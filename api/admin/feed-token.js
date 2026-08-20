const { requireAdmin } = require('../_auth');
const { createAccessToken } = require('../_public-access');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const admin = await requireAdmin(req);
  if (admin.error) return res.status(admin.error.status).json({ error: admin.error.message });

  const email = String(admin.user.email || '');
  const displayName = displayAdminName(email);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    token: createAccessToken({
      role: 'admin',
      codeNumber: 'ADMIN',
      branch: '관리자',
      displayName
    })
  });
};

function displayAdminName(value) {
  const id = String(value || '').split('@')[0].toLowerCase();
  const names = { lemuel05: '장종우', jaguar06: '정환석' };
  return names[id] || id || '관리자';
}
