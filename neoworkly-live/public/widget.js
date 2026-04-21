(function () {
  'use strict';

  const script = document.currentScript || (function () {
    const scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();

  const WIDGET_KEY = script.getAttribute('data-key');
  const LANG = script.getAttribute('data-lang') || 'sk';
  const SERVER = script.src.replace(/\/widget\.js.*$/, '');

  if (!WIDGET_KEY) return console.warn('[Neoworkly Live] data-key missing');

  // ── Translations ─────────────────────────────────────────────────────────────
  const T = {
    sk: {
      title: 'Live chat podpora',
      subtitle: 'Vyberte si operátora alebo kliknite AUTO',
      auto: 'AUTO',
      name_placeholder: 'Vaše meno alebo prezývka',
      name_hint: 'Môžete zostať anonymní',
      start_chat: 'Začať chat',
      no_operators: 'Momentálne nie je dostupný žiadny operátor.',
      join_queue: 'Vstúpiť do fronty',
      in_queue: 'Ste vo fronte',
      queue_pos: 'Vaša pozícia: #',
      chat_ended: 'Chat bol ukončený.',
      chat_ended_visitor: 'Ukončili ste chat.',
      type_placeholder: 'Napíšte správu…',
      send: 'Odoslať',
      end_chat: 'Ukončiť',
      fullscreen: '⛶',
      minimize: '–',
      close: '✕',
      operator_busy: 'Tento operátor je momentálne zaneprázdnený.',
      connecting: 'Pripájam sa…',
      you: 'Vy',
      bio_label: 'Bio',
    },
    en: {
      title: 'Live chat support',
      subtitle: 'Choose an operator or click AUTO',
      auto: 'AUTO',
      name_placeholder: 'Your name or nickname',
      name_hint: 'You can stay anonymous',
      start_chat: 'Start chat',
      no_operators: 'No operators are available right now.',
      join_queue: 'Join queue',
      in_queue: 'You are in the queue',
      queue_pos: 'Your position: #',
      chat_ended: 'The chat has ended.',
      chat_ended_visitor: 'You ended the chat.',
      type_placeholder: 'Type a message…',
      send: 'Send',
      end_chat: 'End chat',
      fullscreen: '⛶',
      minimize: '–',
      close: '✕',
      operator_busy: 'This operator is currently busy.',
      connecting: 'Connecting…',
      you: 'You',
      bio_label: 'Bio',
    }
  };
  const t = T[LANG] || T.sk;

  // ── Base styles (use CSS variables with fallbacks) ────────────────────────────
  const css = `
    #nlive-btn{position:fixed;bottom:24px;right:24px;z-index:99998;width:60px;height:60px;border-radius:var(--nlive-btn-r,50%);background:linear-gradient(135deg,var(--nlive-p,#0d9488),var(--nlive-s,#0891b2));border:none;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;transition:transform .2s,right .25s,left .25s;}
    #nlive-btn.nlive-left{right:auto;left:24px;}
    #nlive-btn:hover{transform:scale(1.1);}
    #nlive-btn svg{width:28px;height:28px;fill:#fff;}
    #nlive-btn .nlive-notif{position:absolute;top:-2px;right:-2px;width:18px;height:18px;background:#ef4444;border-radius:50%;display:none;align-items:center;justify-content:center;color:#fff;font-size:10px;font-weight:700;}

    #nlive-widget{position:fixed;bottom:96px;right:24px;z-index:99999;width:380px;max-height:600px;background:var(--nlive-bg,#0f172a);border:1px solid rgba(255,255,255,.1);border-radius:var(--nlive-r,20px);box-shadow:0 20px 60px rgba(0,0,0,.6);display:none;flex-direction:column;overflow:hidden;font-family:var(--nlive-font,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif);transition:all .25s,right .25s,left .25s;}
    #nlive-widget.nlive-left{right:auto;left:24px;}
    #nlive-widget.nlive-fullscreen{position:fixed;inset:0;bottom:0;right:0;left:0;width:100%;max-height:100%;border-radius:0;z-index:999999;}

    .nlive-header{background:linear-gradient(135deg,var(--nlive-p,#0d9488),var(--nlive-s,#0891b2));padding:16px 16px 12px;display:flex;align-items:flex-start;justify-content:space-between;}
    .nlive-header-left h3{margin:0;color:#fff;font-size:1rem;font-weight:700;}
    .nlive-header-left p{margin:4px 0 0;color:rgba(255,255,255,.8);font-size:.8rem;}
    .nlive-header-btns{display:flex;gap:6px;}
    .nlive-hbtn{background:rgba(255,255,255,.15);border:none;color:#fff;width:28px;height:28px;border-radius:8px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;}
    .nlive-hbtn:hover{background:rgba(255,255,255,.25);}

    .nlive-body{flex:1;overflow-y:auto;padding:16px;color:var(--nlive-text,#f1f5f9);}
    .nlive-body::-webkit-scrollbar{width:4px;}
    .nlive-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:4px;}

    .nlive-name-row{margin-bottom:12px;}
    .nlive-name-row input{width:100%;background:rgba(255,255,255,.06);border:1.5px solid rgba(255,255,255,.12);border-radius:calc(var(--nlive-r,20px) * .55);color:var(--nlive-text,#f1f5f9);font-size:.9rem;padding:10px 12px;outline:none;font-family:inherit;}
    .nlive-name-row input:focus{border-color:var(--nlive-p,#0d9488);}
    .nlive-name-hint{color:var(--nlive-muted,#94a3b8);font-size:.75rem;margin-top:4px;}
    .nlive-ops-title{color:var(--nlive-muted,#94a3b8);font-size:.8rem;margin-bottom:10px;text-transform:uppercase;letter-spacing:.05em;}
    .nlive-ops-list{display:flex;flex-direction:column;gap:8px;margin-bottom:12px;}
    .nlive-op-card{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.04);border:1.5px solid rgba(255,255,255,.08);border-radius:calc(var(--nlive-r,20px) * .6);padding:10px;cursor:pointer;transition:all .15s;}
    .nlive-op-card:hover,.nlive-op-card.selected{border-color:var(--nlive-p,#0d9488);background:rgba(255,255,255,.07);}
    .nlive-op-avatar{border-radius:50%;background:rgba(255,255,255,.1);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;overflow:hidden;flex-shrink:0;}
    .nlive-op-avatar img{width:100%;height:100%;object-fit:cover;}
    .nlive-op-info{flex:1;min-width:0;}
    .nlive-op-name{color:var(--nlive-text,#f1f5f9);font-weight:600;font-size:.9rem;}
    .nlive-op-status{display:flex;align-items:center;gap:4px;font-size:.75rem;margin-top:2px;}
    .nlive-op-status.online{color:#34d399;}
    .nlive-op-status.busy{color:#f59e0b;}
    .nlive-op-dot{width:6px;height:6px;border-radius:50%;}
    .nlive-op-status.online .nlive-op-dot{background:#34d399;}
    .nlive-op-status.busy .nlive-op-dot{background:#f59e0b;}
    .nlive-op-bio-toggle{background:none;border:none;color:var(--nlive-p,#0d9488);font-size:.75rem;cursor:pointer;padding:0;margin-top:2px;}
    .nlive-op-bio{color:var(--nlive-muted,#94a3b8);font-size:.78rem;margin-top:4px;padding:6px 8px;background:rgba(255,255,255,.04);border-radius:6px;display:none;}
    .nlive-op-bio.open{display:block;}

    .nlive-auto-btn{width:100%;padding:12px;background:linear-gradient(135deg,var(--nlive-p,#0d9488),var(--nlive-s,#0891b2));border:none;border-radius:calc(var(--nlive-r,20px) * .6);color:#fff;font-size:.95rem;font-weight:700;cursor:pointer;margin-bottom:8px;transition:opacity .15s;}
    .nlive-auto-btn:hover{opacity:.9;}
    .nlive-start-btn{width:100%;padding:11px;background:transparent;border:1.5px solid var(--nlive-p,#0d9488);border-radius:calc(var(--nlive-r,20px) * .6);color:var(--nlive-p,#0d9488);font-size:.9rem;font-weight:600;cursor:pointer;transition:all .15s;}
    .nlive-start-btn:hover{background:rgba(255,255,255,.06);}
    .nlive-start-btn:disabled{opacity:.5;cursor:default;}

    .nlive-no-ops{text-align:center;padding:20px 0;}
    .nlive-no-ops-icon{font-size:2.5rem;margin-bottom:8px;}
    .nlive-no-ops p{color:var(--nlive-muted,#94a3b8);font-size:.9rem;margin-bottom:16px;}
    .nlive-queue-btn{width:100%;padding:11px;background:linear-gradient(135deg,#7c3aed,#6d28d9);border:none;border-radius:calc(var(--nlive-r,20px) * .6);color:#fff;font-size:.9rem;font-weight:600;cursor:pointer;}
    .nlive-in-queue{text-align:center;padding:24px 16px;}
    .nlive-in-queue h4{color:var(--nlive-text,#f1f5f9);font-size:1rem;margin-bottom:8px;}
    .nlive-in-queue p{color:var(--nlive-muted,#94a3b8);font-size:.9rem;}
    .nlive-queue-pos{font-size:2rem;font-weight:800;color:#7c3aed;margin:12px 0;}

    .nlive-chat{display:flex;flex-direction:column;height:100%;}
    .nlive-chat-messages{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding-bottom:4px;}
    .nlive-chat-messages::-webkit-scrollbar{width:4px;}
    .nlive-chat-messages::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:4px;}
    .nlive-msg{display:flex;flex-direction:column;max-width:82%;}
    .nlive-msg.out{align-self:flex-end;align-items:flex-end;}
    .nlive-msg.in{align-self:flex-start;align-items:flex-start;}
    .nlive-msg-bubble{padding:10px 14px;border-radius:var(--nlive-msg-r,16px);font-size:.88rem;line-height:1.5;word-break:break-word;}
    .nlive-msg.out .nlive-msg-bubble{background:var(--nlive-user-bubble,linear-gradient(135deg,#0d9488,#0891b2));color:#fff;border-bottom-right-radius:4px;}
    .nlive-msg.in .nlive-msg-bubble{background:var(--nlive-op-bubble,rgba(255,255,255,.08));color:var(--nlive-text,#f1f5f9);border-bottom-left-radius:4px;}
    .nlive-msg-meta{color:#475569;font-size:.7rem;margin-top:3px;}
    .nlive-system-msg{text-align:center;color:#64748b;font-size:.78rem;padding:6px 0;}

    .nlive-chat-input{padding:12px 16px;border-top:1px solid rgba(255,255,255,.08);display:flex;gap:8px;align-items:flex-end;}
    .nlive-chat-input textarea{flex:1;background:rgba(255,255,255,.06);border:1.5px solid rgba(255,255,255,.1);border-radius:calc(var(--nlive-r,20px) * .5);color:var(--nlive-text,#f1f5f9);font-size:.88rem;padding:8px 12px;outline:none;resize:none;font-family:inherit;max-height:120px;}
    .nlive-chat-input textarea:focus{border-color:var(--nlive-p,#0d9488);}
    .nlive-send-btn{background:linear-gradient(135deg,var(--nlive-p,#0d9488),var(--nlive-s,#0891b2));border:none;border-radius:calc(var(--nlive-r,20px) * .5);width:38px;height:38px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;}
    .nlive-send-btn:hover{opacity:.9;}
    .nlive-send-btn svg{width:18px;height:18px;fill:#fff;}
    .nlive-end-btn{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:#f87171;font-size:.75rem;border-radius:8px;padding:4px 10px;cursor:pointer;white-space:nowrap;}
    .nlive-end-btn:hover{background:rgba(239,68,68,.2);}
    .nlive-chat-header-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
  `;
  const styleEl = document.createElement('style');
  styleEl.id = 'nlive-base-style';
  styleEl.textContent = css;
  (document.head || document.documentElement).appendChild(styleEl);

  // ── Config vars injector ──────────────────────────────────────────────────────
  const configStyleEl = document.createElement('style');
  configStyleEl.id = 'nlive-config-style';
  (document.head || document.documentElement).appendChild(configStyleEl);

  const RADIUS_MAP = { sharp: '6px', normal: '16px', rounded: '24px', pill: '999px' };
  const BTN_SHAPE_MAP = { circle: '50%', rounded: '14px', square: '8px' };
  const MSG_RADIUS_MAP = { sharp: '6px', normal: '16px', rounded: '20px', pill: '20px' };
  const FONTS = {
    system: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
    inter: "'Inter',sans-serif",
    poppins: "'Poppins',sans-serif",
    nunito: "'Nunito',sans-serif",
    roboto: "'Roboto',sans-serif",
    lato: "'Lato',sans-serif"
  };
  const GOOGLE_FONTS = { inter: 'Inter:wght@400;600;700', poppins: 'Poppins:wght@400;600;700', nunito: 'Nunito:wght@400;600;700', roboto: 'Roboto:wght@400;500;700', lato: 'Lato:wght@400;700' };

  function applyConfig(cfg, logoUrl) {
    if (!cfg) return;
    const r = RADIUS_MAP[cfg.borderRadius] || RADIUS_MAP.normal;
    const btnR = BTN_SHAPE_MAP[cfg.buttonShape] || BTN_SHAPE_MAP.circle;
    const msgR = MSG_RADIUS_MAP[cfg.borderRadius] || MSG_RADIUS_MAP.normal;
    const font = FONTS[cfg.font] || FONTS.system;
    const pos = cfg.position === 'left' ? 'left' : 'right';
    const userBubble = cfg.userBubbleColor ? `linear-gradient(135deg,${cfg.userBubbleColor},${cfg.userBubbleColor})` : `linear-gradient(135deg,var(--nlive-p,#0d9488),var(--nlive-s,#0891b2))`;

    // Load Google Font if needed
    if (cfg.font && cfg.font !== 'system' && GOOGLE_FONTS[cfg.font]) {
      const fontLink = document.getElementById('nlive-font-link') || document.createElement('link');
      fontLink.id = 'nlive-font-link';
      fontLink.rel = 'stylesheet';
      fontLink.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(GOOGLE_FONTS[cfg.font])}&display=swap`;
      if (!document.getElementById('nlive-font-link')) (document.head || document.documentElement).appendChild(fontLink);
    }

    configStyleEl.textContent = `
      #nlive-btn,#nlive-widget{
        --nlive-p:${cfg.primaryColor || '#0d9488'};
        --nlive-s:${cfg.secondaryColor || '#0891b2'};
        --nlive-bg:${cfg.bgColor || '#0f172a'};
        --nlive-text:${cfg.textColor || '#f1f5f9'};
        --nlive-muted:${cfg.mutedColor || '#94a3b8'};
        --nlive-r:${r};
        --nlive-btn-r:${btnR};
        --nlive-msg-r:${msgR};
        --nlive-font:${font};
        --nlive-user-bubble:${userBubble};
        --nlive-op-bubble:${cfg.opBubbleColor || 'rgba(255,255,255,0.08)'};
      }
      #nlive-btn{${pos === 'left' ? 'right:auto;left:24px;' : 'left:auto;right:24px;'}}
      #nlive-widget{${pos === 'left' ? 'right:auto;left:24px;' : 'left:auto;right:24px;'}}
    `;

    // Apply left class for correct fullscreen handling
    const btnEl = document.getElementById('nlive-btn');
    const widgetEl = document.getElementById('nlive-widget');
    if (btnEl) btnEl.classList.toggle('nlive-left', pos === 'left');
    if (widgetEl) widgetEl.classList.toggle('nlive-left', pos === 'left');

    // Apply logo
    const logoWrap = document.getElementById('nlive-logo-wrap');
    const logoImg = document.getElementById('nlive-logo-img');
    if (logoWrap && logoImg) {
      if (logoUrl) {
        logoImg.src = logoUrl.startsWith('http') ? logoUrl : SERVER + logoUrl;
        logoWrap.style.display = 'block';
      } else {
        logoWrap.style.display = 'none';
      }
    }
  }

  async function fetchConfig() {
    try {
      const r = await fetch(`${SERVER}/api/widget-config/${WIDGET_KEY}`);
      if (!r.ok) return;
      const data = await r.json();
      applyConfig(data.config, data.logoUrl);
    } catch {}
  }

  // ── Init: deferred until DOM is ready ────────────────────────────────────────
  function init() {
  fetchConfig();

  // ── DOM ───────────────────────────────────────────────────────────────────────
  const btn = document.createElement('button');
  btn.id = 'nlive-btn';
  btn.title = t.title;
  btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg><span class="nlive-notif" id="nlive-notif"></span>`;
  document.body.appendChild(btn);

  const widget = document.createElement('div');
  widget.id = 'nlive-widget';
  widget.innerHTML = `
    <div class="nlive-header">
      <div class="nlive-header-left">
        <div id="nlive-logo-wrap" style="display:none;margin-bottom:6px;"><img id="nlive-logo-img" src="" alt="" style="max-height:30px;max-width:110px;object-fit:contain;border-radius:3px;"></div>
        <h3>${t.title}</h3>
        <p id="nlive-subtitle">${t.subtitle}</p>
      </div>
      <div class="nlive-header-btns">
        <button class="nlive-hbtn" id="nlive-fs-btn" title="${t.fullscreen}">${t.fullscreen}</button>
        <button class="nlive-hbtn" id="nlive-close-btn" title="${t.close}">${t.close}</button>
      </div>
    </div>
    <div class="nlive-body" id="nlive-body"></div>
  `;
  document.body.appendChild(widget);

  // ── State ─────────────────────────────────────────────────────────────────────
  let isOpen = false;
  let isFullscreen = false;
  let operators = [];
  let selectedOpId = null;
  let currentChatId = null;
  let visitorName = '';
  let socket = null;
  let inQueue = false;

  // ── Toggle ───────────────────────────────────────────────────────────────────
  btn.addEventListener('click', () => { isOpen ? closeWidget() : openWidget(); });
  document.getElementById('nlive-close-btn').addEventListener('click', closeWidget);
  document.getElementById('nlive-fs-btn').addEventListener('click', toggleFullscreen);

  function openWidget() {
    isOpen = true;
    widget.style.display = 'flex';
    btn.style.display = 'none';
    if (!socket) initSocket();
  }
  function closeWidget() {
    isOpen = false;
    widget.style.display = 'none';
    btn.style.display = 'flex';
  }
  function toggleFullscreen() {
    isFullscreen = !isFullscreen;
    widget.classList.toggle('nlive-fullscreen', isFullscreen);
    document.getElementById('nlive-fs-btn').textContent = isFullscreen ? t.minimize : t.fullscreen;
  }

  // ── Socket ────────────────────────────────────────────────────────────────────
  function initSocket() {
    const ioScript = document.createElement('script');
    ioScript.src = `${SERVER}/socket.io/socket.io.js`;
    ioScript.onload = connectSocket;
    document.head.appendChild(ioScript);
  }

  function connectSocket() {
    socket = window.io(`${SERVER}/visitors`);

    socket.on('connect', () => {
      socket.emit('visitor:connect', { widget_key: WIDGET_KEY, visitor_name: visitorName });
    });

    socket.on('operators:list', (ops) => {
      operators = ops;
      if (!currentChatId && !inQueue) renderOpSelection();
    });

    socket.on('operator:busy', () => {
      // Operator is busy — re-render so queue button appears
      renderOpSelection();
    });

    socket.on('no_operators', () => renderOpSelection());

    socket.on('chat:started', ({ chatId, operator, messages }) => {
      currentChatId = chatId;
      inQueue = false;
      renderChat(operator, messages || []);
    });

    socket.on('chat:message', (msg) => {
      if (msg.chat_id !== currentChatId) return;
      appendChatMessage(msg);
      if (!isOpen) showNotif();
    });

    socket.on('chat:ended', () => {
      currentChatId = null;
      appendSystemMsg(t.chat_ended);
      disableChatInput();
    });

    socket.on('queue:joined', ({ position }) => {
      inQueue = true;
      renderInQueue(position);
    });
  }

  // ── Views ─────────────────────────────────────────────────────────────────────
  function bindQueueBtn() {
    const btn = document.getElementById('nlive-queue-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      visitorName = document.getElementById('nlive-name-input').value.trim() || 'Anonym';
      socket.emit('visitor:join_queue', { visitor_name: visitorName });
    });
  }

  function renderOpSelection() {
    const body = document.getElementById('nlive-body');
    document.getElementById('nlive-subtitle').textContent = t.subtitle;

    const availableOps = operators.filter(o => o.is_online);
    const anyFree = availableOps.some(o => !o.is_busy);

    body.innerHTML = `
      <div class="nlive-name-row">
        <input type="text" id="nlive-name-input" placeholder="${t.name_placeholder}" maxlength="40">
        <div class="nlive-name-hint">${t.name_hint}</div>
      </div>
      ${availableOps.length === 0 ? `
        <div class="nlive-no-ops">
          <div class="nlive-no-ops-icon">😔</div>
          <p>${t.no_operators}</p>
          <button class="nlive-queue-btn" id="nlive-queue-btn">${t.join_queue}</button>
        </div>
      ` : `
        <div class="nlive-ops-title">Operátori</div>
        <div class="nlive-ops-list" id="nlive-ops-list">
          ${availableOps.map(op => opCardHTML(op)).join('')}
        </div>
        ${anyFree ? `
          <button class="nlive-auto-btn" id="nlive-auto">${t.auto} – Automaticky priradiť</button>
          <button class="nlive-start-btn" id="nlive-start" disabled>${t.start_chat}</button>
        ` : `
          <div style="font-size:.82rem;color:var(--nlive-muted,#94a3b8);margin:.5rem 0 .25rem;">Všetci operátori sú momentálne zaneprázdnení.</div>
          <button class="nlive-queue-btn" id="nlive-queue-btn">${t.join_queue}</button>
        `}
      `}
    `;

    // Bind operator cards (always, whether free or busy)
    if (availableOps.length > 0) {
      document.querySelectorAll('.nlive-op-card').forEach(card => {
        card.addEventListener('click', () => {
          if (!anyFree) return; // can't select when all busy
          document.querySelectorAll('.nlive-op-card').forEach(c => c.classList.remove('selected'));
          card.classList.add('selected');
          selectedOpId = card.dataset.id;
          const startBtn = document.getElementById('nlive-start');
          if (startBtn) startBtn.disabled = false;
        });
      });
      document.querySelectorAll('.nlive-op-bio-toggle').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const bio = btn.nextElementSibling;
          bio.classList.toggle('open');
          btn.textContent = bio.classList.contains('open') ? '▲ ' + t.bio_label : '▼ ' + t.bio_label;
        });
      });
      if (anyFree) {
        document.getElementById('nlive-auto').addEventListener('click', () => {
          visitorName = document.getElementById('nlive-name-input').value.trim() || 'Anonym';
          socket.emit('visitor:auto', { visitor_name: visitorName });
        });
        document.getElementById('nlive-start').addEventListener('click', () => {
          if (!selectedOpId) return;
          visitorName = document.getElementById('nlive-name-input').value.trim() || 'Anonym';
          socket.emit('visitor:select_operator', { operator_id: selectedOpId, visitor_name: visitorName });
        });
      }
    }
    bindQueueBtn();
  }

  function opPhotoUrl(photo_url) {
    if (!photo_url) return null;
    if (photo_url.startsWith('http')) return photo_url;
    return SERVER + photo_url;
  }

  function opAvatarHTML(op, size) {
    const sz = size || 40;
    const url = opPhotoUrl(op.photo_url);
    const initial = (op.nickname || op.full_name || '?')[0].toUpperCase();
    return `<div class="nlive-op-avatar" style="width:${sz}px;height:${sz}px;font-size:${Math.round(sz*0.4)}px">${url ? `<img src="${url}" alt="">` : `<span>${initial}</span>`}</div>`;
  }

  function opCardHTML(op) {
    const statusCls = op.is_busy ? 'busy' : 'online';
    const statusLabel = op.is_busy ? 'Zaneprázdnený' : (LANG === 'en' ? 'Available' : 'Dostupný');
    const hasBio = op.bio?.trim();
    return `
      <div class="nlive-op-card" data-id="${op.id}">
        ${opAvatarHTML(op, 40)}
        <div class="nlive-op-info">
          <div class="nlive-op-name">${esc(op.nickname || op.full_name || 'Operátor')}</div>
          <div class="nlive-op-status ${statusCls}">
            <span class="nlive-op-dot"></span>${statusLabel}
          </div>
          ${hasBio ? `<button class="nlive-op-bio-toggle">▼ ${t.bio_label}</button><div class="nlive-op-bio">${esc(op.bio)}</div>` : ''}
        </div>
      </div>
    `;
  }

  function renderNoOperators() {
    renderOpSelection();
  }

  function renderInQueue(position) {
    const body = document.getElementById('nlive-body');
    document.getElementById('nlive-subtitle').textContent = t.in_queue;
    body.innerHTML = `
      <div class="nlive-in-queue">
        <h4>${t.in_queue}</h4>
        <div class="nlive-queue-pos">${t.queue_pos}${position}</div>
        <p>Čakajte prosím, čoskoro vás spojíme s operátorom.</p>
      </div>
    `;
  }

  function renderChat(operator, messages) {
    const opName = operator?.nickname || operator?.full_name || 'Operátor';
    const photoUrl = opPhotoUrl(operator?.photo_url);
    const initial = (opName)[0].toUpperCase();
    const avatarHtml = photoUrl
      ? `<img src="${photoUrl}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`
      : `<span style="font-weight:700;font-size:.9rem;color:#0d9488;">${initial}</span>`;

    const body = document.getElementById('nlive-body');
    document.getElementById('nlive-subtitle').textContent = '';
    body.innerHTML = `
      <div class="nlive-chat">
        <div class="nlive-chat-header-row">
          <div style="display:flex;align-items:center;gap:.6rem;">
            <div style="width:36px;height:36px;border-radius:50%;background:rgba(13,148,136,.2);display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;">${avatarHtml}</div>
            <div>
              <div style="font-size:.88rem;font-weight:700;color:#f1f5f9;">${esc(opName)}</div>
              <div style="font-size:.72rem;color:#34d399;display:flex;align-items:center;gap:3px;"><span style="width:5px;height:5px;background:#34d399;border-radius:50%;display:inline-block;"></span>Online</div>
            </div>
          </div>
          <button class="nlive-end-btn" id="nlive-end-chat">${t.end_chat}</button>
        </div>
        <div class="nlive-chat-messages" id="nlive-msgs"></div>
      </div>
      <div class="nlive-chat-input">
        <textarea id="nlive-input" placeholder="${t.type_placeholder}" rows="1"></textarea>
        <button class="nlive-send-btn" id="nlive-send">
          <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>
    `;
    messages.forEach(appendChatMessage);

    document.getElementById('nlive-send').addEventListener('click', sendMsg);
    document.getElementById('nlive-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
    });
    document.getElementById('nlive-end-chat').addEventListener('click', () => {
      socket.emit('visitor:end_chat', { chatId: currentChatId });
      currentChatId = null;
      appendSystemMsg(t.chat_ended_visitor);
      disableChatInput();
    });
  }

  function sendMsg() {
    const input = document.getElementById('nlive-input');
    if (!input) return;
    const content = input.value.trim();
    if (!content || !currentChatId) return;
    socket.emit('visitor:message', { chatId: currentChatId, content });
    input.value = '';
    input.style.height = 'auto';
  }

  function appendChatMessage(msg) {
    const container = document.getElementById('nlive-msgs');
    if (!container) return;
    const isOut = msg.sender_type === 'visitor';
    const div = document.createElement('div');
    div.className = `nlive-msg ${isOut ? 'out' : 'in'}`;
    div.innerHTML = `
      <div class="nlive-msg-bubble">${linkify(esc(msg.content))}</div>
      <div class="nlive-msg-meta">${isOut ? t.you : esc(msg.sender_name || 'Operátor')} · ${fmtTime(msg.created_at)}</div>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function appendSystemMsg(text) {
    const container = document.getElementById('nlive-msgs');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'nlive-system-msg';
    div.textContent = text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function disableChatInput() {
    const inp = document.getElementById('nlive-input');
    const btn = document.getElementById('nlive-send');
    const end = document.getElementById('nlive-end-chat');
    if (inp) inp.disabled = true;
    if (btn) btn.disabled = true;
    if (end) end.style.display = 'none';
  }

  function showError(msg) {
    const body = document.getElementById('nlive-body');
    const err = document.createElement('div');
    err.style.cssText = 'background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#f87171;border-radius:8px;padding:10px 12px;font-size:.85rem;margin-bottom:8px;';
    err.textContent = msg;
    body.insertBefore(err, body.firstChild);
    setTimeout(() => err.remove(), 4000);
  }

  function showNotif() {
    const n = document.getElementById('nlive-notif');
    n.style.display = 'flex';
    n.textContent = '•';
  }

  function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function linkify(html) {
    return html.replace(/(https?:\/\/[^\s<>"&]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline;opacity:.85;word-break:break-all;">$1</a>');
  }
  function fmtTime(dt) { try { return new Date(dt).toLocaleTimeString(LANG === 'sk' ? 'sk-SK' : 'en-US', { hour:'2-digit', minute:'2-digit' }); } catch { return ''; } }
  } // end init()

  // Run init when DOM is ready — works whether script is in <head> or <body>
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
