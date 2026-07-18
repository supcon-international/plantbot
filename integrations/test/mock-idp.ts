// Minimal OIDC identity provider for tests and local SSO development:
// discovery + authorize (auto-approve) + token (code exchange w/ PKCE check)
// + JWKS, signing RS256 ID tokens with an in-memory keypair. No consent UI —
// /authorize immediately 302s back with a code, which makes full-flow e2e
// possible with plain fetch (redirect: 'manual').
//
// Dev usage (browser SSO against the local stack):
//   OIDC_ISSUER=http://127.0.0.1:8976 OIDC_CLIENT_ID=plantbot pnpm dev
//   npx tsx integrations/test/mock-idp.ts        # serves :8976

import { createServer, type Server } from 'node:http'
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto'

export interface MockUser {
  sub: string
  email?: string
  name?: string
}

export interface MockIdp {
  issuer: string
  setUser: (u: MockUser) => void
  stop: () => void
  server: Server
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url')

export function startMockIdp(port: number, user: MockUser = { sub: 'u-1', email: 'alice@corp.com', name: 'Alice' }): Promise<MockIdp> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>
  const kid = 'mock-1'
  const issuer = `http://127.0.0.1:${port}`
  let current = user
  // code → what the ID token must carry / what the exchange must prove
  const codes = new Map<string, { nonce?: string; challenge?: string; clientId: string }>()

  const signIdToken = (aud: string, nonce?: string) => {
    const header = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }))
    const now = Math.floor(Date.now() / 1000)
    const payload = b64u(
      JSON.stringify({
        iss: issuer,
        aud,
        sub: current.sub,
        email: current.email,
        name: current.name,
        nonce,
        iat: now,
        exp: now + 300,
      }),
    )
    const sig = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey)
    return `${header}.${payload}.${b64u(sig)}`
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer)
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (url.pathname === '/.well-known/openid-configuration')
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        id_token_signing_alg_values_supported: ['RS256'],
      })

    if (url.pathname === '/jwks') return json(200, { keys: [{ ...jwk, kid, use: 'sig', alg: 'RS256' }] })

    if (url.pathname === '/authorize') {
      const redirect = url.searchParams.get('redirect_uri')
      const state = url.searchParams.get('state') ?? ''
      if (!redirect) return json(400, { error: 'redirect_uri required' })
      const code = b64u(randomBytes(16))
      codes.set(code, {
        nonce: url.searchParams.get('nonce') ?? undefined,
        challenge: url.searchParams.get('code_challenge') ?? undefined,
        clientId: url.searchParams.get('client_id') ?? '',
      })
      const loc = new URL(redirect)
      loc.searchParams.set('code', code)
      loc.searchParams.set('state', state)
      res.writeHead(302, { location: loc.toString() })
      return res.end()
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const form = new URLSearchParams(body)
        const grant = codes.get(form.get('code') ?? '')
        if (!grant) return json(400, { error: 'invalid_grant' })
        codes.delete(form.get('code')!)
        if (grant.challenge) {
          const verifier = form.get('code_verifier') ?? ''
          if (b64u(createHash('sha256').update(verifier).digest()) !== grant.challenge)
            return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
        }
        return json(200, {
          access_token: b64u(randomBytes(12)),
          token_type: 'Bearer',
          expires_in: 300,
          id_token: signIdToken(form.get('client_id') ?? grant.clientId, grant.nonce),
        })
      })
      return
    }

    json(404, { error: 'not found' })
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({ issuer, server, setUser: (u) => (current = u), stop: () => server.close() }),
    )
  })
}

// standalone: `npx tsx integrations/test/mock-idp.ts [port]`
if (process.argv[1]?.endsWith('mock-idp.ts')) {
  const port = Number(process.argv[2] ?? 8976)
  void startMockIdp(port).then((idp) => console.log(`[mock-idp] ${idp.issuer} — auto-approves alice@corp.com`))
}
