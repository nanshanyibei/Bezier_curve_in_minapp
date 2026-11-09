const diaryStore = require('../../../utils/diaryStore');
const travelStore = require('../../../utils/travelStore');

Page({
  data: {
    version: '1.0.0'
  },

  /** 一键清除本机全部数据 */
  onClearAll() {
    wx.showModal({
      title: '清除全部数据',
      content: '将删除本机保存的全部日记与旅行标记，操作不可恢复。',
      confirmText: '确认清除',
      confirmColor: '#ef7d7d',
      success: (res) => {
        if (!res.confirm) return;
        wx.removeStorageSync(diaryStore.KEY);
        wx.removeStorageSync(travelStore.KEY);
        wx.showToast({ title: '已清除', icon: 'success' });
      }
    });
  }
});
