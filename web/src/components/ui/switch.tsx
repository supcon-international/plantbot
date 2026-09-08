import * as React from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'

import { cn } from '@/lib/cn'

// Checked state uses a solid highlight face and a high-contrast thumb.
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-6 w-10 rounded-md shrink-0 items-center border border-line-2 bg-surface-2 transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--signal) disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-highlight data-[state=checked]:bg-highlight',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-[18px] rounded-sm translate-x-[2px] bg-ink-3 transition-transform data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-primary"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
