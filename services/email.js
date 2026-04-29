'use strict';

const nodemailer = require('nodemailer');

function createTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT || '587', 10),
    secure: parseInt(SMTP_PORT || '587', 10) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

/**
 * Send email notification when a new lead is created.
 * @param {object} opts
 * @param {string} opts.toEmail       - recipient (widget owner's email)
 * @param {string} opts.ownerName     - widget owner's name
 * @param {string} opts.widgetName    - name of the widget
 * @param {object} opts.lead          - { name, email, phone, chat_summary }
 */
async function sendLeadNotification({ toEmail, ownerName, widgetName, lead }) {
  const transport = createTransport();
  if (!transport) {
    // SMTP not configured — log and skip silently
    console.log('[email] SMTP not configured, skipping lead notification.');
    return;
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const dashboardUrl = process.env.BASE_URL ? `${process.env.BASE_URL}/dashboard` : 'https://neoworkly.com/dashboard';

  const summaryBlock = lead.chat_summary
    ? `<div style="background:#f0f7ff;border-left:4px solid #2563eb;padding:12px 16px;border-radius:0 8px 8px 0;margin:16px 0;font-size:14px;line-height:1.7;color:#1e293b;">
         <strong style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em">🤖 AI zhrnutie konverzácie</strong><br><br>
         ${lead.chat_summary.replace(/\n/g, '<br>')}
       </div>`
    : '<p style="color:#94a3b8;font-style:italic;font-size:14px;">AI zhrnutie sa generuje, otvorte dashboard pre detail.</p>';

  const phoneRow = lead.phone
    ? `<tr><td style="padding:6px 0;color:#64748b;font-size:14px">📞 Telefón</td><td style="padding:6px 0 6px 16px;font-size:14px;font-weight:600">${lead.phone}</td></tr>`
    : '';

  const html = `
<!DOCTYPE html>
<html lang="sk">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;margin:0;padding:0">
  <div style="max-width:560px;margin:32px auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">

    <div style="background:linear-gradient(135deg,#2563eb,#7c3aed);padding:28px 32px">
      <div style="font-size:22px;font-weight:800;color:white;letter-spacing:-0.5px">Neoworkly</div>
      <div style="color:rgba(255,255,255,0.8);font-size:14px;margin-top:4px">Nový kontakt zo chatbota</div>
    </div>

    <div style="padding:28px 32px">
      <p style="color:#374151;font-size:15px;margin:0 0 8px">Ahoj <strong>${ownerName}</strong>,</p>
      <p style="color:#64748b;font-size:14px;margin:0 0 24px">Zákazník zanechal kontakt cez chatbot <strong>${widgetName}</strong>.</p>

      <div style="background:#f8fafc;border-radius:12px;padding:20px 24px;margin-bottom:20px">
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:6px 0;color:#64748b;font-size:14px">👤 Meno</td><td style="padding:6px 0 6px 16px;font-size:14px;font-weight:600">${lead.name}</td></tr>
          <tr><td style="padding:6px 0;color:#64748b;font-size:14px">✉️ Email</td><td style="padding:6px 0 6px 16px;font-size:14px;font-weight:600"><a href="mailto:${lead.email}" style="color:#2563eb">${lead.email}</a></td></tr>
          ${phoneRow}
        </table>
      </div>

      ${summaryBlock}

      <a href="${dashboardUrl}" style="display:inline-block;background:#2563eb;color:white;font-weight:700;font-size:15px;padding:13px 28px;border-radius:10px;text-decoration:none;margin-top:8px">
        Otvoriť dashboard →
      </a>
    </div>

    <div style="padding:20px 32px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px">
      Táto správa bola odoslaná automaticky systémom Neoworkly · <a href="${dashboardUrl}" style="color:#94a3b8">neoworkly.com</a>
    </div>
  </div>
</body>
</html>`;

  const text = `Nový kontakt zo chatbota ${widgetName}\n\nMeno: ${lead.name}\nEmail: ${lead.email}${lead.phone ? `\nTelefón: ${lead.phone}` : ''}\n\n${lead.chat_summary ? `AI zhrnutie:\n${lead.chat_summary}` : ''}\n\nDashboard: ${dashboardUrl}`;

  try {
    await transport.sendMail({
      from: `"Neoworkly" <${from}>`,
      to: toEmail,
      subject: `📋 Nový kontakt: ${lead.name} – ${widgetName}`,
      html,
      text,
    });
    console.log(`[email] Lead notification sent to ${toEmail}`);
  } catch (err) {
    console.error('[email] Failed to send lead notification:', err.message);
  }
}

/**
 * Send usage notification at 80% or 100% of monthly limit.
 * @param {object} opts
 * @param {string} opts.toEmail
 * @param {string} opts.ownerName
 * @param {number} opts.pct       - 80 or 100
 * @param {number} opts.extra     - remaining extra credits
 */
async function sendUsageNotification({ toEmail, ownerName, pct, extra }) {
  const transport = createTransport();
  if (!transport) return;

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const dashboardUrl = process.env.BASE_URL ? `${process.env.BASE_URL}/dashboard` : 'https://neoworkly.com/dashboard';
  const is100 = pct >= 100;

  const subject = is100
    ? '⚠️ Mesačný limit AI odpovedí vyčerpaný – dobite kredity'
    : '📊 Využili ste 80 % mesačných AI odpovedí';

  const bodyMsg = is100
    ? `Vyčerpali ste všetkých <strong>1 500 AI odpovedí</strong> zahrnutých v mesačnom pláne. ${extra > 0 ? `Máte ešte <strong>${extra} extra kreditov</strong>.` : 'Chatbot na vašom webe <strong>prestáva odpovedať</strong>, kým si dobijete kredity.'}`
    : `Využili ste <strong>80 % mesačného limitu</strong> (1 200 z 1 500 AI odpovedí). ${extra > 0 ? `Máte k dispozícii <strong>${extra} extra kreditov</strong>.` : 'Zvážte dobíjanie kreditov.'}`;

  const html = `
<!DOCTYPE html>
<html lang="sk">
<head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;margin:0;padding:0">
  <div style="max-width:520px;margin:32px auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:${is100 ? 'linear-gradient(135deg,#dc2626,#b91c1c)' : 'linear-gradient(135deg,#f59e0b,#d97706)'};padding:24px 32px">
      <div style="font-size:20px;font-weight:800;color:white">Neoworkly</div>
      <div style="color:rgba(255,255,255,0.85);font-size:14px;margin-top:4px">${is100 ? 'Limit AI odpovedí vyčerpaný' : '80 % mesačného limitu využité'}</div>
    </div>
    <div style="padding:28px 32px">
      <p style="color:#374151;font-size:15px;margin:0 0 16px">Ahoj <strong>${ownerName}</strong>,</p>
      <p style="color:#374151;font-size:14px;line-height:1.7;margin:0 0 24px">${bodyMsg}</p>
      <a href="${dashboardUrl}" style="display:inline-block;background:#2563eb;color:white;font-weight:700;font-size:15px;padding:13px 28px;border-radius:10px;text-decoration:none">
        Dobiť kredity →
      </a>
    </div>
    <div style="padding:16px 32px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px">
      Neoworkly · <a href="${dashboardUrl}" style="color:#94a3b8">neoworkly.com</a>
    </div>
  </div>
</body>
</html>`;

  try {
    await transport.sendMail({ from: `"Neoworkly" <${from}>`, to: toEmail, subject, html });
    console.log(`[email] Usage notification (${pct}%) sent to ${toEmail}`);
  } catch (err) {
    console.error('[email] Failed to send usage notification:', err.message);
  }
}

/**
 * Auto-reply email to lead after they submit contact form.
 */
async function sendLeadAutoReply({ toEmail, leadName, widgetName, botName, customMessage }) {
  const transport = createTransport();
  if (!transport) return;
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const msg = customMessage || `Ďakujeme za váš záujem! Ozveme sa vám čo najskôr.`;
  const html = `<!DOCTYPE html><html lang="sk"><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;margin:0;padding:0">
  <div style="max-width:520px;margin:32px auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:linear-gradient(135deg,#2563eb,#7c3aed);padding:24px 32px">
      <div style="font-size:20px;font-weight:800;color:white">${widgetName}</div>
      <div style="color:rgba(255,255,255,0.8);font-size:14px;margin-top:4px">Potvrdenie prijatia správy</div>
    </div>
    <div style="padding:28px 32px">
      <p style="color:#374151;font-size:15px;margin:0 0 16px">Ahoj <strong>${leadName}</strong>,</p>
      <p style="color:#374151;font-size:14px;line-height:1.7;margin:0 0 24px;white-space:pre-line">${msg.replace(/\n/g,'<br>')}</p>
      <p style="color:#94a3b8;font-size:13px;margin:0">— Tím ${widgetName}</p>
    </div>
  </div>
</body></html>`;
  try {
    await transport.sendMail({ from: `"${botName || widgetName}" <${from}>`, to: toEmail, subject: `Ďakujeme, ${leadName}! Správa prijatá.`, html, text: msg });
    console.log(`[email] Auto-reply sent to ${toEmail}`);
  } catch (err) { console.error('[email] Auto-reply failed:', err.message); }
}

/**
 * Manual follow-up email to a lead.
 */
async function sendFollowUp({ toEmail, leadName, ownerName, widgetName, message }) {
  const transport = createTransport();
  if (!transport) return;
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const html = `<!DOCTYPE html><html lang="sk"><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;margin:0;padding:0">
  <div style="max-width:520px;margin:32px auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:linear-gradient(135deg,#0f172a,#1e293b);padding:24px 32px">
      <div style="font-size:20px;font-weight:800;color:white">${widgetName}</div>
    </div>
    <div style="padding:28px 32px">
      <p style="color:#374151;font-size:15px;margin:0 0 16px">Ahoj <strong>${leadName}</strong>,</p>
      <p style="color:#374151;font-size:14px;line-height:1.7;margin:0 0 24px;white-space:pre-line">${message.replace(/\n/g,'<br>')}</p>
      <p style="color:#64748b;font-size:13px;margin:0">S pozdravom,<br><strong>${ownerName}</strong></p>
    </div>
  </div>
</body></html>`;
  try {
    await transport.sendMail({ from: `"${ownerName}" <${from}>`, to: toEmail, subject: `Správa od ${ownerName} – ${widgetName}`, html, text: message });
    console.log(`[email] Follow-up sent to ${toEmail}`);
  } catch (err) { console.error('[email] Follow-up failed:', err.message); }
}

/**
 * Team member invite email.
 */
async function sendTeamInvite({ toEmail, ownerName, inviteUrl }) {
  const transport = createTransport();
  if (!transport) return;
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const html = `<!DOCTYPE html><html lang="sk"><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;margin:0;padding:0">
  <div style="max-width:520px;margin:32px auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:linear-gradient(135deg,#2563eb,#7c3aed);padding:24px 32px">
      <div style="font-size:20px;font-weight:800;color:white">Neoworkly</div>
      <div style="color:rgba(255,255,255,0.8);font-size:14px;margin-top:4px">Pozvánka do tímu</div>
    </div>
    <div style="padding:28px 32px">
      <p style="color:#374151;font-size:15px;margin:0 0 16px">Dobrý deň,</p>
      <p style="color:#374151;font-size:14px;line-height:1.7;margin:0 0 24px"><strong>${ownerName}</strong> vás pozýva do tímu na platforme Neoworkly.</p>
      <a href="${inviteUrl}" style="display:inline-block;background:#2563eb;color:white;font-weight:700;font-size:15px;padding:13px 28px;border-radius:10px;text-decoration:none">Prijať pozvánku →</a>
    </div>
  </div>
</body></html>`;
  try {
    await transport.sendMail({ from: `"Neoworkly" <${from}>`, to: toEmail, subject: `${ownerName} vás pozýva do Neoworkly`, html });
    console.log(`[email] Team invite sent to ${toEmail}`);
  } catch (err) { console.error('[email] Team invite failed:', err.message); }
}

/**
 * Password reset email.
 */
async function sendPasswordReset({ toEmail, resetUrl }) {
  const transport = createTransport();
  if (!transport) {
    console.log('[email] SMTP not configured, skipping password reset email.');
    return;
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const html = `<!DOCTYPE html><html lang="sk"><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;margin:0;padding:0">
  <div style="max-width:520px;margin:32px auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:linear-gradient(135deg,#2563eb,#7c3aed);padding:24px 32px">
      <div style="font-size:20px;font-weight:800;color:white">Neoworkly</div>
      <div style="color:rgba(255,255,255,0.8);font-size:14px;margin-top:4px">Obnova hesla</div>
    </div>
    <div style="padding:28px 32px">
      <p style="color:#374151;font-size:15px;margin:0 0 16px">Dostali sme žiadosť o obnovu hesla pre váš účet.</p>
      <p style="color:#64748b;font-size:14px;line-height:1.7;margin:0 0 24px">Kliknite na tlačidlo nižšie a nastavte si nové heslo. Odkaz je platný <strong>1 hodinu</strong>.</p>
      <a href="${resetUrl}" style="display:inline-block;background:#2563eb;color:white;font-weight:700;font-size:15px;padding:13px 28px;border-radius:10px;text-decoration:none">
        Nastaviť nové heslo →
      </a>
      <p style="color:#94a3b8;font-size:12px;margin:24px 0 0;line-height:1.6">Ak ste o obnovu hesla nežiadali, tento email ignorujte. Vaše heslo zostane nezmenené.</p>
    </div>
    <div style="padding:16px 32px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px">
      Neoworkly · <a href="https://neoworkly.com" style="color:#94a3b8">neoworkly.com</a>
    </div>
  </div>
</body></html>`;
  const text = `Obnova hesla\n\nKliknite na odkaz pre nastavenie nového hesla (platný 1 hodinu):\n${resetUrl}\n\nAk ste o obnovu nežiadali, ignorujte tento email.`;
  try {
    await transport.sendMail({ from: `"Neoworkly" <${from}>`, to: toEmail, subject: 'Obnova hesla – Neoworkly', html, text });
    console.log(`[email] Password reset sent to ${toEmail}`);
  } catch (err) { console.error('[email] Password reset failed:', err.message); }
}

async function sendWinbackEmail({ toEmail, name }) {
  const transport = createTransport();
  if (!transport) return;
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const baseUrl = process.env.BASE_URL || 'https://neoworkly.com';
  const subject = 'Chýbate nám v Neoworkly – vráťte sa a získajte výhodu';
  const html = `
<!DOCTYPE html>
<html lang="sk">
<head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;margin:0;padding:0">
  <div style="max-width:520px;margin:32px auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:linear-gradient(135deg,#2563eb,#7c3aed);padding:24px 32px">
      <div style="font-size:20px;font-weight:800;color:white">Neoworkly</div>
      <div style="color:rgba(255,255,255,0.85);font-size:14px;margin-top:4px">Váš AI chatbot na vás čaká</div>
    </div>
    <div style="padding:28px 32px">
      <p style="color:#374151;font-size:15px;margin:0 0 16px">Ahoj <strong>${name}</strong>,</p>
      <p style="color:#374151;font-size:14px;line-height:1.7;margin:0 0 16px">
        Všimli sme si, že ste zrušili predplatné Neoworkly. Úprimne nás to mrzí – a chceli by sme vás späť.
      </p>
      <p style="color:#374151;font-size:14px;line-height:1.7;margin:0 0 24px">
        Váš chatbot vie zachytávať leady, odpovedať zákazníkom a predávať 24/7 — kým vy spíte. Stačí ho znova spustiť.
      </p>
      <a href="${baseUrl}/onboarding" style="display:inline-block;background:linear-gradient(135deg,#2563eb,#7c3aed);color:white;font-weight:700;font-size:15px;padding:13px 28px;border-radius:10px;text-decoration:none">
        Obnoviť predplatné →
      </a>
      <p style="font-size:0.78rem;color:#94a3b8;margin:1.25rem 0 0">
        Máte otázky? Odpovedzte na tento email — radi pomôžeme.
      </p>
    </div>
    <div style="padding:16px 32px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px">
      Neoworkly · <a href="${baseUrl}" style="color:#94a3b8">neoworkly.com</a>
    </div>
  </div>
</body>
</html>`;
  try {
    await transport.sendMail({ from: `"Neoworkly" <${from}>`, to: toEmail, subject, html });
    console.log(`[email] Winback email sent to ${toEmail}`);
  } catch (err) { console.error('[email] Winback email failed:', err.message); }
}

module.exports = { sendLeadNotification, sendUsageNotification, sendLeadAutoReply, sendFollowUp, sendTeamInvite, sendPasswordReset, sendWinbackEmail };
