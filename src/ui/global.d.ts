export interface PickedFile { path: string; name: string; bytes: Uint8Array }
export interface FileFilter { name: string; extensions: string[] }

export interface StudioApi {
  pickFiles(options: { title: string; filters: FileFilter[]; multi?: boolean }): Promise<PickedFile[]>;
  pickSavePath(options: { title: string; defaultName: string; filters: FileFilter[] }): Promise<string | null>;
  pickFolder(title: string): Promise<string | null>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  writeInFolder(folder: string, name: string, bytes: Uint8Array): Promise<string>;
  approveDropped(file: File): Promise<string | null>;
  reveal(path: string): Promise<void>;
  setDirty(dirty: boolean): void;
  closeNow(): void;
  onSaveAndClose(callback: () => void): void;
  onOpenFile(callback: (file: PickedFile) => void): void;
  ready(): void;
}

declare global {
  interface Window { studio: StudioApi }
}
