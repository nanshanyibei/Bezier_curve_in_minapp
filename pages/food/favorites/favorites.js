const foodStore = require('../../../utils/foodStore');

Page({
  data: {
    list: []
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    this.setData({ list: foodStore.getFavorites() });
  },

  onTap(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/food/detail/detail?id=' + id });
  },

  onRemove(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '取消收藏？',
      content: '将从收藏列表移除',
      success: (res) => {
        if (res.confirm) {
          foodStore.toggleFavorite(id);
          this.refresh();
        }
      }
    });
  },

  onGoRandom() {
    wx.navigateBack();
  }
});
