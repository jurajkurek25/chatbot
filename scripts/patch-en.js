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

  'NeuraDesk sa naučí váš produkt, vaše ceny, vaše námietky – a vedie každého návštevníka od prvej otázky po uzavretý predaj. Presne tak, ako by ste to robili vy, len':
    'NeuraDesk will learn your product, your prices, your objections – and guide every visitor from the first question to a closed sale. Exactly as you would do it, but',

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
