const a = require('miniprogram-automator');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const mp = await a.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });

  // 拿一个真实存在的配对 id
  const pairId = await mp.evaluate(async () => {
    const r = await wx.cloud.callFunction({ name: 'api', data: { path: '/api/pairs', method: 'GET' } });
    const d = r.result.data || {};
    const all = [].concat(d.rooms || [], d.incoming || [], d.outgoing || []);
    return all.length ? all[0].id : '';
  });

  if (!pairId) {
    console.log('当前账号没有配对记录，跳过房间页预览验证');
    await mp.disconnect();
    process.exit(0);
  }

  await mp.navigateTo(`/pages/room/index?id=${pairId}`);
  await wait(3000);

  const page = await mp.currentPage();
  console.log(`  当前页：${page.path}`);

  // 注入一组带动态的照片，验证渲染分支
  await page.setData({
    groups: [
      {
        date: '2025-06-01',
        pretty: '6 月 1 日',
        week: '周日',
        canSee: true,
        mine: [
          {
            id: 'fake-motion',
            thumb: '',
            svg: false,
            time: '18:20',
            motion: 'cloud://fake.env/a.mp4',
            live: true,
          },
        ],
        theirs: [
          {
            id: 'fake-live',
            thumb: '',
            svg: true,
            grad: 3,
            sunX: 40,
            sunY: 30,
            time: '18:21',
            motion: '',
            live: true,
          },
        ],
      },
    ],
  });
  await wait(600);

  console.log('\n[1] 动态照片');
  // 用真实点击而不是 callMethod —— 顺带验证 bindtap / dataset 绑定对不对
  let shots = await page.$$('.shot');
  ok('网格里渲染出两张照片', shots.length === 2, shots.length);
  await shots[0].tap();
  await wait(700);
  let d = await page.data();
  ok('打开了预览层', !!d.viewing, d.viewing && d.viewing.id);
  ok('识别出有动态', d.viewing && d.viewing.hasMotion === true, d.viewing && d.viewing.hasMotion);
  ok('带上日期标题', d.viewing && d.viewing.datePretty === '6 月 1 日', d.viewing && d.viewing.datePretty);
  const videoEl = await page.$('.viewer .viewer-media');
  ok('预览层里渲染出播放器', !!videoEl);
  await mp.screenshot({ path: 'docs/ui-check/12-viewer-motion.png' });

  console.log('\n[2] 关掉预览');
  const stage = await page.$('.viewer');
  if (stage) await stage.tap();
  await wait(500);
  d = await page.data();
  ok('点空白处能关闭', d.viewing === null, d.viewing);

  console.log('\n[3] 实况封面（没有视频）');
  shots = await page.$$('.shot');
  await shots[1].tap();
  await wait(700);
  d = await page.data();
  ok('实况封面能打开', !!d.viewing, d.viewing && d.viewing.id);
  ok('没有动态但标记为实况', d.viewing.hasMotion === false && d.viewing.live === true, {
    m: d.viewing.hasMotion,
    l: d.viewing.live,
  });
  ok('取到的是对方那栏的那张', d.viewing.id === 'fake-live', d.viewing.id);
  await mp.screenshot({ path: 'docs/ui-check/13-viewer-live.png' });

  console.log('\n[4] 静态图不做播放器');
  {
    // 换成一张完全没有动态的照片，预览层里不该出现 <video>
    await page.setData({
      groups: [
        {
          date: '2025-06-02',
          pretty: '6 月 2 日',
          week: '周一',
          canSee: true,
          mine: [{ id: 'plain', thumb: '', svg: true, grad: 5, sunX: 30, sunY: 20, time: '09:10', motion: '', live: false }],
          theirs: [],
        },
      ],
    });
    await wait(400);
    const s2 = await page.$$('.shot');
    await s2[0].tap();
    await wait(600);
    d = await page.data();
    ok('静态照片也能打开', !!d.viewing && d.viewing.id === 'plain', d.viewing && d.viewing.id);
    ok('静态照片没有动态标记', d.viewing.hasMotion === false, d.viewing.hasMotion);
    const v2 = await page.$('.viewer .viewer-media');
    ok('静态照片不渲染播放器', !v2);
  }

  console.log(`\n${'-'.repeat(46)}`);
  console.log(`通过 ${pass} 项，失败 ${failed} 项`);

  await mp.disconnect();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
