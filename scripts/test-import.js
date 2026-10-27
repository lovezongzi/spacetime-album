'use strict';

/**
 * 导入链路测试：用 wx 的 mock 把「选图 → 读元数据 → 切动态 → 传云存储 → 配对实况视频」
 * 整条路跑一遍。
 *
 * 用法：node scripts/test-import.js
 *
 * 为什么要这一层：exif.js 的单元测试只验证了「给定一段字节能解出什么」，
 * 但真机上真正跑的是 readMeta 的分段读取（头部 256KB → 按偏移补读 → 尾部扫描）
 * 和 photo.js 的切片写文件。这两段如果错了，单测全绿也没用。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/* ------------------------------ wx mock ------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'spacetime-'));
const USER_DATA = path.join(TMP, 'userdata');
const CLOUD = path.join(TMP, 'cloud');
fs.mkdirSync(USER_DATA, { recursive: true });
fs.mkdirSync(CLOUD, { recursive: true });

function toAb(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
}

let uploads = [];

global.wx = {
  env: { USER_DATA_PATH: USER_DATA },

  getFileSystemManager() {
    return {
      readFile({ filePath, position, length, success, fail }) {
        try {
          const size = fs.statSync(filePath).size;
          const start = position || 0;
          const want = length === undefined ? size - start : length;
          const len = Math.max(0, Math.min(want, size - start));
          const buf = Buffer.alloc(len);
          if (len > 0) {
            const fd = fs.openSync(filePath, 'r');
            fs.readSync(fd, buf, 0, len, start);
            fs.closeSync(fd);
          }
          success({ data: toAb(buf) });
        } catch (e) {
          fail({ errMsg: e.message });
        }
      },
      stat({ path: p, success, fail }) {
        try {
          success({ stats: { size: fs.statSync(p).size } });
        } catch (e) {
          fail({ errMsg: e.message });
        }
      },
      writeFile({ filePath, data, success, fail }) {
        try {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, Buffer.from(data));
          success({});
        } catch (e) {
          fail({ errMsg: e.message });
        }
      },
    };
  },

  cloud: {
    uploadFile({ cloudPath, filePath, success, fail }) {
      try {
        const dest = path.join(CLOUD, cloudPath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(filePath, dest);
        uploads.push({ cloudPath, local: filePath, size: fs.statSync(filePath).size });
        success({ fileId: `cloud://mock.env/${cloudPath}` });
      } catch (e) {
        fail({ errMsg: e.message });
      }
    },
  },

  // 压缩与画布在 Node 里没法真跑，直接透传（测的是链路不是编码）
  compressImage({ src, success }) {
    success({ tempFilePath: src });
  },
  getImageInfo({ success }) {
    success({ width: 720, height: 720 });
  },
};

const exif = require('../miniprogram/utils/exif.js');
const photo = require('../miniprogram/utils/photo.js');

/* ------------------------------ 造样本 ------------------------------ */

const TYPE_W = { 2: 1, 4: 4, 5: 8, 7: 1 };

function ascii(s) {
  return Buffer.from(s + '\0', 'latin1');
}

function buildTiff(o) {
  o = o || {};
  const w16 = (v) => {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(v);
    return b;
  };
  const w32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v);
    return b;
  };

  const ifd0 = [];
  const exifIfd = [];

  if (o.make) ifd0.push({ tag: 0x010f, type: 2, data: ascii(o.make) });
  if (o.model) ifd0.push({ tag: 0x0110, type: 2, data: ascii(o.model) });
  if (o.date) exifIfd.push({ tag: 0x9003, type: 2, data: ascii(o.date) });
  if (o.makerNotes) exifIfd.push({ tag: 0x927c, type: 7, data: o.makerNotes });

  if (o.gps) {
    const rat = (vals) => {
      const b = Buffer.alloc(vals.length * 8);
      vals.forEach((v, i) => {
        b.writeUInt32BE(Math.round(Math.abs(v) * 10000), i * 8);
        b.writeUInt32BE(10000, i * 8 + 4);
      });
      return b;
    };
    ifd0.push({ tag: 0x8825, type: 4, data: Buffer.alloc(4) }); // 占位，稍后回填
    o.__gps = [
      { tag: 0x0001, type: 2, data: ascii('N') },
      { tag: 0x0002, type: 5, data: rat(o.gps.lat) },
      { tag: 0x0003, type: 2, data: ascii('E') },
      { tag: 0x0004, type: 5, data: rat(o.gps.lng) },
    ];
  }
  if (exifIfd.length) ifd0.push({ tag: 0x8769, type: 4, data: Buffer.alloc(4) });

  const gpsIfd = o.__gps || [];
  const ifd0At = 8;
  const ifd0Size = 2 + ifd0.length * 12 + 4;
  const exifAt = ifd0At + ifd0Size;
  const exifSize = exifIfd.length ? 2 + exifIfd.length * 12 + 4 : 0;
  const gpsAt = exifAt + exifSize;
  const gpsSize = gpsIfd.length ? 2 + gpsIfd.length * 12 + 4 : 0;

  for (const e of ifd0) {
    if (e.tag === 0x8769) e.data = w32(exifAt);
    if (e.tag === 0x8825) e.data = w32(gpsAt);
  }

  let dataAt = gpsAt + gpsSize;
  const writeIfd = (list) => {
    if (!list.length) return { buf: Buffer.alloc(0), data: Buffer.alloc(0) };
    const head = [w16(list.length)];
    const blobs = [];
    for (const e of list) {
      head.push(w16(e.tag), w16(e.type), w32(e.data.length / (TYPE_W[e.type] || 1)));
      if (e.data.length <= 4) {
        const pad = Buffer.alloc(4);
        e.data.copy(pad, 0, 0, Math.min(4, e.data.length));
        head.push(pad);
      } else {
        head.push(w32(dataAt));
        blobs.push(e.data);
        dataAt += e.data.length;
      }
    }
    head.push(w32(0));
    return { buf: Buffer.concat(head), data: Buffer.concat(blobs) };
  };

  const a = writeIfd(ifd0);
  const b = writeIfd(exifIfd);
  const c = writeIfd(gpsIfd);
  const header = Buffer.concat([Buffer.from('MM', 'latin1'), w16(0x2a), w32(ifd0At)]);
  return Buffer.concat([header, a.buf, b.buf, c.buf, a.data, b.data, c.data]);
}

function seg(marker, body) {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

function buildJpeg(tiff, o) {
  o = o || {};
  const parts = [Buffer.from([0xff, 0xd8])];
  if (tiff) parts.push(seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])));
  if (o.xmp) {
    parts.push(
      seg(
        0xe1,
        Buffer.concat([
          Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'),
          Buffer.from(o.xmp, 'utf8'),
        ])
      )
    );
  }
  parts.push(Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0, 0]));
  parts.push(Buffer.alloc(o.pixels || 64, 0x55));
  parts.push(Buffer.from([0xff, 0xd9]));
  if (o.mp4) parts.push(o.mp4);
  return Buffer.concat([parts[0]].concat(parts.slice(1)));
}

/** 一段可辨识的 MP4：固定内容，方便验证切出来的字节是否一模一样 */
function buildMp4(payload) {
  const size = payload || 20000;
  const ftyp = Buffer.alloc(32);
  ftyp.writeUInt32BE(32, 0);
  ftyp.write('ftyp', 4, 'latin1');
  ftyp.write('mp42', 8, 'latin1');
  ftyp.writeUInt32BE(0, 12);
  ftyp.write('mp42', 16, 'latin1');
  ftyp.write('isom', 20, 'latin1');

  const moov = Buffer.alloc(16);
  const body = Buffer.alloc(size);
  // 独特图案：每个字节都跟位置相关，切错了一个字节就能发现
  for (let i = 0; i < size; i++) body[i] = (i * 7) & 0xff;
  moov.writeUInt32BE(16 + size, 0);
  moov.write('moov', 4, 'latin1');
  return Buffer.concat([ftyp, moov, body]);
}

function appleNotes(tag, value) {
  const v = ascii(value);
  const head = Buffer.concat([
    Buffer.from('Apple iOS\0', 'latin1'),
    Buffer.from([0x00, 0x01]),
    Buffer.from('MM', 'latin1'),
  ]);
  const at = head.length + 2 + 12 + 4;

  const ifd = Buffer.alloc(2 + 12 + 4);
  ifd.writeUInt16BE(1, 0);
  ifd.writeUInt16BE(tag, 2);
  ifd.writeUInt16BE(2, 4);
  ifd.writeUInt32BE(v.length, 6);
  ifd.writeUInt32BE(at, 10);
  ifd.writeUInt32BE(0, 14);

  return Buffer.concat([head, ifd, v]);
}

/** 造一段假的 iPhone MOV：moov 里带 content.identifier */
function buildMov(uuid) {
  const ident = Buffer.from(uuid, 'latin1');
  const inner = Buffer.alloc(64, 0x11);
  inner.writeUInt32BE(16, 0);
  inner.write('moov', 4, 'latin1');
  const ftyp = Buffer.alloc(32);
  ftyp.writeUInt32BE(32, 0);
  ftyp.write('ftyp', 4, 'latin1');
  ftyp.write('qt  ', 8, 'latin1');
  ftyp.write('qt  ', 16, 'latin1');
  return Buffer.concat([ftyp, inner, ident, Buffer.alloc(256, 0x33)]);
}

/* ------------------------------ 写文件 ------------------------------ */

const S = {
  motion: path.join(TMP, 'xiaomi-motion.jpg'),
  plain: path.join(TMP, 'plain.jpg'),
  live: path.join(TMP, 'iphone-live.heic'),
  mov: path.join(TMP, 'IMG_0001.MOV'),
};

// 小米风格：老标准 XMP + 尾部 MP4
const mp4 = buildMp4(20000);
const motionXmp = `<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description xmlns:GCamera="http://ns.google.com/photos/1.0/camera/">
   <GCamera:MicroVideo>1</GCamera:MicroVideo>
   <GCamera:MicroVideoOffset>${mp4.length}</GCamera:MicroVideoOffset>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
fs.writeFileSync(
  S.motion,
  buildJpeg(buildTiff({ date: '2025-06-01 18:20:11', make: 'Xiaomi', model: 'XIAOMI 14', gps: { lat: [34.34], lng: [108.94] } }), {
    pixels: 3000,
    xmp: motionXmp,
    mp4,
  })
);

fs.writeFileSync(
  S.plain,
  buildJpeg(buildTiff({ date: '2025-08-16 06:02:10', make: 'OPPO', model: 'Find X7' }), { pixels: 3000 })
);

// 实况主图：只有 MakerNotes 里的 UUID，没有内嵌视频
fs.writeFileSync(
  S.live,
  buildJpeg(
    buildTiff({
      date: '2026-01-14 13:26:42',
      make: 'Apple',
      model: 'iPhone 15 Pro',
      makerNotes: appleNotes(0x0011, '133ED373-F65A-4E84-B61F-41A6029C5765'),
    }),
    { pixels: 3000 }
  )
);

fs.writeFileSync(S.mov, buildMov('133ED373-F65A-4E84-B61F-41A6029C5765'));

/* ------------------------------ 断言 ------------------------------ */

let pass = 0;
let failed = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}`);
    if (detail !== undefined) console.log(`      → ${JSON.stringify(detail)}`);
  }
}

(async () => {
  console.log('\n[1] readMeta 分段读取');
  {
    const m = await exif.readMeta(S.motion);
    ok('读到日期', m.date === '2025-06-01', m.date);
    ok('读到坐标', Math.abs(m.lat - 34.34) < 0.01, [m.lat, m.lng]);
    ok('找到内嵌视频', !!(m.motion && m.motion.length), m.motion);
    ok('视频长度等于拼接的那段', m.motion && m.motion.length === mp4.length, m.motion && m.motion.length);
  }
  {
    const m = await exif.readMeta(S.plain);
    ok('普通照片没有视频', m.motion === null, m.motion);
    ok('普通照片日期正常', m.date === '2025-08-16', m.date);
  }
  {
    const m = await exif.readMeta(S.live);
    ok('实况主图认出 UUID', m.liveId === '133ED373-F65A-4E84-B61F-41A6029C5765', m.liveId);
    ok('实况主图本身没有视频', m.motion === null, m.motion);
  }

  console.log('\n[2] 切片出来的视频内容必须与原文件逐字节一致');
  {
    const m = await exif.readMeta(S.motion);
    const out = await exif.extractMotion(S.motion, m.motion, 'probe');
    const got = fs.readFileSync(out);
    const src = fs.readFileSync(S.motion).subarray(m.motion.offset);
    ok('切片长度一致', got.length === src.length, [got.length, src.length]);
    ok('切片内容一致', got.equals(src), '前 16 字节: ' + got.subarray(0, 16).toString('hex'));
    ok('切片开头是 ftyp 盒', got.subarray(4, 8).toString('latin1') === 'ftyp');
  }

  console.log('\n[3] 从 MOV 里读实况配对标识');
  {
    const id = await photo.readVideoId(S.mov);
    ok('MOV 里读出 UUID', id === '133ED373-F65A-4E84-B61F-41A6029C5765', id);
  }
  {
    const id = await photo.readVideoId(S.plain);
    ok('普通文件读不出 UUID', id === '', id);
  }

  console.log('\n[4] buildPhotos 整条链路');
  uploads = [];
  const built = await photo.buildPhotos(
    [{ path: S.motion }, { path: S.plain }, { path: S.live }],
    () => {}
  );
  ok('三张都成功', built.ok.length === 3, built.ok.length);
  ok('没有跳过', built.skipped.noExif === 0 && built.skipped.failed === 0, built.skipped);

  const [mx, pl, lv] = built.ok;
  ok('小米那张带 motionFileId', /^cloud:\/\//.test(mx.motionFileId), mx.motionFileId);
  ok('小米那张标记为动态', mx.live === true, mx.live);
  ok('小米那张机型正确', mx.make === 'Xiaomi', mx.make);
  ok('OPPO 那张没有动态', pl.motionFileId === '' && pl.live === false, [pl.motionFileId, pl.live]);
  ok('实况那张进了待配列表', built.lives.length === 1 && built.lives[0] === lv, built.lives.length);
  ok('实况那张暂时没有视频', lv.motionFileId === '', lv.motionFileId);

  ok('上传了 4 个文件（3 缩略图 + 1 视频）', uploads.length === 4, uploads.map((u) => u.cloudPath));
  const videoUpload = uploads.find((u) => /\.mp4$/.test(u.cloudPath));
  ok('视频走的是 motion 目录', !!videoUpload && /^motion\//.test(videoUpload.cloudPath), videoUpload);
  ok('视频大小与原拼接段一致', !!videoUpload && videoUpload.size === mp4.length, videoUpload && videoUpload.size);

  console.log('\n[5] 实况视频配对');
  {
    const matched = await photo.matchVideos([S.mov], built.lives);
    ok('按 UUID 配上', matched.matched === 1, matched);
    ok('配上后拿到了本地视频路径', !!lv.__videoPath, lv.__videoPath);
  }
  {
    const n = await photo.attachVideos(built.lives);
    ok('视频上传成功', n === 1, n);
    ok('实况那张补上了 motionFileId', /^cloud:\/\//.test(lv.motionFileId), lv.motionFileId);
  }

  console.log('\n[6] 提交前摘掉内部字段');
  {
    const clean = photo.clean(built.ok);
    ok('不含 __videoPath', clean.every((p) => !('__videoPath' in p)), Object.keys(clean[0]));
    ok('不含 liveId（UUID 不上云）', clean.every((p) => !('liveId' in p)), Object.keys(clean[0]));
    ok('保留 motionFileId', /^cloud:\/\//.test(clean[2].motionFileId), clean[2].motionFileId);
  }

  console.log('\n[7] 没有拍摄时间的图片被跳过');
  {
    const noExif = path.join(TMP, 'no-exif.jpg');
    fs.writeFileSync(noExif, buildJpeg(buildTiff({ make: 'Xiaomi', model: 'no date' }), { pixels: 500 }));
    const r = await photo.buildPhotos([{ path: noExif }], () => {});
    ok('被算作无拍摄时间', r.ok.length === 0 && r.skipped.noExif === 1, r.skipped);
  }

  console.log(`\n${'-'.repeat(46)}`);
  console.log(`通过 ${pass} 项，失败 ${failed} 项`);
  console.log(`临时目录：${TMP}`);
  if (failed) process.exit(1);
})().catch((e) => {
  console.error('\n测试崩了：', e);
  process.exit(1);
});
