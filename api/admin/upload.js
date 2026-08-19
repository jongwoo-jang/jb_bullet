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

  let uploadedDriveFileId = null;
  try {
    const admin = await requireAdmin(req);
    if (admin.error) return res.status(admin.error.status).json({ error: admin.error.message });
    ensureServerConfig();
    const { fields, file } = await parseMultipart(req);
    if (!file) return res.status(400).json({ error: '파일이 없습니다.' });
    if (!isAllowedMime(file.mimeType)) return res.status(400).json({ error: '이미지 또는 PDF만 업로드할 수 있습니다.' });

    const postType = file.mimeType === 'application/pdf' ? 'pdf' : 'image';
    const driveFile = await withDriveStage('upload', () => uploadToDrive(file));
    uploadedDriveFileId = driveFile.id;
    await withDriveStage('share', () => makeDriveFilePublic(driveFile.id));

    const downloadUrl = driveFile.webContentLink || driveDownloadUrl(driveFile.id);
    const webViewUrl = driveFile.webViewLink || `https://drive.google.com/file/d/${driveFile.id}/view`;
    const mediaUrl = postType === 'image' ? driveThumbnailUrl(driveFile.id) : webViewUrl;

    const post = await withDriveStage('database', () => insertPost({
      type: postType,
      title: firstField(fields.title) || file.filename,
      category: normalizeCategory(firstField(fields.category)),
      author: firstField(fields.author) || admin.user.email || '관리자',
      tags: parseTags(firstField(fields.tags)),
      description: firstField(fields.description),
      media_url: mediaUrl,
      download_url: downloadUrl,
      web_view_url: webViewUrl,
      drive_file_id: driveFile.id,
      storage_provider: 'google_drive',
      ratio: firstField(fields.ratio) || (postType === 'pdf' ? '3/4' : '4/5')
    }));

    return res.status(201).json({ post });
  } catch (error) {
    console.error(error);
    if (uploadedDriveFileId) await safeDeleteDriveFile(uploadedDriveFileId);
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
    let uploadedFile = null;
    let totalBytes = 0;
    const busboy = Busboy({
      headers: req.headers,
      limits: { files: 1, fileSize: MAX_FILE_BYTES, fields: 12 }
    });

    busboy.on('field', (name, value) => {
      fields[name] = value;
    });

    busboy.on('file', (name, stream, info) => {
      const chunks = [];
      stream.on('data', (chunk) => {
        totalBytes += chunk.length;
        chunks.push(chunk);
      });
      stream.on('limit', () => {
        reject(new Error('업로드 가능한 파일 크기를 초과했습니다.'));
      });
      stream.on('end', () => {
        uploadedFile = {
          fieldName: name,
          filename: info.filename || 'upload',
          mimeType: info.mimeType || 'application/octet-stream',
          buffer: Buffer.concat(chunks),
          size: totalBytes
        };
      });
    });

    busboy.on('error', reject);
    busboy.on('finish', () => resolve({ fields, file: uploadedFile }));
    req.pipe(busboy);
  });
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
  return value === '시상' ? '시상' : '상품';
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
