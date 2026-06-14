#!/usr/bin/env node
/**
 * server.js — 本地静态文件服务 + /api/refresh 触发 update-usage.js
 *
 * 用法：node server.js
 * 默认端口：3000  →  在浏览器打开 http://localhost:3000/claude-dashboard.html
 */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const { spawn, execSync, execFileSync } = require('child_process');
const { cloudsearch, lyric } = require('@neteasecloudmusicapienhanced/api');
const Jimp   = require('jimp');

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

// ── /api/music ────────────────────────────────────────────────
// 数据源：media-control（ungive/media-control）。macOS 15.4+ 起 Apple 给
// mediaremoted 加了 entitlement 校验，普通二进制（含 nowplaying-cli、自编译 Swift）
// 直连 MediaRemote.framework 会被拒返回空；media-control 借系统自带、带授权的
// /usr/bin/perl 去访问，因此在 macOS 26 上仍可用。安装：brew install media-control
let musicCache   = { ok: false };
let musicLastReq = 0;
let musicSong    = '';   // 当前曲目标识（title|artist），用于检测切歌

// media-control 路径：优先 Homebrew 默认位置（launchd 自启时 PATH 常不含它），退回 PATH
const MEDIA_CONTROL = ['/opt/homebrew/bin/media-control', '/usr/local/bin/media-control']
  .find(p => { try { return fs.existsSync(p); } catch { return false; } }) || 'media-control';

// 只有这些音乐 App 在播时才去网易云搜歌词；视频/直播/浏览器等只显示标题不搜词
const MUSIC_BUNDLES = new Set([
  'com.netease.163music',   // 网易云音乐
  'com.apple.Music',        // Apple Music
  'com.spotify.client',     // Spotify
  'com.tencent.QQMusicMac', // QQ 音乐
]);

const norm = s => (s || '').toLowerCase().replace(/\s+/g, '').trim();

// 下载图片为 Buffer（小图，限时）
function fetchImage(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('http ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
  });
}

// 系统缩略图与候选封面的相似度：感知哈希(抗缩放) + 像素差(防误判)，0=完全一致
async function coverDist(thumbImg, picUrl) {
  try {
    const url = picUrl.replace(/^http:/, 'https:') + '?param=64y64';
    const cand = (await Jimp.read(await fetchImage(url))).resize(64, 64);
    const ref  = thumbImg.clone().resize(64, 64);
    return 0.5 * Jimp.distance(ref, cand) + 0.5 * Jimp.diff(ref, cand).percent;
  } catch { return 1; }
}

// 搜索歌曲，锁定「正在播放的那一版」。
// 思路：先按 专辑名/歌手/时长 预排序；若字符串不够确定且有系统缩略图，
// 就用缩略图当指纹，对候选封面做图像比对，选最像的那一版。
// 返回 { id, cover, confident }：confident 时可放心用网易云高清封面替换糊图。
async function searchSong(title, artist, durationSec, album, thumbBuf) {
  try {
    const r = await cloudsearch({ keywords: `${title} ${artist}`.trim(), limit: 15 });
    const songs = r?.body?.result?.songs || [];
    if (!songs.length) return null;

    const nAlbum  = norm(album);
    const nArtist = norm(artist);

    const scored = songs.map(s => {
      const dur      = (s.dt || 0) / 1000;
      const durDiff  = durationSec > 0 ? Math.abs(dur - durationSec) : 999;
      const albumHit = nAlbum  && norm(s.al?.name) === nAlbum;
      const artHit   = nArtist && (s.ar || []).some(a => norm(a.name) === nArtist);
      const score = (albumHit ? 1000 : 0) + (artHit ? 100 : 0) - durDiff;
      return { s, durDiff, albumHit, score };
    }).sort((a, b) => b.score - a.score);

    let best = scored[0];
    if (!best) return null;

    // 字符串快速路径：专辑名精确命中且时长≤3s，直接采用，省去图像下载
    let imgConfident = false;
    const strConfident = best.albumHit && best.durDiff <= 3;

    if (!strConfident && thumbBuf) {
      let thumbImg = null;
      try { thumbImg = await Jimp.read(thumbBuf); } catch {}
      if (thumbImg) {
        // 只比前若干个、且有封面的候选，控制下载量
        const cands = scored.slice(0, 8).filter(c => c.s.al?.picUrl);
        const dists = await Promise.all(
          cands.map(async c => ({ c, d: await coverDist(thumbImg, c.s.al.picUrl) })));
        dists.sort((a, b) => a.d - b.d);
        if (dists.length && dists[0].d <= 0.20) {   // 足够像 → 锁定该版本
          best = dists[0].c;
          imgConfident = true;
        }
      }
    }

    const confident = strConfident || imgConfident || best.durDiff <= 2;
    let cover = best.s.al?.picUrl || null;
    if (cover) cover = cover.replace(/^http:/, 'https:') + '?param=300y300';

    return { id: best.s.id, cover, confident };
  } catch { return null; }
}

// 获取并解析 LRC 歌词，返回 [{time, text}]
async function fetchLrc(songId) {
  try {
    const r = await lyric({ id: songId });
    const raw = r?.body?.lrc?.lyric || '';
    const lines = [];
    for (const line of raw.split('\n')) {
      const m = line.match(/\[(\d+):(\d+(?:\.\d+)?)\](.*)/);
      if (!m) continue;
      const text = m[3].trim();
      if (!text || /^\[/.test(text)) continue;   // 跳过元信息行
      lines.push({ time: parseInt(m[1]) * 60 + parseFloat(m[2]), text });
    }
    return lines.sort((a, b) => a.time - b.time);
  } catch { return []; }
}

function fetchMusic() {
  let info;
  try {
    // artworkData 是大块 base64，放宽 maxBuffer 避免截断
    const out = execFileSync(MEDIA_CONTROL, ['get'], { timeout: 4000, maxBuffer: 8 * 1024 * 1024 })
      .toString().trim();
    info = JSON.parse(out);
  } catch {
    musicCache = { ok: false };
    musicSong  = '';
    return;
  }

  const title  = info.title  || '';
  const artist = info.artist || '';
  if (!title) { musicCache = { ok: false }; musicSong = ''; return; }

  const bundle   = info.bundleIdentifier || '';
  const isMusic  = MUSIC_BUNDLES.has(bundle);
  const playing  = info.playing === true || info.playbackRate > 0;
  // 进度由前端实时插值：elapsedTime(秒) + (now - timestamp) * rate
  const elapsed  = typeof info.elapsedTime  === 'number' ? info.elapsedTime  : 0;
  const tsMs     = info.timestamp ? Date.parse(info.timestamp) : Date.now();
  const rate     = typeof info.playbackRate === 'number' ? info.playbackRate : (playing ? 1 : 0);
  const duration = typeof info.duration     === 'number' ? info.duration     : 0;

  const songKey = `${title}|${artist}`;
  let artwork   = musicCache.artwork || null;
  let lyrics    = musicCache.lyrics  || [];

  if (songKey !== musicSong) {   // 切歌：更新封面、重搜歌词
    musicSong = songKey;

    // 封面：media-control 直接给 base64 + mime，拼成 data URI
    const thumbBuf = (info.artworkData && info.artworkData.length > 100)
      ? Buffer.from(info.artworkData, 'base64') : null;
    if (thumbBuf) {
      artwork = `data:${info.artworkMimeType || 'image/jpeg'};base64,${info.artworkData}`;
    } else {
      artwork = null;
    }

    // 歌词 + 高清封面（异步，不阻塞主流程）；非音乐源不搜
    lyrics = [];
    if (isMusic) {
      searchSong(title, artist, duration, info.album || '', thumbBuf).then(hit => {
        if (!hit || musicSong !== songKey) return;   // 已切歌则丢弃
        // 仅在高置信（专辑/时长吻合）时才换网易云高清图；否则保留系统缩略图
        if (hit.cover && hit.confident) musicCache = { ...musicCache, artwork: hit.cover };
        fetchLrc(hit.id).then(lrc => {
          if (musicSong === songKey) musicCache = { ...musicCache, lyrics: lrc };
        });
      });
    }
  }

  musicCache = {
    ok: true,
    title, artist, album: info.album || '',
    bundle, isMusic, playing,
    elapsed, timestamp: tsMs, rate, duration,
    artwork, lyrics,
  };
}

setInterval(() => {
  if (Date.now() - musicLastReq < 30000) fetchMusic();
}, 2000);

function handleMusic(res) {
  musicLastReq = Date.now();
  if (!musicCache.ok && !musicSong) fetchMusic();
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(musicCache));
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

  if (urlPath === '/api/music') {
    handleMusic(res);
  } else if (urlPath === '/api/refresh') {
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
