/**
 * Minimal Compound File Binary (OLE) reader for legacy Office formats.
 * Enough to fetch whole streams (WordDocument, tables, Workbook):
 * no locking, no writing, strict bounds checks (corrupt input throws).
 */

const MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const HEADER_SIZE = 512;

const ENTRY_ROOT = 5;
const ENTRY_STREAM = 2;

export function isOleFile(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) return false;
  }
  return true;
}

interface FatImage {
  view: DataView;
  file: Uint8Array;
  sectorSize: number;
  fat: number[];
  miniFat: number[];
  rootData: Uint8Array;
}

function u32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) throw new Error('Invalid OLE file');
  return view.getUint32(offset, true);
}

function sectorBytes(file: Uint8Array, sectorSize: number, index: number): Uint8Array {
  const offset = HEADER_SIZE + index * sectorSize;
  if (index < 0 || offset + sectorSize > file.length) throw new Error('Invalid OLE file');
  return file.subarray(offset, offset + sectorSize);
}

function readChain(image: FatImage, start: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let current = start;
  let guard = image.fat.length + 1;
  while (current !== ENDOFCHAIN) {
    if (guard-- <= 0 || current < 0 || current >= image.fat.length) throw new Error('Invalid OLE file');
    chunks.push(sectorBytes(image.file, image.sectorSize, current));
    current = image.fat[current] as number;
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

interface DirEntry {
  name: string;
  type: number;
  left: number;
  right: number;
  child: number;
  start: number;
  size: number;
}

function parseDirectory(data: Uint8Array): DirEntry[] {
  if (data.length % 128 !== 0) throw new Error('Invalid OLE file');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const entries: DirEntry[] = [];
  for (let offset = 0; offset < data.length; offset += 128) {
    const nameLen = view.getUint16(offset + 64, true);
    let name = '';
    if (nameLen >= 2 && nameLen <= 64) {
      const chars: string[] = [];
      for (let i = 0; i + 1 < nameLen - 1; i += 2) {
        chars.push(String.fromCharCode(view.getUint16(offset + i, true)));
      }
      name = chars.join('');
    }
    const sizeLow = u32(view, offset + 120);
    const sizeHigh = u32(view, offset + 124);
    entries.push({
      name,
      type: data[offset + 66],
      left: u32(view, offset + 68),
      right: u32(view, offset + 72),
      child: u32(view, offset + 76),
      start: u32(view, offset + 116),
      size: sizeHigh === 0 ? sizeLow : sizeHigh * 0x100000000 + sizeLow,
    });
  }
  return entries;
}

/** Red-black tree walk of one storage's children. */
function walkChildren(entries: DirEntry[], id: number, visit: (entry: DirEntry) => void): void {
  const stack: number[] = [id];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const current = stack.pop() as number;
    if (current === FREESECT || seen.has(current)) continue;
    seen.add(current);
    const entry = entries[current];
    if (!entry || entry.type === 0) continue;
    visit(entry);
    stack.push(entry.left, entry.right);
  }
}

/**
 * Reads all root-level streams into a name -> bytes map.
 * Mini streams (< 4096 bytes) resolve through the MiniFAT automatically.
 */
export function readOleStreams(file: Uint8Array): Map<string, Uint8Array> {
  if (!isOleFile(file) || file.length < HEADER_SIZE) throw new Error('Invalid OLE file');
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const major = view.getUint16(26, true);
  if (major !== 3 && major !== 4) throw new Error('Invalid OLE file');
  const sectorShift = view.getUint16(30, true);
  const sectorSize = 1 << sectorShift;
  if (sectorSize !== 512 && sectorSize !== 4096) throw new Error('Invalid OLE file');
  const miniCutoff = u32(view, 56);

  // FAT locations: 109 slots in the header, then DIFAT sectors if needed.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const sector = u32(view, 76 + i * 4);
    if (sector !== FREESECT) fatSectors.push(sector);
  }
  let difat = u32(view, 68);
  let difatGuard = fatSectors.length + 16;
  while (difat !== FREESECT && difat !== ENDOFCHAIN) {
    if (difatGuard-- <= 0) throw new Error('Invalid OLE file');
    const data = sectorBytes(file, sectorSize, difat);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const slots = sectorSize / 4 - 1;
    for (let i = 0; i < slots; i++) {
      const sector = dv.getUint32(i * 4, true);
      if (sector !== FREESECT) fatSectors.push(sector);
    }
    difat = dv.getUint32(slots * 4, true);
  }

  const fat: number[] = [];
  for (const sector of fatSectors) {
    const data = sectorBytes(file, sectorSize, sector);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i < sectorSize; i += 4) fat.push(dv.getUint32(i, true));
  }

  const image: FatImage = { view, file, sectorSize, fat, miniFat: [], rootData: new Uint8Array() };
  const firstDir = u32(view, 48);
  if (firstDir === ENDOFCHAIN || firstDir === FREESECT) throw new Error('Invalid OLE file');
  const entries = parseDirectory(readChain(image, firstDir));
  const root = entries[0];
  if (!root || root.type !== ENTRY_ROOT) throw new Error('Invalid OLE file');
  image.rootData = root.start === ENDOFCHAIN ? new Uint8Array() : readChain(image, root.start);

  const firstMiniFat = u32(view, 60);
  if (firstMiniFat !== FREESECT && firstMiniFat !== ENDOFCHAIN) {
    const miniData = readChain(image, firstMiniFat);
    const dv = new DataView(miniData.buffer, miniData.byteOffset, miniData.byteLength);
    for (let i = 0; i + 4 <= miniData.length; i += 4) image.miniFat.push(dv.getUint32(i, true));
  }

  const result = new Map<string, Uint8Array>();
  walkChildren(entries, root.child, (entry) => {
    if (entry.type !== ENTRY_STREAM || entry.name === '') return;
    if (entry.size < 0 || entry.size > file.length) throw new Error('Invalid OLE file');
    if (entry.size > 0 && (entry.start === ENDOFCHAIN || entry.start === FREESECT)) {
      throw new Error('Invalid OLE file');
    }
    let data: Uint8Array;
    if (entry.size < miniCutoff) {
      // Mini stream inside the root storage data.
      const chunks: Uint8Array[] = [];
      let current = entry.start;
      let guard = image.miniFat.length + 1;
      while (current !== ENDOFCHAIN) {
        if (guard-- <= 0 || current < 0 || current * 64 + 64 > image.rootData.length) {
          throw new Error('Invalid OLE file');
        }
        chunks.push(image.rootData.subarray(current * 64, current * 64 + 64));
        current = image.miniFat[current] as number;
      }
      const joined = new Uint8Array(chunks.length * 64);
      chunks.forEach((chunk, i) => joined.set(chunk, i * 64));
      data = joined.subarray(0, entry.size);
    } else if (entry.size === 0) {
      data = new Uint8Array();
    } else {
      data = readChain(image, entry.start).subarray(0, entry.size);
    }
    if (!result.has(entry.name)) result.set(entry.name, data);
  });
  return result;
}
