const { requireAdmin } = require('../_auth');

const MAX_CHUNK_BYTES = Number(process.env.MAX_UPLOAD_CHUNK_BYTES || 3 * 1024 * 1024);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const admin = await requireAdmin(req);
    if (admin.error) return res.status(admin.error.status).json({ error: admin.error.message });

    const uploadUrl = decodeURIComponent(String(req.headers['x-upload-url'] || ''));
    const contentRange = String(req.headers['x-upload-content-range'] || '');
    const mimeType = String(req.headers['x-upload-content-type'] || 'application/octet-stream');
    if (!uploadUrl.startsWith('https://www.googleapis.com/upload/drive/')) {
      return res.status(400).json({ error: 'Google Drive 업로드 URL이 올바르지 않습니다.' });
    }
    if (!/^bytes \d+-\d+\/\d+$/.test(contentRange)) {
      return res.status(400).json({ error: '업로드 범위 정보가 올바르지 않습니다.' });
    }

    const buffer = await readBuffer(req);
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(buffer.length),
        'Content-Range': contentRange
      },
      body: buffer
    });

    const raw = await response.text();
    if (response.status === 308) {
      return res.status(200).json({ done: false, range: response.headers.get('range') || '' });
    }
    if (!response.ok) {
      return res.status(502).json({ error: getGoogleErrorMessage(raw) || 'Google Drive 조각 업로드에 실패했습니다.' });
    }

    let file = {};
    try {
      file = raw ? JSON.parse(raw) : {};
    } catch (error) {
      return res.status(502).json({ error: 'Google Drive 완료 응답을 읽을 수 없습니다.' });
    }
    return res.status(200).json({ done: true, file });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || 'Google Drive 조각 업로드에 실패했습니다.' });
  }
};

function readBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_CHUNK_BYTES) {
        reject(new Error('업로드 조각이 너무 큽니다.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function getGoogleErrorMessage(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed.error && (parsed.error.message || parsed.error.status);
  } catch (error) {
    return text.slice(0, 140);
  }
}
