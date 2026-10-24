// Live rates: USD per BSV (WhatsOnChain) and USD per GBP (ECB via frankfurter.app). Null when unreachable.
export async function rates() {
  const get = (u, f) => fetch(u, { signal: AbortSignal.timeout(2500) }).then((r) => r.json()).then(f).catch(() => null);
  const [usdPerBsv, usdPerGbp] = await Promise.all([
    get('https://api.whatsonchain.com/v1/bsv/main/exchangerate', (j) => Number(j.rate) || null),
    get('https://api.frankfurter.app/latest?from=GBP&to=USD', (j) => Number(j.rates?.USD) || null),
  ]);
  return { usdPerBsv, usdPerGbp };
}
export const PUSH_API = () => (process.env.PUSH_API || 'https://push.bwalletx.com').replace(/\/$/, '');
