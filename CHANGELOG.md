# Changelog

## v2.5.1 — 2026-09-09

### 中文

- 全面替换演示视频：采用有来源与许可记录的真实配电柜、变压器、输送机、阀组、原生热像和安防训练场录像。
- 删除照片动画、生成温度画面和伪 OGI；真实 Adapter OCR 读取热像原有最高温字幕，人员规则检测录像中的实际出入。
- 开发 RTSP、平台视频与 Demo 发布包共用校验过的素材，旧缓存按 SHA-256 替换；模型及视角检查保持原样。
- 主播放器保留完整画面，避免裁掉热像读数；修复 Vite 代理改写 Host 导致本地 RTSP 黑屏的问题，保留 WebSocket 同源校验。
- 演示包使用新的素材版本标识。旧演示数据保留，新素材从新的专用演示项目启动，避免旧规则阈值和用户修改被覆盖。

### English

- Replaced demo videos with attributed recordings of real industrial inspections, native thermal cameras and security-training activity.
- Removed photo animation, generated readings and simulated OGI. Adapter OCR reads the original thermal maximum-temperature overlay, while person rules observe actual movement.
- Unified development RTSP, platform footage and Demo package assets with SHA-256 verified cache replacement; model and view checks are unchanged.
- Kept the full video frame visible and fixed local RTSP playback by preserving Host through the Vite proxy without bypassing WebSocket origin checks.
- Added a media revision boundary for persistent Demo installations. A fresh dedicated demo project preserves older data and user-edited rules.

## v2.5.0 — 2026-09-09

### 中文

- 将视觉监测并入事件中心，与真实传感器阈值共用监测规则入口、编辑与观测复核；视频页按通道提供同一规则的快捷入口。
- 事件保留触发时的规则版本、读数、观测与证据，配置修改和删除不重写历史；试运行与正常观测不生成异常事件。
- 区分规则启用状态与 Adapter 实际运行状态，公开真实预置能力，禁止随机演示生成器触发真实阈值规则。
- 新增独立 Adapter Demo 发布包：原生协议模拟器经真实厂商 Adapter 接入，演示视频经实际模型推理，一键启动和保留数据重启。
- Server 与 Adapter 生产包保持独立，Demo 包明确标记演示场站并关闭 Server 和模拟器随机告警。

兼容性：原有视觉配置、结果与规则继续使用现有持久化来源；新建传感器规则必须显式声明类型和阈值条件。演示验证不代表现场模型准确率或实机协议验收。

### English

- Unified vision monitoring and real sensor thresholds under Events → Monitoring rules, with shared editing and observation review; linked video channels open the same rules.
- Preserved triggering rule revisions, values, observations and evidence without rewriting event history after configuration changes or deletion. Previews and normal observations do not raise anomaly events.
- Distinguished configured enablement from actual Adapter runtime state, advertised supported presets and excluded real thresholds from random demo event generation.
- Added an independent Adapter Demo release bundle with native-protocol simulators, real vendor adapters, actual model inference from sample videos and one-command startup with persistent data.
- Kept production Server and Adapter packages separate; the Demo package labels its site and disables random Server and simulator alarms.

Compatibility: Existing configuration and result stores remain authoritative. New sensor rules require an explicit type and threshold condition. Demo acceptance does not establish site-specific model accuracy or physical-robot certification.

## v2.4.0 — 2026-09-09

### English

- Added eleven vision inspection presets with bundled detection and OCR models, shared tracking and scene rules.
- Added monitoring configuration, scene previews, protected evidence review and versioned observation history.
- Added standalone Adapter deployment with independent robot and vision processes.
- Updated the bilingual interface, navigation and responsive layouts.
- Published separate, self-contained Server and Adapter deployment packages with checksums.

Compatibility: Continuous vision monitoring requires a fixed camera view. Mobile OCR requires confirmed stationary feedback. Existing robot integration and managed connectors remain supported. See the deployment guide when upgrading from the v2.3.1 demo package.

### 中文

- 新增 11 项视觉巡检预置能力，内置检测与 OCR 模型，复用目标跟踪和场景规则。
- 新增监测配置、场景试运行、受保护证据复核与版本化观测记录。
- 新增独立 Adapter 部署，机器人驱动与视觉进程分别运行。
- 更新中英文界面、导航与响应式布局。
- 分别提供 Server、Adapter 完整部署包及校验文件。

兼容性：连续视觉监测要求固定视角；移动相机 OCR 需要可信停稳反馈。现有机器人集成和托管连接器继续兼容。从 v2.3.1 演示包升级请参阅部署指南。

## v2.3.1 — 2026-09-08

### English

- Added robot teleoperation with exclusive control, expiring inputs and confirmed stopping.
- Added measured camera control and current-position preset capture.
- Added PTZ presets, scheduled patrols and execution history for compatible adapters.
- Added video recording, historical playback and MP4 downloads.
- Added equipment and tag registers, defect tracking, inspection calendars and reports.
- Added organization directories and audit logs; refined navigation and account controls.
- Added prebuilt deployment packages with versioned images and SHA-256 checksums.

Compatibility: Spot supports robot driving and optional Spot CAM positioning. F2 supports directional driving and camera reset. Available controls follow each adapter’s declared capabilities.

### 中文

- 新增机器人遥操作，支持独占控制、输入超时停止与停止确认。
- 新增云台手动调整、位置回读及当前位置预置点保存。
- 新增云台预置点、定时巡检与执行记录，支持兼容适配器。
- 新增视频录像、历史回放与 MP4 下载。
- 新增设备与位号台账、缺陷跟踪、巡检日历及报告。
- 新增组织目录与审计日志，优化导航及账户操作区。
- 提供预构建部署包、版本化镜像及 SHA-256 校验文件。

兼容性：Spot 支持机器人驾驶及可选 Spot CAM 云台定位；F2 支持方向驾驶及云台复位。可用控制项以适配器声明的能力为准。
