// POST /api/drive/publish { outpoint, record, timestamp, signature }        -> list a public record on Browse
// POST /api/drive/publish { remove: true, outpoint, timestamp, signature }  -> take it off Browse
// Forwards to the push server (POST /v1/drive/public[/remove]), which checks the wallet's BRC-100 signature
// (protocol [2,'bdrivex public'], keyID 'publish'). The identity key comes from the signed-in session, never the body.
import { readCookie, verifySession } from '@bwalletx/connect/server';
import { body, originOk, secret } from '../bwalletx/_auth.js';
import { PUSH_API } from '../_rates.js';
import { paymailFor } from '../_profile.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();
  if (!originOk(req.headers.origin)) return res.status(403).json({ error: 'Wrong origin.' });
  const s = secret();
  const me = s ? (await verifySession(readCookie(req.headers.cookie, 'bwx_session'), { secret: s }))?.sub || null : null;
  if (!me) return res.status(401).json({ error: 'Connect bWalletX first.' });
  const b = await body(req);
  if (!/^[0-9a-f]{64}:\d{1,6}$/.test(String(b.outpoint)) || !Number.isInteger(b.timestamp) || !Array.isArray(b.signature)) return res.status(400).json({ error: 'Sign with your wallet first.' });
  const remove = b.remove === true;
  if (!remove && (typeof b.record !== 'string' || b.record.length > 4000)) return res.status(400).json({ error: 'Bad record.' });
  const alias = remove ? null : (await paymailFor(me))?.alias || null;
  let r, j;
  try {
    r = await fetch(`${PUSH_API()}/v1/drive/public${remove ? '/remove' : ''}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(remove ? { identityKey: me, outpoint: b.outpoint, timestamp: b.timestamp, signature: b.signature }
        : { identityKey: me, outpoint: b.outpoint, record: b.record, alias, timestamp: b.timestamp, signature: b.signature }),
      signal: AbortSignal.timeout(8000),
    });
    j = await r.json().catch(() => null);
  } catch { return res.status(502).json({ error: 'Could not reach the server. Try again shortly.' }); }
  if (!j && (r.status === 404 || r.status === 405)) return res.status(503).json({ error: 'Listing on Browse opens shortly. Your record is public on chain already.', coming: true });
  if (!r.ok) return res.status([400, 401, 429].includes(r.status) ? r.status : 502).json({ error: j?.error || 'That was not saved.' });
  return res.status(200).json(j);
}
