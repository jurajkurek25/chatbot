# Prechod z Neoworkly Funnel do Neoworkly (sekcia Funnely)

Samostatná aplikácia Neoworkly Funnel beží po novom ako súčasť Neoworkly. Klienti sa prihlasujú do
Neoworkly, funnely spravujú v sekcii **Funnely** a Stripe v sekcii **Platby**. Snippety na ich weboch
fungujú ďalej bez zmeny, lebo ID obchodníkov (`m_…`) aj adresa API zostávajú rovnaké.

## Čo sa stane s klientmi

| Klient vo funneli | Po prechode |
| --- | --- |
| nemá účet Neoworkly | dostane nový účet s **rovnakým e-mailom a heslom** (heslo sa pri prvom prihlásení prevedie na bcrypt) |
| má zapnuté 2FA | prihlásenie do Neoworkly od neho pýta kód z aplikácie alebo záložný kód |
| platí starých 4 € mesačne | Funnely používa ďalej bez predplatného Neoworkly; predplatné spravuje v sekcii Platby (tlačidlo „Spravovať predplatné“) |
| má aj účet Neoworkly s rovnakým e-mailom | skript ho iba **vypíše**; prepojíš ho s `--link-existing` (pozri nižšie) |

Funnely sú pre nových klientov súčasťou predplatného Neoworkly (aj skúšobného obdobia).

## Postup

### 1. Záloha a premenné prostredia

1. Zastav starý funnel (`pm2 stop` / `docker compose stop`), aby počas presunu nevznikali nové údaje.
2. Skopíruj jeho databázu (`DATABASE_FILE`, predvolene `data/neoworkly.db`) na server Neoworkly,
   napr. do `~/funnel-backup/neoworkly.db`. Pri Postgres (`DATABASE_URL`) daj vedieť – skript číta SQLite.
3. Zálohuj databázu Neoworkly (`data/neoworkly.db` alebo `NEOWORKLY_DB_FILE`).
4. Do `.env` Neoworkly prenes z `.env` funnela:

| Funnel | Neoworkly |
| --- | --- |
| `TOTP_ENCRYPTION_KEYS` | `TOTP_ENCRYPTION_KEYS` (rovnaká hodnota) |
| `COOKIE_SECRET` | `COOKIE_SECRET` (rovnaká hodnota – starší šifrovací kľúč) |
| `STRIPE_SECRET_KEY` | `STRIPE_CONNECT_SECRET_KEY` (ak je funnel na inom Stripe účte ako Neoworkly) |
| `STRIPE_PUBLISHABLE_KEY` | `STRIPE_PUBLISHABLE_KEY` |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | `STRIPE_CONNECT_WEBHOOK_SECRET` |
| `STRIPE_WEBHOOK_SECRET` (predplatné 4 €) | `FUNNEL_STRIPE_WEBHOOK_SECRET` |
| `STRIPE_SUBSCRIPTION_PRICE_ID` | `FUNNEL_SUBSCRIPTION_PRICE_ID` |
| `STRIPE_TEST_SECRET_KEY`, `STRIPE_TEST_PUBLISHABLE_KEY` | rovnaké názvy |
| `PUBLIC_URL` (napr. `https://funnel.neoworkly.com`) | `PUBLIC_URL` – nechaj **starú doménu funnela**, nové snippety tak budú rovnaké ako staré |
| `SMTP_URL`, `MAIL_FROM` | netreba – funnel posiela cez SMTP Neoworkly (`SMTP_*`) |

Ak `TOTP_ENCRYPTION_KEYS` alebo `COOKIE_SECRET` nesedí, skript skončí chybou „Nedá sa dešifrovať …“
a nič neuloží.

### 2. Skúška a presun

```bash
# najprv skúška – nič neuloží, iba vypíše, čo by spravil
node scripts/migrate-funnel.js ~/funnel-backup/neoworkly.db --dry-run
# presun
node scripts/migrate-funnel.js ~/funnel-backup/neoworkly.db
```

Pri konfliktoch (rovnaký e-mail už má účet Neoworkly) over, že ide o toho istého človeka
(e-mail v Neoworkly sa pri registrácii neoveruje), a potom spusti znova s `--link-existing`.
Opakované spustenie je bezpečné – už presunutých obchodníkov preskočí.

### 3. Doména funnela

Snippety na weboch klientov volajú API na starej doméne (napr. `https://funnel.neoworkly.com/api/f/…`).
Doménu nasmeruj na server Neoworkly:

- **DNS**: záznam `funnel` (A/CNAME) na server Neoworkly, alebo
- **reverse proxy** (Caddy/Nginx/CloudPanel): pridaj doménu funnela k webu Neoworkly a vystav pre ňu
  HTTPS certifikát. Príklad Caddy:

  ```
  neoworkly.com, funnel.neoworkly.com {
    reverse_proxy localhost:3000
  }
  ```

Staré záložky `https://funnel.neoworkly.com/app` presmerujú na `APP_URL/dashboard?view=funnels`.

### 4. Stripe

1. **Connect webhook** (Dashboard → Developers → Webhooks, endpoint s udalosťami pripojených účtov):
   zmeň URL na `https://neoworkly.com/api/webhook/connect` (alebo ponechaj starú doménu) a **pridaj
   udalosti** `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.expired`, `charge.refunded` – cez ne chodia platby rezervácií a digitálnych
   produktov. `account.updated` a `account.application.deauthorized` ostávajú.
2. **Webhook predplatného 4 €** (`/api/webhook`) môže ostať na starej doméne; jeho tajomstvo je
   `FUNNEL_STRIPE_WEBHOOK_SECRET`.
3. Ak funnel a Neoworkly používajú **ten istý Stripe účet**: hlavný webhook Neoworkly
   (`/api/stripe/webhook`) predplatné s cenou `FUNNEL_SUBSCRIPTION_PRICE_ID` ignoruje, takže starých
   4 € neaktivuje predplatné Neoworkly. Preto musí byť `FUNNEL_SUBSCRIPTION_PRICE_ID` nastavené.
4. **Connect → Settings → Branding a redirect**: návratové adresy onboardingu sú teraz
   `https://neoworkly.com/dashboard?stripe=return`.

### 5. Spustenie a kontrola

```bash
pm2 restart neoworkly   # alebo ako spúšťaš Neoworkly
```

- otvor `https://funnel.neoworkly.com/demo/<m_id>/<krok>` niektorého klienta – snippet sa načíta,
- prihlás sa ako klient (testovací účet) – vidí sekciu Funnely so svojimi krokmi a štatistikami,
- v Stripe → Webhooks skontroluj, že udalosti dostávajú odpoveď 200.

Starý funnel nechaj vypnutý aspoň pár týždňov aj so zálohou databázy; po overení ho zmaž.

## Klientom napíš

> Neoworkly Funnel je odteraz súčasťou Neoworkly. Prihlásite sa na neoworkly.com rovnakým e-mailom
> a heslom, funnely nájdete v sekcii Funnely. Snippety na vašom webe netreba meniť. Ak platíte
> predplatné Funnel, platí ďalej; s predplatným Neoworkly máte Funnely v cene.
