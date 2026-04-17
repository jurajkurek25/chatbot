/* ================================================================
   Neoworkly – Onboarding JS
   4-step flow: Subscription → Knowledge → Questions&CTA → Embed
   ================================================================ */

const API = '';   // same origin

// ── State ────────────────────────────────────────────────────────
let currentStep = 1;
let widgetId = null;
let questions = [];
let knowledgeItems = [];

// ── Auth guard ───────────────────────────────────────────────────
const token = localStorage.getItem('nd_token');
if (!token) {
  window.location.href = '/';
}

function authHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

// ── Toast ────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const el = document.getElementById('ob-toast');
  el.textContent = msg;
  el.className = `ob-toast ob-toast-${type}`;
  el.style.display = 'block';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.display = 'none'; }, 3500);
}

// ── Step navigation ──────────────────────────────────────────────
function goToStep(n) {
  document.querySelectorAll('.ob-panel').forEach(p => p.classList.add('hidden'));
  document.getElementById(`step-${n}`).classList.remove('hidden');
  currentStep = n;
  updateSidebar(n);
  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (n === 2) ensureWidget().then(() => loadKnowledge());
  if (n === 4) loadEmbedCode();
  if (n === 5) initBoostStep();
}

function updateSidebar(active) {
  for (let i = 1; i <= 5; i++) {
    const el = document.getElementById(`ps-${i}`);
    if (el) {
      el.classList.remove('active', 'done');
      if (i < active) el.classList.add('done');
      else if (i === active) el.classList.add('active');
    }
    const mdot = document.getElementById(`mps-${i}`);
    if (mdot) {
      mdot.classList.remove('active', 'done');
      if (i < active) mdot.classList.add('done');
      else if (i === active) mdot.classList.add('active');
    }
    if (i < 5) {
      const mline = document.getElementById(`mpl-${i}`);
      if (mline) mline.classList.toggle('done', i < active);
    }
  }
  const label = document.getElementById('ob-mobile-step-label');
  if (label) label.textContent = `Krok ${active} z 5`;
}

// ── Logout ───────────────────────────────────────────────────────
function logout() {
  localStorage.removeItem('nd_token');
  localStorage.removeItem('nd_user');
  window.location.href = '/';
}

// ════════════════════════════════════════════════════════════════
// STEP 1 – Subscription
// ════════════════════════════════════════════════════════════════

async function checkSubscription() {
  try {
    const r = await fetch(`${API}/api/stripe/status`, { headers: authHeaders() });
    if (!r.ok) return false;
    const data = await r.json();
    return data.active === true;
  } catch {
    return false;
  }
}

function selectPlan(plan) {
  document.getElementById('plan-pro').style.borderColor = plan === 'pro' ? 'var(--primary)' : 'rgba(255,255,255,0.1)';
  document.getElementById('plan-white-label').style.borderColor = plan === 'white_label' ? '#7c3aed' : 'rgba(255,255,255,0.1)';
}

async function startCheckout(plan) {
  const btnId = plan === 'white_label' ? 'btn-checkout-wl' : 'btn-checkout-pro';
  const btn = document.getElementById(btnId);
  const label = plan === 'white_label' ? '💳 Vybrať White Label – €997/mesiac' : '💳 Vybrať Pro – €37/mesiac';
  btn.disabled = true;
  btn.textContent = 'Presmerovávam...';
  try {
    const r = await fetch(`${API}/api/stripe/checkout`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ plan: plan || 'pro' })
    });
    const data = await r.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      showToast('Chyba pri vytváraní platby.', 'error');
      btn.disabled = false;
      btn.textContent = label;
    }
  } catch {
    showToast('Sieťová chyba. Skúste znovu.', 'error');
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function handleStripeReturn() {
  const params = new URLSearchParams(window.location.search);
  const success = params.get('success');
  const sessionId = params.get('session_id');

  if (success === '1' && sessionId) {
    // Try to verify session (in case webhook is slow)
    try {
      await fetch(`${API}/api/stripe/verify-session`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ sessionId })
      });
    } catch { /* ignore */ }

    // Poll up to 5s for subscription to become active
    let active = false;
    for (let i = 0; i < 5; i++) {
      active = await checkSubscription();
      if (active) break;
      await new Promise(res => setTimeout(res, 1000));
    }

    if (active) {
      showSubscriptionActive();
    } else {
      showToast('Platba prebieha. Chvíľu počkajte...', 'info');
      setTimeout(async () => {
        const ok = await checkSubscription();
        if (ok) showSubscriptionActive();
        else showToast('Predplatné sa nepodarilo overiť. Kontaktujte podporu.', 'error');
      }, 4000);
    }

    // Clean URL
    window.history.replaceState({}, '', '/onboarding');
  }
}

function showSubscriptionActive() {
  document.getElementById('btn-checkout').style.display = 'none';
  document.querySelector('.pricing-box-note').style.display = 'none';
  document.getElementById('subscription-active-msg').style.display = 'block';
}

// ════════════════════════════════════════════════════════════════
// STEP 2 – Knowledge
// ════════════════════════════════════════════════════════════════

async function ensureWidget() {
  if (widgetId) return;
  // Load existing widgets first
  try {
    const r = await fetch(`${API}/api/widgets`, { headers: authHeaders() });
    const data = await r.json();
    const widgetList = Array.isArray(data) ? data : (data.widgets || []);
    if (widgetList.length > 0) {
      widgetId = widgetList[0].id;
      // Populate bot name / color from existing widget
      const w = widgetList[0];
      if (w.bot_name) document.getElementById('ob-bot-name').value = w.bot_name;
      if (w.primary_color) {
        document.getElementById('ob-color').value = w.primary_color;
        document.getElementById('ob-color-hex').textContent = w.primary_color;
      }
      return;
    }
  } catch { /* no widgets yet */ }

  // Create a new widget
  try {
    const r = await fetch(`${API}/api/widgets`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        name: 'Môj chatbot',
        bot_name: document.getElementById('ob-bot-name').value || 'Asistent',
        primary_color: document.getElementById('ob-color').value || '#2563eb',
        welcome_message: 'Ahoj! Ako vám môžem pomôcť? 👋'
      })
    });
    const data = await r.json();
    widgetId = data.widget?.id || data.id;
  } catch {
    showToast('Nepodarilo sa vytvoriť widget.', 'error');
  }
}

async function loadKnowledge() {
  if (!widgetId) return;
  try {
    const r = await fetch(`${API}/api/knowledge/${widgetId}`, { headers: authHeaders() });
    const data = await r.json();
    knowledgeItems = Array.isArray(data) ? data : (data.items || []);
    renderKnowledgeList();
  } catch { /* ignore */ }
}

function renderKnowledgeList() {
  const wrap = document.getElementById('ob-knowledge-list');
  const container = document.getElementById('ob-kl-items');

  if (knowledgeItems.length === 0) {
    wrap.style.display = 'none';
    document.getElementById('btn-step2-next').disabled = true;
    return;
  }

  wrap.style.display = 'block';
  document.getElementById('btn-step2-next').disabled = false;

  container.innerHTML = knowledgeItems.map(item => `
    <div class="ob-k-item" data-id="${item.id}">
      <div class="ob-k-item-info">
        <span class="ob-k-item-icon">${item.source_type === 'file' ? '📎' : '📝'}</span>
        <span class="ob-k-item-title">${escHtml(item.title || 'Bez názvu')}</span>
        <span class="ob-k-item-meta">${item.source_type === 'file' ? 'Súbor' : 'Text'}</span>
      </div>
      <button class="ob-k-delete" onclick="deleteKnowledge('${item.id}')">✕</button>
    </div>
  `).join('');
}

async function obScrapeWebsite() {
  if (!widgetId) { showToast('Najprv uložte nastavenia chatbota.', 'error'); return; }
  let url = document.getElementById('ob-scrape-url').value.trim();
  if (!url) { showToast('Zadajte URL adresu webu.', 'error'); return; }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  localStorage.setItem('ob_scrape_url', url);

  const btn = document.getElementById('ob-btn-scrape');
  const status = document.getElementById('ob-scrape-status');
  btn.disabled = true;
  btn.textContent = '⏳ Skenujem...';
  status.style.display = 'block';
  status.style.color = '#64748b';
  status.textContent = 'Skenujem stránky webu, prosím čakajte…';

  try {
    const res = await fetch(`${API}/api/scraper/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url, widget_id: widgetId, max_pages: 15 }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Chyba');

    status.style.color = '#16a34a';
    status.textContent = `✓ Importovaných ${d.imported} stránok do znalostnej bázy.`;
    showToast(`✓ ${d.imported} stránok naskenovaných!`, 'success');
    document.getElementById('ob-scrape-url').value = '';
    loadKnowledge();
  } catch (err) {
    status.style.color = '#dc2626';
    status.textContent = '✗ ' + err.message;
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Skenovať';
  }
}

async function addKnowledgeText() {
  const title = document.getElementById('ob-k-title').value.trim();
  const content = document.getElementById('ob-k-content').value.trim();
  if (!content) { showToast('Vložte obsah textu.', 'error'); return; }

  await ensureWidget();
  if (!widgetId) return;

  try {
    const r = await fetch(`${API}/api/knowledge/${widgetId}/text`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ title: title || 'Dokument', content })
    });
    if (!r.ok) throw new Error();
    showToast('Text bol pridaný.', 'success');
    document.getElementById('ob-k-title').value = '';
    document.getElementById('ob-k-content').value = '';
    await loadKnowledge();
  } catch {
    showToast('Chyba pri pridávaní textu.', 'error');
  }
}

async function uploadKnowledgeFile() {
  const fileInput = document.getElementById('ob-k-file');
  const file = fileInput.files[0];
  if (!file) { showToast('Vyberte súbor.', 'error'); return; }

  await ensureWidget();
  if (!widgetId) return;

  const formData = new FormData();
  formData.append('file', file);
  const customTitle = document.getElementById('ob-k-file-title').value.trim();
  if (customTitle) formData.append('title', customTitle);

  try {
    const r = await fetch(`${API}/api/knowledge/${widgetId}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData
    });
    if (!r.ok) throw new Error();
    showToast('Súbor bol nahratý.', 'success');
    fileInput.value = '';
    document.getElementById('ob-k-file-title').value = '';
    await loadKnowledge();
  } catch {
    showToast('Chyba pri nahrávaní súboru.', 'error');
  }
}

async function deleteKnowledge(id) {
  if (!widgetId) return;
  try {
    const r = await fetch(`${API}/api/knowledge/${widgetId}/${id}`, {
      method: 'DELETE',
      headers: authHeaders()
    });
    if (!r.ok) throw new Error();
    showToast('Dokument bol odstránený.', 'success');
    await loadKnowledge();
  } catch {
    showToast('Chyba pri mazaní.', 'error');
  }
}

async function finishStep2() {
  // Save bot name and color before moving on
  if (widgetId) {
    try {
      await fetch(`${API}/api/widgets/${widgetId}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          bot_name: document.getElementById('ob-bot-name').value || 'Asistent',
          primary_color: document.getElementById('ob-color').value || '#2563eb'
        })
      });
    } catch { /* non-critical */ }
  }
  goToStep(3);
}

// ════════════════════════════════════════════════════════════════
// STEP 3 – Questions & CTA
// ════════════════════════════════════════════════════════════════

async function generateQuestions() {
  if (!widgetId) { showToast('Najprv nahrajte dokumenty.', 'error'); return; }
  const btn = document.getElementById('btn-gen-questions');
  btn.disabled = true;
  btn.textContent = '⏳ Generujem...';

  try {
    const r = await fetch(`${API}/api/knowledge/${widgetId}/suggest-questions`, {
      method: 'POST',
      headers: authHeaders()
    });
    const data = await r.json();
    if (data.questions && data.questions.length) {
      // Merge with existing, deduplicate
      const existing = new Set(questions.map(q => q.toLowerCase()));
      data.questions.forEach(q => {
        if (!existing.has(q.toLowerCase())) questions.push(q);
      });
      renderQuestions();
      showToast('Otázky boli vygenerované!', 'success');
    } else {
      showToast('Nepodarilo sa vygenerovať otázky.', 'error');
    }
  } catch {
    showToast('Chyba pri generovaní otázok.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Generovať z dokumentov';
  }
}

function renderQuestions() {
  const list = document.getElementById('ob-questions-list');
  if (questions.length === 0) {
    list.innerHTML = '<p style="color:#94a3b8;font-size:0.875rem">Žiadne otázky. Kliknite Generovať alebo pridajte vlastnú.</p>';
    return;
  }
  list.innerHTML = questions.map((q, i) => `
    <div class="ob-question-item">
      <span>${escHtml(q)}</span>
      <button class="ob-q-delete" onclick="removeQuestion(${i})">✕</button>
    </div>
  `).join('');
}

function addQuestion() {
  const input = document.getElementById('ob-new-question');
  const q = input.value.trim();
  if (!q) return;
  questions.push(q);
  input.value = '';
  renderQuestions();
}

function removeQuestion(index) {
  questions.splice(index, 1);
  renderQuestions();
}

function getCTAConfig() {
  const type = document.querySelector('input[name="cta-type"]:checked')?.value || 'contact';
  const cfg = {};
  if (type === 'call') cfg.phone = document.getElementById('cta-phone').value.trim();
  if (type === 'contact') cfg.label = document.getElementById('cta-contact-label').value.trim();
  if (type === 'purchase') cfg.link = document.getElementById('cta-link').value.trim();
  if (type === 'order') cfg.details = document.getElementById('cta-order-details').value.trim();
  if (type === 'custom') cfg.text = document.getElementById('cta-custom-text').value.trim();
  return { type, cfg };
}

async function saveStep3() {
  if (!widgetId) { showToast('Chyba: widget neexistuje.', 'error'); return; }

  const { type, cfg } = getCTAConfig();
  const goals = document.getElementById('ob-goals').value.trim();
  const welcome = document.getElementById('ob-welcome').value.trim();

  try {
    const r = await fetch(`${API}/api/widgets/${widgetId}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({
        bot_name: document.getElementById('ob-bot-name').value || 'Asistent',
        primary_color: document.getElementById('ob-color').value || '#2563eb',
        welcome_message: welcome || 'Ahoj! Ako vám môžem pomôcť? 👋',
        cta_type: type,
        cta_config: JSON.stringify(cfg),
        goals,
        suggested_questions: JSON.stringify(questions)
      })
    });
    if (!r.ok) throw new Error();
    goToStep(4);
    loadEmbedCode();
  } catch {
    showToast('Chyba pri ukladaní nastavení.', 'error');
  }
}

// CTA type visibility
function setupCTAToggle() {
  document.querySelectorAll('input[name="cta-type"]').forEach(radio => {
    radio.addEventListener('change', () => {
      document.querySelectorAll('.cta-config-section').forEach(s => s.style.display = 'none');
      const section = document.getElementById(`cta-config-${radio.value}`);
      if (section) section.style.display = 'block';
    });
  });
}

// ════════════════════════════════════════════════════════════════
// STEP 4 – Embed code
// ════════════════════════════════════════════════════════════════

async function loadEmbedCode() {
  if (!widgetId) return;
  try {
    const r = await fetch(`${API}/api/widgets/${widgetId}/embed-code`, { headers: authHeaders() });
    const data = await r.json();
    document.getElementById('ob-embed-code').textContent = data.code || data.embedCode || '';
  } catch {
    document.getElementById('ob-embed-code').textContent = '<!-- Chyba pri načítavaní kódu -->';
  }
}

function copyCode() {
  const code = document.getElementById('ob-embed-code').textContent;
  navigator.clipboard.writeText(code)
    .then(() => showToast('Kód bol skopírovaný!', 'success'))
    .catch(() => showToast('Kopírovanie zlyhalo.', 'error'));
}

async function finishOnboarding() {
  try {
    await fetch(`${API}/api/widgets/complete-onboarding`, {
      method: 'POST',
      headers: authHeaders()
    });
  } catch { /* non-critical */ }
  window.location.href = '/dashboard';
}

// ════════════════════════════════════════════════════════════════
// STEP 5 – Growth Boost
// ════════════════════════════════════════════════════════════════

let boostAuditId = null;
let boostPollTimer = null;

async function initBoostStep() {
  // Check if already paid
  try {
    const r = await fetch(`${API}/api/seo/latest`, { headers: authHeaders() });
    const d = await r.json();
    if (d.has_boost) {
      showBoostPaid();
      return;
    }
    if (d.audit) {
      boostAuditId = d.audit.id;
      if (d.audit.status === 'running') {
        showBoostScanning();
        pollBoostAudit();
      } else if (d.audit.status === 'done') {
        renderBoostTeaser(d.audit);
      }
    }
  } catch { /* ignore */ }

  // Pre-fill URL from localStorage (set during step 2 scrape)
  const savedUrl = localStorage.getItem('ob_scrape_url');
  if (savedUrl) document.getElementById('boost-scan-url').value = savedUrl;
}

async function startBoostScan() {
  let url = document.getElementById('boost-scan-url').value.trim();
  if (!url) { showToast('Zadajte URL adresu webu.', 'error'); return; }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const btn = document.getElementById('btn-boost-scan');
  const status = document.getElementById('boost-scan-status');
  btn.disabled = true;
  btn.textContent = '⏳ Skenujem...';
  status.style.display = 'block';
  status.textContent = 'Spúšťam SEO analýzu…';

  try {
    const r = await fetch(`${API}/api/seo/start`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ url })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Chyba');
    boostAuditId = d.audit_id;
    showBoostScanning();
    pollBoostAudit();
  } catch (err) {
    status.style.color = '#dc2626';
    status.textContent = '✗ ' + err.message;
    btn.disabled = false;
    btn.textContent = 'Skenovať';
  }
}

function showBoostScanning() {
  const status = document.getElementById('boost-scan-status');
  status.style.display = 'block';
  status.style.color = '#64748b';
  status.textContent = '⏳ Analýza prebieha, prosím čakajte (30–60 sekúnd)…';
  document.getElementById('btn-boost-scan').disabled = true;
}

function pollBoostAudit() {
  if (!boostAuditId) return;
  clearTimeout(boostPollTimer);
  boostPollTimer = setTimeout(async () => {
    try {
      const r = await fetch(`${API}/api/seo/status/${boostAuditId}`, { headers: authHeaders() });
      const d = await r.json();
      if (d.status === 'done') {
        document.getElementById('boost-scan-status').style.display = 'none';
        document.getElementById('btn-boost-scan').disabled = false;
        document.getElementById('btn-boost-scan').textContent = 'Skenovať znovu';
        renderBoostTeaser(d);
      } else if (d.status === 'error') {
        document.getElementById('boost-scan-status').style.color = '#dc2626';
        document.getElementById('boost-scan-status').textContent = '✗ Audit zlyhal. Skúste znovu.';
        document.getElementById('btn-boost-scan').disabled = false;
        document.getElementById('btn-boost-scan').textContent = 'Skenovať';
      } else {
        pollBoostAudit();
      }
    } catch { pollBoostAudit(); }
  }, 3000);
}

const SEVERITY_ICON = { critical: '🔴', warning: '🟡', info: '🔵' };

function renderBoostTeaser(audit) {
  const card = document.getElementById('boost-teaser-card');
  card.style.display = 'block';

  const score = audit.score ?? 0;
  const circle = document.getElementById('boost-score-circle');
  circle.textContent = score;
  circle.style.background = score >= 70 ? '#16a34a' : score >= 45 ? '#d97706' : '#ef4444';

  document.getElementById('boost-score-label').textContent = `SEO skóre: ${score}/100`;

  const total = audit.findings?.summary?.total_issues ?? 0;
  document.getElementById('boost-issues-label').textContent = `Nájdených problémov: ${total}`;

  const teaser = (audit.findings?.pages || []).flatMap(p => p.findings).slice(0, 3);
  document.getElementById('boost-teaser-findings').innerHTML = teaser.map(f =>
    `<div style="display:flex;gap:0.5rem;align-items:flex-start;padding:0.4rem 0.6rem;background:rgba(255,255,255,0.05);border-radius:6px;font-size:0.83rem">
      <span>${SEVERITY_ICON[f.severity] || '•'}</span>
      <span>${escHtml(f.issue)}</span>
    </div>`
  ).join('');

  const remaining = total - teaser.length;
  document.getElementById('boost-more-label').textContent = remaining > 0
    ? `+ ďalších ${remaining} problémov v plnom audite (po aktivácii Growth Boost)`
    : '';
}

function showBoostPaid() {
  document.getElementById('boost-offer-card').style.display = 'none';
  document.getElementById('boost-paid-msg').style.display = 'block';
}

async function startBoostCheckout() {
  const btn = document.getElementById('btn-boost-buy');
  btn.disabled = true;
  btn.textContent = 'Presmerovávam...';
  try {
    const r = await fetch(`${API}/api/stripe/checkout-boost`, {
      method: 'POST',
      headers: authHeaders()
    });
    const d = await r.json();
    if (d.url) {
      window.location.href = d.url;
    } else {
      showToast(d.error || 'Chyba pri platbe.', 'error');
      btn.disabled = false;
      btn.textContent = '💳 Získať Growth Boost – €49';
    }
  } catch {
    showToast('Sieťová chyba. Skúste znovu.', 'error');
    btn.disabled = false;
    btn.textContent = '💳 Získať Growth Boost – €49';
  }
}

async function handleBoostReturn() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('success_boost') !== '1') return false;

  window.history.replaceState({}, '', '/onboarding?step=5');
  showToast('Growth Boost bol úspešne aktivovaný! 🎉', 'success');
  showBoostPaid();
  return true;
}

// ════════════════════════════════════════════════════════════════
// Color picker sync
// ════════════════════════════════════════════════════════════════
function setupColorPicker() {
  const picker = document.getElementById('ob-color');
  const hex = document.getElementById('ob-color-hex');
  picker.addEventListener('input', () => { hex.textContent = picker.value; });
}

// ════════════════════════════════════════════════════════════════
// Enter key on question input
// ════════════════════════════════════════════════════════════════
function setupQuestionInput() {
  document.getElementById('ob-new-question').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addQuestion(); }
  });
}

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ════════════════════════════════════════════════════════════════
// Init
// ════════════════════════════════════════════════════════════════
async function init() {
  setupCTAToggle();
  setupColorPicker();
  setupQuestionInput();
  updateSidebar(1);

  // Show discount notice if user registered with a referral
  try {
    const nd_user = localStorage.getItem('nd_user');
    if (nd_user) {
      const u = JSON.parse(nd_user);
      if (u.hasReferral) {
        const notice = document.getElementById('referral-discount-notice');
        if (notice) notice.style.display = 'block';
      }
    }
  } catch { /* ignore */ }

  // Handle Stripe returns
  await handleStripeReturn();
  const boostReturned = await handleBoostReturn();

  // Check subscription status
  const active = await checkSubscription();
  if (active) {
    showSubscriptionActive();
    await ensureWidget();
    await loadKnowledge();

    const params = new URLSearchParams(window.location.search);
    const startStep = parseInt(params.get('step') || '1', 10);
    if (boostReturned) {
      goToStep(5);
    } else if (startStep >= 2 && startStep <= 5) {
      goToStep(startStep);
    } else {
      goToStep(1);
    }
  } else {
    goToStep(1);
  }
}

document.addEventListener('DOMContentLoaded', init);
