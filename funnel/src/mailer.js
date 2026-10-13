// E-maily funnela (oznámenia o objednávkach, Stripe účet) cez SMTP hlavnej Neoworkly (SMTP_HOST…).
// Bez SMTP sa iba vypíšu do konzoly – vhodné na lokálny vývoj.
const { createTransport } = require('../../services/email');

async function sendMail({ to, subject, text }) {
  const transport = createTransport();
  if (!transport) {
    console.log(`\n[e-mail] Komu: ${to}\nPredmet: ${subject}\n\n${text}\n`);
    return;
  }
  await transport.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
}

module.exports = { sendMail };
