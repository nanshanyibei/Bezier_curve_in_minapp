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

/** 34 个省级行政区：清单页分组用（不依赖已下载的 geojson） */
const PROVINCES = {
  '110000': '北京', '120000': '天津', '130000': '河北', '140000': '山西', '150000': '内蒙古',
  '210000': '辽宁', '220000': '吉林', '230000': '黑龙江',
  '310000': '上海', '320000': '江苏', '330000': '浙江', '340000': '安徽', '350000': '福建',
  '360000': '江西', '370000': '山东',
  '410000': '河南', '420000': '湖北', '430000': '湖南', '440000': '广东', '450000': '广西',
  '460000': '海南',
  '500000': '重庆', '510000': '四川', '520000': '贵州', '530000': '云南', '540000': '西藏',
  '610000': '陕西', '620000': '甘肃', '630000': '青海', '640000': '宁夏', '650000': '新疆',
  '710000': '台湾', '810000': '香港', '820000': '澳门'
};
const PROVINCE_TOTAL = 34;

/** adcode → 所属省级 adcode（前两位 + 0000） */
function provinceOf(adcode) {
  const code = String(adcode);
  return code.length >= 2 ? code.slice(0, 2) + '0000' : code;
}

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

/**
 * 覆盖率：省级按「省内有任意去过的标记」去重计数，市级只数非 0000 的去过标记
 * 不编造城市分母（全国地级区划口径不一），只给已标记数量
 */
function coverage() {
  const marks = getAll();
  const provHit = {};
  let city = 0;
  let wantCity = 0;
  let visitedMarks = 0;
  Object.keys(marks).forEach(function (k) {
    const m = marks[k];
    if (!m || !m.status) return;
    if (m.status === 'visited') {
      visitedMarks++;
      provHit[provinceOf(k)] = 1;
      if (!/0000$/.test(k)) city++;
    } else if (m.status === 'want') {
      wantCity++;
    }
  });
  const visitedProv = Object.keys(provHit).length;
  return {
    provinceVisited: visitedProv,
    provinceTotal: PROVINCE_TOTAL,
    pct: Math.round((visitedProv / PROVINCE_TOTAL) * 100),
    cityVisited: city,
    want: wantCity,
    visited: visitedMarks
  };
}

/**
 * 按省级分组，供足迹清单页渲染
 * [{ code, name, visitedCount, wantCount, items: [{ adcode, name, status, isProvince }] }]
 * 排序：有去过的省在前，其次按 adcode
 */
function groupByProvince() {
  const marks = getAll();
  const map = {};
  Object.keys(marks).forEach(function (k) {
    const m = marks[k];
    if (!m || !m.status) return;
    const prov = provinceOf(k);
    if (!map[prov]) {
      map[prov] = {
        code: prov,
        name: PROVINCES[prov] || '',
        items: [],
        visitedCount: 0,
        wantCount: 0
      };
    }
    const g = map[prov];
    if (!g.name && m.name && k === prov) g.name = m.name;
    const isProvince = k === prov;
    g.items.push({
      adcode: k,
      // 老数据（v1/v2）可能没有 name：市级不能拿省名顶替，直接标 adcode 更诚实
      name: m.name || (isProvince ? (PROVINCES[prov] || k) : '未命名 ' + k),
      status: m.status,
      isProvince: isProvince
    });
    if (m.status === 'visited') g.visitedCount++;
    else g.wantCount++;
  });

  const list = Object.keys(map).map(function (k) { return map[k]; });
  list.forEach(function (g) {
    // 省级标记排最前，其余按 adcode（行政区划顺序）
    g.items.sort(function (a, b) {
      if (a.isProvince !== b.isProvince) return a.isProvince ? -1 : 1;
      return a.adcode < b.adcode ? -1 : 1;
    });
    if (!g.name) g.name = g.items[0] ? g.items[0].name : g.code;
  });
  list.sort(function (a, b) {
    if (!!a.visitedCount !== !!b.visitedCount) return a.visitedCount ? -1 : 1;
    return a.code < b.code ? -1 : 1;
  });
  return list;
}

module.exports = {
  KEY, PROVINCES, PROVINCE_TOTAL,
  getAll, get, set, pullCloud, stats, clear,
  coverage, groupByProvince, provinceOf
};
