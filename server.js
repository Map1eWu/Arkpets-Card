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
    });
    res.end(body);
  });
}

// ── /api/gpu ──────────────────────────────────────────────────
// 通过 ssh（连接复用）执行 nvidia-smi，内存缓存快照；前端 30 秒内无请求则停止轮询
function readEnv() {
  const env = {};
  try {
    fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#')) env[m[1]] = m[2];
    });
  } catch {}
  return env;
}

// 支持逗号分隔多台服务器，上限 2 台
const GPU_HOSTS = (readEnv().GPU_HOST || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 2);
// 第一行回传服务器 hostname，其余为各卡数据
const GPU_QUERY = 'hostname && nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits';
const SSH_OPTS  = [
  '-o', 'BatchMode=yes',          // 只走免密，不卡在密码提示
  '-o', 'ConnectTimeout=4',
  '-o', 'ControlMaster=auto',     // 连接复用：首次握手后查询近乎瞬时
  '-o', 'ControlPath=/tmp/cc-gpu-%r@%h-%p',
  '-o', 'ControlPersist=120',
];

// 每台服务器独立缓存与轮询，一台离线不影响另一台
const gpuCaches = GPU_HOSTS.map(h => ({
  host: h, ok: false, gpus: [], updatedAt: null, error: '连接中…',
}));
let gpuLastReq = 0;
const gpuPolling = new Set();

function pollGpuHost(i) {
  if (gpuPolling.has(i)) return;
  gpuPolling.add(i);
  const child = spawn('ssh', [...SSH_OPTS, GPU_HOSTS[i], GPU_QUERY]);
  let out = '', err = '';
  child.stdout.on('data', d => out += d);
  child.stderr.on('data', d => err += d);
  child.on('close', code => {
    gpuPolling.delete(i);
    if (code === 0 && out.trim()) {
      const lines    = out.trim().split('\n').filter(Boolean);
      const hostname = lines[0].includes(',') ? '' : lines.shift().trim();
      const gpus = lines.map(l => {
        const [index, name, util, memUsed, memTotal, temp] = l.split(',').map(s => s.trim());
        return { index: +index, name, util: +util, memUsed: +memUsed, memTotal: +memTotal, temp: +temp };
      });
      gpuCaches[i] = { host: GPU_HOSTS[i], name: hostname, ok: true, gpus, updatedAt: new Date().toISOString(), error: null };
    } else {
      gpuCaches[i] = { ...gpuCaches[i], ok: false, error: (err.trim().split('\n')[0] || `ssh 退出码 ${code}`) };
    }
  });
  child.on('error', e => {
    gpuPolling.delete(i);
    gpuCaches[i] = { ...gpuCaches[i], ok: false, error: e.message };
  });
}

function pollAllGpu() { GPU_HOSTS.forEach((_, i) => pollGpuHost(i)); }

setInterval(() => {
  if (Date.now() - gpuLastReq < 30000) pollAllGpu();   // 懒轮询：没人看就不打扰服务器
}, 5000);

function handleGpu(res) {
  gpuLastReq = Date.now();
  if (GPU_HOSTS.length && !gpuCaches.some(c => c.updatedAt)) pollAllGpu();   // 首个请求立即触发
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    ok: GPU_HOSTS.length > 0,
    error: GPU_HOSTS.length ? null : '未配置：请在 .env 中设置 GPU_HOST',
    servers: gpuCaches,
  }));
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
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400); res.end('Bad Request'); return;   // 畸形编码不许打崩服务
  }
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

  // 有副作用的接口要求自定义头：跨站网页无法附加自定义头（会触发不被放行的
  // CORS 预检），以此阻断本地 CSRF（恶意网页用 <img>/fetch 偷调 localhost）
  const fromCard = req.headers['x-card'] === '1';

  if (urlPath === '/api/refresh') {
    if (!fromCard) { res.writeHead(403); res.end('Forbidden'); return; }
    handleRefresh(res);
  } else if (urlPath === '/api/autostart') {
    if (!fromCard) { res.writeHead(403); res.end('Forbidden'); return; }
    handleAutostart(req, res);
  } else if (urlPath === '/api/gpu') {
    handleGpu(res);
  } else {
    handleStatic(req, res);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ 服务已启动：http://localhost:${PORT}/claude-dashboard.html`);
  console.log(`   刷新接口：http://localhost:${PORT}/api/refresh`);
  console.log(`   按 Ctrl+C 退出`);
});
