'use strict';

const { uid, hash, skyThumb } = require('./util');

/**
 * 演示用的「日子」。真实环境下这些数据来自用户相册的 EXIF。
 * 刻意让三位演示用户的日期互相重叠，以便匹配页立刻有结果。
 */
const DEMO_DAYS = [
  { date: '2026-09-14', time: '18:42', place: '西安 · 曲江池', lat: 34.2036, lng: 108.9855 },
  { date: '2026-07-02', time: '19:15', place: '西安 · 城墙永宁门', lat: 34.2506, lng: 108.9443 },
  { date: '2026-05-21', time: '17:08', place: '秦岭 · 分水岭', lat: 33.9300, lng: 108.9000 },
  { date: '2026-03-08', time: '20:31', place: '西安 · 大唐不夜城', lat: 34.2135, lng: 108.9620 },
  { date: '2025-12-31', time: '23:54', place: '西安 · 钟楼', lat: 34.2610, lng: 108.9423 },
  { date: '2025-10-05', time: '16:20', place: '西安 · 浐灞湿地', lat: 34.3600, lng: 109.0400 },
  { date: '2025-08-16', time: '06:02', place: '华山 · 北峰', lat: 34.4780, lng: 110.0850 },
  { date: '2025-06-19', time: '18:55', place: '西安 · 大雁塔', lat: 34.2186, lng: 108.9640 },
  { date: '2024-11-11', time: '17:40', place: '成都 · 锦江', lat: 30.6570, lng: 104.0660 },
  { date: '2024-04-06', time: '07:12', place: '西安 · 环城公园', lat: 34.2580, lng: 108.9500 },
];

const DEMO_USERS = [
  { name: '阿岚', days: [0, 1, 3, 5, 7, 9] },
  { name: '程小满', days: [1, 2, 4, 5, 8] },
  { name: '江野', days: [0, 2, 3, 6, 7, 9] },
];

/** 当前登录用户「一键载入」的示例相册（与三位演示用户都有交集） */
const SAMPLE_SELF_DAYS = [0, 2, 4, 6, 8, 1];

function makePhoto(userId, day, salt) {
  const seed = userId + day.date + salt;
  return {
    id: uid('ph'),
    userId,
    date: day.date,
    time: day.time,
    place: day.place,
    lat: day.lat,
    lng: day.lng,
    thumb: skyThumb(seed, hash(seed) % 5 === 0 ? 'portrait' : 'landscape'),
    approx: false,
    source: 'demo',
    createdAt: Date.now(),
  };
}

function seedDemo(db) {
  const users = [];
  for (const spec of DEMO_USERS) {
    const user = {
      id: uid('u'),
      name: spec.name,
      token: uid('t'),
      demo: true,
      createdAt: Date.now(),
    };
    users.push(user);
    db.users.push(user);
    spec.days.forEach((idx, i) => {
      db.photos.push(makePhoto(user.id, DEMO_DAYS[idx], i));
      if (i === 0) db.photos.push(makePhoto(user.id, DEMO_DAYS[idx], i + 100));
    });
  }
  return users;
}

/** 给当前用户塞一组示例照片，保证立刻能匹配到人 */
function sampleForUser(db, userId) {
  const created = [];
  SAMPLE_SELF_DAYS.forEach((idx, i) => {
    const p = makePhoto(userId, DEMO_DAYS[idx], 'self' + i);
    p.source = 'sample';
    db.photos.push(p);
    created.push(p);
  });
  return created;
}

module.exports = { DEMO_DAYS, DEMO_USERS, SAMPLE_SELF_DAYS, seedDemo, sampleForUser };
