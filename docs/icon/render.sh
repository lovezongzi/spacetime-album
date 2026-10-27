#!/usr/bin/env bash
# 把 icon.svg 渲染成各尺寸 PNG，并生成小尺寸预览
set -euo pipefail
cd "$(dirname "$0")"

CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SHOT=(--headless=new --no-sandbox --disable-gpu --hide-scrollbars --no-first-run
      --force-device-scale-factor=1 --virtual-time-budget=3000)

# 1) 内联成 HTML 再截，避免直接打开 .svg 时的缩放误差
{
  printf '%s' '<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#120D1E}
svg{display:block;width:100vw;height:100vh}
</style></head><body>'
  cat icon.svg
  printf '%s' '</body></html>'
} > sheet.html

"$CH" "${SHOT[@]}" --window-size=1024,1024 --screenshot=icon-1024.png \
  "file://$PWD/sheet.html" >/dev/null 2>&1

# 2) 派生尺寸
for s in 512 192 144 96; do
  /usr/bin/sips -s format png --resampleHeightWidth "$s" "$s" icon-1024.png \
    --out "icon-$s.png" >/dev/null 2>&1
done

# 3) 预览：圆形裁剪（微信里就是这样显示的）+ 真机尺寸
{
  printf '%s' '<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#EFEAE2;font:13px/1.6 -apple-system,sans-serif;color:#4a4136;
     display:flex;align-items:flex-end;gap:34px;padding:44px 46px}
figure{margin:0;text-align:center}
img{border-radius:50%;display:block;margin:0 auto 12px;background:#120D1E}
figcaption{font-size:12px;letter-spacing:.4px;opacity:.62}
</style></head><body>'
  for s in 144 96 64 40; do
    printf '<figure><img src="icon-512.png" width="%s" height="%s"><figcaption>%spx</figcaption></figure>' \
      "$s" "$s" "$s"
  done
  printf '%s' '</body></html>'
} > preview.html

"$CH" "${SHOT[@]}" --window-size=780,320 --screenshot=preview-round.png \
  "file://$PWD/preview.html" >/dev/null 2>&1

echo "生成完成："
ls -1 icon-*.png preview-round.png | while read -r f; do
  printf '  %-20s %s\n' "$f" "$(/usr/bin/sips -g pixelWidth -g pixelHeight "$f" 2>/dev/null | /usr/bin/awk '/pixel/{printf "%s ", $2}')"
done
