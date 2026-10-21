/**
 * 请求封装：自动带 token、统一错误文案、401 自动回登录页。
 */
const { BASE_URL } = require('../config');

function raw(path, { method = 'GET', data, auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const app = getApp();
    const header = { 'content-type': 'application/json' };
    if (auth && app && app.globalData.token) header['x-token'] = app.globalData.token;

    wx.request({
      url: BASE_URL + path,
      method,
      data,
      header,
      timeout: 25000,
      success(res) {
        const body = res.data || {};
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(body);
        const err = new Error(body.error || `请求失败 (${res.statusCode})`);
        err.statusCode = res.statusCode;
        err.body = body;
        reject(err);
      },
      fail(e) {
        const msg = /timeout/i.test(e.errMsg || '')
          ? '网络有点慢，稍后再试'
          : '连不上服务器，检查一下电脑上的服务有没有开';
        reject(new Error(msg));
      },
    });
  });
}

/** 401 时清掉本地登录态并回登录页 */
function guard(fn) {
  return (...args) =>
    fn(...args).catch((err) => {
      if (err.statusCode === 401) {
        const app = getApp();
        if (app) app.logout();
        wx.reLaunch({ url: '/pages/login/index' });
      }
      throw err;
    });
}

module.exports = {
  get: guard((path) => raw(path)),
  post: guard((path, data) => raw(path, { method: 'POST', data })),
  del: guard((path) => raw(path, { method: 'DELETE' })),
  raw,
};
