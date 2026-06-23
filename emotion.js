// emotion.js — 年的情感引擎 + 气泡控制器
// 由 claude-dashboard.html 拆出，server.js 作为静态文件发出，浏览器直接加载。
// 阶段 0 完成状态；阶段 1 新代码（接线 + LLM + 图像生成）也加在这里。

// ── 情感引擎：年的内部情绪状态 ─────────────────────────────────
// valence × arousal circumplex，双时间尺度 leaky integrator。
// 纯数值计算，无外部依赖。通过 window.emotionEngine 暴露公共接口。
// 开启 debug 浮层：在控制台执行 emotionEngine.setDebug(true)
;(function() {

  // ── 状态 ──────────────────────────────────────────────────────
  const state = {
    emotion: { v: 0, a: 0 },   // 瞬时情绪，事件驱动，快衰减
    mood:    { v: 0, a: 0 },   // 长期心情，慢漂移，追 emotion
  };

  // leaky integrator 衰减率（每秒）
  // emotion: ~50s 消散完一次事件；mood: 几小时才能端到端漂移
  const DECAY_E = 0.02;
  const DECAY_M = 0.001;

  // 信号映射表：[Δvalence, Δarousal, 描述]
  const SIG = {
    usage80:      [-0.30,  0.15, '用量>80%'],
    usage95:      [-0.60, -0.10, '用量>95%'],
    usageReset:   [ 0.40,  0.20, '额度重置'],
    musicOn:      [ 0.12,  0.08, '音乐开始'],
    musicOff:     [-0.05, -0.05, '音乐停止'],
    todoDone:     [ 0.25,  0.10, '完成待办'],
    ignoredLong:  [-0.10, -0.25, '被忽略30min'],
    lateNight:    [-0.05, -0.15, '深夜'],
  };

  // 上次交互时间（用于检测长时间被忽略）
  let lastInteractAt = Date.now();

  // 上次音乐状态（切歌去重）
  let lastMusicPlaying = null;
  let lastMusicTitle   = null;

  // 完整音乐快照，供 section2 LLM 调用时取歌词/封面
  let _musicSnapshot = null;
  // 上次已为其添加封面贴纸的 neteaseId（去重，避免轮询重复添加）
  let _lastSeenNeteaseId = null;

  // 上次用量（重置检测）
  let lastUsagePct = null;

  // debug 是否显示
  let debugVisible = false;

  // ── leaky integrator tick（每秒） ─────────────────────────────
  function clamp(x) { return Math.max(-1, Math.min(1, x)); }

  setInterval(() => {
    const dt = 1;
    // emotion 向 0 衰减
    state.emotion.v *= (1 - DECAY_E * dt);
    state.emotion.a *= (1 - DECAY_E * dt);
    // mood 慢追 emotion
    state.mood.v += (state.emotion.v - state.mood.v) * DECAY_M * dt;
    state.mood.a += (state.emotion.a - state.mood.a) * DECAY_M * dt;

    // 时段信号：深夜（23:00~04:00）每整点触发一次
    const h = new Date().getHours();
    if ((h >= 23 || h < 4) && new Date().getMinutes() === 0 && new Date().getSeconds() < 2) {
      trigger('lateNight');
    }

    // 长时间被忽略检测（30min 无交互）
    if (Date.now() - lastInteractAt > 30 * 60 * 1000) {
      trigger('ignoredLong', 0.3);   // strength 弱一些，持续触发不要叠太高
    }

    if (debugVisible) updateDebugUI();
  }, 1000);

  // ── 触发情绪事件 ─────────────────────────────────────────────
  let lastEventLabel = '—';

  function trigger(key, strength = 1.0) {
    const sig = SIG[key];
    if (!sig) return;
    state.emotion.v = clamp(state.emotion.v + sig[0] * strength);
    state.emotion.a = clamp(state.emotion.a + sig[1] * strength);
    lastEventLabel  = sig[2];
    if (debugVisible) updateDebugUI();
  }

  // ── debug 浮层 ───────────────────────────────────────────────
  const dbgEl  = document.getElementById('emotion-debug');

  function barStyle(val) {
    // val 在 [-1,1]，转成 [0%,100%] 居中；颜色：正=暖绿，负=冷蓝
    const pct  = ((val + 1) / 2 * 100).toFixed(1) + '%';
    const color = val >= 0
      ? `hsl(${140 - val * 40}, 70%, 55%)`   // 正：绿→黄绿
      : `hsl(${200 + val * -40}, 60%, 55%)`;  // 负：蓝→深蓝
    return { pct, color };
  }

  function setBar(fillId, valId, val) {
    const fill = document.getElementById(fillId);
    const span = document.getElementById(valId);
    if (!fill || !span) return;
    const { pct, color } = barStyle(val);
    fill.style.width      = pct;
    fill.style.background = color;
    span.textContent      = val.toFixed(2);
  }

  function updateDebugUI() {
    const cur = current();
    setBar('ed-v-fill',  'ed-v-val',  cur.v);
    setBar('ed-a-fill',  'ed-a-val',  cur.a);
    setBar('ed-mv-fill', 'ed-mv-val', state.mood.v);
    setBar('ed-ma-fill', 'ed-ma-val', state.mood.a);
    const evEl = document.getElementById('ed-event');
    if (evEl) evEl.textContent = lastEventLabel;
  }

  // ── 公共接口 ─────────────────────────────────────────────────

  // 叠加后的驱动值（mood 40% + emotion 60%）
  function current() {
    return {
      v: clamp(state.mood.v * 0.4 + state.emotion.v * 0.6),
      a: clamp(state.mood.a * 0.4 + state.emotion.a * 0.6),
    };
  }

  // 用量变化时调用（pct 为 0~100 数字，null=未知）
  function onUsage(pct) {
    if (pct == null) return;
    // 检测重置：用量大幅回落
    if (lastUsagePct != null && lastUsagePct - pct > 20 && pct < 50) trigger('usageReset');
    else if (pct >= 95) trigger('usage95');
    else if (pct >= 80) trigger('usage80');
    lastUsagePct = pct;
  }

  // 待办勾选完成时调用
  function onTodoDone() {
    trigger('todoDone');
    lastInteractAt = Date.now();
  }

  // 供气泡控制器读取的上下文（音乐/时段）
  let _lastMusicName = '';

  // 音乐状态变化时调用（传 renderMusic 拿到的 d 对象）
  function onMusicChange(d) {
    _musicSnapshot = d.playing ? d : null;
    lastInteractAt = Date.now();   // 音乐切换算一种「关注」
    if (d.playing && (!lastMusicPlaying || d.title !== lastMusicTitle)) {
      trigger('musicOn');
      _lastMusicName = d.song || d.title || '';
    } else if (!d.playing && lastMusicPlaying) {
      trigger('musicOff');
      _lastMusicName = '';
      _lastSeenNeteaseId = null;   // 停播时重置，下次播同首歌可重新生成贴纸
    }
    // searchSong 异步完成后 neteaseId 才出现，且 artwork 已被替换为 CDN URL
    // 只在 CDN URL（非 base64）时添加，避免把大 base64 存进 localStorage
    if (d.playing && d.neteaseId && d.neteaseId !== _lastSeenNeteaseId
        && d.artwork && !d.artwork.startsWith('data:')) {
      _lastSeenNeteaseId = d.neteaseId;
      window.emotionBubble?.showMusicSticker?.(d.neteaseId, d.artwork, d.title || '', d.artist || '');
    }
    lastMusicPlaying = d.playing;
    lastMusicTitle   = d.title;
  }

  // 拼上下文字符串（供 Ollama prompt 用）
  function getContext() {
    const h = new Date().getHours();
    const period = h < 6 ? '深夜' : h < 12 ? '早上' : h < 18 ? '下午' : h < 22 ? '晚上' : '深夜';
    const parts = [];
    if (period !== '下午') parts.push(period);
    if (_lastMusicName) parts.push(`正在听「${_lastMusicName}」`);
    return parts.join('，');
  }

  // 单击 → 短句问候；双击（≤400ms）→ 额外触发完整 LLM 文案
  let _lastInteractTime = 0;
  function onInteract() {
    const now = Date.now();
    if (now - _lastInteractTime < 400) {
      window.emotionBubble?.manualCaption?.();   // 双击：LLM 文案
    } else {
      window.emotionBubble?.greetText?.();       // 单击：短句问候
    }
    _lastInteractTime = now;
    lastInteractAt    = now;
  }

  // 开/关 debug 浮层
  function setDebug(on) {
    debugVisible = !!on;
    if (dbgEl) dbgEl.classList.toggle('visible', debugVisible);
    if (debugVisible) updateDebugUI();
  }

  window.emotionEngine = { current, onUsage, onTodoDone, onMusicChange, onInteract, setDebug, getContext, getMusicSnapshot: () => _musicSnapshot, _state: state };
  console.log('✅ 情感引擎已初始化。emotionEngine.setDebug(true) 开启 debug 浮层');
})();

// ── 情感气泡控制器 ────────────────────────────────────────────
// 文字气泡：跟随年头顶。插画：可多个并存、初始环绕年（避让 UI）、可鼠标拖动。
// 对外接口：
//   emotionBubble.showText('今天有点累呢…')        → 文字气泡
//   const id = emotionBubble.showImage('data:...')  → 插画，返回 id
//   emotionBubble.removeImage(id)                   → 移除某张插画
//   emotionBubble.clearImages()                     → 移除全部插画
//   emotionBubble.hideText()
;(function() {
  const CARD_W      = 800;
  const CARD_H      = 480;
  const HEAD_OFFSET = 148;   // 年头顶到脚底的 CSS 像素估算（SCALE=0.3）
  const ILLUS_SIZE  = 48;

  const card     = document.getElementById('card');
  const textEl   = document.getElementById('emotion-text-bubble');
  const textSpan = document.getElementById('emotion-text-content');
  const trashEl  = document.getElementById('illus-trash');

  // ── 音乐贴纸播放器（全局复用，双击封面贴纸时触发） ─────────────────
  const musicAudioPlayer = Object.assign(document.createElement('audio'), { preload: 'none' });
  document.body.appendChild(musicAudioPlayer);

  // 音量：读存档，默认 30%；滑条与快捷键共用此 API
  const VOL_KEY = 'cardVolume';
  (function () { const v = parseFloat(localStorage.getItem(VOL_KEY)); musicAudioPlayer.volume = (v >= 0 && v <= 1) ? v : 0.3; })();
  window.cardVolume = {
    get() { return musicAudioPlayer.volume; },
    set(v) {
      v = Math.max(0, Math.min(1, Math.round(v * 100) / 100));
      musicAudioPlayer.volume = v;
      localStorage.setItem(VOL_KEY, String(v));
      window.onCardVolumeChange?.(v);   // 通知设置里的滑条同步
    },
    step(d) { this.set(musicAudioPlayer.volume + d); },
  };
  window.onCardVolumeChange?.(musicAudioPlayer.volume);   // 上报初值（滑条若已就绪即同步）

  let _cardSnapshot = null;   // 当前卡片播放的音乐快照，用于歌词更新时刷新
  let _urlActive    = false;  // URL 贴纸歌是否为「当前音源」（载入即 true，暂停仍 true，仅 ended/切走才 false）
  let _neteaseBaseSong = null;   // 起播 URL 时网易云所在的歌（title|artist）；切到别的歌即让位
  let _lastNeteaseSong = null;   // SSE 持续记录的网易云当前歌；起播 URL 时同步取它作基准（避免 fetch 竞态）
  let _lastNeteasePlaying = false; // SSE 持续记录的网易云是否在放
  let _awaitNeteasePause = false;  // 起播 URL 时若网易云在放，我们会暂停它；期间忽略残留的"同曲播放"事件，避免误杀刚起播的 URL
  let _pauseBothTimer = null;      // "同曲恢复→两边都停"的防抖：切歌瞬间会先来"旧标题+playing"过渡事件，延迟确认避免误判

  // 供 dashboard.js 的 toggleBtn / pollMusic / 全局快捷键检测
  window.cardMusicState = { isPlaying: false, active: false, toggle() { window.cardMusicToggle(); } };

  function stopUrlPlayer() {        // 彻底停掉 URL 播放器并把音源交还网易云
    _urlActive = false;
    _cardSnapshot = null;
    window.cardMusicState.active = false;
    musicAudioPlayer.pause();
    musicAudioPlayer.removeAttribute('src');
    musicAudioPlayer.dataset.neteaseId = '';
  }
  function reRenderCard(playing) {  // 用 audio 当前进度刷新面板（暂停时也保持显示，不回切网易云）
    if (!_cardSnapshot) return;
    _cardSnapshot = { ..._cardSnapshot, playing, rate: playing ? 1 : 0,
      elapsed: musicAudioPlayer.currentTime || _cardSnapshot.elapsed || 0, timestamp: Date.now() };
    window.renderMusicNow?.(_cardSnapshot);
  }

  // 双声监测：服务端 SSE 实时推送网易云状态（切歌/播放变化）
  function handleNeteaseState(d) {
    const isNet = d && d.ok && d.isMusic;
    // 始终记录网易云当前曲目/播放态（即使 URL 没在放），供起播 URL 时同步取基准
    if (isNet) { _lastNeteaseSong = `${d.title}|${d.artist}`; _lastNeteasePlaying = !!d.playing; }
    else _lastNeteasePlaying = false;

    if (!_urlActive || musicAudioPlayer.paused) return;     // 仅 URL 真正在放时才处理冲突
    if (!isNet) return;
    if (!d.playing) { _awaitNeteasePause = false; return; } // 网易云已暂停 → 清"等待暂停"标记，之后同曲再播即视为用户主动

    const key = `${d.title}|${d.artist}`;
    if (key !== _neteaseBaseSong) {           // 切到新歌 → URL 让位（pause 事件切面板到网易云新歌）
      clearTimeout(_pauseBothTimer);          // 取消可能挂起的"两边都停"（这其实是切歌过渡）
      stopUrlPlayer();
      return;
    }
    // 同一首在放：
    if (_awaitNeteasePause) return;   // 起播 URL 时网易云残留的播放事件 → 忽略，等我们发的暂停生效
    // 可能是用户主动恢复同一首（→双声），也可能是切歌瞬间"旧标题+playing"的过渡事件。
    // 延迟 500ms 确认：若期间切了歌，上面的让位分支会 clearTimeout 抢先处理；否则才真两边都停。
    clearTimeout(_pauseBothTimer);
    _pauseBothTimer = setTimeout(() => {
      if (!_urlActive || musicAudioPlayer.paused) return;   // 期间已让位/已停 → 作罢
      fetch('/api/music/toggle', { headers: { 'X-Card': '1' } }).catch(() => {});  // 暂停网易云
      musicAudioPlayer.pause();                                                     // 暂停 URL
    }, 500);
  }
  // 订阅服务端 SSE：网易云一切歌/变播放态就实时收到（EventSource 断线自动重连）
  (function subscribeMusic() {
    try {
      const es = new EventSource('/api/music/events');
      es.onmessage = e => {
        let d; try { d = JSON.parse(e.data); } catch { return; }
        handleNeteaseState(d);
        // URL 没占用音源时，用 SSE 实时刷新面板（网易云用自己快捷键暂停/切歌即时反映，不等 3s 轮询）
        if (!window.cardMusicState?.active && d && d.ok) window.renderMusicNow?.(d);
      };
    } catch {}
  })();

  musicAudioPlayer.addEventListener('play',  () => {
    window.cardMusicState.isPlaying = true; _urlActive = true; window.cardMusicState.active = true; reRenderCard(true);
  });
  musicAudioPlayer.addEventListener('pause', () => {
    window.cardMusicState.isPlaying = false;
    if (_urlActive) reRenderCard(false);          // 暂停≠停止：保持该 URL 歌暂停态，不回切网易云
    else { _cardSnapshot = null; window.pollMusicNow?.(); }
  });
  musicAudioPlayer.addEventListener('ended', () => {
    stopUrlPlayer();
    // URL 贴纸歌放完 → 让网易云接着下一首播放（之前播 URL 时把网易云暂停了）
    fetch('/api/music/next', { headers: { 'X-Card': '1' } }).catch(() => {});
    setTimeout(() => window.pollMusicNow?.(), 700);
  });

  // ── 统一播放控制（面板按钮 + 全局快捷键共用，URL-aware）──────────
  window.cardMusicToggle = function () {
    if (_urlActive) { musicAudioPlayer.paused ? musicAudioPlayer.play().catch(() => {}) : musicAudioPlayer.pause(); }
    else { fetch('/api/music/toggle', { headers: { 'X-Card': '1' } }).catch(() => {}); setTimeout(() => window.pollMusicNow?.(), 600); }
  };
  // 下一首：URL 激活时停 URL → 转网易云下一首并播放；否则直接网易云下一首
  window.cardMusicNext = function () {
    if (_urlActive) stopUrlPlayer();
    fetch('/api/music/next', { headers: { 'X-Card': '1' } }).catch(() => {});
    setTimeout(() => window.pollMusicNow?.(), 700);
  };
  // 加入喜欢：对「当前面板显示的歌」操作（URL 激活用贴纸 neteaseId，否则用网易云当前曲）
  window.cardMusicLike = function () {
    const id = (_urlActive && _cardSnapshot?.neteaseId) ? _cardSnapshot.neteaseId : '';
    fetch('/api/music/like' + (id ? `?id=${id}` : ''), { headers: { 'X-Card': '1' } }).catch(() => {});
  };

  function playMusicSticker(neteaseId) {
    const entry = illusList.find(o => o.neteaseId === String(neteaseId));

    // 再次右键双击同一首 → 暂停
    if (musicAudioPlayer.dataset.neteaseId === String(neteaseId) && !musicAudioPlayer.paused) {
      musicAudioPlayer.pause();
      return;
    }

    const src = `/api/music/stream?id=${neteaseId}&level=lossless`;
    if (musicAudioPlayer.src !== new URL(src, location.href).href) {
      musicAudioPlayer.src = src;
      musicAudioPlayer.dataset.neteaseId = String(neteaseId);
    }

    _neteaseBaseSong = _lastNeteaseSong;            // 同步取当前网易云歌作基准（SSE 已实时维护，避免竞态）
    _awaitNeteasePause = (_lastNeteasePlaying === true);  // 网易云在放→我们将暂停它，期间忽略残留同曲事件
    // 用实时请求确认原曲是否在播，再决定是否发暂停——避免依赖可能过期的缓存快照
    fetch('/api/music').then(r => r.json()).then(d => {
      if (d.ok && d.playing) {
        fetch('/api/music/toggle', { headers: { 'X-Card': '1' } }).catch(() => {});
      }
    }).catch(() => {});

    musicAudioPlayer.play().catch(e => console.warn('[music sticker] play:', e.message));

    // 第一轮显示：用贴纸已存的信息（可能缺歌手/歌词）
    _cardSnapshot = {
      ok: true, _cardOverride: true,
      title: entry?.songTitle || '未知曲目',
      artist: entry?.songArtist || '',
      artwork: entry?.src || '',
      playing: true, isMusic: true,
      lyrics: [], elapsed: 0,
      timestamp: Date.now(), rate: 1,
      duration: 0, neteaseId,
    };
    window.renderMusicNow?.(_cardSnapshot);

    // 异步拉完整信息（歌手 + 歌词），拿到后刷新显示；同时补全 entry 信息
    fetch(`/api/netease/detail?id=${neteaseId}`, { headers: { 'X-Card': '1' } })
      .then(r => r.json())
      .then(({ artist, lyrics, duration }) => {
        // 如果用户已经切走，不覆盖
        if (!window.cardMusicState?.isPlaying || musicAudioPlayer.dataset.neteaseId !== String(neteaseId)) return;
        _cardSnapshot = { ..._cardSnapshot, artist: artist || _cardSnapshot.artist || '—', lyrics: lyrics || [], duration: duration || 0, elapsed: musicAudioPlayer.currentTime, timestamp: Date.now() };
        window.renderMusicNow?.(_cardSnapshot);
        // 顺手补全 entry 以便下次起播直接有歌手
        if (entry && artist && !entry.songArtist) { entry.songArtist = artist; saveIllus(); }
      }).catch(() => {});
  }

  let textTimer   = null;
  let currentSide = 'right';

  function petCSSPos() { return window.petPos?.() ?? null; }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  // ── 文字气泡定位（持续跟随年） ───────────────────────────────
  function positionTextBubble() {
    if (!textEl.classList.contains('visible')) return;
    const pos = petCSSPos();
    if (!pos) return;
    const bw    = textEl.offsetWidth  || 80;
    const bh    = textEl.offsetHeight || 36;
    // 优先用骨骼头顶精确坐标，fallback 到固定偏移
    const headY = pos.headCssY ?? (pos.cssY - HEAD_OFFSET);
    const headX = pos.headCssX ?? pos.cssX;
    const GAP_V = 25;   // 垂直间距：气泡底部距头顶
    const GAP_H = 7;    // 水平偏移：气泡相对头的左右错开
    textEl.style.top  = Math.max(4, headY - bh - GAP_V) + 'px';
    textEl.style.left = currentSide === 'right'
      ? Math.min(CARD_W - bw - 4, headX + GAP_H) + 'px'
      : Math.max(4, headX - bw - GAP_H) + 'px';
  }
  setInterval(positionTextBubble, 80);

  // ── 插画系统 ─────────────────────────────────────────────────
  let illusSeq = 0;
  const illusList = [];   // [{ id, el }]，el.style.left/top 为当前位置（CSS px）
  let _isRestoring = true; // 恢复完成前为 true：禁止 saveIllus 写回，防止轮询/恢复期覆盖 store

  // 拿到需要避让的 UI 包围盒（card 坐标系，已补偿缩放）+ 年自身的盒子
  function avoidBoxes() {
    const cardRect = card.getBoundingClientRect();
    const sc = cardRect.width / CARD_W || 1;
    const boxes = [];
    // 主体内容：header + 各 pane（隐藏的 offsetParent 为 null，跳过）
    card.querySelectorAll('.header, .pane').forEach(e => {
      if (e.offsetParent === null) return;
      const r = e.getBoundingClientRect();
      boxes.push({
        x: (r.left - cardRect.left) / sc, y: (r.top - cardRect.top) / sc,
        w: r.width / sc, h: r.height / sc,
      });
    });
    // 年自身（约 90×150，以脚底中心估算），避免插画盖住年
    const pos = petCSSPos();
    if (pos) boxes.push({ x: pos.cssX - 45, y: pos.cssY - 150, w: 90, h: 150 });
    // 已有插画，避免堆叠
    illusList.forEach(({ el }) => {
      boxes.push({ x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0, w: ILLUS_SIZE, h: ILLUS_SIZE });
    });
    return boxes;
  }

  function overlapArea(a, b) {
    const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return ox * oy;
  }

  // 在年周围一圈候选位中，挑与 UI 重叠面积最小的位置
  function pickPosition() {
    const pos = petCSSPos();
    // 年还没就绪：退回左下角
    if (!pos) return { x: 28, y: CARD_H - ILLUS_SIZE - 44 };

    const cx = pos.cssX, cy = pos.cssY - 75;   // 年身体中心
    const boxes = avoidBoxes();
    const angles = [-90, -60, -120, -30, -150, 0, 180, -45, -135];   // 上方优先
    const radii  = [78, 110];

    let best = null, bestScore = Infinity;
    for (const R of radii) {
      for (const deg of angles) {
        const rad = deg * Math.PI / 180;
        const x = clamp(cx + R * Math.cos(rad) - ILLUS_SIZE / 2, 4, CARD_W - ILLUS_SIZE - 4);
        const y = clamp(cy + R * Math.sin(rad) - ILLUS_SIZE / 2, 4, CARD_H - ILLUS_SIZE - 4);
        const cand = { x, y, w: ILLUS_SIZE, h: ILLUS_SIZE };
        let score = 0;
        for (const b of boxes) score += overlapArea(cand, b);
        if (score < bestScore) { bestScore = score; best = { x, y }; }
        if (score === 0) return { x, y };   // 找到完全不遮挡的就直接用
      }
    }
    return best;
  }

  // 废纸篓坐标（card 坐标系），与 CSS 保持同步
  const TRASH = { x: CARD_W - 10 - 36, y: 10, w: 36, h: 36 };

  function isOverTrash(el) {
    const ex = parseFloat(el.style.left) || 0;
    const ey = parseFloat(el.style.top)  || 0;
    return ex < TRASH.x + TRASH.w && ex + ILLUS_SIZE > TRASH.x &&
           ey < TRASH.y + TRASH.h && ey + ILLUS_SIZE > TRASH.y;
  }

  // 把任意角度折回 [0,360)（370°与10°渲染等价，无视觉跳变）
  function normalizeRot(el) {
    const cur  = parseFloat(el.style.getPropertyValue('--illus-rot')) || 0;
    const norm = ((cur % 360) + 360) % 360;
    el.style.setProperty('--illus-rot', `${norm.toFixed(1)}deg`);
    saveIllus();
  }

  // 让插画可被鼠标拖动，拖到废纸篓上松手即删除
  function makeDraggable(el) {
    let rotDebounce = null;
    // 滚轮旋转：每个 wheel 事件 1°，全角度不限制，绕中心转；停止 300ms 后折回 0~360
    el.addEventListener('wheel', e => {
      e.preventDefault();
      e.stopPropagation();
      const cur = parseFloat(el.style.getPropertyValue('--illus-rot')) || 0;
      el.style.setProperty('--illus-rot', `${cur + Math.sign(e.deltaY)}deg`);
      saveIllus();
      clearTimeout(rotDebounce);
      rotDebounce = setTimeout(() => normalizeRot(el), 300);
    }, { passive: false });
    // 左键双击：角度平滑回正（两种贴纸统一行为）
    el.addEventListener('dblclick', e => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('rot-anim');
      el.style.setProperty('--illus-rot', '0deg');
      saveIllus();
      setTimeout(() => el.classList.remove('rot-anim'), 320);
    });
    // 右键双击：音乐贴纸播放/暂停；阻止默认菜单
    let _lastRightUpAt = 0;
    el.addEventListener('contextmenu', e => { if (el.dataset.illusType === 'music') e.preventDefault(); });
    el.addEventListener('mouseup', e => {
      if (e.button !== 2 || el.dataset.illusType !== 'music') return;
      const now = Date.now();
      if (now - _lastRightUpAt < 400) {
        _lastRightUpAt = 0;
        playMusicSticker(el.dataset.neteaseId);
      } else {
        _lastRightUpAt = now;
      }
    });
    el.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const cardRect = card.getBoundingClientRect();
      const sc = cardRect.width / CARD_W || 1;
      const sx = e.clientX, sy = e.clientY;
      const ox = parseFloat(el.style.left) || 0;
      const oy = parseFloat(el.style.top)  || 0;
      el.classList.add('dragging');
      trashEl.classList.add('show');

      function move(ev) {
        el.style.left = (ox + (ev.clientX - sx) / sc) + 'px';
        el.style.top  = (oy + (ev.clientY - sy) / sc) + 'px';
        trashEl.classList.toggle('over', isOverTrash(el));
      }
      function up() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        el.classList.remove('dragging');
        trashEl.classList.remove('show', 'over');
        if (isOverTrash(el)) {
          // 找到对应 id 删除
          const id = parseInt(el.dataset.illusId, 10);
          removeImage(id);
        } else {
          normalizeRot(el);   // 折回 0~360 并存档（顺带保存新位置）
        }
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  // ── 公共接口 ─────────────────────────────────────────────────

  function showText(text, durationMs = 9000) {
    currentSide = Math.random() < 0.5 ? 'left' : 'right';
    textSpan.textContent = text;
    textEl.className = `emotion-text-bubble side-${currentSide}`;
    requestAnimationFrame(() => {
      positionTextBubble();
      textEl.classList.add('visible');
    });
    clearTimeout(textTimer);
    if (durationMs > 0) textTimer = setTimeout(() => textEl.classList.remove('visible'), durationMs);
  }

  function hideText() {
    clearTimeout(textTimer);
    textEl.classList.remove('visible');
  }

  // ── localStorage 持久化（src + 位置，刷新后恢复） ──────────────
  const ILLUS_STORE_KEY = 'emotionIllus';

  function saveIllus() {
    // console.log(`[illus] saveIllus 调用: illusList ${illusList.length} 条, _isRestoring=${_isRestoring}`, new Error().stack.split('\n')[2]?.trim());
    if (_isRestoring) return;  // restoreIllus 完成前禁止写回，防止轮询提前覆盖
    const data = illusList.map(({ el, src, type, neteaseId, songTitle, songArtist, manual }) => {
      const entry = {
        src,
        x:   parseFloat(el.style.left) || 0,
        y:   parseFloat(el.style.top)  || 0,
        rot: parseFloat(el.style.getPropertyValue('--illus-rot')) || 0,
      };
      if (type === 'music') Object.assign(entry, { type: 'music', neteaseId, songTitle, songArtist: songArtist || '', manual: !!manual });
      return entry;
    });
    localStorage.setItem(ILLUS_STORE_KEY, JSON.stringify(data));
  }

  // 显示一张插画，返回 id（可多张并存）；durationMs>0 时自动消失
  function showImage(src, durationMs = 0, pos = null) {
    const id = ++illusSeq;
    const el = document.createElement('div');
    el.className = 'emotion-illus';
    el.dataset.illusId = id;
    const img = document.createElement('img');
    img.src = src; img.alt = '';
    el.appendChild(img);
    card.appendChild(el);

    const p = pos ?? pickPosition();
    el.style.left = p.x + 'px';
    el.style.top  = p.y + 'px';
    // 恢复存档时用 pos.rot；新图随机 -30°~+30°
    const rot = pos?.rot ?? (Math.random() * 60 - 30).toFixed(1);
    el.style.setProperty('--illus-rot', `${rot}deg`);
    makeDraggable(el);
    illusList.push({ id, el, src });

    requestAnimationFrame(() => el.classList.add('visible'));
    if (durationMs > 0) setTimeout(() => removeImage(id), durationMs);
    saveIllus();
    return id;
  }

  function removeImage(id) {
    const i = illusList.findIndex(o => o.id === id);
    if (i < 0) return;
    const { el } = illusList[i];
    illusList.splice(i, 1);
    el.classList.remove('visible');
    setTimeout(() => el.remove(), 400);
    saveIllus();
  }

  function clearImages() {
    illusList.slice().forEach(o => removeImage(o.id));
    // clearImages 会让 saveIllus 多次调，最终落成空数组
  }

  // 内部函数：将 showImage 新建的贴纸标记为音乐类型
  function _tagMusicEntry(id, neteaseId, songTitle, songArtist, manual) {
    const entry = illusList.find(o => o.id === id);
    if (!entry) return;
    entry.type       = 'music';
    entry.neteaseId  = String(neteaseId);
    entry.songTitle  = songTitle;
    entry.songArtist = songArtist;
    entry.manual     = !!manual;
    entry.el.dataset.illusType = 'music';
    entry.el.dataset.neteaseId = String(neteaseId);
    if (songTitle) entry.el.title = `${songTitle}${songArtist ? ' — ' + songArtist : ''}`;
    saveIllus();
  }

  // 自动添加专辑封面贴纸（上限 10 张自动贴，满了删最旧自动贴）
  function showMusicSticker(neteaseId, coverSrc, songTitle, songArtist, pos = null) {
    if (illusList.some(o => o.neteaseId === String(neteaseId))) return;
    // 只淘汰非手动贴纸
    const autoOnes = illusList.filter(o => o.type === 'music' && !o.manual);
    if (autoOnes.length >= 10) removeImage(autoOnes[0].id);
    const id = showImage(coverSrc, 0, pos);
    _tagMusicEntry(id, neteaseId, songTitle, songArtist || '', false);
  }

  // 手动按钮：不受上限限制，已有贴纸不消失
  function forceShowMusicSticker(neteaseId, coverSrc, songTitle, songArtist) {
    if (illusList.some(o => o.neteaseId === String(neteaseId))) return;
    const id = showImage(coverSrc, 0, null);
    _tagMusicEntry(id, neteaseId, songTitle, songArtist || '', true);
  }

  // 页面加载时还原上次的插画
  function restoreIllus() {
    let stored = [];
    try {
      stored = JSON.parse(localStorage.getItem(ILLUS_STORE_KEY) || '[]');
    } catch { stored = []; }   // localStorage 损坏才整体放弃
    // console.log(`[illus] restoreIllus 读到 localStorage.emotionIllus = ${stored.length} 条`);
    // 逐条 try/catch：单条坏掉不能拖垮其余 54 条（之前整体 catch 吞异常 → 55 变 1 的元凶）
    stored.forEach(({ src, x, y, rot, type, neteaseId, songTitle, songArtist, manual }, i) => {
      try {
        if (!src) return;
        if (type === 'music' && neteaseId) {
          const pos = { x, y, rot: rot ?? 0 };
          if (manual) {
            forceShowMusicSticker(neteaseId, src, songTitle || '', songArtist || '');
            const entry = illusList.find(o => o.neteaseId === String(neteaseId));
            if (entry) { entry.el.style.left = x + 'px'; entry.el.style.top = y + 'px'; entry.el.style.setProperty('--illus-rot', `${rot ?? 0}deg`); }
          } else {
            showMusicSticker(neteaseId, src, songTitle || '', songArtist || '', pos);
          }
        } else {
          showImage(src, 0, { x, y, rot: rot ?? 0 });
        }
      } catch (e) {
        console.warn(`[illus] 第 ${i} 条恢复失败，已跳过:`, e.message, { src, type, neteaseId });
      }
    });
    _isRestoring = false;          // 解锁 saveIllus
    window.__storeReady = true;    // 开闸：恢复完成，setItem patch 此后才允许回写 store.json
    saveIllus();                   // 以当前完整 illusList 做一次权威保存（会触发回写）
  }
  // 延迟 500ms 等 Spine / petPos 初始化完再恢复，避免 pickPosition 拿到 null
  setTimeout(restoreIllus, 500);

  // ── 音乐上下文：当前歌词5句 + 封面主色 ──────────────────────
  // 颜色提取：把封面缩到 16×16，过滤近灰像素，取有彩色像素的平均色
  let _coverColorCache = { src: '', color: null };

  // 用英文描述（会进入 image_prompt 上下文，中文会污染 SD prompt）
  function colorToDesc(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2 / 255;
    if (max - min < 20) return l < 0.35 ? 'dark' : l > 0.65 ? 'pale' : 'gray';
    let h;
    if (max === r)      h = ((g - b) / (max - min) + 6) % 6 * 60;
    else if (max === g) h = ((b - r) / (max - min) + 2) * 60;
    else                h = ((r - g) / (max - min) + 4) * 60;
    const hueMap = [[30,'red'],[60,'orange'],[90,'yellow'],[150,'green'],[210,'cyan'],[270,'blue'],[330,'purple']];
    const hue = (hueMap.find(([t]) => h < t) ?? [0,'red'])[1];
    const s = (max - min) / (l > 0.5 ? (510 - max - min) : (max + min));
    const light = l < 0.35 ? 'dark ' : l > 0.65 ? 'pale ' : '';
    return `${light}${s > 0.5 ? 'vivid' : 'muted'} ${hue}`;
  }

  async function extractDominantColor(src) {
    if (!src) return null;
    if (_coverColorCache.src === src) return _coverColorCache.color;
    return new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const cv = document.createElement('canvas');
          cv.width = cv.height = 16;
          const ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0, 16, 16);
          const px = ctx.getImageData(0, 0, 16, 16).data;
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < px.length; i += 4) {
            if (Math.max(px[i], px[i+1], px[i+2]) - Math.min(px[i], px[i+1], px[i+2]) > 30) {
              r += px[i]; g += px[i+1]; b += px[i+2]; n++;
            }
          }
          const color = n > 0 ? colorToDesc(Math.round(r/n), Math.round(g/n), Math.round(b/n)) : null;
          _coverColorCache = { src, color };
          resolve(color);
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  // 取当前播放位置附近 ±2 行，共最多 5 行歌词
  function getCurrentLyrics() {
    const d = window.emotionEngine?.getMusicSnapshot?.();
    if (!d?.playing || !d.lyrics?.length) return null;
    const pos = (d.elapsed || 0) + (Date.now() - (d.timestamp || Date.now())) / 1000 * (d.rate || 0);
    let idx = 0;
    for (let i = 0; i < d.lyrics.length; i++) {
      if (d.lyrics[i].time <= pos) idx = i;
      else break;
    }
    const start = Math.max(0, idx - 2);
    const end   = Math.min(d.lyrics.length - 1, idx + 2);
    const lines = d.lyrics.slice(start, end + 1).map(l => l.text).filter(Boolean);
    return lines.length > 0 ? { song: d.title || '', artist: d.artist || '', lyrics: lines } : null;
  }

  async function getMusicContext() {
    const info = getCurrentLyrics();
    if (!info) return null;
    const d = window.emotionEngine?.getMusicSnapshot?.();
    const coverColor = await extractDominantColor(d?.artwork ?? null);
    return { ...info, coverColor };
  }

  // ── 阶段 1：自动文案触发 ─────────────────────────────────────
  // 每分钟检查一次；满足条件时调 /api/emotion/caption → showText
  const AUTO_MIN_MS  = 5 * 60 * 1000;   // 触发最短间隔 5 分钟
  const AUTO_IDLE_MS = 30 * 60 * 1000;  // 超过 30 分钟没触发，强制一次

  // 单击后续 & 日常闲话用的原作台词池（直接取自明日方舟语音/档案，瞬时无需 LLM）
  const NIAN_QUOTES = [
    '活着真难啊，可别人努力活下去的样子，我真是喜欢得不得了。',
    '辣，是种生活态度。',
    '见证，就是证明一件事曾经存在过。',
    '不适应现实的人会被现实淘汰，这算是很普通的常识吧？',
    '冶铸是种凡俗工艺，但它也曾是往日生活的某种起源。',
    '仪式之所以能不断流传，不在于它本身有什么意义，而在于它为众人带来了什么意义。',
    '这么多年过来，我的梦已经变得很模糊了。',
    '看到最后，才算完满。',
    '铸乃众相之柱。',
    '别让你们自己的一切在不言不语中消失。',
  ];
  let lastCaptionAt  = 0;
  let lastCaptionEmo = { v: 0, a: 0 };

  async function fetchCaption() {
    const em       = window.emotionEngine?.current() ?? { v: 0, a: 0 };
    const ctx      = window.emotionEngine?.getContext?.() ?? '';
    const musicCtx = await getMusicContext();
    try {
      const resp = await fetch('/api/emotion/caption', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Card': '1' },
        body: JSON.stringify({ valence: em.v, arousal: em.a, context: ctx, musicCtx }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      console.log(`[emotion/caption | qwen2.5:1.5b] ollama=${data.ollama} →`, data.caption);
      return data.caption || null;
    } catch (e) {
      console.warn('[emotion/caption | qwen2.5:1.5b] 请求失败:', e.message);
      return null;
    }
  }

  async function maybeAutoCaption(force = false) {
    const now = Date.now();
    if (!force && now - lastCaptionAt < AUTO_MIN_MS) return;

    const em = window.emotionEngine?.current() ?? { v: 0, a: 0 };
    const dv = Math.abs(em.v - lastCaptionEmo.v);
    const da = Math.abs(em.a - lastCaptionEmo.a);
    const idleExpired = now - lastCaptionAt > AUTO_IDLE_MS;

    // 非强制时：情绪波动够大 或 空闲超时 才触发
    if (!force && !idleExpired && dv < 0.35 && da < 0.35) return;

    lastCaptionAt  = now;
    lastCaptionEmo = { v: em.v, a: em.a };

    const caption = await fetchCaption();
    if (caption) showText(caption, 12000);
  }

  // 每分钟轮询（情绪波动触发）
  setInterval(() => maybeAutoCaption(), 60 * 1000);

  // 日常闲话：每 5 分钟独立触发，不依赖情绪变化——年就是闲着想说话
  // 如果 2 分钟内已有其他 caption，跳过以避免重叠
  const CHAT_INTERVAL_MS = 5 * 60 * 1000;
  setInterval(async () => {
    if (Date.now() - lastCaptionAt < 2 * 60 * 1000) return;
    const caption = await fetchCaption();
    if (caption) {
      lastCaptionAt  = Date.now();
      lastCaptionEmo = window.emotionEngine?.current() ?? { v: 0, a: 0 };
      showText(caption, 12000);
    }
  }, CHAT_INTERVAL_MS);

  // 请求本地 SD 1.5 出图，返回图片 URL 或 null
  async function fetchImage() {
    if (localStorage.getItem('emotionImageOff') === '1') {
      console.log('[emotion/image] 已禁用（设置开关关闭）');
      return null;
    }
    const em  = window.emotionEngine?.current() ?? { v: 0, a: 0 };
    const ctx = window.emotionEngine?.getContext?.() ?? '';
    console.log(`[emotion/image] 开始请求 v=${em.v.toFixed(2)} a=${em.a.toFixed(2)}`);
    const t0 = Date.now();
    try {
      const resp = await fetch('/api/emotion/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Card': '1' },
        body: JSON.stringify({ valence: em.v, arousal: em.a, context: ctx }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      if (data.image) {
        console.log(`[emotion/image] ✅ 成功 ${elapsed}s\nprompt: ${data.prompt}\n→ ${data.image}`);
        return data.image;
      } else {
        console.warn(`[emotion/image] ❌ 失败 ${elapsed}s\nprompt: ${data.prompt ?? '(未知)'}\n原因: ${data.error ?? '未知'}`);
        return null;
      }
    } catch (e) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.error(`[emotion/image] ❌ fetch 异常 ${elapsed}s:`, e.message);
      return null;
    }
  }

  // 双击年：两段式——先快速拿到年的独白（~2s），再慢慢等图（~15s）
  let _captionRunning = false;
  async function manualCaption() {
    if (_captionRunning) return;
    _captionRunning = true;
    clearTimeout(_greetFollowTimer);   // 双击时取消单击触发的后续 timer
    const em = window.emotionEngine?.current() ?? { v: 0, a: 0 };
    lastCaptionAt  = Date.now();
    lastCaptionEmo = { v: em.v, a: em.a };
    const ctx = window.emotionEngine?.getContext?.() ?? '';
    showText('让我想想…', 0);
    const t0 = Date.now();

    // 第一阶段：LLM 产出心境（独白 + 文案 + 图片 prompt + 风格），约 2-3s
    let thought = null;
    try {
      const musicCtx = await getMusicContext();   // 放进 try：解析异常不会卡死流程/锁
      const resp = await fetch('/api/emotion/think', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Card': '1' },
        body: JSON.stringify({ valence: em.v, arousal: em.a, context: ctx, musicCtx }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      thought = await resp.json();
      console.log(`[emotion/think | qwen2.5:7b] ${((Date.now()-t0)/1000).toFixed(1)}s`, thought);
    } catch (e) {
      console.warn('[emotion/think] 失败:', e.message);
    }

    // 思考阶段展示的文字：独白优先，退而求其次用 caption
    const thinkingText = thought?.monologue || thought?.caption || null;

    // 第二阶段：SD 出图。被禁用时直接把思考文字作为最终气泡（有限时长），结束
    if (localStorage.getItem('emotionImageOff') === '1') {
      if (thinkingText) showText(thinkingText, 12000);
      else hideText();
      _captionRunning = false;
      return;
    }

    // 出图可能 ~15-60s：思考文字先持久显示，让用户感知年"在想"
    if (thinkingText) showText(thinkingText, 0);
    else hideText();

    let finalized = false;   // 是否已把气泡收尾成「有限时长」的最终态
    try {
      const resp = await fetch('/api/emotion/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Card': '1' },
        body: JSON.stringify({
          valence: em.v, arousal: em.a, context: ctx,
          customPrompt: thought?.image_prompt ?? null,
          style:        thought?.style ?? null,
          composition:  thought?.composition ?? null,
          monologue:    thought?.monologue ?? null,
          caption:      thought?.caption ?? null,
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const imgData = await resp.json();
      console.log(`[emotion/image] ${((Date.now()-t0)/1000).toFixed(1)}s total | prompt: ${imgData.prompt}`);
      // 图出来后：独白再保留 10s 后消失，caption 是贴纸标签不放进气泡
      if (thinkingText) showText(thinkingText, 10000);
      else hideText();
      finalized = true;
      if (imgData.image) showImage(imgData.image, 0);
    } catch (e) {
      console.warn('[emotion/image] 失败:', e.message);
    } finally {
      // 出图失败且未收尾：把持久显示的独白改成有限时长，别让它永久挂着
      if (!finalized) {
        if (thinkingText) showText(thinkingText, 10000);
        else hideText();
      }
      _captionRunning = false;
    }
  }

  // 单击问候：模板短句 → 6s 后跟一条后续（LLM 或原作台词）
  let _lastGreetAt = 0;
  let _greetFollowTimer = null;
  const GREET_FOLLOW_COOLDOWN_MS = 30 * 1000; // LLM 冷却 30s，冷却中用原作台词池

  function greetText() {
    const now = Date.now();
    if (now - _lastGreetAt < 3000) return;
    _lastGreetAt = now;

    const { v = 0, a = 0 } = window.emotionEngine?.current() ?? {};
    // 被戳通用反应（原作语音），无论情绪如何都可能出现
    const universalPokes = ['欸，不要啦。', '别动！在给你做挂饰呢，稳重点！', '博士，你吃了没？'];
    const emotionPool =
      v > 0.4  && a > 0.2  ? ['来陪我玩～', '今天好开心！', '能量满满！', '好想出去玩！'] :
      v > 0.4  && a <= 0.2 ? ['想你啦～', '今天有什么开心的事吗', '好满足～', '嗯哼～'] :
      v < -0.3 && a > 0.2  ? ['有点烦躁…', '今天怎么这么忙', '脑子快转不动了'] :
      v < -0.3 && a <= 0   ? ['怎么啦～', '陪陪我嘛…', '有点累了', '今天不太开心'] :
                             ['今天有什么开心的事吗', '在忙什么呀？', '看我看我！', '怎么啦～'];
    const pool = [...emotionPool, ...universalPokes];

    showText(pool[Math.floor(Math.random() * pool.length)], 6000);

    // 6.2s 后跟一条后续：LLM 冷却中用原作台词，否则调 1.5b
    clearTimeout(_greetFollowTimer);
    _greetFollowTimer = setTimeout(async () => {
      const sinceLastCaption = Date.now() - lastCaptionAt;
      if (sinceLastCaption > GREET_FOLLOW_COOLDOWN_MS) {
        // LLM 生成，贴合当前情绪
        const caption = await fetchCaption();
        if (caption) {
          lastCaptionAt  = Date.now();
          lastCaptionEmo = window.emotionEngine?.current() ?? { v: 0, a: 0 };
          showText(caption, 10000);
        }
      } else {
        // 冷却中：原作台词池，瞬时显示
        const q = NIAN_QUOTES[Math.floor(Math.random() * NIAN_QUOTES.length)];
        showText(q, 10000);
      }
    }, 6200);
  }

  window.emotionBubble = { showText, hideText, showImage, removeImage, clearImages, showMusicSticker, forceShowMusicSticker, manualCaption, greetText };

  // ── 设置面板：插画开关 + 清除按钮 ────────────────────────────
  const illusClearBtn   = document.getElementById('illusClearBtn');
  const illusOffToggle  = document.getElementById('illusOffToggle');

  if (illusClearBtn) {
    illusClearBtn.addEventListener('click', () => clearImages());
  }
  if (illusOffToggle) {
    // 初始化开关状态
    illusOffToggle.classList.toggle('on', localStorage.getItem('emotionImageOff') === '1');
    illusOffToggle.addEventListener('click', () => {
      const nowOff = localStorage.getItem('emotionImageOff') === '1';
      localStorage.setItem('emotionImageOff', nowOff ? '0' : '1');
      illusOffToggle.classList.toggle('on', !nowOff);
    });
  }

  console.log('✅ 情感气泡控制器已初始化（插画支持多张/环绕/拖动/废纸篓/持久化）');
})();
