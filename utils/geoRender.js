/**
 * Canvas 2D 绘制：分组合批 fill + 双描边 casing + 高亮 + 九段线 + 足迹打点
 * PALETTE 与 app.wxss 的 CSS 变量值保持一致（canvas 内无法读取 CSS var）。
 * 坐标变换在 JS 完成（不用 ctx.scale），保证 lineWidth 恒定、放大不虚。
 */
const { project } = require('./geoMap');
const geoRoute = require('./geoRoute');

const PALETTE = {
  bg: '#16161c',                              // --bg
  land: 'rgba(38,38,46,0.92)',                // --bg-card-2 #26262e
  landStroke: '#4a5464',                      // 边界（比 --border 亮一档）
  casing: 'rgba(8,10,14,0.85)',               // 双描边底层
  visitedFill: 'rgba(126,212,145,0.30)',      // --green #7ed491
  visitedStroke: '#7ed491',
  wantFill: 'rgba(240,179,94,0.30)',          // --orange #f0b35e
  wantStroke: '#f0b35e',
  accent: '#6ea8fe',                          // --accent 选中/高亮
  jdStroke: '#7f8aa0',                        // 九段线
  attrFill: 'rgba(167,139,250,0.92)',         // 5A 景点气泡（紫，区别于足迹绿/橙与路线蓝）
  attrSpot: '#c4b5fd',                        // 省内景点小圆点
  attrRim: '#10131a'
};

function addRegionPath(ctx, region, useCoarse, scale, tx, ty) {
  const rings = (useCoarse && region.ringsCoarse) ? region.ringsCoarse : region.rings;
  for (let gi = 0; gi < rings.length; gi++) {
    const ring = rings[gi];
    for (let i = 0; i < ring.length; i += 2) {
      const x = ring[i] * scale + tx;
      const y = ring[i + 1] * scale + ty;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
}

function strokeColorOf(status) {
  if (status === 'visited') return PALETTE.visitedStroke;
  if (status === 'want') return PALETTE.wantStroke;
  return PALETTE.landStroke;
}

function fillColorOf(status) {
  if (status === 'visited') return PALETTE.visitedFill;
  if (status === 'want') return PALETTE.wantFill;
  return PALETTE.land;
}

/** 标记值兼容 v1 字符串与 v2 对象 */
function statusOf(m) {
  if (typeof m === 'string') return m;
  return (m && m.status) || '';
}

/** 二次贝塞尔采样（含首尾），用于按弧长截断绘制 */
function sampleQuad(p0, c, p1, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const mt = 1 - t;
    out.push([
      mt * mt * p0[0] + 2 * mt * t * c[0] + t * t * p1[0],
      mt * mt * p0[1] + 2 * mt * t * c[1] + t * t * p1[1]
    ]);
  }
  return out;
}

/**
 * 步骤 8：路线层（仅全国视图）
 * - stops 缺 center 的站点跳过该段（断链续画）
 * - 相同两端点的边（回折 A→B→A）自动翻弯曲方向，避免两段弧重合
 * - route: { status, stops }；plan=虚线蓝、done=实线绿；节点带序号
 * - anim: { progress } 传入时走「打卡生长」路径：按弧长截断线条，已经过的站点弹脉冲环
 */
function paintRoute(ctx, stops, lineColor, dashed, pr, scale, tx, ty, W, H, withLabels, anim) {
  if (!stops || stops.length < 2) return;
  const toXY = (ll) => {
    const pj = project(ll[0], ll[1]);
    return [(pj[0] - pr.minX) / pr.w * scale + tx, (pr.maxY - pj[1]) / pr.w * scale + ty];
  };
  const pts = stops.map((st) => (st.center ? toXY(st.center) : null));
  const progress = anim && typeof anim.progress === 'number' ? Math.max(0, Math.min(1, anim.progress)) : 1;

  // 构造边（含控制点），动画路径与静态路径共用同一套几何，保证两态一致
  const edges = [];
  const seenEdge = {};
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (!a || !b) continue;
    const ka = stops[i - 1].adcode;
    const kb = stops[i].adcode;
    const key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
    const side = seenEdge[key] ? -1 : 1;
    seenEdge[key] = 1;
    edges.push({ a: a, b: b, c: geoRoute.arcControl(a[0], a[1], b[0], b[1], 0.18, side), to: i });
  }

  ctx.lineWidth = dashed ? 2 : 2.4;
  ctx.strokeStyle = lineColor;

  if (progress >= 1) {
    // 常态：单次 stroke（拖动期每帧都走这里，保持原性能）
    ctx.beginPath();
    let started = false;
    for (let k = 0; k < edges.length; k++) {
      const e = edges[k];
      if (!started) { ctx.moveTo(e.a[0], e.a[1]); started = true; }
      ctx.quadraticCurveTo(e.c[0], e.c[1], e.b[0], e.b[1]);
    }
    ctx.setLineDash(dashed ? [7, 6] : []);
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    // 生长态：逐边采样，按累计弧长截断
    const sampled = [];
    let total = 0;
    const siteAt = {};   // 站点下标 → 该站所在的累计弧长
    if (pts.length && pts[0]) siteAt[0] = 0;
    for (let k = 0; k < edges.length; k++) {
      const e = edges[k];
      const sp = sampleQuad(e.a, e.c, e.b, 18);
      for (let j = 1; j < sp.length; j++) {
        const d = Math.hypot(sp[j][0] - sp[j - 1][0], sp[j][1] - sp[j - 1][1]);
        total += d;
        sampled.push({ p: sp[j], d: d });
      }
      siteAt[e.to] = total;
    }
    const budget = total * progress;
    ctx.beginPath();
    let acc = 0;
    let started = false;
    if (edges.length && sampled.length) {
      ctx.moveTo(edges[0].a[0], edges[0].a[1]);
      started = true;
    }
    for (let k = 0; k < sampled.length; k++) {
      const s = sampled[k];
      if (acc >= budget) break;
      if (acc + s.d <= budget) {
        ctx.lineTo(s.p[0], s.p[1]);
        acc += s.d;
      } else {
        const prevP = k > 0 ? sampled[k - 1].p : edges[0].a;
        const t = s.d > 0 ? (budget - acc) / s.d : 0;
        ctx.lineTo(prevP[0] + (s.p[0] - prevP[0]) * t, prevP[1] + (s.p[1] - prevP[1]) * t);
        acc = budget;
        break;
      }
    }
    if (started) {
      ctx.setLineDash([]);          // 生长中强制实线，走完才恢复虚线语义
      ctx.stroke();
    }

    // 已通过的站点：脉冲环（刚经过 0→1 衰减，半径 7→22）
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const at = siteAt[i];
      if (!p || at === undefined || at > budget) continue;
      const passed = budget - at;
      const k = Math.min(1, passed / 70);
      if (k < 1) {
        ctx.beginPath();
        ctx.arc(p[0], p[1], 7 + k * 15, 0, Math.PI * 2);
        ctx.strokeStyle = lineColor;
        ctx.globalAlpha = (1 - k) * 0.85;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      ctx.arc(p[0], p[1], 5, 0, Math.PI * 2);
      ctx.fillStyle = lineColor;
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // 编号节点（手势期由调用方传 withLabels=false 跳过，减少 arc + fillText）
  if (withLabels !== false) {
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!p || p[0] < -20 || p[1] < -20 || p[0] > W + 20 || p[1] > H + 20) continue;
      ctx.beginPath();
      ctx.arc(p[0], p[1], 7, 0, Math.PI * 2);
      ctx.fillStyle = lineColor;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#10131a';
      ctx.stroke();
      ctx.fillStyle = '#10131a';
      ctx.fillText(String(i + 1), p[0], p[1] + 0.5);
    }
  }
}

function radiusOf(n) {
  return n >= 20 ? 11 : n >= 10 ? 10 : 9;
}

/**
 * 气泡避让：东部小省（京津、苏皖、沪浙）在 375 宽屏上只隔 7~17px，
 * 直接按省中心画会叠在一起。这里做几轮确定性松弛把它们推开，
 * 并限制单点最大位移，避免气泡飘到别的省里去。
 */
function layoutBubbles(points, pr, scale, tx, ty, W, H) {
  const arr = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p || !p.n) continue;
    const pj = project(p.lng, p.lat);
    const x = ((pj[0] - pr.minX) / pr.w) * scale + tx;
    const y = ((pr.maxY - pj[1]) / pr.w) * scale + ty;
    if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
    arr.push({ adcode: p.adcode, name: p.name, n: p.n, x: x, y: y, ox: x, oy: y, r: radiusOf(p.n) });
  }

  const MAX_SHIFT = 15;
  for (let it = 0; it < 24; it++) {
    let moved = false;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i];
        const b = arr[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.sqrt(dx * dx + dy * dy);
        const need = a.r + b.r + 3;
        if (d >= need) continue;
        if (d < 0.5) {
          // 完全重合时按索引给一个固定方向，保证每帧结果一致（不抖）
          const ang = ((i * 37 + j * 11) % 360) * Math.PI / 180;
          dx = Math.cos(ang);
          dy = Math.sin(ang);
          d = 1;
        }
        const push = (need - d) * 0.5 * 0.6;
        const ux = dx / d;
        const uy = dy / d;
        a.x -= ux * push; a.y -= uy * push;
        b.x += ux * push; b.y += uy * push;
        moved = true;
      }
    }
    if (!moved) break;
  }

  for (let i = 0; i < arr.length; i++) {
    const p = arr[i];
    const dx = p.x - p.ox;
    const dy = p.y - p.oy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > MAX_SHIFT) {
      p.x = p.ox + (dx / d) * MAX_SHIFT;
      p.y = p.oy + (dy / d) * MAX_SHIFT;
    }
  }
  return arr;
}

/**
 * 5A 景点气泡（全国视图）：每个省级行政区一个圆，数字是该省 5A 数量。
 * points 由页面按省级图层中心点构造，这里负责投影、避让与描画。
 */
function paintAttractionBubbles(ctx, points, pr, scale, tx, ty, W, H, lite) {
  const arr = layoutBubbles(points, pr, scale, tx, ty, W, H);
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i];
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.attrFill;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = PALETTE.attrRim;
    ctx.stroke();
    if (!lite) {
      ctx.fillStyle = PALETTE.attrRim;
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(p.n), p.x, p.y + 0.5);
    }
  }
}

/** 省内景点点位布局：投影 + 屏幕空间聚合。绘制与点击命中共用，保证看到哪点哪 */
function layoutSpots(spots, pr, scale, tx, ty, W, H) {
  const arr = [];
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i];
    if (!s || !s.lat || !s.lng) continue;
    const pj = project(s.lng, s.lat);
    const x = ((pj[0] - pr.minX) / pr.w) * scale + tx;
    const y = ((pr.maxY - pj[1]) / pr.w) * scale + ty;
    if (x < -24 || y < -24 || x > W + 24 || y > H + 24) continue;
    arr.push({ name: s.name, city: s.city, year: s.year, x: x, y: y, r: 3.5 });
  }

  // 屏幕空间聚合：一个点 + 附近的合成一个，避免字压字
  const MIN = 24;
  const clusters = [];
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i];
    let merged = false;
    for (let j = 0; j < clusters.length; j++) {
      const c = clusters[j];
      if (Math.hypot(c.x - p.x, c.y - p.y) <= MIN) {
        c.items.push(p);
        c.x = (c.x * (c.items.length - 1) + p.x) / c.items.length;
        c.y = (c.y * (c.items.length - 1) + p.y) / c.items.length;
        c.r = 10;
        merged = true;
        break;
      }
    }
    if (!merged) clusters.push({ x: p.x, y: p.y, r: 3.5, items: [p] });
  }
  return clusters;
}

/**
 * 5A 景点点位（省级视图）：密集处先按屏幕距离聚合，再给每个点标名字。
 * 名字宽度按 9px/字估算做矩形碰撞检测，挤不下的只留点不留字，
 * 这样放大后名字会自然多出来，缩小时也不会糊成一团。
 */
function paintAttractionSpots(ctx, spots, pr, scale, tx, ty, W, H, lite) {
  const clusters = layoutSpots(spots, pr, scale, tx, ty, W, H);

  const placed = [];
  const hits = (b) => {
    for (let i = 0; i < placed.length; i++) {
      const q = placed[i];
      if (b[0] < q[2] && b[2] > q[0] && b[1] < q[3] && b[3] > q[1]) return true;
    }
    return false;
  };

  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];

    // 合点：圆里写数字，下方补「首点名 等N」标签（放得下就放，挤了就只有数字）
    if (c.items.length > 1) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, 10, 0, Math.PI * 2);
      ctx.fillStyle = PALETTE.attrFill;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = PALETTE.attrRim;
      ctx.stroke();
      if (!lite) {
        ctx.fillStyle = PALETTE.attrRim;
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(c.items.length), c.x, c.y + 0.5);

        const label = c.items[0].name + ' 等' + c.items.length;
        const tw = label.length * 9;
        const box = [c.x - tw / 2, c.y + 12, c.x + tw / 2, c.y + 26];
        if (box[0] > 2 && box[2] < W - 2 && !hits(box)) {
          placed.push(box);
          ctx.font = '9px sans-serif';
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = 'rgba(12,14,20,0.92)';
          if (ctx.strokeText) ctx.strokeText(label, c.x, c.y + 19);
          ctx.fillStyle = 'rgba(228,232,240,0.96)';
          ctx.fillText(label, c.x, c.y + 19);
        }
      }
      continue;
    }

    const p = c.items[0];
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.attrSpot;
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = PALETTE.attrRim;
    ctx.stroke();

    if (lite) continue;

    // 名字默认放右侧，贴右边界时翻到左侧
    const tw = p.name.length * 9;
    let bx = p.x + 7;
    let align = 'left';
    if (bx + tw > W - 4) {
      bx = p.x - 7;
      align = 'right';
    }
    const box = align === 'left'
      ? [bx, p.y - 7, bx + tw, p.y + 7]
      : [bx - tw, p.y - 7, bx, p.y + 7];
    if (hits(box)) continue;
    placed.push(box);

    // 描边打底：深色地图上纯文字会陷进背景
    ctx.font = '9px sans-serif';
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(12,14,20,0.92)';
    if (ctx.strokeText) ctx.strokeText(p.name, bx, p.y);
    ctx.fillStyle = 'rgba(228,232,240,0.96)';
    ctx.fillText(p.name, bx, p.y);
  }
}

function drawScene(ctx, s) {
  const layer = s.layer;
  const view = s.view;
  const W = s.W;
  const H = s.H;
  const marks = s.marks || {};
  const filter = s.filter || 'all';   // all | visited | want：不匹配的按未标记渲染
  const scale = view.scale;
  const tx = view.tx;
  const ty = view.ty;
  // 交互降级态：拖动/缩放手势期间只画主体（填充 + 细描边），跳过 casing、名称、路线序号
  const lite = !!s.lite;
  // LOD：lite 强制粗环；否则用页面传入的滞回结果，缺省退回旧判定
  const useCoarse = lite ? true : (s.useCoarse !== undefined ? s.useCoarse : view.scale < view.baseScale * 1.6);

  // 背景
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // 按标记状态分组
  const groups = { plain: [], visited: [], want: [] };
  const regions = layer.regions;
  for (let i = 0; i < regions.length; i++) {
    const st = statusOf(marks[regions[i].adcode]);
    const show = filter === 'all' || st === filter;
    groups[show && st === 'visited' ? 'visited' : show && st === 'want' ? 'want' : 'plain'].push(regions[i]);
  }

  // 1. 分组填充（evenodd 挖洞）
  const order = ['plain', 'visited', 'want'];
  for (let g = 0; g < order.length; g++) {
    const list = groups[order[g]];
    if (!list.length) continue;
    ctx.beginPath();
    for (let i = 0; i < list.length; i++) {
      addRegionPath(ctx, list[i], useCoarse, scale, tx, ty);
    }
    ctx.fillStyle = fillColorOf(order[g]);
    ctx.fill('evenodd');
  }

  // 2. casing 暗底描边（全部区域一次性；手势期跳过——最贵的一遍全区域宽线光栅化）
  if (!lite) {
    ctx.beginPath();
    for (let i = 0; i < regions.length; i++) {
      addRegionPath(ctx, regions[i], useCoarse, scale, tx, ty);
    }
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = PALETTE.casing;
    ctx.stroke();
  }

  // 3. 按状态细描边
  for (let g = 0; g < order.length; g++) {
    const list = groups[order[g]];
    if (!list.length) continue;
    ctx.beginPath();
    for (let i = 0; i < list.length; i++) {
      addRegionPath(ctx, list[i], useCoarse, scale, tx, ty);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = strokeColorOf(order[g]);
    ctx.stroke();
  }

  // 4. 选中/下钻来源高亮
  if (s.highlightAdcode) {
    for (let i = 0; i < regions.length; i++) {
      if (regions[i].adcode === s.highlightAdcode) {
        ctx.beginPath();
        addRegionPath(ctx, regions[i], useCoarse, scale, tx, ty);
        ctx.lineWidth = 2;
        ctx.strokeStyle = PALETTE.accent;
        ctx.stroke();
        break;
      }
    }
  }

  // 5. 九段线（仅描边）
  if (layer.jDRings && layer.jDRings.length) {
    ctx.beginPath();
    for (let gi = 0; gi < layer.jDRings.length; gi++) {
      const ring = layer.jDRings[gi];
      for (let i = 0; i < ring.length; i += 2) {
        const x = ring[i] * scale + tx;
        const y = ring[i + 1] * scale + ty;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = PALETTE.jdStroke;
    ctx.stroke();
  }

  // 6. 名称标注（省名/市名，压在填充上、足迹点之下；手势期跳过，避免每帧几十次文字 AA）
  //    景点图层开启时气泡占住省中心，省名整体下移一行
  const attrOn = !!(s.attractions && s.attractions.on);
  if (!lite && layer.proj && layer.regions.length) {
    const pr = layer.proj;
    const fontSize = s.level === 'country' ? 10 : 9;
    const nameDy = attrOn && s.level === 'country' ? 14 : 0;
    ctx.font = fontSize + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(190,200,215,0.75)';
    for (let i = 0; i < layer.regions.length; i++) {
      const r = layer.regions[i];
      if (!r.centerLL || !r.name) continue;
      const pj = project(r.centerLL[0], r.centerLL[1]);
      const x = ((pj[0] - pr.minX) / pr.w) * scale + tx;
      const y = ((pr.maxY - pj[1]) / pr.w) * scale + ty + nameDy;
      if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
      ctx.fillText(r.name, x, y);
    }
  }

  // 7. 足迹打点（全国视图）：市级/区级标记画在城市中心位置，
  //    避免按省填色导致"一个市去过整省变色"；省级标记(0000)仍走填色。
  if (s.level === 'country' && layer.proj) {
    const pr = layer.proj;
    const rDot = 3.5 * Math.sqrt(Math.max(1, Math.min(view.scale / view.baseScale, 2.5)));
    for (const k in marks) {
      const m = marks[k];
      const st = statusOf(m);
      if (!st || !m || !m.center || /0000$/.test(k)) continue;
      if (filter !== 'all' && st !== filter) continue;
      const pj = project(m.center[0], m.center[1]);
      const nx = (pj[0] - pr.minX) / pr.w;
      const ny = (pr.maxY - pj[1]) / pr.w;
      const x = nx * scale + tx;
      const y = ny * scale + ty;
      if (x < -24 || y < -24 || x > W + 24 || y > H + 24) continue;
      ctx.beginPath();
      ctx.arc(x, y, rDot, 0, Math.PI * 2);
      ctx.fillStyle = st === 'visited' ? PALETTE.visitedStroke : PALETTE.wantStroke;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#10131a';
      ctx.stroke();
    }
  }

  // 7.5 5A 景点图层：全国画省级气泡，省内画景点点位与名字
  if (attrOn && layer.proj && s.attractions) {
    if (s.level === 'country' && s.attractions.points && s.attractions.points.length) {
      paintAttractionBubbles(ctx, s.attractions.points, layer.proj, scale, tx, ty, W, H, lite);
    } else if (s.level === 'province' && s.attractions.spots && s.attractions.spots.length) {
      paintAttractionSpots(ctx, s.attractions.spots, layer.proj, scale, tx, ty, W, H, lite);
    }
  }

  // 8. 路线层：已保存路线 + 新建选点预览（省级层也画，选市时能看到已选站点连线）
  if (layer.proj) {
    const pr = layer.proj;
    const sc = view.scale;
    const txv = view.tx;
    const tyv = view.ty;
    const anim = s.routeAnim && s.routeAnim.progress < 1 ? s.routeAnim : null;
    (s.routes || []).forEach((r) => {
      if (anim && anim.id === r.id) return;   // 动画那条留到最后画，保证在最上层
      const done = r.status === 'done';
      paintRoute(ctx, r.stops, done ? PALETTE.visitedStroke : PALETTE.accent, !done, pr, sc, txv, tyv, W, H, !lite);
    });
    if (anim) {
      const hot = (s.routes || []).find((r) => r.id === anim.id);
      if (hot) {
        paintRoute(ctx, hot.stops, PALETTE.visitedStroke, false, pr, sc, txv, tyv, W, H, false, anim);
      }
    }
    if (s.selectStops && s.selectStops.length > 1) {
      paintRoute(ctx, s.selectStops, PALETTE.accent, true, pr, sc, txv, tyv, W, H, !lite);
    }
  }
}

/**
 * 创建渲染器：requestDraw 合帧（一帧最多绘制一次）
 */
function createRenderer(canvas, ctx) {
  let pending = false;
  let state = null;
  let destroyed = false;
  // 单帧耗时打点：每 60 帧输出一次，用于拖动期性能对比（调试期观察，常驻开销可忽略）
  let perf = { frames: 0, total: 0, max: 0, last: 0 };

  function timedDraw(s, lite) {
    const t0 = Date.now();
    drawScene(ctx, s);
    const dt = Date.now() - t0;
    perf.frames++;
    perf.total += dt;
    perf.last = dt;
    if (dt > perf.max) perf.max = dt;
    if (perf.frames % 60 === 0) {
      console.log('[geoPerf] avg=' + (perf.total / perf.frames).toFixed(1)
        + 'ms max=' + perf.max + 'ms lite=' + (lite ? 1 : 0) + ' n=' + perf.frames);
      perf = { frames: 0, total: 0, max: 0, last: dt };
    }
  }

  function schedule(fn) {
    if (canvas.requestAnimationFrame) canvas.requestAnimationFrame(fn);
    else setTimeout(fn, 16);
  }

  return {
    /** 全量重绘一帧 */
    requestDraw(s) {
      if (destroyed) return;
      state = s;
      if (pending) return;
      pending = true;
      schedule(() => {
        pending = false;
        if (!destroyed && state) timedDraw(state, state.lite);
      });
    },
    /** 立即同步绘制（动画循环用） */
    drawNow(s) {
      if (!destroyed) timedDraw(s, s && s.lite);
    },
    /** 最近一批打点数据（调试用） */
    perf() {
      return perf;
    },
    resize(W, H, dpr) {
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    },
    destroy() {
      destroyed = true;
    }
  };
}

// paintRoute 是纯绘制函数，一并导出：打卡生长动画的截断/脉冲逻辑可单测
module.exports = {
  PALETTE,
  createRenderer,
  drawScene,
  statusOf,
  paintRoute,
  paintAttractionBubbles,
  paintAttractionSpots,
  layoutBubbles,
  layoutSpots
};
