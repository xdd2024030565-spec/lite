#!/usr/bin/env node
/**
 * merge-sub.js —— 把两个 Clash 订阅合并成一份，共用同一个「自动优选」组
 *
 * 用途：两份订阅指向不同服务（参数不同，节点不能互相替换），
 *       但可以把它们放进同一份配置，让自动测速组同时覆盖两边的全部节点。
 *
 * 用法：
 *   node merge-sub.js --a <订阅A的URL> --b <订阅B的URL> [-o out.yaml] [-p 端口]
 *
 * 产物：一份可直接导入 Clash / Mihomo 的 YAML。
 *       策略组：
 *         🚀 节点选择  → 可选：自动优选 / 仅A / 仅B / 直连
 *         ⚡ 自动优选  → url-test，包含 A+B 全部节点（核心）
 *         🔀 故障转移  → fallback，自动切换
 *         🎯 全球直连 / 🛑 全球拦截 / 🐟 漏网之鱼
 */
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');

/* ---------------- 参数 ---------------- */
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const URL_A = arg('a');
const URL_B = arg('b');
const OUT = arg('o', 'merged.yaml');
const PORT = parseInt(arg('p', '7890'), 10);
const INTERVAL = parseInt(arg('interval', '300'), 10);

if (!URL_A || !URL_B) {
  console.error('用法: node merge-sub.js --a <订阅A> --b <订阅B> [-o merged.yaml]');
  process.exit(1);
}

/* ---------------- 抓取 ---------------- */
/* 带重试的抓取：这类订阅走 Cloudflare，实测偶发 ECONNRESET */
async function fetchWithRetry(url) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await fetchText(url);
    } catch (e) {
      lastErr = e;
      if (attempt < 5) {
        const wait = 400 * attempt;
        console.error('  第 ' + attempt + ' 次失败（' + (e.message || e) + '），' + wait + 'ms 后重试…');
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('重定向过多'));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'clash-meta/1.18' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchText(res.headers.location, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' ' + url));
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve(buf));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('超时')); });
  });
}

/* 订阅可能是 YAML、JSON 或 base64 三种形态，统一成可解析结构 */
function parseAny(raw) {
  const t = raw.trim();
  /* 1) JSON（有些面板 app=clash 也回 JSON） */
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      if (j.proxies) return { proxies: j.proxies, fmt: 'json' };
    } catch (e) {}
  }
  /* 2) base64 → 再判断是 Links 还是 JSON/YAML */
  let body = t;
  if (!/^proxies:|^port:|^mixed-port:|^\{/.test(body)) {
    const maybe = maybeBase64(body);
    if (maybe !== body) body = maybe;
    if (body.trim().startsWith('{')) {
      try {
        const j = JSON.parse(body);
        if (j.proxies) return { proxies: j.proxies, fmt: 'json-b64' };
      } catch (e) {}
    }
  }
  /* 3) Links 列表（vless:// ... ）—— 从链接构造最小节点 */
  if (/^(vless|vmess|trojan|ss):\/\//m.test(body) && !/^proxies:/m.test(body)) {
    return { proxies: parseLinks(body), fmt: 'links' };
  }
  /* 4) YAML */
  const block = extractSection(body, 'proxies', ['proxy-groups', 'rules', 'port', 'socks-port', 'mixed-port']);
  return { proxies: parseInlineProxies(block), fmt: 'yaml' };
}

/* 把 vless:// / trojan:// 链接解析成 Clash 节点对象 */
function parseLinks(text) {
  const out = [];
  text.split(/\r?\n/).forEach((line) => {
    const l = line.trim();
    if (!l) return;
    try {
      if (l.startsWith('vless://')) {
        const u = new URL(l);
        const qp = u.searchParams;
        const n = {
          name: decodeURIComponent(u.hash.slice(1) || u.hostname),
          server: u.hostname,
          port: parseInt(u.port || '443', 10),
          type: 'vless',
          uuid: decodeURIComponent(u.username || ''),
          tls: qp.get('security') === 'tls' || qp.get('security') === 'reality',
          network: qp.get('type') || 'tcp',
          'client-fingerprint': qp.get('fp') || undefined,
          servername: qp.get('sni') || qp.get('host') || undefined,
          udp: true,
        };
        if (qp.get('security') === 'reality') {
          n['reality-opts'] = { 'public-key': qp.get('pbk') || '', 'short-id': qp.get('sid') || '' };
        }
        if (n.network === 'ws') {
          n['ws-opts'] = {
            path: decodeURIComponent(qp.get('path') || '/'),
            headers: { Host: qp.get('host') || u.hostname },
          };
        }
        out.push(n);
      } else if (l.startsWith('trojan://')) {
        const u = new URL(l);
        const qp = u.searchParams;
        const n = {
          name: decodeURIComponent(u.hash.slice(1) || u.hostname),
          server: u.hostname,
          port: parseInt(u.port || '443', 10),
          type: 'trojan',
          password: decodeURIComponent(u.username || ''),
          'skip-cert-verify': qp.get('allowInsecure') === '1',
          sni: qp.get('sni') || undefined,
          network: qp.get('type') || 'tcp',
          udp: true,
        };
        if (n.network === 'ws') {
          n['ws-opts'] = {
            path: decodeURIComponent(qp.get('path') || '/'),
            headers: { Host: qp.get('host') || u.hostname },
          };
        }
        out.push(n);
      }
    } catch (e) {}
  });
  return out;
}

/* 有些订阅是 base64 编码的；检测并解码 */
function maybeBase64(text) {
  const t = text.trim();
  if (/^proxies:|^port:|^mixed-port:/.test(t)) return text;   /* 已是 YAML */
  if (!/^[A-Za-z0-9+/=\s]+$/.test(t.slice(0, 200))) return text;
  try {
    const dec = Buffer.from(t.replace(/\s/g, ''), 'base64').toString('utf8');
    if (/^(vless|vmess|trojan|ss|ssr):\/\//m.test(dec)) return dec;
  } catch (e) {}
  return text;
}

/* ---------------- 更完整的 YAML 子集解析 ---------------- */
/* 只解析我们需要的结构：顶层键 + 序列/映射，足够处理 Clash 订阅 */
function parseYaml(text) {
  const lines = text.split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, node: root, key: null, isList: false }];

  for (let raw of lines) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.match(/^\s*/)[0].length;
    const line = raw.trim();
    if (line === '---') continue;

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    let cur = stack[stack.length - 1];

    /* 列表项 */
    if (line.startsWith('- ')) {
      const rest = line.slice(2).trim();
      if (!Array.isArray(cur.node)) {
        /* 当前节点应该变成数组，但父级已按对象存好，这里做替换 */
        continue;
      }
      if (rest.includes(': ') || /:$/.test(rest)) {
        const obj = {};
        const m = rest.match(/^([^:]+):\s*(.*)$/);
        if (m) {
          obj[m[1].trim()] = coerce(m[2]);
        }
        cur.node.push(obj);
        stack.push({ indent, node: obj, key: null, isList: false });
      } else {
        cur.node.push(coerce(rest));
      }
      continue;
    }

    /* 键值 */
    const kv = line.match(/^([^:]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const val = kv[2];

    if (val === '') {
      /* 可能子节点是列表或映射，先占位并在下一行判断 */
      cur.node[key] = [];
      stack.push({ indent, node: cur.node[key], key, isList: true });
    } else {
      cur.node[key] = coerce(val);
    }
  }
  return root;
}

function coerce(v) {
  const s = String(v).trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (s.startsWith('[') && s.endsWith(']')) {
    return s.slice(1, -1).split(',').map((x) => coerce(x)).filter((x) => x !== '');
  }
  return s;
}

/* 更稳的做法：直接用行扫描提取 proxies 与 proxy-groups 段落 */
function extractSection(text, sectionName, nextNames) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inside = false;
  for (const line of lines) {
    if (new RegExp('^' + sectionName + ':').test(line)) { inside = true; continue; }
    if (inside) {
      if (/^\S/.test(line) && line.trim() && nextNames.some((n) => new RegExp('^' + n + ':').test(line))) break;
      if (/^\S/.test(line) && line.trim() && /^[a-z-]+:/i.test(line)) break;
      out.push(line);
    }
  }
  return out.join('\n');
}

/* 解析行内风格的 proxy 定义（{name: ..., server: ...}） */
function parseInlineProxies(block) {
  const items = [];
  const lines = block.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('- {')) continue;
    let body = t.slice(3);
    if (body.endsWith('}')) body = body.slice(0, -1);
    const obj = parseFlowMap(body);
    if (obj && obj.name) items.push(obj);
  }
  return items;
}

/* 解析 {k: v, k2: v2, ws-opts: {path: /, headers: {Host: x}}} 这种嵌套花括号 */
function parseFlowMap(str) {
  const obj = {};
  let i = 0;
  const s = str.trim();
  while (i < s.length) {
    /* 读 key */
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;
    let ks = i;
    while (i < s.length && s[i] !== ':') i++;
    if (i >= s.length) break;
    const key = s.slice(ks, i).trim();
    i++; /* 跳过冒号 */
    while (i < s.length && s[i] === ' ') i++;
    let val;
    if (s[i] === '{') {
      /* 嵌套对象 */
      let depth = 0, start = i;
      for (; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}') { depth--; if (depth === 0) { i++; break; } }
      }
      val = parseFlowMap(s.slice(start + 1, i - 1));
    } else {
      let vs = i;
      let depth2 = 0;
      for (; i < s.length; i++) {
        if (s[i] === '{' || s[i] === '[') depth2++;
        else if (s[i] === '}' || s[i] === ']') { if (depth2 === 0) break; depth2--; }
        else if (s[i] === ',' && depth2 === 0) break;
      }
      val = coerce(s.slice(vs, i));
    }
    if (key) obj[key] = val;
  }
  return obj;
}

/* ---------------- YAML 输出 ---------------- */
function q(v) {
  /* 需要引号的情况 */
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (s === '') return '""';
  if (/^[\w.\-/]+$/.test(s) && !/^(true|false|null|yes|no|\d+)$/i.test(s)) return s;
  return JSON.stringify(s);
}

function dumpProxy(p) {
  /* 输出成行内风格，可读且 Clash 完全支持 */
  const parts = [];
  const order = ['name', 'server', 'port', 'type', 'uuid', 'password', 'cipher',
    'tls', 'skip-cert-verify', 'servername', 'client-fingerprint', 'network',
    'alpn', 'udp', 'tfo', 'ip-version', 'packet-encoding', 'encryption', 'ws-opts'];
  const seen = {};
  for (const k of order) {
    if (p[k] === undefined || p[k] === null) continue;
    if (k === 'ws-opts') continue;
    seen[k] = 1;
    let v = p[k];
    if (Array.isArray(v)) v = '[' + v.map(q).join(', ') + ']';
    else v = q(v);
    parts.push(k + ': ' + v);
  }
  for (const k of Object.keys(p)) {
    if (seen[k] || k === 'ws-opts' || p[k] === undefined || p[k] === null) continue;
    parts.push(k + ': ' + (Array.isArray(p[k]) ? '[' + p[k].map(q).join(', ') + ']' : q(p[k])));
  }
  /* ws-opts 放最后（嵌套） */
  if (p['ws-opts']) {
    const wo = p['ws-opts'];
    const inner = [];
    if (wo.path) inner.push('path: ' + q(wo.path));
    if (wo['max-early-data']) inner.push('max-early-data: ' + wo['max-early-data']);
    if (wo['early-data-header-name']) inner.push('early-data-header-name: ' + q(wo['early-data-header-name']));
    if (wo.headers) {
      const hs = Object.keys(wo.headers).map((h) => q(h) + ': ' + q(wo.headers[h]));
      inner.push('headers: {' + hs.join(', ') + '}');
    }
    parts.push('ws-opts: {' + inner.join(', ') + '}');
  }
  return '  - {' + parts.join(', ') + '}';
}

/* ---------------- 主流程 ---------------- */
(async function main() {
  console.log('抓取订阅 A…');
  const resA = parseAny(await fetchWithRetry(URL_A));
  console.log('  格式: ' + resA.fmt + '，节点 ' + resA.proxies.length + ' 个');
  console.log('抓取订阅 B…');
  const resB = parseAny(await fetchWithRetry(URL_B));
  console.log('  格式: ' + resB.fmt + '，节点 ' + resB.proxies.length + ' 个');

  const proxiesA = resA.proxies;
  const proxiesB = resB.proxies;

  if (!proxiesA.length || !proxiesB.length) {
    console.error('解析失败：A=' + proxiesA.length + ' 个，B=' + proxiesB.length + ' 个');
    process.exit(1);
  }

  /* 重命名避免重名冲突：A 前缀「A·」，B 前缀「B·」 */
  const seenNames = {};
  function rename(list, prefix) {
    return list.map((p) => {
      let n = prefix + String(p.name).trim();
      let i = 2;
      while (seenNames[n]) { n = prefix + String(p.name).trim() + ' (' + i + ')'; i++; }
      seenNames[n] = 1;
      const o = Object.assign({}, p);
      o.name = n;
      return o;
    });
  }
  const A = rename(proxiesA, 'A·');
  const B = rename(proxiesB, 'B·');
  const all = A.concat(B);

  const namesA = A.map((p) => p.name);
  const namesB = B.map((p) => p.name);
  const allNames = all.map((p) => p.name);

  console.log('A 节点 ' + A.length + ' 个，B 节点 ' + B.length + ' 个，合计 ' + all.length + ' 个');

  /* 组名 */
  const G_SEL = '🚀 节点选择';
  const G_AUTO = '⚡ 自动优选';
  const G_FALLBACK = '🔀 故障转移';
  const G_AUTO_A = '🅰 仅A自动';
  const G_AUTO_B = '🅱 仅B自动';
  const G_DIRECT = '🎯 全球直连';
  const G_REJECT = '🛑 全球拦截';
  const G_MISS = '🐟 漏网之鱼';

  const lines = [];
  lines.push('# 由 merge-sub.js 生成 —— 两路订阅合并，共用自动优选组');
  lines.push('# A: ' + A.length + ' 个节点  B: ' + B.length + ' 个节点  合计: ' + all.length);
  lines.push('# 测速间隔: ' + INTERVAL + 's');
  lines.push('');
  lines.push('mixed-port: ' + PORT);
  lines.push('allow-lan: false');
  lines.push('mode: rule');
  lines.push('log-level: warning');
  lines.push('ipv6: true');
  lines.push('unified-delay: false');
  lines.push('tcp-concurrent: true');
  lines.push('external-controller: 127.0.0.1:9090');
  lines.push('');
  lines.push('dns:');
  lines.push('  enable: true');
  lines.push('  ipv6: false');
  lines.push('  enhanced-mode: fake-ip');
  lines.push('  fake-ip-range: 198.18.0.1/16');
  lines.push('  nameserver:');
  lines.push('    - 223.5.5.5');
  lines.push('    - 119.29.29.29');
  lines.push('  fallback:');
  lines.push('    - 8.8.4.4');
  lines.push('    - 1.1.1.1');
  lines.push('');
  lines.push('proxies:');
  all.forEach((p) => lines.push(dumpProxy(p)));
  lines.push('');
  lines.push('proxy-groups:');
  lines.push('  - name: ' + q(G_SEL));
  lines.push('    type: select');
  lines.push('    proxies:');
  [G_AUTO, G_AUTO_A, G_AUTO_B, G_FALLBACK, G_DIRECT].forEach((n) => lines.push('      - ' + q(n)));
  lines.push('');
  lines.push('  - name: ' + q(G_AUTO));
  lines.push('    type: url-test');
  lines.push('    url: http://www.gstatic.com/generate_204');
  lines.push('    interval: ' + INTERVAL);
  lines.push('    tolerance: 50');
  lines.push('    lazy: false');
  lines.push('    proxies:');
  allNames.forEach((n) => lines.push('      - ' + q(n)));
  lines.push('');
  lines.push('  - name: ' + q(G_AUTO_A));
  lines.push('    type: url-test');
  lines.push('    url: http://www.gstatic.com/generate_204');
  lines.push('    interval: ' + INTERVAL);
  lines.push('    tolerance: 50');
  lines.push('    proxies:');
  namesA.forEach((n) => lines.push('      - ' + q(n)));
  lines.push('');
  lines.push('  - name: ' + q(G_AUTO_B));
  lines.push('    type: url-test');
  lines.push('    url: http://www.gstatic.com/generate_204');
  lines.push('    interval: ' + INTERVAL);
  lines.push('    tolerance: 50');
  lines.push('    proxies:');
  namesB.forEach((n) => lines.push('      - ' + q(n)));
  lines.push('');
  lines.push('  - name: ' + q(G_FALLBACK));
  lines.push('    type: fallback');
  lines.push('    url: http://www.gstatic.com/generate_204');
  lines.push('    interval: ' + INTERVAL);
  lines.push('    proxies:');
  lines.push('      - ' + q(G_AUTO));
  lines.push('      - ' + q(G_DIRECT));
  lines.push('');
  lines.push('  - name: ' + q(G_DIRECT));
  lines.push('    type: select');
  lines.push('    proxies:');
  lines.push('      - DIRECT');
  lines.push('      - ' + q(G_REJECT));
  lines.push('');
  lines.push('  - name: ' + q(G_REJECT));
  lines.push('    type: select');
  lines.push('    proxies:');
  lines.push('      - REJECT');
  lines.push('      - DIRECT');
  lines.push('');
  lines.push('  - name: ' + q(G_MISS));
  lines.push('    type: select');
  lines.push('    proxies:');
  lines.push('      - ' + q(G_SEL));
  lines.push('      - ' + q(G_AUTO));
  lines.push('      - DIRECT');
  lines.push('');
  lines.push('rules:');
  lines.push('  - GEOIP,LAN,' + G_DIRECT + ',no-resolve');
  lines.push('  - GEOIP,CN,' + G_DIRECT);
  lines.push('  - MATCH,' + q(G_MISS));

  const yaml = lines.join('\n') + '\n';
  fs.writeFileSync(OUT, yaml, 'utf8');

  console.log('已写出: ' + OUT + '  (' + (yaml.length / 1024).toFixed(1) + ' KB)');
  console.log('自动优选组包含全部 ' + all.length + ' 个节点');
})().catch((e) => {
  console.error('失败: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
