import { cn } from '@/lib/cn'

// Reuses the console shimmer (.skeleton) instead of a pulse — same loading
// texture everywhere.
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="skeleton" className={cn('skeleton', className)} {...props} />
}

export { Skeleton }
