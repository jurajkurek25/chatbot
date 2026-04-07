(function () {
  'use strict';

  var BASE_URL = (function () {
    var scripts = document.querySelectorAll('script[src]');
    for (var i = 0; i < scripts.length; i++) {
      var m = scripts[i].src.match(/^(https?:\/\/[^/]+)\/knowledge-widget\.js/);
      if (m) return m[1];
    }
    return '';
  })();

  function init() {
    var containers = document.querySelectorAll('[data-nd-knowledge]');
    for (var i = 0; i < containers.length; i++) {
      var container = containers[i];
      var widgetId = container.getAttribute('data-nd-knowledge');
      if (widgetId && !container.__ndKwMounted) {
        container.__ndKwMounted = true;
        mountWidget(container, widgetId);
      }
    }
  }

  function mountWidget(container, widgetId) {
    container.innerHTML = '<div style="padding:1.5rem;text-align:center;color:#94a3b8;font-family:sans-serif;font-size:0.875rem;">Načítavam...</div>';

    fetch(BASE_URL + '/api/widget/' + encodeURIComponent(widgetId) + '/knowledge')
      .then(function (r) {
        if (!r.ok) { container.innerHTML = ''; return null; }
        return r.json();
      })
      .then(function (data) {
        if (!data) return;
        container.innerHTML = '';
        var shadow = container.attachShadow({ mode: 'open' });
        renderKnowledge(shadow, data);
      })
      .catch(function () {
        container.innerHTML = '';
      });
  }

  function renderKnowledge(root, data) {
    var color = data.primary_color || '#2563eb';
    var items = data.items || [];

    var style = document.createElement('style');
    style.textContent = [
      ':host{display:block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}',
      '.nd-kw{max-width:800px;margin:0 auto;}',
      '.nd-kw-search{',
        'width:100%;box-sizing:border-box;padding:0.75rem 1rem;',
        'border:1.5px solid #e2e8f0;border-radius:8px;font-size:0.95rem;',
        'outline:none;margin-bottom:1rem;background:#fff;color:#1e293b;',
        'transition:border-color 0.2s;',
      '}',
      '.nd-kw-search:focus{border-color:' + color + ';}',
      '.nd-kw-search::placeholder{color:#94a3b8;}',
      '.nd-kw-item{border:1px solid #e2e8f0;border-radius:10px;margin-bottom:0.5rem;overflow:hidden;background:#fff;}',
      '.nd-kw-hdr{',
        'padding:1rem 1.25rem;cursor:pointer;',
        'display:flex;justify-content:space-between;align-items:center;gap:1rem;',
        'font-weight:600;font-size:0.9375rem;color:#1e293b;',
        'user-select:none;background:#fff;transition:background 0.15s;border:none;width:100%;text-align:left;',
      '}',
      '.nd-kw-hdr:hover{background:#f8fafc;}',
      '.nd-kw-hdr.open{color:' + color + ';}',
      '.nd-kw-arrow{font-size:0.7rem;color:#94a3b8;transition:transform 0.25s;flex-shrink:0;}',
      '.nd-kw-hdr.open .nd-kw-arrow{transform:rotate(180deg);color:' + color + ';}',
      '.nd-kw-body{display:none;padding:0 1.25rem 1rem 1.25rem;font-size:0.875rem;color:#475569;line-height:1.75;white-space:pre-wrap;word-break:break-word;}',
      '.nd-kw-body.open{display:block;}',
      '.nd-kw-empty{text-align:center;color:#94a3b8;padding:2.5rem 1rem;font-size:0.9rem;}',
      '.nd-kw-count{font-size:0.8rem;color:#94a3b8;margin-bottom:0.75rem;}',
    ].join('');

    var wrap = document.createElement('div');
    wrap.className = 'nd-kw';

    var searchEl = null;
    if (items.length > 3) {
      searchEl = document.createElement('input');
      searchEl.type = 'text';
      searchEl.className = 'nd-kw-search';
      searchEl.placeholder = 'Hľadať v znalostnej báze...';
      wrap.appendChild(searchEl);
    }

    var countEl = document.createElement('div');
    countEl.className = 'nd-kw-count';
    countEl.textContent = items.length + ' ' + pluralItems(items.length);
    if (items.length > 0) wrap.appendChild(countEl);

    var list = document.createElement('div');
    var itemEls = items.map(function (item) {
      var el = document.createElement('div');
      el.className = 'nd-kw-item';
      el._ndTitle = item.title.toLowerCase();
      el._ndContent = item.content.toLowerCase();

      var hdr = document.createElement('button');
      hdr.className = 'nd-kw-hdr';
      hdr.type = 'button';

      var titleSpan = document.createElement('span');
      titleSpan.textContent = item.title;

      var arrow = document.createElement('span');
      arrow.className = 'nd-kw-arrow';
      arrow.textContent = '▼';

      hdr.appendChild(titleSpan);
      hdr.appendChild(arrow);

      var body = document.createElement('div');
      body.className = 'nd-kw-body';
      body.textContent = item.content;

      hdr.addEventListener('click', function () {
        var isOpen = hdr.classList.contains('open');
        hdr.classList.toggle('open', !isOpen);
        body.classList.toggle('open', !isOpen);
      });

      el.appendChild(hdr);
      el.appendChild(body);
      list.appendChild(el);
      return el;
    });

    if (items.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'nd-kw-empty';
      empty.textContent = 'Zatiaľ žiadne články v znalostnej báze.';
      list.appendChild(empty);
    }

    wrap.appendChild(list);

    if (searchEl) {
      searchEl.addEventListener('input', function () {
        var q = searchEl.value.toLowerCase().trim();
        var visible = 0;
        itemEls.forEach(function (el) {
          var match = !q || el._ndTitle.indexOf(q) !== -1 || el._ndContent.indexOf(q) !== -1;
          el.style.display = match ? '' : 'none';
          if (match) visible++;
        });
        countEl.textContent = visible + ' ' + pluralItems(visible) +
          (q ? ' (filtrovane)' : '');
      });
    }

    root.appendChild(style);
    root.appendChild(wrap);
  }

  function pluralItems(n) {
    if (n === 1) return 'článok';
    if (n >= 2 && n <= 4) return 'články';
    return 'článkov';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
