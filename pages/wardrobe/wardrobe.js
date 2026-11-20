const wardrobeStore = require('../../utils/wardrobeStore');
const cb = require('../../utils/cb');

const CATEGORY_MAP = {};
wardrobeStore.CATEGORIES.forEach(function (c) { CATEGORY_MAP[c.key] = c; });
const SEASON_MAP = {};
wardrobeStore.SEASONS.forEach(function (s) { SEASON_MAP[s.key] = s; });

const ANY = 'any'; // 筛选「全部」：与季节 all（四季）区分开

Page({
  data: {
    categoryChips: [{ key: ANY, label: '全部' }].concat(
      wardrobeStore.CATEGORIES.map(function (c) { return { key: c.key, label: c.label }; })
    ),
    seasonChips: [{ key: ANY, label: '全部' }].concat(
      wardrobeStore.SEASONS.map(function (s) { return { key: s.key, label: s.label }; })
    ),
    filterCategory: ANY,
    filterSeason: ANY,
    items: [],
    stats: { total: 0, cats: 0 },
    loading: true
  },

  onLoad() {
    this.render();
  },

  onShow() {
    // 从编辑页返回要看到最新内容（首次 onShow 紧接 onLoad，跳过避免重复渲染）
    if (this._shown) this.render();
    this._shown = true;
    this.pullCloud();
  },

  /** 拉云端并合并，有变化再刷一次 */
  pullCloud() {
    wardrobeStore.pullCloud().then((r) => {
      if (r && r.changed) this.render();
    }).catch(() => { /* 离线就用本地 */ });
  },

  render() {
    const fc = this.data.filterCategory;
    const fs = this.data.filterSeason;
    const items = wardrobeStore.list()
      .filter(function (e) {
        if (fc !== ANY && e.category !== fc) return false;
        if (fs !== ANY && e.season !== fs) return false;
        return true;
      })
      .map(function (e) {
        const cat = CATEGORY_MAP[e.category] || CATEGORY_MAP.top;
        const sea = SEASON_MAP[e.season] || SEASON_MAP.all;
        return {
          id: e.id,
          name: e.name,
          emoji: cat.emoji,
          categoryLabel: cat.label,
          seasonLabel: sea.label,
          color: e.color,
          display: (e.photo && e.photo.local) || '',
          fileID: (e.photo && e.photo.fileID) || ''
        };
      });

    const s = wardrobeStore.stats();
    let cats = 0;
    Object.keys(s.byCategory).forEach(function (k) { if (s.byCategory[k]) cats++; });

    this.setData({
      items: items,
      stats: { total: s.total, cats: cats },
      loading: false
    });
    this.fillRemoteUrls();
  },

  /** 本机没有图、只有 fileID 的，分批换临时链接 */
  fillRemoteUrls() {
    const need = [];
    this.data.items.forEach(function (it) {
      if (!it.display && it.fileID && need.indexOf(it.fileID) < 0) need.push(it.fileID);
    });
    if (!need.length) return;

    const chunks = [];
    for (let i = 0; i < need.length; i += 20) chunks.push(need.slice(i, i + 20));

    let chain = Promise.resolve();
    chunks.forEach((chunk) => {
      chain = chain.then(() => cb.getFileUrls(chunk)).then((map) => {
        if (!map || !Object.keys(map).length) return;
        const items = this.data.items.map(function (it) {
          if (it.display || !map[it.fileID]) return it;
          return Object.assign({}, it, { display: map[it.fileID] });
        });
        this.setData({ items: items });
      });
    });
    chain.catch(() => { /* 换链接失败就保持占位 */ });
  },

  onFilterCategory(e) {
    const k = e.currentTarget.dataset.k;
    if (!k || k === this.data.filterCategory) return;
    this.setData({ filterCategory: k }, () => this.render());
  },

  onFilterSeason(e) {
    const k = e.currentTarget.dataset.k;
    if (!k || k === this.data.filterSeason) return;
    this.setData({ filterSeason: k }, () => this.render());
  },

  onAdd() {
    wx.navigateTo({ url: '/pages/wardrobe/edit/edit' });
  },

  onEdit(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/wardrobe/edit/edit?id=' + encodeURIComponent(id) });
  },

  onDelete(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.showModal({
      title: '删除衣物',
      content: '照片和记录都会删掉，无法恢复。',
      confirmText: '删除',
      confirmColor: '#ef7d7d',
      success: (r) => {
        if (!r.confirm) return;
        wardrobeStore.remove(id);
        wx.showToast({ title: '已删除', icon: 'none' });
        this.render();
      }
    });
  }
});
