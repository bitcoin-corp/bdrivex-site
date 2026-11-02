// bMail notice (v1.2.1): when a file is sent to one person, the SENDER's wallet tells them in bMail, bWalletX's
// mail, with the link. bDriveX's server takes no part and holds no key: the page builds the letter, the sender's
// wallet seals it to the recipient and signs in to the MessageBox relay, and the relay hands it to their wallet.
//
// The letter is exactly what bWalletX sends (bwalletX src/mobile/bmail/envelope.ts + client.ts sendMail, an
// unstamped letter), so the recipient's wallet fetches, decodes and opens it like any other bMail:
//   { t:'bmail', v:1, id, from, to, at, sealed }      no postage: no money moves
//   sealed = BRC-2 encrypt of {"subject","body"} to the recipient's identity key, protocol [2,'bmail'], key ID = id
// Outside the seal there is only who, to whom and when. The file name, its size and the link are inside it.
//
// The relay message id is the letter id (the wallet lets the client derive one with an HMAC, which costs the
// sender one more wallet approval and buys nothing here: every letter has a fresh random id).
// The MessageBox client (~200 KB gzipped) loads only when a letter is actually sent: see loadClient.

export const BMAIL_HOST = 'https://messagebox.bwalletx.com';
export const BMAIL_BOX = 'bmail';
export const BMAIL_PROTOCOL = [2, 'bmail'];
export const SUBJECT_MAX = 120;
export const BODY_MAX = 10_000;
/** The relay's cap on one message body (bwalletx-messagebox MAX_BODY_BYTES; GET /limits says the same). */
export const MAX_BODY_BYTES = 64 * 1024;
/**
 * messagebox.bwalletx.com's identity key, as its BRC-103 handshake gave it on 2 Nov 2026. Used ONLY to ask the
 * wallet for the relay sign-in permission at the same moment as the other approvals (askAlongside), so they share
 * one sheet. It is not a pin: if the relay's key ever changes, the wallet simply asks on a sheet of its own.
 */
export const RELAY_KEY = '021a8c3e9649e43fbc981aaf9cc366ccf0955df11bd79ef97b86c27387c5ca6723';
/** BRC-103 (AuthFetch) protocols the MessageBox sign-in uses: a nonce HMAC to yourself and a signature to the relay. */
export const AUTH_NONCE = [2, 'server hmac'];
export const AUTH_SIGNATURE = [2, 'auth message signature'];

const KEY = /^0[23][0-9a-f]{64}$/;
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const b64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };

/** 32 hex characters, like bWalletX's newMessageId. */
export const newMessageId = () => hex(crypto.getRandomValues(new Uint8Array(16)));

/** The sealed part's bytes: the same JSON, field order and limits as the wallet's sealedToBytes. */
export const sealedBytes = ({ subject, body }) =>
  Array.from(new TextEncoder().encode(JSON.stringify({ subject: String(subject).slice(0, SUBJECT_MAX), body: String(body).slice(0, BODY_MAX) })));

/** "12 November 2026": the letter is read later and elsewhere, so the year is always there. */
const longDay = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * The words of the letter. `sender` is the sender's $handle, or a short key when the page doesn't know it.
 * The link sits on a line of its own: from a sender the recipient hasn't trusted yet, bWalletX shows links as
 * plain text to copy, and a full stop straight after it would be copied too.
 */
export function noticeText({ sender, name, size, url, expiresAt }) {
  return {
    subject: `${sender} sent you a file`,
    body: `${name} (${size}) is waiting for you on bDriveX.\n\nOpen it with your bWalletX:\n${url}\n\nThe link works until ${longDay(expiresAt)}. Only your wallet can open it.`,
  };
}

/** Seal a letter with the sender's wallet. Returns the envelope, ready for the relay. */
export async function sealNotice(wallet, { from, to, subject, body, id = newMessageId(), at = Date.now() }) {
  from = String(from || '').toLowerCase();
  to = String(to || '').toLowerCase();
  if (!KEY.test(from) || !KEY.test(to)) throw new Error('A bMail needs both identity keys.');
  const { ciphertext } = await wallet.encrypt({ plaintext: sealedBytes({ subject, body }), protocolID: BMAIL_PROTOCOL, keyID: id, counterparty: to });
  return { t: 'bmail', v: 1, id, from, to, at, sealed: b64(ciphertext) };
}

/**
 * Ask the wallet for the relay sign-in permissions now, beside the file-key wrap and the letter's seal, so a
 * wallet that merges requests arriving together (bWalletX: one sheet per action) shows them on one sheet instead of
 * one sheet after another while the letter is on its way. A public-key lookup under each protocol asks for the
 * permission without signing or revealing anything; the result is thrown away. Never throws.
 */
export const askAlongside = (wallet) => Promise.allSettled([
  wallet.getPublicKey({ protocolID: AUTH_NONCE, keyID: '1', counterparty: 'self' }),
  wallet.getPublicKey({ protocolID: AUTH_SIGNATURE, keyID: '1', counterparty: RELAY_KEY }),
]);

let client = null;
/** The vendored MessageBox client (js/vendor/message-box-client.js), fetched the first time it is needed. */
export const loadClient = () => (client ||= import('./vendor/message-box-client.js').catch((e) => { client = null; throw e; }));

/** Hand a sealed letter to the relay, signed in as the sender's wallet (BRC-103). Resolves when the relay has it. */
export async function deliver(wallet, env, { host = BMAIL_HOST } = {}) {
  const body = JSON.stringify(env);
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) throw new Error('This bMail is too large to send.');
  const { MessageBoxClient } = await loadClient();
  const mb = new MessageBoxClient({ walletClient: wallet, host });
  return mb.sendMessage({ recipient: env.to, messageBox: BMAIL_BOX, body, skipEncryption: true, messageId: env.id }, host);
}
