/**
 * 运行配置。
 *
 * 后端已经从「自己搭的 Node 服务 + 公网隧道」换成了「微信云开发」。
 *
 * 为什么换：小程序真机 / 体验版会强制校验 request 合法域名，域名必须已完成 ICP 备案。
 * Cloudflare 临时隧道的域名不是我们的、备不了案、也没法在域名根目录放校验文件，
 * 所以它永远进不了白名单 —— 体验版在手机上必然「连不上服务器」。
 * 云开发的 wx.cloud.callFunction 走微信内部通道，不经过域名校验。
 *
 * CLOUD_ENV 留空表示使用账号下的「默认环境」（通常只有一个环境，够用）。
 * 如果有多个环境，把它填成环境 ID，例如 'spacetime-8g0abcde12345678'。
 */
const CLOUD_ENV = 'sit-d3gjwf9ba4e469265';

/** 云函数名（cloudfunctions/api） */
const CLOUD_FN = 'api';

/**
 * 旧的 HTTP 服务地址，仅 Web 版（public/）本地演示时用得到，小程序端已不再使用。
 */
const BASE_URL = 'https://drawing-molecular-trustees-municipal.trycloudflare.com';

module.exports = { CLOUD_ENV, CLOUD_FN, BASE_URL };
