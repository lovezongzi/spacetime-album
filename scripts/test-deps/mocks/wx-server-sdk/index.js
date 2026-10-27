'use strict';

/**
 * wx-server-sdk 的内存 mock —— 只实现云函数实际用到的那部分数据库语义。
 *
 * 目的：在真正上传到云开发之前，把整条业务链路（登录 / 载入示例 / 匹配 / 发起 /
 * 演示账号自动应答 / 双方展示 / 互相可见）在本地跑通，避免"上传完才发现字段名写错"。
 *
 * 只给测试用，不会被上传（在 scripts/test-deps 下，不在小程序项目里）。
 */

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

const state = {
  collections: {},
  openid: 'openid_test_A',
  seq: 1,
};

function coll(name) {
  if (!state.collections[name]) state.collections[name] = [];
  return state.collections[name];
}

const _ = {
  in: (v) => ({ __op: 'in', v }),
  neq: (v) => ({ __op: 'neq', v }),
  eq: (v) => ({ __op: 'eq', v }),
  or: (v) => ({ __op: 'or', v }),
  and: (v) => ({ __op: 'and', v }),
  gt: (v) => ({ __op: 'gt', v }),
  lt: (v) => ({ __op: 'lt', v }),
};

function matchDoc(doc, cond) {
  if (!cond) return true;
  if (cond.__op === 'or') return cond.v.some((c) => matchDoc(doc, c));
  if (cond.__op === 'and') return cond.v.every((c) => matchDoc(doc, c));
  return Object.keys(cond).every((key) => {
    const want = cond[key];
    const actual = doc[key];
    if (want && want.__op) {
      switch (want.__op) {
        case 'in':
          return want.v.some((x) => x === actual);
        case 'neq':
          return want.v !== actual;
        case 'eq':
          return want.v === actual;
        case 'gt':
          return actual > want.v;
        case 'lt':
          return actual < want.v;
        default:
          return false;
      }
    }
    return actual === want;
  });
}

function project(doc, field) {
  if (!field) return clone(doc);
  const out = { _id: doc._id };
  for (const key of Object.keys(field)) {
    if (field[key]) out[key] = clone(doc[key]);
  }
  return out;
}

function applyUpdate(doc, data) {
  for (const key of Object.keys(data)) {
    const parts = key.split('.');
    let target = doc;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (typeof target[p] !== 'object' || target[p] === null) target[p] = {};
      target = target[p];
    }
    target[parts[parts.length - 1]] = data[key];
  }
}

class Doc {
  constructor(name, id) {
    this.name = name;
    this.id = id;
  }

  async get() {
    const d = coll(this.name).find((x) => x._id === this.id);
    if (!d) {
      const e = new Error('document.get:fail document does not exist');
      e.errCode = -1;
      throw e;
    }
    return { data: clone(d) };
  }

  async set({ data }) {
    const arr = coll(this.name);
    const i = arr.findIndex((x) => x._id === this.id);
    const doc = Object.assign({}, clone(data), { _id: this.id });
    if (i >= 0) arr[i] = doc;
    else arr.push(doc);
    return { stats: { updated: 1 } };
  }

  async update({ data }) {
    const arr = coll(this.name);
    const i = arr.findIndex((x) => x._id === this.id);
    if (i < 0) return { stats: { updated: 0 } };
    applyUpdate(arr[i], clone(data));
    return { stats: { updated: 1 } };
  }

  async remove() {
    const arr = coll(this.name);
    const i = arr.findIndex((x) => x._id === this.id);
    if (i >= 0) arr.splice(i, 1);
    return { stats: { removed: i >= 0 ? 1 : 0 } };
  }
}

class Query {
  constructor(name) {
    this.name = name;
    this.cond = null;
    this.opts = {};
  }

  where(cond) {
    this.cond = cond;
    return this;
  }

  field(f) {
    this.opts.field = f;
    return this;
  }

  skip(n) {
    this.opts.skip = n;
    return this;
  }

  limit(n) {
    this.opts.limit = n;
    return this;
  }

  orderBy(key, dir) {
    this.opts.orderBy = { key, dir: dir || 'asc' };
    return this;
  }

  doc(id) {
    return new Doc(this.name, id);
  }

  async get() {
    let list = coll(this.name).filter((d) => matchDoc(d, this.cond));
    if (this.opts.orderBy) {
      const { key, dir } = this.opts.orderBy;
      list = list.slice().sort((a, b) => {
        const x = a[key];
        const y = b[key];
        if (x === y) return 0;
        return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
      });
    }
    const skip = this.opts.skip || 0;
    const limit = this.opts.limit == null ? 20 : this.opts.limit;
    return { data: list.slice(skip, skip + limit).map((d) => project(d, this.opts.field)) };
  }

  async count() {
    return { total: coll(this.name).filter((d) => matchDoc(d, this.cond)).length };
  }

  async add({ data }) {
    const doc = clone(data);
    if (!doc._id) doc._id = 'gen_' + state.seq++ + '_' + Math.random().toString(36).slice(2, 6);
    coll(this.name).push(doc);
    return { _id: doc._id };
  }

  async remove() {
    const arr = coll(this.name);
    const keep = [];
    let removed = 0;
    for (const d of arr) {
      if (matchDoc(d, this.cond)) removed += 1;
      else keep.push(d);
    }
    state.collections[this.name] = keep;
    return { stats: { removed } };
  }
}

const db = {
  command: _,
  collection: (name) => new Query(name),
  createCollection: async (name) => {
    coll(name);
    return { errMsg: 'createCollection:ok' };
  },
  serverDate: () => new Date(),
};

const cloud = {
  DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
  init() {},
  database: () => db,
  getWXContext: () => ({ OPENID: state.openid, APPID: 'wxmock', UNIONID: '' }),
  __mock: {
    state,
    coll,
    setOpenid(id) {
      state.openid = id;
    },
    dump(name) {
      return clone(coll(name));
    },
    reset() {
      state.collections = {};
      state.seq = 1;
    },
  },
};

module.exports = cloud;
