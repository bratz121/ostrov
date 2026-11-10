const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, clipboard, safeStorage, Notification, shell, globalShortcut } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fetchEvents } = require('./calendar');
const { createAgentWatcher, CURSOR_HOOKS } = require('./agents');

const WIN_W = 880;
const WIN_H = 330;
const HOTKEY = 'Control+Alt+Space';
const AGENT_NAMES = { claude: 'Claude', cursor: 'Cursor', codex: 'Codex' };
const WAITING_TITLES = { permission: 'Claude ждёт разрешения', question: 'Claude задаёт вопрос', plan: 'Claude ждёт одобрения плана', attention: 'Claude ждёт вас' };
const waitingTitle = (a) => WAITING_TITLES[a.ask] || WAITING_TITLES.attention;

let win, tray, mediaProc, agents;
let media = { has: false };
let art = { key: '', data: null };
let volume = { level: 0, muted: false };
let cal = { connected: false, events: [], error: '' };
let weather = null;
let clips = [];
let lastClip = '';
let shelf = [];
const shelfIcons = new Map();
let islandRect = { w: 196, h: 36 };

if (!app.requestSingleInstanceLock()) app.quit();
// Notifications are attributed to the app by this id; it matches the installer's appId.
app.setAppUserModelId('ru.ostrov.island');

// In the installed app the code sits inside app.asar, which PowerShell can't read;
// the bridges are unpacked next to it (see "asarUnpack" in package.json).
const scriptPath = (name) => path.join(__dirname, name).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

// ---------- settings ----------
const configPath = () => path.join(app.getPath('userData'), 'config.json');
let config = { calLink: '', agent: 'claude', city: null, tasks: [], shelf: [], notifyFrom: 'yandex', display: null };
const loadConfig = () => { try { Object.assign(config, JSON.parse(fs.readFileSync(configPath(), 'utf8'))); } catch {} };
const saveConfig = () => fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
// The export link carries a private token, so it is stored encrypted.
const getCalLink = () => { try { return safeStorage.decryptString(Buffer.from(config.calLink, 'base64')); } catch { return ''; } };

const loginItem = () => ({ path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] });
const send = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send(channel, data); };

// ---------- window and displays ----------
const islandDisplay = () => screen.getAllDisplays().find((d) => d.id === config.display) || screen.getPrimaryDisplay();

function listDisplays() {
  const primary = screen.getPrimaryDisplay().id;
  let n = 1;
  return screen.getAllDisplays()
    .sort((a, b) => (b.id === primary) - (a.id === primary) || a.bounds.x - b.bounds.x)
    .map((d) => ({ id: d.id, name: d.id === primary ? 'Основной' : `Экран ${++n}`, label: d.label || '', size: `${d.size.width}×${d.size.height}` }));
}

function placeWindow() {
  if (!win || win.isDestroyed()) return;
  const b = islandDisplay().bounds;
  win.setBounds({ x: Math.round(b.x + (b.width - WIN_W) / 2), y: b.y, width: WIN_W, height: WIN_H });
}

// Hidden for a full-screen app on the island's monitor, or by the person from the tray.
const hidden = { fullscreen: false, byUser: false };
function applyVisibility() {
  if (!win || win.isDestroyed()) return;
  const show = !hidden.fullscreen && !hidden.byUser;
  if (show && !win.isVisible()) win.showInactive();
  if (!show && win.isVisible()) { send('hidden'); win.hide(); }
}

function onFullscreen(msg) {
  let full = false;
  if (msg.full) {
    // the bridge reports physical pixels; displays are in DIPs
    const rect = screen.screenToDipRect(null, { x: msg.x, y: msg.y, width: msg.w, height: msg.h });
    full = screen.getDisplayMatching(rect).id === islandDisplay().id;
  }
  if (full === hidden.fullscreen) return;
  hidden.fullscreen = full;
  applyVisibility();
}

function createWindow() {
  const b = islandDisplay().bounds;
  win = new BrowserWindow({
    width: WIN_W, height: WIN_H,
    x: Math.round(b.x + (b.width - WIN_W) / 2), y: b.y,
    frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());

  const shot = process.env.OSTROV_SHOT;
  if (shot) {
    win.webContents.on('console-message', (_e, _level, message, line, source) => console.log(`[ui] ${message} (${path.basename(source)}:${line})`));
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      send('debug', process.env.OSTROV_VIEW || '');
      await new Promise((r) => setTimeout(r, 1500));
      fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
      app.quit();
    }, +process.env.OSTROV_DELAY || 4500));
  }
}

// The window is click-through except while the cursor is over the island.
// Polling the cursor (instead of forwarded mouse moves) also catches file drags.
function watchCursor() {
  let inside = false;
  setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const now = Math.abs(p.x - (b.x + b.width / 2)) <= islandRect.w / 2 + 2 && p.y >= b.y && p.y <= b.y + islandRect.h + 2;
    if (now === inside) return;
    inside = now;
    win.setIgnoreMouseEvents(!inside, { forward: true });
  }, 50);
}

function trayIcon() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
  return img.resize({ width: 32, height: 32, quality: 'best' });
}

// The hotkey and the tray bring the island back even over a full-screen app,
// and hand it keyboard focus; the page decides whether to open or close.
function summon() {
  hidden.byUser = false;
  if (!win.isVisible()) win.showInactive();
  send('toggle');
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Остров');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть остров', accelerator: 'Ctrl+Alt+Space', click: summon },
    { label: 'Скрыть с экрана', click: () => { hidden.byUser = true; applyVisibility(); } },
    { type: 'separator' },
    { label: 'Выйти', click: () => app.quit() },
  ]));
}

// ---------- media and volume ----------
function startMedia() {
  mediaProc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath('media.ps1'), String(process.pid)], { windowsHide: true });
  let pending = '';
  if (process.env.OSTROV_SHOT) mediaProc.stderr.on('data', (d) => console.log('[media]', String(d).trim()));
  mediaProc.stdout.setEncoding('utf8');
  mediaProc.stdout.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'state') { media = msg; send('media', media); }
      if (msg.type === 'art') { art = { key: msg.key, data: msg.data }; send('art', art); }
      if (msg.type === 'vol') { volume = { level: msg.level, muted: msg.muted }; send('vol', volume); }
      if (msg.type === 'fs') onFullscreen(msg);
    }
  });
  mediaProc.on('exit', () => { if (!app.isQuitting) setTimeout(startMedia, 3000); });
}
const mediaWrite = (line) => { if (mediaProc && mediaProc.stdin.writable) mediaProc.stdin.write(line + '\n'); };

// ---------- notifications (Yandex Messenger arrives through Yandex Browser) ----------
let notifyProc;
let msgs = [];
let notifyAccess = { access: 'Unknown', toasts: null };
const fromYandex = (n) => /yandex|яндекс/i.test(`${n.app} ${n.aumid}`);
const isOwn = (n) => /electron|остров|ostrov/i.test(`${n.app} ${n.aumid}`);

function startNotify() {
  notifyProc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath('notify.ps1'), String(process.pid)], { windowsHide: true });
  let pending = '';
  notifyProc.stdout.setEncoding('utf8');
  notifyProc.stdout.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      let n;
      try { n = JSON.parse(line); } catch { continue; }
      if (n.type === 'status') { notifyAccess = { access: n.access, toasts: n.toasts }; send('notifyAccess', notifyAccess); }
      if (n.type === 'gone') { msgs = msgs.filter((m) => m.id !== n.id); send('msgs', msgs); }
      if (n.type !== 'add' || isOwn(n)) continue;
      if (config.notifyFrom !== 'all' && !fromYandex(n)) continue;
      const texts = (Array.isArray(n.texts) ? n.texts : [n.texts]).filter(Boolean).map(String);
      const msg = { id: n.id, app: n.app || 'Уведомление', title: texts[0] || n.app, body: texts.slice(1).join(' · '), at: n.at || Date.now(), initial: !!n.initial };
      msgs = [msg, ...msgs.filter((m) => m.id !== msg.id)].slice(0, 40);
      send('msgs', msgs);
      if (!msg.initial) send('msg', msg);
    }
  });
  notifyProc.on('exit', () => { if (!app.isQuitting) setTimeout(startNotify, notifyAccess.access === 'Allowed' ? 3000 : 60000); });
}

// ---------- calendar ----------
async function refreshCalendar() {
  const link = getCalLink();
  if (!link) { cal = { connected: false, events: [], error: '' }; return send('cal', cal); }
  try {
    cal = { connected: true, events: await fetchEvents(link), error: '' };
  } catch (e) {
    cal = { connected: true, events: cal.events, error: e.message || 'Не удалось загрузить календарь.' };
  }
  send('cal', cal);
}

// ---------- weather (MET Norway, no account; api.open-meteo.com is unreachable here) ----------
const localDate = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const symbolOf = (entry) => {
  const d = entry.data;
  const next = d.next_1_hours || d.next_6_hours || d.next_12_hours;
  return next ? next.summary.symbol_code : '';
};
// Wind chill (Environment Canada formula), only where it applies.
function feelsLike(t, windMs) {
  const v = windMs * 3.6;
  if (t > 10 || v < 4.8) return t;
  return 13.12 + 0.6215 * t - 11.37 * v ** 0.16 + 0.3965 * t * v ** 0.16;
}

async function refreshWeather() {
  if (!config.city) { weather = null; return send('weather', weather); }
  try {
    const { lat, lon, name } = config.city;
    const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${(+lat).toFixed(4)}&lon=${(+lon).toFixed(4)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Ostrov/0.1 desktop island (Windows)' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(String(res.status));
    const series = (await res.json()).properties.timeseries;
    const now = series[0].data.instant.details;

    const byDay = new Map();
    for (const entry of series) {
      const ts = Date.parse(entry.time);
      const key = localDate(ts);
      if (!byDay.has(key)) byDay.set(key, { date: key, max: -Infinity, min: Infinity, symbol: '', noonGap: Infinity });
      const day = byDay.get(key);
      const t = entry.data.instant.details.air_temperature;
      day.max = Math.max(day.max, t);
      day.min = Math.min(day.min, t);
      // the day's picture is the forecast nearest to 13:00
      const gap = Math.abs(new Date(ts).getHours() - 13);
      if (symbolOf(entry) && gap < day.noonGap) { day.symbol = symbolOf(entry); day.noonGap = gap; }
    }
    const today = localDate(Date.now());
    weather = {
      city: name,
      temp: Math.round(now.air_temperature),
      feels: Math.round(feelsLike(now.air_temperature, now.wind_speed)),
      wind: Math.round(now.wind_speed),
      symbol: symbolOf(series[0]),
      days: [...byDay.values()].filter((d) => d.date > today).slice(0, 3)
        .map((d) => ({ date: d.date, symbol: d.symbol, max: Math.round(d.max), min: Math.round(d.min) })),
    };
  } catch {
    // keep the last good forecast on screen if a refresh fails
    weather = weather && !weather.error ? weather : { city: config.city.name, error: 'Погода не загрузилась. Проверьте интернет.' };
  }
  send('weather', weather);
}

// Geocoding ranks by population, so «Бор» comes back as Бордо first: keep exact
// name matches and let the person pick when several towns share the name.
async function findCity(name) {
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=20&language=ru`;
    const results = (await (await fetch(url)).json()).results || [];
    if (!results.length) return { ok: false, error: 'Такой город не нашёлся. Проверьте название.' };
    const wanted = name.trim().toLowerCase().replace(/ё/g, 'е');
    const exact = results.filter((r) => r.name.toLowerCase().replace(/ё/g, 'е') === wanted);
    const list = (exact.length ? exact : results)
      // the person's own country first, then bigger towns
      .sort((a, b) => (b.country_code === 'RU') - (a.country_code === 'RU') || (b.population || 0) - (a.population || 0))
      .map((r) => ({ name: r.name, region: [r.admin1, r.country].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude }))
      .filter((c, i, all) => all.findIndex((o) => o.name === c.name && o.region === c.region) === i)
      .slice(0, 6);
    if (list.length === 1) return saveCity(list[0]);
    return { ok: false, choices: list };
  } catch {
    return { ok: false, error: 'Не удалось найти город. Проверьте интернет.' };
  }
}

async function saveCity(city) {
  config.city = { name: String(city.name).slice(0, 80), region: String(city.region || '').slice(0, 120), lat: +city.lat, lon: +city.lon };
  saveConfig();
  weather = null;
  await refreshWeather();
  return { ok: true, city: config.city.name };
}

// ---------- clipboard ----------
// Three kinds of entries: links, text and images (Win+Shift+S puts a bitmap, not text).
// The history survives restarts. Copied text can hold passwords, so the list and
// every full image are stored encrypted for this Windows user (DPAPI via safeStorage).
// Pinned entries are kept out of the limits and out of "Очистить".
const MAX_CLIPS = 40;
const MAX_IMAGES = 12;
const clipImages = new Map(); // id -> NativeImage, filled on demand
const isLink = (s) => /^https?:\/\/\S+$/i.test(s.trim());
const clipsFile = () => path.join(app.getPath('userData'), 'clips.bin');
const clipImageFile = (id) => path.join(app.getPath('userData'), 'clips', `${id}.bin`);

let saveClipsTimer;
function saveClips() {
  clearTimeout(saveClipsTimer);
  saveClipsTimer = setTimeout(() => {
    try { fs.writeFileSync(clipsFile(), safeStorage.encryptString(JSON.stringify(clips))); } catch {}
  }, 800);
}

function loadClips() {
  try { clips = JSON.parse(safeStorage.decryptString(fs.readFileSync(clipsFile()))); } catch { clips = []; }
  // don't re-add what is still on the clipboard from last time
  if (clips[0]) lastClip = clips[0].sig;
  // drop image files nothing points at any more
  try {
    const keep = new Set(clips.filter((c) => c.kind === 'image').map((c) => `${c.id}.bin`));
    for (const f of fs.readdirSync(path.dirname(clipImageFile(0)))) if (!keep.has(f)) fs.rmSync(clipImageFile(f.replace(/\.bin$/, '')), { force: true });
  } catch {}
}

function storeClipImage(id, img) {
  clipImages.set(id, img);
  try {
    fs.mkdirSync(path.dirname(clipImageFile(id)), { recursive: true });
    fs.writeFileSync(clipImageFile(id), safeStorage.encryptString(img.toPNG().toString('base64')));
  } catch {}
}

function readClipImage(id) {
  if (clipImages.has(id)) return clipImages.get(id);
  try {
    const img = nativeImage.createFromBuffer(Buffer.from(safeStorage.decryptString(fs.readFileSync(clipImageFile(id))), 'base64'));
    if (!img.isEmpty()) { clipImages.set(id, img); return img; }
  } catch {}
  return null;
}

function setClips(next) {
  const gone = clips.filter((c) => c.kind === 'image' && !next.some((n) => n.id === c.id));
  for (const c of gone) { clipImages.delete(c.id); fs.rmSync(clipImageFile(c.id), { force: true }); }
  clips = next;
  send('clips', clips);
  saveClips();
}

// Decoding a 4K bitmap on every tick is wasteful, so an image is only read when
// the clipboard's formats say it holds one, and compared by a small fingerprint.
function imageSignature(img) {
  const { width, height } = img.getSize();
  const tiny = img.resize({ width: 12, height: 12, quality: 'good' }).toBitmap();
  let hash = 0;
  for (let i = 0; i < tiny.length; i += 1) hash = (hash * 31 + tiny[i]) >>> 0;
  return `${width}x${height}:${hash}`;
}

function addClip(entry) {
  const same = clips.find((c) => c.sig === entry.sig);
  if (same && same.pinned) entry.pinned = true; // copying a pinned entry again keeps the pin
  let next = [entry, ...clips.filter((c) => c.sig !== entry.sig)];
  // limits count only unpinned entries
  const loose = next.filter((c) => !c.pinned);
  const extraImages = loose.filter((c) => c.kind === 'image').slice(MAX_IMAGES);
  const extra = loose.slice(MAX_CLIPS);
  next = next.filter((c) => !extra.includes(c) && !extraImages.includes(c));
  setClips(next);
}

function pollClipboard() {
  const formats = clipboard.availableFormats();
  const hasImage = formats.some((f) => f.startsWith('image/'));
  const text = clipboard.readText();

  if (hasImage && !text.trim()) {
    const img = clipboard.readImage();
    if (img.isEmpty()) return;
    const sig = `img:${imageSignature(img)}`;
    if (sig === lastClip) return;
    lastClip = sig;
    const id = Date.now();
    const { width, height } = img.getSize();
    storeClipImage(id, img);
    addClip({ id, kind: 'image', sig, width, height, thumb: img.resize({ width: Math.min(width, 400), quality: 'good' }).toDataURL(), at: id });
    return;
  }

  if (!text.trim() || `txt:${text}` === lastClip) return;
  lastClip = `txt:${text}`;
  addClip({ id: Date.now(), kind: isLink(text) ? 'link' : 'text', sig: lastClip, text: text.slice(0, 4000), at: Date.now() });
}

// ---------- file shelf ----------
async function addToShelf(paths) {
  for (const p of paths) {
    if (typeof p !== 'string' || shelf.some((s) => s.path === p) || !fs.existsSync(p)) continue;
    let icon = nativeImage.createEmpty();
    try { icon = await app.getFileIcon(p, { size: 'large' }); } catch {}
    const id = `${Date.now()}-${shelf.length}`;
    shelfIcons.set(id, icon);
    shelf.push({ id, path: p, name: path.basename(p), icon: icon.isEmpty() ? '' : icon.toDataURL() });
  }
  shelf = shelf.slice(-24);
  persistShelf();
}
function persistShelf() {
  config.shelf = shelf.map((s) => s.path);
  saveConfig();
  send('shelf', shelf);
}

// ---------- system load ----------
let cpuPrev = null;
function sampleSystem() {
  const now = os.cpus().reduce((a, c) => {
    const total = Object.values(c.times).reduce((x, y) => x + y, 0);
    return { idle: a.idle + c.times.idle, total: a.total + total };
  }, { idle: 0, total: 0 });
  const cpu = cpuPrev ? 1 - (now.idle - cpuPrev.idle) / Math.max(1, now.total - cpuPrev.total) : 0;
  cpuPrev = now;
  send('sys', { cpu: Math.round(cpu * 100), mem: Math.round((1 - os.freemem() / os.totalmem()) * 100) });
}

// ---------- ipc ----------
function wireIpc() {
  ipcMain.handle('init', () => ({
    media, art, volume, cal, weather, clips, shelf, msgs, notifyAccess,
    tasks: config.tasks,
    displays: { list: listDisplays(), current: islandDisplay().id },
    agent: agents.get(),
    settings: {
      agent: config.agent, notifyFrom: config.notifyFrom, city: config.city ? config.city.name : '',
      autostart: app.getLoginItemSettings(loginItem()).openAtLogin, cursorHooks: CURSOR_HOOKS,
    },
  }));
  ipcMain.on('rect', (_e, r) => { islandRect = { w: Math.min(WIN_W, +r.w || 196), h: Math.min(WIN_H, +r.h || 36) }; });
  ipcMain.on('media:cmd', (_e, cmd) => { if (['toggle', 'next', 'prev'].includes(cmd)) mediaWrite(cmd); });
  ipcMain.on('vol:set', (_e, level) => {
    const v = Math.min(100, Math.max(0, Math.round(+level)));
    if (Number.isFinite(v)) mediaWrite(`vol ${(v / 100).toFixed(2)}`);
  });
  ipcMain.on('vol:mute', () => mediaWrite('mute'));

  ipcMain.handle('cal:connect', async (_e, link) => {
    try {
      const events = await fetchEvents(String(link));
      config.calLink = safeStorage.encryptString(String(link).trim()).toString('base64');
      saveConfig();
      cal = { connected: true, events, error: '' };
      send('cal', cal);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || 'Не удалось подключиться.' };
    }
  });
  ipcMain.on('cal:disconnect', () => { config.calLink = ''; saveConfig(); refreshCalendar(); });
  ipcMain.on('cal:refresh', refreshCalendar);
  ipcMain.on('weather:refresh', refreshWeather);
  ipcMain.handle('weather:find', (_e, name) => findCity(String(name).slice(0, 80)));
  ipcMain.handle('weather:pick', (_e, city) => (city && Number.isFinite(+city.lat) && Number.isFinite(+city.lon) ? saveCity(city) : { ok: false, error: 'Выберите город из списка.' }));

  ipcMain.on('clip:copy', (_e, id) => {
    const item = clips.find((c) => c.id === id);
    if (!item) return;
    lastClip = item.sig; // copying an entry back must not add it again
    if (item.kind === 'image') { const img = readClipImage(id); if (img) clipboard.writeImage(img); } else clipboard.writeText(item.text);
  });
  ipcMain.on('clip:clear', () => setClips(clips.filter((c) => c.pinned)));
  ipcMain.on('clip:pin', (_e, id) => setClips(clips.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c))));
  ipcMain.on('clip:remove', (_e, id) => setClips(clips.filter((c) => c.id !== id)));

  ipcMain.on('shelf:add', (_e, paths) => addToShelf(Array.isArray(paths) ? paths : []));
  ipcMain.on('shelf:remove', (_e, id) => { shelf = shelf.filter((s) => s.id !== id); shelfIcons.delete(id); persistShelf(); });
  ipcMain.on('shelf:clear', () => { shelf = []; shelfIcons.clear(); persistShelf(); });
  ipcMain.on('shelf:open', (_e, id) => { const item = shelf.find((s) => s.id === id); if (item) shell.openPath(item.path); });
  ipcMain.on('shelf:reveal', (_e, id) => { const item = shelf.find((s) => s.id === id); if (item) shell.showItemInFolder(item.path); });
  ipcMain.on('shelf:drag', (e, id) => {
    const item = shelf.find((s) => s.id === id);
    const icon = shelfIcons.get(id);
    if (item && icon && !icon.isEmpty() && fs.existsSync(item.path)) e.sender.startDrag({ file: item.path, icon });
  });

  ipcMain.on('tasks:set', (_e, tasks) => {
    if (!Array.isArray(tasks)) return;
    config.tasks = tasks.slice(0, 100).map((t) => ({ id: +t.id, text: String(t.text).slice(0, 200), done: !!t.done }));
    saveConfig();
  });
  ipcMain.on('msgs:clear', () => { msgs = []; send('msgs', msgs); });
  ipcMain.on('notify:from', (_e, from) => {
    if (!['yandex', 'all'].includes(from)) return;
    config.notifyFrom = from; saveConfig();
    msgs = [];
    send('msgs', msgs);
    if (notifyProc) notifyProc.kill(); // restarts and re-reads the notification centre with the new filter
  });
  ipcMain.on('agent:set', (_e, name) => {
    if (!['off', 'claude', 'cursor', 'codex'].includes(name)) return;
    config.agent = name; saveConfig(); agents.setAgent(name);
  });
  ipcMain.on('copy', (_e, text) => clipboard.writeText(String(text)));
  ipcMain.on('autostart', (_e, on) => app.setLoginItemSettings({ ...loginItem(), openAtLogin: !!on }));
  ipcMain.on('notify', (_e, { title, body }) => new Notification({ title, body }).show());
  ipcMain.on('open', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
  ipcMain.on('quit', () => app.quit());
  ipcMain.on('display:set', (_e, id) => {
    if (!screen.getAllDisplays().some((d) => d.id === id)) return;
    config.display = id; saveConfig();
    placeWindow();
  });
  // keyboard focus only when the person asked for it with the hotkey
  ipcMain.on('win:focus', () => { if (win && !win.isDestroyed()) win.focus(); });
  ipcMain.on('win:blur', () => { if (win && !win.isDestroyed() && win.isFocused()) win.blur(); });
}

app.whenReady().then(async () => {
  loadConfig();
  loadClips();
  agents = createAgentWatcher((now, prev) => {
    send('agent', now);
    if (now.status === 'done' && prev.status === 'working') {
      new Notification({ title: `${AGENT_NAMES[now.agent]} закончил работу`, body: 'Можно возвращаться к задаче.' }).show();
    }
    if (now.status === 'waiting' && (prev.status !== 'waiting' || prev.detail !== now.detail)) {
      new Notification({ title: waitingTitle(now), body: [now.detail, now.project].filter(Boolean).join('\n') || 'Вернитесь к сессии, чтобы продолжить.' }).show();
    }
  });
  agents.setAgent(config.agent);
  await addToShelf(config.shelf || []);
  wireIpc();
  createWindow();
  watchCursor();
  createTray();
  startMedia();
  startNotify();
  refreshCalendar();
  refreshWeather();
  globalShortcut.register(HOTKEY, summon);
  const displaysChanged = () => { placeWindow(); send('displays', { list: listDisplays(), current: islandDisplay().id }); };
  screen.on('display-added', displaysChanged);
  screen.on('display-removed', displaysChanged);
  screen.on('display-metrics-changed', displaysChanged);
  setInterval(refreshCalendar, 5 * 60 * 1000);
  setInterval(refreshWeather, 20 * 60 * 1000);
  setInterval(pollClipboard, 800);
  setInterval(sampleSystem, 2000);
});

app.on('before-quit', () => { app.isQuitting = true; globalShortcut.unregisterAll(); if (mediaProc) mediaProc.kill(); if (notifyProc) notifyProc.kill(); if (agents) agents.stop(); });
app.on('window-all-closed', () => app.quit());
