/**
 * Canvas 2D 绘制：分组合批 fill + 双描边 casing + 高亮 + 九段线
 * PALETTE 与 app.wxss 的 CSS 变量值保持一致（canvas 内无法读取 CSS var）。
 * 坐标变换在 JS 完成（不用 ctx.scale），保证 lineWidth 恒定、放大不虚。
 */

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

function drawScene(ctx, s) {
  const layer = s.layer;
  const view = s.view;
  const W = s.W;
  const H = s.H;
  const marks = s.marks || {};
  const scale = view.scale;
  const tx = view.tx;
  const ty = view.ty;
  const useCoarse = view.scale < view.baseScale * 1.6;

  // 背景
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // 按标记状态分组
  const groups = { plain: [], visited: [], want: [] };
  const regions = layer.regions;
  for (let i = 0; i < regions.length; i++) {
    const st = marks[regions[i].adcode] || '';
    groups[st === 'visited' ? 'visited' : st === 'want' ? 'want' : 'plain'].push(regions[i]);
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

  // 2. casing 暗底描边（全部区域一次性）
  ctx.beginPath();
  for (let i = 0; i < regions.length; i++) {
    addRegionPath(ctx, regions[i], useCoarse, scale, tx, ty);
  }
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = PALETTE.casing;
  ctx.stroke();

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
}

/**
 * 创建渲染器：requestDraw 合帧（一帧最多绘制一次）
 */
function createRenderer(canvas, ctx) {
  let pending = false;
  let state = null;
  let destroyed = false;

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
        if (!destroyed && state) drawScene(ctx, state);
      });
    },
    /** 立即同步绘制（动画循环用） */
    drawNow(s) {
      if (!destroyed) drawScene(ctx, s);
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

module.exports = { PALETTE, createRenderer, drawScene };
