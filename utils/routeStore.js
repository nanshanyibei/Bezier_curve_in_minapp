/**
 * 路线存储（key: travel.routes）
 * 结构 v1：{ v:1, routes:[{ id, name, status, stops:[{adcode,name,center}], hidden, createdAt, updatedAt }], updatedAt }
 * - 本地优先，所有操作即时落 storage，离线完全可用
 * - M1 无云端同步（M4 规划接 CloudBase routes 集合，整文档 updatedAt 新者胜）
 * - stops 自带 center（选点时从图层 region.centerLL 取），渲染/里程不依赖图层查询
 * - status: 'plan'（规划中，虚线）| 'done'（已走完，实线）；hidden 为本地显隐态
 */
const KEY = 'travel.routes';
const geoRoute = require('./geoRoute');

function loadAll() {
  const d = wx.getStorageSync(KEY);
  if (d && d.v === 1 && Array.isArray(d.routes)) return d;
  return { v: 1, routes: [], updatedAt: 0 };
}

function save(d) {
  d.updatedAt = Date.now();
  wx.setStorageSync(KEY, d);
}

function getAll() {
  return loadAll().routes;
}

/** 供渲染：未被隐藏的路线 */
function visible() {
  return getAll().filter((r) => !r.hidden);
}

/** 列表数据：按创建时间倒序 + 城市数/直线里程摘要 */
function list() {
  return getAll()
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      hidden: !!r.hidden,
      count: r.stops.length,
      km: totalKm(r.stops),
      // 城市串联路径（缺名的老数据用 adcode 兜底）
      path: r.stops.map((s) => s.name || s.adcode).join(' → ')
    }));
}

/** 相邻站点直线里程合计（缺 center 的站点跳过该段），取整 */
function totalKm(stops) {
  let sum = 0;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1].center;
    const b = stops[i].center;
    if (a && b) sum += geoRoute.haversineKm(a, b);
  }
  return Math.round(sum);
}

function formatDate(now) {
  const t = new Date(now);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
}

/** 创建路线；stops: [{ adcode, name, center:[lon,lat] }]，返回新路线 */
function create(name, stops) {
  const d = loadAll();
  const now = Date.now();
  const r = {
    id: 'r' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    name: name || ('路线 ' + formatDate(now)),
    status: 'plan',
    stops: (stops || []).map((s) => ({
      adcode: String(s.adcode),
      name: s.name || '',
      center: s.center || null
    })),
    hidden: false,
    createdAt: now,
    updatedAt: now
  };
  d.routes.push(r);
  save(d);
  return r;
}

function remove(id) {
  const d = loadAll();
  const i = d.routes.findIndex((r) => r.id === id);
  if (i < 0) return false;
  d.routes.splice(i, 1);
  save(d);
  return true;
}

/** 地图显隐（本地态） */
function setHidden(id, hidden) {
  const d = loadAll();
  const r = d.routes.find((x) => x.id === id);
  if (!r) return false;
  r.hidden = !!hidden;
  save(d);
  return true;
}

module.exports = { KEY, getAll, visible, list, totalKm, create, remove, setHidden };
