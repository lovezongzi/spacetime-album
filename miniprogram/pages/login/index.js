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
      // 有配置 AppID 时，这个 code 会在服务端换成 openid；没有就是空字符串，
      // 服务端会退回用本地生成的 clientId 作为稳定身份。
      const code = await new Promise((resolve) => {
        wx.login({
          success: (r) => resolve(r.code || ''),
          fail: () => resolve(''),
        });
      });

      const d = await api.raw('/api/wx/login', {
        method: 'POST',
        auth: false,
        data: { name, code, clientId: getApp().globalData.clientId },
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
