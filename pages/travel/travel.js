const liteFC = require('../../assets/geo/china-lite.js');
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
  _loadingFull: false,
  _highlight: '',

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

        // lite 层同步构建，秒开可交互
        try {
          this._layer = geoMap.buildLayer(liteFC, { level: 'country', adcode: COUNTRY });
          this._countryLayer = this._layer;
          this._view = geoMap.fitView(this._layer.bbox, width, height, 16);
          this._view._layerBBox = this._layer.bbox;
          this.draw();
        } catch (e) {
          this.setData({ error: '地图初始化失败：' + e.message });
          return;
        }

        // 完整数据后台静默加载替换
        this.loadFull();
      });
  },

  /** 完整全国数据（含精确边界），失败时保留 lite 层可用 */
  loadFull() {
    if (this._loadingFull) return;
    this._loadingFull = true;
    this.setData({ loading: true, progress: 0, loadingText: '正在下载地图数据…', error: '' });
    geoMap.getLayer(COUNTRY, {
      level: 'country',
      onProgress: (p) => {
        if (p < 100) this.setData({ loadingText: '正在下载地图数据 ' + p + '%' });
      }
    }).then((layer) => {
      this._loadingFull = false;
      this._countryLayer = layer;
      // 仅当用户仍在全国视图时替换，避免打断下钻
      if (this.data.level === 'country') {
        this._layer = layer;
        this._view._layerBBox = layer.bbox;
      }
      this.setData({ loading: false });
      this.draw();
    }).catch((err) => {
      this._loadingFull = false;
      console.error('[travel] 精确边界加载失败:', err && err.message || err);
      const detail = err && err.message ? '，' + String(err.message).slice(0, 60) : '';
      this.setData({ loading: false, error: '精确边界加载失败（当前为简图）' + detail + '，点击重试' });
    });
  },

  onRetry() {
    this.setData({ error: '' });
    if (this.data.level === 'country' && !this._loadingFull) this.loadFull();
  },

  // ---------- 绘制 ----------
  draw() {
    if (!this._renderer) return;
    this._renderer.requestDraw({
      layer: this._layer,
      view: this._view,
      W: this._W,
      H: this._H,
      marks: this._marks
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
    const wpt = geoMap.screenToWorld(this._view, x, y);
    const region = geoMap.hitTest(this._layer, wpt[0], wpt[1]);
    if (!region) return;
    this.openSheet(region);
  },

  // ---------- 下钻 / 返回 ----------
  drillTo(region) {
    if (this.data.loading) return;
    this.setData({ loading: true, progress: 0, loadingText: '正在加载' + region.name + '…' });
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
    }).catch(() => {
      // 台湾/港澳无下级数据：省级直接标记
      this.setData({ loading: false });
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
    this.setData({
      sheet: {
        name: region.name,
        adcode: region.adcode,
        levelLabel: this.levelLabel(region),
        status: this._marks[region.adcode] || ''
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
    this._marks = travelStore.set(this.data.sheet.adcode, status);
    this.setData({ sheet: null, stats: travelStore.stats() });
    this.draw();
  }
});
