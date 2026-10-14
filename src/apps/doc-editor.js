// Editor dokumentov Neoworkly: BlockNote (MPL-2.0) + spolupráca v reálnom čase cez /yjs (y-websocket).
// Zostavenie: npm run build:apps → public/apps/doc-editor.js
import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { CollaborationExtension } from '@blocknote/core/yjs';
import { sk } from '@blocknote/core/locales';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';

const token = (() => { try { return localStorage.getItem('nd_token'); } catch { return null; } })();
const id = location.pathname.split('/').filter(Boolean).pop();
const ws = new URLSearchParams(location.search).get('ws') || '';
const $ = sel => document.querySelector(sel);

// Farby dizajnového systému Neoworkly (tmavá téma)
const theme = {
  colors: {
    editor: { text: '#eeeef5', background: '#0d0d18' },
    menu: { text: '#eeeef5', background: '#18182a' },
    tooltip: { text: '#eeeef5', background: '#111120' },
    hovered: { text: '#eeeef5', background: '#24243a' },
    selected: { text: '#ffffff', background: '#5b4fff' },
    disabled: { text: '#7e7ea0', background: '#18182a' },
    shadow: 'rgba(0,0,0,0.5)',
    border: 'rgba(255,255,255,0.1)',
    sideMenu: '#7e7ea0',
  },
  borderRadius: 8,
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
};

async function api(method, path, body) {
  const r = await fetch(`${path}${path.includes('?') ? '&' : '?'}ws=${encodeURIComponent(ws)}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { location.href = '/'; throw new Error('401'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Chyba');
  return d;
}
const ticket = async () => (await api('POST', '/api/realtime/ticket')).ticket;
const colorFor = s => `hsl(${[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % 360} 60% 55%)`;
const initials = n => String(n || '?').split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase();

function download(name, type, content) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Word → bloky BlockNote (nahradí obsah alebo pridá na koniec). */
async function importDocx(editor, bufferPromise, silent) {
  try {
    const { fromDocx } = await import('./lib/docx-io.js');
    const blocks = await editor.tryParseHTMLToBlocks(await fromDocx(await bufferPromise));
    const empty = editor.document.length <= 1 && !(editor.document[0]?.content || []).length;
    if (empty || (!silent && confirm('Nahradiť obsah dokumentu? (Zrušiť = pridať na koniec)'))) editor.replaceBlocks(editor.document, blocks);
    else editor.insertBlocks(blocks, editor.document[editor.document.length - 1], 'after');
  } catch (e) { alert(`Import zlyhal: ${e.message}`); }
}

function Editor({ meta, ydoc, provider }) {
  const editor = useCreateBlockNote({
    dictionary: sk,
    extensions: [CollaborationExtension({
      fragment: ydoc.getXmlFragment('document-store'),
      user: { name: meta.me.name || 'Ja', color: colorFor(meta.me.id) },
      provider,
      showCursorLabels: 'activity',
    })],
  }, [ydoc]);

  useEffect(() => {
    const safe = (meta.title || 'dokument').replace(/[\\/:*?"<>|]/g, '_');
    const menu = $('#menu');
    $('#exportBtn').onclick = e => { e.stopPropagation(); menu.style.display = menu.style.display === 'block' ? 'none' : 'block'; };
    document.addEventListener('click', () => { menu.style.display = 'none'; });
    menu.querySelectorAll('[data-export]').forEach(b => {
      b.onclick = async () => {
        if (b.dataset.export === 'md') download(`${safe}.md`, 'text/markdown', await editor.blocksToMarkdownLossy());
        if (b.dataset.export === 'html') download(`${safe}.html`, 'text/html', `<!DOCTYPE html><html lang="sk"><head><meta charset="UTF-8"><title>${safe}</title></head><body>${await editor.blocksToFullHTML()}</body></html>`);
        if (b.dataset.export === 'pdf') window.print();
        if (b.dataset.export === 'docx' || b.dataset.export === 'docx-drive') {
          const { toDocx } = await import('./lib/docx-io.js');
          const blob = await toDocx(meta.title, editor.document);
          if (b.dataset.export === 'docx') download(`${safe}.docx`, blob.type, blob);
          else {
            const fd = new FormData();
            fd.append('files', new File([blob], `${safe}.docx`, { type: blob.type }));
            await api('POST', `/api/drive/files${meta.folderId ? `?parentId=${encodeURIComponent(meta.folderId)}` : ''}`, fd).then(() => alert('Súbor .docx uložený na Disk.')).catch(e => alert(e.message));
          }
        }
        if (b.dataset.export === 'import-docx') {
          const inp = document.createElement('input');
          inp.type = 'file';
          inp.accept = '.docx';
          inp.onchange = () => inp.files[0] && importDocx(editor, inp.files[0].arrayBuffer());
          inp.click();
        }
      };
    });
    // Otvorené z Disku ako nový dokument: /docs/:id?importDrive=<súbor .docx>
    const fromDrive = new URLSearchParams(location.search).get('importDrive');
    if (fromDrive && meta.role !== 'readonly') {
      history.replaceState(null, '', location.pathname + `?ws=${encodeURIComponent(ws)}`);
      api('GET', `/api/drive/items/${encodeURIComponent(fromDrive)}/url`).then(u => fetch(u.url)).then(r => importDocx(editor, r.arrayBuffer(), true)).catch(e => alert(e.message));
    }
  }, [editor]);

  return <BlockNoteView editor={editor} editable={meta.role !== 'readonly'} theme={theme} />;
}

function App({ meta }) {
  const { ydoc, provider } = useMemo(() => {
    const doc = new Y.Doc();
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/yjs`;
    const p = new WebsocketProvider(url, meta.room, doc, { params: { ticket: meta.ticket }, disableBc: true });
    return { ydoc: doc, provider: p };
  }, [meta.room]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const status = $('#status');
    provider.on('status', e => { status.textContent = e.status === 'connected' ? (meta.role === 'readonly' ? 'Iba na čítanie' : 'Uložené automaticky') : 'Pripájam…'; });
    provider.on('sync', synced => { if (synced) setReady(true); });
    // Lístok platí krátko: pred každým novým pripojením si ho obnov
    const refresh = setInterval(async () => {
      try { provider.params.ticket = await ticket(); } catch { /* skúsi neskôr */ } // provider.url sa skladá z params
    }, 45 * 1000);
    // Kto je v dokumente
    const people = () => {
      const seen = new Map();
      provider.awareness.getStates().forEach(s => { if (s.user) seen.set(s.user.name, s.user); });
      $('#people').innerHTML = [...seen.values()].map(u => `<span title="${u.name.replace(/"/g, '')}" style="background:${u.color}">${initials(u.name)}</span>`).join('');
    };
    provider.awareness.on('change', people);
    return () => { clearInterval(refresh); provider.destroy(); ydoc.destroy(); };
  }, [provider]);

  if (!ready) return <p className="msg">Načítavam dokument…</p>;
  return <Editor meta={meta} ydoc={ydoc} provider={provider} />;
}

async function start() {
  if (!token) { location.href = '/'; return; }
  try {
    const meta = await api('GET', `/api/docs/${encodeURIComponent(id)}`);
    meta.ticket = await ticket();
    document.title = `${meta.title} – Neoworkly`;
    const title = $('#title');
    title.value = meta.title;
    title.disabled = meta.role === 'readonly';
    let t;
    title.oninput = () => { clearTimeout(t); t = setTimeout(() => api('PATCH', `/api/docs/${id}`, { title: title.value }).then(d => { meta.title = d.title; document.title = `${d.title} – Neoworkly`; }).catch(() => {}), 600); };
    $('.back').href = `/dashboard?view=docs&ws=${encodeURIComponent(meta.ownerId)}`;
    createRoot($('#editor')).render(<App meta={meta} />);
  } catch (e) {
    $('#editor').innerHTML = `<p class="msg">${e.message === '401' ? '' : 'Dokument sa nenašiel alebo k nemu nemáte prístup.'}</p>`;
    $('#status').textContent = '';
  }
}
start();
