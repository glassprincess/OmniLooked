import { formatExcelDate, formatPercent, isPlausibleDateSerial, numFmtKind } from './xlsx';
import { readOleStreams } from './cfb';

/**
 * Minimal BIFF8 (Excel 97-2003) sheet reader over the Workbook stream.
 * Supports: BoundSheet8, SST (+Continue), LabelSST/Label, Number, RK/MulRK,
 * BoolErr, Formula (+cached String), XF/Format for dates and percents.
 * Older BIFF2-5 files are rejected (the fallback viewer still covers them).
 */

const RECORD_BOF = 0x0809;
const RECORD_EOF = 0x000a;
const RECORD_BOUNDSHEET = 0x0085;
const RECORD_SST = 0x00fc;
const RECORD_LABELSST = 0x00fd;
const RECORD_LABEL = 0x0204;
const RECORD_NUMBER = 0x0203;
const RECORD_RK = 0x027e;
const RECORD_MULRK = 0x00bd;
const RECORD_BOOLERR = 0x0205;
const RECORD_FORMULA = 0x0006;
const RECORD_STRING = 0x0207;
const RECORD_XF = 0x00e0;
const RECORD_FORMAT = 0x041e;
const RECORD_CONTINUE = 0x003c;

interface BiffRecord {
  id: number;
  data: Uint8Array;
  /** Raw stream offset of the record header (CONTINUE merging shifts data, not this). */
  offset: number;
}

export interface XlsSheet {
  name: string;
  cells: Map<number, Map<number, string>>;
  totalRows: number;
  totalCols: number;
}

function dv(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function u16(view: DataView, data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > data.length) throw new Error('Invalid Excel file');
  return view.getUint16(offset, true);
}

function u32(view: DataView, data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > data.length) throw new Error('Invalid Excel file');
  return view.getUint32(offset, true);
}

/** Splits the stream into records, merging CONTINUE fragments. */
export function splitRecords(stream: Uint8Array): BiffRecord[] {
  const records: BiffRecord[] = [];
  const view = dv(stream);
  let offset = 0;
  let current: { id: number; start: number; parts: Uint8Array[] } | null = null;
  const flush = (): void => {
    if (!current) return;
    const total = current.parts.reduce((sum, part) => sum + part.length, 0);
    const data = new Uint8Array(total);
    let at = 0;
    for (const part of current.parts) {
      data.set(part, at);
      at += part.length;
    }
    records.push({ id: current.id, data, offset: current.start });
    current = null;
  };
  while (offset + 4 <= stream.length) {
    const id = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    if (offset + 4 + size > stream.length) throw new Error('Invalid Excel file');
    const data = stream.subarray(offset + 4, offset + 4 + size);
    if (id === RECORD_CONTINUE) {
      if (!current) throw new Error('Invalid Excel file');
      current.parts.push(data);
    } else {
      flush();
      current = { id, start: offset, parts: [data] };
    }
    offset += 4 + size;
  }
  flush();
  return records;
}

/** Short unicode string: cch u8 (or u16 when wideCount) + flag + chars. */
function readShortString(view: DataView, data: Uint8Array, offset: number, wideCount: boolean): { text: string; next: number } {
  const cch = wideCount ? u16(view, data, offset) : (data[offset] ?? 0);
  if (cch > 10000) throw new Error('Invalid Excel file');
  const flag = data[offset + (wideCount ? 2 : 1)] ?? 0;
  const highByte = (flag & 1) !== 0;
  const start = offset + (wideCount ? 3 : 2);
  const byteLen = highByte ? cch * 2 : cch;
  if (start + byteLen > data.length) throw new Error('Invalid Excel file');
  if (highByte) {
    const chars: string[] = [];
    for (let i = 0; i < cch; i++) chars.push(String.fromCharCode(view.getUint16(start + i * 2, true)));
    return { text: chars.join(''), next: start + byteLen };
  }
  return { text: new TextDecoder('windows-1252').decode(data.subarray(start, start + byteLen)), next: start + byteLen };
}

/** Full SST string. Rich runs and extended data follow the characters. */
function readSstString(view: DataView, data: Uint8Array, offset: number): { text: string; next: number } {
  const cch = u16(view, data, offset);
  if (cch > 100000) throw new Error('Invalid Excel file');
  const flags = data[offset + 2] ?? 0;
  let at = offset + 3;
  let runs = 0;
  if ((flags & 0x08) !== 0) {
    runs = u16(view, data, at);
    if (runs > 10000) throw new Error('Invalid Excel file');
    at += 2;
  }
  let extLen = 0;
  if ((flags & 0x04) !== 0) {
    extLen = u32(view, data, at);
    if (extLen > data.length) throw new Error('Invalid Excel file');
    at += 4;
  }
  const highByte = (flags & 0x01) !== 0;
  const byteLen = highByte ? cch * 2 : cch;
  if (at + byteLen + runs * 4 + extLen > data.length) throw new Error('Invalid Excel file');
  let text: string;
  if (highByte) {
    const chars: string[] = [];
    for (let i = 0; i < cch; i++) chars.push(String.fromCharCode(view.getUint16(at + i * 2, true)));
    text = chars.join('');
  } else {
    text = new TextDecoder('windows-1252').decode(data.subarray(at, at + byteLen));
  }
  return { text, next: at + byteLen + runs * 4 + extLen };
}

function decodeRK(rk: number): number {
  let value: number;
  if ((rk & 2) !== 0) {
    value = (rk | 0) >> 2; // 30-bit signed integer
  } else {
    const buf = new ArrayBuffer(8);
    const d = new DataView(buf);
    d.setUint32(0, (rk & 0xfffffffc) >>> 0, false);
    d.setUint32(4, 0, false);
    value = d.getFloat64(0, false);
  }
  return (rk & 1) !== 0 ? value / 100 : value;
}

const BOOLERR_TEXT: Record<number, string> = {
  0x00: '#NULL!',
  0x07: '#DIV/0!',
  0x0f: '#VALUE!',
  0x17: '#REF!',
  0x1d: '#NAME?',
  0x24: '#NUM!',
  0x2a: '#N/A',
};

function styledNumber(raw: string, xf: number, xfFormats: number[], custom: Map<number, string>): string {
  if (xf < 0 || xf >= xfFormats.length) return raw;
  const kind = numFmtKind(xfFormats[xf] as number, custom.get(xfFormats[xf] as number) ?? null);
  if (kind === 'date') {
    const serial = Number(raw);
    if (Number.isFinite(serial) && isPlausibleDateSerial(serial)) return formatExcelDate(serial);
  } else if (kind === 'percent') {
    return formatPercent(raw);
  }
  return raw;
}

interface BoundSheet {
  name: string;
  offset: number;
}

/** BIFF8 Workbook stream -> sheets with display strings. */
export function parseXlsSheets(file: Uint8Array): XlsSheet[] {
  const streams = readOleStreams(file);
  const workbook = streams.get('Workbook') ?? streams.get('Book');
  if (!workbook) throw new Error('Invalid Excel file');
  const records = splitRecords(workbook);

  const boundSheets: BoundSheet[] = [];
  const sst: string[] = [];
  const xfFormats: number[] = [];
  const custom = new Map<number, string>();
  let sawGlobals = false;

  for (const record of records) {
    const view = dv(record.data);
    switch (record.id) {
      case RECORD_BOF: {
        if (record.data.length < 4) throw new Error('Invalid Excel file');
        if (u16(view, record.data, 0) !== 0x0600) throw new Error('Unsupported Excel version');
        sawGlobals = true;
        break;
      }
      case RECORD_BOUNDSHEET: {
        const offset = u32(view, record.data, 0);
        const type = record.data[5] ?? 0;
        const { text } = readShortString(view, record.data, 6, false);
        if (type === 0) boundSheets.push({ name: text === '' ? 'Sheet' : text, offset });
        break;
      }
      case RECORD_SST: {
        const unique = u32(view, record.data, 4);
        if (unique > 1000000) throw new Error('Invalid Excel file');
        let at = 8;
        for (let i = 0; i < unique; i++) {
          const parsed = readSstString(view, record.data, at);
          sst.push(parsed.text);
          at = parsed.next;
        }
        break;
      }
      case RECORD_XF: {
        xfFormats.push(u16(view, record.data, 2));
        break;
      }
      case RECORD_FORMAT: {
        const ifmt = u16(view, record.data, 0);
        const { text } = readShortString(view, record.data, 2, true);
        custom.set(ifmt, text);
        break;
      }
      default:
        break;
    }
    // Globals end at the first sheet substream; the rest is parsed per sheet.
    if (record.id === RECORD_BOF && sawGlobals && record.data.length >= 4) {
      const dt = u16(view, record.data, 2);
      if (dt === 0x0010) break;
    }
  }
  if (!sawGlobals || boundSheets.length === 0) throw new Error('Invalid Excel file');

  const ordered = [...boundSheets].sort((a, b) => a.offset - b.offset);
  return ordered.map((bound, index) => {
    const next = index + 1 < ordered.length ? (ordered[index + 1] as BoundSheet).offset : Number.MAX_SAFE_INTEGER;
    const slice = records.filter((record) => record.offset >= bound.offset && record.offset < next);
    return parseSheetSlice(slice, bound.name, sst, xfFormats, custom);
  });
}

function setCell(cells: Map<number, Map<number, string>>, row: number, col: number, value: string): { row: number; col: number } {
  let rowMap = cells.get(row);
  if (!rowMap) {
    rowMap = new Map();
    cells.set(row, rowMap);
  }
  rowMap.set(col, value);
  return { row, col };
}

function parseSheetSlice(
  slice: BiffRecord[],
  name: string,
  sst: string[],
  xfFormats: number[],
  custom: Map<number, string>,
): XlsSheet {
  const cells = new Map<number, Map<number, string>>();
  let maxRow = -1;
  let maxCol = -1;
  let pendingFormula: { row: number; col: number; xf: number } | null = null;

  const track = (row: number, col: number): void => {
    if (row >= 0 && col >= 0) {
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
    }
  };

  for (const record of slice) {
    const view = dv(record.data);
    const data = record.data;
    switch (record.id) {
      case RECORD_BOF:
      case RECORD_EOF:
        pendingFormula = null;
        break;
      case RECORD_NUMBER: {
        if (data.length < 14) throw new Error('Invalid Excel file');
        const row = u16(view, data, 0);
        const col = u16(view, data, 2);
        const xf = u16(view, data, 4);
        const value = new DataView(data.buffer, data.byteOffset + 6, 8).getFloat64(0, true);
        setCell(cells, row, col, styledNumber(String(value), xf, xfFormats, custom));
        track(row, col);
        pendingFormula = null;
        break;
      }
      case RECORD_RK: {
        const row = u16(view, data, 0);
        const col = u16(view, data, 2);
        const xf = u16(view, data, 4);
        const value = decodeRK(u32(view, data, 6));
        setCell(cells, row, col, styledNumber(String(value), xf, xfFormats, custom));
        track(row, col);
        pendingFormula = null;
        break;
      }
      case RECORD_MULRK: {
        const row = u16(view, data, 0);
        const colFirst = u16(view, data, 2);
        const colLast = u16(view, data, data.length - 2);
        const count = colLast - colFirst + 1;
        if (count < 1 || count > 256 || 4 + count * 6 + 2 > data.length) throw new Error('Invalid Excel file');
        for (let i = 0; i < count; i++) {
          const xf = u16(view, data, 4 + i * 6);
          const value = decodeRK(u32(view, data, 4 + i * 6 + 2));
          setCell(cells, row, colFirst + i, styledNumber(String(value), xf, xfFormats, custom));
          track(row, colFirst + i);
        }
        pendingFormula = null;
        break;
      }
      case RECORD_LABELSST: {
        const row = u16(view, data, 0);
        const col = u16(view, data, 2);
        const index = u32(view, data, 6);
        setCell(cells, row, col, index < sst.length ? (sst[index] as string) : '');
        track(row, col);
        pendingFormula = null;
        break;
      }
      case RECORD_LABEL: {
        const row = u16(view, data, 0);
        const col = u16(view, data, 2);
        const { text } = readShortString(view, data, 6, true);
        setCell(cells, row, col, text);
        track(row, col);
        pendingFormula = null;
        break;
      }
      case RECORD_BOOLERR: {
        const row = u16(view, data, 0);
        const col = u16(view, data, 2);
        const value = data[6] ?? 0;
        const isErr = data[7] ?? 0;
        setCell(cells, row, col, isErr !== 0 ? (BOOLERR_TEXT[value] ?? '#ERROR!') : value !== 0 ? 'TRUE' : 'FALSE');
        track(row, col);
        pendingFormula = null;
        break;
      }
      case RECORD_FORMULA: {
        const row = u16(view, data, 0);
        const col = u16(view, data, 2);
        const xf = u16(view, data, 4);
        if (data.length < 14) throw new Error('Invalid Excel file');
        const special = data[6] === 0xff && data[7] === 0xff;
        if (!special) {
          const value = new DataView(data.buffer, data.byteOffset + 6, 8).getFloat64(0, true);
          // Writers that skip cached results (e.g. xlwt) leave non-finite
          // garbage: an uncalculated formula shows as an empty cell.
          if (Number.isFinite(value)) {
            setCell(cells, row, col, styledNumber(String(value), xf, xfFormats, custom));
            track(row, col);
          }
          pendingFormula = null;
        } else {
          const kind = data[8] ?? 3;
          if (kind === 0) {
            pendingFormula = { row, col, xf };
            track(row, col);
          } else if (kind === 1) {
            setCell(cells, row, col, (data[9] ?? 0) !== 0 ? 'TRUE' : 'FALSE');
            track(row, col);
            pendingFormula = null;
          } else if (kind === 2) {
            setCell(cells, row, col, BOOLERR_TEXT[data[9] ?? 0] ?? '#ERROR!');
            track(row, col);
            pendingFormula = null;
          } else {
            pendingFormula = null;
          }
        }
        break;
      }
      case RECORD_STRING: {
        if (pendingFormula) {
          const { text } = readShortString(view, data, 0, true);
          setCell(cells, pendingFormula.row, pendingFormula.col, text);
          pendingFormula = null;
        }
        break;
      }
      default:
        break;
    }
  }
  return { name, cells, totalRows: maxRow + 1, totalCols: maxCol + 1 };
}
