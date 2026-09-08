import * as React from 'react'

import { cn } from '@/lib/cn'

// Shared field geometry and visible keyboard focus.
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-9 rounded-md w-full min-w-0 border border-line-2 bg-surface px-2.5 text-[13px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--signal) transition-colors placeholder:text-ink-3 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-crit',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
