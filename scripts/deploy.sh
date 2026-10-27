#!/bin/bash
# 部署云函数到微信云开发
#
# 用法：
#   ./scripts/deploy.sh                      # 用 config.js 里 CLOUD_ENV（留空则用默认环境）
#   ./scripts/deploy.sh cloud1-8g0abcdef     # 指定环境 ID
#
# 前提：
#   1. 小程序后台已开通「云开发」并建好环境
#   2. 开发者工具已登录小程序管理员微信号
#   3. 依赖在云端安装（--remote-npm-install），本机不需要 npm install

set -euo pipefail

CLI="/Applications/wechatwebdevtools.app/Contents/MacOS/cli"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/miniprogram"
FN_NAME="api"

if [ ! -x "$CLI" ]; then
  echo "✗ 找不到微信开发者工具：$CLI"
  exit 1
fi

ENV_ID="${1:-}"
if [ -z "$ENV_ID" ]; then
  ENV_ID=$(/usr/bin/python3 -c "
import re
src = open('$PROJECT/config.js').read()
m = re.search(r\"CLOUD_ENV\s*=\s*'([^']*)'\", src)
print(m.group(1) if m else '')
" 2>/dev/null || echo "")
fi

if [ -z "$ENV_ID" ]; then
  echo "✗ 没拿到环境 ID。"
  echo
  echo "  先看现在有哪些环境："
  echo "    $CLI cloud env list --project $PROJECT"
  echo
  echo "  然后把环境 ID 填进 miniprogram/config.js 的 CLOUD_ENV，"
  echo "  或者直接： ./scripts/deploy.sh <环境ID>"
  exit 1
fi

echo "环境    : $ENV_ID"
echo "云函数  : $FN_NAME"
echo "项目    : $PROJECT"
echo

OUT=$("$CLI" cloud functions deploy \
  --env "$ENV_ID" \
  --names "$FN_NAME" \
  --project "$PROJECT" \
  --remote-npm-install 2>&1)

echo "$OUT" | grep -v "DeprecationWarning\|trace-deprecation"

# CLI 部署失败时退出码依然是 0，只能看输出里有没有 ✖
if echo "$OUT" | grep -q "✖ deploy cloudfunctions"; then
  echo
  if echo "$OUT" | grep -q "Creating"; then
    echo "⚠ 函数还在创建中，等 10 秒再跑一次就好："
    echo "  ./scripts/deploy.sh $ENV_ID"
  else
    echo "✗ 部署失败，看上面的报错。"
  fi
  exit 1
fi

echo
echo "✓ 云函数已部署。接下来："
echo "  1. 开发者工具里点「编译」，在模拟器里走一遍流程"
echo "  2. 确认无误后上传体验版：./scripts/upload.sh 1.0.1 \"换成云开发后端\""
