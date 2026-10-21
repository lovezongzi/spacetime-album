const api = require('../../utils/api');
const { gradOf, prettyDate, weekOf, hash } = require('../../utils/ui');

const POLL_MS = 3000;

Page({
  data: {
    id: '',
    pair: null,
    groups: [],
    spanLabel: '',
    revealing: false,
  },

  onLoad(query) {
    const id = (query && query.id) || '';
    if (!id) {
      wx.navigateBack();
      return;
    }
    this.setData({ id });
    this.load();
  },

  onShow() {
    if (this.data.id) {
      this.load(true);
      this.startPoll();
    }
  },

  onHide() {
    this.stopPoll();
  },

  onUnload() {
    this.stopPoll();
  },

  startPoll() {
    this.stopPoll();
    this._timer = setInterval(() => this.poll(), POLL_MS);
  },

  stopPoll() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  },

  /**
   * 轮询只查状态（几个字段），只有「对方也展示了」这种状态翻转时，
   * 才去拉带照片的完整数据，避免每 3 秒重传一遍 base64。
   */
  async poll() {
    if (this._busy || this._polling) return;
    this._polling = true;
    try {
      const d = await api.get(`/api/pairs/${this.data.id}/state`);
      const cur = this.data.pair;
      const changed =
        !cur ||
        d.canSee !== cur.canSee ||
        d.pair.mine !== cur.mine ||
        d.pair.theirs !== cur.theirs ||
        d.pair.status !== cur.status;
      if (changed) await this.load(true);
    } catch (e) {
      /* 轮询失败静默，下次再试 */
    } finally {
      this._polling = false;
    }
  },

  async load(silent) {
    if (this._busy) return;
    this._busy = true;
    try {
      const d = await api.get(`/api/pairs/${this.data.id}`);
      const pair = d.pair;
      if (pair && pair.partner) {
        wx.setNavigationBarTitle({ title: pair.partner.name });
      }
      this.setData({
        pair,
        groups: (d.groups || []).map(decorateGroup),
        spanLabel: span(pair && pair.dates),
      });
    } catch (e) {
      if (!silent) toast(e.message);
    } finally {
      this._busy = false;
    }
  },

  async reveal() {
    if (this.data.revealing) return;
    this.setData({ revealing: true });
    try {
      await api.post(`/api/pairs/${this.data.id}/reveal`, {});
      await this.load(true);
      wx.vibrateShort({ type: 'light', fail: () => {} });
      wx.showToast({ title: '已展示', icon: 'success', duration: 1200 });
    } catch (e) {
      toast(e.message);
    } finally {
      this.setData({ revealing: false });
    }
  },
});

/* ------------------------------ 辅助 ------------------------------ */

function decorateGroup(g) {
  return {
    date: g.date,
    pretty: prettyDate(g.date),
    week: weekOf(g.date),
    mine: (g.mine || []).map(decoratePhoto),
    theirs: (g.theirs || []).map(decoratePhoto),
    canSee: !!g.theirs,
  };
}

function decoratePhoto(p) {
  const h = hash(p.id);
  return {
    ...p,
    grad: gradOf(p.id),
    sunX: 22 + (h % 48),
    sunY: 16 + ((h >> 4) % 34),
  };
}

function span(dates) {
  if (!dates || !dates.length) return '';
  const sorted = [...dates].sort();
  const f = sorted[0];
  const l = sorted[sorted.length - 1];
  const fmt = (d) => `${d.slice(0, 4)}.${d.slice(5, 7)}`;
  const range = f === l ? fmt(f) : `${fmt(f)} — ${fmt(l)}`;
  return `${range} · ${sorted.length} 天`;
}

function toast(title) {
  wx.showToast({ title: String(title).slice(0, 24), icon: 'none', duration: 2200 });
}
