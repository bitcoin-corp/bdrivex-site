// GET /api/browse -> the newest files people chose to make public on bDriveX (push GET /v1/drive/public?recent=1).
// Public and signed-out. Private records never reach the server, so they can't show here.
import { PUSH_API } from './_rates.js';

export default async function handler(req, res) {
  const r = await fetch(`${PUSH_API()}/v1/drive/public?recent=1&limit=60`, { signal: AbortSignal.timeout(2500) })
    .then(async (x) => ({ ok: x.ok, j: await x.json().catch(() => null) })).catch(() => ({ ok: false, j: null }));
  const live = r.ok && Array.isArray(r.j?.items);
  res.setHeader('Cache-Control', live ? 'public, s-maxage=60, stale-while-revalidate=600' : 'no-store');
  res.status(200).json({ live, items: live ? r.j.items : [] });
}
