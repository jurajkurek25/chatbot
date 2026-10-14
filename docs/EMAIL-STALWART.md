# E-mailové schránky – vlastný mail server Stalwart

Neoworkly zakladá domény klientov a schránky na **vlastnom mail serveri [Stalwart](https://stalw.art)**
(open-source, Rust; IMAP, SMTP, JMAP, antispam, DKIM). Webmail beží priamo v Neoworkly (Pošta),
klienti sa môžu pripojiť aj z telefónu alebo Outlooku cez IMAP/SMTP.

## 1. Server

- Samostatný VPS (odporúčané min. 2 GB RAM), **otvorený port 25** (u poskytovateľa si to overte – mnohí ho blokujú)
  a porty 465 (SMTP), 993 (IMAP), 443 (správa).
- Pevná IPv4 s **reverzným záznamom (PTR)** na `mail.neoworkly.com` – bez neho skončí pošta v spame.
- DNS pre samotný server: `A mail.neoworkly.com → IP`, PTR na IP → `mail.neoworkly.com`.
- Inštalácia podľa oficiálneho návodu Stalwartu (Docker alebo inštalačný skript), certifikát cez ACME (Let's Encrypt).
- Zálohy: dátový adresár Stalwartu (RocksDB / databáza) denne mimo server.

## 2. Prepojenie s Neoworkly

V správe Stalwartu vytvorte **API kľúč** (principal typu API key) s oprávnením spravovať domény,
účty a DKIM. Do `.env` Neoworkly:

```
STALWART_URL=https://mail.neoworkly.com
STALWART_API_KEY=…
MAIL_HOST=mail.neoworkly.com
MAIL_SECRET_KEY=<náhodný dlhý reťazec, nemeniť>
```

`MAIL_SECRET_KEY` šifruje heslá schránok v databáze (webmail sa nimi prihlasuje za používateľa).
Po jeho zmene treba všetkým schránkam vygenerovať nové heslo.

## 3. Overenie API pred spustením ⚠️

Všetky volania Stalwartu sú v jednom súbore **`services/stalwart.js`**. Sú napísané podľa správcovského
REST API Stalwart 0.11–0.15:

| Akcia | Volanie |
|---|---|
| Doména | `POST /api/principal` `{ type: "domain", name }` |
| DKIM | `POST /api/dkim` `{ algorithm: "Ed25519" \| "Rsa", domain }` |
| DNS záznamy | `GET /api/dns/records/{doména}` |
| Schránka | `POST /api/principal` `{ type: "individual", name, secrets, emails, quota }` |
| Heslo | `PATCH /api/principal/{adresa}` `[{ action: "set", field: "secrets", value: [heslo] }]` |
| Zmazanie | `DELETE /api/principal/{meno}` |

Novšie verzie Stalwartu menia model správy (objekty, automatická správa DNS). **Po inštalácii overte tieto
volania voči nainštalovanej verzii** (stačí založiť testovaciu doménu a schránku v Neoworkly → Pošta →
Domény a schránky) a prípadne upravte iba `services/stalwart.js`. Ak server DNS záznamy nevráti,
Neoworkly zobrazí základné (MX, SPF, DMARC); DKIM záznam potom skopírujte zo správy Stalwartu.

## 4. Ako to funguje pre klienta

1. Pošta → Domény a schránky → pridá doménu (napr. `kaviaren.sk`).
2. U registrátora nastaví zobrazené záznamy (MX, SPF, DKIM, DMARC) → „Overiť DNS“.
   Doména je aktívna, keď MX smeruje na `mail.neoworkly.com` a SPF ho povoľuje.
3. Založí schránky (`info@`, `jana@`…) – pridelená schránka patrí jednému kolegovi, nepridelená je spoločná
   pre majiteľa a editorov. Heslo pre telefón sa ukáže pri založení / obnovení.
4. Webmail: čítanie, odpovede, prílohy (aj z Disku), e-mail → úloha, príloha → Disk.

Pozor: ak klient už má poštu inde (napr. Websupport), zmenou MX začne pošta chodiť k nám –
pred prepnutím treba presunúť staré e-maily (napr. imapsync) a vytvoriť rovnaké schránky.
