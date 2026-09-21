import type { FileViewerPlugin } from '../types';
import { FALLBACK, findCandidates } from './registry';
import { sniff } from './sniffer';

export type LoadStage = 'reading' | 'loading' | 'rendering';

export interface ViewerSession {
  file: File;
  plugin: FileViewerPlugin;
  /** True when the user (or the error screen) explicitly asked for the text / hex fallback. */
  forcedFallback: boolean;
}

export interface ViewerFailure {
  file: File;
  error: unknown;
  /** Name of the viewer that failed, null if the failure happened before one was chosen. */
  viewerName: string | null;
  canOpenFallback: boolean;
}

export interface DispatcherHooks {
  onStage(stage: LoadStage, moduleName?: string): void;
  onReady(session: ViewerSession): void;
  onError(failure: ViewerFailure): void;
}

export interface OpenOptions {
  forceFallback?: boolean;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Lifecycle owner: sniffs the file, lazily imports a viewer, renders, and always destroys the previous
 * viewer before the next file. Only the latest open() call may touch the UI (generation counter).
 */
export class Dispatcher {
  private plugin: FileViewerPlugin | null = null;
  private controller: AbortController | null = null;
  private generation = 0;

  constructor(
    private readonly host: HTMLElement,
    private readonly hooks: DispatcherHooks,
  ) {}

  async open(file: File, options: OpenOptions = {}): Promise<void> {
    const generation = ++this.generation;
    this.teardown();
    const controller = new AbortController();
    this.controller = controller;
    const forced = options.forceFallback === true;
    let viewerName: string | null = null;

    try {
      this.hooks.onStage('reading');
      const { extension, bytes } = await sniff(file);
      if (generation !== this.generation) return;

      const entries = forced ? [FALLBACK] : [...findCandidates(extension, bytes), FALLBACK];
      for (const entry of entries) {
        this.hooks.onStage('loading', entry.name);
        const module = await entry.load();
        if (generation !== this.generation) return;

        const plugin = module.createViewer();
        if (!plugin.matches(file, bytes)) continue;

        viewerName = plugin.name;
        this.plugin = plugin;
        this.hooks.onStage('rendering', plugin.name);
        await plugin.render(file, this.host, controller.signal);
        if (generation !== this.generation) return;

        this.hooks.onReady({ file, plugin, forcedFallback: forced });
        return;
      }
      throw new Error('No viewer accepted the file');
    } catch (error) {
      if (generation !== this.generation || isAbortError(error)) return;
      this.teardown();
      this.hooks.onError({ file, error, viewerName, canOpenFallback: !forced });
    }
  }

  close(): void {
    this.generation++;
    this.teardown();
  }

  private teardown(): void {
    this.controller?.abort();
    this.controller = null;
    if (this.plugin) {
      try {
        this.plugin.destroy();
      } catch (error) {
        console.error('Viewer destroy() failed', error);
      }
      this.plugin = null;
    }
    this.host.replaceChildren();
  }
}
