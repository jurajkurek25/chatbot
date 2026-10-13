// Prešifruje 2FA tajomstvá a tajné Stripe kľúče (aj tajomstvá webhookov) aktuálnym kľúčom (prvým v TOTP_ENCRYPTION_KEYS).
// Postup výmeny kľúča:
//   1. TOTP_ENCRYPTION_KEYS="novy-kluc,stary-kluc" (prvé nasadenie: iba "novy-kluc"; staré
//      záznamy v1 sa dešifrujú cez COOKIE_SECRET) a nasaď
//   2. npm run rotate-encryption-key
//   3. starý kľúč z TOTP_ENCRYPTION_KEYS odober (a ak treba, zmeň COOKIE_SECRET)
const totp = require('../src/totp');

async function rotate(db) {
  if (!process.env.TOTP_ENCRYPTION_KEYS) throw new Error('Nastav TOTP_ENCRYPTION_KEYS (prvý kľúč = nový).');
  let changed = 0;
  for (const merchant of await db.listMerchants()) {
    const fields = {};
    for (const column of ['totp_secret', 'totp_pending', 'stripe_api_key', 'stripe_webhook_secret']) {
      const stored = merchant[column];
      if (stored && totp.needsReencrypt(stored)) fields[column] = totp.encrypt(totp.decrypt(stored));
    }
    if (Object.keys(fields).length) {
      await db.updateMerchant(merchant.id, fields);
      changed += 1;
    }
  }
  return changed;
}

if (require.main === module) {
  require('dotenv').config();
  require('../../db/database').initDatabase();
  const db = require('../src/db');
  rotate(db)
    .then((changed) => console.log(`Prešifrované: ${changed} účtov.`))
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    });
}

module.exports = { rotate };
