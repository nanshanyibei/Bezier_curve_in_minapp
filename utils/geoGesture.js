/**
 * 触摸手势状态机：单指 pan / 双指 pinch / tap / longpress
 * 约定：move 返回新 view（调用方负责 clampView 与重绘）；end 返回手势判定结果。
 */

function dist(a, b) {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function createState(onLongPress) {
  return {
    mode: 'none',        // 'none' | 'pan' | 'pinch'
    pinchLocked: false,  // 双指一旦开始，抬到单指也不恢复 tap 判定
    startT: 0,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    lastDist: 0,
    lastMidX: 0,
    lastMidY: 0,
    maxMove: 0,
    lpTimer: null,
    lpFired: false,
    onLongPress: onLongPress || null
  };
}

function clearLongPress(s) {
  if (s.lpTimer) {
    clearTimeout(s.lpTimer);
    s.lpTimer = null;
  }
}

function begin(s, touches) {
  s.startT = Date.now();
  s.lastX = touches[0].clientX;
  s.lastY = touches[0].clientY;
  s.startX = s.lastX;
  s.startY = s.lastY;
  s.maxMove = 0;
  s.lpFired = false;
  clearLongPress(s);

  if (touches.length >= 2) {
    s.mode = 'pinch';
    s.pinchLocked = true;
    s.lastDist = dist(touches[0], touches[1]);
    s.lastMidX = (touches[0].clientX + touches[1].clientX) / 2;
    s.lastMidY = (touches[0].clientY + touches[1].clientY) / 2;
  } else {
    s.mode = 'pan';
    // 长按判定：550ms 内位移 ≤8px
    if (s.onLongPress) {
      s.lpTimer = setTimeout(() => {
        if (s.maxMove <= 8 && !s.pinchLocked) {
          s.lpFired = true;
          s.onLongPress(s.lastX, s.lastY);
        }
      }, 550);
    }
  }
}

function move(s, touches, view, geoMap) {
  if (!touches || !touches.length) return view;

  if (touches.length >= 2 || s.mode === 'pinch') {
    s.mode = 'pinch';
    s.pinchLocked = true;
    clearLongPress(s);
    if (touches.length >= 2) {
      const d = dist(touches[0], touches[1]);
      const mx = (touches[0].clientX + touches[1].clientX) / 2;
      const my = (touches[0].clientY + touches[1].clientY) / 2;
      // 1) 围绕双指中心缩放（增量比，焦点世界坐标不动）
      if (s.lastDist > 0 && d > 0) {
        view = geoMap.zoomAt(view, d / s.lastDist, mx, my);
      }
      // 2) 叠加双指整体平移
      if (s.lastDist > 0) {
        view = geoMap.panBy(view, mx - s.lastMidX, my - s.lastMidY);
      }
      s.lastDist = d;
      s.lastMidX = mx;
      s.lastMidY = my;
      s.lastX = touches[0].clientX;
      s.lastY = touches[0].clientY;
    }
    return view;
  }

  // 单指拖动
  const x = touches[0].clientX;
  const y = touches[0].clientY;
  const dx = x - s.lastX;
  const dy = y - s.lastY;
  s.lastX = x;
  s.lastY = y;
  const moveX = Math.abs(x - s.startX);
  const moveY = Math.abs(y - s.startY);
  if (moveX > s.maxMove) s.maxMove = moveX;
  if (moveY > s.maxMove) s.maxMove = moveY;
  if (s.maxMove > 8) clearLongPress(s);
  return geoMap.panBy(view, dx, dy);
}

function end(s, touches) {
  const dt = Date.now() - s.startT;
  let gesture = 'none';
  const moved = s.maxMove > 8;

  if (!touches || !touches.length) {
    if (s.lpFired) gesture = 'longpress';
    else if (!moved && !s.pinchLocked && dt < 300 && s.mode === 'pan') gesture = 'tap';
    s.mode = 'none';
    s.pinchLocked = false;
    s.lastDist = 0;
  }
  clearLongPress(s);
  return { gesture: gesture, x: s.lastX, y: s.lastY };
}

function cancel(s) {
  clearLongPress(s);
  s.mode = 'none';
  s.pinchLocked = false;
  s.lastDist = 0;
}

module.exports = { createState, begin, move, end, cancel };
