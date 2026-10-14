#!/usr/bin/env node
'use strict';
/**
 * Jednorazový presun klientov zo samostatnej aplikácie Neoworkly Funnel (SQLite súbor) do Neoworkly.
 *
 *   node scripts/migrate-funnel.js /cesta/k/funnel/neoworkly.db [--dry-run] [--link-existing]
 *
 * - ID obchodníkov (m_…) zostávajú => snippety na weboch klientov fungujú ďalej bez zmeny.
 * - Klient bez účtu Neoworkly dostane nový účet s rovnakým e-mailom a heslom (scrypt hash sa
 *   pri prvom prihlásení prevedie na bcrypt); 2FA z funnela platí aj pri prihlásení do Neoworkly.
 * - Staré predplatné za 4 € zostáva (platform_customer_id, subscription_status) a dáva prístup
 *   k Funnelom aj bez predplatného Neoworkly.
 * - Ak už účet Neoworkly s rovnakým e-mailom existuje, prepojí sa iba s --link-existing (e-mail
 *   v Neoworkly nie je overený – over si, že ide o toho istého človeka). Inak sa iba vypíše.
 * - Opakované spustenie preskočí už presunutých obchodníkov.
 *
 * Pred spustením nastav v .env Neoworkly TOTP_ENCRYPTION_KEYS a COOKIE_SECRET z funnela –
 * inak sa nedajú dešifrovať 2FA tajomstvá a Stripe kľúče (skript to overí a skončí).
 */
const crypto = require('crypto');
const Database = require('better-sqlite3');

function migrate(file, { dryRun = false, linkExisting = false, log = console.log } = {}) {
  require('../funnel'); // predvolené premenné prostredia funnela (COOKIE_SECRET…)
  const { initDatabase, getDb } = require('../db/database');
  initDatabase();
  const funnelDb = require('../funnel/src/db');
  funnelDb.getMerchantByUserSync('-'); // vytvorí/doplní tabuľky funnela
  const totp = require('../funnel/src/totp');
  const db = getDb();

  const old = new Database(file, { readonly: true, fileMustExist: true });
  const merchants = old.prepare('SELECT * FROM merchants ORDER BY created_at').all();
  const targetColumns = db.prepare('PRAGMA table_info(funnel_merchants)').all().map((c) => c.name);
  const eventColumns = db.prepare('PRAGMA table_info(funnel_events)').all().map((c) => c.name).filter((c) => c !== 'id');
  const oldEventColumns = old.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
  const report = { migrated: [], linked: [], skipped: [], conflicts: [], events: 0 };

  // Zašifrované údaje musia ísť dešifrovať kľúčmi Neoworkly (rovnaké TOTP_ENCRYPTION_KEYS / COOKIE_SECRET)
  for (const m of merchants) {
    for (const column of ['totp_secret', 'totp_pending', 'stripe_api_key']) {
      if (!m[column]) continue;
      try {
        totp.decrypt(m[column]);
      } catch {
        throw new Error(`Nedá sa dešifrovať ${column} obchodníka ${m.id}. Nastav TOTP_ENCRYPTION_KEYS a COOKIE_SECRET z funnela.`);
      }
    }
  }

  const run = db.transaction(() => {
    for (const m of merchants) {
      const email = String(m.email).trim().toLowerCase();
      if (db.prepare('SELECT 1 FROM funnel_merchants WHERE id = ?').get(m.id)) {
        report.skipped.push({ id: m.id, email, reason: 'už presunutý' });
        continue;
      }
      let user = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email);
      if (user && !linkExisting) {
        report.conflicts.push({ id: m.id, email, reason: 'účet Neoworkly s týmto e-mailom už existuje (spusti s --link-existing)' });
        continue;
      }
      if (user) {
        // Prázdny funnel vytvorený pri otvorení sekcie Funnely nahradí presunutý
        const current = db.prepare('SELECT * FROM funnel_merchants WHERE neoworkly_user_id = ?').get(user.id);
        if (current) {
          const funnel = JSON.parse(current.funnel);
          const used = Object.keys(funnel.products || {}).length || Object.keys(funnel.steps || {}).length || current.stripe_account_id
            || db.prepare('SELECT 1 FROM funnel_events WHERE merchant_id = ?').get(current.id);
          if (used) {
            report.conflicts.push({ id: m.id, email, reason: `účet Neoworkly už má vlastný funnel ${current.id}` });
            continue;
          }
          db.prepare('DELETE FROM funnel_merchants WHERE id = ?').run(current.id);
        }
        report.linked.push({ id: m.id, email, userId: user.id });
      } else {
        user = { id: crypto.randomUUID() };
        const created = Math.floor(new Date(m.created_at).getTime() / 1000) || Math.floor(Date.now() / 1000);
        db.prepare(`INSERT INTO users (id, email, password_hash, name, subscription_status, onboarding_done, created_at)
                    VALUES (?, ?, ?, ?, 'inactive', 1, ?)`)
          .run(user.id, email, m.password_hash || '!', email.split('@')[0], created);
        report.migrated.push({ id: m.id, email, userId: user.id });
      }

      const row = { ...m, email, neoworkly_user_id: user.id };
      const columns = targetColumns.filter((c) => c in row);
      db.prepare(`INSERT INTO funnel_merchants (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
        .run(...columns.map((c) => row[c]));

      const copy = eventColumns.filter((c) => oldEventColumns.includes(c));
      const insert = db.prepare(`INSERT INTO funnel_events (${copy.join(', ')}) VALUES (${copy.map(() => '?').join(', ')})`);
      for (const e of old.prepare('SELECT * FROM events WHERE merchant_id = ? ORDER BY id').iterate(m.id)) {
        insert.run(...copy.map((c) => e[c]));
        report.events += 1;
      }
    }
    if (dryRun) throw Object.assign(new Error('dry-run'), { dryRun: true });
  });

  try {
    run();
  } catch (err) {
    if (!err.dryRun) throw err;
  } finally {
    old.close();
  }

  log(`${dryRun ? '[skúška – nič sa neuložilo] ' : ''}Nové účty: ${report.migrated.length}, prepojené: ${report.linked.length}, `
    + `preskočené: ${report.skipped.length}, konflikty: ${report.conflicts.length}, udalosti: ${report.events}`);
  for (const c of report.conflicts) log(`  ! ${c.email} (${c.id}): ${c.reason}`);
  return report;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Použitie: node scripts/migrate-funnel.js <funnel.db> [--dry-run] [--link-existing]');
    process.exit(1);
  }
  try {
    migrate(file, { dryRun: args.includes('--dry-run'), linkExisting: args.includes('--link-existing') });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { migrate };
