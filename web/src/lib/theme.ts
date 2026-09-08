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
      theme: 'light',
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
    {
      name: 'aegis-theme',
      // Match the first-paint script and ignore obsolete / malformed values.
      merge: (persisted, current) => {
        const saved = persisted as Partial<Pick<ThemeState, 'theme'>> | undefined
        return { ...current, theme: saved?.theme === 'dark' ? 'dark' : 'light' }
      },
    },
  ),
)

// stamp the attribute on module load (index.html's inline script already
// covered first paint; this re-syncs after hydration/persist rehydrate)
apply(useTheme.getState().theme)
