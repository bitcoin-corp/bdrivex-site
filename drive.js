// bDriveX: /drive (the signed-in wallet's own page) and /u/<name> (anyone's public files; owner tools when it's yours).
// Same shape as bvideox.com/studio: connect -> bring in files -> mint, library on the page, one approval per batch.
// Every file and every name in it is untrusted: names are escaped, never put in URLs, styles or attributes.
import * as R from '/drive/records.js';
import { LIVE, esc, ls, filesN, txN, bytes, money, doneKey, doneFor, libKey, loadCfg, pinCheck, liveBlock, friendly } from '/drive/core.js';
import { hashStream } from '/drive/sha256.js';
import { listZip, entryStream, typeFor } from '/drive/zip.js';
import * as G from '/drive/google.js';

const $ = (id) => document.getElementById(id);
const TEST = !/^(www\.)?bdrivex\.com$/.test(location.hostname);
const uname = decodeURIComponent((location.pathname.match(/^\/u\/([^/]+)/) || [])[1] || '').toLowerCase();
const badge = (el, live, text) => { el.className = 'badge ' + (live ? 'live' : 'coming'); el.textContent = text || (live ? 'Live' : 'Coming'); };
const say = (el, text, kind = '') => { el.textContent = text || ''; el.className = 'msg' + (kind ? ' ' + kind : ''); };

let P = null, pg = null, key = null, cfg = null, busy = false, preview = false;
let lib = [];                       // [{ id, name, mimeType, size, sha256, modifiedAt, source, driveId, url, fingerprintOf, addedAt }]
const work = new Map();             // tmp id -> { name, size, got, err } while fingerprinting (not saved)
const picked = new Set();
const fmsg = new Map();             // item id -> { text, bad }
let stop = null;                    // AbortController for the fingerprint queue

if (TEST) $('testbar').hidden = false;
const owner = () => !!(P?.isOwner || preview);
const store = () => key || 'preview';
const done = () => doneFor(store());
const pubs = () => ls.get(`bdx-pub-${store()}`) || {};
const saveLib = () => ls.set(libKey(store()), lib);

// ── load ──────────────────────────────────────────────────────────────────────
async function load() {
  const [p, c] = await Promise.all([
    fetch(uname ? '/api/profile?name=' + encodeURIComponent(uname) : '/api/profile?me=1', { cache: 'no-store' })
      .then(async (r) => ({ ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) })).catch(() => ({ ok: false, status: 0, j: {} })),
    loadCfg(),
  ]);
  cfg = c;
  $('loading').hidden = true;
  if (uname && p.status === 404) { $('nf').hidden = false; $('nfTitle').textContent = `Nobody called ${uname} yet.`; return; }
  if (!p.ok || !p.j.page) {
    if (uname) { $('nf').hidden = false; $('nfTitle').textContent = 'That page didn’t open.'; return; }
    // Preview deploys have no wallet sign-in: open the owner tools without a wallet so uploads, Takeout and prices can be tried.
    if (TEST) { preview = true; P = { isOwner: false }; pg = { alias: null, paymail: null, displayName: 'Preview drive', files: [] }; }
    else { $('gate').hidden = false; if (p.j && p.j.connectOn === false) say($('gateMsg'), 'Wallet sign-in is being switched on for bdrivex.com. Try again shortly.', 'bad'); return; }
  } else { P = p.j; pg = P.page; key = P.identityKey || null; }
  if (uname && pg.alias && uname !== pg.alias) history.replaceState(null, '', '/u/' + encodeURIComponent(pg.alias));
  $('page').hidden = false;
  head();
  if (owner()) {
    $('owner3').hidden = false; $('ownerLinks').hidden = false; $('addPanel').hidden = false; $('lib').hidden = false;
    lib = (ls.get(libKey(store())) || []).filter((f) => f && /^[0-9a-f]{64}$/.test(f.sha256));
    googleBox();
    paint();
  } else publicView();
  checklist();
  if (location.hash === '#status') openModal('status');
}

function setAvatar(url, name) {
  const av = $('av'); av.setAttribute('aria-label', name || '');
  av.textContent = (name || 'b').trim().charAt(0).toUpperCase(); av.classList.add('init');
  if (!url || !/^https:\/\//.test(url)) return;
  const i = new Image();
  i.onload = () => { av.style.backgroundImage = `url("${encodeURI(url)}")`; av.textContent = ''; av.classList.remove('init'); };
  i.src = url;
}
function head() {
  const name = pg.displayName || (pg.alias ? pg.alias : 'bWalletX drive');
  document.title = `${owner() ? 'Your drive' : name} · bDriveX`;
  $('kick').textContent = owner() ? 'Your drive' : 'Drive';
  $('name').textContent = name;
  // Full paymail is the primary label; the $handle is secondary. No name: short key + "Get your name".
  const k0 = key || pg.identityKey || '';
  const sk = k0 ? k0.slice(0, 6) + '\u2026' + k0.slice(-4) : '';
  $('handle').textContent = pg.paymail || (preview ? 'Preview: connect works on bdrivex.com' : sk || 'No name yet');
  if (pg.paymail) $('mail').textContent = pg.alias ? '$' + pg.alias : '';
  else if (preview) $('mail').textContent = '';
  else $('mail').innerHTML = '<a href="https://bwalletx.com/get" target="_blank" rel="noopener">Get your name</a>';
  setAvatar(pg.avatar, name);
  if (pg.alias) { $('linkRow').hidden = false; $('pubLink').textContent = 'bdrivex.com/u/' + pg.alias; }
  $('copyLink').onclick = async () => { try { await navigator.clipboard.writeText('https://bdrivex.com/u/' + pg.alias); $('copyLink').textContent = 'Copied'; } catch { $('copyLink').textContent = 'Copy failed'; } setTimeout(() => { $('copyLink').textContent = 'Copy link'; }, 1600); };
  $('st1s').textContent = pg.paymail || (preview ? 'Preview (no wallet)' : sk || 'Connected');
  if (preview) { $('st1').classList.remove('done'); $('findBtn').hidden = true; }
}

// ── bring in files ────────────────────────────────────────────────────────────
let tmpN = 0;
function addItem(f) {
  const it = { ...f, id: R.itemId(f), addedAt: new Date().toISOString() };
  if (lib.some((x) => x.id === it.id)) return false;
  lib.unshift(it); saveLib(); return true;
}
/** Fingerprint a queue of sources one by one: [{ name, size, mimeType, modifiedAt, source, open: () => stream, extra }]. */
async function ingest(jobs, msgEl) {
  if (!jobs.length) return;
  if (stop) { say(msgEl, 'Wait for the files being read to finish, or press Stop.', 'bad'); return; }
  stop = new AbortController();
  const ids = jobs.map((j) => { const t = 'tmp' + (++tmpN); work.set(t, { name: j.name, size: j.size, got: 0 }); return t; });
  $('prog').hidden = false; paint();
  let added = 0, same = 0, bad = 0;
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i], t = ids[i], w = work.get(t);
    $('progT').textContent = `Fingerprinting ${i + 1} of ${filesN(jobs.length)}…`;
    try {
      if (stop.signal.aborted) throw new Error('stopped');
      let last = 0;
      const r = await j.hash((n) => { w.got = n; const now = performance.now(); if (now - last > 120) { last = now; paintWork(t); } }, stop.signal);
      work.delete(t);
      if (addItem({ name: j.name, mimeType: j.mimeType, size: j.size || w.got, sha256: r.sha256, fingerprintOf: r.fingerprintOf || null, modifiedAt: j.modifiedAt, source: j.source, driveId: j.driveId || null, url: j.url || null })) added++; else same++;
    } catch (e) {
      if (String(e?.message) === 'stopped' || e?.name === 'AbortError') { work.delete(t); continue; }
      w.err = e?.message || 'Couldn’t read this file.'; bad++;
    }
    paint();
  }
  const stopped = stop.signal.aborted;
  stop = null; $('prog').hidden = true;
  say(msgEl, `${stopped ? 'Stopped. ' : ''}${added ? `${filesN(added)} added.` : ''}${same ? ` ${filesN(same)} already here.` : ''}${bad ? ` ${filesN(bad)} couldn’t be read (shown in red).` : ''}`.trim() || 'Nothing added.', bad && !added ? 'bad' : 'ok');
  paint();
  if (added) $('lib').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
const fileJob = (file) => ({ name: file.name || 'untitled', size: file.size, mimeType: file.type || typeFor(file.name), modifiedAt: file.lastModified ? new Date(file.lastModified).toISOString() : null, source: 'upload',
  hash: async (on, signal) => ({ sha256: await hashStream(file.stream(), on, signal) }) });

async function addUploads(files, msgEl) {
  const list = [...files];
  const zips = list.filter((f) => /\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed');
  const rest = list.filter((f) => !zips.includes(f));
  if (rest.length) await ingest(rest.map(fileJob), msgEl);
  for (const z of zips) await addTakeout(z, msgEl === $('uMsg') && !rest.length ? $('zMsg') : msgEl);
}
async function addTakeout(zip, msgEl) {
  say(msgEl, 'Reading the ZIP’s list of files…');
  let entries;
  try { entries = await listZip(zip); } catch (e) { say(msgEl, e.message, 'bad'); return; }
  entries = entries.filter((e) => !/(^|\/)archive_browser\.html$/i.test(e.rawName));
  if (!entries.length) { say(msgEl, 'That ZIP has no files we can read.', 'bad'); return; }
  say(msgEl, `${filesN(entries.length)} in the ZIP (${bytes(entries.reduce((a, e) => a + e.size, 0))}). Fingerprinting them here…`);
  await ingest(entries.map((e) => ({ name: e.name, size: e.size, mimeType: typeFor(e.name), modifiedAt: e.modifiedAt, source: 'takeout',
    hash: async (on, signal) => ({ sha256: await hashStream(await entryStream(zip, e), on, signal) }) })), msgEl);
}
$('fileIn').onchange = (e) => { const f = e.target.files; if (f?.length) addUploads(f, $('uMsg')); e.target.value = ''; };
$('zipIn').onchange = (e) => { const f = e.target.files?.[0]; if (f) addTakeout(f, $('zMsg')); e.target.value = ''; };
$('stopBtn').onclick = () => stop?.abort();
const drop = $('drop');
['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => { if (!owner() || !e.dataTransfer?.types?.includes('Files')) return; e.preventDefault(); drop.classList.add('on'); }));
['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => { if (t === 'dragleave' && e.relatedTarget) return; drop.classList.remove('on'); }));
document.addEventListener('drop', (e) => { if (!owner() || !e.dataTransfer?.files?.length) return; e.preventDefault(); addUploads(e.dataTransfer.files, $('uMsg')); });

// Google Drive (Picker + drive.file). Off until GOOGLE_PICKER=on and the keys are set on the server.
function googleBox() {
  const on = !!cfg?.picker && !TEST;
  badge($('gBadge'), on, on ? 'Live' : 'Coming');
  const b = $('gBtn');
  if (!on) { b.setAttribute('aria-disabled', 'true'); b.textContent = TEST && cfg?.picker ? 'Works on bdrivex.com' : 'Coming soon'; }
  b.onclick = async () => {
    if (b.getAttribute('aria-disabled')) { say($('gMsg'), TEST ? 'Google Drive only works on bdrivex.com.' : 'Google Drive is being switched on. Upload files or a Takeout ZIP work now.'); return; }
    if (stop) { say($('gMsg'), 'Wait for the files being read to finish.', 'bad'); return; }
    b.disabled = true; b.classList.add('busy'); b.textContent = 'Opening Google…'; say($('gMsg'), '');
    try {
      const docs = await G.pick(cfg.picker);
      if (!docs.length) { say($('gMsg'), 'Nothing picked.'); return; }
      const ok = docs.filter((d) => d.mimeType !== 'application/vnd.google-apps.folder');
      await ingest(ok.map((d) => ({ name: d.name || 'untitled', size: d.size, mimeType: d.mimeType, modifiedAt: d.modifiedAt, source: 'drive', driveId: d.id, url: /^https:\/\/(docs|drive)\.google\.com\//.test(d.url) ? d.url : null,
        hash: (on, signal) => G.fingerprint(d, on, signal) })), $('gMsg'));
    } catch (e) { say($('gMsg'), e?.message || 'Google didn’t answer. Try again.', 'bad'); }
    finally { G.revoke(); b.disabled = false; b.classList.remove('busy'); b.textContent = 'From Google Drive'; }
  };
}

// ── library ───────────────────────────────────────────────────────────────────
const ext = (n, m) => (String(n).match(/\.([a-z0-9]{1,4})$/i) || [])[1] || (String(m).split('/')[1] || 'file').slice(0, 4);
const day = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const SRC = { drive: 'Google Drive', upload: 'Upload', takeout: 'Takeout' };
const unminted = () => lib.filter((f) => !done()[f.id]);
const selection = () => unminted().filter((f) => picked.has(f.id));

function card(f) {
  const d = done()[f.id], pub = pubs()[f.id], sel = picked.has(f.id), m = fmsg.get(f.id);
  const full = cfg?.fullStorage?.maxBytes && f.size > cfg.fullStorage.maxBytes;
  return `<article class="f${d ? ' minted' : ''}${sel ? ' sel' : ''}" data-id="${esc(f.id)}">
    <span class="pick">${d ? '' : `<input type="checkbox" data-pick="${esc(f.id)}"${sel ? ' checked' : ''} aria-label="Select ${esc(f.name)}">`}</span>
    <span class="ic" aria-hidden="true">${esc(ext(f.name, f.mimeType))}</span>
    <span style="min-width:0"><span class="t" title="${esc(f.name)}">${esc(f.name)}</span>
      <span class="d">${esc(bytes(f.size))} · ${esc(SRC[f.source] || 'File')}${f.modifiedAt ? ' · ' + esc(day(f.modifiedAt)) : ''}${full ? ' · too big for a full copy' : ''}</span>
      <span class="fp" title="sha256 ${esc(f.sha256)}">sha256 ${esc(f.sha256.slice(0, 16))}…${f.fingerprintOf ? ' (' + esc(f.fingerprintOf) + ')' : ''}</span></span>
    <span class="acts">${d
      ? `<span class="seal">${d.dry ? 'DRY RUN' : 'MINTED'}</span><span class="mute" style="font-size:13px">${d.dry ? 'On this device only' : (pub ? 'Public' : 'Private') + ' · on chain'}</span>${d.dry ? '' : pub ? `<button class="btn btn-ghost" type="button" data-unpub="${esc(f.id)}">Remove from Browse</button>` : `<button class="btn btn-ghost" type="button" data-pub="${esc(f.id)}">Make public</button>`}${d.dry ? `<button class="x" type="button" data-rm="${esc(f.id)}">Remove</button>` : ''}`
      : `<button class="btn btn-gold" type="button" data-mint="${esc(f.id)}"${busy ? ' disabled' : ''}>Mint</button><button class="x" type="button" data-rm="${esc(f.id)}">Remove</button>`}</span>
    ${m ? `<p class="fmsg${m.bad ? ' bad' : ''}">${esc(m.text)}</p>` : ''}
  </article>`;
}
function workCard(t, w) {
  const pct = w.size ? Math.min(100, Math.round((w.got / w.size) * 100)) : 0;
  return `<article class="f${w.err ? ' err' : ''}" data-tmp="${esc(t)}"><span class="pick"></span><span class="ic" aria-hidden="true">${esc(ext(w.name, ''))}</span>
    <span style="min-width:0"><span class="t">${esc(w.name)}</span><span class="d">${w.err ? '' : `Fingerprinting · ${esc(bytes(w.got))}${w.size ? ' of ' + esc(bytes(w.size)) : ''}`}</span>${w.err ? '' : `<span class="bar2"><i style="width:${pct}%"></i></span>`}</span>
    ${w.err ? `<p class="fmsg bad">${esc(w.err)}</p><span class="acts"><button class="x" type="button" data-rmtmp="${esc(t)}">Dismiss</button></span>` : ''}</article>`;
}
function paintWork(t) {
  const el = document.querySelector(`[data-tmp="${CSS.escape(t)}"]`), w = work.get(t);
  if (el && w) el.outerHTML = workCard(t, w);
}
function paint() {
  if (!owner()) return;
  const items = [...[...work].map(([t, w]) => workCard(t, w)), ...lib.map(card)];
  $('list').innerHTML = items.join('') || '<p class="empty">No files yet. Bring some in above.</p>';
  const nd = Object.keys(done()).filter((id) => lib.some((f) => f.id === id)).length;
  $('lLede').textContent = lib.length ? `${filesN(lib.length)} · ${filesN(nd)} minted. Pick some, or mint them all. Fingerprints were made here, in your browser.` : 'Add files above. They show here, ready to mint.';
  $('st2').classList.toggle('done', lib.length > 0); $('st2s').textContent = lib.length ? `${filesN(lib.length)} in your library` : 'Nothing yet';
  $('st3').classList.toggle('done', nd > 0); $('st3s').textContent = nd ? `${filesN(nd)} minted` : lib.length ? 'Ready when you are' : 'After adding files';
  $('tools').hidden = !lib.length;
  paintTools();
}
function block(walletKey = null, pinned = null, seen = '') {
  if (preview) return 'Preview: connect bWalletX on bdrivex.com to mint. Dry run needs a wallet too.';
  return liveBlock({ cfg, key, walletKey, pinned, seen });
}
function paintTools() {
  const left = unminted(), sel = selection(), target = sel.length ? sel : left;
  const b = block();
  $('selAll').textContent = left.length && sel.length === left.length ? 'Clear' : 'Select all';
  $('selAll').disabled = busy || !left.length;
  $('mintBtn').textContent = sel.length ? `Mint ${filesN(sel.length)}` : left.length ? `Mint all ${left.length.toLocaleString()}` : 'Mint';
  $('mintBtn').disabled = busy || !!b || !left.length;
  $('dryBtn').disabled = busy || preview || !left.length;
  if (!left.length) { $('costBig').textContent = '✓'; $('costSub').textContent = lib.length ? 'Every file here is minted.' : ''; $('fullCost').textContent = ''; return; }
  if (!cfg?.priced) { $('costBig').textContent = '…'; $('costSub').textContent = 'Getting today’s prices…'; return; }
  const p = R.plan(target, cfg), m = money(p.totalSats, cfg), fee = money(p.feeSats, cfg);
  const big = target.filter((f) => f.size > (cfg.fullStorage?.maxBytes || Infinity)).length;
  const fp = R.fullStoragePlan(target.filter((f) => f.size <= (cfg.fullStorage?.maxBytes || Infinity)), cfg);
  $('costBig').textContent = m.usd;
  $('costSub').innerHTML = `${esc(m.gbp ? 'about ' + m.gbp + ' · ' : '')}${esc(filesN(target.length))}${sel.length ? ' selected' : ''}: 1p per file + network fee (${esc(fee.usd)}), in ${esc(txN(p.txs))}.${b ? ` <em>${esc(b)}</em>` : ''}`;
  $('fullCost').textContent = `about ${money(fp.totalSats, cfg).usd}${big ? `, ${filesN(big)} over ${bytes(cfg.fullStorage.maxBytes)} left out` : ''}`;
}

$('list').addEventListener('change', (e) => { const id = e.target.dataset?.pick; if (!id) return; e.target.checked ? picked.add(id) : picked.delete(id); e.target.closest('.f').classList.toggle('sel', e.target.checked); paintTools(); });
$('list').addEventListener('click', (e) => {
  const t = e.target.closest('button'); if (!t) return;
  const d = t.dataset;
  if (d.mint) mint(lib.filter((f) => f.id === d.mint), false);
  else if (d.rm) { lib = lib.filter((f) => f.id !== d.rm); picked.delete(d.rm); const dn = done(); if (dn[d.rm]?.dry) { delete dn[d.rm]; ls.set(doneKey(store()), dn); } saveLib(); paint(); }
  else if (d.rmtmp) { work.delete(d.rmtmp); paint(); }
  else if (d.pub) makePublic(lib.find((f) => f.id === d.pub), t);
  else if (d.unpub) unpublish(lib.find((f) => f.id === d.unpub), t);
});
$('selAll').onclick = () => { const left = unminted(); const all = left.length && left.every((f) => picked.has(f.id)); left.forEach((f) => all ? picked.delete(f.id) : picked.add(f.id)); paint(); };
$('mintBtn').onclick = () => { const s = selection(); mint(s.length ? s : unminted(), false); };
$('dryBtn').onclick = () => { const s = selection(); mint(s.length ? s : unminted(), true); };

// ── mint: one approval per batch, verified on chain before Done ───────────────
async function mint(list, dryRun) {
  if (busy || !list.length) return;
  const msg = $('mintMsg');
  busy = true; paint(); $(dryRun ? 'dryBtn' : 'mintBtn').classList.add('busy');
  say(msg, 'Checking your wallet…');
  try {
    if (preview) throw new Error('Preview: connect bWalletX on bdrivex.com to mint.');
    const w = await window.bdxWallet();
    const walletKey = (await w.getPublicKey({ identityKey: true })).publicKey;
    cfg = await loadCfg();
    if (dryRun) { if (walletKey !== key) throw new Error('The wallet in this browser is a different identity from the one signed in. Reconnect bWalletX.'); if (!cfg?.priced) throw new Error('Prices are still loading.'); }
    else { const pin = await pinCheck(w); const b = liveBlock({ cfg, key, walletKey, pinned: pin.ok, seen: pin.seen }); if (b) throw new Error(b); }
    const todo = list.filter((f) => !done()[f.id]);
    if (!todo.length) throw new Error('Those files are already minted.');
    const p = R.plan(todo, cfg);
    const payeeScript = cfg.payee ? await R.p2pkhScriptFor(cfg.payee) : null;
    say(msg, dryRun ? 'Check your wallet: it encrypts your records with your keys. Nothing is sent or spent.'
      : `Check your wallet: one approval, “Mint ${filesN(todo.length)}, locked to you on bdrivex.com”, covers locking and paying (${money(p.totalSats, cfg).usd}).`);
    let n = 0;
    await R.runMint({
      wallet: w, files: todo, dryRun, perTx: cfg.perTx || R.PER_TX, payeeScript, premiumSatsPerItem: p.premiumSatsPerItem, done: done(),
      onChecking: () => say(msg, 'Approved. Checking the network has it…'),
      onBatch: (es) => {
        const d = done();
        for (const e of es) d[e.id] = dryRun ? { outpoint: e.outpoint, kid: e.kid, dry: true, script: e.script } : { outpoint: e.outpoint, kid: e.kid };
        ls.set(doneKey(store()), d);
        n += es.length; say(msg, `${n} of ${filesN(todo.length)} ${dryRun ? 'encrypted on this device…' : 'written and seen on the network…'}`); paint();
      },
    });
    picked.clear();
    say(msg, dryRun ? `Dry run done: ${filesN(n)} encrypted by your wallet into ${txN(p.txs)}, about ${money(p.totalSats, cfg).usd} if sent. Nothing was sent or spent.`
      : `Done: ${filesN(n)} minted, private, locked with your keys. About ${money(p.totalSats, cfg).usd}.`, 'ok');
  } catch (e) { say(msg, friendly(e), 'bad'); }
  busy = false; $('mintBtn').classList.remove('busy'); $('dryBtn').classList.remove('busy'); paint(); checklist();
}

// ── find my records (any device): the wallet's own actions, decrypted here ────
$('findBtn').onclick = async () => {
  const b = $('findBtn'); b.disabled = true; say($('findMsg'), 'Opening your records on this device…');
  try {
    const w = await window.bdxWallet();
    const a = await w.listActions({ labels: [R.LABEL], includeOutputs: true, includeOutputLockingScripts: true, limit: 1000 });
    let found = 0; const d = done();
    for (const t of a.actions || []) for (const o of t.outputs || []) {
      if (!o.lockingScript || !R.parseRecordScript(o.lockingScript)) continue;
      const r = await R.openRecord(w, o.lockingScript).catch(() => null);
      if (!r) continue;
      const it = { name: r.record.name, mimeType: r.record.mimeType, size: r.record.size, sha256: r.record.sha256, modifiedAt: r.record.modifiedAt, source: r.record.source, driveId: r.record.driveId, url: r.record.url, fingerprintOf: r.record.fingerprintOf };
      const id = R.itemId(it);
      addItem(it);
      if (!d[id] || d[id].dry) { d[id] = { outpoint: `${t.txid}:${o.outputIndex}`, kid: r.kid }; found++; }
    }
    ls.set(doneKey(store()), d); paint();
    say($('findMsg'), found ? `Found ${filesN(found)} you minted before.` : 'All your records are already here.', 'ok');
  } catch (e) { say($('findMsg'), friendly(e), 'bad'); }
  b.disabled = false;
};

// ── make public (opt-in, one file at a time) ──────────────────────────────────
function ask(title, body, yes) {
  return new Promise((ok) => {
    const d = $('ask'); $('askH').textContent = title; $('askP').textContent = body; $('askGo').textContent = yes;
    const close = (v) => { d.removeEventListener('close', onClose); $('askGo').onclick = null; if (d.open) d.close(); ok(v); };
    const onClose = () => close(false);
    $('askGo').onclick = () => close(true);
    d.addEventListener('close', onClose);
    d.showModal();
  });
}
const setMsg = (f, text, bad) => { if (text) fmsg.set(f.id, { text, bad }); else fmsg.delete(f.id); paint(); };
async function makePublic(f, btn) {
  if (!f) return;
  const dn = done()[f.id];
  if (!dn || dn.dry) return;
  const go = await ask(`Make “${f.name}” public?`, 'Its name, type, size, fingerprint and date go on chain in clear, signed by you, and show on Browse and your page. The Drive link stays private. The chain copy can’t be undone; you can take it off Browse later.', 'Make public');
  if (!go) return;
  btn.disabled = true; setMsg(f, 'Check your wallet…');
  try {
    const w = await window.bdxWallet();
    const pin = await pinCheck(w); if (!pin.ok) throw new Error(liveBlock({ cfg, key, pinned: false, seen: pin.seen }));
    const rec = R.recordFor(f), json = R.publicJson(rec);
    const script = await R.publicScript(w, json, dn.kid, dn.outpoint);
    const t = await w.createAction({ description: 'bDriveX: make one file record public', outputs: [{ lockingScript: script, satoshis: 0, outputDescription: 'Public file record' }], labels: [R.LABEL, 'bdrivex public'], options: { randomizeOutputs: false, acceptDelayedBroadcast: false, spendingAuthorization: { protocolID: R.PROTOCOL } } });
    if (!t?.txid) throw new Error('The wallet returned no transaction.');
    setMsg(f, 'Approved. Checking the network has it…');
    if (!(await R.confirmOnChain(t.txid, { pending: t.pending === true }))) throw R.notOnChain(t.txid);
    const outpoint = `${t.txid}:0`, ts = Date.now();
    const p = pubs(); p[f.id] = { outpoint, listed: false }; ls.set(`bdx-pub-${store()}`, p);
    setMsg(f, 'On chain. Now sign to list it on Browse…');
    const { signature } = await w.createSignature({ protocolID: R.PUBLIC_PROTOCOL, keyID: 'publish', counterparty: 'anyone', data: Array.from(new TextEncoder().encode(await R.publishMessage(key, outpoint, json, ts))) });
    const r = await fetch('/api/drive/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outpoint, record: json, timestamp: ts, signature }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'It’s public on chain, but Browse didn’t take it. Try again later.');
    p[f.id].listed = true; ls.set(`bdx-pub-${store()}`, p);
    setMsg(f, 'Public ✓ It shows on Browse and your page.');
  } catch (e) { setMsg(f, friendly(e), true); }
  btn.disabled = false;
}
async function unpublish(f, btn) {
  const p = pubs()[f?.id]; if (!p) return;
  btn.disabled = true; setMsg(f, 'Check your wallet…');
  try {
    const w = await window.bdxWallet(), ts = Date.now();
    const { signature } = await w.createSignature({ protocolID: R.PUBLIC_PROTOCOL, keyID: 'publish', counterparty: 'anyone', data: Array.from(new TextEncoder().encode(R.removeMessage(key, p.outpoint, ts))) });
    const r = await fetch('/api/drive/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ remove: true, outpoint: p.outpoint, timestamp: ts, signature }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'That didn’t work. Try again.');
    const all = pubs(); delete all[f.id]; ls.set(`bdx-pub-${store()}`, all);
    setMsg(f, 'Taken off Browse. The public copy already on chain stays there.');
  } catch (e) { setMsg(f, friendly(e), true); }
  btn.disabled = false;
}

// ── public view + checklist ──────────────────────────────────────────────────
function publicView() {
  $('pub').hidden = false;
  const fs = pg.files || [];
  $('pubList').innerHTML = fs.length ? fs.map((f) => `<article class="f"><span class="pick"></span><span class="ic" aria-hidden="true">${esc(ext(f.name, f.mimeType))}</span>
    <span style="min-width:0"><span class="t" title="${esc(f.name)}">${esc(f.name)}</span><span class="d">${esc(bytes(f.size))}${f.modifiedAt ? ' · ' + esc(day(f.modifiedAt)) : ''}</span><span class="fp" title="sha256 ${esc(f.sha256)}">sha256 ${esc(String(f.sha256).slice(0, 16))}…</span></span>
    <span class="acts"><a class="btn btn-ghost" href="https://whatsonchain.com/tx/${esc(String(f.outpoint).split(':')[0])}" target="_blank" rel="noopener">On chain</a></span></article>`).join('')
    : `<p class="empty">${pg.publicLive === false ? 'Public files show here soon.' : 'No public files yet.'}</p>`;
  if (P.signedIn === false) $('pubList').insertAdjacentHTML('afterend', '<p class="hint">Is this yours? Connect bWalletX at the top to manage it.</p>');
}
function checklist() {
  const g = !!cfg?.picker && !TEST;
  const rows = [
    ['Connect bWalletX', !preview],
    ['Your $name and paymail on your page', true],
    ['Your page link (bdrivex.com/u/name)', true],
    ['Upload files from this device', true],
    ['Google Takeout ZIP, read in your browser', true],
    ['Pick files from Google Drive (only the ones you pick)', g],
    ['Fingerprint every file (sha256) in your browser', true],
    ['Mint a private record per file, one approval per batch', LIVE && !!cfg?.payee],
    ['Dry run (nothing sent)', true],
    ['Make a record public; Browse shows public ones only', true],
    ['Full encrypted copy of the file on chain', false],
    ['Choose your own username or domain', false],
  ];
  $('checklist').innerHTML = rows.map(([t, live]) => `<li><span>${esc(t)}</span><span class="badge ${live ? 'live' : 'coming'}">${live ? 'Live' : 'Coming'}</span></li>`).join('');
}

document.addEventListener('bdrivex-wallet', (e) => {
  const k = e.detail?.identityKey || null;
  say($('mintMsg'), '');
  if ((!P || preview) && k) location.reload();
  else if (P?.isOwner && k !== key) location.assign(uname ? location.pathname : '/drive');
  else if (P && !P.isOwner && !preview && k) location.reload();
});

// ── modals ────────────────────────────────────────────────────────────────────
function openModal(id) { const d = $(id); if (d && !d.open) d.showModal(); }
document.addEventListener('click', (e) => {
  const o = e.target.closest('[data-open]');
  if (o) { e.preventDefault(); openModal(o.dataset.open); return; }
  if (e.target.closest('[data-close]')) e.target.closest('dialog').close();
  else if (e.target.tagName === 'DIALOG') e.target.close();
});

load();
