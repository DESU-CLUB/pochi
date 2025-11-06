import { injectable, singleton } from "tsyringe";
import * as vscode from "vscode";

@injectable()
@singleton()
export class DiffOriginNotebookProvider
  implements vscode.FileSystemProvider, vscode.Disposable
{
  static readonly scheme = "pochi-nb-origin";

  private readonly onDidChangeFileEmitter = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >();

  readonly onDidChangeFile = this.onDidChangeFileEmitter.event;

  private registration = vscode.workspace.registerFileSystemProvider(
    DiffOriginNotebookProvider.scheme,
    this,
    { isReadonly: true },
  );

  watch(): vscode.Disposable {
    return { dispose() {} };
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    // query contains base64-encoded .ipynb bytes
    const size = Buffer.from(uri.query ?? "", "base64").byteLength;
    const now = Date.now();
    return { type: vscode.FileType.File, ctime: now, mtime: now, size };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  readFile(uri: vscode.Uri): Uint8Array {
    // Return the original notebook bytes from base64 query
    return Buffer.from(uri.query ?? "", "base64");
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  dispose() {
    this.registration.dispose();
    this.onDidChangeFileEmitter.dispose();
  }
}
