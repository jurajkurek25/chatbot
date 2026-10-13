// Sekcia Funnely / Platby v dashboarde Neoworkly (stránka vložená v iframe na rovnakej doméne).
// ?view=payments => prepojenie Stripe; ?view=funnels => funnely, produkty, kroky, štatistiky.
(function () {
  var state;
  var params = new URLSearchParams(location.search);
  var VIEW = params.get('view') === 'payments' ? 'payments' : 'funnels';
  // Sekcie druhého zobrazenia iba skryté (prvky ostávajú, kód stránky ich môže používať)
  document.querySelectorAll('[data-view]').forEach(function (sec) { if (sec.dataset.view !== VIEW) sec.classList.add('other-view'); });

  // Výška obsahu => rodičovský dashboard nastaví výšku iframe (bez vnútorného posúvania)
  function reportHeight() {
    if (window.parent !== window) window.parent.postMessage({ type: 'nw-funnel-height', view: VIEW, height: document.documentElement.scrollHeight }, location.origin);
  }
  new ResizeObserver(reportHeight).observe(document.body);
  // Stripe (onboarding, portál) sa nedá otvoriť v iframe => celé okno
  function goTop(url) { (window.top || window).location.href = url; }
  var KINDS = { entry: 'Vstupný produkt', offer: 'Chcem / Nechcem pridať', lead: 'Zadarmo za kontakt' };
  var TYPES = { one_time: 'Jednorazový', recurring: 'Opakovaný' };

  function el(tag, props) {
    var node = document.createElement(tag);
    Object.assign(node, props || {});
    for (var i = 2; i < arguments.length; i++) node.append(arguments[i]);
    return node;
  }

  var toastTimer;
  function toast(text, isError) {
    var t = document.getElementById('toast');
    t.textContent = text;
    t.className = isError ? 'error' : '';
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4000);
  }

  // Odpoveď ako JSON; ak server namiesto nej vráti HTML (napr. 502 od proxy, keď aplikácia nebeží),
  // zrozumiteľná chyba namiesto „Unexpected token '<'“
  async function readJson(r) {
    try {
      return await r.json();
    } catch (e) {
      throw new Error('Server momentálne neodpovedá správne (HTTP ' + r.status + '). Skús to o chvíľu znova.');
    }
  }

  async function api(method, path, body) {
    var r = await fetch('/api/funnels/api' + path, {
      method: method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('nd_token') },
      body: method === 'GET' ? undefined : JSON.stringify(body || {})
    });
    var data = await readJson(r);
    if (r.status === 401) goTop('/'); // odhlásený => úvodná stránka s prihlásením
    if (!r.ok) throw new Error(data.error || 'Chyba');
    return data;
  }

  // Spustí volanie API, pri úspechu prekreslí stránku, chybu zobrazí v toaste
  async function run(promise, okText) {
    try {
      render(await promise);
      if (okText) toast(okText);
      return true;
    } catch (err) {
      toast(err.message, true);
      return false;
    }
  }

  function toCents(value) {
    return Math.round(parseFloat(String(value).replace(',', '.')) * 100);
  }

  function actions() {
    var td = el('td', { className: 'actions' });
    for (var i = 0; i < arguments.length; i++) td.append(arguments[i]);
    return td;
  }
  function linkBtn(text, onclick, danger) {
    return el('button', { type: 'button', className: 'link' + (danger ? ' danger' : ''), textContent: text, onclick: onclick });
  }

  // --- Vykreslenie ----------------------------------------------------------
  var SUB_TEXT = {
    active: 'Aktívne', past_due: 'Platba po splatnosti – Stripe ju skúša znova',
    canceled: 'Zrušené', unpaid: 'Nezaplatené', incomplete: 'Čaká na platbu', incomplete_expired: 'Platba vypršala',
    none: 'Neaktívne'
  };

  function renderAccount(s) {
    document.getElementById('blocked-card').hidden = !s.blocked;
    document.getElementById('access-card').hidden = s.active || s.blocked;
    var legacy = s.legacySubscription;
    document.getElementById('legacy-card').hidden = !legacy || legacy.status === 'none';
    if (legacy) {
      var ls = document.getElementById('legacy-status');
      ls.textContent = SUB_TEXT[legacy.status] || legacy.status;
      ls.className = 'status' + (legacy.active ? ' ok' : '');
    }
    var fee = document.getElementById('fee-text');
    if (fee) {
      fee.textContent = s.platformFeePercent
        ? 'Neoworkly si z každej platby berie ' + s.platformFeePercent + ' %.'
        : 'Neoworkly si z platieb nič neberie.';
    }
    document.querySelectorAll('[data-requires-active]').forEach(function (sec) { sec.hidden = !s.active || s.blocked; });
    if (VIEW !== 'payments') return;

    var acctStatus = document.getElementById('acct-status');
    var acctText = document.getElementById('acct-text');
    var connect = document.getElementById('connect');
    if (!s.stripeAccountId) {
      acctStatus.textContent = 'Neprepojené';
      acctStatus.className = 'status';
      acctText.textContent = 'Prepoj svoj Stripe účet (alebo si ho vytvor) – zaberie to pár minút.';
      connect.textContent = 'Prepojiť Stripe';
    } else if (!s.chargesEnabled) {
      acctStatus.textContent = 'Nedokončené';
      acctStatus.className = 'status wait';
      acctText.textContent = 'Stripe ešte potrebuje údaje, kým budeš môcť prijímať platby.';
      connect.textContent = 'Dokončiť nastavenie v Stripe';
    } else {
      acctStatus.textContent = 'Prepojené';
      acctStatus.className = 'status ok';
      acctText.textContent = s.stripeAccountId + ' – prijímaš platby.';
    }
    connect.hidden = s.stripeAccountId && s.chargesEnabled;
    // Vlastné API kľúče: menej bezpečná alternatíva (nie pri poplatku z predaja – ten ide iba cez Connect)
    var byKeys = !!s.stripeKeyHint;
    if (byKeys) {
      acctText.textContent = s.stripeAccountId + ' (kľúč ' + s.stripeKeyHint + ')' + (s.chargesEnabled ? ' – prijímaš platby.' : ' – Stripe účet zatiaľ neprijíma platby.');
      connect.hidden = true;
    }
    document.getElementById('keys-connected').hidden = !byKeys;
    document.getElementById('keys-box').hidden = byKeys || !!s.platformFeePercent || (s.stripeAccountId && s.chargesEnabled);
  }

  var currencyFilled = false;
  function render(s) {
    state = s;
    if (VIEW === 'funnels' && !currencyFilled && s.currencies) {
      currencyFilled = true;
      s.currencies.forEach(function (c) { productForm.currency.append(el('option', { value: c, textContent: c.toUpperCase() })); });
    }
    renderAccount(s);
    if (VIEW !== 'funnels') return;
    if (s.appearance) renderAppearance(s.appearance);
    if (s.notifications) renderNotifications(s.notifications);
    renderTestMode(s);
    var products = document.getElementById('products');
    products.replaceChildren();
    Object.keys(s.products).forEach(function (id) {
      var p = s.products[id];
      products.append(el('tr', {},
        el('td', {}, el('code', { textContent: id })),
        el('td', { textContent: p.name }),
        el('td', { textContent: TYPES[p.type] }),
        el('td', { textContent: p.label }),
        actions(
          linkBtn('Upraviť', function () { editProduct(id); }),
          linkBtn('Zmazať', function () {
            if (confirm('Zmazať produkt ' + id + '?')) run(api('DELETE', '/products/' + id), 'Produkt zmazaný.');
          }, true)
        )
      ));
    });
    if (!products.children.length) products.append(el('tr', {}, el('td', { colSpan: 5, className: 'empty', textContent: 'Zatiaľ žiadne produkty.' })));

    var select = stepForm.productId;
    var selected = select.value;
    select.replaceChildren();
    Object.keys(s.products).forEach(function (id) {
      select.append(el('option', { value: id, textContent: s.products[id].name + ' (' + s.products[id].label + ')' }));
    });
    if (s.products[selected]) select.value = selected;
    var direct = stepForm.directProductId;
    var directSelected = direct.value;
    direct.replaceChildren(el('option', { value: '', textContent: '— nič, iba ponuka vo funneli —' }));
    Object.keys(s.products).forEach(function (id) {
      direct.append(el('option', { value: id, textContent: s.products[id].name + ' (' + s.products[id].label + ')' }));
    });
    if (s.products[directSelected]) direct.value = directSelected;

    renderFunnels(s);
    var steps = document.getElementById('steps');
    steps.replaceChildren();
    Object.keys(s.steps).forEach(function (id) {
      var st = s.steps[id];
      var product = st.kind === 'lead' ? { name: leadLabel(st) } : s.products[st.productId];
      var idCell = el('td', {}, el('code', { textContent: id }));
      if (st.ab) idCell.append(' ', el('span', { className: 'status wait', textContent: 'A/B' }));
      steps.append(el('tr', {},
        idCell,
        el('td', { textContent: st.funnelId && s.funnels[st.funnelId] ? s.funnels[st.funnelId].name : '—' }),
        el('td', { textContent: KINDS[st.kind] }),
        el('td', { textContent: product ? product.name : '—' }),
        el('td', { textContent: st.onAccept }),
        el('td', { textContent: st.onDecline || '—' }),
        actions(
          linkBtn('Snippet', function () { showSnippet(id); }),
          linkBtn('Demo', function () { window.open('/demo/' + s.merchantId + '/' + id); }),
          linkBtn('Upraviť', function () { editStep(id); }),
          linkBtn('A/B test', function () { editAb(id); }),
          linkBtn('Zmazať', function () {
            if (confirm('Zmazať krok ' + id + '?')) run(api('DELETE', '/steps/' + id), 'Krok zmazaný.');
          }, true)
        )
      ));
    });
    if (!steps.children.length) steps.append(el('tr', {}, el('td', { colSpan: 7, className: 'empty', textContent: 'Zatiaľ žiadne kroky.' })));

  }

  // Zobrazí polia s data-for iba pre zvolený typ (data-for môže obsahovať viac typov oddelených medzerou)
  function toggleFields(form, value) {
    form.querySelectorAll('[data-for]').forEach(function (label) {
      label.hidden = label.dataset.for.split(' ').indexOf(value) === -1;
    });
  }

  // --- Produkty -------------------------------------------------------------
  var productForm = document.getElementById('product-form');
  var editingProduct = null;

  productForm.type.onchange = function () { toggleFields(productForm, productForm.type.value); };

  function editProduct(id) {
    var p = state.products[id];
    editingProduct = id;
    productForm.slug.value = id;
    productForm.productName.value = p.name;
    productForm.type.value = p.type;
    productForm.interval.value = p.interval || 'month';
    productForm.amount.value = (p.amount / 100).toFixed(2).replace('.', ',');
    // ID, typ a interval sa po vytvorení nemenia (v Stripe sú súčasťou ceny)
    productForm.currency.value = p.currency || 'eur';
    // ID, typ, interval a mena sa po vytvorení nemenia (v Stripe sú súčasťou ceny)
    productForm.slug.disabled = productForm.type.disabled = productForm.interval.disabled = productForm.currency.disabled = true;
    productForm.querySelector('[type=submit]').textContent = 'Uložiť zmeny';
    productForm.querySelector('[data-cancel]').hidden = false;
    toggleFields(productForm, p.type);
    productForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function resetProductForm() {
    editingProduct = null;
    productForm.reset();
    productForm.slug.disabled = productForm.type.disabled = productForm.interval.disabled = productForm.currency.disabled = false;
    productForm.querySelector('[type=submit]').textContent = 'Pridať produkt';
    productForm.querySelector('[data-cancel]').hidden = true;
    toggleFields(productForm, 'one_time');
  }
  productForm.querySelector('[data-cancel]').onclick = resetProductForm;

  productForm.onsubmit = async function (e) {
    e.preventDefault();
    var body = { name: productForm.productName.value, amount: toCents(productForm.amount.value) };
    var request = editingProduct
      ? api('PUT', '/products/' + editingProduct, body)
      : api('POST', '/products', Object.assign(body, {
          id: productForm.slug.value, type: productForm.type.value, interval: productForm.interval.value,
          currency: productForm.currency.value
        }));
    if (await run(request, 'Produkt uložený.')) resetProductForm();
  };

  // --- Import produktov zo Stripe -----------------------------------------------
  async function loadImport() {
    var btn = document.getElementById('import-load');
    btn.disabled = true;
    try {
      var data = await api('GET', '/stripe/prices');
      var list = document.getElementById('import-list');
      list.replaceChildren();
      data.prices.forEach(function (p) {
        list.append(el('tr', {},
          el('td', { textContent: p.name }),
          el('td', { textContent: TYPES[p.type] }),
          el('td', { textContent: p.label }),
          p.imported
            ? el('td', { className: 'actions', textContent: 'Importovaný' })
            : actions(linkBtn('Importovať', async function () {
                if (await run(api('POST', '/products/import', { priceId: p.priceId }), 'Produkt importovaný.')) loadImport();
              }))
        ));
      });
      if (!list.children.length) list.append(el('tr', {}, el('td', { colSpan: 4, className: 'empty', textContent: 'V Stripe nie sú žiadne použiteľné aktívne ceny.' })));
      document.getElementById('import-skipped').textContent = data.skipped
        ? 'Vynechané (' + data.skipped + '): ceny bez pevnej sumy, v nepodporovanej mene, s iným intervalom než mesačne/ročne alebo archivované.'
        : '';
      document.getElementById('import-box').hidden = false;
    } catch (err) {
      toast(err.message, true);
    }
    btn.disabled = false;
  }
  document.getElementById('import-load').onclick = loadImport;

  // --- Kroky ----------------------------------------------------------------
  var stepForm = document.getElementById('step-form');
  stepForm.kind.onchange = function () { toggleFields(stepForm, stepForm.kind.value); };

  // Krok „Zadarmo za kontakt“: digitálne produkty, lead magnety a widgety z hlavného účtu Neoworkly
  var leadOptions = { products: [], leadMagnets: [], widgets: [] };
  function fillSelect(select, items, label) {
    var selected = select.value;
    select.replaceChildren(select.options[0]);
    items.forEach(function (i) { select.append(el('option', { value: i.id, textContent: label(i) })); });
    select.value = selected;
  }
  async function loadLeadOptions() {
    try {
      leadOptions = await api('GET', '/lead-options');
    } catch (err) {
      return;
    }
    fillSelect(stepForm.leadProductId, leadOptions.products, function (p) { return p.title; });
    fillSelect(stepForm.leadMagnetId, leadOptions.leadMagnets, function (l) { return l.name + ' (' + l.widgetName + ')'; });
    fillSelect(stepForm.leadWidgetId, leadOptions.widgets, function (w) { return w.name; });
    if (state && state.steps) render(state);
  }
  function leadLabel(st) {
    var d = st.deliver || {};
    var names = [
      d.productId && (leadOptions.products.find(function (p) { return p.id === d.productId; }) || {}).title,
      d.leadMagnetId && (leadOptions.leadMagnets.find(function (l) { return l.id === d.leadMagnetId; }) || {}).name
    ].filter(Boolean);
    return names.length ? 'Zadarmo: ' + names.join(' + ') : 'Iba kontakt';
  }
  loadLeadOptions();

  // Voľné polia kroku: riadok = názov, typ, max. dĺžka, povinné
  var fieldRows = document.getElementById('field-rows');
  var fieldAdd = document.getElementById('field-add');
  function addFieldRow(f) {
    f = f || { label: '', type: 'text', required: false, maxLength: 100 };
    var label = el('input', { placeholder: 'Názov, napr. Venovanie', maxLength: 40, required: true, value: f.label });
    var type = el('select', {},
      el('option', { value: 'text', textContent: 'Krátky text' }),
      el('option', { value: 'textarea', textContent: 'Dlhší text' }));
    type.value = f.type;
    var max = el('input', { type: 'number', min: 1, max: 500, required: true, value: f.maxLength, title: 'Max. počet znakov' });
    var required = el('input', { type: 'checkbox', checked: f.required });
    var row = el('div', { className: 'field-row' }, label, type, max,
      el('label', { className: 'check' }, required, 'Povinné'),
      linkBtn('Odobrať', function () { row.remove(); fieldAdd.hidden = false; }, true));
    row.read = function () {
      return { label: label.value, type: type.value, maxLength: parseInt(max.value, 10), required: required.checked };
    };
    fieldRows.append(row);
    fieldAdd.hidden = fieldRows.children.length >= 5;
  }
  function setFieldRows(fields) {
    fieldRows.replaceChildren();
    fieldAdd.hidden = false;
    (fields || []).forEach(addFieldRow);
  }
  fieldAdd.onclick = function () { addFieldRow(); };

  function editStep(id) {
    var st = state.steps[id];
    stepForm.slug.value = id;
    stepForm.slug.disabled = true;
    stepForm.kind.value = st.kind;
    stepForm.productId.value = st.productId || '';
    stepForm.leadProductId.value = (st.deliver && st.deliver.productId) || '';
    stepForm.leadMagnetId.value = (st.deliver && st.deliver.leadMagnetId) || '';
    stepForm.leadWidgetId.value = (st.deliver && st.deliver.widgetId) || '';
    stepForm.askName.checked = !!st.askName;
    stepForm.marketing.checked = !!st.marketing;
    stepForm.marketingText.value = st.marketingText || '';
    stepForm.maxQuantity.value = st.maxQuantity || 1;
    stepForm.onAccept.value = st.onAccept;
    stepForm.onDecline.value = st.onDecline || '';
    stepForm.funnelId.value = st.funnelId || '';
    stepForm.stepTitle.value = st.title || ''; // pole "title" by kolidovalo s element.title
    stepForm.buttonText.value = st.buttonText || '';
    stepForm.yesText.value = st.yesText || '';
    stepForm.noText.value = st.noText || '';
    stepForm.shipping.checked = !!st.shipping;
    stepForm.directProductId.value = (st.direct && st.direct.productId) || '';
    stepForm.directShipping.checked = !!(st.direct && st.direct.shipping);
    setFieldRows(st.fields);
    stepForm.querySelector('[data-cancel]').hidden = false;
    toggleFields(stepForm, st.kind);
    stepForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function resetStepForm() {
    stepForm.reset();
    stepForm.slug.disabled = false;
    setFieldRows([]);
    stepForm.querySelector('[data-cancel]').hidden = true;
    toggleFields(stepForm, 'entry');
  }
  stepForm.querySelector('[data-cancel]').onclick = resetStepForm;

  stepForm.onsubmit = async function (e) {
    e.preventDefault();
    var id = stepForm.slug.value;
    var ok = await run(api('PUT', '/steps/' + encodeURIComponent(id), {
      kind: stepForm.kind.value,
      productId: stepForm.productId.value,
      maxQuantity: parseInt(stepForm.maxQuantity.value, 10),
      funnelId: stepForm.funnelId.value,
      onAccept: stepForm.onAccept.value,
      onDecline: stepForm.onDecline.value,
      title: stepForm.stepTitle.value,
      buttonText: stepForm.buttonText.value,
      yesText: stepForm.yesText.value,
      noText: stepForm.noText.value,
      shipping: stepForm.shipping.checked,
      directProductId: stepForm.directProductId.value,
      directShipping: stepForm.directShipping.checked,
      deliver: {
        productId: stepForm.leadProductId.value,
        leadMagnetId: stepForm.leadMagnetId.value,
        widgetId: stepForm.leadWidgetId.value
      },
      askName: stepForm.askName.checked,
      marketing: stepForm.marketing.checked,
      marketingText: stepForm.marketingText.value,
      fields: Array.prototype.map.call(fieldRows.children, function (row) { return row.read(); })
    }), 'Krok uložený.');
    if (ok) {
      resetStepForm();
      showSnippet(id);
    }
  };

  // --- Štatistiky --------------------------------------------------------------
  var statsDays = 30;
  // Tržby po menách: { eur: 1900, czk: 25000 } => "19,00 € + 250,00 CZK" (meny sa nesčítavajú)
  function money(byCurrency) {
    var parts = Object.keys(byCurrency).sort(function (a, b) { return (b === 'eur') - (a === 'eur') || a.localeCompare(b); }).map(function (c) {
      return new Intl.NumberFormat('sk-SK', { style: 'currency', currency: c.toUpperCase() }).format(byCurrency[c] / 100);
    });
    return parts.length ? parts.join(' + ') : euro.format(0);
  }
  var euro = new Intl.NumberFormat('sk-SK', { style: 'currency', currency: 'EUR' });
  var percent = function (v) { return v === null ? '—' : (v * 100).toLocaleString('sk-SK', { maximumFractionDigits: 1 }) + ' %'; };
  var number = function (v) { return v.toLocaleString('sk-SK'); };

  async function loadStats() {
    var data;
    try {
      data = await api('GET', '/stats?days=' + statsDays + '&funnel=' + encodeURIComponent(statsFunnel.value));
    } catch (err) {
      return; // bez aktívneho predplatného sa sekcia nezobrazuje
    }
    var entryViews = data.steps.filter(function (r) { return r.kind === 'entry'; })
      .reduce(function (t, r) { return t + r.views; }, 0);
    var tiles = [
      ['Návštevy vstupného kroku', number(entryViews)],
      ['Nákupy', number(data.totals.purchases)],
      ['Kontakty', number(data.totals.leads)],
      ['Konverzia funnela', percent(data.totals.conversion)],
      ['Tržby', money(data.totals.revenue)]
    ];
    document.getElementById('stats-tiles').replaceChildren.apply(document.getElementById('stats-tiles'), tiles.map(function (t) {
      return el('div', { className: 'tile' }, el('div', { className: 'label', textContent: t[0] }), el('div', { className: 'value', textContent: t[1] }));
    }));
    var rows = document.getElementById('stats-rows');
    rows.replaceChildren();
    data.steps.forEach(function (r) {
      var name = el('td', {}, el('code', { textContent: r.stepId }));
      if (r.deleted) name.append(' ', el('span', { className: 'hint', textContent: '(zmazaný)' }));
      if (r.kind === 'direct') name.append(' ', el('span', { className: 'hint', textContent: '(priamy predaj mimo funnela)' }));
      rows.append(el('tr', {},
        name,
        el('td', { textContent: r.product || '—' }),
        el('td', { className: 'num', textContent: number(r.views) }),
        el('td', { className: 'num', textContent: number(r.kind === 'lead' ? r.leads : r.purchases) }),
        el('td', { className: 'num', textContent: r.kind === 'entry' || r.kind === 'direct' || r.kind === 'lead' ? '—' : number(r.declines) }),
        el('td', { className: 'num', textContent: percent(r.conversion) }),
        el('td', { className: 'num', textContent: money(r.revenue) })
      ));
    });
    if (!data.steps.length) rows.append(el('tr', {}, el('td', { colSpan: 7, className: 'empty', textContent: 'Zatiaľ žiadne kroky.' })));
    renderAbResults(data.steps);
  }
  document.querySelectorAll('[data-days]').forEach(function (btn) {
    btn.onclick = function () {
      statsDays = Number(btn.dataset.days);
      document.querySelectorAll('[data-days]').forEach(function (b) { b.setAttribute('aria-pressed', b === btn); });
      loadStats();
    };
  });

  // --- Testovací režim --------------------------------------------------------
  function renderTestMode(s) {
    var t = s.testMode || {};
    document.getElementById('test-card').hidden = !t.available || !s.active || s.blocked;
    if (!t.available) return;
    var status = document.getElementById('test-status');
    var text = document.getElementById('test-text');
    var btn = document.getElementById('test-connect');
    if (!t.accountId) {
      status.textContent = 'Nenastavené'; status.className = 'status none';
      text.textContent = 'Vytvor si testovací Stripe účet – pri nastavení použi testovacie údaje, ktoré Stripe ponúkne.';
      btn.textContent = 'Vytvoriť testovací Stripe účet';
    } else if (!t.ready) {
      status.textContent = 'Nedokončené'; status.className = 'status wait';
      text.textContent = 'Dokonči nastavenie testovacieho účtu v Stripe (stačia testovacie údaje).';
      btn.textContent = 'Dokončiť nastavenie';
    } else {
      status.textContent = 'Pripravené'; status.className = 'status ok';
      text.textContent = 'Testovací účet ' + t.accountId + '.';
    }
    btn.hidden = t.ready;
    document.getElementById('test-ready').hidden = !t.ready;
    document.getElementById('test-param').value = '?neoworkly_test=' + (t.key || '');
    var entry = Object.keys(s.steps).find(function (id) { return s.steps[id].kind === 'entry'; });
    document.getElementById('test-demo').hidden = !entry;
    document.getElementById('test-demo').onclick = function () {
      window.open('/demo/' + s.merchantId + '/' + entry + '?neoworkly_test=' + encodeURIComponent(t.key));
    };
  }
  document.getElementById('test-connect').onclick = function () { this.disabled = true; redirectTo('/test/connect'); };
  document.getElementById('test-copy').onclick = async function () {
    await navigator.clipboard.writeText(document.getElementById('test-param').value);
    toast('Skopírované do schránky.');
  };

  // --- Oznámenia --------------------------------------------------------------
  var notifyForm = document.getElementById('notify-form');
  function renderNotifications(n) {
    notifyForm.email.checked = n.email;
    if (document.activeElement !== notifyForm.webhookUrl) notifyForm.webhookUrl.value = n.webhookUrl;
    notifyForm.webhookSecret.value = n.webhookSecret;
    notifyForm.querySelectorAll('[data-webhook]').forEach(function (e) { e.hidden = !n.webhookUrl; });
  }
  notifyForm.onsubmit = function (e) {
    e.preventDefault();
    run(api('PUT', '/notifications', { email: notifyForm.email.checked, webhookUrl: notifyForm.webhookUrl.value }), 'Oznámenia uložené.');
  };
  document.getElementById('secret-rotate').onclick = function () {
    if (confirm('Vymeniť tajomstvo? Tvoj systém potom musí overovať podpis novým tajomstvom.')) {
      run(api('POST', '/notifications/secret'), 'Tajomstvo vymenené.');
    }
  };
  document.getElementById('webhook-test').onclick = async function () {
    var btn = this;
    btn.disabled = true;
    try {
      var r = await api('POST', '/notifications/test');
      toast('Webhook doručený (HTTP ' + r.status + ').');
    } catch (err) {
      toast(err.message, true);
    }
    btn.disabled = false;
  };

  // --- Funnely -----------------------------------------------------------------
  var funnelForm = document.getElementById('funnel-form');
  var statsFunnel = document.getElementById('stats-funnel');
  function renderFunnels(s) {
    var rows = document.getElementById('funnels');
    rows.replaceChildren();
    Object.keys(s.funnels).forEach(function (id) {
      var count = Object.keys(s.steps).filter(function (k) { return s.steps[k].funnelId === id; }).length;
      rows.append(el('tr', {},
        el('td', {}, el('code', { textContent: id })),
        el('td', { textContent: s.funnels[id].name }),
        el('td', { className: 'num', textContent: count }),
        actions(
          linkBtn('Premenovať', function () {
            var name = prompt('Nový názov funnela', s.funnels[id].name);
            if (name) run(api('PUT', '/funnels/' + id, { name: name }), 'Funnel premenovaný.');
          }),
          linkBtn('Zmazať', function () {
            if (confirm('Zmazať funnel ' + s.funnels[id].name + '? Kroky zostanú, iba bez funnela.')) {
              run(api('DELETE', '/funnels/' + id), 'Funnel zmazaný.');
            }
          }, true)
        )
      ));
    });
    if (!rows.children.length) rows.append(el('tr', {}, el('td', { colSpan: 4, className: 'empty', textContent: 'Zatiaľ žiadne funnely – kroky fungujú aj bez nich.' })));
    // Výber funnela pri kroku a vo filtri štatistík
    [[stepForm.funnelId, '— bez funnela —'], [statsFunnel, 'Všetky funnely']].forEach(function (pair) {
      var sel = pair[0];
      var current = sel.value;
      sel.replaceChildren(el('option', { value: '', textContent: pair[1] }));
      Object.keys(s.funnels).forEach(function (id) { sel.append(el('option', { value: id, textContent: s.funnels[id].name })); });
      if (s.funnels[current]) sel.value = current;
    });
    statsFunnel.hidden = !Object.keys(s.funnels).length;
  }
  funnelForm.onsubmit = async function (e) {
    e.preventDefault();
    if (await run(api('PUT', '/funnels/' + encodeURIComponent(funnelForm.slug.value), { name: funnelForm.funnelName.value }), 'Funnel uložený.')) {
      funnelForm.reset();
    }
  };
  statsFunnel.onchange = function () { loadStats(); };

  // --- A/B testy --------------------------------------------------------------
  var abForm = document.getElementById('ab-form');
  var abStepId = null;
  function editAb(id) {
    var st = state.steps[id];
    var base = state.products[st.productId];
    var b = (st.ab && st.ab.b) || {};
    abStepId = id;
    document.getElementById('ab-step').textContent = id;
    // Variant B môže mať iný produkt iba v rovnakej mene (inak by sa tržby nedali porovnať)
    abForm.abProduct.replaceChildren(el('option', { value: '', textContent: 'rovnaký ako A (' + base.label + ')' }));
    Object.keys(state.products).forEach(function (pid) {
      var p = state.products[pid];
      if (pid !== st.productId && (p.currency || 'eur') === (base.currency || 'eur')) {
        abForm.abProduct.append(el('option', { value: pid, textContent: p.name + ' (' + p.label + ')' }));
      }
    });
    abForm.split.value = st.ab ? st.ab.split : 50;
    abForm.abProduct.value = b.productId || '';
    abForm.abTitle.value = b.title || '';
    abForm.abButtonText.value = b.buttonText || '';
    abForm.abYesText.value = b.yesText || '';
    abForm.abNoText.value = b.noText || '';
    abForm.querySelectorAll('[data-ab-for]').forEach(function (l) { l.hidden = l.dataset.abFor !== st.kind; });
    document.getElementById('ab-stop').hidden = !st.ab;
    abForm.hidden = false;
    abForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  abForm.onsubmit = async function (e) {
    e.preventDefault();
    var ok = await run(api('PUT', '/steps/' + abStepId + '/ab', {
      split: parseInt(abForm.split.value, 10),
      productId: abForm.abProduct.value,
      title: abForm.abTitle.value,
      buttonText: abForm.abButtonText.value,
      yesText: abForm.abYesText.value,
      noText: abForm.abNoText.value
    }), 'A/B test beží – výsledky nájdeš v Štatistikách.');
    if (ok) {
      abForm.hidden = true;
      loadStats();
    }
  };
  document.getElementById('ab-stop').onclick = async function () {
    if (!confirm('Ukončiť A/B test? Krok zostane vo variante A.')) return;
    if (await run(api('DELETE', '/steps/' + abStepId + '/ab'), 'A/B test ukončený.')) {
      abForm.hidden = true;
      loadStats();
    }
  };
  document.getElementById('ab-close').onclick = function () { abForm.hidden = true; };

  var VERDICTS = {
    not_enough_data: 'Zatiaľ málo dát',
    no_difference_yet: 'Zatiaľ bez preukázateľného rozdielu',
    b_better: 'B je lepší (95 % istota)',
    a_better: 'A je lepší (95 % istota)'
  };
  function renderAbResults(steps) {
    var list = document.getElementById('ab-list');
    list.replaceChildren();
    var tests = steps.filter(function (r) { return r.ab; });
    document.getElementById('ab-results').hidden = !tests.length;
    tests.forEach(function (r) {
      var t = r.ab;
      var fmt = new Intl.NumberFormat('sk-SK', { style: 'currency', currency: t.currency.toUpperCase() });
      var decided = t.verdict === 'a_better' || t.verdict === 'b_better';
      var verdictClass = decided ? 'ok' : t.verdict === 'not_enough_data' ? 'none' : 'wait';
      var table = el('table', {},
        el('thead', {}, el('tr', {}, el('th', { textContent: 'Variant' }), el('th', { className: 'num', textContent: 'Zobrazenia' }),
          el('th', { className: 'num', textContent: 'Nákupy' }), el('th', { className: 'num', textContent: 'Konverzia' }),
          el('th', { className: 'num', textContent: 'Tržba na návštevu' }), el('th', { className: 'num', textContent: 'Tržby' }))),
        el.apply(null, ['tbody', {}].concat(['a', 'b'].map(function (v) {
          var x = t[v];
          return el('tr', {},
            el('td', { textContent: v.toUpperCase() + (v === 'b' ? ' (' + t.split + ' %)' : ' (' + (100 - t.split) + ' %)') }),
            el('td', { className: 'num', textContent: number(x.views) }),
            el('td', { className: 'num', textContent: number(x.purchases) }),
            el('td', { className: 'num', textContent: percent(x.conversion) }),
            el('td', { className: 'num', textContent: x.revenuePerView === null ? '—' : fmt.format(x.revenuePerView / 100) }),
            el('td', { className: 'num', textContent: fmt.format(x.revenue / 100) }));
        })))
      );
      var detail = t.verdict === 'not_enough_data'
        ? 'Treba aspoň ' + t.minViews + ' zobrazení na variant.'
        : 'p-hodnota ' + (t.pValue === null ? '—' : t.pValue.toFixed(3)) + '.';
      var head = el('div', { className: 'ab-head' },
        el('strong', {}, el('code', { textContent: r.stepId }), ' – od ' + new Date(t.startedAt).toLocaleDateString('sk-SK')),
        el('span', { className: 'status ' + verdictClass, textContent: VERDICTS[t.verdict] }));
      var buttons = el('div', { className: 'row' },
        el('button', { type: 'button', textContent: 'Použiť B natrvalo', onclick: function () { pickWinner(r.stepId, 'b'); } }),
        el('button', { type: 'button', textContent: 'Ponechať A', onclick: function () { pickWinner(r.stepId, 'a'); } }));
      list.append(el('div', { className: 'ab-test' }, head, el('div', { className: 'table-wrap' }, table),
        el('p', { className: 'hint', textContent: detail + ' Konverzia sa porovnáva štatisticky; tržba na návštevu je orientačná.' }), buttons));
    });
  }
  async function pickWinner(stepId, variant) {
    var text = variant === 'b' ? 'Použiť variant B natrvalo a ukončiť test?' : 'Ponechať variant A a ukončiť test?';
    if (confirm(text) && await run(api('POST', '/steps/' + stepId + '/ab/winner', { variant: variant }), 'Test ukončený.')) loadStats();
  }

  // --- Vzhľad ----------------------------------------------------------------
  var appearanceForm = document.getElementById('appearance-form');
  var appearanceLoaded = false;
  appearanceForm.colorPicker.oninput = function () { appearanceForm.color.value = this.value; };
  appearanceForm.color.oninput = function () {
    if (/^#[0-9a-fA-F]{6}$/.test(this.value)) appearanceForm.colorPicker.value = this.value.toLowerCase();
  };
  appearanceForm.onsubmit = function (e) {
    e.preventDefault();
    run(api('PUT', '/appearance', {
      color: appearanceForm.color.value,
      termsUrl: appearanceForm.termsUrl.value,
      privacyUrl: appearanceForm.privacyUrl.value,
      customCss: appearanceForm.customCss.value,
      pausedText: appearanceForm.pausedText.value,
      pausedUrl: appearanceForm.pausedUrl.value
    }), 'Vzhľad uložený – snippety ho použijú pri najbližšom načítaní.');
  };
  function renderAppearance(a) {
    if (appearanceLoaded) return; // neprepisuj rozpísaný formulár pri každom prekreslení
    appearanceLoaded = true;
    appearanceForm.color.value = a.color;
    appearanceForm.colorPicker.value = a.color;
    appearanceForm.termsUrl.value = a.termsUrl;
    appearanceForm.privacyUrl.value = a.privacyUrl;
    appearanceForm.customCss.value = a.customCss;
    appearanceForm.pausedText.value = a.pausedText || '';
    appearanceForm.pausedUrl.value = a.pausedUrl || '';
  }

  // Prompt, podľa ktorého ľubovoľné AI vygeneruje CSS pre snippety (popisuje ich HTML a pravidlá)
  var CSS_PROMPT = [
    'Si skúsený web dizajnér. Napíš CSS, ktoré upraví vzhľad platobného formulára Neoworkly Funnel vloženého na môj web.',
    '',
    'Môj web: [SEM OPÍŠ SVOJ WEB – napr. minimalistický, svetlé pozadie, zaoblené rohy, písmo Inter, hlavná farba #1a9e55. Môžeš priložiť aj snímku obrazovky.]',
    '',
    'Štruktúra HTML (nemôžem ju meniť, iba štýlovať):',
    '',
    '1) Vstupný formulár (e-mail, počet kusov a karta):',
    '<div class="nw-box" id="nw-entry">',
    '  <h3 class="nw-title">Názov produktu – cena</h3>',
    '  <form>',
    '    <input type="email" name="email" placeholder="Tvoj e-mail">',
    '    <label>Počet kusov <input type="number" name="quantity"></label>',
    '    <div class="nw-address"><!-- adresa doručenia od Stripe (iframe), ak je zapnutá --></div>',
    '    <div class="nw-fields"><!-- voľné polia, ak sú nastavené -->',
    '      <label>Venovanie <textarea></textarea></label>',
    '      <label>Poznámka (nepovinné) <input type="text"></label>',
    '    </div>',
    '    <div class="nw-card"><!-- platobné pole Stripe (iframe) --></div>',
    '    <p class="nw-note">Kartu uložíme u Stripe…</p>',
    '    <button type="submit">Pokračovať</button>',
    '    <p class="nw-msg" role="alert"><!-- chybová hláška --></p>',
    '    <p class="nw-legal">Pokračovaním súhlasíš s <a class="nw-terms">obchodnými podmienkami</a> a <a class="nw-privacy">zásadami ochrany osobných údajov</a>.</p>',
    '  </form>',
    '  <p class="nw-powered"><svg>zámok</svg> Powered by <a>Stripe</a> · <a>Neoworkly Funnel</a></p>',
    '</div>',
    '',
    '2) Ponuka (upsell/downsell) s dvoma tlačidlami:',
    '<div class="nw-offer">',
    '  <h3 class="nw-title">Nadpis ponuky</h3>',
    '  <div class="nw-fields"><label>Text na obale <input type="text"></label></div>  <!-- voľné polia, ak sú -->',
    '  <button class="nw-yes">Chcem pridať</button>',
    '  <button class="nw-no">Nechcem pridať</button>',
    '  <p class="nw-msg" role="alert"></p>',
    '  <p class="nw-powered">… Powered by Stripe · Neoworkly Funnel</p>',
    '</div>',
    '',
    'Pravidlá:',
    '- Každý selektor začni .nw-box alebo .nw-offer, aby CSS neovplyvnilo zvyšok môjho webu.',
    '- Farba hlavného tlačidla je v premennej var(--nw-color) a farba textu na ňom vo var(--nw-text). Použi ich, ak nechceš inú farbu.',
    '- Počas spracovania platby majú tlačidlá atribút disabled – navrhni aj štýl button:disabled.',
    '- Počas načítania má koreňový prvok triedu .nw-loading (je skrytý) – toto správanie nemeň.',
    '- Štýluj spolu input aj textarea (rovnaký vzhľad), vrátane :focus a ::placeholder.',
    '- .nw-card a .nw-address obsahujú iframe od Stripe – CSS zmení iba ich okolie (okraj, odsadenie). Polia vo vnútri prevezmú vzhľad poľa pre e-mail automaticky.',
    '- Dodrž čitateľný kontrast (aspoň 4,5:1) a nech to funguje na mobile od šírky 320 px.',
    '- Iba čisté CSS: žiadny JavaScript, @import ani externé obrázky či fonty.',
    '- Vráť iba výsledné CSS v jednom bloku kódu, bez vysvetľovania.'
  ].join('\n');
  document.getElementById('css-prompt').value = CSS_PROMPT;
  document.getElementById('css-prompt-copy').onclick = async function () {
    await navigator.clipboard.writeText(CSS_PROMPT);
    toast('Prompt skopírovaný – vlož ho do AI a doplň opis svojho webu.');
  };

  // --- Snippety -------------------------------------------------------------
  async function showSnippet(name) {
    try {
      var data = await api('GET', '/snippets/' + encodeURIComponent(name));
      document.getElementById('snippet').value = data.html;
      document.getElementById('csp').value = data.csp.join(';\n') + ';';
      document.getElementById('checkout-box').hidden = !data.checkoutUrl;
      if (data.checkoutUrl) {
        document.getElementById('checkout-url').value = data.checkoutUrl;
        document.getElementById('checkout-html').value = '<a href="' + data.checkoutUrl + '" class="nw-checkout-button" rel="nofollow">Kúpiť</a>';
      }
      document.getElementById('snippet-box').hidden = false;
      document.getElementById('snippet-box').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (err) {
      toast(err.message, true);
    }
  }
  document.getElementById('copy-checkout').onclick = async function () {
    await navigator.clipboard.writeText(document.getElementById('checkout-url').value);
    toast('Odkaz skopírovaný.');
  };

  // --- Apple Pay a Google Pay -------------------------------------------------------
  var WALLET_STATUS = { active: 'Aktívne', inactive: 'Neaktívne' };
  function renderWallets(data) {
    var rows = document.getElementById('wallet-domains');
    rows.replaceChildren();
    data.domains.forEach(function (d) {
      var badge = function (s) { return el('span', { className: 'status ' + (s === 'active' ? 'ok' : 'wait'), textContent: WALLET_STATUS[s] || s }); };
      rows.append(el('tr', { title: d.error || '' }, el('td', { textContent: d.domain }), el('td', {}, badge(d.applePay)), el('td', {}, badge(d.googlePay))));
    });
    if (!rows.children.length) rows.append(el('tr', {}, el('td', { colSpan: 3, className: 'empty', textContent: 'Zatiaľ žiadna doména.' })));
  }
  async function loadWallets() {
    try {
      renderWallets(await api('GET', '/wallets'));
      document.getElementById('wallets-card').hidden = false;
    } catch (err) {
      document.getElementById('wallets-card').hidden = true; // bez prepojeného Stripe účtu
    }
  }
  if (VIEW === 'payments') document.getElementById('wallet-form').onsubmit = async function (e) {
    e.preventDefault();
    var form = this;
    form.querySelector('button').disabled = true;
    try {
      renderWallets(await api('POST', '/wallets', { domain: form.domain.value }));
      form.reset();
      toast('Doména zaregistrovaná.');
    } catch (err) {
      toast(err.message, true);
    }
    form.querySelector('button').disabled = false;
  };

  if (VIEW === 'funnels') {
    document.getElementById('copy-csp').onclick = async function () {
      await navigator.clipboard.writeText(document.getElementById('csp').value);
      toast('CSP skopírovaná do schránky.');
    };
    document.getElementById('copy').onclick = async function () {
      await navigator.clipboard.writeText(document.getElementById('snippet').value);
      toast('Skopírované do schránky.');
    };
  }

  // --- Stripe účet a staré predplatné Funnel 4 € --------------------------------
  async function redirectTo(path) {
    try {
      goTop((await api('POST', path)).url);
    } catch (err) {
      toast(err.message, true);
    }
  }
  document.getElementById('legacy-portal').onclick = function () { redirectTo('/billing-portal'); };
  if (VIEW === 'payments') document.getElementById('connect').onclick = function () { this.disabled = true; redirectTo('/connect'); };

  // --- Nastavenia účtu ---------------------------------------------------------
  function accountForm(id, path, body, done) {
    var form = document.getElementById(id);
    form.onsubmit = async function (e) {
      e.preventDefault();
      var btn = form.querySelector('button');
      btn.disabled = true;
      try {
        await api('POST', path, body(form));
        form.reset();
        done();
      } catch (err) {
        toast(err.message, true);
      }
      btn.disabled = false;
    };
  }
  if (VIEW === 'payments') {
    accountForm('keys-form', '/connect/keys', function (f) {
      return { secretKey: f.secretKey.value, publishableKey: f.publishableKey.value, password: f.password.value };
    }, function () { toast('Stripe prepojený API kľúčmi.'); run(api('GET', '/me')).then(loadWallets); });
    document.getElementById('keys-disconnect').onclick = function () {
      if (!confirm('Odpojiť API kľúče? Funnely, rezervácie a produkty prestanú prijímať platby online, kým Stripe znova neprepojíš.')) return;
      run(api('DELETE', '/connect/keys'), 'API kľúče odpojené.');
    };
  }
  if (VIEW === 'funnels') {
    toggleFields(productForm, 'one_time');
    toggleFields(stepForm, 'entry');
  }
  run(api('GET', '/me')).then(function () {
    if (state.active && VIEW === 'funnels') loadStats();
    if (state.active && state.stripeAccountId && VIEW === 'payments') loadWallets();
    var back = params.get('stripe');
    if (back === 'test-return') {
      var ready = state.testMode && state.testMode.ready;
      toast(ready ? 'Testovací účet je pripravený.' : 'Testovací účet ešte potrebuje doplniť údaje.', !ready);
    }
    if (back === 'return') {
      toast(state.chargesEnabled ? 'Stripe účet je prepojený.' : 'Stripe ešte potrebuje doplniť niektoré údaje.', !state.chargesEnabled);
    }
    if (back === 'expired') toast('Odkaz zo Stripe vypršal – kliknite znova na „Dokončiť nastavenie v Stripe“.', true);
    if (back) history.replaceState(null, '', location.pathname + '?view=' + VIEW);
    reportHeight();
  });
})();
