// Throwaway in-page BRC-100 wallet for the headless tests ONLY (scripts/e2e-browser.mjs bundles it and injects it
// before the page loads). The key is a random one the harness makes per run and hands in as window.__TEST_KEY; it
// never holds money and is never written anywhere but this test profile. Never ship this.
import { PrivateKey, ProtoWallet } from '@bsv/sdk';

const pw = new ProtoWallet(PrivateKey.fromHex(window.__TEST_KEY));
window.__calls = [];
const wrap = (name) => async (args) => { window.__calls.push(name); return pw[name](args); };
window.CWI = {
  getPublicKey: wrap('getPublicKey'), createSignature: wrap('createSignature'), encrypt: wrap('encrypt'), decrypt: wrap('decrypt'),
  isAuthenticated: async () => ({ authenticated: true }), waitForAuthentication: async () => ({ authenticated: true }),
  getNetwork: async () => ({ network: 'mainnet' }), getVersion: async () => ({ version: 'test-0' }),
};
