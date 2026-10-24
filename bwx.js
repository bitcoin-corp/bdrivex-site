/* Connect bWalletX on bdrivex.com: drop <span data-bwx></span> anywhere and include this after
   @bwalletx/connect's global build and qrcode-generator. Extension / in-app wallets connect straight away;
   on a desktop with no extension it shows a QR to pair the phone app (or paste into web.bwalletx.com).
   Once connected the button shows the wallet's full paymail (name@bwalletx.com); no name yet: short key + Get your name.
   <span data-bwx="drive"></span> turns into a "Your drive" link once connected.
   In the header, a connected slot is a "$handle" link to /drive, and connecting there opens /drive.
   <span data-bwx="signout"></span> is a Sign out button while connected (nothing when signed out). */
(() => {
  const C = window.bWalletXConnect;
  const slots = [...document.querySelectorAll('[data-bwx]')];
  if (!C || !slots.length) return;
  const short = (k) => k.slice(0, 6) + '…' + k.slice(-4);
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const css = document.createElement('style');
  css.textContent = `.bwx-btn{display:inline-flex;align-items:center;gap:8px;min-height:38px;padding:0 16px;border-radius:999px;border:1px solid rgba(255,210,77,.45);background:#0b0b0c;color:#ffd24d;font:600 14px 'Space Grotesk',sans-serif;cursor:pointer}
  .bwx-btn{max-width:100%;min-width:0}.bwx-pm{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  header [data-bwx]{display:inline-flex;align-items:center;min-width:0;max-width:min(62vw,340px)}
  .bwx-get{margin-left:8px;font-size:12px;color:#ffd24d;white-space:nowrap}
  .bwx-btn:hover{border-color:#ffd24d}.bwx-btn.on{background:linear-gradient(180deg,#ffe58a,#ffd24d 55%,#e0a800);color:#000;border:0}
  .bwx-dot{width:8px;height:8px;border-radius:50%;background:currentColor}
  .bwx-modal{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.8);display:grid;place-items:center;padding:16px}
  .bwx-card{background:#0b0b0c;border:1px solid rgba(255,210,77,.3);border-radius:20px;padding:24px;max-width:360px;width:100%;text-align:center;color:#f4f1e8;font:400 15px/1.5 'IBM Plex Sans',sans-serif}
  .bwx-card h3{font:700 22px 'Space Grotesk';margin:0 0 6px}.bwx-qr{background:#fff;border-radius:12px;padding:12px;margin:14px auto;width:max-content}
  .bwx-code{font:700 30px 'Space Grotesk';letter-spacing:.2em;color:#ffd24d}.bwx-x{margin-top:14px;background:none;border:0;color:#9a968b;cursor:pointer;font-size:14px}
  .bwx-link{word-break:break-all;font-size:11px;color:#9a968b;background:#000;border-radius:8px;padding:8px;margin-top:8px;cursor:copy}`;
  document.head.appendChild(css);

  let key = null, wallet = null, alias = null, paymail = null;
  /** Main name for an identity key, from the bWalletX paymail server (public lookup): {paymail, alias}. */
  const nameFor = async (k) => {
    try { const r = await fetch('https://pay.bwallet.space/api/paymail/lookup?key=' + k); const j = await r.json(); return r.ok && j.paymail ? { paymail: j.paymail, alias: j.alias || null } : null; } catch { return null; }
  };
  const setKey = async (k) => { key = k || null; alias = null; paymail = null; draw(); if (key) { const n = await nameFor(key); if (key === k && n) { alias = n.alias; paymail = n.paymail; draw(); } } };
  const shortKey = (k) => k.slice(0, 6) + '\u2026' + k.slice(-4);
  window.bdxIdentity = () => ({ identityKey: key, alias, paymail });
  /** The connected BRC-100 wallet (for signing claims): this session's, or a restored extension/pairing. */
  window.bdxWallet = async () => wallet || (wallet = (await C.connectBwalletX({})).wallet);
  const draw = () => slots.forEach((s) => {
    s.innerHTML = '';
    // Signed in: the full paymail (name@bwalletx.com); no name yet: a short key + "Get your name".
    const label = paymail ? `<span class="bwx-pm">${esc(paymail)}</span>` : key ? `<span class="bwx-pm">${esc(shortKey(key))}</span>` : '';
    const inNav = !!s.closest('header');
    // Navbar, connected: full paymail -> your account page (/drive). Sign out lives on the drive page.
    if (key && inNav) {
      const a = document.createElement('a');
      a.className = 'bwx-btn on'; a.href = '/drive'; a.title = 'Your drive: paymail and files';
      a.innerHTML = `<span class="bwx-dot"></span>${label}`;
      s.appendChild(a);
      if (!paymail) { const g = document.createElement('a'); g.className = 'bwx-get'; g.href = 'https://bwalletx.com/get'; g.target = '_blank'; g.rel = 'noopener'; g.textContent = 'Get your name'; s.appendChild(g); }
      return;
    }
    if (s.dataset.bwx === 'signout') {
      if (!key) return;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'bwx-btn'; b.textContent = 'Sign out'; b.title = 'Disconnect bWalletX from bDriveX on this browser';
      b.onclick = disconnect; s.appendChild(b); return;
    }
    if (key && s.dataset.bwx === 'drive') {
      const a = document.createElement('a');
      a.className = 'bwx-btn on'; a.href = '/drive';
      a.innerHTML = `Your drive · ${label} <span aria-hidden="true">&rarr;</span>`;
      s.appendChild(a); return;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bwx-btn' + (key ? ' on' : '');
    b.innerHTML = key ? `<span class="bwx-dot"></span>${label}` : 'Connect bWalletX';
    b.title = key ? 'Connected. Click to disconnect.' : 'Connect your bWalletX';
    b.onclick = key ? disconnect : () => connect(inNav || s.dataset.bwx === 'drive');
    s.appendChild(b);
  });
  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  };
  let modal = null;
  const close = () => { modal?.remove(); modal = null; };
  const show = (html) => {
    close();
    modal = document.createElement('div'); modal.className = 'bwx-modal';
    modal.innerHTML = `<div class="bwx-card">${html}<button class="bwx-x" type="button">Cancel</button></div>`;
    modal.querySelector('.bwx-x').onclick = close;
    modal.onclick = (e) => { if (e.target === modal) close(); };
    document.body.appendChild(modal);
    return modal.querySelector('.bwx-card');
  };

  async function connect(toStudio) {
    let ticket = null;
    try {
      const r = await C.signInWithBwalletX({
        challenge: async (identityKey) => { const ch = await post('/api/bwalletx/challenge', { identityKey }); ticket = ch.ticket; return ch; },
        pairing: {
          onLink: (link) => {
            let qr = '';
            if (window.qrcode) { const q = window.qrcode(0, 'M'); q.addData(link); q.make(); qr = q.createSvgTag({ cellSize: 4, margin: 0 }); }
            const card = show(`<h3>Connect bWalletX</h3><p>Scan with the bWalletX app on your phone, or paste the link into <a href="https://web.bwalletx.com" target="_blank" rel="noopener" style="color:#ffd24d">web.bwalletx.com</a>.</p><div class="bwx-qr">${qr}</div><div class="bwx-link" title="Click to copy">${esc(link)}</div><p id="bwxCode" style="margin:12px 0 0"></p>`);
            card.querySelector('.bwx-link').onclick = () => navigator.clipboard?.writeText(link);
          },
          onCode: (code) => { const el = document.getElementById('bwxCode'); if (el) el.innerHTML = `Check your wallet shows <span class="bwx-code">${esc(code)}</span>, then tap Connect.`; },
        },
      });
      const v = await post('/api/bwalletx/verify', { identityKey: r.identityKey, nonce: r.nonce, signature: r.signature, ticket });
      wallet = r.wallet; close(); setKey(v.identityKey);
      document.dispatchEvent(new CustomEvent('bdrivex-wallet', { detail: { identityKey: key, fromNav: !!toStudio } }));
      // Connecting from the navbar (any page) opens your account page. The claim page's own step-3 button stays put.
      if (toStudio && !/^\/drive\/?$/.test(location.pathname)) location.assign('/drive');
    } catch (e) {
      if (e && e.code === 'NOT_FOUND') {
        show(`<h3>No bWalletX found</h3><p>Get the bWalletX extension or app, or use the web wallet.</p><p><a class="bwx-btn on" href="https://bwalletx.com/get">Get bWalletX</a></p>`);
      } else if (modal) {
        modal.querySelector('.bwx-card').insertAdjacentHTML('beforeend', `<p style="color:#ff8a7a">${esc((e && e.message) || 'That didn’t work. Try again.')}</p>`);
      } else {
        show(`<h3>Couldn’t connect</h3><p style="color:#ff8a7a">${esc((e && e.message) || 'Try again.')}</p>`);
      }
    }
  }
  async function disconnect() {
    await post('/api/bwalletx/session', {}).catch(() => {});
    try { C.clearPairing?.(); } catch {}
    wallet = null; setKey(null);
    document.dispatchEvent(new CustomEvent('bdrivex-wallet', { detail: { identityKey: null } }));
  }
  fetch('/api/bwalletx/session', { credentials: 'same-origin' }).then((r) => r.json()).then((j) => setKey(j.identityKey || null)).catch(draw);
  draw();
})();
