import { t } from '../../i18n';
import { aes256CbcDecrypt } from './aes';
import { readOleStreams } from './cfb';
import { attr, childrenByLocal, firstChildByLocal } from './xml';

/**
 * ECMA-376 Agile password protection (MS-OFFCRYPTO) for OOXML packages.
 * AES-256-CBC + SHA-512 + 100k-spin KDF, all through WebCrypto (async).
 * Verified against msoffcrypto-tool vectors and round-trips.
 */

export class OfficePasswordError extends Error {}
export class OfficeCryptoError extends Error {}

export interface AgileKeyData {
  salt: Uint8Array<ArrayBuffer>;
  spinCount: number;
  keyBits: number;
  encryptedKey: Uint8Array<ArrayBuffer>;
  encryptedVerifierInput: Uint8Array<ArrayBuffer>;
  encryptedVerifierValue: Uint8Array<ArrayBuffer>;
  encryptedHmacKey: Uint8Array<ArrayBuffer>;
  encryptedHmacValue: Uint8Array<ArrayBuffer>;
  dataSalt: Uint8Array<ArrayBuffer>;
}

const BLOCK_VERIFIER_INPUT = hexBytes('FEA7D2763B4B9E79');
const BLOCK_VERIFIER_VALUE = hexBytes('D7AA0F6D3061344E');
const BLOCK_ENCRYPTED_KEY = hexBytes('146E0BE7ABACD0D6');
const BLOCK_HMAC_KEY = hexBytes('5FB2AD010CB9E1F6');
const BLOCK_HMAC_VALUE = hexBytes('A0677F02B22C8433');

const SEGMENT_LENGTH = 4096;
/** Upper bound on the KDF spin count (100k is standard; more is a DoS vector). */
const MAX_SPIN_COUNT = 1000000;
/** Upper bound on the decrypted package (zip bombs stay out). */
const MAX_PACKAGE_BYTES = 500 * 1024 * 1024;

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function utf16le(text: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(text.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
  return out;
}

function b64decode(input: string): Uint8Array<ArrayBuffer> {
  const bin = atob(input.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function u32le(value: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

async function sha512(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-512', data.slice()));
}

async function aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  // Pure-JS raw CBC: WebCrypto always strips PKCS#7, Office stores zero padding.
  try {
    return aes256CbcDecrypt(key, iv, data);
  } catch {
    throw new OfficeCryptoError(t('officeFailed'));
  }
}

async function iteratedHash(password: string, salt: Uint8Array, spin: number): Promise<Uint8Array<ArrayBuffer>> {
  let h = await sha512(concat(salt, utf16le(password)));
  const counter = new Uint8Array(4);
  const view = new DataView(counter.buffer);
  for (let i = 0; i < spin; i++) {
    view.setUint32(0, i, true);
    h = await sha512(concat(counter, h));
  }
  return h;
}

async function blockKey(hFinal: Uint8Array, block: Uint8Array, bits: number): Promise<Uint8Array<ArrayBuffer>> {
  return (await sha512(concat(hFinal, block))).slice(0, bits / 8);
}

/** Parses the agile EncryptionInfo XML. Throws OfficeCryptoError when unsupported. */
export function parseEncryptionInfo(bytes: Uint8Array): AgileKeyData {
  const text = new TextDecoder().decode(bytes);
  const start = text.indexOf('<encryption');
  if (start < 0) throw new OfficeCryptoError(t('officeCryptoUnsupported'));
  const doc = new DOMParser().parseFromString(text.slice(start), 'application/xml');
  const root = doc.documentElement;
  if (root.localName === 'parsererror' || root.localName !== 'encryption') {
    throw new OfficeCryptoError(t('officeCryptoUnsupported'));
  }
  const keyData = firstChildByLocal(root, 'keyData');
  const integrity = firstChildByLocal(root, 'dataIntegrity');
  const encryptors = firstChildByLocal(root, 'keyEncryptors');
  const keyEncryptor = encryptors
    ? childrenByLocal(encryptors, 'keyEncryptor').find((el) => (attr(el, 'uri') ?? '').endsWith('/password'))
    : undefined;
  const encKey = keyEncryptor ? firstChildByLocal(keyEncryptor, 'encryptedKey') : null;
  if (!keyData || !integrity || !encKey) throw new OfficeCryptoError(t('officeCryptoUnsupported'));

  const cipher = `${attr(keyData, 'cipherAlgorithm') ?? ''}/${attr(keyData, 'cipherChaining') ?? ''}`;
  const hash = attr(keyData, 'hashAlgorithm') ?? '';
  const keyBits = Number(attr(encKey, 'keyBits') ?? '0');
  const spin = Number(attr(encKey, 'spinCount') ?? '0');
  if (cipher !== 'AES/ChainingModeCBC' || hash !== 'SHA512' || keyBits !== 256) {
    throw new OfficeCryptoError(t('officeCryptoUnsupported'));
  }
  if (!Number.isInteger(spin) || spin <= 0 || spin > MAX_SPIN_COUNT) {
    throw new OfficeCryptoError(t('officeCryptoUnsupported'));
  }
  const get = (el: Element, name: string, size: number): Uint8Array<ArrayBuffer> => {
    const raw = attr(el, name) ?? '';
    const decoded = b64decode(raw);
    if (decoded.length !== size) throw new OfficeCryptoError(t('officeFailed'));
    return decoded;
  };
  return {
    salt: get(encKey, 'saltValue', 16),
    spinCount: spin,
    keyBits,
    encryptedKey: get(encKey, 'encryptedKeyValue', 32),
    encryptedVerifierInput: get(encKey, 'encryptedVerifierHashInput', 16),
    encryptedVerifierValue: get(encKey, 'encryptedVerifierHashValue', 64),
    encryptedHmacKey: get(integrity, 'encryptedHmacKey', 64),
    encryptedHmacValue: get(integrity, 'encryptedHmacValue', 64),
    dataSalt: get(keyData, 'saltValue', 16),
  };
}

/**
 * Derives the secret key and checks the password via the verifier.
 * Returns null on a wrong password (no exception: retry is expected).
 */
export async function deriveSecretKey(password: string, kd: AgileKeyData): Promise<Uint8Array<ArrayBuffer> | null> {
  const hFinal = await iteratedHash(password, kd.salt, kd.spinCount);
  const keyInput = await blockKey(hFinal, BLOCK_VERIFIER_INPUT, kd.keyBits);
  const keyValue = await blockKey(hFinal, BLOCK_VERIFIER_VALUE, kd.keyBits);
  const verifierInput = await aesCbcDecrypt(keyInput, kd.salt, kd.encryptedVerifierInput);
  const expected = await aesCbcDecrypt(keyValue, kd.salt, kd.encryptedVerifierValue);
  if (!timingSafeEqual(await sha512(verifierInput), expected)) return null;
  const keyEnc = await blockKey(hFinal, BLOCK_ENCRYPTED_KEY, kd.keyBits);
  return aesCbcDecrypt(keyEnc, kd.salt, kd.encryptedKey);
}

async function hmacSha512(key: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey('raw', key.slice(), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, data.slice()));
}

/** HMAC integrity over the stored (encrypted) package. Wrong password already fails earlier. */
export async function verifyPackageIntegrity(
  secretKey: Uint8Array,
  kd: AgileKeyData,
  storedPackage: Uint8Array,
): Promise<boolean> {
  const iv1 = (await sha512(concat(kd.dataSalt, BLOCK_HMAC_KEY))).slice(0, 16);
  const iv2 = (await sha512(concat(kd.dataSalt, BLOCK_HMAC_VALUE))).slice(0, 16);
  const hmacKey = await aesCbcDecrypt(secretKey, iv1, kd.encryptedHmacKey);
  const expected = await aesCbcDecrypt(secretKey, iv2, kd.encryptedHmacValue);
  return timingSafeEqual(await hmacSha512(hmacKey, storedPackage), expected);
}

/** Decrypts the EncryptedPackage segments (totalSize header + 4096-byte blocks). */
export async function decryptPackage(
  secretKey: Uint8Array,
  dataSalt: Uint8Array,
  storedPackage: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  if (storedPackage.length < 8) throw new OfficeCryptoError(t('officeFailed'));
  const view = new DataView(storedPackage.buffer, storedPackage.byteOffset, storedPackage.byteLength);
  const totalSize = Number(view.getBigUint64(0, true));
  if (!Number.isSafeInteger(totalSize) || totalSize < 0 || totalSize > MAX_PACKAGE_BYTES) {
    throw new OfficeCryptoError(t('officeFailed'));
  }
  const chunks: Uint8Array[] = [];
  let remaining = totalSize;
  let index = 0;
  let at = 8;
  while (remaining > 0) {
    if (at >= storedPackage.length) throw new OfficeCryptoError(t('officeFailed'));
    const end = Math.min(at + SEGMENT_LENGTH, storedPackage.length);
    const cipher = storedPackage.subarray(at, end);
    if (cipher.length === 0 || cipher.length % 16 !== 0) throw new OfficeCryptoError(t('officeFailed'));
    const iv = (await sha512(concat(dataSalt, u32le(index)))).slice(0, 16);
    const plain = await aesCbcDecrypt(secretKey, iv, cipher);
    const take = Math.min(remaining, plain.length);
    chunks.push(plain.subarray(0, take));
    remaining -= take;
    at = end;
    index++;
    if (index > totalSize / 16 + 16) throw new OfficeCryptoError(t('officeFailed'));
  }
  return concat(...chunks);
}

/** Full unlock: parse, verify password, check integrity, decrypt. */
export async function unlockOfficePackage(fileBytes: Uint8Array, password: string): Promise<Uint8Array<ArrayBuffer>> {
  const streams = readOleStreams(fileBytes);
  const infoBytes = streams.get('EncryptionInfo');
  const packageBytes = streams.get('EncryptedPackage');
  if (!infoBytes || !packageBytes) throw new OfficeCryptoError(t('officeFailed'));
  const kd = parseEncryptionInfo(infoBytes);
  const secret = await deriveSecretKey(password, kd);
  if (!secret) throw new OfficePasswordError(t('officeWrongPassword'));
  if (!(await verifyPackageIntegrity(secret, kd, packageBytes))) {
    throw new OfficeCryptoError(t('officeFailed'));
  }
  return decryptPackage(secret, kd.dataSalt, packageBytes);
}

/** True when the OLE container holds an encrypted OOXML package. */
export function isEncryptedOffice(fileBytes: Uint8Array): boolean {
  try {
    const streams = readOleStreams(fileBytes);
    return streams.has('EncryptedPackage') && streams.has('EncryptionInfo');
  } catch {
    return false;
  }
}
