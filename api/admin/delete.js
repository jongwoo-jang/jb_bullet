const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const { requireAdmin } = require('../_auth');

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

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    });
    const { data: post, error: lookupError } = await supabase
      .from('fp_posts')
      .select('id, drive_file_id')
      .eq('id', body.id)
      .single();
    if (lookupError) throw new Error(lookupError.message);

    const driveFileId = body.driveFileId || post.drive_file_id;
    if (driveFileId) await deleteDriveFile(driveFileId);

    const { error: deleteError } = await supabase.from('fp_posts').delete().eq('id', body.id);
    if (deleteError) throw new Error(deleteError.message);

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || '삭제에 실패했습니다.' });
  }
};

function ensureServerConfig() {
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GOOGLE_CLIENT_EMAIL', 'GOOGLE_PRIVATE_KEY'];
  const missing = required.filter((key) => !process.env[key]);
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
  const drive = google.drive({ version: 'v3', auth: getGoogleAuth() });
  try {
    await drive.files.delete({ fileId });
  } catch (error) {
    if (error.code !== 404) throw error;
  }
}

function getGoogleAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive']
  });
}
