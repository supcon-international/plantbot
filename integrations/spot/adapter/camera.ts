/** Spot CAM mechanical PTZ uses bounded positions; its velocity RPC is not supported. */
export class SpotCamera {
  constructor(readonly name: string, readonly limits: { pan: [number, number]; tilt: [number, number]; zoom: [number, number] }, private rpc: (method: string, body: any) => Promise<any>) {}
  private check(response: any) {
    if (response.header?.error?.code !== 1) throw new Error(response.header?.error?.message || 'Spot CAM rejected the request')
    return response
  }
  async position() {
    const p = this.check(await this.rpc('GetPtzPosition', { ptz: { name: this.name } })).position
    if (!['pan', 'tilt', 'zoom'].every(k => Number.isFinite(p?.[k]?.value))) throw new Error('Spot CAM position unavailable')
    return { pan: p.pan.value, tilt: p.tilt.value, zoom: p.zoom.value }
  }
  async set(target: { pan: number; tilt: number; zoom: number }) {
    for (const axis of ['pan', 'tilt', 'zoom'] as const) {
      if (!Number.isFinite(target[axis]) || target[axis] < this.limits[axis][0] || target[axis] > this.limits[axis][1]) throw new Error(`PTZ ${axis} outside limits`)
    }
    this.check(await this.rpc('SetPtzPosition', { position: { ptz: { name: this.name }, pan: { value: target.pan }, tilt: { value: target.tilt }, zoom: { value: target.zoom } } }))
  }
  async move(target: { pan: number; tilt: number; zoom: number }, cancelled: () => boolean = () => false) {
    await this.set(target)
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (cancelled()) { await this.stop(); throw new Error('Camera movement cancelled') }
      const actual = await this.position()
      if (Math.abs(actual.pan - target.pan) <= 0.5 && Math.abs(actual.tilt - target.tilt) <= 0.5 && Math.abs(actual.zoom - target.zoom) <= 0.1) return
      await new Promise(r => setTimeout(r, 100))
    }
    await this.stop()
    throw new Error('Camera arrival timed out')
  }
  async nudge(axes: Record<string, number>) {
    const p = await this.position()
    for (const axis of ['pan', 'tilt', 'zoom'] as const) {
      const step = axis === 'zoom' ? 0.25 : 2
      p[axis] = Math.max(this.limits[axis][0], Math.min(this.limits[axis][1], p[axis] + (axes[axis] ?? 0) * step))
    }
    await this.set(p)
  }
  async stop() {
    const p = await this.position()
    await this.set(p)
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise(r => setTimeout(r, 80))
      const actual = await this.position()
      if (Math.abs(actual.pan - p.pan) < 0.5 && Math.abs(actual.tilt - p.tilt) < 0.5 && Math.abs(actual.zoom - p.zoom) < 0.1) return
    }
    throw new Error('Camera stop was not confirmed')
  }
}
