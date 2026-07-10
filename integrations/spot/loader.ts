// 官方 bosdyn proto 闭包加载（sim 与 adapter 共用）。
// 选项依据 docs/vendors/spot-sdk.md §8：keepCase（snake_case 字段）、longs:String
// （estop challenge 是满 64 位，BigInt(string) 处理）、oneofs（判活分支虚拟字段）、
// enums 不转字符串（allow_alias 反查歧义 → 全部用数字比较）。

import { loadSync } from '@grpc/proto-loader'
import grpc from '@grpc/grpc-js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROTOS = join(dirname(fileURLToPath(import.meta.url)), 'protos')

const SERVICE_PROTOS = [
  'bosdyn/api/robot_id_service.proto',
  'bosdyn/api/directory_service.proto',
  'bosdyn/api/auth_service.proto',
  'bosdyn/api/time_sync_service.proto',
  'bosdyn/api/lease_service.proto',
  'bosdyn/api/estop_service.proto',
  'bosdyn/api/power_service.proto',
  'bosdyn/api/robot_state_service.proto',
  'bosdyn/api/robot_command_service.proto',
  'bosdyn/api/image_service.proto',
  'bosdyn/api/graph_nav/graph_nav_service.proto',
]

const def = loadSync(SERVICE_PROTOS, {
  keepCase: true,
  longs: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTOS],
})

export const pkg = grpc.loadPackageDefinition(def) as any
export const api = pkg.bosdyn.api
export const graphNav = pkg.bosdyn.api.graph_nav

export const ts = (ms = Date.now()) => ({ seconds: String(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1e6 })
export const tsToMs = (t?: { seconds?: string | number; nanos?: number }) =>
  t ? Number(t.seconds ?? 0) * 1000 + Math.round((t.nanos ?? 0) / 1e6) : 0

export const U64_MASK = 0xffffffffffffffffn
/** estop 挑战应答：uint64 按位取反（py: ctypes.c_ulonglong(~challenge).value） */
export const estopResponse = (challenge: string | number | bigint) =>
  ((~BigInt(challenge)) & U64_MASK).toString()

/** 通用 ResponseHeader（CommonError CODE_OK=1） */
export const okHeader = (reqHeader?: unknown) => ({
  request_header: reqHeader ?? {},
  request_received_timestamp: ts(),
  response_timestamp: ts(),
  error: { code: 1, message: '' },
})

export const yawToQuat = (yaw: number) => ({ w: Math.cos(yaw / 2), x: 0, y: 0, z: Math.sin(yaw / 2) })
export const quatToYaw = (q?: { w?: number; z?: number; x?: number; y?: number }) =>
  q ? Math.atan2(2 * ((q.w ?? 0) * (q.z ?? 0) + (q.x ?? 0) * (q.y ?? 0)), 1 - 2 * ((q.y ?? 0) ** 2 + (q.z ?? 0) ** 2)) : 0
