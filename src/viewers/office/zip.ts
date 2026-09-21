import { unzipSync } from 'fflate';

/** Raw decompressed entries of the OOXML package, keyed by archive path. */
export type ZipEntries = Record<string, Uint8Array>;

/** Decompresses the whole package. Throws on a corrupt archive. */
export function unzipPackage(data: Uint8Array): ZipEntries {
  const entries = unzipSync(data);
  const result: ZipEntries = {};
  for (const [path, bytes] of Object.entries(entries)) {
    if (!path.endsWith('/')) result[path] = bytes;
  }
  if (Object.keys(result).length === 0) throw new Error('Empty archive');
  return result;
}

export function requireEntry(entries: ZipEntries, path: string): Uint8Array {
  const bytes = entries[path];
  if (!bytes) throw new Error(`Missing part: ${path}`);
  return bytes;
}

export function optionalEntry(entries: ZipEntries, path: string): Uint8Array | null {
  return entries[path] ?? null;
}
