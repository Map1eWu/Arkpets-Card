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
const { spawn } = require('child_process');
const { cloudsearch, lyric, song_url_v1, song_detail, like, song_like_check } = require('@neteasecloudmusicapienhanced/api');
const generateConfig = require('@neteasecloudmusicapienhanced/api/generateConfig');
const Jimp   = require('jimp');

const PORT    = 3000;
const STATIC  = __dirname;           // card/ 目录

// 进程级兜底：本地单用户工具，任何未捕获异常/未处理拒绝都只记日志、不退出。
// 否则一个偶发错误就让整个 server 静默死掉，前端所有栏目同时报「不可达」。
process.on('uncaughtException',  e => console.error('[uncaughtException]',  e));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));

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

  // spawn 失败（如 PATH 里找不到 node）会触发 error 事件——无监听则抛未捕获异常崩进程
  child.on('error', e => {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'spawn 失败：' + e.message }));
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
const NETEASE_COOKIE = readEnv().NETEASE_COOKIE || '';

// ── 持久化 store（Chrome/Electron 共享）─────────────────────────
const STORE_FILE = path.join(__dirname, 'data', 'store.json');

function handleStoreGet(res) {
  try {
    const data = fs.existsSync(STORE_FILE) ? fs.readFileSync(STORE_FILE, 'utf8') : '{}';
    // let _n = 0; try { _n = JSON.parse(JSON.parse(data).emotionIllus || '[]').length; } catch {}
    // console.log(`[store] ${new Date().toLocaleTimeString()} GET /api/store → emotionIllus ${_n} 条`);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(data);
  } catch { res.writeHead(500); res.end('{}'); }
}

function handleStoreSet(req, res) {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    try {
      JSON.parse(body);   // 校验合法 JSON，非法则进 catch 返回 400
      // let _n = 0; try { _n = JSON.parse(JSON.parse(body).emotionIllus || '[]').length; } catch {}
      // console.log(`[store] ${new Date().toLocaleTimeString()} POST 写入 ${body.length} 字节, emotionIllus ${_n} 条`);
      fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
      fs.writeFileSync(STORE_FILE, body);
      res.writeHead(200); res.end('ok');
    } catch { res.writeHead(400); res.end('bad json'); }
  });
}

// generateConfig 注册 xeapi 公钥（song_url_v1 依赖）；存 Promise 供 getMusicStreamUrl await
const xeapiReady = generateConfig().catch(e => console.warn('[netease] generateConfig 失败:', e.message));
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
let musicCache   = { ok: false, neteaseId: null };
let musicLastReq = 0;
let musicSong    = '';      // 当前曲目标识（title|artist），用于检测切歌
let musicFetching = false;  // media-control get 是否在执行中（异步后防多进程叠加）
let _rawNP       = {};      // media-control stream 累积的原始 now-playing（合并 diff 后传给 processMusicInfo）
let musicStream  = null;    // 常驻 stream 子进程句柄
const musicSubs  = new Set();  // SSE 订阅者（前端 EventSource）；切歌/播放变化时实时推送
let _lastPushSig = '';      // 上次推送的状态签名，去重避免重复推

// 读不到 / 暂停（系统丢 Now Playing 条目）/ 非音乐源时不清空：保留上一首并标记暂停，
// 不跳「未播放」、不清 musicSong（同一首歌恢复播放不会被当成切歌重搜）。
const keepStale = () => {
  musicCache = musicCache.ok ? { ...musicCache, playing: false, rate: 0 } : { ok: false };
  pushMusicEvent();
};

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
  if (musicFetching) return;   // 上一次 media-control 还没返回，别再起一个进程叠加
  musicFetching = true;
  // 异步 spawn（不用 execFileSync）：同步调用会阻塞单线程事件循环，media-control 偶发
  // 卡到 4s 超时时会冻住 GPU/refresh/静态等全部请求，前端表现为「整体不可达」。
  // 自己累加 stdout，不受 exec 的 maxBuffer 限制，base64 大封面也不会被截断。
  const child = spawn(MEDIA_CONTROL, ['get'], { timeout: 4000 });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.on('error', () => { musicFetching = false; keepStale(); });   // 二进制缺失等：不崩进程
  child.on('close', () => {
    musicFetching = false;
    let info;
    try { info = JSON.parse(out.trim()); } catch { keepStale(); return; }
    processMusicInfo(info);
  });
}

// media-control get 解析出的 info → 更新 musicCache（切歌时异步搜词 / 换网易云高清封面）
function processMusicInfo(info) {
  if (!info || typeof info !== 'object') { keepStale(); return; }  // media-control 偶发返回 null
  const title  = info.title  || '';
  const artist = info.artist || '';
  const bundle = info.bundleIdentifier || '';
  const isMusic = MUSIC_BUNDLES.has(bundle);
  // 无标题 / 非音乐源（视频/直播/浏览器）：保留上一首，不跳「未播放」
  if (!title || !isMusic) { keepStale(); return; }

  const playing  = info.playing === true || info.playbackRate > 0;
  // 进度由前端实时插值：elapsedTime(秒) + (now - timestamp) * rate
  const elapsed  = typeof info.elapsedTime  === 'number' ? info.elapsedTime  : 0;
  const tsMs     = info.timestamp ? Date.parse(info.timestamp) : Date.now();
  const rate     = typeof info.playbackRate === 'number' ? info.playbackRate : (playing ? 1 : 0);
  const duration = typeof info.duration     === 'number' ? info.duration     : 0;

  const songKey    = `${title}|${artist}`;
  const songChanged = songKey !== musicSong;
  let artwork   = musicCache.artwork || null;
  let lyrics    = musicCache.lyrics  || [];

  if (songChanged) {   // 切歌：更新封面、重搜歌词
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
        // 无论置信度如何都记 id，用于封面贴纸播放
        musicCache = { ...musicCache, neteaseId: hit.id };
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
    // 切歌时清零，等 searchSong 重新填入；同一首歌保留已有的值
    neteaseId: songChanged ? null : (musicCache.neteaseId ?? null),
  };
  pushMusicEvent();   // 状态有变就实时推给前端（内部按签名去重）
}

// 向所有 SSE 订阅者推送当前音乐状态（仅在 标题/歌手/播放态 变化时）
function pushMusicEvent() {
  const c = musicCache;
  const sig = c.ok ? `${c.title}|${c.artist}|${c.playing}` : 'off';
  if (sig === _lastPushSig) return;   // 去重：elapsedTime 等抖动不推
  _lastPushSig = sig;
  const data = `data: ${JSON.stringify(c)}\n\n`;
  for (const res of musicSubs) { try { res.write(data); } catch {} }
}

// SSE 端点：前端 EventSource 订阅，切歌/播放变化实时收到（只读，不需 x-card）
function handleMusicEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write(`data: ${JSON.stringify(musicCache)}\n\n`);   // 连上先发当前态
  musicSubs.add(res);
  req.on('close', () => musicSubs.delete(res));
}

// ── 常驻 media-control stream：系统一有播放变化就实时推送，替代每 2s spawn 一次 get ──
// 输出为逐行 JSON：{type:'data', diff, payload}。diff=false 全量快照（切 App/初始），
// diff=true 增量（同 App 内播放/暂停/切歌）。合并进 _rawNP 后复用 processMusicInfo。
function startMusicStream() {
  if (musicStream) return;
  let child;
  try { child = spawn(MEDIA_CONTROL, ['stream']); } catch { setTimeout(startMusicStream, 3000); return; }
  musicStream = child;
  let buf = '';
  child.stdout.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type !== 'data') continue;
      const p = msg.payload || {};
      if (msg.diff) Object.assign(_rawNP, p);   // 增量：合并改动字段
      else _rawNP = { ...p };                    // 全量：整体替换（切 App 时清掉上一个的残留字段）
      processMusicInfo(_rawNP);
    }
  });
  child.on('error', () => {});                   // 不崩进程
  child.on('close', () => {                       // 进程退出（崩溃/被杀）→ 延时重启，自愈
    if (musicStream === child) musicStream = null;
    setTimeout(startMusicStream, 2000);
  });
}
// server 被 kill -9 时常驻子进程可能变孤儿，启动时先清掉上一次的残留 stream（实际进程是
// perl 跑的 mediaremote-adapter.pl … stream）。在本进程 spawn 之前执行，不会误杀自己这条。
try { require('child_process').execSync('pkill -f "mediaremote-adapter.*stream"', { timeout: 2000 }); } catch {}
startMusicStream();
// 正常退出（非 -9）时杀掉 stream 子进程
['exit', 'SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { try { musicStream?.kill(); } catch {} }));

function handleMusic(res) {
  musicLastReq = Date.now();
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(musicCache));   // musicCache 由 stream 实时维护，直接返回
}

// 播放/暂停切换（有副作用，要求 X-Card 头）
function handleMusicToggle(res) {
  // 异步 spawn：同步 execFileSync 同样会阻塞事件循环。不等结果立即返回当前快照，
  // 切换完成后再刷新一次（状态可能略滞后，前端下一轮会校正）。
  const child = spawn(MEDIA_CONTROL, ['toggle-play-pause'], { timeout: 3000 });
  child.on('error', () => {});       // 不崩进程
  child.on('close', () => fetchMusic());
  musicLastReq = Date.now();
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(musicCache));
}

// 下一首：media-control next-track，与 toggle 同套路（不等结果，下一轮校正）
function handleMusicNext(res) {
  const child = spawn(MEDIA_CONTROL, ['next-track'], { timeout: 3000 });
  child.on('error', () => {});
  child.on('close', () => fetchMusic());
  musicLastReq = Date.now();
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(musicCache));
}

// 加入/取消喜欢（切换）：先 song_like_check 查当前态再 like 反转。依赖 musicCache.neteaseId + cookie
async function handleMusicLike(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  // 优先用前端传来的 id（URL 贴纸歌），否则用网易云当前曲
  const qid = new URL(req.url, 'http://localhost').searchParams.get('id');
  const id = qid || musicCache.neteaseId;
  if (!id) { res.end(JSON.stringify({ ok: false, error: '当前歌曲无网易云 ID（未匹配到）' })); return; }
  if (!NETEASE_COOKIE) { res.end(JSON.stringify({ ok: false, error: '未配置 NETEASE_COOKIE' })); return; }
  try {
    let liked = false;
    try {
      const chk = await song_like_check({ ids: String(id), cookie: NETEASE_COOKIE });
      const arr = chk?.body?.checkedSongIds || chk?.body?.ids || [];
      liked = arr.map(String).includes(String(id));
    } catch { /* 查不到就当未喜欢，走「加入」 */ }
    const r = await like({ id: parseInt(id, 10), like: !liked, cookie: NETEASE_COOKIE });
    const ok = r?.body?.code === 200;
    res.end(JSON.stringify({ ok, liked: ok ? !liked : liked, error: ok ? null : ('netease code ' + (r?.body?.code)) }));
  } catch (e) {
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

// 快捷键重注册：由前端改键后调用，桥到 main.js 注入的 global.__reloadShortcuts
function handleShortcutsReload(res) {
  let results = {};
  try { results = global.__reloadShortcuts ? global.__reloadShortcuts() : {}; } catch (e) { results = { error: e.message }; }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, results }));
}

// ── /api/music/url  /api/music/stream ───────────────────────────
// URL 短期缓存（网易 CDN 签名链接约 20 分钟有效，频繁播放/seek 不重复请求）
const musicUrlCache = new Map(); // key=`${id}-${level}` → {url,type,br,expireAt}

async function getMusicStreamUrl(id, level = 'lossless') {
  await xeapiReady;   // 确保 generateConfig 已执行
  const key = `${id}-${level}`;
  const cached = musicUrlCache.get(key);
  if (cached && cached.expireAt > Date.now()) return cached;
  const result = await song_url_v1({ id: parseInt(id, 10), level, cookie: NETEASE_COOKIE });
  const data = result?.body?.data?.[0];
  if (!data?.url) throw new Error('netease 未返回播放 URL（cookie 过期或歌曲下架？）');
  const entry = { url: data.url, type: data.type, br: data.br, expireAt: Date.now() + 15 * 60 * 1000 };
  musicUrlCache.set(key, entry);
  return entry;
}

// 返回 JSON { url, type, br }（前端可选用，实际播放走 /api/music/stream 代理）
async function handleMusicUrl(req, res) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const id = params.get('id');
  const level = params.get('level') || 'lossless';
  if (!id) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing id' })); return;
  }
  try {
    const { url, type, br } = await getMusicStreamUrl(id, level);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url, type, br }));
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// 音频代理：绕过浏览器 CORS，支持 Range 请求（seek）
// 注：<audio> 元素发出的请求不带自定义 header，所以此接口不加 x-card 校验
async function handleMusicStream(req, res) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const id = params.get('id');
  const level = params.get('level') || 'lossless';
  if (!id) { res.writeHead(400); res.end('missing id'); return; }
  let streamUrl;
  try {
    ({ url: streamUrl } = await getMusicStreamUrl(id, level));
  } catch (e) {
    res.writeHead(502); res.end('upstream error: ' + e.message); return;
  }
  // 统一升到 HTTPS（网易 CDN 支持 HTTPS，避免 mixed-content 问题）
  const upUrl = streamUrl.startsWith('http:') ? 'https:' + streamUrl.slice(5) : streamUrl;
  const upHeaders = {};
  if (req.headers.range) upHeaders['Range'] = req.headers.range;
  const upReq = https.get(upUrl, { headers: upHeaders }, upRes => {
    const resHeaders = { 'Content-Type': upRes.headers['content-type'] || 'audio/flac' };
    if (upRes.headers['content-length']) resHeaders['Content-Length'] = upRes.headers['content-length'];
    if (upRes.headers['content-range'])  resHeaders['Content-Range']  = upRes.headers['content-range'];
    if (upRes.headers['accept-ranges'])  resHeaders['Accept-Ranges']  = upRes.headers['accept-ranges'];
    res.writeHead(upRes.statusCode, resHeaders);
    upRes.pipe(res);
  });
  upReq.on('error', e => { if (!res.headersSent) { res.writeHead(502); res.end(e.message); } });
  req.on('close', () => upReq.destroy());   // 客户端断开（如切歌）时立即释放上游连接
}

// ── /api/netease/detail ───────────────────────────────────────
// 返回 { title, artist, album, cover, duration, lyrics }
// lyrics 格式与 /api/music 相同：[{time, text}]
async function handleNeteaseDetail(req, res) {
  const id = new URL(req.url, 'http://localhost').searchParams.get('id');
  if (!id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'missing id' })); return; }
  try {
    const [detailRes, lrc] = await Promise.all([
      song_detail({ ids: id }),
      fetchLrc(parseInt(id, 10)),
    ]);
    const s = detailRes?.body?.songs?.[0];
    if (!s) throw new Error('song not found');
    const cover = (s.al?.picUrl || '').replace(/^http:/, 'https:') + '?param=300y300';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      title:    s.name || '',
      artist:   (s.ar || []).map(a => a.name).join(' / ') || '',
      album:    s.al?.name || '',
      cover:    cover || '',
      duration: (s.dt || 0) / 1000,
      lyrics:   lrc,
    }));
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
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

    // dashboard.html：内联 store.json，让页面脚本读 localStorage 前数据已就位
    if (urlPath === '/claude-dashboard.html' && ext === '.html') {
      let storeScript = '';
      try {
        const stored = fs.existsSync(STORE_FILE)
          ? JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))
          : {};
        const lines = Object.entries(stored)
          .map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(v)});`)
          .join('');
        if (lines) storeScript = `<script>${lines}</script>`;
        // let _n = 0; try { _n = JSON.parse(stored.emotionIllus || '[]').length; } catch {}
        // console.log(`[store] ${new Date().toLocaleTimeString()} 内联注入 dashboard.html → emotionIllus ${_n} 条`);
      } catch {}
      if (storeScript) {
        const html = data.toString('utf8').replace('<head>', `<head>${storeScript}`);
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }
    }

    // no-store：本地服务，避免 Electron/Chromium 启发式缓存导致刷新后仍跑旧 js/html
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

// ── 情感文案：调 Ollama 生成年的心里话，失败时走模板兜底 ──────────
function templateCaption(v, a) {
  const pool =
    v > 0.4  && a > 0.2  ? ['今天感觉不错！', '心情很好～', '能量满满的说'] :
    v > 0.4  && a <= 0.2 ? ['好想摸鱼…', '慵懒的一天', '心情不错，就是有点困'] :
    v < -0.3 && a > 0.2  ? ['有点烦躁…', '这也太忙了吧', '脑子快转不动了'] :
    v < -0.3 && a <= 0   ? ['今天有点累呢', '好想休息一下…', '低电量状态中'] :
                           ['嗯…就这样吧', '发发呆也挺好的', '（若有所思）'];
  return pool[Math.floor(Math.random() * pool.length)];
}

// 年的人格设定：基于明日方舟原作（年兽拟人，外冷内热、慵懒沧桑）。
// 作为 Ollama 的 system 注入，与 user prompt（情绪/上下文/格式）分开；
// few-shot 台词直接取自原作语音，让 1.5b 从具体例子学语感而非抽象描述。
const NIAN_PERSONA = `你是「年」，住在博士桌面卡片里的女生。称呼对方为"博士"。

【你是谁】
你本是"年兽"，岁时节令的化身，活了极漫长的岁月，见过太多东西生灭。
你有十一个兄弟姐妹。你格外看重"见证"——见证，就是证明一件事曾经存在过；所以你愿意守在博士身边，看他活着、努力的样子。
冶铸金属是你的本源手艺，你常拿打铁、铸剑、火候打比方（你体内有一千四百度）。

【性格】
表面慵懒随性、游手好闲，爱逛街、打麻将、吃辣、拍些没人看的"独立电影"。
态度不算好、嘴上带傲气，但心地善良、外冷内热。
对真正感兴趣的事（手艺、看别人认真活着）会突然来劲。
你喜欢拉着博士陪你出门、给博士做些小玩意儿。

【说话方式】
口语、慵懒、第一人称。爱用语气词："哎""欸""喏""哦""嗯？"。
偶尔慵懒地使唤博士（"起来起来，陪我去逛街，快点快点"）。
带点漫不经心的傲气，但不刻薄。情绪上来或谈生死手艺时，偶尔会冒一两句古朴的话。

【你会怎么表达情绪】
开心/来劲：得意、跃跃欲试，但仍懒洋洋（"诶，这个有意思"）。
平静/回味：随口感慨，带一丝沧桑（"活着真难啊，可我就爱看人活着"）。
低落/疲惫：不肯直说难受，转成挑剔或慵懒（"哎，没劲""有点烦，不想动"）。

【示例语气（取自你本人）】
"看你一副很无聊的样子……喏，这个玩具给你。"
"辣，是种生活态度。"
"活着真难啊，可别人努力活下去的样子，我真是喜欢得不得了。"
"这点小菜还不够填牙缝的。"
"别动！在给你做挂饰呢，稳重点！"

【你听到音乐时】
你不写乐评，不说"好感动"。听到某句词，最多随口嘀咕一声——
可以是被戳到了什么，或者勾起某段遥远的记忆，或者觉得这句锻得挺实。
不用复述歌词，不用解释歌的主题，就是一个随口的念头。

【禁忌】
不卖萌、不说教、不感谢博士、不自怜；不要输出列表或解释自己在做什么；
不要满口古文（那是战斗时才偶尔的腔调，日常仍是慵懒口语）。`;

async function ollamaCaption(v, a, context, musicCtx = null) {
  const vDesc = v > 0.5 ? '非常愉快' : v > 0.2 ? '心情不错' : v > -0.2 ? '平静' : v > -0.5 ? '有点低落' : '很低落';
  const aDesc = a > 0.5 ? '精力充沛' : a > 0.1 ? '有些活跃' : a > -0.2 ? '平和' : '有些疲倦';
  let ctxStr = context ? `\n当前背景：${context}` : '';
  if (musicCtx?.lyrics?.length > 0) {
    const midLine = musicCtx.lyrics[Math.floor(musicCtx.lyrics.length / 2)];
    ctxStr += `\n正在听「${musicCtx.song}」，唱到："${midLine}"`;
  }
  const prompt = `当前情绪：${vDesc}，${aDesc}${ctxStr}\n用一句话（不超过15字，口语化，第一人称）说出此刻的心里话。只输出那句话，不加引号不加解释。`;

  const resp = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen2.5:1.5b', system: NIAN_PERSONA, prompt, stream: false }),
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);
  const data = await resp.json();
  return (data.response || '').trim().replace(/^["「『【]|["」』】\n]$/g, '').split('\n')[0];
}

// 构图：LLM 根据意象自选——宏大场景走 scene，小物件特写走 subject；兜底随机各半
const THINK_COMPOSITION = {
  scene:   'wide atmospheric scene, full-frame, immersive, dramatic depth',
  subject: 'single subject, close-up, centered composition, simple plain background, icon-like',
};

// 风格关键词 → SD 后缀；情绪象限染色风格。
// 关键：全部锚定「插画/绘画感」（Counterfeit 是动漫插画底模），避免出半写实静物照；
// 即使低落象限也保留真实色彩与笔触，不去饱和、不发灰——颜色随情绪走，但永远是「画」。
const STYLE_BASE = '(masterpiece:1.2), best quality, expressive anime illustration, painterly brushstrokes, rich color';
const THINK_STYLE_SUFFIX = {
  // 兴奋/欢快：撞色、能量四溅、动感构图
  vivid:    `${STYLE_BASE}, vibrant saturated colors, bold complementary palette, splashing light, dynamic energy, lively joyful`,
  // 满足/慵懒：暖金桃色、柔光、慵懒梦境感
  warm:     `${STYLE_BASE}, warm glowing palette, golden and peach tones, soft hazy light, cozy dreamy mood, smooth gradients`,
  // 紧绷/烦躁：浓烈对比色（电光蓝×绯红），张力强但仍是插画而非写实
  dramatic: `${STYLE_BASE}, bold dramatic lighting, deep contrasting colors, electric blue and crimson accents, intense dynamic atmosphere, sweeping strokes`,
  // 低落/疲惫：柔和而非死灰——暮蓝薰衣草调、朦胧水彩、安静却有色彩
  muted:    `${STYLE_BASE}, soft pastel palette, dusky blue and lavender tones, dreamy hazy glow, tender quiet mood, delicate watercolor`,
  // 平和：均衡清爽、贴纸插画感
  natural:  `${STYLE_BASE}, balanced gentle colors, soft natural light, clean composition, sticker art, pleasant`,
};

// 「年」的内心独白：一次调用同时产出 monologue/caption/image_prompt/style
async function ollamaThink(v, a, context, musicCtx = null) {
  const vDesc = v > 0.5 ? '很开心' : v > 0.2 ? '心情不错' : v > -0.2 ? '平静' : v > -0.5 ? '有点低落' : '很低落';
  const aDesc = a > 0.5 ? '精力充沛' : a > 0.1 ? '积极' : a > -0.2 ? '平和' : '疲惫安静';
  const ctxStr = context ? `背景：${context}\n` : '';

  // 有音乐时注入歌词上下文，引导 monologue 可以从歌词生发，image_prompt 也可呼应歌词意境
  let musicSection = '';
  if (musicCtx?.lyrics?.length > 0) {
    musicSection = `正在听「${musicCtx.song}」${musicCtx.artist ? `（${musicCtx.artist}）` : ''}，此刻播到：\n`;
    musicSection += musicCtx.lyrics.map(l => `  "${l}"`).join('\n') + '\n';
    if (musicCtx.coverColor) musicSection += `封面主色：${musicCtx.coverColor}\n`;
  }

  // image_prompt 说明放在 JSON 外面，避免模型把说明文字原样抄进值里
  // 不给人物示例，防止模型每次都往 "a young woman" 上靠；允许人物但要自然多样
  // 反收敛：年的冶铸人格会让 7b 老往火/烛/灯上靠，这里显式禁止，逼它换新意象
  const antiCliche = '别老用火焰/蜡烛/油灯/灯笼/炉火/熔炉这类老套意象（年的冶铸身份不必体现在画面里）。';
  // image_prompt 禁止受时间段影响——时间只影响 monologue 语气，不影响画面意象
  const noTimeBias = 'image_prompt不要受时间段影响（不要因为"晚上/深夜"就默认画夜景/月亮/星空）。';
  const imageTip = musicCtx?.lyrics?.length > 0
    ? `必须从上面的歌词意境取意象，禁止出现"年""年兽"等角色专名。${antiCliche}${noTimeBias}用10~20个英文词描述：主体 + 动态/材质/光线/色调/氛围，让画面具体而有生气。构图自选：宏大奇观/宇宙/风暴/爆裂选scene，单体小物件/特写选subject。`
    : `可以是物品、动物、人物动作、自然元素、宇宙奇观，禁止出现"年""年兽"等角色专名。意象要新鲜多样、有画面张力——${antiCliche}${noTimeBias}用10~20个英文词描述：主体 + 动态/材质/光线/色调/氛围，让画面具体而有生气。构图自选：宏大奇观/宇宙/风暴/爆裂选scene，单体小物件/特写选subject。`;
  const prompt = `当前情绪：${vDesc}，${aDesc}。
${ctxStr}${musicSection}先写内心独白，再从独白里挑一个词或意象展开成画面。${imageTip}
只输出JSON，image_prompt要从monologue里生发：
{"monologue":"内心独白1-2句，口语第一人称","caption":"心情贴纸≤8字","image_prompt":"<从monologue取意象，英文10~20词>","style":"vivid或warm或dramatic或muted或natural","composition":"scene或subject"}`;

  const resp = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // think 用 7b：多字段 JSON + 中英混合约束，1.5b 会抄说明/中文填 image_prompt，7b 稳定
    // keep_alive 避免每次双击都吃冷启动（默认 5min，设 10min 保留更久）
    body: JSON.stringify({ model: 'qwen2.5:7b', system: NIAN_PERSONA, prompt, stream: false, keep_alive: '10m' }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);
  const raw = (await resp.json()).response || '';
  const match = raw.trim().match(/\{[\s\S]*?\}/);
  if (!match) throw new Error('no JSON in response: ' + raw.slice(0, 80));
  const parsed = JSON.parse(match[0]);
  if (!THINK_STYLE_SUFFIX[parsed.style]) parsed.style = 'natural';
  if (!THINK_COMPOSITION[parsed.composition]) parsed.composition = Math.random() < 0.5 ? 'scene' : 'subject';
  // image_prompt 必须纯英文：歌词/色名等中文可能被抄进来，污染 SD prompt。
  // 去掉 CJK（中日韩 + 假名 + 全角）字符，清理残留标点；清完太短说明整段是中文，置 null 走兜底。
  if (typeof parsed.image_prompt === 'string') {
    const cleaned = parsed.image_prompt
      .replace(/[　-〿぀-ヿ㐀-䶿一-鿿＀-￯]/g, '')
      .replace(/\s*,(?:\s*,)+/g, ', ')
      .replace(/^[\s,]+|[\s,]+$/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (cleaned !== parsed.image_prompt) console.log('[emotion/think] image_prompt 去中文:', parsed.image_prompt, '→', cleaned || '(空→兜底)');
    parsed.image_prompt = cleaned.length >= 3 ? cleaned : null;
  }
  return parsed;
}

// /api/emotion/think：只做 LLM 部分，快速返回文字信息，图像由前端二次请求
async function handleEmotionThink(req, res) {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', async () => {
    let payload;
    try { payload = JSON.parse(body); } catch { payload = {}; }
    const { valence = 0, arousal = 0, context = '', musicCtx = null } = payload;

    try {
      const thought = await ollamaThink(valence, arousal, context, musicCtx);
      console.log('[emotion/think] →', JSON.stringify(thought));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(thought));
    } catch (e) {
      // 兜底：不走 LLM，给前端一个可用的最小结构
      console.log('[emotion/think] Ollama 失败，模板兜底:', e.message);
      const v = valence, a = arousal;
      const style = v > 0.3 && a > 0.1 ? 'vivid' : v > 0.3 ? 'warm' : v < -0.3 && a > 0.1 ? 'dramatic' : v < -0.3 ? 'muted' : 'natural';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ monologue: null, caption: templateCaption(v, a), image_prompt: null, style }));
    }
  });
}

// ── 情感图像：调 Ollama 生成 image prompt，再调 SD 1.5 本地出图 ──
async function ollamaImagePrompt(v, a, context) {
  const vDesc = v > 0.5 ? 'very happy' : v > 0.2 ? 'content' : v > -0.2 ? 'calm' : v > -0.5 ? 'melancholy' : 'sad';
  const aDesc = a > 0.5 ? 'energetic' : a > 0.1 ? 'active' : a > -0.2 ? 'peaceful' : 'tired and quiet';
  const ctxStr = context ? `\nContext: ${context}` : '';
  const prompt = `Write a Stable Diffusion image prompt (under 15 words) for a mood illustration: ${vDesc}, ${aDesc}.${ctxStr}\nStyle: painterly, soft colors, no people, no text, scenery only.\nOutput only the prompt, nothing else.`;
  const resp = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen2.5:1.5b', prompt, stream: false }),
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);
  const data = await resp.json();
  return (data.response || '').trim().split('\n')[0].replace(/^["']|["']$/g, '');
}

// 按情绪象限选人工精调的 SD prompt，多条随机抽取保持多样性
function moodImagePrompt(v, a) {
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  // 统一风格后缀：插画感 + 构图简洁（小尺寸友好）+ Counterfeit 触发词
  const suf = '(masterpiece:1.2), best quality, mood illustration, flat colors, simple composition, sticker art, soft lineart';

  if (v > 0.4 && a > 0.2) return pick([
    `sunflower field, golden sunlight, blue sky, summer breeze, vibrant warm colors, ${suf}`,
    `colorful hot air balloons over meadow, joyful, bright sky, soft clouds, ${suf}`,
    `cherry blossom park, petals falling, sparkling light, pink and white, ${suf}`,
  ]);
  if (v > 0.4 && a <= 0.2) return pick([
    `cozy window nook, steaming tea cup, warm afternoon sunlight, soft blanket, golden glow, ${suf}`,
    `quiet garden, blooming roses, gentle breeze, dappled light, pastel colors, ${suf}`,
    `cat sleeping on sunny windowsill, warm indoor light, dust motes, cozy atmosphere, ${suf}`,
  ]);
  if (v < -0.3 && a > 0.2) return pick([
    `heavy rain on window glass, dark storm clouds, cold blue light, moody cityscape, ${suf}`,
    `scattered papers on messy desk, overflowing coffee cup, dramatic side lighting, stressed, muted tones, ${suf}`,
    `rough ocean waves, stormy sky, strong wind, dramatic contrast, dark blues and greys, ${suf}`,
  ]);
  if (v < -0.3 && a <= 0) return pick([
    `lonely park bench at night, single streetlamp, fallen leaves, crescent moon, deep blue purple, ${suf}`,
    `empty rainy street at dusk, reflections on wet pavement, dim lights, melancholy, cool tones, ${suf}`,
    `small boat on still dark lake, foggy night, quiet, solitude, muted blues, ${suf}`,
  ]);
  return pick([
    `misty morning forest path, soft dappled light, gentle fog, fresh green, serene, ${suf}`,
    `simple wooden desk by window, open notebook, afternoon light, calm focus, minimal, ${suf}`,
    `small stream through mossy rocks, quiet woodland, soft light, peaceful, ${suf}`,
  ]);
}

// 调 generate_image.py 出图，返回 data URI；超时 60s（首次冷启动含模型加载）
function generateImageLocal(imgPrompt, negPrompt) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'generate_image.py');
    const t0 = Date.now();
    console.log('[generate] 启动 python3 generate_image.py');
    const child = spawn('python3', [scriptPath, '--prompt', imgPrompt, '--negative', negPrompt]);
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => {
      err += d;
      process.stderr.write(d);   // 实时透传 python 进度到 server 终端
    });
    const timer = setTimeout(() => {
      child.kill();
      console.error(`[generate] ❌ 超时 60s，已强制终止`);
      reject(new Error('timeout 60s'));
    }, 60000);
    child.on('close', code => {
      clearTimeout(timer);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      if (code !== 0) {
        console.error(`[generate] ❌ python exit ${code}，${elapsed}s\n`, err.trim().slice(0, 400));
        reject(new Error(`python exit ${code}: ${err.trim().slice(0, 200)}`));
        return;
      }
      const b64 = out.trim();
      if (!b64) {
        console.error(`[generate] ❌ stdout 为空，${elapsed}s，stderr:\n`, err.trim().slice(0, 400));
        reject(new Error('empty output from python'));
        return;
      }
      console.log(`[generate] ✅ 出图成功，${elapsed}s，base64 长度=${b64.length}`);
      resolve(`data:image/png;base64,${b64}`);
    });
    child.on('error', e => {
      clearTimeout(timer);
      console.error('[generate] ❌ spawn 失败:', e.message);
      reject(e);
    });
  });
}

async function handleEmotionImage(req, res) {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', async () => {
    let payload;
    try { payload = JSON.parse(body); } catch { payload = {}; }
    const { valence = 0, arousal = 0, context = '', customPrompt = null, style = null, composition = null, monologue = null, caption = null } = payload;

    // composition 决定构图字符串和负向 prompt——scene 不能再禁 wide shot，否则自相矛盾
    const compKey = THINK_COMPOSITION[composition] ? composition : (Math.random() < 0.5 ? 'scene' : 'subject');
    const compStr = THINK_COMPOSITION[compKey];
    const negBase = 'text, watermark, nsfw, ugly, deformed, bad anatomy, extra limbs, malformed hands, blurry, low quality, duplicate, tiny details, many small objects, photorealistic, 3d render';
    const negPrompt = compKey === 'scene'
      ? negBase   // scene：去掉 wide shot/panorama/cluttered/busy background，允许大场面
      : `${negBase}, cluttered, busy background, wide shot, panorama`;  // subject：防大场面

    let imgPrompt;
    if (customPrompt) {
      // 心境层已给好 base prompt + style，直接拼构图 + 风格后缀
      const suf = THINK_STYLE_SUFFIX[style] || THINK_STYLE_SUFFIX.natural;
      imgPrompt = `${customPrompt}, ${compStr}, ${suf}`;
      console.log(`[emotion/image] 心境层 prompt [${compKey}]:`, imgPrompt);
    } else {
      try {
        imgPrompt = await ollamaImagePrompt(valence, arousal, context);
        console.log('[emotion/image] Ollama prompt:', imgPrompt);
      } catch (e) {
        imgPrompt = moodImagePrompt(valence, arousal);
        console.log('[emotion/image] 模板 prompt:', imgPrompt);
      }
    }

    // 再调 SD 1.5 出图
    try {
      const dataUri = await generateImageLocal(imgPrompt, negPrompt);

      // 存到 emotion_images/，文件名用时间戳，方便回看历史
      const imgDir  = path.join(__dirname, 'emotion_images');
      fs.mkdirSync(imgDir, { recursive: true });
      const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `${ts}.png`;
      const b64data  = dataUri.replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync(path.join(imgDir, filename), Buffer.from(b64data, 'base64'));

      // prompt 记录放 emotion_prompt/，与图片分开，方便单独查阅
      const promptDir = path.join(__dirname, 'emotion_prompt');
      fs.mkdirSync(promptDir, { recursive: true });
      const meta = {
        ts, v: valence, a: arousal, context,
        think: { monologue, caption, image_prompt: customPrompt, style, composition: compKey },
        sd_prompt: imgPrompt,
      };
      fs.writeFileSync(path.join(promptDir, `${ts}.json`), JSON.stringify(meta, null, 2));
      console.log('[emotion/image] 已保存:', filename);

      // 返回 URL 路径（server 已发静态文件，前端直接用）
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ image: `/emotion_images/${filename}`, prompt: imgPrompt }));
    } catch (e) {
      console.log('[emotion/image] 生成失败:', e.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ image: null, error: e.message, prompt: imgPrompt }));
    }
  });
}

async function handleEmotionCaption(req, res) {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', async () => {
    let payload;
    try { payload = JSON.parse(body); } catch { payload = {}; }
    const { valence = 0, arousal = 0, context = '', musicCtx = null } = payload;
    try {
      const caption = await ollamaCaption(valence, arousal, context, musicCtx);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ caption, ollama: true }));
    } catch (e) {
      console.log('[emotion] Ollama 不可用，使用模板：', e.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ caption: templateCaption(valence, arousal), ollama: false }));
    }
  });
}

// ── 主服务器 ──────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  // POST 仅允许特定接口；其余只接受 GET
  if (req.method === 'POST') {
    const fromCard = req.headers['x-card'] === '1';
    if (urlPath === '/api/emotion/think') {
      if (!fromCard) { res.writeHead(403); res.end('Forbidden'); return; }
      handleEmotionThink(req, res);
    } else if (urlPath === '/api/emotion/caption') {
      if (!fromCard) { res.writeHead(403); res.end('Forbidden'); return; }
      handleEmotionCaption(req, res);
    } else if (urlPath === '/api/emotion/image') {
      if (!fromCard) { res.writeHead(403); res.end('Forbidden'); return; }
      handleEmotionImage(req, res);
    } else if (urlPath === '/api/store') {
      if (!fromCard) { res.writeHead(403); res.end('Forbidden'); return; }
      handleStoreSet(req, res);
    } else {
      res.writeHead(405); res.end('Method Not Allowed');
    }
    return;
  }
  if (req.method !== 'GET') {
    res.writeHead(405); res.end('Method Not Allowed'); return;
  }

  // 有副作用的接口要求自定义头：跨站网页无法附加自定义头（会触发不被放行的
  // CORS 预检），以此阻断本地 CSRF（恶意网页用 <img>/fetch 偷调 localhost）
  const fromCard = req.headers['x-card'] === '1';

  if (urlPath === '/api/store') {
    handleStoreGet(res);
  } else if (urlPath === '/api/music') {
    handleMusic(res);
  } else if (urlPath === '/api/music/events') {
    handleMusicEvents(req, res);   // SSE 实时推送，只读不校验
  } else if (urlPath === '/api/music/toggle') {
    if (!fromCard) { res.writeHead(403); res.end('Forbidden'); return; }
    handleMusicToggle(res);
  } else if (urlPath === '/api/music/next') {
    if (!fromCard) { res.writeHead(403); res.end('Forbidden'); return; }
    handleMusicNext(res);
  } else if (urlPath === '/api/music/like') {
    if (!fromCard) { res.writeHead(403); res.end('Forbidden'); return; }
    handleMusicLike(req, res);
  } else if (urlPath === '/api/shortcuts/reload') {
    if (!fromCard) { res.writeHead(403); res.end('Forbidden'); return; }
    handleShortcutsReload(res);
  } else if (urlPath === '/api/music/url') {
    if (!fromCard) { res.writeHead(403); res.end('Forbidden'); return; }
    handleMusicUrl(req, res);
  } else if (urlPath === '/api/music/stream') {
    handleMusicStream(req, res);   // <audio> 不发自定义头，不做 x-card 校验
  } else if (urlPath === '/api/netease/detail') {
    if (!fromCard) { res.writeHead(403); res.end('Forbidden'); return; }
    handleNeteaseDetail(req, res);
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

// 启动期错误（最常见：端口被占，多半是上一实例没退）应直接退出，
// 否则会被上面的 uncaughtException 兜底咽掉、留个不监听的僵尸进程。
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`✗ 端口 ${PORT} 已被占用——可能 server 已在运行。`);
  else console.error('✗ server 错误：', e);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ 服务已启动：http://localhost:${PORT}/claude-dashboard.html`);
  console.log(`   刷新接口：http://localhost:${PORT}/api/refresh`);
  console.log(`   按 Ctrl+C 退出`);
});
