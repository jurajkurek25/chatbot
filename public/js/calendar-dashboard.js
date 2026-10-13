/* Kalendár (FullCalendar Standard): udalosti tímu, termíny úloh a rezervácie v jednom pohľade.
   Presúvanie myšou, opakovanie, účastníci, videohovor (Jitsi), ICS odber. Používa NW.suite, esc, showToast. */
(function () {
  'use strict';
  const C = '/api/calendar';
  const COLORS = ['#5b4fff', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#64748b'];
  const REPEAT = { none: 'Neopakovať', daily: 'Denne', weekly: 'Týždenne', monthly: 'Mesačne', yearly: 'Ročne' };
  let cal = null;
  let show = { events: true, tasks: true, bookings: true };
  const $ = id => document.getElementById(id);
  const su = () => window.NW.suite;

  window.NW_SUITE = window.NW_SUITE || {};
  window.NW_SUITE.calendar = { title: 'Kalendár', load };
  try { Object.assign(show, JSON.parse(localStorage.getItem('nw_cal_show') || '{}')); } catch { /* nič */ }
  if (window.NW && NW.rt) {
    let t;
    const refetch = () => { clearTimeout(t); t = setTimeout(() => cal && cal.refetchEvents(), 500); };
    NW.rt.on('calendar', refetch);
    NW.rt.on('task', refetch);
  }

  function lib() {
    if (window.NWCalendar) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = '/apps/calendar.js?v=1';
      sc.onload = resolve;
      sc.onerror = () => reject(new Error('Kalendár sa nepodarilo načítať.'));
      document.head.appendChild(sc);
    });
  }

  async function load() {
    const s = su();
    $('calendar-body').innerHTML = `<div class="panel" style="padding:0.85rem">
      <div style="display:flex;gap:0.6rem;align-items:center;flex-wrap:wrap;margin-bottom:0.75rem">
        ${s.wsPicker(load)}
        ${[['events', '📅 Udalosti'], ['tasks', '✅ Úlohy'], ['bookings', '🗓 Rezervácie']].map(([k, l]) => `<label style="display:flex;gap:0.35rem;align-items:center;font-size:0.85rem"><input type="checkbox" data-show="${k}" ${show[k] ? 'checked' : ''}> ${l}</label>`).join('')}
        <span style="margin-left:auto;display:flex;gap:0.5rem">
          <button class="btn btn-sm btn-secondary" id="cl-feed">🔗 Odber do Google/Apple</button>
          ${s.canWrite ? '<button class="btn btn-sm btn-primary" id="cl-new">+ Udalosť</button>' : ''}</span></div>
      <div id="cl-cal" class="nw-cal"></div></div>
      <style>
        .nw-cal { --fc-border-color: rgba(255,255,255,0.08); --fc-page-bg-color: #18182a; --fc-neutral-bg-color: #111120; --fc-today-bg-color: rgba(91,79,255,0.10);
          --fc-list-event-hover-bg-color: rgba(91,79,255,0.15); --fc-button-bg-color: #111120; --fc-button-border-color: rgba(255,255,255,0.1);
          --fc-button-hover-bg-color: #24243a; --fc-button-hover-border-color: rgba(155,140,255,0.5); --fc-button-active-bg-color: #5b4fff; --fc-button-active-border-color: #5b4fff;
          --fc-event-border-color: transparent; --fc-now-indicator-color: #ff4060; --fc-highlight-color: rgba(91,79,255,0.25); font-size: 0.85rem; }
        .nw-cal .fc-toolbar-title { font-size: 1.1rem; font-weight: 700; }
        .nw-cal .fc-button { font-size: 0.8rem; font-weight: 600; text-transform: none; }
        .nw-cal .fc-col-header-cell-cushion, .nw-cal .fc-daygrid-day-number { color: #c4bcff; }
        .nw-cal .fc-list-day-cushion { background: #111120; }
        .nw-cal .fc-event { cursor: pointer; }
      </style>`;
    $('calendar-body').querySelectorAll('[data-show]').forEach(cb => {
      cb.onchange = () => { show[cb.dataset.show] = cb.checked; try { localStorage.setItem('nw_cal_show', JSON.stringify(show)); } catch { /* nič */ } cal && cal.refetchEvents(); };
    });
    $('cl-feed').onclick = feedDialog;
    if ($('cl-new')) $('cl-new').onclick = () => { const st = new Date(); st.setMinutes(0, 0, 0); st.setHours(st.getHours() + 1); eventDialog({ start: st, end: new Date(st.getTime() + 3600000), allDay: false }); };
    try { await lib(); } catch (e) { $('cl-cal').innerHTML = `<p>${esc(e.message)}</p>`; return; }
    if (cal) cal.destroy();
    cal = window.NWCalendar.create($('cl-cal'), {
      initialView: localStorage.getItem('nw_cal_view') || 'timeGridWeek',
      editable: s.canWrite, selectable: s.canWrite, selectMirror: true,
      datesSet: info => { try { localStorage.setItem('nw_cal_view', info.view.type); } catch { /* nič */ } },
      events: async (info, ok, fail) => {
        const only = Object.keys(show).filter(k => show[k]);
        if (!only.length) return ok([]);
        const r = await apiFetch(s.url(`${C}/events`, { start: info.startStr, end: info.endStr, only: only.join(',') }));
        if (!r || !r.ok) return fail(new Error('load'));
        ok(await r.json());
      },
      select: info => { eventDialog({ start: info.start, end: info.end, allDay: info.allDay }); cal.unselect(); },
      eventClick: info => {
        info.jsEvent.preventDefault();
        const x = info.event.extendedProps;
        if (x.kind === 'task') return s.go(`/dashboard?view=tasks&task=${x.taskId}`);
        if (x.kind === 'booking') return bookingDialog(info.event);
        openEvent(x.eventId);
      },
      eventDrop: moved, eventResize: moved,
      eventContent: arg => {
        const x = arg.event.extendedProps;
        if (x.kind !== 'event' || !x.meeting) return true; // true = predvolené vykreslenie FullCalendar
        return { html: `<div class="fc-event-main-frame" style="padding:1px 3px"><div class="fc-event-time">${esc(arg.timeText)}</div><div class="fc-event-title">🎥 ${esc(arg.event.title)}</div></div>` };
      },
    });
    const open = s.takeOpen('event');
    if (open) openEvent(open);
  }

  async function moved(info) {
    const s = su();
    const e = info.event, x = e.extendedProps;
    let ok = null;
    if (x.kind === 'task') ok = await s.api('PATCH', `/api/tasks/tasks/${x.taskId}`, { dueAt: Math.floor(e.start.getTime() / 1000) });
    if (x.kind === 'event') {
      const body = { start: e.allDay ? e.startStr : e.start.toISOString(), end: e.end ? (e.allDay ? e.endStr : e.end.toISOString()) : undefined, allDay: e.allDay };
      if (x.repeat !== 'none') {
        if (!confirm('Ide o opakovanú udalosť – posunúť celú sériu?')) return info.revert();
        body.occurrence = x.occurrence;
      }
      ok = await s.api('PATCH', `${C}/events/${x.eventId}`, body);
    }
    if (!ok) info.revert(); else cal.refetchEvents();
  }

  const toLocal = d => { const x = new Date(d); return new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };

  async function openEvent(id) {
    const e = await su().api('GET', `${C}/events/${id}`);
    if (e) eventDialog(e);
  }

  /** Nová / existujúca udalosť (e.id). */
  function eventDialog(e) {
    const s = su();
    const isNew = !e.id;
    const ro = s.canWrite ? '' : 'disabled';
    const allDay = !!e.allDay;
    const dateVal = d => toLocal(d).slice(0, 10);
    s.modal(isNew ? '📅 Nová udalosť' : `📅 ${esc(e.title)}`, `<div style="display:grid;grid-template-columns:minmax(0,1fr) 230px;gap:1rem" class="nw-ev-grid"><div>
      <div class="form-group"><label>Názov</label><input class="form-control" id="ev-title" value="${esc(e.title || '')}" ${ro} placeholder="napr. Porada tímu"></div>
      <label style="display:flex;gap:0.5rem;align-items:center;font-size:0.86rem;margin-bottom:0.6rem"><input type="checkbox" id="ev-allday" ${allDay ? 'checked' : ''} ${ro}> Celý deň</label>
      <div class="form-row"><div class="form-group" style="flex:1"><label>Začiatok</label><input class="form-control" id="ev-start" type="${allDay ? 'date' : 'datetime-local'}" value="${allDay ? dateVal(e.start) : toLocal(e.start)}" ${ro}></div>
        <div class="form-group" style="flex:1"><label>Koniec</label><input class="form-control" id="ev-end" type="${allDay ? 'date' : 'datetime-local'}" value="${allDay ? dateVal(new Date(new Date(e.end).getTime() - 86400000)) : toLocal(e.end)}" ${ro}></div></div>
      <div class="form-row"><div class="form-group" style="flex:1"><label>Opakovanie</label><select class="form-control" id="ev-repeat" ${ro}>${Object.entries(REPEAT).map(([k, v]) => `<option value="${k}" ${(e.repeat || 'none') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="form-group" style="flex:1"><label>Opakovať do</label><input class="form-control" id="ev-until" type="date" value="${e.repeatUntil ? dateVal(e.repeatUntil) : ''}" ${ro}></div></div>
      <div class="form-group"><label>Miesto</label><input class="form-control" id="ev-loc" value="${esc(e.location || '')}" ${ro}></div>
      <div class="form-group"><label>Popis</label><textarea class="form-control" id="ev-desc" rows="3" ${ro}>${esc(e.description || '')}</textarea></div>
      ${e.meeting ? `<p style="margin-bottom:0.6rem"><a class="btn btn-primary" href="${esc(e.meeting)}" target="_blank" rel="noopener">🎥 Pripojiť sa k videohovoru</a> <span style="${s.muted}">${esc(e.meeting)}</span></p>` : ''}
      <label style="display:flex;gap:0.5rem;align-items:center;font-size:0.86rem;margin-bottom:0.8rem"><input type="checkbox" id="ev-meet" ${e.meeting ? 'checked' : ''} ${ro}> 🎥 Videohovor (Jitsi Meet)</label>
      </div><aside>
      <div class="form-group"><label>Účastníci</label>${s.members.map(m => `<label style="display:flex;gap:0.4rem;align-items:center;font-size:0.85rem;padding:0.1rem 0"><input type="checkbox" data-att="${esc(m.id)}" ${(e.attendees || []).includes(m.id) ? 'checked' : ''} ${ro}> ${s.avatar(m.id, 20)} ${esc(m.name)}</label>`).join('')}
        <div style="${s.muted}">Pozvaní dostanú upozornenie aj e-mail.</div></div>
      <div class="form-group"><label>Farba</label><div style="display:flex;gap:0.3rem;flex-wrap:wrap">${COLORS.map(c => `<label><input type="radio" name="ev-color" value="${c}" ${(e.color || COLORS[0]) === c ? 'checked' : ''} ${ro} hidden><span data-sw="${c}" style="display:inline-block;width:22px;height:22px;border-radius:50%;background:${c};cursor:pointer;outline:${(e.color || COLORS[0]) === c ? '2px solid #fff' : 'none'};outline-offset:2px"></span></label>`).join('')}</div></div>
      ${isNew ? '' : '<div class="form-group" id="ev-links"></div>'}
      </aside></div>
      ${s.canWrite ? `<div style="display:flex;gap:0.5rem"><button class="btn btn-primary" id="ev-save">${isNew ? 'Vytvoriť' : 'Uložiť'}</button>${isNew ? '' : '<button class="btn btn-danger" id="ev-del" style="margin-left:auto">Zmazať</button>'}</div>` : ''}
      <style>@media (max-width:720px){.nw-ev-grid{grid-template-columns:1fr !important}}</style>`, (el, close) => {
      if (!isNew) s.linksPanel(el.querySelector('#ev-links'), 'event', e.id);
      el.querySelectorAll('[data-sw]').forEach(sw => { sw.onclick = () => { el.querySelectorAll('[data-sw]').forEach(x => { x.style.outline = x === sw ? '2px solid #fff' : 'none'; }); }; });
      if (!s.canWrite) return;
      el.querySelector('#ev-allday').onchange = ev => {
        const t = ev.target.checked ? 'date' : 'datetime-local';
        ['#ev-start', '#ev-end'].forEach(sel => { const inp = el.querySelector(sel); const v = inp.value; inp.type = t; inp.value = t === 'date' ? v.slice(0, 10) : (v.length === 10 ? `${v}T09:00` : v); });
      };
      el.querySelector('#ev-save').onclick = async () => {
        const ad = el.querySelector('#ev-allday').checked;
        const sv = el.querySelector('#ev-start').value, evv = el.querySelector('#ev-end').value;
        if (!sv) return showToast('Zadajte začiatok.', 'error');
        const endAllDay = ad && evv ? new Date(Date.parse(`${evv}T00:00:00Z`) + 86400000).toISOString().slice(0, 10) : undefined; // koniec celodennej je exkluzívny
        const body = {
          title: el.querySelector('#ev-title').value, allDay: ad, start: ad ? sv : new Date(sv).toISOString(), end: ad ? endAllDay : (evv ? new Date(evv).toISOString() : undefined),
          repeat: el.querySelector('#ev-repeat').value, repeatUntil: el.querySelector('#ev-until').value || null, location: el.querySelector('#ev-loc').value,
          description: el.querySelector('#ev-desc').value, meeting: el.querySelector('#ev-meet').checked,
          attendees: [...el.querySelectorAll('[data-att]')].filter(x => x.checked).map(x => x.dataset.att),
          color: (el.querySelector('[name=ev-color]:checked') || {}).value || (el.querySelector('[data-sw][style*="solid"]') || {}).dataset?.sw,
        };
        const r = await s.api(isNew ? 'POST' : 'PATCH', isNew ? `${C}/events` : `${C}/events/${e.id}`, body, isNew ? 'Udalosť vytvorená.' : 'Uložené.');
        if (r) { close(); cal && cal.refetchEvents(); }
      };
      if (el.querySelector('#ev-del')) el.querySelector('#ev-del').onclick = async () => {
        if (confirm(e.repeat && e.repeat !== 'none' ? 'Zmazať celú opakovanú sériu?' : 'Zmazať udalosť?') && await s.api('DELETE', `${C}/events/${e.id}`, undefined, 'Zmazané.')) { close(); cal && cal.refetchEvents(); }
      };
      el.querySelectorAll('[data-sw]').forEach(sw => { sw.addEventListener('click', () => { el.querySelector(`[name=ev-color][value="${sw.dataset.sw}"]`).checked = true; }); });
    }, { wide: true });
  }

  function bookingDialog(ev) {
    const s = su();
    const x = ev.extendedProps;
    s.modal('🗓 Rezervácia', `<p style="font-weight:700;margin-bottom:0.4rem">${esc(ev.title.replace(/^📅\s*/, ''))}</p>
      <p style="${s.muted}">${esc(ev.start.toLocaleString('sk-SK', { dateStyle: 'full', timeStyle: 'short' }))}${ev.end ? ` – ${esc(ev.end.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' }))}` : ''}</p>
      <p style="margin-top:0.6rem">${x.email ? `✉️ <a href="mailto:${esc(x.email)}" style="color:#c4bcff">${esc(x.email)}</a><br>` : ''}${x.phone ? `📞 ${esc(x.phone)}` : ''}</p>
      <p style="${s.muted};margin-top:0.6rem">Rezervácie spravujete v nastaveniach widgetu (Rezervácie).</p>`);
  }

  async function feedDialog() {
    const s = su();
    const d = await s.api('GET', `${C}/feed`);
    if (!d) return;
    s.modal('🔗 Odber kalendára', `<p style="margin-bottom:0.6rem">Pridajte si udalosti, kde ste pozvaný/á, a svoje úlohy s termínom do Google, Apple alebo Outlook kalendára (aktualizuje sa automaticky).</p>
      <div style="display:flex;gap:0.4rem"><input class="form-control" readonly value="${esc(d.url)}"><button class="btn btn-secondary" id="fd-copy">Kopírovať</button></div>
      <p style="${s.muted};margin-top:0.6rem">Google: Ďalšie kalendáre → Z webovej adresy. Apple: Súbor → Nový odber kalendára. Odkaz je súkromný – nezdieľajte ho.</p>`, el => {
      el.querySelector('#fd-copy').onclick = () => navigator.clipboard.writeText(d.url).then(() => showToast('Skopírované.'));
    });
  }
})();
