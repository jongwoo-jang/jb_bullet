const { requireAdmin } = require('../_auth');
const { getDriveAuth, getDriveUserMessage, getMissingDriveEnv, logDriveError } = require('../_google-drive');

const MAX_DIRECT_UPLOAD_BYTES = Number(process.env.MAX_DIRECT_UPLOAD_BYTES || 250 * 1024 * 1024);
const ALLOWED_MIME_PREFIXES = ['image/'];
const ALLOWED_MIME_TYPES = ['application/pdf'];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const admin = await requireAdmin(req);
    if (admin.error) return res.status(admin.error.status).json({ error: admin.error.message });

    const missing = getMissingDriveEnv();
    if (missing.length) return res.status(500).json({ error: `${missing.join(', ')} 환경변수가 필요합니다.` });

    const body = await readJson(req);
    const filename = sanitizeFilename(body.filename || 'upload');
    const mimeType = String(body.mimeType || 'application/octet-stream');
    const size = Number(body.size || 0);
    if (!isAllowedMime(mimeType)) return res.status(400).json({ error: '이미지 또는 PDF만 업로드할 수 있습니다.' });
    if (!Number.isFinite(size) || size <= 0) return res.status(400).json({ error: '파일 크기를 확인할 수 없습니다.' });
    if (size > MAX_DIRECT_UPLOAD_BYTES) return res.status(400).json({ error: `파일은 최대 ${formatBytes(MAX_DIRECT_UPLOAD_BYTES)}까지 업로드할 수 있습니다.` });

    const token = await getAccessToken();
    const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,webViewLink,webContentLink', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(size)
      },
      body: JSON.stringify({
        name: `${Date.now()}-${filename}`,
        parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
        mimeType
      })
    });

    const uploadUrl = response.headers.get('location');
    if (!response.ok || !uploadUrl) {
      const text = await response.text().catch(() => '');
      return res.status(502).json({ error: getGoogleErrorMessage(text) || 'Google Drive 업로드 세션을 만들지 못했습니다.' });
    }

    return res.status(200).json({ uploadUrl });
  } catch (error) {
    logDriveError('drive session failed', error);
    return res.status(500).json({ error: getDriveUserMessage(error, 'Google Drive 업로드 세션 생성에 실패했습니다.') });
  }
};

async function getAccessToken() {
  const auth = getDriveAuth();
  const result = await auth.getAccessToken();
  const token = typeof result === 'string' ? result : result && result.token;
  if (!token) throw new Error('Google Drive access token을 가져오지 못했습니다.');
  return token;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) reject(new Error('요청이 너무 큽니다.'));
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

function isAllowedMime(mimeType) {
  return ALLOWED_MIME_TYPES.includes(mimeType) || ALLOWED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
}

function sanitizeFilename(filename) {
  return String(filename).replace(/[\\/:*?"<>|]/g, '-').slice(0, 120);
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function getGoogleErrorMessage(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed.error && (parsed.error.message || parsed.error.status);
  } catch (error) {
    return text.slice(0, 140);
  }
}
