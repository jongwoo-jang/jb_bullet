const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { normalizeSupabaseUrl } = require('./_supabase-url');

const SETTING_KEY = 'public_passcode_hash';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 14;

function getSupabaseAdmin() {
  return createClient(normalizeSupabaseUrl(process.env.SUPABASE_URL), process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
}

function normalizePasscode(value) {
  return String(value || '').trim();
}

function isValidPasscode(value) {
  return /^\d{4}$/.test(normalizePasscode(value));
}

function hashPasscode(value) {
  return crypto.createHash('sha256').update(normalizePasscode(value)).digest('hex');
}

async function getPasscodeHash(supabase = getSupabaseAdmin()) {
  const { data, error } = await supabase
    .from('fp_settings')
    .select('value')
    .eq('key', SETTING_KEY)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data && data.value ? data.value : '';
}

async function setPasscode(value, supabase = getSupabaseAdmin()) {
  if (!isValidPasscode(value)) throw new Error('4자리 숫자 비밀번호를 입력해 주세요.');
  const { error } = await supabase
    .from('fp_settings')
    .upsert({ key: SETTING_KEY, value: hashPasscode(value), updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
}

async function verifyPasscode(value, supabase = getSupabaseAdmin()) {
  if (!isValidPasscode(value)) return false;
  const storedHash = await getPasscodeHash(supabase);
  if (!storedHash) return false;
  return timingSafeEqual(hashPasscode(value), storedHash);
}

function createAccessToken() {
  const payload = {
    typ: 'public',
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
  };
  const body = toBase64Url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

function verifyAccessToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return false;
  const [body, signature] = parts;
  try {
    if (!timingSafeEqual(sign(body), signature)) return false;
    const payload = JSON.parse(Buffer.from(fromBase64Url(body), 'base64').toString('utf8'));
    return payload.typ === 'public' && Number(payload.exp || 0) > Math.floor(Date.now() / 1000);
  } catch (error) {
    return false;
  }
}

function getBearerToken(req) {
  const value = req.headers.authorization || req.headers.Authorization || '';
  const match = String(value).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

function requirePublicAccess(req) {
  if (!verifyAccessToken(getBearerToken(req))) {
    return { error: { status: 401, message: '다시 접속 비밀번호를 입력해 주세요.' } };
  }
  return { ok: true };
}

function sign(value) {
  return crypto.createHmac('sha256', getSecret()).update(value).digest('base64url');
}

function getSecret() {
  const secret = String(process.env.PUBLIC_ACCESS_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!secret) throw new Error('PUBLIC_ACCESS_SECRET 또는 SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.');
  return secret;
}

function toBase64Url(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function fromBase64Url(value) {
  return value.replace(/-/g, '+').replace(/_/g, '/');
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error('요청 본문이 올바른 JSON이 아닙니다.'));
      }
    });
    req.on('error', reject);
  });
}

module.exports = {
  createAccessToken,
  getPasscodeHash,
  getSupabaseAdmin,
  isValidPasscode,
  readJson,
  requirePublicAccess,
  setPasscode,
  verifyPasscode
};
