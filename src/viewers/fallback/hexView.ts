import { t } from '../../i18n';
import { h } from '../../ui/dom';
import { VirtualList } from '../../ui/virtualList';

const BYTES_PER_ROW = 16;
const ROW_HEIGHT = 20;
/** Bytes fetched per file.slice() call; a multiple of BYTES_PER_ROW. */
const BLOCK_BYTES = 64 * 1024;
const MAX_CACHED_BLOCKS = 64;

const HEX = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, '0'));

/**
 * Classic hex dump: offset, 16 bytes in hex, ASCII column. Virtualized, and the bytes are read on demand in
 * blocks via file.slice(), so files of any size open instantly and never sit in memory as a whole.
 */
export class HexView {
  readonly element: HTMLElement;
  private readonly list: VirtualList;
  private readonly size: number;
  private readonly offsetWidth: number;
  private readonly cache = new Map<number, Uint8Array>();
  private readonly loading = new Set<number>();
  private destroyed = false;

  constructor(private readonly file: File) {
    this.size = file.size;
    this.offsetWidth = Math.max(8, Math.max(0, file.size - 1).toString(16).length);

    const header = h('div', { class: 'hex-head' }, this.headerText());
    this.list = new VirtualList({
      rowHeight: ROW_HEIGHT,
      rowCount: Math.ceil(file.size / BYTES_PER_ROW),
      createRow: () => h('div'),
      updateRow: (row, index) => this.updateRow(row, index),
      onRender: (first, last) => this.ensureBlocks(first, last),
    });
    // The header does not scroll vertically, so keep it in step horizontally.
    this.list.element.addEventListener(
      'scroll',
      () => {
        header.scrollLeft = this.list.element.scrollLeft;
      },
      { passive: true },
    );
    this.element = h('div', { class: 'hex-view' }, header, this.list.element);
  }

  destroy(): void {
    this.destroyed = true;
    this.cache.clear();
    this.loading.clear();
    this.list.destroy();
    this.element.remove();
  }

  private headerText(): string {
    let columns = '';
    for (let i = 0; i < BYTES_PER_ROW; i++) {
      if (i === 8) columns += ' ';
      columns += `${HEX[i]} `;
    }
    return `${t('hexOffset').padEnd(this.offsetWidth)}  ${columns} ASCII`;
  }

  private updateRow(row: HTMLElement, index: number): void {
    const start = index * BYTES_PER_ROW;
    const offset = start.toString(16).padStart(this.offsetWidth, '0');
    const block = Math.floor(start / BLOCK_BYTES);
    const data = this.cache.get(block);
    if (!data) {
      row.textContent = offset; // bytes are still being read
      return;
    }
    const local = start - block * BLOCK_BYTES;
    let hex = '';
    let ascii = '';
    for (let i = 0; i < BYTES_PER_ROW; i++) {
      if (i === 8) hex += ' ';
      if (local + i < data.length && start + i < this.size) {
        const byte = data[local + i];
        hex += `${HEX[byte]} `;
        ascii += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.';
      } else {
        hex += '   ';
      }
    }
    row.textContent = `${offset}  ${hex}|${ascii}|`;
  }

  private ensureBlocks(first: number, last: number): void {
    if (last < first || this.size === 0) return;
    const firstBlock = Math.floor((first * BYTES_PER_ROW) / BLOCK_BYTES);
    const lastByte = Math.min((last + 1) * BYTES_PER_ROW, this.size) - 1;
    const lastBlock = Math.floor(lastByte / BLOCK_BYTES);
    for (let block = firstBlock; block <= lastBlock; block++) {
      if (!this.cache.has(block) && !this.loading.has(block)) void this.loadBlock(block);
    }
  }

  private async loadBlock(block: number): Promise<void> {
    this.loading.add(block);
    try {
      const start = block * BLOCK_BYTES;
      const buffer = await this.file.slice(start, start + BLOCK_BYTES).arrayBuffer();
      if (this.destroyed) return;
      this.cache.set(block, new Uint8Array(buffer));
      if (this.cache.size > MAX_CACHED_BLOCKS) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.list.refresh();
    } catch {
      // unreadable block: its rows keep showing the offset only
    } finally {
      this.loading.delete(block);
    }
  }
}
