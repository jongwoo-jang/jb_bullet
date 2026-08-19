const { requireAdmin } = require('../_auth');
const { getPasscodeHash, getSupabaseAdmin, isValidPasscode, readJson, setPasscode } = require('../_public-access');

module.exports = async function handler(req, res) {
  const admin = await requireAdmin(req);
  if (admin.error) return res.status(admin.error.status).json({ error: admin.error.message });

  if (req.method === 'GET') return getStatus(res);
  if (req.method === 'POST') return updatePasscode(req, res);

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};

async function getStatus(res) {
  try {
    const hash = await getPasscodeHash(getSupabaseAdmin());
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ configured: Boolean(hash) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || '접속 비밀번호 상태를 확인하지 못했습니다.' });
  }
}

async function updatePasscode(req, res) {
  try {
    const body = await readJson(req);
    if (!isValidPasscode(body.passcode)) return res.status(400).json({ error: '4자리 숫자 비밀번호를 입력해 주세요.' });
    await setPasscode(body.passcode, getSupabaseAdmin());
    return res.status(200).json({ ok: true, configured: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || '접속 비밀번호를 저장하지 못했습니다.' });
  }
}
