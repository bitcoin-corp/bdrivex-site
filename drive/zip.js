// Read a Google Takeout ZIP in the browser, without uploading it anywhere. Only the central directory is read up
// front (a few KB at the end of the file); each file's bytes are streamed from its slice of the ZIP, inflated with
// the browser's own DecompressionStream, and fingerprinted. ZIP64 (Takeout archives over 4 GB) is supported.
// Everything in the archive is untrusted: names are cleaned, sizes are checked against the archive, and only
// stored (0) and deflate (8) entries are read.

export const MAX_ENTRIES = 20000;
const u16 = (d, o) => d.getUint16(o, true);
const u32 = (d, o) => d.getUint32(o, true);
const u64 = (d, o) => u32(d, o) + u32(d, o + 4) * 2 ** 32;
const view = async (blob, start, end) => new DataView(await blob.slice(start, end).arrayBuffer());

/** A clean display path: no control chars, no leading slashes or ../, Takeout's "Takeout/Drive/" prefix dropped. */
export function cleanName(raw) {
  let n = String(raw).replace(/\\/g, '/').replace(/[\u0000-\u001f\u007f]/g, '');
  n = n.split('/').filter((p) => p && p !== '.' && p !== '..').join('/');
  n = n.replace(/^Takeout\/(Drive|Google Drive)\//i, '');
  return n.slice(-255) || 'untitled';
}
const dosDate = (t, d) => {
  const y = ((d >> 9) & 0x7f) + 1980, m = (d >> 5) & 0xf, day = d & 0x1f;
  if (!m || !day) return null;
  const dt = new Date(Date.UTC(y, m - 1, day, (t >> 11) & 0x1f, (t >> 5) & 0x3f, (t & 0x1f) * 2));
  return isNaN(dt) ? null : dt.toISOString();
};

/** List the files in a ZIP (Blob/File): [{ name, size, csize, method, offset, modifiedAt }]. Throws on non-ZIPs. */
export async function listZip(blob) {
  const len = blob.size;
  if (len < 22) throw new Error('That file is too small to be a ZIP.');
  const tailLen = Math.min(len, 65557);
  const tail = await view(blob, len - tailLen, len);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('That isn’t a ZIP file (or it’s damaged).');
  let count = u16(tail, eocd + 10), cdSize = u32(tail, eocd + 12), cdOff = u32(tail, eocd + 16);
  // ZIP64: the locator sits just before the EOCD record.
  if ((count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) && eocd >= 20 && u32(tail, eocd - 20) === 0x07064b50) {
    const z64 = u64(tail, eocd - 20 + 8);
    if (z64 + 56 > len) throw new Error('That ZIP looks damaged.');
    const r = await view(blob, z64, z64 + 56);
    if (u32(r, 0) !== 0x06064b50) throw new Error('That ZIP looks damaged.');
    count = u64(r, 32); cdSize = u64(r, 40); cdOff = u64(r, 48);
  }
  if (cdOff + cdSize > len) throw new Error('That ZIP looks damaged.');
  if (count > MAX_ENTRIES) throw new Error(`That ZIP has ${count.toLocaleString()} items. Split your Takeout into smaller parts (Takeout offers 2 GB parts) and add them one at a time.`);
  const cd = await view(blob, cdOff, cdOff + cdSize);
  const out = [];
  for (let p = 0, i = 0; i < count; i++) {
    if (p + 46 > cd.byteLength || u32(cd, p) !== 0x02014b50) throw new Error('That ZIP looks damaged.');
    const method = u16(cd, p + 10), mt = u16(cd, p + 12), md = u16(cd, p + 14);
    let csize = u32(cd, p + 20), size = u32(cd, p + 24);
    const nl = u16(cd, p + 28), xl = u16(cd, p + 30), cl = u16(cd, p + 32);
    let offset = u32(cd, p + 42);
    const name = new TextDecoder().decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nl));
    // ZIP64 extra field (id 1): the 0xffffffff fields, in order.
    for (let x = p + 46 + nl, end = x + xl; x + 4 <= end;) {
      const id = u16(cd, x), sz = u16(cd, x + 2);
      if (id === 1) {
        let q = x + 4;
        if (size === 0xffffffff) { size = u64(cd, q); q += 8; }
        if (csize === 0xffffffff) { csize = u64(cd, q); q += 8; }
        if (offset === 0xffffffff) { offset = u64(cd, q); q += 8; }
      }
      x += 4 + sz;
    }
    p += 46 + nl + xl + cl;
    if (name.endsWith('/')) continue; // folder
    if (method !== 0 && method !== 8) continue; // only stored + deflate
    if (offset + csize > len) continue;
    out.push({ name: cleanName(name), rawName: name, size, csize, method, offset, modifiedAt: dosDate(mt, md) });
  }
  return out;
}

/** A ReadableStream of one entry's uncompressed bytes. */
export async function entryStream(blob, e) {
  const h = await view(blob, e.offset, e.offset + 30);
  if (u32(h, 0) !== 0x04034b50) throw new Error('That ZIP looks damaged.');
  const start = e.offset + 30 + u16(h, 26) + u16(h, 28);
  const raw = blob.slice(start, start + e.csize).stream();
  if (e.method === 0) return raw;
  if (typeof DecompressionStream !== 'function') throw new Error('This browser can’t open ZIP files. Try Chrome, Edge, Safari 16.4+ or Firefox 113+.');
  return raw.pipeThrough(new DecompressionStream('deflate-raw'));
}

/** Rough type from the extension (ZIPs carry no MIME types). */
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', odt: 'application/vnd.oasis.opendocument.text', html: 'text/html', svg: 'image/svg+xml' };
export const typeFor = (name) => TYPES[(String(name).match(/\.([a-z0-9]{1,8})$/i) || [])[1]?.toLowerCase()] || 'application/octet-stream';
