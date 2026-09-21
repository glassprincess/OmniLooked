import { MEDIA_EXTENSIONS } from '../../core/extensions';
import { SNIFF_BYTES } from '../../core/limits';
import { detectMedia } from '../../core/signatures';
import { t } from '../../i18n';
import type { FileViewerPlugin } from '../../types';
import { h } from '../../ui/dom';
import { ImageView } from './imageView';
import { waitForEvent } from './wait';

/** Some mobile browsers never fire metadata events before playback; do not keep the loader forever. */
const MEDIA_READY_TIMEOUT_MS = 3000;

class MediaViewer implements FileViewerPlugin {
  readonly id = 'media';
  readonly name = 'Media';
  readonly supportedExtensions: readonly string[] = MEDIA_EXTENSIONS;

  private objectUrl: string | null = null;
  private root: HTMLElement | null = null;
  private image: ImageView | null = null;
  private media: HTMLMediaElement | null = null;

  matches(_file: File, magicBytes: Uint8Array): boolean {
    return detectMedia(magicBytes) !== null;
  }

  async render(file: File, container: HTMLElement, signal: AbortSignal): Promise<void> {
    // The element type comes from the signature, not from the extension.
    const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
    signal.throwIfAborted();
    const info = detectMedia(head);
    if (!info) throw new Error(t('mediaFailed'));

    const url = URL.createObjectURL(file);
    this.objectUrl = url;

    if (info.kind === 'image') {
      const view = new ImageView(file.name);
      this.image = view;
      container.append(view.element);
      this.root = view.element;
      await view.load(url, signal);
      return;
    }

    const element = info.kind === 'video' ? h('video') : h('audio');
    element.controls = true;
    element.preload = 'metadata';
    if (element instanceof HTMLVideoElement) element.playsInline = true;
    this.media = element;

    if (info.kind === 'video') {
      element.className = 'media-video';
      this.root = element;
      container.append(element);
    } else {
      element.className = 'media-audio-player';
      const root = h('div', { class: 'media-audio' }, h('div', { class: 'media-audio-name' }, file.name), element);
      this.root = root;
      container.append(root);
    }

    const ready = waitForEvent(element, 'loadedmetadata', signal, t('mediaFailed'), MEDIA_READY_TIMEOUT_MS);
    element.src = url;
    await ready;
  }

  destroy(): void {
    this.image?.destroy();
    this.image = null;
    if (this.media) {
      this.media.pause();
      this.media.removeAttribute('src');
      this.media.load();
      this.media = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.root?.remove();
    this.root = null;
  }
}

export function createViewer(): FileViewerPlugin {
  return new MediaViewer();
}
