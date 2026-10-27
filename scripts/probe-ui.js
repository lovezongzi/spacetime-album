'use strict';

/**
 * 驱动开发者工具模拟器，把页面真点一遍，并逐页截图。
 *
 * 用法：
 *   cli auto --project <项目> --auto-port 9420 --trust-project
 *   NODE_PATH=/Users/zongzi/.workbuddy/binaries/node/workspace/node_modules node scripts/probe-ui.js
 */

const path = require('path');
const fs = require('fs');
const automator = require('miniprogram-automator');

const ENDPOINT = process.env.AUTO_ENDPOINT || 'ws://127.0.0.1:9420';
const OUT = path.join(__dirname, '..', 'docs', 'ui-check');

let step = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(mp, name) {
  const file = path.join(OUT, `${String(++step).padStart(2, '0')}-${name}.png`);
  try {
    await mp.screenshot({ path: file });
    console.log(`    📷 ${path.basename(file)}`);
  } catch (e) {
    console.log(`    (截图失败 ${name}: ${e.message})`);
  }
}

function ok(label, cond, extra) {
  console.log(`  ${cond ? '✓' : '✗'} ${label}` + (cond || extra === undefined ? '' : ` → ${JSON.stringify(extra)}`));
  if (!cond) process.exitCode = 1;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const mp = await automator.connect({ wsEndpoint: ENDPOINT });
  console.log('✓ 已连上模拟器\n');

  console.log('[0] 清空这个账号的历史数据');
  const reset = await mp.evaluate(
    () =>
      new Promise((resolve) => {
        wx.cloud
          .callFunction({ name: 'api', data: { path: '/api/reset', method: 'POST', body: {} } })
          .then((r) => resolve(r.result))
          .catch((e) => resolve({ err: (e && e.errMsg) || String(e) }));
      })
  );
  if (reset && reset.code === 200) {
    console.log('    ✓ 已清空相册与配对');
  } else {
    // 首次运行时这个 openid 还没注册，401 是正常的
    console.log('    - 跳过（' + JSON.stringify(reset && reset.code) + '）');
  }

  console.log('\n[1] 登录页填名字进入');
  // 已经登录过的话，登录页 onLoad 会立刻跳回相册，自动化会等不到稳定页面，
  // 所以先主动退出登录
  await mp.evaluate(() => {
    const app = getApp();
    if (app && app.logout) app.logout();
    wx.clearStorageSync();
  });
  await wait(300);

  await mp.reLaunch('/pages/login/index');
  await wait(1200);
  let page = await mp.currentPage();
  ok('停在登录页', page.path === 'pages/login/index', page.path);

  const input = await page.$('.input');
  ok('找到昵称输入框', !!input);
  await input.input('云端快照');
  await wait(300);
  await shot(mp, 'login-filled');

  const enterBtn = await page.$('.btn.primary.block');
  await enterBtn.tap();
  await wait(2600);

  page = await mp.currentPage();
  ok('进入相册页', page.path === 'pages/album/index', page.path);
  await shot(mp, 'album-empty');

  console.log('\n[2] 载入示例相册');
  const sampleBtn = await page.$('.sample');
  ok('找到「载入示例相册」按钮', !!sampleBtn);
  await sampleBtn.tap();
  await wait(4000);

  let data = await page.data();
  ok('相册里有照片', (data.photos || []).length > 0, (data.photos || []).length);
  ok('统计已更新', data.stats && data.stats.photos > 0, data.stats);
  await shot(mp, 'album-filled');

  console.log('\n[3] 遇见页抽一天');
  await mp.switchTab('/pages/match/index');
  await wait(2000);
  page = await mp.currentPage();
  ok('进入遇见页', page.path === 'pages/match/index', page.path);
  await shot(mp, 'match-idle');

  const redraw = await page.$('.redraw');
  ok('找到「抽一天」', !!redraw);
  await redraw.tap();
  await wait(3000);

  data = await page.data();
  ok('抽到了一个日子', !!data.random && !!data.random.date, data.random);
  ok('有候选人', (data.list || []).length > 0, (data.list || []).length);
  await shot(mp, 'match-result');

  console.log('\n[4] 发起交换');
  const swapBtn = await page.$('.swap-btn');
  ok('找到「交换」按钮', !!swapBtn);
  await swapBtn.tap();
  await wait(1000);
  await shot(mp, 'swap-sheet');

  const goBtn = await page.$('.sheet-go');
  ok('找到「发出交换请求」', !!goBtn);
  await goBtn.tap();
  await wait(2000);
  await shot(mp, 'swap-sent');

  console.log('\n[5] 等演示账号同意（5 秒）');
  await wait(5000);
  await mp.switchTab('/pages/pairs/index');
  await wait(2500);
  page = await mp.currentPage();
  ok('进入交换页', page.path === 'pages/pairs/index', page.path);
  data = await page.data();
  ok('对话列表里有内容', (data.rooms || []).length > 0, {
    rooms: (data.rooms || []).length,
    outgoing: (data.outgoing || []).length,
  });
  await shot(mp, 'pairs');

  console.log('\n[6] 进房间，按下展示');
  const room = await page.$('.room');
  ok('找到房间卡片', !!room);
  await room.tap();
  await wait(5000);
  page = await mp.currentPage();
  ok('进入房间页', page.path === 'pages/room/index', page.path);
  data = await page.data();
  ok('有按天的分组', (data.groups || []).length > 0, (data.groups || []).length);
  ok('此刻还看不见对方', data.pair && data.pair.canSee === false, data.pair && data.pair.canSee);
  ok('自己也还没展示', data.pair && data.pair.mine === false, data.pair && data.pair.mine);
  await shot(mp, 'room-locked');

  const revealBtn = await page.$('.btn.primary.block');
  ok('找到「按下展示」', !!revealBtn);
  await revealBtn.tap();
  await wait(2500);
  await shot(mp, 'room-waiting-demo');

  console.log('\n[7] 等演示账号也展示（11 秒）');
  await wait(11000);
  data = await page.data();
  ok('双方可见', data.pair && data.pair.canSee === true, data.pair && data.pair.canSee);
  const anyTheirs = (data.groups || []).some((g) => g.canSee && g.theirs && g.theirs.length);
  ok('能看到对方的照片', anyTheirs, (data.groups || []).map((g) => ({ d: g.date, t: g.theirs && g.theirs.length })));
  await shot(mp, 'room-revealed');

  console.log(`\n截图存在 ${OUT}`);
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error('\n✗ 界面探针失败：', e && (e.message || e));
  process.exit(2);
});
