'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const EMPTY = { users: [], photos: [], pairs: [], seededAt: null };

let db = null;
let timer = null;

function load() {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    db = JSON.parse(JSON.stringify(EMPTY));
  }
  db.users ||= [];
  db.photos ||= [];
  db.pairs ||= [];
  return db;
}

function flush() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

/** 延迟落盘，避免批量导入时反复写文件 */
function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      flush();
    } catch (err) {
      console.error('[db] 保存失败', err);
    }
  }, 80);
}

function saveNow() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  flush();
}

module.exports = { load, save, saveNow, DB_FILE, DATA_DIR };
