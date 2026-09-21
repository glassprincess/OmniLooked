import { SUPPORTED_ENCODINGS, decodeBytes, detectEncoding } from '../../core/encoding';
import { formatBytes } from '../../core/format';
import { SNIFF_BYTES, TEXT_PREVIEW_MAX_BYTES } from '../../core/limits';
import { isProbablyText } from '../../core/sniffer';
import { t, type MessageKey } from '../../i18n';
import type { FileViewerPlugin } from '../../types';
import { h } from '../../ui/dom';
import { VirtualList } from '../../ui/virtualList';
import { createTextView, type TextView } from '../shared/textView';
import { HexView } from './hexView';
import type { StringItem, StringsWorkerIn, StringsWorkerOut } from './stringsScanner';

type TabId = 'text' | 'strings' | 'hex';

const TABS: readonly TabId[] = ['text', 'strings', 'hex'];
const TAB_LABEL: Record<TabId, MessageKey> = {
  text: 'tabSmartText',
  strings: 'tabStrings',
  hex: 'tabHex',
};

const MIN_STRING_LENGTH = 4;
const ROW_HEIGHT = 20;

function notice(text: string): HTMLElement {
  return h('div', { class: 'notice' }, text);
}

/**
 * Universal Fallback Engine: three manually switched views of the same file.
 * Tabs are built on first use, so an unused tab costs nothing (no worker, no extra reads).
 */
class FallbackViewer implements FileViewerPlugin {
  readonly id = 'fallback';
  readonly name = 'Fallback';
  readonly supportedExtensions: readonly string[] = [];

  private file: File | null = null;
  private signal: AbortSignal | null = null;
  private root: HTMLElement | null = null;
  private readonly tabButtons = new Map<TabId, HTMLButtonElement>();
  private readonly panels = new Map<TabId, HTMLElement>();
  private readonly built = new Set<TabId>();
  private textView: TextView | null = null;
  private hexView: HexView | null = null;
  private stringsList: VirtualList | null = null;
  private worker: Worker | null = null;
  private destroyed = false;

  /** The fallback accepts anything. */
  matches(): boolean {
    return true;
  }

  async render(file: File, container: HTMLElement, signal: AbortSignal): Promise<void> {
    this.file = file;
    this.signal = signal;

    // Binary files (archives, executables, legacy formats) are more useful
    // on the Strings tab than as a raw text dump.
    const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
    signal.throwIfAborted();
    const defaultTab: TabId = file.size > 0 && !isProbablyText(head) ? 'strings' : 'text';

    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    const panels = h('div', { class: 'panels' });
    for (const id of TABS) {
      const button = h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': 'false' }, t(TAB_LABEL[id]));
      button.addEventListener('click', () => {
        void this.activate(id);
      });
      const panel = h('div', { class: 'panel', role: 'tabpanel', hidden: true });
      this.tabButtons.set(id, button);
      this.panels.set(id, panel);
      tabs.append(button);
      panels.append(panel);
    }

    const root = h('div', { class: 'fallback' });
    if (defaultTab === 'strings') root.append(notice(t('fallbackBinaryNotice')));
    root.append(tabs, panels);
    container.append(root);
    this.root = root;

    // The first tab is part of rendering: its errors go to the dispatcher.
    await this.activate(defaultTab, true);
  }

  destroy(): void {
    this.destroyed = true;
    this.worker?.terminate();
    this.worker = null;
    this.textView?.destroy();
    this.textView = null;
    this.hexView?.destroy();
    this.hexView = null;
    this.stringsList?.destroy();
    this.stringsList = null;
    this.root?.remove();
    this.root = null;
    this.tabButtons.clear();
    this.panels.clear();
    this.built.clear();
    this.file = null;
    this.signal = null;
  }

  private async activate(id: TabId, propagateErrors = false): Promise<void> {
    for (const tab of TABS) {
      const selected = tab === id;
      this.tabButtons.get(tab)?.setAttribute('aria-selected', String(selected));
      const panel = this.panels.get(tab);
      if (panel) panel.hidden = !selected;
    }
    const panel = this.panels.get(id);
    if (!panel || this.built.has(id)) return;
    this.built.add(id);

    try {
      await this.build(id, panel);
    } catch (error) {
      if (propagateErrors) throw error;
      if (this.destroyed || (error instanceof DOMException && error.name === 'AbortError')) return;
      panel.replaceChildren(notice(error instanceof Error ? error.message : String(error)));
    }
  }

  private async build(id: TabId, panel: HTMLElement): Promise<void> {
    const file = this.file;
    const signal = this.signal;
    if (!file || !signal) return;
    if (file.size === 0) {
      panel.append(notice(t('emptyFile')));
      return;
    }
    switch (id) {
      case 'text':
        await this.buildText(file, signal, panel);
        return;
      case 'strings':
        this.buildStrings(file, panel);
        return;
      case 'hex':
        this.hexView = new HexView(file);
        panel.append(this.hexView.element);
        return;
    }
  }

  private async buildText(file: File, signal: AbortSignal, panel: HTMLElement): Promise<void> {
    const truncated = file.size > TEXT_PREVIEW_MAX_BYTES;
    const bytes = new Uint8Array(await file.slice(0, TEXT_PREVIEW_MAX_BYTES).arrayBuffer());
    signal.throwIfAborted();
    const detected = await detectEncoding(bytes);
    signal.throwIfAborted();

    const select = h('select', { class: 'select', 'aria-label': t('encoding') });
    const options = [...SUPPORTED_ENCODINGS];
    if (!options.some((option) => option.label === detected)) {
      options.push({ label: detected, title: detected.toUpperCase() });
    }
    for (const option of options) select.append(h('option', { value: option.label }, option.title));
    select.value = detected;

    const bar = h('div', { class: 'panel-bar' }, h('label', {}, t('encoding')), select);
    if (truncated) {
      bar.append(
        h('span', {}, t('textTruncated', { shown: formatBytes(TEXT_PREVIEW_MAX_BYTES), total: formatBytes(file.size) })),
      );
    }
    const body = h('div', { class: 'panel-body' });
    panel.append(bar, body);

    const show = (label: string): void => {
      this.textView?.destroy();
      this.textView = createTextView(decodeBytes(bytes, label, truncated));
      body.replaceChildren(this.textView.element);
    };
    select.addEventListener('change', () => show(select.value));
    show(detected);
  }

  private buildStrings(file: File, panel: HTMLElement): void {
    const items: StringItem[] = [];
    const offsetWidth = Math.max(8, file.size.toString(16).length);

    const status = h('span', {}, t('stringsScanning', { percent: 0 }));
    const progress = h('progress', { max: '100', value: '0' });
    const bar = h('div', { class: 'panel-bar' }, status, progress);

    const list = new VirtualList({
      rowHeight: ROW_HEIGHT,
      rowCount: 0,
      createRow: () => h('div', {}, h('span', { class: 'str-off' }), h('span', { class: 'str-tx' })),
      updateRow: (row, index) => {
        const item = items[index];
        const offset = row.firstElementChild;
        const text = row.lastElementChild;
        if (!item || !offset || !text) return;
        offset.textContent = item.offset.toString(16).padStart(offsetWidth, '0');
        text.textContent = item.text;
      },
    });
    this.stringsList = list;
    panel.append(bar, list.element);

    const worker = new Worker(new URL('./strings.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;

    worker.addEventListener('message', (event: MessageEvent<StringsWorkerOut>) => {
      const message = event.data;
      switch (message.type) {
        case 'batch':
          for (const item of message.items) items.push(item);
          list.setRowCount(items.length);
          break;
        case 'progress': {
          const percent = Math.floor((message.read / message.total) * 100);
          progress.value = percent;
          status.textContent = t('stringsScanning', { percent });
          break;
        }
        case 'done':
          progress.hidden = true;
          if (message.truncated) status.textContent = t('stringsTruncated', { count: message.count.toLocaleString() });
          else if (message.count === 0) status.textContent = t('stringsNone');
          else status.textContent = t('stringsFound', { count: message.count.toLocaleString() });
          break;
        case 'error':
          progress.hidden = true;
          status.textContent = `${t('stringsError')}: ${message.message}`;
          break;
      }
    });
    worker.addEventListener('error', () => {
      progress.hidden = true;
      status.textContent = t('stringsError');
    });

    const start: StringsWorkerIn = { type: 'start', file, minLength: MIN_STRING_LENGTH };
    worker.postMessage(start);
  }
}

export function createViewer(): FileViewerPlugin {
  return new FallbackViewer();
}
