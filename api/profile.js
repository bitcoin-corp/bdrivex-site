// GET /api/profile?name=<alias>  -> anyone's page (paymail + public files)
// GET /api/profile?me=1          -> the signed-in wallet's own page
//   -> { page: {paymail, alias, displayName, avatar, files[], publicLive}, isOwner, signedIn, identityKey? }
// The identity key is returned only to its owner (so the page can check the wallet in the browser is the same one).
import { readCookie, verifySession } from '@bwalletx/connect/server';
import { secret } from './bwalletx/_auth.js';
import { NAME_RE, keyForAlias, paymailFor, publicFiles } from './_profile.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const s = secret();
  const me = s ? (await verifySession(readCookie(req.headers.cookie, 'bwx_session'), { secret: s }))?.sub || null : null;
  let key = null;
  if (req.query?.me) {
    if (!me) return res.status(200).json({ page: null, signedIn: false, isOwner: false, connectOn: !!s });
    key = me;
  } else {
    const name = String(req.query?.name || '').toLowerCase().replace(/^[$@]/, '');
    if (!NAME_RE.test(name)) return res.status(400).json({ error: 'That is not a bDriveX name.' });
    key = await keyForAlias(name);
    if (!key) return res.status(404).json({ error: 'Nobody has that name yet.', signedIn: !!me });
  }
  const [pm, pub] = await Promise.all([paymailFor(key), publicFiles(key)]);
  const isOwner = !!(me && me === key);
  return res.status(200).json({
    page: { paymail: pm?.paymail || null, alias: pm?.alias || null, displayName: pm?.name || null, avatar: pm?.avatar || null, files: pub.items.map(({ identityKey: _, ...f }) => f), publicLive: pub.live },
    signedIn: !!me, isOwner, connectOn: !!s, ...(isOwner ? { identityKey: key } : {}),
  });
}
