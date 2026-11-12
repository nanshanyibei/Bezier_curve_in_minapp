/**
 * 城市回忆册
 * 路由：pages/travel/memory/memory?adcode=330100&name=杭州&plan=1
 *
 * 一城多条，按旅行日期倒序。图片展示优先级：本地永久路径 > 云端临时链接。
 * 换了设备本地没有图时，才异步向云端批量换链接。
 */
const memoryStore = require('../../../utils/memoryStore');
const cb = require('../../../utils/cb');

/** 2026-11-12 → { month: '11', day: '12', year: '2026', weekday: '周四' } */
function splitDate(date) {
  const parts = String(date || '').split('-');
  const y = parts[0] || '';
  const m = parts[1] || '';
  const d = parts[2] || '';
  let weekday = '';
  try {
    const dt = new Date(Number(y), Number(m) - 1, Number(d));
    weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dt.getDay()] || '';
  } catch (e) { /* ignore */ }
  return { year: y, month: m, day: d, weekday: weekday };
}

Page({
  data: {
    adcode: '',
    cityName: '',
    plan: false,
    items: [],
    stats: { count: 0, photos: 0 },
    loading: true
  },

  onLoad(options) {
    this.setData({
      adcode: String(options.adcode || ''),
      cityName: decodeURIComponent(options.name || '') || '回忆',
      plan: options.plan === '1'
    });
    wx.setNavigationBarTitle({ title: this.data.cityName + '的回忆' });
    // 先渲染本地，云端合并有新内容再刷一次（换设备首屏不至于长时间空白）
    this.render();
    memoryStore.pullCloud().then((r) => {
      if (r && r.changed) this.render();
    }).catch(() => { /* 离线就用本地 */ });
  },

  onShow() {
    // 从编辑页返回要看到最新内容（首次 onShow 紧接 onLoad，跳过避免重复渲染）
    if (this._shown) this.render();
    this._shown = true;
  },

  render() {
    const list = memoryStore.listByCity(this.data.adcode);
    const items = list.map((e) => {
      const d = splitDate(e.date);
      const photos = (e.photos || []).map((p, i) => ({
        key: e.id + '_' + i,
        display: p.local || '',  // 云端链接稍后补
        fileID: p.fileID || ''
      }));
      return {
        id: e.id,
        date: e.date,
        year: d.year,
        month: d.month,
        day: d.day,
        weekday: d.weekday,
        title: e.title || '',
        text: e.text || '',
        photos: photos,
        gridClass: photos.length === 1 ? 'grid-1' : (photos.length <= 4 ? 'grid-2' : 'grid-3'),
        photoCount: photos.length
      };
    });

    let photoTotal = 0;
    items.forEach((it) => { photoTotal += it.photoCount; });

    this._loaded = true;
    this.setData({
      items: items,
      stats: { count: items.length, photos: photoTotal },
      loading: false
    });
    this.fillRemoteUrls();
  },

  /** 本机没有图、只有 fileID 的，批量换临时链接 */
  fillRemoteUrls() {
    const need = [];
    this.data.items.forEach((it) => {
      it.photos.forEach((p) => {
        if (!p.display && p.fileID) need.push(p.fileID);
      });
    });
    if (!need.length) return;
    cb.getFileUrls(need.slice(0, 20)).then((map) => {
      if (!map || !Object.keys(map).length) return;
      const items = this.data.items.map((it) => {
        const photos = it.photos.map((p) => {
          if (p.display || !map[p.fileID]) return p;
          return Object.assign({}, p, { display: map[p.fileID] });
        });
        return Object.assign({}, it, { photos: photos });
      });
      this.setData({ items: items });
    });
  },

  // ---------- 交互 ----------

  onPreview(e) {
    const di = Number(e.currentTarget.dataset.di);
    const pi = Number(e.currentTarget.dataset.pi);
    const item = this.data.items[di];
    if (!item) return;
    const urls = item.photos.map((p) => p.display).filter(Boolean);
    const cur = item.photos[pi] && item.photos[pi].display;
    if (!urls.length || !cur) {
      wx.showToast({ title: '图片尚未下载到本机', icon: 'none' });
      return;
    }
    wx.previewImage({ current: cur, urls: urls });
  },

  onEdit(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    this.goEdit(id);
  },

  onLongPress(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.showModal({
      title: '删除这条回忆',
      content: '文字和照片都会删掉，无法恢复。',
      confirmText: '删除',
      confirmColor: '#ef7d7d',
      success: (r) => {
        if (!r.confirm) return;
        memoryStore.remove(id);
        wx.showToast({ title: '已删除', icon: 'none' });
        this.render();
      }
    });
  },

  onAdd() {
    this.goEdit('');
  },

  goEdit(id) {
    const q = '?adcode=' + this.data.adcode
      + '&name=' + encodeURIComponent(this.data.cityName)
      + (this.data.plan ? '&plan=1' : '')
      + (id ? '&id=' + encodeURIComponent(id) : '');
    wx.navigateTo({ url: '/pages/travel/memory/edit/edit' + q });
  },

  onShareAppMessage() {
    return {
      title: this.data.cityName + ' · ' + this.data.stats.count + ' 条回忆',
      path: '/pages/travel/memory/memory?adcode=' + this.data.adcode
        + '&name=' + encodeURIComponent(this.data.cityName)
    };
  }
});
