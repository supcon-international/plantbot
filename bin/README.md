# bin/

本地工具二进制目录，内容不入库（`.gitignore` 只保留本说明）。

- `go2rtc`：视频中继二进制，`pnpm run setup` 从官方 release 下载并校验 sha256。
  `pnpm dev` 经 `scripts/relay.mjs` 把它起在 :1984，并给 server 设置 `MEDIA_RELAY`，
  把 RTSP 源转成浏览器可播的 MSE 流；缺失时 relay 脚本空转，RTSP 播放保持离线。
- `go2rtc.yaml`：`scripts/relay.mjs` 首次运行时生成的中继配置，可删，重启会重建。

Docker 演示不用这个目录，镜像里自带 go2rtc（见 `docker/`）。
