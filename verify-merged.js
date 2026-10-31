#!/usr/bin/env node
/**
 * verify-merged.js —— 校验合并后的 Clash 配置是否健全
 *
 * 检查项：
 *   1. 节点数与策略组引用完整（不能引用不存在的节点）
 *   2. 每个节点必填字段齐全（name/server/port/type，vless 需要 uuid，trojan 需要 password）
 *   3. 「自动优选」组必须包含全部节点（这是合并的核心目的）
 *   4. 规则段存在且以 MATCH 收尾
 *
 * 用法：node verify-merged.js merged.yaml
 * 退出码：0 通过，1 失败（CI 会因此中断，避免把坏配置推上去）
 */
'use strict';

const fs = require('fs');
const file = process.argv[2] || 'merged.yaml';

let text;
try {
  text = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.error('❌ 读不到文件: ' + file);
  process.exit(1);
}

const lines = text.split(/\r?\n/);
const proxies = {};
const order = [];
const groups = {};
const groupOrder = [];

let inProxies = false, inGroups = false, inRules = false;
let curGroup = null, curList = null;
const rules = [];

for (let i = 0; i < lines.length; i++) {
  const l = lines[i];

  if (/^proxies:/.test(l)) { inProxies = true; inGroups = false; inRules = false; continue; }
  if (/^proxy-groups:/.test(l)) { inProxies = false; inGroups = true; inRules = false; continue; }
  if (/^rules:/.test(l)) { inProxies = false; inGroups = false; inRules = true; continue; }
  if (/^\S/.test(l) && l.trim()) { inProxies = false; inGroups = false; inRules = false; }

  if (inProxies) {
    const m = l.match(/^  - \{name: "?([^,"]+)"?/);
    if (m) {
      proxies[m[1]] = l;
      order.push(m[1]);
    }
  }

  if (inGroups) {
    const g = l.match(/^  - name: "?([^"]+)"?\s*$/);
    if (g) {
      if (curGroup && curList) groups[curGroup] = curList;
      curGroup = g[1];
      curList = [];
      groupOrder.push(curGroup);
      continue;
    }
    const p = l.match(/^      - "?([^"]+)"?\s*$/);
    if (p && curGroup) curList.push(p[1]);
  }

  if (inRules) {
    const r = l.trim();
    if (r.startsWith('- ')) rules.push(r.slice(2));
  }
}
if (curGroup && curList) groups[curGroup] = curList;

let fail = 0;
function ok(msg) { console.log('✅ ' + msg); }
function bad(msg) { console.log('❌ ' + msg); fail++; }

console.log('=== 校验 ' + file + ' ===');

/* 1) 节点 */
ok('节点总数 ' + order.length);
if (order.length === 0) bad('没有任何节点');

/* 2) 必填字段 */
const needKeys = ['server', 'port', 'type'];
let missField = 0;
order.forEach((name) => {
  const line = proxies[name];
  const miss = needKeys.filter((k) => line.indexOf(k + ':') < 0);
  if (/type: vless/.test(line) && line.indexOf('uuid:') < 0) miss.push('uuid');
  if (/type: trojan/.test(line) && line.indexOf('password:') < 0) miss.push('password');
  if (miss.length) {
    if (missField < 5) bad('节点「' + name + '」缺字段: ' + miss.join(','));
    missField++;
  }
});
if (!missField) ok('所有节点必填字段齐全');
else bad('共 ' + missField + ' 个节点字段不全');

/* 3) 策略组引用 */
const builtin = { DIRECT: 1, REJECT: 1, 'REJECT-DROP': 1, PASS: 1, COMPATIBLE: 1 };
let dangling = 0;
groupOrder.forEach((g) => {
  const list = groups[g] || [];
  const missing = list.filter((n) => !proxies[n] && !groups[n] && !builtin[n]);
  if (missing.length) {
    bad('组「' + g + '」引用了不存在的项: ' + missing.slice(0, 5).join(', '));
    dangling += missing.length;
  }
});
if (!dangling) ok('所有策略组引用有效（' + groupOrder.length + ' 个组）');

/* 4) 自动优选组必须覆盖全部节点 */
const autoName = groupOrder.filter((g) => /自动优选|自动选择|url-test/i.test(g))
  .concat(groupOrder.filter((g) => /自动优选/.test(g)))[0];
let autoGroup = null;
groupOrder.forEach((g) => { if (/⚡|自动优选/.test(g)) autoGroup = g; });
if (autoGroup) {
  const list = groups[autoGroup] || [];
  const set = {};
  list.forEach((n) => { set[n] = 1; });
  const uncovered = order.filter((n) => !set[n]);
  if (uncovered.length) bad('「' + autoGroup + '」未覆盖 ' + uncovered.length + ' 个节点');
  else ok('「' + autoGroup + '」覆盖全部 ' + order.length + ' 个节点');
} else {
  bad('没有找到「自动优选」组');
}

/* 5) 规则 */
if (rules.length && /^MATCH/i.test(rules[rules.length - 1])) {
  ok('规则 ' + rules.length + ' 条，以 MATCH 收尾');
} else {
  bad('规则缺失或未以 MATCH 收尾');
}

console.log('');
if (fail) {
  console.error('校验未通过（' + fail + ' 项）');
  process.exit(1);
}
console.log('全部通过');
