// Udalosti štatistík sa neuchovávajú navždy (GDPR – minimalizácia, a veľkosť databázy):
// raz denne sa zmažú staršie ako STATS_RETENTION_DAYS (predvolene 395 dní = 13 mesiacov).
const db = require('./db');

const DAY = 24 * 60 * 60 * 1000;
const MIN_DAYS = 90; // štatistiky v dashboarde ukazujú až 90 dní dozadu

function retentionDays() {
  const days = Number(process.env.STATS_RETENTION_DAYS || 395);
  if (!Number.isInteger(days) || days < MIN_DAYS) {
    throw new Error(`STATS_RETENTION_DAYS musí byť celé číslo aspoň ${MIN_DAYS}.`);
  }
  return days;
}

const pruneOldEvents = (now = Date.now()) => db.pruneEvents(now - retentionDays() * DAY);

// Pri štarte servera a potom raz denne (na viacerých serveroch neprekáža – mazanie je idempotentné)
function scheduleRetention() {
  const days = retentionDays(); // zlé nastavenie zastaví štart, nie až mazanie o deň
  const run = () =>
    pruneOldEvents()
      .then((deleted) => deleted && console.log(`Zmazané udalosti štatistík staršie ako ${days} dní: ${deleted}`))
      .catch((err) => console.error('Mazanie starých udalostí zlyhalo:', err.message));
  run();
  return setInterval(run, DAY).unref();
}

module.exports = { pruneOldEvents, retentionDays, scheduleRetention };
