# vendor-bmail

Builds `js/vendor/message-box-client.js`, the MessageBox client `/send` uses to hand a bMail notice to
`https://messagebox.bwalletx.com` (see `js/bmail.js`). It also holds the dependencies of the local test relay
(`scripts/relay-stub.mjs`) used by `scripts/e2e-browser.mjs`. Nothing in this folder is served.

## Pinned versions

| Package | Version | Why |
|---|---|---|
| `@bsv/message-box-client` | 2.5.4 | the version bWalletX ships (bwalletX `package.json`), so both send through the same client |
| `@bsv/sdk` | 2.8.11 | the version bWalletX resolves; the only `@bsv/sdk` in the lockfile |
| `@bsv/authsocket-client` | 2.1.7 | message-box-client's own dependency, as bWalletX resolves it |
| `esbuild` | 0.28.2 | same as bdrivex-api's vendor build |
| `@bsv/auth-express-middleware` | 2.2.9 | tests only: the BRC-103 middleware the real relay (bwalletx-messagebox) runs |
| `express` | 5.1.0 | tests only |

Licences: the `@bsv/*` packages are under the Open BSV License (see each package's `LICENSE.txt`).

## Rebuild

```sh
cd scripts/vendor-bmail
pnpm install --frozen-lockfile
pnpm build        # writes ../../js/vendor/message-box-client.js
```

The build is reproducible: with this lockfile the output's SHA-256 is
`e4cea88db71975fc5aa3e6854f8fe2b9f010f51249e235f8b99c25584580d933` (686,221 bytes, 203,355 gzipped at -9).
`entry.js` exports only `MessageBoxClient`; most of the size is `@bsv/sdk` (wallet substrates and overlay
lookup the client constructs), which esbuild cannot shake out.

## Loading

`/send` never loads it up front. `js/bmail.js` imports it the first time a sender leaves "Tell … in bMail" ticked,
from the same origin, so the page's `script-src 'self'` covers it.
