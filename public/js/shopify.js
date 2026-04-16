'use strict';
/**
 * Neoworkly × Shopify – Setup page JS
 * Drives the 4-step onboarding: Login → Widget → Scan → Done
 */

const shop = new URLSearchParams(location.search).get('shop') || '';

let ndToken   = '';   // Neoworkly JWT
let widgetId  = '';
let totalImported = { products: 0, pages: 0, blogs: 0 };

/* ── Helpers ──────────────────────────────────────────────────── */
const $  = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');

function setStep(n) {
  for (let i = 1; i <= 4; i++) {
    const dot  = $(`step-dot-${i}`);
    const line = $(`step-line-${i}`);
    dot.className  = 'step-dot' + (i < n ? ' done' : i === n ? ' active' : '');
    if (line) line.className = 'step-line' + (i < n ? ' done' : '');
  }
  ['login','widget','scan','done'].forEach((s, idx) => {
    const el = $(`screen-${s}`);
    if (idx + 1 === n) el.classList.remove('hidden');
    else el.classList.add('hidden');
  });
}

function setBtnLoading(textId, spinId, loading) {
  $(textId).classList.toggle('hidden', loading);
  $(spinId).classList.toggle('hidden', !loading);
  $(textId).closest('button').disabled = loading;
}

function showError(bannerId, msg) {
  const el = $(bannerId);
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideError(bannerId) {
  $(bannerId).classList.add('hidden');
}

async function apiFetch(path, opts = {}) {
  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (ndToken) opts.headers['Authorization'] = `Bearer ${ndToken}`;
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

/* ── Init ─────────────────────────────────────────────────────── */
(async function init() {
  if (!shop) {
    document.body.innerHTML = '<p style="padding:2rem;color:#dc2626">Chýba ?shop= parameter v URL.</p>';
    return;
  }

  // Show shop name in topbar
  show('topbar-shop');
  $('topbar-shop-name').textContent = shop;

  // Check if shop is already fully set up
  const status = await apiFetch(`/api/shopify/status?shop=${encodeURIComponent(shop)}`);
  if (status.ok && status.data.linked && status.data.scan_done) {
    // Already done — show done screen directly
    widgetId = status.data.widget_id;
    showDoneScreen(status.data);
    return;
  }

  setStep(1);
})();

/* ══════════════════════════════════════════════════════════════
   SCREEN 1 – Login
══════════════════════════════════════════════════════════════ */
$('btn-login').addEventListener('click', async () => {
  hideError('login-error');
  const email    = $('inp-email').value.trim();
  const password = $('inp-password').value;
  if (!email || !password) { showError('login-error', 'Vyplňte email a heslo.'); return; }

  setBtnLoading('btn-login-text', 'btn-login-spin', true);

  const r = await apiFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

  if (!r.ok) {
    showError('login-error', r.data?.error || 'Prihlásenie zlyhalo.');
    setBtnLoading('btn-login-text', 'btn-login-spin', false);
    return;
  }

  ndToken = r.data.token;
  await loadWidgetStep(r.data.user);
});

$('inp-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-login').click();
});

/* ══════════════════════════════════════════════════════════════
   SCREEN 2 – Widget selection
══════════════════════════════════════════════════════════════ */
async function loadWidgetStep(user) {
  // Check current shop status
  const status = await apiFetch(`/api/shopify/status?shop=${encodeURIComponent(shop)}`);
  const shopName = status.data?.shop_name || shop;

  // Fill shop badges
  $('shop-name-display').textContent = shopName;
  $('shop-url-display').textContent  = shop;
  $('shop-name-scan').textContent    = shopName;
  $('shop-url-scan').textContent     = shop;

  // Load user's existing widgets
  const wr = await apiFetch('/api/shopify/widgets', {});
  const widgets = wr.ok ? (wr.data || []) : [];

  const list = $('widget-list');
  // Keep the "create new" option, append existing widgets
  widgets.forEach(w => {
    const label = document.createElement('label');
    label.className = 'widget-option';
    label.innerHTML = `
      <input type="radio" name="widget" value="${w.id}">
      <div><div class="w-name">${escHtml(w.name)}</div></div>
    `;
    list.appendChild(label);
  });

  // Handle radio click highlight
  list.addEventListener('click', (e) => {
    list.querySelectorAll('.widget-option').forEach(o => o.classList.remove('selected'));
    const opt = e.target.closest('.widget-option');
    if (opt) opt.classList.add('selected');
  });

  setStep(2);
}

$('btn-set-widget').addEventListener('click', async () => {
  hideError('widget-error');
  const selected = document.querySelector('input[name="widget"]:checked');
  if (!selected) { showError('widget-error', 'Vyberte widget.'); return; }

  setBtnLoading('btn-widget-text', 'btn-widget-spin', true);

  const isNew = selected.value === '__new__';
  const r = await apiFetch('/api/shopify/link-account', {
    method: 'POST',
    body: JSON.stringify({
      shop,
      widget_id:     isNew ? undefined : selected.value,
      create_widget: isNew,
    }),
  });

  if (!r.ok) {
    showError('widget-error', r.data?.error || 'Chyba.');
    setBtnLoading('btn-widget-text', 'btn-widget-spin', false);
    return;
  }

  widgetId = r.data.widget_id;
  setStep(3);
  show('pre-scan');
  hide('scanning');
});

/* ══════════════════════════════════════════════════════════════
   SCREEN 3 – Scanning
══════════════════════════════════════════════════════════════ */
$('btn-start-scan').addEventListener('click', () => {
  hide('pre-scan');
  show('scanning');
  runScan();
});

async function runScan() {
  const types = [
    { key: 'products', label: 'Produkty',        stepId: 'scan-step-products', subId: 'sub-products', statusId: 'status-products' },
    { key: 'pages',    label: 'Stránky',          stepId: 'scan-step-pages',    subId: 'sub-pages',    statusId: 'status-pages'    },
    { key: 'blogs',    label: 'Blogové články',   stepId: 'scan-step-blogs',    subId: 'sub-blogs',    statusId: 'status-blogs'    },
  ];

  let done = 0;

  for (const t of types) {
    setStepState(t.stepId, 'running');
    $(t.subId).textContent = 'Skenuje sa...';

    let offset     = null;
    let hasMore    = true;
    let imported   = 0;

    while (hasMore) {
      const r = await apiFetch('/api/shopify/scan', {
        method: 'POST',
        body: JSON.stringify({ shop, type: t.key, offset }),
      });

      if (!r.ok) {
        setStepState(t.stepId, 'error');
        $(t.subId).textContent = r.data?.error || 'Chyba';
        hasMore = false;
        break;
      }

      imported   += r.data.imported || 0;
      hasMore     = r.data.has_more  || false;
      offset      = r.data.next_offset || null;

      $(t.subId).textContent = `Importovaných: ${imported}...`;
    }

    totalImported[t.key] = imported;
    setStepState(t.stepId, 'done');
    $(t.subId).textContent = `Hotovo – ${imported} položiek`;
    $(t.statusId).textContent = '✅';

    done++;
    $('progress-fill').style.width = Math.round((done / types.length) * 80) + '%';
    $('progress-label').textContent = `${done} / ${types.length} krokov`;
  }

  // Inject widget script tag
  $('progress-label').textContent = 'Vkladám widget na obchod...';
  const injectR = await apiFetch('/api/shopify/inject', {
    method: 'POST',
    body: JSON.stringify({ shop }),
  });

  $('progress-fill').style.width = '100%';

  if (!injectR.ok) {
    $('progress-label').textContent = '⚠️ Skenovanie hotové, ale widget sa nepodarilo vložiť automaticky.';
  }

  setTimeout(() => showDoneScreen(), 600);
}

function setStepState(stepId, state) {
  const el = $(stepId);
  el.classList.remove('running', 'done', 'error');
  if (state) el.classList.add(state);
}

/* ══════════════════════════════════════════════════════════════
   SCREEN 4 – Done
══════════════════════════════════════════════════════════════ */
function showDoneScreen(existingStatus = null) {
  const total = Object.values(totalImported).reduce((a, b) => a + b, 0);

  if (total > 0 || existingStatus) {
    const p = totalImported.products;
    const pg = totalImported.pages;
    const bl = totalImported.blogs;
    const parts = [];
    if (p)  parts.push(`${p} produktov`);
    if (pg) parts.push(`${pg} stránok`);
    if (bl) parts.push(`${bl} článkov`);
    $('scan-summary').textContent = parts.length
      ? `Naskenovaných a importovaných: ${parts.join(', ')}.`
      : 'Znalostná báza je aktualizovaná.';
  } else {
    $('scan-summary').classList.add('hidden');
  }

  $('link-shop').href = `https://${shop}`;

  setStep(4);

  // Embed toggle handler
  $('embed-toggle').addEventListener('change', async function () {
    await apiFetch('/api/shopify/toggle-embed', {
      method: 'POST',
      body: JSON.stringify({ shop, enabled: this.checked }),
    });
  });
}

// Re-scan button
$('btn-rescan').addEventListener('click', () => {
  totalImported = { products: 0, pages: 0, blogs: 0 };
  setStep(3);
  show('pre-scan');
  hide('scanning');
});

/* ── Escape HTML ────────────────────────────────────────────── */
function escHtml(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
