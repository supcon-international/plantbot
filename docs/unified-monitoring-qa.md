# 统一监测工作区验证

2026-09-09。设计依据沿用 [Tier0 UI 审计](ui-design-audit.md)固定的真实 skill 与前端主题库。此文记录统一监测改造的验证，前一轮安全区、焦点和设备覆盖见 [多端 UI 审计](multi-device-ui-audit.md)。

## 产品变更

- EVENTS 统一为事件、监测规则、缺陷三个页签；事件保留看板和表格。LIVE 只保留视频、云台巡检与录像，通过相关规则或添加规则进入同一编辑器。
- 视觉规则使用 adapter 实际声明的预置能力、视频来源、ROI/越线区域和试运行；指标规则绑定一个机器人及其真实 metric。旧模拟规则明确标注演示，旧视觉占位规则显示未接入执行端，不再新建假算法。
- 配置是否启用与执行状态分别显示。试运行明确不创建事件；规则详情查看实际观测。视频关联只使用 adapter 显式报告的 channelId，不猜测无法证实的来源关系。
- 事件展示实际触发值和条件、冻结规则版本、实际观测、原图标注及可用视频。未报告模型置信度时显示未知；无可追溯观测的旧 vision-* 事件不显示历史伪默认 100%。未知位置不在地图补造坐标。
- 管理员编辑规则；操作员可试运行视觉配置但不能保存；查看者不能执行这些操作。全程复用既有 Tier0 token、shadcn 和 Carbon 组件。

## 回归中修复的问题

| 问题 | 证据与处理 |
| --- | --- |
| 阈值编辑发送不可变机器人/指标字段而被 API 拒绝 | 创建发送完整配置；编辑仅发送可修改字段，机器人和指标在编辑时禁用；真实 POST、PATCH、重开与事件字典变化回归覆盖 |
| 旧视觉事件置信度默认 1 会误导复核 | 看板、表格和详情共用 eventConfidence；冻结 trigger 优先，已知视觉事件缺 trigger 时返回未知 |
| EVENTS 本地页签状态与 URL 双来源导致重复加载和主动取消 | WebKit 真实点击与 AbortSignal 记录发现进入缺陷后无再次操作即取消四路请求；源码隔离对比连续五轮，修前每轮 8 次 fetch/4 次 abort，URL 单一来源后每轮 4 次 fetch/0 次 abort |
| MSE 播放器卸载后排队的 updateend 读取已移除 SourceBuffer | 实际 RTSP 回放定位到 InvalidStateError；播放器清理移除监听并拒绝处理失效的 MediaSource/SourceBuffer，另由视频实播门禁验证 |

Firefox 将 Radix 的隐藏原生 Select 表单代理报告为 1px 元素。手工命名检查只排除同时满足 aria-hidden、负 tabIndex、绝对定位、1px 尺寸、overflow hidden 和零裁剪矩形的代理；可聚焦或可见控件仍接受检查，axe 检查不变。API 取消仍是失败，未为页签问题添加过滤。

## 最终构建与结果

最终生产构建入口 SHA-256：`5c8a7d9c26cde0f25a15f8e21497500655eddfddda7d0ebe231678f543a0cfe7`。以下五组 Tier0 矩阵均使用此构建，测试进程已正常退出。早期失败和中间结果保留在 `demos/unified-monitoring-qa/previous-*/`，不作为最终通过结果。

| Tier0 矩阵 | 页面状态 | 检查组 | axe 扫描 | 违规 |
| --- | ---: | ---: | ---: | ---: |
| Chromium 桌面宽度矩阵 | 316 | 28 | 68 | 0 |
| Firefox 桌面宽度矩阵 | 316 | 28 | 68 | 0 |
| WebKit 桌面宽度矩阵 | 316 | 28 | 68 | 0 |
| Chromium Pixel 横竖屏与安全区 | 89 | 26 | 38 | 0 |
| WebKit iPhone/iPad 横竖屏 | 207 | 28 | 106 | 0 |
| 合计 | 1,244 | 138 | 348 | 0 |

五组结果均无页面溢出、未命名控件、未分类浏览器错误、失败响应或失败请求。浏览器版本为 Chrome 152.0.7977.83、Firefox 151.0、WebKit 26.5。汇总脚本逐项核对通过标记、构建 hash 和零违规，证据在 `demos/unified-monitoring-qa/final-summary.json`。

本构建的实际 RTSP → go2rtc → MSE 四组测试已通过：Chromium、Firefox、WebKit 桌面及 WebKit iPhone 13 模拟。每组初次和重新进入都实际解码；SPA 离开后 socket 关闭、go2rtc 消费者归零。测试另对真实已关闭、已无 SourceBuffer 的 MediaSource 回放迟到 updateend：修复前原样复现 InvalidStateError，修复后页面错误为空，未添加错误过滤。原始失败与修复后的证据均保留在 `demos/stream-browser-qa/`。

| 已完成验证 | 结果 |
| --- | --- |
| 实际视觉推理与统一规则流程 | 三引擎各 8 组检查、12 个语种/主题/宽度组合；共 24 组检查、36 次 axe 扫描，0 违规、0 浏览器错误、0 失败响应 |
| 遥操作 | Chromium/Firefox/WebKit 各 5 组，Chromium 原生触控 6 组，关闭匿名浏览 5 组，共 26 组通过 |
| 巡检运营 | 设备与位号、缺陷、录像、云台、归档、组织审计、权限等 11 组通过 |

视觉脚本与巡检脚本的 JSON 不内置构建 hash：以上结果通过本轮固定构建后的启动/结束记录关联到 5c8。Tier0、流媒体和控制报告自身记录入口 hash 并检查测试期间不变。控制测试保留停止期间迟到输入产生的、响应文案吻合的 409 竞争诊断，其他浏览器错误或响应失败仍阻断。

根侧还完成 Python 视觉 18 项、SDK 11 项、集成单测 33 项，以及厂商/平台集成 45 项（0 跳过）。统一监测与既有视觉专项 2 项通过；新增隔离快照目录门禁验证真实 JPEG 由临时 PB_DATA_DIR 逐字节返回，避免测试写入默认生产数据目录。Docker 最终版本解包验证另见发布记录，不把早期包验证计为最终版本验证。

## 验证范围与边界

生产构建使用 `/robots/` 子路径、本地反向代理和隔离 SQLite。桌面矩阵为 Chromium、Firefox、WebKit 的中英 × 明暗 × 375/768/1440px；设备模式另覆盖 Pixel、iPhone SE/13/15、iPad 横竖屏和真实 CSS env 安全区注入。包含实际页内导航、键盘焦点、可见错误、规则创建/编辑、权限和同源 iframe。

视觉测试运行实际 Python worker 和已安装模型，对支持的 11 项预置能力执行推理，并验证 OCR 读数告警、ROI 操作、原图下载和事件追溯。输入使用测试视频/图像，不是现场识别准确率评估。未实现的 PPE/吸烟模型不列为可运行能力。

遥操作测试经过真实 adapter 协议与 sibling plantbotsimulator，检查运动、停止回执、控制权互斥、失焦/切页清理及触控取消；这不是实体机器人验收。视频检查使用 FFmpeg RTSP/TCP → go2rtc → 页面 MSE，要求实际解码与切页释放，不接受文件播放回退替代。

这些是 macOS 浏览器引擎和 Playwright 设备模拟测试，不是实体手机/平板或所有操作系统的验收。未验证实体软键盘、地址栏伸缩、真实网络切换或硬件解码性能。设备导航使用 tap；Chromium 滚动为原生 wheel，移动 WebKit 使用 DOM scrollBy，不能称为真实手指滑动。Builder 取消/第二指针为合成 PointerEvent；遥操作触控取消另用 CDP 原生输入验证。

源码隔离页签探针结果在 `demos/unified-monitoring-qa/events-tabs-probe.json`，明确标注 `sourceFixture: true` 和 `productionBundleTest: false`，不计入生产构建页面数。实际产物和截图不提交 Git。

早期并行运行有两次 Chromium 测试在全部页面检查通过后清理超时，仍记录为失败；没有延长 25 秒超时或改写通过标记。加入清理阶段诊断后，桌面与设备矩阵分别完整重跑并正常退出。最终表仅统计这些正常结束的运行。

Firefox 在测试发起整页跳转销毁 Troika Worker 时，可能输出一对同源 blob 错误。独立、未改动的 `troika-worker-utils@0.52.0` 页面中，稳定等待和 SPA pushState 各三轮均完成 200/200 次计算且无错误；20 次整页跳转中 6 次复现，pagehide 清理对照仍有 4/10 次。脚本只将同一页面/文档、同一 blob、同一次明确离页期间的 `JSHandle@object`（读取结果为 context disposed）与精确 rehydrate 文案配对归档；单条、可读取对象、稳定页面、SPA 和目标页面的错误仍失败。原脚本、完整 JSON 与日志在 `demos/unified-monitoring-qa/troika-firefox-probe/`；不为该库行为增加产品代码绕行。

## 复现

准备本地素材、Playwright 浏览器、Python 视觉环境与 sibling plantbotsimulator 后，先运行 `WEB_BASE=/robots/ pnpm build`。测试期间不要重新构建。

```bash
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
node scripts/test-inspection-ui.mjs
PB_UI_BROWSER=chromium node scripts/test-vision-ui.mjs
PB_UI_BROWSER=firefox node scripts/test-vision-ui.mjs
PB_UI_BROWSER=webkit node scripts/test-vision-ui.mjs
PB_STREAM_STALE_CALLBACK_PROBE=1 node scripts/test-stream-browser.mjs
```

控制脚本使用固定端口，必须顺序运行。各测试输出位于 `demos/tier0-ui-qa/`、`demos/control-qa/`、`demos/inspection-qa/`、`demos/vision-qa/` 和 `demos/stream-browser-qa/`。

参考：[Playwright 设备模拟](https://playwright.dev/docs/emulation)、[浏览器支持范围](https://playwright.dev/docs/browsers)、[Radix Select](https://www.radix-ui.com/primitives/docs/components/select)。
