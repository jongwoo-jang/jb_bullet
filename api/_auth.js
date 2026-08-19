const { createClient } = require('@supabase/supabase-js');
const { normalizeSupabaseUrl } = require('./_supabase-url');

function getSupabaseAdmin() {
  const url = normalizeSupabaseUrl(process.env.SUPABASE_URL);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.');
  return createClient(url, key, { auth: { persistSession: false } });
}

async function requireAdmin(req) {
  const supabase = getSupabaseAdmin();
  const token = getBearerToken(req);
  if (!token) return { error: { status: 401, message: '로그인이 필요합니다.' } };

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return { error: { status: 401, message: '로그인이 만료되었습니다.' } };

  const email = String(data.user.email || '').toLowerCase();
  const adminEmails = String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (!adminEmails.length) return { error: { status: 500, message: 'ADMIN_EMAILS 환경변수가 필요합니다.' } };
  if (!adminEmails.includes(email)) return { error: { status: 403, message: '관리자 권한이 없습니다.' } };

  return { user: data.user, supabase };
}

function getBearerToken(req) {
  const value = req.headers.authorization || req.headers.Authorization || '';
  const match = String(value).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

module.exports = { requireAdmin };
