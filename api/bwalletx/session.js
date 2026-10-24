// GET /api/bwalletx/session -> { identityKey } | { identityKey: null }   POST -> sign out
import { readCookie, serializeCookie, verifySession } from '@bwalletx/connect/server';
import { ORIGIN, secret } from './_auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const s = secret();
  if (req.method === 'POST') {
    res.setHeader('Set-Cookie', serializeCookie('', { name: 'bwx_session', maxAge: 0, secure: ORIGIN.startsWith('https'), sameSite: 'Lax', path: '/' }));
    return res.status(200).json({ identityKey: null });
  }
  if (!s) return res.status(200).json({ identityKey: null, off: true });
  const p = await verifySession(readCookie(req.headers.cookie, 'bwx_session'), { secret: s });
  return res.status(200).json({ identityKey: p?.sub ?? null });
}
