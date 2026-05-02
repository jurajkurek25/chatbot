'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, '..', 'data', 'sales.db');
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initDatabase() {
  const dir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS settings (
      id TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS training_modules (
      id TEXT PRIMARY KEY,
      order_num INTEGER NOT NULL,
      title TEXT NOT NULL,
      subtitle TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      pass_score INTEGER NOT NULL DEFAULT 75
    );
    CREATE TABLE IF NOT EXISTS quiz_questions (
      id TEXT PRIMARY KEY,
      module_id TEXT NOT NULL REFERENCES training_modules(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      options TEXT NOT NULL,
      correct_index INTEGER NOT NULL,
      explanation TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS user_progress (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      module_id TEXT NOT NULL REFERENCES training_modules(id) ON DELETE CASCADE,
      score INTEGER NOT NULL DEFAULT 0,
      passed INTEGER NOT NULL DEFAULT 0,
      completed_at INTEGER,
      UNIQUE(user_id, module_id)
    );
    CREATE TABLE IF NOT EXISTS prospects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      url TEXT,
      company_name TEXT NOT NULL,
      industry TEXT,
      description TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      fit_score INTEGER,
      ai_summary TEXT,
      opening_line TEXT,
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','converted','rejected')),
      notes TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS promo_codes (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL DEFAULT 'trial',
      value_days INTEGER NOT NULL DEFAULT 30,
      max_uses INTEGER NOT NULL DEFAULT 1,
      uses INTEGER NOT NULL DEFAULT 0,
      prospect_name TEXT,
      notes TEXT,
      expires_at INTEGER,
      synced INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS sales_refs (
      id TEXT PRIMARY KEY,
      user_id TEXT UNIQUE NOT NULL REFERENCES users(id),
      ref_code TEXT UNIQUE NOT NULL,
      clicks INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  seedTraining(db);

  // Incremental migrations
  const migrations = [
    `ALTER TABLE prospects ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  console.log('DB initialized.');
}

function seedTraining(db) {
  const SEED_VERSION = '3';
  const current = db.prepare("SELECT value FROM settings WHERE id = 'training_version'").get();
  if (current?.value === SEED_VERSION) return;

  // Clear existing seed data and re-seed with current version
  db.exec('DELETE FROM quiz_questions; DELETE FROM user_progress; DELETE FROM training_modules;');

  const m1 = uuidv4(), m2 = uuidv4(), m3 = uuidv4(), m4 = uuidv4();

  // ── Module 1: Neoworkly platforma ────────────────────────────────
  db.prepare('INSERT INTO training_modules (id,order_num,title,subtitle,content,pass_score) VALUES (?,?,?,?,?,?)').run(
    m1, 1, 'Neoworkly platforma', 'Nauč sa produkt ktorý predávaš',
    `## Čo je Neoworkly?
Neoworkly je AI chatbot platforma pre malé a stredné firmy. Klient si vytvorí inteligentného chatbota na web za 15 minút – bez programovania, priamo cez AI Coach.

## Plány a ceny

**Pro plán – €37/mesiac**
- 500 AI odpovedí mesačne zahrnutých
- Do 10 chatbotov (widgetov)
- Všetky základné aj pokročilé funkcie

**White Label plán – €97/mesiac**
- 40 widgetov, vlastná značka (bez "Powered by Neoworkly")
- Predaj chatbotov vlastným klientom pod svojím logom
- Extra widgety: €27/mes za každých 10 ďalších
- Volume kredity: €50 = 1 000, €100 = 3 300, €250 = 8 250 odpovedí

**Person Add-on – €27/mesiac**
- Digitálny dvojník konkrétnej osoby
- Chatbot komunikuje štýlom a hlasom majiteľa/experta

**Extra kredity – €8 za 200 odpovedí (25 kr/€)**
- Auto-reload: automatické dobíjanie z uloženej karty pri dosiahnutí limitu

## AI Coach – najväčší differenciátor
Klient popíše biznis prirodzeným jazykom a AI **sama vytvorí celý widget** – otázky, odpovede, nastavenia, znalostná báza. Žiadne manuálne klikanie. Demo pitch: *"Povedzte mi len názov firmy a čo robíte – chatbot vám nastavím za 2 minúty priamo tu."*

## Všetky funkcie

**Lead Capture** – zbieranie mena, emailu, telefónu 24/7 bez obsluhy.

**Follow-up sekvencie** – až 5 automatických emailov leadom s vlastným delayom. Každý lead dostane starostlivosť aj keď ste offline.

**Rezervačný systém** – booking cez chat s prepojením na Google Calendar. Zákazník si rezervuje termín bez telefonovania.

**Znalostná báza** – nahranie PDF, URL, textu. Chatbot odpovedá na základe vlastných dokumentov firmy.

**Proaktívne oslovenie** – chatbot sa sám ozve návštevníkovi webu po nastavenom počte sekúnd.

**Money Mode** – ROI tracking v reálnom čase: príjmy, konverzie leadov na klientov.

**SEO audit** – AI analýza webu zákazníka s konkrétnymi odporúčaniami.

**GDPR súlad** – zabudovaný, bez potreby úprav.

## Integrácie
Instagram DM, WhatsApp, Facebook Messenger, WooCommerce, Shopify

## Cieľoví zákazníci
E-shopy, realitky, kozmetické salóny, fitness centrá, autobazáre, právnici, účtovníci, reštaurácie, koučovia, konzultanti`, 75
  );

  const q1 = [
    ['Koľko stojí Pro plán mesačne?', ['€19','€29','€37','€49'], 2, 'Pro plán stojí €37 mesačne a obsahuje 500 odpovedí a 10 widgetov.'],
    ['Čo je AI Coach a prečo je to najväčší differenciátor?', ['Chatbot pre zákazníkov','AI ktorá sama vytvorí celý widget z popisu biznisu','Extra balík odpovedí','Podpora cez email'], 1, 'AI Coach vytvorí kompletný widget konverzáciou – žiadne manuálne nastavovanie.'],
    ['Koľko odpovedí dostane zákazník za €8 extra kreditov?', ['100','150','200','250'], 2, 'Extra kredity: €8 = 200 odpovedí (kurz 25 kr/€).'],
    ['White Label plán je určený primárne pre?', ['Jednotlivcov s jedným webom','Agentúry predávajúce chatboty klientom pod vlastnou značkou','Firmy s viac ako 100 zamestnancami','Vývojárov'], 1, 'White Label umožňuje predávať chatboty pod vlastnou značkou za €97/mes.'],
    ['Čo robí funkcia Follow-up sekvencia?', ['Odosiela newsletter všetkým návštevníkom','Automaticky emailuje leadov až v 5 krokoch po zachytení kontaktu','Synchronizuje kontakty s CRM','Posiela SMS zákazníkom'], 1, 'Sekvencie automaticky emailujú každý zachytený lead – až 5 krokov s vlastným delayom.'],
    ['S čím sa prepája rezervačný systém?', ['Outlook Calendar','iCloud Calendar','Google Calendar','Excel'], 2, 'Rezervačný systém sa prepája s Google Calendar – zákazník rezervuje slot priamo v chate.'],
    ['Čo je Person Add-on?', ['Extra balík widgetov','Digitálny dvojník – chatbot komunikuje štýlom konkrétnej osoby','Instagram integrácia','Zákaznícka podpora 24/7'], 1, 'Person Add-on za €27/mes vytvorí chatbota komunikujúceho štýlom majiteľa/experta.'],
    ['Čo sleduje Money Mode?', ['Počet správ a kliknutí','ROI – príjmy a konverzie leadov na platiacich klientov','Počet návštevníkov webu','Pozície vo vyhľadávačoch'], 1, 'Money Mode sleduje ROI v reálnom čase – koľko príjmov chatbot priniesol.'],
    ['Aké e-commerce integrácie Neoworkly ponúka?', ['Magento a PrestaShop','WooCommerce a Shopify','Pouze vlastné API','BigCommerce a Squarespace'], 1, 'Neoworkly sa integruje s WooCommerce a Shopify.'],
    ['Čo je proaktívne oslovenie?', ['Email zákazníkovi po nákupe','Chatbot sa sám ozve návštevníkovi webu po X sekundách','Push notifikácia v prehliadači','Automatický telefonát'], 1, 'Proaktívne oslovenie – chatbot sa ako prvý ozve návštevníkovi namiesto čakania.'],
  ];

  for (const [q, opts, ci, exp] of q1) {
    db.prepare('INSERT INTO quiz_questions (id,module_id,question,options,correct_index,explanation) VALUES (?,?,?,?,?,?)')
      .run(uuidv4(), m1, q, JSON.stringify(opts), ci, exp);
  }

  // ── Module 2: Predajné zručnosti ─────────────────────────────────
  db.prepare('INSERT INTO training_modules (id,order_num,title,subtitle,content,pass_score) VALUES (?,?,?,?,?,?)').run(
    m2, 2, 'Predajné zručnosti', 'Nauč sa predávať ako profesionál',
    `## Ideálny zákazník
Firma s webom ktorá dostáva opakujúce sa otázky zákazníkov (ceny, dostupnosť, objednávky, termíny). Chce zachytávať leady 24/7 a nechce prísť o zákazníka kvôli pomalej reakcii.

**Top segmenty:** e-shopy, realitky, kozmetické salóny, fitness, autobazáre, právnici, účtovníci, koučovia.

## BANT kvalifikácia
- **B – Budget:** "Máte vyčlenený rozpočet na digitálny marketing alebo nástroje?"
- **A – Authority:** "Ste zodpovedný za web alebo marketing vo firme?"
- **N – Need:** "Dostávate veľa opakujúcich sa otázok od zákazníkov online?"
- **T – Timeline:** "Kedy by ste chceli mať chatbot spustený?"

## Štruktúra cold callu (celkom ~15 minút)
1. **Opener (15 sek):** "Videl som váš web [firma.sk]. Riešite teraz ako lepšie obsluhovať zákazníkov online?"
2. **Kvalifikácia (2 min):** Need + Authority — max 2 otázky
3. **Value prop (30 sek):** "Neoworkly dá na váš web chatbota, ktorý zachytáva zákazníkov 24/7 za €37/mesiac."
4. **AI Coach demo (2 min):** "Povedzte mi len čo robíte – ukážem vám chatbot za 2 minúty priamo teraz."
5. **CTA (30 sek):** "Môžem vám nastaviť demo dnes alebo zajtra?"

**Demo tip:** Pred hovorom si prejdi web zákazníka. Personalizované demo (pre ich odvetvie) konvertuje 3× lepšie ako generické.

## Zvládanie námietok

**"Je to drahé"**
→ "Koľko vám prinesie jeden zákazník? €37 mesačne zaplatí 2-3 zachytené leady."

**"Nemám čas"**
→ "Presne preto je tu AI Coach – chatbot vám nastavím za 2 minúty, potom pracuje za vás 24/7."

**"Pošlite mi email"**
→ "Rád pošlem. Čo by vás presvedčilo, že to má pre vás zmysel?"

**"Používame iné riešenie"**
→ "Čo používate? Čo vám tam chýba alebo by ste zmenili?"

**"Nemáme dostatok návštevníkov"**
→ "Aj 100 návštevníkov mesačne prinesie 5-10 konverzácií. A proaktívne oslovenie zvýši engagement o 40%."

**"Musím sa poradiť s partnerom"**
→ "Rozumiem. Môžeme urobiť spoločný call kde vysvetlím všetko vám obom?"

**"Chceme free trial"**
→ "Free trial nemáme, ale ak chatbot nezachytí ani jedného zákazníka za prvý mesiac, vrátim peniaze osobne."

**"Chatboty sú neosobné"**
→ "Neoworkly má Person Add-on – chatbot hovorí štýlom konkrétnej osoby. Zákazníci často nevedia, že nejde o živého človeka."

## Uzatváranie
Vždy konkrétny next step s časovým rámcom: *"Spustíme to tento týždeň?"*
Follow-up email do 30 minút po hovore – zhrnutie + next step.`, 75
  );

  const q2 = [
    ['Čo je najsilnejší opener pre cold call realitnej kancelárie?', ['"Dobrý deň, predávame chatboty."','"Videl som váš web. Riešite teraz ako lepšie obsluhovať záujemcov o nehnuteľnosti online?"','"Máte záujem o AI?"','"Posielam vám email s ponukou."'], 1, 'Personalizovaný opener odkazujúci na ich biznis otvára konverzáciu oveľa lepšie.'],
    ['Čo znamená "A" v BANT?', ['Amount – výška zákazky','Authority – kto má rozhodovaciu právomoc','AI – použitie umelej inteligencie','Availability – dostupnosť termínu'], 1, 'A = Authority – predávate tomu kto rozhoduje, nie len záujemcovi.'],
    ['Zákazník: "Je to príliš drahé." Najsilnejšia odpoveď?', ['"Máme aj lacnejší plán."','"Skúste konkurenciu."','"Koľko vám prinesie jeden zákazník? €37 zaplatia 2-3 zachytené leady."','"Dám vám zľavu."'], 2, 'Presuňte diskusiu na ROI – konkrétny príklad hodnoty eliminuje cenovú námietku.'],
    ['Zákazník: "Nemám čas." Ako reagujete?', ['"Zavolám inokedy."','"AI Coach nastaví chatbot za 2 minúty – potom pracuje za vás 24/7."','"Urobíme to rýchlo."','"Pošlem vám email."'], 1, 'Ukážte že AI Coach eliminuje čas na setup – 2 minúty vs hodiny manuálneho nastavovania.'],
    ['"Pošlite mi email" zvyčajne znamená?', ['Záujem – potrebuje čas na rozmyslenie','Technická otázka na produkt','Zdvorilé odmietnutie – treba zistiť skutočný dôvod','Súhlas s kúpou'], 2, 'Väčšinou ide o zdvorilé odmietnutie. Opýtajte sa: "Čo by vás presvedčilo?"'],
    ['Čo urobíte PRED demo hovorom s fitness centrom?', ['Nič – máte štandardné demo','Preskúmate ich web a pripravíte demo so scenárom pre fitness (rezervácie tréningov, FAQ o členstvách)','Naučíte sa všetky funkcie naspamäť','Pošlete im cenovú ponuku vopred'], 1, 'Personalizované demo pre konkrétne odvetvie konvertuje 3× lepšie ako generické.'],
    ['Zákazník: "Chatboty sú neosobné." Čo odpovedáte?', ['"Máte pravdu, chatboty majú limity."','"Person Add-on – chatbot hovorí štýlom konkrétnej osoby. Zákazníci nevedia, že nejde o živého človeka."','"Zákazníci si zvyknú."','"Chatbot je objektívnejší ako ľudia."'], 1, 'Person Add-on priamo rieši túto námietku – chatbot môže byť osobný a autentický.'],
    ['Zákazník pýta zľavu. Najlepšia reakcia?', ['Dáte 20% zľavu okamžite','Navrhnete ročné predplatné (úspora 2 mesiace) alebo preukážete ROI konkrétnym príkladom','Poviete že zľavy nerobíte a ukončíte hovor','Pošlete zľavový kód emailom'], 1, 'Namiesto zľavy ponúknite vyššiu hodnotu: ročné predplatné alebo ukážte ROI.'],
    ['Zákazník: "Musím sa poradiť s manželkou." Čo urobíte?', ['Počkáte týždeň','Navrhnete spoločný 15-minútový call kde vysvetlíte všetko obom','Pošlete email pre manželku','Dáte im mesiac na rozmyslenie'], 1, 'Spoločný call eliminuje "stratenú informáciu" a vy kontrolujete konverzáciu.'],
    ['Čo poslať zákazníkovi do 30 minút po hovore?', ['Nič – počkáte na jeho iniciatívu','Faktúru','Follow-up email: zhrnutie hovoru, konkrétny next step a link na demo','Len link na web Neoworkly'], 2, 'Rýchly follow-up udržiava momentum, ukazuje profesionalitu a drží zákazníka v procese.'],
  ];

  for (const [q, opts, ci, exp] of q2) {
    db.prepare('INSERT INTO quiz_questions (id,module_id,question,options,correct_index,explanation) VALUES (?,?,?,?,?,?)')
      .run(uuidv4(), m2, q, JSON.stringify(opts), ci, exp);
  }

  // ── Module 3: Pokročilé use cases ────────────────────────────────
  db.prepare('INSERT INTO training_modules (id,order_num,title,subtitle,content,pass_score) VALUES (?,?,?,?,?,?)').run(
    m3, 3, 'Pokročilé use cases', 'Nauč sa predávať každému zákazníkovi na mieru',
    `## White Label – predaj agentúram a resellerom

**Ideálny zákazník pre WL:** Digitálna agentúra, webdizajnér, IT firma, marketing poradca ktorý má 5+ klientov s webmi.

**Pitch:** "Za €97 mesačne máte 40 chatbotov pod vlastnou značkou. Každému klientovi predáte chatbot za €50-100/mes – návratnosť za prvých 2-3 klientov."

**Kalkulácia pre agentúru:**
- Neoworkly WL: €97/mes
- 10 klientov × €80/mes = €800 príjem
- Čistý zisk: €703/mes za pasívny recurring revenue

## Person Add-on – kedy a komu

**Ideálni zákazníci:** koučovia, konzultanti, lektori, realitní makléri, lekári, advokáti – ktokoľvek kde osobná značka hrá rolu.

**Pitch:** "Váš chatbot bude komunikovať presne vaším štýlom. Zákazníci budú mať pocit, že píšu priamo vám – aj o 2:00 v noci."

**Demo tip:** Ukáž zákazníkovi ako chatbot odpovie na otázku v ich vlastnom štýle.

## AI Coach – ako demo vyzerá v praxi

1. Obchodník povie: *"Povedzte mi: ako sa volá vaša firma a čo robíte?"*
2. Zákazník odpovie: *"Kozmetický salón Krása, robíme manikúru a pedikúru."*
3. Obchodník klikne na AI Coach v dashboarde a prepíše odpoveď zákazníka.
4. AI Coach vytvorí kompletný widget za 30-60 sekúnd.
5. Zákazník vidí hotový chatbot — **WOW moment**.

**Toto je najsilnejší predajný argument.** Vždy robiť live demo, nie slideshow.

## Money Mode – ROI pitch

Pre skeptických zákazníkov ktorí pochybujú o hodnote:

*"Náš priemerný klient zachytí 15-30 leadov mesačne ktoré by inak stratil. Ak sa vám konvertuje len 10% = 2-3 zákazníci. Koľko stojí jeden zákazník u vás?"*

Money Mode zobrazuje tieto čísla v reálnom čase priamo v dashboarde.

## Sekvencie – predajný pitch

*"Každý zákazník ktorý zanechá kontakt dostane sériu 5 automatických emailov. Kým vy spíte, chatbot buduje vzťah so zákazníkom."*

Ideálne pre: e-shopy (opustený košík), realitky (záujemcovia o nehnuteľnosti), fitness (trial návštevníci).

## Instagram & WhatsApp – pitch

*"Vaše DM správy zodpovie AI automaticky. Žiadne oneskorenie, žiadna manuálna práca. Zákazník dostane odpoveď do 10 sekúnd."*

Silné pre: e-shopy, reštaurácie, kozmetické salóny – kde zákazníci aktívne píšu cez Instagram.

## Booking – pitch pre servisné firmy

*"Zákazník si rezervuje termín priamo v chate – bez telefonovania, bez emailov. Rezervácia ide priamo do vášho Google Calendara."*

Kľúčové pre: kozmetické salóny, fitness, lekári, advokáti, koučovia – všade kde sa rezervujú termíny.`, 75
  );

  const q3 = [
    ['Agentúra má 10 klientov a predáva každému chatbot za €80/mes. Koľko čistého zisku mesačne po odčítaní WL plánu?', ['€703','€800','€97','€503'], 0, '10 × €80 = €800 príjem − €97 WL plán = €703 čistý zisk mesačne.'],
    ['Komu je Person Add-on najprínosnejší?', ['E-shopom s tisíckami produktov','Koučom, konzultantom a expertom kde osobná značka hrá kľúčovú rolu','Výrobným firmám bez priameho kontaktu so zákazníkmi','Firmám s veľkým call centrom'], 1, 'Person Add-on je pre osobné značky kde zákazníci chcú komunikovať s konkrétnym človekom.'],
    ['Aký je WOW moment pri AI Coach demo?', ['Zákazník dostane cenovú ponuku','Zákazník vidí hotový chatbot vytvorený z jeho popisu biznisu za 60 sekúnd','Obchodník ukáže prezentáciu s grafmi','Zákazník dostane email s ponukou'], 1, 'Živé demo kde AI Coach vytvorí chatbot počas hovoru je najsilnejší predajný argument.'],
    ['Čo poviete zákazníkovi ktorý pochybuje o hodnote chatbota?', ['"Chatboty sú budúcnosť."','"Skúste to aspoň mesiac."','"Priemerný klient zachytí 15-30 leadov mesačne ktoré by inak stratil. Koľko stojí jeden zákazník u vás?"','"Všetci competitors to už majú."'], 2, 'Konkrétne čísla a otázka na hodnotu zákazníka presúva diskusiu na ROI.'],
    ['Pre ktorý segment je Instagram integrácia najprínosnejšia?', ['B2B výrobné firmy','E-shopy a kozmetické salóny kde zákazníci aktívne píšu cez Instagram DM','Právnické kancelárie','Výrobné podniky'], 1, 'Instagram integrácia je najsilnejšia pre B2C firmy s aktívnou Instagram komunitou.'],
    ['Ako prezentovať rezervačný systém kozmetickému salónu?', ['"Máme booking funkciu."','"Zákazník si rezervuje termín priamo v chate – bez telefonovania. Rezervácia ide do vášho Google Calendara."','"Integrujeme sa s Google."','"Posielame emailové notifikácie."'], 1, 'Konkrétny benefit (bez telefonovania, priamo do Calendara) je presvedčivejší ako generický popis.'],
    ['Zákazník: webdizajnér s 8 klientmi. Aký plán odporučíte?', ['Pro plán – je lacnejší','White Label – predáva chatboty klientom pod vlastnou značkou za €97/mes','Person Add-on – má osobnú značku','Extra kredity'], 1, 'Webdizajnér s klientmi je ideálny White Label zákazník – môže predávať chatboty ďalej.'],
    ['Čo je kľúčové pri Follow-up sekvenciách pre e-shop?', ['Newsletter každý mesiac','Automatické emaily leadom po opustení košíka alebo zanechaní kontaktu','SMS kampane','Push notifikácie'], 1, 'Sekvencie pre e-shop riešia opustené košíky a nurturujú záujemcov automaticky.'],
    ['Ako začať AI Coach demo počas hovoru?', ['"Ukážem vám prezentáciu."','"Pošlem vám link na web."','"Povedzte mi: ako sa volá vaša firma a čo robíte?" – a živо vytvorte chatbot počas hovoru.','"Pozrite na YouTube ako to funguje."'], 2, 'Live demo počas hovoru je najsilnejší predajný moment – zákazník vidí výsledok okamžite.'],
    ['Zákazník: "Naši zákazníci nás volajú, nepotrebujeme chat." Ako reagujete?', ['"Máte pravdu."','"Skúste aspoň mesiac."','"Každý hovor vás stojí 5-10 minút. Chatbot odpovie na 80% otázok automaticky – vy riešite len zvyšok."','"Chatbot je lepší ako telefón."'], 2, 'Prefrámujte argument na úsporu času – chatbot nenahrádza telefón, eliminuje rutinné hovory.'],
  ];

  for (const [q, opts, ci, exp] of q3) {
    db.prepare('INSERT INTO quiz_questions (id,module_id,question,options,correct_index,explanation) VALUES (?,?,?,?,?,?)')
      .run(uuidv4(), m3, q, JSON.stringify(opts), ci, exp);
  }

  // ── Module 4: Záverečný test ─────────────────────────────────────
  db.prepare('INSERT INTO training_modules (id,order_num,title,subtitle,content,pass_score) VALUES (?,?,?,?,?,?)').run(
    m4, 4, 'Záverečný test', 'Preukáž komplexné znalosti – potrebuješ 80%',
    `## Záverečný certifikačný test

Tento test overuje produktové znalosti, predajné zručnosti aj pokročilé use cases.

Potrebuješ **80% (12/15)** na získanie certifikátu Neoworkly Sales.

**Tip:** Ak si nie istý v nejakej oblasti, vráť sa k príslušnému modulu pred odoslaním.`, 80
  );

  const q4 = [
    ['Čo je najväčší differenciátor Neoworkly oproti konkurencii?', ['Najnižšia cena na trhu','AI Coach – chatbot vytvorený z popisu biznisu za 2 minúty','Neobmedzené odpovede','Len pre e-shopy'], 1, 'AI Coach je unikátna funkcia – zákazník popíše biznis a AI sama vytvorí celý widget.'],
    ['Zákazník – realitná kancelária – pýta čo konkrétne chatbot spraví pre nich. Čo poviete?', ['"Chatbot odpovedá na otázky."','"Chatbot zbiera záujemcov o nehnuteľnosti 24/7, posiela im automatické follow-up emaily a môže rezervovať obhliadky – všetko bez vašej prítomnosti."','"Máme veľa funkcií."','"Pozrite na našu webstránku."'], 1, 'Konkrétny popis pre ich odvetvie (záujemcovia, follow-up, obhliadky) je presvedčivejší ako generický.'],
    ['Agentúra s 15 klientmi chce predávať chatboty. Aký je správny postup?', ['Pro plán pre každého klienta zvlášť','White Label €97/mes – 40 widgetov pod vlastnou značkou, predaj klientom za vlastnú cenu','Odporučiť im Neoworkly priamo','Person Add-on'], 1, 'White Label je riešenie pre agentúry – jedna platba, 40 widgetov, vlastná značka.'],
    ['Koľko odpovedí mesačne zahŕňa Pro plán?', ['200','350','500','1000'], 2, 'Pro plán zahŕňa 500 AI odpovedí mesačne.'],
    ['Zákazník: "Chatbot nám nefungoval u konkurencie." Čo odpovedáte?', ['"To sa stáva."','"Náš je iný."','"Čo konkrétne nefungovalo? Proaktívne oslovenie a Person Add-on riešia väčšinu problémov s adopciou."','"Vrátime peniaze ak nefunguje."'], 2, 'Zistite konkrétny problém a ukážte ako ho Neoworkly rieši – proaktívne oslovenie a personalizácia.'],
    ['Kedy je ideálny moment pre Person Add-on pitch?', ['Vždy, každému zákazníkovi','Keď zákazník hovorí "chatboty sú neosobné" alebo má silnú osobnú značku (kouč, konzultant, lektor)','Len pri White Label pláne','Len pre e-shopy'], 1, 'Person Add-on pitch príde prirodzene pri námietke o neosobnosti alebo pri osobných značkách.'],
    ['Zákazník chce vidieť demo. Čo urobíte ako prvé?', ['Spustíte štandardnú prezentáciu','Pýtate sa: "Ako sa volá vaša firma a čo robíte?" a spustíte AI Coach live','"Pošlem vám link na video demo"','Ukážete features list'], 1, 'Live AI Coach demo počas hovoru je WOW moment – zákazník vidí vlastný chatbot za 60 sekúnd.'],
    ['Zákazník hovorí že má veľa telefonátov od zákazníkov. Aká funkcia to rieši?', ['SEO audit','Money Mode','Chatbot s proaktívnym oslovením + znalostná báza eliminuje rutinné hovory','Person Add-on'], 2, 'Chatbot odpovedá na opakujúce sa otázky automaticky – zákazník rieši len výnimky.'],
    ['Čo je správna odpoveď na "Nemáte free trial"?', ['"Bohužiaľ nemáme."','"Máme 14-dňový trial."','"Free trial nemáme, ale ak chatbot nezachytí ani jedného zákazníka za prvý mesiac, vrátim peniaze osobne."','"Skúste konkurenciu."'], 2, 'Osobná garancia je silnejšia ako formálny trial – buduje dôveru a záväzok obchodníka.'],
    ['Koučka s osobnou značkou chce chatbot. Čo odporučíte?', ['Len Pro plán','Pro plán + Person Add-on – chatbot komunikuje jej štýlom a zákazníci majú pocit že píšu priamo jej','White Label','Len extra kredity'], 1, 'Pre osobnú značku je Person Add-on kľúčový – koučka hovorí vlastným hlasom aj cez chatbot.'],
    ['Zákazník nie je rozhodovateľ ale je záujemca. Čo urobíte?', ['Ukončíte hovor','Predáte len jemu','Požiadate ho aby zorganizoval spoločný call s rozhodovateľom – vy pripravíte demo pre oboch','Počkáte kým ho kontaktuje šéf sám'], 2, 'Vždy sa dostante k rozhodovateľovi – spoločný call je najefektívnejší spôsob.'],
    ['Zákazník: "Používame Tidio." Ako reagujete?', ['"Tidio je lepší."','"Sme lacnejší."','"Zaujímavé. Čo vám tam chýba alebo by ste zmenili? Veľa klientov nám hovorí, že im chýba AI Coach a automatické sekvencie."','"Prepáčte, zavolám inokedy."'], 2, 'Zistite slabiny konkurencie a ukážte kde Neoworkly pridáva hodnotu (AI Coach, sekvencie).'],
    ['Follow-up email po hovore by mal obsahovať?', ['Len cenovú ponuku','Len link na web','Zhrnutie hovoru, konkrétny dohodnutý next step a termín','Katalóg všetkých funkcií'], 2, 'Efektívny follow-up: zhrnutie + next step + termín – udržiava momentum a zodpovednosť.'],
    ['WL zákazník pýta ako zarobí na chatbotoch. Čo ukážete?', ['Poviete že to závisí od trhu','"10 klientov × €80/mes = €800 príjem − €97 WL = €703 čistý zisk. Prvý klient vráti investíciu."','Pošlete mu kalkuláciu emailom','Poviete že závisí od ich salesu'], 1, 'Konkrétna kalkulácia ROI pre WL zákazníka je najsilnejší argument – číslami hovoríte ich jazykom.'],
    ['Zákazník: "Musíme to ešte interně prerokovať." Čo urobíte?', ['Počkáte na ich rozhodnutie','Pošlete email s ponukou','Navrhnete spoločný call so všetkými zainteresovanými stranami + dohodnete konkrétny termín do 48 hodín','Dáte im mesiac na rozmyslenie'], 2, 'Spoločný call udržiava kontrolu nad procesom – čakanie bez termínu väčšinou deal zabiie.'],
  ];

  for (const [q, opts, ci, exp] of q4) {
    db.prepare('INSERT INTO quiz_questions (id,module_id,question,options,correct_index,explanation) VALUES (?,?,?,?,?,?)')
      .run(uuidv4(), m4, q, JSON.stringify(opts), ci, exp);
  }

  // Mark seed version
  db.prepare("INSERT OR REPLACE INTO settings (id, value) VALUES ('training_version', ?)").run(SEED_VERSION);
}

module.exports = { getDb, initDatabase };
