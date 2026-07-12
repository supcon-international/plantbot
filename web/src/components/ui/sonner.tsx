import { Toaster as Sonner, type ToasterProps } from 'sonner'

import { useTheme } from '@/lib/theme'

// Console notification rail: toast.custom() renders our own Carbon card
// (see lib/notify.tsx), so the Toaster only positions/unstyles the stack.
// Bottom-right, not top-right: the top-right corner holds every page's
// action buttons (ADD CAMERA, NEW KEY, …) and a busy event stream was
// fencing them off behind a toast wall.
const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useTheme((s) => s.theme)

  return (
    <Sonner
      theme={theme}
      position="bottom-right"
      offset={{ bottom: 20, right: 16 }}
      mobileOffset={{ bottom: 76, right: 12, left: 12 }}
      gap={8}
      toastOptions={{ unstyled: true, classNames: { toast: 'w-[min(420px,calc(100vw-24px))]' } }}
      {...props}
    />
  )
}

export { Toaster }
