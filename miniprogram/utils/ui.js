/** 一些纯展示用的格式化工具 */

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function hash(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** 头像 / 占位渐变的索引（对应 app.wxss 里的 g0..g5） */
function gradOf(seed) {
  return hash(seed) % 6;
}

/** 2026-09-14 → 2026年9月14日 */
function prettyDate(d) {
  if (!d) return '';
  const [, m, day] = d.split('-');
  return `${d.slice(0, 4)}年${Number(m)}月${Number(day)}日`;
}

/** 2026-09-14 → 9月14日 */
function shortDate(d) {
  if (!d) return '';
  const [, m, day] = d.split('-');
  return `${Number(m)}月${Number(day)}日`;
}

function weekOf(d) {
  if (!d) return '';
  const dt = new Date(`${d}T12:00:00`);
  return WEEK[dt.getDay()] || '';
}

/** 两个日期相差几年几个月，用来做标题上的「隔了 3 年」 */
function yearGap(a, b) {
  if (!a || !b) return 0;
  return Math.abs(Number(a.slice(0, 4)) - Number(b.slice(0, 4)));
}

function distLabel(km) {
  if (km == null) return '';
  if (km <= 1) return '几乎同一处';
  if (km <= 30) return '同一座城';
  return `相距 ${Math.round(km)} 公里`;
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

module.exports = { hash, gradOf, prettyDate, shortDate, weekOf, yearGap, distLabel, today };
