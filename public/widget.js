/* NeuraDeskApp Embeddable Widget v1.0
 * Vložte tento súbor na váš web a chatbot sa automaticky zobrazí.
 * Usage:
 *   <script>window.NeuraDeskConfig = { widgetId: 'YOUR_WIDGET_ID' };</script>
 *   <script src="https://neuradesk.online/widget.js" async></script>
 */
(function () {
  'use strict';

  const BASE_URL = (function () {
    const scripts = document.getElementsByTagName('script');
    const me = scripts[scripts.length - 1];
    try { return new URL(me.src).origin; } catch { return 'https://neuradesk.online'; }
  })();

  const cfg = window.NeuraDeskConfig || {};
  const WIDGET_ID = cfg.widgetId;
  if (!WIDGET_ID) { console.warn('[NeuraDeskApp] Chýba widgetId v NeuraDeskConfig.'); return; }

  /* ── Styles ─────────────────────────────────────────────────── */
  const CSS = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }

    #nd-launcher {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483000;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 16px rgba(0,0,0,0.22);
      transition: transform 0.2s, box-shadow 0.2s;
      outline: none;
    }
    #nd-launcher:hover { transform: scale(1.08); box-shadow: 0 6px 20px rgba(0,0,0,0.28); }
    #nd-launcher svg { width: 26px; height: 26px; fill: white; transition: opacity 0.2s; }

    /* Proactive bubble */
    #nd-proactive-bubble {
      position: fixed;
      bottom: 90px;
      right: 24px;
      z-index: 2147483000;
      max-width: 260px;
      background: white;
      border-radius: 14px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.16);
      padding: 0.75rem 1rem;
      font-size: 0.875rem;
      color: #1e293b;
      line-height: 1.5;
      cursor: pointer;
      animation: ndBubbleIn 0.35s cubic-bezier(0.34,1.56,0.64,1);
      border: 1px solid #e2e8f0;
    }
    #nd-proactive-bubble::after {
      content: '';
      position: absolute;
      bottom: -8px;
      right: 20px;
      width: 14px;
      height: 14px;
      background: white;
      border-right: 1px solid #e2e8f0;
      border-bottom: 1px solid #e2e8f0;
      transform: rotate(45deg);
    }
    #nd-proactive-close {
      position: absolute;
      top: 6px; right: 8px;
      background: none; border: none; cursor: pointer;
      color: #94a3b8; font-size: 1rem; line-height: 1; padding: 2px 4px;
      border-radius: 4px;
    }
    #nd-proactive-close:hover { color: #64748b; }
    @keyframes ndBubbleIn {
      from { opacity: 0; transform: translateY(16px) scale(0.9); }
      to   { opacity: 1; transform: none; }
    }

    #nd-window {
      position: fixed;
      bottom: 92px;
      right: 24px;
      z-index: 2147483000;
      width: 380px;
      max-height: 600px;
      background: white;
      border-radius: 16px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.18);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transition: opacity 0.22s, transform 0.22s;
    }
    #nd-window.nd-hidden { opacity: 0; pointer-events: none; transform: translateY(12px) scale(0.97); }

    /* Header */
    #nd-header {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      padding: 0.9rem 1rem;
      flex-shrink: 0;
    }
    #nd-avatar {
      width: 36px; height: 36px;
      border-radius: 50%;
      background: rgba(255,255,255,0.25);
      display: flex; align-items: center; justify-content: center;
      font-size: 1.1rem;
      flex-shrink: 0;
      overflow: hidden;
    }
    #nd-avatar img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
    #nd-header-info { flex: 1; }
    #nd-bot-name { font-size: 0.95rem; font-weight: 700; color: white; }
    #nd-status { font-size: 0.75rem; color: rgba(255,255,255,0.8); display: flex; align-items: center; gap: 0.3rem; }
    #nd-status-dot { width: 7px; height: 7px; background: #4ade80; border-radius: 50%; }
    #nd-close {
      background: none; border: none; color: rgba(255,255,255,0.8);
      cursor: pointer; font-size: 1.3rem; line-height: 1; padding: 0.2rem;
      border-radius: 6px; transition: background 0.15s;
    }
    #nd-close:hover { background: rgba(255,255,255,0.15); color: white; }

    /* Messages */
    #nd-messages {
      flex: 1;
      overflow-y: auto;
      padding: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
      scroll-behavior: smooth;
      background: #f8fafc;
    }
    #nd-messages::-webkit-scrollbar { width: 4px; }
    #nd-messages::-webkit-scrollbar-track { background: transparent; }
    #nd-messages::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 2px; }

    .nd-msg {
      max-width: 85%;
      padding: 0.6rem 0.85rem;
      border-radius: 12px;
      font-size: 0.875rem;
      line-height: 1.55;
      word-wrap: break-word;
      animation: ndFadeIn 0.18s ease;
    }
    @keyframes ndFadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    .nd-msg-bot { background: white; color: #1e293b; align-self: flex-start; border: 1px solid #e2e8f0; border-bottom-left-radius: 4px; }
    .nd-msg-user { color: white; align-self: flex-end; border-bottom-right-radius: 4px; }
    .nd-msg-bot.nd-typing { color: #94a3b8; font-style: italic; }

    /* Suggested questions */
    #nd-suggestions {
      padding: 0.5rem 1rem 0.75rem;
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      background: #f8fafc;
    }
    #nd-suggestions-label { font-size: 0.72rem; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.1rem; }
    .nd-chip {
      background: white;
      border: 1.5px solid #e2e8f0;
      border-radius: 20px;
      padding: 0.42rem 0.85rem;
      font-size: 0.82rem;
      color: #374151;
      cursor: pointer;
      text-align: left;
      transition: border-color 0.15s, background 0.15s;
      font-family: inherit;
    }
    .nd-chip:hover { border-color: var(--nd-primary); background: #eff6ff; color: var(--nd-primary); }

    /* CTA Banner */
    #nd-cta {
      margin: 0 0.75rem 0.75rem;
      padding: 0.7rem 0.9rem;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      font-size: 0.82rem;
      display: none;
    }
    #nd-cta-text { flex: 1; color: #374151; }
    #nd-cta-btn {
      padding: 0.45rem 1rem;
      border: none;
      border-radius: 8px;
      font-size: 0.82rem;
      font-weight: 700;
      cursor: pointer;
      color: white;
      white-space: nowrap;
      flex-shrink: 0;
      font-family: inherit;
    }

    /* Input area */
    #nd-input-area {
      display: flex;
      align-items: flex-end;
      gap: 0.5rem;
      padding: 0.75rem;
      border-top: 1px solid #e2e8f0;
      background: white;
      flex-shrink: 0;
    }
    #nd-input {
      flex: 1;
      border: 1.5px solid #e2e8f0;
      border-radius: 22px;
      padding: 0.55rem 1rem;
      font-size: 0.875rem;
      outline: none;
      resize: none;
      max-height: 120px;
      overflow-y: auto;
      font-family: inherit;
      color: #1e293b;
      line-height: 1.5;
      transition: border-color 0.2s;
    }
    #nd-input:focus { border-color: var(--nd-primary); }
    #nd-input::placeholder { color: #94a3b8; }
    #nd-send {
      width: 38px; height: 38px;
      border-radius: 50%;
      border: none;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer;
      flex-shrink: 0;
      transition: opacity 0.2s, transform 0.15s;
    }
    #nd-send:hover { transform: scale(1.08); }
    #nd-send:disabled { opacity: 0.45; cursor: not-allowed; transform: none; }
    #nd-send svg { width: 18px; height: 18px; fill: white; }

    /* Contact form overlay */
    #nd-contact-overlay {
      position: absolute;
      inset: 0;
      background: white;
      z-index: 10;
      display: flex;
      flex-direction: column;
      padding: 1.25rem;
      display: none;
    }
    #nd-contact-overlay h3 { font-size: 1rem; font-weight: 700; color: #1e293b; margin-bottom: 0.25rem; }
    #nd-contact-overlay p { font-size: 0.82rem; color: #64748b; margin-bottom: 1.25rem; }
    .nd-field { margin-bottom: 0.75rem; }
    .nd-field label { display: block; font-size: 0.78rem; font-weight: 600; color: #374151; margin-bottom: 0.3rem; }
    .nd-field input {
      width: 100%; padding: 0.55rem 0.8rem;
      border: 1.5px solid #d1d5db; border-radius: 8px;
      font-size: 0.875rem; outline: none; font-family: inherit;
    }
    .nd-field input:focus { border-color: var(--nd-primary); }
    .nd-contact-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
    .nd-btn-full {
      flex: 1; padding: 0.6rem; border: none; border-radius: 8px;
      font-size: 0.875rem; font-weight: 600; cursor: pointer; font-family: inherit;
    }
    .nd-btn-cancel { background: #f1f5f9; color: #374151; }
    .nd-btn-submit { color: white; }
    .nd-success-msg { text-align: center; padding: 2rem 1rem; }
    .nd-success-msg .nd-check { font-size: 2.5rem; margin-bottom: 0.75rem; }
    .nd-success-msg h3 { font-size: 1rem; font-weight: 700; color: #15803d; margin-bottom: 0.4rem; }
    .nd-success-msg p { font-size: 0.82rem; color: #64748b; }

    @media (max-width: 420px) {
      #nd-window { right: 10px; bottom: 80px; width: calc(100vw - 20px); max-height: 70vh; }
      #nd-launcher { right: 12px; bottom: 12px; }
      #nd-proactive-bubble { right: 10px; max-width: calc(100vw - 80px); }
    }
  `;

  /* ── Icons ──────────────────────────────────────────────────── */
  const ICON_CHAT = `<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>`;
  const ICON_CLOSE = `<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
  const ICON_SEND = `<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`;

  /* ── State ──────────────────────────────────────────────────── */
  let config = null;
  let isOpen = false;
  let isTyping = false;
  let sessionId = null;
  let history = [];          // [{role, content}, ...]
  let ctaShown = false;
  let msgCount = 0;
  let proactiveDismissed = false;

  /* ── Shadow DOM setup ───────────────────────────────────────── */
  const host = document.createElement('div');
  host.id = 'nd-host';
  const shadow = host.attachShadow({ mode: 'open' });

  const styleEl = document.createElement('style');
  shadow.appendChild(styleEl);

  /* ── Build DOM ──────────────────────────────────────────────── */
  function buildDOM() {
    const primary = config.primary_color || '#2563eb';

    shadow.host.style.setProperty('--nd-primary', primary);
    styleEl.textContent = CSS.replace(/var\(--nd-primary\)/g, primary);

    shadow.innerHTML = '';
    shadow.appendChild(styleEl);

    // Launcher button
    const launcher = elem('button', { id: 'nd-launcher', title: 'Otvoriť chat', style: `background:${primary}` },
      ICON_CHAT
    );
    launcher.addEventListener('click', toggleChat);
    shadow.appendChild(launcher);

    // Chat window
    const win = elem('div', { id: 'nd-window', class: 'nd-hidden' }, `
      <div id="nd-header" style="background:${primary}">
        <div id="nd-avatar">${config.avatar_url ? `<img src="${config.avatar_url}" alt="">` : '🤖'}</div>
        <div id="nd-header-info">
          <div id="nd-bot-name">${esc(config.bot_name)}</div>
          <div id="nd-status"><span id="nd-status-dot"></span> Online</div>
        </div>
        <button id="nd-close" title="Zavrieť">${ICON_CLOSE}</button>
      </div>
      <div id="nd-messages"></div>
      <div id="nd-suggestions" style="display:none">
        <div id="nd-suggestions-label">Rýchle otázky</div>
      </div>
      <div id="nd-cta" style="background:#f0fdf4;border:1px solid #bbf7d0;display:none">
        <span id="nd-cta-text"></span>
        <button id="nd-cta-btn" style="background:${primary}"></button>
      </div>
      <div id="nd-input-area">
        <textarea id="nd-input" rows="1" placeholder="Napíšte správu..."></textarea>
        <button id="nd-send" style="background:${primary}">${ICON_SEND}</button>
      </div>
      <div id="nd-contact-overlay"></div>
    `);
    shadow.appendChild(win);

    // Wire events
    shadow.getElementById('nd-close').addEventListener('click', toggleChat);
    shadow.getElementById('nd-send').addEventListener('click', handleSend);
    shadow.getElementById('nd-input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });
    shadow.getElementById('nd-input').addEventListener('input', autoResize);

    // Add welcome message
    addBotMessage(config.welcome_message || 'Ahoj! Ako vám môžem pomôcť?');

    // Render suggested questions
    renderSuggestions();

    // Proactive bubble
    if (config.proactive_enabled && config.proactive_message) {
      const delay = (config.proactive_delay || 4) * 1000;
      setTimeout(() => {
        if (isOpen || proactiveDismissed) return;
        showProactiveBubble(config.proactive_message);
      }, delay);
    }
  }

  /* ── Proactive Bubble ───────────────────────────────────────── */
  function showProactiveBubble(message) {
    if (shadow.getElementById('nd-proactive-bubble')) return; // already shown

    const primary = config.primary_color || '#2563eb';
    const bubble = elem('div', { id: 'nd-proactive-bubble' });
    bubble.innerHTML = `
      <button id="nd-proactive-close" title="Zavrieť">✕</button>
      <div style="padding-right:1rem">${esc(message)}</div>
      <div style="margin-top:0.4rem;font-size:0.78rem;font-weight:600;color:${primary}">Napísať →</div>
    `;

    shadow.appendChild(bubble);

    bubble.addEventListener('click', (e) => {
      if (e.target.id === 'nd-proactive-close') {
        dismissBubble();
        return;
      }
      dismissBubble();
      if (!isOpen) toggleChat();
    });

    shadow.getElementById('nd-proactive-close').addEventListener('click', (e) => {
      e.stopPropagation();
      dismissBubble();
    });
  }

  function dismissBubble() {
    proactiveDismissed = true;
    const b = shadow.getElementById('nd-proactive-bubble');
    if (b) {
      b.style.opacity = '0';
      b.style.transform = 'translateY(8px)';
      b.style.transition = 'opacity 0.2s, transform 0.2s';
      setTimeout(() => b.remove(), 220);
    }
  }

  /* ── Toggle ─────────────────────────────────────────────────── */
  function toggleChat() {
    isOpen = !isOpen;
    dismissBubble();
    const win = shadow.getElementById('nd-window');
    const launcher = shadow.getElementById('nd-launcher');
    win.classList.toggle('nd-hidden', !isOpen);
    launcher.innerHTML = isOpen ? ICON_CLOSE : ICON_CHAT;
    if (isOpen) {
      shadow.getElementById('nd-input').focus();
      scrollToBottom();
    }
  }

  /* ── Suggestions ────────────────────────────────────────────── */
  function renderSuggestions() {
    const container = shadow.getElementById('nd-suggestions');
    const qs = config.suggested_questions || [];
    if (!qs.length) return;

    qs.forEach(q => {
      const chip = elem('button', { class: 'nd-chip' }, esc(q));
      chip.addEventListener('click', () => {
        hideSuggestions();
        sendMessage(q);
      });
      container.appendChild(chip);
    });
    container.style.display = '';
  }

  function hideSuggestions() {
    const s = shadow.getElementById('nd-suggestions');
    if (s) s.style.display = 'none';
  }

  /* ── Markdown renderer (bold, italic, newlines only) ────────── */
  function renderMarkdown(text) {
    return esc(text)
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');
  }

  /* ── Messages ───────────────────────────────────────────────── */
  function addBotMessage(text, isStreaming = false) {
    const msgs = shadow.getElementById('nd-messages');
    const div = elem('div', { class: `nd-msg nd-msg-bot${isStreaming ? ' nd-typing' : ''}` });
    if (isStreaming) {
      div.textContent = text;
    } else {
      div.innerHTML = renderMarkdown(text);
    }
    msgs.appendChild(div);
    scrollToBottom();
    return div;
  }

  function addUserMessage(text) {
    const msgs = shadow.getElementById('nd-messages');
    const primary = config.primary_color || '#2563eb';
    const div = elem('div', { class: 'nd-msg nd-msg-user', style: `background:${primary}` });
    div.textContent = text;
    msgs.appendChild(div);
    scrollToBottom();
  }

  function scrollToBottom() {
    const msgs = shadow.getElementById('nd-messages');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
  }

  /* ── Send ───────────────────────────────────────────────────── */
  function handleSend() {
    const input = shadow.getElementById('nd-input');
    const text = input.value.trim();
    if (!text || isTyping) return;
    input.value = '';
    input.style.height = '';
    sendMessage(text);
  }

  async function sendMessage(text) {
    if (isTyping) return;
    hideSuggestions();
    isTyping = true;
    msgCount++;

    // Add user message to UI and history
    addUserMessage(text);
    history.push({ role: 'user', content: text });

    setSendDisabled(true);

    // Show typing indicator
    const typingEl = addBotMessage('…', true);

    try {
      const payload = {
        message: text,
        sessionId,
        history: history.slice(-20).slice(0, -1), // all but current message
        pageContext: { url: window.location.href, title: document.title },
      };

      const response = await fetch(`${BASE_URL}/api/widget/${WIDGET_ID}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        typingEl.textContent = 'Ospravedlňujem sa, nastala chyba. Skúste to prosím neskôr.';
        typingEl.classList.remove('nd-typing');
        isTyping = false;
        setSendDisabled(false);
        return;
      }

      // Stream SSE response
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let buffer = '';
      let first = true;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;

          try {
            const parsed = JSON.parse(raw);
            if (parsed.error) {
              typingEl.textContent = parsed.error;
              typingEl.classList.remove('nd-typing');
            } else if (parsed.done) {
              // Stream finished — render markdown on final text
              const final = parsed.fullText || fullText;
              typingEl.innerHTML = renderMarkdown(final);
              history.push({ role: 'assistant', content: final });
              maybeShowCta();
            } else if (parsed.text) {
              if (first) {
                typingEl.textContent = '';
                typingEl.classList.remove('nd-typing');
                first = false;
              }
              fullText += parsed.text;
              typingEl.textContent = fullText;
              scrollToBottom();
            }
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (err) {
      typingEl.textContent = 'Prepáčte, nie je možné sa spojiť so serverom.';
      typingEl.classList.remove('nd-typing');
    }

    isTyping = false;
    setSendDisabled(false);
    shadow.getElementById('nd-input').focus();
  }

  /* ── CTA ────────────────────────────────────────────────────── */
  function maybeShowCta() {
    if (ctaShown || msgCount < 2) return;
    if (!config.cta_type || config.cta_type === 'none') return;

    ctaShown = true;
    const primary = config.primary_color || '#2563eb';
    const ctaEl = shadow.getElementById('nd-cta');
    const textEl = shadow.getElementById('nd-cta-text');
    const btnEl = shadow.getElementById('nd-cta-btn');

    switch (config.cta_type) {
      case 'call': {
        const phone = (config.cta_config || {}).phone || '';
        textEl.textContent = 'Chcete sa poradiť osobne?';
        btnEl.textContent = '📞 Zavolať';
        btnEl.addEventListener('click', () => { window.open(`tel:${phone}`, '_self'); });
        ctaEl.style.display = 'flex';
        break;
      }
      case 'contact': {
        const label = (config.cta_config || {}).label || 'Zanechajte kontakt';
        textEl.textContent = 'Máte záujem? Ozveme sa vám!';
        btnEl.textContent = '✉️ ' + label;
        btnEl.addEventListener('click', showContactForm);
        ctaEl.style.display = 'flex';
        break;
      }
      case 'custom': {
        const customText = (config.cta_config || {}).text || '';
        if (!customText) return;
        textEl.textContent = customText;
        btnEl.style.display = 'none';
        ctaEl.style.display = 'flex';
        break;
      }
    }
  }

  /* ── Contact Form ───────────────────────────────────────────── */
  function showContactForm() {
    const primary = config.primary_color || '#2563eb';
    const overlay = shadow.getElementById('nd-contact-overlay');
    overlay.innerHTML = `
      <h3>Zanechajte kontakt</h3>
      <p>Ozveme sa vám čo najskôr.</p>
      <div class="nd-field"><label>Meno *</label><input type="text" id="nd-cf-name" placeholder="Vaše meno" required></div>
      <div class="nd-field"><label>Email *</label><input type="email" id="nd-cf-email" placeholder="vas@email.sk" required></div>
      <div class="nd-field"><label>Telefón</label><input type="tel" id="nd-cf-phone" placeholder="+421 900 000 000"></div>
      <div class="nd-field nd-gdpr-row">
        <label style="display:flex;align-items:flex-start;gap:0.5rem;font-size:0.78rem;font-weight:400;color:#374151;cursor:pointer">
          <input type="checkbox" id="nd-cf-gdpr" style="margin-top:2px;width:14px;height:14px;flex-shrink:0" required>
          <span>Súhlasím so spracovaním osobných údajov za účelom spätného kontaktu.*</span>
        </label>
      </div>
      <div class="nd-contact-actions">
        <button class="nd-btn-full nd-btn-cancel" id="nd-cf-cancel">Zrušiť</button>
        <button class="nd-btn-full nd-btn-submit" id="nd-cf-submit" style="background:${primary}">Odoslať</button>
      </div>
    `;
    overlay.style.display = 'flex';
    overlay.style.flexDirection = 'column';
    shadow.getElementById('nd-cf-cancel').addEventListener('click', () => { overlay.style.display = 'none'; });
    shadow.getElementById('nd-cf-submit').addEventListener('click', submitContactForm);
  }

  function submitContactForm() {
    const nameEl = shadow.getElementById('nd-cf-name');
    const emailEl = shadow.getElementById('nd-cf-email');
    const phoneEl = shadow.getElementById('nd-cf-phone');
    const gdprEl = shadow.getElementById('nd-cf-gdpr');
    const name = nameEl?.value.trim();
    const email = emailEl?.value.trim();
    const phone = phoneEl?.value.trim();
    const gdprConsent = gdprEl?.checked;

    if (!name || !email) {
      if (!name && nameEl) nameEl.style.borderColor = '#dc2626';
      if (!email && emailEl) emailEl.style.borderColor = '#dc2626';
      return;
    }
    if (!gdprConsent) {
      if (gdprEl) gdprEl.style.outline = '2px solid #dc2626';
      return;
    }

    const overlay = shadow.getElementById('nd-contact-overlay');
    overlay.innerHTML = `
      <div class="nd-success-msg">
        <div class="nd-check">✅</div>
        <h3>Ďakujeme!</h3>
        <p>Ozveme sa vám čo najskôr, ${esc(name)}.</p>
      </div>
    `;
    setTimeout(() => { overlay.style.display = 'none'; }, 3000);

    // Save lead to backend (fire and forget)
    fetch(`${BASE_URL}/api/widget/${widgetId}/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, phone: phone || undefined, sessionId, gdprConsent: true })
    }).catch(() => { /* ignore network errors */ });
  }

  /* ── Helpers ────────────────────────────────────────────────── */
  function setSendDisabled(disabled) {
    const btn = shadow.getElementById('nd-send');
    if (btn) btn.disabled = disabled;
  }

  function autoResize() {
    const ta = shadow.getElementById('nd-input');
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  }

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function elem(tag, attrs = {}, innerHTML = '') {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else el.setAttribute(k, v);
    }
    if (innerHTML) el.innerHTML = innerHTML;
    return el;
  }

  /* ── Session ID ─────────────────────────────────────────────── */
  function getSessionId() {
    const key = `nd_session_${WIDGET_ID}`;
    let sid = sessionStorage.getItem(key);
    if (!sid) {
      sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem(key, sid);
    }
    return sid;
  }

  /* ── Bootstrap ──────────────────────────────────────────────── */
  async function init() {
    try {
      const res = await fetch(`${BASE_URL}/api/widget/${WIDGET_ID}/config`);
      if (!res.ok) { console.warn('[NeuraDeskApp] Widget nenájdený alebo neaktívny.'); return; }
      config = await res.json();
    } catch (err) {
      console.warn('[NeuraDeskApp] Nepodarilo sa načítať konfiguráciu:', err.message);
      return;
    }

    sessionId = getSessionId();
    document.body.appendChild(host);
    buildDOM();
  }

  // Wait for DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
