// /send: sign in with bWalletX, seal and upload a file, hand back a link; list, re-link and delete your files.
import { API, SITE } from './config.js';
import { ApiError, api, fileSource, shareUrl, uploadFile } from './bdx-client.js';
import { importKey, openMeta, unb64u } from './bdx-crypto.js';
import { $, bytes, day, esc, eta, ext, store, typeOf } from './ui.js';

const C = window.bWalletXConnect;
const K_SESSION = 'bdx:session', K_KEYS = 'bdx:keys', K_RESUME = 'bdx:resume';
let session = store.get(K_SESSION, null);
if (session && session.expiresAt < Date.now() + 60_000) session = null;
let handle = null, busy = false, current = null; // current = { hash, key, linkId }

const LOCK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-label="Locked"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const keys = () => store.get(K_KEYS, {});
const saveKey = (hash, key) => store.set(K_KEYS, { ...keys(), [hash]: key });
const A = () => api(API, session?.token);

// ---------- sign in

function drawWho() {
  const who = $('#who');
  if (!session) { who.innerHTML = ''; return; }
  const k = session.identityKey;
  who.innerHTML = `<span class="chip" title="${esc(k)}"><i></i>${esc(handle || k.slice(0, 6) + '…' + k.slice(-4))}</span><button class="link-btn" type="button" id="signout">Sign out</button>`;
  $('#signout').onclick = signOut;
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
    store.set(K_SESSION, v);
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

function signOut() {
  session = null; handle = null;
  store.set(K_SESSION, null);
  try { C?.clearPairing?.(); } catch {}
  show();
}

// Any 401 means the session ended: back to the sign-in panel.
const guard = (e) => { if (e instanceof ApiError && e.status === 401) signOut(); throw e; };

// ---------- send

const ttlValue = () => ($('#ttl').value ? Number($('#ttl').value) : null);
const ttlNote = (expiresAt) => { $('#ttl-note').textContent = expiresAt ? `until ${day(expiresAt)}` : 'until you switch it off'; };

function progress(sent, total, startedAt) {
  const pc = total ? Math.floor((sent / total) * 100) : 100;
  $('#job-bar span').style.width = pc + '%';
  $('#job-bar').setAttribute('aria-valuenow', String(pc));
  $('#job-step').textContent = `Encrypting and uploading · ${pc}%`;
  $('#job-rate').textContent = eta(sent, total, startedAt);
}

async function send(file) {
  if (busy) return;
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
    saveKey(up.hash, up.key);
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
  const key = keys()[f.hash];
  if (!key || !f.meta) return null;
  try { return (await openMeta(await importKey(unb64u(key)), f.meta)).meta; } catch { return null; }
}

async function loadFiles() {
  let data;
  try { data = await A().get('/v1/files').catch(guard); } catch { return; }
  const { files, usage } = data;
  $('#usage-t').textContent = `${bytes(usage.bytes)} of ${bytes(usage.quota)} used`;
  $('#usage-bar').style.width = Math.min(100, (usage.bytes / usage.quota) * 100) + '%';
  const ul = $('#files');
  if (!files.length) { ul.innerHTML = '<li class="empty" style="display:block">Nothing here yet. Files you send show up here.</li>'; return; }
  const metas = await Promise.all(files.map(nameOf));
  const t = Date.now();
  ul.innerHTML = files.map((f, i) => {
    const m = metas[i];
    const live = f.links.filter((l) => !l.revokedAt && (!l.expiresAt || l.expiresAt > t));
    const downloads = f.links.reduce((n, l) => n + l.downloads, 0);
    const lk = live.map((l) => `<span>Link from ${day(l.createdAt)} · ${l.expiresAt ? 'until ' + day(l.expiresAt) : 'no limit'} · ${m ? `<button class="link-btn" data-act="copy" data-link="${l.id}" data-hash="${f.hash}">Copy</button> ` : ''}<button class="link-btn danger" data-act="off" data-link="${l.id}">Switch off</button></span>`).join('');
    return `<li>
      <span class="ext${m ? '' : ' lock'}">${m ? esc(ext(m.name)) : LOCK}</span>
      <b>${m ? esc(m.name) : 'Locked file'}</b>
      <span class="acts">
        ${m ? `<button class="btn btn-ghost btn-sm" data-act="new" data-hash="${f.hash}">New link</button>` : ''}
        <button class="link-btn danger" data-act="del" data-hash="${f.hash}">Delete</button>
      </span>
      <small>${bytes(m ? m.size : f.size)} · ${day(f.createdAt)} · ${downloads} download${downloads === 1 ? '' : 's'}${live.length ? '' : ' · no live link'}</small>
      ${lk ? `<span class="lk">${lk}</span>` : ''}
    </li>`;
  }).join('');
}

async function onFilesClick(e) {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const { act, hash, link } = b.dataset;
  try {
    if (act === 'copy') return copy(shareUrl(SITE, link, keys()[hash]), b);
    if (act === 'new') {
      const l = await A().post('/v1/links', { hash, ttl: 604800 }).catch(guard);
      await copy(shareUrl(SITE, l.id, keys()[hash]), b);
    }
    if (act === 'off') await A().del(`/v1/links/${link}`).catch(guard);
    if (act === 'del') {
      if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Delete for good?'; setTimeout(() => { b.dataset.sure = ''; b.textContent = 'Delete'; }, 4000); return; }
      await A().del(`/v1/files/${hash}`).catch(guard);
      const k = keys(); delete k[hash]; store.set(K_KEYS, k);
      if (current?.hash === hash) reset();
    }
    loadFiles();
  } catch (err) { b.textContent = err.message.slice(0, 60); }
}

// ---------- wire up

$('#signin').onclick = signIn;
$('#pick').onchange = (e) => { const f = e.target.files[0]; if (f) send(f); };
const drop = $('#drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) send(f); });
$('#copy').onclick = (e) => copy($('#url').value, e.currentTarget);
$('#ttl').onchange = relink;
$('#another').onclick = reset;
$('#files').addEventListener('click', onFilesClick);
addEventListener('beforeunload', (e) => { if (busy) { e.preventDefault(); e.returnValue = ''; } });
show();
