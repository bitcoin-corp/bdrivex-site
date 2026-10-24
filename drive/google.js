// Bring in Google Drive files with Google's own Picker and the non-sensitive `drive.file` scope.
// The user picks files in Google's window; bdrivex.com gets access to those files only, never the rest of the Drive.
// The access token lives in this tab's memory, is used to read the picked files' bytes (to fingerprint them here,
// in the browser) and is revoked as soon as the batch is read. Nothing from Drive goes to our server.
import { hashStream } from './sha256.js';

export const SCOPE = 'https://www.googleapis.com/auth/drive.file';
/** Google Docs/Sheets/Slides have no bytes of their own: we fingerprint an export instead (Drive caps exports at 10 MB). */
const EXPORT = {
  'application/vnd.google-apps.document': ['application/pdf', 'PDF export'],
  'application/vnd.google-apps.spreadsheet': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Excel export'],
  'application/vnd.google-apps.presentation': ['application/pdf', 'PDF export'],
  'application/vnd.google-apps.drawing': ['application/pdf', 'PDF export'],
};

const load = (src) => new Promise((ok, bad) => {
  if (document.querySelector(`script[src="${src}"]`)) return ok();
  const s = document.createElement('script'); s.src = src; s.async = true; s.onload = ok; s.onerror = () => bad(new Error('Google didn’t load. Check your connection and try again.'));
  document.head.appendChild(s);
});

let token = null;
/** Ask Google for drive.file access (Google's own consent window). */
async function getToken(cfg) {
  await load('https://accounts.google.com/gsi/client');
  return new Promise((ok, bad) => {
    const tc = window.google.accounts.oauth2.initTokenClient({
      client_id: cfg.clientId, scope: SCOPE, prompt: '',
      callback: (r) => { if (r && r.access_token) { token = r.access_token; ok(token); } else bad(new Error(r?.error === 'access_denied' ? 'Google didn’t give access, so nothing was brought in.' : 'Google sign-in didn’t finish. Try again.')); },
      error_callback: (e) => bad(new Error(e?.type === 'popup_closed' ? 'The Google window was closed, so nothing was brought in.' : e?.type === 'popup_failed_to_open' ? 'Your browser blocked Google’s window. Allow pop-ups for bdrivex.com and try again.' : 'Google sign-in didn’t finish. Try again.')),
    });
    tc.requestAccessToken();
  });
}

/** Open Google's Picker. Resolves to the picked docs ([] when cancelled). */
export async function pick(cfg) {
  await load('https://apis.google.com/js/api.js');
  await new Promise((ok) => window.gapi.load('picker', ok));
  const t = token || await getToken(cfg);
  const P = window.google.picker;
  return new Promise((ok) => {
    const view = new P.DocsView(P.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false).setMode(P.DocsViewMode.LIST);
    const picker = new P.PickerBuilder()
      .addView(view).addView(new P.DocsUploadView())
      .enableFeature(P.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(t).setDeveloperKey(cfg.apiKey).setAppId(cfg.appId)
      .setTitle('Pick files for bDriveX').setOrigin(location.origin)
      .setCallback((d) => {
        if (d.action === P.Action.PICKED) ok((d.docs || []).map((x) => ({ id: String(x.id), name: String(x.name || ''), mimeType: String(x.mimeType || ''), size: Number(x.sizeBytes) || 0, modifiedAt: x.lastEditedUtc ? new Date(Number(x.lastEditedUtc)).toISOString() : null, url: String(x.url || '') })));
        else if (d.action === P.Action.CANCEL) ok([]);
      })
      .build();
    picker.setVisible(true);
  });
}

/** Fingerprint one picked file: stream its bytes (or its export) from Drive into sha256. */
export async function fingerprint(doc, onBytes, signal) {
  if (!token) throw new Error('Google access ended. Press “From Google Drive” again.');
  const ex = EXPORT[doc.mimeType];
  if (!ex && doc.mimeType.startsWith('application/vnd.google-apps.')) throw new Error('This kind of Google item (a form, site or shortcut) has no file to fingerprint.');
  const url = ex
    ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(doc.id)}/export?mimeType=${encodeURIComponent(ex[0])}`
    : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(doc.id)}?alt=media`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal });
  if (r.status === 403 && ex) throw new Error('Google won’t export files bigger than 10 MB. Download it from Drive and add it with “Upload files”.');
  if (!r.ok || !r.body) throw new Error(`Drive didn’t send the file (${r.status}). Try again.`);
  const sha256 = await hashStream(r.body, onBytes, signal);
  return { sha256, fingerprintOf: ex ? ex[1] : null };
}

/** Let go of Google access straight away. */
export function revoke() {
  const t = token; token = null;
  try { if (t) window.google?.accounts?.oauth2?.revoke(t, () => {}); } catch {}
}
