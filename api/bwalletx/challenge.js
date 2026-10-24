// POST /api/bwalletx/challenge { identityKey } -> { nonce, message, expiresAt, ..., ticket }
import { createChallenge, originAllowed } from '@bwalletx/connect/server';
import { ORIGIN, body, originOk, seal, secret } from './_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!originOk(req.headers.origin)) return res.status(403).json({ error: 'Wrong origin.' });
  const s = secret();
  if (!s) return res.status(503).json({ error: 'bWalletX connect is not switched on yet.' });
  let pending = null;
  const store = { put: (nonce, c) => { pending = { nonce, c }; }, take: () => null };
  try {
    const ch = await createChallenge({ origin: ORIGIN, identityKey: (await body(req)).identityKey, store });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ...ch, ticket: seal(s, pending) });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
}
