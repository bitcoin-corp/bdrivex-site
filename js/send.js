// /send: sign in with bWalletX, seal and upload a file, hand back a link; list, re-link and delete your files.
import { API, SITE } from './config.js';
import { ApiError, api, fileSource, saveKeyWrap, shareUrl, unwrapKey, uploadFile } from './bdx-client.js';
import { importKey, openMeta, unb64u } from './bdx-crypto.js';
import { $, bytes, day, esc, eta, ext, store, tabStore, typeOf } from './ui.js';

const C = window.bWalletXConnect;
const K_SESSION = 'bdx:session', K_KEYS = 'bdx:keys', K_RESUME = 'bdx:resume';
store.set(K_SESSION, null); // v1 kept it in localStorage; clear any left behind
let session = tabStore.get(K_SESSION, null);
if (session && session.expiresAt < Date.now() + 60_000) session = null;
let handle = null, busy = false, current = null; // current = { hash, key, linkId }
let wallet = null, files = null, usage = null, unlocking = null, moved = false;

const LOCK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-label="Locked"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
// File keys live in the wallet (v1.1): bDriveX keeps each key wrapped by your wallet, and this tab keeps the
// opened keys in memory only. v1 kept raw keys in localStorage (K_KEYS); those move into the wallet and are cleared.
const opened = new Map(); // hash -> base64url key
const names = new Map(); // hash -> {name, type, size}
const legacy = () => store.get(K_KEYS, {});
function dropLegacy(hash) {
  const k = legacy();
  if (!(hash in k)) return;
  delete k[hash];
  store.set(K_KEYS, Object.keys(k).length ? k : null);
}
const keyOf = (hash) => opened.get(hash) || legacy()[hash];
const A = () => api(API, session?.token);

// ---------- sign in

function drawWho() {
  const who = $('#who');
  if (!session) { who.innerHTML = ''; return; }
  const k = session.identityKey;
  who.innerHTML = `<span class="chip" title="${esc(k)}"><i></i>${esc(handle || k.slice(0, 6) + '…' + k.slice(-4))}</span><button class="link-btn" type="button" id="signout">Sign out</button>`;
  $('#signout').onclick = () => signOut(false);
}

function show() {
  $('#gate').hidden = !!session;
  $('#app').hidden = !session;
  drawWho();
  if (session) { lookupHandle(session.identityKey); loadFiles(); }
}

async function lookupHandle(k) {
  try {
    const r = await fetch(`https://pay.bwallet.space/api/paymail/lookup?key=${encodeURIComponent(k)}`);
    const j = r.ok ? await r.json() : null;
    if (j && typeof j.paymail === 'string' && session?.identityKey === k) { handle = '$' + j.paymail.split('@')[0]; drawWho(); }
  } catch {}
}

const STATUS = { finding: 'Opening your wallet…', opening: 'Approve in bWalletX…', signing: 'Approve in bWalletX…', pairing: 'Scan the QR with bWalletX…' };
async function signIn() {
  const b = $('#signin'), err = $('#gate-err');
  err.hidden = true;
  if (!C) { err.textContent = 'The bWalletX sign-in script didn’t load. Reload the page.'; err.hidden = false; return; }
  b.disabled = true;
  let modal = null;
  try {
    modal = C.pairingModal({ title: 'Sign in to bDriveX' });
    const a = api(API);
    const r = await C.signInWithBwalletX({
      pairing: modal,
      onStatus: (s) => { if (STATUS[s]) b.textContent = STATUS[s]; },
      challenge: (identityKey) => a.post('/v1/auth/challenge', { identityKey }),
    });
    const v = await a.post('/v1/auth/verify', { identityKey: r.identityKey, nonce: r.nonce, signature: r.signature });
    session = v;
    wallet = r.wallet;
    tabStore.set(K_SESSION, v);
    show();
  } catch (e) {
    if (e && e.code === 'NOT_FOUND') err.innerHTML = 'No bWalletX found in this browser. <a href="https://bwalletx.com/get">Get bWalletX</a>, or sign in again to pair your phone.';
    else if (!(e && e.name === 'AbortError')) err.textContent = (e && e.message) || 'That didn’t work. Try again.';
    err.hidden = !err.textContent;
  } finally {
    try { modal && modal.close(); } catch {}
    b.disabled = false;
    b.textContent = 'Sign in with bWalletX';
  }
}

// everywhere: every session this wallet has, on every device. Otherwise just this one. The server forgets the token
// either way; a 401 (already ended) needs no call.
function signOut(everywhere, ended) {
  if (session && !ended) A().post(everywhere === true ? '/v1/auth/signout-all' : '/v1/auth/signout', {}).catch(() => {});
  session = null; handle = null; files = null; moved = false;
  opened.clear(); names.clear();
  try { wallet?.close?.(); } catch {}
  wallet = null;
  tabStore.set(K_SESSION, null);
  try { C?.clearPairing?.(); } catch {}
  show();
}

// The wallet that signed in. After a reload only the session is left, so find it again: the extension, the in-app
// browser or this browser's phone pairing answer without a QR. interactive: pair the phone by QR if need be.
async function getWallet(interactive) {
  if (wallet) return wallet;
  let modal = null;
  try {
    if (interactive) modal = C.pairingModal({ title: 'Unlock your files' });
    const r = await C.connectBwalletX(modal ? { pairing: modal } : {});
    const { publicKey } = await r.wallet.getPublicKey({ identityKey: true });
    if (publicKey !== session?.identityKey) throw new Error('That’s a different wallet from the one you signed in with.');
    return (wallet = r.wallet);
  } finally {
    try { modal && modal.close(); } catch {}
  }
}

const within = (ms, p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('bWalletX didn’t answer.')), ms))]);

// Any 401 means the session ended: back to the sign-in panel.
const guard = (e) => { if (e instanceof ApiError && e.status === 401) signOut(false, true); throw e; };

// ---------- send

const ttlValue = () => ($('#ttl').value ? Number($('#ttl').value) : null);
const ttlNote = (expiresAt) => { $('#ttl-note').textContent = `until ${day(expiresAt)}`; };

function progress(sent, total, startedAt) {
  const pc = total ? Math.floor((sent / total) * 100) : 100;
  $('#job-bar span').style.width = pc + '%';
  $('#job-bar').setAttribute('aria-valuenow', String(pc));
  $('#job-step').textContent = `Encrypting and uploading · ${pc}%`;
  $('#job-rate').textContent = eta(sent, total, startedAt);
}

const MAX_FILE = 2 * 1024 ** 3;
async function send(file) {
  if (busy) return;
  if (file.size > MAX_FILE) {
    $('#drop').querySelector('.muted').innerHTML = `<span style="color:var(--bad)">${esc(file.name)} is ${bytes(file.size)}. Files up to 2 GB for now.</span>`;
    return;
  }
  busy = true;
  current = null;
  $('#drop').hidden = true;
  $('#job').hidden = false;
  $('#share').hidden = true;
  $('#job-err').hidden = true;
  $('#job-retry').hidden = true;
  $('#job-ext').textContent = ext(file.name);
  $('#job-name').textContent = file.name;
  $('#job-size').textContent = bytes(file.size);
  $('#job-rate').textContent = '';
  progress(0, 1, Date.now());

  const fp = `${file.name}|${file.size}|${file.lastModified}`;
  const resumes = store.get(K_RESUME, {});
  const startedAt = Date.now();
  try {
    const up = await uploadFile({
      base: API, token: session.token, source: fileSource(file), name: file.name, type: typeOf(file),
      resume: resumes[fp],
      onStart: (s) => store.set(K_RESUME, { ...store.get(K_RESUME, {}), [fp]: s }),
      onProgress: ({ sent, total }) => progress(sent, total, startedAt),
    }).catch(guard);
    const r = store.get(K_RESUME, {});
    delete r[fp];
    store.set(K_RESUME, r);
    opened.set(up.hash, up.key);
    $('#job-step').textContent = 'Keeping the key in your wallet, so your other devices can open this file. Approve in bWalletX…';
    try {
      await within(90_000, (async () => saveKeyWrap({ base: API, token: session.token, wallet: await getWallet(false), hash: up.hash, key: up.key }))());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) guard(e);
      store.set(K_KEYS, { ...legacy(), [up.hash]: up.key }); // not in the wallet: keep it here, as v1 did, and move it next visit
    }
    $('#job-step').textContent = 'Making your link…';
    const link = await A().post('/v1/links', { hash: up.hash, ttl: ttlValue() }).catch(guard);
    current = { hash: up.hash, key: up.key, linkId: link.id };
    $('#url').value = shareUrl(SITE, link.id, up.key);
    ttlNote(link.expiresAt);
    $('#job-step').innerHTML = '<span class="ok">Uploaded and encrypted.</span>';
    $('#job-rate').textContent = `${bytes(file.size)} in ${Math.max(1, Math.round((Date.now() - startedAt) / 1000))} s`;
    $('#share').hidden = false;
    $('#url').focus();
    $('#url').select();
    loadFiles();
  } catch (e) {
    $('#job-err').textContent = (e && e.message) || 'The upload stopped.';
    $('#job-err').hidden = false;
    $('#job-step').textContent = 'Stopped';
    if (session) {
      $('#job-retry').hidden = false;
      $('#retry').onclick = () => send(file);
    }
  } finally {
    busy = false;
  }
}

async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); } catch { $('#url').select(); document.execCommand?.('copy'); }
  const t = btn.textContent;
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = t; }, 1600);
}

// Changing how long the link works makes a new link and switches the old one off.
async function relink() {
  if (!current) return;
  const old = current.linkId;
  try {
    const link = await A().post('/v1/links', { hash: current.hash, ttl: ttlValue() }).catch(guard);
    await A().del(`/v1/links/${old}`).catch(() => {});
    current.linkId = link.id;
    $('#url').value = shareUrl(SITE, link.id, current.key);
    ttlNote(link.expiresAt);
    loadFiles();
  } catch (e) { $('#job-err').textContent = e.message; $('#job-err').hidden = false; }
}

function reset() {
  current = null;
  $('#job').hidden = true;
  $('#drop').hidden = false;
  $('#pick').value = '';
}

// ---------- your files

async function nameOf(f) {
  if (names.has(f.hash)) return names.get(f.hash);
  const key = keyOf(f.hash);
  if (!key || !f.meta) return null;
  try {
    const { meta } = await openMeta(await importKey(unb64u(key)), f.meta);
    names.set(f.hash, meta);
    return meta;
  } catch { return null; }
}

async function loadFiles() {
  try { ({ files, usage } = await A().get('/v1/files').catch(guard)); } catch { return; }
  await draw();
  unlock(false);
}

async function draw() {
  if (!files) return;
  $('#usage-t').textContent = `${bytes(usage.bytes)} of ${bytes(usage.quota)} used`;
  $('#usage-bar').style.width = Math.min(100, (usage.bytes / usage.quota) * 100) + '%';
  const ul = $('#files');
  const locked = files.filter((f) => !keyOf(f.hash) && f.keyWrap).length;
  $('#unlock-row').hidden = !locked || !!unlocking;
  if (!files.length) { ul.innerHTML = '<li class="empty" style="display:block">Nothing here yet. Files you send show up here.</li>'; return; }
  const metas = await Promise.all(files.map(nameOf));
  const t = Date.now();
  ul.innerHTML = files.map((f, i) => {
    const m = metas[i];
    const live = f.links.filter((l) => !l.revokedAt && !l.reported && (!l.expiresAt || l.expiresAt > t));
    const downloads = f.links.reduce((n, l) => n + l.downloads, 0);
    const reported = f.links.filter((l) => l.reported).length;
    const lk = live.map((l) => `<span>Link from ${day(l.createdAt)} · until ${day(l.expiresAt)} · ${m ? `<button class="link-btn" data-act="copy" data-link="${l.id}" data-hash="${f.hash}">Copy</button> ` : ''}<button class="link-btn danger" data-act="off" data-link="${l.id}">Switch off</button></span>`).join('');
    return `<li>
      <span class="ext${m ? '' : ' lock'}">${m ? esc(ext(m.name)) : LOCK}</span>
      <b>${m ? esc(m.name) : 'Locked file'}</b>
      <span class="acts">
        ${m ? `<button class="btn btn-ghost btn-sm" data-act="new" data-hash="${f.hash}">New link</button>` : ''}
        <button class="link-btn danger" data-act="del" data-hash="${f.hash}">Delete</button>
      </span>
      <small>${bytes(m ? m.size : f.size)} · ${day(f.createdAt)} · ${downloads} download${downloads === 1 ? '' : 's'}${live.length ? '' : ' · no live link'}</small>
      ${lk || reported ? `<span class="lk">${lk}${reported ? `<span style="color:var(--bad)">${reported === 1 ? 'A link was' : reported + ' links were'} reported and switched off</span>` : ''}</span>` : ''}
    </li>`;
  }).join('');
}

// Open the keys your wallet wrapped, and move any v1 keys from this browser into the wallet (once per tab).
// Quietly on load; interactive (the Unlock button) may pair the phone by QR.
function unlock(interactive) {
  if (unlocking || !files || !session) return unlocking;
  const shut = files.filter((f) => !keyOf(f.hash) && f.keyWrap);
  const move = moved ? [] : files.filter((f) => !f.keyWrap && legacy()[f.hash]);
  if (!shut.length && !move.length) return null;
  const note = $('#keys-note'), err = $('#unlock-err');
  err.hidden = true;
  unlocking = (async () => {
    let w;
    try { w = await getWallet(interactive); } catch (e) {
      if (interactive && !(e && e.name === 'AbortError')) { err.textContent = (e && e.message) || 'That didn’t work. Try again.'; err.hidden = false; }
      return;
    }
    $('#unlock-row').hidden = true;
    if (shut.length) note.textContent = 'Opening your files with bWalletX. Approve if it asks.';
    for (const f of shut) {
      try { opened.set(f.hash, await unwrapKey(w, f.hash, f.keyWrap)); } catch {}
    }
    if (move.length) {
      moved = true;
      note.textContent = `Moving ${move.length === 1 ? 'a file key' : move.length + ' file keys'} from this browser into your wallet, so your other devices can open ${move.length === 1 ? 'it' : 'them'}. Approve in bWalletX.`;
      for (const f of move) {
        const key = legacy()[f.hash];
        try {
          await saveKeyWrap({ base: API, token: session.token, wallet: w, hash: f.hash, key });
          opened.set(f.hash, key);
          dropLegacy(f.hash);
        } catch (e) { if (e instanceof ApiError && e.status === 401) return signOut(false, true); break; } // declined: try next visit
      }
    }
  })().finally(() => {
    unlocking = null;
    note.textContent = KEYS_NOTE;
    draw();
  });
  return unlocking;
}
const KEYS_NOTE = 'Each file’s key is kept in your wallet, so you can open your files on any device you sign in on. bDriveX only ever sees scrambled bytes.';

async function onFilesClick(e) {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const { act, hash, link } = b.dataset;
  try {
    if (act === 'copy') return copy(shareUrl(SITE, link, keyOf(hash)), b);
    if (act === 'new') {
      const l = await A().post('/v1/links', { hash }).catch(guard); // 30 days
      await copy(shareUrl(SITE, l.id, keyOf(hash)), b);
    }
    if (act === 'off') await A().del(`/v1/links/${link}`).catch(guard);
    if (act === 'del') {
      if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Delete for good?'; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Delete'; }, 4000); return; }
      await A().del(`/v1/files/${hash}`).catch(guard);
      opened.delete(hash); names.delete(hash); dropLegacy(hash);
      if (current?.hash === hash) reset();
    }
    loadFiles();
  } catch (err) { b.textContent = err.message.slice(0, 60); }
}

// ---------- wire up

$('#signin').onclick = signIn;
$('#signout-all').onclick = () => signOut(true);
$('#pick').onchange = (e) => { const f = e.target.files[0]; if (f) send(f); };
const drop = $('#drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) send(f); });
$('#copy').onclick = (e) => copy($('#url').value, e.currentTarget);
$('#ttl').onchange = relink;
$('#another').onclick = reset;
$('#files').addEventListener('click', onFilesClick);
$('#unlock').onclick = () => unlock(true);
addEventListener('beforeunload', (e) => { if (busy) { e.preventDefault(); e.returnValue = ''; } });
show();
