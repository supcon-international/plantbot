import { useState } from 'react'
import { useNavigate } from 'react-router'
import { LogIn } from 'lucide-react'
import { useAuth } from '../lib/store'
import { useT } from '../lib/i18n'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** gate mode: rendered standalone by the Shell when PB_PUBLIC_VIEW=0 —
 *  no router navigation, the shell re-renders once the session lands */
export function Login({ gate = false }: { gate?: boolean }) {
  const login = useAuth((s) => s.login)
  const demo = useAuth((s) => s.demo)
  const t = useT()
  const nav = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!username || !password || busy) return
    setBusy(true)
    const fail = await login(username, password)
    setBusy(false)
    if (fail) setErr(fail)
    else if (!gate) nav('/')
  }

  return (
    <div className="flex h-full items-center justify-center px-4">
      <Card className="panel w-[min(380px,100%)]">
        <CardContent className="p-6">
          <form onSubmit={submit} className="space-y-4">
            <div>
              <div className="flex items-center gap-2 text-ink">
                <LogIn size={15} />
                <span className="text-[15px] font-medium">{t('login.title')}</span>
              </div>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-3">{t(gate ? 'login.gated' : 'login.sub')}</p>
            </div>
            <div>
              <Label className="mb-1.5" htmlFor="login-user">
                {t('login.user')}
              </Label>
              <Input
                id="login-user"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                className="mono bg-surface-2 py-2 text-[13px]"
              />
            </div>
            <div>
              <Label className="mb-1.5" htmlFor="login-pass">
                {t('login.pass')}
              </Label>
              <Input
                id="login-pass"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="mono bg-surface-2 py-2 text-[13px]"
              />
            </div>
            {err && (
              <div className="mono border border-crit/40 bg-crit/10 px-2.5 py-1.5 text-[12px]" style={{ color: 'var(--color-crit)' }}>
                {t('login.failed')}
              </div>
            )}
            <Button
              type="submit"
              variant="signal"
              disabled={!username || !password || busy}
              className="mono h-auto w-full py-2.5 text-[12px] normal-case tracking-[0.12em] disabled:opacity-30"
            >
              {t('login.go')}
            </Button>
            {demo && <p className="mono text-[10.5px] leading-relaxed text-ink-3/80">{t('login.hint')}</p>}
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
