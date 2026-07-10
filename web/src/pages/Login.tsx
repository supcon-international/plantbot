import { useState } from 'react'
import { useNavigate } from 'react-router'
import { LogIn } from 'lucide-react'
import { useAuth } from '../lib/store'
import { useT } from '../lib/i18n'

export function Login() {
  const login = useAuth((s) => s.login)
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
    else nav('/')
  }

  return (
    <div className="flex h-full items-center justify-center px-4">
      <form onSubmit={submit} className="panel w-[min(380px,100%)] space-y-4 p-6">
        <div>
          <div className="flex items-center gap-2 text-ink">
            <LogIn size={15} />
            <span className="text-[15px] font-medium">{t('login.title')}</span>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-3">{t('login.sub')}</p>
        </div>
        <div>
          <div className="microlabel mb-1.5">{t('login.user')}</div>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            className="mono w-full border border-line-2 bg-surface-2 px-2.5 py-2 text-[13px] text-ink outline-none focus:border-ink-3"
          />
        </div>
        <div>
          <div className="microlabel mb-1.5">{t('login.pass')}</div>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="mono w-full border border-line-2 bg-surface-2 px-2.5 py-2 text-[13px] text-ink outline-none focus:border-ink-3"
          />
        </div>
        {err && (
          <div className="mono border border-crit/40 bg-crit/10 px-2.5 py-1.5 text-[12px]" style={{ color: 'var(--color-crit)' }}>
            {t('login.failed')}
          </div>
        )}
        <button
          type="submit"
          disabled={!username || !password || busy}
          className="mono w-full border border-ink/30 bg-ink/10 px-3 py-2.5 text-[12px] tracking-[0.12em] text-ink transition-colors hover:bg-ink/15 disabled:opacity-30"
        >
          {t('login.go')}
        </button>
        <p className="mono text-[10.5px] leading-relaxed text-ink-3/80">{t('login.hint')}</p>
      </form>
    </div>
  )
}
