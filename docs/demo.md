# Adapter Demo / 离线完整演示

`plantbot-adapter-demo-v2.5.1-linux-amd64.tar.gz` 是独立离线演示包。它自带同版本 Server、网页、视频中继、三品牌原生协议模拟器、正式 Adapter runtime、真实 ONNX/OCR 模型，以及有来源和许可记录的实拍视频，无需先安装另外两个包。两个默认监测源均标记为 **Demo · Recorded**。首次启动需要 Docker Engine 和 Compose 2.17+；启动过程中不构建源码、不拉镜像、不下载模型。包内 `release.json`、`SHA256SUMS`、`models.lock.json`、`demo.pack.json` 与 `media/manifest.json` 记录版本、镜像、模型和素材来源。

## 一条命令启动

```bash
sha256sum -c plantbot-adapter-demo-v2.5.1-linux-amd64.tar.gz.sha256
tar -xzf plantbot-adapter-demo-v2.5.1-linux-amd64.tar.gz
cd plantbot-adapter-demo-v2.5.1-linux-amd64
bash start.sh
```

打开 `http://127.0.0.1:18080/robots/?site=demo-lab`。首次生成的 `.env.demo` 权限为 600，包含 `admin`、`operator`、`viewer` 三个账户密码。管理员可编辑监测规则；演示日常巡检使用 operator。服务端设置 `PB_DEMO=0`，只创建标记清晰的 `demo-lab` 场站，没有随机 Server 告警或伪造历史结果；模拟器的随机设备/厂商告警也显式关闭，视觉异常只由真实推理生成。初次启动需要等待镜像导入和模型初始化。人员录像约 30 秒循环，热像录像 13.28 秒循环，彼此独立。

默认服务只监听本机网页端口 18080 和 RTSP 端口 18554。通过 `.env.demo` 的 `PLANTBOT_BIND`、`PLANTBOT_PORT`、`PB_DEMO_RTSP_BIND`、`PB_DEMO_RTSP_PORT` 调整；只给需要访问的网络开放。已有同名端口时可首次运行 `PLANTBOT_PORT=18081 PB_DEMO_RTSP_PORT=18555 bash start.sh`。不同演示使用不同的 `PB_DEMO_PROJECT`，它隔离全部数据卷；后续启动、停止也使用同一项目名。

## 现场演示顺序

| 页面 | 可以验证什么 | 明确边界 |
| --- | --- | --- |
| 机队、地图 | Spot、X30、F2 在线，位置/状态经原生协议更新；选择机器人运行两点巡检模板 | 机器人由独立 simulator 驱动，不是真机；任务、暂停、恢复和回充以对应 Adapter 实际能力与回执为准 |
| 视频 | 两个固定源和机器人摄像头经 RTSP → relay 播放 | 真实录像回放，不是当前现场相机；机器人位置与录像内容无空间联动 |
| 事件 → 监测规则 | 热像画面最高温 OCR、人数统计、禁区持续有人，原图与模型标注可复核 | 实际解码、采样和模型推理；配置名称与素材清单不会代替算法 |
| 规则观测历史 | 相机原生叠字约 `31.1–34.3℃`；人员自然进入和离开楼梯通行区 | 试运行不生成正式事件；人数统计只产生观测，未知/失败也保留 |
| 事件详情 | OCR 大于示例上限 33℃、区域有人持续 2 秒产生异常，查看触发配置、观测和原图 | 热点含人物，不代表设备过热；禁区是演示配置，不是对录像中人员的违规认定 |
| 设备、任务 | 演示热像显示读数关联设备档案，两点路线可执行 | 机器人到点拍照不会自动调用独立 OCR 规则 |

人员视频来自 MEVA 安防训练场的固定楼梯摄像头，含真实演员活动，并非工厂生产现场。热像来自 InspecSafe 煤廊巡检机器人的原始 IR 文件，保留原相机的最高温数字，没有绘制或替换读数。OCR 读取右上角文字，不从颜色计算温度，也不确认最高温对应哪台设备；33℃ 仅用于演示规则变化。完整文件、署名、修改说明与旧 URL 映射见[演示素材](demo-media.md)，包内署名见 `DEMO_SOURCES.md`。

播放器使用 RTSP，视觉 worker 直接解码同一份本地 MP4；两者不保证逐帧同步，事件证据来自真正参与推理的那一帧。`media/manifest.json` 的采样读数是可复核的参考，不会注入观测。ViewGuard、检测器和 OCR 使用正式逻辑；预热、漏检、循环切换、黑屏、缺帧或视角变化可能产生未知/不可用，不能当成正常恢复。正常恢复不等于操作员已解决，停用规则也不会关闭历史事件。模型缺失或 SHA-256 不符时启动失败，没有假识别回退。

## 连接已有 Server（可选）

```bash
cp .env.demo.example .env.demo
chmod 600 .env.demo
# 设置 PB_DEMO_SERVER_URL、PB_DEMO_ADMIN_USER、PB_ADMIN_PASSWORD
# 设置 Server 可达的 PB_DEMO_RTSP_BASE，例如 rtsp://192.168.1.100:18554
bash start.sh --external
```

这个模式不会启动包内的 Server 服务，只通过现有会话 API 新建本演示专用的 `demo-lab`、场站 key、设备、摄像头和规则。需要平台管理员账户。遇到不属于本次安装的同名场站时拒绝覆盖；不修改已有业务场站、规则和机器人。源 RTSP 凭证（本演示无凭证）仍只在管理员面可读。已有 Server 若位于云端，必须有回到演示机 RTSP 端口的私网或网络路由，否则可查看推理上传的证据，但视频直播无法连通。

私有场站 key 和运行配置放在本项目 `demo-config` 数据卷中，两个 Adapter 容器启动时复制配置并降为 UID 1000。外接 Server 的管理员凭证只给一次性播种服务，正式驱动/视觉服务不继承它。重复 `start.sh` 不重建历史、不重复创建规则、不重新启用被用户停用的规则。丢失凭证文件时请恢复原文件，不要通过删库绕过。

### 旧演示包升级

旧合成输入的区域、单位和阈值不能直接套到新录像。启动器会检查 `mediaRevision`，遇到旧演示状态时拒绝复用，保留原规则和历史。先停止并备份旧项目，再以新的 `PB_DEMO_PROJECT` 和 `PB_DEMO_ENV_FILE` 启动，例如：

```bash
PB_DEMO_PROJECT=plantbot-recorded-demo PB_DEMO_ENV_FILE=.env.recorded-demo bash start.sh
```

之后启停沿用这两个变量。若旧项目仍运行，还需另选网页和 RTSP 端口。外接 Server 的同名 `demo-lab` 不会自动覆盖；应使用独立 Server，或经管理员明确处理旧演示场站。历史证据与旧发布归档不做改写。

## 运行与停止

```bash
docker compose -p "${PB_DEMO_PROJECT:-plantbot-demo}" --env-file "${PB_DEMO_ENV_FILE:-.env.demo}" -f compose.yaml --profile server ps
docker compose -p "${PB_DEMO_PROJECT:-plantbot-demo}" --env-file "${PB_DEMO_ENV_FILE:-.env.demo}" -f compose.yaml logs --tail=100 demo-adapter vision
docker compose -p "${PB_DEMO_PROJECT:-plantbot-demo}" --env-file "${PB_DEMO_ENV_FILE:-.env.demo}" -f compose.yaml --profile server stop
```

普通停止保留数据；再次 `bash start.sh` 继续使用它。确实需要删除本演示的数据时，在确认 Compose 项目名后执行 `down -v`；外接模式的场站在远端 Server 中，必须由管理员单独删除，停止本地容器不会删除它。不要向现有生产 Server 隐式清库。

## 开发与验证

源码环境使用 `bash scripts/demo-up.sh`，它会构建镜像，因此需要构建依赖下载；离线交付请使用发布包的 `start.sh`。外部 simulator 必须处于 `demo.pack.json` 固定 revision；代码始终保留在独立仓库，通过 Docker build context 纳入演示镜像，不并入 Server 或生产厂商驱动。

```bash
# 检查全部录像 SHA-256 与完整解码；不下载素材
python3 integrations/demo/make-media.py
# 检查已提交素材与真实权重；不启动服务
integrations/vision/.venv/bin/python integrations/demo/test-media.py integrations/vision/models
# 对提取后的完整离线演示包运行隔离测试
node scripts/test-demo-package.mjs dist/releases/plantbot-adapter-demo-v2.5.1-linux-amd64.tar.gz
# 三包版本一致性与正式 Adapter、Demo 一并验证
node scripts/test-release-packages.mjs SERVER.tar.gz ADAPTER.tar.gz ADAPTER_DEMO.tar.gz
```

`make-media.py` 默认只校验，不生成场景或下载来源。维护者可显式提供 `--source-dir` 和独立的 `--output-dir`，按清单校验原始输入后复制/转码；编码器版本导致成品 SHA 改变时必须重新审阅和测试，不能自动更新可信清单。测试检查真实模型输出、正常/异常/恢复、人员统计/禁区条件、JPEG 证据、原生机队、RTSP 和重启幂等；素材解码、真实推理与完整离线包测试是不同检查，均不能由文件存在替代。

## English

The Adapter Demo archive is a self-contained offline installation: the same-version Server images, native Spot/X30/F2 simulators from a pinned separate repository, the production Adapter runtime and vision worker, locked ONNX/OCR weights, and labelled distributable input videos. Run `bash start.sh` and open `/robots/?site=demo-lab`. Credentials are generated in private `.env.demo`. Random Server and simulator alarms are disabled; visual events come only from actual inference. No historical observations are fabricated.

The two monitored inputs are real recordings: a roughly 30-second MEVA stairwell segment from a security-training facility, and a 13.28-second InspecSafe infrared inspection clip. OCR reads the thermal camera's original maximum-temperature overlay, approximately 31.1–34.3℃, against a demonstration limit of 33℃. The hotspot includes a person: this is neither equipment-overheat diagnosis nor temperature measurement from image colours. MEVA participants are not being labelled as actual trespassers. RTSP supplies the player; the vision worker decodes the same local MP4 separately, so evidence corresponds to the inferred frame rather than the player's current frame.

Real inference generates count observations and intrusion/OCR events. Unknown or unusable frames do not mean recovery, and recovery remains separate from human resolution. Missing or corrupt models fail startup. For an existing Server, configure `.env.demo.example` and use `bash start.sh --external`; only a dedicated demo site is created. The media revision check prevents older demo rules from being silently reused with different recordings. Preserve the old installation and start a separate Compose project and environment file. Source attribution is in `DEMO_SOURCES.md`, asset hashes and transformations in `media/manifest.json`, and model licences beside `models.lock.json`; see [the media guide](demo-media.md) for scene limitations.
