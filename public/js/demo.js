'use strict';

const token = localStorage.getItem('nd_token');
if (!token) window.location.href = '/';

// If already subscribed, skip demo and go straight to dashboard
(async () => {
  try {
    const r = await fetch('/api/stripe/status', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.ok) {
      const d = await r.json();
      if (d.active) { window.location.href = '/dashboard'; return; }
    }
  } catch (_) {}
})();

function fillExample(el) {
  document.getElementById('demo-business').value = el.textContent;
  document.getElementById('demo-business').focus();
}

document.getElementById('demo-business').addEventListener('keydown', e => {
  if (e.key === 'Enter') startDemo();
});

async function startDemo() {
  const business = document.getElementById('demo-business').value.trim();
  if (!business) {
    document.getElementById('demo-business').focus();
    return;
  }

  // Show loading
  document.getElementById('step-input').style.display = 'none';
  document.getElementById('demo-loading').style.display = 'block';
  document.getElementById('step-demo').style.display = 'none';
  document.getElementById('demo-cta').style.display = 'none';

  try {
    const res = await fetch('/api/demo/simulate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ business, lang: window.i18n?.currentLang() || 'sk' }),
    });

    const data = await res.json();
    if (!res.ok || !data.messages) throw new Error(data.error || 'Chyba');

    // Update subtitle
    document.getElementById('demo-chat-subtitle').textContent =
      `Simulácia predajného chatu pre: ${business}`;

    // Hide loading, show demo chat
    document.getElementById('demo-loading').style.display = 'none';
    document.getElementById('step-demo').style.display = 'block';
    document.getElementById('demo-messages').innerHTML = '';

    // Animate messages one by one
    await animateMessages(data.messages);

    // Show CTA after all messages
    document.getElementById('demo-cta').style.display = 'block';
    document.getElementById('demo-cta').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  } catch (err) {
    document.getElementById('demo-loading').style.display = 'none';
    document.getElementById('step-input').style.display = 'block';
    alert('Nastala chyba: ' + err.message);
  }
}

async function animateMessages(messages) {
  const container = document.getElementById('demo-messages');

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isBot = msg.role === 'bot';

    // Show typing indicator for bot messages
    if (isBot) {
      const typing = createTypingIndicator();
      container.appendChild(typing);
      container.scrollTop = container.scrollHeight;
      await sleep(900 + Math.random() * 600);
      container.removeChild(typing);
    } else {
      await sleep(400);
    }

    // Add message bubble
    const el = createMessageEl(msg.role, msg.text);
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;

    // Pause between messages
    const pause = isBot ? 500 : 300;
    await sleep(pause);
  }
}

function createMessageEl(role, text) {
  const isBot = role === 'bot';
  const div = document.createElement('div');
  div.className = `demo-msg ${role}`;
  div.innerHTML = `
    <div class="demo-msg-icon">${isBot ? '🤖' : '👤'}</div>
    <div class="demo-msg-bubble">${escHtml(text)}</div>
  `;
  return div;
}

function createTypingIndicator() {
  const div = document.createElement('div');
  div.className = 'demo-msg bot typing-indicator';
  div.innerHTML = `
    <div class="demo-msg-icon">🤖</div>
    <div class="typing-dots">
      <span></span><span></span><span></span>
    </div>
  `;
  return div;
}

function restartDemo() {
  document.getElementById('step-demo').style.display = 'none';
  document.getElementById('demo-cta').style.display = 'none';
  document.getElementById('demo-messages').innerHTML = '';
  document.getElementById('step-input').style.display = 'block';
  document.getElementById('demo-business').focus();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
