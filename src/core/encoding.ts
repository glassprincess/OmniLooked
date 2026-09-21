export interface EncodingOption {
  /** TextDecoder label. */
  label: string;
  title: string;
}

export const SUPPORTED_ENCODINGS: readonly EncodingOption[] = [
  { label: 'utf-8', title: 'UTF-8' },
  { label: 'windows-1251', title: 'Windows-1251' },
  { label: 'ibm866', title: 'CP866' },
  { label: 'koi8-r', title: 'KOI8-R' },
  { label: 'shift_jis', title: 'Shift-JIS' },
];

/** Bytes given to the statistical detector. */
const DETECT_SAMPLE_BYTES = 64 * 1024;

interface JschardetApi {
  detect(input: string): { encoding: string | null; confidence: number };
}
type JschardetModule = Partial<JschardetApi> & { default?: JschardetApi };

export function decodeBytes(bytes: Uint8Array, label: string, truncated = false): string {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  // stream: true keeps a multibyte character cut by truncation from turning into a replacement char.
  return decoder.decode(bytes, { stream: truncated });
}

function bomEncoding(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return null;
}

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    // stream: true tolerates a multibyte sequence that is cut at the very end of the buffer.
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
    return true;
  } catch {
    return false;
  }
}

function toBinaryString(bytes: Uint8Array): string {
  let result = '';
  const step = 0x2000;
  for (let i = 0; i < bytes.length; i += step) {
    result += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return result;
}

async function guessWithDetector(bytes: Uint8Array): Promise<string | null> {
  try {
    const module = (await import('jschardet')) as unknown as JschardetModule;
    const api = (module.default ?? module) as JschardetApi;
    const result = api.detect(toBinaryString(bytes.subarray(0, DETECT_SAMPLE_BYTES)));
    if (!result || !result.encoding) return null;
    const label = result.encoding.toLowerCase();
    new TextDecoder(label); // throws on a label the browser does not know
    return label;
  } catch {
    return null;
  }
}

/**
 * BOM first, then strict UTF-8, then the statistical detector (jschardet, loaded on demand).
 * Falls back to UTF-8 when nothing is recognised.
 */
export async function detectEncoding(bytes: Uint8Array): Promise<string> {
  const bom = bomEncoding(bytes);
  if (bom) return bom;
  if (isValidUtf8(bytes)) return 'utf-8';
  return (await guessWithDetector(bytes)) ?? 'utf-8';
}
