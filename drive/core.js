// Shared rules for the bDriveX page. LIVE gates real writes. A real write also needs: the wallet to pin
// [2,'bdrivex records'] to bdrivex.com (getVersion().pinnedProtocols >= PIN_VERSION, or a "+pN" version suffix) and
// the premium payee set on the server. Any check failing = the page refuses to write; Dry run always works.
import * as R from './records.js';

export const LIVE = true;

export const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const ls = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
export const filesN = (n) => `${n.toLocaleString()} file${n === 1 ? '' : 's'}`;
export const txN = (n) => `${n} transaction${n === 1 ? '' : 's'}`;
export const bytes = (n) => { n = Number(n) || 0; return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB` : `${(n / 1073741824).toFixed(2)} GB`; };
/** { usd: "$0.03", gbp: "2p" } for sats at today's rates. */
export const money = (sats, cfg) => {
  if (!cfg?.usdPerBsv) return { usd: `${sats.toLocaleString()} sats`, gbp: '' };
  const usd = (sats / 1e8) * cfg.usdPerBsv;
  const u = usd < 0.01 ? (usd < 0.001 ? 'under $0.001' : `$${usd.toFixed(3)}`) : usd < 100 ? `$${usd.toFixed(2)}` : `$${Math.round(usd).toLocaleString()}`;
  if (!cfg.usdPerGbp) return { usd: u, gbp: '' };
  const p = (usd / cfg.usdPerGbp) * 100;
  const g = p < 0.1 ? 'under 0.1p' : p < 10 ? `${p.toFixed(1).replace(/\.0$/, '')}p` : p < 100 ? `${Math.round(p)}p` : `£${(p / 100).toFixed(2)}`;
  return { usd: u, gbp: g };
};

/** Items minted by this identity (itemId -> {outpoint, kid}), kept on this device and refilled from the wallet. */
export const doneKey = (key) => `bdx-done-${key}`;
export const doneFor = (key) => ls.get(doneKey(key)) || {};
/** The library (file details only, never bytes), per identity, on this device. */
export const libKey = (key) => `bdx-lib-${key}`;

export async function loadCfg() {
  const c = await fetch('/api/drive/config', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
  if (!c) return null;
  return { ...c, gbpPerItem: c.premiumGbpPerItem, satPerKb: c.feeSatPerKb, priced: !!(c.usdPerBsv && c.usdPerGbp) };
}

export async function pinCheck(w) {
  try {
    const v = await w.getVersion({});
    const m = v && typeof v.version === 'string' ? v.version.match(/\+p(\d+)\b/) : null;
    const lock = Math.max(Number(v && v.pinnedProtocols) || 0, m ? Number(m[1]) : 0);
    return { ok: lock >= R.PIN_VERSION, seen: `${(v && v.version) || 'unknown version'}${lock ? `, lock v${lock}` : ', no lock'}` };
  } catch (e) { return { ok: false, seen: `no answer (${(e && e.message) || 'error'})` }; }
}

/** Why a real write is refused right now, or null. */
export function liveBlock({ cfg, key, walletKey, pinned, seen }) {
  if (!LIVE) return 'Real minting is off. Dry run only.';
  if (!cfg || !cfg.priced) return 'Prices are still loading.';
  if (!key) return 'Connect bWalletX first.';
  if (walletKey && walletKey !== key) return 'The wallet in this browser is a different identity from the one signed in. Reconnect bWalletX.';
  if (pinned === false) return `Your bWalletX needs an update that keeps these records locked to bdrivex.com (the connected wallet reports: ${seen}). Use Dry run until it arrives.`;
  if (!cfg.payee) return 'Real minting opens shortly (payments are being set up). Dry run works now.';
  return null;
}

export const friendly = (e) => /denied|declin|reject|cancel|permission/i.test(String(e?.message)) ? 'Your wallet said no, so nothing was written. Try again when you’re ready.'
  : e?.code === 'NOT_FOUND' ? 'Your wallet is not connected in this browser any more. Press Connect bWalletX, then try again.'
  : (e?.message || 'It stopped. Try again: it carries on from the last saved batch.');
