import type { ViewerModule } from '../types';
import { ARCHIVE_EXTENSIONS, DOC_EXTENSIONS, LEGACY_EXTENSIONS, MEDIA_EXTENSIONS, ODF_EXTENSIONS, OFFICE_EXTENSIONS, PDF_EXTENSIONS, TEXT_EXTENSIONS } from './extensions';
import { detectMedia, isOle, isPdf, isZip } from './signatures';
import { isProbablyText } from './sniffer';

export interface ViewerEntry {
  id: string;
  /** Shown in the loading state: "Loading module [name]...". */
  name: string;
  extensions: readonly string[];
  /** Cheap signature check used when the extension does not match; must not load the viewer. */
  sniff?: (bytes: Uint8Array) => boolean;
  load: () => Promise<ViewerModule>;
}

/** Order matters: earlier entries are tried first. Only the entry list lives in the start bundle. */
export const VIEWERS: readonly ViewerEntry[] = [
  {
    id: 'doc',
    name: 'Doc',
    extensions: DOC_EXTENSIONS,
    sniff: isProbablyText,
    load: () => import('../viewers/doc/index'),
  },
  {
    id: 'office',
    name: 'Office',
    extensions: [...OFFICE_EXTENSIONS, ...LEGACY_EXTENSIONS, ...ODF_EXTENSIONS],
    sniff: (bytes) => isZip(bytes) || isOle(bytes),
    load: () => import('../viewers/office/index'),
  },
  {
    id: 'archive',
    name: 'Archive',
    extensions: ARCHIVE_EXTENSIONS,
    sniff: isZip,
    load: () => import('../viewers/archive/index'),
  },
  {
    id: 'pdf',
    name: 'PDF',
    extensions: PDF_EXTENSIONS,
    sniff: isPdf,
    load: () => import('../viewers/pdf/index'),
  },
  {
    id: 'media',
    name: 'Media',
    extensions: MEDIA_EXTENSIONS,
    sniff: (bytes) => detectMedia(bytes) !== null,
    load: () => import('../viewers/media/index'),
  },
  {
    id: 'code',
    name: 'Text',
    extensions: TEXT_EXTENSIONS,
    sniff: isProbablyText,
    load: () => import('../viewers/code'),
  },
];

export const FALLBACK: ViewerEntry = {
  id: 'fallback',
  name: 'Fallback',
  extensions: [],
  load: () => import('../viewers/fallback/index'),
};

/** Layer 2 candidates: by extension first, then by signature. The plugin's own matches() has the last word. */
export function findCandidates(extension: string, bytes: Uint8Array): ViewerEntry[] {
  const byExtension = VIEWERS.filter((entry) => entry.extensions.includes(extension));
  const bySignature = VIEWERS.filter((entry) => !byExtension.includes(entry) && entry.sniff?.(bytes) === true);
  return [...byExtension, ...bySignature];
}
