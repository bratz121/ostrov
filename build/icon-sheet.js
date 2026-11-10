// Renders every variant at 256/48/32/16 on a dark and a light taskbar into one
// sheet, so the choice is made at the sizes the icon really ships at.
// Run with: npx electron build/icon-sheet.js <out.png>
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const { icon, VARIANTS } = require('./icons');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const uri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const rows = Object.values(VARIANTS).map((v) => {
    const src = uri(icon(v));
    const sizes = (bg) => `<div class="bar" style="background:${bg}">${[48, 32, 16].map((s) => `<img src="${src}" width="${s}" height="${s}">`).join('')}</div>`;
    return `<div class="row"><img src="${src}" width="160" height="160"><div class="side"><p>${v.name}</p>${sizes('#1f1f1f')}${sizes('#eeeeee')}</div></div>`;
  }).join('');
  const html = `<style>body{margin:0;background:#2b2b2b;font:600 18px 'Segoe UI';color:#fff;padding:20px;display:flex;gap:28px}
    .row{display:flex;gap:16px;align-items:center}.side{display:flex;flex-direction:column;gap:10px}
    .bar{display:flex;align-items:center;gap:16px;padding:10px 14px;border-radius:8px}p{margin:0}</style>${rows}`;
  const win = new BrowserWindow({ width: 1180, height: 220, show: false, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 500));
  fs.writeFileSync(process.argv[process.argv.length - 1], (await win.webContents.capturePage()).toPNG());
  app.quit();
});
