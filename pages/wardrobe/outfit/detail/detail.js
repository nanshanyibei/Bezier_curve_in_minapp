/**
 * 搭配详情页
 * 展示搭配图、名称、时间与衣物清单；删除只影响这条搭配。
 */
const outfitStore = require('../../../../utils/outfitStore');
const wardrobeStore = require('../../../../utils/wardrobeStore');
const cb = require('../../../../utils/cb');

const CATEGORY_MAP = {};
wardrobeStore.CATEGORIES.forEach(function (c) { CATEGORY_MAP[c.key] = c; });

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function formatTime(ts) {
  const d = new Date(ts || Date.now());
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function unlinkQuiet(filePath) {
  if (!filePath || filePath.indexOf(wx.env.USER_DATA_PATH) !== 0) return;
  try { wx.getFileSystemManager().unlinkSync(filePath); } catch (e) { /* ignore */ }
}

Page({
  data: {
    id: '',
    name: '',
    image: '',
    items: [],
    dateText: ''
  },

  onLoad(options) {
    const id = options && options.id;
    if (!id) {
      wx.showToast({ title: '搭配不存在', icon: 'none' });
      setTimeout(() => { wx.navigateBack({ delta: 1 }); }, 300);
      return;
    }
    const outfit = outfitStore.get(id);
    if (!outfit) {
      wx.showToast({ title: '搭配不存在', icon: 'none' });
      setTimeout(() => { wx.navigateBack({ delta: 1 }); }, 300);
      return;
    }
    this._outfit = outfit;
    const items = outfit.items.map(function (it) {
      const cat = CATEGORY_MAP[it.category] || CATEGORY_MAP.top;
      return {
        id: it.id,
        name: it.name,
        emoji: cat.emoji,
        categoryLabel: cat.label,
        exists: !!wardrobeStore.get(it.id)
      };
    });
    this.setData({
      id: outfit.id,
      name: outfit.name,
      image: (outfit.image && outfit.image.local) || '',
      items: items,
      dateText: formatTime(outfit.createdAt)
    });
    this.fillRemote();
  },

  fillRemote() {
    const img = this._outfit && this._outfit.image;
    if (!img || this.data.image || !img.fileID) return;
    cb.getFileUrls([img.fileID]).then((map) => {
      if (!map || !map[img.fileID]) return;
      this.setData({ image: map[img.fileID] });
    });
  },

  onPreview() {
    if (!this.data.image) return;
    wx.previewImage({ current: this.data.image, urls: [this.data.image] });
  },

  onDelete() {
    const outfit = this._outfit;
    if (!outfit) return;
    wx.showModal({
      title: '删除搭配',
      content: '只删除这套搭配，衣物不会受影响。',
      confirmText: '删除',
      confirmColor: '#ef7d7d',
      success: (r) => {
        if (!r.confirm) return;
        outfitStore.remove(outfit.id);
        if (outfit.image && outfit.image.local) unlinkQuiet(outfit.image.local);
        wx.showToast({ title: '已删除', icon: 'none' });
        setTimeout(() => { wx.navigateBack({ delta: 1 }); }, 300);
      }
    });
  }
});
