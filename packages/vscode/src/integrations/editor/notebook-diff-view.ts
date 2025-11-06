import * as path from "node:path";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import {
  diagnosticsToProblemsString,
  getNewDiagnostics,
} from "@/lib/diagnostic";
import { ensureFileDirectoryExists, isFileExists } from "@/lib/fs";
import { createPrettyPatch } from "@/lib/fs";
import { getLogger } from "@/lib/logger";
import { resolvePath } from "@getpochi/common/tool-utils";
import * as diff from "diff";
import * as runExclusive from "run-exclusive";
import * as vscode from "vscode";
import { DiffOriginNotebookProvider } from "./diff-origin-notebook-provider";

const logger = getLogger("notebookDiffView");
const ShouldAutoScroll = true;

export class NotebookDiffView implements vscode.Disposable {
  private isFinalized = false;
  private isReverted = false;
  private streamedLines: string[] = [];

  private preDiagnostics: [vscode.Uri, vscode.Diagnostic[]][] =
    vscode.languages.getDiagnostics();
  private editorDocumentUpdatedAt: number | undefined;

  private disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly id: string,
    public readonly fileUri: vscode.Uri,
    private readonly fileExists: boolean,
    private readonly originalContent: string,
    private readonly activeDiffEditor: vscode.NotebookEditor,
    private readonly cwd: string,
    private readonly isFileOpenBeforeDiffPreview = false,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeNotebookDocument(
        ({ notebook, contentChanges }) => {
          if (
            notebook.uri.toString() ===
              this.activeDiffEditor.notebook.uri.toString() &&
            contentChanges.length > 0
          ) {
            this.editorDocumentUpdatedAt = Date.now();
          }
        },
      ),
    );
  }

  async focus() {
    await runVSCodeDiff(
      this.id,
      this.originalContent,
      this.fileExists,
      this.fileUri,
    );
  }

  dispose() {
    if (!this.fileExists) {
      // Delete file if file is empty
      (async () => {
        const metadata = await vscode.workspace.fs.stat(this.fileUri);
        if (metadata.size === 0) {
          await vscode.workspace.fs.delete(this.fileUri);
        }
      })().catch((err) => {
        logger.debug("Error deleting file", err);
      });
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private revertAndClose = async () => {
    if (this.isReverted) {
      logger.debug("revertAndClose already called, skipping");
      return;
    }
    this.isReverted = true;

    logger.debug("revert and close diff view");
    const updatedDocument = this.activeDiffEditor.notebook;
    await discardChangesWithWorkspaceEdit(
      updatedDocument,
      this.originalContent,
    );
    await closeAllNonDirtyDiffViews();

    // Reopen the file if it was open before the diff view
    if (this.isFileOpenBeforeDiffPreview) {
      logger.debug(
        "Reopening file that was open before diff view",
        this.fileUri.fsPath,
      );
      try {
        const document = await vscode.workspace.openTextDocument(this.fileUri);
        await vscode.window.showTextDocument(document, {
          preview: false,
          preserveFocus: true,
        });
      } catch (error) {
        logger.debug("Failed to reopen file", error);
      }
    }
  };

  async update(content: string, isFinal: boolean, abortSignal?: AbortSignal) {
    if (this.isFinalized || this.isReverted) {
      return;
    }

    if (isFinal) {
      logger.debug("Finalizing file", this.fileUri.fsPath);
      this.isFinalized = true;
    }

    if (abortSignal) {
      abortSignal.addEventListener("abort", this.revertAndClose);
      this.disposables.push({
        dispose: () => {
          abortSignal.removeEventListener("abort", this.revertAndClose);
        },
      });
    }

    let accumulatedContent = content;
    // --- Fix to prevent duplicate BOM ---
    // Strip potential BOM from incoming content. VS Code's `applyEdit` might implicitly handle the BOM
    // when replacing from the start (0,0), and we want to avoid duplication.
    // Final BOM is handled in `saveChanges`.
    if (accumulatedContent.startsWith("\ufeff")) {
      accumulatedContent = content.slice(1); // Remove the BOM character
    }

    const diffEditor = this.activeDiffEditor;
    const document = diffEditor.notebook;

    const accumulatedLines = accumulatedContent.split("\n");
    if (!isFinal) {
      accumulatedLines.pop(); // remove the last partial line only if it's not the final update
    }
    const diffLines = accumulatedLines.slice(this.streamedLines.length);

    // Instead of animating each line, we'll update in larger chunks
    const currentLine = this.streamedLines.length + diffLines.length - 1;
    if (currentLine >= 0) {
      // Only proceed if we have new lines

      // For notebooks we don't stream partial structural edits; we just adjust view.

      if (ShouldAutoScroll) {
        if (diffLines.length <= 5) {
          // For small changes, just jump directly to the line
          this.scrollNotebookToCell(currentLine);
        } else {
          // For larger changes, create a quick scrolling animation
          const startLine = this.streamedLines.length;
          const endLine = currentLine;
          const totalLines = endLine - startLine;
          const numSteps = 10; // Adjust this number to control animation speed
          const stepSize = Math.max(1, Math.floor(totalLines / numSteps));

          // Create and await the smooth scrolling animation
          for (let line = startLine; line <= endLine; line += stepSize) {
            diffEditor.revealRange(
              new vscode.NotebookRange(
                Math.min(line, Math.max(0, document.cellCount - 1)),
                Math.min(line, Math.max(0, document.cellCount - 1)),
              ),
              vscode.NotebookEditorRevealType.InCenter,
            );
            await new Promise((resolve) => setTimeout(resolve, 16)); // ~60fps
          }
          // Ensure we end at the final line
          this.scrollNotebookToCell(currentLine);
        }
      }
    }

    // Update the streamedLines with the new accumulated content
    this.streamedLines = accumulatedLines;
    if (isFinal) {
      // Apply final content to the notebook using the active serializer
      const nb = this.activeDiffEditor.notebook;
      try {
        const nbType = nb.notebookType;
        const bytes = Buffer.from(accumulatedContent ?? "", "utf8");
        const data = await vscode.commands.executeCommand<vscode.NotebookData>(
          "vscode.executeDataToNotebook",
          nbType,
          bytes,
        );
        if (data) {
          const fullRange = new vscode.NotebookRange(0, nb.cellCount);
          const ws = new vscode.WorkspaceEdit();
          ws.set(nb.uri, [
            vscode.NotebookEdit.replaceCells(fullRange, data.cells),
          ]);
          await vscode.workspace.applyEdit(ws);
        }
      } catch (err) {
        logger.debug("Failed to apply final notebook content", err);
      }

      await setTimeoutPromise(300);
      this.scrollToFirstNotebookCell();
    }
  }

  private getEditSummary(original: string, modified: string) {
    const diffs = diff.diffLines(original, modified);
    let added = 0;
    let removed = 0;

    for (const part of diffs) {
      if (part.added) {
        added += part.count || 0;
      } else if (part.removed) {
        removed += part.count || 0;
      }
    }

    return { added, removed };
  }

  async saveChanges(relPath: string, newContent: string) {
    const updatedDocument = this.activeDiffEditor.notebook;
    const preSaveContent = updatedDocument.notebookType;
    if (updatedDocument.isDirty) {
      await updatedDocument.save();
    }
    const postSaveContent = updatedDocument.notebookType;
    const editSummary = this.getEditSummary(
      this.originalContent || "",
      postSaveContent,
    );

    const document = await vscode.workspace.openTextDocument(this.fileUri);
    await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: true,
    });

    needFocusDiffViews = true;
    await closeAllNonDirtyDiffViews();

    await this.waitForDiagnostic();
    const postDiagnostics = vscode.languages.getDiagnostics();
    const newProblems = diagnosticsToProblemsString(
      getNewDiagnostics(this.preDiagnostics, postDiagnostics),
      [
        vscode.DiagnosticSeverity.Error, // only including errors since warnings can be distracting (if user wants to fix warnings they can use the @problems mention)
      ],
      this.cwd,
    ); // will be empty string if no errors

    const newContentEOL = newContent.includes("\r\n") ? "\r\n" : "\n";
    const normalizedPreSaveContent =
      preSaveContent.replace(/\r\n|\n/g, newContentEOL).trimEnd() +
      newContentEOL; // trimEnd to fix issue where editor adds in extra new line automatically
    const normalizedPostSaveContent =
      postSaveContent.replace(/\r\n|\n/g, newContentEOL).trimEnd() +
      newContentEOL; // this is the final content we return to the model to use as the new baseline for future edits
    const normalizedNewContent =
      newContent.replace(/\r\n|\n/g, newContentEOL).trimEnd() + newContentEOL;

    let userEdits: string | undefined;
    if (normalizedPreSaveContent !== normalizedNewContent) {
      // user made changes before approving edit. let the model know about user made changes (not including post-save auto-formatting changes)
      userEdits = createPrettyPatch(
        relPath,
        normalizedNewContent,
        normalizedPreSaveContent,
      );
    }

    let autoFormattingEdits: string | undefined;
    if (normalizedPreSaveContent !== normalizedPostSaveContent) {
      // auto-formatting was done by the editor
      autoFormattingEdits = createPrettyPatch(
        relPath,
        normalizedPreSaveContent,
        normalizedPostSaveContent,
      );
    }

    return {
      userEdits,
      autoFormattingEdits,
      newProblems,
      _meta: { editSummary },
    };
  }

  private scrollToFirstNotebookCell() {
    const nb = this.activeDiffEditor.notebook;
    const idx = Math.max(0, Math.min(0, nb.cellCount - 1));
    this.activeDiffEditor.revealRange(
      new vscode.NotebookRange(idx, idx),
      vscode.NotebookEditorRevealType.InCenter,
    );
  }

  private async waitForDiagnostic() {
    if (process.env.VSCODE_TEST_OPTIONS) {
      // No waiting in test mode
      return;
    }

    const waitForDiagnosticMs = 1000;
    const timeoutDuration =
      this.editorDocumentUpdatedAt !== undefined
        ? Math.max(
            1,
            Math.min(
              waitForDiagnosticMs,
              this.editorDocumentUpdatedAt + waitForDiagnosticMs - Date.now(),
            ),
          )
        : waitForDiagnosticMs;
    logger.debug(`Waiting ${timeoutDuration}ms for diagnostics to update...`);
    await new Promise((resolve) => {
      setTimeout(resolve, timeoutDuration);
    });
  }

  private scrollNotebookToCell(index: number) {
    const nb = this.activeDiffEditor.notebook;
    const cellIdx = Math.min(Math.max(0, index), Math.max(0, nb.cellCount - 1));
    this.activeDiffEditor.revealRange(
      new vscode.NotebookRange(cellIdx, cellIdx),
      vscode.NotebookEditorRevealType.InCenter,
    );
  }

  private static async createDiffView(
    id: string,
    relpath: string,
    cwd: string,
  ): Promise<NotebookDiffView> {
    const resolvedPath = resolvePath(relpath, cwd);
    const fileUri = vscode.Uri.file(resolvedPath);
    const fileExists = await isFileExists(fileUri);
    if (!fileExists) {
      await ensureFileDirectoryExists(fileUri);
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from("", "utf-8"));
    }
    const originalContent = (
      await vscode.workspace.fs.readFile(fileUri)
    ).toString();
    const activeDiffEditor = await openDiffEditor(
      id,
      fileUri,
      fileExists,
      originalContent,
    );
    // Check if file was open before creating diff view
    const wasFileOpenBeforeDiff = await isFileOpen(fileUri);

    return new NotebookDiffView(
      id,
      fileUri,
      fileExists,
      originalContent,
      activeDiffEditor,
      cwd,
      wasFileOpenBeforeDiff,
    );
  }

  private static readonly diffViewGetGroup = runExclusive.createGroupRef();
  static readonly getOrCreate = runExclusive.build(
    NotebookDiffView.diffViewGetGroup,
    async (id: string, relpath: string, cwd: string) => {
      // Install hook for first diff view
      if (DiffViewMap.size === 0 && !DiffViewDisposable) {
        logger.info("Installing diff view hook");
        DiffViewDisposable =
          vscode.window.tabGroups.onDidChangeTabs(handleTabChanges);
      }

      let diffView = DiffViewMap.get(id);
      if (!diffView) {
        diffView = await this.createDiffView(id, relpath, cwd);
        DiffViewMap.set(id, diffView);
        logger.debug(`Opened diff view for ${id}: ${relpath}`);
        logger.debug(`Total diff views: ${DiffViewMap.size}`);
        await closeFileEditorTabs(diffView.fileUri);
      }

      return diffView;
    },
  );

  static readonly revertAndClose = async (id: string) => {
    const diffView = DiffViewMap.get(id);
    if (diffView) {
      diffView.revertAndClose();
    }
  };
}

// Check if a file is currently open in any tab (excluding diff views)
async function isFileOpen(fileUri: vscode.Uri): Promise<boolean> {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (
        tab.input instanceof vscode.TabInputText &&
        tab.input.uri.fsPath === fileUri.fsPath &&
        !(tab.input instanceof vscode.TabInputTextDiff)
      ) {
        return true;
      }
    }
  }
  return false;
}

// Close any regular tabs for this file before open diff view
async function closeFileEditorTabs(fileUri: vscode.Uri) {
  const tabsToClose: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (
        tab.input instanceof vscode.TabInputText &&
        tab.input.uri.fsPath === fileUri.fsPath &&
        !(tab.input instanceof vscode.TabInputTextDiff)
      ) {
        tabsToClose.push(tab);
      }
    }
  }
  for (const tab of tabsToClose) {
    await vscode.window.tabGroups.close(tab, true);
  }
}

const DiffViewMap = new Map<string, NotebookDiffView>();
let DiffViewDisposable: vscode.Disposable | undefined;

async function openDiffEditor(
  id: string,
  fileUri: vscode.Uri,
  fileExists: boolean,
  originalContent: string | undefined,
): Promise<vscode.NotebookEditor> {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (
        tab.input instanceof vscode.TabInputNotebookDiff &&
        tab.input?.original?.scheme === DiffOriginNotebookProvider.scheme &&
        tab.input.modified.fsPath === fileUri.fsPath
      ) {
        const nbEditor = vscode.window.visibleNotebookEditors.find(
          (e) => e.notebook.uri.fsPath === fileUri.fsPath,
        );
        if (nbEditor) return nbEditor;
      }
    }
  }

  return runVSCodeDiff(id, originalContent, fileExists, fileUri);
}

function runVSCodeDiff(
  id: string,
  originalContent: string | undefined,
  fileExists: boolean,
  fileUri: vscode.Uri,
): Promise<vscode.NotebookEditor> {
  logger.debug("Opening new diff editor", fileUri.fsPath);
  return new Promise<vscode.NotebookEditor>((resolve, reject) => {
    const fileName = path.basename(fileUri.fsPath);
    const disposable = vscode.window.onDidChangeActiveNotebookEditor(
      (editor) => {
        if (editor && editor.notebook.uri.fsPath === fileUri.fsPath) {
          disposable.dispose();
          resolve(editor);
        }
      },
    );
    vscode.commands.executeCommand(
      "vscode.diff",
      vscode.Uri.parse(`${DiffOriginNotebookProvider.scheme}:${id}`).with({
        query: Buffer.from(originalContent ?? "").toString("base64"),
        fragment: fileUri.fsPath,
      }),
      fileUri,
      `${fileName}: ${fileExists ? "Original ↔ Pochi's Changes" : "New File"} (Editable)`,
      {
        preview: false,
        preserveFocus: true,
      },
    );
    // This may happen on very slow machines ie project idx
    setTimeout(() => {
      disposable.dispose();
      reject(new Error("Failed to open diff editor, please try again..."));
    }, 10_000);
  });
}

async function closeAllNonDirtyDiffViews() {
  const tabs = vscode.window.tabGroups.all
    .flatMap((tg) => tg.tabs)
    .filter(
      (tab) =>
        tab.input instanceof vscode.TabInputNotebookDiff &&
        tab.input?.original?.scheme === DiffOriginNotebookProvider.scheme,
    );
  for (const tab of tabs) {
    // trying to close dirty views results in save popup
    if (!tab.isDirty) {
      await vscode.window.tabGroups.close(tab);
    }
  }
}

let needFocusDiffViews = false;

async function focusDiffViews() {
  for (const diffView of DiffViewMap.values()) {
    await diffView.focus();
  }
}

function handleTabChanges(e: vscode.TabChangeEvent) {
  // Only handle close events
  if (e.closed.length === 0) return;

  const visibleDiffViewIds = new Set<string>();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (
        tab.input instanceof vscode.TabInputTextDiff &&
        tab.input.original.scheme === DiffOriginNotebookProvider.scheme
      ) {
        // id is stored in path
        visibleDiffViewIds.add(tab.input.original.path);
      }
    }
  }

  // Collect IDs to remove to avoid deleting during iteration
  const idsToRemove = new Set<string>();
  const filePathsToClose = new Set<string>();

  // Find diff views that are no longer visible and collect their file paths
  for (const [id, diffView] of DiffViewMap) {
    if (!visibleDiffViewIds.has(id)) {
      idsToRemove.add(id);
      filePathsToClose.add(diffView.fileUri.fsPath);
    }
  }

  // Add all diff views for the same file paths to removal list (for reuse cleanup)
  for (const [id, diffView] of DiffViewMap) {
    if (filePathsToClose.has(diffView.fileUri.fsPath)) {
      idsToRemove.add(id);
    }
  }

  // Now safely dispose and remove all marked diff views
  for (const id of idsToRemove) {
    const diffView = DiffViewMap.get(id);
    if (diffView) {
      diffView.dispose();
      DiffViewMap.delete(id);
      logger.debug(`Closed diff view for ${id}`);
    }
  }

  logger.debug(`Remaining diff views: ${DiffViewMap.size}`);
  if (DiffViewMap.size === 0 && DiffViewDisposable) {
    logger.debug("Disposing diff view hook");
    DiffViewDisposable.dispose();
    DiffViewDisposable = undefined;
  }

  if (needFocusDiffViews) {
    logger.debug("Focusing remaining diff views");
    needFocusDiffViews = false;
    focusDiffViews();
  }
}

async function discardChangesWithWorkspaceEdit(
  notebook: vscode.NotebookDocument,
  originalContent: string,
) {
  if (!notebook.isDirty) {
    return;
  }

  const notebookType = notebook.notebookType;
  const bytes = Buffer.from(originalContent ?? "", "utf8");
  const data = await vscode.commands.executeCommand<vscode.NotebookData>(
    "vscode.executeDataToNotebook",
    notebookType,
    bytes,
  );
  if (!data) {
    return;
  }

  const fullRange = new vscode.NotebookRange(0, notebook.cellCount);
  const ws = new vscode.WorkspaceEdit();
  ws.set(notebook.uri, [
    vscode.NotebookEdit.replaceCells(fullRange, data.cells),
  ]);
  await vscode.workspace.applyEdit(ws);
  await vscode.workspace.saveAll(false);
}
