import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}. See .env.example.`);
  return v;
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  sessionSecret: required('SESSION_SECRET'),
  ms: {
    tenantId: required('MS_TENANT_ID'),
    clientId: required('MS_CLIENT_ID'),
    clientSecret: required('MS_CLIENT_SECRET'),
  },
};

export const isProd = config.nodeEnv === 'production';
