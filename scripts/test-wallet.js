// Throwaway in-page BRC-100 wallet for the headless tests ONLY (scripts/e2e-browser.mjs bundles it and injects it
// before the page loads). The key is a random one the harness makes per run and hands in as window.__TEST_KEY; it
// never holds money and is never written anywhere but this test profile. Never ship this.
//   window.__calls      every method called, in order
//   window.__protoCalls [method, protocol name, counterparty] for calls that name a protocol
//   window.__decline    protocol names this wallet refuses, as a person unticking them on the sheet would
//   window.__slow       { protocol name: ms } answers for that protocol wait, as if its approval sheet were open
import { PrivateKey, ProtoWallet } from '@bsv/sdk';

const pw = new ProtoWallet(PrivateKey.fromHex(window.__TEST_KEY));
window.__calls = [];
window.__protoCalls = [];
window.__decline = [];
window.__slow = {};
const wrap = (name) => async (args) => {
  window.__calls.push(name);
  if (args && args.protocolID) {
    window.__protoCalls.push([name, args.protocolID[1], args.counterparty || 'self']);
    const ms = window.__slow[args.protocolID[1]];
    if (ms) await new Promise((r) => setTimeout(r, ms));
    if (window.__decline.includes(args.protocolID[1])) throw Object.assign(new Error('The user denied this request.'), { code: 'ERR_PERMISSION_DENIED' });
  }
  return pw[name](args);
};
window.CWI = {
  getPublicKey: wrap('getPublicKey'), createSignature: wrap('createSignature'), verifySignature: wrap('verifySignature'),
  encrypt: wrap('encrypt'), decrypt: wrap('decrypt'), createHmac: wrap('createHmac'), verifyHmac: wrap('verifyHmac'),
  isAuthenticated: async () => ({ authenticated: true }), waitForAuthentication: async () => ({ authenticated: true }),
  getNetwork: async () => ({ network: 'mainnet' }), getVersion: async () => ({ version: 'test-0' }),
};
