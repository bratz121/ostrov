const api = window.island;
const $ = (sel) => document.querySelector(sel);
const shell = $('#island');

const AGENTS = { claude: 'Claude', cursor: 'Cursor', codex: 'Codex' };
const DEFAULT_ACCENT = '#ffd84a';
const SIZES = { compact: [208, 36], peek: [420, 36], hud: [300, 36], open: [820, 252] };
// a window's tabs at the top edge under the island: fold to a thin strip
const SLIM_SIZE = [150, 10];

const state = {
  view: 'home',
  pinned: false,
  hover: false,
  dragging: false,
  media: { has: false },
  art: { key: '', data: null },
  volume: null,
  volumeSetAt: 0,
  cal: { connected: false, events: [], error: '' },
  weather: null,
  clips: [],
  clipKind: 'all',
  keyboard: false,
  displays: { list: [], current: null },
  msgs: [],
  msgsSeenAt: Date.now(),
  notifyAccess: { access: 'Unknown', toasts: null },
  shelf: [],
  tasks: [],
  query: '',
  copiedId: null,
  battery: null,
  agent: { agent: 'off', status: 'off', since: Date.now() },
  settings: { agent: 'off', city: '', autostart: false, cursorHooks: '' },
  timer: { total: 25 * 60, left: 25 * 60, endAt: null },
  vpn: { present: false, hasBackup: false },
  announced: new Set(),
};

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  el.append(...children.filter((c) => c != null));
  return el;
}
function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

// ---------- formatting ----------
const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
const shortDateFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric' });
const dayFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });
const weekdayFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });
const clock = (ts) => timeFmt.format(ts);
const span = (sec) => {
  sec = Math.max(0, Math.round(sec));
  const hrs = Math.floor(sec / 3600);
  const rest = `${String(Math.floor((sec % 3600) / 60)).padStart(hrs ? 2 : 1, '0')}:${String(sec % 60).padStart(2, '0')}`;
  return hrs ? `${hrs}:${rest}` : rest;
};
const degrees = (n) => `${n < 0 ? '−' : ''}${Math.abs(n)}°`;
const startOfDay = (ts) => new Date(ts).setHours(0, 0, 0, 0);
function dayLabel(ts) {
  const days = Math.round((startOfDay(ts) - startOfDay(Date.now())) / 86400000);
  return days === 0 ? 'сегодня' : days === 1 ? 'завтра' : dayFmt.format(ts);
}
function until(ts) {
  const min = Math.round((ts - Date.now()) / 60000);
  if (min < 1) return 'прямо сейчас';
  if (min < 60) return `через ${min} мин`;
  if (min < 24 * 60) return `через ${Math.round(min / 60)} ч`;
  return dayLabel(ts);
}
function ago(ts) {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  return `${Math.floor(min / 60)} ч назад`;
}
const capital = (s) => s[0].toUpperCase() + s.slice(1);

// ---------- open / close ----------
let openTimer, closeTimer, peekTimer;
const isOpen = () => shell.dataset.state === 'open';
const typing = () => document.hasFocus() && document.activeElement && document.activeElement.matches('input:not([type=checkbox], [type=range])');

function setState(name) {
  shell.dataset.state = name;
  api.rect(...(name === 'compact' && state.slim ? SLIM_SIZE : SIZES[name]));
}
function setSlim(slim) {
  state.slim = !!slim;
  shell.classList.toggle('slim', state.slim);
  if (shell.dataset.state === 'compact') setState('compact');
}
function open() {
  clearTimeout(closeTimer); clearTimeout(peekTimer);
  setState('open');
}

// While Claude waits for the person, the island doesn't fold back to the plain
// compact view: it rests widened, saying what is needed, until it's resolved.
const WAITING = {
  permission: 'Claude ждёт разрешения',
  question: 'Claude задаёт вопрос',
  plan: 'Claude ждёт одобрения плана',
  attention: 'Claude ждёт вас',
};
const isWaiting = () => state.agent.status === 'waiting';
function waitingLine() {
  const a = state.agent;
  const title = WAITING[a.ask] || WAITING.attention;
  return a.detail && a.ask !== 'attention' ? `${title}: ${a.detail}` : title;
}
function rest() {
  if (isOpen()) return;
  if (isWaiting()) {
    $('#cPeek').replaceChildren(h('span', { class: 'attn-dot', 'aria-hidden': 'true' }), h('span', { class: 'attn-text' }, waitingLine()));
    setState('peek');
  } else {
    setState('compact');
  }
}

function close(force) {
  if (!force && (state.pinned || state.keyboard || state.hover || state.dragging || typing())) return;
  setState('compact');
  rest();
}
function flash(nodes, kind, ms) {
  if (isOpen()) return;
  $('#cPeek').replaceChildren(...nodes);
  setState(kind);
  clearTimeout(peekTimer);
  peekTimer = setTimeout(rest, ms);
}
const peek = (text) => flash([h('span', {}, text)], 'peek', 3800);

shell.addEventListener('mouseenter', () => {
  state.hover = true;
  clearTimeout(closeTimer);
  openTimer = setTimeout(open, state.slim && shell.dataset.state === 'compact' ? 250 : 90);
});
shell.addEventListener('mouseleave', () => {
  state.hover = false;
  clearTimeout(openTimer);
  closeTimer = setTimeout(close, 380);
});
// Keyboard: Ctrl+Alt+Space opens the island with focus; ←/→ or 1–7 switch
// sections, Tab walks the controls, Esc closes and hands focus back.
const TAB_VIEWS = () => [...document.querySelectorAll('.tabs .tab')].map((t) => t.dataset.view);

function openWithKeyboard() {
  state.keyboard = true;
  renderStatus();
  open();
  api.focusWindow();
  // focus lands once the window is active
  setTimeout(() => { const tab = document.querySelector(`.tab[data-view="${state.view}"]`); if (tab) tab.focus(); }, 60);
}
function closeFromKeyboard() {
  state.keyboard = false;
  renderStatus();
  state.pinned = false; renderPin();
  if (document.activeElement) document.activeElement.blur();
  close(true);
  api.blurWindow();
}

// Option groups (role=radiogroup) follow the APG radio pattern: Tab enters the
// group once at the checked option, arrows move and select.
function syncRadioGroups() {
  document.querySelectorAll('[role=radiogroup]').forEach((group) => {
    const radios = [...group.querySelectorAll('[role=radio]:not(:disabled)')];
    const current = radios.find((r) => r.getAttribute('aria-checked') === 'true') || radios[0];
    radios.forEach((r) => r.setAttribute('tabindex', r === current ? '0' : '-1'));
  });
}
document.addEventListener('keydown', (e) => {
  const radio = e.target.closest && e.target.closest('[role=radio]');
  if (!radio || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  const radios = [...radio.closest('[role=radiogroup]').querySelectorAll('[role=radio]:not(:disabled)')];
  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
  const next = radios[(radios.indexOf(radio) + step + radios.length) % radios.length];
  e.preventDefault();
  e.stopPropagation();
  next.click();
  syncRadioGroups();
  // the click may re-render the group, so focus whatever now holds the selection
  const group = radio.closest('[role=radiogroup]') || next.closest('[role=radiogroup]');
  const target = (group && group.querySelector('[role=radio][aria-checked=true]')) || next;
  target.focus();
}, true);

window.addEventListener('blur', () => { state.keyboard = false; renderStatus(); closeTimer = setTimeout(close, 200); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeFromKeyboard(); return; }
  if (!isOpen() || typing() || e.ctrlKey || e.altKey || e.metaKey) return;
  // sliders and option groups keep their own arrow keys
  if (document.activeElement && document.activeElement.matches('input[type=range], [role=radio]')) return;
  const views = TAB_VIEWS();
  let next = null;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const i = Math.max(0, views.indexOf(state.view));
    next = views[(i + (e.key === 'ArrowRight' ? 1 : views.length - 1)) % views.length];
  } else if (/^[1-9]$/.test(e.key) && views[+e.key - 1]) {
    next = views[+e.key - 1];
  }
  if (!next) return;
  e.preventDefault();
  setView(next);
  const tab = document.querySelector(`.tab[data-view="${next}"]`);
  if (tab && state.keyboard) tab.focus();
});

// ---------- toolbar ----------
function setView(view) {
  state.view = view;
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-current', String(t.dataset.view === view)));
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
  if (view === 'messages') markMsgsSeen();
  $('#search').hidden = view !== 'clipboard';
  $('#taskForm').hidden = view !== 'tasks';
  const field = view === 'clipboard' || view === 'tasks';
  $('#status').hidden = field;
  $('#sys').hidden = field;
  renderClear();
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));

// One contextual button: what it clears depends on the open section.
const CLEAR = {
  messages: { label: 'Очистить', show: () => state.msgs.length, run: () => api.clearMsgs() },
  // pinned entries survive "Очистить"
  clipboard: { label: 'Очистить', show: () => state.clips.some((c) => !c.pinned), run: () => api.clipClear() },
  shelf: { label: 'Убрать всё', show: () => state.shelf.length, run: () => api.shelfClear() },
  tasks: { label: 'Убрать выполненные', show: () => state.tasks.some((t) => t.done), run: () => saveTasks(state.tasks.filter((t) => !t.done)) },
};
function renderClear() {
  const c = CLEAR[state.view];
  $('#clearBtn').hidden = !(c && c.show());
  if (c) $('#clearBtn').textContent = c.label;
}
$('#clearBtn').addEventListener('click', () => CLEAR[state.view] && CLEAR[state.view].run());

function renderPin() { $('#pin').setAttribute('aria-pressed', String(state.pinned)); }
$('#pin').addEventListener('click', () => { state.pinned = !state.pinned; renderPin(); });

function renderStatus() {
  const { agent, status, since } = state.agent;
  const dot = $('#cAgent');
  dot.hidden = status === 'off' || status === 'idle' || status === 'waiting';
  dot.dataset.status = status;
  // opened from the keyboard: say which keys work, right where the eye is
  if (state.keyboard) return $('#status').replaceChildren(h('b', {}, '← →'), 'разделы', h('b', {}, 'Tab'), 'кнопки', h('b', {}, 'Esc'), 'закрыть');
  if (status === 'off') return $('#status').replaceChildren(capital(dateFmt.format(Date.now())));
  const name = AGENTS[agent];
  if (status === 'waiting') {
    const a = state.agent;
    return $('#status').replaceChildren(h('span', { class: 'attn-dot', 'aria-hidden': 'true' }),
      h('b', { class: 'attn' }, WAITING[a.ask] || WAITING.attention),
      ...[a.detail, a.project].filter(Boolean).map((t) => h('span', { class: 'attn-detail' }, t)));
  }
  const text = status === 'working' ? [h('b', {}, `${name} работает`), span((Date.now() - since) / 1000)]
    : status === 'done' ? [h('b', {}, `${name} закончил`), ago(since)]
    : [`${name} ждёт задачу`];
  $('#status').replaceChildren(h('span', { class: 'agent-dot', 'data-status': status }), ...text);
}

let sysLoad = null;
function renderSys() {
  const parts = [];
  if (sysLoad) parts.push(h('span', {}, 'ЦП', h('b', {}, `${sysLoad.cpu}%`)), h('span', {}, 'ОЗУ', h('b', {}, `${sysLoad.mem}%`)));
  if (state.battery) parts.push(h('span', { title: state.battery.charging ? 'Заряжается' : 'От батареи' }, icon('i-battery'), h('b', {}, `${state.battery.level}%`)));
  $('#sys').replaceChildren(...parts);
}

// ---------- music ----------
function position() {
  const m = state.media;
  if (!m.has || !m.dur) return 0;
  const drift = m.playing && m.updated > 0 ? (Date.now() - m.updated) / 1000 : 0;
  return Math.min(m.dur, Math.max(0, m.pos + (drift > 0 && drift < m.dur ? drift : 0)));
}

function renderMusic() {
  const m = state.media;
  const live = m.has && !!m.title;
  $('#title').textContent = live ? m.title : 'Сейчас ничего не играет';
  $('#artist').textContent = live
    ? m.artist || (/yandex/i.test(m.app) ? 'Яндекс Музыка' : m.app.replace(/\.exe$/i, ''))
    : 'Включите трек в Яндекс Музыке — он появится здесь.';
  $('#artist').classList.toggle('wrap', !live);
  $('#toggle').dataset.playing = String(live && m.playing);
  $('#toggle').setAttribute('aria-label', live && m.playing ? 'Пауза' : 'Играть');
  document.querySelectorAll('.ctl[data-cmd]').forEach((b) => { b.disabled = !live; });
  renderProgress();
  renderCompact();
}

function renderProgress() {
  const m = state.media;
  $('#progress').hidden = !(m.has && m.dur > 0);
  if ($('#progress').hidden) return;
  const pos = position();
  $('#pos').textContent = span(pos);
  $('#dur').textContent = span(m.dur);
  $('#fill').style.width = `${(pos / m.dur) * 100}%`;
}

function renderArt() {
  const has = state.media.has && state.art.data && state.art.key === state.media.key;
  const src = has ? `data:image/jpeg;base64,${state.art.data}` : '';
  for (const img of [$('#art'), $('#cArt')]) {
    img.hidden = !has;
    if (has && img.src !== src) img.src = src;
  }
  if (!has) return applyHue(null);
  const probe = new Image();
  probe.onload = () => applyHue(coverHue(probe));
  probe.src = src;
}

// The cover's dominant hue colours the accent and the now-playing card.
function applyHue(hue) {
  document.documentElement.style.setProperty('--accent', hue == null ? DEFAULT_ACCENT : `hsl(${hue} 85% 70%)`);
  $('#now').classList.toggle('tinted', hue != null);
  if (hue != null) $('#now').style.setProperty('--hue', hue);
}
function coverHue(img) {
  const c = document.createElement('canvas');
  c.width = c.height = 24;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, 24, 24);
  const px = ctx.getImageData(0, 0, 24, 24).data;
  let x = 0, y = 0, weight = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
    if (d < 0.12) continue;
    const hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    x += Math.cos((hue * Math.PI) / 3) * d; y += Math.sin((hue * Math.PI) / 3) * d; weight += d;
  }
  return weight < 8 ? null : Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
}

document.querySelectorAll('.ctl[data-cmd]').forEach((b) => b.addEventListener('click', () => {
  api.mediaCmd(b.dataset.cmd);
  if (b.dataset.cmd === 'toggle') { state.media.playing = !state.media.playing; renderMusic(); }
}));

// ---------- volume ----------
function renderVolume() {
  const v = state.volume;
  if (!v) return;
  const slider = $('#volume');
  if (document.activeElement !== slider || Date.now() - state.volumeSetAt > 800) slider.value = v.level;
  slider.style.setProperty('--v', `${v.muted ? 0 : slider.value}%`);
  $('#muteIcon').setAttribute('href', v.muted ? '#i-mute' : '#i-volume');
  $('#mute').setAttribute('aria-label', v.muted ? 'Включить звук' : 'Выключить звук');
}
$('#volume').addEventListener('input', (e) => {
  state.volumeSetAt = Date.now();
  e.target.style.setProperty('--v', `${e.target.value}%`);
  api.setVolume(+e.target.value);
});
$('#mute').addEventListener('click', () => { state.volumeSetAt = Date.now(); api.toggleMute(); });

function volumeHud(v) {
  const fill = h('div', { class: 'fill' });
  fill.style.width = `${v.muted ? 0 : v.level}%`;
  flash([icon(v.muted ? 'i-mute' : 'i-volume'), h('div', { class: 'rail' }, fill), h('b', {}, v.muted ? 'Выкл' : `${v.level}%`)], 'hud', 1600);
}

// ---------- calendar ----------
const upcoming = () => state.cal.events.filter((e) => e.end > Date.now());

function renderNext() {
  const card = $('#nextCard');
  if (!state.cal.connected) {
    return card.replaceChildren(
      h('h2', {}, 'Календарь'),
      h('p', { class: 'note' }, 'Подключите Яндекс Календарь, и здесь будет ближайшая встреча.'),
      h('button', { class: 'btn', onclick: () => setView('settings') }, 'Подключить'));
  }
  const list = upcoming();
  const ev = list.find((e) => !e.allDay) || list[0];
  if (!ev) return card.replaceChildren(h('h2', {}, 'Встреч нет'), h('p', { class: 'note' }, 'На ближайшую неделю календарь свободен.'));
  const live = ev.start <= Date.now();
  const join = joinable(ev);
  // replaceChildren prints null as text, so optional parts are filtered out first
  card.replaceChildren(...[
    h('p', { class: 'figure' }, ev.allDay ? 'Весь день' : clock(ev.start)),
    h('p', { class: 'what' }, ev.title),
    ev.location && !join ? h('p', { class: 'note' }, ev.location) : null,
    h('p', { class: live || join ? 'foot hot' : 'foot dim' },
      live ? `идёт до ${clock(ev.end)}` : until(ev.start) === dayLabel(ev.start) ? dayLabel(ev.start) : `${dayLabel(ev.start)}, ${until(ev.start)}`),
    join ? joinButton(ev, 'btn primary join') : null,
  ].filter(Boolean));
}

// A call link becomes a button from 15 minutes before the start until the end.
const JOIN_LEAD = 15 * 60000;
const joinable = (ev) => !!ev.link && !ev.allDay && ev.start - Date.now() <= JOIN_LEAD && ev.end > Date.now();
function joinButton(ev, cls) {
  let host = '';
  try { host = new URL(ev.link).hostname; } catch {}
  return h('button', { class: cls, title: `Открыть звонок: ${host}`, onclick: (e) => { e.stopPropagation(); api.open(ev.link); } }, 'Подключиться');
}

function renderDayline() {
  const box = $('#dayline');
  box.hidden = !state.cal.connected;
  if (box.hidden) return;
  const dayStart = startOfDay(Date.now());
  const today = state.cal.events.filter((e) => !e.allDay && e.start < dayStart + 86400000 && e.end > dayStart);
  const hourOf = (ts) => (ts - dayStart) / 3600000;
  const from = Math.max(0, Math.min(8, ...today.map((e) => Math.floor(hourOf(e.start)))));
  const to = Math.min(24, Math.max(22, ...today.map((e) => Math.ceil(hourOf(e.end)))));
  const at = (hour) => `${((Math.min(to, Math.max(from, hour)) - from) / (to - from)) * 100}%`;

  const hours = h('div', { class: 'hours' });
  for (let hr = from; hr <= to; hr += 2) {
    const label = h('span', { class: hr === from ? 'start' : hr === to ? 'end' : '' }, `${hr}:00`);
    label.style.left = at(hr);
    hours.append(label);
  }
  const lane = h('div', { class: 'lane' });
  for (const ev of today) {
    const bar = h('div', { class: ev.start <= Date.now() && ev.end > Date.now() ? 'bar-ev live' : 'bar-ev', title: `${clock(ev.start)}–${clock(ev.end)} ${ev.title}` });
    bar.style.left = at(hourOf(ev.start));
    bar.style.right = `calc(100% - ${at(hourOf(ev.end))})`;
    lane.append(bar);
  }
  const nowHour = hourOf(Date.now());
  if (nowHour >= from && nowHour <= to) {
    const line = h('div', { class: 'nowline', title: `Сейчас ${clock(Date.now())}` });
    line.style.left = at(nowHour);
    lane.append(line);
  }
  box.replaceChildren(hours, lane);
}

function renderEvents() {
  renderDayline();
  const row = $('#events');
  if (!state.cal.connected) {
    return row.replaceChildren(h('div', { class: 'empty' },
      h('h2', {}, 'Подключите Яндекс Календарь'),
      h('p', {}, 'Достаточно ссылки экспорта из настроек календаря — без логина и пароля.'),
      h('button', { class: 'btn primary', onclick: () => setView('settings') }, 'Подключить')));
  }
  const list = upcoming();
  if (!list.length) {
    return row.replaceChildren(h('div', { class: 'empty' },
      h('h2', {}, state.cal.error ? 'Календарь не загрузился' : 'Неделя свободна'),
      h('p', {}, state.cal.error || 'В ближайшие семь дней встреч нет.'),
      state.cal.error ? h('button', { class: 'btn', onclick: api.calRefresh }, 'Обновить') : null));
  }
  row.replaceChildren(...list.map((ev) => {
    const live = ev.start <= Date.now();
    const when = ev.allDay ? `${dayLabel(ev.start)}, весь день` : `${dayLabel(ev.start)}, ${clock(ev.start)}–${clock(ev.end)}`;
    return h('article', { class: live ? 'tile live' : 'tile' },
      h('p', { class: 'top' }, live && !ev.allDay ? `идёт до ${clock(ev.end)}` : when),
      h('p', { class: 'name' }, ev.title),
      joinable(ev)
        ? h('div', { class: 'foot' }, joinButton(ev, 'btn primary small'))
        : h('p', { class: 'foot' }, h('span', {}, ev.location || ev.calendar), h('span', {}, live ? '' : until(ev.start))));
  }));
}

function announceEvents() {
  for (const ev of upcoming()) {
    const lead = ev.start - Date.now();
    if (ev.allDay || lead <= 0 || lead > 10 * 60000 || state.announced.has(ev.id)) continue;
    state.announced.add(ev.id);
    peek(`${capital(until(ev.start))}: ${ev.title}`);
  }
}

// ---------- weather ----------
// MET Norway symbol codes, e.g. "lightsnowshowers_night"
function sky(symbol = '') {
  const s = symbol.replace(/_(day|night|polartwilight)$/, '');
  if (s.includes('thunder')) return ['w-storm', 'Гроза'];
  if (s.includes('sleet')) return ['w-snow', 'Мокрый снег'];
  if (s.includes('snow')) return ['w-snow', s.startsWith('heavy') ? 'Снегопад' : s.startsWith('light') ? 'Небольшой снег' : 'Снег'];
  if (s.includes('rain')) return ['w-rain', s.startsWith('heavy') ? 'Ливень' : s.startsWith('light') ? 'Небольшой дождь' : 'Дождь'];
  if (s === 'fog') return ['w-fog', 'Туман'];
  if (s === 'cloudy') return ['w-cloud', 'Пасмурно'];
  if (s === 'partlycloudy' || s === 'fair') return ['w-partly', 'Переменная облачность'];
  if (s === 'clearsky') return ['w-sun', 'Ясно'];
  return ['w-cloud', 'Облачно'];
}

function renderWeather() {
  const card = $('#weatherCard');
  const w = state.weather;
  if (!w) {
    const input = h('input', { type: 'text', maxlength: '80', placeholder: 'Ваш город', 'aria-label': 'Город для погоды', required: '' });
    const note = h('p', { class: 'note' }, 'Укажите город, и здесь появится прогноз.');
    const form = h('form', { onsubmit: (e) => { e.preventDefault(); findCity(input.value, note, e.target.querySelector('button'), form); } },
      input, h('button', { class: 'btn' }, 'Показать погоду'));
    return card.replaceChildren(h('h2', {}, 'Погода'), note, form);
  }
  if (w.error) {
    return card.replaceChildren(h('h2', {}, w.city), h('p', { class: 'note' }, w.error),
      h('button', { class: 'btn', onclick: (e) => { e.target.disabled = true; api.weatherRefresh(); } }, 'Повторить'));
  }
  const [glyph, text] = sky(w.symbol);
  card.replaceChildren(
    h('p', { class: 'figure' }, degrees(w.temp), icon(glyph)),
    h('p', { class: 'what' }, `${text}, ${w.city}`),
    h('p', { class: 'note', title: `Ветер ${w.wind} м/с` }, `Ощущается как ${degrees(w.feels)}`),
    h('div', { class: 'days' }, ...w.days.map((d) => h('span', { title: `Ночью ${degrees(d.min)}` }, weekdayFmt.format(new Date(d.date)), h('b', {}, degrees(d.max))))));
}

// VPN tab: launches FortiClient. The second factor stays on your phone — the
// island only opens the app. The island also keeps a copy of the connection
// profile, so if an update wipes it, one button puts it back.
function renderVpn() {
  const v = state.vpn || { present: false, hasBackup: false };

  // left card: open FortiClient
  const launch = h('button', {
    class: 'btn primary wide',
    onclick: async (e) => {
      e.target.disabled = true;
      const ok = await api.launchForti();
      e.target.disabled = false;
      if (!ok) api.notify('FortiClient не найден', 'Проверьте, что он установлен.');
    },
  }, icon('i-shield'), 'Запустить VPN');
  $('#vpnMain').replaceChildren(
    h('div', { class: 'vpn-hero' }, icon('i-shield')),
    h('h1', {}, 'FortiClient'),
    h('p', { class: 'note' }, 'Открыть клиент VPN. Логин и пароль — в FortiClient, второй фактор подтвердите на телефоне.'),
    launch);

  // right card: the saved connection profile
  const info = $('#vpnInfo');
  if (!v.present && v.hasBackup) {
    const restore = h('button', {
      class: 'btn primary wide',
      onclick: async (e) => {
        e.target.disabled = true;
        const ok = await api.vpnRestore();
        state.vpn = await api.vpnStatus();
        api.notify(ok ? 'Профиль VPN восстановлен' : 'Не удалось восстановить', ok ? 'Вводить заново не нужно.' : 'Профиль не вернулся.');
        renderVpn();
      },
    }, icon('i-shield'), 'Восстановить профиль');
    return info.replaceChildren(h('h2', {}, 'Профиль'), h('p', { class: 'note' }, 'Профиль пропал после обновления. Остров сохранил копию — верну без повторного ввода.'), restore);
  }
  const line = v.present
    ? (v.hasBackup ? 'Профиль сохранён. После обновления верну его автоматически.' : 'Профиль найден. Сохраню его копию при следующем запуске.')
    : 'Профиль пока не настроен. Подключись в FortiClient — остров запомнит его.';
  const save = v.present ? h('button', {
    class: 'btn wide', style: 'margin-top:auto;',
    onclick: async (e) => { e.target.disabled = true; await api.vpnSave(); state.vpn = await api.vpnStatus(); renderVpn(); api.notify('Профиль сохранён', 'После обновления восстановится.'); },
  }, 'Сохранить сейчас') : null;
  info.replaceChildren(h('h2', {}, 'Профиль'), h('p', { class: 'note' }, line), save);
}

// Several towns share a name (Бор is in four countries), so the search may
// come back with a list to pick from instead of a saved city.
async function findCity(name, msg, btn, host) {
  if (!name.trim()) return false;
  btn.disabled = true;
  const res = await api.findCity(name.trim());
  btn.disabled = false;
  if (res.ok) return citySaved(res.city, msg);
  if (!res.choices) { msg.textContent = res.error; msg.classList.add('bad'); return false; }
  msg.classList.remove('bad');
  msg.textContent = 'Какой именно?';
  const keep = [...host.children];
  const list = h('div', { class: 'choices', role: 'list' }, ...res.choices.map((c) => h('button', {
    type: 'button', role: 'listitem', title: `${c.name}, ${c.region}`,
    onclick: async () => {
      const done = await api.pickCity(c);
      if (done.ok) return citySaved(done.city, msg);
      msg.textContent = done.error; msg.classList.add('bad');
    },
  }, h('b', {}, c.name), ` ${c.region}`)),
  h('button', { type: 'button', class: 'link', onclick: () => { host.replaceChildren(...keep); msg.textContent = ''; } }, 'Ввести другой'));
  host.replaceChildren(list);
  list.querySelector('button').focus();
  return false;
}
function citySaved(name, msg) {
  state.settings.city = name;
  msg.classList.remove('bad');
  msg.textContent = '';
  renderSettings();
  return true;
}

// ---------- messages (Windows notifications, Yandex Messenger by default) ----------
const unread = () => state.msgs.filter((m) => !m.initial && m.at > state.msgsSeenAt);

function markMsgsSeen() {
  state.msgsSeenAt = Date.now();
  renderMsgBadges();
}

function renderMsgBadges() {
  const n = unread().length;
  const label = n > 99 ? '99+' : String(n);
  $('#msgsBadge').hidden = !n || state.view === 'messages';
  $('#msgsBadge').textContent = label;
  $('#msgsTab').setAttribute('aria-label', n ? `Сообщения, новых: ${n}` : 'Сообщения');
  $('#cMsgs').hidden = !n;
  $('#cMsgsCount').textContent = label;
}

function renderMsgs() {
  renderClear();
  renderMsgBadges();
  const row = $('#msgs');
  const a = state.notifyAccess;
  if (!state.msgs.length) {
    const blocked = a.toasts === 0 || (a.access !== 'Allowed' && a.access !== 'Unknown');
    const yandexOnly = state.settings.notifyFrom !== 'all';
    return row.replaceChildren(h('div', { class: 'empty' },
      h('h2', {}, blocked ? 'Уведомления Windows выключены' : 'Новых сообщений нет'),
      h('p', {}, blocked
        ? 'Остров читает сообщения из уведомлений Windows. Включите их: Параметры → Система → Уведомления.'
        : yandexOnly
          ? 'Здесь появятся сообщения Яндекс Мессенджера, пока они лежат в центре уведомлений Windows.'
          : 'Здесь появятся уведомления всех приложений, пока они лежат в центре уведомлений Windows.')));
  }
  const fresh = new Set(unread().map((m) => m.id));
  row.replaceChildren(...state.msgs.map((m) => h('article', { class: fresh.has(m.id) ? 'tile chat unread' : 'tile chat' },
    h('p', { class: 'top' }, h('span', {}, m.app)),
    h('p', { class: 'name' }, m.title),
    m.body ? h('p', { class: 'body' }, m.body) : null,
    h('p', { class: 'foot' }, h('span', {}, ago(m.at))))));
}

function announceMsg(m) {
  if (isOpen() && state.view === 'messages') { markMsgsSeen(); return; }
  flash([icon('i-chat'), h('span', {}, m.body ? `${m.title}: ${m.body}` : m.title)], 'peek', 4200);
}

// ---------- clipboard ----------
const CLIP_EMPTY = {
  all: ['История пуста', 'Скопируйте текст, ссылку или сделайте скрин — они появятся здесь. История живёт до выхода из приложения.'],
  link: ['Ссылок пока нет', 'Скопируйте адрес страницы — он появится здесь.'],
  text: ['Текста пока нет', 'Скопируйте любой текст — он появится здесь.'],
  image: ['Скринов пока нет', 'Нажмите Win+Shift+S и выделите область — снимок появится здесь.'],
};

function splitLink(text) {
  try {
    const url = new URL(text.trim());
    return { host: url.hostname.replace(/^www\./, ''), rest: decodeURI(url.pathname + url.search).replace(/^\/$/, '') };
  } catch {
    return { host: text.trim(), rest: '' };
  }
}

function renderClipFilters() {
  const count = (kind) => (kind === 'all' ? state.clips.length : state.clips.filter((c) => c.kind === kind).length);
  document.querySelectorAll('#clipFilters button').forEach((b) => {
    const n = count(b.dataset.kind);
    b.setAttribute('aria-checked', String(b.dataset.kind === state.clipKind));
    b.querySelector('b').textContent = n || '';
    b.setAttribute('aria-label', `${b.querySelector('span').textContent}${n ? `, ${n}` : ''}`);
  });
  syncRadioGroups();
}

// A tile copies on click or Enter; the pin in its footer is its own button,
// so the tile is a focusable group rather than a button inside a button.
function clipTile(c) {
  const copied = state.copiedId === c.id;
  const label = c.kind === 'image' ? `Скрин ${c.width}×${c.height}` : c.kind === 'link' ? `Ссылка ${splitLink(c.text).host}` : 'Текст';
  const pin = h('button', {
    class: c.pinned ? 'pin on' : 'pin', 'aria-pressed': String(!!c.pinned),
    'aria-label': c.pinned ? `Открепить: ${label}` : `Закрепить: ${label}`, title: c.pinned ? 'Открепить' : 'Закрепить',
    onclick: (e) => { e.stopPropagation(); api.clipPin(c.id); },
  }, icon('i-pin'));
  const foot = h('div', { class: 'foot' }, h('span', { class: copied ? 'ok' : '' }, copied ? 'Скопировано' : ago(c.at)), pin);
  const props = (kind) => ({
    class: `tile ${kind}${c.pinned ? ' pinned' : ''}`, role: 'button', tabindex: '0',
    title: `${label}. Скопировать снова`, 'aria-label': `${label}. Скопировать снова`,
    onclick: () => copyClip(c.id),
    onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); copyClip(c.id); } },
  });
  if (c.kind === 'image') return h('div', props('shot'), h('img', { src: c.thumb, alt: '' }), foot);
  if (c.kind === 'link') {
    const { host, rest } = splitLink(c.text);
    return h('div', props('url'), h('p', { class: 'name' }, host), rest ? h('p', { class: 'body' }, rest) : null, foot);
  }
  return h('div', props('text'), h('p', { class: 'body' }, c.text.trim().slice(0, 280)), foot);
}

function renderClips() {
  renderClear();
  renderClipFilters();
  const row = $('#clips');
  const q = state.query.trim().toLowerCase();
  let list = state.clipKind === 'all' ? state.clips : state.clips.filter((c) => c.kind === state.clipKind);
  // search looks through words, so screenshots drop out while a query is typed
  if (q) list = list.filter((c) => c.kind !== 'image' && c.text.toLowerCase().includes(q));
  if (!list.length) {
    const [title, text] = q ? ['Ничего не нашлось', 'Попробуйте другое слово или другой раздел слева.'] : CLIP_EMPTY[state.clipKind];
    return row.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, title), h('p', {}, text)));
  }
  // pinned entries lead, each group newest first
  row.replaceChildren(...[...list.filter((c) => c.pinned), ...list.filter((c) => !c.pinned)].map(clipTile));
}
$('#clipFilters').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.clipKind = b.dataset.kind;
  $('#clips').scrollLeft = 0;
  renderClips();
});
function copyClip(id) {
  api.clipCopy(id);
  state.copiedId = id;
  renderClips();
  setTimeout(() => { state.copiedId = null; renderClips(); }, 1400);
}
$('#searchInput').addEventListener('input', (e) => { state.query = e.target.value; renderClips(); });

// ---------- file shelf ----------
function renderShelf() {
  renderClear();
  const row = $('#shelf');
  if (!state.shelf.length) {
    return row.replaceChildren(h('div', { class: 'empty' },
      h('h2', {}, 'Полка пуста'),
      h('p', {}, 'Перетащите файлы на остров, чтобы держать их под рукой. Потом их можно вытащить в любую папку, письмо или чат.')));
  }
  row.replaceChildren(...state.shelf.map((f) => h('div', {
    class: 'tile file', tabindex: '0', role: 'button', draggable: 'true',
    title: `${f.path}\nПеретащите куда нужно. Двойной щелчок — открыть`,
    ondragstart: (e) => { e.preventDefault(); api.shelfDrag(f.id); },
    ondblclick: () => api.shelfOpen(f.id),
    onkeydown: (e) => { if (e.key === 'Enter') api.shelfOpen(f.id); if (e.key === 'Delete') api.shelfRemove(f.id); },
  },
    f.icon ? h('img', { src: f.icon, alt: '' }) : icon('i-shelf'),
    h('p', { class: 'name' }, f.name),
    h('button', { class: 'x', 'aria-label': `Убрать ${f.name} с полки`, title: 'Убрать с полки', onclick: () => api.shelfRemove(f.id) }, icon('i-close')))));
}

const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
function startDrag() {
  state.dragging = true;
  setView('shelf'); open();
  $('#shelf').classList.add('over');
}
// Tauri takes files dropped on the window itself and reports them here;
// the page then only shows the shelf (Rust has already added the files).
if (api.onFileDrag) {
  api.onFileDrag((d) => { if (d.type === 'enter') startDrag(); else endDrag(); });
}
document.addEventListener('dragenter', (e) => { if (hasFiles(e)) startDrag(); });
document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
function endDrag() {
  state.dragging = false;
  $('#shelf').classList.remove('over');
  closeTimer = setTimeout(close, 2500);
}
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) endDrag(); });
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  api.shelfAdd(e.dataTransfer.files);
  endDrag();
});

// ---------- tasks ----------
function saveTasks(tasks) {
  state.tasks = tasks;
  api.setTasks(tasks);
  renderTasks();
}
function renderTasks() {
  renderClear();
  const box = $('#tasks');
  if (!state.tasks.length) {
    return box.replaceChildren(h('div', { class: 'empty' },
      h('h2', {}, 'Задач пока нет'),
      h('p', {}, 'Запишите дело в строке сверху и нажмите Enter. Список сохраняется между запусками.')));
  }
  box.replaceChildren(...state.tasks.map((t) => {
    const check = h('input', { type: 'checkbox', onchange: () => saveTasks(state.tasks.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x))) });
    check.checked = t.done;
    return h('div', { class: 'task' },
      h('label', { title: t.text }, check, h('span', {}, t.text)),
      h('button', { class: 'x', 'aria-label': `Удалить задачу ${t.text}`, title: 'Удалить', onclick: () => saveTasks(state.tasks.filter((x) => x.id !== t.id)) }, icon('i-close')));
  }));
}
$('#taskForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#taskInput').value.trim();
  if (!text) return;
  $('#taskInput').value = '';
  saveTasks([{ id: Date.now(), text, done: false }, ...state.tasks]);
});

// ---------- timer ----------
const timerLeft = () => (state.timer.endAt ? Math.max(0, (state.timer.endAt - Date.now()) / 1000) : state.timer.left);

function renderTimer() {
  const t = state.timer;
  const left = timerLeft();
  $('#digits').textContent = span(left);
  $('#timerFill').style.width = `${(1 - left / t.total) * 100}%`;
  $('#timerStart').textContent = t.endAt ? 'Пауза' : left < t.total ? 'Продолжить' : 'Запустить';
  document.querySelectorAll('#presets .chip').forEach((c) => c.setAttribute('aria-pressed', String(+c.dataset.min * 60 === t.total)));
  $('#cTimer').hidden = !t.endAt;
  $('#cTimer').textContent = span(left);
  if (t.endAt && left <= 0) {
    t.endAt = null; t.left = t.total;
    api.notify('Таймер закончился', `Прошло ${Math.round(t.total / 60)} мин.`);
    peek('Таймер закончился');
    renderTimer();
  }
}
$('#timerStart').addEventListener('click', () => {
  const t = state.timer;
  if (t.endAt) { t.left = timerLeft(); t.endAt = null; } else { t.endAt = Date.now() + t.left * 1000; }
  renderTimer();
});
$('#timerReset').addEventListener('click', () => { state.timer.endAt = null; state.timer.left = state.timer.total; renderTimer(); });
$('#presets').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  state.timer = { total: +chip.dataset.min * 60, left: +chip.dataset.min * 60, endAt: null };
  renderTimer();
});

// ---------- settings ----------
function renderSettings() {
  const connected = state.cal.connected;
  $('#calConnected').hidden = !connected;
  $('#calFields').hidden = connected;
  if (connected) {
    $('#calAccount').textContent = 'Подключён по ссылке экспорта. События обновляются каждые пять минут.';
    $('#calMsg').textContent = state.cal.error;
    $('#calMsg').className = state.cal.error ? 'msg bad' : 'msg';
  }
  document.querySelectorAll('#agentSeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.agent === state.settings.agent)));
  document.querySelectorAll('#notifySeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.from === (state.settings.notifyFrom || 'yandex'))));
  const hint = $('#agentHint');
  const a = state.settings.agent;
  if (a === 'off') hint.replaceChildren('Покажет, когда агент работает и когда закончил.');
  else if (a === 'cursor') {
    hint.replaceChildren('Нужны hooks в .cursor/hooks.json. ',
      h('button', { type: 'button', class: 'link', onclick: (e) => { api.copy(state.settings.cursorHooks); e.target.textContent = 'Скопировано'; } }, 'Скопировать'));
  } else hint.replaceChildren(`Читается из журнала ${AGENTS[a]}, настраивать ничего не нужно.`);
  if (document.activeElement !== $('#city')) $('#city').value = state.settings.city;
  $('#autostart').checked = state.settings.autostart;
  renderDisplays();
  syncRadioGroups();
}

function renderDisplays() {
  const { list, current } = state.displays;
  const seg = $('#displaySeg');
  if (list.length < 2) {
    seg.replaceChildren(h('button', { type: 'button', role: 'radio', 'aria-checked': 'true', disabled: '' }, 'Один экран'));
    return;
  }
  seg.replaceChildren(...list.map((d) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(d.id === current),
    title: [d.label, d.size].filter(Boolean).join(', '),
    onclick: () => { state.displays.current = d.id; api.setDisplay(d.id); renderDisplays(); syncRadioGroups(); },
  }, d.name)));
}

$('#calForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#calMsg');
  const btn = $('#calSubmit');
  btn.disabled = true; btn.textContent = 'Подключаю…';
  msg.className = 'msg'; msg.textContent = '';
  const res = await api.calConnect($('#calLink').value);
  btn.disabled = false; btn.textContent = 'Подключить';
  if (!res.ok) { msg.className = 'msg bad'; msg.textContent = res.error; return; }
  $('#calLink').value = '';
  renderSettings();
});
$('#calHelp').addEventListener('click', () => api.open('https://calendar.yandex.ru/'));
$('#calDisconnect').addEventListener('click', api.calDisconnect);
$('#calRefresh').addEventListener('click', api.calRefresh);
$('#agentSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.settings.agent = b.dataset.agent;
  api.setAgent(b.dataset.agent);
  renderSettings();
});
$('#cityForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#cityMsg');
  msg.className = 'msg'; msg.textContent = '';
  if (await findCity($('#city').value, msg, $('#citySubmit'), $('#cityPick'))) { msg.className = 'msg good'; msg.textContent = 'Город сохранён.'; }
});
$('#notifySeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.settings.notifyFrom = b.dataset.from;
  api.setNotifyFrom(b.dataset.from);
  renderSettings();
});
$('#autostart').addEventListener('change', (e) => { state.settings.autostart = e.target.checked; api.setAutostart(e.target.checked); });
$('#quit').addEventListener('click', api.quit);

// Scroll card rows sideways with a regular mouse wheel.
document.querySelectorAll('.row, .tasks').forEach((row) => row.addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { row.scrollLeft += e.deltaY; e.preventDefault(); }
}, { passive: false }));

// ---------- compact ----------
function renderCompact() {
  const now = Date.now();
  $('#cClock').textContent = clock(now);
  $('#cDate').textContent = shortDateFmt.format(now);
  const playing = state.media.has && state.media.playing;
  $('#cEq').hidden = !playing;
  $('#cDate').hidden = playing || !!state.timer.endAt;
}

// ---------- battery ----------
if (navigator.getBattery) {
  navigator.getBattery().then((b) => {
    // A desktop without a battery reports a full, always-charging one.
    const read = () => { state.battery = b.charging && b.level === 1 && b.chargingTime === 0 ? null : { level: Math.round(b.level * 100), charging: b.charging }; renderSys(); };
    read();
    b.addEventListener('levelchange', read);
    b.addEventListener('chargingchange', () => { read(); if (state.battery) peek(b.charging ? `Заряжается, ${state.battery.level}%` : `Работает от батареи, ${state.battery.level}%`); });
  }).catch(() => {});
}

// ---------- data ----------
api.onMedia((m) => {
  const changed = m.has && m.title && m.key !== state.media.key;
  state.media = m;
  renderMusic(); renderArt();
  if (changed && m.playing) peek(m.artist ? `${m.title} — ${m.artist}` : m.title);
});
api.onArt((a) => { state.art = a; renderArt(); });
api.onVol((v) => {
  const first = !state.volume;
  const mine = Date.now() - state.volumeSetAt < 1500;
  state.volume = v;
  renderVolume();
  if (!first && !mine) volumeHud(v);
});
api.onCal((c) => { state.cal = c; renderNext(); renderEvents(); renderSettings(); });
api.onWeather((w) => { state.weather = w; renderWeather(); });
api.onClips((c) => { state.clips = c; renderClips(); });
api.onMsgs((list) => { state.msgs = list; renderMsgs(); });
api.onMsg(announceMsg);
api.onNotifyAccess((a) => { state.notifyAccess = a; renderMsgs(); });
api.onDisplays((d) => { state.displays = d; renderDisplays(); });
// hidden for a full-screen app: drop any open state so it comes back as the compact island
if (api.onSlim) api.onSlim(setSlim);
api.onHidden(() => { state.keyboard = false; state.hover = false; close(true); });
api.onShelf((s) => { state.shelf = s; renderShelf(); });
api.onSys((s) => { sysLoad = s; renderSys(); });
api.onAgent((a) => {
  const finished = a.status === 'done' && state.agent.status === 'working';
  const wasWaiting = isWaiting();
  state.agent = a;
  shell.classList.toggle('waiting', isWaiting());
  renderStatus();
  if (finished) return peek(`${AGENTS[a.agent]} закончил работу`);
  if (isWaiting() || wasWaiting) rest();
});
api.onToggle(() => {
  if (isOpen() && state.keyboard) closeFromKeyboard(); else openWithKeyboard();
});
api.onDebug((arg) => {
  const [view, demo] = arg.split(':');
  if (demo === 'demo') loadDemo();
  if (demo && demo.startsWith('city=')) { $('#city').value = demo.slice(5); $('#cityForm').requestSubmit(); }
  if (demo === 'kbd') { state.keyboard = true; renderStatus(); }
  if (demo === 'slim') setSlim(true);
  if (demo === 'wait') { state.agent = { agent: 'claude', status: 'waiting', since: Date.now(), ask: 'permission', detail: 'Bash', project: 'ostrov' }; shell.classList.add('waiting'); renderStatus(); if (view === 'compact') return rest(); }
  if (demo === 'end') setTimeout(() => document.querySelectorAll('.view').forEach((v) => { v.scrollLeft = v.scrollWidth; }), 50);
  if (view === 'compact') return;
  if (view === 'peek') return announceMsg(state.msgs[0] || { title: 'Аня', body: 'Скинь макеты острова' });
  state.pinned = true; renderPin();
  if (view) setView(view);
  open();
});

// Sample content for design screenshots (OSTROV_VIEW=home:demo).
function loadDemo() {
  const t = Date.now();
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#1d4e5f'; ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#3fb6c9'; ctx.beginPath(); ctx.arc(40, 26, 20, 0, 7); ctx.fill();
  ctx.fillStyle = '#e8f6f8'; ctx.fillRect(8, 44, 30, 6);
  state.media = { has: true, key: 'demo', app: 'ru.yandex.desktop.music', title: 'Космос для троих', artist: 'Курара', playing: true, pos: 74, dur: 221, updated: t };
  state.art = { key: 'demo', data: c.toDataURL('image/jpeg').split(',')[1] };
  state.volume = { level: 62, muted: false };
  const at = (hr, min = 0) => new Date(t).setHours(hr, min, 0, 0);
  const hourNow = new Date(t).getHours();
  state.cal = { connected: true, error: '', events: [
    { id: 'a', title: 'Синк по релизу', location: 'Телемост', calendar: 'Работа', start: at(hourNow, 0) - 600000, end: at(hourNow + 1, 0), allDay: false, link: 'https://telemost.yandex.ru/j/12345678901234' },
    { id: 'b', title: 'Обед с Аней', location: 'Кофемания на Белорусской', calendar: 'Личное', start: at(hourNow + 2, 30), end: at(hourNow + 3, 30), allDay: false },
    { id: 'c', title: 'Ревью дизайна острова', location: '', calendar: 'Работа', start: at(hourNow + 4, 0), end: at(hourNow + 5, 0), allDay: false },
    { id: 'd', title: 'Стоматолог', location: 'ул. Правды, 8', calendar: 'Личное', start: at(11) + 86400000, end: at(12) + 86400000, allDay: false },
    { id: 'e', title: 'День рождения Миши', location: '', calendar: 'Личное', start: startOfDay(t) + 2 * 86400000, end: startOfDay(t) + 3 * 86400000, allDay: true },
  ] };
  const day = (n) => new Date(t + n * 86400000).toISOString().slice(0, 10);
  state.weather = { city: 'Москва', temp: -3, feels: -7, wind: 4, symbol: 'snow', days: [{ date: day(1), symbol: 'cloudy', max: -1, min: -6 }, { date: day(2), symbol: 'clearsky_day', max: 1, min: -4 }, { date: day(3), symbol: 'rain', max: 3, min: 0 }] };
  const shot = document.createElement('canvas');
  shot.width = 400; shot.height = 225;
  const g = shot.getContext('2d');
  g.fillStyle = '#e9edf2'; g.fillRect(0, 0, 400, 225);
  g.fillStyle = '#2f6fed'; g.fillRect(0, 0, 400, 34);
  g.fillStyle = '#fff'; g.fillRect(24, 56, 220, 14); g.fillRect(24, 82, 300, 10); g.fillRect(24, 100, 260, 10);
  g.fillStyle = '#c9d3df'; g.fillRect(24, 132, 160, 70); g.fillRect(200, 132, 176, 70);
  state.clips = [
    { id: 5, kind: 'image', width: 1920, height: 1080, thumb: shot.toDataURL(), at: t - 15000 },
    { id: 1, kind: 'link', text: 'https://music.yandex.ru/album/2223040/track/19675563', at: t - 40000, pinned: true },
    { id: 2, kind: 'text', text: 'Привет! Скинь, пожалуйста, макеты острова до вечера — хочу показать команде на ревью.', at: t - 9 * 60000 },
    { id: 3, kind: 'text', text: 'npm start', at: t - 34 * 60000 },
    { id: 4, kind: 'link', text: 'https://www.figma.com/design/k2Lx/Ostrov?node-id=12-48', at: t - 3 * 3600000 },
  ];
  state.notifyAccess = { access: 'Allowed', toasts: 1 };
  state.msgsSeenAt = t - 30 * 60000;
  state.msgs = [
    { id: 'm1', app: 'Яндекс Браузер', title: 'Аня', body: 'Скинь макеты острова, покажу команде на ревью', at: t - 60000 },
    { id: 'm2', app: 'Яндекс Браузер', title: 'Команда дизайна', body: 'Миша: созвон переносим на 19:30', at: t - 12 * 60000 },
    { id: 'm3', app: 'Яндекс Браузер', title: 'Папа', body: 'Позвони, как освободишься', at: t - 2 * 3600000 },
  ];
  state.tasks = [
    { id: 1, text: 'Подключить календарь', done: true }, { id: 2, text: 'Ответить Ане про макеты', done: false },
    { id: 3, text: 'Купить билеты на субботу', done: false }, { id: 4, text: 'Продлить домен', done: false }, { id: 5, text: 'Записаться в спортзал', done: false },
  ];
  renderAll();
}

function renderAll() {
  renderMusic(); renderArt(); renderVolume(); renderNext(); renderEvents(); renderWeather(); renderVpn(); renderMsgs(); renderClips(); renderShelf();
  renderTasks(); renderTimer(); renderSettings(); renderStatus(); renderSys(); renderPin();
}

setInterval(() => { renderCompact(); renderProgress(); renderTimer(); renderStatus(); announceEvents(); }, 500);
setInterval(() => { renderNext(); renderEvents(); renderClips(); }, 30000);

api.init().then((init) => {
  Object.assign(state, {
    media: init.media, art: init.art, volume: init.volume.level ? init.volume : null, cal: init.cal, weather: init.weather,
    clips: init.clips, shelf: init.shelf, msgs: init.msgs || [], notifyAccess: init.notifyAccess || state.notifyAccess, displays: init.displays || state.displays, slim: !!init.slim, tasks: init.tasks || [], agent: init.agent, settings: init.settings, vpn: init.vpn || state.vpn,
  });
  setView('home');
  renderAll();
  setSlim(state.slim);
  if (shell.dataset.state === 'compact') setState('compact');
});
