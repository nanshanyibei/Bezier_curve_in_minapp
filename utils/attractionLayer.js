/**
 * 5A 景点图层
 *
 * 数据源：assets/data/attractions-5a.js（358 家，WGS84，随包内置）
 * 只做数据整理，不碰 canvas：绘制在 utils/geoRender.js。
 *
 * 视图分两级：
 *   全国 —— 每个省级行政区一个数字气泡（该省 5A 数量）
 *   省内 —— 每个景点一个点，密集处合并成「+N」
 */
const data = require('../assets/data/attractions-5a.js');

const NAME = {
  110000: '北京', 120000: '天津', 130000: '河北', 140000: '山西', 150000: '内蒙古',
  210000: '辽宁', 220000: '吉林', 230000: '黑龙江', 310000: '上海', 320000: '江苏',
  330000: '浙江', 340000: '安徽', 350000: '福建', 360000: '江西', 370000: '山东',
  410000: '河南', 420000: '湖北', 430000: '湖南', 440000: '广东', 450000: '广西',
  460000: '海南', 500000: '重庆', 510000: '四川', 520000: '贵州', 530000: '云南',
  540000: '西藏', 610000: '陕西', 620000: '甘肃', 630000: '青海', 640000: '宁夏',
  650000: '新疆', 710000: '台湾', 810000: '香港', 820000: '澳门'
};

/** 兵团（659000）在地图上归新疆，计数与显示一并并入 */
function normProv(adcode) {
  return String(adcode) === '659000' ? 650000 : Number(adcode);
}

/** 每条记录转成对象，避免到处写下标 */
const SPOTS = data.list.map((r) => ({
  name: r[0],
  prov: normProv(r[1]),
  city: r[2],
  year: r[3],
  lat: r[4],
  lng: r[5],
  tags: r[6]
}));

/** 省级计数 { adcode: n } */
const COUNT = {};
SPOTS.forEach((s) => { COUNT[s.prov] = (COUNT[s.prov] || 0) + 1; });

/** 省内景点（按纬度降序，方便就近合并） */
const BY_PROV = {};
SPOTS.forEach((s) => { (BY_PROV[s.prov] || (BY_PROV[s.prov] = [])).push(s); });

/** 全国气泡数据：[{ adcode, n, name }] */
function provinces() {
  return Object.keys(COUNT).map((k) => ({
    adcode: Number(k),
    n: COUNT[k],
    name: NAME[k] || k
  }));
}

/** 某省景点列表 */
function spotsOf(provAdcode) {
  return BY_PROV[normProv(provAdcode)] || [];
}

/**
 * 屏幕空间聚合：距离小于 minDist(px) 的点合并为一个簇。
 * 简单的贪心：按顺序取点，落进已有簇半径内就并入，否则新开簇。
 * 返回 [{ x, y, items: [...] }]，items.length > 1 时显示「+N」。
 */
function cluster(points, minDist) {
  const out = [];
  const d2 = minDist * minDist;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    let hit = null;
    for (let j = 0; j < out.length; j++) {
      const c = out[j];
      const dx = c.x - p.x;
      const dy = c.y - p.y;
      if (dx * dx + dy * dy <= d2) { hit = c; break; }
    }
    if (hit) {
      hit.items.push(p);
      // 簇心随成员平移，避免长条状堆叠
      hit.x = (hit.x * (hit.items.length - 1) + p.x) / hit.items.length;
      hit.y = (hit.y * (hit.items.length - 1) + p.y) / hit.items.length;
    } else {
      out.push({ x: p.x, y: p.y, items: [p] });
    }
  }
  return out;
}

module.exports = {
  total: data.total,
  geo: data.geo,
  NAME,
  provinces,
  spotsOf,
  cluster,
  countOf: (adcode) => COUNT[normProv(adcode)] || 0
};
