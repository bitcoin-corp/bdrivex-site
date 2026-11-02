// Headless Chrome over CDP: /send and /s/:id end to end with throwaway in-page wallets (scripts/test-wallet.js).
//   node scripts/e2e-browser.mjs              (needs ../bdrivex-api with its node_modules, and Google Chrome)
//   node scripts/e2e-browser.mjs --real-jon   (also looks up the real $REAL_PAYMAIL key, for a manual UI check; it
//                                              makes no link for it)
// It starts its own API (invite-only: only the sender is invited) and site server on spare ports, so it doesn't
// disturb dev servers on 8787/5173. The page still talks to http://127.0.0.1:8787 (js/config.js); CDP rewrites
// those requests to this run's API. Paymail lookups are answered by the harness with throwaway keys.
// Screenshots go to OUT_DIR (default: a temp dir), never into the repo.
import { spawn } from 'node:child_process';
import { createECDH, createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SITE_DIR = resolve(here, '..');
const API_DIR = resolve(process.env.API_DIR || join(SITE_DIR, '../bdrivex-api'));
const OUT = process.env.OUT_DIR || mkdtempSync(join(tmpdir(), 'bdx-e2e-'));
mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const API_PORT = 8689, SITE_PORT = 5174, SITE = `http://localhost:${SITE_PORT}`;
const REAL_JON = process.argv.includes('--real-jon');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, w) => { console.log(`${c ? '  ok ' : '  FAIL'} ${w}`); if (!c) fails++; };

// ---- throwaway keys (secp256k1, compressed public key = BRC-100 identity key)
const newKey = () => { const priv = randomBytes(32).toString('hex'); const e = createECDH('secp256k1'); e.setPrivateKey(priv, 'hex'); return { priv, pub: e.getPublicKey('hex', 'compressed') }; };
const SENDER = newKey(), RECIP = newKey(), THIRD = newKey(), HC = newKey();
const short = (k) => `${k.slice(0, 4)}…${k.slice(-4)}`;

// ---- the in-page wallet, bundled with the API repo's esbuild and @bsv/sdk
const { build } = await import(pathToFileURL(join(API_DIR, 'node_modules/esbuild/lib/main.js')).href);
const bundle = await build({ entryPoints: [join(here, 'test-wallet.js')], bundle: true, format: 'iife', write: false, nodePaths: [join(API_DIR, 'node_modules')], logLevel: 'silent' });
const WALLET = bundle.outputFiles[0].text;

// ---- servers
const procs = [];
const apiData = mkdtempSync(join(tmpdir(), 'bdx-e2e-api-'));
procs.push(spawn(process.execPath, [join(API_DIR, 'src/server.js')], {
  env: { ...process.env, PORT: String(API_PORT), DATA_DIR: apiData, ALLOWED_ORIGINS: SITE, SIGNUP: 'invite', ALLOWED_KEYS: SENDER.pub, SESSION_SECRET: randomBytes(32).toString('hex') },
  stdio: ['ignore', 'ignore', 'inherit'],
}));
procs.push(spawn(process.execPath, [join(SITE_DIR, 'scripts/dev.mjs')], { env: { ...process.env, PORT: String(SITE_PORT) }, stdio: 'ignore' }));
const up = async (u) => { for (let i = 0; i < 60; i++) { try { await fetch(u); return; } catch { await sleep(150); } } throw new Error(`${u} did not start`); };
await up(`http://127.0.0.1:${API_PORT}/health`);
await up(`http://127.0.0.1:${SITE_PORT}/`);
const cleanup = () => { for (const p of procs) try { p.kill(); } catch {} rmSync(apiData, { recursive: true, force: true }); };
process.on('exit', cleanup);

// ---- paymail answers (throwaway keys only, unless --real-jon lets one real lookup through)
const json = (o, status = 200) => ({ status, body: JSON.stringify(o) });
function paymailStub(url) {
  const u = new URL(url);
  if (u.host === 'pay.bwallet.space') {
    const id = /^\/api\/paymail\/id\/(.+)$/.exec(u.pathname)?.[1];
    if (id) {
      const pm = decodeURIComponent(id);
      if (REAL_JON && pm === 'REAL_PAYMAIL@bwalletx.com') return 'pass';
      if (pm === 'testjon@bwalletx.com') return json({ bsvalias: '1.0', handle: pm, pubkey: RECIP.pub });
      if (pm === 'liar@bwalletx.com') return json({ bsvalias: '1.0', handle: 'someoneelse@bwalletx.com', pubkey: THIRD.pub });
      return json({ error: 'not found' }, 404);
    }
    if (u.pathname === '/api/paymail/lookup') return u.searchParams.get('key') === SENDER.pub ? json({ paymail: 'testsender@bwalletx.com' }) : json({ error: 'not found' }, 404);
    return json({ error: 'not found' }, 404);
  }
  if (u.host === 'dns.google') {
    const name = u.searchParams.get('name');
    return json({ Status: 0, AD: false, Answer: name === '_bsvalias._tcp.handcash.io' ? [{ name: name + '.', type: 33, data: '10 100 443 cloud.handcash.io.' }] : [] });
  }
  if (u.host === 'cloud.handcash.io') {
    if (u.pathname === '/.well-known/bsvalias') return json({ bsvalias: '1.0', capabilities: { pki: 'https://cloud.handcash.io/api/bsvalias/id/{alias}@{domain.tld}' } });
    if (u.pathname === '/api/bsvalias/id/testhc@handcash.io') return json({ bsvalias: '1.0', handle: 'testhc@handcash.io', pubkey: HC.pub });
    return json({ error: 'not found' }, 404);
  }
  return json({ error: 'not found' }, 404);
}

// ---- one headless browser = one device with one wallet
let nextPort = 9433;
async function browser(walletKey, { width = 1440, height = 1100, mobile = false } = {}) {
  const port = nextPort++;
  const dir = mkdtempSync(join(tmpdir(), 'bdx-prof-'));
  const p = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });
  let tabs;
  for (let i = 0; i < 60; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (tabs.some((t) => t.type === 'page')) break; } catch {} await sleep(200); }
  const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const wait = new Map(); const logs = []; const seen = [];
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.onmessage = async (m) => {
    const d = JSON.parse(m.data);
    if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); return; }
    if (d.method === 'Runtime.consoleAPICalled') logs.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
    if (d.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === 'Log.entryAdded') logs.push(`${d.params.entry.level}: ${d.params.entry.text}`);
    if (d.method === 'Fetch.requestPaused') {
      const { requestId, request } = d.params;
      seen.push(`${request.method} ${request.url}`);
      if (request.url.startsWith('http://127.0.0.1:8787/')) return send('Fetch.continueRequest', { requestId, url: request.url.replace('http://127.0.0.1:8787/', `http://127.0.0.1:${API_PORT}/`) });
      const a = paymailStub(request.url);
      if (a === 'pass') return send('Fetch.continueRequest', { requestId });
      return send('Fetch.fulfillRequest', { requestId, responseCode: a.status, responseHeaders: [{ name: 'content-type', value: 'application/json' }, { name: 'access-control-allow-origin', value: '*' }], body: Buffer.from(a.body).toString('base64') });
    }
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable'); await send('Log.enable');
  await send('Fetch.enable', { patterns: ['http://127.0.0.1:8787/*', 'https://pay.bwallet.space/*', 'https://dns.google/*', 'https://cloud.handcash.io/*'].map((urlPattern) => ({ urlPattern })) });
  const dl = join(OUT, `dl-${port}`);
  mkdirSync(dl, { recursive: true });
  await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
  if (mobile) await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
  if (walletKey) await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__TEST_KEY=${JSON.stringify(walletKey)};\n${WALLET}` });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed'); return r.result.result.value; };
  const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(150); } return false; };
  const go = async (u) => { await send('Page.navigate', { url: u }); await sleep(600); await until('document.readyState === "complete"'); };
  const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); writeFileSync(join(OUT, name), Buffer.from(r.result.data, 'base64')); };
  const upload = async (file) => { const doc = await send('DOM.getDocument'); const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#pick' }); await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [file] }); };
  const text = () => ev('document.body.innerText');
  const close = () => { try { ws.close(); } catch {} p.kill(); setTimeout(() => rmSync(dir, { recursive: true, force: true }), 1500); };
  return { ev, until, go, shot, upload, text, close, logs, seen, dl };
}

const $v = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const typeTo = (v) => `(() => { const i = ${$v('#to')}; i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`;

// a test file
const file = join(OUT, 'quarterly-report.pdf');
const bytes = randomBytes(2 * 2 ** 20 + 4321);
writeFileSync(file, bytes);
const want = createHash('sha256').update(bytes).digest('hex');

// ================= sender
console.log('sender (invited) on /send');
const A = await browser(SENDER.priv);
await A.go(`${SITE}/send`);
await A.ev(`${$v('#signin')}.click()`);
ok(await A.until(`!${$v('#app')}.hidden`), 'A: signs in with the throwaway wallet');
await A.upload(file);
ok(await A.until(`!${$v('#linkform')}.hidden`), 'A: "Who is it for?" shows while it uploads');
ok(await A.ev(`document.querySelector('input[name=aud][value=one]').checked`), 'A: "Only this person" is the default');
ok(await A.ev(`${$v('#make')}.disabled`), 'A: no link can be made before a person is chosen');
ok((await A.text()).includes('Anyone who has this link can open it'), 'A: the anyone choice is clearly labelled');
ok(await A.until(`${$v('#job-step')}.textContent.includes('Uploaded and encrypted')`, 60000), 'A: upload finishes');

await A.ev(typeTo('$nobody'));
ok(await A.until(`${$v('#to-who')}.textContent.includes('There’s no $nobody')`), 'A: an unknown $handle is reported');
await A.ev(typeTo('$liar'));
ok(await A.until(`${$v('#to-who')}.textContent.includes('answered for someone else')`), 'A: a pki answer for a different handle is refused');
await A.ev(typeTo('jon@example.org'));
ok(await A.until(`${$v('#to-who')}.textContent.includes('HandCash paymails for now')`), 'A: a paymail host outside the CSP is refused with a clear message');
await A.ev(typeTo('testhc@handcash.io'));
ok(await A.until(`${$v('#to-who')}.textContent.includes('Sending to testhc@handcash.io · ${short(HC.pub)}')`), 'A: a HandCash paymail resolves via SRV + .well-known/bsvalias (pki)');
await A.ev(typeTo('$testjon'));
ok(await A.until(`${$v('#to-who')}.textContent === 'Sending to $testjon · ${short(RECIP.pub)}'`), `A: shows "Sending to $testjon · ${short(RECIP.pub)}"`);
ok(await A.until(`!${$v('#make')}.disabled && ${$v('#make')}.textContent === 'Send to $testjon'`), 'A: the button says who it goes to');

// expiry: a date ten days ahead
const ten = await A.ev(`(() => { const d = new Date(Date.now() + 10 * 864e5); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); })()`);
await A.ev(`(() => { const s = ${$v('#ttl')}; s.value = 'date'; s.dispatchEvent(new Event('change')); const d = ${$v('#ttl-date')}; d.value = ${JSON.stringify(ten)}; d.dispatchEvent(new Event('change')); })()`);
ok(await A.ev(`!${$v('#ttl-date')}.hidden && ${$v('#ttl-date')}.max.length === 10`), 'A: "Until a date…" shows a date picker capped at 30 days');
await A.shot('a1-link-form.png');
const callsBefore = (await A.ev('window.__calls')).filter((c) => c === 'encrypt').length;
await A.ev(`${$v('#make')}.click()`);
ok(await A.until(`!${$v('#share')}.hidden`), 'A: the link is made');
const bound = await A.ev(`${$v('#url')}.value`);
ok(/\/s\/[\w-]{22}$/.test(bound) && !bound.includes('#'), `A: the link has no #k: ${bound.replace(/[\w-]{22}$/, '…')}`);
ok((await A.ev('window.__calls')).filter((c) => c === 'encrypt').length === callsBefore + 1, 'A: the sender\'s wallet wrapped the key for the recipient (encrypt)');
const tenLabel = await A.ev(`new Date(${JSON.stringify(ten)} + 'T12:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })`);
const audLine = await A.ev(`${$v('#aud-line')}.textContent`);
ok(audLine === `Only $testjon can open this · Link works until ${tenLabel}`, `A: "${audLine}"`);
ok(await A.until(`[...document.querySelectorAll('#files .aud-t')].some((e) => e.textContent === 'Only $testjon')`), 'A: the file list shows "Only $testjon"');
await A.shot('a2-sent-to-one.png');

// a second link for the same file, for anyone, from the file list
await A.ev(`document.querySelector('#files [data-act=new]').click()`);
ok(await A.until(`!${$v('#linkform')}.hidden`), 'A: "New link" in the list opens the same who-and-how-long step');
await A.ev(`(() => { const r = document.querySelector('input[name=aud][value=any]'); r.checked = true; r.dispatchEvent(new Event('change')); })()`);
await A.ev(`(() => { const s = ${$v('#ttl')}; s.value = '86400'; s.dispatchEvent(new Event('change')); })()`);
ok(await A.until(`!${$v('#make')}.disabled && ${$v('#make')}.textContent === 'Make a link anyone can open'`), 'A: choosing anyone needs no person');
await A.ev(`${$v('#make')}.click()`);
ok(await A.until(`!${$v('#share')}.hidden`), 'A: anyone-link made');
const anyone = await A.ev(`${$v('#url')}.value`);
ok(/#k=[\w-]{43}$/.test(anyone), 'A: the anyone-link carries #k');
ok((await A.ev(`${$v('#aud-line')}.textContent`)).startsWith('Anyone who has this link can open it · Link works until'), 'A: and says anyone can open it');
ok(await A.until(`(() => { const t = [...document.querySelectorAll('#files .aud-t')].map((e) => e.textContent); return t.includes('Only $testjon') && t.includes('Anyone with the link'); })()`), 'A: the list shows each link\'s audience');
await A.shot('a3-file-list.png');
console.log('  A console:', A.logs.filter((l) => !/Experimental|DevTools/.test(l)).slice(-6));
A.close();

// phone width: the link step fits
const M = await browser(SENDER.priv, { width: 390, height: 844, mobile: true });
await M.go(`${SITE}/send`);
await M.ev(`${$v('#signin')}.click()`);
await M.until(`!${$v('#app')}.hidden`);
await M.upload(file);
await M.until(`${$v('#job-step')}.textContent.includes('Uploaded and encrypted')`, 60000);
await M.ev(typeTo('$testjon'));
await M.until(`${$v('#to-who')}.textContent.startsWith('Sending to')`);
ok(await M.ev('document.documentElement.scrollWidth <= window.innerWidth'), 'phone: no sideways scroll on the link step');
await M.shot('m1-phone-link-form.png');
M.close();

// ================= recipient
console.log('recipient (not invited) on /s/:id');
const R = await browser(RECIP.priv);
await R.go(bound);
ok(await R.until(`!${$v('#bound')}.hidden`), 'R: the page says the file was sent to someone and asks to sign in');
ok(await R.until(`${$v('#b-h')}.textContent === 'Sent to you by $testsender'`), 'R: "Sent to you by $testsender"');
let t = await R.text();
ok(!t.includes('quarterly-report') && !t.includes('$testjon') && !t.includes(RECIP.pub.slice(0, 10)), 'R before sign-in: no file name, nothing about the recipient');
await R.shot('r1-before-sign-in.png');
await R.ev(`${$v('#b-signin')}.click()`);
ok(await R.until(`!${$v('#file')}.hidden && ${$v('#f-name')}.textContent === 'quarterly-report.pdf'`), 'R: signs in (recipient session), the wallet unwraps the key, the name shows');
ok((await R.ev('window.__calls')).includes('decrypt'), 'R: the recipient\'s wallet decrypted the wrap');
const rs = await R.ev(`JSON.parse(sessionStorage.getItem('bdx:open-session')).scope`);
ok(rs === 'recipient', 'R: it is a recipient-only session');
await R.ev(`${$v('#dl')}.click()`);
ok(await R.until(`!${$v('#done')}.hidden`, 60000), 'R: download finishes');
ok((await R.ev(`${$v('#sha')}.textContent`)) === want, `R: sha256 matches ${want.slice(0, 16)}…`);
await sleep(1500);
const got = readdirSync(R.dl).filter((f) => !f.endsWith('.crdownload'));
ok(got.length === 1 && createHash('sha256').update(readFileSync(join(R.dl, got[0]))).digest('hex') === want, 'R: the saved file is byte for byte the original');
await R.shot('r2-downloaded.png');
console.log('  R console:', R.logs.filter((l) => !/Experimental|DevTools/.test(l)).slice(-6));
R.close();

// ================= a third wallet
console.log('a third wallet on the same link');
const X = await browser(THIRD.priv);
await X.go(bound);
await X.until(`!${$v('#bound')}.hidden`);
await X.ev(`${$v('#b-signin')}.click()`);
ok(await X.until(`!${$v('#bad')}.hidden && ${$v('#bad-h')}.textContent === 'This file was sent to someone else.'`), 'X: "This file was sent to someone else."');
t = await X.text();
ok(!t.includes('quarterly-report') && !t.includes('$testjon') && !t.includes(RECIP.pub.slice(0, 10)), 'X: no file name, nothing about the recipient');
ok(!(await X.ev('window.__calls')).includes('decrypt'), 'X: its wallet was never asked to decrypt anything');
await X.shot('x1-someone-else.png');
X.close();

// ================= no wallet at all, anyone-link still works
console.log('no wallet: the anyone-link');
const N = await browser(null);
await N.go(anyone.replace(/^http:\/\/[^/]+/, SITE));
ok(await N.until(`!${$v('#file')}.hidden && ${$v('#f-name')}.textContent === 'quarterly-report.pdf'`), 'N: an anyone-link opens with no wallet');
await N.go(bound);
ok(await N.until(`!${$v('#bound')}.hidden`), 'N: the bound link asks for a sign-in instead');
ok(!N.logs.some((l) => /Content Security Policy/i.test(l)), 'N: no CSP errors');
N.close();

// ================= optional: the real $REAL_PAYMAIL key, for the manual UI check (no link is made)
if (REAL_JON) {
  console.log('manual check: real lookup for $REAL_PAYMAIL');
  const J = await browser(SENDER.priv);
  await J.go(`${SITE}/send`);
  await J.ev(`${$v('#signin')}.click()`);
  await J.until(`!${$v('#app')}.hidden`);
  await J.upload(file);
  await J.until(`${$v('#job-step')}.textContent.includes('Uploaded and encrypted')`, 60000);
  await J.ev(typeTo('REAL_PAYMAIL@bwalletx.com'));
  ok(await J.until(`${$v('#to-who')}.textContent.startsWith('Sending to $REAL_PAYMAIL · ')`), `J: ${await J.ev(`${$v('#to-who')}.textContent`)}`);
  await J.shot('j1-real-REAL_PAYMAIL.png');
  J.close();
}

console.log(`\nscreenshots: ${OUT}`);
console.log(fails ? `${fails} FAILED` : 'all passed');
setTimeout(() => process.exit(fails ? 1 : 0), 1800);
