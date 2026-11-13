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
  jdStroke: '#7f8aa0'                         // 九段线
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

/**
 * 步骤 8：路线层（仅全国视图）
 * - stops 缺 center 的站点跳过该段（断链续画）
 * - 相同两端点的边（回折 A→B→A）自动翻弯曲方向，避免两段弧重合
 * - route: { status, stops }；plan=虚线蓝、done=实线绿；节点带序号
 */
function paintRoute(ctx, stops, lineColor, dashed, pr, scale, tx, ty, W, H, withLabels) {
  if (!stops || stops.length < 2) return;
  const toXY = (ll) => {
    const pj = project(ll[0], ll[1]);
    return [(pj[0] - pr.minX) / pr.w * scale + tx, (pr.maxY - pj[1]) / pr.w * scale + ty];
  };
  const pts = stops.map((st) => (st.center ? toXY(st.center) : null));

  // 弧线
  ctx.beginPath();
  const seenEdge = {};
  let prev = null;
  let started = false;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!p) { prev = null; started = false; continue; }
    if (prev) {
      const a = stops[i - 1].adcode;
      const b = stops[i].adcode;
      const key = a < b ? a + '|' + b : b + '|' + a;
      const side = seenEdge[key] ? -1 : 1;
      seenEdge[key] = 1;
      const c = geoRoute.arcControl(prev[0], prev[1], p[0], p[1], 0.18, side);
      if (!started) { ctx.moveTo(prev[0], prev[1]); started = true; }
      ctx.quadraticCurveTo(c[0], c[1], p[0], p[1]);
    }
    prev = p;
  }
  ctx.lineWidth = dashed ? 2 : 2.4;
  ctx.setLineDash(dashed ? [7, 6] : []);
  ctx.strokeStyle = lineColor;
  ctx.stroke();
  ctx.setLineDash([]);

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
  if (!lite && layer.proj && layer.regions.length) {
    const pr = layer.proj;
    const fontSize = s.level === 'country' ? 10 : 9;
    ctx.font = fontSize + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(190,200,215,0.75)';
    for (let i = 0; i < layer.regions.length; i++) {
      const r = layer.regions[i];
      if (!r.centerLL || !r.name) continue;
      const pj = project(r.centerLL[0], r.centerLL[1]);
      const x = ((pj[0] - pr.minX) / pr.w) * scale + tx;
      const y = ((pr.maxY - pj[1]) / pr.w) * scale + ty;
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

  // 8. 路线层：已保存路线 + 新建选点预览（省级层也画，选市时能看到已选站点连线）
  if (layer.proj) {
    const pr = layer.proj;
    const sc = view.scale;
    const txv = view.tx;
    const tyv = view.ty;
    (s.routes || []).forEach((r) => {
      const done = r.status === 'done';
      paintRoute(ctx, r.stops, done ? PALETTE.visitedStroke : PALETTE.accent, !done, pr, sc, txv, tyv, W, H, !lite);
    });
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

module.exports = { PALETTE, createRenderer, drawScene, statusOf };
