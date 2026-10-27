'use strict';

/**
 * 手机照片元数据读取器：拍摄时间、坐标、机型、动态照片。
 *
 * ## 容器
 *   JPEG   APP1 里的 Exif 段；XMP 通常在另一个 APP1（部分机型合并成一个）
 *   HEIC   iPhone 默认。Exif 不在文件头，藏在 ISO BMFF 的 `meta` 盒里：
 *          `iinf` 列出条目类型，`iloc` 给出每条的绝对偏移和长度
 *   PNG    `eXIf` 分块，内容是纯 TIFF（没有 `Exif\0\0` 前缀）
 *   WebP   RIFF 容器里的 `EXIF` 分块
 *
 * 四条路最后都收敛到同一个 TIFF 解析器，日期 / 坐标只有一份取法，
 * 不会因为容器不同而出现两套结果。
 *
 * ## 动态照片（两类，结构完全不同）
 *   安卓「动态照片」（小米 / 华为 / vivo / OPPO / 荣耀 / Google 相机）
 *     本质是**一张 JPEG**，末尾直接拼接一段 MP4。切出 `[offset, fileSize)`
 *     就是可播放的视频。识别三条路：
 *       1. XMP 老标准 `Camera:MicroVideoOffset`（从文件末尾倒数的字节数）
 *       2. XMP 新标准 `Camera:MotionPhoto` + `Container:Directory` 里的 `Length`
 *       3. 兜底：在文件尾部找 `ftyp` 盒，要求盒长度恰好延伸到文件末尾
 *     第三条最要紧 —— 国产 ROM 常把 XMP 删掉或改命名空间，前两条会落空。
 *
 *   iPhone「实况照片」
 *     是**两个文件**：主图（HEIC/JPG）+ 独立的 `.MOV`。微信小程序的
 *     `wx.chooseMedia` 只返回主图，拿不到那个 MOV，这是平台限制。
 *     所以这里只负责**识别**：Apple 把实况的配对标识写进 Exif 的
 *     MakerNotes（tag 0x0011 Behavior / ContentIdentifier，是个 UUID）。
 *     上层据此引导用户补选那段视频，再用 UUID 或拍摄时间配对。
 *
 * 隐私：只读文件头和真正需要的那几段，原图不出手机。
 */

/* ------------------------------- 常量 ------------------------------- */

/** 各 TIFF 字段类型的字节宽度 */
const T_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

const HEAD = 256 * 1024; // 头部默认读这么多
const EXIF_CAP = 1024 * 1024; // 补读 Exif 的上限
const TAIL_MIN = 1.5 * 1024 * 1024; // 兜底找视频先读这么多
const TAIL_MAX = 8 * 1024 * 1024; // 还没找到再读这么多
const MOTION_MAX = 60 * 1024 * 1024; // 超过这个大小的内嵌视频直接放弃

/** 合理视频盒的品牌名，用来把 JPEG 压缩数据里偶然出现的 "ftyp" 排除掉 */
const MP4_BRANDS = [
  'isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'mp71',
  'M4V ', 'M4VH', 'M4VP', 'avc1', 'dash', 'msnv', 'qt  ',
];

/** 动态照片的两种 XMP 命名空间写法 */
const MOTION_KEYS = [
  'Camera:MicroVideo',
  'GCamera:MicroVideo',
  'Camera:MotionPhoto',
  'GCamera:MotionPhoto',
];

/* ------------------------------ 基础工具 ------------------------------ */

function tag4(view, off) {
  if (!view || off < 0 || off + 4 > view.byteLength) return '';
  return (
    String.fromCharCode(view.getUint8(off)) +
    String.fromCharCode(view.getUint8(off + 1)) +
    String.fromCharCode(view.getUint8(off + 2)) +
    String.fromCharCode(view.getUint8(off + 3))
  );
}

/** 在 view 的 [from, to) 里找一段 ASCII，返回绝对偏移，找不到 -1 */
function findAscii(view, from, to, text) {
  const n = text.length;
  const end = Math.min(to, view.byteLength) - n;
  for (let i = Math.max(0, from); i <= end; i++) {
    let hit = true;
    for (let k = 0; k < n; k++) {
      if (view.getUint8(i + k) !== text.charCodeAt(k)) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
}

/** 把一段字节读成 latin1 字符串（用于扫 XMP，中文不是我们关心的字段） */
function readText(view, from, to) {
  const end = Math.min(to, view.byteLength);
  let s = '';
  for (let i = from; i < end; i++) s += String.fromCharCode(view.getUint8(i));
  return s;
}

function clampNum(n, min, max) {
  return typeof n === 'number' && isFinite(n) && n >= min && n <= max;
}

/* ------------------------------ 时间解析 ------------------------------ */

/**
 * 手机厂商写日期的花样很多，这里统一收口。
 * 认得的写法：
 *   2026:10:27 07:33:29        EXIF 标准
 *   2026-10-27 07:33:29        部分国产 ROM
 *   2026:10:27 07:33           缺秒
 *   2026-10-27T07:33:29+08:00  XMP / ISO 8601
 *   2026-10-27T07:33:29Z       UTC
 *   20261027_073329            少数机型
 *   2026:10:27                 只有日期
 * 返回 { date:'YYYY-MM-DD', time:'HH:MM', tz:'+08:00' } 或 null。
 */
function parseTime(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  // 去掉尾部 NUL 和多余空白
  s = s.replace(/\0+$/, '').replace(/\s+$/, '');
  if (!s || s.length < 8) return null;

  let y;
  let mo;
  let d;
  let h = '';
  let mi = '';
  let tz = '';

  let m = s.match(
    /^(\d{4})[:\-\/.](\d{1,2})[:\-\/.](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+\-]\d{2}:?\d{2})?$/i
  );
  if (m) {
    y = m[1];
    mo = m[2];
    d = m[3];
    h = m[4] || '';
    mi = m[5] || '';
    tz = m[7] || '';
  } else {
    // 20261027_073329 / 20261027 073329
    m = s.match(/^(\d{4})(\d{2})(\d{2})[_ ](\d{2})(\d{2})(\d{2})$/);
    if (!m) return null;
    y = m[1];
    mo = m[2];
    d = m[3];
    h = m[4];
    mi = m[5];
  }

  const Y = +y;
  const M = +mo;
  const D = +d;
  // 未初始化的相机常写 0000:00:00，必须挡掉，否则会算出很荒唐的日期
  if (!clampNum(Y, 1990, 2100) || !clampNum(M, 1, 12) || !clampNum(D, 1, 31)) return null;

  const pad = (v) => (String(v).length < 2 ? '0' + v : String(v));
  const date = `${Y}-${pad(M)}-${pad(D)}`;

  let time = '';
  if (h !== '' && mi !== '') {
    const H = +h;
    const MI = +mi;
    if (!clampNum(H, 0, 23) || !clampNum(MI, 0, 59)) return { date, time: '', tz };
    time = `${pad(H)}:${pad(MI)}`;
  }

  if (tz && tz !== 'Z') {
    // +0800 → +08:00
    const t = tz.replace(/^([+\-])(\d{2}):?(\d{2})$/, '$1$2:$3');
    tz = t;
  } else if (tz === 'Z') {
    tz = '+00:00';
  }

  return { date, time, tz };
}

/* ------------------------------ TIFF ------------------------------ */

/**
 * 从 TIFF 头开始解析。`tiff` 是 TIFF 头在 view 里的绝对偏移。
 * JPEG / HEIC / PNG / WebP 共用这一份，避免多条路径各自漂移。
 */
function parseTiff(view, tiff) {
  const len = view.byteLength;
  if (tiff < 0 || tiff + 8 > len) return null;

  const bo = view.getUint16(tiff);
  if (bo !== 0x4949 && bo !== 0x4d4d) return null;
  const little = bo === 0x4949;
  const r16 = (o) => (o + 2 <= len ? view.getUint16(o, little) : 0);
  const r32 = (o) => (o + 4 <= len ? view.getUint32(o, little) : 0);

  function readIFD(rel) {
    if (!rel || rel <= 0) return {};
    const base = tiff + rel;
    if (base + 2 > len) return {};
    const count = r16(base);
    if (count > 512) return {}; // 明显坏掉的 IFD
    const tags = {};
    for (let i = 0; i < count; i++) {
      const e = base + 2 + i * 12;
      if (e + 12 > len) break;
      tags[r16(e)] = { type: r16(e + 2), count: r32(e + 4), entry: e };
    }
    return tags;
  }

  /** 字段值在 view 里的起点（不超过 4 字节的inline，否则跟着偏移跳） */
  function valueAt(t, i) {
    if (!t) return -1;
    const w = T_SIZE[t.type] || 1;
    const total = w * t.count;
    if (total <= 4) return t.entry + 8 + (i || 0) * w;
    const base = tiff + r32(t.entry + 8);
    return base + (i || 0) * w;
  }

  function ascii(t) {
    if (!t) return null;
    const o = valueAt(t, 0);
    if (o < 0 || o >= len) return null;
    let s = '';
    for (let i = 0; i < t.count && o + i < len; i++) {
      const c = view.getUint8(o + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.replace(/\0/g, '').trim() || null;
  }

  function u32List(t) {
    const n = t ? Math.min(t.count, 16) : 0;
    const out = [];
    for (let i = 0; i < n; i++) {
      const o = valueAt(t, i);
      if (o < 0 || o + 4 > len) break;
      out.push(r32(o));
    }
    return out;
  }

  /** 度数用的 RATIONAL 列表（度 / 分 / 秒） */
  function rationalList(t) {
    const n = t ? Math.min(t.count, 8) : 0;
    const out = [];
    for (let i = 0; i < n; i++) {
      const o = valueAt(t, i);
      if (o < 0 || o + 8 > len) break;
      const num = r32(o);
      const den = r32(o + 4);
      out.push(den ? num / den : 0);
    }
    return out;
  }

  const ifd0Rel = r32(tiff + 4);
  const ifd0 = readIFD(ifd0Rel);
  const exif = ifd0[0x8769] ? readIFD(r32(ifd0[0x8769].entry + 8)) : {};
  const gps = ifd0[0x8825] ? readIFD(r32(ifd0[0x8825].entry + 8)) : {};

  /* ---- 拍摄时间：按可信度排优先级 ---- */
  const dateCandidates = [
    { src: 'DateTimeOriginal', t: exif[0x9003], weight: 3 },
    { src: 'DateTimeDigitized', t: exif[0x9004], weight: 2 },
    { src: 'DateTime', t: ifd0[0x0132], weight: 1 },
  ];
  let time = null;
  let timeSrc = '';
  for (const c of dateCandidates) {
    const v = parseTime(ascii(c.t));
    if (v && v.date) {
      time = v;
      timeSrc = c.src;
      break;
    }
  }

  // 时区：OffsetTimeOriginal(0x9011) 最准，其次 Digitized / 通用
  let tz = time ? time.tz : '';
  if (!tz) {
    for (const tag of [0x9011, 0x9012, 0x9013]) {
      const v = ascii(exif[tag]) || ascii(ifd0[tag]);
      if (v && /^[+\-]\d{2}:?\d{2}$/.test(v.trim())) {
        tz = v.trim().replace(/^([+\-])(\d{2}):?(\d{2})$/, '$1$2:$3');
        break;
      }
    }
  }

  /* ---- GPS ---- */
  let lat = null;
  let lng = null;
  let geoApprox = false;

  const dms = (vals) => {
    if (!vals.length) return NaN;
    if (vals.length >= 3) return vals[0] + vals[1] / 60 + vals[2] / 3600;
    if (vals.length === 2) return vals[0] + vals[1] / 60;
    return vals[0];
  };

  if (gps[0x0002] && gps[0x0004]) {
    const la = dms(rationalList(gps[0x0002]));
    const lo = dms(rationalList(gps[0x0004]));
    if (isFinite(la) && isFinite(lo) && !(la === 0 && lo === 0)) {
      // Ref 缺失时按正数处理，并标记精度可疑（部分国产 ROM 会漏写）
      const latRef = (ascii(gps[0x0001]) || '').toUpperCase();
      const lngRef = (ascii(gps[0x0003]) || '').toUpperCase();
      let sLat = la;
      let sLng = lo;
      if (latRef.charAt(0) === 'S') sLat = -Math.abs(la);
      else if (latRef.charAt(0) === 'N') sLat = Math.abs(la);
      else geoApprox = true;

      if (lngRef.charAt(0) === 'W') sLng = -Math.abs(lo);
      else if (lngRef.charAt(0) === 'E') sLng = Math.abs(lo);
      else geoApprox = true;

      if (Math.abs(sLat) <= 90 && Math.abs(sLng) <= 180 && !(sLat === 0 && sLng === 0)) {
        lat = sLat;
        lng = sLng;
      }
    }
  }

  /* ---- 机型 ---- */
  const make = (ascii(ifd0[0x010f]) || '').trim();
  const model = (ascii(ifd0[0x0110]) || '').trim();

  /* ---- 实况标识：Apple 把配对 UUID 放在 MakerNotes 的 0x0011 ---- */
  let liveId = '';
  const maker = exif[0x927c] || ifd0[0x927c];
  if (maker) {
    const o = valueAt(maker, 0);
    const size = Math.min((T_SIZE[maker.type] || 1) * maker.count, 128 * 1024);
    if (o >= 0 && o + 40 <= len && size >= 40) liveId = appleLiveId(view, o, size);
  }

  return {
    date: time ? time.date : null,
    time: time ? time.time : '',
    tz: tz || '',
    timeSrc,
    lat,
    lng,
    geoApprox,
    make,
    model,
    liveId,
  };
}

/**
 * 从 Apple MakerNotes 里取实况照片的 ContentIdentifier（tag 0x0011）。
 *
 * 结构（对着真机字节核过）：
 *   "Apple iOS\0"  10 字节
 *   0x00 0x01      版本
 *   "MM" / "II"    字节序标记，位于第 12 字节
 *   IFD            从第 14 字节开始
 * 关键一点：IFD 里的值偏移是**相对 MakerNotes 起点**，不是相对 "MM"。
 *
 * 为什么必须按 tag 取、不能直接在块里搜 UUID：
 * 连拍照片的 0x0008 是 BurstUUID，格式一模一样，搜 UUID 会把连拍全误判成实况。
 */
function appleLiveId(view, start, size) {
  const end = Math.min(start + size, view.byteLength);
  if (findAscii(view, start, start + 12, 'Apple iOS') !== start) return '';

  const bo = view.getUint16(start + 12);
  if (bo !== 0x4d4d && bo !== 0x4949) return '';
  const little = bo === 0x4949;
  const r16 = (o) => (o + 2 <= end ? view.getUint16(o, little) : 0);
  const r32 = (o) => (o + 4 <= end ? view.getUint32(o, little) : 0);

  const ifd = start + 14;
  if (ifd + 2 > end) return '';
  const count = r16(ifd);
  if (count > 200) return '';

  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) break;
    if (r16(e) !== 0x0011) continue;
    const type = r16(e + 2);
    const cnt = r32(e + 4);
    if (type !== 2 || cnt < 32 || cnt > 64) return '';
    const vo = cnt <= 4 ? e + 8 : start + r32(e + 8);
    if (vo < 0 || vo + 32 > end) return '';
    return readText(view, vo, vo + Math.min(cnt, 36))
      .replace(/\0/g, '')
      .trim()
      .toUpperCase();
  }
  return '';
}

/* ------------------------------ XMP ------------------------------ */

/**
 * 从一段 XMP 文本里取需要的字段。
 * 只做字符串匹配，不上 XML 解析器 —— 手机里的 XMP 常常不合法，
 * 正则反而活得下来。
 */
function parseXmp(text) {
  const out = { date: null, time: '', tz: '', lat: null, lng: null, motion: null };
  if (!text) return out;

  /* 日期：exif:DateTimeOriginal 优先，其次 xmp:DateTimeOriginal / DateCreated。
     XMP 有元素写法和属性写法两种，都要认。 */
  const dateRes = [
    /exif:DateTimeOriginal>([^<]{8,40})</,
    /exif:DateTimeOriginal="([^"]{8,40})"/,
    /xmp:DateTimeOriginal>([^<]{8,40})</,
    /xmp:DateTimeOriginal="([^"]{8,40})"/,
    /photoshop:DateCreated>([^<]{8,40})</,
  ];
  for (const re of dateRes) {
    const m = text.match(re);
    if (m) {
      const t = parseTime(m[1]);
      if (t && t.date) {
        out.date = t.date;
        out.time = t.time;
        out.tz = t.tz;
        break;
      }
    }
  }

  /* 坐标：exif:GPSLatitude 形如 `34,14.316N` 或 `34,14,18.96N`，元素 / 属性写法都认 */
  const coord = (tagName, limit) => {
    const m =
      text.match(new RegExp('exif:' + tagName + '>([^<]{1,40})<')) ||
      text.match(new RegExp('exif:' + tagName + '="([^"]{1,40})"'));
    if (!m) return null;
    const raw = m[1].trim();
    const ref = (raw.match(/[NSEW]$/i) || [''])[0].toUpperCase();
    const nums = raw
      .replace(/[NSEW]$/i, '')
      .split(/[,\s]+/)
      .map((x) => parseFloat(x))
      .filter((x) => isFinite(x));
    if (!nums.length) return null;
    let v = nums[0];
    if (nums.length >= 3) v += nums[1] / 60 + nums[2] / 3600;
    else if (nums.length === 2) v += nums[1] / 60;
    if (ref === 'S' || ref === 'W') v = -Math.abs(v);
    return Math.abs(v) <= limit ? v : null;
  };
  out.lat = coord('GPSLatitude', 90);
  out.lng = coord('GPSLongitude', 180);

  /* 动态照片 */
  out.motion = readMotionXmp(text);
  return out;
}

/**
 * 从 XMP 里读出内嵌视频的位置。
 * 老标准只给「从文件末尾倒数的字节数」，新标准还给了明确的 Length。
 * 返回 { tailOffset, length|null } 或 null。
 */
function readMotionXmp(text) {
  if (!text) return null;

  const num = (re) => {
    const m = text.match(re);
    if (!m) return null;
    const v = parseInt(m[1], 10);
    return isFinite(v) && v > 0 ? v : null;
  };

  const declared = MOTION_KEYS.some((k) => new RegExp(k + '(?:=|>)\\s*"?1"?').test(text));

  // 老标准：MicroVideoOffset 是「距文件末尾的字节数」
  const micro = num(/MicroVideoOffset[=>]\s*"?(\d+)/);
  if (micro && declared) return { tailOffset: micro, length: null };

  // 新标准：Container:Directory 里 Semantic="MotionPhoto" 的 Item 带 Length
  const itemRe = /Item[^>]*Semantic="MotionPhoto"[^>]*/g;
  const item = text.match(itemRe);
  if (item && item.length) {
    const lenM = item[0].match(/Length="(\d+)"/);
    const len = lenM ? parseInt(lenM[1], 10) : null;
    if (len && len > 0) return { tailOffset: len, length: len };
  }

  // 只有标记没有长度：交给尾部扫描兜底
  if (declared) return { tailOffset: 0, length: null };

  return null;
}

/* ------------------------------ JPEG ------------------------------ */

/**
 * 扫 JPEG 段，收集 EXIF 的 TIFF 起点和 XMP 文本。
 * 注意 EXIF 和 XMP 都可能是 APP1，靠段内标识区分。
 */
function scanJpeg(view) {
  const len = view.byteLength;
  const out = { tiff: -1, xmp: '' };
  let off = 2;

  while (off + 4 <= len) {
    if (view.getUint8(off) !== 0xff) {
      off++;
      continue;
    }
    const marker = view.getUint8(off + 1);
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    if (marker === 0xda) break; // 进图像数据，后面不会再有元数据
    if (marker === 0xd9 || marker === 0x00) break;

    const size = view.getUint16(off + 2);
    if (size < 2) break;
    const body = off + 4;
    const bodyEnd = Math.min(off + 2 + size, len);

    if (marker === 0xe1) {
      if (tag4(view, body) === 'Exif' && view.getUint8(body + 4) === 0) {
        out.tiff = body + 6;
      } else if (findAscii(view, body, Math.min(body + 40, bodyEnd), 'http://ns.adobe.com/xap') >= 0) {
        const start = findAscii(view, body, bodyEnd, '<x:xmpmeta');
        if (start >= 0) {
          const stop = findAscii(view, start, bodyEnd, '</x:xmpmeta>');
          out.xmp = readText(view, start, stop > 0 ? stop + 12 : bodyEnd);
        }
      }
    }
    off += 2 + size;
  }
  return out;
}

/* ------------------------------ HEIF ------------------------------ */

/** 顶层扫盒 */
function findTopBox(view, type) {
  const len = view.byteLength;
  let off = 0;
  while (off + 8 <= len) {
    let size = view.getUint32(off);
    const t = tag4(view, off + 4);
    let hdr = 8;
    if (size === 1) {
      if (off + 16 > len) break;
      size = view.getUint32(off + 8) * 4294967296 + view.getUint32(off + 12);
      hdr = 16;
    } else if (size === 0) {
      size = len - off;
    }
    if (size < hdr) break;
    if (t === type) return { start: off, body: off + hdr, end: Math.min(off + size, len) };
    off += size;
  }
  return null;
}

/**
 * 读 HEIF 的索引：每个 item 的类型、名字、文件内偏移与长度。
 * `base` 是 view[0] 在文件里的绝对偏移（补读片段时用）。
 */
function readHeif(view, base) {
  const len = view.byteLength;
  const meta = findTopBox(view, 'meta');
  if (!meta) return null;

  let p = meta.body + 4; // meta 是 FullBox，跳过 version/flags
  let iinfAt = -1;
  let ilocAt = -1;
  let idatBody = -1;
  let pitmId = -1;

  while (p + 8 <= meta.end) {
    const size = view.getUint32(p);
    const t = tag4(view, p + 4);
    if (size < 8) break;
    if (t === 'iinf') iinfAt = p;
    else if (t === 'iloc') ilocAt = p;
    else if (t === 'idat') idatBody = p + 8;
    else if (t === 'pitm') pitmId = view.getUint8(p + 8) === 0 ? view.getUint16(p + 12) : view.getUint32(p + 12);
    p += size;
  }

  if (iinfAt < 0 || ilocAt < 0) return null;

  /* iinf：条目 id → { type, name } */
  const iinfVer = view.getUint8(iinfAt + 8);
  const count = iinfVer === 0 ? view.getUint16(iinfAt + 12) : view.getUint32(iinfAt + 12);
  let q = iinfAt + (iinfVer === 0 ? 14 : 16);
  const items = {};
  for (let i = 0; i < count && q + 8 <= meta.end; i++) {
    const isz = view.getUint32(q);
    if (isz < 8) break;
    if (tag4(view, q + 4) === 'infe') {
      const iver = view.getUint8(q + 8);
      let id = -1;
      let type = '';
      let nameAt = -1;
      if (iver === 2) {
        id = view.getUint16(q + 12);
        type = tag4(view, q + 16);
        nameAt = q + 20;
      } else if (iver === 3) {
        id = view.getUint32(q + 12);
        type = tag4(view, q + 18);
        nameAt = q + 22;
      }
      if (id >= 0 && nameAt > 0 && nameAt < q + isz) {
        items[id] = { type, name: readText(view, nameAt, Math.min(nameAt + 64, q + isz)).replace(/\0+$/, '') };
      }
    }
    q += isz;
  }

  /* iloc：条目 id → 偏移 / 长度 */
  const ilocVer = view.getUint8(ilocAt + 8);
  let r = ilocAt + 12;
  const offsetSize = view.getUint8(r) >> 4;
  const lengthSize = view.getUint8(r) & 0xf;
  const baseSize = view.getUint8(r + 1) >> 4;
  const indexSize = ilocVer === 1 || ilocVer === 2 ? view.getUint8(r + 1) & 0xf : 0;
  r += 2;

  const locCount = ilocVer === 2 ? view.getUint32(r) : view.getUint16(r);
  r += ilocVer === 2 ? 4 : 2;

  const readN = (n) => {
    if (!n) return 0;
    let v = 0;
    for (let i = 0; i < n && r + i < meta.end; i++) v = v * 256 + view.getUint8(r + i);
    r += n;
    return v;
  };

  for (let i = 0; i < locCount && r + 4 <= meta.end; i++) {
    const id = ilocVer === 2 ? view.getUint32(r) : view.getUint16(r);
    r += ilocVer === 2 ? 4 : 2;

    let method = 0;
    if (ilocVer === 1 || ilocVer === 2) {
      method = view.getUint8(r) & 0xf;
      r += 2;
    }
    r += 2; // data_reference_index

    const baseOffset = readN(baseSize);
    const extentCount = view.getUint16(r);
    r += 2;

    let offset = 0;
    let length = 0;
    for (let k = 0; k < extentCount; k++) {
      if (indexSize) readN(indexSize);
      const eoff = readN(offsetSize);
      const elen = readN(lengthSize);
      if (k === 0) {
        // construction_method=1 表示偏移相对 idat 负载，否则是文件绝对偏移
        const origin = method === 1 && idatBody >= 0 ? idatBody : 0;
        offset = origin + baseOffset + eoff;
        length = elen;
      } else {
        length += elen; // 多个 extent 是连续存放的
      }
    }
    if (items[id]) {
      items[id].offset = offset;
      items[id].length = length;
    }
  }

  return { items, pitmId, base: base || 0 };
}

/** 按类型找第一个 item（Exif / mime） */
function itemOfType(idx, type) {
  const ids = Object.keys(idx.items);
  for (let i = 0; i < ids.length; i++) {
    const it = idx.items[ids[i]];
    if (it.type === type) return it;
  }
  return null;
}

function parseHeic(view, base) {
  const idx = readHeif(view, base);
  if (!idx) return null;

  const out = {
    date: null, time: '', tz: '', timeSrc: '',
    lat: null, lng: null, geoApprox: false,
    make: '', model: '', liveId: '',
    xmp: '', need: null,
  };

  /* Exif 项 */
  const exif = itemOfType(idx, 'Exif');
  if (exif) {
    const local = exif.offset - base;
    if (local < 0 || local + 8 > view.byteLength) {
      // Exif 落在已读范围之外，让调用方按 iloc 的偏移补读
      out.need = { offset: exif.offset, length: Math.min(exif.length || EXIF_CAP, EXIF_CAP) };
    } else {
      const rel = view.getUint32(local);
      if (rel <= 256 * 1024) Object.assign(out, parseTiff(view, local + 4 + rel) || {});
    }
  }

  /* XMP 项：type 是 mime，名字写着 application/rdf+xml */
  const mime = itemOfType(idx, 'mime');
  if (mime && /rdf\+xml|application\/rdf/i.test(mime.name || '')) {
    const local = mime.offset - base;
    if (local >= 0 && local < view.byteLength) {
      const start = findAscii(view, local, Math.min(local + 600, view.byteLength), '<x:xmpmeta');
      if (start >= 0) {
        const stop = findAscii(view, start, local + mime.length, '</x:xmpmeta>');
        out.xmp = readText(view, start, stop > 0 ? stop + 12 : local + mime.length);
      }
    }
  }

  if (!out.date && out.xmp) {
    const x = parseXmp(out.xmp);
    if (x.date) {
      out.date = x.date;
      out.time = x.time;
      out.tz = x.tz;
      out.timeSrc = 'xmp';
    }
  }
  return out;
}

/* ------------------------------ PNG ------------------------------ */

function parsePng(view) {
  const len = view.byteLength;
  let off = 8;
  const out = { tiff: -1, xmp: '' };
  while (off + 8 <= len) {
    const size = view.getUint32(off);
    const type = tag4(view, off + 4);
    const body = off + 8;
    if (size < 0 || body + size > len) break;
    if (type === 'eXIf') {
      // PNG 的 eXIf 分块是纯 TIFF，没有 Exif\0\0 前缀
      let at = body;
      if (tag4(view, body) === 'Exif') at = body + 6;
      out.tiff = at;
      break;
    }
    if (type === 'iTXt' || type === 'tEXt') {
      const start = findAscii(view, body, body + size, '<x:xmpmeta');
      if (start >= 0) {
        const stop = findAscii(view, start, body + size, '</x:xmpmeta>');
        out.xmp = readText(view, start, stop > 0 ? stop + 12 : body + size);
      }
    }
    if (type === 'IEND') break;
    off = body + size + 4; // 跳过 CRC
  }
  return out;
}

/* ------------------------------ WebP ------------------------------ */

function parseWebp(view) {
  const len = view.byteLength;
  let off = 12; // RIFF 头 12 字节
  const out = { tiff: -1, xmp: '' };
  while (off + 8 <= len) {
    const type = tag4(view, off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (size < 0 || body + size > len) break;
    if (type === 'EXIF') {
      let at = body;
      if (tag4(view, body) === 'Exif') at = body + 6;
      out.tiff = at;
    } else if (type === 'XMP ') {
      const start = findAscii(view, body, body + size, '<x:xmpmeta');
      if (start >= 0) {
        const stop = findAscii(view, start, body + size, '</x:xmpmeta>');
        out.xmp = readText(view, start, stop > 0 ? stop + 12 : body + size);
      }
    }
    off = body + size + (size % 2); // RIFF 分块按 2 字节对齐
  }
  return out;
}

/* ---------------------------- 动态照片 ---------------------------- */

/**
 * 在文件尾部找拼接进来的 MP4。
 *
 * 判据（对着真实 Motion Photo 的结构核过）：
 *   - `ftyp` 前面 4 字节是它自己的盒长度（很小，几十字节），**不是**延伸到文件末尾
 *   - 品牌名在已知集合里
 *   - 紧跟其后的盒是 moov / mdat / free 之一，说明这确实是一段 MP4 的开头
 *   - 整段不短于 4KB
 *
 * 单看 "ftyp" 四个字节会在 JPEG 熵编码数据里误命中，加上后两条就稳了。
 */
function findTailVideo(tailView, fileSize, tailStart) {
  const len = tailView.byteLength;
  const FOLLOW = ['moov', 'mdat', 'free', 'wide', 'skip'];

  for (let i = len - 8; i >= 4; i--) {
    if (
      tailView.getUint8(i) !== 0x66 || // f
      tailView.getUint8(i + 1) !== 0x74 || // t
      tailView.getUint8(i + 2) !== 0x79 || // y
      tailView.getUint8(i + 3) !== 0x70 // p
    ) {
      continue;
    }
    const boxStart = i - 4;
    const boxSize = tailView.getUint32(boxStart);
    if (boxSize < 8 || boxSize > 2048) continue;
    if (MP4_BRANDS.indexOf(tag4(tailView, i + 4)) < 0) continue;

    const nextAt = boxStart + boxSize;
    if (nextAt + 8 > len) continue;
    if (FOLLOW.indexOf(tag4(tailView, nextAt + 4)) < 0) continue;

    const absStart = tailStart + boxStart;
    const length = fileSize - absStart;
    if (length < 4096) continue;
    return { offset: absStart, length, mime: 'video/mp4' };
  }
  return null;
}

/* ------------------------------ 入口 ------------------------------ */

/**
 * 解析已读入的一段数据。
 * 返回 { kind, date, time, tz, lat, lng, make, model, liveId, motion, need }
 *   need  —— Exif 落在这一段之外，需要按 { offset, length } 补读
 *   motion —— 内嵌视频 { offset, length } 或 { tailOffset }（还需按文件尾换算）
 */
function parse(buffer, base, fileSize) {
  try {
    const view = new DataView(buffer);
    const len = view.byteLength;
    if (len < 12) return null;
    const at = base || 0;

    let kind = '';
    let tiff = -1;
    let xmp = '';
    let extra = null;

    if (view.getUint16(0) === 0xffd8) {
      kind = 'jpeg';
      const j = scanJpeg(view);
      tiff = j.tiff;
      xmp = j.xmp;
    } else if (tag4(view, 4) === 'ftyp') {
      // HEIF 自成一路：Exif 与 XMP 都在 meta 盒里，不内嵌视频
      const h = parseHeic(view, at);
      if (!h) return null;
      if (h.need) return { kind: 'heic', need: h.need };
      const out = Object.assign(
        {
          date: null, time: '', tz: '', timeSrc: '',
          lat: null, lng: null, geoApprox: false,
          make: '', model: '', liveId: '', motion: null,
        },
        h
      );
      out.kind = 'heic';
      delete out.need;
      return out;
    } else if (view.getUint8(0) === 0x89 && tag4(view, 1).slice(0, 3) === 'PNG') {
      kind = 'png';
      const p = parsePng(view);
      tiff = p.tiff;
      xmp = p.xmp;
    } else if (tag4(view, 0) === 'RIFF' && tag4(view, 8) === 'WEBP') {
      kind = 'webp';
      const w = parseWebp(view);
      tiff = w.tiff;
      xmp = w.xmp;
    } else {
      return null;
    }

    let meta = tiff >= 0 ? parseTiff(view, tiff) : null;
    if ((!meta || !meta.date) && xmp) {
      const x = parseXmp(xmp);
      if (x.date || x.lat != null) {
        meta = meta || {};
        if (!meta.date) {
          meta.date = x.date;
          meta.time = x.time;
          meta.tz = x.tz;
          meta.timeSrc = 'xmp';
        }
        if (meta.lat == null && x.lat != null) {
          meta.lat = x.lat;
          meta.lng = x.lng;
        }
      }
    }
    // HEIC 已经单独解析过 Exif，这里只在没拿到时复用
    if (!meta && extra) meta = extra;

    const out = Object.assign(
      {
        kind,
        date: null, time: '', tz: '', timeSrc: '',
        lat: null, lng: null, geoApprox: false,
        make: '', model: '', liveId: '',
        motion: null,
      },
      meta || {}
    );
    out.kind = kind;

    const mx = xmp ? parseXmp(xmp) : null;
    if (mx && !out.motion) out.motion = mx.motion;
    out.motion = pickMotion(xmp, out.motion, fileSize);
    return out;
  } catch (e) {
    return null;
  }
}

/** 把 XMP 给出的「距末尾字节数」换算成绝对偏移 */
function pickMotion(xmp, known, fileSize) {
  if (known && known.offset != null && known.length) return known;
  const spec = (known && known.tailOffset != null ? known : null) || (xmp ? readMotionXmp(xmp) : null);
  if (!spec) return null;
  if (!spec.tailOffset || !fileSize) return { tailOffset: spec.tailOffset || 0, length: 0 };
  const offset = fileSize - (spec.length || spec.tailOffset);
  if (offset <= 0 || offset >= fileSize) return null;
  const length = fileSize - offset;
  if (length > MOTION_MAX) return null;
  return { offset, length, mime: 'video/mp4' };
}

/* ---------------------------- 文件读取 ---------------------------- */

function readRange(filePath, position, length) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      position,
      length,
      success: (res) => resolve(res.data),
      fail: (e) => reject(new Error(e.errMsg || '读取图片失败')),
    });
  });
}

function readHead(filePath, length) {
  return readRange(filePath, 0, length || HEAD).catch(() => {
    // 老基础库不支持 position / length，退化为整文件
    return new Promise((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath,
        success: (res) => resolve(res.data),
        fail: (e) => reject(new Error(e.errMsg || '读取图片失败')),
      });
    });
  });
}

function fileSizeOf(filePath) {
  return new Promise((resolve) => {
    wx.getFileSystemManager().stat({
      path: filePath,
      success: (r) => resolve((r.stats && r.stats.size) || 0),
      fail: () => resolve(0),
    });
  });
}

/**
 * 读一个本地文件的元数据。
 *
 * 返回：
 *   { date, time, tz, lat, lng, approx, kind, make, model, liveId, motion }
 *   motion 形如 { offset, length }，把这一段切出来就是可播放的 MP4。
 *   找不到拍摄时间时 date 为 null（上层据此跳过这张）。
 *
 * 读取策略（都是「只读需要的那几段」）：
 *   1. 头部 256KB —— 绝大多数 Exif 都在这里
 *   2. Exif 落在范围外 → 按 iloc 偏移补读那一段
 *   3. XMP 声明了内嵌视频 → 按偏移切（不读大块）
 *   4. 没有任何线索的 JPEG → 读尾部扫 ftyp（国产 ROM 删掉 XMP 时的兜底）
 */
async function readMeta(filePath) {
  const empty = {
    date: null, time: '', tz: '', lat: null, lng: null, approx: true,
    kind: '', make: '', model: '', liveId: '', motion: null,
  };
  try {
    const size = await fileSizeOf(filePath);
    const head = await readHead(filePath, HEAD);
    let meta = parse(head, 0, size);

    // Exif 项在文件更后面
    if (meta && meta.need) {
      const { offset, length } = meta.need;
      const chunk = await readRange(filePath, offset, length).catch(() => null);
      if (chunk) {
        const v = new DataView(chunk);
        const rel = v.getUint32(0);
        const tiff = rel <= 256 * 1024 ? parseTiffRaw(v, 4 + rel) : null;
        meta = Object.assign({}, meta, tiff || {});
      }
      meta.need = null;
    }

    if (!meta) return empty;

    const out = {
      date: meta.date || null,
      time: meta.time || '',
      tz: meta.tz || '',
      lat: typeof meta.lat === 'number' ? meta.lat : null,
      lng: typeof meta.lng === 'number' ? meta.lng : null,
      approx: !meta.date,
      kind: meta.kind || '',
      make: meta.make || '',
      model: meta.model || '',
      liveId: meta.liveId || '',
      motion: null,
    };

    /* 内嵌视频：先看 XMP 给的偏移，再兜底扫尾部 */
    if (meta.motion && meta.motion.offset) {
      out.motion = { offset: meta.motion.offset, length: meta.motion.length, mime: 'video/mp4' };
    } else if (meta.kind === 'jpeg' && size > 64 * 1024) {
      const guess = await scanTail(filePath, size);
      if (guess) out.motion = guess;
    }

    return out;
  } catch (e) {
    return empty;
  }
}

/** 补读片段里解析 TIFF（与 parseTiff 共用实现） */
function parseTiffRaw(view, tiff) {
  return parseTiff(view, tiff);
}

/**
 * 读文件尾部找拼接的 MP4。先读 1.5MB，没找到再读 8MB。
 * 只在「这张是 JPEG 且没有 XMP 线索」时才走这里，平时不会多读。
 */
async function scanTail(filePath, size) {
  const first = Math.min(TAIL_MIN, size);
  const tailStart = size - first;
  const buf = await readRange(filePath, tailStart, first).catch(() => null);
  if (!buf) return null;
  let hit = findTailVideo(new DataView(buf), size, tailStart);
  if (hit) return hit;

  if (first >= size || size <= TAIL_MAX) return null;
  const big = Math.min(TAIL_MAX, size);
  const start2 = size - big;
  const buf2 = await readRange(filePath, start2, big).catch(() => null);
  if (!buf2) return null;
  hit = findTailVideo(new DataView(buf2), size, start2);
  return hit;
}

/** 把一段视频切出来存成临时 mp4，返回本地路径 */
function extractMotion(filePath, motion, name) {
  return new Promise((resolve, reject) => {
    if (!motion || !motion.offset || !motion.length) {
      reject(new Error('没有可提取的动态片段'));
      return;
    }
    const fs = wx.getFileSystemManager();
    const out = `${wx.env.USER_DATA_PATH}/live-${name || Date.now()}.mp4`;

    fs.readFile({
      filePath,
      position: motion.offset,
      length: motion.length,
      success: (res) => {
        fs.writeFile({
          filePath: out,
          data: res.data,
          success: () => resolve(out),
          fail: (e) => reject(new Error(e.errMsg || '写入视频失败')),
        });
      },
      fail: (e) => reject(new Error(e.errMsg || '切取动态片段失败')),
    });
  });
}

module.exports = {
  parse,
  readMeta,
  parseTiff,
  parseTime,
  parseXmp,
  extractMotion,
  findTailVideo,
  readRange,
};
