'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { load, save, saveNow } = require('./db');
const { uid } = require('./util');
const { seedDemo, sampleForUser } = require('./seed');

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const db = load();
if (!db.users.length) {
  seedDemo(db);
  saveNow();
  console.log('[db] 已写入 3 位演示用户');
}

/* ---------------------------------- 工具 ---------------------------------- */

function send(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 40 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function userByToken(req) {
  const token = req.headers['x-token'];
  if (!token) return null;
  return db.users.find((u) => u.token === token) || null;
}

function photoCount(userId) {
  return db.photos.reduce((n, p) => (p.userId === userId ? n + 1 : n), 0);
}

function myDates(userId) {
  const set = new Set();
  for (const p of db.photos) if (p.userId === userId) set.add(p.date);
  return set;
}

function photosOf(userId, date) {
  return db.photos
    .filter((p) => p.userId === userId && (!date || p.date === date))
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
}

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
  return Math.round((2 * R * Math.asin(Math.sqrt(s))) * 10) / 10;
}

function minDistance(userA, userB, dates) {
  let best = null;
  for (const date of dates) {
    const pa = photosOf(userA, date);
    const pb = photosOf(userB, date);
    for (const x of pa) {
      for (const y of pb) {
        const d = haversine(x, y);
        if (d != null && (best === null || d < best)) best = d;
      }
    }
  }
  return best;
}

function publicUser(u) {
  return { id: u.id, name: u.name, demo: !!u.demo };
}

function pairOf(id) {
  return db.pairs.find((p) => p.id === id) || null;
}

function partnerOf(pair, userId) {
  const otherId = pair.a === userId ? pair.b : pair.a;
  return db.users.find((u) => u.id === otherId) || { id: otherId, name: '已离开的用户' };
}

/** 演示账号：自动接受请求 / 自动点亮展示，让单人也能走完整个流程 */
function tickDemo() {
  const now = Date.now();
  for (const pair of db.pairs) {
    const partner = partnerOf(pair, pair.a);
    const partnerIsDemo = db.users.find((u) => u.id === partner.id)?.demo;
    if (!partnerIsDemo) continue;
    const other = pair.a;
    const otherIsDemo = db.users.find((u) => u.id === other)?.demo;
    if (otherIsDemo) continue;

    if (pair.status === 'pending' && now - pair.createdAt > 4000) {
      pair.status = 'accepted';
      pair.acceptedAt = now;
      save();
    }
    if (pair.status === 'accepted') {
      // 真人一定是 a：等真人按下展示后，演示账号过几秒也「按下展示」
      if (
        pair.revealed.a &&
        !pair.revealed.b &&
        now - (pair.acceptedAt || pair.createdAt) > 9000
      ) {
        pair.revealed.b = true;
        save();
      }
    }
  }
}

function summarizePair(pair, userId) {
  const partner = partnerOf(pair, userId);
  const iAmA = pair.a === userId;
  const mine = !!pair.revealed[iAmA ? 'a' : 'b'];
  const theirs = !!pair.revealed[iAmA ? 'b' : 'a'];
  return {
    id: pair.id,
    partner: publicUser(partner),
    dates: pair.dates,
    status: pair.status,
    mine,
    theirs,
    canSee: mine && theirs,
    iAmInitiator: iAmA,
    createdAt: pair.createdAt,
    updatedAt: pair.updatedAt || pair.createdAt,
  };
}

/* --------------------------------- API 处理 -------------------------------- */

async function handleApi(req, res, url) {
  const seg = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const method = req.method;
  const route = seg.join('/');

  // 登录 / 注册：昵称即身份，返回 token
  if (method === 'POST' && route === 'login') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 16);
    if (!name) return send(res, 400, { error: '请先给自己起个名字' });
    let user = db.users.find((u) => !u.demo && u.name === name);
    if (!user) {
      user = { id: uid('u'), name, token: uid('t'), createdAt: Date.now() };
      db.users.push(user);
      save();
    }
    return send(res, 200, {
      token: user.token,
      user: publicUser(user),
      stats: albumStats(user.id),
    });
  }

  const me = userByToken(req);
  if (!me) return send(res, 401, { error: '登录状态已失效，请重新进入' });

  if (method === 'GET' && route === 'me') {
    return send(res, 200, { user: publicUser(me), stats: albumStats(me.id) });
  }

  if (method === 'GET' && route === 'photos') {
    return send(res, 200, { photos: photosOf(me.id), stats: albumStats(me.id) });
  }

  if (method === 'POST' && route === 'photos') {
    const body = await readBody(req);
    const list = Array.isArray(body.photos) ? body.photos.slice(0, 300) : [];
    const added = [];
    for (const raw of list) {
      const date = String(raw.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const thumb = typeof raw.thumb === 'string' ? raw.thumb.slice(0, 900000) : '';
      if (!thumb.startsWith('data:image/')) continue;
      const photo = {
        id: uid('ph'),
        userId: me.id,
        date,
        time: /^\d{2}:\d{2}$/.test(raw.time || '') ? raw.time : '',
        place: String(raw.place || '').slice(0, 40),
        lat: typeof raw.lat === 'number' ? raw.lat : null,
        lng: typeof raw.lng === 'number' ? raw.lng : null,
        thumb,
        approx: !!raw.approx,
        source: 'user',
        createdAt: Date.now(),
      };
      db.photos.push(photo);
      added.push(photo);
    }
    save();
    return send(res, 200, { added: added.length, stats: albumStats(me.id) });
  }

  if (method === 'DELETE' && seg[0] === 'photos' && seg[1]) {
    const idx = db.photos.findIndex((p) => p.id === seg[1] && p.userId === me.id);
    if (idx < 0) return send(res, 404, { error: '照片不存在' });
    db.photos.splice(idx, 1);
    save();
    return send(res, 200, { ok: true, stats: albumStats(me.id) });
  }

  // 载入示例相册（演示用）
  if (method === 'POST' && route === 'demo/sample') {
    const created = sampleForUser(db, me.id);
    save();
    return send(res, 200, { added: created.length, stats: albumStats(me.id) });
  }

  // 匹配：随机一天 / 指定时间段
  if (method === 'POST' && route === 'match') {
    const body = await readBody(req);
    const mine = myDates(me.id);
    if (!mine.size) return send(res, 400, { error: '你的相册里还没有照片' });

    let pool = [...mine].sort();
    if (body.mode === 'range') {
      const from = String(body.from || '');
      const to = String(body.to || '');
      pool = pool.filter((d) => (!from || d >= from) && (!to || d <= to));
      if (!pool.length) return send(res, 400, { error: '这个时间段里没有你的照片' });
    }

    const others = db.users.filter((u) => u.id !== me.id && photoCount(u.id) > 0);
    let candidates = [];
    for (const other of others) {
      const theirs = myDates(other.id);
      const overlap = pool.filter((d) => theirs.has(d));
      if (!overlap.length) continue;
      candidates.push({
        user: publicUser(other),
        overlap,
        distanceKm: minDistance(me.id, other.id, overlap),
        theirPhotoCount: overlap.reduce((n, d) => n + photosOf(other.id, d).length, 0),
        near: overlap.filter((d) => {
          const dk = minDistance(me.id, other.id, [d]);
          return dk != null && dk <= 80;
        }).length,
      });
    }
    candidates.sort((a, b) => {
      if (b.overlap.length !== a.overlap.length) return b.overlap.length - a.overlap.length;
      return (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9);
    });

    if (body.mode === 'range') {
      const sharedDates = [...new Set(candidates.flatMap((c) => c.overlap))].sort();
      return send(res, 200, { mode: 'range', dates: sharedDates, candidates: candidates.slice(0, 20) });
    }

    // 随机一天：优先从未交换过的日子里抽，其次是任意一天
    const usedDates = new Set(
      db.pairs
        .filter((p) => (p.a === me.id || p.b === me.id) && p.status !== 'declined')
        .flatMap((p) => p.dates)
    );
    const withOthers = pool.filter((d) => candidates.some((c) => c.overlap.includes(d)));
    const fresh = withOthers.filter((d) => !usedDates.has(d));
    const bag = fresh.length ? fresh : withOthers.length ? withOthers : pool;
    const date = bag[Math.floor(Math.random() * bag.length)];
    const dayCandidates = candidates
      .filter((c) => c.overlap.includes(date))
      .map((c) => ({ ...c, overlap: [date] }));

    return send(res, 200, {
      mode: 'random',
      date,
      total: candidates.length,
      candidates: dayCandidates.slice(0, 10),
    });
  }

  // 配对
  if (method === 'POST' && route === 'pairs') {
    const body = await readBody(req);
    const toUser = db.users.find((u) => u.id === body.toUserId);
    if (!toUser || toUser.id === me.id) return send(res, 400, { error: '找不到这位用户' });
    const dates = (Array.isArray(body.dates) ? body.dates : [])
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)))
      .slice(0, 60);
    if (!dates.length) return send(res, 400, { error: '请至少选择一个日子' });

    // 只保留双方都真的拍过照片的日子
    const mineSet = myDates(me.id);
    const theirSet = myDates(toUser.id);
    const shared = [...new Set(dates)].filter((d) => mineSet.has(d) && theirSet.has(d)).sort();
    if (!shared.length) return send(res, 400, { error: '这些日子里没有你们共同的拍摄' });

    const dup = db.pairs.find(
      (p) =>
        ((p.a === me.id && p.b === toUser.id) || (p.a === toUser.id && p.b === me.id)) &&
        p.status !== 'declined'
    );
    if (dup) {
      if (dup.status === 'accepted') return send(res, 409, { error: '你们已经在交换中了', pairId: dup.id });
      return send(res, 409, { error: '已经发起过请求，正在等待回应', pairId: dup.id });
    }

    const pair = {
      id: uid('pair'),
      a: me.id,
      b: toUser.id,
      dates: shared,
      status: 'pending',
      revealed: { a: false, b: false },
      createdAt: Date.now(),
    };
    db.pairs.push(pair);
    save();
    return send(res, 200, { pair: summarizePair(pair, me.id) });
  }

  if (method === 'GET' && route === 'pairs') {
    tickDemo();
    const mine = db.pairs.filter((p) => p.a === me.id || p.b === me.id);
    const summaries = mine.map((p) => summarizePair(p, me.id));
    return send(res, 200, {
      incoming: summaries.filter((s) => s.status === 'pending' && !s.iAmInitiator),
      outgoing: summaries.filter((s) => s.status === 'pending' && s.iAmInitiator),
      rooms: summaries
        .filter((s) => s.status === 'accepted')
        .sort((a, b) => b.updatedAt - a.updatedAt),
    });
  }

  if (seg[0] === 'pairs' && seg[1]) {
    const pair = pairOf(seg[1]);
    if (!pair || (pair.a !== me.id && pair.b !== me.id)) {
      return send(res, 404, { error: '没有找到这次交换' });
    }

    if (method === 'POST' && seg[2] === 'respond') {
      const body = await readBody(req);
      if (pair.b !== me.id) return send(res, 403, { error: '这个请求不是发给你的' });
      if (pair.status !== 'pending') return send(res, 400, { error: '这个请求已经处理过了' });
      pair.status = body.accept ? 'accepted' : 'declined';
      pair.acceptedAt = Date.now();
      pair.updatedAt = Date.now();
      save();
      return send(res, 200, { pair: summarizePair(pair, me.id) });
    }

    if (method === 'POST' && seg[2] === 'reveal') {
      if (pair.status !== 'accepted') return send(res, 400, { error: '对方还没有同意交换' });
      pair.revealed[pair.a === me.id ? 'a' : 'b'] = true;
      pair.updatedAt = Date.now();
      save();
      return send(res, 200, { pair: summarizePair(pair, me.id) });
    }

    if (method === 'GET') {
      tickDemo();
      const iAmA = pair.a === me.id;
      const partner = partnerOf(pair, me.id);
      const mineRevealed = pair.revealed[iAmA ? 'a' : 'b'];
      const theirsRevealed = pair.revealed[iAmA ? 'b' : 'a'];
      const canSee = mineRevealed && theirsRevealed;
      const groups = pair.dates.map((date) => ({
        date,
        mine: photosOf(me.id, date).map(slim),
        theirs: canSee ? photosOf(partner.id, date).map(slim) : null,
      }));
      return send(res, 200, {
        pair: summarizePair(pair, me.id),
        canSee,
        groups,
      });
    }
  }

  if (method === 'POST' && route === 'reset') {
    db.photos = db.photos.filter((p) => p.userId !== me.id);
    db.pairs = db.pairs.filter((p) => p.a !== me.id && p.b !== me.id);
    save();
    return send(res, 200, { ok: true, stats: albumStats(me.id) });
  }

  return send(res, 404, { error: '接口不存在' });
}

function slim(p) {
  return {
    id: p.id,
    date: p.date,
    time: p.time,
    place: p.place,
    lat: p.lat,
    lng: p.lng,
    thumb: p.thumb,
  };
}

function albumStats(userId) {
  const dates = myDates(userId);
  const sorted = [...dates].sort();
  return {
    photos: photoCount(userId),
    dates: dates.size,
    firstDate: sorted[0] || null,
    lastDate: sorted[sorted.length - 1] || null,
  };
}

/* -------------------------------- 静态文件 -------------------------------- */

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) res.writeHead(404).end('not found');
        else {
          res.writeHead(200, { 'content-type': MIME['.html'] });
          res.end(html);
        }
      });
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(full)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (err) {
      console.error('[api]', err.message);
      if (!res.headersSent) send(res, 400, { error: err.message });
    }
    return;
  }
  serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log(`时空相册 running → http://localhost:${PORT}`);
});
