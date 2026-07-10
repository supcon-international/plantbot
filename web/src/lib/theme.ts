import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemeMode = 'dark' | 'light'

interface ThemeState {
  theme: ThemeMode
  toggle: () => void
  set: (t: ThemeMode) => void
}

const apply = (t: ThemeMode) => {
  document.documentElement.dataset.theme = t
}

export const useTheme = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'dark',
      toggle: () =>
        set((s) => {
          const next: ThemeMode = s.theme === 'dark' ? 'light' : 'dark'
          apply(next)
          return { theme: next }
        }),
      set: (theme) => {
        apply(theme)
        set({ theme })
      },
    }),
    { name: 'aegis-theme' },
  ),
)

// stamp the attribute on module load (index.html's inline script already
// covered first paint; this re-syncs after hydration/persist rehydrate)
apply(useTheme.getState().theme)
