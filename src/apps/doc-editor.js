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
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
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
      };
    });
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
