# 巡检运营扩展：需求核对与实现

2026-09-08。实现沿用场站、Channel、订单、事件、Template/Schedule/Run 和 SQLite；不引入工作流引擎、NVR 服务或第二套权限系统。

## 需求覆盖

| 同事提出的需求 | 现状核对与本次实现 | 使用入口与边界 |
| --- | --- | --- |
| 历史视频检索、回放、下载 | 新增按通道启用录像、1–30 天保留、时间范围检索、分页、原生视频播放/拖动、MP4 下载及删除；FFmpeg 完成片段后才入库 | Video → Recordings。仅有启用录制后的历史，RTSP/本地演示文件可录制；不是外部 NVR 历史导入 |
| 云台预置点、计划、记录 | 新增命名预置点、绝对角度/变倍、有序点位与停留时间、单次/间隔/每周计划、手动调用、执行记录与 CSV、归档查询、取消/超时/重启处理 | Video → PTZ inspection。须有声明绝对定位能力且能确认到位的 adapter；已有三家接入不能据此宣称已具备真机预置点巡检 |
| 缺陷处理 | 现有事件已有 new/acked/resolved/dismissed，本次补设备缺陷台账：轻微/严重、分类、提交人、责任人、处理中/已关闭、关闭说明、重开理由、不可覆盖的处理历史 | Events → Defects；可由事件详情转建，关联设备、位号和证据。关闭缺陷不擅自改变原事件状态 |
| 工业位号台账 | 新增设备—位号—巡检点—数据类型—单位—地址，以及已有机器人 metric 的数据来源绑定 | Assets → Tag register，支持 CSV。绑定只使用已注册指标，协议和凭证仍在 adapter/connector 中 |
| 日历与报告 | 现有排程创建即生效；新增周/月日历、计划与已发生任务区分、按日期/状态查询持久归档、结果/关联事件详情、标准 CSV 和可打印 HTML 报告 | Tasks → Calendar / Archive & reports。HTML 可通过浏览器打印为 PDF；缺失采集结果不会推断为正常 |
| 被巡设备档案、视图、驱动 | 新增设备类型/位置/厂商/型号/序列号/资料备注、卡片/表格、关联位号与缺陷；接入驱动沿用现有 adapter 和托管 connector | Assets。本次不内置 PLC、Modbus 或 OPC UA 驱动，不把机器人档案误当被巡设备档案 |
| 组织、权限与运维 | 现有用户及 viewer/operator/admin × 场站权限保留；新增工厂/部门/岗位目录与用户归属、真实登录和业务操作日志、筛选/分页/90 天保留 | Sites → Organization / Audit logs。组织归属不自动授予权限；事件字典在 Integrations → Event types，指标字典沿用注册表 |
| 外部 AI 算法 | 现有 Detector、事件上报、Reading 与证据接口可作为接入口 | 等国内团队提供算法清单、部署位置、输入/输出和授权后接入；本次没有部署或模拟新的 AI 算法 |

## 云台执行语义

预置点是场站摄像头的配置资源；计划保存点位引用和停留时长，执行时冻结为独立步骤，后续编辑不会改变在跑记录。收到订单的 `acked` 不等于到位，只有 adapter 的 `done` 才开始停留计时。一个摄像头同一时刻只能由一个巡检占用；不同摄像头可以独立执行。

计划创建后按启用状态生效，不再加“下发计划”。每周云台计划明确使用 UTC，单次计划编辑采用浏览器本地时间并转换为时间戳；已有机器人任务排程仍使用服务端时区，日历会注明。首个间隔后启动间隔计划，错过的多次间隔不补发一串动作。

取消待发订单可以直接停止后续点位。设备已接单时取消、超时或平台重启，其当前位置可能未知：保存失败/取消事实并保留占用，操作员检查设备已停止后才能解除。平台解除占用不会偷偷发一条未经厂商协议证实的停止指令。

本次云台记录包括目标角度、顺序、停留、下发/回执时间及失败原因。它是预置点巡视执行记录，不自动进行抓拍、图像识别或读数采集；算法和定点采集由真实 adapter/外部算法集成提供，既有事件证据入口保持有效。

## 取舍依据

- [Milestone：巡航中的预置点顺序与停留时间](https://doc.milestonesys.com/latest/en-US/feature_flags/ff_extendedptz/sc_managepatrollingprofilespecifypositions.htm)：采用可命名预置点、有序巡视及每点停留，配置和执行记录分开。
- [Axis Guard Tour API](https://developer.axis.com/vapix/network-video/guard-tour-api/)：设备能力属于具体设备接口。平台要求 adapter 显式声明，不能用方向脉冲估算成绝对定位成功。
- [Milestone：录像检索与证据导出](https://doc.milestonesys.com/sc/pdf/2024r2/en-US/MilestoneXProtectSmartClient_SearchExportEvidenceQuickGuide_en-US.pdf)：保留通道/时间检索、播放及下载的直接流程；本次没有复制大型 VMS 的全套案件管理。
- [IBM Maximo：工单管理](https://www.ibm.com/docs/en/masv-and-l/maximo-manage/cd?topic=work-order-management) 与 [MaintainX：工单](https://help.getmaintainx.com/about-work-orders)：缺陷关联设备、位置、责任人和处理历史，关闭需要结果说明；不另造完整 CMMS。
- [Boston Dynamics Orbit](https://support.bostondynamics.com/s/article/Orbit-for-Enterprise-171952)：保留站点、时间和实际巡检数据的查询关系。本次日历中的预计触发与实际任务分开显示。
- [FFmpeg segment muxer](https://ffmpeg.org/ffmpeg-formats.html)：片段边界取决于关键帧；入库依据已完成片段清单，正在写入或损坏的 MP4 不作为可播放证据。

## 验证方法

新增用例与既有测试共用真实平台、隔离数据库。云台测试通过显式能力的外部 adapter fixture 验证订单、到位、停留、失败、取消和重启；三厂商行为回归仍对接独立 simulator 仓库。fixture 和 simulator 的结果不是实机验收。

`WEB_BASE=/robots/ pnpm build` 后运行 `node scripts/test-inspection-ui.mjs`：启动隔离 API 和 `/robots` 反代，用系统 Chrome 实际登录、操作表单、打开弹窗、读返回数据、播放与下载视频、创建并执行云台计划、处理缺陷、导出报告，检查中英文、窄屏、只读角色、控制台错误和失败请求。截图及机器可读结果在 `demos/inspection-qa/`（不入 Git）。

本次验证：33 项集成层单测、35 项完整集成测试、6 项 SDK 测试全部通过；新增 F2 复位/方向拒绝/绝对能力拒绝专项 1 项通过。生产构建及 server/web/integrations 类型检查通过。浏览器 11 组流程通过，含旧站慢请求不覆盖新站、明暗主题、iframe 嵌入、中英文及 390px 窄屏；未出现控制台错误或失败的 API/资源请求。已检查生成截图；未进行真机验收或部署新 AI 算法。

## Manual control (v2.3.1)

Manual robot input uses an exclusive expiring control session, separate from durable orders. Spot supports native velocity and discovered Spot CAM position control; F2 supports vendor directional driving and camera reset; X30 robotserver does not expose these manual interfaces. See [manual-control.md](manual-control.md) for the operator workflow, `teleop`/`ptz.manual` factsheet fields, `pumpControl`, stop confirmation and deployment limits.
