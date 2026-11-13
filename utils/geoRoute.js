/**
 * 路线几何工具：球面距离、贝塞尔弧线控制点（纯函数，无 wx 依赖，可单测）
 */

const R_KM = 6371;

/** 两经纬度点 [lon,lat] 间大圆距离（km） */
function haversineKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const h = s1 * s1 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * s2 * s2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 二次贝塞尔控制点（屏幕坐标）：中点沿垂直方向偏移 bend * 段长
 * side = 1 / -1 控制弯曲方向；回折段（同两端点的边再次出现）由调用方翻 side 避免两段重合
 */
function arcControl(x1, y1, x2, y2, bend, side) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  return [mx - dy * bend * side, my + dx * bend * side];
}

module.exports = { haversineKm, arcControl };
