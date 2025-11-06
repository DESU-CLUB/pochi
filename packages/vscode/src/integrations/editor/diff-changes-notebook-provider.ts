import { injectable, singleton } from "tsyringe";
import * as vscode from "vscode";

@injectable()
@singleton()
export class DiffModifiedNotebookProvider
  implements vscode.FileSystemProvider, vscode.Disposable
{
  static readonly scheme = "pochi-nb-modified";

  private readonly content = new Map<string, Uint8Array>(); // key: "id:version"
  private readonly onDidChangeFileEmitter = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >();

  readonly onDidChangeFile = this.onDidChangeFileEmitter.event;

  private registration = vscode.workspace.registerFileSystemProvider(
    DiffModifiedNotebookProvider.scheme,
    this,
    { isReadonly: true },
  );

  setForFile(id: string, path: string, data: Uint8Array, version = 0) {
    const key = `${id}:${version}`;
    this.content.set(key, data);
    this.onDidChangeFileEmitter.fire([
      {
        type: vscode.FileChangeType.Changed,
        uri: vscode.Uri.from({
          scheme: DiffModifiedNotebookProvider.scheme,
          path,
          query: key,
        }),
      },
    ]);
  }

  watch(): vscode.Disposable {
    return { dispose() {} };
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const key = uri.query; // "id:version"
    const data = this.content.get(key);
    const size = data ? data.byteLength : 0;
    const now = Date.now();
    return { type: vscode.FileType.File, ctime: now, mtime: now, size };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const key = uri.query; // "id:version"
    const data = this.content.get(key);
    if (!data) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return data;
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
