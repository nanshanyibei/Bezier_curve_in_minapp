const foodStore = require('../../../utils/foodStore');

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => n < 10 ? '0' + n : '' + n;
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const yesterday = new Date(now.getTime() - 86400000);
  const isYd = d.getFullYear() === yesterday.getFullYear() && d.getMonth() === yesterday.getMonth() && d.getDate() === yesterday.getDate();
  if (sameDay) return '今天 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  if (isYd) return '昨天 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

Page({
  data: {
    list: []
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const raw = foodStore.getHistory();
    const list = raw.map((h) => ({
      dish: h.dish,
      timeText: fmtTime(h.pickedAt)
    }));
    this.setData({ list: list });
  },

  onTap(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/food/detail/detail?id=' + id });
  }
});
