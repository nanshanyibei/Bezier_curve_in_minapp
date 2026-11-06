/**
 * 旅行标记本地存储（key: travel.marks）
 * 结构：{ v: 1, marks: { [adcode]: 'visited' | 'want' }, updatedAt }
 */
const KEY = 'travel.marks';

function loadAll() {
  const d = wx.getStorageSync(KEY);
  if (d && d.v === 1 && d.marks && typeof d.marks === 'object') return d;
  return { v: 1, marks: {} };
}

function getAll() {
  return loadAll().marks;
}

function get(adcode) {
  return loadAll().marks[String(adcode)] || '';
}

/** status 传空串 = 删除标记；返回最新 marks */
function set(adcode, status) {
  const d = loadAll();
  const key = String(adcode);
  if (status) d.marks[key] = status;
  else delete d.marks[key];
  d.updatedAt = Date.now();
  wx.setStorageSync(KEY, d);
  return d.marks;
}

function stats() {
  const marks = getAll();
  let visited = 0;
  let want = 0;
  Object.keys(marks).forEach((k) => {
    if (marks[k] === 'visited') visited++;
    else if (marks[k] === 'want') want++;
  });
  return { visited: visited, want: want };
}

function clear() {
  wx.removeStorageSync(KEY);
}

module.exports = { KEY, getAll, get, set, stats, clear };
