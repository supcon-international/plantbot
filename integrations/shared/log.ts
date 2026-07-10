/** Tiny prefixed logger — every sim/adapter process tags its own lines so the
 *  combined `pnpm dev` stream stays readable. */
export type Log = (msg: string, ...rest: unknown[]) => void

export function makeLog(tag: string): { info: Log; warn: Log } {
  const stamp = () => new Date().toISOString().slice(11, 19)
  return {
    info: (msg, ...rest) => console.log(`${stamp()} [${tag}] ${msg}`, ...rest),
    warn: (msg, ...rest) => console.warn(`${stamp()} [${tag}] ⚠ ${msg}`, ...rest),
  }
}
