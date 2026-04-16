'use strict';
// Manual patch for English strings that the AI kept returning unchanged
// (brand slogans, objection-handling phrases, marketing copy)
// Run: node scripts/patch-en.js
// Re-runnable safely – already-correct keys are overwritten with same value

const fs   = require('fs');
const path = require('path');

const enFile = path.join(__dirname, '..', 'public', 'locales', 'en.json');
const en     = JSON.parse(fs.readFileSync(enFile, 'utf8'));
const done   = new Set(en.__done__ || []);

const patch = {
  'Nie chatbot. Vyškolený AI obchodník.':
    'Not a chatbot. A trained AI salesman.',

  'Vidím sa v tom ↓':
    'That\'s me ↓',

  'Námietky':
    'Objections',

  '– len tušíte, že konverzia je nízka.':
    '– you just sense that conversion is low.',

  'Veľké riešenia sú pre vás príliš drahé':
    'Large solutions are too expensive for you',

  'Čo keby mal váš web':
    'What if your website had',

  'čo nikdy nespí?':
    'that never sleeps?',

  '– a stálo to čas aj peniaze.':
    '– and it cost you time and money.',

  'Vy chcete výsledok zajtra, nie IT projekt.':
    'You want results tomorrow, not an IT project.',

  'Intercom, ManyChat, Salesforce – tisíce eur, mesiace nastavení.':
    'Intercom, ManyChat, Salesforce – thousands of euros, months of setup.',

  '„Aká je cena?" – desiaty krát dnes':
    '"What\'s the price?" – for the tenth time today',

  'Chatbot rieši „Aká je cena?" tisíckrát. Vy sa venujete práci s hodnotou.':
    'Chatbot handles "What\'s the price?" a thousand times. You focus on value work.',

  'AI karty leadov odhaľujú vzory – aké námietky sú najčastejšie, čo ich blokuje.':
    'AI lead cards reveal patterns – which objections are most common, what blocks them.',

  'AI pripravuje vášho predajcu…':
    'AI is preparing your salesman…',

  'Spracúva námietky automaticky':
    'Handles objections automatically',

  'typické námietky vášho odvetvia':
    'typical objections in your industry',

  'Opíšete váš produkt, cieľovku, námietky – AI si':
    'You describe your product, target audience, objections – AI',

  '– kladie otázky, identifikuje problém zákazníka, spracúva námietky a aktívne uzatvára predaj. Na webe aj v Instagram DMs.':
    '– asks questions, identifies the customer\'s problem, handles objections and actively closes the sale. On the web and in Instagram DMs.',

  'Neoworkly sa naučí váš produkt, vaše ceny, vaše námietky – a vedie každého návštevníka od prvej otázky po uzavretý predaj. Presne tak, ako by ste to robili vy, len':
    'Neoworkly will learn your product, your prices, your objections – and guide every visitor from the first question to a closed sale. Exactly as you would do it, but',

  'Napíšte čo predávate — za 10 sekúnd uvidíte, ako váš chatbot kladie otázky, rieši námietky a uzatvára predaj.':
    'Describe what you sell — in 10 seconds you\'ll see how your chatbot asks questions, handles objections and closes the sale.',

  'Je to skutočný predajný AI. Má zabudovaný 5-fázový framework (Discovery → Pain → Solution → Objections → Close), kladie otázky namiesto len odpovedania, identifikuje problém zákazníka a spracúva námietky. To je fundamentálny rozdiel oproti chatbotom, čo len hľadajú v FAQ.':
    'It\'s a real sales AI. It has a built-in 5-phase framework (Discovery → Pain → Solution → Objections → Close), asks questions instead of just answering, identifies the customer\'s problem and handles objections. That\'s a fundamental difference from chatbots that just search FAQs.',

  // ── Nav & section headings ────────────────────────────────────────────────
  'Funkcie':            'Features',
  'Leady':              'Leads',
  '📋 Leady':           '📋 Leads',
  'Cena':               'Price',
  '/mesiac':            '/month',
  'GDPR v cene':        'GDPR included',
  'Podmienky':          'Terms',
  'Kontakt':            'Contact',
  'Ako to funguje':     'How it works',
  'Ako to funguje?':    'How does it work?',
  'Zaregistrujte sa':   'Sign up',
  'Ako vyzerá váš biznis,': 'What does your business look like,',

  // ── Inline partial text nodes ─────────────────────────────────────────────
  'neviete':            'know',
  'alebo zabudol.':     'or forgot.',
  'AI reaguje na':      'AI responds to',
  'GDPR & Dokumenty':   'GDPR & Documents',
  '✓ Import z CSV':     '✓ CSV import',
  '✓ Shopify skenovanie': '✓ Shopify scanning',

  // ── Onboarding step 2 ────────────────────────────────────────────────────
  'Zadajte URL vášho webu – AI ho naskenuje automaticky. Alebo nahrajte PDF, texty, cenníky drag & drop. AI navrhne otázky ihneď po spracovaní.':
    'Enter your website URL – AI will scan it automatically. Or upload PDFs, texts, price lists via drag & drop. AI will suggest questions immediately after processing.',

  // ── Hardcoded partial text nodes split around <strong> tags ──────────────
  // The text walker finds the EXACT text node including leading punctuation.
  // Key must match orig.trim() — comma/period prefix stays, only whitespace is stripped.

  // <strong>automaticky prekladá vlastnosti na benefity</strong>, ktoré zákazník...
  // Note: HTML uses ASCII " (U+0022) as closing quote, not smart " (U+201C)
  ', ktoré zákazník pochopí a ocení. Nie \u201e8GB RAM" ale \u201epobeží ti na tom video editovanie".':
    ', that the customer understands and appreciates. Not \u201e8GB RAM\u201c but \u201evideo editing will run on it\u201c.',

  // <strong>upload vlastnej fotky ako avatara</strong>. Zákazník vidí...
  '. Zákazník vidí vášho asistenta.':
    '. The customer sees your assistant.',

  // <strong>Žiadny konflikt so štýlmi vášho webu</strong>, žiadne spomalenie...
  ', žiadne spomalenie, žiadny broken dizajn.':
    ', no slowdown, no broken design.',

  // <strong>automatickú analýzu</strong>: teplota zákazníka...
  ': teplota zákazníka, problém, urgentnosť, námietky, odporúčaný ďalší krok.':
    ': customer temperature, problem, urgency, objections, recommended next step.',

  // <strong>vlastné poznámky</strong>, história konverzácií...
  ', história konverzácií. Bez komplexnosti Salesforce.':
    ', conversation history. Without Salesforce complexity.',

  // <strong>Dáta sú vždy vaše</strong>, nie uväznené...
  ', nie uväznené v platforme.':
    ', not locked into a platform.',

  // <strong>žiadne throttling ani výpadky</strong>. SQLite...
  '. SQLite s WAL mode a FTS5 pre bleskové vyhľadávanie.':
    '. SQLite with WAL mode and FTS5 for lightning-fast search.',

  // <strong>checkbox GDPR súhlasu</strong>. Skutočný súhlas...
  '. Skutočný súhlas podľa legislatívy EÚ.':
    '. Real consent according to EU legislation.',

  // <strong>+€15 kredit za odporúčanie</strong>, -15% zľava...
  ', -15% zľava pre nového zákazníka.':
    ', -15% discount for the new customer.',

  // <strong>naplní automaticky za pár sekúnd</strong>. Bez nahrávania...
  '. Bez nahrávania súborov, bez copy-paste.':
    '. No file uploads, no copy-paste.',

  // Checkbox labels in GDPR consent form
  'Potvrdzujem, že som sa oboznámil/a s':
    'I confirm that I have read',
  'Súhlasím s':
    'I agree with',

  // <strong>identifikuje jeho skutočný problém</strong>, ponúka riešenie...
  ', ponúka riešenie cez benefity a uzatvára predaj. Nie náhodne – systematicky.':
    ', offers a solution through benefits and closes the sale. Not randomly – systematically.',

  // <strong>nevedia kde začať</strong>. Proaktívna bublina to zmení.
  '. Proaktívna bublina to zmení.':
    '. The proactive bubble changes that.',

  // <strong>„NEodporúčaj keď"</strong>. AI sa riadi...
  '. AI sa riadi týmito pravidlami a zákazníkovi navrhne správny produkt v správnom momente.':
    '. AI follows these rules and suggests the right product to the customer at the right moment.',

  // <strong>max 1–3 produkty naraz</strong>, vždy s priamym...
  ', vždy s priamym odkazom na nákup.':
    ', always with a direct link to purchase.',

  // <h2>Ako vyzerá váš biznis,<br>keď <span>AI obchodník...</span></h2>
  // "keď" is its own text node between <br> and <span>
  'keď':
    'when',

  // <span class="grad-text">AI obchodník robí svoju prácu</span>
  'AI obchodník robí svoju prácu':
    'AI salesman does its job',

  // ── 404 page ──────────────────────────────────────────────────────────────
  'Stránka nenájdená':
    'Page not found',
  'Ahoj! Táto stránka neexistuje, ale ja som tu 24/7. Môžem vám pomôcť nájsť čo hľadáte alebo vás nasmerovať na správne miesto.':
    "Hi! This page doesn't exist, but I'm here 24/7. I can help you find what you're looking for or point you to the right place.",

  // ── Demo page ─────────────────────────────────────────────────────────────
  // Note: \u00a0 = non-breaking space (from &nbsp; in HTML)
  'Uvidíte svojho AI\u00a0predajcu v\u00a0akcii':
    'See your AI\u00a0salesman in\u00a0action',
  'Pracuje 24/7 · odpovedá za sekundy · nikdy nezabudne na follow-up.':
    'Works 24/7 · responds in seconds · never forgets a follow-up.',
  'Nastavte ho pre váš biznis za pár minút.':
    'Set it up for your business in just a few minutes.',
  'Aktivovať pre môj biznis \u2192':
    'Activate for my business \u2192',

  // ── Onboarding install instructions ───────────────────────────────────────
  'Appearance \u2192 Theme Editor \u2192 header.php \u2192 pred </head>':
    'Appearance \u2192 Theme Editor \u2192 header.php \u2192 before </head>',
  'Online Store \u2192 Themes \u2192 Edit Code \u2192 theme.liquid \u2192 pred </head>':
    'Online Store \u2192 Themes \u2192 Edit Code \u2192 theme.liquid \u2192 before </head>',
  'Priamo do HTML súboru pred </head>':
    'Directly into your HTML file before </head>',

  // ── Onboarding pricing & invite ───────────────────────────────────────────
  '\uD83D\uDCB3 Zaplatiť kartou \u2013 \u20AC37/mesiac':
    '\uD83D\uDCB3 Pay by card \u2013 \u20AC37/month',
  '\uD83C\uDF81 Ste pozvaný/á \u2013 platíte zvýhodnenú cenu!':
    '\uD83C\uDF81 You\'re invited \u2013 you pay the discounted price!',
};

let count = 0;
for (const [k, v] of Object.entries(patch)) {
  en[k] = v;
  done.add(k);
  count++;
}

en.__done__ = [...done].sort();
fs.writeFileSync(enFile, JSON.stringify(en, null, 2), 'utf8');
console.log(`Patched ${count} keys into en.json`);
