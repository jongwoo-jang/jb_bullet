const { getSupabaseAdmin, requirePublicAccess } = require('./_public-access');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const access = requirePublicAccess(req);
  if (access.error) return res.status(access.error.status).json({ error: access.error.message });

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

function isMissingPinnedColumn(error) {
  return Boolean(error && String(error.message || '').includes('is_pinned'));
}
