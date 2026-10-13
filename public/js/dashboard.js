'use strict';
/* ── Neoworkly Dashboard ─────────────────────────────────── */

const API = '';  // relative URLs

let currentUser = null;
let widgets = [];
let currentWidget = null;
let currentTab = 'settings';
let suggestedQuestions = [];
let suggestedQuestionsI18n = {};

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

/* ── Mobile Sidebar ──────────────────────────────────────────── */
function toggleMobileSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const isOpen = sidebar.classList.contains('open');
  if (isOpen) {
    sidebar.classList.remove('open');
    overlay.classList.remove('active');
  } else {
    sidebar.classList.add('open');
    overlay.classList.add('active');
  }
}

function closeMobileSidebar() {
  document.querySelector('.sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('active');
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
      if (!sdata.in_trial) renderBillingButton();
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

  // Wire "add language" button via JS (not onclick attribute) to avoid scope issues
  const addLangBtn = document.getElementById('btn-add-welcome-lang');
  if (addLangBtn) addLangBtn.addEventListener('click', () => addWelcomeLang());
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
  closeMobileSidebar();
  document.getElementById('view-widgets').style.display = view === 'widgets' ? '' : 'none';
  document.getElementById('view-editor').style.display = view === 'editor' ? '' : 'none';
  document.getElementById('view-leads').style.display = view === 'leads' ? '' : 'none';
  document.getElementById('view-affiliate').style.display = view === 'affiliate' ? '' : 'none';
  document.getElementById('view-coach').style.display = view === 'coach' ? '' : 'none';
  document.getElementById('widget-nav-section').style.display = view === 'editor' ? '' : 'none';

  document.getElementById('nav-widgets').classList.toggle('active', view === 'widgets');
  document.getElementById('nav-leads').classList.toggle('active', view === 'leads');
  document.getElementById('nav-affiliate').classList.toggle('active', view === 'affiliate');
  document.getElementById('nav-coach').classList.toggle('active', view === 'coach');

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
  if (view === 'coach') {
    document.getElementById('topbar-title').textContent = 'AI Coach';
    document.getElementById('topbar-actions').innerHTML =
      '<button class="btn btn-secondary btn-sm" onclick="clearCoachHistory()">Vymazať chat</button>';
  }
}

function showTab(tab) {
  closeMobileSidebar();
  currentTab = tab;
  ['overview','settings','knowledge','questions','embed','products','instagram','facebook','gdpr','booking','leadmagnets','insights','inbox','integrations'].forEach(t => {
    document.getElementById(`tab-${t}`)?.classList.toggle('active', t === tab);
    document.getElementById(`nav-${t}`)?.classList.toggle('active', t === tab);
  });

  if (tab === 'overview') loadOverview();
  if (tab === 'knowledge') loadKnowledge();
  if (tab === 'embed') loadEmbedCode();
  if (tab === 'instagram') loadInstagramStatus();
  if (tab === 'products') loadProducts();
  if (tab === 'gdpr') loadGdpr();
  if (tab === 'booking') loadBookingTab();
  if (tab === 'leadmagnets') loadLeadMagnets();
  if (tab === 'insights') loadInsights();
  if (tab === 'inbox') loadInbox();
  if (tab === 'integrations') { loadIntegrations(); loadEcomailStatus(); }
  if (tab === 'facebook') loadFacebookStatus();
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
  suggestedQuestionsI18n = { ...(currentWidget.suggested_questions_i18n || {}) };

  // Populate settings form
  document.getElementById('s-name').value = currentWidget.name;
  document.getElementById('s-bot-name').value = currentWidget.bot_name;
  // Welcome message (plain string or JSON for multilingual)
  const rawWelcome = currentWidget.welcome_message || '';
  if (rawWelcome.startsWith('{')) {
    try {
      const wmObj = JSON.parse(rawWelcome);
      document.getElementById('s-welcome').value = wmObj.default || '';
      loadWelcomeLangs(wmObj);
    } catch { document.getElementById('s-welcome').value = rawWelcome; clearWelcomeLangs(); }
  } else {
    document.getElementById('s-welcome').value = rawWelcome;
    clearWelcomeLangs();
  }
  document.getElementById('s-color').value = currentWidget.primary_color;
  document.getElementById('s-goals').value = currentWidget.goals || '';
  document.getElementById('s-active').value = currentWidget.active ? '1' : '0';
  updateColorPreview(currentWidget.primary_color);
  document.getElementById('s-proactive-enabled').checked = Boolean(currentWidget.proactive_enabled);
  document.getElementById('s-proactive-message').value = currentWidget.proactive_message || '';
  document.getElementById('s-proactive-delay').value = currentWidget.proactive_delay || 4;
  for (const [id, key, type] of EXTRA_SETTING_FIELDS) {
    const el = document.getElementById(id);
    if (type === 'check') el.checked = Boolean(currentWidget[key]);
    else el.value = currentWidget[key] ?? '';
  }

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
  document.getElementById('cta-custom-btn-label').value = cc.customBtnLabel || '';
  document.getElementById('cta-custom-link').value = cc.customLink || '';
  document.getElementById('cta-btn-label').value = cc.label || 'Zanechajte kontakt';
  document.getElementById('cta-book-btn-label').value = cc.label || '';
  updateCtaFields();

  // Render suggested questions
  renderQuestions();

  document.getElementById('topbar-title').textContent = currentWidget.name;
  document.getElementById('topbar-actions').innerHTML = `
    <button class="btn btn-secondary" onclick="showView('widgets');loadWidgets()">← Späť</button>
  `;

  showView('editor');

  // If returning from Instagram OAuth, open Instagram tab directly
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('ig_error') || urlParams.get('ig_connected')) {
    showTab('instagram');
  } else {
    showTab('overview');
  }
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

/* ── Translation helpers ────────────────────────────────────────── */
const _sleep = ms => new Promise(r => setTimeout(r, ms));

async function _typeText(input, text, delay = 10) {
  input.value = '';
  for (const ch of text) { input.value += ch; await _sleep(delay); }
}

async function autoTranslateWelcome() {
  const defaultMsg = document.getElementById('s-welcome')?.value.trim();
  if (!defaultMsg) { showToast('Najprv vyplňte predvolenú uvítaciu správu.', 'error'); return; }

  const btn = document.getElementById('btn-auto-translate-welcome');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Prekladám...'; }

  try {
    const targetLangs = Object.keys(WELCOME_LANG_NAMES).filter(l => l !== 'sk');
    const r = await apiFetch('/api/widgets/translate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: defaultMsg, targetLanguages: targetLangs,
        context: 'welcome message for a chat assistant widget on a business website' }),
    });
    if (!r?.ok) { showToast('Chyba prekladu.', 'error'); return; }
    const data = await r.json();

    clearWelcomeLangs();
    const entries = Object.entries(data.translations || {});
    for (const [lang, msg] of entries) {
      if (!WELCOME_LANG_NAMES[lang]) continue;
      addWelcomeLang(lang, '');
      const rows = document.querySelectorAll('.welcome-lang-row');
      const lastInput = rows[rows.length - 1]?.querySelector('.wl-msg');
      if (lastInput) await _typeText(lastInput, String(msg), 8);
      await _sleep(30);
    }
    showToast(`Preložené do ${entries.length} jazykov! Kliknite Uložiť nastavenia.`, 'success');
  } catch (e) {
    showToast('Chyba: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🌍 Auto-preložiť'; }
  }
}

/* ── Booking text auto-translate ─────────────────────────────────── */
const _BK_TXT_KEYS = ['bookingSubtitle','selectService','selectDate','selectTime',
  'contactDetails','continueBtn','backBtn','confirmBtn','noSlots','successTitle','gdprText'];

async function autoTranslateBkTexts() {
  const skTexts = {};
  for (const k of _BK_TXT_KEYS) {
    const el = document.querySelector(`[data-bk-txt="${k}"]`);
    if (el?.value.trim()) skTexts[k] = el.value.trim();
  }
  if (!Object.keys(skTexts).length) { showToast('Vyplňte aspoň jeden text.', 'error'); return; }

  const btn = document.getElementById('btn-translate-bk');
  const statusEl = document.getElementById('bk-translation-status');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Prekladám...'; }
  if (statusEl) statusEl.innerHTML = '';

  try {
    const targetLangs = Object.keys(WELCOME_LANG_NAMES).filter(l => l !== 'sk');
    const r = await apiFetch('/api/widgets/translate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: skTexts, targetLanguages: targetLangs,
        context: 'booking page UI — step titles, button labels, messages' }),
    });
    if (!r?.ok) { showToast('Chyba prekladu.', 'error'); return; }
    const data = await r.json();

    // Merge into design state
    _bkDesign.texts = { ...(_bkDesign.texts || {}), sk: skTexts, ...data.translations };

    // Animate language tags appearing
    if (statusEl) {
      statusEl.style.cssText = 'margin-top:0.75rem;display:flex;flex-wrap:wrap;gap:0.4rem;align-items:center';
      const entries = Object.entries(data.translations || {});
      for (const [lang] of entries) {
        if (!WELCOME_LANG_NAMES[lang]) continue;
        await _sleep(55);
        const tag = document.createElement('span');
        tag.style.cssText = 'background:rgba(31,216,154,0.14);color:#1fd89a;padding:2px 9px;border-radius:99px;font-size:0.73rem;font-weight:700;animation:fadeIn 0.2s';
        tag.textContent = `✓ ${WELCOME_LANG_NAMES[lang]}`;
        statusEl.appendChild(tag);
      }
      await _sleep(200);
      const note = document.createElement('div');
      note.style.cssText = 'width:100%;margin-top:0.4rem;font-size:0.8rem;color:#1fd89a;font-weight:600';
      note.textContent = `✅ Preložené do ${entries.length} jazykov. Kliknite Uložiť dizajn.`;
      statusEl.appendChild(note);
    }
  } catch (e) {
    showToast('Chyba: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🌍 Auto-preložiť do všetkých jazykov'; }
  }
}

/* ── Multilingual Welcome Messages ─────────────────────────────── */
const WELCOME_LANG_NAMES = {
  sk:'Slovenčina', en:'English', de:'Deutsch', fr:'Français', es:'Español',
  pl:'Polski', cs:'Čeština', hu:'Magyar', ro:'Română', hr:'Hrvatski',
  it:'Italiano', nl:'Nederlands', pt:'Português', ru:'Русский', uk:'Українська'
};

function clearWelcomeLangs() {
  const c = document.getElementById('welcome-langs-container');
  if (c) c.innerHTML = '';
}

function loadWelcomeLangs(wmObj) {
  clearWelcomeLangs();
  for (const [lang, msg] of Object.entries(wmObj)) {
    if (lang === 'default') continue;
    addWelcomeLang(lang, msg);
  }
}

function addWelcomeLang(lang, msg) {
  const container = document.getElementById('welcome-langs-container');
  if (!container) { console.error('[ND] welcome-langs-container not found'); return; }
  const row = document.createElement('div');
  row.className = 'welcome-lang-row';
  row.style.cssText = 'display:flex;gap:0.5rem;align-items:center;margin-top:0.5rem';
  const options = Object.entries(WELCOME_LANG_NAMES)
    .map(([code, name]) => `<option value="${code}">${name} (${code})</option>`).join('');
  row.innerHTML =
    `<select class="form-control wl-lang" style="width:150px;flex-shrink:0">${options}</select>` +
    `<input type="text" class="form-control wl-msg" placeholder="Uvítacia správa..." style="flex:1">` +
    `<button type="button" class="btn btn-secondary btn-sm" style="flex-shrink:0;padding:0.35rem 0.65rem" ` +
    `onclick="this.closest('.welcome-lang-row').remove()">×</button>`;
  container.appendChild(row);
  if (lang) { row.querySelector('.wl-lang').value = lang; }
  if (msg)  { row.querySelector('.wl-msg').value  = msg; }
}

function buildWelcomeMessage() {
  const def = document.getElementById('s-welcome').value.trim();
  const rows = document.querySelectorAll('.welcome-lang-row');
  if (!rows.length) return def;
  const obj = { default: def };
  rows.forEach(r => {
    const lang = r.querySelector('.wl-lang').value;
    const msg  = r.querySelector('.wl-msg').value.trim();
    if (lang && msg) obj[lang] = msg;
  });
  return JSON.stringify(obj);
}

/* ── Save Settings ─────────────────────────────────────────────── */
// [element id, widget column, type] — saved/loaded generically, validated server-side
const EXTRA_SETTING_FIELDS = [
  ['s-off-topic', 'off_topic_message', 'text'],
  ['s-no-context', 'no_context_message', 'text'],
  ['s-handoff-enabled', 'handoff_enabled', 'check'],
  ['s-handoff-email', 'handoff_email', 'text'],
  ['s-allowed-domains', 'allowed_domains', 'text'],
  ['s-show-paths', 'show_on_paths', 'text'],
  ['s-hide-mobile', 'hide_on_mobile', 'check'],
  ['s-side', 'widget_side', 'text'],
  ['s-z-index', 'z_index', 'text'],
  ['s-offset-x', 'offset_x', 'text'],
  ['s-offset-y', 'offset_y', 'text'],
  ['s-offset-x-mobile', 'offset_x_mobile', 'text'],
  ['s-offset-y-mobile', 'offset_y_mobile', 'text'],
];

async function saveSettings() {
  if (!currentWidget) return;
  const body = {
    name: document.getElementById('s-name').value.trim(),
    bot_name: document.getElementById('s-bot-name').value.trim(),
    welcome_message: buildWelcomeMessage(),
    primary_color: document.getElementById('s-color').value,
    goals: document.getElementById('s-goals').value.trim(),
    active: document.getElementById('s-active').value === '1',
    proactive_enabled: document.getElementById('s-proactive-enabled').checked,
    proactive_message: document.getElementById('s-proactive-message').value.trim(),
    proactive_delay: parseInt(document.getElementById('s-proactive-delay').value) || 4,
  };
  for (const [id, key, type] of EXTRA_SETTING_FIELDS) {
    const el = document.getElementById(id);
    body[key] = type === 'check' ? el.checked : el.value;
  }
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
  loadUnanswered();
}

/* ── Overview ─────────────────────────────────────────────────── */
async function loadOverview() {
  const res = await apiFetch(`/api/insights/${currentWidget.id}/overview`);
  if (!res || !res.ok) return;
  const d = await res.json();

  const steps = [
    ['created', 'Chatbot vytvorený', 'settings'],
    ['source_added', 'Pridať zdroj znalostí', 'knowledge'],
    ['domains_set', 'Nastaviť povolené domény', 'settings'],
    ['live', 'Vložiť na web', 'embed'],
  ];
  document.getElementById('ov-checklist-panel').style.display = steps.every(([k]) => d.checklist[k]) ? 'none' : '';
  document.getElementById('ov-checklist').innerHTML = steps.map(([key, label, tab], i) => {
    const done = d.checklist[key];
    return `<button onclick="showTab('${tab}')" style="display:flex;align-items:center;gap:0.75rem;text-align:left;padding:0.85rem 1rem;border-radius:12px;cursor:pointer;font-family:inherit;
      background:${done ? 'rgba(31,216,154,0.08)' : '#111120'};border:1px solid ${done ? 'rgba(31,216,154,0.3)' : 'rgba(255,255,255,0.08)'};color:#eeeef5">
      <span style="width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-weight:700;
        background:${done ? '#1fd89a' : 'rgba(91,79,255,0.18)'};color:${done ? '#080810' : '#9b8cff'}">${done ? '✓' : i + 1}</span>
      <span><span style="display:block;font-size:0.7rem;font-weight:700;color:${done ? '#1fd89a' : '#7e7ea0'}">KROK ${i + 1}</span>
      <span style="font-weight:600;font-size:0.9rem">${label}</span></span></button>`;
  }).join('');

  const card = (label, value, sub, color) => `<div class="panel" style="padding:1.1rem 1.25rem;margin:0">
    <div style="font-size:0.72rem;font-weight:700;letter-spacing:0.08em;color:#9b8cff">${label}</div>
    <div style="font-size:2rem;font-weight:800;margin:0.25rem 0;color:${color || '#eeeef5'}">${value}</div>
    <div style="font-size:0.8rem;color:#9898b8">${sub}</div></div>`;
  document.getElementById('ov-stats').innerHTML = [
    card('SPRÁVY DNES', d.messages_today, d.messages_today ? 'otázok od návštevníkov' : 'Zatiaľ žiadna aktivita'),
    card('SPRÁVY / 30 DNÍ', d.messages_30d, 'Celková prevádzka bota'),
    card('ÚSPEŠNOSŤ', d.success_rate === null ? '—' : d.success_rate + ' %', 'Podľa zodpovedaných otázok', d.success_rate === null ? null : d.success_rate >= 80 ? '#1fd89a' : '#fbbf24'),
    card('NEZODPOVEDANÉ', d.unanswered_30d, 'Medzery v znalostiach (30 dní)'),
    card('ZDROJE', d.sources, 'Položiek v znalostnej báze'),
  ].join('');

  const max = Math.max(1, ...d.chart.map(c => c.count));
  document.getElementById('ov-chart').innerHTML = d.chart.map(c =>
    `<div title="${c.date}: ${c.count}" style="flex:1;border-radius:3px 3px 0 0;min-height:4px;height:${Math.round(c.count / max * 100)}%;background:${c.count ? '#5b4fff' : 'rgba(255,255,255,0.08)'}"></div>`
  ).join('');
  document.getElementById('ov-chart-from').textContent = d.chart[0]?.date || '';
  document.getElementById('ov-chart-to').textContent = d.chart[d.chart.length - 1]?.date || '';

  document.getElementById('ov-recent').innerHTML = d.recent_unanswered.length
    ? d.recent_unanswered.map(r => `<div style="padding:0.6rem 0;border-bottom:1px solid rgba(255,255,255,0.06)">
        <div style="font-size:0.9rem">${esc(r.question)}</div>
        <div style="font-size:0.72rem;color:#7e7ea0">${new Date(r.created_at * 1000).toLocaleString('sk-SK')}</div></div>`).join('')
      + `<button class="btn btn-sm btn-secondary" style="margin-top:0.75rem" onclick="showTab('knowledge')">Doplniť odpovede →</button>`
    : '<div class="hint" style="text-align:center;padding:2rem 0">Žiadne nezodpovedané otázky. 🎉</div>';
}

let _unanswered = [];
let _answeringId = null;

async function loadUnanswered() {
  const res = await apiFetch(`/api/knowledge/${currentWidget.id}/unanswered`);
  if (!res || !res.ok) return;
  const rows = await res.json();
  const section = document.getElementById('unanswered-section');
  section.style.display = rows.length ? '' : 'none';
  document.getElementById('unanswered-list').innerHTML = `<div class="knowledge-list">${rows.map(r => `
    <div class="knowledge-item">
      <div class="knowledge-icon">❓</div>
      <div class="knowledge-info">
        <div class="knowledge-title">${esc(r.question)}</div>
        <div class="knowledge-meta">${new Date(r.created_at * 1000).toLocaleString('sk-SK')}</div>
      </div>
      <button class="btn btn-sm btn-primary" onclick="answerUnanswered('${r.id}')">Odpovedať</button>
      <button class="btn btn-sm btn-secondary" onclick="dismissUnanswered('${r.id}')" title="Skryť">✕</button>
    </div>
  `).join('')}</div>`;
  _unanswered = rows;
}

// Prefill the "Pridať text" form with the question so the owner just types the answer
function answerUnanswered(id) {
  const q = _unanswered.find(r => r.id === id);
  if (!q) return;
  document.getElementById('qa-question').value = q.question.slice(0, 500);
  const answer = document.getElementById('qa-answer');
  answer.value = '';
  answer.scrollIntoView({ behavior: 'smooth', block: 'center' });
  answer.focus();
  _answeringId = id;
}

async function dismissUnanswered(id) {
  await apiFetch(`/api/knowledge/${currentWidget.id}/unanswered/${id}`, { method: 'DELETE' });
  loadUnanswered();
}

function renderKnowledgeList(items) {
  const container = document.getElementById('knowledge-list');
  if (!items.length) {
    container.innerHTML = `<div class="empty-state" style="padding:1.5rem"><p>Zatiaľ žiadne dokumenty.</p></div>`;
    return;
  }
  container.innerHTML = `<div class="knowledge-list">${items.map(item => `
    <div class="knowledge-item">
      <div class="knowledge-icon">${(item.preview || '').startsWith('Otázka:') ? '❓' : ({ pdf: '📄', url: '🌐' })[item.source_type] || '📝'}</div>
      <div class="knowledge-info">
        <div class="knowledge-title">${esc(item.title)}</div>
        <div class="knowledge-preview">${esc(item.preview || '')}</div>
        <div class="knowledge-meta">${item.char_count?.toLocaleString() || '?'} znakov · ${new Date(item.created_at * 1000).toLocaleDateString('sk-SK')}</div>
      </div>
      <button class="btn btn-sm btn-danger" onclick="deleteKnowledge('${item.id}')">Zmazať</button>
    </div>
  `).join('')}</div>`;
}

async function scrapeWebsite() {
  let url = document.getElementById('scrape-url').value.trim();
  if (!url) { showToast('Zadajte URL adresu webu.', 'error'); return; }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const btn = document.getElementById('btn-scrape');
  const status = document.getElementById('scrape-status');
  btn.disabled = true;
  btn.textContent = '⏳ Skenujem...';
  status.style.display = 'block';
  status.style.color = '#9898b8';
  status.textContent = 'Skenujem stránky webu, prosím čakajte…';

  try {
    const r = await apiFetch(`/api/scraper/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, widget_id: currentWidget.id, max_pages: 15 }),
    });
    if (!r) throw new Error('no response');
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Chyba');

    status.style.color = '#1fd89a';
    status.textContent = `✓ Importovaných ${d.imported} stránok do znalostnej bázy.`;
    showToast(`✓ ${d.imported} stránok naskenovaných a uložených!`, 'success');
    document.getElementById('scrape-url').value = '';
    loadKnowledge();
  } catch (err) {
    status.style.color = '#ff4060';
    status.textContent = '✗ ' + err.message;
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Skenovať';
  }
}

async function addQaKnowledge() {
  const question = document.getElementById('qa-question').value.trim();
  const answer = document.getElementById('qa-answer').value.trim();
  if (!question || !answer) { showToast('Zadajte otázku aj odpoveď.', 'error'); return; }

  const res = await apiFetch(`/api/knowledge/${currentWidget.id}/qa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, answer }),
  });
  const data = await res.json();
  if (!res.ok) { showToast(data.error || 'Chyba.', 'error'); return; }
  document.getElementById('qa-question').value = '';
  document.getElementById('qa-answer').value = '';
  showToast('Otázka pridaná!', 'success');
  // Answered from the "Nezodpovedané otázky" list → remove it there
  if (_answeringId) {
    await apiFetch(`/api/knowledge/${currentWidget.id}/unanswered/${_answeringId}`, { method: 'DELETE' });
    _answeringId = null;
  }
  loadKnowledge();
}

async function importXml(kind) {
  const input = document.getElementById(kind === 'sitemap' ? 'xml-sitemap-url' : 'xml-feed-url');
  const url = input.value.trim();
  if (!url) { showToast('Zadajte URL adresu.', 'error'); return; }
  const btn = input.nextElementSibling;
  btn.disabled = true;
  btn.textContent = '⏳ Načítavam...';
  try {
    const r = await apiFetch(`/api/scraper/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, widget_id: currentWidget.id }),
    });
    if (!r) throw new Error('no response');
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Chyba');
    showToast(`✓ Importovaných ${d.imported} ${kind === 'sitemap' ? 'stránok' : 'položiek'}.`, 'success');
    input.value = '';
    loadKnowledge();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Načítať';
  }
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
    container.innerHTML = '<div style="color:#7e7ea0;font-size:0.875rem;padding:0.5rem 0;">Žiadne otázky. Pridajte prvú!</div>';
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
  suggestedQuestionsI18n = {};
  input.value = '';
  renderQuestions();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.activeElement?.id === 'new-question') addQuestion();
});

function removeQuestion(index) {
  suggestedQuestions.splice(index, 1);
  suggestedQuestionsI18n = {};
  renderQuestions();
}

async function generateQuestions() {
  if (!currentWidget) { showToast('Najprv vyberte widget.', 'error'); return; }
  const btn    = document.getElementById('btn-generate-questions');
  const status = document.getElementById('generate-questions-status');
  btn.disabled = true;
  btn.textContent = '⏳ Generujem…';
  status.style.display = 'block';

  try {
    const res = await apiFetch(`/api/knowledge/${currentWidget.id}/suggest-questions`, { method: 'POST' });
    if (!res) return; // 401 — apiFetch already called logout()

    let data;
    try {
      data = await res.json();
    } catch {
      console.error('[generateQuestions] Response is not JSON, status:', res.status);
      showToast(`Chyba servera (${res.status}). Skúste znova.`, 'error');
      return;
    }

    if (!res.ok || data.error) {
      console.error('[generateQuestions] API error:', res.status, data.error);
      showToast(data.error || `Chyba ${res.status} pri generovaní otázok.`, 'error');
      return;
    }

    const generated = data.questions || [];

    // Merge: add only questions not already in the list (case-insensitive dedup)
    const existing = new Set(suggestedQuestions.map(q => q.toLowerCase()));
    let added = 0;
    for (const q of generated) {
      if (suggestedQuestions.length >= 6) break;
      if (!existing.has(q.toLowerCase())) {
        suggestedQuestions.push(q);
        existing.add(q.toLowerCase());
        added++;
      }
    }

    renderQuestions();
    if (suggestedQuestions.length >= 6 && added === 0) {
      showToast('Zoznam otázok je plný (max 6). Najprv niektoré odstráňte.', 'error');
    } else {
      showToast(added > 0 ? `✨ Vygenerovaných ${added} otázok.` : 'Otázky sú už pridané.', 'success');
    }
  } catch (e) {
    console.error('[generateQuestions] Unexpected error:', e);
    showToast('Neočakávaná chyba: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Generovať otázky z dokumentov';
    status.style.display = 'none';
  }
}

async function autoTranslateQuestions() {
  if (!currentWidget) { showToast('Najprv vyberte widget.', 'error'); return; }
  if (!suggestedQuestions.length) { showToast('Najprv pridajte alebo vygenerujte otázky.', 'error'); return; }

  const btn = document.getElementById('btn-translate-questions');
  const statusEl = document.getElementById('translate-questions-status');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Prekladám…'; }
  if (statusEl) { statusEl.style.display = 'none'; statusEl.innerHTML = ''; }

  try {
    // Build object keyed by index
    const textsObj = {};
    suggestedQuestions.forEach((q, i) => { textsObj[String(i)] = q; });

    const targetLangs = Object.keys(WELCOME_LANG_NAMES).filter(l => l !== 'sk');
    const r = await apiFetch('/api/widgets/translate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        texts: textsObj,
        targetLanguages: targetLangs,
        context: 'suggested questions for a chat assistant widget on a business website',
      }),
    });
    if (!r?.ok) { showToast('Chyba prekladu otázok.', 'error'); return; }
    const data = await r.json();

    // Convert { cs: { "0": "...", "1": "..." }, ... } → { cs: [...], ... }
    const newI18n = {};
    for (const [lang, translated] of Object.entries(data.translations || {})) {
      if (!WELCOME_LANG_NAMES[lang]) continue;
      newI18n[lang] = suggestedQuestions.map((_, i) => translated[String(i)] || suggestedQuestions[i]);
    }
    suggestedQuestionsI18n = newI18n;

    // Show language badges with animation
    if (statusEl) {
      statusEl.style.cssText = 'display:flex;flex-wrap:wrap;gap:0.4rem;align-items:center;margin-top:0.5rem;';
      const entries = Object.entries(newI18n);
      for (const [lang] of entries) {
        await _sleep(55);
        const tag = document.createElement('span');
        tag.style.cssText = 'background:rgba(31,216,154,0.14);color:#1fd89a;padding:2px 9px;border-radius:99px;font-size:0.73rem;font-weight:700;animation:fadeIn 0.2s';
        tag.textContent = `✓ ${WELCOME_LANG_NAMES[lang]}`;
        statusEl.appendChild(tag);
      }
      await _sleep(150);
      const note = document.createElement('div');
      note.style.cssText = 'width:100%;margin-top:0.4rem;font-size:0.8rem;color:#1fd89a;font-weight:600';
      note.textContent = 'Kliknite Uložiť, aby sa preklady aplikovali.';
      statusEl.appendChild(note);
    }
    showToast(`Otázky preložené do ${Object.keys(newI18n).length} jazykov!`, 'success');
  } catch (e) {
    showToast('Chyba: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🌍 Preložiť otázky do všetkých jazykov'; }
  }
}

function updateCtaFields() {
  const type = document.getElementById('cta-type').value;
  document.getElementById('cta-call-fields').style.display    = type === 'call'    ? '' : 'none';
  document.getElementById('cta-custom-fields').style.display  = type === 'custom'  ? '' : 'none';
  document.getElementById('cta-contact-fields').style.display = type === 'contact' ? '' : 'none';
  document.getElementById('cta-booking-fields').style.display = type === 'booking' ? '' : 'none';
}

async function saveQuestionsAndCta() {
  if (!currentWidget) return;
  const ctaType = document.getElementById('cta-type').value;
  const ctaConfig = {};
  if (ctaType === 'call') ctaConfig.phone = document.getElementById('cta-phone').value.trim();
  if (ctaType === 'custom') {
    ctaConfig.text          = document.getElementById('cta-text').value.trim();
    ctaConfig.customBtnLabel = document.getElementById('cta-custom-btn-label').value.trim();
    ctaConfig.customLink    = document.getElementById('cta-custom-link').value.trim();
  }
  if (ctaType === 'contact') ctaConfig.label = document.getElementById('cta-btn-label').value.trim() || 'Zanechajte kontakt';
  if (ctaType === 'booking') ctaConfig.label = document.getElementById('cta-book-btn-label').value.trim();

  const res = await apiFetch(`/api/widgets/${currentWidget.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      suggested_questions: suggestedQuestions,
      suggested_questions_i18n: suggestedQuestionsI18n,
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

  try {
    // Single endpoint — returns all leads across all user's widgets at once
    // No dependency on `widgets` array being pre-loaded (fixes race condition)
    const r = await apiFetch('/api/widgets/leads/all');
    if (!r) { document.getElementById('leads-loading').style.display = 'none'; return; }
    const data = await r.json();

    allLeads = (data.leads || []).map(l => ({
      ...l,
      widgetId: l.widget_id,
      widgetName: l.widget_name || l.bot_name || '',
    }));

    // Populate widget filter dropdown from the leads data (no separate widgets fetch needed)
    const filterEl = document.getElementById('leads-widget-filter');
    if (filterEl.options.length === 1) {
      const seen = new Set();
      allLeads.forEach(l => {
        if (!seen.has(l.widgetId)) {
          seen.add(l.widgetId);
          const opt = document.createElement('option');
          opt.value = l.widgetId;
          opt.textContent = l.widgetName || l.widgetId;
          filterEl.appendChild(opt);
        }
      });
    }

    // Apply widget filter if selected
    const selectedWidget = filterEl?.value;
    if (selectedWidget) {
      allLeads = allLeads.filter(l => l.widgetId === selectedWidget);
    }

  } catch (err) {
    console.error('loadLeads error:', err);
  }

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
  if (_leadsView === 'kanban') renderKanban();
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
           <div style="white-space:pre-line;font-size:0.82rem;line-height:1.7;color:#eeeef5">${esc(lead.chat_summary)}</div>
         </div>`
      : `<div class="lead-summary-pending" style="font-size:0.78rem;color:#7e7ea0;padding:0.5rem 0">💬 Zákazník nezanechal správu pred kontaktom</div>`;

    const notesVal = esc(lead.notes || '');

    const csatHtml = lead.csat_rating
      ? `<span style="font-size:0.8rem;color:#f59e0b;margin-left:0.35rem" title="CSAT hodnotenie">${'★'.repeat(lead.csat_rating)}${'☆'.repeat(5 - lead.csat_rating)}</span>`
      : '';
    const followUpHtml = lead.follow_up_sent_at
      ? `<span style="font-size:0.72rem;color:#1fd89a;white-space:nowrap">✅ Follow-up odoslaný</span>`
      : `<button class="btn btn-sm btn-secondary" style="font-size:0.75rem;white-space:nowrap" onclick="openFollowupModal('${lead.widgetId}','${lead.id}','${esc(lead.name)}','${esc(lead.email)}')">📧 Follow-up</button>`;

    return `
      <div class="lead-card" id="lead-${lead.id}">
        <div class="lead-card-header">
          <div class="lead-card-info">
            <div class="lead-avatar">${esc(initials)}</div>
            <div style="flex:1">
              <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
                <span class="lead-name">${esc(lead.name)}</span>
                <span class="lead-status-badge ${statusInfo.cls}">${statusInfo.label}</span>
                ${csatHtml}
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
            <label style="font-size:0.78rem;font-weight:600;color:#9898b8">Stav:</label>
            <select class="lead-status-select" onchange="updateLeadStatus('${lead.widgetId}','${lead.id}',this.value)">
              <option value="new" ${status === 'new' ? 'selected' : ''}>🔵 Nový</option>
              <option value="contacted" ${status === 'contacted' ? 'selected' : ''}>🟡 Kontaktovaný</option>
              <option value="closed" ${status === 'closed' ? 'selected' : ''}>🟢 Uzavretý</option>
            </select>
            ${followUpHtml}
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

/* ── Follow-up Modal ──────────────────────────────────────────── */
function openFollowupModal(widgetId, leadId, name, email) {
  document.getElementById('followup-widget-id').value = widgetId;
  document.getElementById('followup-lead-id').value   = leadId;
  document.getElementById('followup-recipient').textContent = `Príjemca: ${name} <${email}>`;
  document.getElementById('followup-message').value   = '';
  const modal = document.getElementById('modal-followup');
  modal.style.display = 'flex';
  document.getElementById('followup-message').focus();
}

function closeFollowupModal(e) {
  if (e && e.target !== document.getElementById('modal-followup')) return;
  document.getElementById('modal-followup').style.display = 'none';
}

async function sendFollowupEmail() {
  const widgetId = document.getElementById('followup-widget-id').value;
  const leadId   = document.getElementById('followup-lead-id').value;
  const message  = document.getElementById('followup-message').value.trim();
  if (!message) { showToast('Napíšte správu', 'error'); return; }
  const btn = document.getElementById('followup-send-btn');
  btn.disabled = true; btn.textContent = 'Odosiela...';
  const res = await apiFetch(`/api/widgets/${widgetId}/leads/${leadId}/followup`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
  btn.disabled = false; btn.textContent = 'Odoslať';
  if (res && res.ok) {
    showToast('Follow-up email odoslaný');
    document.getElementById('modal-followup').style.display = 'none';
    // Update lead in memory
    const lead = allLeads.find(l => l.id === leadId);
    if (lead) lead.follow_up_sent_at = Math.floor(Date.now() / 1000);
    renderLeads();
  } else {
    showToast('Odoslanie zlyhalo', 'error');
  }
}

/* ── Kanban view ──────────────────────────────────────────────── */
let _leadsView = 'list'; // 'list' | 'kanban'

function setLeadsView(view) {
  _leadsView = view;
  document.getElementById('leads-view-list-btn').style.background   = view === 'list'   ? '#5b4fff' : '#18182a';
  document.getElementById('leads-view-list-btn').style.color        = view === 'list'   ? 'white'   : '#9898b8';
  document.getElementById('leads-view-kanban-btn').style.background = view === 'kanban' ? '#5b4fff' : '#18182a';
  document.getElementById('leads-view-kanban-btn').style.color      = view === 'kanban' ? 'white'   : '#9898b8';
  document.getElementById('leads-list').style.display   = view === 'list'   ? '' : 'none';
  document.getElementById('leads-kanban').style.display = view === 'kanban' ? '' : 'none';
  if (view === 'kanban') renderKanban();
}

function renderKanban() {
  const container = document.getElementById('leads-kanban');
  if (!container) return;
  const statusFilter = document.getElementById('leads-status-filter')?.value || '';
  const leads = statusFilter ? allLeads.filter(l => l.status === statusFilter) : allLeads;

  const columns = [
    { key: 'new',       label: '🔵 Nový',         color: '#7b6fff', bg: 'rgba(91,79,255,0.12)' },
    { key: 'contacted', label: '🟡 Kontaktovaný', color: '#f59e0b', bg: 'rgba(245,158,11,0.08)' },
    { key: 'closed',    label: '🟢 Uzavretý',     color: '#22c55e', bg: 'rgba(31,216,154,0.08)' },
  ];

  container.innerHTML = `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;align-items:start">` +
    columns.map(col => {
      const colLeads = leads.filter(l => (l.status || 'new') === col.key);
      const cards = colLeads.map(lead => {
        const initials = (lead.name || '?').split(' ').map(p => p[0]).join('').slice(0,2).toUpperCase();
        const csatStars = lead.csat_rating ? '★'.repeat(lead.csat_rating) + '☆'.repeat(5 - lead.csat_rating) : '';
        const date = new Date(lead.created_at * 1000).toLocaleDateString('sk-SK', {day:'2-digit',month:'2-digit'});
        return `<div style="background:#18182a;border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:0.75rem;margin-bottom:0.5rem;cursor:pointer"
          draggable="true" ondragstart="kanbanDragStart(event,'${lead.id}')" ondragover="event.preventDefault()" ondrop="kanbanDrop(event,'${col.key}')">
          <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem">
            <div style="width:28px;height:28px;border-radius:50%;background:${col.color};color:white;display:flex;align-items:center;justify-content:center;font-size:0.72rem;font-weight:700;flex-shrink:0">${esc(initials)}</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:0.83rem;font-weight:700;color:#eeeef5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(lead.name)}</div>
              <div style="font-size:0.72rem;color:#9898b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(lead.email)}</div>
            </div>
          </div>
          ${csatStars ? `<div style="font-size:0.72rem;color:#f59e0b">${csatStars}</div>` : ''}
          <div style="font-size:0.7rem;color:#7e7ea0;margin-top:0.25rem">${date}${lead.widgetName ? ' · ' + esc(lead.widgetName) : ''}</div>
        </div>`;
      }).join('') || `<div style="font-size:0.8rem;color:#7e7ea0;padding:0.5rem 0;text-align:center">Žiadne</div>`;

      return `<div style="background:${col.bg};border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:0.75rem"
        ondragover="event.preventDefault()" ondrop="kanbanDrop(event,'${col.key}')">
        <div style="font-size:0.78rem;font-weight:700;color:${col.color};margin-bottom:0.65rem;display:flex;align-items:center;justify-content:space-between">
          <span>${col.label}</span>
          <span style="background:${col.color};color:white;border-radius:99px;padding:0.1rem 0.5rem;font-size:0.7rem">${colLeads.length}</span>
        </div>
        ${cards}
      </div>`;
    }).join('') + `</div>`;
}

let _kanbanDragLeadId = null;
function kanbanDragStart(event, leadId) { _kanbanDragLeadId = leadId; }
async function kanbanDrop(event, newStatus) {
  if (!_kanbanDragLeadId) return;
  const lead = allLeads.find(l => l.id === _kanbanDragLeadId);
  if (!lead || lead.status === newStatus) return;
  await updateLeadStatus(lead.widgetId, lead.id, newStatus);
  renderKanban();
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

/* ── GDPR ──────────────────────────────────────────────────────── */
function loadGdpr() {
  if (!currentWidget) return;
  document.getElementById('gdpr-text').value = currentWidget.gdpr_text || '';
}

async function generateGdpr() {
  if (!currentWidget) return;
  const companyName = document.getElementById('gdpr-company-name').value.trim();
  if (!companyName) { showToast('Zadajte názov spoločnosti.', 'error'); return; }

  const btn = document.getElementById('btn-generate-gdpr');
  btn.disabled = true;
  btn.textContent = '⏳ Generujem...';

  const body = {
    companyName,
    companyAddress: document.getElementById('gdpr-company-address').value.trim(),
    companyId:      document.getElementById('gdpr-company-id').value.trim(),
    email:          document.getElementById('gdpr-email').value.trim(),
    purposes:       document.getElementById('gdpr-purposes').value.trim(),
    retention:      document.getElementById('gdpr-retention').value.trim(),
  };

  try {
    const r = await apiFetch(`/api/widgets/${currentWidget.id}/generate-gdpr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r) return;
    const data = await r.json();
    if (data.gdpr_text) {
      document.getElementById('gdpr-text').value = data.gdpr_text;
      showToast('GDPR text bol vygenerovaný. Skontrolujte a uložte.', 'success');
    } else {
      showToast(data.error || 'Chyba pri generovaní.', 'error');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Vygenerovať GDPR text';
  }
}

async function saveGdpr() {
  if (!currentWidget) return;
  const gdpr_text = document.getElementById('gdpr-text').value;
  const r = await apiFetch(`/api/widgets/${currentWidget.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gdpr_text }),
  });
  if (!r) return;
  const data = await r.json();
  currentWidget.gdpr_text = data.gdpr_text || gdpr_text;
  showToast('GDPR text uložený.', 'success');
}

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
    const igErr = params.get('ig_error');
    if (igErr) {
      window.history.replaceState({}, '', '/dashboard');
      showIgError(igErr);
    }
  } catch (err) {
    console.error('loadInstagramStatus error:', err);
  }
}

function showIgError(code) {
  const banner = document.getElementById('ig-error-banner');
  const title = document.getElementById('ig-error-title');
  const detail = document.getElementById('ig-error-detail');
  if (!banner) return;

  const errors = {
    no_pages: {
      title: 'Váš Facebook účet nemá žiadnu Stránku (Page)',
      detail: 'Meta API vyžaduje, aby ste boli administrátorom <strong>Facebook Stránky</strong> (nie osobného profilu), ku ktorej je pripojený váš Instagram. ' +
        'Bez Facebook Stránky prepojenie nie je technicky možné.' +
        '<br><br><strong>Riešenie (5 minút):</strong><br>' +
        '1. <a href="https://www.facebook.com/pages/create" target="_blank" rel="noopener" style="color:#4a3fe0">Vytvorte Facebook Stránku</a> (napr. názov firmy).<br>' +
        '2. V Instagrame → Profil → Upraviť profil → <em>Prepojiť Facebook stránku</em> → vyberte novovytvorenú stránku.<br>' +
        '3. Vráťte sa sem a kliknite znova na „Prepojiť Instagram".',
    },
    no_ig_account: {
      title: 'Facebook Stránka nemá prepojený Instagram účet',
      detail: 'Facebook stránka bola nájdená, ale nie je k nej pripojený žiadny Instagram Business alebo Creator účet.' +
        '<br><br><strong>Čo robiť:</strong><br>' +
        '1. V aplikácii <strong>Instagram</strong> → Profil → Upraviť profil → <em>Prepojiť Facebook stránku</em>.<br>' +
        '2. Vyberte správnu Facebook Stránku.<br>' +
        '3. Potom sa tu znova prihláste.',
    },
    oauth: {
      title: 'Chyba pri autorizácii cez Facebook',
      detail: 'Nastala technická chyba pri spracovaní prihlásenia. Skúste to prosím znova. ' +
        'Ak chyba pretrváva, skontrolujte, či je váš Instagram nastavený ako Business alebo Creator účet.',
    },
    cancelled: {
      title: 'Prepojenie bolo zrušené',
      detail: 'Kliknite znova na „Prepojiť Instagram" a dokončite prihlásenie vrátane povolenia všetkých oprávnení.',
    },
  };

  const msg = errors[code] || {
    title: 'Prepojenie sa nepodarilo',
    detail: 'Skúste to znova. Kód chyby: ' + code,
  };

  title.textContent = msg.title;
  detail.innerHTML = msg.detail;
  banner.style.display = '';
  banner.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function dismissIgError() {
  const banner = document.getElementById('ig-error-banner');
  if (banner) banner.style.display = 'none';
  // Reset button in case it was disabled
  const btn = document.getElementById('btn-ig-connect');
  if (btn) { btn.disabled = false; btn.innerHTML = '<span>📱 Prepojiť Instagram cez Facebook</span>'; }
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

    // Enable redeem button: 1€ minimum for AI credits, 29€ for subscription
    const btnRedeem = document.getElementById('btn-redeem');
    if (btnRedeem) btnRedeem.disabled = (d.referral_credits || 0) < 1;

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

/* ── AI Coach ────────────────────────────────────────────────── */
let coachHistory = [];

function coachAsk(btn) {
  const text = btn.textContent;
  // Hide suggestions after first question
  document.getElementById('coach-suggestions').style.display = 'none';
  document.getElementById('coach-input').value = text;
  sendCoachMessage();
}

async function sendCoachMessage() {
  const input = document.getElementById('coach-input');
  const message = input.value.trim();
  if (!message) return;

  input.value = '';
  document.getElementById('coach-suggestions').style.display = 'none';

  // Add user bubble
  appendCoachMsg('user', message);

  // Show typing indicator
  const typing = appendCoachTyping();

  const btn = document.getElementById('coach-send-btn');
  btn.disabled = true;

  try {
    const r = await apiFetch('/api/coach/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history: coachHistory }),
    });
    if (!r) throw new Error('no response');
    const d = await r.json();
    typing.remove();

    if (!r.ok) {
      appendCoachMsg('assistant', d.error || 'Nastala chyba. Skúste znova.');
    } else {
      appendCoachMsg('assistant', d.reply);
      coachHistory.push({ role: 'user', content: message });
      coachHistory.push({ role: 'assistant', content: d.reply });
      // Keep history reasonable
      if (coachHistory.length > 24) coachHistory = coachHistory.slice(-24);
    }
  } catch {
    typing.remove();
    appendCoachMsg('assistant', 'Nastala chyba spojenia. Skúste znova.');
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

function appendCoachMsg(role, text) {
  const container = document.getElementById('coach-messages');
  const div = document.createElement('div');
  div.className = `coach-msg ${role}`;
  const icon = role === 'assistant' ? '🎓' : (currentUser?.name?.[0]?.toUpperCase() || '👤');
  div.innerHTML = `
    <div class="coach-msg-icon">${icon}</div>
    <div class="coach-msg-bubble">${escCoach(text)}</div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

function appendCoachTyping() {
  const container = document.getElementById('coach-messages');
  const div = document.createElement('div');
  div.className = 'coach-msg assistant';
  div.innerHTML = `
    <div class="coach-msg-icon">🎓</div>
    <div class="coach-typing"><span></span><span></span><span></span></div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

function clearCoachHistory() {
  coachHistory = [];
  document.getElementById('coach-messages').innerHTML = '';
  document.getElementById('coach-suggestions').style.display = '';
}

function escCoach(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code style="background:#111120;padding:0.1rem 0.3rem;border-radius:4px;font-size:0.85em">$1</code>')
    .replace(/\n/g, '<br>');
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
    fill.style.background = pct >= 100 ? '#ff4060' : pct >= 80 ? '#f59e0b' : '#5b4fff';

    count.textContent = `${d.used_this_month} / ${d.base_responses}`;

    if (d.reset_at) {
      const resetDate = new Date(d.reset_at * 1000);
      resetLabel.textContent = `Obnoví sa ${resetDate.toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit' })}`;
    }

    const trialRow = document.getElementById('trial-row');
    if (trialRow) {
      trialRow.style.display = d.in_trial ? '' : 'none';
      if (d.in_trial) {
        const end = new Date(d.trial_until * 1000).toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit' });
        resetLabel.textContent = '';
        document.getElementById('trial-until').textContent = end;
      }
    }

    if (d.extra_credits > 0) {
      extraRow.style.display = '';
      extraRow.textContent = `+ ${d.extra_credits} extra kreditov`;
    } else {
      extraRow.style.display = 'none';
    }

    // 80 % / 100 % warning banner
    const banner = document.getElementById('usage-warning-banner');
    if (banner) {
      if (pct >= 100) {
        banner.style.display = '';
        banner.innerHTML = `⛔ ${d.in_trial ? 'Limit skúšobného obdobia' : 'Mesačný limit'} vyčerpaný. Chatbot neodpovedá. <button class="btn btn-sm btn-primary" style="margin-left:0.5rem" onclick="openCreditsModal()">Dobiť kredity</button>`;
        banner.style.background = 'rgba(255,64,96,0.08)';
        banner.style.borderColor = 'rgba(255,64,96,0.3)';
        banner.style.color = '#ff4060';
      } else if (pct >= 80) {
        banner.style.display = '';
        banner.innerHTML = `⚠️ Zostáva ti ${d.base_remaining} odpovedí (${100 - pct} %). <button class="btn btn-sm btn-secondary" style="margin-left:0.5rem" onclick="buyCredits('p8r')">Dobiť 200 za €8</button>`;
        banner.style.background = 'rgba(245,158,11,0.08)';
        banner.style.borderColor = 'rgba(245,158,11,0.45)';
        banner.style.color = '#fbbf24';
      } else {
        banner.style.display = 'none';
      }
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
    preview.textContent = eur >= 1 ? `= ${eur * 20} odpovedí` : '= 0 odpovedí';
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

let _redeemType = 'subscription';

function selectRedeemOption(type) {
  _redeemType = type;
  // Update radio state
  document.querySelectorAll('input[name="redeem-type"]').forEach(r => {
    r.checked = r.value === type;
  });
  // Update description
  const desc = document.getElementById('redeem-desc');
  if (type === 'subscription') {
    desc.textContent = 'Za každých 29 € kreditov získate 1 mesiac predplatného zadarmo. Stripe predplatné bude pozastavené a automaticky obnoví fakturáciu po skončení.';
  } else {
    desc.textContent = 'Všetky vaše kredity sa prevedú na AI odpovede – 1 € = 100 odpovedí. Okamžite sa pripočítajú k vášmu účtu.';
  }
}

async function redeemCredits() {
  const btn = document.getElementById('btn-redeem');
  btn.disabled = true;
  btn.textContent = '⏳ Spracovávam...';
  const endpoint = _redeemType === 'ai_credits'
    ? '/api/affiliate/redeem-ai-credits'
    : '/api/affiliate/redeem';
  try {
    const r = await apiFetch(endpoint, { method: 'POST' });
    if (!r) { btn.disabled = false; btn.textContent = '🎁 Uplatniť kredity'; return; }
    const d = await r.json();
    if (r.ok) {
      if (_redeemType === 'ai_credits') {
        showToast(`💬 +${d.ai_responses_added} AI odpovedí pridaných!`, 'success');
      } else {
        showToast(`🎉 ${d.free_months} mesiac(e) zadarmo aktivovaný!`, 'success');
      }
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
    <div style="border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:1rem 1.25rem;margin-bottom:0.75rem;opacity:${p.active ? 1 : 0.55}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.25rem">
            <span style="font-weight:700;font-size:0.95rem">${esc(p.name)}</span>
            <span style="font-size:0.72rem;background:#111120;padding:2px 8px;border-radius:99px;color:#b8b8d0">${PRODUCT_TYPE_LABELS[p.type] || p.type}</span>
            ${!p.active ? '<span style="font-size:0.7rem;background:rgba(255,64,96,0.08);color:#ff4060;padding:2px 8px;border-radius:99px">Neaktívny</span>' : ''}
            ${p.price != null ? `<span style="font-size:0.8rem;font-weight:600;color:#1fd89a">${p.price} ${p.currency}</span>` : ''}
          </div>
          ${p.description ? `<div style="font-size:0.82rem;color:#9898b8;margin-bottom:0.4rem">${esc(p.description)}</div>` : ''}
          <div style="display:flex;gap:1rem;flex-wrap:wrap;font-size:0.75rem">
            ${p.recommend_when ? `<span style="color:#1fd89a">✅ ${esc(p.recommend_when.slice(0, 60))}${p.recommend_when.length > 60 ? '…' : ''}</span>` : ''}
            ${p.not_recommend_when ? `<span style="color:#ff4060">❌ ${esc(p.not_recommend_when.slice(0, 60))}${p.not_recommend_when.length > 60 ? '…' : ''}</span>` : ''}
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

/* ════════════════════════════════════════════════════════════════
   BOOKING TAB
   ════════════════════════════════════════════════════════════════ */

let _bookingCfg = null;
let _bookingServices = [];
let _bookingStaff = [];
let _bkCalYear = new Date().getFullYear();
let _bkCalMonth = new Date().getMonth();
let _bkAllBookings = []; // flat list loaded for current month

const DAY_NAMES_BOOKING = ['Nedeľa','Pondelok','Utorok','Streda','Štvrtok','Piatok','Sobota'];
const BK_MONTHS = ['Január','Február','Marec','Apríl','Máj','Jún','Júl','August','September','Október','November','December'];
const APP_ORIGIN = window.location.origin;

async function loadBookingTab() {
  if (!currentWidget) return;
  await Promise.all([
    loadBookingConfig(),
    loadBookingServices(),
    loadBookingStaff(),
  ]);
  renderBookingEmbed();
  renderBookingCalendar();
}

async function loadBookingConfig() {
  const r = await apiFetch(`/api/booking/${currentWidget.id}/config`);
  if (!r || !r.ok) return;
  const data = await r.json();
  _bookingCfg = data;
  document.getElementById('bk-timezone').value = data.timezone || 'Europe/Bratislava';
  document.getElementById('bk-duration').value = data.slot_duration || 60;
  document.getElementById('bk-buffer').value   = data.buffer_between || 0;
  document.getElementById('bk-notice').value   = data.min_notice || 60;
  document.getElementById('bk-advance').value  = data.max_advance_days || 60;
  document.getElementById('bk-confirm-msg').value = data.confirmation_message || '';
  document.getElementById('bk-interval').value = data.slot_interval || 0;
  document.getElementById('bk-staff-selection').value = data.staff_selection || 'choose';
  document.getElementById('bk-cancel-hours').value = data.cancel_hours ?? 24;
  document.getElementById('bk-allow-cancel').checked = !!data.allow_cancel;
  document.getElementById('bk-allow-reschedule').checked = !!data.allow_reschedule;
  document.getElementById('bk-require-phone').checked = !!data.require_phone;
  document.getElementById('bk-notify-staff').checked = !!data.notify_staff;
  document.getElementById('bk-custom-css').value = data.custom_css || '';
  renderReminderOptions(data);
  try { loadBookingDesign(JSON.parse(data.design_config || '{}')); } catch {}
}

/* ── Booking design editor ──────────────────────────────────────── */

let _bkDesign = {};

function loadBookingDesign(d) {
  _bkDesign = d || {};
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  set('bk-d-primary',     d.primaryColor         || '#5b4fff');
  set('bk-d-primary-hex', d.primaryColor         || '#5b4fff');
  set('bk-d-bg',          d.bgColor              || '#f1f5f9');
  set('bk-d-bg-hex',      d.bgColor              || '#f1f5f9');
  set('bk-d-grad',        d.headerGradientColor  || '#9b8cff');
  set('bk-d-grad-hex',    d.headerGradientColor  || '#9b8cff');
  set('bk-d-font',        d.fontFamily           || 'system');
  set('bk-d-avatar',      d.avatarEmoji          || '📅');
  set('bk-d-calname',     d.calendarName         || '');

  // Logo preview
  _setLogoPreview(d.calendarLogo || '');

  // Load saved SK texts into inputs
  const skTxts = d.texts?.sk || {};
  for (const k of _BK_TXT_KEYS) {
    const el = document.querySelector(`[data-bk-txt="${k}"]`);
    if (el && skTxts[k]) el.value = skTxts[k];
  }

  // Highlight active shape preset
  document.querySelectorAll('.bk-shape-opt').forEach(btn => {
    btn.style.borderColor = 'rgba(255,255,255,0.14)';
    btn.querySelector('span').style.color = '#9898b8';
  });
  const r = d.borderRadius;
  const shapeId = r <= 6 ? 'bk-shape-sharp' : r >= 24 ? 'bk-shape-pill' : 'bk-shape-rounded';
  const activeShape = document.getElementById(shapeId);
  if (activeShape) {
    activeShape.style.borderColor = '#5b4fff';
    activeShape.querySelector('span').style.color = '#5b4fff';
  }
}

function _setLogoPreview(url) {
  const img = document.getElementById('bk-logo-preview');
  const removeBtn = document.getElementById('bk-logo-remove-btn');
  if (!img) return;
  if (url) {
    img.src = url;
    img.style.display = 'block';
    if (removeBtn) removeBtn.style.display = '';
  } else {
    img.src = '';
    img.style.display = 'none';
    if (removeBtn) removeBtn.style.display = 'none';
  }
}

async function uploadBookingLogo(input) {
  if (!currentWidget || !input.files[0]) return;
  const file = input.files[0];
  input.value = '';
  const statusEl = document.getElementById('bk-logo-status');

  if (file.size > 300 * 1024) {
    if (statusEl) statusEl.textContent = 'Logo musí byť menšie ako 300 KB.';
    return;
  }

  if (statusEl) statusEl.textContent = 'Spracúvam…';
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  _bkDesign.calendarLogo = dataUrl;
  _setLogoPreview(dataUrl);
  if (statusEl) statusEl.textContent = 'Logo načítané — kliknite Uložiť dizajn.';
  setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
}

function removeBookingLogo() {
  _bkDesign.calendarLogo = '';
  _setLogoPreview('');
}

function syncHex(baseId) {
  const picker = document.getElementById(baseId);
  const hex    = document.getElementById(baseId + '-hex');
  if (picker && hex) hex.value = picker.value;
}

function syncPicker(baseId) {
  const hex    = document.getElementById(baseId + '-hex');
  const picker = document.getElementById(baseId);
  if (!hex || !picker) return;
  if (/^#[0-9a-fA-F]{6}$/.test(hex.value)) picker.value = hex.value;
}

function selectBkShape(el) {
  document.querySelectorAll('.bk-shape-opt').forEach(btn => {
    btn.style.borderColor = 'rgba(255,255,255,0.14)';
    btn.querySelector('span').style.color = '#9898b8';
  });
  el.style.borderColor = '#5b4fff';
  el.querySelector('span').style.color = '#5b4fff';
  _bkDesign.borderRadius = parseInt(el.dataset.radius);
}

async function saveBookingDesign() {
  if (!currentWidget) return;
  const getVal = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const design = {
    primaryColor:        getVal('bk-d-primary-hex') || getVal('bk-d-primary') || '#5b4fff',
    bgColor:             getVal('bk-d-bg-hex')      || getVal('bk-d-bg')      || '#f1f5f9',
    headerGradientColor: getVal('bk-d-grad-hex')    || getVal('bk-d-grad')    || '#9b8cff',
    fontFamily:          getVal('bk-d-font')        || 'system',
    borderRadius:        _bkDesign.borderRadius     ?? 16,
    avatarEmoji:         getVal('bk-d-avatar')      || '📅',
    calendarName:        getVal('bk-d-calname')     || '',
    calendarLogo:        _bkDesign.calendarLogo     || '',
  };

  // Collect SK texts and merge with existing translations
  const skTxts = {};
  for (const k of _BK_TXT_KEYS) {
    const el = document.querySelector(`[data-bk-txt="${k}"]`);
    const v = el?.value.trim();
    if (v) skTxts[k] = v;
  }
  if (Object.keys(skTxts).length) {
    design.texts = { ...(_bkDesign.texts || {}), sk: skTxts };
  } else if (_bkDesign.texts) {
    design.texts = _bkDesign.texts;
  }
  const r = await apiFetch(`/api/booking/${currentWidget.id}/config`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ designConfig: design }),
  });
  if (r && r.ok) showToast('Dizajn uložený! Zmeny sa prejavia na rezervačnej stránke.', 'success');
  else showToast('Chyba pri ukladaní dizajnu.', 'error');
}

function previewBookingPage() {
  if (!currentWidget) return;
  window.open(`/book/${currentWidget.id}`, '_blank');
}

async function saveBookingConfig() {
  if (!currentWidget) return;
  const body = {
    timezone:            document.getElementById('bk-timezone').value,
    slotDuration:        parseInt(document.getElementById('bk-duration').value) || 60,
    bufferBetween:       parseInt(document.getElementById('bk-buffer').value)   || 0,
    minNotice:           parseInt(document.getElementById('bk-notice').value)   || 60,
    maxAdvanceDays:      parseInt(document.getElementById('bk-advance').value)  || 60,
    confirmationMessage: document.getElementById('bk-confirm-msg').value.trim(),
    slotInterval:        parseInt(document.getElementById('bk-interval').value) || 0,
    staffSelection:      document.getElementById('bk-staff-selection').value,
    cancelHours:         parseInt(document.getElementById('bk-cancel-hours').value) || 0,
    allowCancel:         document.getElementById('bk-allow-cancel').checked,
    allowReschedule:     document.getElementById('bk-allow-reschedule').checked,
    requirePhone:        document.getElementById('bk-require-phone').checked,
    notifyStaff:         document.getElementById('bk-notify-staff').checked,
    remindersCustomer:   [...document.querySelectorAll('[data-rem="customer"] input:checked')].map(i => +i.value),
    remindersStaff:      [...document.querySelectorAll('[data-rem="staff"] input:checked')].map(i => +i.value),
  };
  const r = await apiFetch(`/api/booking/${currentWidget.id}/config`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r && r.ok) showToast('Nastavenia uložené!', 'success');
  else showToast('Chyba pri ukladaní.', 'error');
}

const BK_REMINDER_OPTS = [[10080, '1 týždeň vopred'], [2880, '2 dni vopred'], [1440, '1 deň vopred'], [120, '2 hodiny vopred'], [60, '1 hodinu vopred']];

function renderReminderOptions(data) {
  for (const who of ['customer', 'staff']) {
    const el = document.querySelector(`[data-rem="${who}"]`);
    if (!el) continue;
    const on = data[`reminders_${who}`] || [];
    el.innerHTML = BK_REMINDER_OPTS.map(([v, l]) =>
      `<label class="bk-check"><input type="checkbox" value="${v}" ${on.includes(v) ? 'checked' : ''}> ${l}</label>`).join('');
  }
}

async function saveBookingCss() {
  if (!currentWidget) return;
  const r = await apiFetch(`/api/booking/${currentWidget.id}/config`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customCss: document.getElementById('bk-custom-css').value }),
  });
  if (r && r.ok) showToast('CSS uložené!', 'success');
  else showToast('Chyba pri ukladaní.', 'error');
}

/* ── Services ─────────────────────────────────────────────────── */

async function loadBookingServices() {
  if (!currentWidget) return;
  const r = await apiFetch(`/api/booking/${currentWidget.id}/services`);
  if (!r || !r.ok) return;
  _bookingServices = await r.json();
  renderServicesList();
}

function renderServicesList() {
  const el = document.getElementById('bk-services-list');
  if (!el) return;
  if (!_bookingServices.length) {
    el.innerHTML = '<div style="color:#7e7ea0;font-size:0.875rem;padding:0.5rem 0">Žiadne služby — zákazník uvidí iba výber dátumu a času.</div>';
    return;
  }
  el.innerHTML = _bookingServices.map((s, i) => {
    const price = s.price != null ? `${s.price} ${s.currency}` : 'Zadarmo';
    const activeLabel = s.active ? '' : '<span style="font-size:0.7rem;color:#7e7ea0;margin-left:0.5rem">(neaktívna)</span>';
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:0.6rem 0;border-bottom:1px solid rgba(255,255,255,0.06);gap:0.5rem">
      <div>
        <strong style="font-size:0.875rem">${escHtml(s.name)}</strong>${activeLabel}
        ${s.description ? `<div style="font-size:0.78rem;color:#9898b8">${escHtml(s.description)}</div>` : ''}
        <div style="font-size:0.75rem;color:#7e7ea0;margin-top:2px">⏱ ${s.duration_mins} min &nbsp;·&nbsp; 💶 ${esc(price)}${s.capacity > 1 ? ` &nbsp;·&nbsp; 👥 ${s.capacity}` : ''}${s.buffer_before || s.buffer_after ? ` &nbsp;·&nbsp; ⏸ ${s.buffer_before}/${s.buffer_after} min` : ''}${s.questions?.length ? ` &nbsp;·&nbsp; ❓ ${s.questions.length}` : ''}${s.staff_ids?.length ? ` &nbsp;·&nbsp; 👤 ${s.staff_ids.map(id => esc(_bookingStaff.find(x => x.id === id)?.name || '')).filter(Boolean).join(', ')}` : ''}</div>
      </div>
      <div style="display:flex;gap:0.4rem;flex-shrink:0">
        <button class="btn btn-sm btn-secondary" onclick="openServiceModal(${i})">✏️</button>
        <button class="btn btn-sm btn-danger" onclick="deleteService('${s.id}')">🗑</button>
      </div>
    </div>`;
  }).join('');
}

function openServiceModal(idx) {
  const modal = document.getElementById('modal-service');
  if (!modal) return;
  if (idx !== undefined && idx !== null && idx !== '') {
    const s = _bookingServices[idx];
    if (!s) return;
    document.getElementById('svc-modal-title').textContent = 'Upraviť službu';
    document.getElementById('svc-id').value = s.id;
    document.getElementById('svc-name').value = s.name;
    document.getElementById('svc-desc').value = s.description || '';
    document.getElementById('svc-duration').value = s.duration_mins;
    document.getElementById('svc-price').value = s.price ?? '';
    document.getElementById('svc-currency').value = s.currency || 'EUR';
    fillServiceExtras(s);
  } else {
    document.getElementById('svc-modal-title').textContent = 'Nová služba';
    document.getElementById('svc-id').value = '';
    document.getElementById('svc-name').value = '';
    document.getElementById('svc-desc').value = '';
    document.getElementById('svc-duration').value = '60';
    document.getElementById('svc-price').value = '';
    document.getElementById('svc-currency').value = 'EUR';
    fillServiceExtras({});
  }
  modal.style.display = 'flex';
}

let _svcQuestions = [];

function fillServiceExtras(s) {
  document.getElementById('svc-buf-before').value = s.buffer_before || 0;
  document.getElementById('svc-buf-after').value = s.buffer_after || 0;
  document.getElementById('svc-capacity').value = s.capacity || 1;
  document.getElementById('svc-location-type').value = s.location_type || 'in_person';
  document.getElementById('svc-location-detail').value = s.location_detail || '';
  const ids = s.staff_ids || [];
  document.getElementById('svc-staff').innerHTML = _bookingStaff.length
    ? _bookingStaff.map(st => `<label class="bk-check"><input type="checkbox" value="${esc(st.id)}" ${ids.includes(st.id) ? 'checked' : ''}> ${esc(st.name)}</label>`).join('')
    : '<span style="font-size:0.8rem;color:#7e7ea0">Zatiaľ žiadny tím</span>';
  _svcQuestions = (s.questions || []).map(q => ({ ...q, options: (q.options || []).join('\n') }));
  renderSvcQuestions();
}

function renderSvcQuestions() {
  const el = document.getElementById('svc-questions');
  if (!el) return;
  el.innerHTML = _svcQuestions.map((q, i) => `
    <div class="bk-q">
      <input type="text" class="form-control" placeholder="Otázka" value="${esc(q.label || '')}" oninput="_svcQuestions[${i}].label=this.value">
      <select class="form-control" onchange="_svcQuestions[${i}].type=this.value;renderSvcQuestions()">
        ${[['text','Krátky text'],['textarea','Dlhý text'],['select','Výber'],['checkbox','Zaškrtávacie']].map(([v,l]) => `<option value="${v}" ${q.type===v?'selected':''}>${l}</option>`).join('')}
      </select>
      <label class="bk-check" title="Povinné"><input type="checkbox" ${q.required ? 'checked' : ''} onchange="_svcQuestions[${i}].required=this.checked">*</label>
      <button type="button" class="btn btn-sm btn-danger" onclick="_svcQuestions.splice(${i},1);renderSvcQuestions()">✕</button>
      ${q.type === 'select' ? `<textarea class="form-control" rows="2" style="grid-column:1/-1" placeholder="Možnosti – každá na nový riadok" oninput="_svcQuestions[${i}].options=this.value">${esc(q.options || '')}</textarea>` : ''}
    </div>`).join('') || '<div style="font-size:0.8rem;color:#7e7ea0">Žiadne otázky</div>';
}

function addSvcQuestion() {
  _svcQuestions.push({ label: '', type: 'text', required: false, options: '' });
  renderSvcQuestions();
}

function closeServiceModal() {
  const modal = document.getElementById('modal-service');
  if (modal) modal.style.display = 'none';
}

async function saveService() {
  const id       = document.getElementById('svc-id')?.value;
  const name     = document.getElementById('svc-name')?.value.trim();
  const desc     = document.getElementById('svc-desc')?.value.trim();
  const duration = parseInt(document.getElementById('svc-duration')?.value) || 60;
  const priceVal = document.getElementById('svc-price')?.value.trim();
  const currency = document.getElementById('svc-currency')?.value || 'EUR';
  if (!name) { showToast('Zadajte názov služby.', 'error'); return; }
  const body = { name, description: desc, durationMins: duration,
                 price: priceVal !== '' ? parseFloat(priceVal) : null, currency,
                 bufferBefore: parseInt(document.getElementById('svc-buf-before').value) || 0,
                 bufferAfter:  parseInt(document.getElementById('svc-buf-after').value) || 0,
                 capacity:     parseInt(document.getElementById('svc-capacity').value) || 1,
                 locationType: document.getElementById('svc-location-type').value,
                 locationDetail: document.getElementById('svc-location-detail').value.trim(),
                 staffIds: [...document.querySelectorAll('#svc-staff input:checked')].map(i => i.value),
                 questions: _svcQuestions.filter(q => q.label && q.label.trim()) };
  const url    = id ? `/api/booking/${currentWidget.id}/services/${id}` : `/api/booking/${currentWidget.id}/services`;
  const method = id ? 'PUT' : 'POST';
  const r = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r && r.ok) { showToast('Uložené!', 'success'); closeServiceModal(); loadBookingServices(); }
  else showToast('Chyba pri ukladaní.', 'error');
}

async function deleteService(id) {
  if (!confirm('Zmazať túto službu?')) return;
  const r = await apiFetch(`/api/booking/${currentWidget.id}/services/${id}`, { method: 'DELETE' });
  if (r && r.ok) { showToast('Služba zmazaná.', 'success'); loadBookingServices(); }
}

/* ── Team / staff ─────────────────────────────────────────────── */

async function loadBookingStaff() {
  const r = await apiFetch(`/api/booking/${currentWidget.id}/staff`);
  if (!r || !r.ok) return;
  _bookingStaff = await r.json();
  renderStaffList();
}

function staffSummary(s) {
  const days = s.schedules.filter(d => d.active).map(d => ['Ne','Po','Ut','St','Št','Pi','So'][d.day_of_week]).join(' ');
  const tags = [
    days ? `🗓 ${days}` : '🗓 bez rozvrhu',
    s.break_start && s.break_end ? `☕ ${s.break_start}–${s.break_end}` : '',
    s.max_per_day ? `max ${s.max_per_day}/deň` : '',
    s.max_minutes_per_day ? `max ${Math.round(s.max_minutes_per_day / 6) / 10} h/deň` : '',
    s.max_per_week ? `max ${s.max_per_week}/týždeň` : '',
    s.gcal_connected ? '📆 Google' : '',
    s.time_off.length ? `🌴 ${s.time_off.length}× voľno` : '',
    s.max_consecutive ? `max ${s.max_consecutive} za sebou` : '',
    s.no_meeting_days.length ? `🚫 ${s.no_meeting_days.map(d => ['Ne','Po','Ut','St','Št','Pi','So'][d]).join(' ')}` : '',
    s.day_end ? `🌙 do ${s.day_end}` : '',
    s.cycle_phase_today ? `🌸 ${{ menstrual: 'menštruačná', follicular: 'folikulárna', ovulation: 'ovulačná', luteal: 'luteálna' }[s.cycle_phase_today]} fáza` : '',
  ].filter(Boolean);
  const b = s.burnout || {};
  const warn = b.alert === 'load' ? `⚠️ Riziko vyhorenia – vyťaženosť ${b.loads.join('/')} %`
             : b.alert === 'no_break' ? `⚠️ ${b.daysSinceBreak} dní bez voľna` : '';
  return tags.map(t => `<span class="bk-tag">${esc(t)}</span>`).join('')
    + (warn ? `<span class="bk-tag" style="background:rgba(245,158,11,0.16);color:#fbbf24">${esc(warn)}</span>` : '');
}

function renderStaffList() {
  const el = document.getElementById('bk-staff-list');
  if (!el) return;
  el.innerHTML = _bookingStaff.map(s => `
    <div class="bk-staff-card">
      <div style="min-width:0">
        <strong style="font-size:0.9rem">${esc(s.name)}</strong>${s.active ? '' : ' <span style="font-size:0.7rem;color:#7e7ea0">(neaktívny)</span>'}
        <div style="font-size:0.78rem;color:#9898b8;margin:2px 0 4px">${esc(s.email || 'bez e-mailu')}</div>
        <div style="display:flex;flex-wrap:wrap;gap:3px">${staffSummary(s)}</div>
      </div>
      <button class="btn btn-sm btn-secondary" onclick="openStaffModal('${s.id}')">✏️ Upraviť</button>
    </div>`).join('');
}

async function addStaff() {
  const name = prompt('Meno člena tímu:');
  if (!name || !name.trim()) return;
  const r = await apiFetch(`/api/booking/${currentWidget.id}/staff`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }),
  });
  if (!r || !r.ok) { showToast('Chyba.', 'error'); return; }
  const s = await r.json();
  await loadBookingStaff();
  openStaffModal(s.id);
}

function openStaffModal(id) {
  const s = _bookingStaff.find(x => x.id === id);
  if (!s) return;
  const sched = d => s.schedules.find(x => x.day_of_week === d) || { start_time: '09:00', end_time: '17:00', active: 0 };
  const order = [1, 2, 3, 4, 5, 6, 0];
  document.getElementById('staff-modal-body').innerHTML = `
    <input type="hidden" id="st-id" value="${esc(s.id)}">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
      <div class="form-group"><label>Meno</label><input class="form-control" id="st-name" value="${esc(s.name)}"></div>
      <div class="form-group"><label>E-mail (notifikácie a pripomienky)</label><input class="form-control" id="st-email" value="${esc(s.email || '')}"></div>
      <div class="form-group"><label>Krátke predstavenie</label><input class="form-control" id="st-bio" value="${esc(s.bio || '')}"></div>
      <div class="form-group"><label>URL fotky</label><input class="form-control" id="st-photo" value="${esc(s.photo_url || '')}"></div>
    </div>
    <label class="bk-check"><input type="checkbox" id="st-active" ${s.active ? 'checked' : ''}> Aktívny – prijíma rezervácie</label>

    <div class="bk-sub">Pracovné hodiny</div>
    ${order.map(d => { const x = sched(d); return `
      <div style="display:flex;align-items:center;gap:0.6rem;padding:0.25rem 0">
        <label class="bk-check" style="min-width:100px"><input type="checkbox" class="st-day" data-day="${d}" ${x.active ? 'checked' : ''}> ${DAY_NAMES_BOOKING[d]}</label>
        <input type="time" class="form-control st-start" data-day="${d}" value="${x.start_time}" style="width:auto;padding:0.3rem 0.5rem;font-size:0.82rem">
        <span style="color:#7e7ea0">–</span>
        <input type="time" class="form-control st-end" data-day="${d}" value="${x.end_time}" style="width:auto;padding:0.3rem 0.5rem;font-size:0.82rem">
      </div>`; }).join('')}

    <div class="bk-sub">Work-life balance</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
      <div class="form-group"><label>Obedňajšia prestávka od – do</label>
        <div style="display:flex;gap:0.4rem;align-items:center">
          <input type="time" class="form-control" id="st-break-start" value="${s.break_start || ''}" style="padding:0.3rem 0.5rem">
          <span style="color:#7e7ea0">–</span>
          <input type="time" class="form-control" id="st-break-end" value="${s.break_end || ''}" style="padding:0.3rem 0.5rem">
        </div></div>
      <div class="form-group"><label>Max. termínov za deň (0 = bez limitu)</label><input type="number" min="0" class="form-control" id="st-max-day" value="${s.max_per_day || 0}"></div>
      <div class="form-group"><label>Max. hodín s klientmi za deň (0 = bez limitu)</label><input type="number" min="0" step="0.5" class="form-control" id="st-max-hours" value="${(s.max_minutes_per_day || 0) / 60}"></div>
      <div class="form-group"><label>Max. termínov za týždeň (0 = bez limitu)</label><input type="number" min="0" class="form-control" id="st-max-week" value="${s.max_per_week || 0}"></div>
      <div class="form-group"><label>Max. termínov za sebou (0 = bez limitu)</label><input type="number" min="0" class="form-control" id="st-max-consec" value="${s.max_consecutive || 0}"></div>
      <div class="form-group"><label>…potom prestávka aspoň (min)</label><input type="number" min="0" step="5" class="form-control" id="st-consec-break" value="${s.consecutive_break ?? 15}"></div>
      <div class="form-group"><label>Žiadne termíny po (koniec dňa)</label><input type="time" class="form-control" id="st-day-end" value="${s.day_end || ''}"></div>
      <div class="form-group"><label>Dni bez stretnutí</label>
        <div style="display:flex;flex-wrap:wrap;gap:0.3rem 0.75rem;padding-top:0.3rem">${[1,2,3,4,5,6,0].map(d => `<label class="bk-check"><input type="checkbox" class="st-nomeet" value="${d}" ${s.no_meeting_days.includes(d) ? 'checked' : ''}> ${['Ne','Po','Ut','St','Št','Pi','So'][d]}</label>`).join('')}</div></div>
    </div>
    <div style="background:rgba(155,140,255,0.08);border:1px solid rgba(155,140,255,0.25);border-radius:10px;padding:0.8rem;margin-top:0.25rem">
      <div style="font-size:0.85rem;font-weight:700;margin-bottom:0.25rem">💜 Súkromný wellbeing</div>
      <div style="font-size:0.78rem;color:#b8b8d0;line-height:1.5;margin-bottom:0.6rem">Člen tímu si cez súkromný odkaz sám nastaví menštruačné voľno, deň pre duševné zdravie, PN a sledovanie cyklu s limitmi podľa fáz. Vy uvidíte len „nedostupná/ý“ – dôvod a fázu iba ak to sám povolí.${s.shares_wellbeing ? ' <strong style="color:#1fd89a">Zdieľa s vami.</strong>' : ''}</div>
      <button class="btn btn-sm btn-secondary" onclick="sendWellbeingLink('${s.id}')">✉️ ${s.wellbeing_link_sent ? 'Poslať odkaz znova' : 'Poslať súkromný odkaz e-mailom'}</button>
    </div>

    <div class="bk-sub">Služby</div>
    <div style="display:flex;flex-wrap:wrap;gap:0.4rem 1rem">${_bookingServices.length
      ? _bookingServices.map(sv => `<label class="bk-check"><input type="checkbox" class="st-svc" value="${esc(sv.id)}" ${s.service_ids.includes(sv.id) ? 'checked' : ''}> ${esc(sv.name)}</label>`).join('')
      : '<span style="font-size:0.8rem;color:#7e7ea0">Žiadne služby</span>'}</div>
    <div style="font-size:0.72rem;color:#7e7ea0;margin-top:0.3rem">Služba bez priradených ľudí je dostupná u všetkých.</div>

    <div style="display:flex;gap:0.5rem;margin-top:1.25rem">
      <button class="btn btn-primary" style="flex:1" onclick="saveStaff()">Uložiť</button>
      <button class="btn btn-danger" onclick="deleteStaff('${s.id}')">Odstrániť</button>
    </div>

    <div class="bk-sub">Voľno a výnimky</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:0.5rem;align-items:end">
      <div class="form-group" style="margin:0"><label>Od</label><input type="date" class="form-control" id="st-off-from"></div>
      <div class="form-group" style="margin:0"><label>Do</label><input type="date" class="form-control" id="st-off-to"></div>
      <div class="form-group" style="margin:0"><label>Typ</label>
        <select class="form-control" id="st-off-type" onchange="document.getElementById('st-off-times').style.display=this.value==='custom'?'flex':'none'">
          <option value="closed">Celý deň voľno</option><option value="custom">Iné hodiny</option></select></div>
      <div id="st-off-times" style="display:none;gap:0.3rem;grid-column:1/-1">
        <input type="time" class="form-control" id="st-off-start" value="09:00" style="padding:0.3rem 0.5rem">
        <input type="time" class="form-control" id="st-off-end" value="13:00" style="padding:0.3rem 0.5rem"></div>
      <div class="form-group" style="margin:0"><label>Dôvod</label>
        <select class="form-control" id="st-off-reason"><option value="vacation">Dovolenka</option><option value="sick">PN</option><option value="mental_health">Deň pre duševné zdravie</option><option value="other">Iné</option></select></div>
      <div class="form-group" style="margin:0"><label>Existujúce termíny</label>
        <select class="form-control" id="st-off-handle"><option value="reassign">Presunúť na kolegu, inak zrušiť</option><option value="cancel">Zrušiť s ospravedlnením</option><option value="keep">Ponechať</option></select></div>
      <input class="form-control" id="st-off-note" placeholder="Poznámka">
      <button class="btn btn-secondary" onclick="addTimeOff('${s.id}')">+ Pridať voľno</button>
    </div>
    <div style="margin-top:0.5rem" id="st-off-list">${timeOffListHtml(s)}</div>

    <div class="bk-sub">Kalendáre</div>
    <div style="display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap">
      ${s.gcal_connected
        ? `<span style="color:#1fd89a;font-weight:600;font-size:0.85rem">✅ Google Calendar ${esc(s.gcal_email || '')}</span>
           <button class="btn btn-sm btn-danger" onclick="disconnectStaffGCal('${s.id}')">Odpojiť</button>`
        : `<button class="btn btn-sm btn-primary" onclick="connectStaffGCal('${s.id}')">🔗 Prepojiť Google Calendar</button>`}
    </div>
    <div style="font-size:0.75rem;color:#7e7ea0;margin:0.4rem 0">Obsadené časy z Google Kalendára sa nedajú rezervovať a nové rezervácie sa doň zapíšu.</div>
    <label style="font-size:0.78rem;color:#b8b8d0;font-weight:600">Odber kalendára (Apple, Outlook, Google – „pridať z URL“)</label>
    <div style="display:flex;gap:0.4rem;margin-top:0.25rem">
      <input class="form-control" readonly id="st-feed" value="${esc(s.feed_url)}" style="font-size:0.75rem">
      <button class="btn btn-sm btn-secondary" onclick="navigator.clipboard.writeText(document.getElementById('st-feed').value).then(()=>showToast('Skopírované!','success'))">Kopírovať</button>
      <button class="btn btn-sm btn-secondary" title="Vygenerovať novú adresu" onclick="resetStaffFeed('${s.id}')">↻</button>
    </div>`;
  document.getElementById('modal-staff').style.display = 'flex';
}

function timeOffListHtml(s) {
  return s.time_off.map(o => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:0.35rem 0;border-bottom:1px solid rgba(255,255,255,0.06);font-size:0.84rem">
        <span><strong>${o.date_from}${o.date_to !== o.date_from ? ' → ' + o.date_to : ''}</strong> — ${esc(o.label || 'Voľno')}${o.type === 'closed' ? '' : ` (${o.start_time}–${o.end_time})`}${o.note ? ` · ${esc(o.note)}` : ''}${o.private ? ' <span style="color:#7e7ea0">🔒</span>' : ''}</span>
        ${o.private ? '' : `<button class="btn btn-sm btn-danger" onclick="deleteTimeOff('${s.id}','${o.id}')">✕</button>`}
      </div>`).join('') || '<div style="font-size:0.8rem;color:#7e7ea0">Žiadne naplánované voľno</div>';
}

function closeStaffModal() { document.getElementById('modal-staff').style.display = 'none'; }

async function staffApi(path, method, body) {
  const r = await apiFetch(`/api/booking/${currentWidget.id}/staff${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = r ? await r.json().catch(() => ({})) : {};
  if (!r || !r.ok) { showToast(data.error || 'Chyba.', 'error'); return null; }
  return data;
}

/** Reloads the team and updates the open modal's time-off list / feed URL without discarding unsaved edits. */
async function refreshStaff(id) {
  await loadBookingStaff();
  const s = _bookingStaff.find(x => x.id === id);
  if (!s) return;
  const list = document.getElementById('st-off-list');
  if (list) list.innerHTML = timeOffListHtml(s);
  const feed = document.getElementById('st-feed');
  if (feed) feed.value = s.feed_url;
}

async function saveStaff() {
  const id = document.getElementById('st-id').value;
  const val = x => document.getElementById(x).value;
  const ok = await staffApi(`/${id}`, 'PUT', {
    name: val('st-name'), email: val('st-email'), bio: val('st-bio'), photoUrl: val('st-photo'),
    active: document.getElementById('st-active').checked,
    breakStart: val('st-break-start'), breakEnd: val('st-break-end'),
    maxPerDay: val('st-max-day'), maxMinutesPerDay: Math.round((parseFloat(val('st-max-hours')) || 0) * 60), maxPerWeek: val('st-max-week'),
    maxConsecutive: val('st-max-consec'), consecutiveBreak: val('st-consec-break'), dayEnd: val('st-day-end'),
    noMeetingDays: [...document.querySelectorAll('.st-nomeet:checked')].map(i => +i.value),
    serviceIds: [...document.querySelectorAll('.st-svc:checked')].map(i => i.value),
  });
  if (!ok) return;
  const rows = [0, 1, 2, 3, 4, 5, 6].map(d => ({
    day_of_week: d,
    active: document.querySelector(`.st-day[data-day="${d}"]`).checked ? 1 : 0,
    start_time: document.querySelector(`.st-start[data-day="${d}"]`).value || '09:00',
    end_time: document.querySelector(`.st-end[data-day="${d}"]`).value || '17:00',
  }));
  if (!await staffApi(`/${id}/schedule`, 'PUT', rows)) return;
  showToast('Uložené!', 'success');
  closeStaffModal();
  await Promise.all([loadBookingStaff(), loadBookingServices()]);
}

async function deleteStaff(id) {
  if (!confirm('Odstrániť tohto člena tímu?')) return;
  const r = await staffApi(`/${id}`, 'DELETE');
  if (!r) return;
  showToast(r.deactivated ? `Má ${r.upcoming} budúcich rezervácií – bol len deaktivovaný.` : 'Odstránené.', 'success');
  closeStaffModal();
  loadBookingStaff();
}

async function addTimeOff(id) {
  const from = document.getElementById('st-off-from').value;
  if (!from) { showToast('Vyberte dátum.', 'error'); return; }
  const ok = await staffApi(`/${id}/time-off`, 'POST', {
    dateFrom: from, dateTo: document.getElementById('st-off-to').value || from,
    type: document.getElementById('st-off-type').value,
    startTime: document.getElementById('st-off-start').value, endTime: document.getElementById('st-off-end').value,
    note: document.getElementById('st-off-note').value,
    reason: document.getElementById('st-off-reason').value,
    handle: document.getElementById('st-off-handle').value,
  });
  if (!ok) return;
  const parts = [ok.reassigned && `${ok.reassigned} presunutých na kolegu`, ok.cancelled && `${ok.cancelled} zrušených (zákazníci dostali e-mail)`, ok.kept && `${ok.kept} ponechaných`].filter(Boolean);
  showToast(`Voľno pridané.${parts.length ? ' Rezervácie: ' + parts.join(', ') + '.' : ''}`, 'success');
  refreshStaff(id);
  renderBookingCalendar();
}

async function sendWellbeingLink(id) {
  const r = await staffApi(`/${id}/wellbeing-link`, 'POST');
  if (r) { showToast(`Súkromný odkaz odoslaný na ${r.email}.`, 'success'); refreshStaff(id); }
}

async function deleteTimeOff(id, offId) {
  if (await staffApi(`/${id}/time-off/${offId}`, 'DELETE')) refreshStaff(id);
}

async function resetStaffFeed(id) {
  if (!confirm('Vygenerovať novú adresu? Stará prestane fungovať.')) return;
  if (await staffApi(`/${id}/feed-reset`, 'POST')) refreshStaff(id);
}

async function connectStaffGCal(id) {
  const r = await apiFetch(`/api/booking/${currentWidget.id}/staff/${id}/gcal/auth-url`);
  const data = r ? await r.json().catch(() => ({})) : {};
  if (data.url) window.location.href = data.url;
  else showToast(data.error || 'Google Calendar nie je nakonfigurovaný.', 'error');
}

async function disconnectStaffGCal(id) {
  if (!confirm('Naozaj odpojiť Google Calendar?')) return;
  if (await staffApi(`/${id}/gcal`, 'DELETE')) { await loadBookingStaff(); openStaffModal(id); }
}

/* ── Bookings Calendar ─────────────────────────────────────────── */

function bkCalNav(dir) {
  _bkCalMonth += dir;
  if (_bkCalMonth > 11) { _bkCalMonth = 0; _bkCalYear++; }
  if (_bkCalMonth < 0)  { _bkCalMonth = 11; _bkCalYear--; }
  renderBookingCalendar();
}

async function renderBookingCalendar() {
  if (!currentWidget) return;
  const monthEl = document.getElementById('bk-cal-month');
  if (monthEl) monthEl.textContent = `${BK_MONTHS[_bkCalMonth]} ${_bkCalYear}`;

  // Load bookings for this month
  const from = `${_bkCalYear}-${String(_bkCalMonth+1).padStart(2,'0')}-01`;
  const lastDay = new Date(_bkCalYear, _bkCalMonth+1, 0).getDate();
  const to = `${_bkCalYear}-${String(_bkCalMonth+1).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
  const r = await apiFetch(`/api/booking/${currentWidget.id}/bookings?from=${from}&to=${to}`);
  _bkAllBookings = (r && r.ok) ? await r.json() : [];

  const grid = document.getElementById('bk-calendar-grid');
  if (!grid) return;

  const today = new Date().toLocaleDateString('sv-SE');
  const bookingsByDay = {};
  _bkAllBookings.forEach(b => {
    if (!bookingsByDay[b.date]) bookingsByDay[b.date] = [];
    bookingsByDay[b.date].push(b);
  });

  const firstDow = new Date(_bkCalYear, _bkCalMonth, 1).getDay();
  const daysInMonth = new Date(_bkCalYear, _bkCalMonth+1, 0).getDate();
  const DOW_LABELS = ['Ne','Po','Ut','St','Št','Pi','So'];

  let html = `<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px">`;
  DOW_LABELS.forEach(d => {
    html += `<div style="text-align:center;font-size:0.68rem;font-weight:700;color:#7e7ea0;padding:0.4rem 0">${d}</div>`;
  });
  for (let i = 0; i < firstDow; i++) html += `<div></div>`;

  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${_bkCalYear}-${String(_bkCalMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const bks = bookingsByDay[ds] || [];
    const isToday = ds === today;
    const confirmed = bks.filter(b => b.status === 'confirmed').length;
    const cancelled = bks.filter(b => b.status === 'cancelled').length;

    html += `<div onclick="showDayBookings('${ds}')" style="min-height:52px;border-radius:8px;padding:4px;cursor:pointer;
      background:${isToday ? 'rgba(91,79,255,0.14)' : '#111120'};border:1.5px solid ${isToday ? '#5b4fff' : 'rgba(255,255,255,0.08)'};
      transition:background 0.15s" onmouseover="this.style.background='rgba(91,79,255,0.22)'" onmouseout="this.style.background='${isToday ? 'rgba(91,79,255,0.14)' : '#111120'}'">
      <div style="font-size:0.78rem;font-weight:${isToday?'800':'600'};color:${isToday?'#5b4fff':'#eeeef5'};text-align:right;padding:2px 4px">${d}</div>
      ${confirmed ? `<div style="font-size:0.65rem;background:rgba(31,216,154,0.14);color:#1fd89a;border-radius:4px;padding:1px 4px;margin-top:2px;font-weight:600">✓ ${confirmed}</div>` : ''}
      ${cancelled ? `<div style="font-size:0.65rem;background:rgba(255,64,96,0.14);color:#ff4060;border-radius:4px;padding:1px 4px;margin-top:2px;font-weight:600">✗ ${cancelled}</div>` : ''}
    </div>`;
  }
  html += `</div>`;
  grid.innerHTML = html;

  // Clear day detail on month change
  const dayEl = document.getElementById('bk-day-bookings');
  if (dayEl) dayEl.innerHTML = '';
}

function showDayBookings(ds) {
  const el = document.getElementById('bk-day-bookings');
  if (!el) return;
  const bks = _bkAllBookings.filter(b => b.date === ds);
  const [y,mo,d] = ds.split('-').map(Number);
  const dateLabel = `${d}. ${BK_MONTHS[mo-1]} ${y}`;

  if (!bks.length) {
    el.innerHTML = `<div style="color:#7e7ea0;font-size:0.875rem;padding:0.75rem 0">Žiadne rezervácie — ${dateLabel}</div>`;
    return;
  }

  const STATUS_LABEL = { confirmed: '✅', cancelled: '❌', no_show: '👻' };
  const STATUS_COLOR = { confirmed: '#1fd89a', cancelled: '#ff4060', no_show: '#f59e0b' };

  el.innerHTML = `<div style="font-weight:700;font-size:0.875rem;margin-bottom:0.75rem;color:#eeeef5">📅 ${dateLabel}</div>` +
    bks.map(b => `
      <div style="background:#111120;border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:0.875rem;margin-bottom:0.75rem">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.5rem">
          <div>
            <span style="font-weight:700;font-size:0.9rem">${b.start_time} – ${b.end_time}</span>
            ${b.service_name ? `<span style="font-size:0.78rem;background:rgba(155,140,255,0.16);color:#5b4fff;border-radius:4px;padding:1px 6px;margin-left:6px">${escHtml(b.service_name)}</span>` : ''}
            ${b.staff_name && _bookingStaff.length > 1 ? `<span class="bk-tag" style="margin-left:6px">👤 ${escHtml(b.staff_name)}</span>` : ''}
            ${b.seats > 1 ? `<span class="bk-tag">👥 ${b.seats}</span>` : ''}
          </div>
          <span style="font-size:0.8rem;font-weight:600;color:${STATUS_COLOR[b.status]||'#eeeef5'}">${STATUS_LABEL[b.status]||''}</span>
        </div>
        <div style="font-weight:700;font-size:0.875rem;color:#eeeef5">${escHtml(b.customer_name)}</div>
        <div style="font-size:0.8rem;color:#9898b8;margin-bottom:0.5rem">
          <a href="mailto:${escHtml(b.customer_email)}" style="color:#5b4fff">${escHtml(b.customer_email)}</a>
          ${b.customer_phone ? ` · <a href="tel:${escHtml(b.customer_phone)}" style="color:#5b4fff">${escHtml(b.customer_phone)}</a>` : ''}
        </div>
        ${b.ai_summary ? `
          <div style="background:#18182a;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:0.75rem;margin-bottom:0.5rem">
            <div style="font-size:0.68rem;font-weight:700;color:#5b4fff;letter-spacing:0.05em;margin-bottom:0.4rem">🤖 SITUÁCIA KLIENTA</div>
            <div style="font-size:0.81rem;color:#eeeef5;white-space:pre-line;line-height:1.65">${escHtml(b.ai_summary)}</div>
          </div>` : `<div style="font-size:0.78rem;color:#7e7ea0;padding:0.25rem 0;margin-bottom:0.5rem">💬 Rezervácia bez konverzačného kontextu</div>`}
        ${b.internal_notes ? `
          <div style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.35);border-radius:8px;padding:0.6rem;margin-bottom:0.5rem">
            <div style="font-size:0.68rem;font-weight:700;color:#fbbf24;letter-spacing:0.05em;margin-bottom:0.3rem">📝 POZNÁMKY</div>
            <div style="font-size:0.81rem;color:#fbbf24;white-space:pre-line;line-height:1.5">${escHtml(b.internal_notes)}</div>
          </div>` : ''}
        <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-top:0.25rem">
          <button class="btn btn-sm btn-secondary" onclick="showBookingDetail('${b.id}')">✏️ Detail / Poznámky</button>
          ${b.status === 'confirmed' ? `
            <button class="btn btn-sm btn-danger" onclick="changeBookingStatus('${b.id}','cancelled');showDayBookings('${b.date}')">Zrušiť</button>
            <button class="btn btn-sm btn-secondary" onclick="changeBookingStatus('${b.id}','no_show');showDayBookings('${b.date}')">Neprišiel</button>
          ` : ''}
        </div>
      </div>
    `).join('');
}

async function loadBookingsList() {
  // Kept as alias — refresh calendar
  await renderBookingCalendar();
}

function showBookingDetail(id) {
  const b = _bkAllBookings.find(x => x.id === id);
  if (!b) return;
  const modal = document.getElementById('bk-detail-modal');
  const content = document.getElementById('bk-detail-content');
  if (!modal || !content) return;

  const [y,mo,d] = b.date.split('-').map(Number);
  const dateLabel = `${d}. ${BK_MONTHS[mo-1]} ${y}`;
  const STATUS_LABEL = { confirmed: '✅ Potvrdená', cancelled: '❌ Zrušená', no_show: '👻 Nedostavil sa', completed: '✔️ Dokončená' };
  const STATUS_COLOR = { confirmed: '#1fd89a', cancelled: '#ff4060', no_show: '#f59e0b' };

  content.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-bottom:1rem">
      <div style="background:#111120;border-radius:8px;padding:0.6rem">
        <div style="font-size:0.7rem;color:#7e7ea0;font-weight:600">DÁTUM & ČAS</div>
        <div style="font-size:0.875rem;font-weight:700;margin-top:2px">${dateLabel} ${b.start_time}–${b.end_time}</div>
      </div>
      ${b.service_name ? `<div style="background:rgba(155,140,255,0.16);border-radius:8px;padding:0.6rem">
        <div style="font-size:0.7rem;color:#5b4fff;font-weight:600">SLUŽBA</div>
        <div style="font-size:0.875rem;font-weight:700;margin-top:2px;color:#5b4fff">${escHtml(b.service_name)}</div>
      </div>` : '<div></div>'}
    </div>
    ${b.staff_name || b.location_type ? `<div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-bottom:1rem">
      ${b.staff_name ? `<span class="bk-tag">👤 ${escHtml(b.staff_name)}</span>` : ''}
      ${b.seats > 1 ? `<span class="bk-tag">👥 ${b.seats} osoby</span>` : ''}
      ${b.location_type ? `<span class="bk-tag">📍 ${{ in_person: 'Osobne', online: 'Online', phone: 'Telefonicky' }[b.location_type] || ''}${b.location_detail ? ': ' + escHtml(b.location_detail) : ''}</span>` : ''}
    </div>` : ''}
    <div style="background:#111120;border-radius:8px;padding:0.75rem;margin-bottom:1rem">
      <div style="font-size:0.7rem;color:#7e7ea0;font-weight:600;margin-bottom:4px">ZÁKAZNÍK</div>
      <div style="font-weight:700">${escHtml(b.customer_name)}</div>
      <div style="font-size:0.82rem;color:#9898b8">${escHtml(b.customer_email)}</div>
      ${b.customer_phone ? `<div style="font-size:0.82rem;color:#9898b8">${escHtml(b.customer_phone)}</div>` : ''}
      ${(b.answers || []).map(a => `<div style="font-size:0.82rem;margin-top:6px"><span style="color:#7e7ea0">${escHtml(a.q)}:</span> ${escHtml(a.a)}</div>`).join('')}
      ${b.notes ? `<div style="font-size:0.82rem;margin-top:6px"><span style="color:#7e7ea0">Poznámka zákazníka:</span> ${escHtml(b.notes)}</div>` : ''}
      ${b.cancel_reason ? `<div style="font-size:0.82rem;margin-top:6px;color:#ff4060">Dôvod zrušenia: ${escHtml(b.cancel_reason)}</div>` : ''}
    </div>
    ${b.ai_summary ? `
      <div style="background:#111120;border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:0.875rem;margin-bottom:1rem">
        <div style="font-size:0.72rem;font-weight:700;color:#5b4fff;margin-bottom:0.5rem">🤖 AI KARTA KLIENTA</div>
        <div style="font-size:0.82rem;color:#eeeef5;white-space:pre-line;line-height:1.65">${escHtml(b.ai_summary)}</div>
      </div>` : ''}
    <div style="display:flex;gap:0.5rem;margin-bottom:1rem;align-items:center">
      <span style="font-size:0.82rem;font-weight:700;color:${STATUS_COLOR[b.status]||'#eeeef5'}">${STATUS_LABEL[b.status]||b.status}</span>
    </div>
    <div style="margin-bottom:1rem">
      <div style="font-size:0.72rem;font-weight:700;color:#9898b8;letter-spacing:0.05em;margin-bottom:0.4rem">📝 POZNÁMKY</div>
      <textarea id="bk-detail-notes" rows="3" style="width:100%;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:0.6rem;font-size:0.82rem;font-family:inherit;resize:vertical;color:#eeeef5;line-height:1.5"
        placeholder="Pridajte poznámky ku stretnutiu...">${escHtml(b.internal_notes || '')}</textarea>
      <button class="btn btn-sm btn-secondary" style="margin-top:0.4rem" onclick="saveBkNotes('${b.id}','${currentWidget?.id}')">Uložiť poznámky</button>
    </div>
    ${b.status === 'confirmed' ? `<div style="display:flex;gap:0.5rem;flex-wrap:wrap">
      <button class="btn btn-sm btn-secondary" onclick="document.getElementById('bk-move-box').style.display='block'">📅 Presunúť</button>
      <button class="btn btn-sm btn-danger" onclick="changeBookingStatus('${b.id}','cancelled');closeBkDetail()">Zrušiť rezerváciu</button>
      <button class="btn btn-sm btn-secondary" onclick="changeBookingStatus('${b.id}','completed');closeBkDetail()">Dokončená</button>
      <button class="btn btn-sm btn-secondary" onclick="changeBookingStatus('${b.id}','no_show');closeBkDetail()">Neprišiel</button>
    </div>
    <div id="bk-move-box" style="display:none;margin-top:1rem;background:#111120;border-radius:10px;padding:0.875rem">
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
        <input type="date" class="form-control" id="bk-move-date" style="width:auto" onchange="loadMoveSlots('${b.id}')">
        ${_bookingStaff.length > 1 ? `<select class="form-control" id="bk-move-staff" style="width:auto" onchange="loadMoveSlots('${b.id}')">
          ${_bookingStaff.filter(s => s.active).map(s => `<option value="${s.id}" ${s.id === b.staff_id ? 'selected' : ''}>${escHtml(s.name)}</option>`).join('')}</select>` : ''}
      </div>
      <div id="bk-move-slots" style="display:flex;flex-wrap:wrap;gap:0.4rem;margin-top:0.6rem"></div>
      <div style="font-size:0.75rem;color:#7e7ea0;margin-top:0.4rem">Zákazník dostane e-mail s novým termínom a aktualizovanou pozvánkou do kalendára.</div>
    </div>` : ''}
  `;
  modal.style.display = 'flex';
}

function closeBkDetail(e) {
  const modal = document.getElementById('bk-detail-modal');
  if (!modal) return;
  if (!e || e.target === modal) modal.style.display = 'none';
}

function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

async function changeBookingStatus(bookingId, status) {
  let reason;
  if (status === 'cancelled') {
    reason = prompt('Zrušiť rezerváciu? Zákazník dostane e-mail.\nDôvod (nepovinné):', '');
    if (reason === null) return;
  }
  const r = await apiFetch(`/api/booking/${currentWidget.id}/bookings/${bookingId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, reason }),
  });
  if (r && r.ok) { showToast('Stav aktualizovaný.', 'success'); renderBookingCalendar(); }
  else showToast('Chyba.', 'error');
}

async function loadMoveSlots(bookingId) {
  const b = _bkAllBookings.find(x => x.id === bookingId);
  const date = document.getElementById('bk-move-date').value;
  const box = document.getElementById('bk-move-slots');
  if (!b || !date) return;
  const staffId = document.getElementById('bk-move-staff')?.value || b.staff_id || '';
  const q = new URLSearchParams({ date, staffId, excludeBookingId: b.id });
  if (b.service_id) q.set('serviceId', b.service_id);
  const r = await apiFetch(`/api/booking/${currentWidget.id}/slots?${q}`);
  const slots = r && r.ok ? await r.json() : [];
  box.innerHTML = slots.length
    ? slots.map(s => `<button class="btn btn-sm btn-secondary" onclick="moveBooking('${b.id}','${date}','${s.start_time}','${s.staff_id}')">${s.start_time}</button>`).join('')
    : '<span style="font-size:0.8rem;color:#7e7ea0">Žiadne voľné termíny.</span>';
}

async function moveBooking(bookingId, date, startTime, staffId) {
  if (!confirm(`Presunúť na ${date} ${startTime}?`)) return;
  const r = await apiFetch(`/api/booking/${currentWidget.id}/bookings/${bookingId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, startTime, staffId }),
  });
  const data = r ? await r.json().catch(() => ({})) : {};
  if (r && r.ok) { showToast('Rezervácia presunutá.', 'success'); closeBkDetail(); renderBookingCalendar(); }
  else showToast(data.error || 'Chyba.', 'error');
}

async function saveBkNotes(bookingId, widgetId) {
  const notes = document.getElementById('bk-detail-notes')?.value || '';
  const wid = widgetId || currentWidget?.id;
  if (!wid) return;
  const r = await apiFetch(`/api/booking/${wid}/bookings/${bookingId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ internalNotes: notes }),
  });
  if (r && r.ok) {
    // Update local cache so day panel refreshes with new notes
    const b = _bkAllBookings.find(x => x.id === bookingId);
    if (b) b.internal_notes = notes;
    showToast('Poznámky uložené.', 'success');
  } else {
    showToast('Chyba pri ukladaní.', 'error');
  }
}

/* ── Embed code ───────────────────────────────────────────────── */

function renderBookingEmbed() {
  if (!currentWidget) return;
  const bookUrl = `${APP_ORIGIN}/book/${currentWidget.id}`;
  const iframe = `<iframe src="${bookUrl}"\n  width="100%" height="650" frameborder="0"\n  style="border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,0.1)">\n</iframe>`;
  const iframeEl = document.getElementById('bk-embed-iframe');
  const linkEl   = document.getElementById('bk-embed-link');
  if (iframeEl) iframeEl.textContent = iframe;
  if (linkEl)   linkEl.textContent = bookUrl;
}

function copyBookingEmbed(type) {
  if (!currentWidget) return;
  const bookUrl = `${APP_ORIGIN}/book/${currentWidget.id}`;
  const text = type === 'iframe'
    ? `<iframe src="${bookUrl}" width="100%" height="650" frameborder="0" style="border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,0.1)"></iframe>`
    : bookUrl;
  navigator.clipboard.writeText(text).then(() => showToast('Skopírované!', 'success')).catch(() => {});
}

// Handle GCal OAuth return
(function () {
  const p = new URLSearchParams(location.search);
  if (p.get('gcal_ok') === '1') {
    showToast('Google Calendar úspešne prepojený!', 'success');
    window.history.replaceState({}, '', '/dashboard');
  }
  if (p.get('gcal_error') === '1') {
    showToast('Chyba pri prepájaní Google Calendar.', 'error');
    window.history.replaceState({}, '', '/dashboard');
  }
})();

/* ══════════════════════════════════════════════════════════════
   LEAD MAGNETY
══════════════════════════════════════════════════════════════ */

let _lmItems = [];

async function loadLeadMagnets() {
  if (!currentWidget) return;
  try {
    const r = await apiFetch(`/api/lead-magnets/${currentWidget.id}`);
    if (!r) return;
    _lmItems = await r.json();
    renderLmCards();
    populateLmFilter();
    loadLmLeads();
  } catch {
    showToast('Chyba pri načítaní lead magnetov.', 'error');
  }
}

const LM_LANG_LABELS = {
  default:'🌐 Predvolený', sk:'🇸🇰 SK', en:'🇬🇧 EN', de:'🇩🇪 DE',
  fr:'🇫🇷 FR', es:'🇪🇸 ES', pl:'🇵🇱 PL', cs:'🇨🇿 CS',
  hu:'🇭🇺 HU', ro:'🇷🇴 RO', hr:'🇭🇷 HR',
};

function renderLmCards() {
  const cards = document.getElementById('lm-cards');
  const empty = document.getElementById('lm-empty');
  if (!cards) return;

  if (!_lmItems.length) {
    empty.style.display = '';
    cards.innerHTML = '';
    return;
  }
  empty.style.display = 'none';

  cards.innerHTML = _lmItems.map(lm => {
    const filesHtml = (lm.files && lm.files.length)
      ? lm.files.map(f => `
          <span style="display:inline-flex;align-items:center;gap:4px;background:rgba(155,140,255,0.16);border-radius:6px;padding:2px 8px;font-size:0.76rem;font-weight:600;color:#5b4fff">
            <a href="${escHtml(f.file_url)}" target="_blank" rel="noopener" style="color:#5b4fff;text-decoration:none">${escHtml(LM_LANG_LABELS[f.lang] || f.lang)}</a>
            <button onclick="deleteLmFile('${escHtml(lm.id)}','${escHtml(f.id)}')" style="background:none;border:none;cursor:pointer;color:#7c3aed;font-size:0.75rem;line-height:1;padding:0;margin-left:2px" title="Odstrániť">✕</button>
          </span>`).join(' ')
      : '<span style="font-size:0.76rem;color:#7e7ea0">Žiadne jazykové súbory</span>';

    return `
    <div style="background:#111120;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:1rem 1.1rem">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:0.75rem;flex-wrap:wrap">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.3rem;flex-wrap:wrap">
            <span style="font-weight:700;font-size:0.95rem;color:#eeeef5">${escHtml(lm.name)}</span>
            <span style="font-size:0.72rem;padding:1px 7px;border-radius:99px;font-weight:600;background:${lm.active ? 'rgba(31,216,154,0.14)' : '#111120'};color:${lm.active ? '#1fd89a' : '#7e7ea0'}">${lm.active ? 'Aktívny' : 'Neaktívny'}</span>
          </div>
          ${lm.description ? `<div style="font-size:0.82rem;color:#9898b8;margin-bottom:0.4rem">${escHtml(lm.description)}</div>` : ''}
          ${lm.when_to_recommend ? `<div style="font-size:0.78rem;color:#eeeef5;margin-bottom:0.2rem"><b>Odporúčaj keď:</b> ${escHtml(lm.when_to_recommend)}</div>` : ''}
          ${lm.target_audience ? `<div style="font-size:0.78rem;color:#eeeef5;margin-bottom:0.2rem"><b>Pre koho:</b> ${escHtml(lm.target_audience)}</div>` : ''}
          ${lm.ai_content ? `<div style="font-size:0.78rem;color:#eeeef5;margin-bottom:0.5rem"><b>AI zhrnutie:</b> ${escHtml(lm.ai_content)}</div>` : ''}
          <!-- Language files row -->
          <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-top:0.4rem">
            <span style="font-size:0.73rem;font-weight:700;color:#9898b8;white-space:nowrap">🌍 Jazyky:</span>
            ${filesHtml}
            <button class="btn btn-sm btn-secondary" style="font-size:0.73rem;padding:2px 8px" onclick="openLmFileModal('${escHtml(lm.id)}')">+ Pridať jazyk</button>
          </div>
        </div>
        <div style="display:flex;gap:0.4rem;flex-shrink:0;flex-wrap:wrap;align-self:flex-start">
          ${lm.file_url ? `<a href="${escHtml(lm.file_url)}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm" title="Predvolený súbor">⬇</a>` : ''}
          <button class="btn btn-sm ${lm.active ? 'btn-secondary' : 'btn-primary'}" onclick="toggleLmActive('${lm.id}',${lm.active ? 0 : 1})">${lm.active ? 'Deaktivovať' : 'Aktivovať'}</button>
          <button class="btn btn-sm btn-danger" onclick="deleteLm('${lm.id}')">Zmazať</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function populateLmFilter() {
  const sel = document.getElementById('lm-leads-filter');
  if (!sel) return;
  // Keep first option, rebuild rest
  sel.innerHTML = '<option value="">Všetky lead magnety</option>' +
    _lmItems.map(lm => `<option value="${escHtml(lm.id)}">${escHtml(lm.name)}</option>`).join('');
}

async function toggleLmActive(lmId, newActive) {
  if (!currentWidget) return;
  const r = await apiFetch(`/api/lead-magnets/${currentWidget.id}/${lmId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: newActive }),
  });
  if (r && r.ok) {
    const updated = await r.json();
    const idx = _lmItems.findIndex(x => x.id === lmId);
    if (idx !== -1) _lmItems[idx] = updated;
    renderLmCards();
    showToast(newActive ? 'Lead magnet aktivovaný.' : 'Lead magnet deaktivovaný.', 'success');
  } else {
    showToast('Chyba.', 'error');
  }
}

async function deleteLm(lmId) {
  if (!currentWidget) return;
  if (!confirm('Zmazať tento lead magnet? Zozbierané emaily budú tiež vymazané.')) return;
  const r = await apiFetch(`/api/lead-magnets/${currentWidget.id}/${lmId}`, { method: 'DELETE' });
  if (r && r.ok) {
    _lmItems = _lmItems.filter(x => x.id !== lmId);
    renderLmCards();
    populateLmFilter();
    loadLmLeads();
    showToast('Lead magnet zmazaný.', 'success');
  } else {
    showToast('Chyba pri mazaní.', 'error');
  }
}

/* ── Language file modal ──────────────────────────────────────── */
function openLmFileModal(lmId) {
  document.getElementById('lm-file-lmid').value = lmId;
  document.getElementById('lm-file-lang').value = 'default';
  document.getElementById('lm-file-input').value = '';
  document.getElementById('lm-file-progress').style.display = 'none';
  document.getElementById('lm-file-btn').disabled = false;
  document.getElementById('modal-lm-file').style.display = 'flex';
}

function closeLmFileModal(e) {
  if (e && e.currentTarget !== e.target) return;
  document.getElementById('modal-lm-file').style.display = 'none';
}

async function uploadLmFile() {
  if (!currentWidget) return;
  const lmId = document.getElementById('lm-file-lmid').value;
  const lang = document.getElementById('lm-file-lang').value;
  const fileInput = document.getElementById('lm-file-input');
  if (!fileInput.files[0]) { showToast('Vyberte súbor.', 'error'); return; }

  const btn = document.getElementById('lm-file-btn');
  const progress = document.getElementById('lm-file-progress');
  btn.disabled = true;
  progress.style.display = '';

  const formData = new FormData();
  formData.append('lang', lang);
  formData.append('file', fileInput.files[0]);

  try {
    const token = localStorage.getItem('nd_token');
    const r = await fetch(`/api/lead-magnets/${currentWidget.id}/${lmId}/files`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
    const data = await r.json();
    if (!r.ok) {
      showToast(data.error || 'Chyba.', 'error');
      btn.disabled = false;
      progress.style.display = 'none';
      return;
    }
    // Update local cache
    const idx = _lmItems.findIndex(x => x.id === lmId);
    if (idx !== -1) _lmItems[idx].files = data.files;
    renderLmCards();
    document.getElementById('modal-lm-file').style.display = 'none';
    showToast('Jazyková verzia pridaná!', 'success');
  } catch {
    showToast('Chyba pri nahrávaní.', 'error');
    btn.disabled = false;
    progress.style.display = 'none';
  }
}

async function deleteLmFile(lmId, fileId) {
  if (!currentWidget) return;
  if (!confirm('Odstrániť túto jazykovú verziu?')) return;
  const r = await apiFetch(`/api/lead-magnets/${currentWidget.id}/${lmId}/files/${fileId}`, { method: 'DELETE' });
  if (r && r.ok) {
    const idx = _lmItems.findIndex(x => x.id === lmId);
    if (idx !== -1) _lmItems[idx].files = _lmItems[idx].files.filter(f => f.id !== fileId);
    renderLmCards();
    showToast('Súbor odstránený.', 'success');
  } else {
    showToast('Chyba.', 'error');
  }
}

function openLmUploadModal() {
  document.getElementById('lm-name').value = '';
  document.getElementById('lm-description').value = '';
  document.getElementById('lm-file').value = '';
  document.getElementById('lm-upload-progress').style.display = 'none';
  document.getElementById('lm-upload-btn').disabled = false;
  const m = document.getElementById('modal-lm-upload');
  m.style.display = 'flex';
}

function closeLmUploadModal(e) {
  if (e && e.currentTarget !== e.target) return;
  document.getElementById('modal-lm-upload').style.display = 'none';
}

async function uploadLeadMagnet() {
  if (!currentWidget) return;
  const name = document.getElementById('lm-name').value.trim();
  if (!name) { showToast('Zadajte názov.', 'error'); return; }

  const fileInput = document.getElementById('lm-file');
  const btn = document.getElementById('lm-upload-btn');
  const progress = document.getElementById('lm-upload-progress');

  btn.disabled = true;
  progress.style.display = '';

  const formData = new FormData();
  formData.append('name', name);
  formData.append('description', document.getElementById('lm-description').value.trim());
  if (fileInput.files[0]) formData.append('file', fileInput.files[0]);

  try {
    const token = localStorage.getItem('nd_token');
    const r = await fetch(`/api/lead-magnets/${currentWidget.id}`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
    const data = await r.json();
    if (!r.ok) {
      showToast(data.error || 'Chyba pri nahrávaní.', 'error');
      btn.disabled = false;
      progress.style.display = 'none';
      return;
    }
    _lmItems.unshift(data);
    renderLmCards();
    populateLmFilter();
    document.getElementById('modal-lm-upload').style.display = 'none';
    showToast('Lead magnet pridaný!', 'success');
  } catch {
    showToast('Chyba pri nahrávaní.', 'error');
    btn.disabled = false;
    progress.style.display = 'none';
  }
}

async function loadLmLeads() {
  if (!currentWidget) return;
  const lmId = document.getElementById('lm-leads-filter')?.value || '';
  const url = lmId
    ? `/api/lead-magnets/${currentWidget.id}/leads?lmId=${encodeURIComponent(lmId)}`
    : `/api/lead-magnets/${currentWidget.id}/leads`;
  try {
    const r = await apiFetch(url);
    if (!r) return;
    const leads = await r.json();
    renderLmLeads(leads);
  } catch { /* ignore */ }
}

function renderLmLeads(leads) {
  const table = document.getElementById('lm-leads-table');
  const empty = document.getElementById('lm-leads-empty');
  const body = document.getElementById('lm-leads-body');
  if (!table || !body) return;

  if (!leads.length) {
    table.style.display = 'none';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';
  table.style.display = '';

  body.innerHTML = leads.map(l => `
    <tr style="border-bottom:1px solid rgba(255,255,255,0.06)">
      <td style="padding:0.55rem 0.75rem;color:#eeeef5;font-weight:600">${escHtml(l.lm_name || '')}</td>
      <td style="padding:0.55rem 0.75rem;color:#eeeef5">${escHtml(l.name || '—')}</td>
      <td style="padding:0.55rem 0.75rem;color:#5b4fff">${escHtml(l.email)}</td>
      <td style="padding:0.55rem 0.75rem;color:#9898b8;font-size:0.78rem">${new Date(l.created_at * 1000).toLocaleString('sk-SK')}</td>
    </tr>
  `).join('');
}

async function exportLmLeads() {
  if (!currentWidget) return;
  const lmId = document.getElementById('lm-leads-filter')?.value || '';
  const url = lmId
    ? `/api/lead-magnets/${currentWidget.id}/leads/export.csv?lmId=${encodeURIComponent(lmId)}`
    : `/api/lead-magnets/${currentWidget.id}/leads/export.csv`;

  const token = localStorage.getItem('nd_token');
  try {
    const r = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!r.ok) { showToast('Export zlyhal.', 'error'); return; }
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'lead-magnet-leads.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch {
    showToast('Chyba pri exporte.', 'error');
  }
}

/* ══════════════════════════════════════════════════════════════
   TRENDY / INSIGHTS
══════════════════════════════════════════════════════════════ */

let _insightPeriod = 30;

const INS_INTENT_LABELS = {
  buying: '🛒 Chce kúpiť',
  researching: '🔍 Zisťuje informácie',
  support: '🛠️ Rieši problém',
  comparing: '⚖️ Porovnáva možnosti',
  just_browsing: '👁️ Len prehliada',
};
const INS_OBJ_LABELS = {
  price: '💸 Cena je vysoká',
  timing: '⏳ Nechce teraz',
  wrong_product: '❌ Nevhodný produkt',
  trust: '🤔 Nedôvera',
  more_info: '📚 Chce viac info',
  just_browsing: '🌀 Bez konkrétneho záujmu',
  none: '✅ Zanechal kontakt',
};
const INS_URG_LABELS = {
  immediate: '🔥 Okamžite',
  within_month: '📅 Do mesiaca',
  planning: '🗓️ Plánuje dlhodobo',
  just_browsing: '🌀 Len zisťuje',
};
const INS_COLORS = {
  buying: '#1fd89a', researching: '#5b4fff', support: '#fbbf24',
  comparing: '#7c3aed', just_browsing: '#94a3b8',
  price: '#ff4060', timing: '#fbbf24', wrong_product: '#7c3aed',
  trust: '#ea580c', more_info: '#0284c7', none: '#1fd89a',
  immediate: '#ff4060', within_month: '#fbbf24', planning: '#5b4fff',
};

function setInsightPeriod(days) {
  _insightPeriod = days;
  ['7','30','90','0'].forEach(d => {
    const btn = document.getElementById('ins-btn-' + d);
    if (!btn) return;
    btn.className = 'btn btn-sm ' + (String(days) === d ? 'btn-primary' : 'btn-secondary');
  });
  loadInsights();
}

async function loadInsights() {
  if (!currentWidget) return;
  const days = _insightPeriod;
  const url = '/api/insights/' + currentWidget.id + (days > 0 ? '?days=' + days : '?days=0');
  try {
    const r = await apiFetch(url);
    if (!r) return;
    const data = await r.json();
    renderInsights(data);
  } catch {
    showToast('Chyba pri načítaní trendov.', 'error');
  }
}

function renderInsights(data) {
  const empty   = document.getElementById('ins-empty');
  const charts  = document.getElementById('ins-charts');
  const summary = document.getElementById('ins-summary');

  summary.innerHTML = [
    { label: 'Analyzovaných relácií', value: data.total, sub: 'konverzácií s 3+ výmenami' },
    { label: 'Konverzný kurz', value: data.total > 0 ? data.conversion_rate + '%' : '—', sub: data.leads_count + ' leadov' },
    { label: 'Priem. dĺžka', value: data.avg_msg_count > 0 ? data.avg_msg_count + ' správ' : '—', sub: 'na konverzáciu' },
    { label: 'Unikátne témy', value: data.topics.length, sub: 'zachytených tém' },
  ].map(function(c) {
    return '<div style="background:#111120;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:1rem;text-align:center">' +
      '<div style="font-size:1.5rem;font-weight:800;color:#eeeef5">' + escHtml(String(c.value)) + '</div>' +
      '<div style="font-size:0.78rem;font-weight:700;color:#eeeef5;margin:0.2rem 0">' + escHtml(c.label) + '</div>' +
      '<div style="font-size:0.72rem;color:#7e7ea0">' + escHtml(c.sub) + '</div>' +
      '</div>';
  }).join('');

  // A/B test stats
  const abEl = document.getElementById('ins-ab');
  const abContent = document.getElementById('ins-ab-content');
  const abStats = data.ab_stats || {};
  const abA = abStats['a'] || 0;
  const abB = abStats['b'] || 0;
  if (abEl && abContent && (abA > 0 || abB > 0)) {
    abEl.style.display = '';
    const total = abA + abB;
    const pctA = total ? Math.round((abA / total) * 100) : 0;
    const pctB = total ? Math.round((abB / total) * 100) : 0;
    abContent.innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:0.75rem">' +
        '<div style="background:rgba(91,79,255,0.12);border:1px solid rgba(91,79,255,0.35);border-radius:8px;padding:0.75rem;text-align:center">' +
          '<div style="font-size:1.3rem;font-weight:800;color:#5b4fff">' + abA + '</div>' +
          '<div style="font-size:0.78rem;font-weight:700;color:#9b8cff;margin-top:0.1rem">Variant A</div>' +
          '<div style="font-size:0.72rem;color:#9898b8">Originálna správa</div>' +
        '</div>' +
        '<div style="background:rgba(31,216,154,0.08);border:1px solid rgba(31,216,154,0.3);border-radius:8px;padding:0.75rem;text-align:center">' +
          '<div style="font-size:1.3rem;font-weight:800;color:#1fd89a">' + abB + '</div>' +
          '<div style="font-size:0.78rem;font-weight:700;color:#1fd89a;margin-top:0.1rem">Variant B</div>' +
          '<div style="font-size:0.72rem;color:#9898b8">Alternatívna správa</div>' +
        '</div>' +
      '</div>' +
      '<div style="font-size:0.78rem;color:#9898b8;margin-bottom:0.3rem">Podiel leadov</div>' +
      '<div style="height:10px;background:#24243a;border-radius:99px;overflow:hidden;display:flex">' +
        '<div style="width:' + pctA + '%;background:#5b4fff;transition:width 0.4s"></div>' +
        '<div style="width:' + pctB + '%;background:#1fd89a;transition:width 0.4s"></div>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;font-size:0.72rem;color:#9898b8;margin-top:0.25rem">' +
        '<span>A: ' + pctA + '%</span><span>B: ' + pctB + '%</span>' +
      '</div>';
  } else if (abEl) {
    abEl.style.display = 'none';
  }

  if (!data.total) {
    empty.style.display = '';
    charts.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  charts.style.display = 'grid';

  // Topics tag cloud
  var maxT = (data.topics[0] && data.topics[0].count) || 1;
  var topicsEl = document.getElementById('ins-topics');
  if (topicsEl) {
    topicsEl.innerHTML = data.topics.length
      ? '<div style="display:flex;flex-wrap:wrap;gap:0.5rem">' + data.topics.map(function(t) {
          var size = (0.75 + (t.count / maxT) * 0.55).toFixed(2);
          var opacity = (0.4 + (t.count / maxT) * 0.6).toFixed(2);
          return '<span style="background:rgba(91,79,255,' + opacity + ');color:white;border-radius:99px;padding:4px 12px;font-size:' + size + 'rem;font-weight:600" title="' + t.count + '×">' + escHtml(t.topic) + ' <span style="opacity:0.7;font-size:0.75em">' + t.count + '</span></span>';
        }).join('') + '</div>'
      : '<div style="color:#7e7ea0;font-size:0.85rem">Žiadne témy</div>';
  }

  function renderBars(containerId, rows, labelMap, colorMap) {
    var el = document.getElementById(containerId);
    if (!el) return;
    if (!rows || !rows.length) { el.innerHTML = '<div style="color:#7e7ea0;font-size:0.85rem">Žiadne dáta</div>'; return; }
    var maxVal = rows[0].count;
    el.innerHTML = rows.map(function(r) {
      var key = Object.keys(r).find(function(k) { return k !== 'count'; });
      var val = r[key];
      var pct = Math.round((r.count / maxVal) * 100);
      var label = labelMap[val] || val;
      var color = colorMap[val] || '#5b4fff';
      return '<div style="margin-bottom:0.65rem">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.2rem">' +
        '<span style="font-size:0.82rem;font-weight:600;color:#eeeef5">' + escHtml(label) + '</span>' +
        '<span style="font-size:0.78rem;color:#9898b8;font-weight:700">' + r.count + '</span>' +
        '</div>' +
        '<div style="height:8px;background:#24243a;border-radius:99px;overflow:hidden">' +
        '<div style="height:100%;width:' + pct + '%;background:' + color + ';border-radius:99px;transition:width 0.4s"></div>' +
        '</div></div>';
    }).join('');
  }

  renderBars('ins-intents',    data.intents,    INS_INTENT_LABELS, INS_COLORS);
  renderBars('ins-objections', data.objections, INS_OBJ_LABELS,    INS_COLORS);
  renderBars('ins-urgency',    data.urgency,    INS_URG_LABELS,    INS_COLORS);
}

/* ═══════════════════════════════════════════════════════════════
   INBOX — conversation list + live takeover
   ══════════════════════════════════════════════════════════════ */

let _inboxConvs = [];
let _activeConvId = null;
let _activeConvIsLive = false;

async function loadInbox() {
  if (!currentWidget) return;
  const res = await apiFetch(`/api/widgets/${currentWidget.id}/conversations`);
  if (!res || !res.ok) return;
  _inboxConvs = await res.json();
  renderInboxList();
}

function renderInboxList() {
  const list = document.getElementById('inbox-list');
  if (!list) return;
  if (!_inboxConvs.length) {
    list.innerHTML = '<div style="padding:2rem 1rem;text-align:center;color:#7e7ea0;font-size:0.875rem">Žiadne konverzácie</div>';
    return;
  }
  list.innerHTML = _inboxConvs.map(c => {
    const lastMsg = c.last_msg ? c.last_msg.slice(0, 60) + (c.last_msg.length > 60 ? '…' : '') : '—';
    const dt = c.last_msg_at ? new Date(c.last_msg_at * 1000).toLocaleDateString('sk-SK', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '';
    const live = c.live_agent ? '<span style="background:rgba(31,216,154,0.14);color:#1fd89a;font-size:0.65rem;font-weight:700;padding:0.15rem 0.4rem;border-radius:99px;margin-left:0.35rem">LIVE</span>' : '';
    const isActive = c.id === _activeConvId;
    return `<div data-conv-id="${escHtml(c.id)}"
      style="padding:0.7rem 1rem;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.06);${isActive ? 'background:rgba(91,79,255,0.12);border-left:3px solid #5b4fff;' : ''}transition:background 0.1s">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.2rem">
        <span style="font-size:0.8rem;font-weight:700;color:#eeeef5">${escHtml(c.lead_name || c.session_id.slice(0,12)+'…')}${live}</span>
        <span style="font-size:0.7rem;color:#7e7ea0;white-space:nowrap">${dt}</span>
      </div>
      <div style="font-size:0.75rem;color:#9898b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(lastMsg)}</div>
      <div style="font-size:0.7rem;color:#7e7ea0;margin-top:0.15rem">${c.msg_count} správ</div>
    </div>`;
  }).join('');

  // Event delegation — one listener on the list, removed & re-added on each render
  list._inboxHandler && list.removeEventListener('click', list._inboxHandler);
  list._inboxHandler = function(e) {
    const item = e.target.closest('[data-conv-id]');
    if (item) openConversation(item.dataset.convId);
  };
  list.addEventListener('click', list._inboxHandler);
}

async function openConversation(convId) {
  _activeConvId = convId;
  try {
    renderInboxList(); // re-render to highlight active
    const res = await apiFetch(`/api/widgets/${currentWidget.id}/conversations/${convId}/messages`);
    if (!res) return; // 401 — apiFetch already called logout()
    if (!res.ok) {
      let errMsg = `Chyba ${res.status}`;
      try { const d = await res.json(); errMsg = d.error || errMsg; } catch {}
      console.error('[openConversation]', errMsg);
      showToast('Nepodarilo sa načítať konverzáciu: ' + errMsg, 'error');
      return;
    }
    const msgs = await res.json();

    const conv = _inboxConvs.find(c => c.id === convId);
    _activeConvIsLive = !!(conv && conv.live_agent);

    const panel = document.getElementById('inbox-transcript-panel');
    const hint  = document.getElementById('inbox-select-hint');
    panel.style.display = 'block';
    hint.style.display  = 'none';

    document.getElementById('inbox-conv-title').textContent = conv?.lead_name || 'Anonymný návštevník';
    document.getElementById('inbox-conv-meta').textContent = conv ? `Session: ${conv.session_id.slice(0,16)}… · ${conv.msg_count} správ` : '';

    const liveBadge = document.getElementById('inbox-live-badge');
    const takeoverBtn = document.getElementById('inbox-takeover-btn');
    const replyBox = document.getElementById('inbox-agent-reply');
    liveBadge.style.display = _activeConvIsLive ? '' : 'none';
    takeoverBtn.textContent = _activeConvIsLive ? 'Odovzdať AI' : 'Prevziať chat';
    if (replyBox) replyBox.style.display = _activeConvIsLive ? 'flex' : 'none';

    const msgsEl = document.getElementById('inbox-messages');
    msgsEl.innerHTML = msgs.map(m => {
      const isUser = m.role === 'user';
      return `<div style="display:flex;${isUser ? 'justify-content:flex-end' : ''}">
        <div style="max-width:75%;padding:0.55rem 0.8rem;border-radius:${isUser ? '14px 14px 4px 14px' : '14px 14px 14px 4px'};
          background:${isUser ? '#5b4fff' : '#24243a'};color:${isUser ? '#fff' : '#eeeef5'};font-size:0.84rem;line-height:1.45;word-break:break-word">
          ${escHtml(m.content)}
        </div>
      </div>`;
    }).join('');
    msgsEl.scrollTop = msgsEl.scrollHeight;
  } catch (e) {
    console.error('[openConversation] unexpected error:', e);
    showToast('Chyba pri otváraní konverzácie: ' + e.message, 'error');
  }
}

async function toggleLiveTakeover() {
  if (!_activeConvId || !currentWidget) return;
  const res = await apiFetch(`/api/widgets/${currentWidget.id}/conversations/${_activeConvId}/takeover`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ live: !_activeConvIsLive }),
  });
  if (!res || !res.ok) return;
  _activeConvIsLive = !_activeConvIsLive;
  if (_inboxConvs) {
    const conv = _inboxConvs.find(c => c.id === _activeConvId);
    if (conv) conv.live_agent = _activeConvIsLive ? 1 : 0;
  }
  const liveBadge = document.getElementById('inbox-live-badge');
  const takeoverBtn = document.getElementById('inbox-takeover-btn');
  const replyBox = document.getElementById('inbox-agent-reply');
  liveBadge.style.display = _activeConvIsLive ? '' : 'none';
  takeoverBtn.textContent = _activeConvIsLive ? 'Odovzdať AI' : 'Prevziať chat';
  if (replyBox) replyBox.style.display = _activeConvIsLive ? 'flex' : 'none';
  showToast(_activeConvIsLive ? 'Chat prebraný – odpovedáte vy' : 'Chat vrátený AI asistentovi');
}

async function sendAgentMessage() {
  if (!_activeConvId || !currentWidget) return;
  const input = document.getElementById('inbox-agent-input');
  const text = input?.value.trim();
  if (!text) return;
  const res = await apiFetch(`/api/widgets/${currentWidget.id}/conversations/${_activeConvId}/agent-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text }),
  });
  if (!res || !res.ok) return;
  input.value = '';
  // Append message to transcript
  const msgsEl = document.getElementById('inbox-messages');
  if (msgsEl) {
    msgsEl.insertAdjacentHTML('beforeend', `
      <div style="display:flex;justify-content:flex-end">
        <div style="max-width:75%;padding:0.55rem 0.8rem;border-radius:14px 14px 4px 14px;background:#5b4fff;color:#fff;font-size:0.84rem;line-height:1.45;word-break:break-word">${escHtml(text)}</div>
      </div>`);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
}

/* ═══════════════════════════════════════════════════════════════
   INTEGRATIONS — webhooks, branding, hours, CSAT, A/B, WooCommerce, team
   ══════════════════════════════════════════════════════════════ */

const BH_DAYS = [
  { key: '1', label: 'Pondelok' },
  { key: '2', label: 'Utorok' },
  { key: '3', label: 'Streda' },
  { key: '4', label: 'Štvrtok' },
  { key: '5', label: 'Piatok' },
  { key: '6', label: 'Sobota' },
  { key: '0', label: 'Nedeľa' },
];

function loadIntegrations() {
  if (!currentWidget) return;
  const w = currentWidget;

  document.getElementById('int-webhook-url').value   = w.webhook_url        || '';
  document.getElementById('int-slack-url').value     = w.slack_webhook_url  || '';
  document.getElementById('int-hide-branding').checked = Boolean(w.hide_branding);
  document.getElementById('int-csat-enabled').checked  = Boolean(w.csat_enabled);
  document.getElementById('int-ab-enabled').checked    = Boolean(w.ab_test_enabled);
  document.getElementById('int-welcome-b').value      = w.welcome_message_b || '';
  document.getElementById('int-auto-reply-enabled').checked = Boolean(w.auto_reply_enabled);
  document.getElementById('int-auto-reply-msg').value  = w.auto_reply_message || '';
  document.getElementById('int-offline-msg').value     = w.offline_message   || '';
  toggleAutoReplyFields();

  // Business hours
  const bh = w.business_hours || {};
  document.getElementById('int-bh-enabled').checked = Boolean(bh.enabled);
  renderBhDays(bh);
  toggleBhFields();

  // WooCommerce status
  loadWooStatus();

  // Team
  loadTeam();
}

function renderBhDays(bh) {
  const container = document.getElementById('int-bh-days');
  if (!container) return;
  const days = bh.days || {};
  container.innerHTML = BH_DAYS.map(d => {
    const cfg = days[d.key] || { enabled: d.key !== '0' && d.key !== '6', start: '09:00', end: '17:00' };
    return `<div style="display:grid;grid-template-columns:120px 1fr 1fr;gap:0.5rem;align-items:center">
      <label style="display:flex;align-items:center;gap:0.4rem;font-size:0.875rem;cursor:pointer">
        <input type="checkbox" class="bh-day-chk" data-day="${d.key}" ${cfg.enabled ? 'checked' : ''} style="width:14px;height:14px">
        ${d.label}
      </label>
      <input type="time" class="form-control bh-start" data-day="${d.key}" value="${cfg.start || '09:00'}" style="font-size:0.8rem;padding:0.3rem 0.5rem">
      <input type="time" class="form-control bh-end" data-day="${d.key}" value="${cfg.end || '17:00'}" style="font-size:0.8rem;padding:0.3rem 0.5rem">
    </div>`;
  }).join('');
}

function toggleBhFields() {
  const enabled = document.getElementById('int-bh-enabled')?.checked;
  const fields = document.getElementById('int-bh-fields');
  if (fields) fields.style.display = enabled ? '' : 'none';
}

function toggleAutoReplyFields() {
  const enabled = document.getElementById('int-auto-reply-enabled')?.checked;
  const fields = document.getElementById('int-auto-reply-fields');
  if (fields) fields.style.display = enabled ? '' : 'none';
}

function readBhValue() {
  const enabled = document.getElementById('int-bh-enabled')?.checked;
  if (!enabled) return { enabled: false };
  const days = {};
  BH_DAYS.forEach(d => {
    const chk   = document.querySelector(`.bh-day-chk[data-day="${d.key}"]`);
    const start = document.querySelector(`.bh-start[data-day="${d.key}"]`);
    const end   = document.querySelector(`.bh-end[data-day="${d.key}"]`);
    days[d.key] = { enabled: chk?.checked || false, start: start?.value || '09:00', end: end?.value || '17:00' };
  });
  return { enabled: true, days };
}

async function saveIntegrations() {
  if (!currentWidget) return;
  const body = {
    webhook_url:        document.getElementById('int-webhook-url').value.trim() || null,
    slack_webhook_url:  document.getElementById('int-slack-url').value.trim()   || null,
    hide_branding:      document.getElementById('int-hide-branding').checked ? 1 : 0,
    csat_enabled:       document.getElementById('int-csat-enabled').checked   ? 1 : 0,
    ab_test_enabled:    document.getElementById('int-ab-enabled').checked     ? 1 : 0,
    welcome_message_b:  document.getElementById('int-welcome-b').value.trim(),
    auto_reply_enabled: document.getElementById('int-auto-reply-enabled').checked ? 1 : 0,
    auto_reply_message: document.getElementById('int-auto-reply-msg').value.trim(),
    offline_message:    document.getElementById('int-offline-msg').value.trim(),
    business_hours:     JSON.stringify(readBhValue()),
  };
  const res = await apiFetch(`/api/widgets/${currentWidget.id}`, {
    method: 'PUT',
    body: JSON.stringify({ ...currentWidget, ...body }),
  });
  if (res && res.ok) {
    Object.assign(currentWidget, body);
    showToast('Integrácie uložené');
  } else {
    const data = res ? await res.json().catch(() => ({})) : {};
    if (data.error === 'white_label_required') {
      // Revert toggle visually
      document.getElementById('int-hide-branding').checked = false;
      showToast('⬆️ White-label je dostupný iba v pláne White Label (€997/mes). Upgradujte v Stripe portáli.', 'error');
    } else {
      showToast('Chyba pri ukladaní', 'error');
    }
  }
}

/* ── WooCommerce ──────────────────────────────────────────────── */
async function loadWooStatus() {
  if (!currentWidget) return;
  const res = await apiFetch(`/api/woocommerce/${currentWidget.id}/status`);
  if (!res || !res.ok) return;
  const data = await res.json();
  const connected = document.getElementById('woo-connected-status');
  const form      = document.getElementById('woo-form');
  if (data.connected) {
    connected.style.display = 'flex';
    document.getElementById('woo-status-text').textContent = `✅ Pripojené: ${data.shop_url || ''}`;
    if (form) form.style.display = 'none';
  } else {
    connected.style.display = 'none';
    if (form) form.style.display = '';
  }
}

async function connectWooCommerce() {
  if (!currentWidget) return;
  const storeUrl = document.getElementById('woo-url')?.value.trim();
  const ck       = document.getElementById('woo-key')?.value.trim();
  const cs       = document.getElementById('woo-secret')?.value.trim();
  if (!storeUrl || !ck || !cs) { showToast('Vyplňte všetky polia', 'error'); return; }
  const res = await apiFetch(`/api/woocommerce/${currentWidget.id}/connect`, {
    method: 'POST',
    body: JSON.stringify({ storeUrl, consumerKey: ck, consumerSecret: cs }),
  });
  if (res && res.ok) {
    const d = await res.json();
    showToast(`Importovaných ${d.imported} produktov`);
    loadWooStatus();
  } else {
    showToast('Nepodarilo sa pripojiť', 'error');
  }
}

async function disconnectWooCommerce() {
  if (!currentWidget) return;
  const res = await apiFetch(`/api/woocommerce/${currentWidget.id}/disconnect`, { method: 'DELETE' });
  if (res && res.ok) { showToast('WooCommerce odpojený'); loadWooStatus(); }
}

/* ── Team Management ──────────────────────────────────────────── */
async function loadTeam() {
  const res = await apiFetch('/api/team');
  if (!res || !res.ok) return;
  const members = await res.json();
  const list  = document.getElementById('team-list');
  const empty = document.getElementById('team-empty');
  if (!list) return;
  if (!members.length) {
    empty.style.display = '';
    list.innerHTML = '';
    list.appendChild(empty);
    return;
  }
  empty.style.display = 'none';
  const ROLE_LABELS = { readonly: 'Čítanie', editor: 'Editor' };
  list.innerHTML = members.map(m => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:0.6rem 0.75rem;background:#111120;border-radius:8px;gap:0.5rem">
      <div>
        <div style="font-size:0.875rem;font-weight:600;color:#eeeef5">${escHtml(m.email)}</div>
        <div style="font-size:0.75rem;color:#9898b8">${ROLE_LABELS[m.role] || m.role} · ${m.accepted ? '✅ Prijatý' : '⏳ Čakajúci'}</div>
      </div>
      <button class="btn btn-sm btn-secondary" onclick="deleteTeamMember('${escHtml(m.id)}')">Odstraniť</button>
    </div>`).join('');
}

function openInviteModal() {
  const el = document.getElementById('modal-invite');
  if (el) { el.style.display = 'flex'; document.getElementById('invite-email')?.focus(); }
}

function closeInviteModal(e) {
  if (e && e.target !== document.getElementById('modal-invite')) return;
  document.getElementById('modal-invite').style.display = 'none';
}

async function inviteTeamMember() {
  const email = document.getElementById('invite-email')?.value.trim();
  const role  = document.getElementById('invite-role')?.value;
  if (!email) { showToast('Zadajte email', 'error'); return; }
  const res = await apiFetch('/api/team/invite', {
    method: 'POST',
    body: JSON.stringify({ email, role }),
  });
  if (res && res.ok) {
    showToast('Pozvánka odoslaná');
    document.getElementById('modal-invite').style.display = 'none';
    document.getElementById('invite-email').value = '';
    loadTeam();
  } else {
    showToast('Chyba pri pozvaní', 'error');
  }
}

async function deleteTeamMember(memberId) {
  if (!confirm('Odstrániť člena tímu?')) return;
  const res = await apiFetch(`/api/team/${memberId}`, { method: 'DELETE' });
  if (res && res.ok) { showToast('Člen odstránený'); loadTeam(); }
}

/* ═══════════════════════════════════════════════════════════════
   FACEBOOK MESSENGER
   ══════════════════════════════════════════════════════════════ */

async function loadFacebookStatus() {
  if (!currentWidget) return;
  const res = await apiFetch(`/api/facebook/${currentWidget.id}/status`);
  if (!res || !res.ok) return;
  const data = await res.json();

  const disconnected = document.getElementById('fb-panel-disconnected');
  const connected    = document.getElementById('fb-panel-connected');
  const settings     = document.getElementById('fb-panel-settings');
  const sessions     = document.getElementById('fb-panel-sessions');

  if (data.connected) {
    disconnected.style.display = 'none';
    connected.style.display    = '';
    settings.style.display     = '';
    sessions.style.display     = '';

    document.getElementById('fb-connected-name').textContent = data.page_name || 'Facebook Stránka';
    document.getElementById('fb-connected-id').textContent   = data.page_id ? `Page ID: ${data.page_id}` : '';
    const origin = window.location.origin;
    document.getElementById('fb-webhook-url').textContent = `${origin}/api/facebook/${currentWidget.id}/webhook`;

    // Populate settings
    const kws = Array.isArray(data.keyword_triggers) ? data.keyword_triggers.join('\n') : '';
    document.getElementById('fb-keywords').value    = kws;
    document.getElementById('fb-welcome-msg').value = data.welcome_msg || '';

    loadFacebookSessions();
  } else {
    disconnected.style.display = '';
    connected.style.display    = 'none';
    settings.style.display     = 'none';
    sessions.style.display     = 'none';
  }
}

async function connectFacebook() {
  if (!currentWidget) return;
  const token = document.getElementById('fb-token')?.value.trim();
  if (!token) { showToast('Zadajte Page Access Token', 'error'); return; }
  const res = await apiFetch(`/api/facebook/${currentWidget.id}/connect`, {
    method: 'POST',
    body: JSON.stringify({ pageAccessToken: token }),
  });
  if (res && res.ok) {
    showToast('Facebook Messenger pripojený');
    document.getElementById('fb-token').value = '';
    loadFacebookStatus();
  } else {
    const err = res ? await res.json().catch(() => ({})) : {};
    showToast(err.error || 'Nepodarilo sa pripojiť', 'error');
  }
}

async function disconnectFacebook() {
  if (!currentWidget || !confirm('Odpojiť Facebook Messenger?')) return;
  const res = await apiFetch(`/api/facebook/${currentWidget.id}/disconnect`, { method: 'DELETE' });
  if (res && res.ok) { showToast('Facebook Messenger odpojený'); loadFacebookStatus(); }
}

async function saveFacebookSettings() {
  if (!currentWidget) return;
  const keywords = (document.getElementById('fb-keywords')?.value || '')
    .split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);
  const welcome_msg = document.getElementById('fb-welcome-msg')?.value.trim() || '';
  const res = await apiFetch(`/api/facebook/${currentWidget.id}/settings`, {
    method: 'PUT',
    body: JSON.stringify({ keyword_triggers: keywords, welcome_msg }),
  });
  if (res && res.ok) showToast('Nastavenia uložené');
  else showToast('Chyba pri ukladaní', 'error');
}

async function loadFacebookSessions() {
  if (!currentWidget) return;
  const res = await apiFetch(`/api/facebook/${currentWidget.id}/sessions`);
  if (!res || !res.ok) return;
  const sessions = await res.json();
  const list = document.getElementById('fb-sessions-list');
  if (!list) return;
  if (!sessions.length) {
    list.innerHTML = '<div style="font-size:0.875rem;color:#7e7ea0;padding:1rem 0">Zatiaľ žiadne Messenger konverzácie.</div>';
    return;
  }
  list.innerHTML = sessions.map(s => {
    const live = s.live_agent ? '<span style="background:rgba(31,216,154,0.14);color:#1fd89a;font-size:0.65rem;font-weight:700;padding:0.15rem 0.4rem;border-radius:99px;margin-left:0.4rem">LIVE</span>' : '';
    const dt = s.updated_at ? new Date(s.updated_at * 1000).toLocaleString('sk-SK', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
    const lastMsg = s.last_msg ? s.last_msg.slice(0,60) + (s.last_msg.length > 60 ? '…' : '') : '—';
    return `<div style="padding:0.65rem 0.75rem;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:space-between;gap:0.75rem">
      <div style="flex:1;min-width:0">
        <div style="font-size:0.85rem;font-weight:700;color:#eeeef5">${escHtml(s.sender_name || s.sender_id)}${live}</div>
        <div style="font-size:0.75rem;color:#9898b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(lastMsg)}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:0.25rem;flex-shrink:0">
        <span style="font-size:0.7rem;color:#7e7ea0">${dt}</span>
        <button class="btn btn-sm btn-secondary" style="font-size:0.72rem" onclick="toggleFbTakeover('${escHtml(s.id)}','${escHtml(currentWidget.id)}',${s.live_agent ? 1 : 0})">
          ${s.live_agent ? 'Odovzdať AI' : 'Prevziať'}
        </button>
      </div>
    </div>`;
  }).join('');
}

async function toggleFbTakeover(sessionId, widgetId, currentLive) {
  const res = await apiFetch(`/api/facebook/${widgetId}/sessions/${sessionId}/takeover`, {
    method: 'PATCH',
    body: JSON.stringify({ live: !currentLive }),
  });
  if (res && res.ok) { showToast(currentLive ? 'Chat vrátený AI' : 'Chat prebraný'); loadFacebookSessions(); }
}

/* ═══════════════════════════════════════════════════════════════
   ECOMAIL EMAIL MARKETING
   ══════════════════════════════════════════════════════════════ */

let _ecomailLists = [];  // cached list from API

async function loadEcomailStatus() {
  if (!currentWidget) return;
  const res = await apiFetch(`/api/ecomail/${currentWidget.id}/status`);
  if (!res || !res.ok) return;
  const data = await res.json();

  const connected    = document.getElementById('ecomail-connected');
  const disconnected = document.getElementById('ecomail-disconnected');
  if (!connected || !disconnected) return;

  if (data.connected) {
    connected.style.display    = '';
    disconnected.style.display = 'none';
    document.getElementById('ecomail-list-name-display').textContent = data.list_name || `#${data.list_id}`;
  } else {
    connected.style.display    = 'none';
    disconnected.style.display = '';
  }
}

async function ecomailLoadLists() {
  const apiKey = document.getElementById('ecomail-api-key-input')?.value.trim();
  const errEl  = document.getElementById('ecomail-error');
  const btn    = document.getElementById('ecomail-load-lists-btn');
  if (!apiKey) { if (errEl) { errEl.textContent = 'Vložte API kľúč.'; errEl.style.display = ''; } return; }
  if (errEl) errEl.style.display = 'none';
  if (btn) { btn.disabled = true; btn.textContent = 'Načítavam…'; }

  const res = await apiFetch(`/api/ecomail/${currentWidget.id}/lists`, {
    method: 'POST',
    body: JSON.stringify({ apiKey }),
  });
  if (btn) { btn.disabled = false; btn.textContent = 'Načítať moje zoznamy →'; }

  if (!res || !res.ok) {
    const err = res ? await res.json().catch(() => ({})) : {};
    if (errEl) { errEl.textContent = err.error || 'Nepodarilo sa načítať zoznamy.'; errEl.style.display = ''; }
    return;
  }
  const data = await res.json();
  _ecomailLists = data.lists || [];

  const select = document.getElementById('ecomail-list-select');
  const wrap   = document.getElementById('ecomail-lists-wrap');
  const connectWrap = document.getElementById('ecomail-connect-wrap');
  if (select) {
    select.innerHTML = '<option value="">— Vyberte zoznam —</option>' +
      _ecomailLists.map(l => `<option value="${escHtml(l.id)}">${escHtml(l.name)}</option>`).join('');
  }
  if (wrap) wrap.style.display = '';
  if (connectWrap) connectWrap.style.display = '';
}

async function connectEcomail() {
  if (!currentWidget) return;
  const apiKey = document.getElementById('ecomail-api-key-input')?.value.trim();
  const select = document.getElementById('ecomail-list-select');
  const listId = select?.value;
  const listName = select?.options[select.selectedIndex]?.text || '';
  const errEl = document.getElementById('ecomail-error');

  if (!apiKey || !listId) {
    if (errEl) { errEl.textContent = 'Vyberte zoznam.'; errEl.style.display = ''; }
    return;
  }
  if (errEl) errEl.style.display = 'none';

  const res = await apiFetch(`/api/ecomail/${currentWidget.id}/connect`, {
    method: 'POST',
    body: JSON.stringify({ apiKey, listId, listName }),
  });
  if (res && res.ok) {
    showToast('Ecomail prepojený! Leady pôjdu automaticky do vášho zoznamu.');
    document.getElementById('ecomail-api-key-input').value = '';
    loadEcomailStatus();
  } else {
    const err = res ? await res.json().catch(() => ({})) : {};
    if (errEl) { errEl.textContent = err.error || 'Chyba pri prepojení.'; errEl.style.display = ''; }
  }
}

async function disconnectEcomail() {
  if (!currentWidget || !confirm('Odpojiť Ecomail? Leady sa prestanú automaticky pridávať.')) return;
  const res = await apiFetch(`/api/ecomail/${currentWidget.id}/disconnect`, { method: 'DELETE' });
  if (res && res.ok) { showToast('Ecomail odpojený.'); loadEcomailStatus(); }
}

async function testEcomail() {
  if (!currentWidget) return;
  const email = document.getElementById('ecomail-test-email')?.value.trim();
  if (!email) { showToast('Zadajte testovací email', 'error'); return; }
  const res = await apiFetch(`/api/ecomail/${currentWidget.id}/test`, {
    method: 'POST',
    body: JSON.stringify({ testEmail: email }),
  });
  if (res && res.ok) {
    showToast('✅ Test lead odoslaný do Ecomailu! Skontrolujte váš zoznam.');
    document.getElementById('ecomail-test-email').value = '';
  } else {
    const err = res ? await res.json().catch(() => ({})) : {};
    showToast(err.error || 'Test zlyhal.', 'error');
  }
}

/* ── Account Settings ────────────────────────────────────────── */
function openAccountModal() {
  const el = document.getElementById('modal-account');
  if (!el) return;
  // reset fields and messages
  ['acc-cur-pw','acc-new-pw','acc-new-pw2','acc-new-email','acc-email-pw'].forEach(id => {
    const f = document.getElementById(id); if (f) f.value = '';
  });
  ['acc-pw-err','acc-pw-ok','acc-email-err','acc-email-ok'].forEach(id => {
    const f = document.getElementById(id); if (f) { f.style.display = 'none'; f.textContent = ''; }
  });
  switchAccTab('pw');
  el.style.display = 'flex';
}

function closeAccountModal() {
  const el = document.getElementById('modal-account');
  if (el) el.style.display = 'none';
}

function switchAccTab(tab) {
  const isPw = tab === 'pw';
  document.getElementById('acc-panel-pw').style.display = isPw ? '' : 'none';
  document.getElementById('acc-panel-email').style.display = isPw ? 'none' : '';
  document.getElementById('acc-tab-pw').style.cssText = isPw
    ? 'flex:1;background:#5b4fff;color:white;border:none;border-radius:8px;padding:0.5rem;font-size:0.85rem;font-weight:600;cursor:pointer;font-family:inherit'
    : 'flex:1;background:none;color:#9898b8;border:none;border-radius:8px;padding:0.5rem;font-size:0.85rem;font-weight:600;cursor:pointer;font-family:inherit';
  document.getElementById('acc-tab-email').style.cssText = isPw
    ? 'flex:1;background:none;color:#9898b8;border:none;border-radius:8px;padding:0.5rem;font-size:0.85rem;font-weight:600;cursor:pointer;font-family:inherit'
    : 'flex:1;background:#5b4fff;color:white;border:none;border-radius:8px;padding:0.5rem;font-size:0.85rem;font-weight:600;cursor:pointer;font-family:inherit';
}

async function doChangePassword() {
  const errEl = document.getElementById('acc-pw-err');
  const okEl = document.getElementById('acc-pw-ok');
  errEl.style.display = 'none'; okEl.style.display = 'none';

  const cur = document.getElementById('acc-cur-pw').value;
  const nw = document.getElementById('acc-new-pw').value;
  const nw2 = document.getElementById('acc-new-pw2').value;

  if (!cur || !nw || !nw2) {
    errEl.textContent = 'Vyplňte všetky polia.'; errEl.style.display = ''; return;
  }
  if (nw.length < 8) {
    errEl.textContent = 'Nové heslo musí mať aspoň 8 znakov.'; errEl.style.display = ''; return;
  }
  if (nw !== nw2) {
    errEl.textContent = 'Nové heslá sa nezhodujú.'; errEl.style.display = ''; return;
  }

  const res = await apiFetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: cur, newPassword: nw }),
  });
  if (!res) return;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { errEl.textContent = data.error || 'Chyba.'; errEl.style.display = ''; return; }

  document.getElementById('acc-cur-pw').value = '';
  document.getElementById('acc-new-pw').value = '';
  document.getElementById('acc-new-pw2').value = '';
  okEl.style.display = '';
}

async function doChangeEmail() {
  const errEl = document.getElementById('acc-email-err');
  const okEl = document.getElementById('acc-email-ok');
  errEl.style.display = 'none'; okEl.style.display = 'none';

  const newEmail = document.getElementById('acc-new-email').value.trim();
  const pw = document.getElementById('acc-email-pw').value;

  if (!newEmail || !pw) {
    errEl.textContent = 'Vyplňte všetky polia.'; errEl.style.display = ''; return;
  }

  const res = await apiFetch('/api/auth/change-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newEmail, password: pw }),
  });
  if (!res) return;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { errEl.textContent = data.error || 'Chyba.'; errEl.style.display = ''; return; }

  // Update stored user info and UI
  const stored = JSON.parse(localStorage.getItem('nd_user') || '{}');
  stored.email = data.email;
  localStorage.setItem('nd_user', JSON.stringify(stored));
  const emailEl = document.getElementById('user-email');
  if (emailEl) emailEl.textContent = data.email;

  document.getElementById('acc-new-email').value = '';
  document.getElementById('acc-email-pw').value = '';
  okEl.textContent = `Email bol zmenený na ${data.email}.`;
  okEl.style.display = '';
}
