const { google } = require('googleapis');

const OAUTH_ENV = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];
const SERVICE_ACCOUNT_ENV = ['GOOGLE_CLIENT_EMAIL', 'GOOGLE_PRIVATE_KEY'];

function hasOAuthConfig() {
  return OAUTH_ENV.every(hasValue);
}

function hasServiceAccountConfig() {
  return SERVICE_ACCOUNT_ENV.every(hasValue);
}

function getDriveAuth() {
  if (hasOAuthConfig()) {
    const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
    auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    return auth;
  }

  if (hasServiceAccountConfig()) {
    return new google.auth.JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/drive']
    });
  }

  throw new Error('Google Drive 인증 환경변수가 필요합니다.');
}

function getDrive() {
  return google.drive({ version: 'v3', auth: getDriveAuth() });
}

function getDriveAuthMode() {
  if (hasOAuthConfig()) return 'oauth';
  if (hasServiceAccountConfig()) return 'service_account';
  return 'missing';
}

function getMissingDriveEnv() {
  const folderMissing = hasValue('GOOGLE_DRIVE_FOLDER_ID') ? [] : ['GOOGLE_DRIVE_FOLDER_ID'];

  if (hasOAuthConfig() || hasServiceAccountConfig()) return folderMissing;
  if (OAUTH_ENV.some(hasValue)) return missing(OAUTH_ENV).concat(folderMissing);
  if (SERVICE_ACCOUNT_ENV.some(hasValue)) return missing(SERVICE_ACCOUNT_ENV).concat(folderMissing);

  return OAUTH_ENV.concat(folderMissing);
}

function missing(names) {
  return names.filter((name) => !hasValue(name));
}

function hasValue(name) {
  return Boolean(String(process.env[name] || '').trim());
}

module.exports = { getDrive, getDriveAuth, getDriveAuthMode, getMissingDriveEnv };
