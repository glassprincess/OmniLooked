/** Bytes read by the FileSniffer: the first bytes are the magic bytes, the rest feeds the text heuristic. */
export const SNIFF_BYTES = 4096;

/** Max bytes loaded into memory for text views; larger files are shown truncated with a notice. */
export const TEXT_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

/** Lines longer than this are cut in the display (the DOM cannot hold megabyte-long lines). */
export const MAX_DISPLAY_LINE_CHARS = 10_000;

/** Max share of stray control characters in the sniffed sample for a file to still count as text. */
export const MAX_CONTROL_CHAR_RATIO = 0.01;
