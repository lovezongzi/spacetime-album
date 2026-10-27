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

    const app = getApp();
    if (app && app.globalData.cloudReady === false) {
      reject(new Error('云开发没初始化成功，检查 app.js 里的 wx.cloud.init'));
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
        // 原始错误一定要打出来，否则只能看到"连不上"这种没信息量的话
        console.error(`[cloud] ${method} ${path} 调用失败：`, msg);

        let text = '云服务连不上，稍后再试';
        if (/-501000|no cloud|cloud environment|env.*not.*exist|TcbError/i.test(msg)) {
          text = '云环境还没开通：公众平台 → 开发 → 云开发 → 建一个环境';
        } else if (/FunctionName|-501005|FUNCTION_NOT_FOUND|not found/i.test(msg)) {
          text = '云函数 api 还没部署：右键 cloudfunctions/api → 上传并部署';
        } else if (/env|environment|envId|CLOUD_ENV/i.test(msg)) {
          text = '云开发环境没选对：核对 config.js 里的 CLOUD_ENV';
        } else if (/timeout/i.test(msg)) {
          text = '云函数响应太慢，稍后再试';
        }

        const err = new Error(text);
        err.raw = msg;
        reject(err);
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
