import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Toggle as TogglePrimitive } from 'radix-ui'

import { cn } from '@/lib/cn'

// Segmented-cell behavior: pressed state inverts to solid ink.
const toggleVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-(family-name:--font-condensed) text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3 transition-colors outline-none hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink disabled:pointer-events-none disabled:opacity-45 data-[state=on]:bg-ink data-[state=on]:text-bg [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-3.5',
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline: 'border border-line bg-surface',
      },
      size: {
        default: 'h-8 min-w-7 px-2.5',
        sm: 'h-7 min-w-7 px-2 text-[10px]',
        lg: 'h-9 min-w-9 px-3',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Toggle({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>) {
  return <TogglePrimitive.Root data-slot="toggle" className={cn(toggleVariants({ variant, size, className }))} {...props} />
}

export { Toggle, toggleVariants }
