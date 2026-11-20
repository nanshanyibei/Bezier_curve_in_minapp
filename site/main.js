(function () {
  'use strict';

  var PAD = 40;
  var SPAN = 340;

  var svg = document.getElementById('bezier-svg');
  var path = document.getElementById('curve-path');
  var guide1 = document.getElementById('guide-1');
  var guide2 = document.getElementById('guide-2');
  var handle1 = document.getElementById('handle-1');
  var handle2 = document.getElementById('handle-2');
  var output = document.getElementById('bezier-output');
  var p1Val = document.getElementById('p1-val');
  var p2Val = document.getElementById('p2-val');
  var chips = Array.prototype.slice.call(document.querySelectorAll('#presets .chip'));
  var copyBtn = document.getElementById('copy');
  var playBtn = document.getElementById('play');
  var track = document.querySelector('.demo-track');
  var dot = document.getElementById('demo-dot');

  var cp = { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 };
  var dragging = null;

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function toX(v) {
    return PAD + v * SPAN;
  }

  function toY(v) {
    return PAD + SPAN - v * SPAN;
  }

  function fmt(n) {
    return String(Math.round(n * 100) / 100);
  }

  function bezierValue() {
    return 'cubic-bezier(' + fmt(cp.x1) + ', ' + fmt(cp.y1) + ', ' + fmt(cp.x2) + ', ' + fmt(cp.y2) + ')';
  }

  function render() {
    var p0x = toX(0), p0y = toY(0);
    var p3x = toX(1), p3y = toY(1);
    var p1x = toX(cp.x1), p1y = toY(cp.y1);
    var p2x = toX(cp.x2), p2y = toY(cp.y2);

    path.setAttribute('d',
      'M' + p0x + ' ' + p0y +
      ' C ' + p1x + ' ' + p1y + ' ' + p2x + ' ' + p2y + ' ' + p3x + ' ' + p3y);

    guide1.setAttribute('x2', p1x);
    guide1.setAttribute('y2', p1y);
    guide2.setAttribute('x2', p2x);
    guide2.setAttribute('y2', p2y);

    handle1.setAttribute('cx', p1x);
    handle1.setAttribute('cy', p1y);
    handle2.setAttribute('cx', p2x);
    handle2.setAttribute('cy', p2y);

    var css = bezierValue();
    output.textContent = css;
    p1Val.textContent = fmt(cp.x1) + ', ' + fmt(cp.y1);
    p2Val.textContent = fmt(cp.x2) + ', ' + fmt(cp.y2);

    var matched = null;
    chips.forEach(function (chip) {
      var v = chip.getAttribute('data-v').split(',').map(Number);
      var hit = Math.abs(v[0] - cp.x1) < 0.005 &&
                Math.abs(v[1] - cp.y1) < 0.005 &&
                Math.abs(v[2] - cp.x2) < 0.005 &&
                Math.abs(v[3] - cp.y2) < 0.005;
      chip.classList.toggle('active', hit);
      if (hit) matched = chip;
    });

    if (dot) {
      dot.style.transitionTimingFunction = css;
    }
    return matched;
  }

  function clientToValue(event) {
    var rect = svg.getBoundingClientRect();
    var x = (event.clientX - rect.left) / rect.width * 420;
    var y = (event.clientY - rect.top) / rect.height * 420;
    return {
      x: clamp((x - PAD) / SPAN, 0, 1),
      y: clamp((PAD + SPAN - y) / SPAN, -0.2, 1.2)
    };
  }

  function onPointerDown(event) {
    var index = event.currentTarget.getAttribute('data-i');
    dragging = index;
    svg.classList.add('dragging');
    svg.setPointerCapture && svg.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!dragging) return;
    var v = clientToValue(event);
    if (dragging === '1') {
      cp.x1 = v.x;
      cp.y1 = v.y;
    } else {
      cp.x2 = v.x;
      cp.y2 = v.y;
    }
    render();
    event.preventDefault();
  }

  function onPointerUp() {
    if (!dragging) return;
    dragging = null;
    svg.classList.remove('dragging');
  }

  [handle1, handle2].forEach(function (h) {
    h.addEventListener('pointerdown', onPointerDown);
  });
  svg.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      var v = chip.getAttribute('data-v').split(',').map(Number);
      cp.x1 = v[0];
      cp.y1 = v[1];
      cp.x2 = v[2];
      cp.y2 = v[3];
      render();
      play();
    });
  });

  function play() {
    if (!track || !dot) return;
    var distance = Math.max(0, track.clientWidth - dot.offsetWidth);
    dot.style.transition = 'none';
    dot.style.transform = 'translateX(0)';
    void dot.offsetWidth;
    dot.style.transition = 'transform 1.2s ' + bezierValue();
    dot.style.transform = 'translateX(' + distance + 'px)';
  }

  playBtn.addEventListener('click', play);

  copyBtn.addEventListener('click', function () {
    var text = bezierValue();
    var done = function () {
      copyBtn.classList.add('done');
      copyBtn.textContent = '已复制';
      setTimeout(function () {
        copyBtn.classList.remove('done');
        copyBtn.textContent = '复制';
      }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      var area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(area);
      done();
    }
  });

  render();

  var reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in-view');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add('in-view'); });
  }
})();
