// Yandex Calendar through its private iCal export link: no login or password.
const ical = require('node-ical');

const DAYS_AHEAD = 7;

function checkLink(link) {
  let url;
  try { url = new URL(String(link).trim().replace(/^webcal:/i, 'https:')); } catch { return null; }
  return url.protocol === 'https:' ? url.toString() : null;
}

// The call link of a meeting, from wherever the organiser put it (URL, place or
// description). Only video-call services count: a cafe's menu link is not a call.
const MEETING_HOSTS = /(^|\.)(telemost\.yandex\.ru|telemost\.360\.yandex\.ru|zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webinar\.ru|jazz\.sber\.ru|ktalk\.ru)$/i;
const textOf = (v) => String((v && v.val) || v || '');
function meetingLink(src) {
  const found = `${textOf(src.url)} ${textOf(src.location)} ${textOf(src.description)}`.match(/https:\/\/[^\s<>"')\]]+/g) || [];
  const urls = found.map((u) => u.replace(/[.,;]+$/, '')).filter((u) => { try { new URL(u); return true; } catch { return false; } });
  return urls.find((u) => MEETING_HOSTS.test(new URL(u).hostname)) || '';
}

function expand(ev, from, to, calendar) {
  const allDay = ev.datetype === 'date';
  const length = (ev.end ? ev.end.getTime() : ev.start.getTime()) - ev.start.getTime();
  const make = (start, src) => ({
    id: `${ev.uid}|${start.getTime()}`,
    title: String((src.summary && src.summary.val) || src.summary || 'Без названия'),
    location: String((src.location && src.location.val) || src.location || ''),
    start: start.getTime(),
    end: start.getTime() + length,
    allDay,
    calendar,
    link: meetingLink(src) || meetingLink(ev),
  });
  if (!ev.rrule) {
    return ev.start < to && ev.start.getTime() + Math.max(length, 1) > from.getTime() ? [make(ev.start, ev)] : [];
  }
  const skipped = new Set(Object.values(ev.exdate || {}).map((d) => new Date(d).toDateString()));
  const moved = ev.recurrences || {};
  return ev.rrule.between(new Date(from.getTime() - length), to, true)
    .filter((d) => !skipped.has(d.toDateString()))
    .map((d) => {
      const override = moved[d.toISOString().slice(0, 10)];
      return override ? make(override.start, override) : make(d, ev);
    });
}

async function fetchEvents(link) {
  const url = checkLink(link);
  if (!url) throw new Error('Это не похоже на ссылку. Скопируйте её целиком из настроек календаря.');
  let res;
  try { res = await fetch(url); } catch { throw new Error('Календарь не ответил. Проверьте интернет.'); }
  if ([401, 403, 404].includes(res.status)) throw new Error('Ссылка не работает. Возможно, её сбросили — скопируйте новую.');
  if (!res.ok) throw new Error(`Календарь ответил ошибкой ${res.status}.`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('По ссылке нет календаря. Нужна ссылка экспорта в формате iCal.');

  const parsed = ical.sync.parseICS(text);
  const cal = Object.values(parsed).find((v) => v.type === 'VCALENDAR');
  const name = String((cal && cal['WR-CALNAME']) || 'Календарь');
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + DAYS_AHEAD * 86400000);
  const events = [];
  for (const ev of Object.values(parsed)) {
    if (ev.type !== 'VEVENT' || !ev.start) continue;
    try { events.push(...expand(ev, from, to, name)); } catch {}
  }
  return events.sort((a, b) => a.start - b.start);
}

module.exports = { fetchEvents, meetingLink };
