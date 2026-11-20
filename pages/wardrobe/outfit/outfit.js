/**
 * 新建搭配页
 * 选择上装（含外套）、下装、鞋；可选 1 个包、最多 2 件配饰。
 * 本地 Canvas 生成 800×800 白底搭配图，保存后回到衣橱的「搭配」模式。
 */
const wardrobeStore = require('../../../utils/wardrobeStore');
const outfitStore = require('../../../utils/outfitStore');
const outfitRender = require('../../../utils/outfitRender');
const cb = require('../../../utils/cb');

const CATEGORY_MAP = {};
wardrobeStore.CATEGORIES.forEach(function (c) { CATEGORY_MAP[c.key] = c; });

const MODE_KEY = 'wardrobe.mode';
const ACC_MAX = 2;

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function defaultName() {
  const d = new Date();
  return '搭配 ' + (d.getMonth() + 1) + '月' + d.getDate() + '日 '
    + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function persistFile(tempFilePath, ext) {
  const fs = wx.getFileSystemManager();
  const dest = wx.env.USER_DATA_PATH + '/outfit_' + Date.now() + '_'
    + Math.random().toString(36).slice(2, 7) + '.' + (ext || 'jpg');
  try {
    fs.copyFileSync(tempFilePath, dest);
    return dest;
  } catch (e) {
    console.error('[outfit] 保存本地搭配图失败:', (e && e.message) || e);
    return tempFilePath;
  }
}

function unlinkQuiet(filePath) {
  if (!filePath || filePath.indexOf(wx.env.USER_DATA_PATH) !== 0) return;
  try { wx.getFileSystemManager().unlinkSync(filePath); } catch (e) { /* ignore */ }
}

Page({
  data: {
    groups: [],
    selection: { top: '', bottom: '', shoes: '', bag: '', accessory: [] },
    preview: '',
    generating: true,
    previewError: false,
    canvasOk: true,
    saving: false,
    missing: [],
    missingText: '',
    canSave: false
  },

  onLoad() {
    this._previewToken = 0;
    this._renderChain = Promise.resolve();
    this.loadCandidates();
  },

  onReady() {
    wx.createSelectorQuery().in(this)
      .select('#outfitCanvas').fields({ node: true, size: true })
      .exec((res) => {
        const canvas = res && res[0] && res[0].node;
        if (!canvas) {
          this.setData({ canvasOk: false, generating: false, previewError: true });
          return;
        }
        this._canvas = canvas;
        this.setData({ canvasOk: true });
        this.schedulePreview();
      });
  },

  onShow() {
    if (this._shown) {
      this.loadCandidates();
      this.schedulePreview();
    }
    this._shown = true;
  },

  // ---------- 候选衣物 ----------

  loadCandidates() {
    const base = [
      { key: 'top', title: '上装 / 外套', tip: '必选', addCategory: 'top', items: [] },
      { key: 'bottom', title: '下装', tip: '必选', addCategory: 'bottom', items: [] },
      { key: 'shoes', title: '鞋', tip: '必选', addCategory: 'shoes', items: [] },
      { key: 'bag', title: '包', tip: '可选 · 最多 1 件', addCategory: 'bag', items: [] },
      { key: 'accessory', title: '配饰', tip: '可选 · 最多 2 件', addCategory: 'accessory', items: [] }
    ];
    const index = {};
    base.forEach(function (g) { index[g.key] = g; });

    wardrobeStore.list().forEach(function (e) {
      const cat = CATEGORY_MAP[e.category];
      if (!cat) return;
      const view = {
        id: e.id,
        name: e.name,
        category: e.category,
        emoji: cat.emoji,
        display: (e.photo && e.photo.local) || '',
        fileID: (e.photo && e.photo.fileID) || ''
      };
      if (e.category === 'top' || e.category === 'outer') index.top.items.push(view);
      else if (index[e.category]) index[e.category].items.push(view);
    });

    this._baseGroups = base;
    const sel = this.data.selection;
    // 清理已不存在的选择
    const valid = {};
    base.forEach(function (g) {
      g.items.forEach(function (it) { valid[it.id] = true; });
    });
    if (sel.top && !valid[sel.top]) sel.top = '';
    if (sel.bottom && !valid[sel.bottom]) sel.bottom = '';
    if (sel.shoes && !valid[sel.shoes]) sel.shoes = '';
    if (sel.bag && !valid[sel.bag]) sel.bag = '';
    sel.accessory = (sel.accessory || []).filter(function (id) { return valid[id]; });
    this.setData({ selection: sel });

    this.applyGroups();
    this.fillRemoteUrls();
  },

  applyGroups() {
    const sel = this.data.selection;
    const groups = this._baseGroups.map(function (g) {
      return Object.assign({}, g, {
        items: g.items.map(function (it) {
          const selected = g.key === 'accessory'
            ? sel.accessory.indexOf(it.id) >= 0
            : sel[g.key] === it.id;
          return Object.assign({}, it, { selected: selected });
        })
      });
    });
    this.setData({ groups: groups });
    this.updateSaveState();
  },

  /** 本机没有图、只有 fileID 的，换临时链接（新设备场景） */
  fillRemoteUrls() {
    const need = [];
    (this._baseGroups || []).forEach(function (g) {
      g.items.forEach(function (it) {
        if (!it.display && it.fileID && need.indexOf(it.fileID) < 0) need.push(it.fileID);
      });
    });
    if (!need.length) return;

    const chunks = [];
    for (let i = 0; i < need.length; i += 20) chunks.push(need.slice(i, i + 20));
    let chain = Promise.resolve();
    chunks.forEach((chunk) => {
      chain = chain.then(() => cb.getFileUrls(chunk)).then((map) => {
        if (!map || !Object.keys(map).length) return;
        this._baseGroups.forEach(function (g) {
          g.items.forEach(function (it) {
            if (!it.display && map[it.fileID]) it.display = map[it.fileID];
          });
        });
        this.applyGroups();
        this.schedulePreview();
      });
    });
    chain.catch(() => { /* 用占位继续 */ });
  },

  // ---------- 选择 ----------

  onPick(e) {
    const group = e.currentTarget.dataset.group;
    const id = e.currentTarget.dataset.id;
    if (!group || !id) return;
    const sel = Object.assign({}, this.data.selection);
    if (group === 'accessory') {
      const arr = (sel.accessory || []).slice();
      const i = arr.indexOf(id);
      if (i >= 0) arr.splice(i, 1);
      else if (arr.length >= ACC_MAX) {
        wx.showToast({ title: '配饰最多 ' + ACC_MAX + ' 件', icon: 'none' });
        return;
      } else {
        arr.push(id);
      }
      sel.accessory = arr;
    } else {
      sel[group] = sel[group] === id ? '' : id;
    }
    this.setData({ selection: sel }, () => {
      this.applyGroups();
      this.schedulePreview();
    });
  },

  onGoAdd(e) {
    const cat = e.currentTarget.dataset.cat;
    wx.navigateTo({ url: '/pages/wardrobe/edit/edit?category=' + encodeURIComponent(cat || '') });
  },

  // ---------- 预览 ----------

  updateSaveState() {
    const sel = this.data.selection;
    const missing = [];
    if (!sel.top) missing.push('上装');
    if (!sel.bottom) missing.push('下装');
    if (!sel.shoes) missing.push('鞋');
    const canSave = !missing.length && !!this.data.preview
      && !this.data.generating && !this.data.saving;
    this.setData({
      missing: missing,
      missingText: missing.join('、'),
      canSave: canSave
    });
  },

  buildModel() {
    const map = {};
    (this._baseGroups || []).forEach(function (g) {
      g.items.forEach(function (it) { map[it.id] = it; });
    });
    const sel = this.data.selection;
    function pick(id) {
      const it = map[id];
      if (!it) return null;
      return { id: it.id, src: it.display, emoji: it.emoji };
    }
    return {
      top: pick(sel.top),
      bottom: pick(sel.bottom),
      shoes: pick(sel.shoes),
      bag: pick(sel.bag),
      accessories: (sel.accessory || []).map(pick).filter(Boolean)
    };
  },

  schedulePreview() {
    if (!this._canvas) return;
    this.setData({ generating: true, previewError: false }, () => this.updateSaveState());
    clearTimeout(this._previewTimer);
    this._previewTimer = setTimeout(() => { this.queueRender(); }, 100);
  },

  queueRender() {
    if (!this._canvas) return;
    const token = (this._previewToken || 0) + 1;
    this._previewToken = token;
    const model = this.buildModel();
    // 串行执行，避免两次渲染同时改写画布尺寸
    this._renderChain = (this._renderChain || Promise.resolve()).catch(function () {}).then(() => {
      if (token !== this._previewToken) return '';
      return outfitRender.renderOutfit(this._canvas, model);
    });
    this._renderChain.then((path) => {
      if (!path || token !== this._previewToken) return;
      this.setData({ preview: path, generating: false, previewError: false });
      this.updateSaveState();
    }).catch((err) => {
      console.error('[outfit] 预览生成失败:', (err && err.message) || err);
      if (token !== this._previewToken) return;
      this.setData({ generating: false, previewError: true });
      this.updateSaveState();
    });
  },

  onRetryPreview() {
    this.schedulePreview();
  },

  // ---------- 保存 ----------

  buildSnapshot() {
    const map = {};
    (this._baseGroups || []).forEach(function (g) {
      g.items.forEach(function (it) { map[it.id] = it; });
    });
    const sel = this.data.selection;
    const ids = [sel.top, sel.bottom, sel.shoes, sel.bag].concat(sel.accessory || []);
    const out = [];
    ids.forEach(function (id) {
      if (!id || !map[id]) return;
      out.push({ id: map[id].id, name: map[id].name, category: map[id].category });
    });
    return out;
  },

  onSave() {
    if (this.data.saving) return;
    if (this.data.generating) {
      wx.showToast({ title: '预览生成中，请稍候', icon: 'none' });
      return;
    }
    if (this.data.missing.length) {
      wx.showToast({ title: '还缺：' + this.data.missingText, icon: 'none' });
      return;
    }
    if (!this.data.preview || this.data.previewError) {
      wx.showToast({ title: '预览还未生成', icon: 'none' });
      return;
    }

    const def = defaultName();
    wx.showModal({
      title: '保存搭配',
      editable: true,
      content: def,
      placeholderText: def,
      confirmText: '保存',
      success: (r) => {
        if (!r.confirm) return;
        const name = String(r.content || '').trim().slice(0, outfitStore.NAME_MAX) || def;
        this.saveOutfit(name);
      }
    });
  },

  saveOutfit(name) {
    if (this.data.saving) return;
    this.setData({ saving: true });
    const local = persistFile(this.data.preview, 'jpg');
    cb.uploadImage(local).then((up) => {
      const saved = outfitStore.save({
        name: name,
        image: { fileID: up ? up.fileID : '', local: local, failed: !up },
        items: this.buildSnapshot()
      });
      this.setData({ saving: false });
      if (!saved) {
        wx.showToast({ title: '保存失败', icon: 'none' });
        return;
      }
      try { wx.setStorageSync(MODE_KEY, 'outfits'); } catch (e) { /* ignore */ }
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => { wx.navigateBack({ delta: 1 }); }, 400);
    }).catch(() => {
      this.setData({ saving: false });
      wx.showToast({ title: '保存失败', icon: 'none' });
      unlinkQuiet(local);
    });
  }
});
