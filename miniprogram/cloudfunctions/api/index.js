'use strict';

/**
 * 时空相册 —— 云函数后端（单函数多路由）。
 *
 * 为什么从 Node HTTP 服务搬到这里：
 *   小程序真机 / 体验版强制校验 request 合法域名，域名必须已备案。
 *   Cloudflare 临时隧道域名不属于你、无法备案、也放不了校验文件，永远进不了白名单。
 *   云开发的 wx.cloud.callFunction 走微信内部通道，不经过域名校验，也不需要备案。
 *
 * 身份：不再用 token，直接取 cloud.getWXContext().OPENID（微信保证可信）。
 *
 * 存储约定：
 *   users   _id = openid（演示用户用 demo_xxx 之类的人造 id）
 *   photos  fileId 存云存储的 cloud:// 路径；演示/示例照片 fileId 为空、svg=true，前端用渐变占位
 *   pairs   配对状态机 pending → accepted → revealed.a / revealed.b → 双方可见
 */

const cloud = require('wx-server-sdk');
const { demoUsers, demoPhotos, samplePhotosFor } = require('./demo');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const COL = ['users', 'photos', 'pairs', 'meta'];
const PAGE = 100;
const HARD_CAP = 3000;

/* --------------------------------- 小工具 --------------------------------- */

const ok = (data) => ({ code: 200, data });
const fail = (code, message, extra) =>
  Object.assign({ code, data: Object.assign({ error: message }, extra || {}) });

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const isTime = (s) => /^\d{2}:\d{2}$/.test(String(s || ''));

function newId(prefix) {
  return (
    prefix +
    '_' +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 9)
  );
}

/** 云数据库单次最多取 100 条，这里翻页拉全（有硬上限，避免失控） */
async function fetchAll(name, where, field, cap) {
  const out = [];
  let skip = 0;
  const limit = cap || HARD_CAP;
  for (;;) {
    let q = db.collection(name).where(where || {});
    if (field) q = q.field(field);
    const r = await q.skip(skip).limit(PAGE).get();
    out.push(...r.data);
    if (r.data.length < PAGE || out.length >= limit) break;
    skip += PAGE;
  }
  return out;
}

/** 分批并发写，避免串行几十次往返把云函数拖到超时 */
async function batchSet(name, docs, size) {
  const n = size || 10;
  for (let i = 0; i < docs.length; i += n) {
    await Promise.all(
      docs.slice(i, i + n).map((d) => {
        const data = Object.assign({}, d);
        const id = data._id;
        delete data._id;
        return db
          .collection(name)
          .doc(id)
          .set({ data })
          .catch(() => db.collection(name).add({ data: Object.assign({ _id: id }, data) }));
      })
    );
  }
}

/* -------------------------------- 初始化播种 ------------------------------- */

let seeded = false;

async function ensureSeed() {
  if (seeded) return;
  for (const name of COL) {
    try {
      await db.createCollection(name);
    } catch (e) {
      /* 已存在就跳过 */
    }
  }
  try {
    const flag = await db.collection('meta').doc('seed_v1').get();
    if (flag.data && flag.data.done) {
      seeded = true;
      return;
    }
  } catch (e) {
    /* 没有标记，继续播种 */
  }
  await batchSet('users', demoUsers(), 6);
  await batchSet('photos', demoPhotos(), 10);
  await db.collection('meta').doc('seed_v1').set({ data: { done: true, at: Date.now() } });
  seeded = true;
}

/* --------------------------------- 用户相关 -------------------------------- */

async function getUser(id) {
  if (!id) return null;
  try {
    const r = await db.collection('users').doc(id).get();
    return r.data || null;
  } catch (e) {
    return null;
  }
}

async function loadUsers(ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return {};
  const list = await fetchAll('users', { _id: _.in(uniq) }, { name: true, demo: true });
  const map = {};
  for (const u of list) map[u._id] = u;
  return map;
}

const publicUser = (u) => ({
  id: u._id,
  name: u.name || '路过的人',
  demo: !!u.demo,
});

async function albumStats(userId) {
  const rows = await fetchAll('photos', { userId }, { date: true });
  const dates = [...new Set(rows.map((p) => p.date))].sort();
  return {
    photos: rows.length,
    dates: dates.length,
    firstDate: dates[0] || null,
    lastDate: dates[dates.length - 1] || null,
  };
}

/* --------------------------------- 照片相关 -------------------------------- */

const slim = (p) => ({
  id: p._id,
  date: p.date,
  time: p.time || '',
  place: p.place || '',
  lat: typeof p.lat === 'number' ? p.lat : null,
  lng: typeof p.lng === 'number' ? p.lng : null,
  // 云存储 fileID（cloud://...）可以直接喂给 <image src>
  thumb: p.fileId || '',
  // 小程序 <image> 不支持 svg，演示照片改走 WXSS 渐变
  svg: !!p.svg,
  // 动态照片：有 motion 就能播；live 表示这是实况/动态的封面
  motion: p.motionFileId || '',
  live: !!p.live,
  kind: p.kind || '',
  make: p.make || '',
  model: p.model || '',
});

async function photosOf(userId, date) {
  const where = date ? { userId, date } : { userId };
  const rows = await fetchAll('photos', where);
  return rows.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
}

/* --------------------------------- 匹配算法 -------------------------------- */

function haversine(a, b) {
  if (!a || !b) return null;
  if (typeof a.lat !== 'number' || typeof b.lat !== 'number') return null;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)) * 10) / 10;
}

function minDistance(bucketA, bucketB) {
  let best = null;
  for (const x of bucketA) {
    for (const y of bucketB) {
      const d = haversine(x, y);
      if (d != null && (best === null || d < best)) best = d;
    }
  }
  return best;
}

/* --------------------------------- 配对相关 -------------------------------- */

function summarize(pair, myId, partner) {
  const iAmA = pair.a === myId;
  const mine = !!(pair.revealed && pair.revealed[iAmA ? 'a' : 'b']);
  const theirs = !!(pair.revealed && pair.revealed[iAmA ? 'b' : 'a']);
  return {
    id: pair._id,
    partner: partner ? publicUser(partner) : { id: iAmA ? pair.b : pair.a, name: '已离开的用户', demo: false },
    dates: pair.dates || [],
    status: pair.status,
    mine,
    theirs,
    canSee: mine && theirs,
    iAmInitiator: iAmA,
    createdAt: pair.createdAt,
    updatedAt: pair.updatedAt || pair.createdAt,
  };
}

async function demoIdSet() {
  const rows = await fetchAll('users', { demo: true }, { _id: true }, 200);
  return new Set(rows.map((u) => u._id));
}

/**
 * 演示账号的「自动应答」：懒执行，每次读配对时顺手推进状态。
 * 云函数没有常驻进程，没法像原来的 Node 版那样定时跑。
 */
async function tickDemo(pairs, demoSet) {
  const now = Date.now();
  for (const pair of pairs) {
    const aDemo = demoSet.has(pair.a);
    const bDemo = demoSet.has(pair.b);
    if (aDemo === bDemo) continue; // 两边同类，不干预

    const realIsA = !aDemo;
    const iAmA = realIsA; // 以真人视角看，他是不是 a
    const realKey = iAmA ? 'a' : 'b';
    const demoKey = iAmA ? 'b' : 'a';
    const revealed = pair.revealed || {};

    const patch = {};
    if (pair.status === 'pending' && now - pair.createdAt > 4000) {
      patch.status = 'accepted';
      patch.acceptedAt = now;
      patch.updatedAt = now;
    } else if (
      pair.status === 'accepted' &&
      revealed[realKey] &&
      !revealed[demoKey] &&
      now - (pair.acceptedAt || pair.createdAt) > 9000
    ) {
      patch['revealed.' + demoKey] = true;
      patch.updatedAt = now;
    }

    if (Object.keys(patch).length) {
      await db.collection('pairs').doc(pair._id).update({ data: patch }).catch(() => {});
      if (patch.status) pair.status = patch.status;
      if (patch.status) pair.acceptedAt = now;
      if (patch['revealed.' + demoKey]) {
        pair.revealed = Object.assign({}, revealed, { [demoKey]: true });
      }
      if (patch.updatedAt) pair.updatedAt = patch.updatedAt;
    }
  }
}

async function myPairs(myId) {
  const rows = await fetchAll('pairs', _.or([{ a: myId }, { b: myId }]), null, 500);
  return rows.sort((x, y) => (y.updatedAt || y.createdAt) - (x.updatedAt || x.createdAt));
}

/* ---------------------------------- 路由 ---------------------------------- */

async function route(path, method, body, openid) {
  const seg = String(path || '')
    .replace(/^\/?api\/?/, '')
    .split('/')
    .filter(Boolean);
  const key = seg.join('/');

  /* ---------------- 公开 ---------------- */

  if (method === 'GET' && key === 'health') {
    const [u, p] = await Promise.all([
      db.collection('users').count().catch(() => ({ total: 0 })),
      db.collection('photos').count().catch(() => ({ total: 0 })),
    ]);
    return ok({ ok: true, users: u.total, photos: p.total, wxBound: true, backend: 'cloud' });
  }

  if (method === 'POST' && key === 'wx/login') {
    const name = String((body && body.name) || '').trim().slice(0, 16) || '路过的人';
    let user = await getUser(openid);
    if (!user) {
      user = { _id: openid, name, createdAt: Date.now() };
      await db.collection('users').doc(openid).set({ data: { name, createdAt: Date.now() } });
    } else if (user.name !== name) {
      user.name = name;
      await db.collection('users').doc(openid).update({ data: { name } });
    }
    return ok({
      // 客户端只拿它判断「有没有登录」，值本身没有验证作用
      token: openid,
      user: publicUser(user),
      stats: await albumStats(openid),
      bound: true,
    });
  }

  /* ---------------- 以下都要登录 ---------------- */

  const me = await getUser(openid);
  if (!me) return fail(401, '登录状态已失效，请重新进入');

  if (method === 'GET' && key === 'me') {
    return ok({ user: publicUser(me), stats: await albumStats(openid) });
  }

  if (method === 'GET' && key === 'photos') {
    const rows = await photosOf(openid);
    return ok({ photos: rows.map(slim), stats: await albumStats(openid) });
  }

  if (method === 'POST' && key === 'photos') {
    const list = Array.isArray(body && body.photos) ? body.photos.slice(0, 60) : [];
    if (!list.length) return ok({ added: 0, stats: await albumStats(openid) });

    const docs = [];
    let lives = 0;
    for (const raw of list) {
      const date = String(raw.date || '');
      if (!isDate(date)) continue;
      const fileId = String(raw.fileId || '');
      if (!/^cloud:\/\//.test(fileId) || fileId.length > 400) continue;
      const motion = String(raw.motionFileId || '');
      const hasMotion = /^cloud:\/\//.test(motion) && motion.length <= 400;
      if (hasMotion) lives += 1;
      docs.push({
        _id: newId('ph'),
        userId: openid,
        date,
        time: isTime(raw.time) ? raw.time : '',
        place: String(raw.place || '').slice(0, 40),
        lat: typeof raw.lat === 'number' ? raw.lat : null,
        lng: typeof raw.lng === 'number' ? raw.lng : null,
        fileId,
        // 动态照片：切出来的那段 MP4 的 fileID，空表示只有封面
        motionFileId: hasMotion ? motion : '',
        live: !!raw.live || hasMotion,
        kind: ['jpg', 'png', 'webp', 'heic'].indexOf(String(raw.kind)) >= 0 ? raw.kind : '',
        make: String(raw.make || '').slice(0, 24),
        model: String(raw.model || '').slice(0, 40),
        svg: false,
        approx: !!raw.approx,
        source: 'user',
        createdAt: Date.now(),
      });
    }
    if (docs.length) {
      await Promise.all(
        docs.map((d) => {
          const data = Object.assign({}, d);
          delete data._id;
          return db.collection('photos').add({ data: Object.assign({ _id: d._id }, data) });
        })
      );
    }
    return ok({ added: docs.length, motion: lives, stats: await albumStats(openid) });
  }

  if (method === 'DELETE' && seg[0] === 'photos' && seg[1]) {
    const one = await db.collection('photos').where({ _id: seg[1], userId: openid }).get();
    const row = one.data && one.data[0];
    const r = await db.collection('photos').where({ _id: seg[1], userId: openid }).remove();
    if (!r.stats || !r.stats.removed) return fail(404, '照片不存在');
    // 顺带清掉云存储里的缩略图和动态片段，别留垃圾
    const files = [row && row.fileId, row && row.motionFileId].filter((f) => /^cloud:\/\//.test(f || ''));
    if (files.length) await cloud.deleteFile({ fileList: files }).catch(() => null);
    return ok({ ok: true, stats: await albumStats(openid) });
  }

  if (method === 'POST' && key === 'demo/sample') {
    const docs = samplePhotosFor(openid);
    await batchSet('photos', docs, 6);
    return ok({ added: docs.length, stats: await albumStats(openid) });
  }

  /* ---------------- 匹配 ---------------- */

  if (method === 'POST' && key === 'match') {
    const mineRows = await fetchAll(
      'photos',
      { userId: openid },
      { date: true, lat: true, lng: true, time: true }
    );
    const myDates = new Set(mineRows.map((p) => p.date));
    if (!myDates.size) return fail(400, '你的相册里还没有照片');

    let pool = [...myDates].sort();
    const mode = body && body.mode;
    if (mode === 'range') {
      const from = String((body && body.from) || '');
      const to = String((body && body.to) || '');
      pool = pool.filter((d) => (!from || d >= from) && (!to || d <= to));
      if (!pool.length) return fail(400, '这个时间段里没有你的照片');
    }

    // 一次把所有候选人的照片捞出来（只取算距离要用的字段），在内存里分组
    const rows = await fetchAll(
      'photos',
      { date: _.in(pool), userId: _.neq(openid) },
      { userId: true, date: true, lat: true, lng: true, time: true }
    );

    const mineByDate = {};
    for (const p of mineRows) (mineByDate[p.date] = mineByDate[p.date] || []).push(p);

    const byUser = {};
    for (const p of rows) (byUser[p.userId] = byUser[p.userId] || []).push(p);

    const userIds = Object.keys(byUser);
    const users = await loadUsers(userIds);

    const candidates = [];
    for (const uid of userIds) {
      const theirsByDate = {};
      for (const p of byUser[uid]) (theirsByDate[p.date] = theirsByDate[p.date] || []).push(p);

      const overlap = pool.filter((d) => theirsByDate[d]);
      if (!overlap.length) continue;

      let dist = null;
      let near = 0;
      let theirCount = 0;
      for (const d of overlap) {
        theirCount += theirsByDate[d].length;
        const dk = minDistance(mineByDate[d] || [], theirsByDate[d]);
        if (dk != null) {
          if (dist === null || dk < dist) dist = dk;
          if (dk <= 80) near += 1;
        }
      }

      candidates.push({
        user: publicUser(users[uid] || { _id: uid, name: '路过的人' }),
        overlap,
        distanceKm: dist,
        theirPhotoCount: theirCount,
        near,
      });
    }

    candidates.sort((a, b) => {
      if (b.overlap.length !== a.overlap.length) return b.overlap.length - a.overlap.length;
      return (a.distanceKm == null ? 1e9 : a.distanceKm) - (b.distanceKm == null ? 1e9 : b.distanceKm);
    });

    if (mode === 'range') {
      const shared = [...new Set(candidates.flatMap((c) => c.overlap))].sort();
      return ok({ mode: 'range', dates: shared, candidates: candidates.slice(0, 20) });
    }

    // 随机一天：优先抽还没交换过的日子
    const pairs = await myPairs(openid);
    const used = new Set(
      pairs.filter((p) => p.status !== 'declined').flatMap((p) => p.dates || [])
    );
    const withOthers = pool.filter((d) => candidates.some((c) => c.overlap.includes(d)));
    const fresh = withOthers.filter((d) => !used.has(d));
    const bag = fresh.length ? fresh : withOthers.length ? withOthers : pool;
    const date = bag[Math.floor(Math.random() * bag.length)];
    const dayCandidates = candidates
      .filter((c) => c.overlap.includes(date))
      .map((c) => Object.assign({}, c, { overlap: [date] }));

    return ok({
      mode: 'random',
      date,
      total: candidates.length,
      candidates: dayCandidates.slice(0, 10),
    });
  }

  /* ---------------- 配对 ---------------- */

  if (method === 'POST' && key === 'pairs') {
    const toUserId = String((body && body.toUserId) || '');
    const toUser = await getUser(toUserId);
    if (!toUser || toUserId === openid) return fail(400, '找不到这位用户');

    const dates = (Array.isArray(body && body.dates) ? body.dates : [])
      .filter(isDate)
      .slice(0, 60);
    if (!dates.length) return fail(400, '请至少选择一个日子');

    const [mineRows, theirRows] = await Promise.all([
      fetchAll('photos', { userId: openid, date: _.in(dates) }, { date: true }),
      fetchAll('photos', { userId: toUserId, date: _.in(dates) }, { date: true }),
    ]);
    const mineSet = new Set(mineRows.map((p) => p.date));
    const theirSet = new Set(theirRows.map((p) => p.date));
    const shared = [...new Set(dates)].filter((d) => mineSet.has(d) && theirSet.has(d)).sort();
    if (!shared.length) return fail(400, '这些日子里没有你们共同的拍摄');

    const existing = await myPairs(openid);
    const dup = existing.find(
      (p) =>
        ((p.a === openid && p.b === toUserId) || (p.a === toUserId && p.b === openid)) &&
        p.status !== 'declined'
    );
    if (dup) {
      if (dup.status === 'accepted') return fail(409, '你们已经在交换中了', { pairId: dup._id });
      return fail(409, '已经发起过请求，正在等待回应', { pairId: dup._id });
    }

    const pair = {
      _id: newId('pair'),
      a: openid,
      b: toUserId,
      dates: shared,
      status: 'pending',
      revealed: { a: false, b: false },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const data = Object.assign({}, pair);
    delete data._id;
    await db.collection('pairs').add({ data: Object.assign({ _id: pair._id }, data) });

    return ok({ pair: summarize(pair, openid, toUser) });
  }

  if (method === 'GET' && key === 'pairs') {
    const pairs = await myPairs(openid);
    await tickDemo(pairs, await demoIdSet());

    const partnerIds = pairs.map((p) => (p.a === openid ? p.b : p.a));
    const users = await loadUsers(partnerIds);
    const list = pairs.map((p) =>
      summarize(p, openid, users[p.a === openid ? p.b : p.a])
    );

    return ok({
      incoming: list.filter((s) => s.status === 'pending' && !s.iAmInitiator),
      outgoing: list.filter((s) => s.status === 'pending' && s.iAmInitiator),
      rooms: list
        .filter((s) => s.status === 'accepted')
        .sort((a, b) => b.updatedAt - a.updatedAt),
    });
  }

  if (seg[0] === 'pairs' && seg[1]) {
    const pid = seg[1];
    let pair = null;
    try {
      pair = (await db.collection('pairs').doc(pid).get()).data;
    } catch (e) {
      pair = null;
    }
    if (!pair || (pair.a !== openid && pair.b !== openid)) {
      return fail(404, '没有找到这次交换');
    }

    if (method === 'POST' && seg[2] === 'respond') {
      if (pair.b !== openid) return fail(403, '这个请求不是发给你的');
      if (pair.status !== 'pending') return fail(400, '这个请求已经处理过了');
      const accept = !!(body && body.accept);
      const patch = {
        status: accept ? 'accepted' : 'declined',
        acceptedAt: Date.now(),
        updatedAt: Date.now(),
      };
      await db.collection('pairs').doc(pid).update({ data: patch });
      Object.assign(pair, patch);
      return ok({ pair: summarize(pair, openid, await getUser(pair.a)) });
    }

    if (method === 'POST' && seg[2] === 'reveal') {
      if (pair.status !== 'accepted') return fail(400, '对方还没有同意交换');
      const key2 = pair.a === openid ? 'a' : 'b';
      await db
        .collection('pairs')
        .doc(pid)
        .update({ data: { ['revealed.' + key2]: true, updatedAt: Date.now() } });
      pair.revealed = Object.assign({}, pair.revealed || {}, { [key2]: true });
      pair.updatedAt = Date.now();
      return ok({ pair: summarize(pair, openid, await getUser(pair.a === openid ? pair.b : pair.a)) });
    }

    // 轻量轮询：只回状态，不重复传照片
    if (method === 'GET' && seg[2] === 'state') {
      const demoSet = await demoIdSet();
      await tickDemo([pair], demoSet);
      const iAmA = pair.a === openid;
      return ok({
        pair: summarize(pair, openid, await getUser(iAmA ? pair.b : pair.a)),
        canSee: !!(pair.revealed && pair.revealed[iAmA ? 'a' : 'b'] && pair.revealed[iAmA ? 'b' : 'a']),
      });
    }

    if (method === 'GET') {
      await tickDemo([pair], await demoIdSet());
      const partnerId = pair.a === openid ? pair.b : pair.a;
      const partner = await getUser(partnerId);
      const iAmA = pair.a === openid;
      const mineOn = !!(pair.revealed && pair.revealed[iAmA ? 'a' : 'b']);
      const theirsOn = !!(pair.revealed && pair.revealed[iAmA ? 'b' : 'a']);
      const canSee = mineOn && theirsOn;

      const dates = pair.dates || [];
      const rows = await fetchAll('photos', {
        userId: _.in([openid, partnerId]),
        date: _.in(dates),
      });
      const mine = {};
      const theirs = {};
      for (const p of rows) {
        const bucket = p.userId === openid ? mine : theirs;
        (bucket[p.date] = bucket[p.date] || []).push(p);
      }
      const byTime = (x, y) => String(x.time || '').localeCompare(String(y.time || ''));

      const groups = dates.map((date) => ({
        date,
        mine: (mine[date] || []).sort(byTime).map(slim),
        theirs: canSee ? (theirs[date] || []).sort(byTime).map(slim) : null,
      }));

      return ok({
        pair: summarize(pair, openid, partner),
        canSee,
        groups,
      });
    }
  }

  if (method === 'POST' && key === 'reset') {
    await db.collection('photos').where({ userId: openid }).remove();
    await db.collection('pairs').where(_.or([{ a: openid }, { b: openid }])).remove();
    return ok({ ok: true, stats: await albumStats(openid) });
  }

  return fail(404, '接口不存在');
}

/* --------------------------------- 入口 ---------------------------------- */

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const method = String((event && event.method) || 'GET').toUpperCase();
  const path = String((event && event.path) || '/');
  const body = (event && event.body) || {};

  if (!OPENID && !path.includes('health')) {
    return fail(401, '拿不到微信身份，请在小程序里打开');
  }

  try {
    await ensureSeed();
    return await route(path, method, body, OPENID);
  } catch (err) {
    console.error('[api]', method, path, err && err.message);
    return fail(400, (err && err.message) || '服务开小差了');
  }
};
