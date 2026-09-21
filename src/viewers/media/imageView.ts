import { t } from '../../i18n';
import { h } from '../../ui/dom';
import { waitForEvent } from './wait';

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 40;
const BUTTON_STEP = 1.25;
const WHEEL_SENSITIVITY = 0.002;

interface Point {
  x: number;
  y: number;
}

/** Image with zoom (wheel, pinch, buttons) and pan (drag). The image is positioned by a CSS transform. */
export class ImageView {
  readonly element: HTMLDivElement;
  private readonly img: HTMLImageElement;
  private readonly percent: HTMLSpanElement;
  private readonly observer: ResizeObserver;
  private readonly pointers = new Map<number, Point>();
  private scale = 1;
  private x = 0;
  private y = 0;
  /** Once the user zooms or pans, resizing the window no longer re-fits the image. */
  private adjusted = false;
  private loaded = false;

  constructor(alt: string) {
    this.img = h('img', { alt, draggable: 'false' });
    this.percent = h('span', { class: 'zoom-percent' });

    const zoomOut = this.button('−', t('zoomOut'), () => this.zoomAtCenter(1 / BUTTON_STEP));
    const zoomIn = this.button('+', t('zoomIn'), () => this.zoomAtCenter(BUTTON_STEP));
    const actual = this.button(t('zoomActual'), t('zoomActual'), () => this.zoomAtCenter(1 / this.scale));
    const fit = this.button(t('zoomFit'), t('zoomFit'), () => this.fit());
    const controls = h('div', { class: 'zoom-controls' }, zoomOut, this.percent, zoomIn, actual, fit);
    // Controls must not start a pan or a double-click zoom.
    controls.addEventListener('pointerdown', (event) => event.stopPropagation());
    controls.addEventListener('dblclick', (event) => event.stopPropagation());

    this.element = h('div', { class: 'image-stage' }, this.img, controls);
    this.element.addEventListener('wheel', this.onWheel, { passive: false });
    this.element.addEventListener('pointerdown', this.onPointerDown);
    this.element.addEventListener('pointermove', this.onPointerMove);
    this.element.addEventListener('pointerup', this.onPointerEnd);
    this.element.addEventListener('pointercancel', this.onPointerEnd);
    this.element.addEventListener('dblclick', this.onDoubleClick);

    this.observer = new ResizeObserver(() => {
      if (!this.adjusted) this.fit();
    });
    this.observer.observe(this.element);
    this.updatePercent();
  }

  async load(url: string, signal: AbortSignal): Promise<void> {
    const ready = waitForEvent(this.img, 'load', signal, t('mediaFailed'));
    this.img.src = url;
    await ready;
    this.loaded = true;
    this.fit();
  }

  destroy(): void {
    this.observer.disconnect();
    this.pointers.clear();
    this.img.removeAttribute('src');
    this.element.remove();
  }

  private button(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = h('button', { class: 'btn small', type: 'button', title, 'aria-label': title }, label);
    button.addEventListener('click', onClick);
    return button;
  }

  private fit(): void {
    const width = this.element.clientWidth;
    const height = this.element.clientHeight;
    const naturalWidth = this.img.naturalWidth;
    const naturalHeight = this.img.naturalHeight;
    if (!this.loaded || width === 0 || height === 0 || naturalWidth === 0 || naturalHeight === 0) return;
    this.scale = Math.min(width / naturalWidth, height / naturalHeight, 1);
    this.x = (width - naturalWidth * this.scale) / 2;
    this.y = (height - naturalHeight * this.scale) / 2;
    this.adjusted = false;
    this.apply();
  }

  private zoomAt(factor: number, cx: number, cy: number): void {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.scale * factor));
    const k = next / this.scale;
    this.x = cx - (cx - this.x) * k;
    this.y = cy - (cy - this.y) * k;
    this.scale = next;
    this.adjusted = true;
    this.apply();
  }

  private zoomAtCenter(factor: number): void {
    this.zoomAt(factor, this.element.clientWidth / 2, this.element.clientHeight / 2);
  }

  private apply(): void {
    this.img.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
    this.updatePercent();
  }

  private updatePercent(): void {
    this.percent.textContent = `${Math.round(this.scale * 100)}%`;
  }

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    const rect = this.element.getBoundingClientRect();
    this.zoomAt(Math.exp(-delta * WHEEL_SENSITIVITY), event.clientX - rect.left, event.clientY - rect.top);
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.element.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.element.classList.add('dragging');
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const previous = this.pointers.get(event.pointerId);
    if (!previous) return;

    if (this.pointers.size === 1) {
      this.x += event.clientX - previous.x;
      this.y += event.clientY - previous.y;
      previous.x = event.clientX;
      previous.y = event.clientY;
      this.adjusted = true;
      this.apply();
      return;
    }

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const beforeDistance = Math.hypot(a.x - b.x, a.y - b.y);
      const beforeX = (a.x + b.x) / 2;
      const beforeY = (a.y + b.y) / 2;
      previous.x = event.clientX;
      previous.y = event.clientY;
      const afterDistance = Math.hypot(a.x - b.x, a.y - b.y);
      const afterX = (a.x + b.x) / 2;
      const afterY = (a.y + b.y) / 2;

      this.x += afterX - beforeX;
      this.y += afterY - beforeY;
      const rect = this.element.getBoundingClientRect();
      if (beforeDistance > 0) this.zoomAt(afterDistance / beforeDistance, afterX - rect.left, afterY - rect.top);
      else this.apply();
    }
  };

  private readonly onPointerEnd = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.pointers.size === 0) this.element.classList.remove('dragging');
  };

  private readonly onDoubleClick = (event: MouseEvent): void => {
    if (Math.abs(this.scale - 1) < 0.001) {
      this.fit();
      return;
    }
    const rect = this.element.getBoundingClientRect();
    this.zoomAt(1 / this.scale, event.clientX - rect.left, event.clientY - rect.top);
  };
}
