import { t } from '../../i18n';
import { h } from '../../ui/dom';
import { readOleStreams } from './cfb';

/**
 * Legacy Word (97-2003) body text via FIB + piece table (MS-DOC).
 * Offsets verified against [MS-DOC] FibBase / FibRgLw97 / FibRgFcLcb97 /
 * Clx / Pcdt / PlcPcd and cross-checked with word-extractor on real files.
 */

const UTF16 = new TextDecoder('utf-16le');
const WIN1252 = new TextDecoder('windows-1252');

export interface DocPiece {
  cpStart: number;
  filePos: number;
  unicode: boolean;
  text: string;
}

function dv(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function u16(view: DataView, data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > data.length) throw new Error('Invalid Word file');
  return view.getUint16(offset, true);
}

function u32(view: DataView, data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > data.length) throw new Error('Invalid Word file');
  return view.getUint32(offset, true);
}

export function parsePieces(table: Uint8Array, fcClx: number, lcbClx: number): Array<Omit<DocPiece, 'text'>> {
  if (fcClx < 0 || lcbClx <= 5 || fcClx + lcbClx > table.length) throw new Error('Invalid Word file');
  const view = dv(table);
  let pos = fcClx;
  const end = fcClx + lcbClx;
  // Skip RgPrc property groups; the piece table starts at the 0x02 marker.
  for (;;) {
    if (pos >= end) throw new Error('Invalid Word file');
    if (table[pos] !== 1) break;
    pos++;
    const skip = u16(view, table, pos);
    pos += 2 + skip;
  }
  if (table[pos] !== 2) throw new Error('Invalid Word file');
  pos++;
  const lcb = u32(view, table, pos);
  pos += 4;
  if (pos + lcb > end) throw new Error('Invalid Word file');
  const count = (lcb - 4) / 12;
  if (!Number.isInteger(count) || count < 0 || count > 100000) throw new Error('Invalid Word file');
  const pieces: Array<Omit<DocPiece, 'text'>> = [];
  for (let i = 0; i < count; i++) {
    const cpStart = u32(view, table, pos + i * 4);
    const cpEnd = u32(view, table, pos + (i + 1) * 4);
    if (cpEnd < cpStart) throw new Error('Invalid Word file');
    const fc = u32(view, table, pos + (count + 1) * 4 + i * 8 + 2);
    const unicode = (fc & 0x40000000) === 0;
    const filePos = unicode ? fc : Math.floor((fc & ~0x40000000) / 2);
    pieces.push({ cpStart, filePos, unicode });
  }
  return pieces;
}

export function pieceText(doc: Uint8Array, piece: Omit<DocPiece, 'text'>, chars: number): string {
  const byteLen = chars * (piece.unicode ? 2 : 1);
  if (piece.filePos < 0 || piece.filePos + byteLen > doc.length) throw new Error('Invalid Word file');
  const slice = doc.subarray(piece.filePos, piece.filePos + byteLen);
  return piece.unicode ? UTF16.decode(slice) : WIN1252.decode(slice);
}

/** Drops field instructions (0x13..0x14), keeps cached results (0x14..0x15). */
export function stripFieldCodes(text: string): string {
  let result = '';
  let skip = 0;
  for (const char of text) {
    if (char === '\u0013') skip++;
    else if (char === '\u0014') {
      if (skip > 0) skip--;
    } else if (char === '\u0015') {
      if (skip > 0) skip--;
    } else if (skip === 0) {
      result += char;
    }
  }
  return result;
}

/** Plain-text paragraphs of the main story ([0, ccpText)). */
export function extractDocParagraphs(file: Uint8Array): string[] {
  const streams = readOleStreams(file);
  const doc = streams.get('WordDocument');
  if (!doc || doc.length < 0x200) throw new Error('Invalid Word file');
  const view = dv(doc);
  const wIdent = view.getUint16(0, true);
  if (wIdent !== 0xa5ec && wIdent !== 0xa5dc) throw new Error('Invalid Word file');
  const flags = view.getUint16(0x0a, true);
  if ((flags & 0x0100) !== 0) throw new Error('Password-protected document');
  const tableName = (flags & 0x0200) !== 0 ? '1Table' : '0Table';
  const table = streams.get(tableName);
  if (!table) throw new Error('Invalid Word file');
  const ccpText = u32(view, doc, 0x4c);
  if (ccpText <= 0) return [];
  if (ccpText > 20000000) throw new Error('Invalid Word file');
  const fcClx = u32(view, doc, 0x1a2);
  const lcbClx = u32(view, doc, 0x1a6);
  const pieces = parsePieces(table, fcClx, lcbClx);

  let text = '';
  let cp = 0;
  for (let i = 0; i < pieces.length && cp < ccpText; i++) {
    const piece = pieces[i] as Omit<DocPiece, 'text'>;
    const nextCp = i + 1 < pieces.length ? (pieces[i + 1] as Omit<DocPiece, 'text'>).cpStart : ccpText;
    const take = Math.min(nextCp, ccpText) - Math.max(cp, piece.cpStart);
    if (take <= 0) continue;
    const skip = Math.max(0, cp - piece.cpStart);
    const full = pieceText(doc, piece, nextCp - piece.cpStart);
    text += full.substring(skip, skip + take);
    cp = Math.min(nextCp, ccpText);
  }

  return stripFieldCodes(text)
    .replace(/[\x07\x0b]/g, ' ')
    .split(/[\r\x0c]+/)
    .map((line) => line.replace(/[\x00-\x08\x0e-\x1f\x7f]/g, '').trim())
    .filter((line) => line !== '');
}

/** Renders legacy .doc body text as paragraphs. */
export function renderDoc(file: Uint8Array): HTMLElement {
  const root = h('div', { class: 'o-doc' });
  const paragraphs = extractDocParagraphs(file);
  if (paragraphs.length === 0) throw new Error(t('officeEmpty'));
  for (const line of paragraphs) {
    const p = h('p', {});
    p.textContent = line;
    root.append(p);
  }
  return root;
}
