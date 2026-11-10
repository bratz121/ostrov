// Renders the chosen variant ("sky") to build/icon.png and assets/icon.png (256×256).
// Run with: npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { icon, VARIANTS } = require('./icons');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 256, height: 256, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html,${encodeURIComponent(`<style>html,body{margin:0;background:transparent}</style>${icon(VARIANTS.sky)}`)}`);
  await new Promise((r) => setTimeout(r, 300));
  const png = (await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 })).resize({ width: 256, height: 256, quality: 'best' }).toPNG();
  fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
  fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), png);
  app.quit();
});
