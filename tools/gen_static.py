#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""重新生成 lite/index.html 里的静态快照。

用法:
    python3 tools/gen_static.py links.json          # 指定数据文件
    python3 tools/gen_static.py --api               # 从 GitHub API 拉取线上最新

会重写两处:
    1. var SNP={...};            —— 脚本可用时的首屏兜底数据
    2. <div id="list"> ... </div><!-- /list -->  —— 脚本不可用时的静态列表
       （折叠组以「展开」形态平铺，因为无 JS 时无法折叠）
"""
import json
import sys
import base64
import urllib.request
import urllib.parse

API = ('https://api.yongjiu.ccwu.cc/repos/xdd2024030565-spec/lite1/'
       'contents/links.json?ref=main')
HTML = 'index.html'


def esc(s):
    s = '' if s is None else str(s)
    return (s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
             .replace('"', '&#34;'))


def attr(s):
    return esc(s).replace("'", '&#39;')


def get_domain(u):
    import re
    m = re.match(r'^https?://([^/?#]+)', str(u or ''), re.I)
    return m.group(1).replace('www.', '') if m else str(u or '')


def time_ago(s):
    import datetime
    try:
        t = datetime.datetime.strptime(str(s)[:19], '%Y-%m-%dT%H:%M:%S')
    except Exception:
        return ''
    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    d = int((now - t).total_seconds())
    if d < 0:
        d = 0
    if d < 3600:
        return '%d 分钟前' % (d // 60)
    if d < 86400:
        return '%d 小时前' % (d // 3600)
    days = d // 86400
    if days < 30:
        return '%d 天前' % days
    if days < 365:
        return '%d 个月前' % (days // 30)
    return '%d 年前' % (days // 365)


def fetch(path=None):
    if path:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    req = urllib.request.Request(API, headers={
        'Accept': 'application/vnd.github.v3+json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read().decode('utf-8'))
    return json.loads(base64.b64decode(d['content']).decode('utf-8'))


def card(x, cat_name):
    h = '<div class="card"><a class="title" href="%s">%s</a>' % (
        attr(x['url']), esc(x.get('title') or x['url']))
    h += '<div class="meta">%s · %s' % (esc(get_domain(x['url'])), esc(cat_name))
    ta = time_ago(x.get('added'))
    if ta:
        h += ' · ' + ta
    if x.get('pinned'):
        h += ' · 置顶'
    h += '</div>'
    if x.get('note'):
        h += '<div class="note">%s</div>' % esc(x['note'])
    h += '<div class="row"><a class="btn" href="%s">打开</a></div></div>' % attr(x['url'])
    return h


def fav(u):
    return ('https://www.google.com/s2/favicons?domain='
            + urllib.parse.quote(get_domain(u)) + '&sz=64')


def stack(items):
    n = min(3, len(items))
    h = '<span class="fstack">'
    for x in items[:n]:
        h += ('<i class="fchip hasimg">%s<img src="%s" alt=""></i>'
              % (esc((x.get('title') or x['url'] or '?')[:1].upper()),
                 attr(fav(x['url']))))
    h += '</span>'
    if len(items) > 3:
        h += '<span class="fmore">+%d</span>' % (len(items) - 3)
    return h


def build(data):
    cats = data.get('categories') or []
    links = data.get('links') or []
    folders = data.get('folders') or []
    cat_by_id = {c['id']: c['name'] for c in cats}
    fold_by_id = {f['id']: f for f in folders}
    out = ['<div class="static-note">脚本未运行时的静态列表（生成时快照，可直接点击；'
           '折叠组以展开形态显示）</div>']
    for c in cats:
        members = [x for x in links if x.get('categoryId') == c['id']]
        folds_here = [f for f in folders if f.get('categoryId') == c['id']]
        plain = [x for x in members if not (x.get('fldId') in fold_by_id)]
        if not members and not folds_here:
            continue
        out.append('<div class="gh">%s</div>' % esc(c['name']))
        for f in folds_here:
            items = [x for x in links if x.get('fldId') == f['id']]
            out.append('<div class="foldbox open"><div class="foldhead">%s'
                       '<span class="fh-name">%s</span>'
                       '<span class="fh-meta">%s · %d 个网址</span></div>'
                       % (stack(items), esc(f['name']),
                          esc(c['name']), len(items)))
            if not items:
                out.append('<div class="fold-empty">这个折叠组还是空的</div>')
            for x in items:
                out.append(card(x, c['name']))
            out.append('</div>')
        for x in plain:
            out.append(card(x, c['name']))
    orphans = [x for x in links if x.get('categoryId') not in cat_by_id]
    if orphans:
        out.append('<div class="gh">未分类</div>')
        for x in orphans:
            out.append(card(x, '未分类'))
    return ''.join(out)


def main():
    data = fetch(None if '--api' in sys.argv else sys.argv[1])
    snp = json.dumps({
        'siteName': data.get('siteName') or '网址储存',
        'settings': data.get('settings') or {'theme': 'light', 'fontSize': 16},
        'categories': data.get('categories') or [],
        'folders': data.get('folders') or [],
        'links': data.get('links') or [],
    }, ensure_ascii=False, separators=(',', ':'))

    with open(HTML, encoding='utf-8') as f:
        s = f.read()

    import re
    m0 = re.search(r'var SNP=\{.*?\};\n', s, flags=re.S)
    assert m0, 'SNP 未匹配'
    s = s[:m0.start()] + 'var SNP=%s;\n' % snp + s[m0.end():]

    m = re.search(r'<div id="list">.*?</div><!-- /list -->', s, flags=re.S)
    assert m, '静态列表未匹配'
    s = s[:m.start()] + '<div id="list">' + build(data) + '</div><!-- /list -->' + s[m.end():]

    with open(HTML, 'w', encoding='utf-8') as f:
        f.write(s)
    print('已更新 %s：%d 链接 / %d 分类 / %d 折叠组'
          % (HTML, len(data.get('links') or []),
             len(data.get('categories') or []), len(data.get('folders') or [])))


if __name__ == '__main__':
    main()
