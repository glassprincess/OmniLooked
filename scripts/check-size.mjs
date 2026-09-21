// Checks the start bundle (index.html + the JS/CSS it loads) against the 100 KB limit from the spec.
// The size is measured compressed (gzip and brotli); the limit is applied to gzip. Run after `pnpm build`.
import { readFileSync, existsSync } from 'node:fs';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';

const DIST = 'dist';
const LIMIT_BYTES = 100 * 1024;

const htmlPath = join(DIST, 'index.html');
if (!existsSync(htmlPath)) {
  console.error('dist/index.html not found. Run `pnpm build` first.');
  process.exit(2);
}

const html = readFileSync(htmlPath, 'utf8');
const files = new Set([htmlPath]);
for (const match of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"[^>]*>/g)) {
  const ref = match[1];
  if (/^(?:[a-z]+:)?\/\//i.test(ref) || ref.startsWith('data:')) continue;
  if (!/\.(?:js|mjs|css)$/i.test(ref)) continue;
  const path = join(DIST, ref.replace(/^\.?\//, ''));
  if (existsSync(path)) files.add(path);
}

let raw = 0;
let gzip = 0;
let brotli = 0;
for (const file of files) {
  const data = readFileSync(file);
  const g = gzipSync(data, { level: 9 }).length;
  const b = brotliCompressSync(data).length;
  raw += data.length;
  gzip += g;
  brotli += b;
  console.log(`${file}: raw ${data.length} B, gzip ${g} B, brotli ${b} B`);
}
console.log(`TOTAL: raw ${raw} B, gzip ${gzip} B, brotli ${brotli} B (limit for gzip: ${LIMIT_BYTES} B)`);

if (gzip > LIMIT_BYTES) {
  console.error('Start bundle exceeds the limit.');
  process.exit(1);
}
