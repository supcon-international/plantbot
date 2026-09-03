import { Toaster as Sonner, type ToasterProps } from 'sonner'
import { useSyncExternalStore } from 'react'

import { useTheme } from '@/lib/theme'

// Console notification rail: toast.custom() renders our own Carbon card
// (see lib/notify.tsx), so the Toaster only positions/unstyles the stack.
//
// Desktop: bottom-right — the top-right corner holds every page's action
// buttons (ADD CAMERA, NEW KEY, …) and a busy event stream was fencing them
// off behind a toast wall.
// Mobile (<768px): top-center — the bottom edge belongs to the tab bar and the
// page's own list (events were piling straight onto it), so toasts drop from
// the top instead, tucked below the notch via the safe-area inset.
const MOBILE_QUERY = '(max-width: 767px)'
function useIsMobile() {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(MOBILE_QUERY)
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    },
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false, // no SSR here; assume desktop for the first snapshot
  )
}

const SAFE_TOP = 'calc(12px + env(safe-area-inset-top))'

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useTheme((s) => s.theme)
  const isMobile = useIsMobile()

  return (
    <Sonner
      theme={theme}
      position={isMobile ? 'top-center' : 'bottom-right'}
      // `top` is also set on the desktop `offset` so 600–767px is covered:
      // there sonner still uses `offset` (its own mobileOffset only applies
      // below 600px) while our position has already flipped to top-center.
      offset={{ top: SAFE_TOP, bottom: 20, right: 16 }}
      mobileOffset={{ top: SAFE_TOP, left: 12, right: 12 }}
      gap={8}
      toastOptions={{ unstyled: true, classNames: { toast: 'w-[min(420px,calc(100vw-24px))]' } }}
      {...props}
    />
  )
}

export { Toaster }
