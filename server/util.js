'use strict';

const crypto = require('crypto');

/** 生成短 id */
function uid(prefix) {
  return prefix + '_' + crypto.randomBytes(7).toString('hex');
}

/** 稳定哈希（用于示例图片配色） */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const PALETTES = [
  // 火烧云
  ['#2C2A4A', '#8C4A6B', '#FF7A59', '#FFC978'],
  // 黄昏海面
  ['#1B2A4A', '#3F6C8F', '#F2A65A', '#FFE3B3'],
  // 雨后青空
  ['#223A5E', '#5B8FB9', '#A8D5E5', '#F4F1DE'],
  // 高原日落
  ['#3A2A2A', '#8A4B3C', '#E1844B', '#F7D9A0'],
  // 夏夜紫
  ['#241B3A', '#5B3A72', '#C4736F', '#F0B7A1'],
  // 清晨薄雾
  ['#3C4A57', '#7C8B96', '#C9C0A8', '#F6EFE2'],
  // 正午蓝
  ['#0F2B46', '#2E6E9E', '#8FC7DE', '#EAF6FA'],
  // 麦田金
  ['#3A2E1F', '#8A6A34', '#D9A64C', '#F6E2B3'],
  // 雪山粉
  ['#2B2F45', '#6E6A8A', '#D8A0A8', '#FBE7E1'],
  // 灰蓝雨天
  ['#2A3138', '#4E5D66', '#8FA3AB', '#DDE4E6'],
];

/** 生成一张「天空」示例缩略图（SVG data URL），用于演示账号 */
function skyThumb(seed, ratio) {
  const h = hash(String(seed));
  const pal = PALETTES[(h >> 3) % PALETTES.length];
  const w = 640;
  const hgt = ratio === 'portrait' ? 820 : Math.round(640 * (0.62 + ((h >> 9) % 25) / 100));
  const sunX = 60 + (h % 520);
  const sunY = Math.round(hgt * (0.18 + ((h >> 3) % 30) / 100));
  const sunR = 26 + (h % 46);
  const ridgeY = Math.round(hgt * (0.6 + ((h >> 5) % 16) / 100));
  const r2 = ridgeY + 14 + ((h >> 7) % 34);

  const clouds = Array.from({ length: 3 }, (_, i) => {
    const cx = 20 + ((h >> (4 + i * 3)) % 600);
    const cy = Math.round(hgt * (0.14 + i * 0.11)) + ((h >> (2 + i)) % 44);
    const rx = 80 + ((h >> (6 + i)) % 150);
    const ry = 9 + ((h >> (8 + i)) % 16);
    return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#fff" opacity="${(0.08 + i * 0.06).toFixed(2)}"/>`;
  }).join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0.2" y2="1">
<stop offset="0" stop-color="${pal[0]}"/><stop offset="0.42" stop-color="${pal[1]}"/>
<stop offset="0.74" stop-color="${pal[2]}"/><stop offset="1" stop-color="${pal[3]}"/>
</linearGradient></defs>
<rect width="${w}" height="${hgt}" fill="url(#g)"/>
<circle cx="${sunX}" cy="${sunY}" r="${sunR * 2.4}" fill="#fff" opacity="0.12"/>
<circle cx="${sunX}" cy="${sunY}" r="${sunR}" fill="#fff" opacity="0.8"/>
${clouds}
<path d="M0 ${ridgeY} L110 ${ridgeY - 38} L190 ${ridgeY - 12} L300 ${ridgeY - 54} L420 ${ridgeY - 6} L520 ${ridgeY - 30} L640 ${ridgeY + 8} L640 ${hgt} L0 ${hgt} Z" fill="#000" opacity="0.26"/>
<path d="M0 ${r2} L130 ${r2 + 12} L240 ${r2 - 16} L360 ${r2 + 10} L480 ${r2 - 8} L640 ${r2 + 16} L640 ${hgt} L0 ${hgt} Z" fill="#000" opacity="0.4"/>
</svg>`;

  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

module.exports = { uid, hash, skyThumb };
