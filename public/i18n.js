/* Neoworkly i18n — text-node replacement engine
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
      document.documentElement.lang = DEFAULT;
      if (callback) callback();
      return;
    }
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/locales/' + lang + '.json?v=5', true);
    xhr.onload = function () {
      if (xhr.status === 200) {
        try { const p = JSON.parse(xhr.responseText); delete p.__done__; translations = p; } catch (e) { translations = {}; }
        currentLang = lang;
        localStorage.setItem('nd_lang', lang);
      } else {
        // File not yet available — keep user's choice, apply no translations for now
        translations = {};
        currentLang = lang;
      }
      document.documentElement.lang = currentLang;
      if (callback) callback();
    };
    xhr.onerror = function () { translations = {}; currentLang = lang; document.documentElement.lang = lang; if (callback) callback(); };
    xhr.send();
  }

  function t(key) {
    return (currentLang !== DEFAULT && translations[key]) ? translations[key] : key;
  }

  function applyTranslations(root) {
    if (currentLang === DEFAULT || Object.keys(translations).length === 0) { updateSwitcherUI(); return; }
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
    window.location.reload(); // preserves hash (#section anchors)
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
    // Set html[lang] synchronously so widget.js (which reads it at parse time) gets the right value
    document.documentElement.lang = lang;
    // Persist ?lang= param to localStorage then clean URL
    var urlParam = new URLSearchParams(window.location.search).get('lang');
    if (urlParam && SUPPORTED.indexOf(urlParam) !== -1) {
      localStorage.setItem('nd_lang', urlParam);
      var cleanUrl = window.location.pathname +
        window.location.search.replace(/[?&]lang=[a-z]{2}/, '').replace(/^\?$/, '');
      history.replaceState(null, '', cleanUrl || window.location.pathname);
    }
    buildSwitcher();
    loadLang(lang, function () { applyTranslations(document.body); applyMetaTranslations(); });
  }

  // Translations for <title> and <meta name="description"> per page per lang
  var META = {
    'index.html': {
      en: { title: 'Neoworkly – AI Sales Agent for Your Website & Instagram', description: 'Not a chatbot. A trained AI salesperson – guides customers from the first question to a closed deal. 24/7. On your website and Instagram.' },
      de: { title: 'Neoworkly – KI-Verkäufer für Ihre Website & Instagram', description: 'Kein Chatbot. Ein trainierter KI-Verkäufer – begleitet Kunden von der ersten Frage bis zum Abschluss. 24/7. Auf Ihrer Website und Instagram.' },
      fr: { title: 'Neoworkly – Agent commercial IA pour votre site & Instagram', description: 'Pas un chatbot. Un commercial IA formé – guide les clients de la première question à la vente conclue. 24h/24. Sur votre site et Instagram.' },
      es: { title: 'Neoworkly – Agente de ventas IA para tu web e Instagram', description: 'No es un chatbot. Es un vendedor IA entrenado – guía al cliente desde la primera pregunta hasta cerrar la venta. 24/7. En tu web e Instagram.' },
      pl: { title: 'Neoworkly – Sprzedawca AI dla Twojej strony i Instagrama', description: 'Nie chatbot. Wyszkolony sprzedawca AI – prowadzi klienta od pierwszego pytania do zamkniętej sprzedaży. 24/7. Na stronie i Instagramie.' },
      cs: { title: 'Neoworkly – AI obchodník pro váš web a Instagram', description: 'Žádný chatbot. Vyškolený AI obchodník – provází zákazníka od první otázky k uzavřenému prodeji. 24/7. Na webu i Instagramu.' },
      hu: { title: 'Neoworkly – AI értékesítő a weboldaladhoz és Instagramhoz', description: 'Nem chatbot. Betanított AI értékesítő – végigkíséri az ügyfelet az első kérdéstől a lezárt üzletig. 24/7. Weboldaladon és Instagramon.' },
      ro: { title: 'Neoworkly – Agent de vânzări AI pentru site-ul și Instagram-ul tău', description: 'Nu un chatbot. Un agent de vânzări AI instruit – ghidează clientul de la prima întrebare până la vânzarea închisă. 24/7. Pe site și Instagram.' },
      hr: { title: 'Neoworkly – AI prodajni agent za vašu web stranicu i Instagram', description: 'Ne chatbot. Obučeni AI prodavač – vodi kupca od prvog pitanja do zaključene prodaje. 24/7. Na webu i Instagramu.' },
    },
    'demo.html': {
      en: { title: 'See Your AI Salesperson in Action – Neoworkly' },
      de: { title: 'Ihren KI-Verkäufer in Aktion erleben – Neoworkly' },
      fr: { title: 'Voir votre vendeur IA en action – Neoworkly' },
      es: { title: 'Ver tu vendedor IA en acción – Neoworkly' },
      pl: { title: 'Zobacz swojego sprzedawcę AI w akcji – Neoworkly' },
      cs: { title: 'Uvidíte svého AI obchodníka v akci – Neoworkly' },
      hu: { title: 'Lásd az AI értékesítődet akcióban – Neoworkly' },
      ro: { title: 'Vedeți agentul dvs. AI de vânzări în acțiune – Neoworkly' },
      hr: { title: 'Pogledajte svog AI prodavača na djelu – Neoworkly' },
    },
    'onboarding.html': {
      en: { title: 'Setup – Neoworkly' },
      de: { title: 'Einrichtung – Neoworkly' },
      fr: { title: 'Configuration – Neoworkly' },
      es: { title: 'Configuración – Neoworkly' },
      pl: { title: 'Konfiguracja – Neoworkly' },
      cs: { title: 'Nastavení – Neoworkly' },
      hu: { title: 'Beállítás – Neoworkly' },
      ro: { title: 'Configurare – Neoworkly' },
      hr: { title: 'Postavljanje – Neoworkly' },
    },
    'present.html': {
      en: { title: 'Gift Card – Neoworkly', description: 'Give Neoworkly — AI chatbot, digital twin or AI credits for your business or a loved one.' },
      de: { title: 'Geschenkkarte – Neoworkly', description: 'Verschenken Sie Neoworkly — KI-Chatbot, digitaler Zwilling oder KI-Credits für Ihr Unternehmen oder jemanden Nahestehenden.' },
      fr: { title: 'Carte cadeau – Neoworkly', description: 'Offrez Neoworkly — chatbot IA, jumeau numérique ou crédits IA pour votre entreprise ou un proche.' },
      es: { title: 'Tarjeta de regalo – Neoworkly', description: 'Regala Neoworkly — chatbot IA, gemelo digital o créditos IA para tu negocio o alguien especial.' },
      pl: { title: 'Karta podarunkowa – Neoworkly', description: 'Podaruj Neoworkly — chatbot AI, cyfrowy bliźniak lub kredyty AI dla Twojej firmy lub bliskiej osoby.' },
      cs: { title: 'Dárková karta – Neoworkly', description: 'Darujte Neoworkly — AI chatbot, digitální dvojník nebo AI kredity pro váš byznys nebo blízkého.' },
      hu: { title: 'Ajándékkártya – Neoworkly', description: 'Ajándékozzon Neoworkly-t — AI chatbot, digitális iker vagy AI kreditek vállalkozásának vagy szeretteinek.' },
      ro: { title: 'Card cadou – Neoworkly', description: 'Dăruiți Neoworkly — chatbot AI, geamăn digital sau credite AI pentru afacerea dvs. sau o persoană dragă.' },
      hr: { title: 'Poklon kartica – Neoworkly', description: 'Poklonite Neoworkly — AI chatbot, digitalni dvojnik ili AI kredite za vaše poslovanje ili nekoga bliskog.' },
    },
  };

  function applyMetaTranslations() {
    if (currentLang === DEFAULT) return;
    var page = window.location.pathname.split('/').pop() || 'index.html';
    if (!page.endsWith('.html')) page = 'index.html';
    var pageMeta = META[page];
    if (!pageMeta) return;
    var m = pageMeta[currentLang];
    if (!m) return;
    if (m.title) document.title = m.title;
    if (m.description) {
      var el = document.querySelector('meta[name="description"]');
      if (el) el.setAttribute('content', m.description);
    }
  }

  window.i18n = { t: t, setLang: setLang, loadLang: loadLang, applyTranslations: applyTranslations,
                  applyMetaTranslations: applyMetaTranslations,
                  currentLang: function () { return currentLang; }, SUPPORTED: SUPPORTED, FLAGS: FLAGS };
  window.t = t;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
