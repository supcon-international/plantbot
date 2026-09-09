# 演示录像、来源与算法边界

v2.5.1 的演示视频全部来自有公开许可的相机录像。仓库在 `integrations/demo/media/` 随附 11 个 MP4：9 条 InspecSafe 工业 RGB/IR 录像和 2 条 MEVA 安防训练场录像。它们用于演示，不代表在线生产现场；界面的机器人运动和视频内容没有空间联动。

[`media/manifest.json`](../integrations/demo/media/manifest.json) 是文件清单：记录作者、来源、固定数据集 revision、原始成员路径或下载字节区间、输入 SHA-256、加工参数、成品 SHA-256 和平台 URL 映射。[`THIRD_PARTY.md`](../integrations/demo/THIRD_PARTY.md) 提供署名和许可说明；模型来源另见[视觉组件许可](../integrations/vision/THIRD_PARTY.md)。

## 两个默认监测源

| 文件 | 实际内容与加工 | 默认演示用途与限制 |
| --- | --- | --- |
| `instrument.mp4` | InspecSafe `coal_conveyor-Level04-SuspendedRail-000020-infrared.mp4`；13.28 秒，1280×1024、25 fps；原 MP4 字节直接复制 | OCR 读取相机原生最高温叠字约 31.1–34.3℃。热点含人物，不能认定设备过热；没有根据颜色测温 |
| `restricted-area.mp4` | MEVA `2018-05-18.14-30-00.14-35-00.admin.G329.r13.avi` 的开头 0–30 秒；成品约 29.93 秒、1280×714、15 fps | 真人上下楼梯，人数统计和区域有人持续 2 秒。安防训练场演员活动，不是工厂生产事故；“禁区”是演示配置 |

OCR 区域为 `[[0.7,0.12],[1,0.12],[1,0.5],[0.7,0.5]]`，单位使用画面中的单字符 `℃`（U+2103），示例上限为 33。原始文件和成品 SHA-256 均为 `c42d70a1ebf97dc5964b87cb0d269492ae05bb2cad2798c3c2f156f67d6468d1`。模型从原生文字读出的采样包括 2 秒的 33.2℃、4 秒的 31.1℃、6 秒的 32.3℃、8 秒的 32.6℃、10 秒的 33.1℃和 12 秒的 34.3℃。这些是已观察的样本，不是每次播放都必须在同一时刻出现的预存结果；33℃ 也不是现场安全阈值。

人员区域为 `[[0.38,0.43],[0.65,0.43],[0.65,1],[0.38,1]]`。本地模型采样能观察到进入、离开与相应规则变化，也保留了约 9.6–10.8 秒上层遮挡/远距位置的漏检。示例区域缩小到可见通行区，不把全画面小目标计数当成人工真值。录到真实人物并不保证每一帧都能识别。

两个视频独立循环。worker 用正式 FFmpeg 解码、ONNX Runtime、RT-DETRv2/ByteTrack 或 RapidOCR 执行采样与规则，再上传观测及实际原图；不从清单注入识别结果。默认演示的推理直接读本地 MP4，视频页另走 RTSP → relay，所以播放器当前帧与事件证据可能不同。预热、循环切换、镜头变化、漏检和不可用输入按正式逻辑处理；未知/失败不能产生恢复。试运行不创建正式事件，人数统计只记观测；启用后的异常规则才创建事件。恢复与人工处置分别保留。

## 工业和园区画面

下表中的 InspecSafe 编号是原始成员名称，完整归档路径在清单中。平台保留部分旧文件名作为兼容 URL；文件名中的 `aerial`、`night`、`stadium` 等不再描述内容，应以画面和当前来源标签为准。

| 仓库文件 | 真实来源与内容 | 平台兼容文件名 |
| --- | --- | --- |
| `switchgear-inspection.mp4` | InspecSafe `power-Level04-Wheeled-000386-visible`，配电柜、指针表和指示灯 | `switchgear.mp4` |
| `substation-inspection.mp4` | InspecSafe `power-Level04-Wheeled-000419-visible`，变压器及高压设备 | `substation.mp4`、`plant_aerial.mp4`、`refinery.mp4` |
| `conveyor-inspection.mp4` | InspecSafe `coal_conveyor-Level04-SuspendedRail-000013-visible`，输送机巡检走廊 | `staging.mp4`、`corridor.mp4` |
| `process-pipework.mp4` | InspecSafe `oil_chemical-Level04-Wheeled-000312-visible`，工艺管线和阀门 | `perimeter.mp4`、`tanknight.mp4`、`smokestack.mp4` |
| `equipment-valve.mp4` | InspecSafe `metallurgy-Level04-Wheeled-000252-visible`，冶金设备阀体近景 | `pumpjack.mp4` |
| `substation-thermal.mp4` | InspecSafe `power-Level04-Wheeled-000419-infrared`，高压设备原生热像 | `thermal.mp4` |
| `conveyor-thermal.mp4` | InspecSafe `coal_conveyor-Level04-SuspendedRail-000013-infrared`，输送机原生热像 | `thermal_conveyor.mp4` |
| `valve-thermal.mp4` | InspecSafe `metallurgy-Level04-Wheeled-000252-infrared`，阀体原生热像 | `thermal_valve.mp4` |
| `campus-security.mp4` | MEVA `2018-03-13.17-10-03.17-15-03.school.G424.r13.avi` 开头 0–37 秒，训练场园区停车区与行人；成品约 36.93 秒 | `campus_gate.mp4`、`campus_quad.mp4`、`campus_walk.mp4`、`parking_night.mp4`、`stadium_field.mp4` |
| `restricted-area.mp4` | 上述 MEVA 设施楼梯通道 | `intruder.mp4`、`theft_cctv.mp4`、`night_walkway.mp4`、`library_aisle.mp4` |

这些工业巡检片段用于真实画面展示，不是每个场景均已配置或验证所有视觉规则。机器人巡检原片可能包含云台扫视；不能为了让固定区域规则通过而关闭 ViewGuard。指针表、温度叠字、人流和车辆需要各自对应的算法与参数。

热像均取自原作者的 `infrared` 文件，保留相机色标及叠字；普通 RGB 未被着色冒充热像。普通热像也不是 OGI 气体成像。本版没有找到适合随包再分发的已核实 OGI 输入，因此移除 `ogi.mp4` 和无执行端的 OGI 演示规则；平台已有气体指标阈值及接收真实 OGI 事件的能力仍保留。

## 来源、署名与加工

**InspecSafe-V1 — TetraBOT，CC BY 4.0。** 数据集作者说明这些 RGB/IR 视频采自实际工业巡检机器人。[原始数据说明及许可声明](https://huggingface.co/datasets/Tetrabot2026/InspecSafe-V1/blob/main/README.md)；[固定 revision 的测试归档](https://huggingface.co/datasets/Tetrabot2026/InspecSafe-V1/resolve/f3cb7d3e7827c1afc1c5bfd0524257984bba46ab/test.tar.gz)。发布清单固定 revision `f3cb7d3e7827c1afc1c5bfd0524257984bba46ab`，完整归档 SHA-256 为 `818086e696f970e036bf6a76758e4fb851fa26f771fe4eac56f8dc073b44358d`。8 条展示片保留连续原片，仅缩放/降帧、H.264 转码和去音轨；OCR 主片直接复制。

**MEVA — Kitware Inc. 与 IARPA，CC BY 4.0。** [官方数据页](https://mevadata.org/)说明采集地点是 Muscatatuck Urban Training Center，含演员的脚本与非脚本活动；[官方许可](https://mevadata.org/resources/MEVA-data-license.txt)明确授权。两段从官方 S3 原始 AVI 开头连续截取，仅缩放、降帧至 15 fps、H.264 转码并去音轨。实际下载的是各原文件的首 16 MiB，足够覆盖所选窗口；清单中的输入 SHA 仅对应该字节范围，不是未下载的完整 5 分钟 AVI 的 SHA。交付 MP4 是完整、可解码的成品。

没有重排人物动作、补画读数、生成中间场景或倒放接成长循环。热像保留采集设备的原始显示；MEVA 的真实场地身份与人员活动不被改写为工厂违规。分发时保留来源、作者、[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 与修改说明，不暗示原作者或录像人物为 Plantbot 背书。完整成品哈希与精确 FFmpeg 参数以随包清单为准。

## 安装与复核

`pnpm run setup` 从仓库内素材安装到 `server/media`，源文件和目标缓存均检查 SHA-256；仅同名不能命中缓存，旧别名内容不匹配时通过临时文件原子替换。只处理清单登记的演示文件及明确退役的 `ogi.mp4`，不批量改数据库或历史证据。开发和 Demo 包共用 Plantbot 的 `docker/bench-rtsp.mjs`；独立 `plantbotsimulator` 继续提供原生机器人协议，Plantbot 不再读取其旧录像缓存。历史发布归档不回写。

```bash
# 已有文件的完整解码和 SHA 校验；不下载或生成媒体
python3 integrations/demo/make-media.py
# 安装器的旧缓存替换、校验失败和退役文件清理回归
node scripts/test-demo-media.mjs
# 正式模型对默认两路录像的采样与规则测试
integrations/vision/.venv/bin/python integrations/demo/test-media.py integrations/vision/models
```

素材验证通过不等于整个发布包通过；离线启动、RTSP、模型输出、事件、重启保留和清理还需执行 [Demo 包验收](demo.md#开发与验证)。模型缺失或损坏必须明确失败，不允许回退到伪造识别。
