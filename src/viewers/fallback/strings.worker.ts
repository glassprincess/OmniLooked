import { StringScanner } from './stringsScanner';
import type { StringItem, StringsWorkerIn, StringsWorkerOut } from './stringsScanner';

/** Heavy scanning stays off the main thread. The file is read in slices, never as one ArrayBuffer. */
const CHUNK_BYTES = 1024 * 1024;
const BATCH_SIZE = 2000;
/** Caps that keep the result list (held in the main thread) bounded. */
const MAX_STRINGS = 200_000;
const MAX_TOTAL_CHARS = 16_000_000;

interface WorkerScope {
  postMessage(message: StringsWorkerOut): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<StringsWorkerIn>) => void): void;
}
const scope = self as unknown as WorkerScope;

async function run(message: StringsWorkerIn): Promise<void> {
  const { file, minLength } = message;
  let count = 0;
  let totalChars = 0;
  let truncated = false;
  let batch: StringItem[] = [];

  const flushBatch = (): void => {
    if (batch.length === 0) return;
    scope.postMessage({ type: 'batch', items: batch });
    batch = [];
  };

  const scanner = new StringScanner(minLength, (item) => {
    if (count >= MAX_STRINGS || totalChars + item.text.length > MAX_TOTAL_CHARS) {
      truncated = true;
      return false;
    }
    count++;
    totalChars += item.text.length;
    batch.push(item);
    if (batch.length >= BATCH_SIZE) flushBatch();
    return true;
  });

  try {
    for (let offset = 0; offset < file.size && !scanner.isHalted; offset += CHUNK_BYTES) {
      const buffer = await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer();
      scanner.push(new Uint8Array(buffer), offset);
      flushBatch();
      scope.postMessage({ type: 'progress', read: Math.min(offset + CHUNK_BYTES, file.size), total: file.size });
    }
    scanner.finish();
    flushBatch();
    scope.postMessage({ type: 'done', count, truncated });
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}

scope.addEventListener('message', (event) => {
  void run(event.data);
});
