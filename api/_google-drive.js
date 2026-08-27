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

function isInvalidGoogleGrant(error) {
  const responseError = error && error.response && error.response.data && error.response.data.error;
  const causeMessage = error && error.cause && error.cause.message;
  const message = String(error && (error.message || error.code || '') || '');
  return responseError === 'invalid_grant' || causeMessage === 'invalid_grant' || message.includes('invalid_grant');
}

function getDriveUserMessage(error, fallback = 'Google Drive 처리에 실패했습니다.') {
  if (isInvalidGoogleGrant(error)) {
    return 'Google Drive 인증이 만료되었습니다. Vercel의 GOOGLE_REFRESH_TOKEN을 새로 발급한 값으로 교체한 뒤 Redeploy 해주세요.';
  }
  return error && error.message ? error.message : fallback;
}

function logDriveError(context, error) {
  const response = error && error.response;
  const data = response && response.data || {};
  console.error(context, {
    message: error && error.message,
    code: error && error.code,
    status: error && error.status || response && response.status,
    googleError: data.error,
    googleErrorDescription: data.error_description
  });
}

function missing(names) {
  return names.filter((name) => !hasValue(name));
}

function hasValue(name) {
  return Boolean(String(process.env[name] || '').trim());
}

module.exports = { getDrive, getDriveAuth, getDriveAuthMode, getMissingDriveEnv, getDriveUserMessage, isInvalidGoogleGrant, logDriveError };
