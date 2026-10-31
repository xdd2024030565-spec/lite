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
    { url: 'https://reader.yongjiu.ccwu.cc/reader/list', name: 'reader', node: 0 },
    { url: 'https://deepseek-web.yongjiu.ccwu.cc/health', name: 'deepseek-web', node: 0 },
    { url: 'https://api.yongjiu.ccwu.cc/', name: 'api', node: 0 },
    { url: 'https://api2.yongjiu.ccwu.cc/', name: 'api2', node: 0 }
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

  var TARGET_KEY = 'cfbubble_target';
  var AUTO_KEY = 'cfbubble_auto';
  function loadTarget() {
    try {
      var a = localStorage.getItem(AUTO_KEY);
      state.auto = (a === null) ? true : (a === '1');
      var v = localStorage.getItem(TARGET_KEY);
      if (v !== null) {
        var n = parseInt(v, 10);
        if (!isNaN(n) && n >= 0 && n < TARGETS.length) state.idx = n;
      }
    } catch (e) {}
  }
  function saveTarget(i) {
    try { localStorage.setItem(TARGET_KEY, String(i)); } catch (e) {}
  }
  function saveAuto(on) {
    try { localStorage.setItem(AUTO_KEY, on ? '1' : '0'); } catch (e) {}
  }

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
  var state = {
    colo: '', ip: '', ms: 0, host: '', ok: false, busy: false, idx: 0,
    auto: true,                 /* 自动选择：总是跟踪最快的那个 */
    results: [],                /* 每个目标的测速结果 { ms, ok, colo } */
    testing: false,             /* 是否正在全量测速 */
    bestIdx: -1                 /* 自动选择时选中的目标下标 */
  };

  /* 手动模式：只测当前选中的那一个。
   * 统一走 probeOne，避免两套探测实现不一致（缓存、超时、colo 解析）。 */
  function probe(cb) {
    if (state.idx < 0) state.idx = 0;
    var i = state.idx % TARGETS.length;
    var t = TARGETS[i];
    probeOne(t, function (r) {
      state.ok = r.ok;
      state.colo = r.colo || '';
      state.ms = r.ms || 0;
      state.host = t.name || '';
      state.results[i] = r;
      if (cb) cb();
    });
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
      '#__cfb_tip{position:fixed;z-index:2147483001;background:rgba(28,28,30,.97);color:#eee;',
      'border:1px solid rgba(255,255,255,.14);border-radius:8px;font-size:12px;line-height:1.5;',
      'display:none;width:230px;max-width:82vw;box-shadow:0 6px 24px rgba(0,0,0,.45);',
      'font-family:-apple-system,"PingFang SC","Microsoft YaHei",Arial,sans-serif;overflow:hidden}',
      '#__cfb_tip .cfb-tt{padding:9px 11px 7px;border-bottom:1px solid rgba(255,255,255,.1)}',
      '#__cfb_tip .cfb-r1{font-size:12px;color:#ddd}',
      '#__cfb_tip .cfb-r1 b{color:#fff;font-size:13px}',
      '#__cfb_tip .cfb-r2{font-size:11px;opacity:.65;margin-top:2px}',
      '#__cfb_tip .cfb-bar{display:flex;align-items:center;gap:8px;padding:8px 11px;border-bottom:1px solid rgba(255,255,255,.1)}',
      '#__cfb_tip .cfb-btn{display:inline-block;padding:4px 10px;border-radius:4px;cursor:pointer;',
      'background:rgba(255,255,255,.1);font-size:12px;user-select:none;-webkit-user-select:none}',
      '#__cfb_tip .cfb-btn:hover{background:rgba(255,255,255,.2)}',
      '#__cfb_tip .cfb-btn.primary{background:#0a66cc;color:#fff}',
      '#__cfb_tip .cfb-btn.primary:hover{background:#0d7aeb}',
      '#__cfb_tip .cfb-mode{font-size:11px;opacity:.6;margin-left:auto}',
      '#__cfb_tip .cfb-list{max-height:260px;overflow-y:auto;-webkit-overflow-scrolling:touch}',
      '#__cfb_tip .cfb-item{display:flex;align-items:center;gap:7px;padding:7px 11px;cursor:pointer;',
      'border-bottom:1px solid rgba(255,255,255,.05)}',
      '#__cfb_tip .cfb-item:hover{background:rgba(255,255,255,.07)}',
      '#__cfb_tip .cfb-item.on{background:rgba(10,102,204,.22)}',
      '#__cfb_tip .cfb-item.auto{border-bottom:1px solid rgba(255,255,255,.14)}',
      '#__cfb_tip .cfb-item.best{background:rgba(10,102,204,.10)}',
      '#__cfb_tip .cfb-item.best .cfb-dot{color:#4da3ff}',
      '#__cfb_tip .cfb-item.bad .cfb-ms{color:#ff6b6b}',
      '#__cfb_tip .cfb-item.pending .cfb-ms{opacity:.5}',
      '#__cfb_tip .cfb-dot{font-size:10px;opacity:.8;flex-shrink:0}',
      '#__cfb_tip .cfb-item.on .cfb-dot{color:#4da3ff}',
      '#__cfb_tip .cfb-nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#__cfb_tip .cfb-ms{font-size:11px;opacity:.8;font-variant-numeric:tabular-nums;flex-shrink:0}',
      '#__cfb_tip .cfb-foot2{padding:7px 11px;font-size:11px;opacity:.65;',
      'border-top:1px solid rgba(255,255,255,.1)}'
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

  /* 面板内容：状态 + 自动选择 + 全部节点（可测速 / 可手动选） */
  function panelHtml() {
    var h = [];
    /* 顶部状态 */
    h.push('<div class="cfb-tt">');
    if (state.ok) {
      var city = COLO[state.colo] || '';
      h.push('<div class="cfb-r1">Cloudflare 节点：<b>' + (state.colo || '未知') + '</b>' +
        (city ? '（' + city + '）' : '') + '</div>');
      h.push('<div class="cfb-r2">' + state.ms + ' ms' + (state.host ? ' · 经 ' + state.host : '') + '</div>');
    } else {
      h.push('<div class="cfb-r1">访问 Cloudflare 失败</div>');
    }
    h.push('</div>');

    /* 操作条 */
    h.push('<div class="cfb-bar">');
    h.push('<span class="cfb-btn primary" data-act="testall">' +
      (state.testing ? '测速中…' : '⚡ 全部测速') + '</span>');
    h.push('<span class="cfb-mode">' + (state.auto ? '自动选择：开' : '自动选择：关') + '</span>');
    h.push('</div>');

    /* 节点列表 */
    h.push('<div class="cfb-list">');

    /* 「自动选择」伪节点 */
    var autoOn = state.auto;
    h.push('<div class="cfb-item auto' + (autoOn ? ' on' : '') + '" data-auto="1">' +
      '<span class="cfb-dot">' + (autoOn ? '●' : '○') + '</span>' +
      '<span class="cfb-nm">自动选择</span>' +
      '<span class="cfb-ms">' + (autoOn && state.bestIdx >= 0 && state.results[state.bestIdx]
        ? (state.results[state.bestIdx].ms + 'ms') : (autoOn ? '跟随最快' : '')) + '</span>' +
      '</div>');

    for (var i = 0; i < TARGETS.length; i++) {
      var r = state.results[i];
      var cur = (!state.auto && state.idx >= 0 && i === (state.idx % TARGETS.length));
      var isBest = (state.auto && i === state.bestIdx);
      var msTxt, cls = '';
      if (state.testing && !r) { msTxt = '测速中…'; cls = ' pending'; }
      else if (r) {
        if (r.ok) { msTxt = r.ms + 'ms' + (r.colo ? ' ' + r.colo : ''); }
        else { msTxt = '不可用'; cls = ' bad'; }
      } else { msTxt = '—'; }
      /* 自动模式下只有「自动选择」一行高亮；具体节点用 ◉ 标出“当前最快”，不再抢高亮 */
      h.push('<div class="cfb-item' + (cur ? ' on' : '') + (isBest ? ' best' : '') + cls + '" data-ti="' + i + '">' +
        '<span class="cfb-dot">' + (cur ? '●' : (isBest ? '◉' : '○')) + '</span>' +
        '<span class="cfb-nm">' + esc(TARGETS[i].name || ('目标' + (i + 1))) + '</span>' +
        '<span class="cfb-ms">' + msTxt + '</span>' +
        '</div>');
    }
    h.push('</div>');

    /* 底部统计 */
    if (state.results.some(function (x) { return x; })) {
      var oks = state.results.filter(function (x) { return x && x.ok; });
      var txt = '可用 ' + oks.length + '/' + TARGETS.length;
      if (oks.length) {
        var arr = oks.map(function (x) { return x.ms; });
        txt += ' · 最快 ' + Math.min.apply(null, arr) + 'ms';
      }
      h.push('<div class="cfb-foot2">' + txt + '</div>');
    }

    return h.join('');
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function showPanel() {
    var t = $('__cfb_tip');
    var el = $('__cfb');
    if (!t || !el) return;
    t.innerHTML = panelHtml();
    t.style.display = 'block';
    t.className = 'open';

    var x = parseFloat(el.style.left) || 0;
    var y = parseFloat(el.style.top) || 0;
    var w = t.offsetWidth, h = t.offsetHeight;
    var vw = window.innerWidth || 320, vh = window.innerHeight || 480;
    var BS = 52;                       /* 球直径 */

    /* 横向：优先放球右侧；右侧放不下就放左侧；都放不下则贴边 */
    var left = x + BS + 6;
    if (left + w > vw - 6) left = x - w - 6;
    if (left < 6) left = 6;
    if (left + w > vw - 6) { w = vw - 12; left = 6; t.style.width = w + 'px'; }

    /* 纵向：优先与球顶部对齐；超出底部则上移 */
    var top = y;
    if (top + h > vh - 6) top = vh - h - 6;
    if (top < 6) top = 6;

    t.style.left = left + 'px';
    t.style.top = top + 'px';

    /* 首次打开且还没有任何测速结果时，自动跑一次，避免全是「—」 */
    var hasAny = false;
    for (var q = 0; q < state.results.length; q++) {
      if (state.results[q]) { hasAny = true; break; }
    }
    if (!hasAny && !state.testing) {
      testAll(function () { if (panelOpen()) showPanel(); });
      return;
    }

    /* 绑定面板内的点击 */
    var items = t.getElementsByTagName('div');
    for (var i = 0; i < items.length; i++) {
      (function (node) {
        var ti = node.getAttribute && node.getAttribute('data-ti');
        var act = node.getAttribute && node.getAttribute('data-act');
        var isAuto = node.getAttribute && node.getAttribute('data-auto');

        if (isAuto) {
          on(node, 'click', function (e) {
            if (e && e.stopPropagation) e.stopPropagation();
            state.auto = !state.auto;
            saveAuto(state.auto);
            if (state.auto) {
              /* 打开自动选择：立即全量测速并选定最快 */
              state.idx = -1;
              testAll(function () { if (panelOpen()) showPanel(); });
            } else {
              /* 关掉自动：保持当前目标不变，交给手动 */
              saveTarget(state.idx);
              if (panelOpen()) showPanel();
            }
            render();
          });
        } else if (ti !== null && ti !== undefined) {
          on(node, 'click', function (e) {
            if (e && e.stopPropagation) e.stopPropagation();
            var idx = parseInt(ti, 10);
            state.auto = false;         /* 手动选 = 关掉自动 */
            state.idx = idx;
            saveAuto(false);
            saveTarget(idx);
            hidePanel();
            refresh();
          });
        } else if (act === 'testall') {
          on(node, 'click', function (e) {
            if (e && e.stopPropagation) e.stopPropagation();
            testAll(function () { if (panelOpen()) showPanel(); });
          });
        }
      })(items[i]);
    }
  }

  function hidePanel() {
    var t = $('__cfb_tip');
    if (!t) return;
    t.style.display = 'none';
    t.className = '';
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
      hidePanel();
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
        /* 没拖动 = 点击：打开/关闭面板 */
        if (panelOpen()) {
          hidePanel();
        } else {
          showPanel();
        }
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
      showPanel();
    }, false);
    el.addEventListener && el.addEventListener('mouseout', function () {
      if (drag.on) return;
      hidePanel();
      applyEdge();
    }, false);
  }

  /* ---------------- 全量测速 ---------------- */
  /* 并发探测所有目标，记录每个的延迟；完成后若为自动模式则选最快的 */
  function testAll(done) {
    if (state.testing) return;
    state.testing = true;
    state.results = TARGETS.map(function () { return null; });
    render();
    if (panelOpen()) showPanel();

    var pending = TARGETS.length;
    var best = -1, bestMs = 1e9;

    TARGETS.forEach(function (t, i) {
      probeOne(t, function (r) {
        state.results[i] = r;
        if (r.ok && r.ms < bestMs) { bestMs = r.ms; best = i; }
        pending--;
        if (panelOpen()) showPanel();
        if (pending === 0) {
          state.testing = false;
          state.bestIdx = best;
          if (state.auto && best >= 0) {
            /* 自动模式：只把最优结果反映到悬浮球，不改 state.idx
             * （改了会让该节点同时出现“手动选中”与“最快”两种高亮） */
            state.ok = true;
            state.ms = state.results[best].ms;
            state.host = TARGETS[best].name;
            /* 节点三字码：优先用最快目标自己的；它没返回就借用任一能返回的
             * （同一时刻所有请求都落在同一个 CF 边缘节点上） */
            var coloNow = state.results[best].colo || '';
            if (!coloNow) {
              for (var z = 0; z < state.results.length; z++) {
                if (state.results[z] && state.results[z].colo) { coloNow = state.results[z].colo; break; }
              }
            }
            state.colo = coloNow;
          }
          render();
          if (panelOpen()) showPanel();
          if (done) done();
        }
      });
    });
  }

  /* 测单个目标（不修改全局 state，只回传结果） */
  function probeOne(t, cb) {
    var x = null, done = false, timer = null, t0 = now();
    function fin(ok, colo, ms) {
      if (done) return;
      done = true;
      if (timer) { clearTimeout(timer); timer = null; }
      cb({ ok: ok, colo: colo || '', ms: ms || 0 });
    }
    try { x = window.XMLHttpRequest ? new XMLHttpRequest() : null; } catch (e) { x = null; }
    if (!x) { fin(false); return; }
    /* 必须破缓存：命中缓存会在十几毫秒内返回，测出来的延迟毫无意义。
     * 两道保险：① 追加时间戳参数 ② 设置 no-cache 请求头 */
    var url = t.url + (t.url.indexOf('?') >= 0 ? '&' : '?') + '_t=' + now();
    x.open('GET', url, true);
    try { x.setRequestHeader('Cache-Control', 'no-cache, no-store'); } catch (e) {}
    try { x.setRequestHeader('Pragma', 'no-cache'); } catch (e) {}
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      var ms = now() - t0;
      var ray = '';
      try { ray = x.getResponseHeader('cf-ray') || ''; } catch (e) { ray = ''; }
      var colo = '';
      if (ray) {
        var parts = String(ray).split('-');
        if (parts.length > 1) colo = parts[parts.length - 1].toUpperCase();
      }
      if (!colo && t.node) {
        try {
          var j = JSON.parse(x.responseText || '{}');
          if (j && j.colo) colo = String(j.colo).toUpperCase();
        } catch (e) {}
      }
      if (colo || (x.status > 0 && x.status < 500)) fin(true, colo, ms);
      else fin(false, '', ms);
    };
    timer = setTimeout(function () {
      if (done) return;
      fin(false, '', now() - t0);
      try { x.abort(); } catch (e) {}
    }, TIMEOUT_MS);
    try { x.send(); } catch (e) { fin(false); }
  }

  function panelOpen() {
    var t = $('__cfb_tip');
    return !!(t && t.style.display === 'block');
  }

  function refresh() {
    if (state.busy || state.testing) return;
    /* 自动模式：整体测速一遍并跟随最快 */
    if (state.auto) {
      testAll(function () {
        state.busy = false;
        render();
      });
      return;
    }
    state.busy = true;
    render();
    probe(function () {
      state.busy = false;
      render();
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

  /* 暴露少量接口，便于调试与外部控制 */
  window.CFBubble = {
    show: function () { showPanel(); },
    hide: function () { hidePanel(); },
    testAll: function () { testAll(function () { if (panelOpen()) showPanel(); }); },
    state: state,
    targets: TARGETS
  };

  if (document.readyState === 'loading') {
    document.addEventListener
      ? document.addEventListener('DOMContentLoaded', start, false)
      : document.attachEvent('onreadystatechange', function () { if (document.readyState === 'complete') start(); });
  } else {
    start();
  }
})();
