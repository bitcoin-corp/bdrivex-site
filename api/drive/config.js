// GET /api/drive/config -> what the page needs, fresh:
//   { payee, premiumGbpPerItem, perTx, feeSatPerKb, usdPerBsv, usdPerGbp, fullStorage, picker }
// payee: the bCorp receive address for b's premium, from BDRIVEX_PREMIUM_ADDRESS (Vercel env, never in source).
//   While it is unset, payee is null and the page refuses real writes (Dry run still works).
// picker: Google Picker settings, only when GOOGLE_PICKER=on and all three are set. The OAuth client id, the
//   browser API key (restricted to bdrivex.com + the Picker API) and the app id (Cloud project number) are public
//   by design: Google's Picker runs in the browser and needs them there. No client secret is used.
import { rates } from '../_rates.js';

export const MINT = { premiumGbpPerItem: 0.01, perTx: 25, feeSatPerKb: 100 };
/** Full encrypted storage on chain: Coming. The cap it will open with, shown with the cost. */
export const FULL_STORAGE = { live: false, maxBytes: 1_000_000 };

export function pickerConfig(env = process.env) {
  const clientId = (env.GOOGLE_CLIENT_ID || '').trim(), apiKey = (env.GOOGLE_PICKER_API_KEY || '').trim(), appId = (env.GOOGLE_PICKER_APP_ID || '').trim();
  if (env.GOOGLE_PICKER !== 'on' || !/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId) || !/^[\w-]{20,60}$/.test(apiKey) || !/^\d{6,20}$/.test(appId)) return null;
  return { clientId, apiKey, appId };
}

export default async function handler(req, res) {
  const addr = (process.env.BDRIVEX_PREMIUM_ADDRESS || '').trim();
  const r = await rates();
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    payee: /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(addr) ? addr : null,
    ...MINT, ...r, fullStorage: FULL_STORAGE, picker: pickerConfig(),
  });
}
