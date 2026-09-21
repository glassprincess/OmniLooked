/** Contract every viewer implements (spec 2.3). */
export interface FileViewerPlugin {
  readonly id: string;
  readonly name: string;
  readonly supportedExtensions: readonly string[];
  /**
   * Signature check that protects against spoofed extensions.
   * `magicBytes` is the head of the file (up to SNIFF_BYTES bytes); signatures are checked against its prefix.
   */
  matches(file: File, magicBytes: Uint8Array): boolean;
  /** Renders the file into `container`. Must reject with an AbortError when `signal` is aborted. */
  render(file: File, container: HTMLElement, signal: AbortSignal): Promise<void>;
  /** Releases resources: Object URLs, Workers, Canvas/WebGL contexts, DOM. Must be idempotent. */
  destroy(): void;
}

/** Shape of every lazily imported viewer module. A fresh instance is created per opened file. */
export interface ViewerModule {
  createViewer(): FileViewerPlugin;
}

/** Window event a viewer dispatches to open a nested file (e.g. inside an archive). */
export const OPEN_NESTED_EVENT = 'omniview:open-nested';
