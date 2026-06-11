#!/usr/bin/env node
/**
 * update-usage.js (v6 — AppleScript + Chrome injection，已定位真实端点)
 *
 * 端点：GET /api/organizations/{org_uuid}/usage
 * 响应：{ five_hour: { utilization, resets_at }, seven_day: { utilization, resets_at } }
 *
 * 前置条件：Chrome 中有已登录的 claude.ai 标签页
 *           View → Developer → Allow JavaScript from Apple Events  ✓
 *
 * 用法：node update-usage.js
 *
 * cron 每 5 分钟：
 *   *\/5 * * * * cd /Users/maple/Desktop/Maple/project/card && node update-usage.js
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawnSync } = require('child_process');

const OUT_FILE    = path.join(__dirname, 'usage-data.js');
const STORAGE_KEY = '__cd_usage_result';

// 读取 .env（轻量解析，无依赖；目前仅用 ACCOUNT_LABEL 作面板右下角显示）
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

// ── AppleScript 工具 ───────────────────────────────────────
function runAppleScript(script) {
  const tmp = path.join(os.tmpdir(), `cd-${Date.now()}.applescript`);
  fs.writeFileSync(tmp, script, 'utf8');
  const r = spawnSync('osascript', [tmp], { encoding: 'utf8', timeout: 20000 });
  try { fs.unlinkSync(tmp); } catch {}
  if (r.error) throw r.error;
  return (r.stdout || '').trim();
}

function esc(js) {
  return js.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
}

function execInChrome(js) {
  const result = runAppleScript(`
tell application "Google Chrome"
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t contains "claude.ai" then
        execute t javascript "${esc(js)}"
        return "ok"
      end if
    end repeat
  end repeat
  return "no_claude_tab"
end tell`);
  return result;
}

function evalInChrome(expr) {
  return runAppleScript(`
tell application "Google Chrome"
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t contains "claude.ai" then
        return execute t javascript "${esc(expr)}"
      end if
    end repeat
  end repeat
  return ""
end tell`);
}

// ── 注入脚本（纯 .then() 链，不用 async/await）────────────
const INJECT_JS = `
(function() {
  sessionStorage.removeItem('${STORAGE_KEY}');
  fetch('/api/account')
    .then(function(r) { return r.text(); })
    .then(function(t) {
      var account  = JSON.parse(t);
      var orgUuid  = account.memberships[0].organization.uuid;
      fetch('/api/organizations/' + orgUuid + '/usage')
        .then(function(r2) { return r2.text(); })
        .then(function(t2) {
          sessionStorage.setItem('${STORAGE_KEY}', JSON.stringify({ ok: true, d: JSON.parse(t2) }));
        })
        .catch(function(e) {
          sessionStorage.setItem('${STORAGE_KEY}', JSON.stringify({ ok: false, error: 'usage fetch: ' + e.message }));
        });
    })
    .catch(function(e) {
      sessionStorage.setItem('${STORAGE_KEY}', JSON.stringify({ ok: false, error: 'account fetch: ' + e.message }));
    });
})()
`;

// ── 主流程 ─────────────────────────────────────────────────
async function fetchUsage() {
  // 确认 AppleScript 注入可用
  const test = execInChrome(`sessionStorage.setItem('__cd_sync','1');'ok'`);
  if (test === 'no_claude_tab') {
    throw new Error('Chrome 中未找到 claude.ai 标签页，请先在 Chrome 打开 https://claude.ai 并登录');
  }
  const testVal = evalInChrome(`sessionStorage.getItem('__cd_sync')`);
  if (testVal !== '1') {
    throw new Error('AppleScript 注入失败，请检查：View → Developer → Allow JavaScript from Apple Events');
  }

  // 注入用量抓取脚本
  execInChrome(INJECT_JS);

  // 等待异步 fetch 完成（最多 20 秒）
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const val = evalInChrome(`sessionStorage.getItem('${STORAGE_KEY}')`);
    if (val && val !== 'null' && val !== '') {
      const result = JSON.parse(val);
      if (!result.ok) throw new Error(result.error || '未知错误');
      return result.d;
    }
  }
  throw new Error('超时：20 秒内未收到数据，请检查 Chrome 标签页是否正常加载');
}

// ── 解析响应 ───────────────────────────────────────────────
function parseData(data) {
  const pct5h     = data.five_hour?.utilization  ?? null;
  const pct7d     = data.seven_day?.utilization  ?? null;
  const resetAt5h = data.five_hour?.resets_at    ?? null;
  const resetAt7d = data.seven_day?.resets_at    ?? null;
  return { pct5h, pct7d, resetAt5h, resetAt7d };
}

// ── 写入 usage-data.js ─────────────────────────────────────
async function main() {
  let raw;
  try {
    raw = await fetchUsage();
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  const p = parseData(raw);
  const payload = {
    pct5h:     p.pct5h  !== null ? Math.round(p.pct5h)  : null,
    pct7d:     p.pct7d  !== null ? Math.round(p.pct7d)  : null,
    resetAt5h: p.resetAt5h ?? null,
    resetAt7d: p.resetAt7d ?? null,
    updatedAt: new Date().toISOString(),
    isStale:   false,
    source:    'chrome-injection',
    account:   readEnv().ACCOUNT_LABEL || null,
  };

  fs.writeFileSync(
    OUT_FILE,
    `// Auto-generated — do not edit\n` +
    `// ${new Date().toISOString()}\n` +
    `window.USAGE_DATA = ${JSON.stringify(payload, null, 2)};\n`,
    'utf8'
  );

  const fmt = p => p !== null ? `${p}%` : '--';
  const fmtReset = iso => {
    if (!iso) return '--';
    const diff = new Date(iso) - Date.now();
    if (diff <= 0) return '即将重置';
    const d = Math.floor(diff / 86400000);
    if (d > 0) return `${d}d 后`;
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m 后` : `${m}m 后`;
  };

  console.log('✅ 已获取服务端真实额度');
  console.log(`   5小时已用：${fmt(payload.pct5h)}  重置：${fmtReset(payload.resetAt5h)}`);
  console.log(`   7天已用：  ${fmt(payload.pct7d)}  重置：${fmtReset(payload.resetAt7d)}`);
  console.log(`   更新时间：${payload.updatedAt}`);
  console.log(`   输出：${OUT_FILE}`);
}

main().catch(e => { console.error(`❌ ${e.message}`); process.exit(1); });
