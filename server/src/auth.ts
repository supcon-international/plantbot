// Session auth — HMAC-signed cookie, no external deps. Anonymous requests
// carry the viewer role (the public demo stays browsable); login elevates.

import { createHmac, randomBytes } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { getConfig, roleFor, ROLE_RANK, type Role, type UserRec, verifyPassword } from './config.js'

const SECRET = process.env.SESSION_SECRET || randomBytes(24).toString('hex')
const COOKIE = 'pb_sess'
const TTL_MS = 7 * 24 * 3600_000

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url')
const sign = (payload: string) => createHmac('sha256', SECRET).update(payload).digest('base64url')

export function issueSession(reply: FastifyReply, username: string) {
  const payload = b64u(JSON.stringify({ u: username, exp: Date.now() + TTL_MS }))
  const token = `${payload}.${sign(payload)}`
  reply.header(
    'set-cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(TTL_MS / 1000)}`,
  )
}

export function clearSession(reply: FastifyReply) {
  reply.header('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

export function readSession(cookieHeader: string | undefined): UserRec | null {
  if (!cookieHeader) return null
  const m = /(?:^|;\s*)pb_sess=([^;]+)/.exec(cookieHeader)
  if (!m) return null
  const [payload, mac] = m[1].split('.')
  if (!payload || !mac || sign(payload) !== mac) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { u: string; exp: number }
    if (data.exp < Date.now()) return null
    return getConfig().users.find((u) => u.username === data.u) ?? null
  } catch {
    return null
  }
}

export function requestUser(req: FastifyRequest): UserRec | null {
  return readSession(req.headers.cookie)
}

export function login(username: string, password: string): UserRec | null {
  const u = getConfig().users.find((x) => x.username === username)
  if (!u || !verifyPassword(u, password)) return null
  return u
}

/** fastify preHandler enforcing a minimum role on the :siteId in the route */
export function requireRole(min: Role) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const siteId = (req.params as { siteId?: string }).siteId ?? ''
    const user = requestUser(req)
    const role = roleFor(user, siteId)
    if (ROLE_RANK[role] >= ROLE_RANK[min]) return
    if (!user) return reply.code(401).send({ error: 'sign in required', need: min })
    return reply.code(403).send({ error: `requires ${min} role on ${siteId}`, need: min, have: role })
  }
}

export function publicUser(u: UserRec | null) {
  return u ? { username: u.username, displayName: u.displayName, roles: u.roles } : null
}
