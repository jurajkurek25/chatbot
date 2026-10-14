// FullCalendar Standard (MIT) pre sekciu Kalendár – window.NWCalendar.create(el, options)
// Zostavenie: npm run build:apps → public/apps/calendar.js
import { Calendar } from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin from '@fullcalendar/interaction';
import skLocale from '@fullcalendar/core/locales/sk';

window.NWCalendar = {
  create(el, options) {
    const cal = new Calendar(el, {
      plugins: [dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin],
      locale: skLocale,
      timeZone: 'local',
      firstDay: 1,
      height: 'auto',
      nowIndicator: true,
      navLinks: true,
      dayMaxEvents: 4,
      slotMinTime: '06:00:00',
      slotMaxTime: '22:00:00',
      headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek' },
      ...options,
    });
    cal.render();
    return cal;
  },
};
