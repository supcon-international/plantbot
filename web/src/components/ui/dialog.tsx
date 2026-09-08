import * as React from 'react'
import { Close as XIcon } from '@carbon/icons-react'
import { Dialog as DialogPrimitive } from 'radix-ui'

import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'modal-backdrop-scrim fixed inset-0 z-50 bg-black/45 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
        className,
      )}
      {...props}
    />
  )
}

/** Stable scrollable dialog: bottom sheet on mobile, centred on desktop. */
function DialogContent({
  className,
  children,
  showCloseButton = true,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  const t = useT()
  // Native input autoFocus runs before Radix's mount autofocus callback. Keep
  // a pre-portal snapshot for conditionally mounted dialogs in that case.
  const activeBeforeMount = document.activeElement
  const openerRef = React.useRef<HTMLElement | null>(
    activeBeforeMount instanceof HTMLElement && activeBeforeMount !== document.body ? activeBeforeMount : null,
  )
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          // NB: not the .panel class — its position:relative would beat `fixed`.
          'modal-surface fixed bottom-0 left-[50%] z-50 max-h-[92dvh] w-full translate-x-[-50%] overflow-y-auto bg-surface outline-none md:top-[50%] md:bottom-auto md:max-w-xl md:translate-y-[-50%] data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          className,
        )}
        {...props}
        onOpenAutoFocus={(event) => {
          // Controlled / conditionally mounted dialogs may have no Radix Trigger.
          const active = document.activeElement
          const content = event.target
          if (active instanceof HTMLElement && active !== document.body && !(content instanceof HTMLElement && content.contains(active))) {
            openerRef.current = active
          }
          onOpenAutoFocus?.(event)
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event)
          const opener = openerRef.current
          if (!event.defaultPrevented && opener?.isConnected) {
            event.preventDefault()
            opener.focus({ preventScroll: true })
          }
        }}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-3 right-3 inline-flex rounded-md size-8 items-center justify-center border border-transparent text-ink-3 transition-colors outline-none hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--signal) [&_svg]:pointer-events-none [&_svg]:size-3.5"
          >
            <XIcon />
            <span className="sr-only">{t('c.close')}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dialog-header" className={cn('flex flex-col gap-1.5 text-left', className)} {...props} />
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        'font-sans text-[18px] font-medium text-ink',
        className,
      )}
      {...props}
    />
  )
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-[13px] text-ink-2', className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
