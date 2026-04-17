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
}

declare module '@fastify/secure-session' {
  interface SessionData {
    user: SessionUser;
    oauthState: string;
    oauthReturnTo: string;
  }
}

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

    const user: SessionUser = {
      name: account.name ?? account.username,
      email: account.username,
      oid: String(claims.oid ?? account.homeAccountId),
      tenantId: tid,
      loggedInAt: Date.now(),
    };
    req.session.set('user', user);
    req.session.set('oauthState', undefined);

    const returnTo = req.session.get('oauthReturnTo') ?? '/staff';
    req.session.set('oauthReturnTo', undefined);
    return reply.redirect(returnTo);
  });

  app.post('/auth/logout', async (req, reply) => {
    req.session.delete();
    return reply.redirect('/');
  });

  app.get('/api/me', async (req, reply) => {
    const user = req.session.get('user');
    if (!user) return reply.code(401).send({ error: 'not_authenticated' });
    return { user };
  });
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const user = req.session.get('user');
  if (!user) {
    const target = encodeURIComponent(req.url);
    return reply.redirect(`/auth/login?returnTo=${target}`);
  }
}
