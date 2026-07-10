import * as React from 'react'

import { cn } from '@/lib/cn'

// Native focus treatment (signal inset bar) comes from the global stylesheet;
// this only sets the squared Carbon field chrome.
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-8 w-full min-w-0 border border-line-2 bg-surface px-2.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-3 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-crit',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
