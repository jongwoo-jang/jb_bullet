const { normalizeSupabaseUrl } = require('./_supabase-url');

const REQUIRED_SERVER_ENV = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GOOGLE_CLIENT_EMAIL',
  'GOOGLE_PRIVATE_KEY',
  'GOOGLE_DRIVE_FOLDER_ID',
  'ADMIN_EMAILS'
];

function hasEnv(name) {
  return Boolean(String(process.env[name] || '').trim());
}

function getMissingEnv(names) {
  return names.filter((name) => !hasEnv(name));
}

function getEnvStatus() {
  return {
    SUPABASE_URL: Boolean(normalizeSupabaseUrl(process.env.SUPABASE_URL)),
    SUPABASE_PUBLISHABLE_KEY: hasEnv('SUPABASE_PUBLISHABLE_KEY') || hasEnv('SUPABASE_ANON_KEY'),
    SUPABASE_SERVICE_ROLE_KEY: hasEnv('SUPABASE_SERVICE_ROLE_KEY'),
    GOOGLE_CLIENT_EMAIL: hasEnv('GOOGLE_CLIENT_EMAIL'),
    GOOGLE_PRIVATE_KEY: hasEnv('GOOGLE_PRIVATE_KEY'),
    GOOGLE_DRIVE_FOLDER_ID: hasEnv('GOOGLE_DRIVE_FOLDER_ID'),
    ADMIN_EMAILS: hasEnv('ADMIN_EMAILS'),
    MAX_UPLOAD_BYTES: hasEnv('MAX_UPLOAD_BYTES')
  };
}

module.exports = { REQUIRED_SERVER_ENV, getEnvStatus, getMissingEnv, hasEnv };
