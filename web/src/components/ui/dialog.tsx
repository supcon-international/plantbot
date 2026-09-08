import * as React from 'react'
import { Close as XIcon } from '@carbon/icons-react'
import { Dialog as DialogPrimitive } from 'radix-ui'

import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'

type DialogActivation = { element: HTMLElement; radixTrigger: boolean }
let currentActivation: DialogActivation | null = null

function rememberActivation(element: HTMLElement, radixTrigger = false) {
  const activation = { element, radixTrigger }
  currentActivation = activation
  // React batches click updates. Keep the source through that commit, then
  // discard it so a later programmatic dialog cannot inherit a stale click.
  setTimeout(() => {
    if (currentActivation === activation) currentActivation = null
  }, 0)
}

/** Capture on the existing app shell; Safari clicks need not focus buttons. */
function captureDialogOpener(event: React.MouseEvent<HTMLElement>) {
  const element = event.target instanceof Element
    ? event.target.closest('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]')
    : null
  if (element instanceof HTMLElement) rememberActivation(element)
}

function focusedActivation(): DialogActivation | null {
  const element = document.activeElement
  return element instanceof HTMLElement && element !== document.body ? { element, radixTrigger: false } : null
}

const DialogActivationContext = React.createContext<DialogActivation | null | undefined>(undefined)

function Dialog({ open: controlledOpen, defaultOpen, onOpenChange, ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false)
  const open = controlledOpen ?? uncontrolledOpen
  // Snapshot once per opening, before portalled inputs can take focus. This
  // also covers persistent controlled roots such as the shared confirmation.
  const activation = React.useMemo(() => open ? currentActivation ?? focusedActivation() : null, [open])
  return (
    <DialogActivationContext.Provider value={activation}>
      <DialogPrimitive.Root
        data-slot="dialog"
        {...props}
        open={open}
        onOpenChange={(nextOpen) => {
          if (controlledOpen === undefined) setUncontrolledOpen(nextOpen)
          onOpenChange?.(nextOpen)
        }}
      />
    </DialogActivationContext.Provider>
  )
}

function DialogTrigger({ onClickCapture, ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} onClickCapture={(event) => {
    rememberActivation(event.currentTarget, true)
    onClickCapture?.(event)
  }} />
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
  const activation = React.useContext(DialogActivationContext)
  const restoreRef = React.useRef<DialogActivation | null>(activation ?? focusedActivation())
  if (activation) restoreRef.current = activation
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          // NB: not the .panel class — its position:relative would beat `fixed`.
          'modal-surface fixed bottom-0 z-50 translate-x-[-50%] overflow-y-auto bg-surface outline-none md:bottom-auto md:max-w-xl md:translate-y-[-50%] data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          className,
        )}
        {...props}
        onOpenAutoFocus={(event) => {
          // Preserve compatibility if this content is used with a raw Radix root.
          const active = document.activeElement
          const content = event.target
          if (activation === undefined && active instanceof HTMLElement && active !== document.body && !(content instanceof HTMLElement && content.contains(active))) {
            restoreRef.current = { element: active, radixTrigger: false }
          }
          onOpenAutoFocus?.(event)
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event)
          const restore = restoreRef.current
          const opener = restore?.element
          // A real DialogTrigger retains Radix's own restoration behavior.
          if (!event.defaultPrevented && !restore?.radixTrigger && opener?.isConnected) {
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
  captureDialogOpener,
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
