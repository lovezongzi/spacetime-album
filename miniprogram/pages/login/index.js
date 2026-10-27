const api = require('../../utils/api');

Page({
  data: { name: '', loading: false },

  onLoad() {
    const app = getApp();
    if (app && app.globalData.token) {
      wx.reLaunch({ url: '/pages/album/index' });
    }
  },

  onName(e) {
    this.setData({ name: e.detail.value });
  },

  async enter() {
    const name = String(this.data.name || '').trim();
    if (!name) {
      wx.showToast({ title: '先给自己起个名字', icon: 'none' });
      return;
    }
    if (this.data.loading) return;

    this.setData({ loading: true });
    try {
      // 云开发下身份由云函数直接取 openid，不需要先把 code 换成 openid，
      // 所以这里只是把昵称提交上去。
      const d = await api.raw('/api/wx/login', {
        method: 'POST',
        data: { name, clientId: getApp().globalData.clientId },
      });

      getApp().persist(d);
      wx.reLaunch({ url: '/pages/album/index' });
    } catch (e) {
      wx.showToast({ title: e.message || '进入失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },
});
