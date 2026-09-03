// 云深处线协议纯函数单测（node:test + tsx）。覆盖：帧编解码（多帧/半帧/坏同步字）、
// num() 负指数、buildNavTaskReq/parseNavTaskReq 往返（含科学计数法坐标）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SYNC, TYPE, encodeFrame, FrameParser, num, defaultNavPoint,
  buildNavTaskReq, parseNavTaskReq, buildRealtimeReq,
} from '../../deeprobotics/protocol.js'

test('encodeFrame: EB90 头 + 字节长度 + 序列号回填', () => {
  const xml = buildRealtimeReq()
  const buf = encodeFrame(0x1234, xml)
  assert.ok(buf.subarray(0, 4).equals(SYNC), 'sync word EB90EB90')
  assert.equal(buf.readUInt16LE(4), Buffer.byteLength(xml, 'utf8'), 'length = UTF-8 byte count')
  assert.equal(buf.readUInt16LE(6), 0x1234, 'seq filled')
  assert.equal(buf.subarray(16).toString('utf8'), xml, 'body round-trips')
})

test('FrameParser: 单帧解出 seq/type/body', () => {
  const xml = buildNavTaskReq([defaultNavPoint(1, 1.5, -2.5, 0.3)])
  const frames = new FrameParser().push(encodeFrame(7, xml))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].seq, 7)
  assert.equal(frames[0].type, TYPE.NAV_TASK)
  assert.equal(frames[0].body, xml)
})

test('FrameParser: 一次 push 两帧全部解出', () => {
  const a = encodeFrame(1, buildRealtimeReq())
  const b = encodeFrame(2, buildNavTaskReq([defaultNavPoint(1, 0, 0)]))
  const frames = new FrameParser().push(Buffer.concat([a, b]))
  assert.equal(frames.length, 2)
  assert.deepEqual(frames.map((f) => f.seq), [1, 2])
  assert.deepEqual(frames.map((f) => f.type), [TYPE.REALTIME, TYPE.NAV_TASK])
})

test('FrameParser: 半帧缓冲——补齐后才吐帧', () => {
  const full = encodeFrame(9, buildRealtimeReq())
  const p = new FrameParser()
  assert.equal(p.push(full.subarray(0, 10)).length, 0, '不足一帧头 → 不吐')
  assert.equal(p.push(full.subarray(10, 20)).length, 0, '头齐 body 未齐 → 不吐')
  const out = p.push(full.subarray(20))
  assert.equal(out.length, 1, '补齐 → 吐一帧')
  assert.equal(out[0].seq, 9)
})

test('FrameParser: 坏同步字——丢字节重新对齐，不卡死', () => {
  const good = encodeFrame(5, buildRealtimeReq())
  const dirty = Buffer.concat([Buffer.from([0x00, 0x11, 0x22]), good])
  const frames = new FrameParser().push(dirty)
  assert.equal(frames.length, 1, '跳过前导垃圾，仍解出后续有效帧')
  assert.equal(frames[0].seq, 5)
})

test('num(): 科学计数法含负指数（旧正则的 bug）', () => {
  assert.equal(num('<S>1.5e-3</S>', 'S'), 0.0015)
  assert.equal(num('<S>-1.5e-3</S>', 'S'), -0.0015)
  assert.equal(num('<S>-2E+4</S>', 'S'), -20000)
  assert.equal(num('<S> 42 </S>', 'S'), 42, 'trims whitespace')
  assert.equal(num('<S>abc</S>', 'S'), 0, 'non-numeric → 0')
  assert.equal(num('<S></S>', 'S'), 0, 'empty → 0')
  assert.equal(num('<Nope>1</Nope>', 'S'), 0, 'missing tag → 0')
})

test('buildNavTaskReq/parseNavTaskReq: 多点往返（含指数坐标）', () => {
  // 1.5e-7 的量级会被 JS 以指数字符串序列化 → 正好压测 num 的指数解析
  const pts = [
    defaultNavPoint(1, 1.5e-7, -3.2e-7, 0.25),
    defaultNavPoint(2, -12.5, 8.0, -1.57),
  ]
  const parsed = parseNavTaskReq(buildNavTaskReq(pts))
  assert.equal(parsed.length, 2)
  for (let i = 0; i < pts.length; i++) {
    assert.ok(Math.abs(parsed[i].PosX - pts[i].PosX) < 1e-12, `PosX[${i}]`)
    assert.ok(Math.abs(parsed[i].PosY - pts[i].PosY) < 1e-12, `PosY[${i}]`)
    assert.ok(Math.abs(parsed[i].AngleYaw - pts[i].AngleYaw) < 1e-9, `AngleYaw[${i}]`)
    assert.equal(parsed[i].Value, pts[i].Value, `Value[${i}]`)
    assert.equal(parsed[i].NavMode, pts[i].NavMode, `NavMode[${i}]`)
  }
})
