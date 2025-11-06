import * as fs from "node:fs/promises";
import { NotebookDiffView } from "@/integrations/editor/notebook-diff-view";
import {
  editNotebookCell,
  parseNotebook,
  resolvePath,
  serializeNotebook,
  validateNotebookPath,
} from "@getpochi/common/tool-utils";
import type { ClientTools, ToolFunctionType } from "@getpochi/tools";

export const editNotebook: ToolFunctionType<
  ClientTools["editNotebook"]
> = async ({ path: filePath, cellId, content }, { cwd, toolCallId, nonInteractive, abortSignal }) => {
  try {
    const absolutePath = resolvePath(filePath, cwd);
    validateNotebookPath(absolutePath);

    const fileContent = await fs.readFile(absolutePath, "utf-8");
    const notebook = parseNotebook(fileContent);
    const updatedNotebook = editNotebookCell(notebook, cellId, content);
    const serialized = serializeNotebook(updatedNotebook);

    if (nonInteractive) {
      await fs.writeFile(absolutePath, serialized, "utf-8");
      return { success: true };
    }

    // Interactive: show in NotebookDiffView and save via VS Code
    const nbView = await NotebookDiffView.getOrCreate(
      toolCallId,
      filePath,
      cwd,
    );
    await nbView.update(serialized, true, abortSignal);

    return { success: true };
  } catch (error) {
    try {
      if (toolCallId) {
        NotebookDiffView.revertAndClose(toolCallId);
      }
    } catch {}
    return { success: false };
  }
};
