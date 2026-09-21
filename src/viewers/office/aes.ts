/**
 * AES-256 block decryption (FIPS-197 Inverse Cipher) for raw CBC data.
 * WebCrypto cannot do padding-less CBC, and Office crypto stores
 * zero-padded blocks — hence this small, vector-tested implementation.
 * Encryption is not needed (read-only viewer).
 */

const INV_SBOX = new Uint8Array([
  0x52, 0x09, 0x6a, 0xd5, 0x30, 0x36, 0xa5, 0x38, 0xbf, 0x40, 0xa3, 0x9e, 0x81, 0xf3, 0xd7, 0xfb,
  0x7c, 0xe3, 0x39, 0x82, 0x9b, 0x2f, 0xff, 0x87, 0x34, 0x8e, 0x43, 0x44, 0xc4, 0xde, 0xe9, 0xcb,
  0x54, 0x7b, 0x94, 0x32, 0xa6, 0xc2, 0x23, 0x3d, 0xee, 0x4c, 0x95, 0x0b, 0x42, 0xfa, 0xc3, 0x4e,
  0x08, 0x2e, 0xa1, 0x66, 0x28, 0xd9, 0x24, 0xb2, 0x76, 0x5b, 0xa2, 0x49, 0x6d, 0x8b, 0xd1, 0x25,
  0x72, 0xf8, 0xf6, 0x64, 0x86, 0x68, 0x98, 0x16, 0xd4, 0xa4, 0x5c, 0xcc, 0x5d, 0x65, 0xb6, 0x92,
  0x6c, 0x70, 0x48, 0x50, 0xfd, 0xed, 0xb9, 0xda, 0x5e, 0x15, 0x46, 0x57, 0xa7, 0x8d, 0x9d, 0x84,
  0x90, 0xd8, 0xab, 0x00, 0x8c, 0xbc, 0xd3, 0x0a, 0xf7, 0xe4, 0x58, 0x05, 0xb8, 0xb3, 0x45, 0x06,
  0xd0, 0x2c, 0x1e, 0x8f, 0xca, 0x3f, 0x0f, 0x02, 0xc1, 0xaf, 0xbd, 0x03, 0x01, 0x13, 0x8a, 0x6b,
  0x3a, 0x91, 0x11, 0x41, 0x4f, 0x67, 0xdc, 0xea, 0x97, 0xf2, 0xcf, 0xce, 0xf0, 0xb4, 0xe6, 0x73,
  0x96, 0xac, 0x74, 0x22, 0xe7, 0xad, 0x35, 0x85, 0xe2, 0xf9, 0x37, 0xe8, 0x1c, 0x75, 0xdf, 0x6e,
  0x47, 0xf1, 0x1a, 0x71, 0x1d, 0x29, 0xc5, 0x89, 0x6f, 0xb7, 0x62, 0x0e, 0xaa, 0x18, 0xbe, 0x1b,
  0xfc, 0x56, 0x3e, 0x4b, 0xc6, 0xd2, 0x79, 0x20, 0x9a, 0xdb, 0xc0, 0xfe, 0x78, 0xcd, 0x5a, 0xf4,
  0x1f, 0xdd, 0xa8, 0x33, 0x88, 0x07, 0xc7, 0x31, 0xb1, 0x12, 0x10, 0x59, 0x27, 0x80, 0xec, 0x5f,
  0x60, 0x51, 0x7f, 0xa9, 0x19, 0xb5, 0x4a, 0x0d, 0x2d, 0xe5, 0x7a, 0x9f, 0x93, 0xc9, 0x9c, 0xef,
  0xa0, 0xe0, 0x3b, 0x4d, 0xae, 0x2a, 0xf5, 0xb0, 0xc8, 0xeb, 0xbb, 0x3c, 0x83, 0x53, 0x99, 0x61,
  0x17, 0x2b, 0x04, 0x7e, 0xba, 0x77, 0xd6, 0x26, 0xe1, 0x69, 0x14, 0x63, 0x55, 0x21, 0x0c, 0x7d,
]);

const RCON = new Uint8Array([0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]);

function xtime(a: number): number {
  return ((a << 1) ^ ((a & 0x80) !== 0 ? 0x1b : 0)) & 0xff;
}

function gfMul(a: number, b: number): number {
  let result = 0;
  let x = a;
  let y = b;
  while (y > 0) {
    if ((y & 1) !== 0) result ^= x;
    x = xtime(x);
    y >>= 1;
  }
  return result;
}

/** Forward key expansion (FIPS-197 §5.2), then converted to decryption keys. */
export function expandKeyDecrypt(key: Uint8Array): Uint32Array {
  if (key.length !== 32) throw new Error('AES-256 needs a 32-byte key');
  const nk = 8;
  const rounds = 14;
  const w = new Uint32Array(4 * (rounds + 1));
  for (let i = 0; i < nk; i++) {
    w[i] = ((key[i * 4] as number) << 24) | ((key[i * 4 + 1] as number) << 16) |
      ((key[i * 4 + 2] as number) << 8) | (key[i * 4 + 3] as number);
  }
  // Forward S-box for expansion (only the few bytes we need).
  const sbox = SBOX_OF_INV;
  for (let i = nk; i < w.length; i++) {
    let temp = w[i - 1] as number;
    if (i % nk === 0) {
      temp = (subWord(rotWord(temp), sbox) ^ ((RCON[i / nk - 1] as number) << 24)) >>> 0;
    } else if (i % nk === 4) {
      temp = subWord(temp, sbox);
    }
    w[i] = ((w[i - nk] as number) ^ temp) >>> 0;
  }
  // Direct Inverse Cipher (FIPS-197 Fig. 12): same round order as encryption
  // in reverse, with forward keys in reverse. No key transformation needed.
  const dw = new Uint32Array(w.length);
  for (let r = 0; r <= rounds; r++) {
    for (let c = 0; c < 4; c++) {
      dw[r * 4 + c] = w[(rounds - r) * 4 + c] as number;
    }
  }
  return dw;
}

/** Forward S-box derived by inverting the inverse table (single source of truth). */
const SBOX_OF_INV: Uint8Array = (() => {
  const forward = new Uint8Array(256);
  for (let i = 0; i < 256; i++) forward[INV_SBOX[i] as number] = i;
  return forward;
})();

function rotWord(word: number): number {
  return ((word << 8) | (word >>> 24)) >>> 0;
}

function subWord(word: number, sbox: Uint8Array): number {
  return ((((sbox[(word >>> 24) & 0xff] as number) << 24) |
    ((sbox[(word >>> 16) & 0xff] as number) << 16)) |
    (((sbox[(word >>> 8) & 0xff] as number) << 8) |
      (sbox[word & 0xff] as number))) >>> 0;
}

function invMixColumn(word: number): number {
  const a0 = (word >>> 24) & 0xff;
  const a1 = (word >>> 16) & 0xff;
  const a2 = (word >>> 8) & 0xff;
  const a3 = word & 0xff;
  return ((((gfMul(a0, 0x0e) ^ gfMul(a1, 0x0b) ^ gfMul(a2, 0x0d) ^ gfMul(a3, 0x09)) << 24) |
    ((gfMul(a0, 0x09) ^ gfMul(a1, 0x0e) ^ gfMul(a2, 0x0b) ^ gfMul(a3, 0x0d)) << 16)) |
    (((gfMul(a0, 0x0d) ^ gfMul(a1, 0x09) ^ gfMul(a2, 0x0e) ^ gfMul(a3, 0x0b)) << 8) |
      (gfMul(a0, 0x0b) ^ gfMul(a1, 0x0d) ^ gfMul(a2, 0x09) ^ gfMul(a3, 0x0e)))) >>> 0;
}

function decryptBlock(block: Uint8Array, dw: Uint32Array): Uint8Array<ArrayBuffer> {
  const s = new Uint8Array(16);
  s.set(block);
  const addKey = (round: number): void => {
    for (let c = 0; c < 4; c++) {
      const word = dw[round * 4 + c] as number;
      s[c * 4] = (s[c * 4] as number) ^ ((word >>> 24) & 0xff);
      s[c * 4 + 1] = (s[c * 4 + 1] as number) ^ ((word >>> 16) & 0xff);
      s[c * 4 + 2] = (s[c * 4 + 2] as number) ^ ((word >>> 8) & 0xff);
      s[c * 4 + 3] = (s[c * 4 + 3] as number) ^ (word & 0xff);
    }
  };
  // State layout is column-major: s[row + 4*col].
  const get = (row: number, col: number): number => s[row + 4 * col] as number;
  const set = (row: number, col: number, value: number): void => {
    s[row + 4 * col] = value;
  };
  const shiftSub = (): void => {
    for (let r = 0; r < 4; r++) {
      const t0 = get(r, (4 - r) % 4);
      const t1 = get(r, (5 - r) % 4);
      const t2 = get(r, (6 - r) % 4);
      const t3 = get(r, (7 - r) % 4);
      set(r, 0, INV_SBOX[t0] as number);
      set(r, 1, INV_SBOX[t1] as number);
      set(r, 2, INV_SBOX[t2] as number);
      set(r, 3, INV_SBOX[t3] as number);
    }
  };
  const mixState = (): void => {
    for (let c = 0; c < 4; c++) {
      const word = (((get(0, c) as number) << 24) | ((get(1, c) as number) << 16) |
        ((get(2, c) as number) << 8) | (get(3, c) as number)) >>> 0;
      const mixed = invMixColumn(word);
      set(0, c, (mixed >>> 24) & 0xff);
      set(1, c, (mixed >>> 16) & 0xff);
      set(2, c, (mixed >>> 8) & 0xff);
      set(3, c, mixed & 0xff);
    }
  };
  addKey(0);
  for (let round = 1; round < 14; round++) {
    shiftSub();
      addKey(round);
      mixState();
    }
  shiftSub();
  addKey(14);
  return s;
}

/**
 * Raw AES-256-CBC decryption (no padding handling): every block is processed,
 * the caller owns trimming. Throws on bad lengths or key/IV sizes.
 */
export function aes256CbcDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array<ArrayBuffer> {
  if (key.length !== 32) throw new Error('AES-256 needs a 32-byte key');
  if (iv.length !== 16) throw new Error('AES needs a 16-byte IV');
  if (data.length === 0 || data.length % 16 !== 0) throw new Error('Cipher length must be a non-zero multiple of 16');
  const dw = expandKeyDecrypt(key);
  const out = new Uint8Array(data.length);
  let previous = iv;
  const block = new Uint8Array(16);
  for (let at = 0; at < data.length; at += 16) {
    block.set(data.subarray(at, at + 16));
    const plain = decryptBlock(block, dw);
    for (let i = 0; i < 16; i++) out[at + i] = (plain[i] as number) ^ (previous[i] as number);
    previous = data.subarray(at, at + 16);
  }
  return out;
}
