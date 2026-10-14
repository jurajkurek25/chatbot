'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
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
const ecomailRoutes     = require('./routes/ecomail');
const paymentsRoutes    = require('./routes/payments');
const shopRoutes        = require('./routes/shop');
const driveRoutes       = require('./routes/drive');

const app = express();
const PORT = process.env.PORT || 3000;

initDatabase();

app.use(cors());
app.use(compression());

// Funnely (Express 5 podaplikácia): /api/f, /api/funnels, /demo a Stripe webhooky funnela.
// Pred express.json() – webhooky potrebujú surové telo a funnel si parsuje telá sám.
app.use(require('./funnel').createApp());

// Stripe webhook MUST receive raw body — mount before express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// Grafika: návrhy s obrázkami potrebujú väčšie telo (vlastný parser v routeri)
app.use('/api/graphics', require('./routes/graphics'));

// rawBody is kept for webhook signature checks (Meta)
app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
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
app.use('/api/payments', paymentsRoutes);
app.use('/api/shop', shopRoutes);
app.use('/api/drive', driveRoutes);
app.use('/api/marketing', require('./routes/marketing'));
app.use('/api/realtime', require('./routes/realtime'));
// Tímová sada: úlohy, kalendár, poznámky, dokumenty
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/calendar', require('./routes/calendar'));
app.use('/api/notes', require('./routes/notes'));
app.use('/api/docs', require('./routes/docs'));
app.use('/api/teamchat', require('./routes/teamchat'));
app.use('/api/meet', require('./routes/meet'));
app.use('/api/forms', require('./routes/forms'));
app.use('/api/boards', require('./routes/boards'));
app.use('/api/sheets', require('./routes/sheets'));
app.use('/api/lead-magnets', leadMagnetsRoutes);
app.use('/api/insights',    insightsRoutes);
app.use('/api/facebook',    facebookRoutes);
app.use('/api/ecomail',     ecomailRoutes);
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
app.get('/book/:widgetId', (req, res) => {
  // Allow booking page to be embedded in iframes on any domain
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.sendFile(path.join(__dirname, 'public', 'booking.html'));
});
app.get('/booking/manage/:token', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'booking-manage.html'))
);
app.get('/p/:productId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'product.html')));
app.get('/members/:storeId', (req, res) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.sendFile(path.join(__dirname, 'public', 'members.html'));
});
app.get('/form/:token', (req, res) => {
  // Formulár sa dá vložiť na web klienta (iframe)
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.sendFile(path.join(__dirname, 'public', 'form.html'));
});
app.get('/docs/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'doc.html')));
app.get('/boards/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'board.html')));
app.get('/sheets/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sheet.html')));
app.get('/graphics/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'graphic.html')));
app.get('/s/:token', (req, res) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});
app.get('/wellbeing/:token', (req, res) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.sendFile(path.join(__dirname, 'public', 'wellbeing.html'));
});

// 404 handler — must be last
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

const server = app.listen(PORT, () => {
  console.log(`Neoworkly running on http://localhost:${PORT}`);
  require('./services/bookingNotify').startReminderScheduler();
  require('./services/wellbeing').startBurnoutScheduler();
  require('./services/bookingPayments').startHoldSweeper();
  require('./funnel/src/retention').scheduleRetention(); // štatistiky funnelov staršie ako 13 mesiacov
  require('./services/marketing').startScheduler(); // kampane, automatické série (Resend)
  require('./services/tasks').startScheduler(); // pripomienky úloh
  // Kôš Disku: položky staršie ako 30 dní sa zmažú natrvalo (raz za deň)
  const purge = () => { try { require('./services/drive').purgeTrash(); } catch (e) { console.error('[drive purge]', e.message); } };
  setTimeout(purge, 60 * 1000).unref();
  setInterval(purge, 24 * 3600 * 1000).unref();
});

// Spolupráca v reálnom čase (/ws, /yjs) na tom istom porte; pri vypnutí uloží otvorené dokumenty
require('./services/realtime').attach(server);
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => { require('./services/realtime').flushAll(); process.exit(0); });
}
