import * as React from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'

import { cn } from '@/lib/cn'

// Squared hardware toggle: hairline track, square thumb, signal fill when on.
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-[16px] w-[30px] shrink-0 items-center border border-line-2 bg-surface-2 transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-(--signal) data-[state=checked]:bg-(--signal)/20',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-[10px] translate-x-[2px] bg-ink-3 transition-transform data-[state=checked]:translate-x-[16px] data-[state=checked]:bg-(--signal)"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
