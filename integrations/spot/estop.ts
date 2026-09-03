// Spot estop challenge/response — a pure, side-effect-free module so it can be
// unit-tested without loading the gRPC proto closure (loader.ts runs loadSync at
// import time). loader.ts re-exports these so existing imports keep working and
// there is a single source of truth.

export const U64_MASK = 0xffffffffffffffffn

/** estop 挑战应答：uint64 按位取反（官方 py：ctypes.c_ulonglong(~challenge).value）。
 *  challenge 是满 64 位整数（proto 以 longs:String 交付），故用 BigInt 运算后取模 2^64。 */
export const estopResponse = (challenge: string | number | bigint): string =>
  ((~BigInt(challenge)) & U64_MASK).toString()
