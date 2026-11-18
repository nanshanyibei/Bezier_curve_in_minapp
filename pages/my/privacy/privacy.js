const travelStore = require('../../../utils/travelStore');
const diaryStore = require('../../../utils/diaryStore');
const cb = require('../../../utils/cb');

// 对话记录本地缓存键（与 assistant 页保持一致）
const CHAT_KEYS = ['chat.messages', 'chat.updatedAt'];

Page({
  data: {
    version: '1.0.0'
  },

  /** 清除数据：区分「本机缓存」和「云端数据」两档 */
  onClearAll() {
    wx.showActionSheet({
      itemList: ['清除本机缓存（云端保留）', '删除云端数据（彻底删除）'],
      success: (res) => {
        if (res.tapIndex === 0) this.clearLocal();
        else if (res.tapIndex === 1) this.clearCloud();
      }
    });
  },

  clearLocal() {
    wx.showModal({
      title: '清除本机缓存',
      content: '只删除本机保存的内容。云端数据保留，下次打开会自动同步回来。',
      confirmText: '清除',
      confirmColor: '#ef7d7d',
      success: (res) => {
        if (!res.confirm) return;
        wx.removeStorageSync(diaryStore.KEY);
        wx.removeStorageSync(travelStore.KEY);
        CHAT_KEYS.forEach((k) => wx.removeStorageSync(k));
        wx.showToast({ title: '已清除本机缓存', icon: 'success' });
      }
    });
  },

  clearCloud() {
    wx.showModal({
      title: '删除云端数据',
      content: '将永久删除云端保存的全部日记、旅行标记与对话记录，无法恢复。',
      confirmText: '全部删除',
      confirmColor: '#ef7d7d',
      success: (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '正在删除' });
        Promise.all([
          cb.clearCollection('diaries'),
          cb.clearCollection('marks'),
          cb.clearCollection('chats')
        ]).then((r) => {
          wx.hideLoading();
          const failed = r.some((n) => n < 0);
          // 云端删干净了才清本地，避免本地没了云端还在
          if (!failed) {
            wx.removeStorageSync(diaryStore.KEY);
            wx.removeStorageSync(travelStore.KEY);
            CHAT_KEYS.forEach((k) => wx.removeStorageSync(k));
          }
          wx.showToast({
            title: failed ? '部分删除失败，请检查网络' : '已删除云端数据',
            icon: failed ? 'none' : 'success'
          });
        }).catch(() => {
          wx.hideLoading();
          wx.showToast({ title: '删除失败，请检查网络', icon: 'none' });
        });
      }
    });
  }
});
