# Plantbot release deployment / 版本部署

## 中文

v2.4.0 起分别提供 **Server** 和 **Adapter** 两个预构建包。安装需要 Docker Engine 与 Docker Compose 2.17+，不需要 Node、Python、源码构建或运行时下载模型。当前发布 Linux x86-64 包；请选择经过发布验证的体系架构。

- **Server**：Web、平台 API、SQLite、视频中继。可部署在云端或现场服务器。
- **Adapter**：机器人厂商驱动与 11 项视觉预置能力，包含预训练模型。部署在能访问机器人/摄像头的网络中，通过场站 API key 连接 Server。驱动和视觉是独立进程与容器，分别重启；启动时读取私有配置后以 UID 1000 运行；视觉默认限制为 2 CPU / 2 GiB。

建议 Server 配置 2 vCPU / 4 GiB，Adapter 从 4 vCPU / 4 GiB 开始，并根据路数和实测采样间隔调整资源。安装两包需预留至少 10 GiB 镜像空间；录像与证据另计。新安装不生成演示机器人或随机告警。

### 安装 Server

```bash
sha256sum -c plantbot-server-v2.4.0-linux-amd64.tar.gz.sha256
tar -xzf plantbot-server-v2.4.0-linux-amd64.tar.gz
cd plantbot-server-v2.4.0-linux-amd64
bash start.sh
```

打开 `http://127.0.0.1:18080/robots/`。首次登录密码在 `.env.server`（权限 600），账户为 `admin`、`operator`、`viewer`。以管理员创建场站，在集成页面创建场站 API key，供 Adapter 使用。

默认仅绑定回环地址。远程部署通过已有 HTTPS 反向代理或 tunnel 访问；也可在 `.env.server` 设置 `PLANTBOT_BIND`、`PLANTBOT_PORT` 后重新启动。所有 URL 都保留 `/robots` 前缀。

### 安装 Adapter

```bash
sha256sum -c plantbot-adapter-v2.4.0-linux-amd64.tar.gz.sha256
tar -xzf plantbot-adapter-v2.4.0-linux-amd64.tar.gz
cd plantbot-adapter-v2.4.0-linux-amd64
cp adapter.example.json adapter.json
chmod 600 adapter.json
# 编辑 adapter.json 的 serverUrl、sources 和 devices
# 在 .env.adapter 中设置 PB_SITE_KEY=pbk_...（文件权限设为 600）
bash start.sh
```

`serverUrl` 是从 Adapter 所在主机可访问的 Server 地址，例如 `https://example.com/robots`。同机 Docker 部署可用 `http://host.docker.internal:18080/robots`，Linux 需为服务添加 `extra_hosts: ["host.docker.internal:host-gateway"]` 并使 Server 监听该接口；跨主机使用可路由地址。相机和机器人地址使用 Adapter 能直接访问的地址，不能填 Server 容器内的 `localhost`。

`devices` 配置沿用托管连接器的厂商字段，例如：

```json
{
  "vendor": "spot",
  "config": {
    "serial": "BD-91250777",
    "callsign": "Spot 1",
    "host": "192.168.1.30",
    "user": "operator",
    "pass": "device-password",
    "streams": [{"id":"front","name":"Front camera","url":"rtsp://192.168.1.30/front"}]
  }
}
```

支持 `spot`、`deeprobotics`、`gosuncn`；字段见仓库 `integrations/shared/connector-catalog.ts` 和集成文档。普通固定摄像头只需 `sources`，`devices` 可以为空。每个 Adapter 实例使用唯一 `id` 和独立数据卷。修改配置文件后重启 Adapter。仅使用机器人驱动时可运行 `docker compose --env-file .env.adapter -f compose.yaml up -d adapter`，无需启动视觉服务。

视觉配置入口在 **LIVE → 视觉巡检**。ROI、方向、持续时间与班次须按现场配置；预训练模型可以直接推理，但不能省略现场准确率验证。移动相机的 OCR 需要可信停稳反馈及对应文件挂载，详见 `VISION.md`。

### 升级与维护

保留旧版本的 `.env.server` / `.env.adapter`、`adapter.json` 和 Docker 数据卷。下载新版后复制相应配置文件，运行 `start.sh` 即使用预构建镜像升级。默认卷名分别是 `plantbot-server-data`、`plantbot-adapter-vision-data`；可用 `PB_DATA_VOLUME`、`PB_ADAPTER_VOLUME` 指定。停止服务不要使用 `down -v`。

```bash
docker compose --env-file .env.server -f compose.yaml ps
docker compose --env-file .env.server -f compose.yaml logs --tail=100
docker compose --env-file .env.server -f compose.yaml down
# Adapter 对应改为 .env.adapter
```

从 v2.3.1 演示包迁移：先停止旧 Compose 项目并备份数据卷和 `.env.demo`，将 `.env.demo` 复制为 `.env.server`，在其中设置 `PB_DATA_VOLUME=plantbot-demo_plantbot-data`（若旧项目名不同，以实际卷名为准）。数据库、用户、场站和历史记录可复用；新包不启动模拟器，机器人需重新配置 Adapter。不要同时启动两个 Server 写同一 SQLite 卷。回退应恢复升级前的卷备份和对应旧版镜像。

模型清单及 SHA-256 随 Adapter 包提供；每个包都有镜像 ID、源码提交号与文件校验清单。`start.sh` 先校验、导入本地镜像再启动，不执行构建或在线拉取。

## English

Starting with v2.4.0, releases provide separate **Server** and **Adapter** packages. Both require Docker Engine and Docker Compose 2.17+. Node, Python, source builds and runtime model downloads are unnecessary. Published packages currently target Linux x86-64.

Server contains the web application, platform API, SQLite storage and video relay. Adapter contains vendor robot drivers and eleven vision presets with pretrained models. Run Adapter on a network that can reach the devices. Its driver and vision containers read the private configuration at startup, then run as UID 1000 and restart independently; vision defaults to 2 CPUs and 2 GiB RAM. A fresh Server starts without simulated robots or generated alarms.

Verify each archive's `.sha256`, extract it, and run `bash start.sh`. Server opens at `http://127.0.0.1:18080/robots/`; initial account passwords are stored in `.env.server`. Sign in as `admin`, create a site and issue its API key. For Adapter, configure `serverUrl`, `sources` and optional `devices` in `adapter.json`, then set `PB_SITE_KEY` in `.env.adapter`. Protect both files with mode 600. `serverUrl` must be reachable from Adapter and must include the deployment prefix. Use routable device addresses, not Server's loopback address.

Configure monitoring under **LIVE → Vision inspection**. Preview the scene, adjust regions, direction, duration and UTC schedules, then enable the rule. See `VISION.md` for model provenance, stationary-view requirements, retention and test procedures. For robot-only deployments, start the `adapter` Compose service without `vision`.

For upgrades, retain environment files, `adapter.json` and data volumes, then run the new package's `start.sh`. Never use `down -v` to stop a deployment you intend to preserve. Default volume names are `plantbot-server-data` and `plantbot-adapter-vision-data`; override them with `PB_DATA_VOLUME` and `PB_ADAPTER_VOLUME`.

To migrate from the v2.3.1 demo package, stop the old deployment, back up its volume and `.env.demo`, copy that file to `.env.server`, and point `PB_DATA_VOLUME` to the actual old volume (normally `plantbot-demo_plantbot-data`). Existing records are retained. Simulators are no longer started by the release packages; configure robot adapters separately. Never run two Server instances against one SQLite volume. Rollback requires the previous image and a pre-upgrade volume backup.

Every package includes source revision, image IDs and checksums. Startup loads local images and does not build or pull them. Production HTTPS termination and device network access remain deployment responsibilities.

## Maintainers / 维护者

Commit version, changelog and source changes, then run `pnpm run release:build linux/amd64`. The command builds and exports both packages into `dist/releases`, using only committed source files. Run `node scripts/test-release-packages.mjs <server.tar.gz> <adapter.tar.gz>` to validate the extracted packages against a disposable Server, actual model inference and a native Spot simulator before publishing. The test requires the sibling `plantbotsimulator` checkout and the local vision Python environment. ARM64 build support is not a claim of a tested ARM64 release.
