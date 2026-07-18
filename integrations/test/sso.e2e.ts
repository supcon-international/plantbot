// OIDC SSO e2e — real platform + mock IdP, full Authorization Code + PKCE
// round-trip driven with plain fetch (redirect: 'manual'):
//   login 302 → IdP authorize 302 → callback → pb_sess → /api/auth/me
// Asserts JIT provisioning (default role + admin allowlist), state tampering
// rejection, and that password login still coexists.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnProc, waitFor, j } from './harness.js'
import { startMockIdp, type MockIdp } from './mock-idp.js'

const PORT = 8975
const IDP_PORT = 8976
const BASE = `http://127.0.0.1:${PORT}`

let idp: MockIdp
let stopPlatform: () => void

test.before(async () => {
  idp = await startMockIdp(IDP_PORT)
  const dataDir = mkdtempSync(join(tmpdir(), 'pb-sso-'))
  const proc = spawnProc(
    'server/src/index.ts',
    {
      API_PORT: String(PORT),
      PB_DATA_DIR: dataDir,
      PB_DEMO: '1',
      PB_DEV_KEYS: '1',
      SESSION_SECRET: 'sso-e2e-secret',
      OIDC_ISSUER: idp.issuer,
      OIDC_CLIENT_ID: 'plantbot-e2e',
      OIDC_DEFAULT_ROLE: 'operator',
      OIDC_ADMIN_USERS: 'boss@corp.com',
    },
    `platform:${PORT}`,
  )
  stopPlatform = () => proc.kill('SIGTERM')
  await waitFor(async () => (await fetch(`${BASE}/api/sites`)).ok, 20_000, 'platform up')
})

test.after(() => {
  stopPlatform?.()
  idp?.stop()
})

const cookieOf = (res: Response, name: string) => {
  const all = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? '']
  const hit = all.find((c) => c.startsWith(`${name}=`))
  return hit ? hit.split(';')[0] : null
}

/** run the whole browser redirect dance with fetch and return the session cookie */
async function ssoRoundTrip(): Promise<{ sess: string; me: any }> {
  const login = await fetch(`${BASE}/api/auth/oidc/login?next=/live`, { redirect: 'manual' })
  assert.equal(login.status, 302)
  const stateCookie = cookieOf(login, 'pb_oidc')
  assert.ok(stateCookie, 'state cookie set')
  const authorizeUrl = login.headers.get('location')!
  assert.ok(authorizeUrl.startsWith(idp.issuer), 'redirects to the IdP')
  assert.match(authorizeUrl, /code_challenge_method=S256/)

  const approve = await fetch(authorizeUrl, { redirect: 'manual' })
  assert.equal(approve.status, 302)
  const callbackUrl = approve.headers.get('location')!
  assert.ok(callbackUrl.includes('/api/auth/oidc/callback?'), 'IdP sends the browser back')

  const cb = await fetch(callbackUrl, { redirect: 'manual', headers: { cookie: stateCookie! } })
  assert.equal(cb.status, 302, `callback should 302, got ${cb.status}: ${await cb.text()}`)
  assert.equal(cb.headers.get('location'), '/live', 'lands on the requested next path')
  const sess = cookieOf(cb, 'pb_sess')
  assert.ok(sess, 'session issued')

  const me = await j(await fetch(`${BASE}/api/auth/me`, { headers: { cookie: sess! } }))
  return { sess: sess!, me }
}

test('advertises SSO on /api/auth/me when configured', async () => {
  const me = await j(await fetch(`${BASE}/api/auth/me`))
  assert.deepEqual(me.sso, { label: 'SSO' })
})

test('full code+PKCE flow JIT-provisions with the default role', async () => {
  const { me } = await ssoRoundTrip()
  assert.equal(me.user.username, 'alicecorp.com') // slug of alice@corp.com
  assert.equal(me.user.displayName, 'Alice')
  for (const s of me.sites) assert.equal(s.role, 'operator')
})

test('admin allowlist provisions as platform admin', async () => {
  idp.setUser({ sub: 'u-2', email: 'boss@corp.com', name: 'Boss' })
  const { me } = await ssoRoundTrip()
  assert.equal(me.user.username, 'bosscorp.com')
  for (const s of me.sites) assert.equal(s.role, 'admin')
  idp.setUser({ sub: 'u-1', email: 'alice@corp.com', name: 'Alice' })
})

test('tampered state is rejected', async () => {
  const login = await fetch(`${BASE}/api/auth/oidc/login`, { redirect: 'manual' })
  const stateCookie = cookieOf(login, 'pb_oidc')!
  const approve = await fetch(login.headers.get('location')!, { redirect: 'manual' })
  const cb = new URL(approve.headers.get('location')!)
  cb.searchParams.set('state', 'forged')
  const res = await fetch(cb, { redirect: 'manual', headers: { cookie: stateCookie } })
  assert.equal(res.status, 400)
})

test('password login still works alongside SSO', async () => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'plantbot' }),
  })
  assert.equal(res.status, 200)
})
