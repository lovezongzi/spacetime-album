const api = require('../../utils/api');
const { gradOf, shortDate, weekOf, distLabel, today } = require('../../utils/ui');

Page({
  data: {
    mode: 'random',
    hasPhotos: true,
    loading: false,
    loaded: false,
    random: {},
    list: [],
    from: '',
    to: '',
    today: today(),
    sheet: null,
    sending: false,
  },

  onShow() {
    const app = getApp();
    if (!app.globalData.token) {
      wx.reLaunch({ url: '/pages/login/index' });
      return;
    }

    const stats = app.globalData.stats || {};
    const hasPhotos = (stats.photos || 0) > 0;
    this.setData({ hasPhotos });

    // 第一次进来直接抽一天，省掉一次点击
    if (hasPhotos && !this._drawn && this.data.mode === 'random') {
      this._drawn = true;
      this.draw();
    }
  },

  setMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.mode) return;
    this.setData({ mode, list: [] });
    if (mode === 'random' && !this._drawn && this.data.hasPhotos) {
      this._drawn = true;
      this.draw();
    }
  },

  goAlbum() {
    wx.switchTab({ url: '/pages/album/index' });
  },

  async draw() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const d = await api.post('/api/match', { mode: 'random' });
      const list = (d.candidates || []).map(decorate);
      this.setData({
        random: {
          date: d.date,
          monthDay: shortDate(d.date),
          year: d.date.slice(0, 4),
          week: weekOf(d.date),
          count: list.length,
        },
        list,
        loaded: true,
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false });
      if (/没有照片/.test(e.message)) {
        this.setData({ hasPhotos: false, list: [] });
      } else {
        toast(e.message);
      }
    }
  },

  onFrom(e) {
    this.setData({ from: e.detail.value });
  },

  onTo(e) {
    this.setData({ to: e.detail.value });
  },

  async searchRange() {
    if (this.data.loading) return;
    if (this.data.from && this.data.to && this.data.from > this.data.to) {
      toast('开始日期晚于结束日期');
      return;
    }
    this.setData({ loading: true });
    try {
      const d = await api.post('/api/match', {
        mode: 'range',
        from: this.data.from,
        to: this.data.to,
      });
      const list = (d.candidates || []).map(decorate);
      this.setData({ list, loaded: true, loading: false });
      if (!list.length) toast('这段时间里没有重合的日子');
    } catch (e) {
      this.setData({ loading: false });
      toast(e.message);
    }
  },

  /* ------------------------------ 选日子 ------------------------------ */

  startSwap(e) {
    const { uid, name, dates } = e.currentTarget.dataset;
    const items = String(dates || '')
      .split(',')
      .filter(Boolean)
      .map((d) => ({ date: d, label: shortDate(d), on: true }));

    this.setData({
      sheet: { uid, name, dates: items, picked: items.length },
    });
  },

  toggleDate(e) {
    const date = e.currentTarget.dataset.date;
    const sheet = this.data.sheet;
    if (!sheet) return;
    const dates = sheet.dates.map((d) => (d.date === date ? { ...d, on: !d.on } : d));
    this.setData({
      'sheet.dates': dates,
      'sheet.picked': dates.filter((d) => d.on).length,
    });
  },

  closeSheet() {
    if (this.data.sending) return;
    this.setData({ sheet: null });
  },

  async sendSwap() {
    const sheet = this.data.sheet;
    if (!sheet || this.data.sending) return;
    const dates = sheet.dates.filter((d) => d.on).map((d) => d.date);
    if (!dates.length) {
      toast('至少选一天');
      return;
    }

    this.setData({ sending: true });
    try {
      await api.post('/api/pairs', { toUserId: sheet.uid, dates });
      this.setData({ sending: false, sheet: null });
      wx.showToast({ title: '请求已发出', icon: 'success' });
      setTimeout(() => wx.switchTab({ url: '/pages/pairs/index' }), 720);
    } catch (e) {
      this.setData({ sending: false });
      if (e.statusCode === 409) {
        this.setData({ sheet: null });
        wx.showToast({ title: e.message, icon: 'none' });
        setTimeout(() => wx.switchTab({ url: '/pages/pairs/index' }), 900);
      } else {
        toast(e.message);
      }
    }
  },
});

/* ------------------------------ 辅助 ------------------------------ */

function decorate(c) {
  const bits = [];
  bits.push(c.overlap.length === 1 ? '同一天' : `${c.overlap.length} 个日子重合`);
  if (c.distanceKm != null) {
    bits.push(distLabel(c.distanceKm));
  } else if (c.overlap.length === 1) {
    bits.push(shortDate(c.overlap[0]));
  }

  return {
    key: c.user.id,
    user: c.user,
    initial: (c.user.name || '·').slice(0, 1),
    grad: gradOf(c.user.id),
    overlapStr: c.overlap.join(','),
    meta: bits.join(' · '),
  };
}

function toast(title) {
  wx.showToast({ title: String(title).slice(0, 24), icon: 'none', duration: 2200 });
}
