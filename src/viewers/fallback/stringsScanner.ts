export interface StringItem {
  /** Byte offset of the first byte of the string in the file. */
  offset: number;
  text: string;
}

export interface StringsWorkerIn {
  type: 'start';
  file: File;
  minLength: number;
}

export type StringsWorkerOut =
  | { type: 'batch'; items: StringItem[] }
  | { type: 'progress'; read: number; total: number }
  | { type: 'done'; count: number; truncated: boolean }
  | { type: 'error'; message: string };

/**
 * Streaming extractor of runs of printable characters: ASCII 0x20-0x7E, tab, and well-formed UTF-8
 * multibyte characters. A run is reported when it has at least `minLength` characters. The state survives
 * chunk boundaries, so a string (or a UTF-8 character) split between two chunks is handled correctly.
 */
export class StringScanner {
  private run: number[] = [];
  private pending: number[] = [];
  private pendingNeed = 0;
  /** Allowed range of the first continuation byte of the pending UTF-8 sequence (rejects overlongs and surrogates). */
  private secondLow = 0x80;
  private secondHigh = 0xbf;
  private chars = 0;
  private start = 0;
  private halted = false;
  private readonly decoder = new TextDecoder('utf-8');

  /**
   * @param emit receives every found string; return false to stop the scan.
   * @param maxRunBytes a longer run is split, so memory per string stays bounded.
   */
  constructor(
    private readonly minLength: number,
    private readonly emit: (item: StringItem) => boolean,
    private readonly maxRunBytes = 4096,
  ) {}

  get isHalted(): boolean {
    return this.halted;
  }

  push(chunk: Uint8Array, baseOffset: number): void {
    for (let i = 0; i < chunk.length && !this.halted; i++) {
      this.feed(chunk[i], baseOffset + i);
    }
  }

  /** Call once after the last chunk. An incomplete UTF-8 character at the very end is dropped. */
  finish(): void {
    if (!this.halted) this.flush();
  }

  private feed(byte: number, position: number): void {
    if (this.pendingNeed > 0) {
      const first = this.pending.length === 1;
      const low = first ? this.secondLow : 0x80;
      const high = first ? this.secondHigh : 0xbf;
      if (byte >= low && byte <= high) {
        this.pending.push(byte);
        this.pendingNeed--;
        if (this.pendingNeed === 0) {
          for (const value of this.pending) this.run.push(value);
          this.pending.length = 0;
          this.chars++;
          this.splitIfLong();
        }
        return;
      }
      // Broken sequence: drop the incomplete character, close the run, and treat this byte afresh.
      this.flush();
    }

    if ((byte >= 0x20 && byte <= 0x7e) || byte === 0x09) {
      if (this.run.length === 0) this.start = position;
      this.run.push(byte);
      this.chars++;
      this.splitIfLong();
      return;
    }

    if (byte >= 0xc2 && byte <= 0xf4) {
      if (this.run.length === 0) this.start = position;
      this.pending.push(byte);
      if (byte < 0xe0) {
        this.pendingNeed = 1;
        this.secondLow = 0x80;
        this.secondHigh = 0xbf;
      } else if (byte < 0xf0) {
        this.pendingNeed = 2;
        this.secondLow = byte === 0xe0 ? 0xa0 : 0x80;
        this.secondHigh = byte === 0xed ? 0x9f : 0xbf;
      } else {
        this.pendingNeed = 3;
        this.secondLow = byte === 0xf0 ? 0x90 : 0x80;
        this.secondHigh = byte === 0xf4 ? 0x8f : 0xbf;
      }
      return;
    }

    this.flush();
  }

  private splitIfLong(): void {
    if (this.run.length >= this.maxRunBytes) this.flush();
  }

  private flush(): void {
    if (this.chars >= this.minLength) {
      const text = this.decoder.decode(Uint8Array.from(this.run));
      if (!this.emit({ offset: this.start, text })) this.halted = true;
    }
    this.run.length = 0;
    this.chars = 0;
    this.pending.length = 0;
    this.pendingNeed = 0;
  }
}
