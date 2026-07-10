# Boston Dynamics Spot API — vendored `.proto` closure

这些是 Boston Dynamics `spot-sdk` 官方 gRPC 接口定义文件（`.proto`），原样下载、未做任何修改，供
Plantbot 的 Spot 集成（`integrations/spot/` 下的 simulator + adaptor）用 `@grpc/proto-loader` 加载。

## 来源

- 仓库：<https://github.com/boston-dynamics/spot-sdk>
- 分支：`master`
- 原始路径：`protos/bosdyn/api/**`（本目录完整保留了 `bosdyn/api/...` 目录结构，proto 里的
  `import "bosdyn/api/xxx.proto"` 才能被解析）
- 下载方式：`https://raw.githubusercontent.com/boston-dynamics/spot-sdk/master/protos/<path>`
- 下载时间：2026-07-10

## 闭包范围（59 个文件）

以 Plantbot 需要的 service 为种子（auth / robot_id / directory / time_sync / lease / estop / power /
robot_state / robot_command / image / graph_nav），沿 `import` 图递归下载至闭包完整。即：**每一个
`import "bosdyn/api/..."` 引用的文件都在本目录内**（已用脚本校验，见下）。

**未下载**的 import 只有 6 个 `google/protobuf/*` 标准类型，`@grpc/proto-loader` 自带、无需 vendoring：

```
google/protobuf/any.proto        duration.proto     field_mask.proto
google/protobuf/struct.proto     timestamp.proto    wrappers.proto
```

## 用 proto-loader 加载

`includeDirs` 指向本目录，入口 proto 用相对路径（例如同时加载多个 service）：

```ts
import * as protoLoader from '@grpc/proto-loader'
import * as grpc from '@grpc/grpc-js'

const pkgDef = protoLoader.loadSync(
  [
    'bosdyn/api/auth_service.proto',
    'bosdyn/api/robot_id_service.proto',
    'bosdyn/api/directory_service.proto',
    'bosdyn/api/time_sync_service.proto',
    'bosdyn/api/lease_service.proto',
    'bosdyn/api/estop_service.proto',
    'bosdyn/api/power_service.proto',
    'bosdyn/api/robot_state_service.proto',
    'bosdyn/api/robot_command_service.proto',
    'bosdyn/api/image_service.proto',
    'bosdyn/api/graph_nav/graph_nav_service.proto',
  ],
  {
    includeDirs: [__dirname], // = integrations/spot/protos
    keepCase: true, // 必须：保留 snake_case 字段名，与 proto 原文一致
    longs: String, // uint64（如 estop challenge）→ 字符串，避免精度丢失
    enums: Number, // 见 spot-sdk.md「Node 实现坑」——enum allow_alias
    defaults: true,
    oneofs: true, // 给 oneof 增加虚拟字段，便于判断激活分支
  },
)
const bosdyn = (grpc.loadPackageDefinition(pkgDef) as any).bosdyn.api
```

字段级协议参考、会话时序、以及 proto-loader 的坑，见 `docs/vendors/spot-sdk.md`。

## 许可

这些文件受 **Boston Dynamics Software Development Kit License（20191101-BDSDK-SL）** 约束，
不是本项目的开源许可覆盖范围。完整许可文本见同目录 [`LICENSE`](./LICENSE)（同样从 spot-sdk 仓库根
下载）。每个 `.proto` 文件头部亦带有该许可声明。仅作接口对接用途保留，随上游更新请重新下载。
