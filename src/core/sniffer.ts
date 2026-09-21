import { MAX_CONTROL_CHAR_RATIO, SNIFF_BYTES } from './limits';
import { startsWith } from './signatures';

export interface SniffResult {
  /** Lower-case extension without the dot, or '' when there is none. */
  extension: string;
  /** Head of the file: the first bytes are the magic bytes. */
  bytes: Uint8Array;
}

export function getExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/** Layer 1: reads the extension and the head of the file. Never reads the whole file. */
export async function sniff(file: File): Promise<SniffResult> {
  const buffer = await file.slice(0, SNIFF_BYTES).arrayBuffer();
  return { extension: getExtension(file.name), bytes: new Uint8Array(buffer) };
}

export function hasTextBom(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, [0xef, 0xbb, 0xbf]) || // UTF-8
    startsWith(bytes, [0xff, 0xfe]) || //        UTF-16 LE
    startsWith(bytes, [0xfe, 0xff]) //           UTF-16 BE
  );
}

/** Backspace, tab, LF, form feed, CR, ESC (ANSI colours in logs). */
const ALLOWED_CONTROLS = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d, 0x1b]);

/**
 * Text heuristic on the sniffed head: no NUL bytes and almost no control characters.
 * Works for UTF-8 and single-byte encodings (Windows-1251, CP866, KOI8-R); UTF-16 is accepted by its BOM.
 */
export function isProbablyText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  if (hasTextBom(bytes)) return true;
  let stray = 0;
  for (const byte of bytes) {
    if (byte === 0x00) return false;
    if ((byte < 0x20 && !ALLOWED_CONTROLS.has(byte)) || byte === 0x7f) stray++;
  }
  return stray / bytes.length <= MAX_CONTROL_CHAR_RATIO;
}
