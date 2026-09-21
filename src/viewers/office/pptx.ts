import { t } from '../../i18n';
import { h } from '../../ui/dom';
import { OfficeImages } from './images';
import { parseRels, REL_NS, resolvePartPath, type Rel } from './rels';
import { isSafeHref } from './util';
import { allDescendantsByLocal, attr, attrNS, childElements, childrenByLocal, firstChildByLocal, firstDescendantByLocal, parseXml } from './xml';
import { requireEntry, type ZipEntries } from './zip';

interface SlideContext {
  relsPath: string;
  rels: Map<string, Rel>;
  images: OfficeImages;
}

function applyDrawingRunStyle(span: HTMLSpanElement, rPr: Element | null): void {
  if (!rPr) return;
  if (attr(rPr, 'b') === '1') span.style.fontWeight = 'bold';
  if (attr(rPr, 'i') === '1') span.style.fontStyle = 'italic';
  if (attr(rPr, 'u') === 'sng' || attr(rPr, 'u') === 'dbl') span.style.textDecoration = 'underline';
  if (attr(rPr, 'strike') === 'sngStrike' || attr(rPr, 'strike') === 'dblStrike') {
    span.style.textDecoration = [span.style.textDecoration, 'line-through'].filter(Boolean).join(' ');
  }
  const size = Number(attr(rPr, 'sz'));
  if (Number.isFinite(size) && size > 0) span.style.fontSize = `${Math.min(96, Math.max(8, size / 100))}pt`;
}

/** Bullet marker for a DrawingML paragraph, or null for plain text. */
function bulletMarker(pPr: Element | null): string | null {
  if (!pPr) return null;
  if (firstChildByLocal(pPr, 'buNone')) return null;
  const buChar = firstChildByLocal(pPr, 'buChar');
  if (buChar) return attr(buChar, 'char') ?? '•';
  const buAutoNum = firstChildByLocal(pPr, 'buAutoNum');
  if (buAutoNum) return `${attr(buAutoNum, 'type') === 'arabicPeriod' ? '1.' : '•'}`;
  if (firstChildByLocal(pPr, 'buBlip')) return '•';
  return null;
}

function linkHref(ctx: SlideContext, hlink: Element): string | null {
  const rId = attrNS(hlink, REL_NS, 'id');
  if (!rId) return null;
  const rel = ctx.rels.get(rId);
  if (!rel || rel.target.startsWith('#')) return null;
  return isSafeHref(rel.target) ? rel.target : null;
}

function renderRun(ctx: SlideContext, run: Element, host: HTMLElement): void {
  const rPr = firstChildByLocal(run, 'rPr');
  const hlink = firstChildByLocal(run, 'hlinkClick') ?? firstChildByLocal(run, 'hlinkMouseOver');
  const href = hlink ? linkHref(ctx, hlink) : null;
  const span = h('span', {});
  applyDrawingRunStyle(span, rPr);
  let content = false;
  for (const child of childElements(run)) {
    if (child.localName === 't') {
      span.append(child.textContent ?? '');
      content = true;
    } else if (child.localName === 'br') {
      span.append(h('br', {}));
      content = true;
    }
  }
  if (!content) return;
  if (href) {
    host.append(h('a', { class: 'o-link', href, target: '_blank', rel: 'noopener noreferrer' }, span));
  } else {
    host.append(span);
  }
}

/** Field runs (date/time/slide number) carry cached text in child t elements. */
function renderField(fld: Element, host: HTMLElement): void {
  const span = h('span', { class: 'o-field' });
  for (const t of childrenByLocal(fld, 't')) span.append(t.textContent ?? '');
  if (span.textContent !== '') host.append(span);
}

function renderDrawingParagraph(ctx: SlideContext, p: Element): HTMLElement {
  const pPr = firstChildByLocal(p, 'pPr');
  const level = Number(attr(pPr ?? p, 'lvl') ?? '0');
  const block = h('div', { class: 'o-spara' });
  if (Number.isInteger(level) && level > 0) block.style.marginLeft = `${level * 1.2}em`;
  const marker = bulletMarker(pPr);
  if (marker !== null) block.append(h('span', { class: 'o-bullet' }, marker), ' ');
  const align = (attr(pPr ?? p, 'algn') ?? '').toLowerCase();
  if (align === 'ctr') block.style.textAlign = 'center';
  else if (align === 'r') block.style.textAlign = 'right';
  else if (align === 'just') block.style.textAlign = 'justify';
  for (const child of childElements(p)) {
    if (child.localName === 'r') renderRun(ctx, child, block);
    else if (child.localName === 'fld') renderField(child, block);
    else if (child.localName === 'br') block.append(h('br', {}));
  }
  return block;
}

/** Shape text body (p:sp/p:txBody or table cell a:txBody). */
function renderTextBody(ctx: SlideContext, txBody: Element): HTMLElement {
  const body = h('div', {});
  for (const p of childrenByLocal(txBody, 'p')) body.append(renderDrawingParagraph(ctx, p));
  return body;
}

function renderShape(ctx: SlideContext, sp: Element): HTMLElement | null {
  const txBody = firstChildByLocal(sp, 'txBody');
  if (!txBody) return null;
  const shape = h('div', { class: 'o-shape' }, renderTextBody(ctx, txBody));
  return shape;
}

function renderPicture(ctx: SlideContext, pic: Element): HTMLElement | null {
  let rId: string | null = null;
  const queue: Element[] = [pic];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (current.localName === 'blip') {
      rId = attrNS(current, REL_NS, 'embed');
      break;
    }
    queue.push(...childElements(current));
  }
  const url = ctx.images.resolve(ctx.relsPath, ctx.rels, rId);
  if (!url) return null;
  const img = h('img', { class: 'o-img', alt: '' });
  img.src = url;
  return h('div', { class: 'o-img-wrap' }, img);
}

function renderDrawingTable(ctx: SlideContext, tbl: Element): HTMLElement {
  const table = h('table', { class: 'o-tbl' });
  const rows = childrenByLocal(tbl, 'tr');
  rows.forEach((tr, index) => {
    const row = h('tr', {});
    for (const tc of childrenByLocal(tr, 'tc')) {
      // First row is usually the header.
      const cell = h(index === 0 ? 'th' : 'td', {});
      const txBody = firstChildByLocal(tc, 'txBody');
      if (txBody) {
        for (const p of childrenByLocal(txBody, 'p')) {
          const line = h('div', {});
          const rendered = renderDrawingParagraph(ctx, p);
          line.append(...Array.from(rendered.childNodes));
          cell.append(line);
        }
      }
      row.append(cell);
    }
    table.append(row);
  });
  return table;
}

function renderSlide(ctx: SlideContext, slideXml: Element, index: number): HTMLElement {
  const card = h('section', { class: 'o-slide', id: `slide-${index + 1}` });
  card.append(h('div', { class: 'o-slide-head' }, t('slideLabel', { n: index + 1 })));
  const body = h('div', { class: 'o-slide-body' });
  const tree = firstChildByLocal(slideXml, 'cSld');
  const spTree = tree ? firstChildByLocal(tree, 'spTree') : null;
  if (spTree) renderSpTreeChildren(ctx, spTree, body);
  // Table-only slides still count; shapes without text are skipped silently.
  card.append(body);
  return card;
}

/**
 * Shape tree walker. Real decks hide content in grouped shapes (grpSp),
 * compatibility wrappers (AlternateContent) and connector text (cxnSp).
 */
function renderSpTreeChildren(ctx: SlideContext, container: Element, body: HTMLElement): void {
  for (const child of childElements(container)) {
    switch (child.localName) {
      case 'sp': {
        const shape = renderShape(ctx, child);
        if (shape) body.append(shape);
        break;
      }
      case 'grpSp': {
        // Grouped shapes nest the same shape elements; recurse.
        renderSpTreeChildren(ctx, child, body);
        break;
      }
      case 'cxnSp': {
        const txBody = firstChildByLocal(child, 'txBody');
        if (txBody) body.append(h('div', { class: 'o-shape' }, renderTextBody(ctx, txBody)));
        break;
      }
      case 'pic': {
        const pic = renderPicture(ctx, child);
        if (pic) body.append(pic);
        break;
      }
      case 'graphicFrame': {
        renderGraphicFrame(ctx, child, body);
        break;
      }
      case 'AlternateContent': {
        // Compatibility wrapper: the Choice branch holds the real content.
        const choice = firstChildByLocal(child, 'Choice') ?? firstChildByLocal(child, 'Fallback');
        if (choice) renderSpTreeChildren(ctx, choice, body);
        break;
      }
      case 'tbl': {
        body.append(renderDrawingTable(ctx, child));
        break;
      }
      // nvGrpSpPr, grpSpPr, extLst and connectors without text carry nothing readable.
    }
  }
}

function renderGraphicFrame(ctx: SlideContext, frame: Element, body: HTMLElement): void {
  // Tables live here too (graphicData/table in real files).
  const nested = firstDescendantByLocal(frame, 'tbl');
  if (nested) {
    body.append(renderDrawingTable(ctx, nested));
    return;
  }
  // SmartArt (dgm:t) and inline chart titles (a:t) still carry readable text.
  const texts = allDescendantsByLocal(frame, 't')
    .map((t) => t.textContent ?? '')
    .filter((text) => text !== '');
  if (texts.length > 0) {
    const block = h('div', { class: 'o-shape' });
    for (const text of texts) {
      const line = h('div', { class: 'o-spara' });
      line.textContent = text;
      block.append(line);
    }
    body.append(block);
    return;
  }
  body.append(h('div', { class: 'o-chart' }, t('chartPlaceholder')));
}

/** Renders the slide deck as stacked cards with a slide jumper. Throws when empty. */
export function renderPptx(entries: ZipEntries, images: OfficeImages): HTMLElement {
  const presentation = parseXml(requireEntry(entries, 'ppt/presentation.xml'), 'ppt/presentation.xml');
  const presRels = parseRels(entries, 'ppt/_rels/presentation.xml.rels');
  const sldIdLst = firstChildByLocal(presentation.documentElement, 'sldIdLst');
  const slidePaths: string[] = [];
  if (sldIdLst) {
    for (const sldId of childrenByLocal(sldIdLst, 'sldId')) {
      const rel = presRels.get(attrNS(sldId, REL_NS, 'id') ?? '');
      if (!rel || rel.external) continue;
      slidePaths.push(resolvePartPath('ppt/_rels/presentation.xml.rels', rel.target));
    }
  }
  if (slidePaths.length === 0) throw new Error(t('officeEmpty'));

  const root = h('div', { class: 'o-deck' });
  const jumper = h('select', { class: 'select', 'aria-label': t('slidesLabel') });
  slidePaths.forEach((_, index) => {
    jumper.append(h('option', { value: `slide-${index + 1}` }, t('slideLabel', { n: index + 1 })));
  });
  jumper.addEventListener('change', () => {
    root.querySelector(`#${CSS.escape(jumper.value)}`)?.scrollIntoView({ block: 'start' });
  });
  root.append(h('div', { class: 'panel-bar' }, h('label', {}, t('slidesLabel')), jumper));

  slidePaths.forEach((path, index) => {
    const slideXml = parseXml(requireEntry(entries, path), path);
    const relsDir = path.replace(/[^/]+$/, '');
    const relsPath = `${relsDir}_rels/${path.slice(relsDir.length)}.rels`;
    const ctx: SlideContext = {
      relsPath,
      rels: parseRels(entries, relsPath),
      images,
    };
    root.append(renderSlide(ctx, slideXml.documentElement, index));
  });
  return root;
}
