const { requireAdmin } = require('../_auth');
const { getSupabaseAdmin, readJson } = require('../_public-access');

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
    const supabase = getSupabaseAdmin();
    const { count: codeCount, error: codeError } = await supabase
      .from('fp_member_codes')
      .select('code_number', { count: 'exact', head: true });
    if (codeError) throw new Error(codeError.message);
    const { count: memberCount, error: memberError } = await supabase
      .from('fp_members')
      .select('id', { count: 'exact', head: true });
    if (memberError) throw new Error(memberError.message);
    res.setHeader('Cache-Control', 'no-store');
    const { count: activeCodeCount, error: activeError } = await supabase
      .from('fp_member_codes')
      .select('code_number', { count: 'exact', head: true })
      .eq('is_active', true);
    if (activeError) throw new Error(activeError.message);
    return res.status(200).json({ configured: Boolean(activeCodeCount), codeCount: activeCodeCount || 0, totalCodeCount: codeCount || 0, memberCount: memberCount || 0 });
  } catch (error) {
    console.error(error);
    if (isMissingMemberTable(error)) {
      return res.status(500).json({ error: 'Supabase SQL Editor에서 최신 supabase-schema.sql을 먼저 실행해 주세요.' });
    }
    return res.status(500).json({ error: error.message || '회원가입 코드 상태를 확인하지 못했습니다.' });
  }
}

async function updatePasscode(req, res) {
  try {
    const body = await readJson(req);
    const rows = Array.isArray(body.codes) ? body.codes.map(normalizeCodeRow).filter(Boolean) : [];
    const codes = [...new Map(rows.map((row) => [row.code_number, row])).values()];
    if (!codes.length) return res.status(400).json({ error: '업로드할 소속지점/코드번호 목록이 없습니다.' });

    const supabase = getSupabaseAdmin();
    const { error: deactivateError } = await supabase
      .from('fp_member_codes')
      .update({ is_active: false })
      .neq('code_number', '');
    if (deactivateError) throw new Error(deactivateError.message);

    const { error } = await supabase
      .from('fp_member_codes')
      .upsert(codes, { onConflict: 'code_number' });
    if (error) throw new Error(error.message);
    return res.status(200).json({ ok: true, configured: true, count: codes.length });
  } catch (error) {
    console.error(error);
    if (isMissingMemberTable(error)) {
      return res.status(500).json({ error: 'Supabase SQL Editor에서 최신 supabase-schema.sql을 먼저 실행해 주세요.' });
    }
    return res.status(500).json({ error: error.message || '회원가입 코드 목록을 저장하지 못했습니다.' });
  }
}

function normalizeCodeRow(row) {
  const branch = String(row.branch || '').trim().replace(/\s+/g, ' ');
  const codeNumber = String(row.codeNumber || row.code_number || '').trim().replace(/\s+/g, '').toUpperCase();
  if (!branch || !codeNumber) return null;
  return {
    branch,
    code_number: codeNumber,
    is_active: true,
    created_at: new Date().toISOString()
  };
}

function isMissingMemberTable(error) {
  const message = String(error && error.message ? error.message : '');
  return message.includes('public.fp_member_codes') || message.includes('public.fp_members');
}
