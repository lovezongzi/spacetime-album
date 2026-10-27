'use strict';

/**
 * 云函数本地端到端测试。
 *
 * 用法：
 *   node scripts/test-cloud.js
 *
 * 用内存 mock 顶替 wx-server-sdk，把「登录 → 载入示例 → 随机一天 → 发起交换 →
 * 演示账号自动同意 → 按下展示 → 双方可见」整条链路跑一遍。
 * 不需要装任何依赖，也不需要云环境。
 */

const path = require('path');
const Module = require('module');

// 把 require('wx-server-sdk') 重定向到本地 mock（必须在加载云函数之前）
const MOCK_SDK = path.join(__dirname, 'test-deps', 'mocks', 'wx-server-sdk', 'index.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'wx-server-sdk') return MOCK_SDK;
  return originalResolve.call(this, request, ...rest);
};

let clock = 1790000000000;
const realNow = Date.now;
Date.now = () => clock;

const cloud = require('wx-server-sdk');
const fn = require('../miniprogram/cloudfunctions/api/index.js');

let pass = 0;
let failCount = 0;

function check(label, cond, extra) {
  if (cond) {
    pass += 1;
    console.log('  ✓ ' + label);
  } else {
    failCount += 1;
    console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}

function section(t) {
  console.log('\n' + t);
}

async function call(openid, path, method, body) {
  cloud.__mock.setOpenid(openid);
  const r = await fn.main({ path, method: method || 'GET', body: body || {} });
  return r;
}

(async () => {
  const A = 'openid_real_A';
  const B = 'openid_real_B';

  section('0. 健康检查 + 自动播种');
  let r = await call(A, '/api/health', 'GET');
  check('health 返回 200', r.code === 200, r);
  check('演示用户已播种（3 位）', r.data.users === 3, r.data);
  check('演示照片已播种（20 张）', r.data.photos === 20, r.data);

  section('1. 未登录用户访问受保护接口');
  r = await call('openid_never_registered', '/api/photos', 'GET');
  check('返回 401 引导去登录页', r.code === 401, r);

  section('2. 登录');
  r = await call(A, '/api/wx/login', 'POST', { name: '测试甲' });
  check('登录成功', r.code === 200, r);
  check('昵称正确', r.data.user.name === '测试甲', r.data.user);
  check('初始相册为空', r.data.stats.photos === 0, r.data.stats);
  const token = r.data.token;
  check('返回了登录标记', !!token);

  r = await call(A, '/api/me', 'GET');
  check('me 接口可用', r.code === 200 && r.data.user.name === '测试甲', r);

  section('3. 载入示例相册');
  r = await call(A, '/api/demo/sample', 'POST', {});
  check('导入 6 张', r.data.added === 6, r.data);
  check('覆盖 6 个日子', r.data.stats.dates === 6, r.data.stats);

  r = await call(A, '/api/photos', 'GET');
  check('照片列表 6 条', r.data.photos.length === 6, r.data.photos.length);
  check('示例照片走渐变占位（svg=true）', r.data.photos.every((p) => p.svg === true));
  check('示例照片没有 fileID', r.data.photos.every((p) => p.thumb === ''));

  section('4. 随机匹配一天');
  r = await call(A, '/api/match', 'POST', { mode: 'random' });
  check('匹配成功', r.code === 200, r);
  check('给出了一个日子', /^\d{4}-\d{2}-\d{2}$/.test(r.data.date || ''), r.data.date);
  check('有候选陌生人', r.data.candidates.length > 0, r.data.candidates.length);
  const cand = r.data.candidates[0];
  check('候选带上名字', !!cand.user.name, cand.user);
  check('候选算出了共同天数', cand.overlap.length >= 1, cand.overlap);
  check('候选算出了距离', typeof cand.distanceKm === 'number', cand.distanceKm);

  section('5. 指定时间段匹配');
  r = await call(A, '/api/match', 'POST', { mode: 'range', from: '2025-01-01', to: '2026-12-31' });
  check('range 模式成功', r.code === 200, r);
  check('筛出了共同的日子', (r.data.dates || []).length > 0, r.data.dates);

  section('6. 发起交换');
  r = await call(A, '/api/pairs', 'POST', { toUserId: cand.user.id, dates: cand.overlap });
  check('发起成功', r.code === 200, r);
  check('状态是 pending', r.data.pair.status === 'pending', r.data.pair);
  check('发起人是自己', r.data.pair.iAmInitiator === true);
  const pairId = r.data.pair.id;

  r = await call(A, '/api/pairs', 'POST', { toUserId: cand.user.id, dates: cand.overlap });
  check('重复发起被拦（409）', r.code === 409, r);
  check('409 带回了已有配对 id', r.data.pairId === pairId, r.data);

  section('7. 演示账号自动同意（4 秒后）');
  r = await call(A, `/api/pairs/${pairId}/state`, 'GET');
  check('4 秒前还是 pending', r.data.pair.status === 'pending', r.data.pair.status);

  clock += 5000;
  r = await call(A, `/api/pairs/${pairId}/state`, 'GET');
  check('4 秒后自动 accepted', r.data.pair.status === 'accepted', r.data.pair.status);
  check('这时还看不见对方照片', r.data.canSee === false);

  r = await call(A, '/api/pairs', 'GET');
  check('列表里进了 rooms', r.data.rooms.length === 1, r.data.rooms.length);
  check('incoming 已清空', r.data.incoming.length === 0);

  section('8. 按下展示');
  r = await call(A, `/api/pairs/${pairId}/reveal`, 'POST', {});
  check('自己已展示', r.data.pair.mine === true, r.data.pair);
  check('对方还没展示', r.data.pair.theirs === false, r.data.pair);
  check('还不能互相看见', r.data.pair.canSee === false);

  r = await call(A, `/api/pairs/${pairId}`, 'GET');
  check('对方照片被藏住', r.data.groups.every((g) => g.theirs === null), r.data.groups);
  check('自己的照片能看见', r.data.groups.some((g) => g.mine.length > 0), r.data.groups);

  section('9. 演示账号也展示（9 秒后）');
  clock += 10000;
  r = await call(A, `/api/pairs/${pairId}/state`, 'GET');
  check('双方可见', r.data.canSee === true, r.data);

  r = await call(A, `/api/pairs/${pairId}`, 'GET');
  check('能看到对方照片了', r.data.groups.some((g) => g.theirs && g.theirs.length > 0), r.data.groups.map((g) => ({ d: g.date, t: g.theirs && g.theirs.length })));
  check('分组数量等于共同日子数', r.data.groups.length === cand.overlap.length);

  section('10. 照片上传校验');
  r = await call(A, '/api/photos', 'POST', {
    photos: [
      { date: '2026-09-14', time: '08:00', fileId: 'cloud://env-bucket/photos/x.jpg' },
      { date: '2026-09-14', time: '08:10', fileId: 'http://evil.example/x.jpg' },
      { date: 'not-a-date', time: '08:20', fileId: 'cloud://env-bucket/photos/y.jpg' },
      { date: '2026-09-14', time: '08:30', fileId: '' },
    ],
  });
  check('只收下合法的云存储 fileID（1 张）', r.data.added === 1, r.data);
  check('相册变成 7 张', r.data.stats.photos === 7, r.data.stats);

  r = await call(A, '/api/photos', 'GET');
  const real = r.data.photos.filter((p) => !p.svg);
  check('真实照片带 cloud:// 地址', real.length === 1 && /^cloud:\/\//.test(real[0].thumb), real);

  section('11. 删照片');
  const firstId = r.data.photos[0].id;
  r = await call(A, `/api/photos/${firstId}`, 'DELETE');
  check('删除成功', r.code === 200, r);
  check('少了一张', r.data.stats.photos === 6, r.data.stats);

  r = await call(A, '/api/photos/not_exist_id', 'DELETE');
  check('删不存在的照片返回 404', r.code === 404, r);

  section('12. 第二个真人用户能不能看到第一个');
  r = await call(B, '/api/wx/login', 'POST', { name: '测试乙' });
  check('乙登录成功', r.code === 200, r);
  await call(B, '/api/demo/sample', 'POST', {});
  r = await call(B, '/api/match', 'POST', { mode: 'random' });
  const names = (r.data.candidates || []).map((c) => c.user.name);
  check('乙能匹配到甲', names.includes('测试甲'), names);
  check('乙也能匹配到演示用户', names.some((n) => ['阿岚', '程小满', '江野'].includes(n)), names);

  section('13. 越权防护');
  r = await call(B, `/api/pairs/${pairId}`, 'GET');
  check('乙看不到别人的配对（404）', r.code === 404, r);

  const pair = cloud.__mock.dump('pairs').find((p) => p._id === pairId);
  r = await call(A, `/api/pairs/${pairId}/respond`, 'POST', { accept: true });
  check('发起人不能自己点同意（403）', r.code === 403, r);

  section('14. 重置');
  r = await call(A, '/api/reset', 'POST', {});
  check('重置成功', r.code === 200, r);
  check('相册清空', r.data.stats.photos === 0, r.data.stats);
  const left = cloud.__mock.dump('pairs').filter((p) => p.a === A || p.b === A);
  check('配对记录也清掉了', left.length === 0, left.length);

  section('15. 未知路由');
  r = await call(A, '/api/nope', 'GET');
  check('返回 404', r.code === 404, r);

  console.log(`\n${'-'.repeat(46)}`);
  console.log(`通过 ${pass} 项，失败 ${failCount} 项`);

  Date.now = realNow;
  process.exit(failCount ? 1 : 0);
})().catch((e) => {
  console.error('\n测试脚本自身出错：', e);
  Date.now = realNow;
  process.exit(2);
});
