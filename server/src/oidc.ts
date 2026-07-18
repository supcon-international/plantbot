// OIDC / OAuth 2.0 SSO — zero-dependency Authorization Code + PKCE client.
// Lets an embedding webapp's identity provider sign users into Plantbot:
// set OIDC_ISSUER + OIDC_CLIENT_ID (+ OIDC_CLIENT_SECRET for confidential
// clients) and a "continue with SSO" entry appears on the login page.
//
//   OIDC_ISSUER          https://idp.example.com  (discovery at
//                        <issuer>/.well-known/openid-configuration)
//   OIDC_CLIENT_ID       registered client id
//   OIDC_CLIENT_SECRET   optional — omit for a public client (PKCE only)
//   OIDC_SCOPES          default "openid profile email"
//   OIDC_LABEL           login-button label, default "SSO"
//   OIDC_DEFAULT_ROLE    role for JIT-provisioned users (viewer|operator|admin,
//                        default viewer, granted on '*')
//   OIDC_ADMIN_USERS     comma list of emails/subs that provision as '*' admin
//   OIDC_REDIRECT_URL    absolute callback override; defaults to
//                        <request origin><PUBLIC_BASE>/api/auth/oidc/callback
//
// Flow: GET /api/auth/oidc/login?next=/x → 302 to the IdP → callback verifies
// state, exchanges the code, validates the ID token against the IdP's JWKS
// (RS256/PS256/ES256), JIT-provisions the user, issues the normal pb_sess
// session and redirects into the SPA. Users created this way authenticate
// only via SSO (their local password is random); platform admins can adjust
// their roles in the SITES → users panel afterwards.

import { createHash, createHmac, createPublicKey, randomBytes, verify as cryptoVerify, type KeyObject } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { createUser, getUser, type Role } from './config.js'
import { issueSession } from './auth.js'

const ISSUER = (process.env.OIDC_ISSUER ?? '').replace(/\/$/, '')
const CLIENT_ID = process.env.OIDC_CLIENT_ID ?? ''
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET ?? ''
const SCOPES = process.env.OIDC_SCOPES ?? 'openid profile email'
const DEFAULT_ROLE: Role = (['viewer', 'operator', 'admin'] as const).includes(
  (process.env.OIDC_DEFAULT_ROLE ?? '') as Role,
)
  ? ((process.env.OIDC_DEFAULT_ROLE ?? 'viewer') as Role)
  : 'viewer'
const ADMIN_USERS = (process.env.OIDC_ADMIN_USERS ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

const PUB = process.env.PUBLIC_BASE ?? ''
const STATE_COOKIE = 'pb_oidc'
const STATE_TTL_MS = 10 * 60_000
// own HMAC secret is fine: the state cookie is written and read by this module
// within one process lifetime (the auth redirect round-trip takes seconds)
const STATE_SECRET = process.env.SESSION_SECRET || randomBytes(24).toString('hex')

export const oidcEnabled = () => !!ISSUER && !!CLIENT_ID
export const oidcLabel = () => process.env.OIDC_LABEL || 'SSO'

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url')
const hmac = (s: string) => createHmac('sha256', STATE_SECRET).update(s).digest('base64url')
const sha256 = (s: string) => createHash('sha256').update(s).digest()

// ---------- discovery + JWKS (cached, refreshed hourly) ----------

interface Discovery {
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  issuer: string
}

let discovery: { doc: Discovery; at: number } | null = null
let jwks: { keys: Record<string, unknown>[]; at: number } | null = null

async function getDiscovery(): Promise<Discovery> {
  if (discovery && Date.now() - discovery.at < 3600_000) return discovery.doc
  const res = await fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(6000) })
  if (!res.ok) throw new Error(`discovery ${res.status}`)
  const doc = (await res.json()) as Discovery
  discovery = { doc, at: Date.now() }
  return doc
}

async function getJwks(uri: string, forceFresh = false): Promise<Record<string, unknown>[]> {
  if (!forceFresh && jwks && Date.now() - jwks.at < 3600_000) return jwks.keys
  const res = await fetch(uri, { signal: AbortSignal.timeout(6000) })
  if (!res.ok) throw new Error(`jwks ${res.status}`)
  const doc = (await res.json()) as { keys: Record<string, unknown>[] }
  jwks = { keys: doc.keys ?? [], at: Date.now() }
  return jwks.keys
}

// ---------- ID-token validation (RS256 / PS256 / ES256) ----------

interface IdClaims {
  iss: string
  aud: string | string[]
  sub: string
  exp: number
  nonce?: string
  email?: string
  preferred_username?: string
  name?: string
}

function verifyJwt(token: string, keys: Record<string, unknown>[]): IdClaims {
  const [h, p, s] = token.split('.')
  if (!h || !p || !s) throw new Error('malformed id_token')
  const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as { alg: string; kid?: string }
  const candidates = keys.filter((k) => !header.kid || k.kid === header.kid)
  if (!candidates.length) throw new Error('no matching jwk')
  const data = Buffer.from(`${h}.${p}`)
  const sig = Buffer.from(s, 'base64url')
  const ok = candidates.some((k) => {
    let key: KeyObject
    try {
      key = createPublicKey({ key: k as never, format: 'jwk' })
    } catch {
      return false
    }
    if (header.alg === 'RS256') return cryptoVerify('sha256', data, key, sig)
    if (header.alg === 'PS256')
      return cryptoVerify('sha256', data, { key, padding: 6 /* RSA_PKCS1_PSS_PADDING */ }, sig)
    if (header.alg === 'ES256') return cryptoVerify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig)
    return false
  })
  if (!ok) throw new Error(`signature check failed (${header.alg})`)
  return JSON.parse(Buffer.from(p, 'base64url').toString()) as IdClaims
}

// ---------- state cookie (CSRF + PKCE round-trip) ----------

interface OidcState {
  state: string
  nonce: string
  verifier: string
  next: string
  ts: number
}

function setStateCookie(reply: FastifyReply, st: OidcState, secure: boolean) {
  const payload = b64u(JSON.stringify(st))
  reply.header(
    'set-cookie',
    `${STATE_COOKIE}=${payload}.${hmac(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`,
  )
}

function readStateCookie(req: FastifyRequest): OidcState | null {
  const m = /(?:^|;\s*)pb_oidc=([^;]+)/.exec(req.headers.cookie ?? '')
  if (!m) return null
  const [payload, mac] = m[1].split('.')
  if (!payload || !mac || hmac(payload) !== mac) return null
  try {
    const st = JSON.parse(Buffer.from(payload, 'base64url').toString()) as OidcState
    return Date.now() - st.ts < STATE_TTL_MS ? st : null
  } catch {
    return null
  }
}

const clearStateCookie = (reply: FastifyReply) =>
  reply.header('set-cookie', `${STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)

// ---------- redirect URI ----------

function redirectUri(req: FastifyRequest): string {
  if (process.env.OIDC_REDIRECT_URL) return process.env.OIDC_REDIRECT_URL
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'http'
  const host = (req.headers['x-forwarded-host'] as string) ?? req.headers.host ?? 'localhost'
  return `${proto}://${host}${PUB}/api/auth/oidc/callback`
}

/** only same-app relative paths may be redirect targets after login */
const safeNext = (v: unknown): string =>
  typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : '/'

// ---------- handlers ----------

export async function oidcLogin(req: FastifyRequest, reply: FastifyReply) {
  if (!oidcEnabled()) return reply.code(404).send({ error: 'SSO not configured' })
  let doc: Discovery
  try {
    doc = await getDiscovery()
  } catch (e) {
    return reply.code(502).send({ error: `IdP discovery failed: ${(e as Error).message}` })
  }
  const st: OidcState = {
    state: b64u(randomBytes(24)),
    nonce: b64u(randomBytes(24)),
    verifier: b64u(randomBytes(48)),
    next: safeNext((req.query as Record<string, string>).next),
    ts: Date.now(),
  }
  setStateCookie(reply, st, req.headers['x-forwarded-proto'] === 'https')
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(req),
    scope: SCOPES,
    state: st.state,
    nonce: st.nonce,
    code_challenge: b64u(sha256(st.verifier)),
    code_challenge_method: 'S256',
  })
  return reply.redirect(`${doc.authorization_endpoint}?${q}`, 302)
}

export async function oidcCallback(req: FastifyRequest, reply: FastifyReply) {
  if (!oidcEnabled()) return reply.code(404).send({ error: 'SSO not configured' })
  const q = req.query as Record<string, string>
  const st = readStateCookie(req)
  // NB: one set-cookie slot per reply here — on success the session cookie
  // takes it and the 10-min state cookie just expires on its own
  if (q.error) {
    clearStateCookie(reply)
    return reply.code(401).send({ error: `IdP: ${q.error}${q.error_description ? ` — ${q.error_description}` : ''}` })
  }
  if (!st || !q.code || q.state !== st.state) {
    clearStateCookie(reply)
    return reply.code(400).send({ error: 'state mismatch — restart sign-in' })
  }

  try {
    const doc = await getDiscovery()
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: q.code,
      redirect_uri: redirectUri(req),
      client_id: CLIENT_ID,
      code_verifier: st.verifier,
      ...(CLIENT_SECRET ? { client_secret: CLIENT_SECRET } : {}),
    })
    const tokRes = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(8000),
    })
    if (!tokRes.ok) throw new Error(`token exchange ${tokRes.status}: ${(await tokRes.text()).slice(0, 160)}`)
    const tok = (await tokRes.json()) as { id_token?: string }
    if (!tok.id_token) throw new Error('token response carried no id_token')

    // validate against JWKS; retry once with a fresh key set (IdP key rotation)
    let claims: IdClaims
    try {
      claims = verifyJwt(tok.id_token, await getJwks(doc.jwks_uri))
    } catch {
      claims = verifyJwt(tok.id_token, await getJwks(doc.jwks_uri, true))
    }
    if (claims.iss !== (doc.issuer ?? ISSUER)) throw new Error('issuer mismatch')
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!aud.includes(CLIENT_ID)) throw new Error('audience mismatch')
    if (claims.exp * 1000 < Date.now()) throw new Error('id_token expired')
    if (claims.nonce && claims.nonce !== st.nonce) throw new Error('nonce mismatch')

    // JIT provisioning — same slug rule as createUser, so lookups stay stable
    const identity = (claims.email ?? claims.preferred_username ?? claims.sub).toLowerCase()
    const username = identity.replace(/[^a-z0-9_.-]+/g, '').slice(0, 32)
    if (!username) throw new Error('claims carry no usable identity')
    if (!getUser(username)) {
      const admin = ADMIN_USERS.includes(identity) || ADMIN_USERS.includes(claims.sub.toLowerCase())
      createUser({
        username,
        displayName: claims.name ?? claims.preferred_username ?? identity,
        password: b64u(randomBytes(24)), // SSO-only account — local password unused
        roles: { '*': admin ? 'admin' : DEFAULT_ROLE },
      })
      console.log(`[oidc] provisioned ${username} (${admin ? 'admin' : DEFAULT_ROLE})`)
    }
    issueSession(req, reply, username)
    return reply.redirect(`${PUB}${st.next}` || '/', 302)
  } catch (e) {
    console.warn(`[oidc] callback failed: ${(e as Error).message}`)
    clearStateCookie(reply)
    return reply.code(401).send({ error: `SSO sign-in failed: ${(e as Error).message}` })
  }
}
