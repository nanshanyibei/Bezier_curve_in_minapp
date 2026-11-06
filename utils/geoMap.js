/**
 * 地图核心：Web Mercator 投影、Layer 构建（双 LOD）、视图变换、射线法命中测试
 * 世界坐标：投影后归一化到 [0,1] 宽度、y 翻转成屏幕方向，Layer.bbox = [0,0,1,h/w]
 */
const geoSource = require('./geoSource');
const { dpSimplifyFlat, simplifyRing, simplifyPolygonRings, ringBBox, ringArea } = require('./geoSimplify');

const REF_W = 359; // 基准适配宽度（375px - 左右各 8px padding）

// ---------- 投影 ----------
function project(lon, lat) {
  return [
    lon * Math.PI / 180,
    Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))
  ];
}

// ---------- Layer 构建 ----------
const layerCache = {};

/**
 * 由 FeatureCollection 构建渲染层
 * @param {object} fc FeatureCollection（含九段线时自动拆为 jDRings）
 * @param {object} opts { level: 'country'|'province', coarsePx: 0.35 }
 */
function buildLayer(fc, opts) {
  opts = opts || {};
  const coarsePx = opts.coarsePx || 0.35;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const items = [];
  const jdRaw = [];

  fc.features.forEach((f) => {
    if (!f.geometry) return;
    const isJD = String(f.properties && f.properties.adcode || '').indexOf('JD') >= 0;
    const polys = f.geometry.type === 'Polygon'
      ? [f.geometry.coordinates]
      : f.geometry.coordinates;
    const projPolys = polys.map((poly) => poly.map((ring) => {
      const flat = new Float64Array(ring.length * 2);
      for (let i = 0; i < ring.length; i++) {
        const p = project(ring[i][0], ring[i][1]);
        flat[i * 2] = p[0];
        flat[i * 2 + 1] = p[1];
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[1] > maxY) maxY = p[1];
      }
      return flat;
    }));
    if (isJD) {
      projPolys.forEach((poly) => poly.forEach((r) => jdRaw.push(r)));
    } else {
      items.push({ props: f.properties || {}, polys: projPolys });
    }
  });

  const w = maxX - minX;
  const h = maxY - minY;
  if (!w || !h) throw new Error('地图数据无有效边界');
  const fitScale = REF_W / w;

  const norm = (flat) => {
    const out = new Float32Array(flat.length);
    for (let i = 0; i < flat.length; i += 2) {
      out[i] = (flat[i] - minX) / w;
      out[i + 1] = (maxY - flat[i + 1]) / w;
    }
    return out;
  };

  const tolWorld = coarsePx / fitScale;
  const minDiag = 0.15 / fitScale;

  const regions = [];
  items.forEach((it) => {
    const ringsFull = [];
    const ringBBs = [];
    let bb = [Infinity, Infinity, -Infinity, -Infinity];
    let area = 0;
    let center = null;

    it.polys.forEach((poly) => {
      poly.forEach((ring, ri) => {
        const n = norm(ring);
        ringsFull.push(n);
        const rb = ringBBox(n);
        ringBBs.push(rb);
        if (rb[0] < bb[0]) bb[0] = rb[0];
        if (rb[1] < bb[1]) bb[1] = rb[1];
        if (rb[2] > bb[2]) bb[2] = rb[2];
        if (rb[3] > bb[3]) bb[3] = rb[3];
        if (ri === 0) {
          area = Math.abs(ringArea(n));
          if (it.props.center) {
            const c = project(it.props.center[0], it.props.center[1]);
            center = [(c[0] - minX) / w, (maxY - c[1]) / w];
          }
        }
      });
    });

    // 粗略 LOD（缩放较小时使用）
    const ringsCoarse = [];
    ringsFull.forEach((r) => {
      const c = simplifyRing(r, tolWorld, minDiag);
      if (c) ringsCoarse.push(c);
    });

    regions.push({
      adcode: String(it.props.adcode || ''),
      name: it.props.name || '',
      level: it.props.level || '',
      bbox: bb,
      area: area,
      center: center || [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2],
      rings: ringsFull,
      ringsCoarse: ringsCoarse.length ? ringsCoarse : ringsFull
    });
  });

  // 小面积优先命中（嵌套区域点选小的）
  regions.sort((a, b) => a.area - b.area);

  return {
    adcode: String(opts.adcode || ''),
    level: opts.level || 'country',
    bbox: [0, 0, 1, h / w],
    fitScale: fitScale,
    regions: regions,
    jDRings: jdRaw.map(norm) // 九段线（仅描边，不参与命中/填充）
  };
}

/** 加载并构建 Layer（带内存缓存） */
function getLayer(adcode, opts) {
  opts = opts || {};
  const key = adcode + ':' + (opts.level || 'country');
  if (layerCache[key]) return Promise.resolve(layerCache[key]);
  return geoSource.loadGeoJSON(adcode, opts).then((fc) => {
    const layer = buildLayer(fc, { level: opts.level || 'country', adcode: adcode });
    layerCache[key] = layer;
    return layer;
  });
}

function dropLayerCache(adcode) {
  Object.keys(layerCache).forEach((k) => {
    if (k.indexOf(adcode + ':') === 0) delete layerCache[k];
  });
}

// ---------- 视图变换 ----------

/** 适配视图：地图完整居中；minScale 即初始 scale（不允许缩得比初始更小） */
function fitView(bbox, W, H, pad) {
  pad = pad == null ? 16 : pad;
  const w = bbox[2] - bbox[0];
  const h = bbox[3] - bbox[1];
  const scale = Math.min((W - pad * 2) / w, (H - pad * 2) / h);
  return {
    scale: scale,
    tx: (W - w * scale) / 2 - bbox[0] * scale,
    ty: (H - h * scale) / 2 - bbox[1] * scale,
    baseScale: scale,
    maxScale: scale * 12
  };
}

function screenToWorld(view, x, y) {
  return [(x - view.tx) / view.scale, (y - view.ty) / view.scale];
}

/** 围绕焦点 (fx,fy) 缩放 factor 倍 */
function zoomAt(view, factor, fx, fy) {
  const target = view.scale * factor;
  const k2 = Math.min(view.maxScale, Math.max(view.baseScale, target)) / view.scale;
  return {
    scale: view.scale * k2,
    tx: fx - (fx - view.tx) * k2,
    ty: fy - (fy - view.ty) * k2,
    baseScale: view.baseScale,
    maxScale: view.maxScale
  };
}

function panBy(view, dx, dy) {
  return { scale: view.scale, tx: view.tx + dx, ty: view.ty + dy, baseScale: view.baseScale, maxScale: view.maxScale };
}

/** 限制平移范围：允许 margin 像素越界，防止地图飘走 */
function clampView(view, W, H, margin) {
  margin = margin == null ? 48 : margin;
  const layer = view._layerBBox;
  let minX = 0, minY = 0, maxX = 1, maxY = 1;
  if (layer) { minX = layer[0]; minY = layer[1]; maxX = layer[2]; maxY = layer[3]; }
  const x0 = minX * view.scale + view.tx;
  const y0 = minY * view.scale + view.ty;
  const x1 = maxX * view.scale + view.tx;
  const y1 = maxY * view.scale + view.ty;
  let tx = view.tx;
  let ty = view.ty;
  if (x1 - x0 <= W + margin * 2) tx = (W - (x1 - x0)) / 2 - x0 + tx; // 整体可见时居中
  else if (x0 > margin) tx += margin - x0;
  else if (x1 < W - margin) tx += W - margin - x1;
  if (y1 - y0 <= H + margin * 2) ty = (H - (y1 - y0)) / 2 - y0 + ty;
  else if (y0 > margin) ty += margin - y0;
  else if (y1 < H - margin) ty += H - margin - y1;
  return { scale: view.scale, tx: tx, ty: ty, baseScale: view.baseScale, maxScale: view.maxScale };
}

// ---------- 命中测试 ----------

/** 射线法（单环，支持闭合环） */
function pointInRing(flat, x, y) {
  let inside = false;
  for (let i = 0, j = flat.length - 2; i < flat.length; j = i, i += 2) {
    const xi = flat[i];
    const yi = flat[i + 1];
    const xj = flat[j];
    const yj = flat[j + 1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/** evenodd 语义：外环内且不在洞内 = 命中（逐环异或） */
function pointInRegion(region, x, y) {
  const bb = region.bbox;
  if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3]) return false;
  let inside = false;
  for (let i = 0; i < region.rings.length; i++) {
    const inRing = pointInRing(region.rings[i], x, y);
    if (inRing) inside = !inside;
  }
  return inside;
}

/** regions 已按 area 升序，命中即返回 */
function hitTest(layer, x, y) {
  for (let i = 0; i < layer.regions.length; i++) {
    if (pointInRegion(layer.regions[i], x, y)) return layer.regions[i];
  }
  return null;
}

module.exports = {
  project,
  buildLayer,
  getLayer,
  dropLayerCache,
  fitView,
  screenToWorld,
  zoomAt,
  panBy,
  clampView,
  pointInRing,
  pointInRegion,
  hitTest
};
