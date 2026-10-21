#!/bin/bash
# 上传小程序体验版
#
# 用法：
#   ./scripts/upload.sh 1.0.0 "第一次体验版"
#
# 前提：
#   1. miniprogram/project.config.json 里的 appid 已换成你自己的真实 AppID
#   2. 开发者工具已登录小程序管理员或开发者微信号
#   3. 服务端口已开（工具 → 设置 → 安全设置 → 服务端口）

set -euo pipefail

CLI="/Applications/wechatwebdevtools.app/Contents/MacOS/cli"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/miniprogram"

VERSION="${1:-1.0.0}"
DESC="${2:-体验版}"

if [ ! -x "$CLI" ]; then
  echo "✗ 找不到微信开发者工具：$CLI"
  echo "  先安装：https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html"
  exit 1
fi

APPID=$(/usr/bin/python3 -c "
import json,sys
print(json.load(open('$PROJECT/project.config.json'))['appid'])
" 2>/dev/null || echo "")

if [ -z "$APPID" ] || [ "$APPID" = "touristappid" ]; then
  echo "✗ 当前是测试号 / 空 AppID，无法上传体验版。"
  echo "  请把 miniprogram/project.config.json 的 appid 换成你在 mp.weixin.qq.com 注册后拿到的真实 AppID。"
  exit 1
fi

echo "项目    : $PROJECT"
echo "AppID   : $APPID"
echo "版本号  : $VERSION"
echo "描述    : $DESC"
echo

"$CLI" upload --project "$PROJECT" -v "$VERSION" -d "$DESC"

echo
echo "✓ 上传完成。接下来到 https://mp.weixin.qq.com → 管理 → 版本管理："
echo "  1. 在「开发版本」里找到刚上传的版本"
echo "  2. 点「选为体验版」"
echo "  3. 到「成员管理 → 体验成员」把朋友的微信号加进来（上限 100 人）"
echo "  4. 把体验版二维码发给他们"
