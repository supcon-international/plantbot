# Changelog

## v2.4.0 — 2026-09-09

### English

- Added eleven vision inspection presets with bundled pretrained detection, tracking and OCR models.
- Added monitoring configuration, scene previews, protected evidence review and versioned observation history.
- Added standalone Adapter deployment with independent robot and vision processes.
- Updated the bilingual interface, navigation and responsive layouts.
- Published separate, self-contained Server and Adapter deployment packages with checksums.

Compatibility: Continuous vision monitoring requires a fixed camera view. Mobile OCR requires confirmed stationary feedback. Existing robot integration and managed connectors remain supported. See the deployment guide when upgrading from the v2.3.1 demo package.

### 中文

- 新增 11 项视觉巡检预置能力，内置预训练检测、跟踪与 OCR 模型。
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
