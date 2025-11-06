import { DiffView } from "@/integrations/editor/diff-view";
import { NotebookDiffView } from "@/integrations/editor/notebook-diff-view";
import { createPrettyPatch, ensureFileDirectoryExists } from "@/lib/fs";
import { getLogger } from "@/lib/logger";
import { getEditSummary, writeTextDocument } from "@/lib/write-text-document";
import { parseDiffAndApply } from "@getpochi/common/diff-utils";
import { resolvePath, validateTextFile } from "@getpochi/common/tool-utils";
import type { ClientTools } from "@getpochi/tools";
import type {
  PreviewToolFunctionType,
  ToolFunctionType,
} from "@getpochi/tools";
import * as vscode from "vscode";

const logger = getLogger("applyDiffTool");

/**
 * Preview the diff using DiffView
 */
export const previewApplyDiff: PreviewToolFunctionType<
  ClientTools["applyDiff"]
> = async (args, { toolCallId, state, abortSignal, cwd, nonInteractive }) => {
  const { path, searchContent, replaceContent, expectedReplacements } =
    args || {};
  if (
    !args ||
    !path ||
    searchContent === undefined ||
    replaceContent === undefined
  ) {
    return { error: "Invalid arguments for previewing applyDiff tool." };
  }

  let isNotebook = false;
  try {
    const resolvedPath = resolvePath(path, cwd);
    const fileUri = vscode.Uri.file(resolvedPath);

    const fileBuffer = await vscode.workspace.fs.readFile(fileUri);
    validateTextFile(fileBuffer);

    const fileContent = fileBuffer.toString();

    const updatedContent = await parseDiffAndApply(
      fileContent,
      searchContent,
      replaceContent,
      expectedReplacements,
    );

    if (nonInteractive) {
      const editSummary = getEditSummary(fileContent, updatedContent);
      const edit = createPrettyPatch(path, fileContent, updatedContent);
      return { success: true, _meta: { edit, editSummary } };
    }

    isNotebook = resolvedPath.toLowerCase().endsWith(".ipynb");
    if (isNotebook) {
      const nbView = await NotebookDiffView.getOrCreate(toolCallId, path, cwd);
      await nbView.update(
        updatedContent,
        state !== "partial-call",
        abortSignal,
      );
    } else {
      const diffView = await DiffView.getOrCreate(toolCallId, path, cwd);
      await diffView.update(
        updatedContent,
        state !== "partial-call",
        abortSignal,
      );
    }
    return { success: true };
  } catch (error) {
    if (state === "call") {
      if (isNotebook) {
        NotebookDiffView.revertAndClose(toolCallId);
      } else {
        DiffView.revertAndClose(toolCallId);
      }
    }
    throw error;
  }
};

/**
 * Apply a diff to a file using DiffView
 */
export const applyDiff: ToolFunctionType<ClientTools["applyDiff"]> = async (
  { path, searchContent, replaceContent, expectedReplacements },
  { toolCallId, abortSignal, nonInteractive, cwd },
) => {
  let isNotebook = false;
  try {
    const resolvedPath = resolvePath(path, cwd);
    const fileUri = vscode.Uri.file(resolvedPath);
    await ensureFileDirectoryExists(fileUri);

    const fileBuffer = await vscode.workspace.fs.readFile(fileUri);
    validateTextFile(fileBuffer);

    const fileContent = fileBuffer.toString();

    const updatedContent = await parseDiffAndApply(
      fileContent,
      searchContent,
      replaceContent,
      expectedReplacements,
    );

    if (nonInteractive) {
      const edits = await writeTextDocument(
        path,
        updatedContent,
        cwd,
        abortSignal,
      );
      logger.info(
        `Successfully applied diff to ${path} in non-interactive mode`,
      );
      return { success: true, ...edits };
    }

    isNotebook = resolvedPath.toLowerCase().endsWith(".ipynb");
    let edits: { userEdits?: string; autoFormattingEdits?: string; newProblems?: string } = {};
    if (isNotebook) {
      const nbView = await NotebookDiffView.getOrCreate(toolCallId, path, cwd);
      await nbView.update(updatedContent, true);
      edits = await nbView.saveChanges(path, updatedContent);
    } else {
      const diffView = await DiffView.getOrCreate(toolCallId, path, cwd);
      await diffView.update(updatedContent, true);
      edits = await diffView.saveChanges(path, updatedContent);
    }

    logger.info(`Successfully applied diff to ${path}`);
    return { success: true, ...edits };
  } catch (error) {
    if (isNotebook) {
      NotebookDiffView.revertAndClose(toolCallId);
    } else {
      DiffView.revertAndClose(toolCallId);
    }
    throw error;
  }
};
