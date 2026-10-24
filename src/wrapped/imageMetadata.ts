import { stripSvgMetadata } from './shareCards.js';

// Metadata stripping for exported share-card images (Prompt 5.3, operation key 2026-10-10.1/prompt-5.3).
// Allow-list based: only what is needed to draw the picture is copied; everything else is dropped.
// Used for any raster the browser panel produces before it is saved. Rules: docs/SHARE_CARDS.md.

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']); // drops tEXt, zTXt, iTXt, eXIf, tIME, pHYs, iCCP, gAMA, ...

export type StripResult = { ok: true; format: 'png' | 'jpeg' | 'svg'; body: Buffer } | { ok: false; error: 'unsupported_or_corrupt' };

function stripPng(b: Buffer): Buffer | null {
  if (b.length < 20 || !b.subarray(0, 8).equals(PNG_SIG)) return null;
  const out: Buffer[] = [PNG_SIG];
  let pos = 8, sawEnd = false, sawHeader = false;
  while (pos + 12 <= b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + len;
    if (end > b.length) return null;
    if (pos === 8 && type !== 'IHDR') return null;
    if (type === 'IHDR') sawHeader = true;
    if (PNG_KEEP.has(type)) out.push(b.subarray(pos, end));
    pos = end;
    if (type === 'IEND') { sawEnd = true; break; }
  }
  return sawEnd && sawHeader ? Buffer.concat(out) : null; // bytes after IEND are dropped too
}

function stripJpeg(b: Buffer): Buffer | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const out: Buffer[] = [b.subarray(0, 2)];
  let pos = 2;
  while (pos + 4 <= b.length) {
    if (b[pos] !== 0xff) return null;
    const marker = b[pos + 1] as number;
    if (marker === 0xff) { pos++; continue; }
    if (marker === 0xda) { // start of scan: entropy-coded data follows; copy it, then stop at EOI
      let i = pos + 2 + b.readUInt16BE(pos + 2);
      while (i + 1 < b.length && !(b[i] === 0xff && b[i + 1] === 0xd9)) i++;
      if (i + 1 >= b.length) return null;
      out.push(b.subarray(pos, i), Buffer.from([0xff, 0xd9]));
      return Buffer.concat(out);
    }
    const len = b.readUInt16BE(pos + 2);
    if (len < 2 || pos + 2 + len > b.length) return null;
    const isApp = marker >= 0xe0 && marker <= 0xef, isCom = marker === 0xfe;
    const isJfif = marker === 0xe0 && b.toString('latin1', pos + 4, pos + 9) === 'JFIF\0';
    if ((!isApp && !isCom) || isJfif) out.push(b.subarray(pos, pos + 2 + len)); // APP1 (EXIF, XMP), APP2 (ICC), APP13 (IPTC), COM are dropped
    pos += 2 + len;
  }
  return null;
}

/** True when the text, after an optional XML declaration and any comments, opens with an svg element. Linear scan, no backtracking. */
function startsAsSvg(input: string): boolean {
  let s = input.trimStart();
  if (s.startsWith('<?xml')) {
    const end = s.indexOf('?>');
    if (end === -1) return false;
    s = s.slice(end + 2).trimStart();
  }
  while (s.startsWith('<!--')) {
    const end = s.indexOf('-->');
    if (end === -1) return false;
    s = s.slice(end + 3).trimStart();
  }
  return /^<svg\b/.test(s);
}

export function stripImageMetadata(input: Buffer | string): StripResult {
  if (typeof input === 'string') return startsAsSvg(input) ? { ok: true, format: 'svg', body: Buffer.from(stripSvgMetadata(input), 'utf8') } : { ok: false, error: 'unsupported_or_corrupt' };
  const png = stripPng(input);
  if (png) return { ok: true, format: 'png', body: png };
  const jpg = stripJpeg(input);
  if (jpg) return { ok: true, format: 'jpeg', body: jpg };
  return { ok: false, error: 'unsupported_or_corrupt' };
}
