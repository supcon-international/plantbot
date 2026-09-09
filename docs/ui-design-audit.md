# Plantbot UI：Tier0 规范审计与适配

## 依据与范围

2026-09-09 按用户要求，从 GitHub 读取真实 skill 与代码，未编造同名规范：

- [Tier0-Design-System / SKILL.md](https://github.com/FREEZONEX/Tier0-Design-System/blob/52e01e94c18188668f47dfe7664f27cfde1690f6/SKILL.md)，版本 `52e01e94c18188668f47dfe7664f27cfde1690f6`。使用 `tier0-product`，必读 `DESIGN.md`、`foundations/README.md`、`tokens/core.css`、`tokens/product.css`、`sources/spec.product-ui.md` 与产品 surface 的 README/layout/components/checklist。
- [Tier0-Frontend / packages/theme](https://github.com/FREEZONEX/Tier0-Frontend/tree/105a4ae0460b362967a2c5b80195f7825ded0e40/packages/theme/src)，版本 `105a4ae0460b362967a2c5b80195f7825ded0e40`。读取 `themes.scss`、`variables.scss`、`tailwind.css`、`token.ts`，以真实主题、组件语义为准。
- [IBM Carbon 图标用法](https://carbondesignsystem.com/elements/icons/code/)与 [WCAG 2.2](https://www.w3.org/TR/WCAG22/)用于图标实现、键盘、可访问名称、对比度及触达测试。

覆盖总览、机队、机器人详情、任务、地图、视频、事件、设备、集成、场站、场站搭建、文档和登录；检查主要页内视图、中英文、明暗主题、移动导航和 iframe。

## 审计发现与改动

| 发现 | 改进 |
| --- | --- |
| 默认深色、荧光绿主动作、零圆角、硬偏移阴影，与 Tier0 product 的近黑主操作、4px 控件、细边框不符 | 全局 Tier0 语义色板，浅色默认且尊重保存主题；统一控件圆角、按钮主次及弹层阴影 |
| Condensed / 全大写 / 拉宽字距用于日常标签，辅助文字常见 9–11px | 标题与正文使用 IBM Plex Sans/SC；Mono 保留数据用途；提高辅助文字可读性，按钮正常句首大小写 |
| 混用 Lucide 与自定义“Carbon风” | 使用真实 `@carbon/icons-react`，字体从官方资源本地加载并保留 OFL 许可 |
| 顶栏扫光、切页位移、在线点反复呼吸等装饰 | 去除无业务含义动画，保留加载/选择/输入等状态反馈与减少动态效果支持 |
| 手机10个导航挤在横向条内、非当前项没有可见名称 | 四个常用模块加“更多”，每项有文本和触达面积；更多中保留全部可授权入口 |
| 图标操作/输入缺名称、可点卡片只支持鼠标 | 命名控件，支持键盘进入，加入跳过导航、页面标题、未知路由返回入口 |
| 受控弹窗关闭后焦点可能丢失，危险操作缺确认 | 保存并恢复触发控件焦点，验证嵌套/输入弹窗；删除与吊销显示资源名称并确认 |
| 离线设备可能计入“就绪”、未知电量显示0%，固定在线点误导 | KPI 改为可验证的“在线空闲”，未知数值明确显示，离线无在线信号 |
| 长路径/表单/表格窄屏容易裁切，部分页内 tab 需要真正点击才能发现问题 | 统一内容最小宽度、滚动容器、换行和控件布局；测试实际导航与页内视图 |
| 集成页的慢响应可能被轮询持续丢弃，切站后旧回调可能覆盖新站状态 | 请求结束后再轮询，按场站重建页面；验证 9 秒延迟响应及错误后重试 |
| 地图默认字体和充电 emoji 会触发外部字体请求 | 本地 Plex Mono 主字库、原生充电图形；实际测试地图画面和资源请求 |

## 适配边界

保留 Plantbot 的 React/Vite/shadcn、现有路由、RBAC、场站模型、3D 地图和生产 `/robots/` 前缀。Tier0-Frontend 作为参考库，不把其 Next.js/Ant Design 单体组件移植进本仓库。颜色与形态由全局 token 和共享组件承担，业务页不另建主题。

`default` / `signal` 是主操作兼容别名，`highlight` 为产品强调动作。深色保留主按钮对比边界；状态色与品牌高亮分别定义。上游浅色弱文字和状态色在小字号场景不能直接照抄，本地保留可读对比度适配。

来源中有一处冲突：产品 `layout.md` 示意为固定深色侧栏，真实库 `themes.scss` 则定义浅色白侧栏、深色黑侧栏，共享 Sidebar 消费该主题变量。按 `SKILL.md` 的“以前端库为事实来源”规则，本次侧栏随主题变化，不额外覆盖为固定黑色。

“在线空闲”表示已上报在线、idle、无任务且电量≥25%；最终任务分配还取决于能力、控制占用等服务端条件。UI 测试中的机器人和视频为隔离测试夹具/仿真，不代表真机验证或上线部署。

## 验证

生产测试先运行 `WEB_BASE=/robots/ pnpm build`，再执行：

```bash
node scripts/test-tier0-ui.mjs
node scripts/test-inspection-ui.mjs
node scripts/test-control-ui.mjs
PB_UI_PUBLIC_VIEW=0 node scripts/test-control-ui.mjs
```

所有脚本均启动独立数据库和本地代理，不访问生产写接口。截图与机器结果位于 `demos/tier0-ui-qa/final/`、`demos/inspection-qa/`、`demos/control-qa/`；这些运行产物不随代码提交，执行上述命令可重新生成。

2026-09-09 最终结果：

| 验证 | 结果 |
| --- | --- |
| `/robots/` 生产构建；web / server / integrations 类型检查 | 全部通过 |
| 中英 × 明暗 × 375 / 768 / 1440px；实际路由、页内视图和 Builder 工具 | 279 个页面状态、26 组检查通过；无页面溢出、无名称控件或意外浏览器/API错误 |
| WCAG 2 A/AA、2.1 A/AA、2.2 AA 自动检查 | 67 次 axe 扫描，0 项违规；另验键盘焦点圈定、关闭归位、跳过导航 |
| 地图与加载状态 | 验证 WebGL 实际几何像素、遥测电量与稳定读数；本轮资源请求无第三方依赖 |
| 巡检运营 UI | 11 组通过，含设备/位号、缺陷历史、真实录像解码/seek/下载、云台计划、日历/归档、组织审计及只读权限 |
| 遥操作 UI | 匿名浏览开启与关闭各 5 组通过，含真实仿真机运动/停止回执、控制权互斥、窗口失焦和切页清理 |
| 集成层 | 33 个单测 + 44 个端到端测试通过，无跳过 |
| Adapter SDK | 11 个单测通过 |
| 文档与差异 | AGENTS/CLAUDE 镜像、中文字体字形覆盖、git diff --check 通过 |

最终 UI 报告完成时间为 `2026-09-08T17:54:15.330Z`，构建入口 SHA-256 为 `bf6570f5cfb1c04cf99854178c94e6432ba0078b384b5af17318031a79f1ae9b`。测试前后校验相同，避免结果混用不同构建。浏览器验证使用 Chromium 与指定视口；仿真结果不代表真机验收，本次未部署生产。

测试过程中修正了一处已有时序假设：云台取消测试原先固定等待 650ms，在并发负载下可能早于 adapter 接单。现等待真实订单 `acked` 后取消，继续严格验证停止订单和回执，未修改生产控制逻辑。

多浏览器、手机/平板横竖屏及安全区的后续修复与复测见 [多端 UI 验证](multi-device-ui-audit.md)。上述 Chromium 首轮结果保留为本轮之前的历史证据。

## 2026-09-09 新建规则白屏回归

用户实测发现“事件 → 规则 → 新建规则”白屏。`NewRuleModal` 在 Zustand selector 内直接 `filter` 事件类型，每次产生新数组，触发 `getSnapshot` / `Maximum update depth exceeded`。修复为订阅原始 `eventTypes` 后用 `useMemo` 派生；同时补齐表单标签关联，并保持视频源 Select 从首次渲染起受控。

此前按 `role=tab` 遍历的测试没有进入 Events 的 radio 视图，因而漏掉规则弹窗。`test-tier0-ui.mjs` 现在显式验证规则入口、必填状态、内置和自定义类型保存、弹窗打开时字典更新、保存后重新新建，以及临时数据清理。新覆盖还发现浅色严重级别文字对比不足：warning/error token 分别适配为 `#985400` / `#c82020`，保证着色徽标与选中控件上的 12px 文字可读。

最终 `/robots/` 构建及三引擎 `TIER0_UI_PHASE=interactions TIER0_UI_BROWSER=chromium|firefox|webkit node scripts/test-tier0-ui.mjs` 均通过：合计 48 组检查、39 个界面状态、15 次 axe 扫描，0 项违规。开发页面另实测中文/英文、明暗主题、375px/768px/默认桌面宽度的新建和下拉交互，并经 UI 保存、停用、删除仅本次创建的临时规则；修复后无新增浏览器 error/warn。

WebKit 首次最终构建回归的规则用例已通过，但后续 Live 页出现一次媒体请求 `cancelled`，整轮判失败；原始记录保留在 `demos/vision-demo/rule-fix-webkit-first-result.json`。同一构建单独完整复跑通过，没有放宽失败分类。三引擎最终机器报告在 `demos/tier0-ui-qa/<engine>/interactions/result.json`，共同构建入口 SHA-256 为 `30a484f74c76608ebfa01708efe793e84f42acca1b0581952850b4605d36f57b`。本次仍为本地浏览器与视口验证，不代表实体手机或生产部署。
