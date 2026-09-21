import { t } from '../../i18n';
import { h } from '../../ui/dom';

/** Display cap: huge sheets render partially with a notice. */
export const MAX_SHEET_ROWS = 2000;
export const MAX_SHEET_COLS = 50;

export function colLettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) return -1;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

export function colIndexToLetters(index: number): string {
  let result = '';
  let value = index + 1;
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

export interface SheetBookEntry {
  name: string;
  /** Dense grid of display strings, already capped. */
  grid: string[][];
  totalRows: number;
  truncated: boolean;
}

/** Builds a capped dense grid from sparse cells. Shared by xlsx and legacy xls. */
export function buildSheetGrid(
  cells: Map<number, Map<number, string>>,
  totalRows: number,
  totalCols: number,
): { grid: string[][]; truncated: boolean } {
  const showRows = Math.min(totalRows, MAX_SHEET_ROWS);
  const showCols = Math.min(totalCols, MAX_SHEET_COLS);
  const grid: string[][] = [];
  for (let r = 0; r < showRows; r++) {
    const rowMap = cells.get(r);
    const row: string[] = [];
    for (let c = 0; c < showCols; c++) row.push(rowMap?.get(c) ?? '');
    grid.push(row);
  }
  return { grid, truncated: showRows < totalRows || showCols < totalCols };
}

function renderSheetTable(grid: string[][]): HTMLElement {
  const table = h('table', { class: 'o-sheet' });
  const colCount = grid.length > 0 ? (grid[0] as string[]).length : 0;
  const head = h('tr', {}, h('th', { class: 'o-corner' }));
  for (let c = 0; c < colCount; c++) head.append(h('th', {}, colIndexToLetters(c)));
  table.append(h('thead', {}, head));
  const body = h('tbody', {});
  grid.forEach((row, r) => {
    const tr = h('tr', {}, h('th', { class: 'o-rownum' }, String(r + 1)));
    for (const value of row) {
      const td = h('td', {});
      td.textContent = value;
      tr.append(td);
    }
    body.append(tr);
  });
  table.append(body);
  return table;
}

/** Workbook with a sheet switcher. Throws when there are no sheets. */
export function renderSheetBook(sheets: SheetBookEntry[]): HTMLElement {
  if (sheets.length === 0) throw new Error(t('officeEmpty'));
  const root = h('div', { class: 'o-book' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const panels = h('div', { class: 'panels' });
  root.append(tabs, panels);

  sheets.forEach((sheet, index) => {
    const selected = index === 0;
    const button = h('button', {
      class: 'tab',
      type: 'button',
      role: 'tab',
      'aria-selected': String(selected),
    });
    button.textContent = sheet.name;
    const panel = h('div', { class: 'panel', role: 'tabpanel', hidden: !selected });
    if (sheet.truncated) {
      panel.append(
        h('div', { class: 'notice' }, t('officeSheetTruncated', {
          shown: sheet.grid.length,
          total: sheet.totalRows,
        })),
      );
    }
    panel.append(h('div', { class: 'o-sheet-wrap' }, renderSheetTable(sheet.grid)));
    button.addEventListener('click', () => {
      for (const [i, other] of Array.from(panels.children).entries()) {
        (other as HTMLElement).hidden = i !== index;
      }
      for (const [i, other] of Array.from(tabs.children).entries()) {
        (other as HTMLElement).setAttribute('aria-selected', String(i === index));
      }
    });
    tabs.append(button);
    panels.append(panel);
  });

  return root;
}
