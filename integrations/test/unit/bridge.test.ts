// shared/bridge 纯函数单测：worldTransformFromEnv（厂商 SLAM 系→世界系相似变换）
// 正反变换互逆 + 未设时为恒等 + makeBackoff 退避档位。
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { worldTransformFromEnv, makeBackoff } from '../../shared/bridge.js'

const TF_KEYS = ['PB_TF_SCALE', 'PB_TF_THETA', 'PB_TF_TX', 'PB_TF_TZ'] as const
const clearTf = () => TF_KEYS.forEach((k) => delete process.env[k])
afterEach(clearTf)

test('worldTransformFromEnv: 未设 → 恒等', () => {
  clearTf()
  const tf = worldTransformFromEnv()
  assert.deepEqual(tf.fwd(5, 7), { x: 5, z: 7 })
  assert.deepEqual(tf.inv(5, 7), { x: 5, z: 7 })
})

test('worldTransformFromEnv: fwd/inv 互逆（scale+rot+translate）', () => {
  process.env.PB_TF_SCALE = '1.4'
  process.env.PB_TF_THETA = '0.6'
  process.env.PB_TF_TX = '3'
  process.env.PB_TF_TZ = '-2'
  const tf = worldTransformFromEnv()
  for (const [x, z] of [[1, 2], [-3, 4], [0, 0], [10.5, -7.25]]) {
    const w = tf.fwd(x, z)
    const p = tf.inv(w.x, w.z)
    assert.ok(Math.abs(p.x - x) < 1e-9, `inv∘fwd x (${x},${z})`)
    assert.ok(Math.abs(p.z - z) < 1e-9, `inv∘fwd z (${x},${z})`)
  }
})

test('worldTransformFromEnv: 纯平移的已知值', () => {
  process.env.PB_TF_TX = '3'
  process.env.PB_TF_TZ = '-2'
  const tf = worldTransformFromEnv()
  assert.deepEqual(tf.fwd(1, 1), { x: 4, z: -1 })
  assert.deepEqual(tf.inv(4, -1), { x: 1, z: 1 })
})

test('makeBackoff: 指数增长、封顶、changed 档位、reset', () => {
  const b = makeBackoff({ startMs: 1000, capMs: 8000, factor: 2 })
  assert.deepEqual(b.next(), { delay: 1000, changed: true })
  assert.deepEqual(b.next(), { delay: 2000, changed: true })
  assert.deepEqual(b.next(), { delay: 4000, changed: true })
  assert.deepEqual(b.next(), { delay: 8000, changed: true })
  assert.deepEqual(b.next(), { delay: 8000, changed: false }, '封顶后不再变 → 不打日志')
  b.reset()
  assert.deepEqual(b.next(), { delay: 1000, changed: true }, 'reset 回起点')
})
