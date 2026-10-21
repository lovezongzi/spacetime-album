#!/bin/bash
# 把本地服务端通过 Cloudflare 隧道暴露成一个临时公网 https 地址
#
# 用法：
#   ./scripts/tunnel.sh
#
# 得到类似 https://xxxx-yyyy.trycloudflare.com 的地址后，
# 把它填进 miniprogram/config.js 的 BASE_URL。
#
# 注意：这个地址在你关掉脚本后就失效，换一次就变。
# 只适合体验版临时用；要长期稳定就得备案域名 + 固定服务器。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CF="$HOME/.local/bin/cloudflared"
PORT="${1:-4173}"

if [ ! -x "$CF" ]; then
  echo "✗ 没找到 cloudflared：$CF"
  echo "  安装：curl -L -o /tmp/cf.tgz https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz"
  echo "        tar xzf /tmp/cf.tgz -C /tmp && mkdir -p ~/.local/bin && cp /tmp/cloudflared ~/.local/bin/"
  exit 1
fi

# 服务端没在跑就先拉起来
if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "服务端未运行，正在启动…"
  ( cd "$ROOT" && PORT="$PORT" nohup node server/index.js > /tmp/spacetime-tunnel-server.log 2>&1 & )
  sleep 1.5
fi

echo "本地服务：http://127.0.0.1:$PORT"
echo "正在建立隧道，几秒后下面会出现一个 https 地址…"
echo

"$CF" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate
