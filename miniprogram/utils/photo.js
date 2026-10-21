/**
 * 选图 → 读 EXIF → 压缩 → base64。
 * 原图不做上传，只把 720px 的缩略图发给服务端。
 */
const { readMeta } = require('./exif');

const MAX_B64 = 820000; // 单张 base64 上限，超过就跳过（服务端同样有长度限制）

function pickImages(count) {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: count || 9,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      // original 才会保留 EXIF，compressed 会把拍摄信息洗掉
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

function readBase64(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: 'base64',
      success: (r) => resolve(r.data),
      fail: (e) => reject(new Error(e.errMsg || '读取图片失败')),
    });
  });
}

function mimeOf(filePath) {
  const ext = (filePath.split('.').pop() || 'jpg').toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'heic') return 'image/heic';
  return 'image/jpeg';
}

/**
 * 逐张处理，串行执行避免内存峰值。
 * onProgress(done, total, label)
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
      const small = await compress(p);
      const b64 = await readBase64(small);
      if (b64.length > MAX_B64) {
        skipped.tooBig += 1;
        continue;
      }
      ok.push({
        date: meta.date,
        time: meta.time || '',
        lat: meta.lat,
        lng: meta.lng,
        place: '',
        approx: !!meta.approx,
        thumb: `data:${mimeOf(small)};base64,${b64}`,
      });
    } catch (e) {
      skipped.failed += 1;
    }
  }

  if (onProgress) onProgress(paths.length, paths.length);
  return { ok, skipped };
}

module.exports = { pickImages, compress, readBase64, buildPhotos, MAX_B64 };
