/**
 * 服务端地址。
 *
 * 当前指向 Cloudflare 临时隧道（本机 Node 服务对外暴露的 https 地址）。
 * 这个地址在隧道进程重启后会变，变了就回来改这一行。
 * 重新拿地址：./scripts/tunnel.sh
 *
 * 三种场景：
 * - 开发者工具调试：用 http://127.0.0.1:4173 最快（工具里勾「不校验合法域名」即可）
 * - 真机 / 体验版：必须用下面的 https 地址，且手机端要打开「开发调试」开关
 * - 正式发布：换成备案域名，并在小程序后台「开发设置 → 服务器域名」加进 request 合法域名
 */
const BASE_URL = 'https://gerald-joined-builders-recorders.trycloudflare.com';

module.exports = { BASE_URL };
