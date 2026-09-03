// Session auth — HMAC-signed cookie, no external deps. Anonymous requests
// carry the viewer role while PB_PUBLIC_VIEW allows it (public demo);
// PB_PUBLIC_VIEW=0 gates every non-integration API behind a session.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { getUser, roleFor, ROLE_RANK, type Role, type UserRec, verifyPassword } from './config.js'

const SECRET = process.env.SESSION_SECRET || randomBytes(24).toString('hex')
// one warning for the whole process — oidc.ts shares this same env var for its
// state-cookie secret, so it deliberately does not emit a second line
if (!process.env.SESSION_SECRET)
  console.warn(
    '[auth] SESSION_SECRET is not set — using a random per-boot secret. Sessions and SSO state will ' +
      'not survive a restart and will differ across instances. Set SESSION_SECRET in production.',
  )
const COOKIE = 'pb_sess'
const TTL_MS = 7 * 24 * 3600_000

/** constant-time equality for HMAC/token strings — avoids the early-exit timing
 *  leak of `===`. Length-guarded so timingSafeEqual never throws on a mismatch. */
export function safeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export const PUBLIC_VIEW = process.env.PB_PUBLIC_VIEW !== '0'

// iframe embedding: a cross-site host page only sends our session cookie when
// it is SameSite=None (which mandates Secure → HTTPS deploys only). Default
// stays Lax for standalone deployments. PB_COOKIE_SAMESITE=none|lax|strict.
const SAMESITE = (() => {
  const v = (process.env.PB_COOKIE_SAMESITE ?? 'lax').toLowerCase()
  return v === 'none' ? 'None' : v === 'strict' ? 'Strict' : 'Lax'
})()

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url')
const sign = (payload: string) => createHmac('sha256', SECRET).update(payload).digest('base64url')

const secure = (req: FastifyRequest) =>
  SAMESITE === 'None' || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''

export function issueSession(req: FastifyRequest, reply: FastifyReply, username: string) {
  const payload = b64u(JSON.stringify({ u: username, exp: Date.now() + TTL_MS }))
  const token = `${payload}.${sign(payload)}`
  reply.header(
    'set-cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=${SAMESITE}; Max-Age=${Math.floor(TTL_MS / 1000)}${secure(req)}`,
  )
}

export function clearSession(reply: FastifyReply) {
  reply.header('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=${SAMESITE}; Max-Age=0${SAMESITE === 'None' ? '; Secure' : ''}`)
}

export function readSession(cookieHeader: string | undefined): UserRec | null {
  if (!cookieHeader) return null
  const m = /(?:^|;\s*)pb_sess=([^;]+)/.exec(cookieHeader)
  if (!m) return null
  const [payload, mac] = m[1].split('.')
  if (!payload || !mac || !safeStrEqual(sign(payload), mac)) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { u: string; exp: number }
    if (data.exp < Date.now()) return null
    return getUser(data.u)
  } catch {
    return null
  }
}

export function requestUser(req: FastifyRequest): UserRec | null {
  return readSession(req.headers.cookie)
}

// ---------- login throttle: 5 failures / 15 min per ip+user, then lockout ----------

const attempts = new Map<string, { fails: number; until: number }>()

export function loginThrottled(ip: string, username: string): boolean {
  const a = attempts.get(`${ip}|${username}`)
  return !!a && a.fails >= 5 && Date.now() < a.until
}

export function login(ip: string, username: string, password: string): UserRec | null {
  const key = `${ip}|${username}`
  const u = getUser(username)
  if (u && verifyPassword(u, password)) {
    attempts.delete(key)
    return u
  }
  const a = attempts.get(key) ?? { fails: 0, until: 0 }
  a.fails++
  a.until = Date.now() + 15 * 60_000
  attempts.set(key, a)
  // memory guard: drop only entries whose lockout window has elapsed — never
  // wipe the whole table, which would release every active lockout at once
  if (attempts.size > 5000) {
    const now = Date.now()
    for (const [k, v] of attempts) if (v.until < now) attempts.delete(k)
  }
  return null
}

/** fastify preHandler enforcing a minimum role on the :siteId in the route
 *  (routes without :siteId — sites/users admin — pass only for '*' admins) */
export function requireRole(min: Role) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const siteId = (req.params as { siteId?: string }).siteId ?? ''
    const user = requestUser(req)
    const role = roleFor(user, siteId)
    if (ROLE_RANK[role] >= ROLE_RANK[min]) return
    if (!user) return reply.code(401).send({ error: 'sign in required', need: min })
    return reply.code(403).send({ error: `requires ${min} role on ${siteId || 'platform'}`, need: min, have: role })
  }
}

export function publicUser(u: UserRec | null) {
  return u ? { username: u.username, displayName: u.displayName, roles: u.roles } : null
}
