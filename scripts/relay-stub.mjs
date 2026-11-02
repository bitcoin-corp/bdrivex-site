// A local stand-in for messagebox.bwalletx.com, for the headless tests ONLY. It speaks the real BRC-103 mutual auth
// (@bsv/auth-express-middleware, the same middleware the real relay runs) with a throwaway server key, and keeps
// messages in memory in the shape the real relay (bitcoin-corp/bwalletx-messagebox) stores and lists them:
//   POST /sendMessage   { message: { recipient, messageBox, messageId, body } } -> { status, results: [{ recipient, messageId }] }
//   POST /listMessages  { messageBox } -> { status, messages: [{ messageId, body: JSON {message: body}, sender, ... }] }
//   POST /acknowledgeMessage { messageIds }
//   GET  /limits        -> { status, maxBodyBytes }
// Test hooks (no auth, local only): GET /__sent (every message, raw), POST /__fail?on=1|0 (sendMessage answers 500).
// Deps come from scripts/vendor-bmail/node_modules (pnpm install there).
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const NM = join(here, 'vendor-bmail/node_modules');
const load = (p) => import(pathToFileURL(join(NM, p)).href);

export const MAX_BODY_BYTES = 64 * 1024;

export async function startRelay({ port = 0 } = {}) {
  const express = (await load('express/index.js')).default;
  const { createAuthMiddleware } = await load('@bsv/auth-express-middleware/dist/mod.mjs');
  const { PrivateKey, ProtoWallet } = await load('@bsv/sdk/dist/esm/mod.js');
  const serverKey = PrivateKey.fromRandom();
  const wallet = new ProtoWallet(serverKey);
  const identityKey = serverKey.toPublicKey().toString();
  const messages = []; // { messageId, messageBox, recipient, sender, body (stored JSON), acknowledged }
  const state = { fail: false, sendCalls: 0 };

  const app = express();
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', '*');
    res.header('Access-Control-Allow-Methods', '*');
    res.header('Access-Control-Expose-Headers', '*');
    res.header('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });
  app.use(express.json({ limit: MAX_BODY_BYTES * 2 + 16 * 1024 }));
  app.get('/limits', (_req, res) => res.json({ status: 'success', maxBodyBytes: MAX_BODY_BYTES }));
  app.get('/__sent', (_req, res) => res.json(messages));
  app.post('/__fail', (req, res) => { state.fail = req.query.on === '1'; res.json({ fail: state.fail }); });
  app.use(createAuthMiddleware({ wallet, allowUnauthenticated: false }));

  app.post('/sendMessage', (req, res) => {
    state.sendCalls++;
    const sender = req.auth?.identityKey;
    if (!sender || sender === 'unknown') return res.status(401).json({ status: 'error', code: 'ERR_AUTH_REQUIRED' });
    if (state.fail) return res.status(500).json({ status: 'error', code: 'ERR_INTERNAL', description: 'An internal error has occurred.' });
    const m = req.body?.message;
    if (!m || typeof m.messageBox !== 'string' || !m.messageBox.trim()) return res.status(400).json({ status: 'error', code: 'ERR_INVALID_MESSAGEBOX' });
    if (typeof m.body !== 'string' && (typeof m.body !== 'object' || m.body === null)) return res.status(400).json({ status: 'error', code: 'ERR_INVALID_MESSAGE_BODY' });
    if (typeof m.recipient !== 'string' || !/^0[23][0-9a-f]{64}$/i.test(m.recipient)) return res.status(400).json({ status: 'error', code: 'ERR_INVALID_RECIPIENT_KEY' });
    if (typeof m.messageId !== 'string' || !m.messageId) return res.status(400).json({ status: 'error', code: 'ERR_INVALID_MESSAGEID' });
    if (Buffer.byteLength(typeof m.body === 'string' ? m.body : JSON.stringify(m.body)) > MAX_BODY_BYTES) return res.status(413).json({ error: 'message too large' });
    if (!messages.some((x) => x.messageId === m.messageId)) {
      messages.push({ messageId: m.messageId, messageBox: m.messageBox, recipient: m.recipient, sender, body: JSON.stringify({ message: m.body }), acknowledged: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    }
    res.json({ status: 'success', message: 'Your message has been sent to 1 recipient(s).', results: [{ recipient: m.recipient, messageId: m.messageId }] });
  });
  app.post('/listMessages', (req, res) => {
    const me = req.auth?.identityKey;
    const box = req.body?.messageBox;
    res.json({ status: 'success', messages: messages.filter((x) => x.recipient === me && x.messageBox === box && !x.acknowledged).map(({ messageId, body, sender, created_at, updated_at }) => ({ messageId, body, sender, created_at, updated_at })) });
  });
  app.post('/acknowledgeMessage', (req, res) => {
    const me = req.auth?.identityKey;
    for (const x of messages) if (x.recipient === me && (req.body?.messageIds || []).includes(x.messageId)) x.acknowledged = true;
    res.json({ status: 'success' });
  });

  const server = createServer(app);
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, identityKey, messages, state, close: () => server.close() };
}
