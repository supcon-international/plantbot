import * as React from 'react'
import { Tabs as TabsPrimitive } from 'radix-ui'

import { cn } from '@/lib/cn'

// The console segmented control: hairline-framed strip, mono/condensed labels,
// selected cell inverts to solid ink (segmented-control.is-selected).
function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn('flex flex-col gap-2', className)} {...props} />
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn('inline-flex h-8 w-fit items-stretch border border-line bg-surface', className)}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        'inline-flex min-w-7 items-center justify-center gap-1.5 border-0 border-r border-line bg-transparent px-2.5 font-(family-name:--font-condensed) text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3 transition-colors outline-none last:border-r-0 hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink disabled:pointer-events-none disabled:opacity-45 data-[state=active]:bg-ink data-[state=active]:text-bg [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0',
        className,
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn('flex-1 outline-none', className)} {...props} />
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
