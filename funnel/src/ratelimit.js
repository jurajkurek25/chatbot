// Obmedzenie počtu požiadaviek (pevné okno), počítadlá v pamäti procesu.
const MINUTE = 60 * 1000;

function memoryStore() {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
  }, MINUTE).unref();
  return {
    // Vráti [počet v aktuálnom okne, ms do konca okna]
    async hit(key, windowMs) {
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || entry.reset <= now) {
        entry = { count: 0, reset: now + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      return [entry.count, entry.reset - now];
    },
    async reset() {
      hits.clear();
    },
  };
}

const store = memoryStore(); // jedna inštancia servera (SQLite) => počítadlá v pamäti

// Middleware: limits = [{ name, max, windowMs, key: (req) => string }]; všetky musia prejsť
function rateLimit(...limits) {
  return async (req, res, next) => {
    for (const { name, max, windowMs, key } of limits) {
      let count, msLeft;
      try {
        [count, msLeft] = await store.hit(`${name}:${key(req)}`, windowMs);
      } catch (err) {
        // Chyba počítadla nesmie zastaviť predaj – limit sa dočasne preskočí
        console.error(`Rate limit ${name} nedostupný:`, err.message);
        continue;
      }
      if (count > max) {
        res.set('Retry-After', String(Math.ceil(msLeft / 1000)));
        return res.status(429).json({ error: 'Príliš veľa pokusov. Skús to prosím neskôr.' });
      }
    }
    next();
  };
}

const byIp = (req) => req.ip;

// Iba pre testy: vyčistí všetky počítadlá
const resetRateLimits = () => store.reset();

// Pri vypínaní servera
const closeRateLimits = async () => {
  if (store.close) await store.close();
};

module.exports = { rateLimit, byIp, MINUTE, resetRateLimits, closeRateLimits };
