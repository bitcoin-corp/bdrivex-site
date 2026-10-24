// Connect bWalletX on bdrivex.com (@bwalletx/connect, BRC-100). bdrivex has no database, so instead of a
// nonce table the pending challenge is sealed (AES-256-GCM) into a `ticket` the browser carries back to
// /verify. It can't be read or forged; the nonce is still single-origin, single-key and expires in 2 min.
// Env: BWALLETX_SESSION_SECRET (32+ chars) signs the session cookie and keys the ticket.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const ORIGIN = process.env.SITE_ORIGIN || 'https://bdrivex.com';
/** The apex and its www twin both serve the site; the signed message always names the apex. */
export const originOk = (o) => { try { const h = new URL(String(o)).host; const a = new URL(ORIGIN).host; return h === a || h === 'www.' + a; } catch { return false; } };
export const secret = () => {
  const s = process.env.BWALLETX_SESSION_SECRET || '';
  return s.length >= 32 ? s : null;
};
const key = (s) => createHash('sha256').update('bdrivex bwalletx ticket\n' + s).digest();

export function seal(s, data) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key(s), iv);
  const body = Buffer.concat([c.update(JSON.stringify(data), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}
export function open(s, ticket) {
  try {
    const b = Buffer.from(String(ticket), 'base64url');
    const d = createDecipheriv('aes-256-gcm', key(s), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
  } catch { return null; }
}

export async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}
