import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist/types/src/display/api';
import { PDF_EXTENSIONS } from '../../core/extensions';
import { isPdf } from '../../core/signatures';
import { getExtension } from '../../core/sniffer';
import { t } from '../../i18n';
import type { FileViewerPlugin } from '../../types';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const MAX_DPR = 2;

/** Lazily fetched pdf.js data (standard fonts, CMaps) served from public/pdfjs. */
function assetUrl(path: string): string {
  return new URL(`pdfjs/${path}`, document.baseURI).href;
}

/** pdf.js rejects locked files with PasswordException (wrong password too). */
function isPasswordError(error: unknown): boolean {
  return error instanceof Error && error.name === 'PasswordException';
}

class PdfViewer implements FileViewerPlugin {
  readonly id = 'pdf';
  readonly name = 'PDF';
  readonly supportedExtensions: readonly string[] = PDF_EXTENSIONS;

  private root: HTMLElement | null = null;
  private loadingTask: PDFDocumentLoadingTask | null = null;
  private doc: PDFDocumentProxy | null = null;
  private task: RenderTask | null = null;
  private textTask: Promise<unknown> | null = null;
  private pageNumber = 1;
  private pageCount = 0;
  private zoomIndex = 2; // 1x; fit mode overrides the base scale
  private fitMode = true;
  private destroyed = false;

  private canvas: HTMLCanvasElement | null = null;
  private textLayer: HTMLElement | null = null;
  private pageLabel: HTMLElement | null = null;
  private zoomLabel: HTMLElement | null = null;
  private prevButton: HTMLButtonElement | null = null;
  private nextButton: HTMLButtonElement | null = null;
  private scrollBox: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private renderId = 0;

  matches(file: File, magicBytes: Uint8Array): boolean {
    return getExtension(file.name) === 'pdf' && isPdf(magicBytes);
  }

  async render(file: File, container: HTMLElement, signal: AbortSignal): Promise<void> {
    const data = new Uint8Array(await file.arrayBuffer());
    signal.throwIfAborted();
    let doc: PDFDocumentProxy;
    try {
      doc = await this.loadDocument(data, undefined);
    } catch (error) {
      if (isPasswordError(error)) {
        this.promptPassword(container, signal, data);
        return;
      }
      throw new Error(t('pdfFailed'));
    }
    signal.throwIfAborted();
    if (this.destroyed) {
      await this.closeDocument();
      return;
    }
    this.showDocument(doc, container, signal);
    await this.goTo(1);
  }

  private async loadDocument(data: Uint8Array, password: string | undefined): Promise<PDFDocumentProxy> {
    const loadingTask = pdfjsLib.getDocument({
      data: data.slice(),
      password,
      cMapUrl: assetUrl('cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: assetUrl('standard_fonts/'),
    });
    this.loadingTask = loadingTask;
    try {
      return await loadingTask.promise;
    } catch (error) {
      if (isPasswordError(error)) throw error;
      throw new Error(t('pdfFailed'));
    }
  }

  private async closeDocument(): Promise<void> {
    if (this.loadingTask) {
      await this.loadingTask.destroy().catch(() => undefined);
      this.loadingTask = null;
    }
    this.doc = null;
  }

  /** Password-protected files get an inline unlock form instead of a dead end. */
  private promptPassword(container: HTMLElement, signal: AbortSignal, data: Uint8Array): void {
    const input = h('input', { class: 'input', type: 'password', placeholder: t('pdfPassword'), 'aria-label': t('pdfPassword') });
    const error = h('div', { class: 'pdf-lock-error', hidden: true });
    const submit = h('button', { class: 'btn primary', type: 'submit' }, t('pdfUnlock'));
    const form = h('form', { class: 'pdf-lock-box' },
      h('div', { class: 'dz-title' }, t('pdfLocked')),
      input,
      error,
      submit,
    );
    let busy = false;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (busy || this.destroyed || signal.aborted) return;
      busy = true;
      submit.disabled = true;
      error.hidden = true;
      void this.loadDocument(data, input.value).then((doc) => {
        if (this.destroyed || signal.aborted) {
          void this.closeDocument();
          return;
        }
        this.root?.remove();
        this.root = null;
        this.showDocument(doc, container, signal);
        void this.goTo(1).finally(() => {
          busy = false;
          submit.disabled = false;
        });
      }).catch((loadError: unknown) => {
        busy = false;
        submit.disabled = false;
        error.hidden = false;
        error.textContent = isPasswordError(loadError) ? t('pdfWrongPassword') : t('pdfFailed');
      });
    });
    const root = h('div', { class: 'pdf-view pdf-lock-wrap' }, form);
    container.append(root);
    this.root = root;
    input.focus();
  }

  private showDocument(doc: PDFDocumentProxy, container: HTMLElement, signal: AbortSignal): void {
    this.doc = doc;
    this.pageCount = doc.numPages;

    const prevButton = h('button', { class: 'btn small', type: 'button', title: t('pdfPrev') });
    prevButton.append(icon('back'));
    const nextButton = h('button', { class: 'btn small', type: 'button', title: t('pdfNext') });
    const nextIcon = icon('back');
    nextIcon.style.transform = 'scaleX(-1)';
    nextButton.append(nextIcon);
    const pageLabel = h('span', { class: 'pdf-page-label', role: 'status' });
    const zoomOut = h('button', { class: 'btn small', type: 'button', title: t('zoomOut') }, '−');
    const zoomLabel = h('span', { class: 'zoom-percent' });
    const zoomIn = h('button', { class: 'btn small', type: 'button', title: t('zoomIn') }, '+');
    const zoomFit = h('button', { class: 'btn small', type: 'button', title: t('zoomFit') }, t('zoomFit'));
    this.prevButton = prevButton;
    this.nextButton = nextButton;
    this.pageLabel = pageLabel;
    this.zoomLabel = zoomLabel;

    prevButton.addEventListener('click', () => void this.goTo(this.pageNumber - 1));
    nextButton.addEventListener('click', () => void this.goTo(this.pageNumber + 1));
    zoomIn.addEventListener('click', () => this.setZoom(this.zoomIndex + 1, false));
    zoomOut.addEventListener('click', () => this.setZoom(this.zoomIndex - 1, false));
    zoomFit.addEventListener('click', () => this.setZoom(2, true));

    const bar = h('div', { class: 'panel-bar pdf-bar' },
      prevButton, pageLabel, nextButton,
      h('span', { class: 'pdf-spacer' }),
      zoomOut, zoomLabel, zoomIn, zoomFit,
    );
    const canvas = h('canvas', { class: 'pdf-canvas' });
    const textLayer = h('div', { class: 'pdf-text' });
    const page = h('div', { class: 'pdf-page' }, canvas, textLayer);
    const scrollBox = h('div', { class: 'pdf-scroll' }, page);
    this.canvas = canvas;
    this.textLayer = textLayer;
    this.scrollBox = scrollBox;

    const root = h('div', { class: 'pdf-view' }, bar, scrollBox);
    container.append(root);
    this.root = root;

    this.resizeObserver = new ResizeObserver(() => {
      if (this.fitMode) void this.renderCurrent();
    });
    this.resizeObserver.observe(scrollBox);

    signal.addEventListener('abort', () => this.cancelTasks(), { once: true });
  }

  destroy(): void {
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.cancelTasks();
    if (this.loadingTask) {
      void this.loadingTask.destroy().catch(() => undefined);
      this.loadingTask = null;
    }
    this.doc = null;
    this.root?.remove();
    this.root = null;
    this.canvas = null;
    this.textLayer = null;
  }

  private cancelTasks(): void {
    try {
      this.task?.cancel();
    } catch {
      // Already finished; ignore.
    }
    this.task = null;
    this.textTask = null;
  }

  private async goTo(page: number): Promise<void> {
    if (!this.doc || this.destroyed) return;
    this.pageNumber = Math.min(this.pageCount, Math.max(1, page));
    await this.renderCurrent();
  }

  private setZoom(index: number, fit: boolean): void {
    this.zoomIndex = Math.min(ZOOM_STEPS.length - 1, Math.max(0, index));
    this.fitMode = fit;
    void this.renderCurrent();
  }

  private refreshChrome(): void {
    this.pageLabel && (this.pageLabel.textContent = t('pdfPage', { n: this.pageNumber, total: this.pageCount }));
    const percent = Math.round((ZOOM_STEPS[this.zoomIndex] as number) * 100);
    this.zoomLabel && (this.zoomLabel.textContent = this.fitMode ? t('zoomFit') : `${percent}%`);
    if (this.prevButton) this.prevButton.disabled = this.pageNumber <= 1;
    if (this.nextButton) this.nextButton.disabled = this.pageNumber >= this.pageCount;
  }

  private async renderCurrent(): Promise<void> {
    const id = ++this.renderId;
    const doc = this.doc;
    const canvas = this.canvas;
    const textLayer = this.textLayer;
    const scrollBox = this.scrollBox;
    if (!doc || !canvas || !textLayer || !scrollBox || this.destroyed) return;
    this.cancelTasks();
    this.refreshChrome();

    let page: PDFPageProxy;
    try {
      page = await doc.getPage(this.pageNumber);
    } catch {
      return;
    }
    if (id !== this.renderId || this.destroyed) return;

    const base = ZOOM_STEPS[this.zoomIndex] as number;
    let scale = base;
    if (this.fitMode && scrollBox.clientWidth > 0) {
      const probe = page.getViewport({ scale: 1 });
      scale = Math.max(0.25, (scrollBox.clientWidth - 48) / probe.width);
    }
    const viewport = page.getViewport({ scale });
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    // Backing store at device resolution; pdf.js maps the viewport onto it.
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    textLayer.replaceChildren();
    textLayer.style.width = `${viewport.width}px`;
    textLayer.style.height = `${viewport.height}px`;

    try {
      const task = page.render({ canvas, viewport });
      this.task = task;
      await task.promise;
    } catch (error) {
      if (error instanceof Error && error.name === 'RenderingCancelledException') return;
      throw error;
    } finally {
      if (this.task && id === this.renderId) this.task = null;
    }
    if (id !== this.renderId || this.destroyed) return;

    // Selectable text is best-effort: the canvas stays usable if it fails.
    try {
      const TextLayer = (pdfjsLib as unknown as {
        TextLayer?: new (options: Record<string, unknown>) => { render: () => Promise<unknown> };
      }).TextLayer;
      if (TextLayer) {
        const layer = new TextLayer({
          container: textLayer,
          viewport,
          textContentSource: page.streamTextContent(),
        });
        this.textTask = layer.render();
        await this.textTask;
      }
    } catch {
      textLayer.replaceChildren();
    }
  }
}

export function createViewer(): FileViewerPlugin {
  return new PdfViewer();
}
