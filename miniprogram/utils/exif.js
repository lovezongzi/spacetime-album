/**
 * 小程序版 EXIF 读取器：只取「拍摄时间 + GPS 坐标」。
 *
 * 和 Web 端同一套解析逻辑，区别是输入从 File 换成了小程序的临时文件路径：
 * 用 FileSystemManager 只读文件头部 256KB，原始照片始终留在手机上，不上传。
 */

const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function parse(buffer) {
  try {
    const view = new DataView(buffer);
    const len = view.byteLength;
    if (len < 4 || view.getUint16(0) !== 0xffd8) return null;

    let off = 2;
    let tiff = -1;
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
        const sig =
          String.fromCharCode(view.getUint8(off + 4), view.getUint8(off + 5)) +
          String.fromCharCode(view.getUint8(off + 6), view.getUint8(off + 7));
        if (sig === 'Exif') {
          tiff = off + 10;
          break;
        }
      }
      off += 2 + size;
    }
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

    function dms(t) {
      return rational(t, 0) + rational(t, 1) / 60 + rational(t, 2) / 3600;
    }

    const ifd0 = readIFD(r32(tiff + 4));
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
  } catch (e) {
    return null;
  }
}

/** 只读文件头部，避免把几 MB 原图整个读进内存 */
function readHead(filePath, length) {
  return new Promise((resolve, reject) => {
    const fs = wx.getFileSystemManager();
    fs.readFile({
      filePath,
      position: 0,
      length: length || 256 * 1024,
      success: (res) => resolve(res.data),
      fail: () => {
        // 老基础库不支持 position / length，退化为整文件
        fs.readFile({
          filePath,
          success: (res) => resolve(res.data),
          fail: (e) => reject(new Error(e.errMsg || '读取图片失败')),
        });
      },
    });
  });
}

/**
 * 读一张本地图片的拍摄信息。
 * 返回 { date, time, lat, lng, approx }；没有拍摄时间时 date 为 null。
 */
async function readMeta(filePath) {
  try {
    const head = await readHead(filePath);
    const meta = parse(head);
    if (meta && meta.date) return { ...meta, approx: false };
    return { date: null, time: '', lat: null, lng: null, approx: true };
  } catch (e) {
    return { date: null, time: '', lat: null, lng: null, approx: true };
  }
}

module.exports = { parse, readMeta };
