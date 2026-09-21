import { t } from '../../i18n';
import { h } from '../../ui/dom';
import { readOleStreams } from './cfb';

/**
 * Legacy PowerPoint (97-2003) text via the PowerPoint Document stream (MS-PPT).
 * Record walk collects TextBytesAtom (ANSI) and TextCharsAtom (UTF-16LE)
 * payloads in document order; containers recurse.
 */

const UTF16 = new TextDecoder('utf-16le');
const ANSI = new TextDecoder('windows-1252');

const TEXT_BYTES_ATOM = 0x0fa0;
const TEXT_CHARS_ATOM = 0x0fa8;

function walkRecords(
  view: DataView,
  bytes: Uint8Array,
  offset: number,
  end: number,
  visit: (type: number, payload: Uint8Array) => void,
): void {
  let at = offset;
  let guard = 1000000;
  while (at + 8 <= end) {
    if (guard-- <= 0) throw new Error('Invalid PowerPoint file');
    const verInst = view.getUint16(at, true);
    const recType = view.getUint16(at + 2, true);
    const recLen = view.getUint32(at + 4, true);
    const bodyStart = at + 8;
    const bodyEnd = bodyStart + recLen;
    // Truncated tail: keep what was collected instead of failing.
    if (recLen > end - bodyStart || bodyEnd < bodyStart) break;
    if ((verInst & 0x000f) === 0x000f) {
      walkRecords(view, bytes, bodyStart, bodyEnd, visit);
    } else {
      visit(recType, bytes.subarray(bodyStart, bodyEnd));
    }
    at = bodyEnd;
  }
}

/** Plain-text paragraphs from every text atom of the deck. */
export function extractPptParagraphs(file: Uint8Array): string[] {
  const streams = readOleStreams(file);
  const doc = streams.get('PowerPoint Document');
  if (!doc || doc.length < 8) throw new Error('Invalid PowerPoint file');
  const view = new DataView(doc.buffer, doc.byteOffset, doc.byteLength);
  const texts: string[] = [];
  walkRecords(view, doc, 0, doc.length, (type, payload) => {
    if (type === TEXT_BYTES_ATOM) texts.push(ANSI.decode(payload));
    else if (type === TEXT_CHARS_ATOM) texts.push(UTF16.decode(payload));
  });
  return texts
    .join('')
    .split(/[\r\x0c]+/)
    .map((line) => line.replace(/[\x00-\x08\x0e-\x1f\x7f]/g, '').trim())
    .filter((line) => line !== '');
}

/** Renders legacy .ppt text as paragraphs. */
export function renderPpt(file: Uint8Array): HTMLElement {
  const root = h('div', { class: 'o-doc' });
  const paragraphs = extractPptParagraphs(file);
  if (paragraphs.length === 0) throw new Error(t('officeEmpty'));
  for (const line of paragraphs) {
    const p = h('p', {});
    p.textContent = line;
    root.append(p);
  }
  return root;
}
