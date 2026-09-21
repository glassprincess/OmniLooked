export const MEDIA_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'ico',
  'mp4', 'webm', 'mp3', 'wav', 'ogg',
] as const;

/**
 * Documents with a rendered preview plus a source tab (see viewers/doc).
 * The preview is isolated: HTML/Markdown go into a sandboxed iframe without
 * scripts, SVG goes through <img> where scripts cannot run.
 */
export const DOC_EXTENSIONS = ['html', 'htm', 'svg', 'md', 'markdown'] as const;

export type DocKind = 'html' | 'svg' | 'markdown';

export function docKindFor(extension: string): DocKind | null {
  if (extension === 'html' || extension === 'htm') return 'html';
  if (extension === 'svg') return 'svg';
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  return null;
}

/**
 * Modern Office formats (OOXML packages). The legacy binary formats
 * (.doc/.xls/.ppt) are NOT included: they need a different parser.
 */
export const OFFICE_EXTENSIONS = ['docx', 'xlsx', 'pptx'] as const;

export type OfficeKind = 'docx' | 'xlsx' | 'pptx';

export function officeKindFor(extension: string): OfficeKind | null {
  if (extension === 'docx') return 'docx';
  if (extension === 'xlsx') return 'xlsx';
  if (extension === 'pptx') return 'pptx';
  return null;
}

/**
 * Legacy binary Office formats (OLE compound files). Rendered from own
 * parsers: .doc as extracted text, .xls as sheets.
 */
export const LEGACY_EXTENSIONS = ['doc', 'xls', 'ppt'] as const;

export type LegacyKind = 'doc' | 'xls' | 'ppt';

export function legacyKindFor(extension: string): LegacyKind | null {
  if (extension === 'doc') return 'doc';
  if (extension === 'xls') return 'xls';
  if (extension === 'ppt') return 'ppt';
  return null;
}

/** Plain archives with a content listing and open-inside support. */
export const ARCHIVE_EXTENSIONS = ['zip'] as const;

/** ODF text/spreadsheet/presentation (ZIP packages like OOXML). */
export const ODF_EXTENSIONS = ['ods', 'odt', 'odp'] as const;

export type OdfKind = 'ods' | 'odt' | 'odp';

export function odfKindFor(extension: string): OdfKind | null {
  if (extension === 'ods' || extension === 'odt' || extension === 'odp') return extension;
  return null;
}

/** PDF documents rendered with pdf.js (canvas + text layer). */
export const PDF_EXTENSIONS = ['pdf'] as const;

/**
 * Extensions routed to the text/code viewer. Everything here is shown as source text, never rendered,
 * so file content cannot reach the app DOM as markup.
 */
export const TEXT_EXTENSIONS = [
  'txt', 'log', 'json', 'jsonc', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'sql', 'sh', 'bash', 'bat', 'ps1',
  'c', 'h', 'cpp', 'hpp', 'cs', 'java', 'kt', 'go', 'rs', 'rb', 'php', 'swift', 'lua', 'r',
  'css', 'scss', 'xml', 'csv', 'tsv', 'tex', 'diff', 'patch',
] as const;
