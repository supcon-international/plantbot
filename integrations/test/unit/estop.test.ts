// Spot estop 挑战应答单测：uint64 按位取反（BigInt，满 64 位）。
// 纯函数抽在 spot/estop.ts（loader.ts 顶层 loadSync 有副作用，不宜直接导入）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estopResponse, U64_MASK } from '../../spot/estop.js'

test('estopResponse: ~challenge & (2^64-1)', () => {
  assert.equal(estopResponse('0'), '18446744073709551615', '~0 = 全 1')
  assert.equal(estopResponse(0), '18446744073709551615')
  assert.equal(estopResponse(1), '18446744073709551614', '~1 = 2^64-2')
  assert.equal(estopResponse(U64_MASK.toString()), '0', '~(2^64-1) = 0')
})

test('estopResponse: 满 64 位挑战 + 双取反复原', () => {
  const challenge = '12345678901234567890' // > 2^53，必须 BigInt 才不失真
  const resp = estopResponse(challenge)
  assert.equal(estopResponse(resp), challenge, '双取反回到原值')
  // 结果始终落在 [0, 2^64)
  assert.ok(BigInt(resp) >= 0n && BigInt(resp) <= U64_MASK)
})

test('estopResponse: 接受 number/string/bigint 三种入参', () => {
  assert.equal(estopResponse(255), estopResponse('255'))
  assert.equal(estopResponse(255n), estopResponse('255'))
})
