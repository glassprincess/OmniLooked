import { resolvePartPath, type Rel } from './rels';
import { imageMimeFor, sniffImageMime } from './util';
import { optionalEntry, type ZipEntries } from './zip';

/**
 * Blob URLs for embedded images. Tracks every created URL so destroy()
 * can revoke them. Images are inert (<img> never runs scripts).
 */
export class OfficeImages {
  private readonly urls: string[] = [];

  constructor(private readonly entries: ZipEntries) {}

  resolve(relsPath: string, rels: Map<string, Rel>, rId: string | null): string | null {
    if (rId === null) return null;
    const rel = rels.get(rId);
    if (!rel || rel.external) return null;
    return this.fromPath(resolvePartPath(relsPath, rel.target));
  }

  /** Direct package path (ODF Pictures, no relationship layer). */
  fromPath(path: string): string | null {
    const bytes = optionalEntry(this.entries, path);
    if (!bytes) return null;
    const mime = sniffImageMime(bytes) ?? imageMimeFor(path);
    if (!mime) return null;
    // slice() copies into an exact-size ArrayBuffer view, which BlobPart requires.
    const url = URL.createObjectURL(new Blob([bytes.slice()], { type: mime }));
    this.urls.push(url);
    return url;
  }

  destroy(): void {
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.length = 0;
  }
}
