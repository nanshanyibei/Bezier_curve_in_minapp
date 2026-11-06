/**
 * GeoJSON 边界简化：栈式 Douglas-Peucker（防数万点环爆栈）+ 小岛过滤 + 闭合修复
 * flat 数组格式：[x0,y0,x1,y1,...]，坐标单位与容差一致（调用方保证，均为世界坐标或经纬度）
 */

/**
 * DP 简化，返回新 flat 数组（保留首尾点）
 */
function dpSimplifyFlat(flat, tol) {
  const n = flat.length / 2;
  if (n <= 3) return flat;

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const stack = [[0, n - 1]];
  while (stack.length) {
    const seg = stack.pop();
    const s = seg[0];
    const e = seg[1];
    let maxD = -1;
    let maxI = -1;

    const x1 = flat[s * 2];
    const y1 = flat[s * 2 + 1];
    const x2 = flat[e * 2];
    const y2 = flat[e * 2 + 1];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;

    for (let i = s + 1; i < e; i++) {
      const px = flat[i * 2];
      const py = flat[i * 2 + 1];
      let d;
      if (len2 === 0) {
        const ex = px - x1;
        const ey = py - y1;
        d = Math.sqrt(ex * ex + ey * ey);
      } else {
        let t = ((px - x1) * dx + (py - y1) * dy) / len2;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const cx = x1 + t * dx;
        const cy = y1 + t * dy;
        const ex = px - cx;
        const ey = py - cy;
        d = Math.sqrt(ex * ex + ey * ey);
      }
      if (d > maxD) { maxD = d; maxI = i; }
    }

    if (maxD > tol && maxI > 0) {
      keep[maxI] = 1;
      stack.push([s, maxI], [maxI, e]);
    }
  }

  let count = 0;
  for (let i = 0; i < n; i++) if (keep[i]) count++;
  const out = new Float64Array(count * 2);
  let w = 0;
  for (let i = 0; i < n; i++) {
    if (keep[i]) {
      out[w++] = flat[i * 2];
      out[w++] = flat[i * 2 + 1];
    }
  }
  return out;
}

/** 环 bbox：[minX, minY, maxX, maxY] */
function ringBBox(flat) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < flat.length; i += 2) {
    const x = flat[i];
    const y = flat[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/** 鞋带公式面积（有符号，单位同坐标） */
function ringArea(flat) {
  let a = 0;
  for (let i = 0, j = flat.length - 2; i < flat.length; j = i, i += 2) {
    a += flat[j] * flat[i + 1] - flat[i] * flat[j + 1];
  }
  return a / 2;
}

/**
 * 简化单环：DP + 小环过滤 + 强制闭合
 * @returns Float64Array | null（null = 环退化/被过滤）
 */
function simplifyRing(flat, tol, minDiag) {
  if (minDiag != null) {
    const bb = ringBBox(flat);
    const diag = Math.sqrt((bb[2] - bb[0]) ** 2 + (bb[3] - bb[1]) ** 2);
    if (diag < minDiag) return null; // 小岛过滤
  }
  let out = dpSimplifyFlat(flat, tol);
  if (out.length / 2 < 4) return null;
  // 强制闭合（stroke 需要完整边界）
  const fx = out[0];
  const fy = out[1];
  const lx = out[out.length - 2];
  const ly = out[out.length - 1];
  if (fx !== lx || fy !== ly) {
    const closed = new Float64Array(out.length + 2);
    closed.set(out);
    closed[out.length] = fx;
    closed[out.length + 1] = fy;
    out = closed;
  }
  return out;
}

/**
 * 简化一个 Polygon 的一组环（外环 + 洞）
 * @returns Float64Array[] | null（外环被过滤则整个 polygon 丢弃）
 */
function simplifyPolygonRings(rings, tol, minDiag) {
  const out = [];
  for (let i = 0; i < rings.length; i++) {
    const r = simplifyRing(rings[i], tol, i === 0 ? minDiag : null);
    if (!r) {
      if (i === 0) return null; // 外环退化 → 丢弃整个 polygon
      continue; // 洞退化 → 跳过该洞
    }
    out.push(r);
  }
  return out.length ? out : null;
}

module.exports = { dpSimplifyFlat, ringBBox, ringArea, simplifyRing, simplifyPolygonRings };
