// Find a person's identity key from their $handle or paymail (bsvalias `pki`), in the browser, so bDriveX's server
// never has a say in whose key a file is wrapped for.
//   $jon, jon, name@bwalletx.com  -> pay.bwallet.space (bWalletX's paymail service)
//   jon@example.com               -> SRV _bsvalias._tcp.example.com (DNS over HTTPS), else example.com:443, then
//                                    /.well-known/bsvalias -> capabilities.pki
// /send's CSP limits which paymail hosts the browser can reach (see vercel.json).
const KEY = /^0[23][0-9a-f]{64}$/;
const BWALLETX = new Set(['bwalletx.com']);
const BWALLETX_PKI = 'https://pay.bwallet.space/api/paymail/id/{alias}@{domain.tld}';
const DOH = 'https://dns.google/resolve';

/** "$jon" | "jon" | "name@bwalletx.com" | "name@example.com" -> { alias, domain, paymail, label } or null. */
export function parseRecipient(input) {
  let s = String(input || '').trim().replace(/^\$/, '');
  if (!s.includes('@')) s += '@bwalletx.com';
  const m = /^([a-z0-9._+-]{1,64})@((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/i.exec(s);
  if (!m) return null;
  const alias = m[1].toLowerCase(), domain = m[2].toLowerCase();
  return { alias, domain, paymail: `${alias}@${domain}`, label: BWALLETX.has(domain) ? `$${alias}` : `${alias}@${domain}` };
}

async function getJson(url, f, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await f(url, { signal: ac.signal, headers: { accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
    return await r.json();
  } finally { clearTimeout(t); }
}

/** The pki URL template for a domain. Trusts an SRV target only inside the domain, or when DNSSEC vouches for it. */
async function pkiTemplate(domain, f, ms) {
  if (BWALLETX.has(domain)) return BWALLETX_PKI;
  let host = domain, port = 443;
  try {
    const d = await getJson(`${DOH}?name=${encodeURIComponent(`_bsvalias._tcp.${domain}`)}&type=SRV`, f, ms);
    const srv = (d.Answer || []).filter((a) => a.type === 33).map((a) => String(a.data).split(/\s+/))
      .filter((x) => x.length === 4).sort((a, b) => Number(a[0]) - Number(b[0]))[0];
    if (srv) {
      const target = srv[3].replace(/\.$/, '').toLowerCase();
      if (target === domain || target.endsWith('.' + domain) || d.AD === true) { host = target; port = Number(srv[2]) || 443; }
    }
  } catch {}
  const wk = await getJson(`https://${host}${port === 443 ? '' : ':' + port}/.well-known/bsvalias`, f, ms);
  const tpl = wk && wk.capabilities && wk.capabilities.pki;
  if (typeof tpl !== 'string' || !tpl.startsWith('https://')) throw new Error('no pki');
  return tpl;
}

/**
 * Resolve a recipient to { alias, domain, paymail, label, identityKey }. Throws with a message fit to show.
 * `fetch` can be swapped (tests).
 */
export async function resolveRecipient(input, { fetch: f = globalThis.fetch.bind(globalThis), timeout = 8000 } = {}) {
  const p = parseRecipient(input);
  if (!p) throw new Error('Type a $handle or a paymail, like $jon or name@bwalletx.com.');
  let j;
  try {
    const tpl = await pkiTemplate(p.domain, f, timeout);
    j = await getJson(tpl.replace('{alias}', encodeURIComponent(p.alias)).replace('{domain.tld}', encodeURIComponent(p.domain)), f, timeout);
  } catch (e) {
    if (e && e.status === 404) throw new Error(`There’s no ${p.label}. Check the spelling.`);
    throw new Error(BWALLETX.has(p.domain) ? `Couldn’t look up ${p.label} just now. Try again.` : `Couldn’t look up ${p.label}. bDriveX can send to $handles and HandCash paymails for now.`);
  }
  const key = String((j && j.pubkey) || '').toLowerCase();
  if (!KEY.test(key)) throw new Error(`${p.label} has no identity key bDriveX can use.`);
  if (j.handle && String(j.handle).toLowerCase() !== p.paymail) throw new Error(`The lookup for ${p.label} answered for someone else.`);
  return { ...p, identityKey: key };
}

export const shortKey = (k) => `${k.slice(0, 4)}…${k.slice(-4)}`;
