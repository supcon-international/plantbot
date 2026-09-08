import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'

import { cn } from '@/lib/cn'

// Tier0 product: near-ink primary actions, calm secondary controls, and
// green reserved for an explicitly highlighted / selected state.
const buttonVariants = cva(
  'inline-flex min-h-6 rounded-md shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap font-sans text-[13px] font-medium transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--signal) disabled:pointer-events-none disabled:opacity-45 aria-invalid:border-crit [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border border-primary bg-primary text-primary-foreground hover:bg-(--tier0-primary-hover)',
        signal: 'border border-primary bg-primary text-primary-foreground hover:bg-(--tier0-primary-hover)',
        highlight: 'border border-highlight bg-highlight text-primary hover:bg-(--signal)',
        utility: 'border border-line bg-surface text-ink-2 hover:border-ink-2 hover:bg-surface-2 hover:text-ink',
        outline: 'border border-line-2 bg-surface text-ink-2 hover:border-ink-2 hover:bg-surface-2 hover:text-ink',
        ghost: 'border border-transparent bg-transparent text-ink-3 hover:bg-surface-2 hover:text-ink',
        destructive: 'border border-crit/45 bg-transparent text-crit hover:bg-crit hover:text-(--tier0-error-foreground)',
        link: 'border-0 bg-transparent p-0 text-ink-2 underline underline-offset-2 hover:text-ink',
      },
      size: {
        default: 'h-9 px-3',
        sm: 'h-8 px-2.5 text-[12px]',
        lg: 'h-10 px-4 text-[14px]',
        icon: 'size-9 p-0',
        iconSm: 'size-8 p-0',
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
