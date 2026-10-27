/**
 * 选图 → 读 EXIF → 压缩 → 传到云存储。
 *
 * 关键点：
 * - sizeType 必须是 original，compressed 会把 EXIF 洗掉，日期就拿不到了
 * - 必须在压缩之前读 EXIF（压缩后的文件已经不含拍摄信息）
 * - 只上传 720px 的缩略图，原图不出手机
 * - iPhone 的照片默认是 HEIC：`<image>` 在 Android 上放不出来，所以要尽量转成 JPEG。
 *   先交给 wx.compressImage（原生、会处理方向），压完再嗅一下魔数；如果还是 HEIC，
 *   用离屏画布重画成 JPEG。两条都不行才退回原文件（至少在 iOS 上能显示）。
 */
const { readMeta } = require('./exif');

/** 可能是 HEIC/HEIF 的品牌（iPhone 主品牌是 heic，兼容串里常带 mif1） */
const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'];

function pickImages(count) {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: count || 9,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['original'],
      success: (res) => resolve((res.tempFiles || []).map((f) => f.tempFilePath)),
      fail: (e) => {
        if (/cancel/i.test(e.errMsg || '')) return resolve([]);
        reject(new Error(e.errMsg || '选择图片失败'));
      },
    });
  });
}

function compress(filePath) {
  return new Promise((resolve) => {
    wx.compressImage({
      src: filePath,
      quality: 62,
      compressedWidth: 720,
      success: (r) => resolve(r.tempFilePath || filePath),
      fail: () => resolve(filePath),
    });
  });
}

/** 读文件头若干字节，用来判断真实格式（扩展名不可信，临时文件常常没有后缀） */
function readMagic(filePath, n) {
  const size = n || 16;
  return new Promise((resolve) => {
    wx.getFileSystemManager().readFile({
      filePath,
      position: 0,
      length: size,
      success: (res) => resolve(new DataView(res.data)),
      fail: () => resolve(null),
    });
  });
}

function tag4(view, off) {
  if (!view || off + 4 > view.byteLength) return '';
  return (
    String.fromCharCode(view.getUint8(off)) +
    String.fromCharCode(view.getUint8(off + 1)) +
    String.fromCharCode(view.getUint8(off + 2)) +
    String.fromCharCode(view.getUint8(off + 3))
  );
}

/** 按魔数判断格式，返回 'jpg' / 'png' / 'webp' / 'heic' / '' */
function kindOf(view) {
  if (!view || view.byteLength < 12) return '';
  if (view.getUint16(0) === 0xffd8) return 'jpg';
  // PNG 签名 89 50 4E 47 0D 0A 1A 0A：第 1-3 字节是 "PNG"，第 4 字节是 \r
  if (view.getUint8(0) === 0x89 && tag4(view, 1).slice(0, 3) === 'PNG') return 'png';
  if (tag4(view, 0) === 'RIFF' && tag4(view, 8) === 'WEBP') return 'webp';
  if (tag4(view, 4) === 'ftyp') {
    const brand = tag4(view, 8);
    if (HEIF_BRANDS.indexOf(brand) >= 0) return 'heic';
    // 兼容品牌串里也可能出现 heic
    for (let i = 16; i + 4 <= view.byteLength; i += 4) {
      if (HEIF_BRANDS.indexOf(tag4(view, i)) >= 0) return 'heic';
    }
  }
  return '';
}

/**
 * 用离屏画布把图片重画成 JPEG。
 * 画布只画 720px 的小图，不会把整张 4000 万像素的原图展开。
 */
function canvasToJpeg(filePath, maxSide) {
  return new Promise((resolve, reject) => {
    if (!wx.createOffscreenCanvas) return reject(new Error('基础库不支持离屏画布'));

    wx.getImageInfo({
      src: filePath,
      success: (info) => {
        const w = info.width || 0;
        const h = info.height || 0;
        if (!w || !h) return reject(new Error('拿不到图片尺寸'));

        const scale = Math.min(1, (maxSide || 720) / Math.max(w, h));
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));

        let canvas;
        try {
          canvas = wx.createOffscreenCanvas({ type: '2d', width: cw, height: ch });
        } catch (e) {
          return reject(new Error('创建画布失败'));
        }

        const img = canvas.createImage();
        img.onload = () => {
          try {
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, cw, ch);
            wx.canvasToTempFilePath({
              canvas,
              fileType: 'jpg',
              quality: 72,
              success: (r) => resolve(r.tempFilePath),
              fail: () => reject(new Error('导出 JPEG 失败')),
            });
          } catch (e) {
            reject(e);
          }
        };
        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = filePath;
      },
      fail: () => reject(new Error('读不到图片信息')),
    });
  });
}

/** 图片 + 推断出的格式 */
async function toThumb(filePath) {
  const thumb = await compress(filePath);
  const kind = kindOf(await readMagic(thumb, 32));

  // 压完已经是 JPEG/PNG/WebP，直接用
  if (kind && kind !== 'heic') return { path: thumb, kind };

  // 还是 HEIC（或认不出来）：试着重画成 JPEG
  const srcKind = kindOf(await readMagic(filePath, 32));
  if (srcKind === 'heic' || kind === 'heic') {
    const jpg = await canvasToJpeg(filePath, 720).catch(() => null);
    if (jpg) return { path: jpg, kind: 'jpg' };
  }

  return { path: thumb, kind: kind || 'jpg' };
}

function uploadOne(filePath, seq, ext) {
  return new Promise((resolve, reject) => {
    const suffix = ext && ext !== 'heic' ? ext : 'jpg';
    const cloudPath =
      `photos/${Date.now().toString(36)}-${seq}-` +
      `${Math.random().toString(36).slice(2, 8)}.${suffix}`;

    wx.cloud.uploadFile({
      cloudPath,
      filePath,
      success: (r) => (r.fileId ? resolve(r.fileId) : reject(new Error('上传没有返回 fileID'))),
      fail: (e) => reject(new Error(e.errMsg || '上传失败')),
    });
  });
}

/**
 * 逐张处理，串行执行避免内存峰值和网络拥塞。
 * onProgress(done, total)
 * 返回的每一项带 fileId，直接交给 POST /api/photos。
 */
async function buildPhotos(paths, onProgress) {
  const ok = [];
  const skipped = { noExif: 0, tooBig: 0, failed: 0 };

  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    if (onProgress) onProgress(i, paths.length);
    try {
      const meta = await readMeta(p);
      if (!meta.date) {
        skipped.noExif += 1;
        continue;
      }
      const thumb = await toThumb(p);
      const fileId = await uploadOne(thumb.path, i, thumb.kind);
      ok.push({
        date: meta.date,
        time: meta.time || '',
        lat: meta.lat,
        lng: meta.lng,
        place: '',
        approx: !!meta.approx,
        fileId,
      });
    } catch (e) {
      skipped.failed += 1;
    }
  }

  if (onProgress) onProgress(paths.length, paths.length);
  return { ok, skipped };
}

module.exports = {
  pickImages,
  compress,
  canvasToJpeg,
  kindOf,
  readMagic,
  toThumb,
  uploadOne,
  buildPhotos,
};
