const api = require('../../utils/api');
const { pickImages, buildPhotos } = require('../../utils/photo');
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

    let paths = [];
    try {
      paths = await pickImages(9);
    } catch (e) {
      toast(e.message);
      return;
    }
    if (!paths.length) return;

    this.setData({ importing: true });
    try {
      const { ok, skipped } = await buildPhotos(paths, (done, total) => {
        if (done < total) {
          wx.showLoading({ title: `读取 ${done + 1}/${total}`, mask: true });
        }
      });

      if (!ok.length) {
        wx.hideLoading();
        wx.showModal({
          title: '没读到拍摄时间',
          content: '这些照片里没有 EXIF 拍摄信息，可能是截图或经过转发的图片。试试原图，或者先载入示例相册看看效果。',
          showCancel: false,
          confirmText: '知道了',
        });
        return;
      }

      let added = 0;
      let stats = null;
      for (let i = 0; i < ok.length; i += BATCH) {
        const batch = ok.slice(i, i + BATCH);
        const upto = Math.min(i + BATCH, ok.length);
        wx.showLoading({ title: `上传 ${upto}/${ok.length}`, mask: true });
        const r = await api.post('/api/photos', { photos: batch });
        added += r.added || 0;
        stats = r.stats || stats;
      }
      wx.hideLoading();

      if (stats) getApp().patchStats(stats);
      await this.load();

      const skipCount = skipped.noExif + skipped.tooBig + skipped.failed;
      const parts = [`导入 ${added} 张`];
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
  };
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
