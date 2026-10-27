/**
 * 请求封装：走云函数，自动解包 {code, data}，统一错误文案，401 自动回登录页。
 *
 * 页面里的调用方式完全没变（api.get('/api/photos')），只是底层从 wx.request 换成了
 * wx.cloud.callFunction —— 这也是为什么真机不会再被域名白名单拦住。
 */
const { CLOUD_FN } = require('../config');

function raw(path, { method = 'GET', data } = {}) {
  return new Promise((resolve, reject) => {
    if (!wx.cloud) {
      reject(new Error('基础库版本过低，请把开发者工具的调试基础库调到 2.2.3 以上'));
      return;
    }

    wx.cloud.callFunction({
      name: CLOUD_FN,
      data: { path, method, body: data || {} },
      success(res) {
        const r = res.result || {};
        const code = typeof r.code === 'number' ? r.code : 500;
        const body = r.data || {};

        if (code >= 200 && code < 300) return resolve(body);

        const err = new Error(body.error || `请求失败 (${code})`);
        err.statusCode = code;
        err.body = body;
        reject(err);
      },
      fail(e) {
        const msg = e.errMsg || '';
        let text = '云服务连不上，稍后再试';
        if (/FunctionName|FUNCTION_NOT_FOUND|-501000|not found/i.test(msg)) {
          text = '云函数 api 还没部署：开发者工具里右键 cloudfunctions/api → 上传并部署';
        } else if (/env|environment|envId/i.test(msg)) {
          text = '云开发环境没选对：在开发者工具「云开发」面板里确认环境，再核对 config.js';
        } else if (/timeout/i.test(msg)) {
          text = '云函数响应太慢，稍后再试';
        }
        reject(new Error(text));
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
