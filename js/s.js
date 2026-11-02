// /s/:id: open a share link, download and decrypt in this browser.
//   Anyone-links (/s/:id#k=key): no wallet, nothing sent but the link id. The key stays in the #fragment.
//   Links sent to one person (v1.2, no #k): the recipient signs in with bWalletX, bDriveX hands their session the key
//   wrapped for them, their wallet unwraps it (counterparty = the sender), and the file decrypts here as before.
//   Anyone else learns only that the file was sent to someone else.
import { API } from './config.js';
import { ApiError, api, downloadLink, linkInfo, openBoundLink, openLink, parseShare } from './bdx-client.js';
import { shortKey } from './paymail.js';
import { $, bytes, day, eta, ext, tabStore } from './ui.js';

const id = location.pathname.split('/')[2] || new URLSearchParams(location.search).get('id') || '';
const key = parseShare(location.hash);
const K_SESSION = 'bdx:open-session'; // this page's own sign-in (it may be a recipient-only session), tab only
let session = tabStore.get(K_SESSION, null);
if (session && session.expiresAt < Date.now() + 60_000) session = null;
let link = null, running = false, wallet = null, bound = null;

function bad(h, p, acts = false) {
  $('#loading').hidden = true;
  $('#file').hidden = true;
  $('#bound').hidden = true;
  $('#bad').hidden = false;
  $('#bad-h').textContent = h;
  $('#bad-p').textContent = p;
  $('#bad-acts').hidden = !acts;
  $('#report').hidden = true;
  document.title = `${h} · bDriveX`;
}

const linkGone = (e) => {
  if (e.status === 410) return bad('This link has expired', 'Ask the sender for a new one.');
  if (e.status === 404 && /report/.test(e.message)) return bad('This link was switched off', 'Someone reported it, so it’s switched off while we review it.');
  if (e.status === 404) return bad('This link was switched off', 'The sender switched it off or deleted the file. Ask them for a new one.');
  return bad('This link doesn’t work', e.message);
};

async function load() {
  if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return bad('This link doesn’t work', 'The address looks cut short. Ask the sender to send it again.');
  let info;
  try {
    info = await linkInfo({ base: API, id, token: session?.token });
  } catch (e) { return linkGone(e); }
  if (info.bound) return openBound(info);
  if (!key) return bad('This link is missing its key', 'The part after # was lost, so the file can’t be opened. Copy the whole link, or ask the sender for it again.');
  try {
    link = await openLink({ base: API, id, key });
  } catch (e) { return linkGone(e); }
  showFile();
}

function showFile() {
  const m = link.meta;
  $('#loading').hidden = true;
  $('#bound').hidden = true;
  $('#bad').hidden = true;
  $('#file').hidden = false;
  $('#f-ext').textContent = ext(m.name);
  $('#f-name').textContent = m.name;
  $('#f-size').textContent = bytes(m.size);
  $('#f-sent').textContent = day(link.createdAt);
  $('#f-until').textContent = `until ${day(link.expiresAt)}`;
  $('#report').hidden = false;
  document.title = `${m.name} · bDriveX`;
}

// ---------- links sent to one person

const SEAL_BOUND = 'Encrypted end to end. Only the wallet this file was sent to can unlock it, and your browser decrypts it as it downloads. bDriveX never sees the key or the file.';
const SOMEONE_ELSE = 'This file was sent to someone else.';

async function senderName(k) {
  try {
    const r = await fetch(`https://pay.bwallet.space/api/paymail/lookup?key=${encodeURIComponent(k)}`, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    const j = r.ok ? await r.json() : null;
    if (j && typeof j.paymail === 'string' && /^[a-z0-9._+-]{1,64}@bwalletx\.com$/i.test(j.paymail)) return '$' + j.paymail.split('@')[0];
    if (j && typeof j.paymail === 'string' && /^[a-z0-9._+-]{1,64}@[a-z0-9.-]{1,190}$/i.test(j.paymail)) return j.paymail;
  } catch {}
  return null;
}

function openBound(info) {
  bound = info;
  $('#seal-t').textContent = SEAL_BOUND;
  // A key in the fragment means nothing here: drop it from the address bar.
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  if (info.forYou) return openForMe(false);
  if (session) return someoneElse();
  drawBound('Sign in with bWalletX to open it. Only the wallet it was sent to can.', 'Sign in with bWalletX to open', signIn);
}

function drawBound(p, btnText, onClick) {
  $('#loading').hidden = true;
  $('#bad').hidden = true;
  $('#file').hidden = true;
  $('#bound').hidden = false;
  $('#b-p').textContent = p;
  $('#b-size').textContent = bytes(bound.size);
  $('#b-until').textContent = `until ${day(bound.expiresAt)}`;
  $('#b-signin').textContent = btnText;
  $('#b-signin').onclick = onClick;
  $('#b-h').textContent = 'A file sent to you';
  document.title = 'A file sent to you · bDriveX';
  const from = bound.from;
  if (typeof from === 'string' && /^0[23][0-9a-f]{64}$/.test(from)) {
    $('#b-h').textContent = `Sent to you by ${shortKey(from)}`;
    senderName(from).then((n) => { if (n && bound?.from === from && !$('#bound').hidden) $('#b-h').textContent = `Sent to you by ${n}`; });
  }
}

// Nothing about who it was for: just that it wasn't this wallet.
function someoneElse() {
  bad(SOMEONE_ELSE, session
    ? 'You’re signed in with a different wallet. If it was meant for you, sign in with the wallet it was sent to.'
    : 'If it was meant for you, sign in with the wallet it was sent to.', true);
  $('#b-out').hidden = !session;
}

function loadConnect() {
  if (window.bWalletXConnect) return Promise.resolve(window.bWalletXConnect);
  const m = document.querySelector('meta[name=bdx-connect]');
  return new Promise((ok, no) => {
    const sc = document.createElement('script');
    sc.src = m.content;
    sc.integrity = m.dataset.integrity;
    sc.crossOrigin = 'anonymous';
    sc.onload = () => (window.bWalletXConnect ? ok(window.bWalletXConnect) : no(new Error('The bWalletX sign-in script didn’t load. Reload the page.')));
    sc.onerror = () => no(new Error('The bWalletX sign-in script didn’t load. Reload the page.'));
    document.head.appendChild(sc);
  });
}

const STATUS = { finding: 'Opening your wallet…', opening: 'Approve in bWalletX…', signing: 'Approve in bWalletX…', pairing: 'Scan the QR with bWalletX…' };
async function signIn() {
  const b = $('#b-signin'), err = $('#b-err');
  err.hidden = true;
  b.disabled = true;
  let modal = null;
  try {
    const C = await loadConnect();
    modal = C.pairingModal({ title: 'Open a file sent to you' });
    const a = api(API);
    const r = await C.signInWithBwalletX({
      pairing: modal,
      onStatus: (s) => { if (STATUS[s]) b.textContent = STATUS[s]; },
      challenge: (identityKey) => a.post('/v1/auth/challenge', { identityKey }),
    });
    let v;
    try {
      v = await a.post('/v1/auth/verify', { identityKey: r.identityKey, nonce: r.nonce, signature: r.signature });
    } catch (e) {
      // Not invited and nothing was sent to this wallet: so this link isn't for it.
      if (e instanceof ApiError && e.status === 403) { try { r.wallet?.close?.(); } catch {} return someoneElse(); }
      throw e;
    }
    session = v;
    wallet = r.wallet;
    tabStore.set(K_SESSION, v);
    const info = await linkInfo({ base: API, id, token: session.token });
    bound = info;
    if (!info.forYou) return someoneElse();
    await openForMe(true);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 410)) return linkGone(e);
    if (e && e.code === 'NOT_FOUND') err.innerHTML = 'No bWalletX found in this browser. <a href="https://bwalletx.com/get">Get bWalletX</a>, or sign in again to pair your phone.';
    else if (!(e && e.name === 'AbortError')) err.textContent = (e && e.message) || 'That didn’t work. Try again.';
    err.hidden = !err.textContent;
  } finally {
    try { modal && modal.close(); } catch {}
    b.disabled = false;
    if (/Approve|Opening|Scan/.test(b.textContent)) b.textContent = 'Sign in with bWalletX to open';
  }
}

// The wallet that signed in. After a reload only the session is left: find it again, and check it's the same one.
async function getWallet(interactive) {
  if (wallet) return wallet;
  const C = await loadConnect();
  let modal = null;
  try {
    if (interactive) modal = C.pairingModal({ title: 'Open a file sent to you' });
    const r = await C.connectBwalletX(modal ? { pairing: modal } : {});
    const { publicKey } = await r.wallet.getPublicKey({ identityKey: true });
    if (publicKey !== session?.identityKey) throw new Error('That’s a different wallet from the one you signed in with.');
    return (wallet = r.wallet);
  } finally {
    try { modal && modal.close(); } catch {}
  }
}

async function openForMe(interactive) {
  let w;
  try { w = await getWallet(interactive); } catch (e) {
    drawBound('Open bWalletX to unlock it. Only the wallet it was sent to can.', 'Open with bWalletX', () => openForMe(true));
    if (interactive && !(e && e.name === 'AbortError')) { $('#b-err').textContent = (e && e.message) || 'That didn’t work. Try again.'; $('#b-err').hidden = false; }
    return;
  }
  drawBound('Unlocking it with bWalletX. Approve if it asks.', 'Unlocking…', () => {});
  $('#b-signin').disabled = true;
  try {
    link = await openBoundLink({ base: API, id, token: session.token, wallet: w });
  } catch (e) {
    $('#b-signin').disabled = false;
    if (e instanceof ApiError && e.status === 403) return someoneElse();
    if (e instanceof ApiError && e.status === 401) { signOut(true); return drawBound('Your sign-in ended. Sign in again to open it.', 'Sign in with bWalletX to open', signIn); }
    if (e instanceof ApiError) return linkGone(e);
    return bad('This file couldn’t be opened', `Your wallet couldn’t unlock it (${(e && e.message) || 'unknown error'}). Ask the sender to send it again.`);
  }
  $('#b-signin').disabled = false;
  showFile();
}

function signOut(ended) {
  if (session && !ended) api(API, session.token).post('/v1/auth/signout', {}).catch(() => {});
  session = null;
  try { wallet?.close?.(); } catch {}
  wallet = null;
  tabStore.set(K_SESSION, null);
  try { window.bWalletXConnect?.clearPairing?.(); } catch {}
}

// ---------- download

// Up to 1 GB is gathered in memory and saved like any download. Bigger files stream straight to disk where the
// browser allows it (Chrome, Edge), so a 10 GB video doesn't have to fit in memory.
async function sinkFor(m) {
  if (m.size > 2 ** 30 && window.showSaveFilePicker) {
    const h = await showSaveFilePicker({ suggestedName: m.name });
    const w = await h.createWritable();
    return { write: (u8) => w.write(u8), close: () => w.close(), abort: () => w.abort(), disk: true };
  }
  const parts = [];
  return {
    write: (u8) => { parts.push(u8); },
    close: () => {
      const url = URL.createObjectURL(new Blob(parts, { type: m.type || 'application/octet-stream' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: m.name });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  };
}

async function download() {
  if (running || !link) return;
  running = true;
  const btn = $('#dl');
  btn.disabled = true;
  $('#done').hidden = true;
  $('#prog').hidden = false;
  $('#p-step').style.color = '';
  let sink;
  try {
    sink = await sinkFor(link.meta);
    const t0 = Date.now();
    $('#p-step').textContent = 'Downloading and decrypting · 0%';
    const { sha256 } = await downloadLink({
      base: API, id, link, sink,
      onProgress: ({ got, total }) => {
        const pc = Math.floor((got / total) * 100);
        $('#p-bar').style.width = pc + '%';
        $('#p-step').textContent = `Downloading and decrypting · ${pc}%`;
        $('#p-rate').textContent = eta(got, total, t0);
      },
    });
    $('#prog').hidden = true;
    $('#done').hidden = false;
    $('#sha').textContent = sha256;
    btn.hidden = true;
  } catch (e) {
    try { sink?.abort?.(); } catch {}
    if (e && e.name === 'AbortError') { $('#prog').hidden = true; }
    else { $('#p-step').innerHTML = ''; $('#p-step').textContent = (e && e.message) || 'The download stopped. Try again.'; $('#p-step').style.color = 'var(--bad)'; }
    btn.disabled = false;
    btn.textContent = 'Try again';
  } finally {
    running = false;
  }
}

async function report() {
  const b = $('#r-send'), done = $('#r-done');
  if (!$('#r-why').value) { done.textContent = 'Choose a reason first.'; done.hidden = false; return; }
  b.disabled = true;
  try {
    const headers = { 'content-type': 'application/json' };
    if (link?.token) headers.authorization = `Bearer ${link.token}`; // a link sent to one person: only they can report it
    const r = await fetch(`${API}/v1/s/${encodeURIComponent(id)}/report`, { method: 'POST', headers, body: JSON.stringify({ reason: $('#r-why').value }) });
    if (!r.ok && r.status !== 404) throw new Error((await r.json().catch(() => null))?.error || 'That didn’t go through. Try again.');
    done.textContent = 'Thank you. The link is switched off and we’ll review it.';
    done.hidden = false;
    $('#dl').hidden = true;
    b.hidden = true;
  } catch (e) {
    done.textContent = e.message;
    done.hidden = false;
    b.disabled = false;
  }
}

$('#dl').onclick = download;
$('#r-send').onclick = report;
$('#again').onclick = () => { $('#dl').hidden = false; $('#dl').disabled = false; download(); };
$('#b-other').onclick = () => { signOut(false); if (bound) drawBound('Sign in with the wallet it was sent to.', 'Sign in with bWalletX to open', signIn); signIn(); };
$('#b-out').onclick = () => { signOut(false); if (bound) drawBound('Sign in with bWalletX to open it. Only the wallet it was sent to can.', 'Sign in with bWalletX to open', signIn); };
load();
