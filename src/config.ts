import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}. See .env.example.`);
  return v;
}

/**
 * Parse comma-separated env var into a lowercased email list. Empty / missing
 * is treated as "nobody is admin" — the backup/restore endpoints will 403.
 */
function parseEmailList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  sessionSecret: required('SESSION_SECRET'),
  /**
   * Staff whose email is in this list can hit /api/admin/* (download backup,
   * restore). Restore is destructive, so keep this list tight — just the
   * business owners.
   */
  adminEmails: parseEmailList('ADMIN_EMAILS'),
  ms: {
    tenantId: required('MS_TENANT_ID'),
    clientId: required('MS_CLIENT_ID'),
    clientSecret: required('MS_CLIENT_SECRET'),
  },
};

export const isProd = config.nodeEnv === 'production';
