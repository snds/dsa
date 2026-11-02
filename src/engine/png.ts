import zlib from 'node:zlib';

/**
 * Just enough PNG to read the screenshots dsa takes (8-bit RGB or RGBA, not interlaced): so a
 * capture can be checked for painted pixels without an image library.
 */
export interface Pixels { width: number; height: number; /** RGBA, row by row */ data: Uint8Array }

export function decodePng(buf: Buffer): Pixels {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG');
  let at = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at), kind = buf.toString('latin1', at + 4, at + 8), body = buf.subarray(at + 8, at + 8 + len);
    if (kind === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]!; type = body[9]!; interlace = body[12]!; }
    else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
    at += 12 + len;
  }
  const ch = type === 6 ? 4 : type === 2 ? 3 : type === 0 ? 1 : type === 4 ? 2 : 0;
  if (depth !== 8 || !ch || interlace) throw new Error(`Unsupported PNG (depth ${depth}, type ${type}, interlace ${interlace})`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch, data = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride), p = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[p++]!, line = new Uint8Array(raw.subarray(p, p + stride)); p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch]! : 0, b = prev[x]!, c = x >= ch ? prev[x - ch]! : 0;
      const pr = () => { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
      line[x] = (line[x]! + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? pr() : 0)) & 255;
    }
    for (let x = 0; x < width; x++) {
      const s = x * ch, d = (y * width + x) * 4;
      if (ch >= 3) { data[d] = line[s]!; data[d + 1] = line[s + 1]!; data[d + 2] = line[s + 2]!; data[d + 3] = ch === 4 ? line[s + 3]! : 255; }
      else { data[d] = data[d + 1] = data[d + 2] = line[s]!; data[d + 3] = ch === 2 ? line[s + 1]! : 255; }
    }
    prev = line;
  }
  return { width, height, data };
}

/** CSS pixels kept off a box's edge when looking for content: past a border and its anti-aliasing. */
export const BLANK_INSET = 3;

/**
 * Whether a region shows anything: a box is blank when its luminance barely varies (spread under 6)
 * or it holds two colours or fewer. `box` is in CSS pixels; `scale` is the capture's device pixel ratio.
 */
export function isBlank(px: Pixels, box?: { x: number; y: number; w: number; h: number } | null, scale = 2, inset = 0): boolean {
  // Inset (CSS px) skips the box's own edge: an empty bordered button is a border and a fill, nothing inside.
  const i = box ? Math.min(inset, box.w / 4, box.h / 4) : 0;
  const x0 = Math.max(0, Math.floor(((box?.x ?? 0) + i) * scale)), y0 = Math.max(0, Math.floor(((box?.y ?? 0) + i) * scale));
  const x1 = Math.min(px.width, Math.ceil(box ? (box.x + box.w - i) * scale : px.width)), y1 = Math.min(px.height, Math.ceil(box ? (box.y + box.h - i) * scale : px.height));
  let lo = 255, hi = 0;
  const colours = new Set<number>();
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * px.width + x) * 4, r = px.data[i]!, g = px.data[i + 1]!, b = px.data[i + 2]!;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (l < lo) lo = l; if (l > hi) hi = l;
    if (colours.size < 3) colours.add((r << 16) | (g << 8) | b);
  }
  return x1 <= x0 || y1 <= y0 || hi - lo < 6 || colours.size <= 2;
}
