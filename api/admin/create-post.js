const { createClient } = require('@supabase/supabase-js');
const { requireAdmin } = require('../_auth');
const { normalizeSupabaseUrl } = require('../_supabase-url');
const { getDrive, getMissingDriveEnv } = require('../_google-drive');

const MAX_FILES = 20;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const driveFileIds = [];
  try {
    const admin = await requireAdmin(req);
    if (admin.error) return res.status(admin.error.status).json({ error: admin.error.message });

    const missing = getMissingDriveEnv();
    if (missing.length) return res.status(500).json({ error: `${missing.join(', ')} 환경변수가 필요합니다.` });

    const body = await readJson(req);
    const files = Array.isArray(body.files) ? body.files.slice(0, MAX_FILES) : [];
    if (!files.length) return res.status(400).json({ error: '저장할 파일 정보가 없습니다.' });

    const attachments = [];
    for (const file of files) {
      const driveFileId = String(file.id || '');
      if (!driveFileId) return res.status(400).json({ error: 'Google Drive 파일 ID가 없습니다.' });
      driveFileIds.push(driveFileId);
      await makeDriveFilePublic(driveFileId);
      attachments.push(toAttachment(file));
    }

    const primary = attachments[0];
    const post = await insertPost({
      type: primary.type,
      title: String(body.title || primary.filename || '제목 없음').trim(),
      category: normalizeCategory(body.category),
      author: getAdminName(admin.user.email),
      tags: parseTags(body.tags),
      description: String(body.description || ''),
      media_url: primary.media_url,
      download_url: primary.download_url,
      web_view_url: primary.web_view_url,
      drive_file_id: primary.drive_file_id,
      storage_provider: 'google_drive',
      ratio: String(body.ratio || '1/1'),
      is_pinned: Boolean(body.isPinned),
      attachments
    }, Boolean(body.isPinned));

    return res.status(201).json({ post });
  } catch (error) {
    console.error(error);
    await Promise.all(driveFileIds.map((fileId) => safeDeleteDriveFile(fileId)));
    return res.status(500).json({ error: getCreatePostErrorMessage(error) });
  }
};

function toAttachment(file) {
  const mimeType = String(file.mimeType || file.mime_type || 'application/octet-stream');
  const driveFileId = String(file.id || file.drive_file_id || '');
  const type = mimeType === 'application/pdf' ? 'pdf' : 'image';
  return {
    type,
    filename: String(file.filename || file.name || 'upload'),
    mime_type: mimeType,
    media_url: driveThumbnailUrl(driveFileId),
    download_url: file.webContentLink || driveDownloadUrl(driveFileId),
    web_view_url: file.webViewLink || `https://drive.google.com/file/d/${driveFileId}/view`,
    drive_file_id: driveFileId,
    ratio: type === 'pdf' ? '3/4' : '1/1'
  };
}

async function makeDriveFilePublic(fileId) {
  await withDriveStage('share', () => getDrive().permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
    supportsAllDrives: true
  }));
}

async function insertPost(post, pinnedRequested = false) {
  return withDriveStage('database', async () => {
    const supabase = createClient(normalizeSupabaseUrl(process.env.SUPABASE_URL), process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    });
    let { data, error } = await supabase.from('fp_posts').insert(post).select('*').single();
    if (isMissingPinnedColumn(error) && !pinnedRequested) {
      const fallback = { ...post };
      delete fallback.is_pinned;
      const retry = await supabase.from('fp_posts').insert(fallback).select('*').single();
      data = retry.data;
      error = retry.error;
    }
    if (error) throw new Error(error.message);
    return data;
  });
}

async function safeDeleteDriveFile(fileId) {
  try {
    await getDrive().files.delete({ fileId, supportsAllDrives: true });
  } catch (error) {
    console.error('Failed to clean up Drive file', error);
  }
}

async function withDriveStage(stage, action) {
  try {
    return await action();
  } catch (error) {
    error.driveStage = stage;
    throw error;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 256 * 1024) reject(new Error('요청이 너무 큽니다.'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error('JSON 요청 형식이 올바르지 않습니다.'));
      }
    });
    req.on('error', reject);
  });
}

function normalizeCategory(value) {
  if (value === '공지' || value === '시상' || value === '복합') return value;
  return '상품';
}

function parseTags(value) {
  if (Array.isArray(value)) return value.map(String).map((tag) => tag.trim()).filter(Boolean);
  if (!value) return [];
  return String(value).split(',').map((tag) => tag.trim()).filter(Boolean);
}

function getAdminName(email) {
  const id = String(email || '').split('@')[0].toLowerCase();
  const names = { lemuel05: '장종우', jaguar06: '정환석' };
  return names[id] || id || '관리자';
}

function driveThumbnailUrl(fileId) {
  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w1200`;
}

function driveDownloadUrl(fileId) {
  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
}

function getCreatePostErrorMessage(error) {
  if (error.driveStage === 'share' && error.code === 403) {
    return '파일 업로드는 되었지만 공개 링크 권한 설정이 차단되었습니다. Google Drive 폴더의 링크 공유 설정을 확인해 주세요.';
  }
  if (error.driveStage === 'database') {
    if (String(error.message || '').includes('attachments')) {
      return 'Supabase fp_posts 테이블에 attachments 컬럼이 필요합니다. 최신 supabase-schema.sql을 SQL Editor에서 실행해 주세요.';
    }
    if (isMissingPinnedColumn(error)) {
      return 'Supabase fp_posts 테이블에 is_pinned 컬럼이 필요합니다. 최신 supabase-schema.sql을 SQL Editor에서 실행해 주세요.';
    }
    return `Supabase 게시물 저장에 실패했습니다: ${error.message}`;
  }
  return error.message || '게시물 저장에 실패했습니다.';
}

function isMissingPinnedColumn(error) {
  return Boolean(error && String(error.message || '').includes('is_pinned'));
}
