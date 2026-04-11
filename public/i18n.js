(function() {
  'use strict';

  const SUPPORTED = ['sk','en','de','fr','es','pl','cs','hu','ro','hr'];
  const DEFAULT   = 'sk';

  function detectLang() {
    const stored = localStorage.getItem('nd_lang');
    if (stored && SUPPORTED.includes(stored)) return stored;
    const browser = (navigator.language || navigator.userLanguage || '').slice(0,2).toLowerCase();
    return SUPPORTED.includes(browser) ? browser : DEFAULT;
  }

  let translations = {};
  let currentLang  = detectLang();

  async function loadLang(lang) {
    if (lang === currentLang && Object.keys(translations).length > 0) return;
    try {
      const r = await fetch(`/locales/${lang}.json?v=1`);
      if (!r.ok) throw new Error();
      translations = await r.json();
      currentLang  = lang;
      localStorage.setItem('nd_lang', lang);
    } catch {
      if (lang !== DEFAULT) {
        const r = await fetch(`/locales/${DEFAULT}.json?v=1`);
        translations = await r.json();
      }
    }
  }

  function t(key, vars) {
    let str = translations[key] || key;
    if (vars) Object.entries(vars).forEach(([k,v]) => { str = str.replace(`{${k}}`, v); });
    return str;
  }

  function applyTranslations(root) {
    const el = root || document;
    el.querySelectorAll('[data-i18n]').forEach(node => {
      const key  = node.getAttribute('data-i18n');
      const attr = node.getAttribute('data-i18n-attr');
      const html = node.getAttribute('data-i18n-html');
      if (attr)       node.setAttribute(attr, t(key));
      else if (html)  node.innerHTML = t(key);
      else            node.textContent = t(key);
    });
    el.querySelectorAll('[data-i18n-placeholder]').forEach(node => {
      node.placeholder = t(node.getAttribute('data-i18n-placeholder'));
    });
  }

  window.i18n = { t, applyTranslations, loadLang, currentLang: () => currentLang, SUPPORTED };
  window.t = t;
})();
