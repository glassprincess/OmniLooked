/**
 * Minimal Markdown renderer (GFM subset), dependency-free.
 *
 * Security model: escape-first. Raw HTML from the file is escaped and never
 * interpreted; link URLs are allow-listed (http/https/mailto/fragment);
 * images are never fetched (rendered as a placeholder with a link), so a
 * preview cannot run scripts or exfiltrate data. The result is additionally
 * displayed inside a sandboxed iframe without scripts or same-origin access.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Only navigation URLs; relative paths and exotic schemes render as plain text. */
function isSafeUrl(url: string): boolean {
  // Strip control characters that could smuggle a dangerous scheme past the prefix check.
  const cleaned = url.trim().replace(/[\u0000-\u0020\u007F]+/g, '');
  return /^(https?:|mailto:|#)/i.test(cleaned);
}

const CODE_PH = '\u0000';
const LINK_PH = '\u0001';

function applyEmphasis(escaped: string): string {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/(^|\W)_([^_]+)_(\W|$)/g, '$1<em>$2</em>$3')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
}

/** Inline formatting: code spans, images (placeholder), links, autolinks, emphasis. */
export function renderInline(src: string): string {
  const codes: string[] = [];
  const links: string[] = [];

  // 1. Code spans are extracted first so their content is never formatted.
  let out = src.replace(/`([^`\n]+)`/g, (_m: string, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `${CODE_PH}${codes.length - 1}${CODE_PH}`;
  });

  // 2. Images become a placeholder + link: no network requests from the preview.
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m: string, alt: string, url: string) => {
    const safeAlt = applyEmphasis(escapeHtml(alt));
    const label = safeAlt === '' ? 'image' : safeAlt;
    if (isSafeUrl(url)) {
      const href = escapeHtml(url);
      links.push(
        `<span class="md-img">🖼 ${label} <a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a></span>`,
      );
    } else {
      links.push(`<span class="md-img">🖼 ${label}</span>`);
    }
    return `${LINK_PH}${links.length - 1}${LINK_PH}`;
  });

  // 3. Links [text](url). Unsafe URLs are left for escaping below (shown literally).
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m: string, text: string, url: string) => {
    if (!isSafeUrl(url)) return _m;
    const href = escapeHtml(url);
    links.push(`<a href="${href}" target="_blank" rel="noopener noreferrer">${applyEmphasis(escapeHtml(text))}</a>`);
    return `${LINK_PH}${links.length - 1}${LINK_PH}`;
  });

  // 4. Autolinks <https://...>.
  out = out.replace(/<(https?:[^<>\s]+)>/g, (_m: string, url: string) => {
    const href = escapeHtml(url);
    links.push(`<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`);
    return `${LINK_PH}${links.length - 1}${LINK_PH}`;
  });

  // 5. Escape everything that is left (including unsafe link/image markup).
  out = escapeHtml(out);

  // 6. Emphasis operates on escaped text (* _ ~ survive escaping).
  out = applyEmphasis(out);

  // 7. Restore protected fragments.
  out = out.replace(/\u0000(\d+)\u0000/g, (_m: string, index: string) => codes[Number(index)] ?? '');
  out = out.replace(/\u0001(\d+)\u0001/g, (_m: string, index: string) => links[Number(index)] ?? '');
  return out;
}

function renderParagraph(buf: string[]): string {
  const parts = buf.map((line) => {
    const hardBreak = / {2,}$/.test(line);
    return renderInline(line.replace(/ {2,}$/, '')) + (hardBreak ? '<br />' : '');
  });
  return `<p>${parts.join('\n')}</p>`;
}

const FENCE_RE = /^(\s*)(```|~~~)(.*)$/;
const ATX_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const HR_STAR_RE = /^\s*([*_]\s*){3,}$/;
const HR_DASH_RE = /^\s*(-\s*){3,}$/;
const SETEXT_RE = /^\s*(=+|-+)\s*$/;
const QUOTE_RE = /^\s*>/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)\|?\s*$/;

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\||\|$/g, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function parseTable(lines: string[], start: number): { html: string; next: number } {
  const head = splitRow(lines[start]);
  const seps = splitRow(lines[start + 1]);
  const aligns = seps.map((sep) => {
    const left = sep.startsWith(':');
    const right = sep.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
  const th = head
    .map((cell, i) => {
      const align = aligns[i] ?? 'left';
      const style = align === 'left' ? '' : ` style="text-align:${align}"`;
      return `<th${style}>${renderInline(cell)}</th>`;
    })
    .join('');
  const body: string[] = [];
  let i = start + 2;
  while (i < lines.length && /^\s*\|?.*\|/.test(lines[i]) && lines[i].trim() !== '') {
    const cells = splitRow(lines[i]);
    const tds = head
      .map((_, col) => {
        const align = aligns[col] ?? 'left';
        const style = align === 'left' ? '' : ` style="text-align:${align}"`;
        return `<td${style}>${renderInline(cells[col] ?? '')}</td>`;
      })
      .join('');
    body.push(`<tr>${tds}</tr>`);
    i++;
  }
  return {
    html: `<table><thead><tr>${th}</tr></thead><tbody>${body.join('')}</tbody></table>`,
    next: i,
  };
}

function parseList(lines: string[], start: number): { html: string; next: number } {
  const first = lines[start].match(LIST_RE);
  if (!first) return { html: '', next: start };
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const tag = ordered ? 'ol' : 'ul';
  const items: string[] = [];
  let current: string[] | null = null;
  let nested: string[] = [];

  const flush = (): void => {
    if (current === null) return;
    const text = current.join(' ').trim();
    const task = text.match(/^\[([ xX])\]\s+(.*)$/);
    let inner: string;
    if (task) {
      const checked = task[1].toLowerCase() === 'x' ? ' checked' : '';
      inner = `<input type="checkbox" disabled${checked} /> ${renderInline(task[2])}`;
    } else {
      inner = renderInline(text);
    }
    items.push(`<li>${inner}${nested.join('')}</li>`);
    current = null;
    nested = [];
  };

  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      // A blank line ends the list unless a new item/continuation follows.
      let j = i + 1;
      while (j < lines.length && /^\s*$/.test(lines[j])) j++;
      const nextLine = j < lines.length ? lines[j] : '';
      const nextMatch = nextLine.match(LIST_RE);
      if (nextMatch && nextMatch[1].length >= baseIndent) {
        i = j;
        continue;
      }
      break;
    }
    const match = line.match(LIST_RE);
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (match && indent <= baseIndent + 3 && (current === null || indent >= baseIndent)) {
      if (indent > baseIndent && current !== null && match[1].length > baseIndent) {
        // Nested list.
        const sub = parseList(lines, i);
        nested.push(sub.html);
        i = sub.next;
        continue;
      }
      if (indent < baseIndent) break;
      flush();
      current = [match[3]];
      i++;
      continue;
    }
    if (current !== null && indent > baseIndent) {
      current.push(line.trim());
      i++;
      continue;
    }
    break;
  }
  flush();
  return { html: `<${tag}>${items.join('')}</${tag}>`, next: i };
}

/** Block parser: fences, headings, hr, quotes, tables, lists, paragraphs. */
export function markdownToHtml(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    const fence = line.match(FENCE_RE);
    if (fence) {
      const marker = fence[2];
      const lang = fence[3].trim().split(/\s+/)[0] ?? '';
      const buf: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // Skip the closing fence (or run past EOF, the loop guard handles it).
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      html.push(`<pre><code${cls}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    const atx = line.match(ATX_RE);
    if (atx) {
      const level = atx[1].length;
      html.push(`<h${level}>${renderInline(atx[2])}</h${level}>`);
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      html.push(`<blockquote>${markdownToHtml(buf.join('\n'))}</blockquote>`);
      continue;
    }

    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      TABLE_SEP_RE.test(lines[i + 1])
    ) {
      const table = parseTable(lines, i);
      html.push(table.html);
      i = table.next;
      continue;
    }

    if (HR_STAR_RE.test(line) || HR_DASH_RE.test(line)) {
      html.push('<hr />');
      i++;
      continue;
    }

    if (LIST_RE.test(line)) {
      const list = parseList(lines, i);
      html.push(list.html);
      i = list.next;
      continue;
    }

    // Paragraph: runs until a blank line or another block start.
    // A ===/--- underline turns the paragraph into a setext h1/h2.
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !FENCE_RE.test(lines[i]) &&
      !ATX_RE.test(lines[i]) &&
      !QUOTE_RE.test(lines[i]) &&
      !LIST_RE.test(lines[i]) &&
      !HR_STAR_RE.test(lines[i]) &&
      !SETEXT_RE.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    if (i < lines.length && SETEXT_RE.test(lines[i])) {
      const level = lines[i].trim().startsWith('=') ? 1 : 2;
      html.push(`<h${level}>${renderInline(buf.join(' ').trim())}</h${level}>`);
      i++;
    } else {
      html.push(renderParagraph(buf));
    }
  }

  return html.join('\n');
}
