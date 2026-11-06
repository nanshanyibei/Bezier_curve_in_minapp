/**
 * 旅行标记本地存储（key: travel.marks）
 * 结构 v2：{ v: 2, marks: { [adcode]: { status, name, center:[lon,lat] } }, updatedAt }
 * v1（字符串值）自动迁移；center 用于全国视图足迹打点。
 */
const KEY = 'travel.marks';

function loadAll() {
  const d = wx.getStorageSync(KEY);
  if (d && d.v === 2 && d.marks && typeof d.marks === 'object') return d;
  if (d && d.v === 1 && d.marks && typeof d.marks === 'object') {
    const migrated = {};
    Object.keys(d.marks).forEach((k) => {
      const val = d.marks[k];
      migrated[k] = typeof val === 'string'
        ? { status: val, name: '', center: null }
        : val;
    });
    return { v: 2, marks: migrated, updatedAt: d.updatedAt || 0 };
  }
  return { v: 2, marks: {} };
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
  if (status) {
    const prev = d.marks[key] || {};
    d.marks[key] = {
      status: status,
      name: (meta && meta.name) || prev.name || '',
      center: (meta && meta.center) || prev.center || null
    };
  } else {
    delete d.marks[key];
  }
  d.updatedAt = Date.now();
  wx.setStorageSync(KEY, d);
  return d.marks;
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

module.exports = { KEY, getAll, get, set, stats, clear };
