'use strict';
const fs = require('fs');
const path = require('path');

const skPath = path.join(__dirname, '..', 'public', 'locales', 'sk.json');
const sk = JSON.parse(fs.readFileSync(skPath, 'utf8'));

const newKeys = {
  // SEO Audit — navigácia & header
  '🚀 SEO Audit': '🚀 SEO Audit',
  'SEO Audit': 'SEO Audit',
  'Naskenujte web, odhaľte SEO problémy a stiahnite hotové opravy.': 'Naskenujte web, odhaľte SEO problémy a stiahnite hotové opravy.',
  '+ Nový sken': '+ Nový sken',
  'Zatiaľ žiadny audit': 'Zatiaľ žiadny audit',
  'Kliknite "+ Nový sken" a zadajte URL vášho webu.': 'Kliknite "+ Nový sken" a zadajte URL vášho webu.',
  'SEO skóre': 'SEO skóre',
  'Dokončené:': 'Dokončené:',

  // SEO Audit — výsledky
  '🔍 Nový SEO sken': '🔍 Nový SEO sken',
  '🌐 Problémy celého webu': '🌐 Problémy celého webu',
  '✓ Žiadne problémy': '✓ Žiadne problémy',
  '⏳ SEO analýza prebieha… Táto stránka sa automaticky obnoví.': '⏳ SEO analýza prebieha… Táto stránka sa automaticky obnoví.',
  'Odomknite plný audit vrátane AI opráv': 'Odomknite plný audit vrátane AI opráv',

  // SEO Audit — Domain metrics
  '📊 Autorita domény (DataForSEO)': '📊 Autorita domény (DataForSEO)',
  'Domain Rank': 'Domain Rank',
  'Backlinky': 'Backlinky',
  'Odkazujúce domény': 'Odkazujúce domény',
  'Nefunkčné backlinky': 'Nefunkčné backlinky',

  // SEO Audit — download tlačidlá
  '⬇ WordPress Plugin': '⬇ WordPress Plugin',
  '⬇ HTML Snippet': '⬇ HTML Snippet',
  '⬇ Schema.org JSON-LD': '⬇ Schema.org JSON-LD',
  '⬇ llms.txt': '⬇ llms.txt',

  // Growth Boost — onboarding krok 5
  'Growth Boost': 'Growth Boost',
  'Krok 5 z 5': 'Krok 5 z 5',
  '🔍 SEO sken vášho webu': '🔍 SEO sken vášho webu',
  'Náš AI skener analyzuje váš web, odhalí SEO chyby a pripraví hotové opravy pre WordPress aj HTML weby.': 'Náš AI skener analyzuje váš web, odhalí SEO chyby a pripraví hotové opravy pre WordPress aj HTML weby.',
  'URL webu': 'URL webu',
  'Spustiť sken': 'Spustiť sken',
  '📊 Výsledky skenu': '📊 Výsledky skenu',
  'Growth Boost – Kompletná SEO oprava': 'Growth Boost – Kompletná SEO oprava',
  'Jednorazová platba · Okamžité stiahnutie hotových opráv': 'Jednorazová platba · Okamžité stiahnutie hotových opráv',
  'Bezpečná platba cez Stripe · Jednorazová platba': 'Bezpečná platba cez Stripe · Jednorazová platba',
  '🚀 Zvýšte návštevnosť webu': '🚀 Zvýšte návštevnosť webu',
  'Zadajte adresu webu – okamžite uvidíte prvé problémy zadarmo.': 'Zadajte adresu webu – okamžite uvidíte prvé problémy zadarmo.',
  '✅ Kompletný audit až 8 podstránok': '✅ Kompletný audit až 8 podstránok',
  '✅ AI optimalizovaný title & description pre každú stránku': '✅ AI optimalizovaný title & description pre každú stránku',
  '✅ Hotový WordPress plugin (.php) – 1 klik inštalácia': '✅ Hotový WordPress plugin (.php) – 1 klik inštalácia',
  '✅ HTML snippet pre statické weby – vložte do </head>': '✅ HTML snippet pre statické weby – vložte do </head>',
  '✅ Opravy canonical, OG tagov, viewport, alt textov': '✅ Opravy canonical, OG tagov, viewport, alt textov',
  '💳 Získať Growth Boost – €49': '💳 Získať Growth Boost – €49',
  'Preskočiť a otvoriť dashboard →': 'Preskočiť a otvoriť dashboard →',

  // Growth Boost — Boost token systém
  'Boost token zakúpený!': 'Boost token zakúpený!',
  'Boost tokeny sú odlišné od AI kreditov chatbota — slúžia výhradne na odomykanie SEO auditov.': 'Boost tokeny sú odlišné od AI kreditov chatbota — slúžia výhradne na odomykanie SEO auditov.',
  '⚡ Growth Boost – Kompletná SEO oprava za €49': '⚡ Growth Boost – Kompletná SEO oprava za €49',
  'Jednorazová platba. Odomkne hotové AI opravy pre váš web:': 'Jednorazová platba. Odomkne hotové AI opravy pre váš web:',
  '1 Boost token = 1 odomknutý audit. Kupujte keď aktualizujete web alebo skenujete ďalší web.': '1 Boost token = 1 odomknutý audit. Kupujte keď aktualizujete web alebo skenujete ďalší web.',
  'Boost tokeny nesúvisia s AI kreditmi chatbota.': 'Boost tokeny nesúvisia s AI kreditmi chatbota.',
  '💳 Kúpiť Boost token – €49': '💳 Kúpiť Boost token – €49',
  '🔓 Odomknúť tento audit (1 token)': '🔓 Odomknúť tento audit (1 token)',
  '+ Kúpiť ďalší token – €49': '+ Kúpiť ďalší token – €49',
  '1 token = 1 odomknutý audit. Nesúvisí s AI kreditmi chatbota.': '1 token = 1 odomknutý audit. Nesúvisí s AI kreditmi chatbota.',
  'Spustite audit a kliknite "Odomknúť" pre plné výsledky + hotové opravy (WordPress, HTML, Schema.org, llms.txt).': 'Spustite audit a kliknite "Odomknúť" pre plné výsledky + hotové opravy (WordPress, HTML, Schema.org, llms.txt).',
  'WordPress plugin — automaticky opraví meta tagy na celom webe': 'WordPress plugin — automaticky opraví meta tagy na celom webe',
  'HTML snippet — pre Webflow, Squarespace a vlastné weby': 'HTML snippet — pre Webflow, Squarespace a vlastné weby',
  'Schema.org JSON-LD — AI vás správne opíše v Google a ChatGPT': 'Schema.org JSON-LD — AI vás správne opíše v Google a ChatGPT',
  'llms.txt — nový štandard pre AI asistentov (Claude, Perplexity...)': 'llms.txt — nový štandard pre AI asistentov (Claude, Perplexity...)',

  // Nastavenia účtu
  '⚙️ Účet': '⚙️ Účet',
  'Nastavenia účtu': 'Nastavenia účtu',
  'Zmena hesla': 'Zmena hesla',
  'Zmeniť heslo': 'Zmeniť heslo',
  'Aktuálne heslo': 'Aktuálne heslo',
  'Nové heslo': 'Nové heslo',
  'Potvrdiť nové heslo': 'Potvrdiť nové heslo',
  'Zmena emailu': 'Zmena emailu',
  'Zmeniť email': 'Zmeniť email',
  'Nový email': 'Nový email',
  'Potvrdiť heslom': 'Potvrdiť heslom',
  'Heslo bolo úspešne zmenené.': 'Heslo bolo úspešne zmenené.',
  'Email bol úspešne zmenený.': 'Email bol úspešne zmenený.',

  // Toast správy — SEO
  'SEO analýza spustená!': 'SEO analýza spustená!',
  'Audit odomknutý! Načítavam plné výsledky...': 'Audit odomknutý! Načítavam plné výsledky...',
  'Growth Boost aktivovaný! Sťahujte opravy nižšie.': 'Growth Boost aktivovaný! Sťahujte opravy nižšie.',
  'Growth Boost bol úspešne aktivovaný! 🎉': 'Growth Boost bol úspešne aktivovaný! 🎉',
  'Chyba pri sťahovaní.': 'Chyba pri sťahovaní.',
  'Zadajte URL.': 'Zadajte URL.',

  // Toast správy — existujúce features
  'Uložené!': 'Uložené!',
  'Nastavenia uložené': 'Nastavenia uložené',
  'Integrácie uložené': 'Integrácie uložené',
  'Pracovné hodiny uložené!': 'Pracovné hodiny uložené!',
  'Dizajn uložený! Zmeny sa prejavia na rezervačnej stránke.': 'Dizajn uložený! Zmeny sa prejavia na rezervačnej stránke.',
  'Jazyková verzia pridaná!': 'Jazyková verzia pridaná!',
  'Lead magnet pridaný!': 'Lead magnet pridaný!',
  'Lead magnet zmazaný.': 'Lead magnet zmazaný.',
  'Súbor odstránený.': 'Súbor odstránený.',
  'Pozvánka odoslaná': 'Pozvánka odoslaná',
  'Člen odstránený': 'Člen odstránený',
  'Ecomail prepojený! Leady pôjdu automaticky do vášho zoznamu.': 'Ecomail prepojený! Leady pôjdu automaticky do vášho zoznamu.',
  'Ecomail odpojený.': 'Ecomail odpojený.',
  'Google Calendar úspešne prepojený!': 'Google Calendar úspešne prepojený!',
  'Google Calendar odpojený.': 'Google Calendar odpojený.',
  'Facebook Messenger pripojený': 'Facebook Messenger pripojený',
  'Facebook Messenger odpojený': 'Facebook Messenger odpojený',
  'WooCommerce odpojený': 'WooCommerce odpojený',
  'Follow-up email odoslaný': 'Follow-up email odoslaný',
  'Export zlyhal.': 'Export zlyhal.',
  'Odoslanie zlyhalo': 'Odoslanie zlyhalo',
  'Služba zmazaná.': 'Služba zmazaná.',
  'Výnimka pridaná.': 'Výnimka pridaná.',
  'Výnimka odstránená.': 'Výnimka odstránená.',
  '✅ Test lead odoslaný do Ecomailu! Skontrolujte váš zoznam.': '✅ Test lead odoslaný do Ecomailu! Skontrolujte váš zoznam.',
  '⬆️ White-label je dostupný iba v pláne White Label (€997/mes). Upgradujte v Stripe portáli.': '⬆️ White-label je dostupný iba v pláne White Label (€997/mes). Upgradujte v Stripe portáli.',

  // Chybové hlášky
  'Chyba.': 'Chyba.',
  'Chyba:': 'Chyba:',
  'Chyba siete.': 'Chyba siete.',
  'Chyba prekladu.': 'Chyba prekladu.',
  'Chyba prekladu otázok.': 'Chyba prekladu otázok.',
  'Chyba pri exporte.': 'Chyba pri exporte.',
  'Chyba pri ukladaní': 'Chyba pri ukladaní',
  'Chyba pri ukladaní dizajnu.': 'Chyba pri ukladaní dizajnu.',
  'Chyba pri načítaní trendov.': 'Chyba pri načítaní trendov.',
  'Chyba pri načítaní lead magnetov.': 'Chyba pri načítaní lead magnetov.',
  'Chyba pri pozvaní': 'Chyba pri pozvaní',
  'Chyba pri prepájaní Google Calendar.': 'Chyba pri prepájaní Google Calendar.',
  'Chyba pri otváraní konverzácie:': 'Chyba pri otváraní konverzácie:',
  'Chyba: widget neexistuje.': 'Chyba: widget neexistuje.',
  'Neočakávaná chyba:': 'Neočakávaná chyba:',
  'Nepodarilo sa načítať konverzáciu:': 'Nepodarilo sa načítať konverzáciu:',
  'Nepodarilo sa pripojiť': 'Nepodarilo sa pripojiť',

  // Validácia / pokyny
  'Zadajte URL adresu webu.': 'Zadajte URL adresu webu.',
  'Zadajte email': 'Zadajte email',
  'Zadajte názov.': 'Zadajte názov.',
  'Zadajte názov služby.': 'Zadajte názov služby.',
  'Zadajte nadpis aj obsah.': 'Zadajte nadpis aj obsah.',
  'Zadajte testovací email': 'Zadajte testovací email',
  'Zadajte Page Access Token': 'Zadajte Page Access Token',
  'Vyplňte všetky polia': 'Vyplňte všetky polia',
  'Vyplňte aspoň jeden text.': 'Vyplňte aspoň jeden text.',
  'Vyberte dátum.': 'Vyberte dátum.',
  'Napíšte správu': 'Napíšte správu',
  'Najprv nahrajte dokumenty.': 'Najprv nahrajte dokumenty.',
  'Najprv pridajte alebo vygenerujte otázky.': 'Najprv pridajte alebo vygenerujte otázky.',
  'Najprv vyberte widget.': 'Najprv vyberte widget.',
  'Najprv vyplňte predvolenú proaktívnu správu.': 'Najprv vyplňte predvolenú proaktívnu správu.',
  'Najprv vyplňte predvolenú uvítaciu správu.': 'Najprv vyplňte predvolenú uvítaciu správu.',
  'Zoznam otázok je plný (max 6). Najprv niektoré odstráňte.': 'Zoznam otázok je plný (max 6). Najprv niektoré odstráňte.',
  'Generujem otázky…': 'Generujem otázky…',
  'Kredity sa neobnovia mesačne – spotrebúvajú sa postupne': 'Kredity sa neobnovia mesačne – spotrebúvajú sa postupne',
};

let added = 0;
for (const [k, v] of Object.entries(newKeys)) {
  if (!sk[k]) {
    sk[k] = v;
    added++;
  }
}

fs.writeFileSync(skPath, JSON.stringify(sk, null, 2), 'utf8');
console.log(`✓ Pridaných ${added} nových kľúčov. Celkovo: ${Object.keys(sk).length} kľúčov.`);
