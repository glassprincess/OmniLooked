import { t } from '../../i18n';
import { parseRels, REL_NS, resolvePartPath } from './rels';
import { buildSheetGrid, renderSheetBook, type SheetBookEntry } from './sheetview';
import { attr, attrNS, childElements, childrenByLocal, collectText, firstChildByLocal, parseXml } from './xml';
import { requireEntry, type ZipEntries } from './zip';

export { colIndexToLetters, colLettersToIndex } from './sheetview';

/** A1 -> zero-based {col,row}; null on a malformed reference. */
export function parseCellRef(ref: string): { col: number; row: number } | null {
  const match = /^([A-Za-z]+)(\d+)$/.exec(ref.trim());
  if (!match) return null;
  const col = colLettersToIndexLocal(match[1]);
  const row = Number(match[2]) - 1;
  if (col < 0 || row < 0) return null;
  return { col, row };
}

function colLettersToIndexLocal(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) return -1;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

/** Built-in number formats that are dates (ECMA-376 §18.8.30). */
const BUILTIN_DATE_FMT = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 57,
]);

const BUILTIN_PERCENT_FMT = new Set([9, 10]);

export type NumFmtKind = 'date' | 'percent' | 'general';

/** Custom format codes: date tokens (y/m/d) win over the percent sign. */
export function numFmtKind(numFmtId: number, customCode: string | null): NumFmtKind {
  if (BUILTIN_DATE_FMT.has(numFmtId)) return 'date';
  if (BUILTIN_PERCENT_FMT.has(numFmtId)) return 'percent';
  if (customCode) {
    const stripped = customCode.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
    if (/[dmy]/i.test(stripped)) return 'date';
    if (stripped.includes('%')) return 'percent';
  }
  return 'general';
}

/** Excel serial day (1900 system) -> Date. */
export function excelSerialToDate(serial: number): Date {
  return new Date(Math.round((serial - 25569) * 86400 * 1000));
}

export function formatExcelDate(serial: number): string {
  const date = excelSerialToDate(serial);
  if (!Number.isFinite(date.getTime())) return String(serial);
  return Math.abs(serial % 1) > 1e-9 ? date.toLocaleString() : date.toLocaleDateString();
}

export function formatPercent(raw: string): string {
  const value = Number(raw);
  if (!Number.isFinite(value)) return raw;
  const percent = value * 100;
  const text = Number.isInteger(percent) ? String(percent) : percent.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `${text}%`;
}

/** Plausible Excel date serials (1900-01-01 .. ~2173). Guards style misreads. */
export function isPlausibleDateSerial(serial: number): boolean {
  return serial >= 0 && serial <= 100000;
}

interface SheetDef {
  name: string;
  path: string;
}

function parseSharedStrings(entries: ZipEntries): string[] {
  const bytes = entries['xl/sharedStrings.xml'];
  if (!bytes) return [];
  const doc = parseXml(bytes, 'xl/sharedStrings.xml');
  return childrenByLocal(doc.documentElement, 'si').map((si) => collectText(si));
}

function parseStyleFormats(entries: ZipEntries): { xfFormats: number[]; custom: Map<number, string> } {
  const xfFormats: number[] = [];
  const custom = new Map<number, string>();
  const bytes = entries['xl/styles.xml'];
  if (!bytes) return { xfFormats, custom };
  const doc = parseXml(bytes, 'xl/styles.xml');
  for (const numFmt of childrenByLocal(firstChildByLocal(doc.documentElement, 'numFmts') ?? doc.documentElement, 'numFmt')) {
    const id = Number(attr(numFmt, 'numFmtId'));
    const code = attr(numFmt, 'formatCode');
    if (Number.isInteger(id) && code !== null) custom.set(id, code);
  }
  for (const xf of childrenByLocal(firstChildByLocal(doc.documentElement, 'cellXfs') ?? doc.documentElement, 'xf')) {
    const id = Number(attr(xf, 'numFmtId'));
    xfFormats.push(Number.isInteger(id) ? id : 0);
  }
  return { xfFormats, custom };
}

export function resolveStyledNumber(
  raw: string,
  styleIndex: number,
  xfFormats: number[],
  custom: Map<number, string>,
): string {
  if (raw === '' || !Number.isInteger(styleIndex) || styleIndex < 0 || styleIndex >= xfFormats.length) {
    return raw;
  }
  const numFmtId = xfFormats[styleIndex] as number;
  const kind = numFmtKind(numFmtId, custom.get(numFmtId) ?? null);
  if (kind === 'date') {
    const serial = Number(raw);
    if (Number.isFinite(serial) && isPlausibleDateSerial(serial)) return formatExcelDate(serial);
  } else if (kind === 'percent') {
    return formatPercent(raw);
  }
  return raw;
}

function resolveCellValue(
  cell: Element,
  shared: string[],
  xfFormats: number[],
  custom: Map<number, string>,
): string {
  const type = attr(cell, 't') ?? '';
  const raw = firstChildByLocal(cell, 'v')?.textContent ?? '';
  switch (type) {
    case 's': {
      const index = Number(raw);
      return Number.isInteger(index) && index >= 0 && index < shared.length ? (shared[index] as string) : raw;
    }
    case 'inlineStr':
      return collectText(firstChildByLocal(cell, 'is') ?? cell);
    case 'b':
      return raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw;
    case 'e':
    case 'str':
      return raw;
    default: {
      // Numbers, formula results (cached <v>), and styled dates/percents.
      const styleIndex = Number(attr(cell, 's'));
      return resolveStyledNumber(raw, styleIndex, xfFormats, custom);
    }
  }
}

function parseSheet(
  entries: ZipEntries,
  path: string,
  shared: string[],
  xfFormats: number[],
  custom: Map<number, string>,
): { cells: Map<number, Map<number, string>>; totalRows: number; totalCols: number } {
  const doc = parseXml(requireEntry(entries, path), path);
  const cells = new Map<number, Map<number, string>>();
  let maxRow = -1;
  let maxCol = -1;
  let lastCol = -1;

  for (const rowEl of childElements(firstChildByLocal(doc.documentElement, 'sheetData') ?? doc.documentElement)) {
    if (rowEl.localName !== 'row') continue;
    const rowAttr = Number(attr(rowEl, 'r'));
    const rowIndex = Number.isInteger(rowAttr) ? rowAttr - 1 : maxRow + 1;
    for (const cell of childrenByLocal(rowEl, 'c')) {
      const ref = parseCellRef(attr(cell, 'r') ?? '');
      const col = ref ? ref.col : lastCol + 1;
      const row = ref ? ref.row : rowIndex;
      lastCol = col;
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
      let rowMap = cells.get(row);
      if (!rowMap) {
        rowMap = new Map();
        cells.set(row, rowMap);
      }
      rowMap.set(col, resolveCellValue(cell, shared, xfFormats, custom));
    }
  }
  return { cells, totalRows: maxRow + 1, totalCols: maxCol + 1 };
}

/** Renders workbook.xml sheets with a sheet switcher. Throws when empty. */
export function renderXlsx(entries: ZipEntries): HTMLElement {
  const workbook = parseXml(requireEntry(entries, 'xl/workbook.xml'), 'xl/workbook.xml');
  const rels = parseRels(entries, 'xl/_rels/workbook.xml.rels');
  const defs: SheetDef[] = [];
  const sheetsEl = firstChildByLocal(workbook.documentElement, 'sheets');
  if (sheetsEl) {
    for (const sheet of childrenByLocal(sheetsEl, 'sheet')) {
      const name = attr(sheet, 'name') ?? t('officeSheet');
      const rel = rels.get(attrNS(sheet, REL_NS, 'id') ?? '');
      if (!rel || rel.external) continue;
      defs.push({ name, path: resolvePartPath('xl/_rels/workbook.xml.rels', rel.target) });
    }
  }

  const shared = parseSharedStrings(entries);
  const { xfFormats, custom } = parseStyleFormats(entries);
  const books: SheetBookEntry[] = defs.map((def) => {
    const parsed = parseSheet(entries, def.path, shared, xfFormats, custom);
    const { grid, truncated } = buildSheetGrid(parsed.cells, parsed.totalRows, parsed.totalCols);
    return { name: def.name, grid, totalRows: parsed.totalRows, truncated };
  });
  return renderSheetBook(books);
}
