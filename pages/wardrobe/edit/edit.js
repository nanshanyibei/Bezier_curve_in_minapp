/**
 * 衣物编辑页
 * 路由：pages/wardrobe/edit/edit[?id=xxx]
 *
 * 关键设计：
 * - 选图后在本地做白底/去背景处理，再上传；处理失败自动回退原图，不阻断保存。
 * - 原图（orig）只保留在本次编辑会话，处理后生成新的本地 JPG 再上传换 fileID。
 * - 上传失败只标 failed，不影响保存与本地展示；替换/删除时清理旧本地与云文件。
 * - 名称必填；处理或上传未完成时拦截保存，避免云端缺图。
 */
const wardrobeStore = require('../../../utils/wardrobeStore');
const cb = require('../../../utils/cb');
const photoClean = require('../../../utils/photoClean');

const MODE_KEY = 'wardrobe.bgMode';
const BG_MODES = [
  { key: photoClean.MODES.CUTOUT, label: '智能去背景' },
  { key: photoClean.MODES.WHITE, label: '白底美化' },
  { key: photoClean.MODES.ORIGINAL, label: '原图' }
];

/** 从路径猜扩展名（保留 PNG 的透明通道） */
function extOf(filePath) {
  const m = /\.([A-Za-z0-9]+)(?:\?|$)/.exec(String(filePath || ''));
  const e = m ? m[1].toLowerCase() : 'jpg';
  return /^(jpg|jpeg|png|webp)$/.test(e) ? e : 'jpg';
}

/** 本地永久化：临时路径重启即失效，必须 copy 到 USER_DATA_PATH */
function persistFile(tempFilePath, ext) {
  const fs = wx.getFileSystemManager();
  const dest = wx.env.USER_DATA_PATH + '/wardrobe_' + Date.now() + '_'
    + Math.random().toString(36).slice(2, 7) + '.' + (ext || 'jpg');
  try {
    fs.copyFileSync(tempFilePath, dest);
    return dest;
  } catch (e) {
    console.error('[wardrobe] 保存本地图片失败:', (e && e.message) || e);
    return tempFilePath; // 兜底用临时路径，本次会话仍可见
  }
}

function unlinkQuiet(filePath) {
  if (!filePath || filePath.indexOf(wx.env.USER_DATA_PATH) !== 0) return;
  try { wx.getFileSystemManager().unlinkSync(filePath); } catch (e) { /* 已删或不存在 */ }
}

/** 压缩（失败就用原图，不阻断流程） */
function compressFile(src, quality) {
  return new Promise((resolve) => {
    if (typeof wx.compressImage !== 'function') return resolve('');
    wx.compressImage({
      src: src,
      quality: quality || 78,
      success: (res) => resolve((res && res.tempFilePath) || ''),
      fail: () => resolve('')
    });
  });
}

function readMode() {
  let m = '';
  try { m = wx.getStorageSync(MODE_KEY); } catch (e) { /* ignore */ }
  return (m === photoClean.MODES.CUTOUT || m === photoClean.MODES.WHITE
    || m === photoClean.MODES.ORIGINAL) ? m : photoClean.MODES.CUTOUT;
}

Page({
  data: {
    id: '',
    isEdit: false,
    name: '',
    category: 'top',
    color: '',
    season: 'all',
    note: '',
    noteCount: 0,
    photo: null,              // { orig, local, fileID, display, processing, uploading, failed }
    bgModes: BG_MODES,
    bgMode: photoClean.MODES.CUTOUT,
    canvasOk: true,
    categories: wardrobeStore.CATEGORIES,
    seasons: wardrobeStore.SEASONS,
    nameMax: wardrobeStore.NAME_MAX,
    colorMax: wardrobeStore.COLOR_MAX,
    noteMax: wardrobeStore.NOTE_MAX,
    saving: false
  },

  onLoad(options) {
    this._photoToken = 0; // 防止图片异步流程在删除/重选后回写旧状态
    const patch = { bgMode: readMode() };
    // 从「新建搭配」的缺衣提示跳转过来时，默认选中对应分类
    if (options && options.category
      && wardrobeStore.CATEGORIES.some(function (c) { return c.key === options.category; })) {
      patch.category = options.category;
    }
    if (options && options.id) {
      const hit = wardrobeStore.get(options.id);
      if (hit) {
        patch.id = hit.id;
        patch.isEdit = true;
        patch.name = hit.name;
        patch.category = hit.category;
        patch.color = hit.color;
        patch.season = hit.season;
        patch.note = hit.note;
        patch.noteCount = hit.note.length;
        if (hit.photo) {
          patch.photo = {
            orig: hit.photo.local || '',
            local: hit.photo.local || '',
            fileID: hit.photo.fileID || '',
            display: hit.photo.local || '',
            processing: false,
            uploading: false,
            failed: false
          };
        }
      }
    }
    this.setData(patch);
    wx.setNavigationBarTitle({ title: patch.isEdit ? '编辑衣物' : '添加衣物' });
    this.fillRemoteUrl();
  },

  onReady() {
    wx.createSelectorQuery().in(this)
      .select('#workCanvas').fields({ node: true, size: true })
      .select('#outCanvas').fields({ node: true, size: true })
      .exec((res) => {
        const work = res && res[0] && res[0].node;
        const out = res && res[1] && res[1].node;
        if (!work || !out) {
          this.setData({ canvasOk: false });
          return;
        }
        this._workCanvas = work;
        this._outCanvas = out;
        this.setData({ canvasOk: true });
      });
  },

  /** 换设备/重装后本地无图，用 fileID 换临时链接展示 */
  fillRemoteUrl() {
    const p = this.data.photo;
    if (!p || p.display || !p.fileID) return;
    cb.getFileUrls([p.fileID]).then((map) => {
      const cur = this.data.photo;
      if (!cur || cur.display || !map[p.fileID]) return;
      this.setData({ photo: Object.assign({}, cur, { display: map[p.fileID] }) });
    });
  },

  // ---------- 表单 ----------

  onNameInput(e) {
    this.setData({ name: e.detail.value });
  },

  onColorInput(e) {
    this.setData({ color: e.detail.value });
  },

  onNoteInput(e) {
    const v = e.detail.value || '';
    this.setData({ note: v, noteCount: v.length });
  },

  onPickCategory(e) {
    const k = e.currentTarget.dataset.k;
    if (!k || k === this.data.category) return;
    this.setData({ category: k });
  },

  onPickSeason(e) {
    const k = e.currentTarget.dataset.k;
    if (!k || k === this.data.season) return;
    this.setData({ season: k });
  },

  // ---------- 照片 ----------

  onPickPhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const f = (res.tempFiles || [])[0];
        if (f && f.tempFilePath) this.setPhotoFromTemp(f.tempFilePath);
      }
    });
  },

  /** 处理方式切换：从原图重算，不重新选图 */
  onPickMode(e) {
    const k = e.currentTarget.dataset.k;
    if (!k || k === this.data.bgMode) return;
    this.setData({ bgMode: k });
    try { wx.setStorageSync(MODE_KEY, k); } catch (err) { /* ignore */ }

    const p = this.data.photo;
    if (!p || !p.orig) return;
    const token = (this._photoToken || 0) + 1;
    this._photoToken = token;
    this.setData({ photo: Object.assign({}, p, { processing: true, failed: false }) });
    this.runProcess(token);
  },

  /** 选图入口：先落原图，再按当前模式处理 */
  setPhotoFromTemp(tempPath) {
    if (!tempPath) return;
    const token = (this._photoToken || 0) + 1;
    this._photoToken = token;

    const prev = this.data.photo;
    if (prev) {
      // 已上传过的本地图保留到新图上传成功后再清理，避免中途退出导致列表图裂开
      if (prev.orig && prev.orig !== prev.local) unlinkQuiet(prev.orig);
      if (!prev.fileID && prev.local) unlinkQuiet(prev.local);
    }

    const orig = persistFile(tempPath, extOf(tempPath));
    this.setData({
      photo: {
        orig: orig,
        local: '',
        fileID: (prev && prev.fileID) || '', // 保留旧 fileID，新图上传成功后再删
        display: orig,
        processing: true,
        uploading: false,
        failed: false
      }
    });
    this.runProcess(token);
  },

  /** 按当前模式处理，成功后上传 */
  runProcess(token) {
    const p = this.data.photo;
    if (!p || !p.orig || token !== this._photoToken) return;
    const mode = this.data.bgMode;
    const prevFileID = p.fileID || '';
    const prevLocal = p.local || '';

    if (mode === photoClean.MODES.ORIGINAL || !this.data.canvasOk) {
      this.finalizeOriginal(token);
      return;
    }

    photoClean.processImage({
      src: p.orig,
      mode: mode,
      workCanvas: this._workCanvas,
      outCanvas: this._outCanvas
    }).then((res) => {
      if (token !== this._photoToken) return;
      const finalLocal = persistFile(res.path, 'jpg');
      this.setData({
        photo: Object.assign({}, this.data.photo, {
          local: finalLocal,
          display: finalLocal,
          processing: false
        })
      });
      if (res.fallback) {
        wx.showToast({ title: '背景较复杂，已改用白底', icon: 'none' });
      }
      this.uploadFinal(token, finalLocal, prevFileID, prevLocal);
    }).catch((err) => {
      console.error('[wardrobe] 图片处理失败:', (err && err.message) || err);
      if (token !== this._photoToken) return;
      wx.showToast({ title: '处理失败，已改用原图', icon: 'none' });
      this.finalizeOriginal(token);
    });
  },

  /** 原图 / 处理失败兜底：压缩后直接上传 */
  finalizeOriginal(token) {
    const p = this.data.photo;
    if (!p || !p.orig || token !== this._photoToken) return;
    const prevFileID = p.fileID || '';
    const prevLocal = p.local || '';
    compressFile(p.orig).then((compressed) => {
      if (token !== this._photoToken) return;
      const finalLocal = compressed ? persistFile(compressed, 'jpg') : p.orig;
      this.setData({
        photo: Object.assign({}, this.data.photo, {
          local: finalLocal,
          display: finalLocal,
          processing: false
        })
      });
      this.uploadFinal(token, finalLocal, prevFileID, prevLocal);
    }).catch(() => {
      if (token !== this._photoToken) return;
      this.setData({
        photo: Object.assign({}, this.data.photo, {
          local: p.orig,
          display: p.orig,
          processing: false
        })
      });
      this.uploadFinal(token, p.orig, prevFileID, prevLocal);
    });
  },

  /** 上传最终本地图；成功后清理被替换的旧云文件与旧本地图 */
  uploadFinal(token, local, prevFileID, prevLocal) {
    if (token !== this._photoToken || !local) return;
    this.setData({
      photo: Object.assign({}, this.data.photo, { uploading: true, failed: false })
    });
    cb.uploadImage(local).then((up) => {
      if (token !== this._photoToken) return;
      this.setData({
        photo: Object.assign({}, this.data.photo, {
          uploading: false,
          failed: !up,
          fileID: up ? up.fileID : ''
        })
      });
      if (up) {
        if (prevFileID && prevFileID !== up.fileID) cb.deleteFiles([prevFileID]);
        if (prevLocal && prevLocal !== local) unlinkQuiet(prevLocal);
      }
    });
  },

  onRetryPhoto() {
    const p = this.data.photo;
    if (!p || p.processing || p.uploading) return;
    const token = (this._photoToken || 0) + 1;
    this._photoToken = token;
    if (p.local) {
      this.uploadFinal(token, p.local, p.fileID);
      return;
    }
    if (p.orig) {
      this.setData({ photo: Object.assign({}, p, { processing: true, failed: false }) });
      this.runProcess(token);
      return;
    }
    wx.showToast({ title: '本地文件已丢失', icon: 'none' });
  },

  onRemovePhoto() {
    const p = this.data.photo;
    if (!p) return;
    this._photoToken = (this._photoToken || 0) + 1; // 作废仍在进行的处理/上传
    this.setData({ photo: null });
    if (p.local) unlinkQuiet(p.local);
    if (p.orig && p.orig !== p.local) unlinkQuiet(p.orig);
    if (p.fileID) cb.deleteFiles([p.fileID]);
  },

  onPreview() {
    const p = this.data.photo;
    if (!p || !p.display) return;
    wx.previewImage({ current: p.display, urls: [p.display] });
  },

  // ---------- 保存 / 删除 ----------

  onSave() {
    if (this.data.saving) return;
    const name = (this.data.name || '').trim();
    if (!name) {
      wx.showToast({ title: '给衣物起个名字', icon: 'none' });
      return;
    }
    const p = this.data.photo;
    if (p && (p.processing || p.uploading)) {
      wx.showToast({ title: '图片处理中，请稍候', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    const saved = wardrobeStore.save({
      id: this.data.id || '',
      name: name,
      category: this.data.category,
      color: this.data.color,
      season: this.data.season,
      note: this.data.note,
      photo: p ? { fileID: p.fileID || '', local: p.local || '', failed: !p.fileID } : null
    });
    this.setData({ saving: false });
    if (!saved) {
      wx.showToast({ title: '保存失败', icon: 'none' });
      return;
    }
    wx.showToast({ title: '已保存', icon: 'success' });
    setTimeout(() => { wx.navigateBack({ delta: 1 }); }, 400);
  },

  onDelete() {
    if (!this.data.id) return;
    wx.showModal({
      title: '删除这件衣物',
      content: '照片和记录都会删掉，无法恢复。',
      confirmText: '删除',
      confirmColor: '#ef7d7d',
      success: (r) => {
        if (!r.confirm) return;
        const p = this.data.photo;
        wardrobeStore.remove(this.data.id);
        if (p) {
          if (p.local) unlinkQuiet(p.local);
          if (p.orig && p.orig !== p.local) unlinkQuiet(p.orig);
        }
        wx.showToast({ title: '已删除', icon: 'none' });
        setTimeout(() => { wx.navigateBack({ delta: 1 }); }, 300);
      }
    });
  }
});
