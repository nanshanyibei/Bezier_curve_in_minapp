const geoMap = require('../../utils/geoMap');
const geoRender = require('../../utils/geoRender');
const geoGesture = require('../../utils/geoGesture');
const travelStore = require('../../utils/travelStore');
const routeStore = require('../../utils/routeStore');
const memoryStore = require('../../utils/memoryStore');
const attractionLayer = require('../../utils/attractionLayer');
const cb = require('../../utils/cb');
const seed = require('../../assets/data/attractions-seed');

const COUNTRY = '100000';
const ANIM_MS = 240;
const ATTR_KEY = 'travel.attrLayer';   // 景点图层开关，默认关
// 直辖市（仅用于弹层文案标注，可正常下钻到区）
const MUNICIPALITIES = { 110000: 1, 120000: 1, 310000: 1, 500000: 1 };

Page({
  data: {
    level: 'country',          // 'country' | 'province'
    currentName: '中国',
    stats: { visited: 0, want: 0 },
    filter: 'all',             // all | visited | want，图例即筛选器
    loading: false,
    progress: 0,
    loadingText: '',
    error: '',
    showHint: true,            // 全国视图操作提示
    sheet: null,               // { name, adcode, levelLabel, status }
    routeSheet: null,          // { routes: [{ id, name, status, hidden, count, km }] }
    routeSelect: null,         // { name, stops: [{ adcode, name, center }] } 新建路线选点态
    attrOn: false              // 5A 景点图层（默认关，记忆上次选择）
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
  _provinceAdcode: '', // 省级层当前省份 adcode（区级景点查省级兜底用）
  _routes: [],         // 路线内存缓存：draw() 每帧读，绝不落回 storage
  _routeAnim: null,    // 打卡动效态 { id, progress }，仅绘制期存在
  _useCoarse: true,    // LOD 滞回状态（true=简化环）
  _gesturing: false,   // 手势中：走降级渲染
  _gestureDrew: false, // 本次手势是否已降级重绘过（纯点击不触发补帧）
  _liteTimer: null,    // 松手后补精细帧的定时器

  onLoad() {
    this._marks = travelStore.getAll();
    this._routes = routeStore.visible();
    this._gs = geoGesture.createState();
    this._attrPoints = null;
    this.setData({
      stats: travelStore.stats(),
      attrOn: wx.getStorageSync(ATTR_KEY) === 1
    });
    // 云端标记合并（新者胜），异步不打断首屏
    travelStore.pullCloud().then((r) => {
      if (r && r.changed) {
        this._marks = r.marks;
        this.setData({ stats: travelStore.stats() });
        this.draw();
      }
    });
  },

  onReady() {
    this.initCanvas();
  },

  onShow() {
    // 显隐可能在别处改过，回来时刷一次内存缓存
    this._syncRoutes();
    // iOS 切走再切回时 canvas 位图可能被系统回收，立即重绘避免空白一帧
    if (this._renderer) this.draw();
    // 从足迹清单返回时带定位请求
    this.applyPendingFocus();
  },

  onHide() {
    geoGesture.cancel(this._gs);
    this._animToken++;
    this._resetGesture();
  },

  onUnload() {
    geoGesture.cancel(this._gs);
    this._animToken++;
    this._resetGesture();
    if (this._renderer) this._renderer.destroy();
  },

  /** 刷新路线内存缓存（路线增删/显隐后调用） */
  _syncRoutes() {
    this._routes = routeStore.visible();
  },

  /** 手势结束：清降级态 + 取消补帧定时器 */
  _resetGesture() {
    this._gesturing = false;
    this._gestureDrew = false;
    if (this._liteTimer) {
      clearTimeout(this._liteTimer);
      this._liteTimer = null;
    }
  },

  /** LOD 滞回：≥1.6x 进精细环，<1.3x 退回简化环，消除临界抖动 */
  _updateLod() {
    const v = this._view;
    if (!v || !v.baseScale) return;
    const r = v.scale / v.baseScale;
    if (this._useCoarse && r >= 1.6) this._useCoarse = false;
    else if (!this._useCoarse && r < 1.3) this._useCoarse = true;
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

        // 全国精确边界在分包 subpackages/geo 中，跨分包异步加载（分包异步化）
        require.async('../../subpackages/geo/china-full.js')
          .then((fc) => {
            this._fullFC = fc; // 缓存，避免重复跨分包加载
            try {
              this._layer = geoMap.buildLayer(fc, { level: 'country', adcode: COUNTRY });
              this._countryLayer = this._layer;
              this._view = geoMap.fitView(this._layer.bbox, width, height, 16);
              this._view._layerBBox = this._layer.bbox;
              this.draw();
              if (this._pendingFocus) {
                const f = this._pendingFocus;
                this._pendingFocus = '';
                this.focusAdcode(f);
              }
            } catch (e) {
              this.setData({ error: '地图初始化失败：' + e.message });
            }
          })
          .catch((e) => {
            this.setData({ error: '地图数据加载失败：' + ((e && e.message) || e) });
          });
      });
  },

  onRetry() {
    this.setData({ error: '' });
    this.initCanvas();
  },

  // ---------- 筛选 / 清单入口 ----------
  /** 图例即筛选器：all ↔ visited ↔ want（再次点击当前项退回 all） */
  onFilter(e) {
    const f = e.currentTarget.dataset.f || 'all';
    this.setData({ filter: f === this.data.filter ? 'all' : f });
    this.draw();
  },

  onOpenList() {
    wx.navigateTo({ url: '/pages/travel/list/list' });
  },

  onOpenMy() {
    wx.navigateTo({ url: '/pages/my/my' });
  },

  // ---------- 从清单页定位 ----------
  findRegion(layer, adcode) {
    if (!layer || !layer.regions) return null;
    for (let i = 0; i < layer.regions.length; i++) {
      if (layer.regions[i].adcode === adcode) return layer.regions[i];
    }
    return null;
  },

  applyPendingFocus() {
    const app = getApp();
    const g = app && app.globalData;
    if (!g || !g.travelFocus) return;
    const adcode = String(g.travelFocus);
    g.travelFocus = '';
    this.focusAdcode(adcode);
  },

  /** 省级标记直接弹层；市级先下钻到所属省，再在省级层里弹城市 */
  focusAdcode(adcode) {
    if (!this._countryLayer) {
      this._pendingFocus = adcode; // 图层未就绪，initCanvas 完成后补
      return;
    }
    const provCode = adcode.slice(0, 2) + '0000';
    const provRegion = this.findRegion(this._countryLayer, provCode);
    if (!provRegion) return;

    const openCity = () => {
      const hit = this.findRegion(this._layer, adcode);
      if (hit) this.openSheet(hit);
      else this.openSheet(provRegion);
    };

    if (adcode === provCode) {
      if (this.data.level === 'province') this.onBack(() => this.openSheet(provRegion));
      else this.openSheet(provRegion);
      return;
    }
    if (this.data.level === 'province') {
      if (this._provinceAdcode === provCode) { openCity(); return; }
      this.onBack(() => this.drillTo(provRegion, openCity));
      return;
    }
    this.drillTo(provRegion, openCity);
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
      level: this.data.level,
      filter: this.data.filter,
      lite: this._gesturing,
      useCoarse: this._useCoarse,
      routes: this._routes,
      routeAnim: this._routeAnim,
      selectStops: this.data.routeSelect ? this.data.routeSelect.stops : null
    });
  },

  // ---------- 触摸 ----------
  onTouchStart(e) {
    if (!this._view) return;
    this._animToken++; // 打断切层动画
    if (this._liteTimer) {
      clearTimeout(this._liteTimer);
      this._liteTimer = null;
    }
    // 不在此处重绘：纯点击不应闪一帧无名称地图，首次 move 才降级绘制
    this._gesturing = true;
    this._gestureDrew = false;
    geoGesture.begin(this._gs, e.touches);
  },

  onTouchMove(e) {
    if (!this._view) return;
    const old = this._view;
    let v = geoGesture.move(this._gs, e.touches, this._view, geoMap);
    v = geoMap.clampView(v, this._W, this._H, 48);
    v._layerBBox = this._layer.bbox;
    this._view = v;
    this._updateLod();
    if (!sameView(old, v)) {
      this._gestureDrew = true;
      this.draw(); // 视图无变化（如手指未动）不重绘
    }
  },

  onTouchEnd(e) {
    if (!this._view) return;
    const r = geoGesture.end(this._gs, e.touches);
    const drew = this._gestureDrew;
    this._gesturing = false;
    this._gestureDrew = false;
    // 有过降级绘制才补精细帧（名称/描边回来）；纯点击不重绘
    if (drew) {
      this._liteTimer = setTimeout(() => {
        this._liteTimer = null;
        this.draw();
      }, 120);
    }
    if (r.gesture === 'tap') this.handleTap(r.x, r.y);
  },

  onTouchCancel() {
    geoGesture.cancel(this._gs);
    const drew = this._gestureDrew;
    this._gesturing = false;
    this._gestureDrew = false;
    if (this._liteTimer) clearTimeout(this._liteTimer);
    if (!drew) return;
    this._liteTimer = setTimeout(() => {
      this._liteTimer = null;
      this.draw();
    }, 120);
  },

  // ---------- 点选 ----------
  handleTap(x, y) {
    const wpt = geoMap.screenToWorld(this._view, x, y);
    const region = geoMap.hitTest(this._layer, wpt[0], wpt[1]);
    if (!region) return;
    // 路线选点模式：全国层点省份=下钻选市；省级层点城市=加入/移除站点
    if (this.data.routeSelect) {
      if (this.data.level === 'country') {
        if (this.data.loading) return;
        this.drillTo(region, null, () => this.addStop(region));
        return;
      }
      this.addStop(region);
      return;
    }
    // 全国层单击=标记省份/直辖市；省级层单击=标记城市
    this.openSheet(region);
  },

  /** 选点态：站点加入/移除（centerLL 缺失时用归一化中心反算经纬度兜底） */
  addStop(region) {
    const sel = this.data.routeSelect;
    if (!sel) return;
    const stops = sel.stops.slice();
    const idx = stops.findIndex((s) => s.adcode === region.adcode);
    if (idx >= 0) {
      stops.splice(idx, 1);
    } else {
      const center = region.centerLL || this.centerLLOf(region);
      if (!center) {
        wx.showToast({ title: '该区域缺少中心点', icon: 'none' });
        return;
      }
      stops.push({ _k: this._stopSeq++, adcode: region.adcode, name: region.name, center: center });
    }
    this._applyStops(stops);
  },

  /** 统一更新选点站点：维护 closed 标记（首尾同城 = 闭合环线） */
  _applyStops(stops) {
    const closed = stops.length >= 3 && stops[stops.length - 1].adcode === stops[0].adcode;
    this.setData({ 'routeSelect.stops': stops, 'routeSelect.closed': closed });
    this.draw();
  },

  /** 闭合环线：把首站追加到末尾（A→B→A）；已闭合时再点=取消闭合 */
  onCloseLoop() {
    const sel = this.data.routeSelect;
    if (!sel || sel.stops.length < 2) return;
    const stops = sel.stops.slice();
    if (sel.closed) {
      stops.pop();
    } else {
      stops.push(Object.assign({}, stops[0], { _k: this._stopSeq++ }));
    }
    this._applyStops(stops);
  },

  /** 归一化中心 → 经纬度（Web Mercator 反算） */
  centerLLOf(region) {
    const pr = this._layer && this._layer.proj;
    if (!pr || !region.center) return null;
    const x = region.center[0] * pr.w + pr.minX;
    const y = pr.maxY - region.center[1] * pr.w;
    return [x * 180 / Math.PI, (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI];
  },

  // ---------- 下钻 / 返回 ----------
  /** 下钻到省级层；onFail 用于选点态（无下级数据时以省级自身成站），缺省回退标记弹层 */
  drillTo(region, done, onFail) {
    if (this.data.loading) return;
    this.setData({ loading: true, progress: 0, loadingText: '正在加载' + region.name + '…', showHint: false });
    this._provinceAdcode = region.adcode;
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
        if (typeof done === 'function') done();
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
      // 台湾/港澳无下级数据或网络不可用：选点态以省级自身成站，否则省级直接标记
      if (typeof onFail === 'function') {
        onFail();
        return;
      }
      this.openSheet(region);
    });
  },

  onBack(done) {
    if (!this._countryLayer || this.data.level !== 'province') return;
    const target = geoMap.fitView(this._countryLayer.bbox, this._W, this._H, 16);
    this.animateView(target, () => {
      this._layer = this._countryLayer;
      this._view = target;
      this._view._layerBBox = this._countryLayer.bbox;
      this._highlight = '';
      this._provinceAdcode = '';
      this.setData({ level: 'country', currentName: '中国' });
      this.draw();
      if (typeof done === 'function') done();
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
        this._updateLod();
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
    const hint = isCountry
      ? '标记以足迹点显示在中国地图上 · 点「查看市界」可下钻标记下级区域'
      : '标记会以足迹点的形式显示在全国地图上';
    this._sheetRegion = region;
    this.setData({
      sheet: {
        name: region.name,
        adcode: region.adcode,
        levelLabel: this.levelLabel(region),
        status: mk ? mk.status : '',
        centerLL: region.centerLL || null,
        canDrill: isCountry,
        hint: hint,
        spots: [],
        spotsLoading: true,
        memCount: 0,
        memPhotos: 0,
        memThumbs: []
      }
    });
    this.loadSpots(region, false);
    this.loadMemories(region);
  },

  /** 弹层回忆摘要：条数 + 最近 3 张缩略图（优先本地图，换设备时异步换云端链接） */
  loadMemories(region) {
    const adcode = String(region.adcode);
    const list = memoryStore.listByCity(adcode);
    let photos = 0;
    const thumbs = [];
    const remote = [];
    list.forEach((e) => {
      (e.photos || []).forEach((p) => {
        photos++;
        if (p.local) thumbs.push(p.local);
        else if (p.fileID) remote.push(p.fileID);
      });
    });
    if (this._sheetRegion !== region) return;
    this.setData({
      'sheet.memCount': list.length,
      'sheet.memPhotos': photos,
      'sheet.memThumbs': thumbs.slice(0, 3)
    });
    // 本机没有图（换了设备）才去云端换链接，避免每次开弹层都多一次请求
    if (!thumbs.length && remote.length) {
      cb.getFileUrls(remote.slice(0, 3)).then((map) => {
        if (this._sheetRegion !== region) return;
        const urls = remote.slice(0, 3).map((f) => map[f]).filter(Boolean);
        if (urls.length) this.setData({ 'sheet.memThumbs': urls });
      });
    }
  },

  /** 打开这座城市的回忆册 */
  onOpenMemory() {
    if (!this.data.sheet) return;
    const s = this.data.sheet;
    const plan = s.status === 'want' ? '&plan=1' : '';
    wx.navigateTo({
      url: '/pages/travel/memory/memory?adcode=' + s.adcode
        + '&name=' + encodeURIComponent(s.name) + plan
    });
  },

  /** 当前查询的省级兜底 adcode：全国层=region 本身（省）；省级层=adcode 截断到省 */
  fallbackProvinceCode(region) {
    if (this.data.level === 'country') return region.adcode;
    const code = String(region.adcode);
    return code.length >= 6 ? (parseInt(code.slice(0, 2), 10) * 10000) + '00' : code;
  },

  /* @dev:begin */
  /** 兜底省级名称（AI 提示词用） */
  parentName() {
    return this.data.level === 'province' ? this.data.currentName : '';
  },
  /* @dev:end */

  /** 弹层景点：云端查询（带缓存）→ 空则用种子兜底 */
  loadSpots(region, forceRefresh) {
    const adcode = String(region.adcode);
    const fb = this.fallbackProvinceCode(region);
    cb.fetchAttractions(adcode, fb, 6).then((list) => {
      if (this._sheetRegion !== region) return; // 弹层已切换/关闭
      let spots = list;
      if (!spots.length) spots = seed.byAdcode(adcode).map((s) => ({
        name: s.name, desc: s.desc, img: s.img, bestMonths: s.bestMonths, tags: s.tags
      }));
      this.setData({ 'sheet.spots': spots, 'sheet.spotsLoading': false });
    });
  },

  /* @dev:begin */
  /** 「AI 补充更多」：云函数 LLM 生成并写库，成功后刷新弹层（服务端无 key 时自动退回本地直连） */
  onGenAttractions() {
    const region = this._sheetRegion;
    if (!region || !this.data.sheet || this.data.sheet.spotsLoading) return;
    if (!cb.cloudReady()) {
      wx.showToast({ title: '未配置云端，无法 AI 补充', icon: 'none' });
      return;
    }
    this.setData({ 'sheet.spotsLoading': true });
    cb.genAttractions(String(region.adcode), region.name, this.parentName()).then((list) => {
      if (this._sheetRegion !== region) return;
      const spots = list.length ? list : this.data.sheet.spots;
      this.setData({ 'sheet.spots': spots, 'sheet.spotsLoading': false });
      if (!list.length) wx.showToast({ title: '生成失败，稍后再试', icon: 'none' });
    });
  },
  /* @dev:end */

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

  // ---------- 路线 ----------
  onOpenRoutes() {
    if (this.data.routeSelect) return; // 选点中不弹列表
    this.setData({ routeSheet: { routes: routeStore.list(), detail: null } });
  },

  closeRouteSheet() {
    this.setData({ routeSheet: null });
  },

  /** 列表刷新：详情态下同步刷新当前详情，避免改名/调序后回列表看到旧数据 */
  refreshRouteSheet() {
    const rs = this.data.routeSheet;
    if (!rs) return;
    const patch = { 'routeSheet.routes': routeStore.list() };
    if (rs.detail) {
      const d = routeStore.detail(rs.detail.id);
      if (d) patch['routeSheet.detail'] = d;
    }
    this.setData(patch);
  },

  // ---------- 路线详情 ----------

  /** 点列表项主体 → 进详情（显隐改由单独的按钮控制） */
  onOpenRouteDetail(e) {
    const id = e.currentTarget.dataset.id;
    const d = routeStore.detail(id);
    if (!d) return;
    this.setData({ 'routeSheet.detail': d });
  },

  onBackRouteList() {
    this.setData({ 'routeSheet.detail': null });
    this.refreshRouteSheet();
  },

  /** 重命名：原生可编辑弹窗，取消或空名都不落库 */
  onRenameRoute() {
    const d = this.data.routeSheet && this.data.routeSheet.detail;
    if (!d) return;
    wx.showModal({
      title: '重命名路线',
      editable: true,
      placeholderText: '给这条路线起个名字',
      content: d.name,
      confirmText: '保存',
      success: (res) => {
        if (!res.confirm) return;
        const next = routeStore.rename(d.id, res.content);
        if (!next) {
          wx.showToast({ title: '名称不能为空', icon: 'none' });
          return;
        }
        this.setData({
          'routeSheet.detail': next,
          'routeSheet.routes': routeStore.list()
        });
        wx.showToast({ title: '已重命名', icon: 'none' });
      }
    });
  },

  /** 站点上移 / 下移（dir: -1 上，1 下），到边界静默不动 */
  onMoveStop(e) {
    const d = this.data.routeSheet && this.data.routeSheet.detail;
    if (!d) return;
    const i = Number(e.currentTarget.dataset.i);
    const dir = Number(e.currentTarget.dataset.dir);
    const next = routeStore.moveStop(d.id, i, dir);
    if (!next) return;   // 首站不能再上移，末站不能再下移
    this.setData({
      'routeSheet.detail': next,
      'routeSheet.routes': routeStore.list()
    });
    this._syncRoutes();
    this.draw();
  },

  /** 移除站点：少于 2 个城市时拒绝，否则路线不成线 */
  onDeleteStop(e) {
    const d = this.data.routeSheet && this.data.routeSheet.detail;
    if (!d) return;
    const i = Number(e.currentTarget.dataset.i);
    const r = routeStore.removeStop(d.id, i);
    if (!r.ok) {
      if (r.reason === 'TOO_FEW') wx.showToast({ title: '至少保留 2 个城市', icon: 'none' });
      return;
    }
    this.setData({
      'routeSheet.detail': r.route,
      'routeSheet.routes': routeStore.list()
    });
    this._syncRoutes();
    this.draw();
  },

  /** 状态切换：规划中 ↔ 已走完。切到已走完即「打卡」，收起弹层看地图生长动效 */
  onToggleRouteStatus() {
    const d = this.data.routeSheet && this.data.routeSheet.detail;
    if (!d) return;
    const target = d.status === 'done' ? 'plan' : 'done';
    const r = routeStore.setStatus(d.id, target);
    if (!r) return;
    this._syncRoutes();

    if (r.became === 'done') {
      // 弹层挡住地图下半部分，先收起来再画
      this.setData({ routeSheet: null });
      if (wx.vibrateShort) wx.vibrateShort({ type: 'medium' });
      wx.showToast({ title: '打卡成功 · ' + r.route.km + ' km', icon: 'none' });
      setTimeout(() => this.playRouteStamp(d.id), 180);
    } else {
      this.setData({
        'routeSheet.detail': r.route,
        'routeSheet.routes': routeStore.list()
      });
      this.draw();
      wx.showToast({ title: '已改回规划中', icon: 'none' });
    }
  },

  /**
   * 打卡动效：线路从起点生长到终点，途经站点依次脉冲
   * 由 canvas 的 requestAnimationFrame 驱动；结束后回落静态绘制（带回序号）
   */
  playRouteStamp(id) {
    const DUR = 900;
    const start = Date.now();
    const tick = () => {
      if (!this._routeAnim || this._routeAnim.id !== id) return;
      const t = Math.min(1, (Date.now() - start) / DUR);
      if (t >= 1) {
        this._routeAnim = null;   // 静态路径接管最终态
        this.draw();
        return;
      }
      const eased = 1 - Math.pow(1 - t, 3);
      this._routeAnim = { id: id, progress: eased };
      this.draw();
      if (this._canvas && this._canvas.requestAnimationFrame) {
        this._canvas.requestAnimationFrame(tick);
      } else {
        setTimeout(tick, 16);
      }
    };
    this._routeAnim = { id: id, progress: 0 };
    tick();
  },

  /** 新建路线：省级视图先回全国（选点在全国层进行），再进入选点态 */
  onCreateRoute() {
    if (this.data.routeSelect) return;
    this.setData({ routeSheet: null });
    this._stopSeq = 0;
    const start = () => {
      const d = new Date();
      const p = (n) => (n < 10 ? '0' + n : '' + n);
      this.setData({
        routeSelect: {
          name: '路线 ' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()),
          stops: [],
          closed: false
        }
      });
      this.draw();
    };
    if (this.data.level === 'province') this.onBack(start);
    else start();
  },

  onRouteName(e) {
    if (!this.data.routeSelect) return;
    this.setData({ 'routeSelect.name': e.detail.value });
  },

  /** 选点条上移除站点（×） */
  onRemoveStop(e) {
    if (!this.data.routeSelect) return;
    const i = Number(e.currentTarget.dataset.i);
    const stops = this.data.routeSelect.stops.slice();
    if (i >= 0 && i < stops.length) {
      stops.splice(i, 1);
      this._applyStops(stops);
    }
  },

  onFinishRoute() {
    const sel = this.data.routeSelect;
    if (!sel) return;
    if (sel.stops.length < 2) {
      wx.showToast({ title: '至少点选 2 个城市', icon: 'none' });
      return;
    }
    const r = routeStore.create(sel.name, sel.stops);
    this.setData({ routeSelect: null });
    this._syncRoutes();
    // 从省级视图建完线后回全国，先看到完整弧线再弹列表
    if (this.data.level === 'province') this.onBack(() => this.draw());
    else this.draw();
    this.setData({ routeSheet: { routes: routeStore.list(), detail: null } });
    wx.showToast({ title: '已保存「' + r.name + '」', icon: 'none' });
  },

  onCancelRoute() {
    const sel = this.data.routeSelect;
    if (!sel) return;
    const quit = () => {
      this.setData({ routeSelect: null });
      this.draw();
    };
    if (sel.stops.length) {
      wx.showModal({
        title: '放弃新建路线？',
        content: '已选的 ' + sel.stops.length + ' 个城市不会被保存',
        confirmText: '放弃',
        cancelText: '继续选',
        success: (res) => { if (res.confirm) quit(); }
      });
    } else {
      quit();
    }
  },

  /** 列表项：切换地图显隐 */
  onToggleRoute(e) {
    const id = e.currentTarget.dataset.id;
    const item = routeStore.list().find((r) => r.id === id);
    if (!item) return;
    routeStore.setHidden(id, !item.hidden);
    this._syncRoutes();
    this.refreshRouteSheet();
    this.draw();
  },

  /** 列表项：删除（二次确认） */
  onDeleteRoute(e) {
    const id = e.currentTarget.dataset.id;
    const item = routeStore.list().find((r) => r.id === id);
    if (!item) return;
    wx.showModal({
      title: '删除路线',
      content: '「' + item.name + '」将被删除，不可恢复',
      confirmText: '删除',
      confirmColor: '#ef7d7d',
      success: (res) => {
        if (!res.confirm) return;
        routeStore.remove(id);
        this._syncRoutes();
        // 可能从详情里删的，统一退回列表
        this.setData({ routeSheet: { routes: routeStore.list(), detail: null } });
        this.draw();
      }
    });
  },

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

/** scale/tx/ty 三元组完全一致视为视图无变化（手指未动时跳过重绘） */
function sameView(a, b) {
  return a.scale === b.scale && a.tx === b.tx && a.ty === b.ty;
}
