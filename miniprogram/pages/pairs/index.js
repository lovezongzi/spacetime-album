const api = require('../../utils/api');
const { gradOf, shortDate } = require('../../utils/ui');

const POLL_MS = 3500;

Page({
  data: {
    incoming: [],
    outgoing: [],
    rooms: [],
    empty: true,
    loading: true,
  },

  onShow() {
    const app = getApp();
    if (!app.globalData.token) {
      wx.reLaunch({ url: '/pages/login/index' });
      return;
    }
    this.load();
    this.startPoll();
  },

  onHide() {
    this.stopPoll();
  },

  onUnload() {
    this.stopPoll();
  },

  startPoll() {
    this.stopPoll();
    this._timer = setInterval(() => this.load(true), POLL_MS);
  },

  stopPoll() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  },

  async load(silent) {
    if (this._busy) return;
    this._busy = true;
    try {
      const d = await api.get('/api/pairs');
      const incoming = (d.incoming || []).map(decorate);
      const outgoing = (d.outgoing || []).map(decorate);
      const rooms = (d.rooms || []).map(decorate);
      this.setData({
        incoming,
        outgoing,
        rooms,
        empty: !incoming.length && !outgoing.length && !rooms.length,
        loading: false,
      });
    } catch (e) {
      if (!silent) toast(e.message);
      this.setData({ loading: false });
    } finally {
      this._busy = false;
    }
  },

  async accept(e) {
    const id = e.currentTarget.dataset.id;
    try {
      await api.post(`/api/pairs/${id}/respond`, { accept: true });
      wx.showToast({ title: '已同意', icon: 'success' });
      await this.load(true);
      setTimeout(() => wx.navigateTo({ url: `/pages/room/index?id=${id}` }), 600);
    } catch (err) {
      toast(err.message);
    }
  },

  decline(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '婉拒这次交换？',
      content: '对方会知道你没有接受，照片不会互相展示。',
      confirmText: '婉拒',
      confirmColor: '#c0503a',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await api.post(`/api/pairs/${id}/respond`, { accept: false });
          await this.load(true);
        } catch (err) {
          toast(err.message);
        }
      },
    });
  },

  openRoom(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/room/index?id=${id}` });
  },

  goMatch() {
    wx.switchTab({ url: '/pages/match/index' });
  },
});

/* ------------------------------ 辅助 ------------------------------ */

function decorate(s) {
  return {
    ...s,
    initial: (s.partner.name || '·').slice(0, 1),
    grad: gradOf(s.partner.id),
    datesLabel: datesLabel(s.dates || []),
    stateLabel: s.canSee ? '已可查看' : s.mine ? '等 TA 展示' : '去展示我的一天',
  };
}

function datesLabel(ds) {
  if (!ds.length) return '';
  if (ds.length === 1) return `${shortDate(ds[0])} 这一天`;
  if (ds.length === 2) return `${shortDate(ds[0])}、${shortDate(ds[1])}`;
  return `共 ${ds.length} 天 · ${shortDate(ds[0])} 起`;
}

function toast(title) {
  wx.showToast({ title: String(title).slice(0, 24), icon: 'none', duration: 2200 });
}
