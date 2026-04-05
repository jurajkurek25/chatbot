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
  loadUsageBar();

  // Show toast if returning from credit purchase
  const params = new URLSearchParams(location.search);
  if (params.get('credits_added') === '1') {
    showToast('Kredity boli úspešne pridané!', 'success');
    window.history.replaceState({}, '', '/dashboard');
    loadUsageBar();
  }
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
  document.getElementById('view-leads').style.display = view === 'leads' ? '' : 'none';
  document.getElementById('view-affiliate').style.display = view === 'affiliate' ? '' : 'none';
  document.getElementById('widget-nav-section').style.display = view === 'editor' ? '' : 'none';

  document.getElementById('nav-widgets').classList.toggle('active', view === 'widgets');
  document.getElementById('nav-leads').classList.toggle('active', view === 'leads');
  document.getElementById('nav-affiliate').classList.toggle('active', view === 'affiliate');

  if (view === 'widgets') {
    document.getElementById('topbar-title').textContent = 'Moje widgety';
    document.getElementById('topbar-actions').innerHTML =
      '<button class="btn btn-primary" onclick="openCreateWidgetModal()">+ Nový widget</button>';
  }
  if (view === 'leads') {
    document.getElementById('topbar-title').textContent = 'Kontakty';
    document.getElementById('topbar-actions').innerHTML = '';
    loadLeads();
  }
  if (view === 'affiliate') {
    document.getElementById('topbar-title').textContent = 'Affiliate';
    document.getElementById('topbar-actions').innerHTML = '';
    loadAffiliateStatus();
  }
}

function showTab(tab) {
  currentTab = tab;
  ['settings','knowledge','questions','embed','products','instagram'].forEach(t => {
    document.getElementById(`tab-${t}`)?.classList.toggle('active', t === tab);
    document.getElementById(`nav-${t}`)?.classList.toggle('active', t === tab);
  });

  if (tab === 'knowledge') loadKnowledge();
  if (tab === 'embed') loadEmbedCode();
  if (tab === 'instagram') loadInstagramStatus();
  if (tab === 'products') loadProducts();
}

/* ── Widgets List ─────────────────────────────────────────────── */
async function loadWidgets() {
  document.getElementById('widget-list-loading').style.display = '';
  document.getElementById('widget-grid').style.display = 'none';
  document.getElementById('widget-empty').style.display = 'none';

  const res = await apiFetch('/api/widgets');
  if (!res) return;
  const wdata = await res.json();
  widgets = Array.isArray(wdata) ? wdata : (wdata.widgets || []);

  document.getElementById('widget-list-loading').style.display = 'none';

  // Update leads badge count in background
  if (widgets.length > 0) {
    let totalLeads = 0;
    await Promise.all(widgets.map(async w => {
      try {
        const r = await apiFetch(`/api/widgets/${w.id}/leads`);
        if (r) { const d = await r.json(); totalLeads += (d.leads || []).length; }
      } catch { /* ignore */ }
    }));
    updateLeadsBadge(totalLeads);
  }

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
  document.getElementById('s-proactive-enabled').checked = Boolean(currentWidget.proactive_enabled);
  document.getElementById('s-proactive-message').value = currentWidget.proactive_message || '';
  document.getElementById('s-proactive-delay').value = currentWidget.proactive_delay || 4;

  // Avatar preview
  const preview = document.getElementById('s-avatar-preview');
  if (preview) {
    if (currentWidget.avatar_url) {
      preview.innerHTML = `<img src="${currentWidget.avatar_url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    } else {
      preview.innerHTML = '🤖';
    }
  }

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
    proactive_enabled: document.getElementById('s-proactive-enabled').checked,
    proactive_message: document.getElementById('s-proactive-message').value.trim(),
    proactive_delay: parseInt(document.getElementById('s-proactive-delay').value) || 4,
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

/* ── Avatar Upload ────────────────────────────────────────────── */
async function uploadAvatar() {
  if (!currentWidget) return;
  const file = document.getElementById('s-avatar-file')?.files[0];
  if (!file) { showToast('Vyberte obrázok.', 'error'); return; }

  const formData = new FormData();
  formData.append('avatar', file);

  try {
    const r = await apiFetch(`/api/widgets/${currentWidget.id}/avatar`, {
      method: 'POST',
      body: formData,
    });
    if (!r) return;
    const data = await r.json();
    if (data.avatar_url) {
      currentWidget.avatar_url = data.avatar_url;
      const preview = document.getElementById('s-avatar-preview');
      if (preview) preview.innerHTML = `<img src="${data.avatar_url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
      showToast('Avatar bol nahratý.');
    } else {
      showToast(data.error || 'Chyba.', 'error');
    }
  } catch {
    showToast('Chyba pri nahrávaní.', 'error');
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
/* ── Leads / Contacts ──────────────────────────────────────────── */
let allLeads = [];

async function loadLeads() {
  document.getElementById('leads-loading').style.display = '';
  document.getElementById('leads-empty').style.display = 'none';
  document.getElementById('leads-list').innerHTML = '';

  // Populate widget filter if not done yet
  const filterEl = document.getElementById('leads-widget-filter');
  if (filterEl.options.length === 1 && widgets.length > 0) {
    widgets.forEach(w => {
      const opt = document.createElement('option');
      opt.value = w.id;
      opt.textContent = w.name || w.bot_name;
      filterEl.appendChild(opt);
    });
  }

  const selectedWidget = filterEl?.value;
  const targetWidgets = selectedWidget
    ? [{ id: selectedWidget }]
    : widgets;

  allLeads = [];
  for (const w of targetWidgets) {
    try {
      const r = await apiFetch(`/api/widgets/${w.id}/leads`);
      if (!r) continue;
      const data = await r.json();
      if (data.leads) {
        allLeads.push(...data.leads.map(l => ({ ...l, widgetId: w.id, widgetName: w.name || w.bot_name })));
      }
    } catch { /* skip */ }
  }

  // Sort newest first
  allLeads.sort((a, b) => b.created_at - a.created_at);

  document.getElementById('leads-loading').style.display = 'none';

  if (allLeads.length === 0) {
    document.getElementById('leads-empty').style.display = '';
    updateLeadsBadge(0);
    return;
  }

  updateLeadsBadge(allLeads.length);
  renderLeads();
}

const STATUS_LABELS = {
  new:       { label: '🔵 Nový',         cls: 'status-new' },
  contacted: { label: '🟡 Kontaktovaný', cls: 'status-contacted' },
  closed:    { label: '🟢 Uzavretý',     cls: 'status-closed' },
};

function filterLeadsByStatus() {
  renderLeads();
}

function renderLeads() {
  const statusFilter = document.getElementById('leads-status-filter')?.value || '';
  const filtered = statusFilter ? allLeads.filter(l => l.status === statusFilter) : allLeads;

  const container = document.getElementById('leads-list');

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding:2rem"><p>Žiadne kontakty pre zvolený filter.</p></div>';
    return;
  }

  container.innerHTML = filtered.map(lead => {
    const initials = (lead.name || '?').split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
    const date = new Date(lead.created_at * 1000).toLocaleString('sk-SK', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
    const status = lead.status || 'new';
    const statusInfo = STATUS_LABELS[status] || STATUS_LABELS.new;

    const summaryHtml = lead.chat_summary
      ? `<div class="lead-summary">
           <div class="lead-summary-label">🤖 Zhrnutie konverzácie</div>
           <div style="white-space:pre-line;font-size:0.82rem;line-height:1.7;color:#374151">${esc(lead.chat_summary)}</div>
         </div>`
      : `<div class="lead-summary-pending" style="font-size:0.78rem;color:#94a3b8;padding:0.5rem 0">💬 Zákazník nezanechal správu pred kontaktom</div>`;

    const notesVal = esc(lead.notes || '');

    return `
      <div class="lead-card" id="lead-${lead.id}">
        <div class="lead-card-header">
          <div class="lead-card-info">
            <div class="lead-avatar">${esc(initials)}</div>
            <div style="flex:1">
              <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
                <span class="lead-name">${esc(lead.name)}</span>
                <span class="lead-status-badge ${statusInfo.cls}">${statusInfo.label}</span>
              </div>
              <div class="lead-meta">
                <a class="lead-meta-item" href="mailto:${esc(lead.email)}">✉️ ${esc(lead.email)}</a>
                ${lead.phone ? `<a class="lead-meta-item" href="tel:${esc(lead.phone)}">📞 ${esc(lead.phone)}</a>` : ''}
                ${lead.widgetName ? `<span class="lead-meta-item">💬 ${esc(lead.widgetName)}</span>` : ''}
                ${lead.gdpr_consent ? '<span class="lead-meta-item" title="GDPR súhlas udelený">✅ GDPR</span>' : ''}
              </div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:0.5rem;flex-shrink:0">
            <span class="lead-date">${date}</span>
            <button class="lead-delete" onclick="deleteLead('${lead.widgetId}','${lead.id}')" title="Zmazať">✕</button>
          </div>
        </div>

        ${summaryHtml}

        <div class="lead-actions">
          <div class="lead-status-row">
            <label style="font-size:0.78rem;font-weight:600;color:#64748b">Stav:</label>
            <select class="lead-status-select" onchange="updateLeadStatus('${lead.widgetId}','${lead.id}',this.value)">
              <option value="new" ${status === 'new' ? 'selected' : ''}>🔵 Nový</option>
              <option value="contacted" ${status === 'contacted' ? 'selected' : ''}>🟡 Kontaktovaný</option>
              <option value="closed" ${status === 'closed' ? 'selected' : ''}>🟢 Uzavretý</option>
            </select>
          </div>
          <div class="lead-notes-row">
            <textarea class="lead-notes-input" id="notes-${lead.id}" rows="2"
              placeholder="Poznámky: zavolal som, dohodli sme stretnutie 15.4....">${notesVal}</textarea>
            <button class="btn btn-sm btn-secondary" onclick="saveLeadNotes('${lead.widgetId}','${lead.id}')">Uložiť</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

async function updateLeadStatus(widgetId, leadId, status) {
  try {
    await apiFetch(`/api/widgets/${widgetId}/leads/${leadId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    const lead = allLeads.find(l => l.id === leadId);
    if (lead) lead.status = status;
    showToast('Stav aktualizovaný.');
    renderLeads();
  } catch {
    showToast('Chyba pri ukladaní stavu.', 'error');
  }
}

async function saveLeadNotes(widgetId, leadId) {
  const notes = document.getElementById(`notes-${leadId}`)?.value || '';
  try {
    await apiFetch(`/api/widgets/${widgetId}/leads/${leadId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes })
    });
    const lead = allLeads.find(l => l.id === leadId);
    if (lead) lead.notes = notes;
    showToast('Poznámky uložené.');
  } catch {
    showToast('Chyba pri ukladaní poznámok.', 'error');
  }
}

async function exportLeadsCSV() {
  const filterEl = document.getElementById('leads-widget-filter');
  const widgetId = filterEl?.value;

  if (!widgetId) {
    // Export all widgets — download per widget
    if (widgets.length === 0) { showToast('Žiadne widgety.', 'error'); return; }
    for (const w of widgets) {
      await downloadCSV(w.id, w.name || w.bot_name);
    }
  } else {
    const w = widgets.find(x => x.id === widgetId);
    await downloadCSV(widgetId, w?.name || widgetId);
  }
}

async function downloadCSV(widgetId, widgetName) {
  try {
    const r = await apiFetch(`/api/widgets/${widgetId}/leads/export`);
    if (!r) return;
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kontakty-${widgetName}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Export ${widgetName} dokončený.`);
  } catch {
    showToast('Chyba pri exporte.', 'error');
  }
}

async function deleteLead(widgetId, leadId) {
  if (!confirm('Zmazať tento kontakt?')) return;
  try {
    const r = await apiFetch(`/api/widgets/${widgetId}/leads/${leadId}`, { method: 'DELETE' });
    if (!r) return;
    allLeads = allLeads.filter(l => l.id !== leadId);
    updateLeadsBadge(allLeads.length);
    renderLeads();
    if (allLeads.length === 0) document.getElementById('leads-empty').style.display = '';
  } catch {
    showToast('Chyba pri mazaní.', 'error');
  }
}

function updateLeadsBadge(count) {
  const badge = document.getElementById('leads-badge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

/* ── Instagram ─────────────────────────────────────────────────── */

async function loadInstagramStatus() {
  if (!currentWidget) return;

  // Set webhook URL hint
  const webhookEl = document.getElementById('ig-webhook-url');
  if (webhookEl) webhookEl.textContent = `${window.location.origin}/api/instagram/webhook`;

  try {
    const r = await apiFetch(`/api/instagram/status/${currentWidget.id}`);
    if (!r) return;
    const data = await r.json();

    const panelDisconnected = document.getElementById('ig-panel-disconnected');
    const panelConnected = document.getElementById('ig-panel-connected');
    const panelSettings = document.getElementById('ig-panel-settings');

    if (data.connected) {
      panelDisconnected.style.display = 'none';
      panelConnected.style.display = '';
      panelSettings.style.display = '';

      document.getElementById('ig-connected-name').textContent = data.ig_username ? `@${data.ig_username}` : 'Instagram účet';
      document.getElementById('ig-connected-page').textContent = data.page_name || 'Facebook Stránka';
      document.getElementById('ig-avatar-initials').textContent =
        (data.ig_username || 'IG').slice(0, 2).toUpperCase();
      document.getElementById('ig-stat-sessions').textContent = data.dm_sessions || 0;

      // Populate settings
      document.getElementById('ig-keywords').value = (data.keyword_triggers || []).join('\n');
      document.getElementById('ig-welcome-dm').value = data.dm_welcome_msg || '';
    } else {
      panelDisconnected.style.display = '';
      panelConnected.style.display = 'none';
      panelSettings.style.display = 'none';
    }

    // Handle redirect params from OAuth callback
    const params = new URLSearchParams(window.location.search);
    if (params.get('ig_connected') === '1') {
      showToast('Instagram bol úspešne prepojený! ✅');
      window.history.replaceState({}, '', '/dashboard');
    }
    if (params.get('ig_error')) {
      const errMap = {
        cancelled: 'Prepojenie bolo zrušené.',
        no_ig_account: 'Facebook Stránka nemá pripojený Instagram Business účet.',
        oauth: 'Chyba pri autorizácii. Skúste znovu.',
      };
      showToast(errMap[params.get('ig_error')] || 'Chyba pri prepojení Instagramu.', 'error');
      window.history.replaceState({}, '', '/dashboard');
    }
  } catch (err) {
    console.error('loadInstagramStatus error:', err);
  }
}

async function connectInstagram() {
  if (!currentWidget) return;
  const btn = document.getElementById('btn-ig-connect');
  btn.disabled = true;
  btn.innerHTML = '<span>⏳ Presmerovávam...</span>';

  try {
    const r = await apiFetch(`/api/instagram/auth-url/${currentWidget.id}`);
    if (!r) { btn.disabled = false; btn.innerHTML = '<span>📱 Prepojiť Instagram</span>'; return; }
    const data = await r.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      showToast(data.error || 'Chyba pri generovaní odkazu.', 'error');
      btn.disabled = false;
      btn.innerHTML = '<span>📱 Prepojiť Instagram</span>';
    }
  } catch {
    showToast('Sieťová chyba.', 'error');
    btn.disabled = false;
    btn.innerHTML = '<span>📱 Prepojiť Instagram</span>';
  }
}

async function disconnectInstagram() {
  if (!currentWidget) return;
  if (!confirm('Odpojiť Instagram? Bot prestane reagovať na komentáre.')) return;

  try {
    const r = await apiFetch(`/api/instagram/disconnect/${currentWidget.id}`, { method: 'DELETE' });
    if (!r) return;
    showToast('Instagram bol odpojený.');
    loadInstagramStatus();
  } catch {
    showToast('Chyba pri odpájaní.', 'error');
  }
}

async function saveInstagramSettings() {
  if (!currentWidget) return;

  const keywordsRaw = document.getElementById('ig-keywords')?.value || '';
  const keywords = keywordsRaw
    .split('\n')
    .map(k => k.trim().toLowerCase())
    .filter(Boolean);

  const welcomeDm = document.getElementById('ig-welcome-dm')?.value?.trim() || '';

  try {
    const r = await apiFetch(`/api/instagram/settings/${currentWidget.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword_triggers: keywords, dm_welcome_msg: welcomeDm })
    });
    if (!r) return;
    showToast('Instagram nastavenia uložené.');
  } catch {
    showToast('Chyba pri ukladaní.', 'error');
  }
}

/* ── Affiliate ──────────────────────────────────────────────────── */

async function loadAffiliateStatus() {
  try {
    const r = await apiFetch('/api/affiliate/status');
    if (!r) return;
    const d = await r.json();

    document.getElementById('aff-share-url').value = d.share_url || '';
    document.getElementById('aff-code').textContent = d.referral_code || '—';
    document.getElementById('aff-referred-count').textContent = d.referred_count || 0;
    document.getElementById('aff-paid-referrals').textContent = d.paid_referrals || 0;
    document.getElementById('aff-credits').textContent = (d.referral_credits || 0).toFixed(2) + ' €';
    document.getElementById('aff-free-months').textContent = d.free_months_available || 0;
    document.getElementById('aff-auto-redeem').checked = !!d.credits_redeem_enabled;

    // Enable redeem button if enough credits
    const btnRedeem = document.getElementById('btn-redeem');
    if (btnRedeem) btnRedeem.disabled = (d.referral_credits || 0) < (d.monthly_price || 29);

    // Show free period if active
    const freePeriodEl = document.getElementById('aff-free-period-info');
    if (d.in_free_period && d.free_until) {
      freePeriodEl.style.display = '';
      document.getElementById('aff-free-until').textContent =
        new Date(d.free_until * 1000).toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } else {
      freePeriodEl.style.display = 'none';
    }
  } catch {
    showToast('Chyba pri načítaní affiliate štatistík.', 'error');
  }
}

function copyAffiliateLink() {
  const url = document.getElementById('aff-share-url')?.value;
  if (!url) return;
  navigator.clipboard.writeText(url)
    .then(() => showToast('Odkaz skopírovaný!', 'success'))
    .catch(() => showToast('Kopírovanie zlyhalo.', 'error'));
}

async function toggleAutoRedeem() {
  try {
    const r = await apiFetch('/api/affiliate/toggle-redeem', { method: 'POST' });
    if (!r) return;
    const d = await r.json();
    document.getElementById('aff-auto-redeem').checked = !!d.credits_redeem_enabled;
    showToast(d.credits_redeem_enabled ? 'Auto uplatňovanie zapnuté.' : 'Auto uplatňovanie vypnuté.');
  } catch {
    showToast('Chyba.', 'error');
  }
}

/* ── Credits / Usage ────────────────────────────────────────────── */

async function loadUsageBar() {
  try {
    const r = await apiFetch('/api/credits/status');
    if (!r) return;
    const d = await r.json();

    const fill = document.getElementById('usage-bar-fill');
    const count = document.getElementById('usage-count');
    const resetLabel = document.getElementById('usage-reset-label');
    const extraRow = document.getElementById('usage-extra-row');

    if (!fill) return;

    const pct = d.usage_pct || 0;
    fill.style.width = `${Math.min(100, pct)}%`;
    fill.style.background = pct >= 100 ? '#dc2626' : pct >= 80 ? '#f59e0b' : '#2563eb';

    count.textContent = `${d.used_this_month} / ${d.base_responses}`;

    if (d.reset_at) {
      const resetDate = new Date(d.reset_at * 1000);
      resetLabel.textContent = `Obnoví sa ${resetDate.toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit' })}`;
    }

    if (d.extra_credits > 0) {
      extraRow.style.display = '';
      extraRow.textContent = `+ ${d.extra_credits} extra kreditov`;
    } else {
      extraRow.style.display = 'none';
    }
  } catch { /* ignore */ }
}

function openCreditsModal() {
  document.getElementById('modal-credits').style.display = 'flex';
  // Live preview for custom amount
  const input = document.getElementById('credits-custom-eur');
  const preview = document.getElementById('credits-custom-preview');
  input.value = '';
  preview.textContent = '= 0 odpovedí';
  input.oninput = () => {
    const eur = Math.floor(Number(input.value) || 0);
    preview.textContent = eur >= 1 ? `= ${eur * 100} odpovedí` : '= 0 odpovedí';
  };
}

async function buyCredits(packageId) {
  try {
    const r = await apiFetch('/api/credits/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ package_id: packageId }),
    });
    if (!r) return;
    const d = await r.json();
    if (d.url) window.location.href = d.url;
    else showToast(d.error || 'Chyba.', 'error');
  } catch {
    showToast('Chyba pri vytváraní platby.', 'error');
  }
}

async function buyCustomCredits() {
  const eur = Math.floor(Number(document.getElementById('credits-custom-eur').value) || 0);
  if (eur < 1) { showToast('Minimálna suma je 1 €.', 'error'); return; }
  try {
    const r = await apiFetch('/api/credits/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ custom_eur: eur }),
    });
    if (!r) return;
    const d = await r.json();
    if (d.url) window.location.href = d.url;
    else showToast(d.error || 'Chyba.', 'error');
  } catch {
    showToast('Chyba pri vytváraní platby.', 'error');
  }
}

async function redeemCredits() {
  const btn = document.getElementById('btn-redeem');
  btn.disabled = true;
  btn.textContent = '⏳ Spracovávam...';
  try {
    const r = await apiFetch('/api/affiliate/redeem', { method: 'POST' });
    if (!r) { btn.disabled = false; btn.textContent = '🎁 Uplatniť kredity'; return; }
    const d = await r.json();
    if (r.ok) {
      showToast(`🎉 ${d.free_months} mesiac(e) zadarmo aktivovaný!`, 'success');
      loadAffiliateStatus();
    } else {
      showToast(d.error || 'Chyba pri uplatňovaní.', 'error');
      btn.disabled = false;
      btn.textContent = '🎁 Uplatniť kredity';
    }
  } catch {
    showToast('Chyba.', 'error');
    btn.disabled = false;
    btn.textContent = '🎁 Uplatniť kredity';
  }
}

/* ── Products ───────────────────────────────────────────────────── */

let products = [];
let editingProductId = null;

const PRODUCT_TYPE_LABELS = {
  digital: '💾 Digitálny', physical: '📦 Fyzický', service: '🔧 Služba',
  consultation: '💬 Konzultácia', course: '🎓 Kurz',
  ticket: '🎫 Vstupenka', lead_magnet: '🎁 Lead magnet',
};

async function loadProducts() {
  if (!currentWidget) return;
  try {
    const r = await apiFetch(`/api/products/${currentWidget.id}`);
    if (!r) return;
    products = await r.json();
    renderProducts();
  } catch {
    showToast('Chyba pri načítaní produktov.', 'error');
  }
}

function renderProducts() {
  const list = document.getElementById('products-list');
  const empty = document.getElementById('products-empty');
  if (!list) return;

  if (!products.length) {
    empty.style.display = '';
    list.innerHTML = '';
    return;
  }
  empty.style.display = 'none';

  list.innerHTML = products.map(p => `
    <div style="border:1px solid #e2e8f0;border-radius:12px;padding:1rem 1.25rem;margin-bottom:0.75rem;opacity:${p.active ? 1 : 0.55}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.25rem">
            <span style="font-weight:700;font-size:0.95rem">${esc(p.name)}</span>
            <span style="font-size:0.72rem;background:#f1f5f9;padding:2px 8px;border-radius:99px;color:#475569">${PRODUCT_TYPE_LABELS[p.type] || p.type}</span>
            ${!p.active ? '<span style="font-size:0.7rem;background:#fef2f2;color:#dc2626;padding:2px 8px;border-radius:99px">Neaktívny</span>' : ''}
            ${p.price != null ? `<span style="font-size:0.8rem;font-weight:600;color:#16a34a">${p.price} ${p.currency}</span>` : ''}
          </div>
          ${p.description ? `<div style="font-size:0.82rem;color:#64748b;margin-bottom:0.4rem">${esc(p.description)}</div>` : ''}
          <div style="display:flex;gap:1rem;flex-wrap:wrap;font-size:0.75rem">
            ${p.recommend_when ? `<span style="color:#16a34a">✅ ${esc(p.recommend_when.slice(0, 60))}${p.recommend_when.length > 60 ? '…' : ''}</span>` : ''}
            ${p.not_recommend_when ? `<span style="color:#dc2626">❌ ${esc(p.not_recommend_when.slice(0, 60))}${p.not_recommend_when.length > 60 ? '…' : ''}</span>` : ''}
          </div>
        </div>
        <div style="display:flex;gap:0.5rem;flex-shrink:0">
          <button class="btn btn-sm btn-secondary" onclick="editProduct('${p.id}')">Upraviť</button>
          <button class="btn btn-sm btn-danger" onclick="deleteProduct('${p.id}')">Zmazať</button>
        </div>
      </div>
    </div>
  `).join('');
}

function openProductModal(id) {
  editingProductId = null;
  document.getElementById('product-modal-title').textContent = 'Nový produkt';
  // Clear fields
  ['pm-name','pm-description','pm-for-whom','pm-benefits','pm-stripe-link','pm-recommend-when','pm-not-recommend-when','pm-faq'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('pm-price').value = '';
  document.getElementById('pm-cta-text').value = 'Zistiť viac';
  document.getElementById('pm-type').value = 'service';
  document.getElementById('pm-currency').value = 'EUR';
  document.getElementById('pm-priority').value = '0';
  document.getElementById('pm-active').value = '1';
  document.getElementById('modal-product').style.display = 'flex';
}

function editProduct(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  editingProductId = id;
  document.getElementById('product-modal-title').textContent = 'Upraviť produkt';
  document.getElementById('pm-name').value = p.name || '';
  document.getElementById('pm-type').value = p.type || 'service';
  document.getElementById('pm-description').value = p.description || '';
  document.getElementById('pm-for-whom').value = p.for_whom || '';
  document.getElementById('pm-benefits').value = p.benefits || '';
  document.getElementById('pm-price').value = p.price != null ? p.price : '';
  document.getElementById('pm-currency').value = p.currency || 'EUR';
  document.getElementById('pm-stripe-link').value = p.stripe_link || '';
  document.getElementById('pm-cta-text').value = p.cta_text || 'Zistiť viac';
  document.getElementById('pm-recommend-when').value = p.recommend_when || '';
  document.getElementById('pm-not-recommend-when').value = p.not_recommend_when || '';
  document.getElementById('pm-faq').value = p.faq || '';
  document.getElementById('pm-priority').value = p.priority || 0;
  document.getElementById('pm-active').value = p.active ? '1' : '0';
  document.getElementById('modal-product').style.display = 'flex';
}

function closeProductModal() {
  document.getElementById('modal-product').style.display = 'none';
  editingProductId = null;
}

async function saveProduct() {
  if (!currentWidget) return;
  const name = document.getElementById('pm-name').value.trim();
  if (!name) { showToast('Zadajte názov produktu.', 'error'); return; }

  const priceRaw = document.getElementById('pm-price').value;
  const body = {
    name,
    type: document.getElementById('pm-type').value,
    description: document.getElementById('pm-description').value.trim(),
    for_whom: document.getElementById('pm-for-whom').value.trim(),
    benefits: document.getElementById('pm-benefits').value.trim(),
    price: priceRaw !== '' ? parseFloat(priceRaw) : null,
    currency: document.getElementById('pm-currency').value,
    stripe_link: document.getElementById('pm-stripe-link').value.trim() || null,
    cta_text: document.getElementById('pm-cta-text').value.trim() || 'Zistiť viac',
    recommend_when: document.getElementById('pm-recommend-when').value.trim(),
    not_recommend_when: document.getElementById('pm-not-recommend-when').value.trim(),
    faq: document.getElementById('pm-faq').value.trim(),
    priority: parseInt(document.getElementById('pm-priority').value || '0', 10),
    active: document.getElementById('pm-active').value === '1' ? 1 : 0,
  };

  const url = editingProductId
    ? `/api/products/${currentWidget.id}/${editingProductId}`
    : `/api/products/${currentWidget.id}`;
  const method = editingProductId ? 'PUT' : 'POST';

  const r = await apiFetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r) return;
  if (r.ok) {
    closeProductModal();
    showToast(editingProductId ? 'Produkt aktualizovaný.' : 'Produkt pridaný!', 'success');
    loadProducts();
  } else {
    const d = await r.json().catch(() => ({}));
    showToast(d.error || 'Chyba pri ukladaní.', 'error');
  }
}

async function deleteProduct(id) {
  if (!currentWidget) return;
  if (!confirm('Zmazať tento produkt?')) return;
  const r = await apiFetch(`/api/products/${currentWidget.id}/${id}`, { method: 'DELETE' });
  if (r && r.ok) {
    showToast('Produkt zmazaný.', 'success');
    loadProducts();
  }
}

async function downloadProductTemplate() {
  if (!currentWidget) return;
  try {
    const r = await fetch(`/api/products/${currentWidget.id}/template.csv`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!r.ok) { showToast('Chyba pri sťahovaní šablóny.', 'error'); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'produkty-sablona.csv';
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    showToast('Chyba siete.', 'error');
  }
}

async function importProductsCSV(input) {
  if (!currentWidget || !input.files[0]) return;
  const file = input.files[0];
  input.value = ''; // reset so same file can be re-selected

  const formData = new FormData();
  formData.append('file', file);

  let r;
  try {
    r = await fetch(`/api/products/${currentWidget.id}/import-csv`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}` },
      body: formData,
    });
  } catch {
    showToast('Chyba siete.', 'error');
    return;
  }

  const data = await r.json();
  if (!r.ok) {
    showToast(data.error || 'Chyba importu.', 'error');
    return;
  }

  const { imported, errors } = data;
  if (imported > 0) {
    showToast(`Importovaných ${imported} produkt${imported === 1 ? '' : imported < 5 ? 'y' : 'ov'}.`, 'success');
    loadProducts();
  }
  if (errors.length) {
    console.warn('CSV import errors:', errors);
    showToast(`${errors.length} riadok${errors.length === 1 ? '' : 'ov'} sa nepodarilo importovať.`, 'error');
  }
  if (imported === 0 && !errors.length) {
    showToast('CSV neobsahuje žiadne platné produkty.', 'error');
  }
}
