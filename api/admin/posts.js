const { requireAdmin } = require('../_auth');

const PAGE_LIMIT = 500;

module.exports = async function handler(req, res) {
  const admin = await requireAdmin(req);
  if (admin.error) return res.status(admin.error.status).json({ error: admin.error.message });

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const supabase = admin.supabase;
    let { data, error } = await supabase
      .from('fp_posts')
      .select('*')
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(PAGE_LIMIT);
    if (isMissingPinnedColumn(error)) {
      const retry = await supabase
        .from('fp_posts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(PAGE_LIMIT);
      data = retry.data;
      error = retry.error;
    }
    if (error) throw new Error(error.message);

    const posts = await attachStats(supabase, data || []);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, posts });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || '등록 자료를 불러오지 못했습니다.' });
  }
};

async function attachStats(supabase, posts) {
  const ids = posts.map((post) => Number(post.id)).filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!ids.length) return posts.map((post) => ({ ...post, stats: defaultStats() }));
  const statsByPostId = new Map();
  try {
    const { data, error } = await supabase
      .from('fp_post_stats')
      .select('post_id, view_count, like_count, share_count, download_count, save_count')
      .in('post_id', ids);
    if (error) throw new Error(error.message);
    (data || []).forEach((row) => {
      statsByPostId.set(String(row.post_id), {
        view_count: Number(row.view_count || 0),
        like_count: Number(row.like_count || 0),
        share_count: Number(row.share_count || 0),
        download_count: Number(row.download_count || 0),
        save_count: Number(row.save_count || 0)
      });
    });
  } catch (error) {
    if (!isMissingStatsTable(error)) console.error('admin post stats skipped:', error.message || error);
  }
  return posts.map((post) => ({ ...post, stats: statsByPostId.get(String(post.id)) || defaultStats() }));
}

function defaultStats() {
  return {
    view_count: 0,
    like_count: 0,
    share_count: 0,
    download_count: 0,
    save_count: 0
  };
}

function isMissingPinnedColumn(error) {
  return Boolean(error && String(error.message || '').includes('is_pinned'));
}

function isMissingStatsTable(error) {
  const message = String(error && error.message || '');
  return message.includes('fp_post_stats') || message.includes('public.fp_post_stats');
}
