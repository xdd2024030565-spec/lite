/*!
 * cf-bubble.js —— Cloudflare 节点悬浮球（纯 ES5，全站点通用）
 *
 * 用法：在任意页面的 </body> 前加一行即可，无需其它配置：
 *     <script src="cf-bubble.js"></script>
 *
 * 功能：
 *   · 实时显示当前走的 Cloudflare 边缘节点（cf-ray 尾部的三字码，如 AMS/HKG/NRT）
 *   · 拖动到任意位置，位置会被记住
 *   · 拖到屏幕边缘自动半透明并贴边隐藏，点一下再出来
 *   · 点击数字可手动刷新 / 换用备用入口
 *
 * 探测目标可在 window.CF_BUBBLE_TARGETS 里覆盖（数组，元素含 url 与可选 name）。
 * 不依赖任何库，不使用 const/let/箭头函数/Promise/fetch，老设备与内嵌 WebView 可用。
 */
(function () {
  'use strict';

  if (window.__cfBubbleLoaded) return;   /* 防止重复注入 */
  window.__cfBubbleLoaded = true;

  /* ---------------- 配置 ---------------- */
  var STORE_KEY = 'cfbubble_pos';
  var EDGE_HIDE_PX = 18;      /* 距边缘多少像素内视为「贴边」 */
  var EDGE_ALPHA = 0.28;      /* 贴边后的透明度 */
  var POLL_MS = 60000;        /* 自动刷新间隔 */
  var TIMEOUT_MS = 8000;

  /* 默认探测目标：拿到的 cf-ray 与响应耗时就能说明当前节点 */
  /* 探测目标。首选自带 /cfnode 的 Worker：它把边缘节点写进响应体，
   * 这是跨域时唯一可靠的方式（cf-ray 响应头默认不对 JS 暴露）。
   * 其余为兜底：能连通即可，但拿不到节点名。 */
  var TARGETS = window.CF_BUBBLE_TARGETS || [
    { url: 'https://vault-sync.yongjiu.ccwu.cc/cfnode', name: 'vault-sync', node: 1 },
    { url: 'https://nav.yongjiu.ccwu.cc/health', name: 'nav', node: 0 },
    { url: 'https://reader.yongjiu.ccwu.cc/reader/list', name: 'reader', node: 0 }
  ];

  /* CF 机场三字码 → 中文城市（常见节点，未收录的直接显示三字码） */
  var COLO = {
    AMS: '阿姆斯特丹', HKG: '香港', TPE: '台北', NRT: '东京', KIX: '大阪', ICN: '首尔',
    SIN: '新加坡', BKK: '曼谷', KUL: '吉隆坡', CGK: '雅加达', MNL: '马尼拉',
    SJC: '圣何塞', LAX: '洛杉矶', SEA: '西雅图', ORD: '芝加哥', DFW: '达拉斯',
    IAD: '华盛顿', EWR: '纽瓦克', ATL: '亚特兰大', MIA: '迈阿密',
    LHR: '伦敦', CDG: '巴黎', FRA: '法兰克福', AMS2: '阿姆斯特丹', MAD: '马德里',
    MXP: '米兰', WAW: '华沙', ARN: '斯德哥尔摩', DUB: '都柏林', ZRH: '苏黎世',
    SYD: '悉尼', MEL: '墨尔本', AKL: '奥克兰', GRU: '圣保罗', JNB: '约翰内斯堡',
    DXB: '迪拜', BOM: '孟买', DEL: '新德里', SGN: '胡志明'
  };

  /* ---------------- 工具 ---------------- */
  function $(id) { return document.getElementById(id); }
  function now() { return new Date().getTime(); }

  function loadPos() {
    try {
      var raw = window.localStorage ? localStorage.getItem(STORE_KEY) : '';
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (p && typeof p.x === 'number' && typeof p.y === 'number') return p;
    } catch (e) {}
    return null;
  }
  function savePos(x, y) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ x: x, y: y })); } catch (e) {}
  }

  /* ---------------- 探测 ---------------- */
  var state = { colo: '', ip: '', ms: 0, host: '', ok: false, busy: false, idx: 0 };

  function probe(cb) {
    var t = TARGETS[state.idx % TARGETS.length];
    var tryStart = state.idx;
    var x = null, done = false, timer = null, t0 = now();

    function finish(ok, colo, ip, ms) {
      if (done) return;
      done = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (!ok) {
        /* 这个入口失败就立刻换下一个候选，全部试过才算真的不可用。
         * 实测单个入口约 20% 概率偶然失败，顺着切换即可显著提高成功率。 */
        var tried = state.idx - tryStart;
        if (tried < TARGETS.length - 1) {
          state.idx++;
          probeRetry(cb);
          return;
        }
      }
      state.ok = ok;
      state.colo = colo || '';
      state.ip = ip || '';
      state.ms = ms || 0;
      state.host = t.name || '';
      if (cb) cb();
    }
    function probeRetry(next) {
      /* 换个入口再探一次（递归深度由 TARGETS 长度封顶） */
      setTimeout(function () { probe(next); }, 60);
    }

    try {
      x = window.XMLHttpRequest ? new XMLHttpRequest() : null;
    } catch (e) { x = null; }
    if (!x) { finish(false); return; }

    x.open('GET', t.url, true);
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      var ms = now() - t0;
      /* 只要能拿到 cf-ray 就算连通 —— 不管业务状态码。
       * 很多子域的 /health 其实是 404，但 Cloudflare 照样回了 cf-ray，
       * 说明「到 CF 节点的链路是通的」，这正是悬浮球要显示的东西。 */
      var ray = '';
      try { ray = x.getResponseHeader('cf-ray') || ''; } catch (e) { ray = ''; }
      var colo = '';
      if (ray) {
        var parts = String(ray).split('-');
        if (parts.length > 1) colo = parts[parts.length - 1].toUpperCase();
      }
      /* 自带 /cfnode 的入口会在响应体里给出 colo，优先采用 */
      if (!colo && t.node) {
        try {
          var j = JSON.parse(x.responseText || '{}');
          if (j && j.colo) colo = String(j.colo).toUpperCase();
        } catch (e) {}
      }
      /* 只要有响应就算通（即使业务码是 404/401，链路也是好的） */
      if (colo || (x.status > 0 && x.status < 500)) finish(true, colo, '', ms);
      else finish(false, '', '', ms);
    };
    timer = setTimeout(function () {
      if (done) return;
      finish(false);
      try { x.abort(); } catch (e) {}
    }, TIMEOUT_MS);
    try { x.send(); } catch (e) { finish(false); }
  }

  /* ---------------- 样式 ---------------- */
  function injectStyle() {
    if ($('__cfb_style')) return;
    var css = [
      '#__cfb{position:fixed;z-index:2147483000;width:52px;height:52px;border-radius:50%;',
      'background:rgba(0,102,204,.92);color:#fff;display:flex;align-items:center;justify-content:center;',
      'flex-direction:column;font-size:11px;line-height:1.15;cursor:pointer;user-select:none;',
      '-webkit-user-select:none;touch-action:none;box-shadow:0 2px 10px rgba(0,0,0,.3);',
      'font-family:-apple-system,"PingFang SC","Microsoft YaHei",Arial,sans-serif;',
      'transition:opacity .18s,transform .18s;overflow:hidden;text-align:center}',
      '#__cfb.edge{opacity:.28}',
      '#__cfb.edge:hover{opacity:1}',
      '#__cfb.bad{background:rgba(153,0,0,.92)}',
      '#__cfb.busy{opacity:.6}',
      '#__cfb .c{font-size:12px;font-weight:700;letter-spacing:.3px}',
      '#__cfb .m{font-size:9px;opacity:.85}',
      '#__cfb_tip{position:fixed;z-index:2147483001;background:rgba(0,0,0,.86);color:#fff;',
      'padding:6px 10px;border-radius:6px;font-size:12px;line-height:1.5;white-space:pre;',
      'pointer-events:none;display:none;max-width:70vw;font-family:-apple-system,"PingFang SC","Microsoft YaHei",Arial,sans-serif}'
    ].join('');
    var s = document.createElement('style');
    s.id = '__cfb_style';
    if (s.styleSheet) s.styleSheet.cssText = css; else s.appendChild(document.createTextNode(css));
    (document.getElementsByTagName('head')[0] || document.body).appendChild(s);
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    var el = $('__cfb');
    if (!el) return;
    var c, m, cls = '';
    if (state.busy) {
      c = '···'; m = '探测中'; cls = ' busy';
    } else if (state.ok) {
      c = state.colo || 'CF';
      m = state.ms > 0 ? (state.ms + 'ms') : '正常';
    } else {
      c = '✕'; m = '不可用'; cls = ' bad';
    }
    el.className = cls.replace(/^\s+/, '');
    el.innerHTML = '<div class="c">' + c + '</div><div class="m">' + m + '</div>';
    applyEdge();
  }

  function tipText() {
    var lines = [];
    if (state.ok) {
      var city = COLO[state.colo] || '';
      lines.push('Cloudflare 节点：' + (state.colo || '未知') + (city ? '（' + city + '）' : ''));
      lines.push('响应：' + state.ms + ' ms');
      if (state.host) lines.push('探测入口：' + state.host);
    } else {
      lines.push('当前网络访问 Cloudflare 失败');
    }
    lines.push('');
    lines.push('点击：刷新节点信息');
    lines.push('拖动：移动到任意位置');
    return lines.join('\n');
  }

  function showTip(x, y) {
    var t = $('__cfb_tip');
    if (!t) return;
    t.textContent = tipText();
    t.style.display = 'block';
    var w = t.offsetWidth, h = t.offsetHeight;
    var left = x + 62, top = y;
    if (left + w > (window.innerWidth || 320) - 8) left = x - w - 10;
    if (left < 6) left = 6;
    if (top + h > (window.innerHeight || 480) - 8) top = (window.innerHeight || 480) - h - 8;
    if (top < 6) top = 6;
    t.style.left = left + 'px';
    t.style.top = top + 'px';
  }
  function hideTip() {
    var t = $('__cfb_tip');
    if (t) t.style.display = 'none';
  }

  /* ---------------- 位置与贴边 ---------------- */
  function clampPos(x, y) {
    var w = window.innerWidth || 320, h = window.innerHeight || 480;
    var size = 52;
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x > w - size) x = w - size;
    if (y > h - size) y = h - size;
    return { x: x, y: y };
  }

  function applyEdge() {
    var el = $('__cfb');
    if (!el) return;
    var x = parseFloat(el.style.left) || 0;
    var y = parseFloat(el.style.top) || 0;
    var w = window.innerWidth || 320, h = window.innerHeight || 480, size = 52;
    var atEdge = (x <= EDGE_HIDE_PX || y <= EDGE_HIDE_PX || x >= w - size - EDGE_HIDE_PX || y >= h - size - EDGE_HIDE_PX);
    /* 贴边时再往外推一点，只露出一角 */
    if (atEdge) {
      if (x <= EDGE_HIDE_PX) x = -size * 0.45;
      else if (x >= w - size - EDGE_HIDE_PX) x = w - size * 0.55;
      if (y <= EDGE_HIDE_PX) y = -size * 0.45;
      else if (y >= h - size - EDGE_HIDE_PX) y = h - size * 0.55;
      el.className = el.className.replace(/\s*edge/g, '') + ' edge';
    } else {
      el.className = el.className.replace(/\s*edge/g, '');
    }
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  }

  /* ---------------- 交互 ---------------- */
  var drag = { on: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0 };

  function bind(el) {
    function point(e) {
      e = e || window.event;
      if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
      if (e.changedTouches && e.changedTouches[0]) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
      return { x: e.clientX || 0, y: e.clientY || 0 };
    }

    function down(e) {
      var p = point(e);
      drag.on = true; drag.moved = false;
      drag.sx = p.x; drag.sy = p.y;
      drag.ox = parseFloat(el.style.left) || 0;
      drag.oy = parseFloat(el.style.top) || 0;
      hideTip();
      if (e.preventDefault) e.preventDefault();
    }
    function move(e) {
      if (!drag.on) return;
      var p = point(e);
      var dx = p.x - drag.sx, dy = p.y - drag.sy;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
      var np = clampPos(drag.ox + dx, drag.oy + dy);
      el.style.left = np.x + 'px';
      el.style.top = np.y + 'px';
      el.className = el.className.replace(/\s*edge/g, '');
      if (e.preventDefault) e.preventDefault();
    }
    function up(e) {
      if (!drag.on) return;
      drag.on = false;
      if (drag.moved) {
        /* 松手时贴边收起 */
        applyEdge();
        var x = parseFloat(el.style.left) || 0, y = parseFloat(el.style.top) || 0;
        savePos(x, y);
      } else {
        /* 没拖动 = 点击：刷新 */
        refresh();
      }
    }

    el.addEventListener ? el.addEventListener('mousedown', down, false) : el.attachEvent('onmousedown', down);
    el.addEventListener ? el.addEventListener('touchstart', down, false) : null;

    if (document.addEventListener) {
      document.addEventListener('mousemove', move, false);
      document.addEventListener('mouseup', up, false);
      document.addEventListener('touchmove', move, false);
      document.addEventListener('touchend', up, false);
    } else {
      document.attachEvent('onmousemove', move);
      document.attachEvent('onmouseup', up);
    }

    /* 长按/悬停显示详情（桌面） */
    el.addEventListener && el.addEventListener('mouseover', function () {
      if (drag.on) return;
      var x = parseFloat(el.style.left) || 0, y = parseFloat(el.style.top) || 0;
      if (el.className.indexOf('edge') >= 0) {
        /* 贴边状态：先弹出来 */
        el.className = el.className.replace(/\s*edge/g, '');
      }
      showTip(x, y);
    }, false);
    el.addEventListener && el.addEventListener('mouseout', function () {
      if (drag.on) return;
      hideTip();
      applyEdge();
    }, false);
  }

  function refresh() {
    if (state.busy) return;
    state.busy = true;
    render();
    state.idx++;
    probe(function () {
      state.busy = false;
      render();
      var el = $('__cfb');
      if (el) {
        var x = parseFloat(el.style.left) || 0, y = parseFloat(el.style.top) || 0;
        showTip(x, y);
        setTimeout(hideTip, 2200);
      }
    });
  }

  /* ---------------- 启动 ---------------- */
  function start() {
    injectStyle();

    var el = document.createElement('div');
    el.id = '__cfb';
    var t = document.createElement('div');
    t.id = '__cfb_tip';

    var p = loadPos();
    var np = clampPos(p ? p.x : (window.innerWidth || 320) - 72, p ? p.y : 120);
    el.style.left = np.x + 'px';
    el.style.top = np.y + 'px';

    document.body.appendChild(el);
    document.body.appendChild(t);

    bind(el);
    render();
    probe(function () { render(); });

    setInterval(function () {
      if (document.hidden) return;
      probe(function () { render(); });
    }, POLL_MS);

    var rt = null;
    window.addEventListener && window.addEventListener('resize', function () {
      if (rt) clearTimeout(rt);
      rt = setTimeout(function () {
        var x = parseFloat(el.style.left) || 0, y = parseFloat(el.style.top) || 0;
        var c = clampPos(x, y);
        el.style.left = c.x + 'px'; el.style.top = c.y + 'px';
        applyEdge();
      }, 150);
    }, false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener
      ? document.addEventListener('DOMContentLoaded', start, false)
      : document.attachEvent('onreadystatechange', function () { if (document.readyState === 'complete') start(); });
  } else {
    start();
  }
})();
