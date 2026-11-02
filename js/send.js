// /send: sign in with bWalletX, seal and upload a file, say who it's for, hand back a link; list, re-link and delete
// your files. v1.2: a link is for one person by default (their wallet unwraps the key); "anyone with the link" is a
// choice the sender makes. v1.2.1: for one person, the sender's wallet can also tell them in bMail (js/bmail.js).
import { API, SITE } from './config.js';
import { askAlongside, deliver, loadClient, noticeText, sealNotice } from './bmail.js';
import { ApiError, api, boundUrl, fileSource, makeLink, saveKeyWrap, shareUrl, unwrapKey, uploadFile } from './bdx-client.js';
import { importKey, openMeta, unb64u } from './bdx-crypto.js';
import { resolveRecipient, shortKey } from './paymail.js';
import { $, bytes, day, esc, eta, ext, store, tabStore, typeOf } from './ui.js';

const C = window.bWalletXConnect;
const K_SESSION = 'bdx:session', K_KEYS = 'bdx:keys', K_RESUME = 'bdx:resume';
store.set(K_SESSION, null); // v1 kept it in localStorage; clear any left behind
let session = tabStore.get(K_SESSION, null);
if (session && session.expiresAt < Date.now() + 60_000) session = null;
let handle = null, busy = false, current = null; // current = { hash, key, name, size, linkId }
let recipient = null, finding = null; // recipient = { label, paymail, identityKey } once looked up
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

const DAY = 86400, MAX_TTL = 30 * DAY;
const audience = () => document.querySelector('input[name=aud]:checked').value; // 'one' | 'any'
const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// Seconds the link should work: 1, 7 or 30 days, or to the end of a chosen day (at most 30 days; the server enforces it).
function ttlValue() {
  const v = $('#ttl').value;
  if (v !== 'date') return Number(v);
  const d = $('#ttl-date').value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const [y, m, dd] = d.split('-').map(Number);
  const end = new Date(y, m - 1, dd, 23, 59, 59).getTime();
  return Math.max(60, Math.min(MAX_TTL, Math.floor((end - Date.now()) / 1000)));
}
function onTtl() {
  const date = $('#ttl').value === 'date', el = $('#ttl-date');
  el.hidden = !date;
  if (date) {
    const t = new Date();
    el.min = isoDay(t);
    el.max = isoDay(new Date(t.getTime() + MAX_TTL * 1000));
    if (!el.value) el.value = isoDay(new Date(t.getTime() + 14 * DAY * 1000));
  }
  canMake();
}

function progress(sent, total, startedAt) {
  const pc = total ? Math.floor((sent / total) * 100) : 100;
  $('#job-bar span').style.width = pc + '%';
  $('#job-bar').setAttribute('aria-valuenow', String(pc));
  $('#job-step').textContent = sent ? `Encrypting and uploading · ${pc}% · ${bytes(sent)} of ${bytes(total)}` : 'Encrypting and uploading · starting…';
  $('#job-rate').textContent = eta(sent, total, startedAt);
}

// ---- who it's for: look the person up as they type (in this browser, straight from their paymail service)
function drawTo(msg, bad) {
  const el = $('#to-who');
  el.classList.toggle('bad', !!bad);
  if (msg != null) { el.textContent = msg; return; }
  if (!recipient) { el.textContent = ''; return; }
  const you = recipient.identityKey === session?.identityKey ? ' (that’s you)' : '';
  el.innerHTML = `Sending to <b>${esc(recipient.label)}</b>${you} · <span class="k" title="${esc(recipient.identityKey)}">${esc(shortKey(recipient.identityKey))}</span>`;
}
let findTimer = null;
function findSoon() {
  clearTimeout(findTimer);
  recipient = null;
  drawTo('');
  canMake();
  if ($('#to').value.trim().length >= 2) findTimer = setTimeout(find, 600);
}
async function find() {
  clearTimeout(findTimer);
  const typed = $('#to').value.trim();
  if (!typed) { drawTo('Type their $handle or paymail.', true); return null; }
  if (recipient && finding === typed) return recipient;
  finding = typed;
  drawTo('Looking them up…');
  try {
    const r = await resolveRecipient(typed);
    if ($('#to').value.trim() !== typed) return null; // they kept typing
    recipient = r;
    drawTo();
    return r;
  } catch (e) {
    if ($('#to').value.trim() === typed) { recipient = null; drawTo(e.message, true); }
    return null;
  } finally { canMake(); }
}

function canMake() {
  const one = audience() === 'one';
  $('#to-row').hidden = !one;
  $('#to-who').hidden = !one;
  const ready = !!current?.hash && !busy;
  const ok = ready && (!one || !!recipient) && ttlValue() != null;
  $('#make').disabled = !ok;
  $('#make').textContent = one ? (recipient ? `Send to ${recipient.label}` : 'Make link') : 'Make a link anyone can open';
  $('#tell-row').hidden = !(one && recipient);
  if (recipient) $('#tell-who').textContent = recipient.label;
  $('#make-note').textContent = !ready && !current?.hash ? 'You can choose while it uploads.' : '';
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
  $('#tell').checked = true;
  noticeRun++;
  mailLine('');
  $('#drop').hidden = true;
  $('#job').hidden = false;
  $('#share').hidden = true;
  $('#linkform').hidden = false;
  $('#link-err').hidden = true;
  $('#job-err').hidden = true;
  $('#job-retry').hidden = true;
  $('#job-bar').hidden = false;
  $('#job-ext').textContent = ext(file.name);
  $('#job-name').textContent = file.name;
  $('#job-size').textContent = bytes(file.size);
  $('#job-rate').textContent = '';
  progress(0, 1, Date.now());
  canMake();

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
    current = { hash: up.hash, key: up.key, name: file.name, size: file.size, linkId: null };
    $('#job-step').innerHTML = '<span class="ok">Uploaded and encrypted.</span> Now say who it’s for.';
    $('#job-rate').textContent = `${bytes(file.size)} in ${Math.max(1, Math.round((Date.now() - startedAt) / 1000))} s`;
    loadFiles();
  } catch (e) {
    $('#linkform').hidden = true;
    $('#job-err').textContent = (e && e.message) || 'The upload stopped.';
    $('#job-err').hidden = false;
    $('#job-step').textContent = 'Stopped';
    if (session) {
      $('#job-retry').hidden = false;
      $('#retry').onclick = () => send(file);
    }
  } finally {
    busy = false;
    canMake();
  }
}

// Make the link the sender chose. For one person, their wallet wraps the key for that person's identity key; for
// anyone, the key goes in the link. Changing who or how long makes a new link and switches the old one off.
async function make(e) {
  e?.preventDefault();
  if (!current?.hash || busy) return;
  const one = audience() === 'one';
  const err = $('#link-err');
  err.hidden = true;
  const ttl = ttlValue();
  if (ttl == null) { err.textContent = 'Choose the date the link stops working.'; err.hidden = false; return; }
  const to = one ? await find() : null;
  if (one && !to) return;
  busy = true;
  const b = $('#make');
  b.disabled = true;
  const tell = one && $('#tell').checked;
  noticeRun++;
  mailLine('');
  let sealing = null; // the bMail notice, sealed by the sender's wallet while it wraps the key
  try {
    let w = null;
    if (one) {
      b.textContent = 'Approve in bWalletX…';
      w = await getWallet(true);
    } else b.textContent = 'Making your link…';
    const file = { name: current.name, size: current.size };
    // The letter's seal and the relay sign-in are asked for at the same moment as the key wrap, so bWalletX can put
    // them on the same sheet. They can fail on their own (the person unticks them): the link never depends on them.
    const alongside = tell ? (l) => {
      const words = noticeText({ sender: handle || shortKey(session.identityKey), name: file.name, size: bytes(file.size), url: l.url, expiresAt: l.expiresAt });
      sealing = sealNotice(w, { from: session.identityKey, to: to.identityKey, ...words });
      sealing.catch(() => {});
      // A moment later, still inside the wallet's merge window (bWalletX: 60 ms), so the sheet leads with the key
      // wrap and its title names "bdrivex share", not the relay's sign-in keys.
      setTimeout(() => askAlongside(w), 15);
      loadClient().catch(() => {});
    } : null;
    const link = await within(120_000, makeLink({
      base: API, token: session.token, site: SITE, hash: current.hash, key: current.key, ttl,
      recipient: one ? to.identityKey : null, recipientLabel: one ? to.label : null, wallet: w, alongside,
    })).catch(guard);
    if (current.linkId) await A().del(`/v1/links/${current.linkId}`).catch(() => {});
    current.linkId = link.id;
    $('#url').value = link.url;
    $('#aud-line').innerHTML = `${one ? `Only <b>${esc(to.label)}</b> can open this` : '<b>Anyone who has this link</b> can open it'} · Link works until ${esc(day(link.expiresAt))}`;
    $('#seal-t').innerHTML = one
      ? `There’s no key in this link. ${esc(to.label)} signs in with bWalletX and their wallet unlocks the file. Anyone else who gets the link sees only that it was sent to someone else. bDriveX only holds scrambled bytes.`
      : 'The key is the part after <b>#</b> in the link. Browsers never send it to a server, so bDriveX only holds scrambled bytes. Anyone with the whole link can download the file.';
    $('#job-step').innerHTML = `<span class="ok">Your link is ready.</span> ${one ? `Send it to ${esc(to.label)} any way you like.` : 'Anyone you give it to can open the file.'}`;
    $('#linkform').hidden = true;
    $('#share').hidden = false;
    $('#url').focus();
    $('#url').select();
    loadFiles();
    if (sealing) sendNotice(sealing, w, to, link.url);
  } catch (e2) {
    err.textContent = e2 && e2.name === 'AbortError' ? 'You closed bWalletX before it finished. Try again.' : (e2 && e2.message) || 'That didn’t work. Try again.';
    err.hidden = false;
  } finally {
    busy = false;
    canMake();
  }
}

// ---- the bMail notice. It never blocks, delays or undoes the link: if it fails, the sender passes the link on.
let noticeRun = 0; // a newer link (or "Change who") makes an older notice's result stale
function mailLine(html, bad) {
  const el = $('#mail-line');
  el.hidden = !html;
  el.classList.toggle('bad', !!bad);
  el.innerHTML = html || '';
}
async function sendNotice(sealing, w, to, url) {
  const run = noticeRun;
  mailLine(`Telling <b>${esc(to.label)}</b> in bMail… Approve in bWalletX if it asks.`);
  try {
    const env = await within(120_000, sealing);
    await within(60_000, deliver(w, env));
    if (run === noticeRun) mailLine(`<span class="ok">bMail sent.</span> ${esc(to.label)} will find the link in bMail in their bWalletX.`);
  } catch (e) {
    console.warn('[bDriveX] bMail notice not sent:', (e && e.message) || e);
    if (run !== noticeRun) return;
    mailLine('Couldn’t send the bMail. Send them the link yourself. <button class="link-btn" type="button" id="mail-copy">Copy link</button>', true);
    $('#mail-copy').onclick = (ev) => copy(url, ev.currentTarget);
  }
}

async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); } catch { $('#url').select(); document.execCommand?.('copy'); }
  const t = btn.textContent;
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = t; }, 1600);
}

function change() {
  noticeRun++;
  mailLine('');
  $('#share').hidden = true;
  $('#linkform').hidden = false;
  canMake();
}

// New link for a file already in the list: the same who-and-how-long step as a fresh upload.
function relinkFile(hash) {
  const m = names.get(hash), key = keyOf(hash);
  if (!m || !key || busy) return;
  current = { hash, key, name: m.name, size: m.size, linkId: null };
  $('#tell').checked = true;
  noticeRun++;
  mailLine('');
  $('#drop').hidden = true;
  $('#job').hidden = false;
  $('#job-ext').textContent = ext(m.name);
  $('#job-name').textContent = m.name;
  $('#job-size').textContent = bytes(m.size);
  $('#job-bar').hidden = true;
  $('#job-step').textContent = 'A new link for this file. Say who it’s for.';
  $('#job-rate').textContent = '';
  $('#job-err').hidden = true;
  $('#job-retry').hidden = true;
  $('#share').hidden = true;
  $('#link-err').hidden = true;
  $('#linkform').hidden = false;
  canMake();
  $('#job').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function reset() {
  noticeRun++;
  mailLine('');
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
    const lk = live.map((l) => {
      const who = l.bound ? `Only ${esc(l.recipientLabel || shortKey(l.recipient))}` : 'Anyone with the link';
      const canCopy = l.bound ? l.ready : !!m; // a link for one person has no key in it, so it can always be copied
      return `<span><span class="aud-t">${who}</span> · until ${day(l.expiresAt)}${l.bound && !l.ready ? ' · not finished' : ''} · ${canCopy ? `<button class="link-btn" data-act="copy" data-link="${l.id}" data-hash="${f.hash}"${l.bound ? ' data-bound="1"' : ''}>Copy</button> ` : ''}<button class="link-btn danger" data-act="off" data-link="${l.id}">Switch off</button></span>`;
    }).join('');
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
  const { act, hash, link, bound } = b.dataset;
  try {
    if (act === 'copy') return copy(bound ? boundUrl(SITE, link) : shareUrl(SITE, link, keyOf(hash)), b);
    if (act === 'new') return relinkFile(hash);
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
$('#ttl').onchange = onTtl;
$('#ttl-date').onchange = canMake;
$('#linkform').addEventListener('submit', make);
document.querySelectorAll('input[name=aud]').forEach((r) => { r.onchange = () => { canMake(); if (audience() === 'one') $('#to').focus(); }; });
$('#to').addEventListener('input', findSoon);
$('#to').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } });
$('#to-find').onclick = find;
$('#change').onclick = change;
$('#another').onclick = reset;
$('#files').addEventListener('click', onFilesClick);
$('#unlock').onclick = () => unlock(true);
addEventListener('beforeunload', (e) => { if (busy) { e.preventDefault(); e.returnValue = ''; } });
show();
