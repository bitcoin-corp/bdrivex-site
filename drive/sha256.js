// Streaming SHA-256 for file fingerprints in the browser (and node, for tests). WebCrypto's digest() needs the
// whole file in memory; this one takes chunks, so a multi-GB Drive or Takeout file never has to fit in RAM.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  constructor() {
    this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.buf = new Uint8Array(64); this.n = 0; this.len = 0; this.w = new Uint32Array(64);
  }
  block(b, o) {
    const w = this.w, h = this.h;
    for (let i = 0; i < 16; i++) w[i] = (b[o + i * 4] << 24) | (b[o + i * 4 + 1] << 16) | (b[o + i * 4 + 2] << 8) | b[o + i * 4 + 3];
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], c = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((c >>> 17) | (c << 15)) ^ ((c >>> 19) | (c << 13)) ^ (c >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [A, B, C, D, E, F, G, H] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = ((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7));
      const t1 = (H + S1 + ((E & F) ^ (~E & G)) + K[i] + w[i]) | 0;
      const S0 = ((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10));
      const t2 = (S0 + ((A & B) ^ (A & C) ^ (B & C))) | 0;
      H = G; G = F; F = E; E = (D + t1) | 0; D = C; C = B; B = A; A = (t1 + t2) | 0;
    }
    h[0] += A; h[1] += B; h[2] += C; h[3] += D; h[4] += E; h[5] += F; h[6] += G; h[7] += H;
  }
  update(d) {
    let i = 0;
    this.len += d.length;
    if (this.n) {
      while (this.n < 64 && i < d.length) this.buf[this.n++] = d[i++];
      if (this.n < 64) return this;
      this.block(this.buf, 0); this.n = 0;
    }
    for (; i + 64 <= d.length; i += 64) this.block(d, i);
    while (i < d.length) this.buf[this.n++] = d[i++];
    return this;
  }
  hex() {
    const bits = this.len * 8;
    const pad = new Uint8Array(((this.n + 9 + 63) & ~63) - this.n);
    pad[0] = 0x80;
    const hi = Math.floor(bits / 2 ** 32), lo = bits >>> 0;
    pad.set([hi >>> 24, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, lo >>> 24, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255], pad.length - 8);
    this.len -= pad.length; this.update(pad);
    return Array.from(this.h, (x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }
}

/** sha256 hex of a ReadableStream of Uint8Array chunks. onBytes(n) reports progress. */
export async function hashStream(stream, onBytes = () => {}, signal) {
  const s = new Sha256(), r = stream.getReader();
  let n = 0;
  for (;;) {
    if (signal?.aborted) { r.cancel().catch(() => {}); throw new Error('stopped'); }
    const { value, done } = await r.read();
    if (done) break;
    s.update(value); n += value.length; onBytes(n);
  }
  return s.hex();
}
