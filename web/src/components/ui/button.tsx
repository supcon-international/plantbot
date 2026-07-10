import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'

import { cn } from '@/lib/cn'

// Carbon console skin: squared, hairline borders, condensed uppercase labels.
// `utility` ≙ the old .utility-button, `ghost` ≙ .icon-button.is-quiet,
// `signal` is the lime emphasis block (.utility-button.is-on), `default` is
// the solid-ink action block (segmented is-selected tone).
const buttonVariants = cva(
  'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap font-(family-name:--font-condensed) text-[11px] font-medium uppercase tracking-[0.08em] transition-colors duration-100 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:pointer-events-none disabled:opacity-45 aria-invalid:border-crit [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border border-ink bg-ink text-bg hover:border-ink-2 hover:bg-ink-2',
        signal: 'border border-(--signal) bg-(--signal) text-[#080808] hover:brightness-[0.96]',
        utility: 'border border-line bg-surface text-ink-3 hover:border-ink-2 hover:bg-surface-2 hover:text-ink',
        outline: 'border border-line-2 bg-surface text-ink-2 hover:border-ink-2 hover:bg-surface-2 hover:text-ink',
        ghost: 'border border-transparent bg-transparent text-ink-3 hover:bg-surface-2 hover:text-ink',
        destructive: 'border border-crit/45 bg-transparent text-crit hover:bg-crit hover:text-white',
        link: 'border-0 bg-transparent p-0 text-ink-2 hover:text-(--signal)',
      },
      size: {
        default: 'h-8 px-2.5',
        sm: 'h-7 px-2 text-[10px]',
        lg: 'h-9 px-4',
        icon: 'size-8 p-0',
        iconSm: 'size-7 p-0',
      },
    },
    defaultVariants: {
      variant: 'utility',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant = 'utility',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
