'use strict';

/**
 * 演示数据。
 *
 * 为了让一个人也能走完「发起 → 对方同意 → 双方展示 → 互相看见」整条链路，
 * 这里内置三位虚拟用户，配了互相重叠的日子；演示账号会自动接受请求、自动点亮展示。
 *
 * 演示照片不放真实图片：小程序端 <image> 不支持 SVG，前端本来就用渐变占位，
 * 所以只标 svg:true，配色由前端 gradOf(_id) 稳定算出。这样数据库里不用塞几十 KB 的串。
 */

const DEMO_DAYS = [
  { date: '2026-09-14', time: '18:42', place: '西安 · 曲江池', lat: 34.2036, lng: 108.9855 },
  { date: '2026-07-02', time: '19:15', place: '西安 · 城墙永宁门', lat: 34.2506, lng: 108.9443 },
  { date: '2026-05-21', time: '17:08', place: '秦岭 · 分水岭', lat: 33.93, lng: 108.9 },
  { date: '2026-03-08', time: '20:31', place: '西安 · 大唐不夜城', lat: 34.2135, lng: 108.962 },
  { date: '2025-12-31', time: '23:54', place: '西安 · 钟楼', lat: 34.261, lng: 108.9423 },
  { date: '2025-10-05', time: '16:20', place: '西安 · 浐灞湿地', lat: 34.36, lng: 109.04 },
  { date: '2025-08-16', time: '06:02', place: '华山 · 北峰', lat: 34.478, lng: 110.085 },
  { date: '2025-06-19', time: '18:55', place: '西安 · 大雁塔', lat: 34.2186, lng: 108.964 },
  { date: '2024-11-11', time: '17:40', place: '成都 · 锦江', lat: 30.657, lng: 104.066 },
  { date: '2024-04-06', time: '07:12', place: '西安 · 环城公园', lat: 34.258, lng: 108.95 },
];

const DEMO_USERS = [
  { key: 'alan', name: '阿岚', days: [0, 1, 3, 5, 7, 9] },
  { key: 'xiaoman', name: '程小满', days: [1, 2, 4, 5, 8] },
  { key: 'jiangye', name: '江野', days: [0, 2, 3, 6, 7, 9] },
];

/** 当前登录用户「一键载入」的示例相册（与三位演示用户都有交集） */
const SAMPLE_SELF_DAYS = [0, 2, 4, 6, 8, 1];

const demoUserId = (key) => `demo_${key}`;

function demoUsers() {
  return DEMO_USERS.map((s) => ({
    _id: demoUserId(s.key),
    name: s.name,
    demo: true,
    createdAt: 1750000000000,
  }));
}

/** 用固定的 _id，重复播种只会覆盖，不会翻倍 */
function demoPhotos() {
  const out = [];
  for (const spec of DEMO_USERS) {
    spec.days.forEach((idx, i) => {
      const day = DEMO_DAYS[idx];
      const n = i === 0 ? 2 : 1; // 第一天给两张，让房间页左右对照更明显
      for (let k = 0; k < n; k++) {
        const seed = `${spec.key}${idx}${k}`;
        out.push({
          _id: `dph_${seed}`,
          userId: demoUserId(spec.key),
          date: day.date,
          time: day.time,
          place: day.place,
          lat: day.lat,
          lng: day.lng,
          fileId: '',
          svg: true,
          approx: false,
          source: 'demo',
          createdAt: 1750000000000 + idx * 1000 + k,
        });
      }
    });
  }
  return out;
}

/** 给某个真人用户塞一组示例照片，保证他立刻能匹配到人 */
function samplePhotosFor(userId) {
  return SAMPLE_SELF_DAYS.map((idx, i) => {
    const day = DEMO_DAYS[idx];
    return {
      _id: `sph_${userId}_${idx}`,
      userId,
      date: day.date,
      time: day.time,
      place: day.place,
      lat: day.lat,
      lng: day.lng,
      fileId: '',
      svg: true,
      approx: false,
      source: 'sample',
      createdAt: Date.now() + i,
    };
  });
}

module.exports = {
  DEMO_DAYS,
  DEMO_USERS,
  SAMPLE_SELF_DAYS,
  demoUsers,
  demoPhotos,
  samplePhotosFor,
};
