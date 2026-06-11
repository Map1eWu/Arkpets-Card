#!/usr/bin/env node
/**
 * server.js — 本地静态文件服务 + /api/refresh 触发 update-usage.js
 *
 * 用法：node server.js
 * 默认端口：3000  →  在浏览器打开 http://localhost:3000/claude-dashboard.html
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { spawn } = require('child_process');

const PORT    = 3000;
const STATIC  = __dirname;           // card/ 目录

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// ── /api/refresh ──────────────────────────────────────────────
function handleRefresh(res) {
  console.log(`[${new Date().toLocaleTimeString()}] /api/refresh → node update-usage.js`);

  const child = spawn('node', [path.join(STATIC, 'update-usage.js')], {
    cwd: STATIC,
    env: process.env,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d; process.stdout.write(d); });
  child.stderr.on('data', d => { stderr += d; process.stderr.write(d); });

  child.on('close', code => {
    const ok = code === 0;
    const body = JSON.stringify({ ok, code, output: stdout, error: stderr });
    res.writeHead(ok ? 200 : 500, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
  });
}

// ── /api/autostart ────────────────────────────────────────────
// 开机自启 = ~/Library/LaunchAgents 下是否存在 plist（登录时由 macOS 加载）
// on=写入（下次登录生效） off=删除 不带参数=查询状态
const os = require('os');
const PLIST_LABEL = 'com.claude-card.autostart';
const PLIST_PATH  = path.join(os.homedir(), 'Library', 'LaunchAgents', PLIST_LABEL + '.plist');

function plistContent() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>${path.join(STATIC, 'start.sh')}</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>NODE_BIN</key><string>${process.execPath}</string></dict>
  <key>RunAtLoad</key><true/>
</dict></plist>
`;
}

function handleAutostart(req, res) {
  const set = new URL(req.url, 'http://localhost').searchParams.get('set');
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  try {
    if (set === 'on') {
      fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
      fs.writeFileSync(PLIST_PATH, plistContent(), 'utf8');
      console.log(`[autostart] 已写入 ${PLIST_PATH}`);
    } else if (set === 'off') {
      if (fs.existsSync(PLIST_PATH)) fs.unlinkSync(PLIST_PATH);
      console.log(`[autostart] 已移除 ${PLIST_PATH}`);
    }
    send(200, { ok: true, enabled: fs.existsSync(PLIST_PATH) });
  } catch (e) {
    send(500, { ok: false, error: e.message });
  }
}

// ── 静态文件 ──────────────────────────────────────────────────
function handleStatic(req, res) {
  // 去掉 query string，并解码 %23 → # 等编码字符
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/claude-dashboard.html';

  const filePath = path.join(STATIC, urlPath);

  // 安全：防止路径穿越
  if (!filePath.startsWith(STATIC)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

// ── 主服务器 ──────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // 仅允许 GET
  if (req.method !== 'GET') {
    res.writeHead(405); res.end('Method Not Allowed'); return;
  }

  const urlPath = req.url.split('?')[0];
  if (urlPath === '/api/refresh') {
    handleRefresh(res);
  } else if (urlPath === '/api/autostart') {
    handleAutostart(req, res);
  } else {
    handleStatic(req, res);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ 服务已启动：http://localhost:${PORT}/claude-dashboard.html`);
  console.log(`   刷新接口：http://localhost:${PORT}/api/refresh`);
  console.log(`   按 Ctrl+C 退出`);
});
