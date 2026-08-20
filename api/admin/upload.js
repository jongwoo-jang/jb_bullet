const { createClient } = require('@supabase/supabase-js');
const Busboy = require('busboy');
const { Readable } = require('stream');
const { requireAdmin } = require('../_auth');
const { normalizeSupabaseUrl } = require('../_supabase-url');
const { getDrive, getDriveAuthMode, getMissingDriveEnv } = require('../_google-drive');

const MAX_FILE_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 100 * 1024 * 1024);
const ALLOWED_MIME_PREFIXES = ['image/'];
const ALLOWED_MIME_TYPES = ['application/pdf'];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uploadedDriveFileIds = [];
  try {
    const admin = await requireAdmin(req);
    if (admin.error) return res.status(admin.error.status).json({ error: admin.error.message });
    ensureServerConfig();
    const { fields, files } = await parseMultipart(req);
    if (!files.length) return res.status(400).json({ error: '파일이 없습니다.' });
    files.forEach((file) => {
      if (!isAllowedMime(file.mimeType)) throw new Error('이미지 또는 PDF만 업로드할 수 있습니다.');
    });

    const attachments = [];
    for (const file of files) {
      const driveFile = await withDriveStage('upload', () => uploadToDrive(file));
      uploadedDriveFileIds.push(driveFile.id);
      await withDriveStage('share', () => makeDriveFilePublic(driveFile.id));
      attachments.push(toAttachment(file, driveFile));
    }

    const primary = attachments[0];
    const postType = primary.type;

    const post = await withDriveStage('database', () => insertPost({
      type: postType,
      title: firstField(fields.title) || files[0].filename,
      category: normalizeCategory(firstField(fields.category)),
      author: getAdminName(admin.user.email),
      tags: parseTags(firstField(fields.tags)),
      description: firstField(fields.description),
      media_url: primary.media_url,
      download_url: primary.download_url,
      web_view_url: primary.web_view_url,
      drive_file_id: primary.drive_file_id,
      storage_provider: 'google_drive',
      ratio: firstField(fields.ratio) || '1/1',
      attachments
    }));

    return res.status(201).json({ post });
  } catch (error) {
    console.error(error);
    await Promise.all(uploadedDriveFileIds.map((fileId) => safeDeleteDriveFile(fileId)));
    return res.status(500).json({ error: getUploadErrorMessage(error) });
  }
};

function ensureServerConfig() {
  const missing = getMissingDriveEnv();
  if (missing.length) throw new Error(`${missing.join(', ')} 환경변수가 필요합니다.`);
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const uploadedFiles = [];
    const busboy = Busboy({
      headers: req.headers,
      limits: { files: 20, fileSize: MAX_FILE_BYTES, fields: 12 }
    });

    busboy.on('field', (name, value) => {
      fields[name] = value;
    });

    busboy.on('file', (name, stream, info) => {
      const chunks = [];
      stream.on('data', (chunk) => {
        chunks.push(chunk);
      });
      stream.on('limit', () => {
        reject(new Error('업로드 가능한 파일 크기를 초과했습니다.'));
      });
      stream.on('end', () => {
        const buffer = Buffer.concat(chunks);
        uploadedFiles.push({
          fieldName: name,
          filename: info.filename || 'upload',
          mimeType: info.mimeType || 'application/octet-stream',
          buffer,
          size: buffer.length
        });
      });
    });

    busboy.on('error', reject);
    busboy.on('finish', () => resolve({ fields, files: uploadedFiles }));
    req.pipe(busboy);
  });
}

function toAttachment(file, driveFile) {
  const type = file.mimeType === 'application/pdf' ? 'pdf' : 'image';
  return {
    type,
    filename: file.filename,
    mime_type: file.mimeType,
    media_url: driveThumbnailUrl(driveFile.id),
    download_url: driveFile.webContentLink || driveDownloadUrl(driveFile.id),
    web_view_url: driveFile.webViewLink || `https://drive.google.com/file/d/${driveFile.id}/view`,
    drive_file_id: driveFile.id,
    ratio: type === 'pdf' ? '3/4' : '1/1'
  };
}

async function uploadToDrive(file) {
  const drive = getDrive();
  const safeName = sanitizeFilename(file.filename);
  const result = await drive.files.create({
    requestBody: {
      name: `${Date.now()}-${safeName}`,
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
      mimeType: file.mimeType
    },
    media: {
      mimeType: file.mimeType,
      body: Readable.from(file.buffer)
    },
    fields: 'id,name,mimeType,webViewLink,webContentLink',
    supportsAllDrives: true
  });
  return result.data;
}

async function withDriveStage(stage, action) {
  try {
    return await action();
  } catch (error) {
    error.driveStage = stage;
    throw error;
  }
}

function getUploadErrorMessage(error) {
  if (error.driveStage === 'upload' && error.code === 404) {
    if (getDriveAuthMode() === 'oauth') {
      return 'Google Drive 폴더를 찾지 못했습니다. GOOGLE_DRIVE_FOLDER_ID 값과 OAuth로 연결한 Google 계정의 폴더 접근 권한을 확인해 주세요.';
    }
    return 'Google Drive 폴더를 찾지 못했습니다. GOOGLE_DRIVE_FOLDER_ID 값과 서비스 계정 폴더 공유 권한을 확인해 주세요.';
  }
  if (error.driveStage === 'upload' && error.code === 403) {
    const reason = getDriveReason(error);
    if (reason === 'storageQuotaExceeded' || String(error.message || '').includes('Service Accounts do not have storage quota')) {
      return '서비스 계정은 개인 Google Drive 용량으로 업로드할 수 없습니다. Google OAuth 방식으로 GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN을 설정해 주세요.';
    }
    if (getDriveAuthMode() === 'oauth') {
      return 'Google Drive 업로드 권한이 없습니다. OAuth로 연결한 Google 계정이 Drive 폴더에 파일을 추가할 수 있는지 확인해 주세요.';
    }
    return 'Google Drive 업로드 권한이 없습니다. 서비스 계정을 Drive 폴더에 편집자로 공유했는지 확인해 주세요.';
  }
  if (error.driveStage === 'share' && error.code === 403) {
    return '파일 업로드는 되었지만 공개 링크 권한 설정이 차단되었습니다. Google Drive 폴더의 링크 공유 설정을 확인해 주세요.';
  }
  if (error.driveStage === 'database') {
    if (String(error.message || '').includes('attachments')) {
      return 'Supabase fp_posts 테이블에 attachments 컬럼이 필요합니다. 최신 supabase-schema.sql을 SQL Editor에서 실행해 주세요.';
    }
    return `Supabase 게시물 저장에 실패했습니다: ${error.message}`;
  }
  return error.message || '업로드에 실패했습니다.';
}

async function makeDriveFilePublic(fileId) {
  const drive = getDrive();
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
    supportsAllDrives: true
  });
}

async function safeDeleteDriveFile(fileId) {
  try {
    const drive = getDrive();
    await drive.files.delete({ fileId, supportsAllDrives: true });
  } catch (error) {
    console.error('Failed to clean up Drive file', error);
  }
}

async function insertPost(post) {
  const supabase = createClient(normalizeSupabaseUrl(process.env.SUPABASE_URL), process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
  const { data, error } = await supabase.from('fp_posts').insert(post).select('*').single();
  if (error) throw new Error(error.message);
  return data;
}

function isAllowedMime(mimeType) {
  return ALLOWED_MIME_TYPES.includes(mimeType) || ALLOWED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
}

function normalizeCategory(value) {
  if (value === '시상' || value === '복합') return value;
  return '상품';
}

function parseTags(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).map((tag) => tag.trim()).filter(Boolean);
  } catch (error) {
    return value.split(',').map((tag) => tag.trim()).filter(Boolean);
  }
  return [];
}

function firstField(value) {
  return Array.isArray(value) ? value[0] : value;
}

function getAdminName(email) {
  const id = String(email || '').split('@')[0].toLowerCase();
  const names = { lemuel05: '장종우', jaguar06: '정환석' };
  return names[id] || id || '관리자';
}

function sanitizeFilename(filename) {
  return String(filename).replace(/[\\/:*?"<>|]/g, '-').slice(0, 120);
}

function driveThumbnailUrl(fileId) {
  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w1200`;
}

function driveDownloadUrl(fileId) {
  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
}

function getDriveReason(error) {
  return error && error.errors && error.errors[0] ? error.errors[0].reason : '';
}
