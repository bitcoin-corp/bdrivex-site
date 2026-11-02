// Where the storage API lives. Local dev talks to bdrivex-api on 127.0.0.1:8787.
const local = /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
export const API = local ? 'http://127.0.0.1:8787' : 'https://files.bdrivex.com';
export const SITE = location.origin;
