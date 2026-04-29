'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { initDatabase } = require('./db/database');
const authRoutes = require('./routes/auth');
const widgetRoutes = require('./routes/widgets');
const knowledgeRoutes = require('./routes/knowledge');
const chatRoutes = require('./routes/chat');
const stripeRoutes = require('./routes/stripe');
const instagramRoutes = require('./routes/instagram');
const affiliateRoutes = require('./routes/affiliate');
const { router: creditsRoutes } = require('./routes/credits');
const productsRoutes = require('./routes/products');
const shopifyRoutes  = require('./routes/shopify');
const demoRoutes     = require('./routes/demo');
const coachRoutes    = require('./routes/coach');
const scraperRoutes  = require('./routes/scraper');
const bookingRoutes  = require('./routes/booking');
const teamRoutes        = require('./routes/team');
const woocommerceRoutes = require('./routes/woocommerce');
const leadMagnetsRoutes = require('./routes/lead-magnets');
const insightsRoutes    = require('./routes/insights');
const facebookRoutes    = require('./routes/facebook');
const whatsappRoutes    = require('./routes/whatsapp');
const sequencesRoutes   = require('./routes/sequences');
const ecomailRoutes     = require('./routes/ecomail');
const seoRoutes         = require('./routes/seo');
const moneyRoutes       = require('./routes/money');
const reactivationRoutes = require('./routes/reactivation');
const personRoutes       = require('./routes/person');
const emailRoutes        = require('./routes/email');
const { router: giftCardRoutes } = require('./routes/gift-cards');

const app = express();
const PORT = process.env.PORT || 3000;

initDatabase();

app.use(cors());

// Stripe webhook MUST receive raw body — mount before express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '10mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// widget.js: short cache so customers always get fresh translations
app.get('/widget.js', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'widget.js'));
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/widgets', widgetRoutes);
app.use('/api/knowledge', knowledgeRoutes);
app.use('/api/widget', chatRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/instagram', instagramRoutes);
app.use('/api/affiliate', affiliateRoutes);
app.use('/api/credits', creditsRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/demo', demoRoutes);
app.use('/api/coach', coachRoutes);
app.use('/api/scraper', scraperRoutes);
app.use('/api/booking', bookingRoutes);
app.use('/api/lead-magnets', leadMagnetsRoutes);
app.use('/api/insights',    insightsRoutes);
app.use('/api/facebook',    facebookRoutes);
app.use('/api/whatsapp',    whatsappRoutes);
app.use('/api/sequences',   sequencesRoutes);
app.use('/api/ecomail',     ecomailRoutes);
app.use('/api/seo',         seoRoutes);
app.use('/api/money',       moneyRoutes);
app.use('/api/reactivation', reactivationRoutes);
app.use('/api/person',      personRoutes);
app.use('/api/email',       emailRoutes);
app.use('/api/gift-cards',  giftCardRoutes);
app.use('/api/team',        teamRoutes);
app.use('/api/woocommerce', woocommerceRoutes);
// Team invite accept (public, no auth needed on GET)
app.get('/team/accept/:token', (req, res) => res.redirect(`/api/team/accept/${req.params.token}`));

// Shopify integration (OAuth + setup + scan)
// IMPORTANT: webhook uninstall must receive raw body — mount before express.json() would affect it,
// but since we apply express.raw() inside the route handler itself it's fine here.
app.use('/shopify', shopifyRoutes);
app.use('/api/shopify', shopifyRoutes);
// Widget loader script (called from Shopify storefront via ScriptTag)
app.get('/shopify-widget-loader.js', (req, res) => {
  const widgetId = req.query.widget || '';
  const origin   = (process.env.APP_URL || 'https://neoworkly.com').replace(/\/$/, '');
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(`(function(){if(window.__neoworklyLoaded)return;window.__neoworklyLoaded=true;window.NeoworklyConfig={widgetId:${JSON.stringify(widgetId)}};var s=document.createElement('script');s.src=${JSON.stringify(origin+'/widget.js')};s.async=true;document.head.appendChild(s);})();`);
});

// Page routes
app.get('/dashboard', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'))
);
app.get('/onboarding', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'onboarding.html'))
);
app.get('/demo', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'demo.html'))
);
app.get('/darcek', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'darcek.html'))
);
app.get('/book/:widgetId', (req, res) => {
  // Allow booking page to be embedded in iframes on any domain
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.sendFile(path.join(__dirname, 'public', 'booking.html'));
});

// 404 handler — must be last
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

app.listen(PORT, () => {
  console.log(`Neoworkly running on http://localhost:${PORT}`);
});

// Process follow-up sequence emails every 5 minutes
setInterval(async () => {
  try {
    const http = require('http');
    const opts = { hostname: 'localhost', port: PORT, path: '/api/sequences/process', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 0, 'X-Internal-Secret': process.env.INTERNAL_SECRET || '' } };
    const req = http.request(opts);
    req.on('error', () => {});
    req.end();
  } catch {}
}, 5 * 60 * 1000);

// Subscription safety sync every 4 hours: deactivate widgets for inactive subscriptions
// Guards against missed webhooks
setInterval(() => {
  try {
    const { getDb } = require('./db/database');
    const db = getDb();
    const result = db.prepare(`
      UPDATE widgets SET active = 0
      WHERE user_id IN (
        SELECT id FROM users
        WHERE subscription_status = 'inactive'
          AND (free_until IS NULL OR free_until < unixepoch())
      ) AND active = 1
    `).run();
    if (result.changes > 0) {
      console.log(`[sync] Deactivated ${result.changes} widget(s) for inactive subscriptions`);
    }
  } catch (e) {
    console.error('[sync] Subscription sync error:', e.message);
  }
}, 4 * 60 * 60 * 1000);

// Process win-back emails every hour
setInterval(async () => {
  try {
    const { getDb } = require('./db/database');
    const { sendWinbackEmail } = require('./services/email');
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const jobs = db.prepare('SELECT * FROM winback_jobs WHERE sent_at IS NULL AND failed = 0 AND send_at <= ?').all(now);
    for (const job of jobs) {
      try {
        await sendWinbackEmail({ toEmail: job.user_email, name: job.user_name });
        db.prepare('UPDATE winback_jobs SET sent_at = ? WHERE id = ?').run(now, job.id);
      } catch (e) {
        console.error('[winback] Failed to send email for job', job.id, e.message);
        db.prepare('UPDATE winback_jobs SET failed = 1 WHERE id = ?').run(job.id);
      }
    }
    if (jobs.length > 0) console.log(`[winback] Processed ${jobs.length} win-back email(s)`);
  } catch (e) {
    console.error('[winback] Cron error:', e.message);
  }
}, 60 * 60 * 1000);
