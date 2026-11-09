/**
 * 日记本地存储（wx.setStorageSync）
 * 结构：{ entries: [{ date: 'YYYY-MM-DD', text: '...', updatedAt: ts }] }
 */

const KEY = 'diary.entries';

function loadAll() {
  const data = wx.getStorageSync(KEY);
  if (data && Array.isArray(data.entries)) return data.entries;
  return [];
}

function saveAll(entries) {
  wx.setStorageSync(KEY, { entries: entries });
}

/** 今天日期 YYYY-MM-DD */
function today() {
  const d = new Date();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

/** 按日期倒序的全部日记 */
function list() {
  return loadAll().slice().sort(function (a, b) {
    return a.date < b.date ? 1 : -1;
  });
}

/** 保存（按日期 upsert） */
function save(date, text) {
  const entries = loadAll();
  const trimmed = (text || '').trim();
  const idx = entries.findIndex(function (e) { return e.date === date; });
  if (!trimmed) {
    // 空内容 = 删除
    if (idx >= 0) entries.splice(idx, 1);
  } else if (idx >= 0) {
    entries[idx].text = trimmed;
    entries[idx].updatedAt = Date.now();
  } else {
    entries.push({ date: date, text: trimmed, updatedAt: Date.now() });
  }
  saveAll(entries);
}

function get(date) {
  const hit = loadAll().find(function (e) { return e.date === date; });
  return hit ? hit.text : '';
}

/** 最近 days 天有内容的日记（旧→新，供回顾与导出） */
function getRange(days) {
  const from = new Date();
  from.setDate(from.getDate() - days + 1);
  const fromStr = from.getFullYear() + '-' +
    String(from.getMonth() + 1).padStart(2, '0') + '-' +
    String(from.getDate()).padStart(2, '0');
  return loadAll()
    .filter(function (e) { return e.date >= fromStr && e.text; })
    .sort(function (a, b) { return a.date < b.date ? -1 : 1; })
    .map(function (e) { return { date: e.date, text: e.text }; });
}

/** 统计：总篇数、总字数 */
function stats() {
  const entries = loadAll().filter(function (e) { return e.text; });
  let chars = 0;
  entries.forEach(function (e) { chars += e.text.length; });
  return { count: entries.length, chars: chars };
}

module.exports = { KEY, today, list, save, get, getRange, stats };
