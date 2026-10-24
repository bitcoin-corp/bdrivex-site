// bDriveX private file records: pure helpers (browser + node). Same shape as bvideox.com mint/records.js.
//
// A record is a file's details, never its bytes: name, type, size, the sha256 fingerprint of its bytes (computed in
// the browser), its date, where it came from and (for Drive) its link. Each record is encrypted with the owner's own
// keys (BRC-100 wallet.encrypt, BRC-2, protocol [2,'bdrivex records'], counterparty self, a fresh random key id per
// file). The chain shows that a record exists, its padded size and its time; only the owner's 12 words open it.
//
// Output script (one per file, 0 sats):
//   OP_FALSE OP_RETURN B <ciphertext> application/octet-stream binary | MAP SET app bdrivex type record v 1 enc brc2 kid <kid>
// Public record (opt-in, one per file; no Drive link):
//   OP_FALSE OP_RETURN B <json> application/json utf-8 | MAP SET app bdrivex type record-public v 1 reveal <txid:vout> kid <kid>
//     | BRC3 <publicKey> <signature over sha256(json)>

export const PROTOCOL = [2, 'bdrivex records'];
export const LABEL = PROTOCOL[1];
export const APP = 'bdrivex';
export const VERSION = '1';
export const B_PREFIX = '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut';
export const MAP_PREFIX = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5';
export const SIG = 'BRC3';
export const PER_TX = 25;
export const PAD_BUCKET = 128;
export const BRC2_OVERHEAD = 48;
export const TX_OVERHEAD_BYTES = 400;
export const PREMIUM_OUTPUT_BYTES = 34;
/** Wallet pin level that includes [2,'bdrivex records'] pinned to bdrivex.com (bWalletX services/pinnedProtocols.ts). */
export const PIN_VERSION = 3;
export const SOURCES = ['drive', 'upload', 'takeout'];

const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => Uint8Array.from(String(h).match(/../g) ?? [], (x) => parseInt(x, 16));
const sha256 = async (d) => new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', d));
const clip = (s, n) => String(s ?? '').slice(0, n);
const isoOrNull = (d) => { const t = d ? new Date(d) : null; return t && !isNaN(t) ? t.toISOString() : null; };

/** The private record for one file, in a fixed key order. `f` is a library item. */
export function recordFor(f) {
  if (!/^[0-9a-f]{64}$/.test(String(f.sha256))) throw new Error('no fingerprint yet');
  return {
    v: 1, name: clip(f.name, 255) || 'untitled', mimeType: clip(f.mimeType, 255) || 'application/octet-stream', size: Math.max(0, Math.floor(Number(f.size) || 0)),
    sha256: f.sha256, modifiedAt: isoOrNull(f.modifiedAt), source: SOURCES.includes(f.source) ? f.source : 'upload',
    driveId: f.driveId ? clip(f.driveId, 128) : null, url: /^https:\/\//.test(String(f.url || '')) ? clip(f.url, 500) : null,
    fingerprintOf: f.fingerprintOf ? clip(f.fingerprintOf, 120) : null,
  };
}
/** The public record (what Browse shows): no Drive id or link. Exactly this JSON string is signed and stored. */
export const publicRecordFor = (r) => ({ v: 1, name: r.name, mimeType: r.mimeType, size: r.size, sha256: r.sha256, modifiedAt: r.modifiedAt, source: r.source });
export const publicJson = (r) => JSON.stringify(publicRecordFor(r));

/** JSON then spaces up to the next PAD_BUCKET (JSON.parse ignores trailing whitespace), so sizes say less. */
export function pad(rec, bucket = PAD_BUCKET) {
  const raw = enc.encode(JSON.stringify(rec));
  const out = new Uint8Array(Math.ceil((raw.length + 1) / bucket) * bucket).fill(0x20);
  out.set(raw);
  return out;
}
export function readRecord(plaintext) {
  const j = JSON.parse(dec.decode(Uint8Array.from(plaintext)));
  if (!j || j.v !== 1 || typeof j.name !== 'string' || !/^[0-9a-f]{64}$/.test(String(j.sha256))) throw new Error('not a bdrivex record');
  return j;
}
/** 128-bit random key id, hex: says nothing about the file. */
export const newKeyId = (rand = (a) => globalThis.crypto.getRandomValues(a)) => hex(rand(new Uint8Array(16)));
/** Stable id for a file in the library: same bytes + same name = same item. */
export const itemId = (f) => `${f.sha256}:${String(f.name || '').slice(0, 255)}`;

// ── scripts ───────────────────────────────────────────────────────────────────
const pushData = (d) => {
  const n = d.length;
  const head = n < 0x4c ? [n] : n <= 0xff ? [0x4c, n] : n <= 0xffff ? [0x4d, n & 0xff, n >> 8] : [0x4e, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
  return [...head, ...d];
};
const s = (t) => enc.encode(t);
const PIPE = s('|');
const opReturn = (parts) => hex([0x00, 0x6a, ...parts.flatMap((p) => pushData(Array.from(p)))]);

export const recordScript = (kid, ciphertext) => opReturn([
  s(B_PREFIX), Uint8Array.from(ciphertext), s('application/octet-stream'), s('binary'), PIPE,
  s(MAP_PREFIX), s('SET'), s('app'), s(APP), s('type'), s('record'), s('v'), s(VERSION), s('enc'), s('brc2'), s('kid'), s(kid),
]);

export function readPushes(scriptHex) {
  const b = unhex(scriptHex);
  if (b[0] !== 0x00 || b[1] !== 0x6a) return null;
  const out = [];
  for (let i = 2; i < b.length;) {
    const op = b[i++];
    let n;
    if (op < 0x4c) n = op;
    else if (op === 0x4c) n = b[i++];
    else if (op === 0x4d) { n = b[i] | (b[i + 1] << 8); i += 2; }
    else if (op === 0x4e) { n = (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 2 ** 24; i += 4; }
    else return null;
    if (i + n > b.length) return null;
    out.push(b.slice(i, i + n));
    i += n;
  }
  return out;
}
export function parseRecordScript(scriptHex) {
  const p = readPushes(scriptHex);
  if (!p || p.length !== 17) return null;
  const t = p.map((x) => dec.decode(x));
  if (t[0] !== B_PREFIX || t[4] !== '|' || t[5] !== MAP_PREFIX || t[8] !== APP || t[10] !== 'record' || t[14] !== 'brc2' || t[15] !== 'kid') return null;
  if (!/^[0-9a-f]{32}$/.test(t[16])) return null;
  return { kid: t[16], ciphertext: p[1] };
}

// ── premium payee (P2PKH from a base58check address) ──────────────────────────
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export async function p2pkhScriptFor(address) {
  let n = 0n;
  for (const ch of String(address)) { const i = B58.indexOf(ch); if (i < 0) throw new Error('bad address'); n = n * 58n + BigInt(i); }
  let h = n.toString(16); if (h.length % 2) h = '0' + h;
  const lead = (String(address).match(/^1*/) || [''])[0].length;
  const b = Uint8Array.from([...new Array(lead).fill(0), ...unhex(h)]);
  if (b.length !== 25 || b[0] !== 0x00) throw new Error('not a mainnet P2PKH address');
  const sum = (await sha256(await sha256(b.slice(0, 21)))).slice(0, 4);
  if (hex(sum) !== hex(b.slice(21))) throw new Error('address checksum failed');
  return '76a914' + hex(b.slice(1, 21)) + '88ac';
}

// ── price ─────────────────────────────────────────────────────────────────────
export const premiumSats = (gbpPerItem, usdPerBsv, usdPerGbp) => Math.max(1, Math.ceil((gbpPerItem * usdPerGbp / usdPerBsv) * 1e8));
const pushLen = (n) => n + (n < 0x4c ? 1 : n <= 0xff ? 2 : n <= 0xffff ? 3 : 5);
/** Exact bytes of one record output (8-byte value + varint + script) for a padded plaintext length. */
export function outputBytes(plaintextBytes) {
  const parts = [B_PREFIX.length, plaintextBytes + BRC2_OVERHEAD, 24, 6, 1, MAP_PREFIX.length, 3, 3, APP.length, 4, 6, 1, 1, 3, 4, 3, 32];
  const script = 2 + parts.reduce((a, n) => a + pushLen(n), 0);
  return 8 + (script < 0xfd ? 1 : script <= 0xffff ? 3 : 5) + script;
}
export const feeSats = (bytes, satPerKb) => Math.ceil((bytes * satPerKb) / 1000);
/** Plan a record mint: batches, bytes, network fee, premium. */
export function plan(files, o) {
  const perTx = o.perTx || PER_TX, batches = [];
  for (let i = 0; i < files.length; i += perTx) batches.push(files.slice(i, i + perTx));
  let bytes = 0, fee = 0;
  for (const b of batches) {
    let tx = TX_OVERHEAD_BYTES + PREMIUM_OUTPUT_BYTES;
    for (const f of b) tx += outputBytes(pad(recordFor(f)).length);
    bytes += tx; fee += feeSats(tx, o.satPerKb);
  }
  const prem = premiumSats(o.gbpPerItem, o.usdPerBsv, o.usdPerGbp);
  return { files: files.length, txs: batches.length, bytes, feeSats: fee, premiumSatsPerItem: prem, premiumSats: prem * files.length, totalSats: fee + prem * files.length, batches };
}
/**
 * What keeping the whole file on chain would cost (Coming): the encrypted bytes at the network fee rate, plus the
 * same premium. Shown so nobody is surprised later; nothing is written this way in v1.
 */
export function fullStoragePlan(files, o) {
  let bytes = 0;
  for (const f of files) bytes += Math.max(0, Number(f.size) || 0) + BRC2_OVERHEAD + 120;
  bytes += Math.ceil(files.length / (o.perTx || PER_TX)) * (TX_OVERHEAD_BYTES + PREMIUM_OUTPUT_BYTES);
  const prem = premiumSats(o.gbpPerItem, o.usdPerBsv, o.usdPerGbp) * files.length;
  return { bytes, feeSats: feeSats(bytes, o.satPerKb), totalSats: feeSats(bytes, o.satPerKb) + prem };
}

// ── encrypt / decrypt ─────────────────────────────────────────────────────────
export async function encryptBatch(wallet, files, o = {}) {
  const outputs = [], items = [];
  for (const f of files) {
    const kid = newKeyId(o.rand);
    const { ciphertext } = await wallet.encrypt({ plaintext: Array.from(pad(recordFor(f))), protocolID: PROTOCOL, keyID: kid, counterparty: 'self' });
    items.push({ id: itemId(f), kid, vout: outputs.length });
    outputs.push({ lockingScript: recordScript(kid, ciphertext), satoshis: 0, outputDescription: 'Private file record' });
  }
  if (o.payeeScript && o.premiumSatsPerItem) outputs.push({ lockingScript: o.payeeScript, satoshis: o.premiumSatsPerItem * files.length, outputDescription: `bDriveX: 1p per file × ${files.length}` });
  return { outputs, items };
}
export async function openRecord(wallet, scriptHex) {
  const r = parseRecordScript(scriptHex);
  if (!r) return null;
  const { plaintext } = await wallet.decrypt({ ciphertext: Array.from(r.ciphertext), protocolID: PROTOCOL, keyID: r.kid, counterparty: 'self' });
  return { kid: r.kid, record: readRecord(plaintext) };
}

/**
 * Run a mint, batch by batch, resumable. `done` maps itemId -> outpoint already written; those are skipped.
 * Live: one createAction per batch (label 'bdrivex records', spendingAuthorization for the protocol, so the wallet
 * shows ONE sheet for the lock and the payment), then the txid is checked on chain before the batch is saved.
 * Dry run: nothing is sent; built outputs go to onDry.
 */
export async function runMint(o) {
  const todo = o.files.filter((f) => !o.done?.[itemId(f)]);
  const perTx = o.perTx || PER_TX;
  for (let i = 0; i < todo.length; i += perTx) {
    if (o.signal?.aborted) throw new Error('stopped');
    const fs = todo.slice(i, i + perTx);
    const b = await encryptBatch(o.wallet, fs, o);
    let txid;
    if (o.dryRun) { txid = 'dry' + (o.dryN = (o.dryN || 0) + 1); await o.onDry?.(b); }
    else {
      const r = await o.wallet.createAction({
        description: `bDriveX: ${fs.length} private file record${fs.length === 1 ? '' : 's'}`,
        outputs: b.outputs, labels: [LABEL],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false, spendingAuthorization: { protocolID: PROTOCOL } },
      });
      if (!r?.txid) throw new Error('The wallet returned no transaction.');
      txid = r.txid;
      o.onChecking?.(txid);
      if (!(await (o.confirm || confirmOnChain)(txid, { pending: r.pending === true }))) throw notOnChain(txid);
    }
    await o.onBatch?.(b.items.map((it) => ({ id: it.id, kid: it.kid, outpoint: `${txid}:${it.vout}`, script: o.dryRun ? b.outputs[it.vout].lockingScript : undefined })));
  }
}

// ── did it really go out? ─────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ARC_SEEN = /^(SEEN_ON_NETWORK|MINED|ACCEPTED_BY_NETWORK|SEEN_IN_ORPHAN_MEMPOOL)$/;
export async function confirmOnChain(txid, { pending = false, fetchFn = fetch, wait = sleep } = {}) {
  if (!/^[0-9a-f]{64}$/i.test(String(txid))) return false;
  const delays = pending ? [1500, 3000, 5000, 8000, 12000, 20000, 30000] : [1000, 2000, 3000, 5000, 8000, 12000];
  for (const d of delays) {
    try { const r = await fetchFn(`https://api.whatsonchain.com/v1/bsv/main/tx/hash/${txid}`, { cache: 'no-store' }); if (r.ok) return true; } catch {}
    try {
      const r = await fetchFn(`https://arc.gorillapool.io/v1/tx/${txid}`, { cache: 'no-store' });
      if (r.ok) { const j = await r.json().catch(() => null); if (j && ARC_SEEN.test(String(j.txStatus || ''))) return true; }
    } catch {}
    await wait(d);
  }
  return false;
}
export function notOnChain(txid) {
  const e = new Error(`Your wallet answered, but the network doesn't show the transaction (${String(txid).slice(0, 10)}…), so nothing is marked as done. Your bWalletX keeps trying to send it on its own; nothing more is charged if you wait. Check again in a few minutes before you press Mint again.`);
  e.code = 'NOT_ON_CHAIN'; e.txid = txid;
  return e;
}

// ── make one record public (opt-in) ───────────────────────────────────────────
export async function publicScript(wallet, json, kid, outpoint) {
  const bytes = enc.encode(json);
  const keyID = `public ${kid}`;
  const { publicKey } = await wallet.getPublicKey({ protocolID: PROTOCOL, keyID, counterparty: 'self' });
  const { signature } = await wallet.createSignature({ data: Array.from(await sha256(bytes)), protocolID: PROTOCOL, keyID, counterparty: 'self' });
  return opReturn([
    s(B_PREFIX), bytes, s('application/json'), s('utf-8'), PIPE,
    s(MAP_PREFIX), s('SET'), s('app'), s(APP), s('type'), s('record-public'), s('v'), s(VERSION), s('reveal'), s(outpoint), s('kid'), s(kid),
    PIPE, s(SIG), s(publicKey), s(hex(signature)),
  ]);
}
/** The message the wallet signs so the server lists a public record (push /v1/drive/public). */
export const publishMessage = async (identityKey, outpoint, json, ts) => `bdrivex public ${identityKey} ${outpoint} ${hex(await sha256(enc.encode(json)))} ${ts}`;
export const removeMessage = (identityKey, outpoint, ts) => `bdrivex unpublish ${identityKey} ${outpoint} ${ts}`;
export const PUBLIC_PROTOCOL = [2, 'bdrivex public'];
