const { getDrive, getDriveAuthMode, getMissingDriveEnv } = require('./_google-drive');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const missing = getMissingDriveEnv();
    if (missing.length) return res.status(200).json({ ok: false, authMode: getDriveAuthMode(), missing, folderAccessible: false });

    const drive = getDrive();
    const result = await drive.files.get({
      fileId: process.env.GOOGLE_DRIVE_FOLDER_ID,
      fields: 'id,name,mimeType,capabilities/canAddChildren,capabilities/canShare',
      supportsAllDrives: true
    });

    const isFolder = result.data.mimeType === 'application/vnd.google-apps.folder';
    const canAddChildren = Boolean(result.data.capabilities && result.data.capabilities.canAddChildren);
    return res.status(200).json({
      ok: isFolder && canAddChildren,
      authMode: getDriveAuthMode(),
      folderAccessible: true,
      folderName: result.data.name || '',
      isFolder,
      canAddChildren,
      canShare: Boolean(result.data.capabilities && result.data.capabilities.canShare)
    });
  } catch (error) {
    return res.status(200).json({
      ok: false,
      folderAccessible: false,
      authMode: getDriveAuthMode(),
      error: getDriveHelpMessage(error),
      reason: getDriveReason(error)
    });
  }
};

function getDriveHelpMessage(error) {
  const authMode = getDriveAuthMode();
  if (error.code === 404) {
    if (authMode === 'oauth') {
      return 'GOOGLE_DRIVE_FOLDER_ID가 잘못됐거나, OAuth로 연결한 Google 계정이 해당 폴더에 접근할 수 없습니다.';
    }
    return 'GOOGLE_DRIVE_FOLDER_ID가 잘못됐거나, 해당 폴더가 GOOGLE_CLIENT_EMAIL 서비스 계정에 편집자로 공유되지 않았습니다.';
  }
  if (error.code === 403) {
    if (authMode === 'oauth') {
      return 'Google Drive API 권한이 부족합니다. OAuth 동의 범위와 Drive 폴더 권한을 확인해 주세요.';
    }
    return 'Google Drive API 권한이 부족합니다. Drive API 사용 설정과 서비스 계정 폴더 공유 권한을 확인해 주세요.';
  }
  return error.message || 'Google Drive 폴더 접근 확인에 실패했습니다.';
}

function getDriveReason(error) {
  return error && error.errors && error.errors[0] ? error.errors[0].reason : '';
}
