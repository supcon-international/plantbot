# Plantbot 多端 UI 验证

2026-09-09，在 [Tier0 设计审计](ui-design-audit.md)合并后补充多浏览器、手机和平板检查。设计依据仍为该报告中固定版本的真实 Tier0 skill 与主题库。

## 本轮修复

| 问题 | 修复及验证方式 |
| --- | --- |
| 手机横屏进入桌面侧栏布局后，末尾模块超出高度且无法滚动 | 侧栏导航允许收缩和纵向滚动；实际进入末尾的文档模块 |
| 刘海屏横屏、底部手势区可能遮挡顶栏、导航与弹窗保存按钮 | 统一四边安全区，弹窗按安全矩形定位，滚动到底后检查按钮边界 |
| 独立登录页未避开刘海区，登录门禁继承了不存在的侧栏偏移 | 登录页和门禁使用独立安全区布局；短横屏表单可滚动，滚动定位留出手势区 |
| iframe 桌面布局继承侧栏留白，横向导航滚动时中间项目可进入不安全区域 | 嵌入内容明确取消侧栏偏移，导航滚动容器自身限制在安全区域内；检查 top/bottom/hidden 与全部导航项目 |
| Builder 拖拽中断后仍保留拖动状态，第二个触点可干扰编辑 | 按 pointer ID 跟踪主指针，取消及失去捕获时清理；真实鼠标拖拽后检查取消、失去捕获和第二触点 |
| WebKit 鼠标打开受控弹窗后，Escape 关闭没有回到触发按钮 | 从当前点击事件记录实际触发控件，按每次打开保存；保留 Radix Trigger、嵌套弹窗及调用方取消默认焦点行为 |
| 窄屏代码块发生横向滚动后，键盘用户无法进入 | 集成页与机器人接入向导共五处代码区增加键盘焦点和可见焦点环；设备模式下执行 axe |

## 环境与范围

测试使用 macOS 上的 Playwright 1.61.1，运行生产 `/robots/` 构建、隔离 SQLite、真实本地代理和模拟机器人。没有访问生产写接口或部署生产。

- Chromium（已安装 Chrome 152.0.7977.82）、Firefox 151.0、WebKit 26.5：中英 × 明暗 × 375/768/1440px；覆盖 12 个业务路由、页内视图、Builder、登录、错误恢复、权限、实际同源 iframe 和键盘操作。
- Chromium 设备模拟：Pixel 7 竖屏 412×839、横屏 863×360，DPR 2.625。
- WebKit 设备模拟：iPhone SE 320×568、iPhone 13 390×664 和横屏 844×390、iPhone 15 393×659；iPad 第六代 768×1024 / 1024×768。使用对应设备的 UA、触控、移动视口与 DPR。
- Chromium CDP 安全区注入：375×812（上47/下34）和 844×390（左47/右47/下21），断言实际 CSS env 值与控件坐标。
- 控制测试：三引擎的真实仿真机运动、停止回执、控制权互斥、失焦/切页清理；另用 Chromium 原生 CDP 触控输入验证按住、松手与 touchCancel 停止。
- 视频测试：本地素材经 FFmpeg 编码为 RTSP/TCP，再由 go2rtc 拉流，经生产 LIVE 页 MSE WebSocket 播放。检查协商、二进制视频帧、实际解码尺寸与进度、非空画面以及离开/重新进入。浏览器不能通过文件播放回退取得通过。

## 最终结果

生产构建入口 SHA-256：`22f405cd5843feb3454f257115fb1964b795105b409b2025df52959aeec4d921`。本轮业务复测均使用这份构建。

| 验证 | 结果 |
| --- | --- |
| 三引擎桌面矩阵 | Chromium / Firefox / WebKit 各 279 个状态、27 组检查通过，合计 837 个状态 |
| 手机和平板设备矩阵 | Chromium 82 个状态、25 组检查；WebKit 188 个状态、27 组检查通过，合计 270 个状态 |
| 全部 UI 矩阵 | 共 1,107 个状态、133 组检查；343 次 axe 扫描、0 项违规；未发现页面溢出、未命名控件、未分类运行错误或失败请求 |
| RTSP → go2rtc → MSE | Chromium、Firefox、WebKit 桌面及 WebKit iPhone 四组通过；实际 SPA 切页后播放器移除、socket 关闭、go2rtc 消费者清零，再进入可恢复解码 |
| 遥操作 | 三引擎各 5 组、Chromium 原生触控 6 组、关闭匿名浏览的 Chromium 5 组，共 26 组通过 |
| 巡检运营 | 设备/位号、缺陷、录像、云台、归档、组织审计与权限共 11 组通过 |
| 弹窗焦点专项 | WebKit、Chromium 源码隔离夹具各 10 类检查通过；生产构建矩阵另检查实际 Add asset 弹窗 |
| 静态检查 | `/robots/` 构建、前端类型、测试脚本语法、AGENTS/CLAUDE 镜像及差异检查通过 |

## 可复现命令

先安装 Firefox / WebKit 浏览器运行时，准备项目素材及 sibling `plantbotsimulator`，然后构建：

```bash
pnpm exec playwright install firefox webkit
pnpm run setup
WEB_BASE=/robots/ pnpm build

TIER0_UI_BROWSER=chromium node scripts/test-tier0-ui.mjs
TIER0_UI_BROWSER=firefox node scripts/test-tier0-ui.mjs
TIER0_UI_BROWSER=webkit node scripts/test-tier0-ui.mjs
TIER0_UI_BROWSER=chromium TIER0_UI_DEVICES=1 node scripts/test-tier0-ui.mjs
TIER0_UI_BROWSER=webkit TIER0_UI_DEVICES=1 node scripts/test-tier0-ui.mjs

PB_UI_BROWSER=chromium node scripts/test-control-ui.mjs
PB_UI_BROWSER=firefox node scripts/test-control-ui.mjs
PB_UI_BROWSER=webkit node scripts/test-control-ui.mjs
PB_UI_BROWSER=chromium PB_UI_TOUCH=1 node scripts/test-control-ui.mjs
PB_UI_BROWSER=chromium PB_UI_PUBLIC_VIEW=0 node scripts/test-control-ui.mjs
node scripts/test-stream-browser.mjs
node scripts/test-inspection-ui.mjs
node scripts/test-dialog-focus.mjs
```

控制脚本使用固定端口，五次控制运行必须顺序执行。其余业务脚本使用独立数据目录；测试期间不要重新构建。多端与视频/控制报告记录浏览器版本及入口文件 SHA-256，并校验测试前后相同。

Dialog 脚本以隔离 Vite 入口测试当前源码，不改 `web/dist`，结果在 `demos/dialog-focus-qa/` 明确标注 `sourceFixture: true`，不混入生产构建页面数量。覆盖鼠标/键盘打开、焦点圈闭、Escape、输入自动聚焦、调用方回调、常驻确认框、嵌套归位、Radix Trigger 与过期激活事件。

结果与截图保存在 `demos/tier0-ui-qa/<engine>/{final,devices}/`、`demos/control-qa/multi-device/`、`demos/stream-browser-qa/`、`demos/inspection-qa/`，运行产物不提交 Git。

## 验证边界

这些是浏览器引擎和设备模拟测试，不是实体 iPhone、iPad、Android 真机验收，也不等于覆盖所有操作系统上的正式 Safari、Chrome 或 Firefox。未验证实体键盘弹起、浏览器地址栏动态伸缩、真实网络切换及硬件解码性能。

设备导航使用浏览器触控 tap；Chromium 滚动用原生 wheel，移动 WebKit 因 Playwright 不支持 wheel，使用 DOM scrollBy 并断言实际滚动位置和内容可达性，不能称为真实手指滑动。Builder 的主拖拽是实际鼠标输入，取消和第二触点为合成 PointerEvent；遥操作的触控取消另经 CDP 原生输入验证。

依据：[Playwright 浏览器](https://playwright.dev/docs/browsers)、[设备模拟](https://playwright.dev/docs/emulation)、[CDP 安全区覆盖](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setSafeAreaInsetsOverride)、[WCAG 2.2 重排](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)。Firefox 不支持 Playwright 的 isMobile，因此使用其桌面宽度矩阵，不伪装成移动 Firefox。

测试诊断单独保留：Firefox 的本地媒体 `NS_ERROR_PARSED_DATA_CACHED` 按 [Mozilla 自身定义](https://searchfox.org/mozilla-central/source/devtools/shared/network-observer/NetworkUtils.sys.mjs)归为已缓存状态；主动切页/关闭导致的本地资源取消（包括受保护的事件快照图片）必须关联请求的导航或关闭记录。其他网络失败仍阻断测试。

WebKit 在 LIVE 初次加载 `plant_aerial.mp4` 时会取消一次完整 Range 请求，并重新请求文件尾段与前段。独立复现中，随后 19ms 内进入实际播放，2.5 秒内解码帧数从 11 增至 61，视频错误为空。测试仅在同页面、同文档、同 URL 成功解码的证据成立时，将这类取消记录为媒体诊断；不能用其他页面播放成功替代。

Troika Worker 的同源 blob 在快速整页跳转时也会产生取消及访问检查日志。纯库探针中，等待模块注册完成后再跳转没有错误，快速跳转能复现；`pagehide` 清理不能可靠避免，因此没有修改产品 Worker 逻辑。测试仅分类工具明确发起硬导航期间、来源和文案吻合的诊断，保留原文与导航记录；稳定页面或 API 的同类错误仍阻断。

WebKit 手机视频模式有内部媒体图标诊断，脚本在同轮 `about:blank`、不加载 Plantbot 的媒体探针上复现后，只分类文案与空来源位置完全相同的消息，保留原始记录；实际解码和页面错误仍独立阻断。
