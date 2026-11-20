/**
 * 衣物照片本地处理（无网络、无第三方服务）
 * - A 白底美化：边框取样灰世界白平衡 + 800×800 白底方图（主体留 8% 白边）
 * - B 简易去背景：边框种子泛洪，纯色/近纯色背景替换为纯白；不可靠时自动降级 A
 * - 透明 PNG：按 alpha 直接铺白底，适配手机相册「长按抠图」产物
 *
 * 纯像素函数（whiteBalancePixels / cutoutMask / compositeWhite）单独导出，便于本地验证。
 */
const WORK_MAX = 900;
const OUT_SIZE = 800;
const MARGIN_RATIO = 0.08;
const OUT_QUALITY = 0.92;

const MODES = {
  CUTOUT: 'cutout',
  WHITE: 'white',
  ORIGINAL: 'original'
};

function clamp(v, a, b) {
  return Math.min(Math.max(v, a), b);
}

function median(arr) {
  if (!arr || !arr.length) return 0;
  const a = Array.prototype.slice.call(arr).sort(function (x, y) { return x - y; });
  return a[a.length >> 1];
}

/** 取四周 2px 环带样本（角点会重复计入，可接受） */
function collectBorder(data, w, h) {
  const out = { r: [], g: [], b: [], total: 0, transparent: 0 };
  function add(i) {
    const p = i * 4;
    out.total++;
    if (data[p + 3] < 16) { out.transparent++; return; }
    out.r.push(data[p]);
    out.g.push(data[p + 1]);
    out.b.push(data[p + 2]);
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < 2 && y < h; y++) add(y * w + x);
    for (let y = Math.max(0, h - 2); y < h; y++) add(y * w + x);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < 2 && x < w; x++) add(y * w + x);
    for (let x = Math.max(0, w - 2); x < w; x++) add(y * w + x);
  }
  return out;
}

/**
 * 灰世界白平衡：以边框颜色为参考，把通道增益限制在 0.85~1.2
 * 就地修改 data；返回 { applied, gains }
 */
function whiteBalancePixels(data, w, h) {
  const s = collectBorder(data, w, h);
  if (s.r.length < 100) return { applied: false, gains: [1, 1, 1] };
  const mr = median(s.r);
  const mg = median(s.g);
  const mb = median(s.b);
  if (!mr || !mg || !mb) return { applied: false, gains: [1, 1, 1] };
  const target = (mr + mg + mb) / 3;
  const gains = [
    clamp(target / mr, 0.85, 1.2),
    clamp(target / mg, 0.85, 1.2),
    clamp(target / mb, 0.85, 1.2)
  ];
  if (Math.abs(gains[0] - 1) < 0.01 && Math.abs(gains[1] - 1) < 0.01
    && Math.abs(gains[2] - 1) < 0.01) {
    return { applied: false, gains: gains };
  }
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.round(clamp(data[i] * gains[0], 0, 255));
    data[i + 1] = Math.round(clamp(data[i + 1] * gains[1], 0, 255));
    data[i + 2] = Math.round(clamp(data[i + 2] * gains[2], 0, 255));
  }
  return { applied: true, gains: gains };
}

/**
 * 生成背景掩码：1 = 背景，0 = 主体
 * 返回 { mask, coverage, transparent?, threshold? }；背景太复杂 / 判定不可靠时返回 null
 */
function cutoutMask(data, w, h) {
  const total = w * h;
  const s = collectBorder(data, w, h);
  if (!s.total) return null;

  // 已经是透明底（手机相册长按抠图）：直接把透明像素当背景
  if (s.transparent / s.total > 0.6) {
    const mask = new Uint8Array(total);
    let count = 0;
    for (let i = 0; i < total; i++) {
      if (data[i * 4 + 3] < 16) { mask[i] = 1; count++; }
    }
    const cov = count / total;
    if (cov < 0.005 || cov > 0.98) return null;
    return { mask: mask, coverage: cov, transparent: true };
  }

  if (s.r.length < 50) return null;
  const mr = median(s.r);
  const mg = median(s.g);
  const mb = median(s.b);

  const dists = new Float64Array(s.r.length);
  for (let i = 0; i < s.r.length; i++) {
    const dr = s.r[i] - mr;
    const dg = s.g[i] - mg;
    const db = s.b[i] - mb;
    dists[i] = Math.sqrt(dr * dr + dg * dg + db * db);
  }
  const d50 = median(dists);
  const thr = clamp(d50 * 2.5 + 16, 24, 56);

  let near = 0;
  for (let i = 0; i < dists.length; i++) if (dists[i] <= thr) near++;
  if (near / dists.length < 0.6) return null;

  const thr2 = thr * thr;
  const mask = new Uint8Array(total);
  const stack = new Int32Array(total);
  let top = 0;
  let count = 0;

  function isBg(idx) {
    const p = idx * 4;
    const dr = data[p] - mr;
    const dg = data[p + 1] - mg;
    const db = data[p + 2] - mb;
    return dr * dr + dg * dg + db * db <= thr2;
  }

  function seed(idx) {
    if (mask[idx] || !isBg(idx)) return;
    mask[idx] = 1;
    stack[top++] = idx;
    count++;
  }

  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }

  while (top > 0) {
    const idx = stack[--top];
    const x = idx % w;
    if (x > 0) seed(idx - 1);
    if (x < w - 1) seed(idx + 1);
    if (idx >= w) seed(idx - w);
    if (idx < total - w) seed(idx + w);
  }

  const coverage = count / total;
  if (coverage < 0.12 || coverage > 0.92) return null;
  return { mask: mask, coverage: coverage, threshold: thr };
}

/** 背景铺白、半透明像素与白底混合、主体边缘 45% 白羽化 */
function compositeWhite(data, w, h, mask) {
  const total = w * h;
  for (let i = 0; i < total; i++) {
    const p = i * 4;
    if (mask && mask[i]) {
      data[p] = 255;
      data[p + 1] = 255;
      data[p + 2] = 255;
      data[p + 3] = 255;
      continue;
    }
    const a = data[p + 3];
    if (a < 255) {
      const k = a / 255;
      data[p] = Math.round(data[p] * k + 255 * (1 - k));
      data[p + 1] = Math.round(data[p + 1] * k + 255 * (1 - k));
      data[p + 2] = Math.round(data[p + 2] * k + 255 * (1 - k));
    }
    if (mask) {
      const x = i % w;
      const y = (i / w) | 0;
      const edge = (x > 0 && mask[i - 1])
        || (x < w - 1 && mask[i + 1])
        || (y > 0 && mask[i - w])
        || (y < h - 1 && mask[i + w]);
      if (edge) {
        data[p] = Math.round(data[p] * 0.55 + 255 * 0.45);
        data[p + 1] = Math.round(data[p + 1] * 0.55 + 255 * 0.45);
        data[p + 2] = Math.round(data[p + 2] * 0.55 + 255 * 0.45);
      }
    }
    data[p + 3] = 255;
  }
}

/** EXIF orientation → Canvas 变换矩阵（原图坐标） */
function orientMatrix(orientation, ow, oh) {
  switch (orientation) {
    case 'up-mirrored': return [-1, 0, 0, 1, ow, 0];
    case 'down': return [-1, 0, 0, -1, ow, oh];
    case 'down-mirrored': return [1, 0, 0, -1, 0, oh];
    case 'left-mirrored': return [0, 1, 1, 0, 0, 0];
    case 'right': return [0, 1, -1, 0, oh, 0];
    case 'right-mirrored': return [0, -1, -1, 0, oh, ow];
    case 'left': return [0, -1, 1, 0, 0, ow];
    default: return [1, 0, 0, 1, 0, 0];
  }
}

function isSwappedOrientation(o) {
  return o === 'left' || o === 'right' || o === 'left-mirrored' || o === 'right-mirrored';
}

function loadImage(canvas, src) {
  return new Promise(function (resolve, reject) {
    let img;
    try {
      img = canvas.createImage();
    } catch (e) {
      reject(e);
      return;
    }
    img.onload = function () { resolve(img); };
    img.onerror = function () { reject(new Error('图片加载失败')); };
    img.src = src;
  });
}

function getImageInfo(src) {
  return new Promise(function (resolve) {
    if (typeof wx.getImageInfo !== 'function') return resolve(null);
    wx.getImageInfo({
      src: src,
      success: function (r) {
        resolve({
          width: r.width,
          height: r.height,
          orientation: r.orientation || 'up'
        });
      },
      fail: function () { resolve(null); }
    });
  });
}

function exportCanvas(canvas) {
  return new Promise(function (resolve, reject) {
    wx.canvasToTempFilePath({
      canvas: canvas,
      fileType: 'jpg',
      quality: OUT_QUALITY,
      destWidth: canvas.width,
      destHeight: canvas.height,
      success: function (r) { resolve(r.tempFilePath); },
      fail: function (e) { reject(e); }
    });
  });
}

/** 前景包围盒（mask 中 0 为主体），无前景时返回整幅 */
function foregroundBox(mask, w, h) {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[row + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w: w, h: h };
  const pad = 4;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * 处理一张图，返回最终白底 JPG 的临时路径
 * @param {{src:string, mode:string, workCanvas:Object, outCanvas:Object}} opts
 * @returns {Promise<{path:string, applied:string, fallback:boolean}>}
 */
function processImage(opts) {
  const src = opts && opts.src;
  const mode = (opts && opts.mode) || MODES.CUTOUT;
  const workCanvas = opts && opts.workCanvas;
  const outCanvas = opts && opts.outCanvas;
  if (!src || !workCanvas || !outCanvas) {
    return Promise.reject(new Error('缺少图片或画布'));
  }

  let wInfo = null;
  let img = null;
  return getImageInfo(src).then(function (info) {
    wInfo = info;
    return loadImage(workCanvas, src);
  }).then(function (image) {
    img = image;
    const ow = (wInfo && wInfo.width) || img.width;
    const oh = (wInfo && wInfo.height) || img.height;
    if (!ow || !oh) throw new Error('图片尺寸异常');

    const orientation = (wInfo && wInfo.orientation) || 'up';
    const swap = isSwappedOrientation(orientation);
    const scale = Math.min(1, WORK_MAX / Math.max(ow, oh));
    const w = Math.max(1, Math.round((swap ? oh : ow) * scale));
    const h = Math.max(1, Math.round((swap ? ow : oh) * scale));

    workCanvas.width = w;
    workCanvas.height = h;
    const wctx = workCanvas.getContext('2d');
    wctx.setTransform(1, 0, 0, 1, 0, 0);
    wctx.clearRect(0, 0, w, h);

    const m = orientMatrix(orientation, ow, oh);
    wctx.setTransform(m[0] * scale, m[1] * scale, m[2] * scale, m[3] * scale,
      m[4] * scale, m[5] * scale);
    wctx.drawImage(img, 0, 0);
    wctx.setTransform(1, 0, 0, 1, 0, 0);

    const imageData = wctx.getImageData(0, 0, w, h);
    const data = imageData.data;

    whiteBalancePixels(data, w, h);

    let mask = null;
    let fallback = false;
    if (mode === MODES.CUTOUT) {
      const cut = cutoutMask(data, w, h);
      if (cut) mask = cut.mask;
      else fallback = true;
    }
    compositeWhite(data, w, h, mask);
    wctx.putImageData(imageData, 0, 0);

    return exportCanvas(workCanvas).then(function (workPath) {
      const outCtx = outCanvas.getContext('2d');
      outCanvas.width = OUT_SIZE;
      outCanvas.height = OUT_SIZE;
      outCtx.setTransform(1, 0, 0, 1, 0, 0);
      outCtx.fillStyle = '#ffffff';
      outCtx.fillRect(0, 0, OUT_SIZE, OUT_SIZE);

      return loadImage(outCanvas, workPath).then(function (workImg) {
        const box = mask ? foregroundBox(mask, w, h) : { x: 0, y: 0, w: w, h: h };
        const inner = OUT_SIZE * (1 - 2 * MARGIN_RATIO);
        const k = Math.min(inner / box.w, inner / box.h);
        const dw = box.w * k;
        const dh = box.h * k;
        const dx = (OUT_SIZE - dw) / 2;
        const dy = (OUT_SIZE - dh) / 2;
        outCtx.drawImage(workImg, box.x, box.y, box.w, box.h, dx, dy, dw, dh);
        return exportCanvas(outCanvas).then(function (outPath) {
          return {
            path: outPath,
            applied: mask ? MODES.CUTOUT : MODES.WHITE,
            fallback: fallback
          };
        });
      });
    });
  });
}

module.exports = {
  MODES: MODES,
  WORK_MAX: WORK_MAX,
  OUT_SIZE: OUT_SIZE,
  processImage: processImage,
  whiteBalancePixels: whiteBalancePixels,
  cutoutMask: cutoutMask,
  compositeWhite: compositeWhite
};
