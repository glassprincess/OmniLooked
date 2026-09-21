import { t } from '../../i18n';
import { h } from '../../ui/dom';
import { OfficeImages } from './images';
import { parseRels, REL_NS, type Rel } from './rels';
import { isSafeHref } from './util';
import { attr, attrNS, childElements, childrenByLocal, firstChildByLocal, parseXml } from './xml';
import { optionalEntry, requireEntry, type ZipEntries } from './zip';

interface LevelFormat {
  kind: 'bullet' | 'ordered';
  fmt: string;
}

interface DocxContext {
  relsPath: string;
  rels: Map<string, Rel>;
  /** numId -> abstract level formats. */
  numbering: Map<number, Map<number, LevelFormat>>;
  /** numId -> counters per level. */
  counters: Map<number, number[]>;
  images: OfficeImages;
  blocks: number;
}

function toLetters(n: number): string {
  let result = '';
  let value = n;
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function toRoman(n: number): string {
  const table: Array<[number, string]> = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
    [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let result = '';
  let value = n;
  for (const [arabic, roman] of table) {
    while (value >= arabic) {
      result += roman;
      value -= arabic;
    }
  }
  return result === '' ? String(n) : result;
}

function formatCounter(n: number, fmt: string): string {
  switch (fmt) {
    case 'lowerLetter':
      return `${toLetters(n).toLowerCase()}.`;
    case 'upperLetter':
      return `${toLetters(n)}.`;
    case 'lowerRoman':
      return `${toRoman(n).toLowerCase()}.`;
    case 'upperRoman':
      return `${toRoman(n)}.`;
    default:
      return `${n}.`;
  }
}

/** numId -> (ilvl -> format). Unknown ids fall back to decimal counters. */
function parseNumbering(entries: ZipEntries): Map<number, Map<number, LevelFormat>> {
  const result = new Map<number, Map<number, LevelFormat>>();
  const bytes = optionalEntry(entries, 'word/numbering.xml');
  if (!bytes) return result;
  const doc = parseXml(bytes, 'word/numbering.xml');
  const abstracts = new Map<number, Map<number, LevelFormat>>();
  for (const abs of childrenByLocal(doc.documentElement, 'abstractNum')) {
    const id = Number(attr(abs, 'abstractNumId'));
    if (!Number.isInteger(id)) continue;
    const levels = new Map<number, LevelFormat>();
    for (const lvl of childrenByLocal(abs, 'lvl')) {
      const ilvl = Number(attr(lvl, 'ilvl'));
      if (!Number.isInteger(ilvl)) continue;
      const fmt = attr(firstChildByLocal(lvl, 'numFmt') ?? lvl, 'val') ?? 'decimal';
      levels.set(ilvl, { kind: fmt === 'bullet' ? 'bullet' : 'ordered', fmt });
    }
    abstracts.set(id, levels);
  }
  for (const num of childrenByLocal(doc.documentElement, 'num')) {
    const numId = Number(attr(num, 'numId'));
    const absId = Number(attr(firstChildByLocal(num, 'abstractNumId') ?? num, 'val'));
    if (!Number.isInteger(numId)) continue;
    result.set(numId, abstracts.get(absId) ?? new Map());
  }
  return result;
}

function listPrefix(ctx: DocxContext, numId: number, ilvl: number): string {
  const format = ctx.numbering.get(numId)?.get(ilvl);
  if (!format || format.kind === 'bullet') return '•';
  let counters = ctx.counters.get(numId);
  if (!counters) {
    counters = [];
    ctx.counters.set(numId, counters);
  }
  counters[ilvl] = (counters[ilvl] ?? 0) + 1;
  counters.length = ilvl + 1; // deeper levels restart
  return formatCounter(counters[ilvl] ?? 1, format.fmt);
}

/** Symbol-font glyphs (w:sym) mapped to readable equivalents. */
function symbolChar(code: string): string {
  const map: Record<string, string> = {
    F0B7: '•', F0A7: '❑', F0FC: '✓', F0FE: '■', F02D: '–', F020: ' ',
  };
  return map[code.toUpperCase()] ?? '•';
}

function applyRunStyle(span: HTMLSpanElement, rPr: Element | null): void {
  if (!rPr) return;
  const bold = firstChildByLocal(rPr, 'b');
  if (bold && attr(bold, 'val') !== 'false' && attr(bold, 'val') !== '0') span.style.fontWeight = 'bold';
  const italic = firstChildByLocal(rPr, 'i');
  if (italic && attr(italic, 'val') !== 'false' && attr(italic, 'val') !== '0') span.style.fontStyle = 'italic';
  const underline = firstChildByLocal(rPr, 'u');
  const strike = firstChildByLocal(rPr, 'strike') ?? firstChildByLocal(rPr, 'dstrike');
  const decorations: string[] = [];
  if (underline && attr(underline, 'val') !== 'none') decorations.push('underline');
  if (strike) decorations.push('line-through');
  if (decorations.length > 0) span.style.textDecoration = decorations.join(' ');
  const vertAlign = attr(firstChildByLocal(rPr, 'vertAlign') ?? rPr, 'val');
  if (vertAlign === 'superscript' || vertAlign === 'subscript') span.style.verticalAlign = vertAlign;
  const color = attr(firstChildByLocal(rPr, 'color') ?? rPr, 'val');
  if (color && color !== 'auto' && /^[0-9a-fA-F]{6}$/.test(color)) span.style.color = `#${color}`;
  const size = Number(attr(firstChildByLocal(rPr, 'sz') ?? rPr, 'val'));
  if (Number.isFinite(size) && size > 0) {
    span.style.fontSize = `${Math.min(72, Math.max(6, size / 2))}pt`;
  }
}

function appendImage(ctx: DocxContext, host: HTMLElement, rId: string | null): void {
  const url = ctx.images.resolve(ctx.relsPath, ctx.rels, rId);
  if (!url) return;
  const img = h('img', { class: 'o-img', alt: '' });
  img.src = url;
  host.append(h('div', { class: 'o-img-wrap' }, img));
  ctx.blocks++;
}

/** Finds drawing/blip references (DrawingML and legacy VML pict). */
function appendRunImages(ctx: DocxContext, run: Element, host: HTMLElement): void {
  const queue: Element[] = [run];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (current.localName === 'blip' || current.localName === 'imagedata') {
      appendImage(ctx, host, attrNS(current, REL_NS, 'embed') ?? attrNS(current, REL_NS, 'id'));
    } else {
      queue.push(...childElements(current));
    }
  }
}

function renderRunContent(ctx: DocxContext, run: Element, host: HTMLElement): void {
  const rPr = firstChildByLocal(run, 'rPr');
  for (const child of childElements(run)) {
    switch (child.localName) {
      case 't': {
        const span = h('span', {});
        applyRunStyle(span, rPr);
        span.textContent = child.textContent ?? '';
        host.append(span);
        break;
      }
      case 'tab':
        host.append('\u00a0\u00a0\u00a0\u00a0');
        break;
      case 'br':
        host.append(h('br', {}));
        break;
      case 'sym': {
        const span = h('span', {});
        applyRunStyle(span, rPr);
        span.textContent = symbolChar(attr(child, 'char') ?? '');
        host.append(span);
        break;
      }
      case 'noBreakHyphen':
        host.append('‑');
        break;
      case 'drawing':
      case 'pict':
        appendRunImages(ctx, child, host);
        break;
      // instrText (field codes), bookmarkStart/End, rPr itself: skipped.
    }
  }
}

function hyperlinkHref(ctx: DocxContext, link: Element): string | null {
  const rId = attrNS(link, REL_NS, 'id');
  if (!rId) return null;
  const rel = ctx.rels.get(rId);
  if (!rel || rel.target.startsWith('#')) return null;
  return isSafeHref(rel.target) ? rel.target : null;
}

const HEADING_STYLE = new Map([
  ['title', 'h1'],
  ['heading1', 'h1'],
  ['heading2', 'h2'],
  ['heading3', 'h3'],
  ['heading4', 'h4'],
  ['heading5', 'h5'],
  ['heading6', 'h6'],
] as Array<[string, 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6']>);

function renderParagraph(ctx: DocxContext, p: Element): HTMLElement {
  const pPr = firstChildByLocal(p, 'pPr');
  const styleVal = (attr(firstChildByLocal(pPr ?? p, 'pStyle') ?? p, 'val') ?? '').toLowerCase();
  const tag = HEADING_STYLE.get(styleVal) ?? 'p';

  const numPr = pPr ? firstChildByLocal(pPr, 'numPr') : null;
  const numId = Number(attr(firstChildByLocal(numPr ?? p, 'numId') ?? p, 'val'));
  const ilvl = Number(attr(firstChildByLocal(numPr ?? p, 'ilvl') ?? p, 'val') ?? '0');
  const isList = numPr !== null && Number.isInteger(numId);

  const block = isList ? h('div', { class: 'o-li' }) : h(tag, {});
  if (isList) {
    const level = Number.isInteger(ilvl) ? ilvl : 0;
    block.style.marginLeft = `${level * 1.5}em`;
    block.append(h('span', { class: 'o-bullet' }, listPrefix(ctx, numId, level)), ' ');
  }

  const align = (attr(firstChildByLocal(pPr ?? p, 'jc') ?? p, 'val') ?? '').toLowerCase();
  if (align === 'center' || align === 'right') block.style.textAlign = align;
  else if (align === 'both' || align === 'distribute') block.style.textAlign = 'justify';

  for (const child of childElements(p)) {
    if (child.localName === 'r') {
      renderRunContent(ctx, child, block);
    } else if (child.localName === 'hyperlink') {
      const href = hyperlinkHref(ctx, child);
      if (href) {
        const link = h('a', { class: 'o-link', href, target: '_blank', rel: 'noopener noreferrer' });
        for (const run of childrenByLocal(child, 'r')) renderRunContent(ctx, run, link);
        block.append(link);
      } else {
        for (const run of childrenByLocal(child, 'r')) renderRunContent(ctx, run, block);
      }
    } else if (child.localName === 'fldSimple') {
      for (const run of childrenByLocal(child, 'r')) renderRunContent(ctx, run, block);
    }
  }

  ctx.blocks++;
  return block;
}

function renderTable(ctx: DocxContext, tbl: Element): HTMLElement {
  const table = h('table', { class: 'o-tbl' });
  for (const tr of childrenByLocal(tbl, 'tr')) {
    const row = h('tr', {});
    for (const tc of childrenByLocal(tr, 'tc')) {
      const cell = h('td', {});
      const gridSpan = Number(attr(firstChildByLocal(firstChildByLocal(tc, 'tcPr') ?? tc, 'gridSpan') ?? tc, 'val'));
      if (Number.isInteger(gridSpan) && gridSpan > 1) cell.colSpan = gridSpan;
      const paras = childrenByLocal(tc, 'p');
      if (paras.length === 0) cell.append('\u00a0');
      for (const p of paras) {
        // Cells keep their runs but not block-level tags or list prefixes.
        const inline = h('div', {});
        const rendered = renderParagraph(ctx, p);
        inline.append(...Array.from(rendered.childNodes));
        ctx.blocks--; // nested paragraphs are part of the table block
        cell.append(inline);
      }
      row.append(cell);
    }
    table.append(row);
  }
  ctx.blocks++;
  return table;
}

/** Renders word/document.xml into a readable document. Throws when empty. */
export function renderDocx(entries: ZipEntries, images: OfficeImages): HTMLElement {
  const doc = parseXml(requireEntry(entries, 'word/document.xml'), 'word/document.xml');
  const relsPath = 'word/_rels/document.xml.rels';
  const ctx: DocxContext = {
    relsPath,
    rels: parseRels(entries, relsPath),
    numbering: parseNumbering(entries),
    counters: new Map(),
    images,
    blocks: 0,
  };
  const root = h('div', { class: 'o-doc' });
  const body = firstChildByLocal(doc.documentElement, 'body');
  if (body) {
    for (const child of childElements(body)) {
      if (child.localName === 'p') root.append(renderParagraph(ctx, child));
      else if (child.localName === 'tbl') root.append(renderTable(ctx, child));
    }
  }
  if (ctx.blocks === 0) throw new Error(t('officeEmpty'));
  return root;
}
