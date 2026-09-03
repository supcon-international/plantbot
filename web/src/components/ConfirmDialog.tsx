import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useT } from '../lib/i18n'

export interface ConfirmOptions {
  /** dialog heading (defaults to a generic "Confirm") */
  title?: string
  /** body text — supports newlines */
  message?: string
  /** confirm-button label (defaults to "Confirm") */
  confirmText?: string
  /** cancel-button label (defaults to "Cancel") */
  cancelText?: string
  /** red confirm button for destructive actions (delete) */
  destructive?: boolean
  /** prompt mode: render a text field; resolves the entered string (or null on cancel) */
  input?: boolean
  /** initial value for the input field */
  defaultValue?: string
  /** input placeholder */
  placeholder?: string
}

type Result = boolean | string | null
type Ask = (opts: ConfirmOptions) => Promise<Result>

const Ctx = React.createContext<Ask | null>(null)

/**
 * App-level provider for the shared confirm / prompt dialog. Replaces the
 * native window.confirm / window.prompt (which the sandboxed iframe embed and
 * some browsers suppress) with a Carbon-skinned Radix dialog.
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const t = useT()
  const [state, setState] = React.useState<{ opts: ConfirmOptions; resolve: (r: Result) => void } | null>(null)
  const [value, setValue] = React.useState('')

  const ask = React.useCallback<Ask>((opts) => {
    setValue(opts.defaultValue ?? '')
    return new Promise<Result>((resolve) => setState({ opts, resolve }))
  }, [])

  const opts = state?.opts
  const isInput = !!opts?.input

  const settle = (result: Result) => {
    state?.resolve(result)
    setState(null)
  }
  const cancel = () => settle(isInput ? null : false)
  const accept = () => settle(isInput ? value : true)

  return (
    <Ctx.Provider value={ask}>
      {children}
      <Dialog open={!!state} onOpenChange={(open) => !open && cancel()}>
        <DialogContent
          showCloseButton={false}
          className="md:max-w-md"
          {...(opts?.message ? {} : { 'aria-describedby': undefined })}
        >
          <div className="space-y-4 p-4">
            <DialogHeader>
              <DialogTitle>{opts?.title ?? t('c.confirm')}</DialogTitle>
              {opts?.message && (
                <DialogDescription className="whitespace-pre-line leading-relaxed">{opts.message}</DialogDescription>
              )}
            </DialogHeader>
            {isInput && (
              <Input
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={opts?.placeholder}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    accept()
                  }
                }}
                className="mono bg-surface-2 py-2 text-[13px]"
              />
            )}
            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                onClick={cancel}
                className="mono h-auto px-4 py-2 text-[11px] normal-case tracking-[0.1em]"
              >
                {opts?.cancelText ?? t('c.cancel')}
              </Button>
              <Button
                variant={opts?.destructive ? 'destructive' : 'signal'}
                onClick={accept}
                className="mono h-auto px-4 py-2 text-[11px] normal-case tracking-[0.1em]"
              >
                {opts?.confirmText ?? t('c.confirm')}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </Ctx.Provider>
  )
}

/**
 * Returns an async `confirm(opts)`:
 *  - default mode resolves `true` / `false`
 *  - `input: true` (prompt) resolves the entered string, or `null` on cancel
 */
export function useConfirm(): Ask {
  const ask = React.useContext(Ctx)
  if (!ask) throw new Error('useConfirm must be used within <ConfirmProvider>')
  return ask
}
