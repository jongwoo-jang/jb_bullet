const { requireAdmin } = require('./_auth');
const { getSupabaseAdmin, readJson, requirePublicAccess } = require('./_public-access');

module.exports = async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const adminMode = url.searchParams.get('admin') === '1';

  if (adminMode) {
    const admin = await requireAdmin(req);
    if (admin.error) return res.status(admin.error.status).json({ error: admin.error.message });
    if (req.method === 'GET') return listAdminComments(admin.supabase, res);
    if (req.method === 'POST' || req.method === 'DELETE') return deleteAdminComment(req, admin.supabase, res);
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const access = requirePublicAccess(req);
  if (access.error) return res.status(access.error.status).json({ error: access.error.message });

  if (req.method === 'GET') return listComments(req, res);
  if (req.method === 'POST') return createComment(req, res, access.payload);

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

async function createComment(req, res, member) {
  try {
    const body = await readJson(req);
    const postId = body.post_id;
    const text = String(body.text || '').trim();
    if (!postId) return res.status(400).json({ error: '게시물 ID가 필요합니다.' });
    if (!text) return res.status(400).json({ error: '댓글 내용을 입력해 주세요.' });

    const supabase = getSupabaseAdmin();
    const author = await resolveCommentAuthor(supabase, member);
    const { data, error } = await supabase
      .from('fp_comments')
      .insert({ post_id: postId, author, text })
      .select('*')
      .single();
    if (error) throw new Error(error.message);

    return res.status(201).json({ comment: data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || '댓글 저장에 실패했습니다.' });
  }
}

async function resolveCommentAuthor(supabase, member = {}) {
  const tokenName = normalizeDisplayName(member.displayName);
  if (tokenName) return tokenName;
  const codeNumber = normalizeCodeNumber(member.codeNumber);
  if (!codeNumber) return '회원';
  const { data, error } = await supabase
    .from('fp_members')
    .select('display_name')
    .eq('code_number', codeNumber)
    .maybeSingle();
  if (isMissingDisplayNameColumn(error)) return '회원';
  if (error) throw new Error(error.message);
  return normalizeDisplayName(data && data.display_name) || '회원';
}

function normalizeCodeNumber(value) {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function normalizeDisplayName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 30);
}

function isMissingDisplayNameColumn(error) {
  return Boolean(error && String(error.message || '').includes('display_name'));
}

async function listAdminComments(supabase, res) {
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

async function deleteAdminComment(req, supabase, res) {
  try {
    const body = await readJson(req);
    if (!body.id) return res.status(400).json({ error: '댓글 ID가 필요합니다.' });

    const { error } = await supabase.from('fp_comments').delete().eq('id', body.id);
    if (error) throw new Error(error.message);

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || '댓글 삭제에 실패했습니다.' });
  }
}
