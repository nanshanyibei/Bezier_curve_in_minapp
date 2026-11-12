/**
 * 城市回忆编辑页
 * 路由：pages/travel/memory/edit/edit?adcode=330100&name=杭州&plan=1[&id=xxx]
 *
 * 关键设计：
 * - 图片先 copyFile 落到 USER_DATA_PATH（永久），再异步上传换 fileID；
 *   上传失败只标 failed，不影响保存与展示（本地路径仍可看图）。
 * - 草稿按 adcode + id 分开存，退出再进能恢复；保存成功后清掉。
 * - 日期是「旅行日期」，不是同步时间，不能选未来。
 */
const memoryStore = require('../../../../utils/memoryStore');
const cb = require('../../../../utils/cb');

const DRAFT_PREFIX = 'memory.draft.';

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** 本地永久化：临时路径重启即失效，必须 copy 到 USER_DATA_PATH */
function persistFile(tempFilePath, ext) {
  const fs = wx.getFileSystemManager();
  const dest = wx.env.USER_DATA_PATH + '/mem_' + Date.now() + '_'
    + Math.random().toString(36).slice(2, 7) + '.' + (ext || 'jpg');
  try {
    fs.copyFileSync(tempFilePath, dest);
    return dest;
  } catch (e) {
    console.error('[memory] 保存本地图片失败:', (e && e.message) || e);
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

Page({
  data: {
    adcode: '',
    cityName: '',
    plan: false,             // 想去 = 计划，UI 与真实回忆区分
    id: '',
    isEdit: false,
    date: '',
    today: '',
    title: '',
    text: '',
    textCount: 0,
    photos: [],              // [{ key, local, fileID, display, uploading, failed }]
    maxPhotos: 9,
    maxText: 5000,
    saving: false
  },

  _dirty: false,
  _saved: false,

  onLoad(options) {
    const adcode = String(options.adcode || '');
    const today = memoryStore.today();
    const patch = {
      adcode: adcode,
      cityName: decodeURIComponent(options.name || '') || adcode,
      plan: options.plan === '1',
      today: today,
      date: today
    };

    if (options.id) {
      const hit = memoryStore.get(options.id);
      if (hit) {
        patch.id = hit.id;
        patch.isEdit = true;
        patch.date = hit.date;
        patch.title = hit.title;
        patch.text = hit.text;
        patch.textCount = hit.text.length;
        patch.photos = (hit.photos || []).map((p, i) => ({
          key: 's' + i,
          local: p.local || '',
          fileID: p.fileID || '',
          display: p.local || '',
          uploading: false,
          failed: !p.fileID
        }));
      }
    } else {
      patch.id = '';
    }

    // 草稿按 adcode + id 分开存，编辑态也能恢复未完成的修改
    const draft = this.readDraft(adcode, patch.id || 'new');
    if (draft) {
      patch.date = draft.date || today;
      patch.title = draft.title || '';
      patch.text = draft.text || '';
      patch.textCount = (draft.text || '').length;
      patch.photos = (draft.photos || []).map((p, i) => ({
        key: 'd' + i,
        local: p.local || '',
        fileID: p.fileID || '',
        display: p.local || '',
        uploading: false,
        failed: !p.fileID
      }));
      wx.showToast({ title: '已恢复未完成的草稿', icon: 'none' });
    }

    this.setData(patch);
    this.fillRemoteUrls();
    wx.setNavigationBarTitle({ title: patch.isEdit ? '编辑回忆' : '写下回忆' });
  },

  /** 有 fileID 没本地图的（换设备/重装），批量换临时链接 */
  fillRemoteUrls() {
    const need = this.data.photos.filter((p) => !p.local && p.fileID).map((p) => p.fileID);
    if (!need.length) return;
    cb.getFileUrls(need).then((map) => {
      const photos = this.data.photos.map((p) => {
        if (p.local || !p.fileID || !map[p.fileID]) return p;
        return Object.assign({}, p, { display: map[p.fileID] });
      });
      this.setData({ photos: photos });
    });
  },

  // ---------- 表单 ----------

  onDateChange(e) {
    this.setData({ date: e.detail.value });
    this._dirty = true;
  },

  onTitleInput(e) {
    this.setData({ title: e.detail.value });
    this._dirty = true;
  },

  onTextInput(e) {
    const v = e.detail.value || '';
    this.setData({ text: v, textCount: v.length });
    this._dirty = true;
  },

  // ---------- 图片 ----------

  onAddPhoto() {
    const left = this.data.maxPhotos - this.data.photos.length;
    if (left <= 0) {
      wx.showToast({ title: '最多 ' + this.data.maxPhotos + ' 张', icon: 'none' });
      return;
    }
    wx.chooseMedia({
      count: left,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const files = (res.tempFiles || []).slice(0, left);
        files.forEach((f) => this.addOne(f.tempFilePath));
      }
    });
  },

  /** 一张图：落本地 → 压 → 上传，全程不阻塞其它图 */
  addOne(tempFilePath) {
    if (!tempFilePath) return;
    const key = 'p' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
    let local = persistFile(tempFilePath);
    const photos = this.data.photos.concat([{
      key: key, local: local, fileID: '', display: local, uploading: true, failed: false
    }]);
    this.setData({ photos: photos });
    this._dirty = true;

    compressFile(local).then((compressed) => {
      if (!compressed) return local;
      const next = persistFile(compressed);
      if (next && next !== local) {
        unlinkQuiet(local);         // 原图用完即删，省 USER_DATA_PATH 空间
        return next;
      }
      return local;
    }).then((finalLocal) => {
      if (finalLocal !== local) {
        this.patchPhoto(key, { local: finalLocal, display: finalLocal });
        local = finalLocal;
      }
      return cb.uploadImage(local);
    }).then((up) => {
      this.patchPhoto(key, {
        uploading: false,
        failed: !up,
        fileID: up ? up.fileID : ''
      });
    }).catch((err) => {
      console.error('[memory] 图片处理失败:', (err && err.message) || err);
      this.patchPhoto(key, { uploading: false, failed: true });
    });
  },

  patchPhoto(key, fields) {
    const photos = this.data.photos.map((p) => (p.key === key ? Object.assign({}, p, fields) : p));
    this.setData({ photos: photos });
  },

  onRetryPhoto(e) {
    const i = Number(e.currentTarget.dataset.i);
    const p = this.data.photos[i];
    if (!p || p.uploading) return;
    if (!p.local) {
      wx.showToast({ title: '本地文件已丢失', icon: 'none' });
      return;
    }
    this.patchPhoto(p.key, { uploading: true, failed: false });
    cb.uploadImage(p.local).then((up) => {
      this.patchPhoto(p.key, { uploading: false, failed: !up, fileID: up ? up.fileID : '' });
      if (!up) wx.showToast({ title: '上传失败，已存本地', icon: 'none' });
    });
  },

  onRemovePhoto(e) {
    const i = Number(e.currentTarget.dataset.i);
    const p = this.data.photos[i];
    if (!p) return;
    const photos = this.data.photos.slice();
    photos.splice(i, 1);
    this.setData({ photos: photos });
    this._dirty = true;
    unlinkQuiet(p.local);
    if (p.fileID) cb.deleteFiles([p.fileID]);  // 失败静默，容忍孤儿
  },

  onPreview(e) {
    const i = Number(e.currentTarget.dataset.i);
    const p = this.data.photos[i];
    if (!p || !p.display) return;
    const urls = this.data.photos.map((x) => x.display).filter(Boolean);
    wx.previewImage({ current: p.display, urls: urls });
  },

  // ---------- 保存 / 删除 ----------

  onSave() {
    if (this.data.saving) return;
    const text = (this.data.text || '').trim();
    if (!text && !this.data.photos.length) {
      wx.showToast({ title: '写点什么或加张图', icon: 'none' });
      return;
    }
    this.setData({ saving: true });

    const entry = {
      id: this.data.id || '',
      adcode: this.data.adcode,
      cityName: this.data.cityName,
      date: this.data.date,
      title: (this.data.title || '').trim(),
      text: this.data.text || '',
      photos: this.data.photos.map((p) => ({
        fileID: p.fileID || '',
        local: p.local || '',
        failed: !p.fileID
      }))
    };
    const saved = memoryStore.save(entry);
    this.setData({ saving: false });
    if (!saved) {
      wx.showToast({ title: '内容为空，未保存', icon: 'none' });
      return;
    }
    this._saved = true;
    this.clearDraft();
    wx.showToast({ title: '已保存', icon: 'success' });
    setTimeout(() => { wx.navigateBack({ delta: 1 }); }, 500);
  },

  onDelete() {
    if (!this.data.id) return;
    wx.showModal({
      title: '删除这条回忆',
      content: '文字和照片都会删掉，无法恢复。',
      confirmText: '删除',
      confirmColor: '#ef7d7d',
      success: (r) => {
        if (!r.confirm) return;
        memoryStore.remove(this.data.id);
        this.data.photos.forEach((p) => unlinkQuiet(p.local));
        this._saved = true;
        this.clearDraft();
        wx.showToast({ title: '已删除', icon: 'none' });
        setTimeout(() => { wx.navigateBack({ delta: 1 }); }, 400);
      }
    });
  },

  // ---------- 草稿 ----------

  draftKey() {
    return DRAFT_PREFIX + this.data.adcode + '.' + (this.data.id || 'new');
  },

  readDraft(adcode, idKey) {
    try {
      const d = wx.getStorageSync(DRAFT_PREFIX + adcode + '.' + idKey);
      if (d && (d.text || (d.photos && d.photos.length))) return d;
    } catch (e) { /* ignore */ }
    return null;
  },

  writeDraft() {
    if (this._saved) return;
    const hasContent = (this.data.text || '').trim() || this.data.photos.length || (this.data.title || '').trim();
    if (!hasContent) return;
    try {
      wx.setStorageSync(this.draftKey(), {
        date: this.data.date,
        title: this.data.title,
        text: this.data.text,
        photos: this.data.photos.map((p) => ({ local: p.local, fileID: p.fileID })),
        ts: Date.now()
      });
    } catch (e) { /* 空间满放弃草稿，不阻塞 */ }
  },

  clearDraft() {
    try { wx.removeStorageSync(this.draftKey()); } catch (e) { /* ignore */ }
  },

  onHide() {
    this.writeDraft();
  },

  onUnload() {
    this.writeDraft();
  }
});
