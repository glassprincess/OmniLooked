import { MAX_DISPLAY_LINE_CHARS } from '../../core/limits';
import { h } from '../../ui/dom';
import { VirtualList } from '../../ui/virtualList';

const ROW_HEIGHT = 20;

export interface TextView {
  readonly element: HTMLElement;
  destroy(): void;
}

function clip(line: string): string {
  return line.length > MAX_DISPLAY_LINE_CHARS ? `${line.slice(0, MAX_DISPLAY_LINE_CHARS)}…` : line;
}

/** Read-only, virtualized text with line numbers. Whitespace and line breaks are preserved. */
export function createTextView(text: string): TextView {
  const lines = text.split(/\r\n|\r|\n/);
  const list = new VirtualList({
    rowHeight: ROW_HEIGHT,
    rowCount: lines.length,
    createRow: () => h('div', {}, h('span', { class: 'tv-ln' }), h('span', { class: 'tv-tx' })),
    updateRow: (row, index) => {
      const gutter = row.firstElementChild;
      const code = row.lastElementChild;
      if (!gutter || !code) return;
      gutter.textContent = String(index + 1);
      code.textContent = clip(lines[index]);
    },
  });
  list.element.classList.add('text-view');
  list.element.style.setProperty('--ln-digits', String(String(lines.length).length));
  return { element: list.element, destroy: () => list.destroy() };
}
