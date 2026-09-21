import { attr, childElements, parseXml } from './xml';
import type { ZipEntries } from './zip';
import { optionalEntry } from './zip';

export interface Rel {
  target: string;
  type: string;
  external: boolean;
}

/** Namespace of r:id / r:embed relationship references. */
export const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Id -> relationship for one .rels part. Missing part means no relationships. */
export function parseRels(entries: ZipEntries, relsPath: string): Map<string, Rel> {
  const result = new Map<string, Rel>();
  const bytes = optionalEntry(entries, relsPath);
  if (!bytes) return result;
  const doc = parseXml(bytes, relsPath);
  for (const rel of childElements(doc.documentElement)) {
    if (rel.localName !== 'Relationship') continue;
    const id = attr(rel, 'Id');
    const target = attr(rel, 'Target');
    if (id === null || target === null) continue;
    result.set(id, {
      target,
      type: attr(rel, 'Type') ?? '',
      external: (attr(rel, 'TargetMode') ?? '').toLowerCase() === 'external',
    });
  }
  return result;
}

/**
 * Resolves a relationship target against the part that owns the .rels file.
 * Absolute URLs and server-rooted paths pass through untouched.
 */
export function resolvePartPath(owningPart: string, target: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith('/')) {
    return target.startsWith('/') ? target.slice(1) : target;
  }
  const parts = owningPart.split('/');
  parts.pop(); // strip the file name
  if (parts[parts.length - 1] === '_rels') parts.pop(); // .../_rels -> the part's folder
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}
