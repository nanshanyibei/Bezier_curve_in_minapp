/**
 * 日记存储
 * - 本地 storage（key: diary.entries）作离线缓存：{ entries: [{ date, text, updatedAt }] }
 * - 云端 diaries 集合（经云函数 wxauth 网关，按 openid 隔离），_id = date
 * - 写：本地即时生效 → 异步推云端；读：本地优先，pullCloud() 按 updatedAt 新者胜合并
 */
const cb = require('./cb');

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

/** 保存（按日期 upsert）；空内容 = 删除 */
function save(date, text) {
  const entries = loadAll();
  const trimmed = (text || '').trim();
  const idx = entries.findIndex(function (e) { return e.date === date; });
  if (!trimmed) {
    if (idx >= 0) entries.splice(idx, 1);
  } else if (idx >= 0) {
    entries[idx].text = trimmed;
    entries[idx].updatedAt = Date.now();
  } else {
    entries.push({ date: date, text: trimmed, updatedAt: Date.now() });
  }
  saveAll(entries);

  // 异步推云端（失败静默，下次 pullCloud 兜底）
  if (!trimmed) {
    cb.removeDoc('diaries', date);
  } else {
    const cur = entries.find(function (e) { return e.date === date; });
    cb.setDoc('diaries', date, {
      date: date,
      text: trimmed,
      updatedAt: (cur && cur.updatedAt) || Date.now()
    });
  }
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

/**
 * 拉云端日记并按 updatedAt 新者胜合并，返回 { entries, changed }
 * 云端不可用时 changed = false
 */
function pullCloud() {
  return cb.listDocs('diaries').then(function (list) {
    if (!list || !list.length) return { entries: loadAll(), changed: false };
    const map = {};
    loadAll().forEach(function (e) { if (e && e.date) map[e.date] = e; });
    let changed = false;
    list.forEach(function (d) {
      if (!d || !d.date) return;
      const remote = { date: d.date, text: d.text || '', updatedAt: d.updatedAt || 0 };
      const cur = map[remote.date];
      if (cur && (cur.updatedAt || 0) >= remote.updatedAt) return;
      if (!remote.text) {
        if (cur) { delete map[remote.date]; changed = true; }
        return;
      }
      map[remote.date] = remote;
      changed = true;
    });
    if (changed) {
      saveAll(Object.keys(map).map(function (k) { return map[k]; }));
    }
    return { entries: loadAll(), changed: changed };
  }).catch(function () {
    return { entries: loadAll(), changed: false };
  });
}

module.exports = { KEY, today, list, save, get, getRange, stats, pullCloud };
