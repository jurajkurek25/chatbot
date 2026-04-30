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
  `);

  seedTraining(db);
  console.log('DB initialized.');
}

function seedTraining(db) {
  if (db.prepare('SELECT id FROM training_modules LIMIT 1').get()) return;

  const m1 = uuidv4(), m2 = uuidv4(), m3 = uuidv4();

  db.prepare('INSERT INTO training_modules (id,order_num,title,subtitle,content,pass_score) VALUES (?,?,?,?,?,?)').run(
    m1, 1, 'Neoworkly platforma', 'Nauč sa produkt ktorý predávaš',
    `## Čo je Neoworkly?
Neoworkly je AI chatbot platforma pre malé a stredné firmy. Umožňuje vytvoriť inteligentného chatbota na web za 15 minút – bez programovania.

## Plány a ceny

**Pro plán – €37/mesiac**
- 500 AI odpovedí mesačne
- Do 10 chatbotov (widgetov)
- Všetky základné funkcie

**White Label plán – €97/mesiac**
- 40 chatbotov
- Vlastná značka (bez "Powered by Neoworkly")
- Predaj chatbotov vlastným klientom
- Extra widgety: €27/mes za 10 ďalších

**Person Add-on – €27/mesiac**
- Digitálny dvojník konkrétnej osoby
- Chatbot hovorí štýlom a hlasom majiteľa

**Extra kredity – €8 za 200 odpovedí**
- Auto-reload: automatické dobíjanie pri dosiahnutí limitu

## Hlavné funkcie

**Lead Capture** – chatbot zbiera meno, email, telefón zákazníka 24/7.

**Follow-up sekvencie** – automatické emaily leadom. Až 5 krokov, vlastný delay.

**Rezervačný systém** – booking cez chat, prepojenie s Google Calendar.

**Znalostná báza** – nahranie PDF, URL, textu. AI odpovedá na základe vašich dokumentov.

**Integrácie** – Instagram DM, WhatsApp, Facebook Messenger.

**Money Mode** – sledovanie ROI: príjmy, konverzie leadov na klientov.

**SEO audit** – AI analýza webu zákazníka s odporúčaniami.

## Cieľový zákazník
Malé a stredné firmy s webom: e-shopy, realitky, kozmetické salóny, fitness centrá, autobazáre, právnici, účtovníci, reštaurácie.`, 75
  );

  const q1 = [
    ['Koľko stojí Pro plán mesačne?', ['€19/mesiac','€29/mesiac','€37/mesiac','€49/mesiac'], 2, 'Pro plán stojí €37 mesačne.'],
    ['Koľko AI odpovedí obsahuje Pro plán?', ['200','350','500','1000'], 2, 'Pro plán obsahuje 500 AI odpovedí mesačne.'],
    ['Čo umožňuje White Label plán?', ['Viac chatbotov len pre seba','Predaj chatbotov klientom pod vlastnou značkou','Neobmedzené odpovede','Bezplatný plán pre agentúry'], 1, 'White Label umožňuje predávať chatboty klientom pod vlastnou značkou.'],
    ['Koľko widgetov je v Pro pláne?', ['3','5','10','Neobmedzene'], 2, 'Pro plán obsahuje do 10 widgetov (chatbotov).'],
    ['Čo je Person Add-on?', ['Extra balík odpovedí','Digitálny dvojník komunikujúci štýlom osoby','Instagram integrácia','Rezervačný systém'], 1, 'Person Add-on je digitálny dvojník – chatbot hovorí štýlom konkrétnej osoby.'],
    ['Aké integrácie Neoworkly ponúka?', ['Len webový chat','Telegram a Viber','Instagram, WhatsApp, Facebook Messenger','Len email'], 2, 'Neoworkly sa integruje s Instagram DM, WhatsApp a Facebook Messenger.'],
    ['Čo je Follow-up sekvencia?', ['Newsletter pre odberateľov','Automatické emaily leadom po zachytení kontaktu','SMS správy zákazníkom','Push notifikácie'], 1, 'Follow-up sekvencia sú automatické emaily odosielané leadom.'],
    ['Koľko stojí balík extra kreditov?', ['€5 za 100 odpovedí','€8 za 200 odpovedí','€10 za 100 odpovedí','€15 za 200 odpovedí'], 1, 'Extra kredity stoja €8 za 200 odpovedí.'],
    ['S čím sa prepája rezervačný systém?', ['Outlook Calendar','Google Calendar','iCloud Calendar','Excel'], 1, 'Rezervačný systém sa prepája s Google Calendar.'],
    ['Čo sleduje funkcia Money Mode?', ['Len počet správ','ROI – príjmy a konverzie leadov na klientov','Počet návštevníkov webu','Email otvárateľnosť'], 1, 'Money Mode sleduje ROI – príjmy z konverzácií a konverzie leadov.'],
  ];

  for (const [q, opts, ci, exp] of q1) {
    db.prepare('INSERT INTO quiz_questions (id,module_id,question,options,correct_index,explanation) VALUES (?,?,?,?,?,?)')
      .run(uuidv4(), m1, q, JSON.stringify(opts), ci, exp);
  }

  db.prepare('INSERT INTO training_modules (id,order_num,title,subtitle,content,pass_score) VALUES (?,?,?,?,?,?)').run(
    m2, 2, 'Predajné zručnosti', 'Nauč sa predávať ako profesionál',
    `## Ideálny zákazník
Firma ktorá má web a dostáva opakujúce sa otázky zákazníkov (ceny, dostupnosť, objednávky). Chce zachytávať leady 24/7 a stratila zákazníka kvôli pomalej reakcii.

**Najlepšie segmenty:** e-shopy, realitky, kozmetické salóny, fitness, autobazáre, právnici, účtovníci.

## BANT kvalifikácia
- **B – Budget:** "Máte vyčlenený rozpočet na digitálne nástroje?"
- **A – Authority:** "Ste zodpovedný za web/marketing?"
- **N – Need:** "Dostávate veľa opakujúcich sa otázok od zákazníkov?"
- **T – Timeline:** "Kedy by ste chceli mať chatbot spustený?"

## Štruktúra cold callu
1. **Opener (15 sek):** "Videl som váš web [firma.sk]. Riešite teraz ako lepšie obsluhovať zákazníkov online?"
2. **Kvalifikácia (2 min):** 2 otázky → Need + Authority
3. **Value prop (30 sek):** "Neoworkly dá na váš web chatbota, ktorý zachytáva zákazníkov 24/7 za €37/mesiac."
4. **Mini demo (2 min):** Konkrétny príklad pre ich biznis
5. **CTA (30 sek):** "Môžem vám nastaviť demo dnes/zajtra?"

## Zvládanie námietok

**"Je to drahé"**
→ "Koľko vám prinesie jeden zákazník? €37 mesačne zaplatí 2-3 zachytené leady."

**"Nemám čas"**
→ "Presne preto sme tu. Setup trvá 15 minút, potom chatbot pracuje za vás."

**"Pošlite mi email"**
→ "Rád pošlem. Čo by vás presvedčilo, že to má pre vás zmysel?"

**"Používame iné riešenie"**
→ "Čo používate? Čo vám tam chýba alebo by ste zmenili?"

**"Nemáme dostatok návštevníkov"**
→ "Aj 100 návštevníkov mesačne môže priniesť 5-10 konverzácií."

## Uzatváranie obchodu
Vždy konkrétny next step: "Spustíme to tento týždeň?"
Po hovore: follow-up email do 30 minút.`, 75
  );

  const q2 = [
    ['Ktorý typ firmy je najlepší kandidát pre Neoworkly?', ['Firma bez webu','Firma s webom a opakujúcimi otázkami zákazníkov','Startup bez zákazníkov','Korporácia s IT tímom'], 1, 'Ideálny zákazník má web a dostáva opakujúce sa otázky.'],
    ['Čo znamená "N" v BANT?', ['Name – meno zákazníka','Network – sieť kontaktov','Need – zákazník má reálny problém','Number – počet zamestnancov'], 2, 'N = Need – zákazník musí mať reálny problém, ktorý chatbot rieši.'],
    ['Zákazník: "Je to príliš drahé." Najlepšia odpoveď?', ['"Máme aj lacnejší plán."','"Rozumiem, skúste iného."','"Koľko vám prinesie jeden zákazník? 2-3 leady to zaplatia."','"Je to investícia, nie náklad."'], 2, 'Najlepšie presuňte diskusiu na ROI – konkrétny príklad hodnoty.'],
    ['Zákazník: "Nemám čas." Ako reagujete?', ['"Zavolám inokedy."','"Urobíme to rýchlo."','"Setup je 15 minút, potom chatbot pracuje za vás 24/7."','"Pošlem vám email."'], 2, 'Ukážte, že chatbot ušetrí čas – setup je len 15 minút.'],
    ['Aká je ideálna dĺžka prvého predajného hovoru?', ['5 minút','15-20 minút','45 minút','Čo najdlhší'], 1, 'Prvý hovor by mal trvať 15-20 minút: kvalifikácia, demo, CTA.'],
    ['"Pošlite mi email" zvyčajne znamená?', ['Záujem – potrebuje čas','Technická otázka','Zdvorilé odmietnutie – treba zistiť skutočný dôvod','Súhlas s kúpou'], 2, 'Väčšinou ide o zdvorilé odmietnutie. Opýtajte sa čo by ich presvedčilo.'],
    ['Čo urobíte PRED demo hovorom?', ['Nič – stačí štandardné demo','Naučiť sa všetky funkcie naspamäť','Preskúmať web zákazníka a pripraviť demo na mieru','Pripraviť cenovú ponuku'], 2, 'Personalizované demo je oveľa efektívnejšie ako generické.'],
    ['Zákazník: "Používame iné riešenie." Čo urobíte?', ['Ospravedlníte sa a zavesíte','Poviete že ste lepší','Spýtate sa čo používajú a zistíte čo im chýba','Ponúknete zľavu'], 2, 'Zistite čo im v súčasnom riešení chýba a ukážte ako to Neoworkly rieši.'],
    ['Ako uzavrieť obchod po úspešnom demo?', ['Čakáte na zákazníka','Pošlete faktúru','Konkrétna výzva: "Spustíme to tento týždeň?"','Dáte im mesiac na rozmyslenie'], 2, 'Vždy navrhujte konkrétny next step s časovým rámcom.'],
    ['Zákazník: "Nemáme dostatok návštevníkov." Odpoveď?', ['"Máte pravdu, chatbot nie je pre vás."','"Aj 100 návštevníkov prinesie 5-10 konverzácií. Oplatí sa."','"Najprv zvýšte traffic."','"Zavolajte keď budete mať viac zákazníkov."'], 1, 'Aj malý traffic môže priniesť hodnotné leady – kvalita > kvantita.'],
  ];

  for (const [q, opts, ci, exp] of q2) {
    db.prepare('INSERT INTO quiz_questions (id,module_id,question,options,correct_index,explanation) VALUES (?,?,?,?,?,?)')
      .run(uuidv4(), m2, q, JSON.stringify(opts), ci, exp);
  }

  db.prepare('INSERT INTO training_modules (id,order_num,title,subtitle,content,pass_score) VALUES (?,?,?,?,?,?)').run(
    m3, 3, 'Záverečný test', 'Preukáž svoje znalosti – potrebuješ 80%',
    `## Záverečný test

Tento test overuje kombináciu produktových znalostí aj predajných zručností.

Potrebuješ **80%** na získanie certifikátu Neoworkly Sales.

Úspešné absolvovanie ti otvorí prístup k plnej verzii platformy a zaradí ťa do predajného tímu.

**Tip:** Ak si nie istý, vráť sa k predchádzajúcim modulom.`, 80
  );

  const q3 = [
    ['Ktorý plán je vhodný pre agentúru predávajúcu chatboty klientom?', ['Pro €37/mes','White Label €97/mes','Person Add-on €27/mes','Extra kredity €8'], 1, 'White Label umožňuje predaj chatbotov pod vlastnou značkou.'],
    ['Reštaurácia: "Naši zákazníci nás volajú, nepotrebujeme chat." Ako reagujete?', ['"Máte pravdu."','"Volania vás zaberajú čas. Chatbot odpovie na 80% otázok a uvoľní vás."','"Skúste to aspoň mesiac."','"Máme aj telefonickú integráciu."'], 1, 'Prefrámujte argument – chatbot elimináciou hovorov ušetrí čas.'],
    ['Koľko krokov môže mať follow-up sekvencia?', ['2','3','5','10'], 2, 'Follow-up sekvencia môže mať až 5 krokov.'],
    ['Zákazník vyskúšal chatbot a zákazníci ho nepoužívali. Čo odpovedáte?', ['"To sa stáva, chatboty nefungujú všade."','"Neoworkly má proaktívne oslovenie – chatbot sa sám ozve po X sekundách."','"Potrebujete viac trafficu."','"Skúste iný produkt."'], 1, 'Proaktívne oslovenie je kľúčová funkcia – chatbot sa ozve ako prvý.'],
    ['Zákazník nie je rozhodovateľ. Čo urobíte?', ['Ukončíte hovor','"Rozumiete produktu vy?" a predáte jemu','Požiadate ho aby vás prepojil s rozhodovateľom','Pošlete mu email pre šéfa'], 2, 'Vždy sa snažte dostať k rozhodovateľovi – najlepšie cez spoločný call.'],
    ['Kedy odporučiť Person Add-on?', ['Každému zákazníkovi','Len veľkým firmám','Koučom, konzultantom, speakerom – kde osobná značka hrá rolu','Len e-shopom'], 2, 'Person Add-on je ideálny pre osobné značky kde je dôležité "kto" hovorí.'],
    ['Zákazník pýta zľavu. Ako reagujete?', ['Dáte 20% zľavu','Neponúkate zľavu – ponúknete ročné predplatné alebo ukážete ROI','Poviete že zľavy nemáte a zavesíte','Pošlete zľavový kód emailom'], 1, 'Namiesto zľavy ponúknite ročné predplatné (2 mesiace zadarmo) alebo preukážte ROI.'],
    ['Ako funguje auto-reload kreditov?', ['Manuálne – zákazník dobíja ručne','Automaticky keď kredity klesnú pod limit – dobíje sa z uloženej karty','Každý mesiac fixne','Len ak zákazník zavolá podpore'], 1, 'Auto-reload automaticky dobíja kredity keď klesnú pod nastavený limit.'],
    ['Zákazník: "Musím sa poradiť s partnerom/manželom." Čo urobíte?', ['Počkáte','Pošlete email','Navrhnete spoločný call kde vysvetlíte všetko obom','Dáte im 2 týždne'], 2, 'Spoločný call eliminuje "stratenú informáciu" – obaja počujú rovnaké argumenty.'],
    ['Čo poslať zákazníkovi do 30 minút po hovore?', ['Nič – počkáte na neho','Faktúru','Follow-up email so zhrnutím a konkrétnym next step','Odkaz na web Neoworkly'], 2, 'Rýchly follow-up email udržiava momentum a ukazuje profesionalitu.'],
    ['E-shop zákazník – aký use case zdôraznite?', ['SEO audit','24/7 odpovede na otázky o produktoch a zachytávanie zákazníkov pri nákupe','Rezervačný systém','Instagram integrácia'], 1, 'Pre e-shop je kľúčové 24/7 zachytávanie zákazníkov pri rozhodovaní o kúpe.'],
    ['Zákazník chce free trial. Neoworkly ho nemá. Čo poviete?', ['"Bohužiaľ nemáme, prepáčte."','"Máme 30-dňovú garanciu vrátenia peňazí."','"Nemáme trial, ale ak chatbot nezachytí ani jedného zákazníka, vrátim peniaze osobne."','"Skúste konkurenciu."'], 2, 'Osobná garancia je silnejšia ako formálny trial – buduje dôveru.'],
    ['Čo je hlavný rozdiel Pro vs White Label?', ['Cena','White Label má vlastnú značku a 40 widgetov pre predaj klientom','Počet AI odpovedí','Integrácie'], 1, 'White Label je pre agentúry: vlastná značka + 40 widgetov + predaj klientom.'],
    ['Ako funguje rezervačný systém?', ['Zákazník vyplní formulár na webe','Chatbot zbiera dátum/čas/email v konverzácii a rezervuje automaticky','Zákazník volá na recepciu','Email s dostupnými termínmi'], 1, 'Chatbot zbiera údaje konverzačne a rezervuje slot priamo v Google Calendar.'],
    ['Zákazník hovorí "AI chatboty sú neosobné." Ako reagujete?', ['"Máte pravdu, chatboty majú limity."','"Neoworkly má Person Add-on – chatbot hovorí štýlom konkrétnej osoby."','"Zákazníci si zvyknú."','"Chatbot je lepší ako ľudia."'], 1, 'Person Add-on priamo rieši túto námietku – chatbot môže byť veľmi osobný.'],
  ];

  for (const [q, opts, ci, exp] of q3) {
    db.prepare('INSERT INTO quiz_questions (id,module_id,question,options,correct_index,explanation) VALUES (?,?,?,?,?,?)')
      .run(uuidv4(), m3, q, JSON.stringify(opts), ci, exp);
  }
}

module.exports = { getDb, initDatabase };
