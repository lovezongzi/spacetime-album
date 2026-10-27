/**
 * 选图 → 读 EXIF → 压缩 → 传到云存储。
 *
 * 关键点：
 * - sizeType 必须是 original，compressed 会把 EXIF 洗掉，日期就拿不到了
 * - 必须在压缩之前读 EXIF（压缩后的文件已经不含拍摄信息）
 * - 只上传 720px 的缩略图，原图不出手机
 */
const { readMeta } = require('./exif');

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

function extOf(filePath) {
  const ext = (String(filePath).split('.').pop() || 'jpg').toLowerCase();
  return ['jpg', 'jpeg', 'png', 'webp'].includes(ext) ? ext : 'jpg';
}

/** 传到云存储，拿到 cloud:// 的 fileID，后续 <image src> 可以直接用 */
function uploadOne(filePath, seq) {
  return new Promise((resolve, reject) => {
    const cloudPath =
      `photos/${Date.now().toString(36)}-${seq}-` +
      `${Math.random().toString(36).slice(2, 8)}.${extOf(filePath)}`;

    wx.cloud.uploadFile({
      cloudPath,
      filePath,
      success: (r) => (r.fileID ? resolve(r.fileID) : reject(new Error('上传没有返回 fileID'))),
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
      const small = await compress(p);
      const fileId = await uploadOne(small, i);
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

module.exports = { pickImages, compress, readBase64, uploadOne, buildPhotos };
