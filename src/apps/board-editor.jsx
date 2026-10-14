// Tabuľa Neoworkly: Excalidraw (MIT) + spolupráca v reálnom čase cez /yjs (y-websocket).
// Prvky: Y.Map „elements“ (id → prvok, zlučuje sa podľa verzie cez reconcileElements), obrázky: Y.Map „files“,
// kurzory a výber kolegov cez awareness. Zostavenie: npm run build:apps → public/apps/board/board-editor.js
import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { Excalidraw, CaptureUpdateAction, reconcileElements, exportToBlob, MainMenu } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';

window.EXCALIDRAW_ASSET_PATH = `${location.origin}/apps/excalidraw/`; // písma z nášho servera (čínske z CDN iba pri potrebe)

const token = (() => { try { return localStorage.getItem('nd_token'); } catch { return null; } })();
const id = location.pathname.split('/').filter(Boolean).pop();
const ws = new URLSearchParams(location.search).get('ws') || '';
const $ = sel => document.querySelector(sel);
const MAX_FILE = 3 * 1024 * 1024; // obrázok v tabuli (dataURL) – väčšie patria na Disk

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
const hue = s => [...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
const initials = n => String(n || '?').split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase();
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.style.display = 'block';
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.style.display = 'none'; }, 2600);
}

function Board({ meta, ydoc, provider }) {
  const [api_, setApi] = useState(null);
  const versions = useRef(new Map()); // id prvku → verzia, ktorú už pozná Yjs
  const readonly = meta.role === 'readonly';
  const yEls = ydoc.getMap('elements');
  const yFiles = ydoc.getMap('files');

  // Počiatočný stav zo servera
  const [initial] = useState(() => {
    const elements = [...yEls.values()].filter(Boolean);
    elements.forEach(el => versions.current.set(el.id, el.version));
    return { elements, files: Object.fromEntries(yFiles.entries()), appState: { theme: 'dark', viewBackgroundColor: '#ffffff', currentItemFontFamily: 5 }, scrollToContent: true };
  });

  // Zmeny od kolegov → scéna
  useEffect(() => {
    if (!api_) return undefined;
    const onEls = (event, tx) => {
      if (tx.local) return;
      const remote = [];
      event.changes.keys.forEach((change, key) => { const el = yEls.get(key); if (el) remote.push(el); });
      if (!remote.length) return;
      const merged = reconcileElements(api_.getSceneElementsIncludingDeleted(), remote, api_.getAppState());
      remote.forEach(el => versions.current.set(el.id, Math.max(versions.current.get(el.id) || 0, el.version)));
      api_.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
    };
    const onFiles = (event, tx) => {
      if (tx.local) return;
      const add = [];
      event.changes.keys.forEach((c, key) => { const f = yFiles.get(key); if (f) add.push(f); });
      if (add.length) api_.addFiles(add);
    };
    yEls.observe(onEls);
    yFiles.observe(onFiles);
    // Kurzory a výber kolegov
    const onAwareness = () => {
      const collaborators = new Map();
      provider.awareness.getStates().forEach((s, clientId) => {
        if (clientId === ydoc.clientID || !s.user) return;
        const h = hue(s.user.id);
        collaborators.set(String(clientId), {
          username: s.user.name, pointer: s.pointer, button: s.button || 'up', selectedElementIds: s.selected || {},
          color: { background: `hsl(${h} 70% 92%)`, stroke: `hsl(${h} 60% 45%)` }, id: s.user.id,
        });
      });
      api_.updateScene({ collaborators });
      const seen = new Map();
      provider.awareness.getStates().forEach(s => { if (s.user) seen.set(s.user.id, s.user); });
      $('#people').innerHTML = [...seen.values()].map(u => `<span title="${u.name.replace(/"/g, '')}" style="background:hsl(${hue(u.id)} 55% 45%)">${initials(u.name)}</span>`).join('');
    };
    provider.awareness.on('change', onAwareness);
    onAwareness();
    return () => { yEls.unobserve(onEls); yFiles.unobserve(onFiles); provider.awareness.off('change', onAwareness); };
  }, [api_]);

  // Uloženie obrázka tabule na Disk (priečinok Tabule) – dá sa poslať v chate, priložiť k úlohe…
  useEffect(() => {
    if (!api_) return;
    $('#toDrive').onclick = async () => {
      const els = api_.getSceneElements();
      if (!els.length) return toast('Tabuľa je prázdna.');
      try {
        const blob = await exportToBlob({ elements: els, files: api_.getFiles(), appState: { ...api_.getAppState(), exportBackground: true, exportWithDarkMode: false }, mimeType: 'image/png' });
        const fd = new FormData();
        fd.append('files', new File([blob], `${(meta.title || 'tabula').replace(/[\\/:*?"<>|]/g, '_')}.png`, { type: 'image/png' }));
        const parent = meta.folderId ? `&parentId=${encodeURIComponent(meta.folderId)}` : '';
        await api('POST', `/api/drive/files${parent.replace('&', '?')}`, fd);
        toast('Obrázok uložený na Disk.');
      } catch (e) { toast(e.message || 'Uloženie zlyhalo.'); }
    };
  }, [api_]);

  // Lokálne zmeny → Yjs (iba prvky s novou verziou)
  const onChange = (elements, appState, files) => {
    if (readonly) return;
    const changed = elements.filter(el => versions.current.get(el.id) !== el.version);
    const newFiles = Object.values(files || {}).filter(f => !yFiles.has(f.id) && (f.dataURL || '').length < MAX_FILE * 1.37);
    if (!changed.length && !newFiles.length) return;
    ydoc.transact(() => {
      changed.forEach(el => { yEls.set(el.id, el); versions.current.set(el.id, el.version); });
      newFiles.forEach(f => yFiles.set(f.id, { id: f.id, mimeType: f.mimeType, dataURL: f.dataURL, created: f.created }));
    });
    const big = Object.values(files || {}).find(f => !yFiles.has(f.id) && (f.dataURL || '').length >= MAX_FILE * 1.37);
    if (big) toast('Obrázok je príliš veľký (max. 3 MB) – kolegovia ho neuvidia. Väčšie súbory dajte na Disk.');
    const sel = appState.selectedElementIds || {};
    const cur = provider.awareness.getLocalState()?.selected || {};
    if (Object.keys(sel).join() !== Object.keys(cur).join()) provider.awareness.setLocalStateField('selected', sel);
  };
  const onPointerUpdate = ({ pointer, button }) => {
    const now = Date.now();
    if (now - (onPointerUpdate.t || 0) < 40) return;
    onPointerUpdate.t = now;
    provider.awareness.setLocalStateField('pointer', { x: pointer.x, y: pointer.y, tool: pointer.tool || 'pointer' });
    provider.awareness.setLocalStateField('button', button);
  };

  return (
    <Excalidraw
      excalidrawAPI={setApi} initialData={initial} onChange={onChange} onPointerUpdate={onPointerUpdate}
      isCollaborating viewModeEnabled={readonly} theme="dark" langCode="sk-SK" name={meta.title}
      UIOptions={{ canvasActions: { loadScene: false, clearCanvas: !readonly, saveToActiveFile: false, toggleTheme: true, export: { saveFileToDisk: true } } }}>
      <MainMenu>
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.DefaultItems.Export />
        {!readonly && <MainMenu.DefaultItems.ClearCanvas />}
        <MainMenu.DefaultItems.ToggleTheme />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
        <MainMenu.DefaultItems.Help />
      </MainMenu>
    </Excalidraw>
  );
}

function App({ meta }) {
  const [state] = useState(() => {
    const doc = new Y.Doc();
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/yjs`;
    const p = new WebsocketProvider(url, meta.room, doc, { params: { ticket: meta.ticket }, disableBc: true });
    p.awareness.setLocalStateField('user', { id: meta.me.id, name: meta.me.name || 'Ja' });
    return { ydoc: doc, provider: p };
  });
  const [ready, setReady] = useState(false);
  const { ydoc, provider } = state;

  useEffect(() => {
    const status = $('#status');
    provider.on('status', e => { status.textContent = e.status === 'connected' ? (meta.role === 'readonly' ? 'Iba na prezeranie' : 'Uložené automaticky') : 'Pripájam…'; });
    provider.on('sync', synced => { if (synced) setReady(true); });
    const refresh = setInterval(async () => { try { provider.params.ticket = await ticket(); } catch { /* skúsi neskôr */ } }, 45 * 1000);
    return () => { clearInterval(refresh); provider.destroy(); ydoc.destroy(); };
  }, []);

  if (!ready) return <p className="msg">Načítavam tabuľu…</p>;
  return <Board meta={meta} ydoc={ydoc} provider={provider} />;
}

async function start() {
  if (!token) { location.href = '/'; return; }
  try {
    const meta = await api('GET', `/api/boards/${encodeURIComponent(id)}`);
    meta.ticket = await ticket();
    document.title = `${meta.title} – Neoworkly`;
    const title = $('#title');
    title.value = meta.title;
    title.disabled = meta.role === 'readonly';
    let t;
    title.oninput = () => { clearTimeout(t); t = setTimeout(() => api('PATCH', `/api/boards/${id}`, { title: title.value }).then(d => { meta.title = d.title; document.title = `${d.title} – Neoworkly`; }).catch(() => {}), 600); };
    $('.back').href = `/dashboard?view=boards&ws=${encodeURIComponent(meta.ownerId)}`;
    if (meta.role === 'readonly') $('#toDrive').style.display = 'none';
    createRoot($('#board')).render(<App meta={meta} />);
  } catch (e) {
    $('#board').innerHTML = `<p class="msg">${e.message === '401' ? '' : 'Tabuľa sa nenašla alebo k nej nemáte prístup.'}</p>`;
    $('#status').textContent = '';
  }
}
start();
