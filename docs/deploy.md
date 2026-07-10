# 部署运维（云服务器 · 子路径 serve）

当前生产实例：**https://m3rcyzzz.club/robots** — Ubuntu 云主机，nginx 子路径反代，Cloudflare named tunnel 出公网（源站只监听回环，机器本身不暴露端口）。

## 拓扑

```
浏览器 ──► Cloudflare edge ──► cloudflared tunnel ──► nginx 127.0.0.1:8888
                                                        ├─ /robots/           → alias web/dist（SPA + try_files 回退 index.html）
                                                        ├─ /robots/assets/    → alias web/dist/assets（7d 缓存）
                                                        ├─ /robots/api/       → proxy 127.0.0.1:8787/api/   （剥 /robots 前缀）
                                                        ├─ /robots/ws         → proxy 127.0.0.1:8787/ws     （WS upgrade 头，?site= 查询串透传）
                                                        └─ /robots/media/     → proxy 127.0.0.1:8787/media/ （Range 透传，CF 边缘可缓存）
plantbot.service (systemd) ──► node tsx server/src/index.ts @ 127.0.0.1:8787
```

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
Restart=on-failure
```

秘密不进单元文件，放 drop-in `/etc/systemd/system/plantbot.service.d/auth.conf`：
`SESSION_SECRET`（会话 HMAC，缺省则每次重启随机=会话失效）、`PB_ADMIN_PASSWORD` 等账户轮换。生产凭证记录在服务器 `/home/ubuntu/plantbot-credentials.txt`（chmod 600，不入库）。

辅助：`plantbot-snap-gc.timer` 每小时清理 24h 前的事件快照 JPG（上游只写不删，防磁盘涨满）。

### 集成层（三对 simulator/adapter，演示环境）

外部机器人（SPOT·A / X30·EXT / GS·F2×2）来自 `integrations/` 的六个独立进程。演示环境 sim+adapter 都跑；
接真机时只部署 adapter。每对一个 systemd unit（模式同 plantbot.service，`WorkingDirectory` 指 `integrations/`，
`ExecStart` 指 `node node_modules/tsx/dist/cli.mjs <vendor>/{sim,adapter}/main.ts`）。关键环境变量：

```ini
# 平台侧（plantbot.service drop-in）——播种适配器秘钥，与各 adapter 的 PLANTBOT_KEY 一致：
Environment=PB_SEED_KEYS=plant-07=pbk_xxx,plant-12=pbk_yyy,campus-east=pbk_zzz
# 各 adapter：
Environment=PLANTBOT_BASE=http://127.0.0.1:8787
Environment=PLANTBOT_KEY=pbk_xxx
Environment=STREAM_BASE=/robots/media      # 子路径部署时注册流地址的前缀（本地默认 /media）
```

真实秘钥值同样记录在 `/home/ubuntu/plantbot-credentials.txt`，不入库。sim 侧无秘密（本地回环监听）。
掉线语义：adapter 停止 = 机器人 20s 后显示 OFFLINE（注册信息在 `config.json` 持久，重启平台仍在场）。

## 更新流程（在服务器上）

```bash
cd /home/ubuntu/plantbot && git pull
pnpm install                      # 仅依赖变更时
pnpm run setup                    # 仅新增媒体素材时（幂等）
WEB_BASE=/robots/ pnpm build      # 前端：nginx 直接吃 dist，无需重启
sudo systemctl restart plantbot   # 服务端变更时（仿真状态会复位，属预期）
```

缓存行为：打包产物带 hash（改名即新 URL，无需 purge）；`index.html` no-cache（构建即生效）；`/robots/media/*.mp4` 会被 Cloudflare 边缘缓存（省源站流量）。改了**同名**静态文件（如 URDF/splat）才需要 CF purge 或换文件名。

## 陷阱备忘（都踩过）

- **子路径是第一约束**：web 用 `BASE`、server 下发 URL 用 `PUB`，见 CLAUDE.md。本地根路径开发一切正常≠线上正常。
- tunnel 源站必须 `http://localhost:8888`（https 打纯 HTTP nginx 会 502 TLS 握手错）。
- `pnpm setup` 被 pnpm 10 内置命令遮蔽，必须 `pnpm run setup`。
- nginx 的 `/robots/` 各 location 必须用 `^~` 前缀匹配，否则站点其他正则 location（`.mp4`/`.html` 缓存规则）会截胡。
- `server/data/`（运行时配置+上传地图）与 `server/media/`（素材）永不入库。
- 重启 = 仿真复位（机队/任务/事件重新播种），但 `config.json` 里的用户/API key/自定义事件类型/地图会保留。
