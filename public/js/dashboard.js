'use strict';
/* ── NeuraDeskApp Dashboard ─────────────────────────────────── */

const API = '';  // relative URLs

let currentUser = null;
let widgets = [];
let currentWidget = null;
let currentTab = 'settings';
let suggestedQuestions = [];

/* ── Auth Helpers ────────────────────────────────────────────── */
function getToken() { return localStorage.getItem('nd_token'); }

async function apiFetch(url, opts = {}) {
  const res = await fetch(API + url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${getToken()}`,
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) { logout(); return; }
  return res;
}

function logout() {
  localStorage.removeItem('nd_token');
  localStorage.removeItem('nd_user');
  window.location.href = '/';
}

/* ── Init ─────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  if (!getToken()) { window.location.href = '/'; return; }

  const saved = localStorage.getItem('nd_user');
  if (saved) {
    currentUser = JSON.parse(saved);
    renderUserInfo();
  }

  // Check subscription; redirect to onboarding if inactive
  try {
    const sr = await apiFetch('/api/stripe/status');
    if (sr) {
      const sdata = await sr.json();
      if (!sdata.active) { window.location.href = '/onboarding'; return; }
      renderBillingButton();
    }
  } catch { /* allow access on network error */ }

  loadWidgets();
});

function renderBillingButton() {
  const footer = document.getElementById('sidebar-footer');
  if (!footer) return;
  // Avoid duplicate
  if (footer.querySelector('.btn-billing')) return;
  const btn = document.createElement('button');
  btn.className = 'btn btn-secondary btn-billing';
  btn.style.cssText = 'width:100%;margin-bottom:0.5rem;font-size:0.8rem';
  btn.textContent = '💳 Spravovať predplatné';
  btn.onclick = openBillingPortal;
  footer.insertBefore(btn, footer.firstChild);
}

async function openBillingPortal() {
  try {
    const r = await apiFetch('/api/stripe/portal', { method: 'POST' });
    if (!r) return;
    const data = await r.json();
    if (data.url) window.location.href = data.url;
  } catch {
    alert('Nepodarilo sa otvoriť fakturačný portál.');
  }
}

function renderUserInfo() {
  if (!currentUser) return;
  document.getElementById('user-name').textContent = currentUser.name;
  document.getElementById('user-email').textContent = currentUser.email;
  document.getElementById('user-avatar').textContent = (currentUser.name || '?')[0].toUpperCase();
}

/* ── Views ─────────────────────────────────────────────────────── */
function showView(view) {
  document.getElementById('view-widgets').style.display = view === 'widgets' ? '' : 'none';
  document.getElementById('view-editor').style.display = view === 'editor' ? '' : 'none';
  document.getElementById('widget-nav-section').style.display = view === 'editor' ? '' : 'none';

  document.getElementById('nav-widgets').classList.toggle('active', view === 'widgets');

  if (view === 'widgets') {
    document.getElementById('topbar-title').textContent = 'Moje widgety';
    document.getElementById('topbar-actions').innerHTML =
      '<button class="btn btn-primary" onclick="openCreateWidgetModal()">+ Nový widget</button>';
  }
}

function showTab(tab) {
  currentTab = tab;
  ['settings','knowledge','questions','embed'].forEach(t => {
    document.getElementById(`tab-${t}`).classList.toggle('active', t === tab);
    const nav = document.getElementById(`nav-${t}`);
    if (nav) nav.classList.toggle('active', t === tab);
  });

  if (tab === 'knowledge') loadKnowledge();
  if (tab === 'embed') loadEmbedCode();
}

/* ── Widgets List ─────────────────────────────────────────────── */
async function loadWidgets() {
  document.getElementById('widget-list-loading').style.display = '';
  document.getElementById('widget-grid').style.display = 'none';
  document.getElementById('widget-empty').style.display = 'none';

  const res = await apiFetch('/api/widgets');
  if (!res) return;
  widgets = await res.json();

  document.getElementById('widget-list-loading').style.display = 'none';

  if (widgets.length === 0) {
    document.getElementById('widget-empty').style.display = '';
    return;
  }

  const grid = document.getElementById('widget-grid');
  grid.innerHTML = '';
  grid.style.display = 'grid';

  widgets.forEach(w => {
    const card = document.createElement('div');
    card.className = 'widget-card';
    card.innerHTML = `
      <div class="widget-card-header">
        <div>
          <div class="widget-card-name">${esc(w.name)}</div>
          <div class="widget-card-meta">🤖 ${esc(w.bot_name)} &nbsp;·&nbsp; 📚 ${w.knowledge_count || 0} dokumentov</div>
        </div>
        <div class="widget-dot ${w.active ? 'active' : 'inactive'}" title="${w.active ? 'Aktívny' : 'Neaktívny'}"></div>
      </div>
      <div class="widget-card-actions">
        <button class="btn btn-sm btn-primary" onclick="openWidget('${w.id}')">Upraviť</button>
        <button class="btn btn-sm btn-secondary" onclick="copyEmbedForWidget('${w.id}')">📋 Embed</button>
        <button class="btn btn-sm btn-danger" onclick="deleteWidget('${w.id}', event)">Zmazať</button>
      </div>
    `;
    grid.appendChild(card);
  });
}

async function openWidget(widgetId) {
  const res = await apiFetch(`/api/widgets/${widgetId}`);
  if (!res) return;
  currentWidget = await res.json();

  suggestedQuestions = [...(currentWidget.suggested_questions || [])];

  // Populate settings form
  document.getElementById('s-name').value = currentWidget.name;
  document.getElementById('s-bot-name').value = currentWidget.bot_name;
  document.getElementById('s-welcome').value = currentWidget.welcome_message;
  document.getElementById('s-color').value = currentWidget.primary_color;
  document.getElementById('s-goals').value = currentWidget.goals || '';
  document.getElementById('s-active').value = currentWidget.active ? '1' : '0';
  updateColorPreview(currentWidget.primary_color);

  // Populate CTA
  document.getElementById('cta-type').value = currentWidget.cta_type || 'none';
  const cc = currentWidget.cta_config || {};
  document.getElementById('cta-phone').value = cc.phone || '';
  document.getElementById('cta-text').value = cc.text || '';
  document.getElementById('cta-btn-label').value = cc.label || 'Zanechajte kontakt';
  updateCtaFields();

  // Render suggested questions
  renderQuestions();

  document.getElementById('topbar-title').textContent = currentWidget.name;
  document.getElementById('topbar-actions').innerHTML = `
    <button class="btn btn-secondary" onclick="showView('widgets');loadWidgets()">← Späť</button>
  `;

  showView('editor');
  showTab('settings');
}

/* ── Create Widget ─────────────────────────────────────────────── */
function openCreateWidgetModal() {
  document.getElementById('new-widget-name').value = '';
  document.getElementById('new-bot-name').value = 'Asistent';
  document.getElementById('modal-create').style.display = 'flex';
  setTimeout(() => document.getElementById('new-widget-name').focus(), 50);
}

function closeModal(event) {
  if (event.target === event.currentTarget) {
    event.currentTarget.style.display = 'none';
  }
}

async function createWidget() {
  const name = document.getElementById('new-widget-name').value.trim();
  const botName = document.getElementById('new-bot-name').value.trim();
  if (!name) { showToast('Zadajte názov widgetu.', 'error'); return; }

  const res = await apiFetch('/api/widgets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, bot_name: botName || 'Asistent' }),
  });
  if (!res) return;
  const widget = await res.json();
  if (res.ok) {
    document.getElementById('modal-create').style.display = 'none';
    showToast('Widget vytvorený!', 'success');
    await openWidget(widget.id);
  } else {
    showToast(widget.error || 'Chyba pri vytváraní widgetu.', 'error');
  }
}

/* ── Delete Widget ─────────────────────────────────────────────── */
async function deleteWidget(widgetId, event) {
  event.stopPropagation();
  if (!confirm('Naozaj chcete zmazať tento widget? Táto akcia je nevratná.')) return;

  const res = await apiFetch(`/api/widgets/${widgetId}`, { method: 'DELETE' });
  if (res && res.ok) {
    showToast('Widget zmazaný.', 'success');
    loadWidgets();
  } else {
    showToast('Chyba pri mazaní widgetu.', 'error');
  }
}

/* ── Save Settings ─────────────────────────────────────────────── */
async function saveSettings() {
  if (!currentWidget) return;
  const body = {
    name: document.getElementById('s-name').value.trim(),
    bot_name: document.getElementById('s-bot-name').value.trim(),
    welcome_message: document.getElementById('s-welcome').value.trim(),
    primary_color: document.getElementById('s-color').value,
    goals: document.getElementById('s-goals').value.trim(),
    active: document.getElementById('s-active').value === '1',
  };
  if (!body.name) { showToast('Názov widgetu je povinný.', 'error'); return; }

  const res = await apiFetch(`/api/widgets/${currentWidget.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res && res.ok) {
    currentWidget = await res.json();
    document.getElementById('topbar-title').textContent = currentWidget.name;
    showToast('Nastavenia uložené!', 'success');
  } else {
    showToast('Chyba pri ukladaní.', 'error');
  }
}

/* ── Color Picker ─────────────────────────────────────────────── */
function updateColorPreview(color) {
  document.getElementById('color-preview').style.background = color;
  document.getElementById('color-hex').textContent = color;
}

/* ── Knowledge Base ─────────────────────────────────────────────── */
async function loadKnowledge() {
  if (!currentWidget) return;
  const res = await apiFetch(`/api/knowledge/${currentWidget.id}`);
  if (!res) return;
  const items = await res.json();
  renderKnowledgeList(items);
}

function renderKnowledgeList(items) {
  const container = document.getElementById('knowledge-list');
  if (!items.length) {
    container.innerHTML = `<div class="empty-state" style="padding:1.5rem"><p>Zatiaľ žiadne dokumenty.</p></div>`;
    return;
  }
  container.innerHTML = `<div class="knowledge-list">${items.map(item => `
    <div class="knowledge-item">
      <div class="knowledge-icon">${item.source_type === 'pdf' ? '📄' : '📝'}</div>
      <div class="knowledge-info">
        <div class="knowledge-title">${esc(item.title)}</div>
        <div class="knowledge-preview">${esc(item.preview || '')}</div>
        <div class="knowledge-meta">${item.char_count?.toLocaleString() || '?'} znakov · ${new Date(item.created_at * 1000).toLocaleDateString('sk-SK')}</div>
      </div>
      <button class="btn btn-sm btn-danger" onclick="deleteKnowledge('${item.id}')">Zmazať</button>
    </div>
  `).join('')}</div>`;
}

async function addTextKnowledge() {
  const title = document.getElementById('k-title').value.trim();
  const content = document.getElementById('k-content').value.trim();
  if (!title || !content) { showToast('Zadajte nadpis aj obsah.', 'error'); return; }

  const res = await apiFetch(`/api/knowledge/${currentWidget.id}/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, content }),
  });
  const data = await res.json();
  if (res.ok) {
    document.getElementById('k-title').value = '';
    document.getElementById('k-content').value = '';
    showToast('Dokument pridaný!', 'success');
    loadKnowledge();
  } else {
    showToast(data.error || 'Chyba.', 'error');
  }
}

async function uploadFile() {
  const fileInput = document.getElementById('k-file');
  const titleInput = document.getElementById('k-file-title');
  if (!fileInput.files.length) { showToast('Vyberte súbor.', 'error'); return; }

  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  if (titleInput.value.trim()) formData.append('title', titleInput.value.trim());

  const res = await fetch(`/api/knowledge/${currentWidget.id}/upload`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${getToken()}` },
    body: formData,
  });
  const data = await res.json();
  if (res.ok) {
    fileInput.value = '';
    titleInput.value = '';
    showToast('Súbor nahraný a spracovaný!', 'success');
    loadKnowledge();
  } else {
    showToast(data.error || 'Chyba pri nahrávaní.', 'error');
  }
}

async function deleteKnowledge(itemId) {
  if (!confirm('Zmazať tento dokument?')) return;
  const res = await apiFetch(`/api/knowledge/${currentWidget.id}/${itemId}`, { method: 'DELETE' });
  if (res && res.ok) {
    showToast('Dokument zmazaný.', 'success');
    loadKnowledge();
  }
}

/* ── Questions & CTA ─────────────────────────────────────────────── */
function renderQuestions() {
  const container = document.getElementById('questions-list');
  if (!suggestedQuestions.length) {
    container.innerHTML = '<div style="color:#94a3b8;font-size:0.875rem;padding:0.5rem 0;">Žiadne otázky. Pridajte prvú!</div>';
    return;
  }
  container.innerHTML = suggestedQuestions.map((q, i) => `
    <div class="question-item">
      <span class="question-text">${esc(q)}</span>
      <button class="question-remove" onclick="removeQuestion(${i})" title="Odstraniť">✕</button>
    </div>
  `).join('');
}

function addQuestion() {
  const input = document.getElementById('new-question');
  const val = input.value.trim();
  if (!val) return;
  if (suggestedQuestions.length >= 6) { showToast('Maximálne 6 otázok.', 'error'); return; }
  suggestedQuestions.push(val);
  input.value = '';
  renderQuestions();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.activeElement?.id === 'new-question') addQuestion();
});

function removeQuestion(index) {
  suggestedQuestions.splice(index, 1);
  renderQuestions();
}

function updateCtaFields() {
  const type = document.getElementById('cta-type').value;
  document.getElementById('cta-call-fields').style.display = type === 'call' ? '' : 'none';
  document.getElementById('cta-custom-fields').style.display = type === 'custom' ? '' : 'none';
  document.getElementById('cta-contact-fields').style.display = type === 'contact' ? '' : 'none';
}

async function saveQuestionsAndCta() {
  if (!currentWidget) return;
  const ctaType = document.getElementById('cta-type').value;
  const ctaConfig = {};
  if (ctaType === 'call') ctaConfig.phone = document.getElementById('cta-phone').value.trim();
  if (ctaType === 'custom') ctaConfig.text = document.getElementById('cta-text').value.trim();
  if (ctaType === 'contact') ctaConfig.label = document.getElementById('cta-btn-label').value.trim() || 'Zanechajte kontakt';

  const res = await apiFetch(`/api/widgets/${currentWidget.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      suggested_questions: suggestedQuestions,
      cta_type: ctaType,
      cta_config: ctaConfig,
    }),
  });
  if (res && res.ok) {
    currentWidget = await res.json();
    showToast('Otázky a CTA uložené!', 'success');
  } else {
    showToast('Chyba pri ukladaní.', 'error');
  }
}

/* ── Embed Code ─────────────────────────────────────────────────── */
async function loadEmbedCode() {
  if (!currentWidget) return;
  const res = await apiFetch(`/api/widgets/${currentWidget.id}/embed-code`);
  if (!res) return;
  const data = await res.json();
  document.getElementById('embed-code').textContent = data.code;

  // Render preview bubble
  const preview = document.getElementById('preview-bubble');
  preview.innerHTML = `
    <div style="
      width:56px;height:56px;border-radius:50%;
      background:${currentWidget.primary_color};
      display:flex;align-items:center;justify-content:center;
      cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.2);
      font-size:1.5rem;color:white;
    ">💬</div>
  `;
}

async function copyEmbedForWidget(widgetId) {
  const res = await apiFetch(`/api/widgets/${widgetId}/embed-code`);
  if (!res) return;
  const data = await res.json();
  navigator.clipboard.writeText(data.code).then(() => {
    showToast('Embed kód skopírovaný!', 'success');
  });
}

function copyEmbed() {
  const code = document.getElementById('embed-code').textContent;
  navigator.clipboard.writeText(code).then(() => {
    showToast('Skopírované!', 'success');
  });
}

/* ── Toast ─────────────────────────────────────────────────────── */
function showToast(msg, type = 'success') {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.4s'; }, 2500);
  setTimeout(() => t.remove(), 3000);
}

/* ── Utils ─────────────────────────────────────────────────────── */
function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
