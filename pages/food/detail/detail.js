const foodStore = require('../../../utils/foodStore');

Page({
  data: {
    dish: null,
    isFav: false,
    isCustom: false
  },

  onLoad(options) {
    const id = options.id;
    const dish = foodStore.getDishById(id);
    if (!dish) {
      wx.showToast({ title: '菜品不存在', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1500);
      return;
    }
    this.setData({
      dish: dish,
      isFav: foodStore.isFavorite(id),
      isCustom: !!dish._isCustom
    });
  },

  onToggleFav() {
    const isNowFav = foodStore.toggleFavorite(this.data.dish.id);
    this.setData({ isFav: isNowFav });
    wx.showToast({
      title: isNowFav ? '已收藏 ♥' : '已取消收藏',
      icon: 'none'
    });
  },

  onRandomAnother() {
    const tags = this.data.dish.tags || [];
    const final = foodStore.randomPick(tags);
    if (!final) {
      wx.showToast({ title: '暂无更多同分类菜品', icon: 'none' });
      return;
    }
    foodStore.pushHistory(final.id);
    this.setData({
      dish: final,
      isFav: foodStore.isFavorite(final.id),
      isCustom: !!final._isCustom
    });
  },

  onEditCustom() {
    wx.navigateTo({ url: '/pages/food/custom/edit?id=' + this.data.dish.id });
  }
});
