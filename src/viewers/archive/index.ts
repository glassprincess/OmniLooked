import { ARCHIVE_EXTENSIONS } from '../../core/extensions';
import { formatBytes } from '../../core/format';
import { isZip } from '../../core/signatures';
import { getExtension } from '../../core/sniffer';
import { t } from '../../i18n';
import { OPEN_NESTED_EVENT, type FileViewerPlugin } from '../../types';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { unzipPackage, type ZipEntries } from '../office/zip';

/** Cap on listed entries; huge archives render partially with a notice. */
export const MAX_ARCHIVE_ENTRIES = 10000;

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

function nestedMime(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot < 0 ? '' : path.slice(dot + 1).toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    case 'pdf':
      return 'application/pdf';
    case 'mp4':
      return 'video/mp4';
    case 'mp3':
      return 'audio/mpeg';
    default:
      return '';
  }
}

class ArchiveViewer implements FileViewerPlugin {
  readonly id = 'archive';
  readonly name = 'Archive';
  readonly supportedExtensions: readonly string[] = ARCHIVE_EXTENSIONS;

  private root: HTMLElement | null = null;
  private urls: string[] = [];

  matches(file: File, magicBytes: Uint8Array): boolean {
    return getExtension(file.name) === 'zip' && isZip(magicBytes);
  }

  async render(file: File, container: HTMLElement, signal: AbortSignal): Promise<void> {
    const data = new Uint8Array(await file.arrayBuffer());
    signal.throwIfAborted();
    let entries: ZipEntries;
    try {
      entries = unzipPackage(data);
    } catch {
      throw new Error(t('archiveFailed'));
    }
    signal.throwIfAborted();

    const paths = Object.keys(entries).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const root = h('div', { class: 'archive' });
    if (paths.length === 0) {
      root.append(h('div', { class: 'notice' }, t('archiveEmpty')));
    } else {
      const total = paths.reduce((sum, path) => sum + (entries[path] as Uint8Array).length, 0);
      root.append(
        h('div', { class: 'panel-bar' }, h('span', {}, t('archiveSummary', { count: paths.length, size: formatBytes(total) }))),
      );
      const shown = paths.slice(0, MAX_ARCHIVE_ENTRIES);
      if (shown.length < paths.length) {
        root.append(
          h('div', { class: 'notice' }, t('archiveTruncated', { shown: shown.length, total: paths.length })),
        );
      }
      const list = h('div', { class: 'archive-list', role: 'list' });
      for (const path of shown) {
        const bytes = entries[path] as Uint8Array;
        const openButton = h('button', { class: 'archive-row', type: 'button', title: t('archiveOpen') });
        const name = h('span', { class: 'archive-name' });
        name.textContent = path;
        openButton.append(name, h('span', { class: 'archive-size' }, formatBytes(bytes.length)));
        openButton.addEventListener('click', () => {
          const nested = new File([bytes.slice()], baseName(path), { type: nestedMime(path) });
          window.dispatchEvent(new CustomEvent<File>(OPEN_NESTED_EVENT, { detail: nested }));
        });
        const save = h('a', { class: 'btn small archive-save', title: t('download'), download: baseName(path) });
        save.append(icon('download'));
        let url: string | null = null;
        const ensureUrl = (): void => {
          if (url) return;
          url = URL.createObjectURL(new Blob([bytes.slice()]));
          this.urls.push(url);
          save.href = url;
        };
        save.addEventListener('mouseenter', ensureUrl);
        save.addEventListener('click', ensureUrl);
        list.append(h('div', { class: 'archive-item', role: 'listitem' }, openButton, save));
      }
      root.append(list);
    }
    container.append(root);
    this.root = root;
  }

  destroy(): void {
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
    this.root?.remove();
    this.root = null;
  }
}

export function createViewer(): FileViewerPlugin {
  return new ArchiveViewer();
}
