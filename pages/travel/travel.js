const fullFC = require('../../assets/geo/china-full.js');
const geoMap = require('../../utils/geoMap');
const geoRender = require('../../utils/geoRender');
const geoGesture = require('../../utils/geoGesture');
const travelStore = require('../../utils/travelStore');

const COUNTRY = '100000';
const ANIM_MS = 240;

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
  _netWarned: false,
  _autoDrillLocked: false,

  onLoad() {
    this._marks = travelStore.getAll();
    this._gs = geoGesture.createState((x, y) => this.handleLongPress(x, y));
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
    // 长按已在回调里处理
    this.maybeAutoDrill();
  },

  /** 放大到阈值自动下钻视野中心所在省（放大即出市界）；缩到阈值外自动回全国 */
  maybeAutoDrill() {
    if (this.data.loading || this._autoDrillLocked) return;
    const ratio = this._view.scale / this._view.baseScale;
    if (this.data.level === 'country') {
      if (ratio < 2.2) return;
      const wpt = geoMap.screenToWorld(this._view, this._W / 2, this._H / 2);
      const region = geoMap.hitTest(this._layer, wpt[0], wpt[1]);
      if (region) this.drillTo(region, { silent: true });
    } else if (this.data.level === 'province' && ratio <= 0.6) {
      this.onBack();
    }
  },

  onTouchCancel() {
    geoGesture.cancel(this._gs);
  },

  // ---------- 点选 ----------
  handleTap(x, y) {
    const wpt = geoMap.screenToWorld(this._view, x, y);
    const region = geoMap.hitTest(this._layer, wpt[0], wpt[1]);
    if (!region) return;
    if (this.data.level === 'country') {
      this.drillTo(region);
    } else {
      this.openSheet(region);
    }
  },

  handleLongPress(x, y) {
    // 与单击一致：全国层下钻省份，省级层打开标记弹层
    this.handleTap(x, y);
  },

  // ---------- 下钻 / 返回 ----------
  drillTo(region, opts) {
    if (this.data.loading) return;
    const silent = !!(opts && opts.silent);
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
      // 自动触发（缩放）失败：锁住，避免每次手势反复重试；静默提示
      if (silent) {
        this._autoDrillLocked = true;
        if (!this._netWarned) {
          this._netWarned = true;
          wx.showToast({ title: '市界数据需联网加载', icon: 'none' });
        }
        return;
      }
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
      this._autoDrillLocked = false;
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
    this.setData({
      sheet: {
        name: region.name,
        adcode: region.adcode,
        levelLabel: this.levelLabel(region),
        status: mk ? mk.status : '',
        centerLL: region.centerLL || null
      }
    });
  },

  levelLabel(region) {
    if (this.data.level === 'country') return '省级';
    return region.level === 'district' ? '区' : '市';
  },

  closeSheet() {
    this.setData({ sheet: null });
  },

  noop() {},

  onPickStatus(e) {
    const status = e.currentTarget.dataset.status || '';
    if (!this.data.sheet) return;
    this._marks = travelStore.set(this.data.sheet.adcode, status, {
      name: this.data.sheet.name,
      center: this.data.sheet.centerLL
    });
    this.setData({ sheet: null, stats: travelStore.stats() });
    this.draw();
  }
});
