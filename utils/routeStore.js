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

/** 取单条路线（原始结构，含 stops） */
function get(id) {
  const r = loadAll().routes.find((x) => x.id === id);
  return r || null;
}

/**
 * 详情视图数据：站点带序号与首尾标记，附里程
 * 站点直接引用 store 内的对象副本，页面改序后拿返回值重渲染即可
 */
function detail(id) {
  const r = get(id);
  if (!r) return null;
  const stops = r.stops.map((s, i) => ({
    adcode: s.adcode,
    name: s.name || s.adcode,
    center: s.center || null,
    no: i + 1,
    isFirst: i === 0,
    isLast: i === r.stops.length - 1
  }));
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    hidden: !!r.hidden,
    count: r.stops.length,
    km: totalKm(r.stops),
    stops: stops
  };
}

/** 重命名：空名回退为原名；限长 20 字 */
function rename(id, name) {
  const trimmed = String(name || '').trim().slice(0, 20);
  if (!trimmed) return null;
  const d = loadAll();
  const r = d.routes.find((x) => x.id === id);
  if (!r) return null;
  r.name = trimmed;
  r.updatedAt = Date.now();
  save(d);
  return detail(id);
}

/** 切换状态：plan ↔ done；返回 { route, became } 供页面判断是否播放打卡动效 */
function setStatus(id, status) {
  const next = status === 'done' ? 'done' : 'plan';
  const d = loadAll();
  const r = d.routes.find((x) => x.id === id);
  if (!r) return null;
  const became = r.status !== next ? next : '';
  r.status = next;
  r.updatedAt = Date.now();
  if (next === 'done' && !r.stampedAt) r.stampedAt = Date.now(); // 首次打卡时间
  save(d);
  return { route: detail(id), became: became };
}

/**
 * 站点调序：dir = -1 上移 / 1 下移
 * 到头了返回 null（页面据此不抖）
 */
function moveStop(id, index, dir) {
  const d = loadAll();
  const r = d.routes.find((x) => x.id === id);
  if (!r) return null;
  const from = Number(index);
  const to = from + (dir < 0 ? -1 : 1);
  if (!(from >= 0 && from < r.stops.length) || to < 0 || to >= r.stops.length) return null;
  const tmp = r.stops[from];
  r.stops[from] = r.stops[to];
  r.stops[to] = tmp;
  r.updatedAt = Date.now();
  save(d);
  return detail(id);
}

/** 移除站点：少于 2 个站点时拒绝（路线至少要有一段） */
function removeStop(id, index) {
  const d = loadAll();
  const r = d.routes.find((x) => x.id === id);
  if (!r) return { ok: false, reason: 'NOT_FOUND' };
  if (r.stops.length <= 2) return { ok: false, reason: 'TOO_FEW' };
  const i = Number(index);
  if (!(i >= 0 && i < r.stops.length)) return { ok: false, reason: 'BAD_INDEX' };
  r.stops.splice(i, 1);
  r.updatedAt = Date.now();
  save(d);
  return { ok: true, route: detail(id) };
}

module.exports = {
  KEY, getAll, visible, list, totalKm, create, remove, setHidden,
  get, detail, rename, setStatus, moveStop, removeStop
};
