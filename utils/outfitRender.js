/**
 * 搭配图渲染（纯本地 Canvas）
 * 版式：上装 → 下装 → 鞋 垂直排列；包、配饰在右侧辅列，且面积明显小于主列。
 * 输出：800×800 白底 JPG。
 *
 * 衣物照片本身是白底方图，直接 contain 会浪费大量留白；
 * 这里先在缩小图上找「非白内容」包围盒，再按内容裁切绘制，让主体真正占满槽位。
 */
const SIZE = 800;
const ANALYSIS_MAX = 360;
const WHITE_TOLERANCE = 12; // 与纯白的通道差，超过视为衣物内容
const bboxCache = {};

function slotBoxes(hasSide) {
  if (!hasSide) {
    return {
      top: { x: 0.20, y: 0.05, w: 0.60, h: 0.27 },
      bottom: { x: 0.22, y: 0.34, w: 0.56, h: 0.26 },
      shoes: { x: 0.31, y: 0.68, w: 0.38, h: 0.12 }
    };
  }
  return {
    top: { x: 0.08, y: 0.05, w: 0.56, h: 0.27 },
    bottom: { x: 0.08, y: 0.34, w: 0.54, h: 0.26 },
    shoes: { x: 0.14, y: 0.68, w: 0.38, h: 0.12 }
  };
}

function sideBoxes(hasBag, accCount) {
  const out = [];
  if (hasBag) out.push({ kind: 'bag', x: 0.68, y: 0.07, w: 0.22, h: 0.18 });
  const startY = hasBag ? 0.33 : 0.13;
  for (let i = 0; i < accCount; i++) {
    out.push({ kind: 'acc', x: 0.68, y: startY + i * 0.20, w: 0.20, h: 0.16 });
  }
  return out;
}

function localize(src) {
  return new Promise(function (resolve) {
    if (!src) return resolve('');
    if (typeof wx.getImageInfo !== 'function') return resolve(src);
    wx.getImageInfo({
      src: src,
      success: function (r) { resolve(r.path || src); },
      fail: function () { resolve(src); }
    });
  });
}

function loadImage(canvas, src) {
  return new Promise(function (resolve) {
    if (!src) return resolve(null);
    let img;
    try {
      img = canvas.createImage();
    } catch (e) {
      return resolve(null);
    }
    img.onload = function () { resolve(img); };
    img.onerror = function () { resolve(null); };
    img.src = src;
  });
}

function prepareItem(canvas, item) {
  if (!item || !item.src) return Promise.resolve(null);
  return localize(item.src).then(function (p) {
    return loadImage(canvas, p);
  });
}

/** 在缩小图上找非白内容包围盒（原图坐标） */
function contentBox(canvas, img, key) {
  const iw = img.width;
  const ih = img.height;
  if (!iw || !ih) return null;
  if (bboxCache[key]) return bboxCache[key];

  const scale = Math.min(1, ANALYSIS_MAX / Math.max(iw, ih));
  const aw = Math.max(1, Math.round(iw * scale));
  const ah = Math.max(1, Math.round(ih * scale));
  canvas.width = aw;
  canvas.height = ah;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, aw, ah);
  ctx.drawImage(img, 0, 0, aw, ah);

  const data = ctx.getImageData(0, 0, aw, ah).data;
  let minX = aw;
  let minY = ah;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < ah; y++) {
    for (let x = 0; x < aw; x++) {
      const p = (y * aw + x) * 4;
      if (data[p + 3] < 16) continue;
      const diff = 255 - Math.min(data[p], data[p + 1], data[p + 2]);
      if (diff <= WHITE_TOLERANCE) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  let box;
  if (maxX < 0) {
    box = { x: 0, y: 0, w: iw, h: ih };
  } else {
    const padX = Math.max(1, Math.round((maxX - minX + 1) * 0.04));
    const padY = Math.max(1, Math.round((maxY - minY + 1) * 0.04));
    const bx = Math.max(0, minX - padX);
    const by = Math.max(0, minY - padY);
    const bw = Math.min(aw - 1, maxX + padX) - bx + 1;
    const bh = Math.min(ah - 1, maxY + padY) - by + 1;
    // 内容过小（白衣服贴白底、异常图）时不裁切，避免只剩一个角
    if (bw < aw * 0.18 && bh < ah * 0.18) {
      box = { x: 0, y: 0, w: iw, h: ih };
    } else {
      box = { x: bx / aw * iw, y: by / ah * ih, w: bw / aw * iw, h: bh / ah * ih };
    }
  }
  bboxCache[key] = box;
  return box;
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

function drawPlaceholder(ctx, box, label) {
  const x = box.x * SIZE;
  const y = box.y * SIZE;
  const w = box.w * SIZE;
  const h = box.h * SIZE;
  roundRect(ctx, x, y, w, h, 16);
  ctx.fillStyle = '#f5f7fb';
  ctx.fill();
  if (typeof ctx.setLineDash === 'function') ctx.setLineDash([8, 8]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#d7dfef';
  ctx.stroke();
  if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
  const fontSize = Math.max(16, Math.min(26, Math.round(h * 0.16)));
  ctx.fillStyle = '#9aa5bb';
  ctx.font = fontSize + 'px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + w / 2, y + h / 2);
}

function drawItem(ctx, canvas, img, box, bboxKey) {
  if (!img) return false;
  const box2 = contentBox(canvas, img, bboxKey);
  if (!box2) return false;
  const pad = 4;
  const bx = box.x * SIZE + pad;
  const by = box.y * SIZE + pad;
  const bw = box.w * SIZE - pad * 2;
  const bh = box.h * SIZE - pad * 2;
  const scale = Math.min(bw / box2.w, bh / box2.h);
  const dw = box2.w * scale;
  const dh = box2.h * scale;
  const dx = bx + (bw - dw) / 2;
  const dy = by + (bh - dh) / 2;
  ctx.drawImage(img, box2.x, box2.y, box2.w, box2.h, dx, dy, dw, dh);
  return true;
}

function exportCanvas(canvas) {
  return new Promise(function (resolve, reject) {
    wx.canvasToTempFilePath({
      canvas: canvas,
      fileType: 'jpg',
      quality: 0.92,
      destWidth: SIZE,
      destHeight: SIZE,
      success: function (r) { resolve(r.tempFilePath); },
      fail: function (e) { reject(e); }
    });
  });
}

/**
 * @param {Object} canvas Canvas 2D 节点
 * @param {Object} model {
 *   top, bottom, shoes, bag: { id, src, emoji } | null,
 *   accessories: [{ id, src, emoji }]
 * }
 * @returns {Promise<string>} 临时 JPG 路径
 */
function renderOutfit(canvas, model) {
  const m = model || {};
  const accs = Array.isArray(m.accessories) ? m.accessories.filter(Boolean) : [];
  return Promise.all([
    prepareItem(canvas, m.top),
    prepareItem(canvas, m.bottom),
    prepareItem(canvas, m.shoes),
    prepareItem(canvas, m.bag),
    Promise.all(accs.map(function (a) { return prepareItem(canvas, a); }))
  ]).then(function (res) {
    const hasSide = !!m.bag || accs.length > 0;
    const main = slotBoxes(hasSide);
    const side = sideBoxes(!!m.bag, accs.length);

    // 先在缩小图上算好所有内容包围盒（会临时改写 canvas 尺寸），再统一绘制
    const topKey = (m.top && m.top.src) || 'top';
    const bottomKey = (m.bottom && m.bottom.src) || 'bottom';
    const shoesKey = (m.shoes && m.shoes.src) || 'shoes';
    const bagKey = (m.bag && m.bag.src) || 'bag';
    const accIndex = res[4].map(function (img, i) { return { img: img, key: accs[i].src || ('acc_' + i) }; });
    const preps = [
      { img: res[0], key: topKey },
      { img: res[1], key: bottomKey },
      { img: res[2], key: shoesKey }
    ];
    if (m.bag) preps.push({ img: res[3], key: bagKey });
    accIndex.forEach(function (it) { preps.push(it); });
    preps.forEach(function (it) {
      if (it.img) contentBox(canvas, it.img, it.key);
    });

    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, SIZE, SIZE);

    const drewTop = drawItem(ctx, canvas, res[0], main.top, (m.top && m.top.src) || 'top');
    if (!drewTop) drawPlaceholder(ctx, main.top, '上装');

    const drewBottom = drawItem(ctx, canvas, res[1], main.bottom, (m.bottom && m.bottom.src) || 'bottom');
    if (!drewBottom) drawPlaceholder(ctx, main.bottom, '下装');

    const drewShoes = drawItem(ctx, canvas, res[2], main.shoes, (m.shoes && m.shoes.src) || 'shoes');
    if (!drewShoes) drawPlaceholder(ctx, main.shoes, '鞋');

    if (m.bag) {
      const bagBox = side[0];
      const drewBag = drawItem(ctx, canvas, res[3], bagBox, m.bag.src || 'bag');
      if (!drewBag) drawPlaceholder(ctx, bagBox, '包');
    }

    const accStart = m.bag ? 1 : 0;
    accs.forEach(function (a, i) {
      const box = side[accStart + i];
      if (!box) return;
      const drewAcc = drawItem(ctx, canvas, res[4][i], box, a.src || ('acc_' + i));
      if (!drewAcc) drawPlaceholder(ctx, box, '配饰');
    });

    return exportCanvas(canvas);
  });
}

module.exports = {
  SIZE: SIZE,
  renderOutfit: renderOutfit
};
