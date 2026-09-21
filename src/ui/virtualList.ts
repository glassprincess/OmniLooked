import { h } from './dom';

export interface VirtualListOptions {
  /** Fixed row height in px. */
  rowHeight: number;
  rowCount: number;
  /** Extra rows rendered below the viewport. */
  overscan?: number;
  createRow(): HTMLElement;
  updateRow(row: HTMLElement, index: number): void;
  onRender?(firstRow: number, lastRow: number): void;
}

/**
 * Browsers cap the height of an element (roughly 17-33 million px depending on the engine). Beyond this height
 * the scroll position is mapped proportionally to the row index, so multi-gigabyte hex dumps stay scrollable.
 */
const MAX_SPACER_HEIGHT = 10_000_000;

/**
 * Fixed-height virtual scrolling: only the visible rows exist in the DOM, and they are reused.
 * Row content must be written with textContent (never innerHTML).
 */
export class VirtualList {
  readonly element: HTMLDivElement;
  private readonly spacer: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly pool: HTMLElement[] = [];
  private readonly observer: ResizeObserver;
  private rowCount: number;
  private frame = 0;
  private first = 0;
  private last = -1;
  private destroyed = false;

  private readonly schedule = (): void => {
    if (this.frame !== 0 || this.destroyed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  };

  constructor(private readonly options: VirtualListOptions) {
    this.rowCount = options.rowCount;
    this.spacer = h('div', { class: 'vlist-spacer' });
    this.body = h('div', { class: 'vlist-body' });
    this.element = h('div', { class: 'vlist' }, this.spacer, this.body);
    this.element.style.setProperty('--row-h', `${options.rowHeight}px`);
    this.element.addEventListener('scroll', this.schedule, { passive: true });
    this.observer = new ResizeObserver(this.schedule);
    this.observer.observe(this.element);
    this.updateSpacer();
  }

  setRowCount(count: number): void {
    this.rowCount = count;
    this.updateSpacer();
    this.schedule();
  }

  /** [first, last] rendered row indexes; last < first when nothing is rendered. */
  visibleRange(): [number, number] {
    return [this.first, this.last];
  }

  /** Re-renders the visible rows now (e.g. after data for them arrived). */
  refresh(): void {
    if (!this.destroyed) this.render();
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.observer.disconnect();
    this.element.removeEventListener('scroll', this.schedule);
    this.element.remove();
    this.pool.length = 0;
  }

  private updateSpacer(): void {
    const total = this.rowCount * this.options.rowHeight;
    this.spacer.style.height = `${Math.min(total, MAX_SPACER_HEIGHT)}px`;
  }

  private render(): void {
    const { rowHeight, overscan = 2 } = this.options;
    const viewport = this.element.clientHeight;
    const scrollTop = this.element.scrollTop;

    const total = this.rowCount * rowHeight;
    const spacerHeight = Math.min(total, MAX_SPACER_HEIGHT);
    const maxVirtual = Math.max(0, total - viewport);
    const maxReal = Math.max(0, spacerHeight - viewport);
    const ratio = maxReal > 0 ? maxVirtual / maxReal : 1;
    const virtualTop = Math.min(scrollTop * ratio, maxVirtual);

    const first = Math.min(Math.floor(virtualTop / rowHeight), Math.max(0, this.rowCount - 1));
    const offset = virtualTop - first * rowHeight;
    const wanted = Math.ceil((viewport + offset) / rowHeight) + overscan;
    const last = Math.min(this.rowCount - 1, first + wanted - 1);
    const visibleCount = Math.max(0, last - first + 1);

    while (this.pool.length < visibleCount) {
      const row = this.options.createRow();
      row.classList.add('vlist-row');
      this.body.append(row);
      this.pool.push(row);
    }
    for (let i = 0; i < this.pool.length; i++) {
      const row = this.pool[i];
      if (i < visibleCount) {
        row.style.display = '';
        this.options.updateRow(row, first + i);
      } else {
        row.style.display = 'none';
      }
    }

    this.body.style.transform = `translateY(${scrollTop - offset}px)`;
    this.first = first;
    this.last = last;
    this.options.onRender?.(first, last);
  }
}
