#!/usr/bin/env node
/**
 * EXIF 解析器的本地测试（不需要小程序环境）。
 *
 * 三组用例：
 *   1. 真实 HEIC（iPhone 默认格式）—— IMG_5100.HEIC
 *   2. 自造 HEIC —— 不依赖任何外部文件，专门覆盖「Exif 项在头部之外要补读」
 *   3. 不该误判的输入 —— PNG / 垃圾数据 / 空文件 / 只有 ftyp 的 HEIC
 *
 * 用法：
 *   node scripts/test-exif.js [某个 .HEIC]
 * 不传路径时用内置的 Downloads/IMG_5100.HEIC；文件不在也照样跑第 2、3 组。
 */

const fs = require('fs');
const path = require('path');

const exif = require('../miniprogram/utils/exif.js');

let pass = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}  ${detail === undefined ? '' : JSON.stringify(detail)}`);
  }
}

function toView(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/* ------------------------- 自造 HEIC 的小工具 ------------------------- */

/** 一个 ISO BMFF 盒：4 字节长度 + 4 字节类型 + 负载 */
function box(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'binary');
  return Buffer.concat([head, payload]);
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

/** 最小的 TIFF：IFD0 → Exif 子 IFD → DateTimeOriginal。
 *  用大端（MM），因为下面的 u16/u32 都是 writeUInt*BE —— 别声明 II 却写大端数。 */
function buildTiff(dateStr) {
  const str = Buffer.from(dateStr + '\0', 'binary');
  const IFD0 = 8;
  const EXIF_IFD = IFD0 + 2 + 12 + 4; // 计数 + 1 条记录 + 下个 IFD 指针
  const DATA = EXIF_IFD + 2 + 12 + 4;

  const header = Buffer.concat([
    Buffer.from('MM', 'binary'),
    u16(0x002a),
    u32(IFD0),
  ]);

  const ifd0 = Buffer.concat([
    u16(1),
    // tag 0x8769 = Exif 子 IFD 指针，type 4 (LONG)，count 1
    u16(0x8769), u16(4), u32(1), u32(EXIF_IFD),
    u32(0), // 没有下一个 IFD
  ]);

  const exifIfd = Buffer.concat([
    u16(1),
    // tag 0x9003 = DateTimeOriginal，type 2 (ASCII)
    u16(0x9003), u16(2), u32(str.length), u32(DATA),
    u32(0),
  ]);

  return Buffer.concat([header, ifd0, exifIfd, str]);
}

/**
 * 造一个 HEIC。exifOffset 是 Exif item 在**这个 buffer 内**的偏移，
 * base 是这个 buffer 在文件里的起始偏移 —— iloc 里写的是文件绝对偏移（base + exifOffset）。
 * totalSize 决定文件有多长（可以故意让它短于 exifOffset，模拟「在头部之外」）。
 */
function buildHeic(exifOffset, totalSize, base) {
  const at = base || 0;
  const tiff = buildTiff('2026:10:27 07:33:29');

  const iinf = box(
    'iinf',
    Buffer.concat([
      u32(0), // version 0 + flags
      u16(1), // 1 个条目
      box(
        'infe',
        Buffer.concat([
          u32(0x02000000), // version 2
          u16(1), // item_ID
          u16(0), // protection index
          Buffer.from('Exif', 'binary'),
          Buffer.from([0]), // 空名字
        ]),
      ),
    ]),
  );

  const iloc = box(
    'iloc',
    Buffer.concat([
      u32(0), // version 0 + flags
      Buffer.from([0x44, 0x00]), // offset_size=4, length_size=4, base_offset_size=0
      u16(1), // 1 个条目
      u16(1), // item_ID
      u16(0), // data_reference_index
      u16(1), // 1 个 extent
      u32(at + exifOffset), // 文件绝对偏移
      u32(4096), // 长度足够覆盖 TIFF
    ]),
  );

  const meta = box('meta', Buffer.concat([u32(0), iinf, iloc]));
  const ftyp = box('ftyp', Buffer.from('heic\x00\x00\x00\x00mif1', 'binary'));

  const head = Buffer.concat([ftyp, meta]);
  const exifBlock = Buffer.concat([u32(0), tiff]); // 4 字节 TIFF 相对偏移 = 0

  const need = Math.max(totalSize, head.length, exifOffset + exifBlock.length);
  const buf = Buffer.alloc(need);
  head.copy(buf, 0);
  if (exifOffset + exifBlock.length <= need) exifBlock.copy(buf, exifOffset);
  return buf;
}

/** 在真实文件里找一个「包含 meta、但不含 Exif 项」的切片，用于验证补读 */
function realNeed(buf) {
  for (let cut = 8192; cut < Math.min(buf.length, 256 * 1024); cut += 512) {
    const r = exif.parse(toView(buf.subarray(0, cut)), 0);
    if (r && r.__need) return r.__need;
  }
  return null;
}

/* ------------------------------- 跑测试 ------------------------------- */

console.log('EXIF 解析器测试\n');

const HEIC = process.argv[2] || '/Users/zongzi/Downloads/IMG_5100.HEIC';

/* ---- 1. 真实 HEIC ---- */
if (!fs.existsSync(HEIC)) {
  console.log(`（跳过真实文件：找不到 ${HEIC}）`);
} else {
  const buf = fs.readFileSync(HEIC);
  const head = buf.subarray(0, 256 * 1024);

  console.log(`真实文件：${path.basename(HEIC)}   ${(buf.length / 1048576).toFixed(1)} MB`);

  const r = exif.parse(toView(head), 0);
  ok('识别出 HEIC 并解析到拍摄时间', r && !!r.date, r);
  if (r && r.date) {
    console.log(`     → ${r.date} ${r.time}   GPS ${r.lat}, ${r.lng}`);
    ok('日期形如 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(r.date), r.date);
    ok('时间形如 HH:MM', /^\d{2}:\d{2}$/.test(r.time), r.time);
    ok(
      '坐标在合法范围',
      r.lat === null || (Math.abs(r.lat) <= 90 && Math.abs(r.lng) <= 180),
      r,
    );
  }

  const need = realNeed(buf);
  if (need) {
    const chunk = buf.subarray(need.offset, need.offset + need.length);
    const r2 = exif.parseExifBlock(new DataView(toView(chunk)), 0);
    ok('头部截断时按偏移补读，得到同一个日期', r2 && r2.date === (r && r.date), r2);
  } else {
    ok('头部截断时按偏移补读，得到同一个日期', false, '没有找到触发补读的切片');
  }
}

/* ---- 2. 自造 HEIC ---- */
console.log('\n自造 HEIC：');
{
  const full = buildHeic(5000, 6000);
  const r = exif.parse(toView(full), 0);
  ok('完整文件能解析', r && r.date === '2026-10-27' && r.time === '07:33', r);

  // 只给前 2000 字节：meta 在、Exif 项在 5000
  const cut = exif.parse(toView(full.subarray(0, 2000)), 0);
  ok('Exif 项在头部之外时返回 __need', cut && cut.__need && cut.__need.offset === 5000, cut);

  if (cut && cut.__need) {
    const chunk = full.subarray(cut.__need.offset, cut.__need.offset + cut.__need.length);
    const r2 = exif.parseExifBlock(new DataView(toView(chunk)), 0);
    ok('按 __need 补读后解析成功', r2 && r2.date === '2026-10-27', r2);
  }

  // base 偏移：这个 buffer 在文件里从 1000 开始，所以 iloc 里的绝对偏移是 1000+4000
  const shifted = Buffer.concat([Buffer.alloc(1000, 0), buildHeic(4000, 5000, 1000)]);
  const r3 = exif.parse(toView(shifted.subarray(1000)), 1000);
  ok('带 base 偏移时仍能定位 Exif', r3 && r3.date === '2026-10-27', r3);
}

/* ---- 3. 不该误判的输入 ---- */
console.log('\n不该误判的输入：');
{
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  ok('PNG 返回 null（截图不会有 EXIF）', exif.parse(toView(png), 0) === null);

  ok('垃圾数据返回 null', exif.parse(toView(Buffer.alloc(64, 0x41)), 0) === null);
  ok('空数据返回 null', exif.parse(toView(Buffer.alloc(0)), 0) === null);

  const ftypOnly = box('ftyp', Buffer.from('heic\x00\x00\x00\x00mif1', 'binary'));
  ok('只有 ftyp 的 HEIC 返回 null 而不是抛错', exif.parse(toView(ftypOnly), 0) === null);

  // 声明了 Exif 项但偏移越界：不能崩，应回 null 或 __need
  const broken = buildHeic(9_000_000, 2000);
  const rb = exif.parse(toView(broken.subarray(0, 2000)), 0);
  ok('Exif 偏移越界时安全返回', rb === null || (rb && rb.__need), rb);
}

/* ---- 4. 格式嗅探（决定上传扩展名与要不要转 JPEG） ---- */
console.log('\n格式嗅探：');
{
  const photo = require('../miniprogram/utils/photo.js');

  const heic = buildHeic(5000, 6000);
  ok('认出 HEIC', photo.kindOf(new DataView(toView(heic.subarray(0, 32)))) === 'heic');

  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
  ok('认出 JPEG', photo.kindOf(new DataView(toView(jpeg))) === 'jpg');

  const png = Buffer.concat([
    Buffer.from([0x89]),
    Buffer.from('PNG\r\n\x1a\n', 'binary'),
    Buffer.alloc(20),
  ]);
  ok('认出 PNG（签名字节要照真实的来）', photo.kindOf(new DataView(toView(png))) === 'png');

  const webp = Buffer.concat([
    Buffer.from('RIFF', 'binary'),
    Buffer.alloc(4),
    Buffer.from('WEBP', 'binary'),
    Buffer.alloc(8),
  ]);
  ok('认出 WebP', photo.kindOf(new DataView(toView(webp))) === 'webp');

  ok('认不出来时返回空（调用方退回 jpg）', photo.kindOf(new DataView(toView(Buffer.alloc(32)))) === '');

  if (fs.existsSync(HEIC)) {
    const head = fs.readFileSync(HEIC).subarray(0, 32);
    ok('真实 HEIC 文件头也认得', photo.kindOf(new DataView(toView(head))) === 'heic');
  }

  const realPng = path.join(__dirname, '..', 'docs', 'icon', 'icon-192.png');
  if (fs.existsSync(realPng)) {
    const head = fs.readFileSync(realPng).subarray(0, 32);
    ok('真实 PNG 图标认得出', photo.kindOf(new DataView(toView(head))) === 'png');
  }
}

/* ------------------------------- 汇总 ------------------------------- */
console.log(`\n${pass} 项通过${failures.length ? `，${failures.length} 项失败` : '，全部通过'}`);
if (failures.length) {
  console.log('失败：' + failures.join('、'));
  process.exit(1);
}
