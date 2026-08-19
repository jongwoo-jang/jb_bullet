const { createClient } = require('@supabase/supabase-js');
const Busboy = require('busboy');
const { google } = require('googleapis');
const { Readable } = require('stream');
const { requireAdmin } = require('../_auth');
const { normalizeSupabaseUrl } = require('../_supabase-url');

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
    const driveFile = await uploadToDrive(file);
    uploadedDriveFileId = driveFile.id;
    await makeDriveFilePublic(driveFile.id);

    const downloadUrl = driveFile.webContentLink || driveDownloadUrl(driveFile.id);
    const webViewUrl = driveFile.webViewLink || `https://drive.google.com/file/d/${driveFile.id}/view`;
    const mediaUrl = postType === 'image' ? driveThumbnailUrl(driveFile.id) : webViewUrl;

    const post = await insertPost({
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
    });

    return res.status(201).json({ post });
  } catch (error) {
    console.error(error);
    if (uploadedDriveFileId) await safeDeleteDriveFile(uploadedDriveFileId);
    return res.status(500).json({ error: error.message || '업로드에 실패했습니다.' });
  }
};

function ensureServerConfig() {
  const required = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'GOOGLE_CLIENT_EMAIL',
    'GOOGLE_PRIVATE_KEY',
    'GOOGLE_DRIVE_FOLDER_ID'
  ];
  const missing = required.filter((key) => !process.env[key]);
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
  const drive = google.drive({ version: 'v3', auth: getGoogleAuth() });
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
    fields: 'id,name,mimeType,webViewLink,webContentLink'
  });
  return result.data;
}

async function makeDriveFilePublic(fileId) {
  const drive = google.drive({ version: 'v3', auth: getGoogleAuth() });
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' }
  });
}

async function safeDeleteDriveFile(fileId) {
  try {
    const drive = google.drive({ version: 'v3', auth: getGoogleAuth() });
    await drive.files.delete({ fileId });
  } catch (error) {
    console.error('Failed to clean up Drive file', error);
  }
}

function getGoogleAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive']
  });
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
