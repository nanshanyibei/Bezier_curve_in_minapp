const foodStore = require('../../utils/foodStore');

Page({
  data: {
    allTags: [],
    activeTags: [],
    currentDish: null,
    pool: [],
    picking: false,
    favCount: 0,
    historyCount: 0,
    customCount: 0,
    totalCount: 0,
    ready: false
  },

  _timer: null,

  onShow() {
    foodStore.ready().then(() => {
      this.refresh();
    });
  },

  onHide() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  },

  refresh() {
    const s = foodStore.stats();
    const tags = foodStore.getAllTags();
    const pool = foodStore.getDishesByTags(this.data.activeTags);
    this.setData({
      allTags: tags,
      pool: pool,
      favCount: s.favoriteCount,
      historyCount: s.historyCount,
      customCount: s.customCount,
      totalCount: s.total,
      ready: true
    });
  },

  onToggleTag(e) {
    const tag = e.currentTarget.dataset.tag;
    const active = this.data.activeTags.slice();
    const idx = active.indexOf(tag);
    if (idx >= 0) active.splice(idx, 1);
    else active.push(tag);
    const pool = foodStore.getDishesByTags(active);
    this.setData({ activeTags: active, pool: pool });
  },

  onClearTags() {
    this.setData({ activeTags: [], pool: foodStore.getAllDishes() });
  },

  onRetry() {
    foodStore.ready().then(() => {
      this.refresh();
      if (this.data.pool.length) {
        wx.showToast({ title: '已加载 ' + this.data.pool.length + ' 道菜', icon: 'none' });
      } else {
        wx.showToast({ title: '仍没有数据，请检查云端 foods 集合', icon: 'none' });
      }
    });
  },

  onRandomTap() {
    if (this.data.picking || !this.data.pool.length) return;

    const final = foodStore.randomPick(this.data.activeTags);
    if (!final) {
      wx.showToast({ title: '该分类暂无菜品', icon: 'none' });
      return;
    }

    this.setData({ picking: true });
    let count = 0;
    const pool = this.data.pool;
    if (!pool.length) return;

    this._timer = setInterval(() => {
      const temp = pool[Math.floor(Math.random() * pool.length)];
      this.setData({ currentDish: temp });
      if (++count >= 12) {
        clearInterval(this._timer);
        this._timer = null;
        this.setData({ currentDish: final, picking: false });
      }
    }, 160);
  },

  onAccept() {
    if (!this.data.currentDish) return;
    foodStore.pushHistory(this.data.currentDish.id);
    const s = foodStore.stats();
    this.setData({ historyCount: s.historyCount });
    wx.showToast({ title: '就它了 ✓', icon: 'none' });
  },

  onOpenDetail() {
    if (!this.data.currentDish) return;
    wx.navigateTo({ url: '/pages/food/detail/detail?id=' + this.data.currentDish.id });
  },

  onOpenFavorites() {
    wx.navigateTo({ url: '/pages/food/favorites/favorites' });
  },

  onOpenHistory() {
    wx.navigateTo({ url: '/pages/food/history/history' });
  },

  onOpenCustom() {
    wx.navigateTo({ url: '/pages/food/custom/edit' });
  }
});
