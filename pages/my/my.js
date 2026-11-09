const diaryStore = require('../../utils/diaryStore');
const travelStore = require('../../utils/travelStore');

const VERSION = '1.0.0';

Page({
  data: {
    diaryCount: 0,
    diaryChars: 0,
    visitedCount: 0,
    version: VERSION
  },

  onShow() {
    const d = diaryStore.stats();
    const t = travelStore.stats();
    this.setData({
      diaryCount: d.count,
      diaryChars: d.chars,
      visitedCount: t.visited
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
      content: '南山工作台 v' + VERSION + '\n\n日记与旅行记录全部保存在本机，不上传任何服务器。',
      showCancel: false,
      confirmText: '知道了'
    });
  }
});
