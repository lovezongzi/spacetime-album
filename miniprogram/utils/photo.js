'use strict';

/**
 * 选图 → 读元数据 → 出缩略图 → 切动态片段 → 传云存储。
 *
 * ## 三条关键约束
 * 1. `sizeType` 必须是 original。压缩会把 EXIF 洗掉，日期就没了；
 *    对动态照片来说更致命 —— 微信一跳转码，尾部拼接的 MP4 直接消失。
 * 2. 必须在压缩之前读元数据。压缩后的文件已经不含拍摄信息。
 * 3. 缩略图只出 720px。原图不出手机，只有缩略图和动图那几秒会上去。
 *
 * ## 动态照片
 * 安卓「动态照片」是一张 JPEG 尾部拼了段 MP4，切出来就能播，全自动。
 * iPhone「实况」是主图 + 独立 MOV 两个文件，小程序 API 只给主图，
 * 所以走 `pickLiveVideos` 让用户补选，再用 UUID 精确配对（见 matchVideos）。
 */
const { readMeta, extractMotion, readRange } = require('./exif');

/** 可能是 HEIC/HEIF 的品牌（iPhone 主品牌是 heic，兼容串里常带 mif1） */
const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'];

/** 云存储单文件上限（免费版 50MB），留点余量 */
const MOTION_LIMIT = 40 * 1024 * 1024;

/* ------------------------------ 选择 ------------------------------ */

function pickImages(count) {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: count || 9,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['original'],
      success: (res) => {
        const list = (res.tempFiles || []).map((f) => ({
          path: f.tempFilePath,
          size: f.size || 0,
          // 某些基础库版本会顺带给出视频路径，能用就用，省一次补选
          videoPath: f.videoPath || f.videoTempFilePath || '',
        }));
        resolve(list);
      },
      fail: (e) => {
        if (/cancel/i.test(e.errMsg || '')) return resolve([]);
        reject(new Error(e.errMsg || '选择图片失败'));
      },
    });
  });
}

function pickVideos(count) {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: Math.min(count || 9, 9),
      mediaType: ['video'],
      sourceType: ['album'],
      sizeType: ['original'], // 必须原片，转码会把实况 UUID 洗掉
      maxDuration: 60,
      success: (res) => resolve((res.tempFiles || []).map((f) => f.tempFilePath)),
      fail: (e) => {
        if (/cancel/i.test(e.errMsg || '')) return resolve([]);
        reject(new Error(e.errMsg || '选择视频失败'));
      },
    });
  });
}

/** 从聊天记录里选文件：实况的 MOV 走这条路最稳，因为它不在「视频」分类里 */
function pickChatFiles(count) {
  return new Promise((resolve) => {
    wx.chooseMessageFile({
      count: Math.min(count || 9, 9),
      type: 'file',
      extension: ['mov', 'MOV', 'mp4', 'MP4'],
      success: (res) => resolve((res.tempFiles || []).map((f) => f.path || f.tempFilePath)),
      fail: () => resolve([]),
    });
  });
}

/**
 * 让用户选实况的动态部分，给两条路：
 *   相册    —— 一部分机型（尤其安卓）在这里能直接选到那 3 秒
 *   聊天文件 —— iPhone 的实况 MOV 在系统相册里没有独立条目，
 *               但用「以文件发送」发到文件传输助手就会变成 HEIC + MOV 两个文件，
 *               从小程序里选那个 MOV 一样能配对
 */
function pickLiveVideos(count) {
  return new Promise((resolve) => {
    wx.showActionSheet({
      itemList: ['从相册的视频里选', '从聊天文件里选（先把实况发给文件传输助手）'],
      success: (r) => {
        resolve(r.tapIndex === 1 ? pickChatFiles(count) : pickVideos(count).catch(() => []));
      },
      fail: () => resolve([]),
    });
  });
}

/* ------------------------------ 格式 ------------------------------ */

/** 读文件头若干字节，用来判断真实格式（扩展名不可信，临时文件常常没有后缀） */
function readMagic(filePath, n) {
  return new Promise((resolve) => {
    wx.getFileSystemManager().readFile({
      filePath,
      position: 0,
      length: n || 16,
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
    for (let i = 16; i + 4 <= view.byteLength; i += 4) {
      if (HEIF_BRANDS.indexOf(tag4(view, i)) >= 0) return 'heic';
    }
  }
  return '';
}

/* ------------------------------ 缩略图 ------------------------------ */

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

/* ------------------------------ 上传 ------------------------------ */

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

function uploadVideo(filePath, seq) {
  return new Promise((resolve, reject) => {
    const cloudPath =
      `motion/${Date.now().toString(36)}-${seq}-` +
      `${Math.random().toString(36).slice(2, 8)}.mp4`;

    wx.cloud.uploadFile({
      cloudPath,
      filePath,
      success: (r) => (r.fileId ? resolve(r.fileId) : reject(new Error('视频上传没有返回 fileID'))),
      fail: (e) => reject(new Error(e.errMsg || '视频上传失败')),
    });
  });
}

/* ---------------------------- 实况视频配对 ---------------------------- */

/**
 * 从一段 MOV 里读实况配对标识。
 *
 * iPhone 把 UUID 写在 `com.apple.quicktime.content.identifier` 里，
 * 和主图 MakerNotes 的 0x0011 是同一个值。所以乱序选也能精确配对。
 * 读前 256KB 就够 —— iPhone 的 MOV 是流式封装，moov 在文件开头。
 */
async function readVideoId(filePath) {
  try {
    const buf = await readRange(filePath, 0, 256 * 1024);
    const view = new DataView(buf);
    const len = view.byteLength;
    const end = len - 36;
    for (let i = 0; i <= end; i++) {
      // 快速跳过：UUID 第 9 个字符一定是 '-'
      if (view.getUint8(i + 8) !== 0x2d) continue;
      let ok = true;
      for (let k = 0; k < 36; k++) {
        const c = view.getUint8(i + k);
        const dash = k === 8 || k === 13 || k === 18 || k === 23;
        if (dash) {
          if (c !== 0x2d) {
            ok = false;
            break;
          }
        } else if (
          !(
            (c >= 0x30 && c <= 0x39) ||
            (c >= 0x41 && c <= 0x46) ||
            (c >= 0x61 && c <= 0x66)
          )
        ) {
          ok = false;
          break;
        }
      }
      if (ok) {
        let s = '';
        for (let k = 0; k < 36; k++) s += String.fromCharCode(view.getUint8(i + k));
        return s.toUpperCase();
      }
    }
    return '';
  } catch (e) {
    return '';
  }
}

/**
 * 把补选的视频分配到实况照片上。
 * photos 是 buildPhotos 产出的、还没定稿的条目（需要 liveId）；
 * 先按 UUID 精确配对，剩下的按顺序补给缺视频的那些。
 */
async function matchVideos(videoPaths, photos) {
  const pending = photos.filter((p) => p.live && !p.motionFileId);
  if (!pending.length || !videoPaths.length) return { matched: 0, leftover: videoPaths.length };

  const ids = [];
  for (let i = 0; i < videoPaths.length; i++) {
    ids.push(await readVideoId(videoPaths[i]));
  }

  let matched = 0;
  const usedVideo = {};
  const leftoverVideos = [];

  // 第一轮：UUID 精确配对
  for (const p of pending) {
    if (!p.liveId) continue;
    const k = ids.indexOf(p.liveId);
    if (k >= 0 && !usedVideo[k]) {
      usedVideo[k] = true;
      p.__videoPath = videoPaths[k];
      matched += 1;
    }
  }

  for (let i = 0; i < videoPaths.length; i++) {
    if (!usedVideo[i]) leftoverVideos.push(videoPaths[i]);
  }

  // 第二轮：剩下的按顺序补给还缺视频的（用户按顺序选的场景）
  for (const p of pending) {
    if (p.__videoPath) continue;
    const v = leftoverVideos.shift();
    if (!v) break;
    p.__videoPath = v;
    matched += 1;
  }

  return { matched, leftover: leftoverVideos.length };
}

/* ------------------------------ 主流程 ------------------------------ */

/**
 * 逐张处理，串行执行避免内存峰值和网络拥塞。
 *
 * onProgress(done, total, note)
 * 返回 { ok, skipped, lives }
 *   ok     可直接交给 POST /api/photos
 *   lives  其中属于「实况但还没视频」的条目，供上层引导补选
 */
async function buildPhotos(paths, onProgress) {
  const ok = [];
  const skipped = { noExif: 0, tooBig: 0, failed: 0 };
  const lives = [];

  for (let i = 0; i < paths.length; i++) {
    const item = paths[i];
    const p = typeof item === 'string' ? item : item.path;
    if (onProgress) onProgress(i, paths.length, '读取');
    try {
      const meta = await readMeta(p);
      if (!meta.date) {
        // 没有拍摄时间就没法按「那一天」匹配，但实况信息仍值得记下来
        skipped.noExif += 1;
        continue;
      }

      const thumb = await toThumb(p);
      const fileId = await uploadOne(thumb.path, i, thumb.kind);

      const entry = {
        date: meta.date,
        time: meta.time || '',
        lat: meta.lat,
        lng: meta.lng,
        place: '',
        approx: !!meta.approx,
        fileId,
        kind: thumb.kind,
        make: meta.make || '',
        model: meta.model || '',
        live: !!meta.liveId,
        liveId: meta.liveId || '',
        motionFileId: '',
      };

      /* 安卓动态照片：直接从文件里切出 MP4，全自动 */
      if (meta.motion && meta.motion.length) {
        if (meta.motion.length > MOTION_LIMIT) {
          entry.motionSkipped = 'tooBig';
        } else {
          if (onProgress) onProgress(i, paths.length, '提取动态');
          const mp4 = await extractMotion(p, meta.motion, `${Date.now()}-${i}`).catch(() => null);
          if (mp4) {
            entry.motionFileId = await uploadVideo(mp4, i).catch(() => '');
          }
        }
        // 拿到视频就说明这张是动态照片，哪怕它没有苹果那套 UUID
        if (entry.motionFileId) entry.live = true;
      }

      /* iPhone 实况：微信只给主图，先记下来，等补选视频 */
      entry.__videoPath = (typeof item === 'object' && item.videoPath) || '';
      if (entry.live && !entry.motionFileId) lives.push(entry);

      ok.push(entry);
    } catch (e) {
      skipped.failed += 1;
    }
  }

  if (onProgress) onProgress(paths.length, paths.length, '完成');
  return { ok, skipped, lives };
}

/** 把已经配好视频的实况条目补上 motionFileId */
async function attachVideos(photos, onProgress) {
  let done = 0;
  const list = photos.filter((p) => p.__videoPath && !p.motionFileId);
  for (const p of list) {
    try {
      const id = await uploadVideo(p.__videoPath, done);
      p.motionFileId = id;
    } catch (e) {
      /* 单条失败不影响其他 */
    }
    done += 1;
    if (onProgress) onProgress(done, list.length);
  }
  return done;
}

/** 提交给云函数前把内部字段摘掉 */
function clean(photos) {
  return photos.map((p) => {
    const c = Object.assign({}, p);
    delete c.__videoPath;
    delete c.liveId; // UUID 不用上云，配对只在本地做
    return c;
  });
}

module.exports = {
  pickImages,
  pickVideos,
  pickChatFiles,
  pickLiveVideos,
  compress,
  canvasToJpeg,
  kindOf,
  readMagic,
  toThumb,
  uploadOne,
  uploadVideo,
  readVideoId,
  matchVideos,
  buildPhotos,
  attachVideos,
  clean,
};
