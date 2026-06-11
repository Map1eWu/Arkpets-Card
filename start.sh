#!/bin/bash
# Claude Card 一键启动：拉起本地 server（如未运行）并打开 Chrome 应用模式窗口
# 手动运行或由 launchd 开机自启调用（NODE_BIN 由自启配置注入）

cd "$(dirname "$0")" || exit 1
NODE="${NODE_BIN:-$(command -v node)}"

# server 未运行则后台启动，并等待就绪
if ! curl -s -o /dev/null --max-time 1 http://127.0.0.1:3000; then
  nohup "$NODE" server.js > /tmp/claude-card.log 2>&1 &
  for _ in $(seq 1 20); do
    curl -s -o /dev/null --max-time 1 http://127.0.0.1:3000 && break
    sleep 0.5
  done
fi

# Chrome 应用模式窗口（无地址栏；Chrome 已运行时会转发给现有实例）
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --app=http://localhost:3000 > /dev/null 2>&1 &
