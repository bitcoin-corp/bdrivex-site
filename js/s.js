// /s/:id#k=key: open a share link, download and decrypt in this browser. No wallet, nothing sent but the link id.
import { API } from './config.js';
import { downloadLink, openLink, parseShare } from './bdx-client.js';
import { $, bytes, day, eta, ext } from './ui.js';

const id = location.pathname.split('/')[2] || new URLSearchParams(location.search).get('id') || '';
const key = parseShare(location.hash);
let link = null, running = false;

function bad(h, p) {
  $('#loading').hidden = true;
  $('#file').hidden = true;
  $('#bad').hidden = false;
  $('#bad-h').textContent = h;
  $('#bad-p').textContent = p;
  document.title = `${h} · bDriveX`;
}

async function load() {
  if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return bad('This link doesn’t work', 'The address looks cut short. Ask the sender to send it again.');
  if (!key) return bad('This link is missing its key', 'The part after # was lost, so the file can’t be opened. Copy the whole link, or ask the sender for it again.');
  try {
    link = await openLink({ base: API, id, key });
  } catch (e) {
    if (e.status === 410) return bad('This link has expired', 'Ask the sender for a new one.');
    if (e.status === 404 && /report/.test(e.message)) return bad('This link was switched off', 'Someone reported it, so it’s switched off while we review it.');
    if (e.status === 404) return bad('This link was switched off', 'The sender switched it off or deleted the file. Ask them for a new one.');
    return bad('This link doesn’t work', e.message);
  }
  const m = link.meta;
  $('#loading').hidden = true;
  $('#file').hidden = false;
  $('#f-ext').textContent = ext(m.name);
  $('#f-name').textContent = m.name;
  $('#f-size').textContent = bytes(m.size);
  $('#f-sent').textContent = day(link.createdAt);
  $('#f-until').textContent = `until ${day(link.expiresAt)}`;
  $('#report').hidden = false;
  document.title = `${m.name} · bDriveX`;
}

// Up to 1 GB is gathered in memory and saved like any download. Bigger files stream straight to disk where the
// browser allows it (Chrome, Edge), so a 10 GB video doesn't have to fit in memory.
async function sinkFor(m) {
  if (m.size > 2 ** 30 && window.showSaveFilePicker) {
    const h = await showSaveFilePicker({ suggestedName: m.name });
    const w = await h.createWritable();
    return { write: (u8) => w.write(u8), close: () => w.close(), abort: () => w.abort(), disk: true };
  }
  const parts = [];
  return {
    write: (u8) => { parts.push(u8); },
    close: () => {
      const url = URL.createObjectURL(new Blob(parts, { type: m.type || 'application/octet-stream' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: m.name });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  };
}

async function download() {
  if (running || !link) return;
  running = true;
  const btn = $('#dl');
  btn.disabled = true;
  $('#done').hidden = true;
  $('#prog').hidden = false;
  $('#p-step').style.color = '';
  let sink;
  try {
    sink = await sinkFor(link.meta);
    const t0 = Date.now();
    $('#p-step').textContent = 'Downloading and decrypting · 0%';
    const { sha256 } = await downloadLink({
      base: API, id, link, sink,
      onProgress: ({ got, total }) => {
        const pc = Math.floor((got / total) * 100);
        $('#p-bar').style.width = pc + '%';
        $('#p-step').textContent = `Downloading and decrypting · ${pc}%`;
        $('#p-rate').textContent = eta(got, total, t0);
      },
    });
    $('#prog').hidden = true;
    $('#done').hidden = false;
    $('#sha').textContent = sha256;
    btn.hidden = true;
  } catch (e) {
    try { sink?.abort?.(); } catch {}
    if (e && e.name === 'AbortError') { $('#prog').hidden = true; }
    else { $('#p-step').innerHTML = ''; $('#p-step').textContent = (e && e.message) || 'The download stopped. Try again.'; $('#p-step').style.color = 'var(--bad)'; }
    btn.disabled = false;
    btn.textContent = 'Try again';
  } finally {
    running = false;
  }
}

async function report() {
  const b = $('#r-send'), done = $('#r-done');
  if (!$('#r-why').value) { done.textContent = 'Choose a reason first.'; done.hidden = false; return; }
  b.disabled = true;
  try {
    const r = await fetch(`${API}/v1/s/${encodeURIComponent(id)}/report`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: $('#r-why').value }),
    });
    if (!r.ok && r.status !== 404) throw new Error((await r.json().catch(() => null))?.error || 'That didn’t go through. Try again.');
    done.textContent = 'Thank you. The link is switched off and we’ll review it.';
    done.hidden = false;
    $('#dl').hidden = true;
    b.hidden = true;
  } catch (e) {
    done.textContent = e.message;
    done.hidden = false;
    b.disabled = false;
  }
}

$('#dl').onclick = download;
$('#r-send').onclick = report;
$('#again').onclick = () => { $('#dl').hidden = false; $('#dl').disabled = false; download(); };
load();
