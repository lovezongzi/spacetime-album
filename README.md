<p align="center">
  <img src="docs/icon/icon-192.png" width="104" alt="时空相册" />
</p>

<h1 align="center">时空相册 · Spacetime Album</h1>

<p align="center"><sub>在那些我们还不认识的日子里，我们看过同一片天。</sub></p>

一个很轻的实验：**两个陌生人，交换彼此在同一天拍下的照片。**

微信小程序端 + 网页版两个前端，共用一套 Node 服务端。

你授权自己相册里的照片，系统只读取每张照片的**拍摄日期**和**大致地点**。然后它随机抽一个日子 —— 或者由你指定一段时间 —— 去找那天也在按快门的人。匹配时看不到任何照片；只有双方都按下「展示」之后，那一天的照片才会互相可见。

灵感来自一次整理相册：一张风景照，出现在我们还没认识的时间里。原来在某年某天，她经历过这样的一天，见过这样一片火烧云 —— 那会不会，我们还没相识的时候，曾在同一时间对着同一片云按下快门？

<p align="center">
  <img src="docs/mp-login.png" width="150" />
  <img src="docs/mp-album.png" width="150" />
  <img src="docs/mp-match.png" width="150" />
  <img src="docs/mp-swap.png" width="150" />
</p>
<p align="center">
  <img src="docs/mp-pairs.png" width="150" />
  <img src="docs/mp-room.png" width="150" />
  <img src="docs/screen-album.png" width="150" />
</p>
<p align="center">
  <sub>微信小程序端 · 授权相册 → 随机一天 → 选日子 → 双方同意后交换那一天的照片<br/>（最后一图为同一套接口的网页版）</sub>
</p>

---

## 现在能做什么

| 环节 | 说明 |
| --- | --- |
| 授权相册 | 微信端 `wx.chooseMedia` 选图，手机上直接解析 EXIF，取拍摄时间 + GPS；网页端选若干张或整个文件夹 |
| 时光概览 | 按日子归拢照片，显示授权了多少张、多少个拍摄日、跨了多少年 |
| 随机一天 | 从你的相册里抽一个日子，列出那天也在拍照的人 |
| 指定时间 | 给定起止日期，找出所有重合的日子与候选人，按重合天数排序 |
| 发起交换 | 勾选要交换的日子（默认全选），发送请求 |
| 双方同意 | 对方接受后进入交换房间；两边各自「展示」，都展示完才互相可见 |
| 交换房间 | 按日子左右对照「你 / TA」，标注各自按快门的时刻 |
| 随时收回 | 单张取消授权，或一键清空全部授权（进行中的交换一并结束） |

演示账号会自动回应：发起请求约 4 秒后被接受，你按下展示约 9 秒后 TA 也按下展示 —— 一个人也能走完整条链路。

## 隐私设计

这是整个产品的底线，也是一切交互设计的前提：

1. **原图不出设备。** 照片在设备上（浏览器或手机）被压成 720px 的缩略图，只上传缩略图，原图始终留在本地。
2. **匹配只看元数据。** 匹配阶段比对的是「日期」和「坐标」，任何人（包括服务端）都不会把照片发给未确认的对方。
3. **双向确认后才能看。** 配对需要对方同意；展示需要双方各自按下按钮。任何一方不按，另一方永远看不到。
4. **可撤回。** 授权是逐张的，随时能删；清空授权即退出所有交换。
5. **匿名。** 不需要手机号，昵称就是身份，坐标只用于算距离，不在界面上显示原始经纬度。
6. **轮询不带照片。** 交换房间每 3 秒只问一次「对方按了没」，状态真的翻转时才去拉图 —— 一次 312 字节，而不是重传几百 KB。

## 技术结构

刻意做到**零依赖**：没有框架、没有构建步骤、`npm install` 都不用跑。同一套接口，两个前端。

```
.
├── server/
│   ├── index.js    # HTTP 服务 + 路由 + 匹配算法（Node 原生 http）
│   ├── db.js       # JSON 文件持久化（原子写 + 延迟落盘）
│   ├── seed.js     # 演示用户与「天空」示例图
│   └── util.js     # id / 哈希 / SVG 渐变天空
├── miniprogram/    # 微信小程序端（原生，无框架）
│   ├── app.js / app.json / app.wxss
│   ├── config.js   # 服务端地址（改这里切真机 / 线上）
│   ├── utils/
│   │   ├── exif.js   # 手写 EXIF 解析器，只读文件头 256KB
│   │   ├── photo.js  # 选图 → EXIF → 压缩 → base64 分批上传
│   │   ├── api.js    # wx.request 封装，401 自动回登录
│   │   └── ui.js     # 日期 / 距离 / 渐变格式化
│   └── pages/
│       ├── login/    # 起名字，wx.login + clientId 换 token
│       ├── album/    # 照片网格、导入、载入示例
│       ├── match/    # 随机一天 / 指定时间段 → 选日子
│       ├── pairs/    # 收到的请求 / 等待中 / 正在交换
│       └── room/     # 左右对照 + 双向展示
├── public/         # 网页版（同一套接口，浏览器直接打开）
│   ├── index.html
│   ├── app.js      # 原生 DOM，模板字符串渲染
│   ├── exif.js     # 与小程序端同源的解析逻辑
│   └── style.css   # 移动端优先，日落色系
└── data/db.json    # 运行时生成（已在 .gitignore 中）
```

### 匹配算法

- **日期集合**：`D(u) = { 用户 u 授权过的所有拍摄日 }`
- 重合日：`D(a) ∩ D(b)`
- **随机一天**：在「有人重合的日子」里抽，优先抽从未交换过的日子，避免重复
- **指定时间**：先按区间过滤 `D(a)`，再逐个用户求交集，按重合天数降序、距离升序排列
- **距离**：同一天里两人照片坐标的哈弗辛距离最小值，界面上化作「同一座城 / 相距 12 公里」

### 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | 昵称换 token（网页版，同名即同一身份） |
| POST | `/api/wx/login` | 小程序登录：`{code, clientId, name}`，配了 AppID 时用 code 换 openid |
| GET | `/api/me` | 当前用户与相册统计 |
| GET | `/api/health` | 健康检查（小程序启动时探活） |
| GET/POST | `/api/photos` | 列出 / 批量新增授权照片（只收日期、坐标、缩略图） |
| DELETE | `/api/photos/:id` | 取消单张授权 |
| POST | `/api/match` | `{mode:"random"}` 或 `{mode:"range",from,to}` |
| GET | `/api/pairs` | 收到的请求 / 发出的请求 / 进行中的交换 |
| POST | `/api/pairs` | 发起交换 `{toUserId, dates[]}` |
| POST | `/api/pairs/:id/respond` | 接受或婉拒 `{accept:true}` |
| POST | `/api/pairs/:id/reveal` | 展示自己的照片 |
| GET | `/api/pairs/:id/state` | 轮询专用：只有状态，没有照片（312 字节） |
| GET | `/api/pairs/:id` | 交换房间数据（未双向展示时对方照片为空） |
| POST | `/api/demo/sample` | 给当前用户载入一份示例相册 |

## 跑起来

### 1. 先起服务端

```bash
node server/index.js     # 默认 http://localhost:4173
```

需要 Node 18+。首次启动会自动写入 3 位演示用户（阿岚 / 程小满 / 江野），他们各自在西安、成都、华山拍过一些日子。

### 2. 微信小程序端

```
微信开发者工具 → 导入项目 → 目录选 miniprogram/ → AppID 选「测试号」
→ 详情 → 本地设置 → 勾选「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」
→ 编译
```

起个名字 → 「载入示例相册」→ 「遇见」→ 随机一天 → 交换 → 等 4 秒 → 进房间 → 按展示 → 等 9 秒，就能看到对面的那一天。

**真机预览**：把 `miniprogram/config.js` 里的 `BASE_URL` 改成电脑的局域网 IP（如 `http://192.168.1.20:4173`），手机和电脑连同一个 Wi-Fi，并在开发者工具点「预览」。

**正式发布**：换 HTTPS 域名，在小程序后台「开发 → 开发设置 → 服务器域名」加到 request 合法域名；想要真实微信身份（换手机也不丢相册），在服务端启动时给出 `WX_APPID` 和 `WX_SECRET`：

```bash
WX_APPID=wx... WX_SECRET=... node server/index.js
```

没配也能跑 —— 登录会退回用客户端生成的 `clientId` 作为稳定身份，只是换设备或重装会变成新用户。

### 3. 网页版

`http://localhost:4173` 直接打开就是同一套接口的浏览器版本，适合对比和调试。

## 网页版 → 小程序端，换掉了什么

| 能力 | 网页版 | 小程序端 |
| --- | --- | --- |
| 选照片 | `<input type="file" multiple>` | `wx.chooseMedia({ sizeType: ['original'] })` |
| 读 EXIF | `File.slice().arrayBuffer()` | `FileSystemManager.readFile({ position, length })` 只读前 256KB |
| 压缩 | `canvas.toBlob(jpeg, 0.72)` | `wx.compressImage({ compressedWidth: 720 })` |
| 上传 | `fetch` + JSON | `wx.request`，每批 3 张 |
| 登录 | 昵称 → token | `wx.login` 的 code → openid；没配 AppID 时用 `clientId` |
| 轮询 | `setInterval` + fetch | `setInterval` + 轻量 `/state`，状态翻转才拉图 |
| 示例图 | SVG data URL（浏览器能画） | 小程序 `<image>` 不认 SVG，改走 WXSS 渐变占位 |

最后一条是个小坑：服务端会在每张照片上带一个 `svg: true/false`，小程序据此决定渲染 `<image>` 还是渐变块。真实用户照片走 `<image>`，只有演示数据是 SVG。

## 路线图

- [ ] 「同一片天」：同一天 + 距离 < 50km 时给出更强的提示，甚至比对天空颜色
- [ ] 那天的天气/日落时间，作为交换房间的注脚
- [ ] 反向地理编码，把坐标变成「西安 · 曲江池」这样的地名
- [ ] 照片挪到对象存储，服务端不再存 base64（现在是 JSON 文件，超过几千张会撑）
- [ ] 服务端 EXIF 解析，兜住 HEIC 和没有 EXIF 的照片（现在直接跳过）
- [ ] 举报与内容审核（陌生人交换照片必须要有）
- [ ] 小程序订阅消息：对方接受 / 对方展示了，推一条

## License

MIT
