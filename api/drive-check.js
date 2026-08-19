const { google } = require('googleapis');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const missing = ['GOOGLE_CLIENT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'GOOGLE_DRIVE_FOLDER_ID'].filter(
      (key) => !String(process.env[key] || '').trim()
    );
    if (missing.length) return res.status(200).json({ ok: false, missing, folderAccessible: false });

    const drive = google.drive({ version: 'v3', auth: getGoogleAuth() });
    const result = await drive.files.get({
      fileId: process.env.GOOGLE_DRIVE_FOLDER_ID,
      fields: 'id,name,mimeType'
    });

    return res.status(200).json({
      ok: result.data.mimeType === 'application/vnd.google-apps.folder',
      folderAccessible: true,
      folderName: result.data.name || '',
      isFolder: result.data.mimeType === 'application/vnd.google-apps.folder'
    });
  } catch (error) {
    return res.status(200).json({
      ok: false,
      folderAccessible: false,
      error: getDriveHelpMessage(error)
    });
  }
};

function getGoogleAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive']
  });
}

function getDriveHelpMessage(error) {
  if (error.code === 404) {
    return 'GOOGLE_DRIVE_FOLDER_ID가 잘못됐거나, 해당 폴더가 GOOGLE_CLIENT_EMAIL 서비스 계정에 편집자로 공유되지 않았습니다.';
  }
  if (error.code === 403) {
    return 'Google Drive API 권한이 부족합니다. Drive API 사용 설정과 폴더 공유 권한을 확인해 주세요.';
  }
  return error.message || 'Google Drive 폴더 접근 확인에 실패했습니다.';
}
