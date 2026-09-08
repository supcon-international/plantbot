import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Toggle as TogglePrimitive } from 'radix-ui'

import { cn } from '@/lib/cn'

// Selected states use the Tier0 highlight surface.
const toggleVariants = cva(
  'inline-flex rounded-md items-center justify-center gap-1.5 whitespace-nowrap font-sans text-[13px] font-medium text-ink-3 transition-colors outline-none hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-(--signal) disabled:pointer-events-none disabled:opacity-45 data-[state=on]:bg-highlight-soft data-[state=on]:text-ink [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-3.5',
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline: 'border border-line bg-surface',
      },
      size: {
        default: 'h-9 min-w-8 px-2.5',
        sm: 'h-8 min-w-8 px-2 text-[12px]',
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
