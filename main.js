const { app, BrowserWindow, globalShortcut } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 在主进程里启动 HTTP server（server.js 会自动 listen 3000）
require('./server.js');

let win;

function waitForServer(cb, tries = 30) {
  http.get('http://127.0.0.1:3000', res => { res.resume(); cb(); })
    .on('error', () => tries > 0 && setTimeout(() => waitForServer(cb, tries - 1), 300));
}

// ── 全局快捷键系统 ───────────────────────────────────────────
// 绑定存在 store.json 的 cardShortcuts（前端 localStorage 同步过来），缺省用默认。
// 默认值必须与 dashboard.html 里 SC_DEFAULTS 保持一致。
const STORE_FILE = path.join(__dirname, 'data', 'store.json');
const SHORTCUT_DEFAULTS = {
  toggleCard:  'CommandOrControl+Shift+C',
  musicToggle: 'CommandOrControl+Shift+P',
  // musicNext:   'CommandOrControl+Shift+Right',   // 暂时停用
  genIllust:   'CommandOrControl+Shift+G',
  // musicLike:   'CommandOrControl+Shift+L',       // 暂时停用
  volumeUp:    'CommandOrControl+Alt+Up',
  volumeDown:  'CommandOrControl+Alt+Down',
};

// 音乐相关走渲染进程的统一函数（URL 贴纸 vs 网易云 由前端判断），避免双声/回切
function runInRenderer(js) { win?.webContents.executeJavaScript(js).catch(() => {}); }

function runAction(action) {
  switch (action) {
    case 'toggleCard':
      if (win) { win.isVisible() ? win.hide() : (win.show(), win.focus()); }
      break;
    case 'musicToggle': runInRenderer('window.cardMusicToggle?.()'); break;
    case 'musicNext':   runInRenderer('window.cardMusicNext?.()');   break;
    case 'musicLike':   runInRenderer('window.cardMusicLike?.()');   break;
    case 'genIllust':   runInRenderer('window.emotionBubble?.manualCaption?.()'); break;
    case 'volumeUp':    runInRenderer('window.cardVolume?.step(0.05)');  break;
    case 'volumeDown':  runInRenderer('window.cardVolume?.step(-0.05)'); break;
  }
}

function readShortcuts() {
  let stored = {};
  try {
    const s = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    stored = JSON.parse(s.cardShortcuts || '{}');
  } catch { /* store 没建/无此键，用默认 */ }
  return { ...SHORTCUT_DEFAULTS, ...stored };
}

// 重注册全部快捷键；返回 {action: 'ok'|'fail'|'unset'} 供前端显示。媒体键始终常驻。
function registerShortcuts() {
  globalShortcut.unregisterAll();
  const binds = readShortcuts();
  const results = {};
  for (const [action, accel] of Object.entries(binds)) {
    if (!accel) { results[action] = 'unset'; continue; }
    try { results[action] = globalShortcut.register(accel, () => runAction(action)) ? 'ok' : 'fail'; }
    catch { results[action] = 'fail'; }
  }
  // 媒体键无论自定义键如何都保留
  try { globalShortcut.register('MediaPlayPause', () => runAction('musicToggle')); } catch {}
  try { globalShortcut.register('MediaNextTrack', () => runAction('musicNext')); } catch {}
  return results;
}
// 暴露给 server.js 的 /api/shortcuts/reload 调用
global.__reloadShortcuts = registerShortcuts;

function createWindow() {
  win = new BrowserWindow({
    width: 800,
    height: 480,
    title: 'Card',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // 启动时清掉磁盘 HTTP 缓存：否则会用旧缓存的 dashboard.html，
  // 其中烤死的内联 store 是旧数据，刷新即把好数据覆盖成旧的（8k→1k 元凶）。
  win.webContents.session.clearCache().finally(() => {
    waitForServer(() => win?.loadURL('http://localhost:3000/claude-dashboard.html'));
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  createWindow();
  registerShortcuts();   // 读 store.json 绑定 + 媒体键
  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
