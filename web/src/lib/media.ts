// Data-saver playback: swap each /media loop for its 640p capped-bitrate twin
// (<name>.low.mp4, rendered by scripts/setup.mjs) so slow links stay watchable.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** first-visit default: honour Save-Data and constrained effective link types */
function detectSlowLink(): boolean {
  const c = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection
  if (!c) return false
  return !!c.saveData || /(^|\b)(slow-2g|2g|3g)$/.test(c.effectiveType ?? '')
}

interface DataSaverState {
  on: boolean
  toggle: () => void
}

export const useDataSaver = create<DataSaverState>()(
  persist((set) => ({ on: detectSlowLink(), toggle: () => set((s) => ({ on: !s.on })) }), {
    name: 'aegis-datasaver',
  }),
)

/** /media/foo.mp4 → /media/foo.low.mp4 (server ships both; caller falls back on error) */
export function lowSrc(file: string) {
  return file.replace(/\.mp4$/, '.low.mp4')
}
