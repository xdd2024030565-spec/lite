# 网址储存 · 兼容版 (lite)

全设备兼容版网址导航。面向老设备 / 电子墨水屏优化，不使用现代脚本特性；脚本不可用时自动显示静态快照列表。数据与完整版 [lite1](https://github.com/xdd2024030565-spec/lite1) 完全互通（同一份 links.json）。

## 访问地址
- 🚀 **国内加速地址（帽子云）**: https://lite-3d8c30u.maozi.io/
- 📦 GitHub Pages 原始地址: https://xdd2024030565-spec.github.io/lite/

## 加速方案
通过帽子云（maoziyun）部署，国内访问速度大幅提升。
- 帽子云部署地址: https://lite-3d8c30u.maozi.io/

## Cloudflare 加速（备用）
通过 Cloudflare Worker 反向代理 + CDN 缓存加速。
- Worker 代理地址: https://lite-proxy.xdd2024030565.workers.dev/
- 自定义域名: https://lite.yongjiu.ccwu.cc/

## 配套阅读器
- 📖 适配版阅读器（站内）: https://lite-3d8c30u.maozi.io/reader.html
- 📄 纯HTML模式（无需脚本）: https://reader.yongjiu.ccwu.cc/reader/web/list

### 阅读视图
- 交互（2026-10-25 起）：**点击正文中间 → 顶栏与底栏一起弹出/收起**（3.5 秒无操作自动收起，键盘 `T` 同效）；点击左 30% 翻上页、右 30% 翻下页；滑动翻页
- 只有**两层**界面元素：顶部工具栏（书库 / 章节标题 / 目录 / 设置）和底部工具栏（进度滑杆 + 上一页 / 进度 / 下一页），原先的右侧 `⋮` 导轨、居中圆钮菜单、左右 `‹ ›` 角标已全部移除
- 默认全屏阅读：两栏藏在屏幕外，正文不再被任何常驻栏遮挡
- 目录为右侧滑入抽屉（章节搜索 + 当前章高亮，Esc 关闭）；阅读设置为底部面板
- 5 种翻页动画：无 / 淡化 / 滑动 / 覆盖 / 仿真（`prefers-reduced-motion` 下关闭）
- 阅读设置精简为「翻页 / 排版 / 外观」三组，去掉了与新交互冲突的旧项（点按分区、顶部工具栏常显、底部按钮常显）
- 保持 ES5 兼容，纯 HTML + 内联脚本，无需构建
- 打开书籍时若版面尚未就绪（视口/键盘动画中），会自动重试排版，不再出现整本白屏
- 调试与离线副本：`reader_dbg.html` / `reader_t.html` / `reader_offline.html`（仅调试与内嵌数据，不影响线上入口）
## 折叠组
兼容版已支持与完整版同构的折叠组：折叠时显示 favicon 横向堆叠 + 组内网址总数角标，与普通网址行同样大小、同样对齐；点击整行原地向下展开为折叠条 + 组内网址列表，再点顶部折叠条收起（带高度过渡，`prefers-reduced-motion` 时不做动画）。

- 折叠状态只存在内存里，刷新页面自动全部折叠
- 展开时组名右侧带「改名 / 解散」，旧浏览器也保留这两个入口
- 搜索命中组内的网址时，该组自动展开
- 添加面板与编辑面板都有折叠组选择，可「＋ 新建折叠组…」就地建组；编辑面板切换分类时折叠组自动联动
- 折叠组在列表中的位置由组内最新一条网址决定

## 静态快照
脚本不可用时（老设备 / 关闭 JS）页面直接用内嵌的静态快照渲染，样式与主页面一致，折叠组会以「折叠条 + 组内网址」的展开形式列出。

重新生成快照（读取线上 links.json，写入内联数据与静态列表）：

```bash
# 默认读 https://api.yongjiu.ccwu.cc 上的 links.json
python3 tools/gen_static.py

# 或用本地/已导出的 JSON
python3 tools/gen_static.py ./links.json
```

仓库内不放 links.json 副本，进仓库的只有生成后的 index.html。

## 数据写入
数据写入走 API 双域名兜底：`api.yongjiu.ccwu.cc` 失败自动切到 `api2.yongjiu.ccwu.cc`，选中的域名记在 `localStorage['lite_api_best']`，下次打开优先使用。
