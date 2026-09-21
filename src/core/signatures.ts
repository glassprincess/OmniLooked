export type MediaKind = 'image' | 'video' | 'audio';

export interface MediaInfo {
  kind: MediaKind;
  format: string;
}

export function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

/** ZIP local file header: OOXML packages, ODF, EPUB, JAR and plain archives share it. */
export function isZip(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
}

/** OLE compound file magic: legacy .doc/.xls/.ppt and other structured storage. */
export function isOle(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
}

/** PDF header: %PDF. */
export function isPdf(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x25, 0x50, 0x44, 0x46]);
}

function hasAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** MPEG audio frame header: 11 sync bits, version and layer must not be the reserved values. */
function isMpegAudioFrame(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false;
  const b1 = bytes[1];
  return bytes[0] === 0xff && (b1 & 0xe0) === 0xe0 && ((b1 >> 3) & 3) !== 1 && ((b1 >> 1) & 3) !== 0;
}

/** Recognises the media formats of Stage 1 by their signature (never by extension). */
export function detectMedia(bytes: Uint8Array): MediaInfo | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', format: 'png' };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: 'image', format: 'jpeg' };
  if (hasAscii(bytes, 0, 'GIF87a') || hasAscii(bytes, 0, 'GIF89a')) return { kind: 'image', format: 'gif' };
  if (hasAscii(bytes, 0, 'RIFF') && hasAscii(bytes, 8, 'WEBP')) return { kind: 'image', format: 'webp' };
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return { kind: 'image', format: 'ico' };
  if (hasAscii(bytes, 0, 'RIFF') && hasAscii(bytes, 8, 'WAVE')) return { kind: 'audio', format: 'wav' };
  if (hasAscii(bytes, 4, 'ftyp')) return { kind: 'video', format: 'mp4' };
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: 'video', format: 'webm' };
  if (hasAscii(bytes, 0, 'OggS')) return { kind: 'audio', format: 'ogg' };
  if (hasAscii(bytes, 0, 'ID3') || isMpegAudioFrame(bytes)) return { kind: 'audio', format: 'mp3' };
  return null;
}
