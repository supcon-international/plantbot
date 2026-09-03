# 部署运维（云服务器 · 子路径 serve）

当前生产实例：**https://m3rcyzzz.club/robots** — Ubuntu 云主机，nginx 子路径反代，Cloudflare named tunnel 出公网（源站只监听回环，机器本身不暴露端口）。

**源码部署运行要求：Node ≥ 22.22**（react-router 8 / vite 8 的下限；平台用内建 `node:sqlite`，零原生依赖）。推荐 Node 24 LTS。Docker 部署不要求宿主机安装 Node。

## Docker 完整演示（一键部署）

这是给客户看完整功能的部署方式，不是只启动 Web + Server 的 `dev:core`。它会启动：

- `gateway`：生产构建后的 Web + nginx，唯一映射到宿主机的容器；
- `api`：平台服务和 SQLite 演示数据；
- `relay`：go2rtc，把 RTSP 转成浏览器可播放的视频；
- `bench`：三家厂商协议模拟器 + 5 个 adapter，共注册 6 台机器人。

服务器需安装 Git、Docker Engine 与 Docker Compose 2.17+，并具备两个私有仓库的读取权限。
为了避免首次构建转码视频时 OOM，
建议至少准备 4 vCPU、8 GB 内存和 10 GB 可用磁盘。在 Plantbot 仓库执行：

```bash
./scripts/demo-up.sh
```

脚本会自动完成以下工作：

1. 若兄弟目录没有 `plantbotsimulator`，自动从 GitHub 克隆并校验已验收的 commit `dc32eea`（私有仓库须先给服务器配置 HTTPS token，或通过 `PLANTBOT_SIM_URL` 使用 SSH deploy key）；
2. 首次创建权限为 600 的 `.env.demo`，生成随机登录密码、会话密钥和三把场站 key；
3. 构建 Linux 镜像并下载演示素材；
4. 等到平台、SPA、媒体中继、代表 RTSP 实际出帧、3 个场站及 `1 + 1 + 4` 台机器人全部健康后，再用真实登录会话验证 X30 热成像流完成 MSE 协商并收到媒体数据才返回。

第一次构建需要下载和转码演示视频，通常会比后续启动慢。完成后脚本会打印入口和
`operator` / `viewer` 密码。默认入口：

```text
http://127.0.0.1:18080/robots/
```

默认只绑定回环地址，推荐让现有 nginx 或 Cloudflare tunnel 转发到
`http://127.0.0.1:18080`，由外层负责域名和 HTTPS。确实需要临时直连服务器端口时，先把
`.env.demo` 的 `PLANTBOT_BIND` 改为 `0.0.0.0`，并限制云防火墙来源；不要长期裸露 HTTP。
若服务器已有网段与默认的 `172.30.250.0/24` 冲突，在 `.env.demo` 同时设置不冲突的
`PLANTBOT_SUBNET`、该网段的 `PLANTBOT_NETWORK_GATEWAY`、容器地址 `PLANTBOT_GATEWAY_IP`，
并把后两者用逗号写入 `PLANTBOT_TRUSTED_PROXIES`。

外层 nginx 可直接使用下面这段。`proxy_pass` 末尾不能加 `/`，否则 `/robots` 前缀会被剥掉；
WebSocket 的 Upgrade 头也必须透传，否则实时状态和视频不可用。

```nginx
location = /robots {
    return 302 /robots/;
}

location ^~ /robots/ {
    proxy_pass http://127.0.0.1:18080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

给客户使用 `viewer`；需要现场派任务的人使用 `operator`；`admin` 能改用户、场站、规则和
连接器，不应外发。匿名访问已关闭。所有运行数据保存在 Docker volume
`plantbot-demo_plantbot-data`，重启容器不会丢失。
`.env.demo` 与这个 volume 必须一起保留；若凭证文件丢失，脚本会拒绝在旧数据上生成一套新
凭证，避免旧场站 key 悄悄继续有效。此时应优先从备份恢复 `.env.demo`；若已确认要清库，
先在 Docker 中停止并删除 `plantbot-demo` 项目的容器，再核对名称后只删除
`plantbot-demo_plantbot-data` 这个 volume，然后重新运行脚本。

这里的“完整演示”指三厂商机器人接入、实时视频、遥测、事件、任务、排程、地图和控制等
模拟巡检业务链路，不包含 OIDC 身份源和跨域 iframe 的现场配置。`viewer` 也不会看到建站、
用户和连接器管理页；客户确需评估这些管理功能时，只在可随时重置的演示实例临时提供
`admin`，演示后执行下方的完整重置（数据和凭证）。跨域嵌入与 SSO 应按客户域名、IdP 和角色映射另做联调。

常用运维命令：

```bash
# 查看状态
docker compose -p plantbot-demo --env-file .env.demo -f compose.demo.yaml ps

# 跟踪平台和模拟器日志
docker compose -p plantbot-demo --env-file .env.demo -f compose.demo.yaml logs -f api bench relay

# 停止（保留数据库）
docker compose -p plantbot-demo --env-file .env.demo -f compose.demo.yaml down

# 拉取代码后更新并重新验收
git pull && ./scripts/demo-up.sh
```

只有在明确要清空所有演示任务、事件和配置时才执行下面的命令；`-v` 会永久删除该演示栈的
SQLite volume，但会保留原账号密码与会话签名密钥：

```bash
docker compose -p plantbot-demo --env-file .env.demo -f compose.demo.yaml down -v
./scripts/demo-up.sh
```

若曾把 `admin` 发给客户，必须同时轮换凭证，不能只清数据库。下面的完整重置会让旧密码和旧
登录 Cookie 一并失效；`.env.demo` 删除后无法恢复其中的旧场站 key：

```bash
docker compose -p plantbot-demo --env-file .env.demo -f compose.demo.yaml down -v
rm -- .env.demo
./scripts/demo-up.sh
```

若 simulator 仓库不在默认兄弟目录，启动时传绝对路径：

```bash
PLANTBOT_SIM_DIR=/opt/plantbotsimulator ./scripts/demo-up.sh
```

若使用私有 fork，也可以指定 Git URL：

```bash
PLANTBOT_SIM_URL=git@github.com:your-org/plantbotsimulator.git ./scripts/demo-up.sh
```

新版本联调通过后，可用 `PLANTBOT_SIM_REF=<commit-or-tag>` 覆盖默认的 simulator 版本。已有
`PLANTBOT_SIM_DIR` 不会被脚本更新或切换分支，避免覆盖本地改动。

## 源码部署拓扑（现有生产实例）

下面的 `127.0.0.1:8888` 是现有 systemd + 宿主 nginx 部署，不适用于上面的 Docker
演示栈；Docker 演示默认入口是 `127.0.0.1:18080`。

```
浏览器 ──► Cloudflare edge ──► cloudflared tunnel ──► nginx 127.0.0.1:8888
                                                        ├─ /robots/           → alias web/dist（SPA + try_files 回退 index.html）
                                                        ├─ /robots/assets/    → alias web/dist/assets（7d 缓存）
                                                        ├─ /robots/api/       → proxy 127.0.0.1:8787/api/   （剥 /robots 前缀）
                                                        ├─ /robots/ws         → proxy 127.0.0.1:8787/ws     （WS upgrade 头，?site= 查询串透传）
                                                        ├─ /robots/media/     → proxy 127.0.0.1:8787/media/ （Range 透传，CF 边缘可缓存）
                                                        └─ /robots/stream/api/ws → proxy 127.0.0.1:1984/api/ws（仅开放 go2rtc 播放 WS）
plantbot.service (systemd) ──► node tsx server/src/index.ts @ 127.0.0.1:8787
go2rtc.service（可选）      ──► go2rtc @ 127.0.0.1:1984（RTSP 中继;平台经其 REST API 注册流）
```

## 持久层（SQLite）

一切持久状态在 **`server/data/plantbot.db`**（node:sqlite, WAL）：用户/API key(哈希)/场站建模
（航点/区域/摄像头/变换/底图元数据）/外部机器人注册/规则/路线模板/排程/任务历史/事件流/订单/审计/读数(7 天滚动)。
旧部署的 `config.json` 在首次启动时自动导入并改名 `config.json.imported`。

- **备份**：cron 每日 `sqlite3 server/data/plantbot.db ".backup '/backup/plantbot-$(date +%F).db'"`（或直接拷 db+wal）。
- 重启不再丢任务/事件/规则。进行中 run 的恢复语义：已被 adapter 拉走但未完结的订单（acked）在启动时**重置回队列重新派发**（巡检任务幂等，机器人若从未停下会重跑一轮）；订单彻底丢失的孤儿 run 直接标 failed；执行中卡死的 run 由 6h 看门狗兜底。
- 保留策略内建：读数 7d、完结订单 7d、事件 90d、完结任务 90d、命令审计 30d。

## systemd

`/etc/systemd/system/plantbot.service`（要点）：

```ini
[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/plantbot/server
# pnpm 的 .bin/tsx 是 sh shim，必须指向真实 JS 入口：
ExecStart=/usr/bin/node /home/ubuntu/plantbot/server/node_modules/tsx/dist/cli.mjs src/index.ts
Environment=API_PORT=8787
Environment=API_HOST=127.0.0.1        # 只绑回环，靠 nginx/tunnel 出去
Environment=PUBLIC_BASE=/robots       # 下发给客户端的 URL 前缀
Environment=PB_TRUST_PROXY=127.0.0.1  # 只信任同机 nginx，登录限速才能按访客 IP 隔离
# —— 生产开关 ——
# PB_DEMO 不设 = 无演示血浆：不导入演示场站、不跑随机事件生成器（事件只来自集成上报+阈值检测器）
# Environment=PB_DEMO=1               # 仅演示实例开
Environment=PB_PUBLIC_VIEW=0          # 关匿名浏览：所有页面登录后可见（公开 demo 才设 1/不设）
# Environment=MEDIA_RELAY=http://127.0.0.1:1984   # 接真 RTSP 摄像头/机器人流时指向 go2rtc
# —— 被集成 / iframe 嵌入 ——
# Environment=OIDC_ISSUER=https://idp.example.com  # + OIDC_CLIENT_ID(/SECRET) 即启用 SSO 登录
# Environment=PB_COOKIE_SAMESITE=none              # 跨站 iframe 需要(强制 Secure,须 HTTPS)
Restart=on-failure
```

秘密不进单元文件，放 drop-in `/etc/systemd/system/plantbot.service.d/auth.conf`：
`SESSION_SECRET`（会话 HMAC，缺省则每次重启随机=会话失效）、`PB_ADMIN_PASSWORD` 等账户轮换。生产凭证记录在服务器 `/home/ubuntu/plantbot-credentials.txt`（chmod 600，不入库）。

辅助：`plantbot-snap-gc.timer` 每小时清理 24h 前的事件快照 JPG（平台自身也会在超过 600 张时滚动清理）。

## 视频面（RTSP → go2rtc）

生产视频源是 **RTSP**（Site Builder 里给固定摄像头填 rtsp:// 地址；机器人流由 adapter 在 factsheet 里发布 rtsp:// URL）。链路：

1. go2rtc 单二进制，systemd 拉起（监听 127.0.0.1:1984，无需配置文件——平台会经 `PUT /api/streams` 注册源）。**开发环境无需手动装**：`pnpm run setup` 已把 go2rtc 下进 `bin/`，`pnpm dev` 经 `scripts/relay.mjs` 自动拉起并把 `MEDIA_RELAY` 指向它。生产用系统包或同一 `bin/go2rtc` 挂 systemd unit 即可。
2. plantbot 环境加 `MEDIA_RELAY=http://127.0.0.1:1984`。
3. nginx 只反代精确播放路径，并用平台会话先鉴权；不要把 go2rtc 的 `/api/streams`、
   `/api/config` 等管理接口暴露到公网。`map` 放在 nginx 的 `http` 块，`location` 放在
   Plantbot 的 `server` 块：

```nginx
map $arg_src $valid_plantbot_relay {
    default 0;
    ~^[A-Za-z0-9_-]+$ 1;
}

location = /_plantbot_session_auth {
    internal;
    proxy_pass http://127.0.0.1:8787/api/sites;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Cookie $http_cookie;
}

location = /robots/stream/api/ws {
    if ($valid_plantbot_relay = 0) { return 400; }
    auth_request /_plantbot_session_auth;
    proxy_pass http://127.0.0.1:1984/api/ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
    proxy_buffering off;
}

location ^~ /robots/stream/ { return 404; }
```
4. 浏览器播放走 `<BASE>/stream/api/ws?src=<site>-<streamKey>`（MSE，前端自动）；事件/任务快照由平台 ffmpeg 直抓 RTSP（`-rtsp_transport tcp -timeout`，死源快速失败不挂起），不经中继。

`MEDIA_RELAY` 已配但 go2rtc 未起/URL 错时：平台每 15s 探测 `<relay>/api`，探测失败则 `GET /api/health` 的 `relayOnline` 与会话的 `relayOnline` 都为 false，LIVE 页如实显示 RELAY OFFLINE（不会对着黑屏假装在线）；快照功能不受影响；demo 本地环路照常直放。`relayOnline` 只在 go2rtc 真实应答且流注册成功时为 true。

## 建站交付流程（交付工程师）

1. 管理员登录 → SITES → NEW SITE（名称即 id slug）。
2. Site Builder：MAP 上传 SLAM 占据栅格 PNG（分辨率/原点按 ROS map.yaml 换算,内建两点比例尺测量）→ FIT BOUNDS。
3. +WP 点选放航点（一个设为 DOCK）、+ZONE 画区域、CAMS 填 RTSP 摄像头 → SAVE（实时生效）。临时补一路固定摄像头也可以直接在 LIVE 页 ADD CAMERA。
4. CALIB 标定厂商坐标系（如 GoRobot 激光图 px→米）：取 ≥2 组对应点求解,保存 Transform,一键复制 adapter 环境变量。
5. 接机器人,二选一：
   - **托管连接器**（平台可直连机器人网络时的首选）：INTEG → MANAGED CONNECTORS → 选厂商填机器人地址/凭证/dock 坐标/相机 rtsp:// → 创建即接入。平台代跑 adapter 子进程（崩溃退避重启、日志面板可查、重启平台自动恢复）,无需手工密钥。
   - **外部 adapter**（跨网/自有运行时/内置三型号之外）：INTEG 签发场站 API key（**明文只显示一次**,库里存哈希）→ 填进 adapter 的 `PLANTBOT_KEY`,起 adapter（见下节）。SDK 有 TypeScript 与 Node-RED 两种形态（`sdk/`,见 docs/integration.md）。
6. 机器人自动注册出现在机队。

### 集成层（adapter × 五；simulator 在独立仓库 plantbotsimulator）

机器人经 `integrations/` 的五个 **adapter** 进程接入——plant-07 = SPOT·A、
plant-12 = X30·HB、campus-east = SPOT·CE + X30·CE + GS·F2×2（gosuncn 一对驱动两台）。
演示环境 sim+adapter 都跑；接真机时只部署 adapter。生产采用**单编排器 unit**
`plantbot-integrations.service`：`ExecStart` 跑一个仓库外的 `plantbot-run-integrations.mjs`
（进程表与 `integrations/scripts/dev-all.mjs` 逐进程一致,崩溃 2s 重生,日志带前缀进同一 journal;
密钥/流前缀经 `EnvironmentFile=/home/ubuntu/plantbot-integrations.env` 注入,不硬编码）。
需要按对拆 unit 时模式同 plantbot.service（`WorkingDirectory` 指 `integrations/`,`ExecStart` 指
`node node_modules/tsx/dist/cli.mjs <vendor>/{sim,adapter}/main.ts`）。多实例经 profile 选身份：
spot 传 `SPOT_PROFILE=plant07|campus`（sim 另配 `SPOT_SERIAL/SPOT_NICK/SPOT_SIM_HOME_*/SPOT_SIM_DOCK_*`），
deeprobotics 传 `DR_PROFILE=plant12|campus`（sim 另配 `DR_SIM_HOME_*`，须与 profile 的 dock 同点），
端口与坐标以 `integrations/scripts/dev-all.mjs` 为准。关键环境变量：

```ini
# 平台侧（plantbot.service drop-in）——播种适配器秘钥，与各 adapter 的 PLANTBOT_KEY 一致：
Environment=PB_SEED_KEYS=plant-07=pbk_xxx,plant-12=pbk_yyy,campus-east=pbk_zzz
# 各 adapter：
Environment=PLANTBOT_BASE=http://127.0.0.1:8787
Environment=PLANTBOT_KEY=pbk_xxx
Environment=STREAM_BASE=/robots/media      # 子路径部署时注册流地址的前缀（本地默认 /media;接真机发布 rtsp:// URL）
```

真实秘钥值同样记录在 `/home/ubuntu/plantbot-credentials.txt`，不入库。sim 侧无秘密（本地回环监听）。
掉线语义：adapter 停止 = 机器人 20s 后显示 OFFLINE（注册与场站数据都在 SQLite,重启平台仍在场）。

清库重播种的正确顺序：**先 stop 平台再删 `plantbot.db`（连同 `-wal`/`-shm`）**,然后 start 平台（PB_DEMO 实例会重新导入演示种子）→ start 集成层（adapter 启动时注册,平台必须已就绪）。SQLite 是同步写穿,不再有 config.json 时代的 2s 延迟落盘问题,但删库仍必须在平台停止后进行。

## 更新流程（在服务器上）

```bash
cd /home/ubuntu/plantbot && git pull
pnpm install                      # 仅依赖变更时
pnpm run setup                    # 仅新增媒体素材时（幂等）
WEB_BASE=/robots/ pnpm build      # 前端：nginx 直接吃 dist，无需重启
sudo systemctl restart plantbot   # 服务端变更时（任务/事件/规则等已持久,重启即恢复）
```

缓存行为：打包产物带 hash（改名即新 URL，无需 purge）；`index.html` no-cache（构建即生效）；`/robots/media/*.mp4` 会被 Cloudflare 边缘缓存（省源站流量）。素材环路按出口带宽预算激进编码（setup.mjs 的 `VF`/`ENC`：640w·12fps·CRF30·≤450kbps）——**调整编码参数后同名 mp4 需 purge Cloudflare 边缘**,否则访客继续拿旧缓存。改了**同名**静态文件（如 URDF 网格）才需要 CF purge 或换文件名。

## 陷阱备忘（都踩过）

- **子路径是第一约束**：web 用 `BASE`、server 下发 URL 用 `PUB`，见 CLAUDE.md。本地根路径开发一切正常≠线上正常。
- 现有源码部署的 tunnel 源站必须 `http://localhost:8888`；Docker 演示则指向
  `http://localhost:18080`（https 打纯 HTTP nginx 会 502 TLS 握手错）。
- `pnpm setup` 被 pnpm 10 内置命令遮蔽，必须 `pnpm run setup`。
- nginx 的 `/robots/` 各 location 必须用 `^~` 前缀匹配，否则站点其他正则 location（`.mp4`/`.html` 缓存规则）会截胡。
- `server/data/`（SQLite + 上传地图）与 `server/media/`（素材）永不入库；`plantbot.db` 记得进备份。
- API key 明文只在创建响应出现一次;丢了就吊销重签（库里只有哈希,找不回）。
- 摄像头 rtsp:// 地址内嵌凭证,平台**只对该站 admin 回传明文**（Site Builder 编辑用）;
  viewer/匿名的 fleet/channels/WS 载荷一律剥掉 URL（播放走会话租约,快照走服务端 ffmpeg,都不需要它）。
- CORS 已整体移除:一切同源（dev 走 vite 代理,生产走 nginx）。跨域调用只有 Bearer 的集成 API。
- **iframe 嵌入**:宿主页 `<iframe src=…/live?embed=1&site=…>`;平台侧 `PB_COOKIE_SAMESITE=none` + HTTPS,
  nginx 对 `/robots/` location 加 `add_header Content-Security-Policy "frame-ancestors 'self' https://宿主域";`
  (不设则任何站点都能嵌)。SSO 建议由宿主在顶层窗口完成(IdP 普遍拒绝被 iframe),iframe 内即已带会话。
