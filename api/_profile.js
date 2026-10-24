// Pages: one per bWalletX identity, at bdrivex.com/u/<name> (the paymail alias).
// The wallet's paymail comes from the bWalletX paymail server (public, read-only):
//   GET pay.bwallet.space/api/paymail/lookup?key=<identityKey> -> { paymail, alias }
//   GET pay.bwallet.space/api/paymail/id/<alias>@bwalletx.com   -> { pubkey }
//   GET pay.bwallet.space/api/paymail/profile/<paymail>          -> { name, avatar }
// Public files come from the bWalletX push server (GET /v1/drive/public?identity_key=), only what the user made public.
import { PUSH_API } from './_rates.js';

export const PAYMAIL_API = () => (process.env.PAYMAIL_API || 'https://pay.bwallet.space/api/paymail').replace(/\/$/, '');
export const PAYMAIL_DOMAIN = 'bwalletx.com';
export const KEY_RE = /^0[23][0-9a-f]{64}$/;
export const NAME_RE = /^[a-z0-9][a-z0-9_.-]{1,39}$/;

export const get = async (url, ms = 2500) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: 'application/json' } });
    return { status: r.status, json: await r.json().catch(() => null) };
  } catch { return { status: 0, json: null }; }
};
export async function paymailFor(identityKey) {
  const l = await get(`${PAYMAIL_API()}/lookup?key=${identityKey}`);
  if (l.status !== 200 || !l.json?.alias) return null;
  const paymail = String(l.json.paymail || `${l.json.alias}@${PAYMAIL_DOMAIN}`);
  const p = await get(`${PAYMAIL_API()}/profile/${encodeURIComponent(paymail)}`);
  const avatar = /^https:\/\//.test(String(p.json?.avatar || '')) ? String(p.json.avatar) : null;
  return { paymail, alias: String(l.json.alias), name: p.json?.name ? String(p.json.name).slice(0, 80) : null, avatar };
}
export async function keyForAlias(alias) {
  const r = await get(`${PAYMAIL_API()}/id/${encodeURIComponent(alias)}@${PAYMAIL_DOMAIN}`);
  const k = String(r.json?.pubkey || '').toLowerCase();
  return KEY_RE.test(k) ? k : null;
}
/** Public files for a key: { live, items }. live:false when the push endpoint isn't deployed yet. */
export async function publicFiles(identityKey) {
  const r = await get(`${PUSH_API()}/v1/drive/public?identity_key=${identityKey}&limit=100`);
  if (r.status === 200 && Array.isArray(r.json?.items)) return { live: true, items: r.json.items };
  return { live: false, items: [] };
}
