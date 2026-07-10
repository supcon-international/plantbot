import * as React from 'react'

import { cn } from '@/lib/cn'

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'field-sizing-content flex min-h-16 w-full border border-line-2 bg-surface px-2.5 py-2 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-3 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-crit',
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
