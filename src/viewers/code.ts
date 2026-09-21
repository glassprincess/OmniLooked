import { decodeBytes, detectEncoding } from '../core/encoding';
import { TEXT_EXTENSIONS } from '../core/extensions';
import { formatBytes } from '../core/format';
import { TEXT_PREVIEW_MAX_BYTES } from '../core/limits';
import { isProbablyText } from '../core/sniffer';
import { t } from '../i18n';
import type { FileViewerPlugin } from '../types';
import { h } from '../ui/dom';
import { createTextView, type TextView } from './shared/textView';

class CodeViewer implements FileViewerPlugin {
  readonly id = 'code';
  readonly name = 'Text';
  readonly supportedExtensions: readonly string[] = TEXT_EXTENSIONS;

  private root: HTMLElement | null = null;
  private view: TextView | null = null;

  matches(_file: File, magicBytes: Uint8Array): boolean {
    return isProbablyText(magicBytes);
  }

  async render(file: File, container: HTMLElement, signal: AbortSignal): Promise<void> {
    const root = h('div', { class: 'code-viewer' });

    if (file.size === 0) {
      root.append(h('div', { class: 'notice' }, t('emptyFile')));
    } else {
      const truncated = file.size > TEXT_PREVIEW_MAX_BYTES;
      const bytes = new Uint8Array(await file.slice(0, TEXT_PREVIEW_MAX_BYTES).arrayBuffer());
      signal.throwIfAborted();
      const encoding = await detectEncoding(bytes);
      signal.throwIfAborted();

      if (truncated) {
        root.append(
          h('div', { class: 'notice' }, t('textTruncated', {
            shown: formatBytes(TEXT_PREVIEW_MAX_BYTES),
            total: formatBytes(file.size),
          })),
        );
      }
      this.view = createTextView(decodeBytes(bytes, encoding, truncated));
      root.append(this.view.element);
    }

    container.append(root);
    this.root = root;
  }

  destroy(): void {
    this.view?.destroy();
    this.view = null;
    this.root?.remove();
    this.root = null;
  }
}

export function createViewer(): FileViewerPlugin {
  return new CodeViewer();
}
