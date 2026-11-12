/**
 * 足迹清单：地图之外的第二入口
 * 纯读 travelStore，不写任何数据；点条目回地图定位
 */
const travelStore = require('../../../utils/travelStore');

Page({
  data: {
    cov: { provinceVisited: 0, provinceTotal: 34, pct: 0, cityVisited: 0, want: 0, visited: 0 },
    filter: 'all',            // all | visited | want
    groups: [],
    counts: { all: 0, visited: 0, want: 0 },
    empty: true
  },

  onLoad() {
    this.refresh();
  },

  onShow() {
    // 从地图返回后标记可能已变
    this.refresh();
  },

  refresh() {
    this.setData({ cov: travelStore.coverage() });
    this.build();
  },

  build() {
    const filter = this.data.filter;
    const raw = travelStore.groupByProvince();
    const counts = { all: 0, visited: 0, want: 0 };

    const groups = [];
    raw.forEach((g) => {
      g.items.forEach((it) => {
        counts.all++;
        if (it.status === 'visited') counts.visited++;
        else if (it.status === 'want') counts.want++;
      });
      const items = filter === 'all' ? g.items : g.items.filter((it) => it.status === filter);
      if (!items.length) return;
      const vc = items.filter((it) => it.status === 'visited').length;
      const wc = items.length - vc;
      let stat = '';
      if (vc && wc) stat = '去过 ' + vc + ' · 想去 ' + wc;
      else if (vc) stat = '去过 ' + vc;
      else stat = '想去 ' + wc;
      groups.push({ code: g.code, name: g.name, stat: stat, items: items });
    });

    this.setData({
      groups: groups,
      counts: counts,
      empty: counts.all === 0
    });
  },

  onFilter(e) {
    const f = e.currentTarget.dataset.f || 'all';
    if (f === this.data.filter) return;
    this.setData({ filter: f }, () => this.build());
  },

  /** 回地图并定位到该区域 */
  onTapItem(e) {
    const adcode = String(e.currentTarget.dataset.adcode || '');
    if (!adcode) return;
    const app = getApp();
    if (app && app.globalData) app.globalData.travelFocus = adcode;
    // 清单页若为页面栈首页（分享/扫码直接进入），navigateBack 会失败，改走 switchTab
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 });
    } else {
      wx.switchTab({ url: '/pages/travel/travel' });
    }
  }
});
