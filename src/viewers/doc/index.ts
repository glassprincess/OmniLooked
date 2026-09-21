import { decodeBytes, detectEncoding } from '../../core/encoding';
import { DOC_EXTENSIONS, docKindFor, type DocKind } from '../../core/extensions';
import { formatBytes } from '../../core/format';
import { TEXT_PREVIEW_MAX_BYTES } from '../../core/limits';
import { getExtension, isProbablyText } from '../../core/sniffer';
import { t, type MessageKey } from '../../i18n';
import type { FileViewerPlugin } from '../../types';
import { h } from '../../ui/dom';
import { createTextView, type TextView } from '../shared/textView';
import { markdownToHtml } from './markdown';

type TabId = 'preview' | 'source';

const TABS: readonly TabId[] = ['preview', 'source'];
const TAB_LABEL: Record<TabId, MessageKey> = {
  preview: 'tabPreview',
  source: 'tabSource',
};

/**
 * Sandboxed preview: scripts, forms and same-origin access are blocked, so a
 * malicious file cannot touch the app. Links still open in a new tab.
 */
const SANDBOX_FLAGS = 'allow-popups allow-popups-to-escape-sandbox';

function markdownDocument(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'" />
<style>
:root { color-scheme: light dark; }
body { margin: 0 auto; max-width: 860px; padding: 24px 20px 48px; font: 15px/1.6 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #1a1d26; background: #ffffff; overflow-wrap: break-word; }
@media (prefers-color-scheme: dark) { body { color: #e6e8ee; background: #0f1117; } }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.4em 0 0.6em; }
h1, h2 { border-bottom: 1px solid #d8dce5; padding-bottom: 0.3em; }
@media (prefers-color-scheme: dark) { h1, h2 { border-color: #2a3040; } }
p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
ul, ol { padding-left: 2em; }
li + li { margin-top: 0.25em; }
li > ul, li > ol { margin: 0.25em 0 0; }
a { color: #2b62e0; }
@media (prefers-color-scheme: dark) { a { color: #6ea8fe; } }
code { padding: 0.15em 0.4em; border-radius: 4px; background: rgba(120, 130, 150, 0.16); font: 0.88em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre { padding: 12px 14px; overflow: auto; border-radius: 6px; background: rgba(120, 130, 150, 0.14); }
pre code { padding: 0; background: none; }
blockquote { margin-left: 0; padding: 0.2em 0 0.2em 1em; border-left: 4px solid #d8dce5; color: #5a6275; }
@media (prefers-color-scheme: dark) { blockquote { border-color: #2a3040; color: #8c94a8; } }
blockquote > :last-child { margin-bottom: 0; }
hr { border: none; border-top: 2px solid #d8dce5; margin: 1.5em 0; }
@media (prefers-color-scheme: dark) { hr { border-color: #2a3040; } }
table { border-collapse: collapse; display: block; overflow: auto; }
th, td { border: 1px solid #d8dce5; padding: 6px 12px; }
@media (prefers-color-scheme: dark) { th, td { border-color: #2a3040; } }
th { background: rgba(120, 130, 150, 0.14); }
input[type="checkbox"] { margin-right: 0.4em; }
.md-img { display: inline-block; padding: 0.1em 0.5em; border: 1px dashed #8c94a8; border-radius: 4px; font-size: 0.9em; }
</style>
</head>
<body>${body}</body>
</html>`;
}

/**
 * Rendered documents with a source tab: HTML pages, SVG images and Markdown.
 * The preview never shares a DOM with the app (sandboxed iframe for HTML and
 * Markdown, plain <img> for SVG where scripts cannot run), the source tab
 * reuses the virtualized text view.
 */
class DocViewer implements FileViewerPlugin {
  readonly id = 'doc';
  readonly name = 'Doc';
  readonly supportedExtensions: readonly string[] = DOC_EXTENSIONS;

  private text = '';
  private raw: Uint8Array<ArrayBuffer> | null = null;
  private truncated = false;
  private totalSize = 0;
  private root: HTMLElement | null = null;
  private sourcePanel: HTMLElement | null = null;
  private sourceBuilt = false;
  private textView: TextView | null = null;
  private objectUrl: string | null = null;
  private destroyed = false;

  matches(file: File, magicBytes: Uint8Array): boolean {
    return docKindFor(getExtension(file.name)) !== null && isProbablyText(magicBytes);
  }

  async render(file: File, container: HTMLElement, signal: AbortSignal): Promise<void> {
    const kind = docKindFor(getExtension(file.name));
    if (kind === null) throw new Error('Unsupported document type');

    this.truncated = file.size > TEXT_PREVIEW_MAX_BYTES;
    this.totalSize = file.size;
    const bytes = new Uint8Array(await file.slice(0, TEXT_PREVIEW_MAX_BYTES).arrayBuffer());
    signal.throwIfAborted();
    const encoding = await detectEncoding(bytes);
    signal.throwIfAborted();
    this.text = decodeBytes(bytes, encoding, this.truncated);
    this.raw = bytes;

    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    const previewPanel = h('div', { class: 'panel', role: 'tabpanel' });
    const sourcePanel = h('div', { class: 'panel', role: 'tabpanel', hidden: true });
    this.sourcePanel = sourcePanel;

    const buttons = new Map<TabId, HTMLButtonElement>();
    for (const id of TABS) {
      const selected = id === 'preview';
      const button = h(
        'button',
        { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(selected) },
        t(TAB_LABEL[id]),
      );
      button.addEventListener('click', () => this.activate(id, buttons, previewPanel, sourcePanel));
      buttons.set(id, button);
      tabs.append(button);
    }

    // The preview is part of rendering: its errors go to the dispatcher.
    if (file.size === 0) {
      previewPanel.append(h('div', { class: 'notice' }, t('emptyFile')));
    } else {
      if (this.truncated) {
        previewPanel.append(
          h('div', { class: 'notice' }, t('textTruncated', {
            shown: formatBytes(TEXT_PREVIEW_MAX_BYTES),
            total: formatBytes(file.size),
          })),
        );
      }
      previewPanel.append(this.buildPreview(kind));
    }

    const root = h('div', { class: 'doc-view' }, tabs, h('div', { class: 'panels' }, previewPanel, sourcePanel));
    container.append(root);
    this.root = root;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.objectUrl !== null) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.textView?.destroy();
    this.textView = null;
    this.root?.remove();
    this.root = null;
    this.sourcePanel = null;
    this.raw = null;
    this.text = '';
  }

  private activate(
    id: TabId,
    buttons: Map<TabId, HTMLButtonElement>,
    previewPanel: HTMLElement,
    sourcePanel: HTMLElement,
  ): void {
    const showPreview = id === 'preview';
    previewPanel.hidden = !showPreview;
    sourcePanel.hidden = showPreview;
    buttons.get('preview')?.setAttribute('aria-selected', String(showPreview));
    buttons.get('source')?.setAttribute('aria-selected', String(!showPreview));
    if (!showPreview) this.buildSource();
  }

  private buildPreview(kind: DocKind): HTMLElement {
    switch (kind) {
      case 'html':
        return this.buildHtmlPreview();
      case 'svg':
        return this.buildSvgPreview();
      case 'markdown':
        return this.buildMarkdownPreview();
    }
  }

  private buildHtmlPreview(): HTMLElement {
    const bar = h('div', { class: 'panel-bar' }, h('span', {}, t('sandboxNote')));
    const frame = h('iframe', { class: 'doc-frame', sandbox: SANDBOX_FLAGS, title: t('tabPreview') });
    frame.srcdoc = this.text;
    return h('div', { class: 'doc-preview' }, bar, frame);
  }

  private buildSvgPreview(): HTMLElement {
    // <img> never executes scripts, so SVG is safe without an iframe.
    const url = URL.createObjectURL(new Blob([this.raw ?? new Uint8Array()], { type: 'image/svg+xml' }));
    this.objectUrl = url;
    const img = h('img', { class: 'doc-svg', alt: '' });
    img.src = url;
    return h('div', { class: 'doc-svg-wrap' }, img);
  }

  private buildMarkdownPreview(): HTMLElement {
    const frame = h('iframe', { class: 'doc-frame', sandbox: SANDBOX_FLAGS, title: t('tabPreview') });
    frame.srcdoc = markdownDocument(markdownToHtml(this.text));
    return h('div', { class: 'doc-preview' }, frame);
  }

  private buildSource(): void {
    const panel = this.sourcePanel;
    if (panel === null || this.sourceBuilt || this.destroyed) return;
    this.sourceBuilt = true;
    if (this.text === '') {
      panel.append(h('div', { class: 'notice' }, t('emptyFile')));
      return;
    }
    if (this.truncated) {
      panel.append(
        h('div', { class: 'notice' }, t('textTruncated', {
          shown: formatBytes(TEXT_PREVIEW_MAX_BYTES),
          total: formatBytes(this.totalSize),
        })),
      );
    }
    // The stored text already reflects truncation.
    this.textView = createTextView(this.text);
    panel.append(this.textView.element);
  }
}

export function createViewer(): FileViewerPlugin {
  return new DocViewer();
}
