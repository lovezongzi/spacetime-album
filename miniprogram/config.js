/**
 * 服务端地址。
 *
 * 当前指向 Cloudflare 临时隧道（本机 Node 服务对外暴露的 https 地址）。
 * 这个地址会变：隧道进程重启会变，被 Cloudflare 回收也会变（实测活不过几天）。
 * 判断是否还活着别用 pgrep，直接 curl 一下 /api/health。
 * 改了地址必须重新上传一次，手机上才会生效。
 *
 * 三种场景：
 * - 开发者工具调试：用 http://127.0.0.1:4173 最快（工具里勾「不校验合法域名」即可）
 * - 真机 / 体验版：必须用下面的 https 地址，且手机端要打开「开发调试」开关
 * - 正式发布：换成备案域名，并在小程序后台「开发设置 → 服务器域名」加进 request 合法域名
 */
const BASE_URL = 'https://drawing-molecular-trustees-municipal.trycloudflare.com';

module.exports = { BASE_URL };
