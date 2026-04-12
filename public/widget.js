/* NeuraDeskApp Embeddable Widget v1.0
 * Vložte tento súbor na váš web a chatbot sa automaticky zobrazí.
 * Usage:
 *   <script>window.NeuraDeskConfig = { widgetId: 'YOUR_WIDGET_ID' };</script>
 *   <script src="https://neuradesk.online/widget.js" async></script>
 */
(function () {
  'use strict';

  const BASE_URL = (function () {
    // document.currentScript is reliable for both sync and async scripts
    if (document.currentScript && document.currentScript.src) {
      try { return new URL(document.currentScript.src).origin; } catch {}
    }
    // Fallback: find widget.js in the script list
    const scripts = document.getElementsByTagName('script');
    for (let i = scripts.length - 1; i >= 0; i--) {
      if (scripts[i].src && scripts[i].src.includes('widget.js')) {
        try { return new URL(scripts[i].src).origin; } catch {}
      }
    }
    return 'https://neuradesk.online';
  })();

  const cfg = window.NeuraDeskConfig || {};
  const WIDGET_ID = cfg.widgetId;
  if (!WIDGET_ID) { console.warn('[NeuraDeskApp] Chýba widgetId v NeuraDeskConfig.'); return; }

  /* ── Widget i18n (zero API cost) ─────────────────────────────── */
  function detectPageLang() {
    const h = document.documentElement.lang;
    if (h) return h.toLowerCase().split('-')[0];
    const pm = location.pathname.match(/^\/([a-z]{2})\//);
    if (pm) return pm[1];
    const sm = location.hostname.match(/^([a-z]{2})\./);
    if (sm && sm[1] !== 'ww') return sm[1];
    return (navigator.language || 'sk').toLowerCase().split('-')[0];
  }

  const _SUPPORTED = ['sk','en','de','fr','es','pl','cs','hu','ro','hr'];
  // _lang is computed lazily on first call — ensures i18n.js has already set html[lang]
  // (i18n.js runs synchronously before DOMContentLoaded; widget init() runs after)
  let _lang = null;
  function getLang() {
    if (!_lang) { const l = detectPageLang(); _lang = _SUPPORTED.includes(l) ? l : 'sk'; }
    return _lang;
  }

  const WIDGET_I18N = {
    sk: {
      open:'Otvoriť chat', close:'Zavrieť', online:'Online',
      quick_q:'Rýchle otázky', placeholder:'Napíšte správu...',
      powered:'Toto je AI predajca\u00a0\u2014\u00a0', powered_link:'chceš ho tiež?',
      write:'Napísať \u2192',
      cta_call_text:'Chcete sa poradiť osobne?', cta_call_btn:'📞 Zavolať',
      cta_cont_text:'Máte záujem? Ozveme sa vám!', cta_cont_label:'Zanechajte kontakt',
      cta_more:'Zistiť viac',
      gdpr_title:'📋 Podmienky spracovania osobných údajov',
      form_title:'Zanechajte kontakt', form_sub:'Ozveme sa vám čo najskôr.',
      name_label:'Meno *', name_ph:'Vaše meno',
      email_label:'Email *', email_ph:'vas@email.sk',
      phone_label:'Telefón', phone_ph:'+421 900 000 000',
      gdpr_full:'Prečítal/a som si podmienky spracovania osobných údajov a súhlasím s nimi.*',
      gdpr_simple:'Súhlasím so spracovaním osobných údajov za účelom spätného kontaktu.*',
      cancel:'Zrušiť', send:'Odoslať',
      gdpr_note:'Vaše osobné údaje spracúvame v súlade s GDPR.',
      gdpr_show:'Zobraziť podrobnosti', gdpr_hide:'Skryť',
      thanks:'Ďakujeme!', contact_ok:'Ozveme sa vám čo najskôr, ',
      error:'Prepáčte, nie je možné sa spojiť so serverom.',
    },
    en: {
      open:'Open chat', close:'Close', online:'Online',
      quick_q:'Quick questions', placeholder:'Write a message...',
      powered:'This is an AI salesman\u00a0\u2014\u00a0', powered_link:'want one too?',
      write:'Write \u2192',
      cta_call_text:'Want to consult in person?', cta_call_btn:'📞 Call',
      cta_cont_text:"Interested? We'll get back to you!", cta_cont_label:'Leave your contact',
      cta_more:'Learn more',
      gdpr_title:'📋 Personal data processing terms',
      form_title:'Leave your contact', form_sub:"We'll get back to you as soon as possible.",
      name_label:'Name *', name_ph:'Your name',
      email_label:'Email *', email_ph:'your@email.com',
      phone_label:'Phone', phone_ph:'+1 000 000 0000',
      gdpr_full:'I have read the personal data processing terms and I agree.*',
      gdpr_simple:'I consent to the processing of my personal data for contact purposes.*',
      cancel:'Cancel', send:'Send',
      gdpr_note:'We process your personal data in accordance with GDPR.',
      gdpr_show:'Show details', gdpr_hide:'Hide',
      thanks:'Thank you!', contact_ok:"We'll get back to you shortly, ",
      error:'Sorry, unable to connect to the server.',
    },
    de: {
      open:'Chat öffnen', close:'Schließen', online:'Online',
      quick_q:'Schnelle Fragen', placeholder:'Nachricht schreiben...',
      powered:'Das ist ein KI-Verkäufer\u00a0\u2014\u00a0', powered_link:'auch einen haben?',
      write:'Schreiben \u2192',
      cta_call_text:'Möchten Sie sich persönlich beraten lassen?', cta_call_btn:'📞 Anrufen',
      cta_cont_text:'Interessiert? Wir melden uns!', cta_cont_label:'Kontakt hinterlassen',
      cta_more:'Mehr erfahren',
      gdpr_title:'📋 Datenschutzbedingungen',
      form_title:'Kontakt hinterlassen', form_sub:'Wir melden uns so schnell wie möglich.',
      name_label:'Name *', name_ph:'Ihr Name',
      email_label:'E-Mail *', email_ph:'ihre@email.de',
      phone_label:'Telefon', phone_ph:'+49 000 0000000',
      gdpr_full:'Ich habe die Datenschutzbedingungen gelesen und stimme zu.*',
      gdpr_simple:'Ich stimme der Verarbeitung meiner Daten zum Zweck der Kontaktaufnahme zu.*',
      cancel:'Abbrechen', send:'Senden',
      gdpr_note:'Ihre Daten werden DSGVO-konform verarbeitet.',
      gdpr_show:'Details anzeigen', gdpr_hide:'Verbergen',
      thanks:'Danke!', contact_ok:'Wir melden uns bald, ',
      error:'Entschuldigung, Verbindung zum Server nicht möglich.',
    },
    fr: {
      open:'Ouvrir le chat', close:'Fermer', online:'En ligne',
      quick_q:'Questions rapides', placeholder:'\u00c9crire un message...',
      powered:"C'est un vendeur IA\u00a0\u2014\u00a0", powered_link:'en vouloir un aussi\u00a0?',
      write:'\u00c9crire \u2192',
      cta_call_text:'Vous souhaitez une consultation personnelle\u00a0?', cta_call_btn:'📞 Appeler',
      cta_cont_text:'Int\u00e9ress\u00e9(e)\u00a0? Nous vous rappellerons\u00a0!', cta_cont_label:'Laisser ses coordonn\u00e9es',
      cta_more:'En savoir plus',
      gdpr_title:'📋 Conditions de traitement des donn\u00e9es',
      form_title:'Laisser ses coordonn\u00e9es', form_sub:'Nous vous recontacterons d\u00e8s que possible.',
      name_label:'Nom *', name_ph:'Votre nom',
      email_label:'Email *', email_ph:'votre@email.fr',
      phone_label:'T\u00e9l\u00e9phone', phone_ph:'+33 0 00 00 00 00',
      gdpr_full:"J'ai lu les conditions de traitement des donn\u00e9es et j'accepte.*",
      gdpr_simple:'Je consens au traitement de mes donn\u00e9es personnelles \u00e0 des fins de contact.*',
      cancel:'Annuler', send:'Envoyer',
      gdpr_note:'Vos donn\u00e9es personnelles sont trait\u00e9es conform\u00e9ment au RGPD.',
      gdpr_show:'Afficher les d\u00e9tails', gdpr_hide:'Masquer',
      thanks:'Merci\u00a0!', contact_ok:'Nous vous recontacterons bient\u00f4t, ',
      error:'D\u00e9sol\u00e9, impossible de se connecter au serveur.',
    },
    es: {
      open:'Abrir chat', close:'Cerrar', online:'En l\u00ednea',
      quick_q:'Preguntas r\u00e1pidas', placeholder:'Escribe un mensaje...',
      powered:'Este es un vendedor IA\u00a0\u2014\u00a0', powered_link:'\u00bfquieres uno tambi\u00e9n?',
      write:'Escribir \u2192',
      cta_call_text:'\u00bfQuiere consultar en persona?', cta_call_btn:'📞 Llamar',
      cta_cont_text:'\u00bfInteresado/a? \u00a1Le contactaremos!', cta_cont_label:'Dejar contacto',
      cta_more:'M\u00e1s informaci\u00f3n',
      gdpr_title:'📋 Condiciones de tratamiento de datos',
      form_title:'Dejar contacto', form_sub:'Nos pondremos en contacto lo antes posible.',
      name_label:'Nombre *', name_ph:'Su nombre',
      email_label:'Email *', email_ph:'su@email.es',
      phone_label:'Tel\u00e9fono', phone_ph:'+34 000 000 000',
      gdpr_full:'He le\u00eddo las condiciones de tratamiento de datos y acepto.*',
      gdpr_simple:'Consiento el tratamiento de mis datos personales para fines de contacto.*',
      cancel:'Cancelar', send:'Enviar',
      gdpr_note:'Sus datos personales se procesan de acuerdo con el RGPD.',
      gdpr_show:'Mostrar detalles', gdpr_hide:'Ocultar',
      thanks:'\u00a1Gracias!', contact_ok:'Nos pondremos en contacto pronto, ',
      error:'Lo sentimos, no es posible conectarse al servidor.',
    },
    pl: {
      open:'Otwórz czat', close:'Zamknij', online:'Online',
      quick_q:'Szybkie pytania', placeholder:'Napisz wiadomość...',
      powered:'To jest sprzedawca AI\u00a0\u2014\u00a0', powered_link:'chcesz też?',
      write:'Napisz \u2192',
      cta_call_text:'Chcesz skonsultować się osobiście?', cta_call_btn:'📞 Zadzwoń',
      cta_cont_text:'Zainteresowany/a? Odezwiemy się!', cta_cont_label:'Zostaw kontakt',
      cta_more:'Dowiedz się więcej',
      gdpr_title:'📋 Warunki przetwarzania danych osobowych',
      form_title:'Zostaw kontakt', form_sub:'Odezwiemy się jak najszybciej.',
      name_label:'Imię *', name_ph:'Twoje imię',
      email_label:'Email *', email_ph:'twoj@email.pl',
      phone_label:'Telefon', phone_ph:'+48 000 000 000',
      gdpr_full:'Zapoznałem/łam się z warunkami przetwarzania danych i wyrażam zgodę.*',
      gdpr_simple:'Wyrażam zgodę na przetwarzanie danych osobowych w celu kontaktu.*',
      cancel:'Anuluj', send:'Wyślij',
      gdpr_note:'Przetwarzamy dane osobowe zgodnie z RODO.',
      gdpr_show:'Pokaż szczegóły', gdpr_hide:'Ukryj',
      thanks:'Dziękujemy!', contact_ok:'Odezwiemy się wkrótce, ',
      error:'Przepraszamy, nie można połączyć się z serwerem.',
    },
    cs: {
      open:'Otevřít chat', close:'Zavřít', online:'Online',
      quick_q:'Rychlé otázky', placeholder:'Napište zprávu...',
      powered:'Toto je AI obchodník\u00a0\u2014\u00a0', powered_link:'chcete ho také?',
      write:'Napsat \u2192',
      cta_call_text:'Chcete se osobně poradit?', cta_call_btn:'📞 Zavolat',
      cta_cont_text:'Máte zájem? Ozveme se vám!', cta_cont_label:'Zanechat kontakt',
      cta_more:'Zjistit více',
      gdpr_title:'📋 Podmínky zpracování osobních údajů',
      form_title:'Zanechat kontakt', form_sub:'Ozveme se vám co nejdříve.',
      name_label:'Jméno *', name_ph:'Vaše jméno',
      email_label:'Email *', email_ph:'vas@email.cz',
      phone_label:'Telefon', phone_ph:'+420 000 000 000',
      gdpr_full:'Přečetl/a jsem podmínky zpracování osobních údajů a souhlasím.*',
      gdpr_simple:'Souhlasím se zpracováním osobních údajů za účelem kontaktu.*',
      cancel:'Zrušit', send:'Odeslat',
      gdpr_note:'Vaše osobní údaje zpracováváme v souladu s GDPR.',
      gdpr_show:'Zobrazit podrobnosti', gdpr_hide:'Skrýt',
      thanks:'Děkujeme!', contact_ok:'Ozveme se vám co nejdříve, ',
      error:'Omlouváme se, nelze se připojit k serveru.',
    },
    hu: {
      open:'Chat megnyitása', close:'Bezárás', online:'Online',
      quick_q:'Gyors kérdések', placeholder:'Írjon üzenetet...',
      powered:'Ez egy AI értékesítő\u00a0\u2014\u00a0', powered_link:'szeretne egyet?',
      write:'Írjon \u2192',
      cta_call_text:'Személyesen szeretne tanácsot kérni?', cta_call_btn:'📞 Hívjon',
      cta_cont_text:'Érdekli? Visszahívjuk!', cta_cont_label:'Hagyjon elérhetőséget',
      cta_more:'Tudjon meg többet',
      gdpr_title:'📋 Személyes adatok kezelési feltételei',
      form_title:'Hagyjon elérhetőséget', form_sub:'A lehető leghamarabb felvesszük Önnel a kapcsolatot.',
      name_label:'Név *', name_ph:'Az Ön neve',
      email_label:'Email *', email_ph:'on@email.hu',
      phone_label:'Telefon', phone_ph:'+36 00 000 0000',
      gdpr_full:'Elolvastam az adatkezelési feltételeket és elfogadom azokat.*',
      gdpr_simple:'Hozzájárulok személyes adataim kapcsolatfelvétel céljára történő kezeléséhez.*',
      cancel:'Mégsem', send:'Küldés',
      gdpr_note:'Személyes adatait a GDPR-nak megfelelően kezeljük.',
      gdpr_show:'Részletek megjelenítése', gdpr_hide:'Elrejtés',
      thanks:'Köszönjük!', contact_ok:'Hamarosan felvesszük Önnel a kapcsolatot, ',
      error:'Sajnáljuk, nem sikerül csatlakozni a szerverhez.',
    },
    ro: {
      open:'Deschide chat', close:'Închide', online:'Online',
      quick_q:'Întrebări rapide', placeholder:'Scrieți un mesaj...',
      powered:'Acesta este un vânzător AI\u00a0\u2014\u00a0', powered_link:'vreți și dvs.?',
      write:'Scrieți \u2192',
      cta_call_text:'Doriți să vă consultați personal?', cta_call_btn:'📞 Sunați',
      cta_cont_text:'Interesat(ă)? Vă contactăm!', cta_cont_label:'Lăsați datele de contact',
      cta_more:'Aflați mai mult',
      gdpr_title:'📋 Condiții de prelucrare a datelor personale',
      form_title:'Lăsați datele de contact', form_sub:'Vă vom contacta cât mai curând.',
      name_label:'Nume *', name_ph:'Numele dvs.',
      email_label:'Email *', email_ph:'dvs@email.ro',
      phone_label:'Telefon', phone_ph:'+40 000 000 000',
      gdpr_full:'Am citit condițiile de prelucrare a datelor și sunt de acord.*',
      gdpr_simple:'Sunt de acord cu prelucrarea datelor personale în scopul contactului.*',
      cancel:'Anulați', send:'Trimiteți',
      gdpr_note:'Datele dvs. personale sunt prelucrate conform GDPR.',
      gdpr_show:'Afișați detalii', gdpr_hide:'Ascundeți',
      thanks:'Mulțumim!', contact_ok:'Vă vom contacta în curând, ',
      error:'Ne pare rău, nu ne putem conecta la server.',
    },
    hr: {
      open:'Otvori chat', close:'Zatvori', online:'Online',
      quick_q:'Brza pitanja', placeholder:'Napišite poruku...',
      powered:'Ovo je AI prodavač\u00a0\u2014\u00a0', powered_link:'želite li i vi?',
      write:'Piši \u2192',
      cta_call_text:'Želite se osobno posavjetovati?', cta_call_btn:'📞 Nazovite',
      cta_cont_text:'Zainteresirani? Javit ćemo vam se!', cta_cont_label:'Ostavite kontakt',
      cta_more:'Saznajte više',
      gdpr_title:'📋 Uvjeti obrade osobnih podataka',
      form_title:'Ostavite kontakt', form_sub:'Javit ćemo vam se što je prije moguće.',
      name_label:'Ime *', name_ph:'Vaše ime',
      email_label:'Email *', email_ph:'vas@email.hr',
      phone_label:'Telefon', phone_ph:'+385 00 000 0000',
      gdpr_full:'Pročitao/la sam uvjete obrade osobnih podataka i suglasan/na sam.*',
      gdpr_simple:'Suglasan/na sam s obradom osobnih podataka u svrhu kontakta.*',
      cancel:'Odustani', send:'Pošalji',
      gdpr_note:'Vaše osobne podatke obrađujemo u skladu s GDPR-om.',
      gdpr_show:'Prikaži detalje', gdpr_hide:'Sakrij',
      thanks:'Hvala!', contact_ok:'Javit ćemo vam se uskoro, ',
      error:'Žao nam je, nije moguće spojiti se na poslužitelj.',
    },
  };

  function wt(key) {
    const lang = getLang();
    return (WIDGET_I18N[lang] || {})[key] || WIDGET_I18N.sk[key] || key;
  }

  /* ── Styles ─────────────────────────────────────────────────── */
  const CSS = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }

    #nd-launcher {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483000;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 16px rgba(0,0,0,0.22);
      transition: transform 0.2s, box-shadow 0.2s;
      outline: none;
    }
    #nd-launcher:hover { transform: scale(1.08); box-shadow: 0 6px 20px rgba(0,0,0,0.28); }
    #nd-launcher svg { width: 26px; height: 26px; fill: white; transition: opacity 0.2s; }

    /* Proactive bubble */
    #nd-proactive-bubble {
      position: fixed;
      bottom: 90px;
      right: 24px;
      z-index: 2147483000;
      max-width: 260px;
      background: white;
      border-radius: 14px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.16);
      padding: 0.75rem 1rem;
      font-size: 0.875rem;
      color: #1e293b;
      line-height: 1.5;
      cursor: pointer;
      animation: ndBubbleIn 0.35s cubic-bezier(0.34,1.56,0.64,1);
      border: 1px solid #e2e8f0;
    }
    #nd-proactive-bubble::after {
      content: '';
      position: absolute;
      bottom: -8px;
      right: 20px;
      width: 14px;
      height: 14px;
      background: white;
      border-right: 1px solid #e2e8f0;
      border-bottom: 1px solid #e2e8f0;
      transform: rotate(45deg);
    }
    #nd-proactive-close {
      position: absolute;
      top: 6px; right: 8px;
      background: none; border: none; cursor: pointer;
      color: #94a3b8; font-size: 1rem; line-height: 1; padding: 2px 4px;
      border-radius: 4px;
    }
    #nd-proactive-close:hover { color: #64748b; }
    @keyframes ndBubbleIn {
      from { opacity: 0; transform: translateY(16px) scale(0.9); }
      to   { opacity: 1; transform: none; }
    }

    #nd-window {
      position: fixed;
      bottom: 92px;
      right: 24px;
      z-index: 2147483000;
      width: 380px;
      max-height: 600px;
      background: white;
      border-radius: 16px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.18);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transition: opacity 0.22s, transform 0.22s;
    }
    #nd-window.nd-hidden { opacity: 0; pointer-events: none; transform: translateY(12px) scale(0.97); }

    /* Header */
    #nd-header {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      padding: 0.9rem 1rem;
      flex-shrink: 0;
    }
    #nd-avatar {
      width: 36px; height: 36px;
      border-radius: 50%;
      background: rgba(255,255,255,0.25);
      display: flex; align-items: center; justify-content: center;
      font-size: 1.1rem;
      flex-shrink: 0;
      overflow: hidden;
    }
    #nd-avatar img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
    #nd-header-info { flex: 1; }
    #nd-bot-name { font-size: 0.95rem; font-weight: 700; color: white; }
    #nd-status { font-size: 0.75rem; color: rgba(255,255,255,0.8); display: flex; align-items: center; gap: 0.3rem; }
    #nd-status-dot { width: 7px; height: 7px; background: #4ade80; border-radius: 50%; }
    #nd-close {
      background: none; border: none; color: rgba(255,255,255,0.8);
      cursor: pointer; font-size: 1.3rem; line-height: 1; padding: 0.2rem;
      border-radius: 6px; transition: background 0.15s;
    }
    #nd-close:hover { background: rgba(255,255,255,0.15); color: white; }

    /* Messages */
    #nd-messages {
      flex: 1;
      overflow-y: auto;
      padding: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
      scroll-behavior: smooth;
      background: #f8fafc;
    }
    #nd-messages::-webkit-scrollbar { width: 4px; }
    #nd-messages::-webkit-scrollbar-track { background: transparent; }
    #nd-messages::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 2px; }

    .nd-msg {
      max-width: 85%;
      padding: 0.6rem 0.85rem;
      border-radius: 12px;
      font-size: 0.875rem;
      line-height: 1.55;
      word-wrap: break-word;
      animation: ndFadeIn 0.18s ease;
    }
    @keyframes ndFadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    .nd-msg-bot { background: white; color: #1e293b; align-self: flex-start; border: 1px solid #e2e8f0; border-bottom-left-radius: 4px; }
    .nd-msg-user { color: white; align-self: flex-end; border-bottom-right-radius: 4px; }
    .nd-msg-bot.nd-typing { color: #94a3b8; font-style: italic; }
    .nd-link { color: var(--nd-primary); text-decoration: underline; word-break: break-all; }
    .nd-link:hover { opacity: 0.8; }
    .nd-link-btn {
      display: inline-block; margin: 0.35rem 0;
      padding: 0.4rem 1rem; border-radius: 20px;
      background: var(--nd-primary); color: white !important;
      text-decoration: none !important; font-size: 0.8rem; font-weight: 600;
      word-break: break-all;
    }
    .nd-link-btn:hover { opacity: 0.85; }

    /* Suggested questions */
    #nd-suggestions {
      padding: 0.5rem 1rem 0.75rem;
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      background: #f8fafc;
    }
    #nd-suggestions-label { font-size: 0.72rem; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.1rem; }
    .nd-chip {
      background: white;
      border: 1.5px solid #e2e8f0;
      border-radius: 20px;
      padding: 0.42rem 0.85rem;
      font-size: 0.82rem;
      color: #374151;
      cursor: pointer;
      text-align: left;
      transition: border-color 0.15s, background 0.15s;
      font-family: inherit;
    }
    .nd-chip:hover { border-color: var(--nd-primary); background: #eff6ff; color: var(--nd-primary); }

    /* CTA Banner */
    #nd-cta {
      margin: 0 0.75rem 0.75rem;
      padding: 0.7rem 0.9rem;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      font-size: 0.82rem;
      display: none;
    }
    #nd-cta-text { flex: 1; color: #374151; }
    #nd-cta-btn {
      padding: 0.45rem 1rem;
      border: none;
      border-radius: 8px;
      font-size: 0.82rem;
      font-weight: 700;
      cursor: pointer;
      color: white;
      white-space: nowrap;
      flex-shrink: 0;
      font-family: inherit;
    }

    /* Input area */
    #nd-input-area {
      display: flex;
      align-items: flex-end;
      gap: 0.5rem;
      padding: 0.75rem;
      border-top: 1px solid #e2e8f0;
      background: white;
      flex-shrink: 0;
    }
    #nd-input {
      flex: 1;
      border: 1.5px solid #e2e8f0;
      border-radius: 22px;
      padding: 0.55rem 1rem;
      font-size: 0.875rem;
      outline: none;
      resize: none;
      max-height: 120px;
      overflow-y: auto;
      font-family: inherit;
      color: #1e293b;
      line-height: 1.5;
      transition: border-color 0.2s;
    }
    #nd-input:focus { border-color: var(--nd-primary); }
    #nd-input::placeholder { color: #94a3b8; }
    #nd-send {
      width: 38px; height: 38px;
      border-radius: 50%;
      border: none;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer;
      flex-shrink: 0;
      transition: opacity 0.2s, transform 0.15s;
    }
    #nd-send:hover { transform: scale(1.08); }
    #nd-send:disabled { opacity: 0.45; cursor: not-allowed; transform: none; }
    #nd-send svg { width: 18px; height: 18px; fill: white; }

    /* Contact form overlay */
    #nd-contact-overlay {
      position: absolute;
      inset: 0;
      background: white;
      z-index: 10;
      display: flex;
      flex-direction: column;
      padding: 1.25rem;
      display: none;
    }
    #nd-contact-overlay h3 { font-size: 1rem; font-weight: 700; color: #1e293b; margin-bottom: 0.25rem; }
    #nd-contact-overlay p { font-size: 0.82rem; color: #64748b; margin-bottom: 1.25rem; }
    .nd-field { margin-bottom: 0.75rem; }
    .nd-field label { display: block; font-size: 0.78rem; font-weight: 600; color: #374151; margin-bottom: 0.3rem; }
    .nd-field input {
      width: 100%; padding: 0.55rem 0.8rem;
      border: 1.5px solid #d1d5db; border-radius: 8px;
      font-size: 0.875rem; outline: none; font-family: inherit;
    }
    .nd-field input:focus { border-color: var(--nd-primary); }
    .nd-contact-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
    .nd-btn-full {
      flex: 1; padding: 0.6rem; border: none; border-radius: 8px;
      font-size: 0.875rem; font-weight: 600; cursor: pointer; font-family: inherit;
    }
    .nd-btn-cancel { background: #f1f5f9; color: #374151; }
    .nd-btn-submit { color: white; }
    .nd-success-msg { text-align: center; padding: 2rem 1rem; }
    .nd-gdpr-details { margin: 0.5rem 0; font-size: 0.78rem; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
    .nd-gdpr-details summary { padding: 0.5rem 0.75rem; cursor: pointer; font-weight: 600; color: #475569; background: #f8fafc; list-style: none; display: flex; align-items: center; gap: 0.4rem; }
    .nd-gdpr-details summary::-webkit-details-marker { display: none; }
    .nd-gdpr-details[open] summary { border-bottom: 1px solid #e2e8f0; }
    .nd-gdpr-content { padding: 0.75rem; color: #475569; line-height: 1.65; max-height: 160px; overflow-y: auto; white-space: pre-wrap; font-size: 0.77rem; }
    .nd-success-msg .nd-check { font-size: 2.5rem; margin-bottom: 0.75rem; }
    .nd-success-msg h3 { font-size: 1rem; font-weight: 700; color: #15803d; margin-bottom: 0.4rem; }
    .nd-success-msg p { font-size: 0.82rem; color: #64748b; }

    @media (max-width: 420px) {
      #nd-window { right: 10px; bottom: 80px; width: calc(100vw - 20px); max-height: 70vh; }
      #nd-launcher { right: 12px; bottom: 12px; }
      #nd-proactive-bubble { right: 10px; max-width: calc(100vw - 80px); }
    }
  `;

  /* ── Icons ──────────────────────────────────────────────────── */
  const ICON_CHAT = `<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>`;
  const ICON_CLOSE = `<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
  const ICON_SEND = `<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`;

  /* ── State ──────────────────────────────────────────────────── */
  let config = null;
  let isOpen = false;
  let isTyping = false;
  let sessionId = null;
  let history = [];          // [{role, content}, ...]
  let ctaShown = false;
  let msgCount = 0;
  let proactiveDismissed = false;

  /* ── Shadow DOM setup ───────────────────────────────────────── */
  const host = document.createElement('div');
  host.id = 'nd-host';
  const shadow = host.attachShadow({ mode: 'open' });

  const styleEl = document.createElement('style');
  shadow.appendChild(styleEl);

  /* ── Build DOM ──────────────────────────────────────────────── */
  function buildDOM() {
    const primary = config.primary_color || '#2563eb';

    shadow.host.style.setProperty('--nd-primary', primary);
    styleEl.textContent = CSS.replace(/var\(--nd-primary\)/g, primary);

    shadow.innerHTML = '';
    shadow.appendChild(styleEl);

    // Launcher button
    const launcher = elem('button', { id: 'nd-launcher', title: wt('open'), style: `background:${primary}` },
      ICON_CHAT
    );
    launcher.addEventListener('click', toggleChat);
    shadow.appendChild(launcher);

    // Chat window
    const win = elem('div', { id: 'nd-window', class: 'nd-hidden' }, `
      <div id="nd-header" style="background:${primary}">
        <div id="nd-avatar">${config.avatar_url ? `<img src="${config.avatar_url}" alt="">` : '🤖'}</div>
        <div id="nd-header-info">
          <div id="nd-bot-name">${esc(config.bot_name)}</div>
          <div id="nd-status"><span id="nd-status-dot"></span> ${wt('online')}</div>
        </div>
        <button id="nd-close" title="${wt('close')}">${ICON_CLOSE}</button>
      </div>
      <div id="nd-messages"></div>
      <div id="nd-suggestions" style="display:none">
        <div id="nd-suggestions-label">${wt('quick_q')}</div>
      </div>
      <div id="nd-cta" style="background:#f0fdf4;border:1px solid #bbf7d0;display:none">
        <span id="nd-cta-text"></span>
        <button id="nd-cta-btn" style="background:${primary}"></button>
      </div>
      <div id="nd-input-area">
        <textarea id="nd-input" rows="1" placeholder="${wt('placeholder')}"></textarea>
        <button id="nd-send" style="background:${primary}">${ICON_SEND}</button>
      </div>
      <div id="nd-powered" style="text-align:center;padding:0.35rem 0.5rem;font-size:0.7rem;color:#94a3b8;background:white;border-top:1px solid #f1f5f9;flex-shrink:0;">
        ${wt('powered')}<a href="https://NeuraDesk.online" target="_blank" rel="noopener" style="color:#94a3b8;text-decoration:underline;">${wt('powered_link')}</a>
      </div>
      <div id="nd-contact-overlay"></div>
    `);
    shadow.appendChild(win);

    // Wire events
    shadow.getElementById('nd-close').addEventListener('click', toggleChat);
    shadow.getElementById('nd-send').addEventListener('click', handleSend);
    shadow.getElementById('nd-input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });
    shadow.getElementById('nd-input').addEventListener('input', autoResize);

    // Add welcome message (multilingual if configured)
    const _welcomeMsg = getWelcomeMessage(config.welcome_message);
    if (_welcomeMsg) addBotMessage(_welcomeMsg);

    // Render suggested questions
    renderSuggestions();

    // Proactive bubble
    if (config.proactive_enabled && config.proactive_message) {
      const delay = (config.proactive_delay || 4) * 1000;
      setTimeout(() => {
        if (isOpen || proactiveDismissed) return;
        showProactiveBubble(config.proactive_message);
      }, delay);
    }
  }

  /* ── Proactive Bubble ───────────────────────────────────────── */
  function showProactiveBubble(message) {
    if (shadow.getElementById('nd-proactive-bubble')) return; // already shown

    const primary = config.primary_color || '#2563eb';
    const bubble = elem('div', { id: 'nd-proactive-bubble' });
    bubble.innerHTML = `
      <button id="nd-proactive-close" title="${wt('close')}">✕</button>
      <div style="padding-right:1rem">${esc(message)}</div>
      <div style="margin-top:0.4rem;font-size:0.78rem;font-weight:600;color:${primary}">${wt('write')}</div>
    `;

    shadow.appendChild(bubble);

    bubble.addEventListener('click', (e) => {
      if (e.target.id === 'nd-proactive-close') {
        dismissBubble();
        return;
      }
      dismissBubble();
      if (!isOpen) toggleChat();
    });

    shadow.getElementById('nd-proactive-close').addEventListener('click', (e) => {
      e.stopPropagation();
      dismissBubble();
    });
  }

  function dismissBubble() {
    proactiveDismissed = true;
    const b = shadow.getElementById('nd-proactive-bubble');
    if (b) {
      b.style.opacity = '0';
      b.style.transform = 'translateY(8px)';
      b.style.transition = 'opacity 0.2s, transform 0.2s';
      setTimeout(() => b.remove(), 220);
    }
  }

  /* ── Toggle ─────────────────────────────────────────────────── */
  function toggleChat() {
    isOpen = !isOpen;
    dismissBubble();
    const win = shadow.getElementById('nd-window');
    const launcher = shadow.getElementById('nd-launcher');
    win.classList.toggle('nd-hidden', !isOpen);
    launcher.innerHTML = isOpen ? ICON_CLOSE : ICON_CHAT;
    if (isOpen) {
      shadow.getElementById('nd-input').focus();
      scrollToBottom();
    }
  }

  /* ── Suggestions ────────────────────────────────────────────── */
  function renderSuggestions() {
    const container = shadow.getElementById('nd-suggestions');
    const qs = config.suggested_questions || [];
    if (!qs.length) return;

    qs.forEach(q => {
      const chip = elem('button', { class: 'nd-chip' }, esc(q));
      chip.addEventListener('click', () => {
        hideSuggestions();
        sendMessage(q);
      });
      container.appendChild(chip);
    });
    container.style.display = '';
  }

  function hideSuggestions() {
    const s = shadow.getElementById('nd-suggestions');
    if (s) s.style.display = 'none';
  }

  /* ── Markdown renderer (bold, italic, newlines only) ────────── */
  function renderMarkdown(text) {
    // Match [label](url) and bare https?:// URLs, trim trailing punctuation from bare URLs
    const URL_RE = /(\[([^\]]{1,200})\]\((https?:\/\/[^\s)]{1,500})\))|(https?:\/\/[^\s<>"]{1,500})/g;
    let html = '';
    let last = 0;
    let m;

    while ((m = URL_RE.exec(text)) !== null) {
      // Escape plain text before this match
      html += escInline(text.slice(last, m.index));

      if (m[1]) {
        // Markdown link: [label](url)
        html += `<a href="${escAttr(m[3])}" target="_blank" rel="noopener noreferrer" class="nd-link">${esc(m[2])}</a>`;
      } else {
        // Bare URL — strip trailing punctuation (.,!?) that AI often appends
        let url = m[0].replace(/[.,!?:)\]]+$/, '');
        const trailingPunct = m[0].slice(url.length);

        // Button style if URL is on its own line
        const before = text.slice(0, m.index);
        const after  = text.slice(m.index + url.length);
        const alone  = /(\n|^)\s*$/.test(before) && /^\s*(\n|$)/.test(after);

        const cls = alone ? 'nd-link-btn' : 'nd-link';
        html += `<a href="${escAttr(url)}" target="_blank" rel="noopener noreferrer" class="${cls}">${esc(url)}</a>`;
        if (trailingPunct) html += escInline(trailingPunct);
      }
      last = m.index + m[0].length;
    }

    html += escInline(text.slice(last));

    return html
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');
  }

  function escInline(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  /* ── Messages ───────────────────────────────────────────────── */
  function addBotMessage(text, isStreaming = false) {
    const msgs = shadow.getElementById('nd-messages');
    const div = elem('div', { class: `nd-msg nd-msg-bot${isStreaming ? ' nd-typing' : ''}` });
    if (isStreaming) {
      div.textContent = text;
    } else {
      div.innerHTML = renderMarkdown(text);
    }
    msgs.appendChild(div);
    scrollToBottom();
    return div;
  }

  function addUserMessage(text) {
    const msgs = shadow.getElementById('nd-messages');
    const primary = config.primary_color || '#2563eb';
    const div = elem('div', { class: 'nd-msg nd-msg-user', style: `background:${primary}` });
    div.textContent = text;
    msgs.appendChild(div);
    scrollToBottom();
  }

  function scrollToBottom() {
    const msgs = shadow.getElementById('nd-messages');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
  }

  /* ── Send ───────────────────────────────────────────────────── */
  function handleSend() {
    const input = shadow.getElementById('nd-input');
    const text = input.value.trim();
    if (!text || isTyping) return;
    input.value = '';
    input.style.height = '';
    sendMessage(text);
  }

  async function sendMessage(text) {
    if (isTyping) return;
    hideSuggestions();
    isTyping = true;
    msgCount++;

    // Add user message to UI and history
    addUserMessage(text);
    history.push({ role: 'user', content: text });

    setSendDisabled(true);

    // Show typing indicator
    const typingEl = addBotMessage('…', true);

    try {
      const payload = {
        message: text,
        sessionId,
        history: history.slice(-20).slice(0, -1), // all but current message
        pageContext: { url: window.location.href, title: document.title },
      };

      const response = await fetch(`${BASE_URL}/api/widget/${WIDGET_ID}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        typingEl.textContent = wt('error');
        typingEl.classList.remove('nd-typing');
        isTyping = false;
        setSendDisabled(false);
        return;
      }

      // Stream SSE response
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let buffer = '';
      let first = true;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;

          try {
            const parsed = JSON.parse(raw);
            if (parsed.error) {
              typingEl.textContent = parsed.error;
              typingEl.classList.remove('nd-typing');
            } else if (parsed.done) {
              // Stream finished — render markdown on final text
              const final = parsed.fullText || fullText;
              typingEl.innerHTML = renderMarkdown(final);
              history.push({ role: 'assistant', content: final });
              maybeShowCta();
            } else if (parsed.text) {
              if (first) {
                typingEl.textContent = '';
                typingEl.classList.remove('nd-typing');
                first = false;
              }
              fullText += parsed.text;
              typingEl.textContent = fullText;
              scrollToBottom();
            }
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (err) {
      typingEl.textContent = wt('error');
      typingEl.classList.remove('nd-typing');
    }

    isTyping = false;
    setSendDisabled(false);
    shadow.getElementById('nd-input').focus();
  }

  /* ── CTA ────────────────────────────────────────────────────── */
  function maybeShowCta() {
    if (ctaShown || msgCount < 2) return;
    if (!config.cta_type || config.cta_type === 'none') return;

    ctaShown = true;
    const primary = config.primary_color || '#2563eb';
    const ctaEl = shadow.getElementById('nd-cta');
    const textEl = shadow.getElementById('nd-cta-text');
    const btnEl = shadow.getElementById('nd-cta-btn');

    switch (config.cta_type) {
      case 'call': {
        const phone = (config.cta_config || {}).phone || '';
        textEl.textContent = wt('cta_call_text');
        btnEl.textContent = wt('cta_call_btn');
        btnEl.addEventListener('click', () => { window.open(`tel:${phone}`, '_self'); });
        ctaEl.style.display = 'flex';
        break;
      }
      case 'contact': {
        const label = (config.cta_config || {}).label || wt('cta_cont_label');
        textEl.textContent = wt('cta_cont_text');
        btnEl.textContent = '✉️ ' + label;
        btnEl.addEventListener('click', showContactForm);
        ctaEl.style.display = 'flex';
        break;
      }
      case 'custom': {
        const cfg2       = config.cta_config || {};
        const customText = cfg2.text || '';
        if (!customText) return;
        textEl.textContent = customText;
        const customLink  = cfg2.customLink || '';
        const customLabel = cfg2.customBtnLabel || wt('cta_more');
        if (customLink) {
          btnEl.textContent = '→ ' + customLabel;
          btnEl.addEventListener('click', () => { window.open(customLink, '_blank', 'noopener'); });
          btnEl.style.display = '';
        } else {
          btnEl.style.display = 'none';
        }
        ctaEl.style.display = 'flex';
        break;
      }
    }
  }

  /* ── Contact Form ───────────────────────────────────────────── */
  function showContactForm() {
    const primary = config.primary_color || '#2563eb';
    const overlay = shadow.getElementById('nd-contact-overlay');
    const gdprText = config.gdpr_text || '';
    const gdprBlock = gdprText ? `
      <details class="nd-gdpr-details">
        <summary>${wt('gdpr_title')}</summary>
        <div class="nd-gdpr-content">${esc(gdprText)}</div>
      </details>` : '';
    overlay.innerHTML = `
      <h3>${wt('form_title')}</h3>
      <p>${wt('form_sub')}</p>
      <div class="nd-field"><label>${wt('name_label')}</label><input type="text" id="nd-cf-name" placeholder="${wt('name_ph')}" required></div>
      <div class="nd-field"><label>${wt('email_label')}</label><input type="email" id="nd-cf-email" placeholder="${wt('email_ph')}" required></div>
      <div class="nd-field"><label>${wt('phone_label')}</label><input type="tel" id="nd-cf-phone" placeholder="${wt('phone_ph')}"></div>
      ${gdprBlock}
      <div class="nd-field nd-gdpr-row">
        <label style="display:flex;align-items:flex-start;gap:0.5rem;font-size:0.78rem;font-weight:400;color:#374151;cursor:pointer">
          <input type="checkbox" id="nd-cf-gdpr" style="margin-top:2px;width:14px;height:14px;flex-shrink:0" required>
          <span>${gdprText ? wt('gdpr_full') : wt('gdpr_simple')}</span>
        </label>
      </div>
      <div class="nd-contact-actions">
        <button class="nd-btn-full nd-btn-cancel" id="nd-cf-cancel">${wt('cancel')}</button>
        <button class="nd-btn-full nd-btn-submit" id="nd-cf-submit" style="background:${primary}">${wt('send')}</button>
      </div>
    `;
    overlay.style.display = 'flex';
    overlay.style.flexDirection = 'column';
    shadow.getElementById('nd-cf-cancel').addEventListener('click', () => { overlay.style.display = 'none'; });
    shadow.getElementById('nd-cf-submit').addEventListener('click', submitContactForm);
  }

  function submitContactForm() {
    const nameEl = shadow.getElementById('nd-cf-name');
    const emailEl = shadow.getElementById('nd-cf-email');
    const phoneEl = shadow.getElementById('nd-cf-phone');
    const gdprEl = shadow.getElementById('nd-cf-gdpr');
    const name = nameEl?.value.trim();
    const email = emailEl?.value.trim();
    const phone = phoneEl?.value.trim();
    const gdprConsent = gdprEl?.checked;

    if (!name || !email) {
      if (!name && nameEl) nameEl.style.borderColor = '#dc2626';
      if (!email && emailEl) emailEl.style.borderColor = '#dc2626';
      return;
    }
    if (!gdprConsent) {
      if (gdprEl) gdprEl.style.outline = '2px solid #dc2626';
      return;
    }

    const overlay = shadow.getElementById('nd-contact-overlay');
    const gdprNote = config.gdpr_text
      ? `<p class="nd-gdpr-note">${wt('gdpr_note')} <span id="nd-gdpr-toggle" style="color:var(--nd-primary);cursor:pointer;text-decoration:underline">${wt('gdpr_show')}</span></p>
         <div id="nd-gdpr-after" style="display:none;font-size:0.75rem;color:#64748b;line-height:1.6;max-height:120px;overflow-y:auto;white-space:pre-wrap;margin-top:0.5rem;padding:0.5rem;background:#f8fafc;border-radius:6px;border:1px solid #e2e8f0">${esc(config.gdpr_text)}</div>`
      : '';
    overlay.innerHTML = `
      <div class="nd-success-msg">
        <div class="nd-check">✅</div>
        <h3>${wt('thanks')}</h3>
        <p>${wt('contact_ok')}${esc(name)}.</p>
        ${gdprNote}
      </div>
    `;
    if (config.gdpr_text) {
      const toggle = overlay.querySelector('#nd-gdpr-toggle');
      const detail = overlay.querySelector('#nd-gdpr-after');
      if (toggle && detail) {
        toggle.addEventListener('click', () => {
          detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
          toggle.textContent = detail.style.display === 'none' ? wt('gdpr_show') : wt('gdpr_hide');
        });
      }
    }
    setTimeout(() => { overlay.style.display = 'none'; }, 3000);

    // Save lead to backend (fire and forget)
    fetch(`${BASE_URL}/api/widget/${WIDGET_ID}/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, phone: phone || undefined, sessionId, gdprConsent: true })
    }).catch(() => { /* ignore network errors */ });
  }

  /* ── Welcome message (multilingual JSON or plain text) ──────── */
  function getWelcomeMessage(raw) {
    if (!raw || !raw.startsWith('{')) return raw || '';
    try {
      const obj = JSON.parse(raw);
      const lang = getLang();
      return obj[lang] || obj['default'] || obj['en'] || obj['sk'] || '';
    } catch { return raw; }
  }

  /* ── Helpers ────────────────────────────────────────────────── */
  function setSendDisabled(disabled) {
    const btn = shadow.getElementById('nd-send');
    if (btn) btn.disabled = disabled;
  }

  function autoResize() {
    const ta = shadow.getElementById('nd-input');
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  }

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function elem(tag, attrs = {}, innerHTML = '') {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else el.setAttribute(k, v);
    }
    if (innerHTML) el.innerHTML = innerHTML;
    return el;
  }

  /* ── Session ID ─────────────────────────────────────────────── */
  function getSessionId() {
    const key = `nd_session_${WIDGET_ID}`;
    let sid = sessionStorage.getItem(key);
    if (!sid) {
      sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem(key, sid);
    }
    return sid;
  }

  /* ── Bootstrap ──────────────────────────────────────────────── */
  async function init() {
    try {
      const res = await fetch(`${BASE_URL}/api/widget/${WIDGET_ID}/config`);
      if (!res.ok) { console.warn('[NeuraDeskApp] Widget nenájdený alebo neaktívny.'); return; }
      config = await res.json();
    } catch (err) {
      console.warn('[NeuraDeskApp] Nepodarilo sa načítať konfiguráciu:', err.message);
      return;
    }

    sessionId = getSessionId();
    document.body.appendChild(host);
    buildDOM();
  }

  // Wait for DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
