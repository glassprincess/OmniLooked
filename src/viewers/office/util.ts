/** Only navigation URLs; anything else renders as plain text. */
export function isSafeHref(url: string): boolean {
  const cleaned = url.trim().replace(/[\u0000-\u0020\u007F]+/g, '');
  return /^(https?:|mailto:|#)/i.test(cleaned);
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/** Vector metafiles browsers cannot render are skipped silently. */
export function imageMimeFor(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  return IMAGE_MIME[path.slice(dot + 1).toLowerCase()] ?? null;
}

function hasBytes(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

/**
 * Image type by magic bytes, not by extension: producers mislabel files
 * (e.g. JPEG data named .png), and a wrong blob MIME breaks rendering.
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (hasBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (hasBytes(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (hasBytes(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
      hasBytes(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'image/gif';
  if (hasBytes(bytes, 0, [0x52, 0x49, 0x46, 0x46]) &&
      hasBytes(bytes, 8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  if (hasBytes(bytes, 0, [0x42, 0x4d])) return 'image/bmp';
  if (hasBytes(bytes, 0, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon';
  // SVG: optional BOM, whitespace, then <svg (possibly after an XML prolog).
  let start = 0;
  if (hasBytes(bytes, 0, [0xef, 0xbb, 0xbf])) start = 3;
  let head = '';
  for (let i = start; i < Math.min(bytes.length, 1024); i++) {
    const byte = bytes[i] as number;
    if (byte > 0x7e) return null;
    head += String.fromCharCode(byte);
  }
  const trimmed = head.trimStart();
  if (trimmed.startsWith('<svg')) return 'image/svg+xml';
  if (trimmed.startsWith('<?xml') && trimmed.includes('<svg')) return 'image/svg+xml';
  return null;
}
