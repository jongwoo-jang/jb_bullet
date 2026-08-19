const { getSupabaseAdmin, readJson, requirePublicAccess } = require('./_public-access');

module.exports = async function handler(req, res) {
  const access = requirePublicAccess(req);
  if (access.error) return res.status(access.error.status).json({ error: access.error.message });

  if (req.method === 'GET') return listComments(req, res);
  if (req.method === 'POST') return createComment(req, res);

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};

async function listComments(req, res) {
  try {
    const postId = new URL(req.url, `https://${req.headers.host}`).searchParams.get('post_id');
    if (!postId) return res.status(400).json({ error: '게시물 ID가 필요합니다.' });

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('fp_comments')
      .select('*')
      .eq('post_id', postId)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ comments: data || [] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || '댓글을 불러오지 못했습니다.' });
  }
}

async function createComment(req, res) {
  try {
    const body = await readJson(req);
    const postId = body.post_id;
    const text = String(body.text || '').trim();
    if (!postId) return res.status(400).json({ error: '게시물 ID가 필요합니다.' });
    if (!text) return res.status(400).json({ error: '댓글 내용을 입력해 주세요.' });

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('fp_comments')
      .insert({ post_id: postId, author: '방문자', text })
      .select('*')
      .single();
    if (error) throw new Error(error.message);

    return res.status(201).json({ comment: data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || '댓글 저장에 실패했습니다.' });
  }
}
