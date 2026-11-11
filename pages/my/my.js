const diaryStore = require('../../utils/diaryStore');
const travelStore = require('../../utils/travelStore');
const cb = require('../../utils/cb');

const VERSION = '1.0.0';

Page({
  data: {
    diaryCount: 0,
    diaryChars: 0,
    visitedCount: 0,
    syncText: '正在连接…',
    syncOk: false,
    version: VERSION
  },

  onShow() {
    this.refresh();
    this.refreshSync();
    // 启动同步（登录 + 云端回灌）可能晚于本页渲染，完成后补刷一次
    const p = getApp() && getApp().globalData && getApp().globalData.syncPromise;
    if (p) p.then(() => { this.refresh(); this.refreshSync(); });
  },

  refresh() {
    const d = diaryStore.stats();
    const t = travelStore.stats();
    this.setData({
      diaryCount: d.count,
      diaryChars: d.chars,
      visitedCount: t.visited
    });
  },

  /** 云端登录态展示：已登录 = 数据跟微信走，删小程序也能找回 */
  refreshSync() {
    cb.ready().then(() => {
      const info = cb.getLoginInfo();
      let text = '未登录，数据仅保存在本机';
      if (info.logged) text = '已同步到云端，换手机也能找回';
      else if (info.mode === 'anonymous') text = '云端降级模式，数据跟着本机走';
      else if (info.mode === 'offline') text = '离线模式，数据仅保存在本机';
      this.setData({ syncText: text, syncOk: !!info.logged });
    }).catch(() => {
      this.setData({ syncText: '离线模式，数据仅保存在本机', syncOk: false });
    });
  },

  /* @dev:begin */
  onAiAssistant() {
    wx.navigateTo({ url: '/pages/assistant/assistant' });
  },

  onPoster() {
    wx.navigateTo({ url: '/pages/index/index' });
  },
  /* @dev:end */

  onPrivacy() {
    wx.navigateTo({ url: '/pages/my/privacy/privacy' });
  },

  onAbout() {
    wx.showModal({
      title: '关于',
      content: '南山工作台 v' + VERSION + '\n\n日记与旅行标记会同步到云端，并以微信身份标识。删除小程序或换手机后，重新进入即可自动认回数据。',
      showCancel: false,
      confirmText: '知道了'
    });
  }
});
