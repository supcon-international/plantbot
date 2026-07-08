/**
 * rAF-polling ResizeObserver stand-in, passed to R3F's `resize.polyfill`.
 * Some embedded/headless viewers ship a ResizeObserver that never fires its
 * initial notification, which leaves react-use-measure at 0×0 and the Canvas
 * uninitialized forever. Polling ~60 Hz on a handful of containers is free.
 */
export class RafResizeObserver {
  private cb: (entries: any[], obs: any) => void
  private els = new Set<Element>()
  private sizes = new WeakMap<Element, { w: number; h: number }>()
  private raf = 0

  constructor(cb: (entries: any[], obs: any) => void) {
    this.cb = cb
  }

  observe(el: Element) {
    this.els.add(el)
    if (!this.raf) this.loop()
  }

  unobserve(el: Element) {
    this.els.delete(el)
  }

  disconnect() {
    this.els.clear()
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop)
    const entries: any[] = []
    for (const el of this.els) {
      const w = (el as HTMLElement).clientWidth
      const h = (el as HTMLElement).clientHeight
      const prev = this.sizes.get(el)
      if (!prev || prev.w !== w || prev.h !== h) {
        this.sizes.set(el, { w, h })
        entries.push({
          target: el,
          contentRect: { width: w, height: h, x: 0, y: 0, top: 0, left: 0, bottom: h, right: w },
          borderBoxSize: [{ inlineSize: w, blockSize: h }],
          contentBoxSize: [{ inlineSize: w, blockSize: h }],
        })
      }
    }
    if (entries.length) this.cb(entries, this)
  }
}
