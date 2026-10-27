'use strict';

/**
 * 通过开发者工具自动化接口，直接在小程序运行时里调云函数。
 *
 * 用法：
 *   # 先开自动化端口
 *   cli auto --project <项目> --auto-port 9420 --trust-project
 *   # 再跑这个
 *   NODE_PATH=/Users/zongzi/.workbuddy/binaries/node/workspace/node_modules node scripts/probe-cloud.js
 *
 * 这样能在手机扫码之前，把「云函数真的能跑通」这件事验证掉。
 */

const automator = require('miniprogram-automator');

const ENDPOINT = process.env.AUTO_ENDPOINT || 'ws://127.0.0.1:9420';

function log(label, value) {
  console.log(`  ${label}:`, typeof value === 'string' ? value : JSON.stringify(value));
}

(async () => {
  const mp = await automator.connect({ wsEndpoint: ENDPOINT });
  console.log('✓ 已连上开发者工具\n');

  const call = (path, method, body) =>
    mp.evaluate(
      (p, m, b) =>
        new Promise((resolve) => {
          wx.cloud.callFunction({ name: 'api', data: { path: p, method: m, body: b } })
            .then((r) => resolve({ ok: true, result: r.result }))
            .catch((e) => resolve({ ok: false, err: (e && e.errMsg) || String(e) }));
        }),
      path,
      method,
      body || {}
    );

  console.log('[1] 云函数连通性');
  const health = await call('/api/health', 'GET');
  console.log('  原始返回:', JSON.stringify(health));
  const h = health.ok && health.result ? health.result : null;
  const hd = h && h.data;
  if (!hd || !hd.ok) {
    console.log('\n✗ 云函数调不通，先解决这一步');
    process.exit(1);
  }
  log('用户数', hd.users);
  log('照片数', hd.photos);
  log('后端', hd.backend);

  console.log('\n[2] 登录');
  const login = await call('/api/wx/login', 'POST', { name: '真机验证' });
  console.log('  原始返回:', JSON.stringify(login).slice(0, 300));
  const ld = login.result && login.result.data;
  if (!ld || !ld.user) {
    console.log('\n✗ 登录失败');
    process.exit(1);
  }
  log('昵称', ld.user.name);
  log('身份', ld.user.id);

  console.log('\n[3] 载入示例相册');
  const sample = await call('/api/demo/sample', 'POST', {});
  const sd = sample.result && sample.result.data;
  log('导入', sd && sd.added);
  log('相册状态', sd && sd.stats);

  console.log('\n[4] 随机匹配一天');
  const match = await call('/api/match', 'POST', { mode: 'random' });
  const md = match.result && match.result.data;
  if (!md || !md.date) {
    console.log('  匹配失败:', JSON.stringify(match).slice(0, 400));
  } else {
    log('这一天', md.date);
    log('候选人数', md.total);
    log('候选人', (md.candidates || []).map((c) => `${c.user.name}（重合 ${c.overlap.length} 天，${c.distanceKm}km）`));
  }

  console.log('\n[5] 拉相册');
  const photos = await call('/api/photos', 'GET');
  const pd = photos.result && photos.result.data;
  log('照片数', pd && pd.photos && pd.photos.length);
  log('示例', pd && pd.photos && pd.photos.slice(0, 2).map((p) => ({ date: p.date, svg: p.svg })));

  console.log('\n[6] 发起交换 + 等对方同意');
  const cand = md && md.candidates && md.candidates[0];
  if (!cand) {
    console.log('  没有候选人，跳过');
    process.exit(0);
  }
  const pair = await call('/api/pairs', 'POST', { toUserId: cand.user.id, dates: cand.overlap });
  const pr = pair.result && pair.result.data;
  console.log('  发起返回:', JSON.stringify(pair.result).slice(0, 300));
  if (!pr || !pr.pair) {
    console.log('  发起失败');
    process.exit(1);
  }
  const pid = pr.pair.id;
  log('配对 id', pid);

  console.log('  等 5 秒看演示账号是否自动同意…');
  await new Promise((r) => setTimeout(r, 5000));
  const st = await call(`/api/pairs/${pid}/state`, 'GET');
  const std = st.result && st.result.data;
  log('状态', std && std.pair && std.pair.status);
  log('能否互看', std && std.canSee);

  if (std && std.pair && std.pair.status === 'accepted') {
    console.log('\n✓ 云函数整条链路跑通了');
  } else {
    console.log('\n⚠ 状态没推进，看上面的原始返回');
  }

  process.exit(0);
})().catch((e) => {
  console.error('✗ 探针失败：', e && (e.message || e));
  process.exit(2);
});
