const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('../_auth');
const { normalizeSupabaseUrl } = require('../_supabase-url');
const { getDrive, getMissingDriveEnv } = require('../_google-drive');
const { logActivity } = require('../_activity');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const admin = await requireAdmin(req);
    if (admin.error) return res.status(admin.error.status).json({ error: admin.error.message });
    ensureServerConfig();
    const body = await readJson(req);
    if (!body.id) return res.status(400).json({ error: '게시물 ID가 필요합니다.' });

    const supabase = createClient(normalizeSupabaseUrl(process.env.SUPABASE_URL), process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    });
    const { data: post, error: lookupError } = await supabase
      .from('fp_posts')
      .select('id, title, category, drive_file_id, attachments')
      .eq('id', body.id)
      .single();
    if (lookupError) throw new Error(lookupError.message);

    const driveFileIds = getDriveFileIds(post, body);
    await Promise.all(driveFileIds.map((fileId) => deleteDriveFile(fileId)));

    const { error: deleteError } = await supabase.from('fp_posts').delete().eq('id', body.id);
    if (deleteError) throw new Error(deleteError.message);

    await logActivity(req, 'post_delete', {
      actorRole: 'admin',
      actorName: getAdminName(admin.user.email),
      postId: post.id,
      metadata: { title: post.title, category: post.category }
    });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || '삭제에 실패했습니다.' });
  }
};

function ensureServerConfig() {
  const missing = getMissingDriveEnv();
  if (missing.length) throw new Error(`${missing.join(', ')} 환경변수가 필요합니다.`);
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

async function deleteDriveFile(fileId) {
  const drive = getDrive();
  try {
    await drive.files.delete({ fileId, supportsAllDrives: true });
  } catch (error) {
    if (error.code !== 404) throw error;
  }
}

function getDriveFileIds(post = {}, body = {}) {
  const ids = new Set();
  addDriveFileId(ids, body.driveFileId);
  addDriveFileId(ids, post.drive_file_id);
  const attachments = Array.isArray(post.attachments) ? post.attachments : [];
  attachments.forEach((item) => {
    addDriveFileId(ids, item && (item.drive_file_id || item.driveFileId));
  });
  return [...ids];
}

function addDriveFileId(ids, value) {
  const id = String(value || '').trim();
  if (id) ids.add(id);
}

function getAdminName(email) {
  const id = String(email || '').split('@')[0].toLowerCase();
  const names = { lemuel05: '장종우', jaguar06: '정환석' };
  return names[id] || id || '관리자';
}
