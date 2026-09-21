import { LEGACY_EXTENSIONS, legacyKindFor, ODF_EXTENSIONS, odfKindFor, OFFICE_EXTENSIONS, officeKindFor } from '../../core/extensions';
import { isOle, isZip } from '../../core/signatures';
import { getExtension } from '../../core/sniffer';
import { t } from '../../i18n';
import type { FileViewerPlugin } from '../../types';
import { h } from '../../ui/dom';
import { isEncryptedOffice, OfficeCryptoError, OfficePasswordError, unlockOfficePackage } from './agile';
import { parseXlsSheets } from './biff';
import { renderDoc } from './doc';
import { renderDocx } from './docx';
import { OfficeImages } from './images';
import { renderOdf } from './odf';
import { renderPpt } from './ppt';
import { renderPptx } from './pptx';
import { renderXlsx } from './xlsx';
import { buildSheetGrid, renderSheetBook, type SheetBookEntry } from './sheetview';
import { unzipPackage, type ZipEntries } from './zip';

class OfficeViewer implements FileViewerPlugin {
  readonly id = 'office';
  readonly name = 'Office';
  readonly supportedExtensions: readonly string[] = [...OFFICE_EXTENSIONS, ...LEGACY_EXTENSIONS, ...ODF_EXTENSIONS];

  private root: HTMLElement | null = null;
  private images: OfficeImages | null = null;
  private lastExtension = '';
  private destroyed = false;

  matches(file: File, magicBytes: Uint8Array): boolean {
    const extension = getExtension(file.name);
    // Encrypted OOXML is an OLE container rather than a ZIP; the render
    // path tells a wrongly-named legacy file apart via EncryptedPackage.
    if (officeKindFor(extension) !== null || odfKindFor(extension) !== null) {
      return isZip(magicBytes) || isOle(magicBytes);
    }
    if (legacyKindFor(extension) !== null) return isOle(magicBytes);
    return false;
  }

  async render(file: File, container: HTMLElement, signal: AbortSignal): Promise<void> {
    const extension = getExtension(file.name);
    this.lastExtension = extension;
    const data = new Uint8Array(await file.arrayBuffer());
    signal.throwIfAborted();

    if (legacyKindFor(extension) === 'doc') {
      const content = renderDoc(data);
      signal.throwIfAborted();
      this.root = h('div', { class: 'office' },
        h('div', { class: 'notice' }, t('legacyDocNote')),
        content,
      );
      container.append(this.root);
      return;
    }
    if (legacyKindFor(extension) === 'ppt') {
      const content = renderPpt(data);
      signal.throwIfAborted();
      this.root = h('div', { class: 'office' }, content);
      container.append(this.root);
      return;
    }
    if (legacyKindFor(extension) === 'xls') {
      const entries: SheetBookEntry[] = parseXlsSheets(data).map((sheet) => {
        const { grid, truncated } = buildSheetGrid(sheet.cells, sheet.totalRows, sheet.totalCols);
        return { name: sheet.name, grid, totalRows: sheet.totalRows, truncated };
      });
      signal.throwIfAborted();
      this.root = h('div', { class: 'office' }, renderSheetBook(entries));
      container.append(this.root);
      return;
    }

    // A ZIP directory lives at the end of the file, so the whole file is read.
    let entries: ZipEntries;
    try {
      entries = unzipPackage(data);
    } catch {
      // Encrypted OOXML is an OLE container, not a ZIP: ask for a password.
      if (isEncryptedOffice(data)) {
        this.promptOfficePassword(container, signal, data);
        return;
      }
      throw new Error(t('officeFailed'));
    }
    signal.throwIfAborted();
    this.showOfficePackage(entries, container, signal);
  }

  private showOfficePackage(entries: ZipEntries, container: HTMLElement, signal: AbortSignal): void {
    const extension = this.lastExtension;
    const images = new OfficeImages(entries);
    this.images = images;
    const kind = officeKindFor(extension);
    try {
      if (kind === 'docx') this.root = wrap(renderDocx(entries, images));
      else if (kind === 'xlsx') this.root = wrap(renderXlsx(entries));
      else if (kind !== null) this.root = wrap(renderPptx(entries, images));
      else this.root = wrap(renderOdf(entries, images));
    } catch (error) {
      images.destroy();
      this.images = null;
      throw error;
    }
    signal.throwIfAborted();
    container.append(this.root);
  }

  /** Password-protected OOXML gets an inline unlock form instead of a dead end. */
  private promptOfficePassword(container: HTMLElement, signal: AbortSignal, data: Uint8Array): void {
    const input = h('input', { class: 'input', type: 'password', placeholder: t('pdfPassword'), 'aria-label': t('pdfPassword') });
    const error = h('div', { class: 'pdf-lock-error', hidden: true });
    const submit = h('button', { class: 'btn primary', type: 'submit' }, t('pdfUnlock'));
    const form = h('form', { class: 'pdf-lock-box' },
      h('div', { class: 'dz-title' }, t('officeLocked')),
      input,
      error,
      submit,
    );
    let busy = false;
    const resetButton = (): void => {
      busy = false;
      submit.disabled = false;
      submit.textContent = t('pdfUnlock');
    };
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (busy || this.destroyed || signal.aborted) return;
      busy = true;
      submit.disabled = true;
      submit.textContent = t('officeChecking');
      error.hidden = true;
      void unlockOfficePackage(data, input.value).then((decrypted) => {
        if (this.destroyed || signal.aborted) return;
        let entries: ZipEntries;
        try {
          entries = unzipPackage(decrypted);
        } catch {
          resetButton();
          error.hidden = false;
          error.textContent = t('officeFailed');
          return;
        }
        this.root?.remove();
        this.root = null;
        try {
          this.showOfficePackage(entries, container, signal);
        } catch (showError) {
          resetButton();
          error.hidden = false;
          error.textContent = showError instanceof Error ? showError.message : t('officeFailed');
          return;
        }
        resetButton();
      }).catch((unlockError: unknown) => {
        resetButton();
        error.hidden = false;
        if (unlockError instanceof OfficePasswordError) error.textContent = t('officeWrongPassword');
        else if (unlockError instanceof OfficeCryptoError) error.textContent = unlockError.message;
        else error.textContent = t('officeFailed');
      });
    });
    const root = h('div', { class: 'office pdf-lock-wrap' }, form);
    container.append(root);
    this.root = root;
    input.focus();
  }

  destroy(): void {
    this.destroyed = true;
    this.images?.destroy();
    this.images = null;
    this.root?.remove();
    this.root = null;
  }
}

function wrap(content: HTMLElement): HTMLElement {
  return h('div', { class: 'office' }, content);
}

export function createViewer(): FileViewerPlugin {
  return new OfficeViewer();
}
