// window.island for the Tauri build: the same API the Electron preload exposed, so
// app.js runs unchanged. Calendar and weather live here; their HTTP goes through
// Rust (the page can't reach those servers itself because of CORS).
(() => {
  // the Electron preload already gave us the API (window.island alone is also
  // the <div id="island"> through named element access, so check for the API)
  if (window.island && typeof window.island.init === 'function') return;
  // Tauri's own IPC is there even if the window.__TAURI__ global isn't
  const internals = window.__TAURI_INTERNALS__;
  if (!internals) return;
  // early messages are kept too: the IPC may not answer yet while the page loads
  window.__islandLog = [];
  const report = (m) => { window.__islandLog.push(String(m)); internals.invoke('log', { message: String(m) }).catch(() => {}); };
  window.addEventListener('error', (e) => report(`${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
  window.addEventListener('unhandledrejection', (e) => report(`promise: ${e.reason && (e.reason.stack || e.reason)}`));
  if (!window.__TAURI__) { report('window.__TAURI__ is missing'); return; }
  report('bridge loaded');
  const { invoke, Channel } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const on = (name) => (fn) => listen(name, (e) => fn(e.payload));
  const fire = (cmd, args) => { invoke(cmd, args).catch(() => {}); };

  const calSubs = [];
  const weatherSubs = [];
  let cal = { connected: false, events: [], error: '' };
  let weather = null;
  let city = null;
  let shelf = [];
  const emitCal = () => calSubs.forEach((f) => f(cal));
  const emitWeather = () => weatherSubs.forEach((f) => f(weather));

  // ---------- calendar (iCal export link) ----------
  const DAYS_AHEAD = 7;
  const MEETING_HOSTS = /(^|\.)(telemost\.yandex\.ru|telemost\.360\.yandex\.ru|zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webinar\.ru|jazz\.sber\.ru|ktalk\.ru)$/i;

  // The call link of a meeting, wherever the organiser put it. Only video-call
  // services count: a cafe's menu link is not a call.
  function meetingLink(...fields) {
    const found = fields.join(' ').match(/https:\/\/[^\s<>"')\]]+/g) || [];
    for (const raw of found) {
      const u = raw.replace(/[.,;]+$/, '');
      try { if (MEETING_HOSTS.test(new URL(u).hostname)) return u; } catch {}
    }
    return '';
  }

  async function fetchEvents(link) {
    let url;
    try { url = new URL(String(link).trim().replace(/^webcal:/i, 'https:')); } catch {}
    if (!url || url.protocol !== 'https:') throw new Error('Это не похоже на ссылку. Скопируйте её целиком из настроек календаря.');
    let text;
    try { text = await invoke('http_get', { url: url.toString() }); } catch (e) {
      const m = /status (\d+)/.exec(String(e));
      if (m && ['401', '403', '404'].includes(m[1])) throw new Error('Ссылка не работает. Возможно, её сбросили — скопируйте новую.');
      if (m) throw new Error(`Календарь ответил ошибкой ${m[1]}.`);
      throw new Error('Календарь не ответил. Проверьте интернет.');
    }
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('По ссылке нет календаря. Нужна ссылка экспорта в формате iCal.');

    const ICAL = (await import('./vendor/ical.min.js')).default;
    const root = new ICAL.Component(ICAL.parse(text));
    for (const tz of root.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(tz);
    const name = String(root.getFirstPropertyValue('x-wr-calname') || 'Календарь');
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const to = new Date(from.getTime() + DAYS_AHEAD * 86400000);

    // a recurring event and its moved occurrences share a UID
    const masters = new Map();
    const moved = [];
    for (const c of root.getAllSubcomponents('vevent')) {
      if (c.hasProperty('recurrence-id')) moved.push(c); else masters.set(c.getFirstPropertyValue('uid'), new ICAL.Event(c));
    }
    for (const c of moved) {
      const master = masters.get(c.getFirstPropertyValue('uid'));
      if (master) master.relateException(c); else masters.set(Math.random(), new ICAL.Event(c));
    }

    const events = [];
    const push = (ev, start, end) => {
      const s = start.toJSDate(), e = (end || start).toJSDate();
      if (s >= to || Math.max(e.getTime(), s.getTime() + 1) <= from.getTime()) return;
      events.push({
        id: `${ev.uid}|${s.getTime()}`, title: ev.summary || 'Без названия', location: ev.location || '',
        start: s.getTime(), end: e.getTime(), allDay: start.isDate, calendar: name,
        link: meetingLink(ev.component.getFirstPropertyValue('url') || '', ev.location || '', ev.description || ''),
      });
    };
    for (const ev of masters.values()) {
      if (!ev.startDate) continue;
      if (!ev.isRecurring()) { push(ev, ev.startDate, ev.endDate); continue; }
      const it = ev.iterator();
      for (let n = 0, next; n < 1000 && (next = it.next()) && next.toJSDate() < to; n++) {
        const d = ev.getOccurrenceDetails(next);
        push(d.item, d.startDate, d.endDate);
      }
    }
    return events.sort((a, b) => a.start - b.start);
  }

  async function refreshCalendar() {
    const link = await invoke('get_secret', { key: 'calLink' }).catch(() => null);
    if (!link) { cal = { connected: false, events: [], error: '' }; return emitCal(); }
    try { cal = { connected: true, events: await fetchEvents(link), error: '' }; } catch (e) {
      cal = { connected: true, events: cal.events, error: e.message };
    }
    emitCal();
  }

  // ---------- weather (MET Norway) and town search (Open-Meteo geocoding) ----------
  const localDate = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const symbolOf = (entry) => { const d = entry.data; const n = d.next_1_hours || d.next_6_hours || d.next_12_hours; return n ? n.summary.symbol_code : ''; };
  function feelsLike(t, windMs) { // wind chill, only where it applies
    const v = windMs * 3.6;
    return t > 10 || v < 4.8 ? t : 13.12 + 0.6215 * t - 11.37 * v ** 0.16 + 0.3965 * t * v ** 0.16;
  }

  async function refreshWeather() {
    if (!city) { weather = null; return emitWeather(); }
    try {
      const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${(+city.lat).toFixed(4)}&lon=${(+city.lon).toFixed(4)}`;
      const series = JSON.parse(await invoke('http_get', { url })).properties.timeseries;
      const now = series[0].data.instant.details;
      const byDay = new Map();
      for (const entry of series) {
        const ts = Date.parse(entry.time);
        const key = localDate(ts);
        if (!byDay.has(key)) byDay.set(key, { date: key, max: -Infinity, min: Infinity, symbol: '', gap: Infinity });
        const day = byDay.get(key);
        const t = entry.data.instant.details.air_temperature;
        day.max = Math.max(day.max, t); day.min = Math.min(day.min, t);
        const gap = Math.abs(new Date(ts).getHours() - 13); // the day's picture is the forecast nearest 13:00
        if (symbolOf(entry) && gap < day.gap) { day.symbol = symbolOf(entry); day.gap = gap; }
      }
      const today = localDate(Date.now());
      weather = {
        city: city.name, temp: Math.round(now.air_temperature), feels: Math.round(feelsLike(now.air_temperature, now.wind_speed)),
        wind: Math.round(now.wind_speed), symbol: symbolOf(series[0]),
        days: [...byDay.values()].filter((d) => d.date > today).slice(0, 3).map((d) => ({ date: d.date, symbol: d.symbol, max: Math.round(d.max), min: Math.round(d.min) })),
      };
    } catch {
      // keep the last good forecast on screen if a refresh fails
      weather = weather && !weather.error ? weather : { city: city.name, error: 'Погода не загрузилась. Проверьте интернет.' };
    }
    emitWeather();
  }

  async function saveCity(c) {
    city = { name: String(c.name).slice(0, 80), region: String(c.region || '').slice(0, 120), lat: +c.lat, lon: +c.lon };
    fire('set_config', { patch: { city } });
    weather = null;
    await refreshWeather();
    return { ok: true, city: city.name };
  }

  // Geocoding ranks by population, so «Бор» comes back as Бордо first: keep exact
  // name matches and let the person pick when several towns share the name.
  async function findCity(name) {
    try {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=20&language=ru`;
      const results = JSON.parse(await invoke('http_get', { url })).results || [];
      if (!results.length) return { ok: false, error: 'Такой город не нашёлся. Проверьте название.' };
      const norm = (s) => s.toLowerCase().replace(/ё/g, 'е');
      const exact = results.filter((r) => norm(r.name) === norm(name.trim()));
      const list = (exact.length ? exact : results)
        .sort((a, b) => (b.country_code === 'RU') - (a.country_code === 'RU') || (b.population || 0) - (a.population || 0))
        .map((r) => ({ name: r.name, region: [r.admin1, r.country].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude }))
        .filter((c, i, all) => all.findIndex((o) => o.name === c.name && o.region === c.region) === i)
        .slice(0, 6);
      return list.length === 1 ? saveCity(list[0]) : { ok: false, choices: list };
    } catch {
      return { ok: false, error: 'Не удалось найти город. Проверьте интернет.' };
    }
  }

  setInterval(refreshCalendar, 5 * 60 * 1000);
  setInterval(refreshWeather, 20 * 60 * 1000);
  listen('shelf', (e) => { shelf = e.payload; });

  window.island = {
    async init() {
      const r = await invoke('init').catch((e) => { report(`init failed: ${e}`); throw e; });
      report('init ok');
      city = r.settings.cityObj || null;
      shelf = r.shelf || [];
      refreshCalendar();
      refreshWeather();
      return { ...r, cal, weather };
    },
    rect: (w, h) => fire('rect', { w, h }),
    mediaCmd: (cmd) => fire('media_cmd', { cmd }),
    setVolume: (level) => fire('set_volume', { level }),
    toggleMute: () => fire('toggle_mute'),
    async calConnect(link) {
      try {
        const events = await fetchEvents(link);
        await invoke('set_secret', { key: 'calLink', value: String(link).trim() });
        cal = { connected: true, events, error: '' };
        emitCal();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message || 'Не удалось подключиться.' };
      }
    },
    calDisconnect: async () => { await invoke('set_secret', { key: 'calLink', value: null }); refreshCalendar(); },
    calRefresh: () => refreshCalendar(),
    findCity: (name) => findCity(String(name).slice(0, 80)),
    pickCity: (c) => (c && Number.isFinite(+c.lat) && Number.isFinite(+c.lon) ? saveCity(c) : Promise.resolve({ ok: false, error: 'Выберите город из списка.' })),
    weatherRefresh: () => refreshWeather(),
    clipCopy: (id) => fire('clip_copy', { id }),
    clipClear: () => fire('clip_clear'),
    clipPin: (id) => fire('clip_pin', { id }),
    clipRemove: (id) => fire('clip_remove', { id }),
    setDisplay: (id) => fire('set_config', { patch: { display: id } }),
    focusWindow: () => fire('win_focus'),
    blurWindow: () => fire('win_blur'),
    shelfAdd: () => {}, // files dropped on the window are added by Rust directly
    shelfRemove: (id) => fire('shelf_remove', { id }),
    shelfClear: () => fire('shelf_clear'),
    shelfOpen: (id) => fire('shelf_open', { id }),
    shelfReveal: (id) => fire('shelf_reveal', { id }),
    shelfDrag(id) {
      const f = shelf.find((s) => s.id === id);
      if (!f) return;
      invoke('plugin:drag|start_drag', { item: [f.path], image: f.icon || f.iconPath, options: null, onEvent: new Channel() }).catch(() => {});
    },
    setTasks: (tasks) => fire('set_config', { patch: { tasks } }),
    clearMsgs: () => fire('msgs_clear'),
    setNotifyFrom: (from) => fire('set_config', { patch: { notifyFrom: from } }),
    setAgent: (name) => fire('set_config', { patch: { agent: name } }),
    copy: (text) => fire('copy_text', { text: String(text) }),
    setAutostart: (on) => fire('set_autostart', { on: !!on }),
    notify: (title, body) => fire('show_notification', { title, body }),
    open: (url) => fire('open_url', { url }),
    quit: () => fire('quit'),
    onMedia: on('media'), onArt: on('art'), onVol: on('vol'), onClips: on('clips'), onShelf: on('shelf'),
    onSys: on('sys'), onAgent: on('agent'), onToggle: on('toggle'), onDebug: on('debug'),
    onMsgs: on('msgs'), onMsg: on('msg'), onNotifyAccess: on('notifyAccess'),
    onDisplays: on('displays'), onHidden: on('hidden'),
    onFileDrag: on('filedrag'),
    onSlim: on('slim'),
    onCal: (fn) => calSubs.push(fn),
    onWeather: (fn) => weatherSubs.push(fn),
  };
})();
