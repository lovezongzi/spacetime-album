const api = require('../../utils/api');
const {
  pickImages,
  pickLiveVideos,
  buildPhotos,
  matchVideos,
  attachVideos,
  clean,
} = require('../../utils/photo');
const { gradOf, prettyDate, shortDate, hash } = require('../../utils/ui');

const BATCH = 3;

Page({
  data: {
    user: null,
    stats: { photos: 0, dates: 0, firstDate: null, lastDate: null },
    photos: [],
    initial: '·',
    selfGrad: 0,
    spanLabel: '',
    loading: true,
    importing: false,
    busy: false,
    detail: null,
  },

  onShow() {
    const app = getApp();
    if (!app.globalData.token) {
      wx.reLaunch({ url: '/pages/login/index' });
      return;
    }
    if (this.data.importing) return;
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    const app = getApp();
    try {
      const d = await api.get('/api/photos');
      app.patchStats(d.stats);
      this.setData({
        user: app.globalData.user,
        initial: (app.globalData.user && app.globalData.user.name || '·').slice(0, 1),
        selfGrad: gradOf(app.globalData.user ? app.globalData.user.id : 'x'),
        stats: d.stats,
        photos: (d.photos || []).map(decorate).sort(byDateDesc),
        spanLabel: span(d.stats),
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false });
      toast(e.message);
    }
  },

  /* ------------------------------ 导入 ------------------------------ */

  async importPhotos() {
    if (this.data.importing || this.data.busy) return;

    let picked = [];
    try {
      picked = await pickImages(9);
    } catch (e) {
      toast(e.message);
      return;
    }
    if (!picked.length) return;

    this.setData({ importing: true });
    try {
      const { ok, skipped, lives } = await buildPhotos(picked, (done, total, note) => {
        if (done < total) {
          wx.showLoading({ title: `${note || '读取'} ${done + 1}/${total}`, mask: true });
        }
      });

      if (!ok.length) {
        wx.hideLoading();
        wx.showModal({
          title: '没读到拍摄时间',
          content:
            '截图、微信转发的图片、以及部分修图 App 保存的图片会把拍摄信息（EXIF）抹掉，没有它就没法按「那一天」匹配。\n试试从相册里选相机原图（iPhone 的 HEIC、安卓的 JPG/HEIC 都支持），或者先载入示例相册看看效果。',
          showCancel: false,
          confirmText: '知道了',
        });
        return;
      }

      // 实况照片：微信只给封面，动态部分要单独补选
      let liveGain = 0;
      if (lives.length) {
        wx.hideLoading();
        const want = await ask(
          `检测到 ${lives.length} 张实况照片`,
          '微信只把封面图给了小程序，动态那 3 秒要单独选一次。\niPhone 的实况在相册「视频」里通常找不到，可以先用「以文件发送」把它发给文件传输助手，会拆成 HEIC + MOV 两个文件，再从小程序里选那个 MOV —— 程序会按实况标识自动对上，顺序乱了也没关系。\n跳过也可以，封面照常参与匹配。',
          '补选视频',
          '先用封面'
        );
        if (want) {
          const vids = await pickLiveVideos(lives.length).catch(() => []);
          if (vids.length) {
            const { matched } = await matchVideos(vids, lives);
            if (matched) {
              wx.showLoading({ title: '上传动态…', mask: true });
              await attachVideos(lives);
              liveGain = matched;
            } else {
              toast('这些视频没能和实况对上');
            }
          }
        }
      }

      let added = 0;
      let stats = null;
      let motion = 0;
      const payload = clean(ok);
      for (let i = 0; i < payload.length; i += BATCH) {
        const batch = payload.slice(i, i + BATCH);
        const upto = Math.min(i + BATCH, payload.length);
        wx.showLoading({ title: `上传 ${upto}/${payload.length}`, mask: true });
        const r = await api.post('/api/photos', { photos: batch });
        added += r.added || 0;
        motion += r.motion || 0;
        stats = r.stats || stats;
      }
      wx.hideLoading();

      if (stats) getApp().patchStats(stats);
      await this.load();

      const parts = [`导入 ${added} 张`];
      if (motion) parts.push(`${motion} 张带动态`);
      else if (liveGain) parts.push(`${liveGain} 张实况已配好`);
      if (skipped.noExif) parts.push(`${skipped.noExif} 张无拍摄时间`);
      if (skipped.tooBig) parts.push(`${skipped.tooBig} 张过大`);
      if (skipped.failed) parts.push(`${skipped.failed} 张读取失败`);
      setTimeout(() => toast(parts.join('，')), 220);
    } catch (e) {
      wx.hideLoading();
      toast(e.message);
    } finally {
      this.setData({ importing: false });
    }
  },

  async loadSample() {
    if (this.data.importing || this.data.busy) return;
    this.setData({ busy: true });
    try {
      wx.showLoading({ title: '铺开示例相册', mask: true });
      const d = await api.post('/api/demo/sample', {});
      wx.hideLoading();
      getApp().patchStats(d.stats);
      await this.load();
      toast('已载入 6 个日子，去「遇见」看看');
    } catch (e) {
      wx.hideLoading();
      toast(e.message);
    } finally {
      this.setData({ busy: false });
    }
  },

  /* ------------------------------ 单张操作 ------------------------------ */

  openPhoto(e) {
    const id = e.currentTarget.dataset.id;
    const p = this.data.photos.find((x) => x.id === id);
    if (p) this.setData({ detail: p });
  },

  closeDetail() {
    this.setData({ detail: null });
  },

  async removePhoto() {
    const d = this.data.detail;
    if (!d) return;
    wx.showModal({
      title: '移除这张照片？',
      content: `${prettyDate(d.date)} 的这张照片会从你的相册里删掉，之后就不能用它匹配了。`,
      confirmText: '移除',
      confirmColor: '#c0503a',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          const res = await api.del(`/api/photos/${d.id}`);
          getApp().patchStats(res.stats);
          this.setData({ detail: null });
          await this.load();
        } catch (err) {
          toast(err.message);
        }
      },
    });
  },
});

/* ------------------------------ 辅助 ------------------------------ */

function decorate(p) {
  const h = hash(p.id);
  return {
    ...p,
    pretty: prettyDate(p.date),
    dayLabel: shortDate(p.date),
    grad: gradOf(p.id),
    sunX: 22 + (h % 48),
    sunY: 16 + ((h >> 4) % 34),
    hasGeo: typeof p.lat === 'number' && typeof p.lng === 'number',
    hasMotion: !!p.motion,
  };
}

function ask(title, content, confirmText, cancelText) {
  return new Promise((resolve) => {
    wx.showModal({
      title,
      content,
      confirmText: confirmText || '好',
      cancelText: cancelText || '取消',
      confirmColor: '#c96b3f',
      success: (r) => resolve(!!r.confirm),
      fail: () => resolve(false),
    });
  });
}

function byDateDesc(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return (b.time || '').localeCompare(a.time || '');
}

function span(stats) {
  if (!stats || !stats.firstDate) return '';
  const f = stats.firstDate;
  const l = stats.lastDate;
  const fmt = (d) => `${d.slice(0, 4)}.${d.slice(5, 7)}`;
  return f === l ? fmt(f) : `${fmt(f)} — ${fmt(l)}`;
}

function toast(title) {
  wx.showToast({ title: String(title).slice(0, 24), icon: 'none', duration: 2200 });
}
