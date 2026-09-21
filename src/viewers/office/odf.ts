import { t } from '../../i18n';
import { h } from '../../ui/dom';
import { OfficeImages } from './images';
import { buildSheetGrid, renderSheetBook, type SheetBookEntry } from './sheetview';
import { isSafeHref } from './util';
import { attr, childElements, childrenByLocal, firstChildByLocal, parseXml } from './xml';
import { requireEntry, type ZipEntries } from './zip';

/**
 * ODF text/spreadsheet/presentation (ODT/ODS/ODP): content.xml over ZIP.
 * All text goes through textContent; links are allow-listed; images load
 * from the package via blob URLs.
 */

interface TextStyle {
  bold: boolean;
  italic: boolean;
}

function parseTextStyles(root: Element): Map<string, TextStyle> {
  const result = new Map<string, TextStyle>();
  const auto = firstChildByLocal(root, 'automatic-styles');
  if (!auto) return result;
  for (const style of childrenByLocal(auto, 'style')) {
    const name = attr(style, 'name');
    if (!name) continue;
    const props = firstChildByLocal(style, 'text-properties');
    if (!props) continue;
    result.set(name, {
      bold: (attr(props, 'font-weight') ?? '') === 'bold',
      italic: (attr(props, 'font-style') ?? '') === 'italic',
    });
  }
  return result;
}

function renderInlineChildren(
  parent: Element,
  host: HTMLElement,
  styles: Map<string, TextStyle>,
): void {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 3) {
      host.append(node.textContent ?? '');
    } else if (node.nodeType === 1) {
      const el = node as Element;
      switch (el.localName) {
        case 'span': {
          const style = styles.get(attr(el, 'style-name') ?? '');
          const span = h('span', {});
          if (style?.bold) span.style.fontWeight = 'bold';
          if (style?.italic) span.style.fontStyle = 'italic';
          renderInlineChildren(el, span, styles);
          host.append(span);
          break;
        }
        case 'a': {
          const href = attr(el, 'href') ?? '';
          if (isSafeHref(href)) {
            const link = h('a', { class: 'o-link', href, target: '_blank', rel: 'noopener noreferrer' });
            renderInlineChildren(el, link, styles);
            host.append(link);
          } else {
            renderInlineChildren(el, host, styles);
          }
          break;
        }
        case 'line-break':
          host.append(h('br', {}));
          break;
        case 'tab':
          host.append('\u00a0\u00a0\u00a0');
          break;
        case 's': {
          const count = Number(attr(el, 'c') ?? '1');
          host.append('\u00a0'.repeat(Number.isInteger(count) && count > 0 && count < 100 ? count : 1));
          break;
        }
        default:
          renderInlineChildren(el, host, styles);
          break;
      }
    }
  }
}

function paragraphText(p: Element): string {
  return p.textContent ?? '';
}

function renderParagraph(p: Element, styles: Map<string, TextStyle>): HTMLElement {
  const block = h('p', {});
  renderInlineChildren(p, block, styles);
  return block;
}

function renderHeading(el: Element, styles: Map<string, TextStyle>): HTMLElement {
  const level = Number(attr(el, 'outline-level') ?? '1');
  const tag = level >= 1 && level <= 6 ? (`h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') : 'p';
  const block = h(tag, {});
  renderInlineChildren(el, block, styles);
  return block;
}

function renderList(el: Element, styles: Map<string, TextStyle>): HTMLElement {
  const list = h('ul', {});
  for (const item of childrenByLocal(el, 'list-item')) {
    const li = h('li', {});
    for (const child of childElements(item)) {
      if (child.localName === 'p') li.append(renderParagraph(child, styles));
      else if (child.localName === 'h') li.append(renderHeading(child, styles));
      else if (child.localName === 'list') li.append(renderList(child, styles));
    }
    list.append(li);
  }
  return list;
}

function renderOdfTable(table: Element, styles: Map<string, TextStyle>): HTMLElement {
  const out = h('table', { class: 'o-tbl' });
  for (const row of childrenByLocal(table, 'table-row')) {
    const repeats = Number(attr(row, 'number-rows-repeated') ?? '1');
    for (let r = 0; r < (Number.isInteger(repeats) && repeats > 0 && repeats < 1000 ? repeats : 1); r++) {
      const tr = h('tr', {});
      for (const cell of childElements(row)) {
        if (cell.localName === 'covered-table-cell') continue;
        if (cell.localName !== 'table-cell') continue;
        const td = h('td', {});
        const colRepeat = Number(attr(cell, 'number-columns-repeated') ?? '1');
        if (Number.isInteger(colRepeat) && colRepeat > 1 && colRepeat < 1000) td.colSpan = colRepeat;
        const paras = childrenByLocal(cell, 'p');
        if (paras.length === 0) {
          const raw = attr(cell, 'value') ?? attr(cell, 'date-value') ?? attr(cell, 'boolean-value') ?? '';
          td.textContent = raw === '' ? '\u00a0' : raw;
        }
        for (const p of paras) td.append(renderParagraph(p, styles));
        tr.append(td);
      }
      out.append(tr);
    }
  }
  return out;
}

function renderTextBody(body: Element, styles: Map<string, TextStyle>): HTMLElement {
  const root = h('div', { class: 'o-doc' });
  for (const child of childElements(body)) {
    if (child.localName === 'p') root.append(renderParagraph(child, styles));
    else if (child.localName === 'h') root.append(renderHeading(child, styles));
    else if (child.localName === 'list') root.append(renderList(child, styles));
    else if (child.localName === 'table') root.append(renderOdfTable(child, styles));
  }
  return root;
}

function renderSpreadsheet(body: Element): HTMLElement {
  const books: SheetBookEntry[] = [];
  for (const table of childrenByLocal(body, 'table')) {
    const name = attr(table, 'name') ?? t('officeSheet');
    const cells = new Map<number, Map<number, string>>();
    let maxRow = -1;
    let maxCol = -1;
    let rowIndex = 0;
    for (const row of childrenByLocal(table, 'table-row')) {
      const rowRepeats = Number(attr(row, 'number-rows-repeated') ?? '1');
      const repeatRows = Number.isInteger(rowRepeats) && rowRepeats > 0 && rowRepeats < 10000 ? rowRepeats : 1;
      let colIndex = 0;
      const rowCells: Array<{ text: string; span: number }> = [];
      for (const cell of childElements(row)) {
        if (cell.localName === 'covered-table-cell') {
          colIndex++;
          continue;
        }
        if (cell.localName !== 'table-cell') continue;
        const colRepeat = Number(attr(cell, 'number-columns-repeated') ?? '1');
        const span = Number.isInteger(colRepeat) && colRepeat > 0 && colRepeat < 1000 ? colRepeat : 1;
        const paras = childrenByLocal(cell, 'p');
        let text = paras.map(paragraphText).join('\n');
        if (text === '') {
          text = attr(cell, 'value') ?? attr(cell, 'date-value') ?? attr(cell, 'boolean-value') ?? '';
        }
        rowCells.push({ text, span });
        colIndex += span;
      }
      for (let r = 0; r < repeatRows; r++) {
        let c = 0;
        for (const { text, span } of rowCells) {
          let rowMap = cells.get(rowIndex);
          if (!rowMap) {
            rowMap = new Map();
            cells.set(rowIndex, rowMap);
          }
          rowMap.set(c, text);
          c += span;
        }
        if (rowIndex > maxRow) maxRow = rowIndex;
        rowIndex++;
      }
      if (colIndex - 1 > maxCol) maxCol = colIndex - 1;
    }
    const { grid, truncated } = buildSheetGrid(cells, maxRow + 1, maxCol + 1);
    books.push({ name, grid, totalRows: maxRow + 1, truncated });
  }
  return renderSheetBook(books);
}

function renderDrawText(flow: Element, styles: Map<string, TextStyle>, host: HTMLElement): void {
  for (const child of childElements(flow)) {
    if (child.localName === 'p') host.append(renderParagraph(child, styles));
    else if (child.localName === 'h') host.append(renderHeading(child, styles));
    else if (child.localName === 'list') host.append(renderList(child, styles));
    else renderDrawText(child, styles, host);
  }
}

function renderPresentation(body: Element, styles: Map<string, TextStyle>, images: OfficeImages): HTMLElement {
  const root = h('div', { class: 'o-deck' });
  const pages = childrenByLocal(body, 'page');
  if (pages.length === 0) throw new Error(t('officeEmpty'));
  pages.forEach((page, index) => {
    const card = h('section', { class: 'o-slide' });
    card.append(h('div', { class: 'o-slide-head' }, t('slideLabel', { n: index + 1 })));
    const content = h('div', { class: 'o-slide-body' });
    const queue: Element[] = [page];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      if (current.localName === 'text-box') {
        const shape = h('div', { class: 'o-shape' });
        renderDrawText(current, styles, shape);
        content.append(shape);
      } else if (current.localName === 'image') {
        const url = images.fromPath(attr(current, 'href') ?? '');
        if (url) {
          const img = h('img', { class: 'o-img', alt: '' });
          img.src = url;
          content.append(h('div', { class: 'o-img-wrap' }, img));
        }
      } else {
        queue.push(...childElements(current));
      }
    }
    card.append(content);
    root.append(card);
  });
  return root;
}

/** Renders ODT/ODS/ODP content.xml. Throws when there is nothing readable. */
export function renderOdf(entries: ZipEntries, images: OfficeImages): HTMLElement {
  const doc = parseXml(requireEntry(entries, 'content.xml'), 'content.xml');
  const styles = parseTextStyles(doc.documentElement);
  const body = firstChildByLocal(doc.documentElement, 'body');
  if (!body) throw new Error(t('officeEmpty'));
  const text = firstChildByLocal(body, 'text');
  if (text) {
    const rendered = renderTextBody(text, styles);
    if (rendered.textContent?.trim() === '') throw new Error(t('officeEmpty'));
    return rendered;
  }
  const spreadsheet = firstChildByLocal(body, 'spreadsheet');
  if (spreadsheet) return renderSpreadsheet(spreadsheet);
  const presentation = firstChildByLocal(body, 'presentation');
  if (presentation) return renderPresentation(presentation, styles, images);
  throw new Error(t('officeEmpty'));
}
