// node --test test/  : sha256 streaming, Takeout ZIP reading, private record round trip, prices, Picker config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import { Sha256, hashStream } from '../drive/sha256.js';
import { listZip, entryStream, cleanName } from '../drive/zip.js';
import * as R from '../drive/records.js';
import { pickerConfig } from '../api/drive/config.js';

const ref = (b) => createHash('sha256').update(b).digest('hex');

test('streaming sha256 matches node for many sizes and chunkings', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 65536 + 7]) {
    const b = randomBytes(n);
    for (const step of [1, 3, 64, 1000, n || 1]) {
      const h = new Sha256();
      for (let i = 0; i < b.length; i += step) h.update(b.subarray(i, i + step));
      assert.equal(h.hex(), ref(b), `n=${n} step=${step}`);
    }
  }
});
test('hashStream over a Blob stream', async () => {
  const b = randomBytes(300_000);
  let seen = 0;
  assert.equal(await hashStream(new Blob([b]).stream(), (n) => { seen = n; }), ref(b));
  assert.equal(seen, b.length);
});

/** A tiny ZIP writer: stored + deflate entries, a folder, a nasty name. */
function zip(entries) {
  const locals = [], cds = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), data = e.data ?? Buffer.alloc(0);
    const comp = e.method === 8 ? deflateRawSync(data) : data;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(e.method, 8);
    lh.writeUInt16LE(0x6000, 10); lh.writeUInt16LE(0x5b58, 12); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(e.method, 10); ch.writeUInt16LE(0x6000, 12); ch.writeUInt16LE(0x5b58, 14);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, comp); cds.push(ch, name); off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(cds), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return new Blob([...locals, cd, end]);
}
test('Takeout ZIP: lists files, skips folders, cleans names, streams + fingerprints stored and deflated entries', async () => {
  const a = randomBytes(5000), b = Buffer.from('hello '.repeat(2000));
  const z = zip([{ name: 'Takeout/Drive/', method: 0 }, { name: 'Takeout/Drive/photos/a.bin', method: 0, data: a }, { name: 'Takeout/Drive/../../etc/b<script>.txt', method: 8, data: b }]);
  const list = await listZip(z);
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'photos/a.bin');
  assert.equal(list[1].name, 'etc/b<script>.txt'); // escaped at display time, never path-joined
  assert.equal(list[1].size, b.length);
  assert.match(list[0].modifiedAt, /^2025-10-24T12:00/);
  assert.equal(await hashStream(await entryStream(z, list[0])), ref(a));
  assert.equal(await hashStream(await entryStream(z, list[1])), ref(b));
});
test('not a ZIP is a plain-words error', async () => {
  await assert.rejects(listZip(new Blob([randomBytes(500)])), /isn’t a ZIP/);
  assert.equal(cleanName('/a/./b\u0000c/../d'), 'a/bc/d');
});

const file = (o = {}) => ({ name: 'lease.pdf', mimeType: 'application/pdf', size: 123456, sha256: ref('x'), modifiedAt: '2026-10-01T10:00:00Z', source: 'drive', driveId: 'abc', url: 'https://drive.google.com/file/d/abc/view', ...o });
test('record round trip: encrypt with the wallet, parse the script, decrypt, same record', async () => {
  const w = new ProtoWallet(PrivateKey.fromRandom());
  const b = await R.encryptBatch(w, [file(), file({ name: 'b.jpg', url: 'javascript:alert(1)' })]);
  assert.equal(b.outputs.length, 2);
  const r0 = await R.openRecord(w, b.outputs[0].lockingScript);
  assert.deepEqual(r0.record, R.recordFor(file()));
  const r1 = await R.openRecord(w, b.outputs[1].lockingScript);
  assert.equal(r1.record.url, null, 'only https links are kept');
  // another wallet can't open it
  await assert.rejects(R.openRecord(new ProtoWallet(PrivateKey.fromRandom()), b.outputs[0].lockingScript));
  // the script size matches the planner's estimate
  assert.equal(R.outputBytes(R.pad(R.recordFor(file())).length), 8 + 1 + b.outputs[0].lockingScript.length / 2 + (b.outputs[0].lockingScript.length / 2 >= 0xfd ? 2 : 0));
  assert.equal(R.publicJson(R.recordFor(file())).includes('drive.google.com'), false, 'public record drops the Drive link');
});
test('plan: premium per file + fee; full storage costs scale with bytes', () => {
  const cfg = { gbpPerItem: 0.01, usdPerBsv: 50, usdPerGbp: 1.3, satPerKb: 100 };
  const p = R.plan([file(), file({ name: 'b' })], cfg);
  assert.equal(p.txs, 1);
  assert.equal(p.premiumSatsPerItem, Math.ceil(0.01 * 1.3 / 50 * 1e8));
  assert.ok(p.feeSats > 0 && p.totalSats === p.feeSats + p.premiumSats);
  const f1 = R.fullStoragePlan([file({ size: 1_000_000 })], cfg), f2 = R.fullStoragePlan([file({ size: 10 })], cfg);
  assert.ok(f1.feeSats > 90_000 && f2.feeSats < 100);
  assert.throws(() => R.recordFor(file({ sha256: 'nope' })));
});
test('Picker config only when switched on and well formed', () => {
  const ok = { GOOGLE_PICKER: 'on', GOOGLE_CLIENT_ID: '123-abc.apps.googleusercontent.com', GOOGLE_PICKER_API_KEY: 'AIza' + 'x'.repeat(35), GOOGLE_PICKER_APP_ID: '1234567890' };
  assert.deepEqual(pickerConfig(ok), { clientId: ok.GOOGLE_CLIENT_ID, apiKey: ok.GOOGLE_PICKER_API_KEY, appId: '1234567890' });
  assert.equal(pickerConfig({ ...ok, GOOGLE_PICKER: 'off' }), null);
  assert.equal(pickerConfig({ ...ok, GOOGLE_PICKER_APP_ID: '' }), null);
  assert.equal(pickerConfig({}), null);
});
