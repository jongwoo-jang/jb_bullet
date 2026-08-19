const { createAccessToken, getPasscodeHash, getSupabaseAdmin, readJson, verifyPasscode } = require('../_public-access');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = await readJson(req);
    const supabase = getSupabaseAdmin();
    const configured = Boolean(await getPasscodeHash(supabase));
    if (!configured) return res.status(409).json({ error: '접속 비밀번호가 아직 설정되지 않았습니다.' });
    const ok = await verifyPasscode(body.passcode, supabase);
    if (!ok) return res.status(401).json({ error: '비밀번호를 확인해 주세요.' });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ token: createAccessToken() });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || '접속 확인에 실패했습니다.' });
  }
};
