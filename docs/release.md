# Plantbot release deployment / 版本部署

## 中文

预构建包包含平台、Web 网关、视频中继及三厂商演示机器人。服务器只需 Docker Engine 和 Docker Compose 2.17+，无需 Node、Git、源码构建或额外下载演示素材。选择与服务器架构对应的包；`linux-amd64` 用于 Intel/AMD 64 位 Linux。建议 4 vCPU、8 GB 内存及 10 GB 可用磁盘。

下载 Release 附件后，校验并启动：

```bash
sha256sum -c plantbot-v2.3.1-linux-amd64.tar.gz.sha256
tar -xzf plantbot-v2.3.1-linux-amd64.tar.gz
cd plantbot-v2.3.1-linux-amd64
bash start.sh
```

入口为 `http://127.0.0.1:18080/robots/`。启动脚本验证文件、导入镜像、生成首次登录凭证，并检查场站、机器人、视频和登录。账户及密钥保存在 `.env.demo`（权限 600）；该文件与 Docker 数据卷需要一起保留。部署在远程服务器时，通过既有 nginx 或 Cloudflare tunnel 转发此入口。

已有 Docker 演示实例升级：将旧目录的 `.env.demo` 安全复制到新版本目录，保持原 Compose 项目名（默认 `plantbot-demo`），再运行 `bash start.sh`。原数据卷自动复用。升级前备份数据库、录像与凭证；不要执行 `down -v`。自定义项目使用 `PB_DEMO_PROJECT`，凭证文件使用 `PB_DEMO_ENV_FILE`。

```bash
# 状态 / 停止（保留数据）
docker compose -p plantbot-demo --env-file .env.demo -f compose.release.yaml ps
docker compose -p plantbot-demo --env-file .env.demo -f compose.release.yaml down
```

此包是完整演示部署，包含模拟器。真机接入仍须配置厂商适配器及现场网络。云台与机器人控制范围见 `CHANGELOG.md`。

## English

The prebuilt package includes the platform, web gateway, video relay and simulated robots from three vendors. It requires Docker Engine and Docker Compose 2.17+; Node, Git, source builds and separate media downloads are not required. Use the package matching your server architecture. `linux-amd64` targets 64-bit Intel/AMD Linux. Recommended resources: 4 vCPUs, 8 GB RAM and 10 GB free disk space.

Verify the archive checksum, extract it and run `bash start.sh` using the commands above. The application is available at `http://127.0.0.1:18080/robots/`. Startup verifies package integrity, imports images, generates initial credentials and validates sites, robots, video and authentication. For remote access, forward this endpoint through your existing nginx or Cloudflare tunnel.

Credentials are stored in `.env.demo` with mode 600. Preserve this file together with the Docker data volume. To upgrade an existing Docker demo, securely copy its `.env.demo` into the new release directory, retain the same Compose project name (default: `plantbot-demo`) and run `bash start.sh`. Existing data is retained. Back up the database, recordings and credentials before upgrading; do not use `down -v`. Custom projects and credential paths use `PB_DEMO_PROJECT` and `PB_DEMO_ENV_FILE`.

This is a complete demonstration deployment with simulators. Physical robots require vendor adapters and site network configuration. See `CHANGELOG.md` for camera and robot control availability.

## Maintainers / 维护者

Update `package.json` and `CHANGELOG.md`, commit the release changes, then run:

```bash
pnpm run release:build linux/amd64
```

The build uses committed platform files and the pinned simulator revision, exports versioned Docker images, and writes the archive and checksum to `dist/releases/`. Local databases, credentials, untracked files and macOS dependencies are excluded. Validate the extracted package before creating the corresponding GitHub tag and release.
