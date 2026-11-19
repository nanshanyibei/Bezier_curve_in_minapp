/**
 * 景区详情页
 *
 * 入参：prov（省级 adcode）+ name（名录原名，encodeURIComponent）
 * 渲染分两段：先用包内骨架立刻出标题/城市/年份，再异步补内容。
 * 没有内容不是错误：整页只剩基本信息 + 一句说明，不空白、不报错。
 */
const attractionLayer = require('../../utils/attractionLayer');
const attrContent = require('../../utils/attrContent');
const attrImage = require('../../utils/attrImage');
const spotStore = require('../../utils/spotStore');

/** 人文 / 自然 → 主图渐变色调（两者都占算混合） */
function toneOf(types) {
  const list = types || [];
  const hasNature = list.indexOf('自然') >= 0;
  const hasCulture = list.indexOf('人文') >= 0;
  if (hasNature && !hasCulture) return 'nature';
  if (hasCulture && !hasNature) return 'culture';
  return 'mixed';
}

function fmtMonth(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
}

Page({
  data: {
    ready: false,
    err: '',
    name: '',
    prov: '',
    city: '',
    year: '',
    initial: '',
    heroTone: 'mixed',
    typeTags: [],
    tags: [],
    oneline: '',
    intro: '',
    highlights: [],
    info: [],
    tips: '',
    img: '',
    mark: '',
    hasContent: false,
    loading: true,
    updatedAt: ''
  },

  onLoad(options) {
    const prov = String((options && options.prov) || '');
    let name = '';
    try {
      name = decodeURIComponent(String((options && options.name) || ''));
    } catch (e) {
      name = String((options && options.name) || '');
    }

    const skeleton = attractionLayer.spotsOf(prov).filter((s) => s.name === name)[0];
    if (!skeleton) {
      this.setData({ ready: true, loading: false, err: '没找到这个景区，可能名录已更新' });
      return;
    }

    const types = (skeleton.tags || '').split(',').filter(Boolean);
    this.setData({
      ready: true,
      name: name,
      prov: prov,
      city: skeleton.city || '',
      year: skeleton.year || '',
      initial: name.slice(0, 1),
      heroTone: toneOf(types),
      typeTags: types,
      mark: spotStore.get(prov, name)
    });

    this._applyContent(prov, name);
    this._syncMarks(prov, name);
  },

  /** 内容：先吃缓存，云端回来再覆盖一次 */
  _applyContent(prov, name) {
    attrContent.spotOf(prov, name).then((s) => {
      if (s) this._render(s);
      else this.setData({ loading: false });
    });
  },

  _render(s) {
    const info = [];
    if (s.ticket) info.push({ k: '门票', v: s.ticket });
    if (s.hours) info.push({ k: '开放', v: s.hours });
    if (s.bestMonths) info.push({ k: '最佳', v: s.bestMonths });
    if (s.duration) info.push({ k: '建议', v: s.duration });
    if (s.transport) info.push({ k: '到达', v: s.transport });

    this.setData({
      hasContent: true,
      loading: false,
      oneline: s.oneline || '',
      tags: Array.isArray(s.tags) ? s.tags : [],
      intro: s.intro || '',
      highlights: Array.isArray(s.highlights) ? s.highlights : [],
      info: info,
      tips: s.tips || '',
      updatedAt: fmtMonth(s.updatedAt)
    });

    if (s.img) {
      attrImage.resolve(s.img).then((p) => {
        if (p) this.setData({ img: p });
      });
    }
  },

  /** 云端标记合并：本地先出手，拉到云端若更新则覆盖 */
  _syncMarks(prov, name) {
    spotStore.pullCloud().then((r) => {
      if (!r || !r.changed) return;
      this.setData({ mark: spotStore.get(prov, name) });
    });
  },

  /** 去过 / 想去：再点一次取消 */
  onMark(e) {
    const want = String((e.currentTarget && e.currentTarget.dataset.status) || '');
    if (!want) return;
    const next = this.data.mark === want ? '' : want;
    spotStore.set(this.data.prov, this.data.name, next);
    this.setData({ mark: next });
    wx.vibrateShort && wx.vibrateShort({ type: 'light' });
    wx.showToast({
      title: next === 'visited' ? '已标记去过' : next === 'want' ? '已加入想去' : '已取消',
      icon: 'none'
    });
  },

  /** 下拉刷新：强制跳过本地缓存重拉该省内容 */
  onPullDownRefresh() {
    const prov = this.data.prov;
    const name = this.data.name;
    if (!prov) { wx.stopPullDownRefresh(); return; }
    attrContent.refresh(prov, true).then((d) => {
      const s = d && d.map[name];
      if (s) this._render(s);
      wx.stopPullDownRefresh();
      wx.showToast({ title: s ? '内容已更新' : '暂无新内容', icon: 'none' });
    }).catch(() => {
      wx.stopPullDownRefresh();
    });
  },

  onShareAppMessage() {
    return {
      title: this.data.oneline ? this.data.name + ' · ' + this.data.oneline : this.data.name,
      path: '/pages/travel/spot/spot?prov=' + this.data.prov + '&name=' + encodeURIComponent(this.data.name)
    };
  }
});
