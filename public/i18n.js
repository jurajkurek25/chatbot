/* NeuraDeskApp i18n — text-node replacement engine
 * No HTML changes required — translations applied via DOM walker.
 * Language files: /locales/{lang}.json  (keys = SK source, values = translation)
 * To generate translations: node scripts/translate.js  (needs ANTHROPIC_API_KEY)
 */
(function () {
  'use strict';

  var SUPPORTED = ['sk', 'en', 'de', 'fr', 'es', 'pl', 'cs', 'hu', 'ro', 'hr'];
  var DEFAULT   = 'sk';
  var FLAGS     = { sk:'🇸🇰', en:'🇬🇧', de:'🇩🇪', fr:'🇫🇷', es:'🇪🇸', pl:'🇵🇱', cs:'🇨🇿', hu:'🇭🇺', ro:'🇷🇴', hr:'🇭🇷' };
  var NAMES     = { sk:'Slovenčina', en:'English', de:'Deutsch', fr:'Français', es:'Español', pl:'Polski', cs:'Čeština', hu:'Magyar', ro:'Română', hr:'Hrvatski' };

  var translations = {};
  var currentLang  = DEFAULT;

  function detectLang() {
    var urlParam = new URLSearchParams(window.location.search).get('lang');
    if (urlParam && SUPPORTED.indexOf(urlParam) !== -1) return urlParam;
    var stored = localStorage.getItem('nd_lang');
    if (stored && SUPPORTED.indexOf(stored) !== -1) return stored;
    var browser = ((navigator.language || navigator.userLanguage || '').slice(0, 2) || '').toLowerCase();
    return SUPPORTED.indexOf(browser) !== -1 ? browser : DEFAULT;
  }

  function loadLang(lang, callback) {
    if (SUPPORTED.indexOf(lang) === -1) lang = DEFAULT;
    if (lang === DEFAULT) {
      translations = {};
      currentLang  = DEFAULT;
      localStorage.setItem('nd_lang', DEFAULT);
      if (callback) callback();
      return;
    }
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/locales/' + lang + '.json?v=2', true);
    xhr.onload = function () {
      if (xhr.status === 200) {
        try { translations = JSON.parse(xhr.responseText); } catch (e) { translations = {}; }
        currentLang = lang;
        localStorage.setItem('nd_lang', lang);
      } else {
        translations = {};
        currentLang  = DEFAULT;
        localStorage.setItem('nd_lang', DEFAULT);
      }
      if (callback) callback();
    };
    xhr.onerror = function () { translations = {}; currentLang = DEFAULT; if (callback) callback(); };
    xhr.send();
  }

  function t(key) {
    return (currentLang !== DEFAULT && translations[key]) ? translations[key] : key;
  }

  function applyTranslations(root) {
    if (currentLang === DEFAULT) { updateSwitcherUI(); return; }
    if (!root) root = document.body;

    // Walk text nodes
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var node;
    while ((node = walker.nextNode())) {
      // Skip script/style content
      var parent = node.parentElement;
      if (!parent) continue;
      var tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'CODE' || tag === 'PRE') continue;
      var orig    = node.textContent;
      var trimmed = orig.trim();
      if (trimmed.length < 2) continue;
      if (translations[trimmed]) {
        node.textContent = orig.replace(trimmed, translations[trimmed]);
      }
    }

    // Placeholder / title / alt attributes
    root.querySelectorAll('[placeholder]').forEach(function (el) {
      var ph = el.placeholder.trim();
      if (ph && translations[ph]) el.placeholder = translations[ph];
    });
    root.querySelectorAll('[title]').forEach(function (el) {
      var tl = el.title.trim();
      if (tl && translations[tl]) el.title = translations[tl];
    });

    updateSwitcherUI();
  }

  function setLang(lang) {
    localStorage.setItem('nd_lang', lang || DEFAULT);
    // Reload page — cleanest way to re-apply all translations from scratch
    var url = new URL(window.location.href);
    url.searchParams.delete('lang');
    window.location.href = url.toString();
  }

  var switcherBuilt = false;

  function closeAllMenus() {
    document.querySelectorAll('.lsw-wrap.open').forEach(function (w) {
      w.classList.remove('open');
      var m = w.querySelector('.lsw-menu');
      var t = w.querySelector('.lsw-trigger');
      if (m) m.style.display = 'none';
      if (t) t.setAttribute('aria-expanded', 'false');
    });
  }

  function buildSwitcher() {
    var containers = document.querySelectorAll('.lang-switcher');
    if (!containers.length) return;

    var items = SUPPORTED.map(function (l) {
      return '<button type="button" class="lsw-item" data-lang="' + l + '">'
           + '<span class="lsw-code">' + l.toUpperCase() + '</span>'
           + '<span class="lsw-name">' + NAMES[l] + '</span>'
           + '</button>';
    }).join('');

    containers.forEach(function (c) {
      c.innerHTML =
        '<div class="lsw-wrap">'
        + '<button type="button" class="lsw-trigger" aria-haspopup="true" aria-expanded="false">'
        +   '<span class="lsw-cur-code"></span>'
        +   '<svg class="lsw-arrow" width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        + '</button>'
        + '<div class="lsw-menu" style="display:none">' + items + '</div>'
        + '</div>';

      var wrap    = c.querySelector('.lsw-wrap');
      var trigger = c.querySelector('.lsw-trigger');
      var menu    = c.querySelector('.lsw-menu');

      trigger.addEventListener('click', function (e) {
        e.stopPropagation();
        var isOpen = !wrap.classList.contains('open');
        closeAllMenus();
        if (isOpen) {
          wrap.classList.add('open');
          menu.style.display = 'block';
          trigger.setAttribute('aria-expanded', 'true');
        }
      });

      menu.addEventListener('click', function (e) {
        var btn = e.target.closest('.lsw-item');
        if (btn) { closeAllMenus(); i18n.setLang(btn.dataset.lang); }
      });
    });

    if (!switcherBuilt) {
      document.addEventListener('click', closeAllMenus);
      switcherBuilt = true;
    }

    updateSwitcherUI();
  }

  function updateSwitcherUI() {
    var lang = currentLang;
    document.querySelectorAll('.lsw-cur-code').forEach(function (el) { el.textContent = lang.toUpperCase(); });
    document.querySelectorAll('.lsw-item').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.lang === lang);
    });
  }

  function init() {
    var lang = detectLang();
    // Persist ?lang= param to localStorage then clean URL
    var urlParam = new URLSearchParams(window.location.search).get('lang');
    if (urlParam && SUPPORTED.indexOf(urlParam) !== -1) {
      localStorage.setItem('nd_lang', urlParam);
      var cleanUrl = window.location.pathname +
        window.location.search.replace(/[?&]lang=[a-z]{2}/, '').replace(/^\?$/, '');
      history.replaceState(null, '', cleanUrl || window.location.pathname);
    }
    buildSwitcher();
    loadLang(lang, function () { applyTranslations(document.body); });
  }

  window.i18n = { t: t, setLang: setLang, loadLang: loadLang, applyTranslations: applyTranslations,
                  currentLang: function () { return currentLang; }, SUPPORTED: SUPPORTED, FLAGS: FLAGS };
  window.t = t;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
