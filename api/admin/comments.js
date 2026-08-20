const { requireAdmin } = require('../_auth');
const { readJson } = require('../_public-access');

module.exports = async function handler(req, res) {
  const admin = await requireAdmin(req);
  if (admin.error) return res.status(admin.error.status).json({ error: admin.error.message });

  if (req.method === 'GET') return listComments(admin.supabase, res);
  if (req.method === 'POST' || req.method === 'DELETE') return deleteComment(req, admin.supabase, res);

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
};

async function listComments(supabase, res) {
  try {
    const { data: comments, error } = await supabase
      .from('fp_comments')
      .select('id, post_id, author, text, created_at')
      .order('created_at', { ascending: false })
      .limit(300);
    if (error) throw new Error(error.message);

    const postIds = [...new Set((comments || []).map((item) => item.post_id).filter(Boolean))];
    const titleByPostId = await getPostTitles(supabase, postIds);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      comments: (comments || []).map((item) => ({
        ...item,
        post_title: titleByPostId.get(String(item.post_id)) || ''
      }))
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || '댓글을 불러오지 못했습니다.' });
  }
}

async function getPostTitles(supabase, postIds) {
  const titleByPostId = new Map();
  if (!postIds.length) return titleByPostId;
  const { data, error } = await supabase
    .from('fp_posts')
    .select('id, title')
    .in('id', postIds);
  if (error) throw new Error(error.message);
  (data || []).forEach((post) => titleByPostId.set(String(post.id), post.title || ''));
  return titleByPostId;
}

async function deleteComment(req, supabase, res) {
  try {
    const body = await readJson(req);
    const id = body.id;
    if (!id) return res.status(400).json({ error: '댓글 ID가 필요합니다.' });

    const { error } = await supabase.from('fp_comments').delete().eq('id', id);
    if (error) throw new Error(error.message);

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || '댓글 삭제에 실패했습니다.' });
  }
}
