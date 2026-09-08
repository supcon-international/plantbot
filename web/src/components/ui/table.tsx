import * as React from 'react'

import { cn } from '@/lib/cn'

// Hairline data grid: microlabel header row, line-2 rule under the head,
// surface-2 row hover — the console's existing table anatomy.
function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div data-slot="table-container" tabIndex={0} className="relative w-full min-w-0 overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-(--signal)">
      <table data-slot="table" className={cn('w-full caption-bottom border-collapse text-left text-[13px]', className)} {...props} />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn('[&_tr]:border-b [&_tr]:border-line-2 [&_tr:hover]:bg-transparent', className)} {...props} />
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={cn('[&_tr:last-child]:border-0', className)} {...props} />
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return <tfoot data-slot="table-footer" className={cn('border-t border-line-2 bg-surface-2/50 [&>tr]:last:border-b-0', className)} {...props} />
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn('border-b border-line transition-colors hover:bg-surface-2/60 data-[state=selected]:bg-highlight-soft', className)}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return <th scope="col" data-slot="table-head" className={cn('microlabel h-10 whitespace-nowrap px-2.5 align-middle', className)} {...props} />
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return <td data-slot="table-cell" className={cn('h-12 whitespace-nowrap px-2.5 py-2 align-middle text-ink-2', className)} {...props} />
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return <caption data-slot="table-caption" className={cn('microlabel mt-3', className)} {...props} />
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption }
