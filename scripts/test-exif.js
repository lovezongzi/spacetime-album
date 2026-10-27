'use strict';

/**
 * 元数据解析器测试。
 *
 * 用法：node scripts/test-exif.js
 *
 * 覆盖三部分：
 *   1. 真实文件（iPhone HEIC / SONY JPEG / 实况主图）
 *   2. 各家写法的差异（日期格式、GPS 写法、容器）
 *   3. 动态照片的三种识别路径 + 误判防护
 *
 * 除了真实文件，样本都是现场按规范拼的 —— 这样能精确控制「哪一段在哪」，
 * 也才能在改动解析器时立刻知道有没有踩坏原本对的分支。
 */
const fs = require('fs');
const path = require('path');
const exif = require('../miniprogram/utils/exif.js');
const photo = require('../miniprogram/utils/photo.js');

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

function toView(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
}

function probe(buf, fileSize) {
  return exif.parse(toView(buf), 0, fileSize === undefined ? buf.length : fileSize);
}

/* ------------------------------ 构造器 ------------------------------ */

const TYPE_W = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };

function ascii(s) {
  return Buffer.from(s + '\0', 'latin1');
}

/**
 * 拼一个 TIFF。参数：
 *   date / dateIn('exif'|'ifd0') / dateTag
 *   tz / make / model / makerNotes(Buffer)
 *   gps: { lat: number[], lng: number[], latRef, lngRef, omitRef }
 *   little: 用小端
 */
function buildTiff(o) {
  o = o || {};
  const little = !!o.little;
  const w16 = (v) => {
    const b = Buffer.alloc(2);
    little ? b.writeUInt16LE(v) : b.writeUInt16BE(v);
    return b;
  };
  const w32 = (v) => {
    const b = Buffer.alloc(4);
    little ? b.writeUInt32LE(v) : b.writeUInt32BE(v);
    return b;
  };

  const ifd0 = [];
  const exifIfd = [];
  const gpsIfd = [];

  if (o.make) ifd0.push({ tag: 0x010f, type: 2, data: ascii(o.make) });
  if (o.model) ifd0.push({ tag: 0x0110, type: 2, data: ascii(o.model) });

  if (o.date) {
    if (o.dateIn === 'ifd0') ifd0.push({ tag: 0x0132, type: 2, data: ascii(o.date) });
    else exifIfd.push({ tag: o.dateTag || 0x9003, type: 2, data: ascii(o.date) });
  }
  if (o.tz) exifIfd.push({ tag: 0x9011, type: 2, data: ascii(o.tz) });
  if (o.makerNotes) exifIfd.push({ tag: 0x927c, type: 7, data: o.makerNotes });

  if (o.gps) {
    const rat = (vals) => {
      const b = Buffer.alloc(vals.length * 8);
      vals.forEach((v, i) => {
        // 真实 EXIF 里负号由 Ref 表达，度分秒本身是绝对值
        const num = Math.round(Math.abs(v) * 10000);
        little ? b.writeUInt32LE(num, i * 8) : b.writeUInt32BE(num, i * 8);
        little ? b.writeUInt32LE(10000, i * 8 + 4) : b.writeUInt32BE(10000, i * 8 + 4);
      });
      return b;
    };
    if (!o.gps.omitRef) {
      gpsIfd.push({ tag: 0x0001, type: 2, data: ascii(o.gps.latRef || 'N') });
    }
    gpsIfd.push({ tag: 0x0002, type: 5, data: rat(o.gps.lat) });
    if (!o.gps.omitRef) {
      gpsIfd.push({ tag: 0x0003, type: 2, data: ascii(o.gps.lngRef || 'E') });
    }
    gpsIfd.push({ tag: 0x0004, type: 5, data: rat(o.gps.lng) });
  }

  let pExif = null;
  let pGps = null;
  if (exifIfd.length) {
    pExif = { tag: 0x8769, type: 4, data: Buffer.alloc(4) };
    ifd0.push(pExif);
  }
  if (gpsIfd.length) {
    pGps = { tag: 0x8825, type: 4, data: Buffer.alloc(4) };
    ifd0.push(pGps);
  }

  const ifd0At = 8;
  const ifd0Size = 2 + ifd0.length * 12 + 4;
  const exifAt = ifd0At + ifd0Size;
  const exifSize = exifIfd.length ? 2 + exifIfd.length * 12 + 4 : 0;
  const gpsAt = exifAt + exifSize;
  const gpsSize = gpsIfd.length ? 2 + gpsIfd.length * 12 + 4 : 0;

  if (pExif) pExif.data = w32(exifAt);
  if (pGps) pGps.data = w32(gpsAt);

  let dataAt = gpsAt + gpsSize;

  const writeIfd = (list) => {
    if (!list.length) return { buf: Buffer.alloc(0), data: Buffer.alloc(0) };
    const head = [w16(list.length)];
    const blobs = [];
    for (const e of list) {
      head.push(w16(e.tag));
      head.push(w16(e.type));
      head.push(w32(e.data.length / (TYPE_W[e.type] || 1)));
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

  const header = Buffer.concat([
    Buffer.from(little ? 'II' : 'MM', 'latin1'),
    w16(0x2a),
    w32(ifd0At),
  ]);

  return Buffer.concat([header, a.buf, b.buf, c.buf, a.data, b.data, c.data]);
}

function seg(marker, body) {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

/** 拼一张 JPEG，尾部可选拼一段 MP4 */
function buildJpeg(tiff, o) {
  o = o || {};
  const parts = [Buffer.from([0xff, 0xd8])];
  if (tiff) {
    parts.push(seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])));
  }
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
  // SOS + 一小段假图像数据 + EOI
  parts.push(Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0, 0]));
  parts.push(Buffer.alloc(o.pixels || 64, 0x55));
  parts.push(Buffer.from([0xff, 0xd9]));
  if (o.mp4) parts.push(o.mp4);
  return Buffer.concat(parts);
}

/** 一段最小 MP4：ftyp(32) + moov(含 payload) */
function buildMp4(payload) {
  const size = payload || 8192;
  const ftyp = Buffer.alloc(32);
  ftyp.writeUInt32BE(32, 0);
  ftyp.write('ftyp', 4, 'latin1');
  ftyp.write('mp42', 8, 'latin1');
  ftyp.writeUInt32BE(0, 12);
  ftyp.write('mp42', 16, 'latin1');
  ftyp.write('isom', 20, 'latin1');

  const body = Buffer.alloc(size, 0x22);
  const moov = Buffer.alloc(16);
  moov.writeUInt32BE(16 + size, 0);
  moov.write('moov', 4, 'latin1');

  return Buffer.concat([ftyp, moov, body]);
}

function buildPng(tiff) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body, Buffer.alloc(4)]); // CRC 不校验，填零
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(100, 0);
  ihdr.writeUInt32BE(100, 4);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('eXIf', tiff),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildWebp(tiff) {
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32LE(body.length, 4);
    const pad = body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
    return Buffer.concat([head, body, pad]);
  };
  const vp8 = chunk('VP8 ', Buffer.alloc(16, 0x33));
  const ex = chunk('EXIF', Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]));
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), vp8, ex]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/** Apple MakerNotes：tag 指定，值是 UUID 或任意 ASCII */
function appleNotes(tag, value) {
  const v = ascii(value);
  const head = Buffer.concat([
    Buffer.from('Apple iOS\0', 'latin1'),
    Buffer.from([0x00, 0x01]),
    Buffer.from('MM', 'latin1'),
  ]);
  const count = 1;
  const ifdSize = 2 + count * 12 + 4;
  const valueAt = head.length + ifdSize; // 偏移基准是 MakerNotes 起点

  const ifd = Buffer.alloc(ifdSize);
  let p = 0;
  ifd.writeUInt16BE(count, p);
  p += 2;
  ifd.writeUInt16BE(tag, p);
  p += 2;
  ifd.writeUInt16BE(2, p); // ASCII
  p += 2;
  ifd.writeUInt32BE(v.length, p);
  p += 4;
  ifd.writeUInt32BE(valueAt, p);
  p += 4;
  ifd.writeUInt32BE(0, p);

  return Buffer.concat([head, ifd, v]);
}

const XMP_OLD = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:Camera="http://ns.google.com/photos/1.0/camera/"
    xmlns:GCamera="http://ns.google.com/photos/1.0/camera/">
   <GCamera:MicroVideo>1</GCamera:MicroVideo>
   <GCamera:MicroVideoVersion>1</GCamera:MicroVideoVersion>
   <GCamera:MicroVideoOffset>__OFFSET__</GCamera:MicroVideoOffset>
   <GCamera:MicroVideoPresentationTimestampUs>333227</GCamera:MicroVideoPresentationTimestampUs>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

const XMP_NEW = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:Camera="http://ns.google.com/photos/1.0/camera/"
    xmlns:Container="http://ns.google.com/photos/1.0/container/">
   <Camera:MotionPhoto>1</Camera:MotionPhoto>
   <Camera:MotionPhotoVersion>1</Camera:MotionPhotoVersion>
   <Camera:MotionPhotoPresentationTimestampUs>1500000</Camera:MotionPhotoPresentationTimestampUs>
   <Container:Directory>
    <rdf:Seq>
     <rdf:li rdf:parseType="Resource">
      <Container:Item Container:Mime="image/jpeg" Container:Semantic="Primary" Container:Length="4096"/>
     </rdf:li>
     <rdf:li rdf:parseType="Resource">
      <Container:Item Container:Mime="video/mp4" Container:Semantic="MotionPhoto" Container:Length="__OFFSET__"/>
     </rdf:li>
    </rdf:Seq>
   </Container:Directory>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

/* ------------------------------ 一、真实文件 ------------------------------ */

console.log('\n[1] 真实文件');
const D = '/Users/zongzi/Downloads';

if (fs.existsSync(`${D}/IMG_5100.HEIC`)) {
  const buf = fs.readFileSync(`${D}/IMG_5100.HEIC`);
  const r = probe(buf.subarray(0, 256 * 1024), buf.length);
  ok('iPhone HEIC 读出日期', r && r.date === '2026-10-27', r && r.date);
  ok('iPhone HEIC 读出时刻', r && r.time === '07:33', r && r.time);
  ok('iPhone HEIC 读出时区', r && r.tz === '+08:00', r && r.tz);
  ok('iPhone HEIC 读出机型', r && /iPhone/.test(r.model), r && r.model);
  ok(
    'iPhone HEIC 读出坐标（西安）',
    r && Math.abs(r.lat - 34.2386) < 0.01 && Math.abs(r.lng - 108.8818) < 0.01,
    r && [r.lat, r.lng]
  );
  ok('iPhone HEIC 认出实况标识', r && /^[0-9A-F]{8}-/.test(r.liveId), r && r.liveId);
  ok('HEIC 不误报内嵌视频', r && r.motion === null, r && r.motion);
}

if (fs.existsSync(`${D}/IMG_7026.JPG`)) {
  const buf = fs.readFileSync(`${D}/IMG_7026.JPG`);
  const r = probe(buf.subarray(0, 256 * 1024), buf.length);
  ok('相机 JPEG 读出日期', r && r.date === '2026-02-02', r && r.date);
  ok('相机 JPEG 读出厂商', r && r.make === 'SONY', r && r.make);
  ok('相机照片不该有实况标识', r && r.liveId === '', r && r.liveId);
}

if (fs.existsSync(`${D}/livePhoto_1768368402.JPG`)) {
  const buf = fs.readFileSync(`${D}/livePhoto_1768368402.JPG`);
  const r = probe(buf.subarray(0, 256 * 1024), buf.length);
  ok('实况主图 JPG 认出标识', r && r.liveId === 'B693C1E7-EA67-45EE-AAF7-302FBC95AA7B', r && r.liveId);
}

/* ------------------------------ 二、日期写法 ------------------------------ */

console.log('\n[2] 日期写法（各家 ROM 差异）');
const dateCases = [
  ['EXIF 标准', '2026:10:27 07:33:29', '2026-10-27', '07:33'],
  ['短横线分隔', '2026-10-27 07:33:29', '2026-10-27', '07:33'],
  ['缺秒', '2026:10:27 07:33', '2026-10-27', '07:33'],
  ['ISO 带时区', '2026-10-27T07:33:29+08:00', '2026-10-27', '07:33'],
  ['ISO 带 Z', '2026-10-27T07:33:29Z', '2026-10-27', '07:33'],
  ['紧凑式', '20261027_073329', '2026-10-27', '07:33'],
  ['只有日期', '2026:10:27', '2026-10-27', ''],
  ['带毫秒', '2026-10-27 07:33:29.512', '2026-10-27', '07:33'],
];
for (const [label, raw, wantDate, wantTime] of dateCases) {
  const t = exif.parseTime(raw);
  ok(
    `${label}：${raw}`,
    t && t.date === wantDate && t.time === wantTime,
    t
  );
}

console.log('\n[3] 无效日期必须挡掉');
ok('全零时间戳', exif.parseTime('0000:00:00 00:00:00') === null, exif.parseTime('0000:00:00 00:00:00'));
ok('月份越界', exif.parseTime('2026:13:45 25:99') === null);
ok('年份太早', exif.parseTime('0001:01:01 00:00:00') === null);
ok('空串', exif.parseTime('') === null);
ok('乱码', exif.parseTime('not a date') === null);

/* ------------------------------ 四、GPS 写法 ------------------------------ */

console.log('\n[4] GPS 写法');
{
  const r = probe(buildJpeg(buildTiff({
    date: '2026:10:27 07:33:29',
    gps: { lat: [34, 14, 18.96], lng: [108, 52, 54.4] },
  })));
  ok('度分秒 + N/E', Math.abs(r.lat - 34.2386) < 0.01 && Math.abs(r.lng - 108.8817) < 0.01, [r.lat, r.lng]);
  ok('有 Ref 时不标可疑', r.geoApprox === false, r.geoApprox);
}
{
  const r = probe(buildJpeg(buildTiff({
    date: '2026:10:27 07:33:29',
    gps: { lat: [34, 14, 18.96], lng: [108, 52, 54.4], omitRef: true },
  })));
  ok('缺 Ref 仍能算出坐标', Math.abs(r.lat - 34.2386) < 0.01, [r.lat, r.lng]);
  ok('缺 Ref 标记为可疑', r.geoApprox === true, r.geoApprox);
}
{
  const r = probe(buildJpeg(buildTiff({
    date: '2026:10:27 07:33:29',
    gps: { lat: [0], lng: [0] },
  })));
  ok('全零坐标忽略', r.lat === null && r.lng === null, [r.lat, r.lng]);
}
{
  const r = probe(buildJpeg(buildTiff({
    date: '2026:10:27 07:33:29',
    gps: { lat: [33.8688], lng: [151.2093], latRef: 'S' },
  })));
  ok('南方单值坐标', Math.abs(r.lat + 33.8688) < 0.01, [r.lat, r.lng]);
}

/* ------------------------------ 五、动态照片 ------------------------------ */

console.log('\n[5] 安卓动态照片');

// 老标准：MicroVideoOffset 从文件末尾倒数
{
  const mp4 = buildMp4(10000);
  const tiff = buildTiff({
    date: '2025-06-01 18:20:11',
    make: 'Xiaomi',
    model: 'XIAOMI 14',
  });
  const base = buildJpeg(tiff, { pixels: 2000 });
  const withMp4 = Buffer.concat([base, mp4]);
  const xmp = XMP_OLD.replace('__OFFSET__', String(mp4.length));
  const full = buildJpeg(tiff, { pixels: 2000, xmp, mp4 });

  const r = probe(full.subarray(0, 256 * 1024), full.length);
  ok('老标准认出动态照片', r && r.motion && r.motion.offset > 0, r && r.motion);
  ok('老标准偏移落在 MP4 开头', r && r.motion && full.subarray(r.motion.offset, r.motion.offset + 4).toString('hex') === '00000020', r && r.motion);
  ok('老标准长度覆盖到文件尾', r && r.motion && r.motion.offset + r.motion.length === full.length, r && r.motion);
  ok('动态照片的日期照常读出', r && r.date === '2025-06-01', r && r.date);
}

// 新标准：Container:Directory
{
  const mp4 = buildMp4(12000);
  const tiff = buildTiff({ date: '2025-08-09 06:02:33', make: 'Google', model: 'Pixel 8' });
  const xmp = XMP_NEW.replace('__OFFSET__', String(mp4.length));
  const full = buildJpeg(tiff, { pixels: 3000, xmp, mp4 });

  const r = probe(full.subarray(0, 256 * 1024), full.length);
  ok('新标准认出动态照片', r && r.motion && r.motion.offset > 0, r && r.motion);
  ok('新标准偏移正确', r && r.motion && r.motion.offset + r.motion.length === full.length, r && r.motion);
}

// 没有 XMP：只能靠尾部扫描
{
  const mp4 = buildMp4(9000);
  const tiff = buildTiff({ date: '2025-09-15 12:00:00' });
  const full = buildJpeg(tiff, { pixels: 1500, mp4 });

  const r = probe(full.subarray(0, 256 * 1024), full.length);
  // 尾部扫描在 readMeta 里做（需要读文件尾），这里直接测函数
  const tail = full.subarray(full.length - 1024 * 1024);
  const hit = exif.findTailVideo(new DataView(toView(tail)), full.length, full.length - tail.length);
  ok('无 XMP 时靠尾部扫描找到视频', hit && hit.offset === full.length - mp4.length, hit);
}

// 误判防护：图像数据里塞 ftyp 但不构成 MP4
{
  const junk = Buffer.alloc(4096, 0x77);
  junk.write('ftyp', 100, 'latin1');
  junk.write('mp42', 104, 'latin1');
  const tiff = buildTiff({ date: '2025-09-15 12:00:00' });
  const full = buildJpeg(tiff, { pixels: 200, mp4: junk });

  const hit = exif.findTailVideo(new DataView(toView(full)), full.length, 0);
  ok('乱塞 ftyp 的数据不被当成视频', hit === null, hit);
}

// 完全正常的照片不该被误判
{
  const tiff = buildTiff({ date: '2025-09-15 12:00:00' });
  const full = buildJpeg(tiff, { pixels: 4000 });
  const hit = exif.findTailVideo(new DataView(toView(full)), full.length, 0);
  ok('普通照片没有内嵌视频', hit === null, hit);
}

/* ------------------------------ 六、其它容器 ------------------------------ */

console.log('\n[6] PNG 与 WebP');
{
  const tiff = buildTiff({ date: '2025-03-04 21:10:00', make: 'HUAWEI', model: 'Mate 60' });
  const r = probe(buildPng(tiff));
  ok('PNG 的 eXIf 能读出日期', r && r.date === '2025-03-04', r && r.date);
  ok('PNG 能读出机型', r && r.make === 'HUAWEI', r && r.make);
}
{
  const tiff = buildTiff({ date: '2025-04-05 08:08:08', make: 'vivo', model: 'X100' });
  const r = probe(buildWebp(tiff));
  ok('WebP 的 EXIF 能读出日期', r && r.date === '2025-04-05', r && r.date);
  ok('WebP 能读出机型', r && r.make === 'vivo', r && r.make);
}

/* ------------------------------ 七、实况标识 ------------------------------ */

console.log('\n[7] 实况标识与误判');
{
  const notes = appleNotes(0x0011, '133ED373-F65A-4E84-B61F-41A6029C5765');
  const r = probe(buildJpeg(buildTiff({ date: '2026:01:14 13:26:42', makerNotes: notes })));
  ok('Apple 0x0011 取到实况 UUID', r && r.liveId === '133ED373-F65A-4E84-B61F-41A6029C5765', r && r.liveId);
}
{
  // 连拍的 BurstUUID 是 0x0008，格式相同但不该被当成实况
  const notes = appleNotes(0x0008, 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE');
  const r = probe(buildJpeg(buildTiff({ date: '2026:01:14 13:26:42', makerNotes: notes })));
  ok('连拍 BurstUUID 不误判成实况', r && r.liveId === '', r && r.liveId);
}
{
  const r = probe(buildJpeg(buildTiff({ date: '2026:01:14 13:26:42', make: 'Apple', model: 'iPhone 15 Pro' })));
  ok('没有 MakerNotes 时不报实况', r && r.liveId === '', r && r.liveId);
}

/* ------------------------------ 八、XMP 兜底 ------------------------------ */

console.log('\n[8] 没有 EXIF 时用 XMP');
{
  const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/">
   <exif:DateTimeOriginal>2025-07-07T19:19:19+08:00</exif:DateTimeOriginal>
   <exif:GPSLatitude>31,13.5N</exif:GPSLatitude>
   <exif:GPSLongitude>121,28.5E</exif:GPSLongitude>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
  const r = probe(buildJpeg(null, { xmp }));
  ok('XMP 补出日期', r && r.date === '2025-07-07', r && r.date);
  ok('XMP 补出坐标', r && Math.abs(r.lat - 31.225) < 0.01, r && [r.lat, r.lng]);
}

/* ------------------------------ 九、格式嗅探 ------------------------------ */

console.log('\n[9] 格式嗅探（上传时决定扩展名）');
ok('认出 JPEG', photo.kindOf(new DataView(toView(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])))) === 'jpg');
ok(
  '认出 PNG',
  photo.kindOf(new DataView(toView(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])))) === 'png'
);
{
  const webp = buildWebp(buildTiff({ date: '2025-04-05 08:08:08' }));
  ok('认出 WebP', photo.kindOf(new DataView(toView(webp.subarray(0, 32)))) === 'webp');
}
if (fs.existsSync(`${D}/IMG_5100.HEIC`)) {
  const head = fs.readFileSync(`${D}/IMG_5100.HEIC`).subarray(0, 32);
  ok('认出 HEIC', photo.kindOf(new DataView(toView(head))) === 'heic');
}

/* ------------------------------ 汇总 ------------------------------ */

console.log(`\n${'-'.repeat(46)}`);
console.log(`通过 ${pass} 项，失败 ${failed} 项`);
if (failed) {
  console.log('有失败项，看上面的 ✗ 行');
  process.exit(1);
}
