/**
 * 旅行标记存储（key: travel.marks）
 * 结构 v3：{ v: 3, marks: { [adcode]: { status, name, center:[lon,lat], updatedAt } }, updatedAt }
 * - 本地优先：所有操作即时落 storage，离线完全可用
 * - 云端同步（CloudBase marks 集合，设备维度 userKey 隔离）：
 *   set() 后异步推送；pullCloud() 拉取并按每条 updatedAt 新者胜合并
 * v1（字符串值）/v2（无 updatedAt）自动迁移
 */
const KEY = 'travel.marks';
const cb = require('./cb');

function migrate(d) {
  if (d && d.v === 3 && d.marks && typeof d.marks === 'object') return d;
  if (d && d.marks && typeof d.marks === 'object') {
    const migrated = {};
    Object.keys(d.marks).forEach((k) => {
      const val = d.marks[k];
      migrated[k] = typeof val === 'string'
        ? { status: val, name: '', center: null, updatedAt: 0 }
        : Object.assign({ updatedAt: 0 }, val);
    });
    return { v: 3, marks: migrated, updatedAt: d.updatedAt || 0 };
  }
  return { v: 3, marks: {} };
}

function loadAll() {
  const d = wx.getStorageSync(KEY);
  return migrate(d);
}

function getAll() {
  return loadAll().marks;
}

function get(adcode) {
  return loadAll().marks[String(adcode)] || null;
}

/** status 传空串 = 删除标记；meta 可带 { name, center }；返回最新 marks */
function set(adcode, status, meta) {
  const d = loadAll();
  const key = String(adcode);
  const now = Date.now();
  if (status) {
    const prev = d.marks[key] || {};
    d.marks[key] = {
      status: status,
      name: (meta && meta.name) || prev.name || '',
      center: (meta && meta.center) || prev.center || null,
      updatedAt: now
    };
  } else {
    delete d.marks[key];
  }
  d.updatedAt = now;
  wx.setStorageSync(KEY, d);

  // 异步推云端（未配置/离线静默失败，靠下次 pullCloud 兜底）
  cb.pushMark({
    adcode: key,
    status: status,
    name: status ? d.marks[key].name : '',
    center: status ? d.marks[key].center : null,
    updatedAt: now
  });
  return d.marks;
}

/**
 * 拉取云端标记并合并（每条按 updatedAt 新者胜），返回 { marks, changed }
 * 云端不可用时 changed = false
 */
function pullCloud() {
  return cb.fetchMarks().then((docs) => {
    if (!docs || !docs.length) return { marks: getAll(), changed: false };
    const d = loadAll();
    let changed = false;
    docs.forEach((doc) => {
      if (!doc || !doc.adcode) return;
      const key = String(doc.adcode);
      const remoteT = doc.updatedAt || 0;
      const local = d.marks[key];
      if (local && (local.updatedAt || 0) >= remoteT) return; // 本地更新，跳过
      if (doc.status) {
        d.marks[key] = {
          status: doc.status,
          name: doc.name || (local && local.name) || '',
          center: doc.center || (local && local.center) || null,
          updatedAt: remoteT
        };
      } else if (local) {
        delete d.marks[key];
      }
      changed = true;
    });
    if (changed) wx.setStorageSync(KEY, d);
    return { marks: d.marks, changed: changed };
  });
}

function stats() {
  const marks = getAll();
  let visited = 0;
  let want = 0;
  Object.keys(marks).forEach((k) => {
    const st = marks[k] && marks[k].status;
    if (st === 'visited') visited++;
    else if (st === 'want') want++;
  });
  return { visited: visited, want: want };
}

function clear() {
  wx.removeStorageSync(KEY);
}

module.exports = { KEY, getAll, get, set, pullCloud, stats, clear };
