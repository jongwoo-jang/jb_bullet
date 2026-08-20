const crypto = require('crypto');
const { getSupabaseAdmin } = require('./_public-access');

const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_WINDOW_MINUTES = 10;
const MAX_METADATA_BYTES = 4096;

async function logActivity(req, eventType, details = {}) {
  try {
    const supabase = getSupabaseAdmin();
    const row = {
      event_type: eventType,
      actor_role: cleanText(details.actorRole || 'member', 24),
      actor_code_number: nullableText(details.actorCodeNumber, 80),
      actor_name: nullableText(details.actorName, 80),
      post_id: normalizePostId(details.postId),
      ip_hash: hashIp(getClientIp(req)),
      user_agent: cleanText(req && req.headers ? req.headers['user-agent'] : '', 500),
      metadata: trimMetadata(details.metadata || {})
    };
    const { error } = await supabase.from('fp_activity_logs').insert(row);
    if (error) throw new Error(error.message);
  } catch (error) {
    console.error('activity log skipped:', error.message || error);
  }
}

async function isLoginLimited(req, codeNumber) {
  try {
    const supabase = getSupabaseAdmin();
    const since = new Date(Date.now() - LOGIN_WINDOW_MINUTES * 60 * 1000).toISOString();
    const query = supabase
      .from('fp_activity_logs')
      .select('id', { count: 'exact', head: true })
      .eq('event_type', 'login_failed')
      .gte('created_at', since);
    if (codeNumber) query.eq('actor_code_number', codeNumber);
    const { count, error } = await query;
    if (error) throw new Error(error.message);
    return Number(count || 0) >= LOGIN_FAILURE_LIMIT;
  } catch (error) {
    console.error('login limit skipped:', error.message || error);
    return false;
  }
}

function getClientIp(req) {
  const forwarded = req && req.headers ? req.headers['x-forwarded-for'] : '';
  return String(forwarded || '').split(',')[0].trim()
    || String(req && req.headers ? req.headers['x-real-ip'] || '' : '').trim()
    || String(req && req.socket ? req.socket.remoteAddress || '' : '').trim();
}

function hashIp(value) {
  const ip = String(value || '').trim();
  if (!ip) return null;
  const secret = String(process.env.PUBLIC_ACCESS_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'fp-lounge').trim();
  return crypto.createHmac('sha256', secret).update(ip).digest('hex');
}

function normalizePostId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function nullableText(value, max) {
  const text = cleanText(value, max);
  return text || null;
}

function cleanText(value, max) {
  return String(value || '').trim().slice(0, max);
}

function trimMetadata(value) {
  try {
    const json = JSON.stringify(value || {});
    if (Buffer.byteLength(json, 'utf8') <= MAX_METADATA_BYTES) return value || {};
    return { truncated: true };
  } catch (error) {
    return { invalid: true };
  }
}

module.exports = {
  LOGIN_FAILURE_LIMIT,
  LOGIN_WINDOW_MINUTES,
  isLoginLimited,
  logActivity
};
