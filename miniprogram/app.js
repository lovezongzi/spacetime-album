const { CLOUD_ENV } = require('./config');

App({
  globalData: {
    // 云开发下不再是真 token，只用来表示「已登录」；身份由云函数从 openid 取
    token: '',
    user: null,
    stats: null,
    clientId: '',
    bound: true,
    cloudReady: false,
  },

  onLaunch() {
    this.initCloud();

    const token = wx.getStorageSync('sa_token') || '';
    const user = wx.getStorageSync('sa_user') || null;
    const stats = wx.getStorageSync('sa_stats') || null;

    let clientId = wx.getStorageSync('sa_client');
    if (!clientId) {
      clientId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      wx.setStorageSync('sa_client', clientId);
    }

    Object.assign(this.globalData, { token, user, stats, clientId });
  },

  initCloud() {
    if (!wx.cloud) {
      this.globalData.cloudReady = false;
      console.error('[cloud] 基础库过低，不支持云开发（需要 2.2.3+）');
      return;
    }
    try {
      wx.cloud.init(
        CLOUD_ENV
          ? { env: CLOUD_ENV, traceUser: true }
          : { traceUser: true }
      );
      this.globalData.cloudReady = true;
    } catch (e) {
      this.globalData.cloudReady = false;
      console.error('[cloud] 初始化失败', e);
    }
  },

  /** 登录成功后统一落盘 */
  persist(payload) {
    const g = this.globalData;
    if (payload.token) {
      g.token = payload.token;
      wx.setStorageSync('sa_token', payload.token);
    }
    if (payload.user) {
      g.user = payload.user;
      wx.setStorageSync('sa_user', payload.user);
    }
    if (payload.stats) {
      g.stats = payload.stats;
      wx.setStorageSync('sa_stats', payload.stats);
    }
    if (typeof payload.bound === 'boolean') {
      g.bound = payload.bound;
      wx.setStorageSync('sa_bound', payload.bound);
    }
  },

  patchStats(stats) {
    if (!stats) return;
    this.globalData.stats = stats;
    wx.setStorageSync('sa_stats', stats);
  },

  logout() {
    this.globalData.token = '';
    this.globalData.user = null;
    this.globalData.stats = null;
    wx.removeStorageSync('sa_token');
    wx.removeStorageSync('sa_user');
    wx.removeStorageSync('sa_stats');
  },
});
