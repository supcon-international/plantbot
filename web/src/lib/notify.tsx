import { toast } from 'sonner'
import { NavLink } from 'react-router'
import { X } from 'lucide-react'
import type { DetectionEvent } from './types'
import { useT } from './i18n'
import { SevDot } from '../components/ui'
import { Button } from '@/components/ui/button'

// The console notification card (toast-card: hard shadow + signal edge),
// delivered through sonner's stack instead of a hand-rolled singleton.
function EventToast({ ev, toastId }: { ev: DetectionEvent; toastId: string | number }) {
  const t = useT()
  return (
    <div className="toast-card rise relative flex w-full items-center gap-3 px-4 py-3">
      <SevDot sev={ev.severity} pulse />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium text-ink">{ev.label}</div>
        <div className="microlabel mt-0.5">
          {ev.sourceName} · {ev.zone}
        </div>
      </div>
      <NavLink to={`/events?ev=${ev.id}`} onClick={() => toast.dismiss(toastId)} className="text-link shrink-0">
        {t('shell.view')}
      </NavLink>
      <Button variant="ghost" size="iconSm" aria-label="dismiss" onClick={() => toast.dismiss(toastId)}>
        <X />
      </Button>
    </div>
  )
}

export function notifyEvent(ev: DetectionEvent) {
  // configuration surfaces (site builder / accounts) are no place for an
  // event firehose — the EVENTS badge still counts them
  if (location.pathname.includes('/sites')) return
  toast.custom((id) => <EventToast ev={ev} toastId={id} />, { duration: 7000 })
}
