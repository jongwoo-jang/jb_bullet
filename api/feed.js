const { getSupabaseAdmin, readJson, requirePublicAccess } = require('./_public-access');
const { logActivity } = require('./_activity');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const access = requirePublicAccess(req);
  if (access.error) return res.status(access.error.status).json({ error: access.error.message });

  if (req.method === 'POST') return recordFeedActivity(req, res, access.payload);

  try {
    const supabase = getSupabaseAdmin();
    let { data, error } = await supabase
      .from('fp_posts')
      .select('*')
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false });
    if (isMissingPinnedColumn(error)) {
      const retry = await supabase.from('fp_posts').select('*').order('created_at', { ascending: false });
      data = retry.data;
      error = retry.error;
    }
    if (error) throw new Error(error.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ posts: data || [] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || '자료를 불러오지 못했습니다.' });
  }
};

async function recordFeedActivity(req, res, payload) {
  try {
    const body = await readJson(req);
    const eventType = String(body.eventType || '');
    if (eventType !== 'download' && eventType !== 'share') {
      return res.status(400).json({ error: 'Unsupported activity type' });
    }
    await logActivity(req, eventType, {
      actorRole: payload && payload.role === 'admin' ? 'admin' : 'member',
      actorCodeNumber: payload && payload.codeNumber,
      actorName: payload && payload.displayName,
      postId: body.postId,
      metadata: { source: 'feed' }
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || 'Activity logging failed' });
  }
}

function isMissingPinnedColumn(error) {
  return Boolean(error && String(error.message || '').includes('is_pinned'));
}
