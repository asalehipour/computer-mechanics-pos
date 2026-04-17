import { ConfidentialClientApplication, type AuthenticationResult } from '@azure/msal-node';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';

const msal = new ConfidentialClientApplication({
  auth: {
    clientId: config.ms.clientId,
    authority: `https://login.microsoftonline.com/${config.ms.tenantId}`,
    clientSecret: config.ms.clientSecret,
  },
});

const SCOPES = ['openid', 'profile', 'email', 'User.Read'];
const REDIRECT_URI = `${config.publicBaseUrl}/auth/callback`;

export interface SessionUser {
  name: string;
  email: string;
  oid: string;
  tenantId: string;
  loggedInAt: number;
  /**
   * Per-login nonce used to enforce single-session-per-user. The server keeps
   * the latest nonce for each user in `currentNonce`; any session whose nonce
   * doesn't match is treated as invalidated (the user logged in elsewhere).
   */
  sessionNonce: string;
}

declare module '@fastify/secure-session' {
  interface SessionData {
    user: SessionUser;
    oauthState: string;
    oauthReturnTo: string;
  }
}

/**
 * Latest valid nonce per user `oid`. Set at login; checked on every
 * authenticated request. When a user logs in somewhere else, the old session's
 * nonce no longer matches and that session is kicked. In-memory only — a
 * server restart logs everyone out, which is an acceptable tradeoff for a POS.
 */
const currentNonce = new Map<string, string>();

export function registerAuth(app: FastifyInstance) {
  app.get('/auth/login', async (req, reply) => {
    const state = crypto.randomUUID();
    req.session.set('oauthState', state);
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const returnTo = q.returnTo ?? '/staff';
    req.session.set('oauthReturnTo', returnTo);

    const url = await msal.getAuthCodeUrl({
      scopes: SCOPES,
      redirectUri: REDIRECT_URI,
      state,
      prompt: 'select_account',
    });
    return reply.redirect(url);
  });

  app.get('/auth/callback', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    if (q.error) {
      return reply.code(400).send(`Microsoft login error: ${q.error_description ?? q.error}`);
    }
    if (!q.code) return reply.code(400).send('Missing auth code');

    const expectedState = req.session.get('oauthState');
    if (!expectedState || q.state !== expectedState) {
      return reply.code(400).send('Invalid OAuth state — possible CSRF or expired login.');
    }

    let result: AuthenticationResult | null;
    try {
      result = await msal.acquireTokenByCode({
        code: q.code,
        scopes: SCOPES,
        redirectUri: REDIRECT_URI,
      });
    } catch (err) {
      req.log.error({ err }, 'Token exchange failed');
      return reply.code(500).send('Authentication failed. Check server logs.');
    }
    if (!result || !result.account) {
      return reply.code(500).send('No account returned from Microsoft.');
    }

    const { account, idTokenClaims } = result;
    const claims = (idTokenClaims ?? {}) as Record<string, unknown>;
    const tid = String(claims.tid ?? '');

    if (tid && tid !== config.ms.tenantId) {
      return reply.code(403).send('Account not in the Computer Mechanics tenant.');
    }

    const oid = String(claims.oid ?? account.homeAccountId);

    // Generate a new nonce and record it as the sole valid one for this user.
    // Any prior session with a different nonce will be rejected by requireAuth
    // on its next request — that's how "logging in elsewhere kicks the front
    // counter out" works.
    const sessionNonce = crypto.randomUUID();
    currentNonce.set(oid, sessionNonce);

    const user: SessionUser = {
      name: account.name ?? account.username,
      email: account.username,
      oid,
      tenantId: tid,
      loggedInAt: Date.now(),
      sessionNonce,
    };
    req.session.set('user', user);
    req.session.set('oauthState', undefined);

    const returnTo = req.session.get('oauthReturnTo') ?? '/staff';
    req.session.set('oauthReturnTo', undefined);
    return reply.redirect(returnTo);
  });

  app.post('/auth/logout', async (req, reply) => {
    const user = req.session.get('user');
    if (user && currentNonce.get(user.oid) === user.sessionNonce) {
      // Only clear the nonce if this session was the winning one — avoids a
      // stale logout blowing away a freshly-logged-in other session.
      currentNonce.delete(user.oid);
    }
    req.session.delete();
    return reply.redirect('/');
  });

  app.get('/api/me', async (req, reply) => {
    const user = req.session.get('user');
    if (!user) return reply.code(401).send({ error: 'not_authenticated' });
    if (currentNonce.get(user.oid) !== user.sessionNonce) {
      req.session.delete();
      return reply.code(401).send({ error: 'session_superseded' });
    }
    return { user };
  });
}

/**
 * Returns true if the session's nonce is still the winning one for its user,
 * i.e. they haven't logged in somewhere else since. Used by both HTTP
 * requireAuth and the WebSocket handshake.
 */
export function isSessionCurrent(user: SessionUser | undefined): boolean {
  if (!user) return false;
  return currentNonce.get(user.oid) === user.sessionNonce;
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const user = req.session.get('user');
  if (!user) {
    const target = encodeURIComponent(req.url);
    return reply.redirect(`/auth/login?returnTo=${target}`);
  }
  if (!isSessionCurrent(user)) {
    // Superseded — clear the stale session and force a fresh login.
    req.session.delete();
    const target = encodeURIComponent(req.url);
    return reply.redirect(`/auth/login?returnTo=${target}`);
  }
}
