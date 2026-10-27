/**
 * 小程序版 EXIF 读取器：只取「拍摄时间 + GPS 坐标」。
 *
 * 支持两种容器：
 *   JPEG   —— 扫描 APP1 段，`Exif\0\0` 后面就是 TIFF 头
 *   HEIC   —— iPhone 默认格式。EXIF 不在文件头，而是藏在 ISO BMFF 的
 *             `meta` 盒里：`iinf` 列出条目类型，`iloc` 给出每个条目的
 *             绝对偏移和长度，找到 item_type = "Exif" 那个，按长度读出来，
 *             前 4 字节是 TIFF 头的相对偏移。
 *
 * 两条路最后都落到同一个 TIFF 解析器上，所以日期/GPS 的取法完全一致。
 *
 * 隐私：整个过程只读文件头（必要时只补读 EXIF 那一小段），原始照片不出手机。
 */

const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/** 头部先读这么多；HEIC 的 meta 盒和 Exif 项通常都在这个范围内 */
const HEAD = 256 * 1024;
/** 万一 Exif 项落在头部之外，单次最多补读这么多 */
const EXIF_CAP = 1024 * 1024;

/** 读 4 字节盒类型名 */
function tag4(view, off) {
  if (off + 4 > view.byteLength) return '';
  return (
    String.fromCharCode(view.getUint8(off)) +
    String.fromCharCode(view.getUint8(off + 1)) +
    String.fromCharCode(view.getUint8(off + 2)) +
    String.fromCharCode(view.getUint8(off + 3))
  );
}

/* ------------------------------- TIFF ------------------------------- */

/**
 * 从 TIFF 头开始解析。`tiff` 是 TIFF 头在 view 里的绝对偏移。
 * JPEG 和 HEIC 共用这一份，避免两套逻辑漂移。
 */
function parseTiff(view, tiff) {
  const len = view.byteLength;
  if (tiff < 0 || tiff + 8 > len) return null;

  const bo = view.getUint16(tiff);
  if (bo !== 0x4949 && bo !== 0x4d4d) return null;
  const little = bo === 0x4949;
  const r16 = (o) => view.getUint16(o, little);
  const r32 = (o) => view.getUint32(o, little);

  function readIFD(rel) {
    const base = tiff + rel;
    if (rel <= 0 || base + 2 > len) return {};
    const count = r16(base);
    const tags = {};
    for (let i = 0; i < count; i++) {
      const e = base + 2 + i * 12;
      if (e + 12 > len) break;
      const tag = r16(e);
      tags[tag] = { type: r16(e + 2), count: r32(e + 4), entry: e };
    }
    return tags;
  }

  function valueOffset(t) {
    const bytes = (SIZE[t.type] || 1) * t.count;
    return bytes <= 4 ? t.entry + 8 : tiff + r32(t.entry + 8);
  }

  function ascii(t) {
    if (!t) return null;
    const o = valueOffset(t);
    let s = '';
    for (let i = 0; i < t.count && o + i < len; i++) {
      const c = view.getUint8(o + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim() || null;
  }

  function rational(t, i) {
    const o = valueOffset(t) + i * 8;
    if (o + 8 > len) return 0;
    const num = r32(o);
    const den = r32(o + 4);
    return den ? num / den : 0;
  }

  const dms = (t) => rational(t, 0) + rational(t, 1) / 60 + rational(t, 2) / 3600;

  const ifd0Rel = r32(tiff + 4);
  const ifd0 = readIFD(ifd0Rel);
  const exif = ifd0[0x8769] ? readIFD(r32(ifd0[0x8769].entry + 8)) : {};
  const gps = ifd0[0x8825] ? readIFD(r32(ifd0[0x8825].entry + 8)) : {};

  const rawDate = ascii(exif[0x9003]) || ascii(exif[0x9004]) || ascii(ifd0[0x0132]) || null;
  let date = null;
  let time = '';
  if (rawDate) {
    const m = rawDate.match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2})/);
    if (m) {
      date = `${m[1]}-${m[2]}-${m[3]}`;
      time = `${m[4]}:${m[5]}`;
    }
  }

  let lat = null;
  let lng = null;
  if (gps[0x0002] && gps[0x0004]) {
    lat = dms(gps[0x0002]);
    lng = dms(gps[0x0004]);
    if (ascii(gps[0x0001]) === 'S') lat = -lat;
    if (ascii(gps[0x0003]) === 'W') lng = -lng;
    if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) {
      lat = null;
      lng = null;
    }
  }

  return { date, time, lat, lng };
}

/* ------------------------------- JPEG ------------------------------- */

/** 扫 JPEG 段，返回 APP1 里 TIFF 头的偏移 */
function jpegTiffOffset(view) {
  const len = view.byteLength;
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
    if (marker === 0xda) break; // 进入图像数据，后面不会再有 EXIF
    const size = view.getUint16(off + 2);
    if (size < 2) break;
    if (marker === 0xe1 && off + 10 <= len) {
      const sig = tag4(view, off + 4);
      if (sig === 'Exif') return off + 10;
    }
    off += 2 + size;
  }
  return -1;
}

/* ------------------------------- HEIC ------------------------------- */

/** 顶层扫盒，找到 meta 盒（文件里第一个） */
function findTopBox(view, type) {
  const len = view.byteLength;
  let off = 0;
  while (off + 8 <= len) {
    let size = view.getUint32(off);
    const t = tag4(view, off + 4);
    let hdr = 8;
    if (size === 1) {
      if (off + 16 > len) break;
      // 64 位长度：46 位足够，避免用 BigInt
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
 * 解析 HEIC。
 * `base` 是 view[0] 在文件里的绝对偏移 —— 补读片段时要用它把盒内相对偏移还原成文件偏移。
 * 返回 { date, time, lat, lng } 或 { __need: {offset, length} }（EXIF 不在已读范围内）。
 */
function parseHeic(view, base) {
  const len = view.byteLength;
  const meta = findTopBox(view, 'meta');
  if (!meta) return null;

  // meta 是 FullBox，body 前 4 字节是 version + flags
  let p = meta.body + 4;

  let iinfAt = -1;
  let ilocAt = -1;
  let idatBody = -1;

  while (p + 8 <= meta.end) {
    const size = view.getUint32(p);
    const t = tag4(view, p + 4);
    if (size < 8) break;
    if (t === 'iinf') iinfAt = p;
    else if (t === 'iloc') ilocAt = p;
    else if (t === 'idat') idatBody = p + 8;
    p += size;
  }

  if (iinfAt < 0 || ilocAt < 0) return null;

  /* --- iinf：条目 id → 类型 --- */
  const iinfVer = view.getUint8(iinfAt + 8);
  const itemCount = iinfVer === 0 ? view.getUint16(iinfAt + 12) : view.getUint32(iinfAt + 12);
  let q = iinfAt + (iinfVer === 0 ? 14 : 16);
  const types = {};
  for (let i = 0; i < itemCount && q + 8 <= len; i++) {
    const isz = view.getUint32(q);
    if (isz < 8) break;
    if (tag4(view, q + 4) === 'infe') {
      const iver = view.getUint8(q + 8);
      if (iver === 2) {
        types[view.getUint16(q + 12)] = tag4(view, q + 16);
      } else if (iver === 3) {
        types[view.getUint32(q + 12)] = tag4(view, q + 18);
      }
    }
    q += isz;
  }

  /* --- iloc：条目 id → 偏移/长度 --- */
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
    for (let i = 0; i < n; i++) v = v * 256 + view.getUint8(r + i);
    r += n;
    return v;
  };

  let exifStart = -1;
  let exifLen = 0;

  for (let i = 0; i < locCount && r + 4 <= len; i++) {
    const itemId = ilocVer === 2 ? view.getUint32(r) : view.getUint16(r);
    r += ilocVer === 2 ? 4 : 2;

    let method = 0;
    if (ilocVer === 1 || ilocVer === 2) {
      method = view.getUint8(r) & 0xf; // 低 4 位是 construction_method
      r += 2;
    }
    r += 2; // data_reference_index

    const baseOffset = readN(baseSize);
    const extentCount = view.getUint16(r);
    r += 2;

    for (let k = 0; k < extentCount; k++) {
      if (indexSize) readN(indexSize);
      const eoff = readN(offsetSize);
      const elen = readN(lengthSize);

      if (types[itemId] === 'Exif' && k === 0) {
        // method 1 表示相对 idat 负载；method 0 是文件绝对偏移
        const origin = method === 1 && idatBody >= 0 ? idatBody : 0;
        exifStart = origin + baseOffset + eoff;
        exifLen = elen;
      }
    }
    if (exifStart >= 0) break;
  }

  if (exifStart < 0) return null;

  const local = exifStart - base;
  if (local < 0 || local + 4 > len) {
    // EXIF 项落在已读范围之外，让调用方按需补读这一段
    return { __need: { offset: exifStart, length: Math.min(exifLen || EXIF_CAP, EXIF_CAP) } };
  }

  return parseExifBlock(view, local);
}

/**
 * 解析一段独立的 EXIF 数据块（HEIF 的 Exif item）：
 * 前 4 字节是 TIFF 头相对负载起点的偏移，后面才是 TIFF。
 */
function parseExifBlock(view, at) {
  if (at + 4 > view.byteLength) return null;
  const rel = view.getUint32(at);
  if (rel > 1024 * 256) return null;
  return parseTiff(view, at + 4 + rel);
}

/* ------------------------------ 入口 ------------------------------ */

/**
 * 解析文件头。返回 { date, time, lat, lng }，
 * 或 { __need } 表示还要补读一段，或 null 表示识别不了。
 */
function parse(buffer, base) {
  try {
    const view = new DataView(buffer);
    const len = view.byteLength;
    if (len < 8) return null;

    // JPEG：FF D8
    if (view.getUint16(0) === 0xffd8) {
      const tiff = jpegTiffOffset(view);
      return tiff < 0 ? null : parseTiff(view, tiff);
    }

    // ISO BMFF：前 4 字节是盒长度，5-8 是 'ftyp'
    if (tag4(view, 4) === 'ftyp') {
      return parseHeic(view, base || 0);
    }

    return null;
  } catch (e) {
    return null;
  }
}

/* ---------------------------- 文件读取 ---------------------------- */

/** 只读文件头部，避免把几 MB 原图整个读进内存 */
function readRange(filePath, position, length) {
  return new Promise((resolve, reject) => {
    const fs = wx.getFileSystemManager();
    fs.readFile({
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

/**
 * 读一张本地图片的拍摄信息。
 * 返回 { date, time, lat, lng, approx }；没有拍摄时间时 date 为 null。
 */
async function readMeta(filePath) {
  const empty = { date: null, time: '', lat: null, lng: null, approx: true };
  try {
    const head = await readHead(filePath);
    let meta = parse(head, 0);

    // HEIC 的 Exif 项可能落在文件更后面，按 iloc 给的偏移补读一次
    if (meta && meta.__need) {
      const { offset, length } = meta.__need;
      const chunk = await readRange(filePath, offset, length).catch(() => null);
      meta = chunk ? parseExifBlock(new DataView(chunk), 0) : null;
    }

    if (meta && meta.date) return { ...meta, approx: false };
    return empty;
  } catch (e) {
    return empty;
  }
}

module.exports = { parse, readMeta, parseExifBlock, parseTiff };
