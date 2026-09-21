/**
 * Namespace-agnostic XML helpers for OOXML. Real-world files mix prefixes
 * (w, a, p, mc:Fallback...), so everything matches on localName only.
 */

export function parseXml(bytes: Uint8Array, part: string): Document {
  const text = new TextDecoder().decode(bytes);
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const root = doc.documentElement;
  if (root.localName === 'parsererror' || root.namespaceURI?.includes('parsererror') === true) {
    throw new Error(`Invalid XML: ${part}`);
  }
  return doc;
}

export function childElements(parent: Element): Element[] {
  const result: Element[] = [];
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE) result.push(node as Element);
  }
  return result;
}

export function childrenByLocal(parent: Element, local: string): Element[] {
  return childElements(parent).filter((el) => el.localName === local);
}

export function firstChildByLocal(parent: Element, local: string): Element | null {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).localName === local) {
      return node as Element;
    }
  }
  return null;
}

/** First descendant (breadth-first) with the given local name. */
export function firstDescendantByLocal(root: Element | Document, local: string): Element | null {
  const found = allDescendantsByLocal(root, local);
  return found.length > 0 ? (found[0] as Element) : null;
}

/** All descendants (breadth-first) with the given local name. */
export function allDescendantsByLocal(root: Element | Document, local: string): Element[] {
  const result: Element[] = [];
  const queue: Element[] = root instanceof Element ? [root] : root.documentElement ? [root.documentElement] : [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (current !== root && current.localName === local) result.push(current);
    queue.push(...childElements(current));
  }
  return result;
}

/** Concatenates the text of all descendant `t` elements (a:t / w:t). */
export function collectText(root: Element): string {
  let result = '';
  const queue: Element[] = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (current.localName === 't') result += current.textContent ?? '';
    else queue.push(...childElements(current));
  }
  return result;
}

export function attr(element: Element, local: string): string | null {
  for (const name of element.getAttributeNames()) {
    const colon = name.indexOf(':');
    if ((colon < 0 ? name : name.slice(colon + 1)) === local) return element.getAttribute(name);
  }
  return null;
}

/**
 * Namespace-precise attribute lookup. Needed for relationship references:
 * e.g. p:sldId carries both id="256" and r:id="rId2", and only the latter
 * (in the relationships namespace) is the rel id.
 */
export function attrNS(element: Element, namespace: string, local: string): string | null {
  for (const name of element.getAttributeNames()) {
    const node = element.getAttributeNode(name);
    if (node && node.namespaceURI === namespace && node.localName === local) return node.value;
  }
  return null;
}
