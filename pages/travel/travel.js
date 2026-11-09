const fullFC = require('../../assets/geo/china-full.js');
const geoMap = require('../../utils/geoMap');
const geoRender = require('../../utils/geoRender');
const geoGesture = require('../../utils/geoGesture');
const travelStore = require('../../utils/travelStore');

const COUNTRY = '100000';
const ANIM_MS = 240;
// 直辖市：不下钻到区，整市直接标记
const MUNICIPALITIES = { 110000: 1, 120000: 1, 310000: 1, 500000: 1 };

Page({
  data: {
    level: 'country',          // 'country' | 'province'
    currentName: '中国',
    stats: { visited: 0, want: 0 },
    loading: false,
    progress: 0,
    loadingText: '',
    error: '',
    showHint: true,            // 全国视图操作提示
    sheet: null                // { name, adcode, levelLabel, status }
  },

  // 非响应式运行时
  _canvas: null,
  _ctx: null,
  _renderer: null,
  _W: 0,
  _H: 0,
  _layer: null,
  _countryLayer: null,
  _view: null,
  _marks: {},
  _gs: null,
  _animToken: 0,
  _highlight: '',
  _domainWarned: false,
  _sheetRegion: null,

  onLoad() {
    this._marks = travelStore.getAll();
    this._gs = geoGesture.createState();
    this.setData({ stats: travelStore.stats() });
  },

  onReady() {
    this.initCanvas();
  },

  onHide() {
    geoGesture.cancel(this._gs);
    this._animToken++;
  },

  onUnload() {
    geoGesture.cancel(this._gs);
    this._animToken++;
    if (this._renderer) this._renderer.destroy();
  },

  // ---------- 初始化 ----------
  initCanvas() {
    wx.createSelectorQuery().in(this)
      .select('#mapCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) {
          this.setData({ error: '地图画布初始化失败，点击重试' });
          return;
        }
        const node = res[0].node;
        const width = res[0].width;
        const height = res[0].height;
        const dpr = Math.min(wx.getSystemInfoSync().pixelRatio || 2, 2);
        node.width = width * dpr;
        node.height = height * dpr;
        const ctx = node.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        this._canvas = node;
        this._ctx = ctx;
        this._W = width;
        this._H = height;
        this._renderer = geoRender.createRenderer(node, ctx);

        // 全国精确边界已打包进小程序（assets/geo/china-full.js），无需网络
        try {
          this._layer = geoMap.buildLayer(fullFC, { level: 'country', adcode: COUNTRY });
          this._countryLayer = this._layer;
          this._view = geoMap.fitView(this._layer.bbox, width, height, 16);
          this._view._layerBBox = this._layer.bbox;
          this.draw();
        } catch (e) {
          this.setData({ error: '地图初始化失败：' + e.message });
          return;
        }
      });
  },

  onRetry() {
    this.setData({ error: '' });
    this.initCanvas();
  },

  // ---------- 绘制 ----------
  draw() {
    if (!this._renderer) return;
    this._renderer.requestDraw({
      layer: this._layer,
      view: this._view,
      W: this._W,
      H: this._H,
      marks: this._marks,
      level: this.data.level
    });
  },

  // ---------- 触摸 ----------
  onTouchStart(e) {
    if (!this._view) return;
    this._animToken++; // 打断切层动画
    geoGesture.begin(this._gs, e.touches);
  },

  onTouchMove(e) {
    if (!this._view) return;
    this._view = geoGesture.move(this._gs, e.touches, this._view, geoMap);
    this._view = geoMap.clampView(this._view, this._W, this._H, 48);
    this._view._layerBBox = this._layer.bbox;
    this.draw();
  },

  onTouchEnd(e) {
    if (!this._view) return;
    const r = geoGesture.end(this._gs, e.touches);
    if (r.gesture === 'tap') this.handleTap(r.x, r.y);
  },

  onTouchCancel() {
    geoGesture.cancel(this._gs);
  },

  // ---------- 点选 ----------
  handleTap(x, y) {
    const wpt = geoMap.screenToWorld(this._view, x, y);
    const region = geoMap.hitTest(this._layer, wpt[0], wpt[1]);
    if (!region) return;
    // 全国层单击=标记省份/直辖市；省级层单击=标记城市
    this.openSheet(region);
  },

  // ---------- 下钻 / 返回 ----------
  drillTo(region) {
    if (this.data.loading) return;
    this.setData({ loading: true, progress: 0, loadingText: '正在加载' + region.name + '…', showHint: false });
    geoMap.getLayer(region.adcode, { level: 'province' }).then((layer) => {
      this._highlight = region.adcode;
      const target = geoMap.fitView(layer.bbox, this._W, this._H, 24);
      this.animateView(target, () => {
        this._layer = layer;
        this._view = target;
        this._view._layerBBox = layer.bbox;
        this.setData({
          level: 'province',
          currentName: region.name,
          loading: false
        });
        this.draw();
      });
    }).catch((err) => {
      this.setData({ loading: false });
      const msg = (err && err.message) || '';
      console.error('[travel] 下钻加载失败:', region.name, msg);
      if (msg.indexOf('domain list') >= 0 && !this._domainWarned) {
        this._domainWarned = true;
        wx.showModal({
          title: '市界数据需要联网',
          content: '真机请点右上角「…」→ 打开调试模式；或在 mp 后台把 file.geojson.cn 加入 request 与 downloadFile 合法域名。本次先用省级标记。',
          showCancel: false
        });
      }
      // 台湾/港澳无下级数据或网络不可用：省级直接标记
      this.openSheet(region);
    });
  },

  onBack() {
    if (!this._countryLayer || this.data.level !== 'province') return;
    const target = geoMap.fitView(this._countryLayer.bbox, this._W, this._H, 16);
    this.animateView(target, () => {
      this._layer = this._countryLayer;
      this._view = target;
      this._view._layerBBox = this._countryLayer.bbox;
      this._highlight = '';
      this.setData({ level: 'country', currentName: '中国' });
      this.draw();
    });
  },

  /** easeOutCubic 视图动画；token 可被打断 */
  animateView(target, done) {
    const token = ++this._animToken;
    const from = { scale: this._view.scale, tx: this._view.tx, ty: this._view.ty };
    const start = Date.now();
    const step = () => {
      if (token !== this._animToken) return;
      const t = Math.min(1, (Date.now() - start) / ANIM_MS);
      const e = 1 - Math.pow(1 - t, 3);
      this._view = {
        scale: from.scale + (target.scale - from.scale) * e,
        tx: from.tx + (target.tx - from.tx) * e,
        ty: from.ty + (target.ty - from.ty) * e,
        baseScale: this._view.baseScale,
        maxScale: this._view.maxScale,
        _layerBBox: this._layer.bbox
      };
      if (t < 1) {
        this.draw();
        if (this._canvas.requestAnimationFrame) {
          this._canvas.requestAnimationFrame(step);
        } else {
          setTimeout(step, 16);
        }
      } else {
        done();
      }
    };
    step();
  },

  // ---------- 标记弹层 ----------
  openSheet(region) {
    const mk = this._marks[region.adcode];
    const isCountry = this.data.level === 'country';
    const isMuni = !!MUNICIPALITIES[region.adcode];
    let hint = '标记会以足迹点的形式显示在全国地图上';
    if (isCountry) {
      hint = isMuni
        ? '直辖市按整市标记，不再下钻到区'
        : '标记以足迹点显示在中国地图上 · 点「查看市界」可标记到城市';
    }
    this._sheetRegion = region;
    this.setData({
      sheet: {
        name: region.name,
        adcode: region.adcode,
        levelLabel: this.levelLabel(region),
        status: mk ? mk.status : '',
        centerLL: region.centerLL || null,
        canDrill: isCountry && !isMuni,
        hint: hint
      }
    });
  },

  /** 弹层「查看市界」：先关弹层（遮罩会挡住切层动画），再复用 drillTo */
  onDrill() {
    const region = this._sheetRegion;
    if (!region || !this.data.sheet || !this.data.sheet.canDrill) return;
    if (this.data.loading) return;
    this.closeSheet();
    this.drillTo(region);
  },

  levelLabel(region) {
    if (this.data.level === 'country') {
      return MUNICIPALITIES[region.adcode] ? '直辖市' : '省';
    }
    return region.level === 'district' ? '区' : '市';
  },

  closeSheet() {
    this._sheetRegion = null;
    this.setData({ sheet: null });
  },

  noop() {},

  onPickStatus(e) {
    const status = e.currentTarget.dataset.status || '';
    if (!this.data.sheet) return;
    const adcode = this.data.sheet.adcode;
    const name = this.data.sheet.name;
    const center = this.data.sheet.centerLL;
    this.closeSheet();
    this._marks = travelStore.set(adcode, status, { name: name, center: center });
    this.setData({ stats: travelStore.stats() });
    this.draw();
  }
});
