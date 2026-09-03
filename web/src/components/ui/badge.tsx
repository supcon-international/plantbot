import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'

import { cn } from '@/lib/cn'

// Squared sentence-case chips — the substrate for SevTag / ModeChip / MissionStatusTag
// (`micro` keeps the mono/uppercase treatment for ids and codes)
// (those keep their data-mode / data-status attribute skins from app.css).
const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border px-1.5 py-0.5 text-[11px] font-medium tracking-[0.02em] transition-colors [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'border-line-2 bg-surface-2 text-ink-2',
        signal: 'border-(--signal) bg-(--signal) text-[#080808]',
        outline: 'border-line bg-transparent text-ink-3',
        destructive: 'border-crit/45 bg-crit/10 text-crit',
        micro: 'mono border-line-2 bg-surface-2 px-1.5 py-[3px] text-[9px] uppercase tracking-[0.1em] text-ink-2',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

function Badge({
  className,
  variant = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span'

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
