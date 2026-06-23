#!/bin/bash
# Claude Card 一键启动（Electron）
# - 已在运行：杀掉旧进程，重新启动
# - 未运行：直接启动
# 手动运行或由 launchd 开机自启调用（NODE_BIN 由自启配置注入）

cd "$(dirname "$0")" || exit 1

ELECTRON="./node_modules/.bin/electron"

# 只杀「监听」3000 的进程（card 本身）。绝不能用 `lsof -ti tcp:3000`——那会把
# 「连接到」3000 的客户端也列出（如 VS Code 的 Launch 预览/浏览器），导致误杀它们。
LISTENER=$(lsof -ti tcp:3000 -sTCP:LISTEN 2>/dev/null)
if [ -n "$LISTENER" ]; then
  echo "[card] 检测到 3000 端口监听，关闭旧 card 进程..."
  echo "$LISTENER" | xargs kill -9 2>/dev/null
  sleep 0.3
fi

nohup "$ELECTRON" . > /tmp/claude-card.log 2>&1 &
echo "[card] Electron 已启动"
