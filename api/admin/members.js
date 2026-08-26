const { requireAdmin } = require('../_auth');
const { readJson } = require('../_public-access');

const PAGE_LIMIT = 1000;

module.exports = async function handler(req, res) {
  const admin = await requireAdmin(req);
  if (admin.error) return res.status(admin.error.status).json({ error: admin.error.message });

  if (req.method === 'GET') return listMembers(req, res, admin.supabase);
  if (req.method === 'POST' || req.method === 'DELETE') return deleteMember(req, res, admin.supabase);

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
};

async function listMembers(req, res, supabase) {
  try {
    const url = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`);
    const q = cleanText(url.searchParams.get('q'), 80).toLowerCase();
    const data = await getAllMembers(supabase);

    const members = (data || [])
      .map(normalizeMember)
      .filter((member) => {
        if (!q) return true;
        return [member.code_number, member.branch, member.display_name]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(q);
      });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, members, total: members.length });
  } catch (error) {
    console.error(error);
    if (isMissingMemberTable(error)) {
      return res.status(500).json({ error: 'Supabase SQL Editor에서 최신 supabase-schema.sql을 먼저 실행해 주세요.' });
    }
    return res.status(500).json({ error: error.message || '회원 목록을 불러오지 못했습니다.' });
  }
}

async function getAllMembers(supabase) {
  const members = [];
  for (let start = 0; ; start += PAGE_LIMIT) {
    const { data, error } = await supabase
      .from('fp_members')
      .select('id, code_number, branch, display_name, created_at, last_login_at')
      .order('created_at', { ascending: false })
      .range(start, start + PAGE_LIMIT - 1);
    if (error) throw new Error(error.message);
    members.push(...(data || []));
    if (!data || data.length < PAGE_LIMIT) break;
  }
  return members;
}

async function deleteMember(req, res, supabase) {
  try {
    const body = await readJson(req);
    const codeNumber = cleanText(body.codeNumber || body.code_number, 80).toUpperCase();
    if (!codeNumber) return res.status(400).json({ error: '삭제할 회원 코드번호가 필요합니다.' });

    const { data, error } = await supabase
      .from('fp_members')
      .delete()
      .eq('code_number', codeNumber)
      .select('code_number');
    if (error) throw new Error(error.message);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, deleted: (data || []).length });
  } catch (error) {
    console.error(error);
    if (isMissingMemberTable(error)) {
      return res.status(500).json({ error: 'Supabase SQL Editor에서 최신 supabase-schema.sql을 먼저 실행해 주세요.' });
    }
    return res.status(500).json({ error: error.message || '회원을 삭제하지 못했습니다.' });
  }
}

function normalizeMember(row = {}) {
  return {
    id: row.id,
    code_number: cleanText(row.code_number, 80),
    branch: cleanText(row.branch, 80),
    display_name: cleanText(row.display_name, 80) || '회원',
    created_at: row.created_at || null,
    last_login_at: row.last_login_at || null
  };
}

function cleanText(value, maxLength) {
  return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, maxLength);
}

function isMissingMemberTable(error) {
  const message = String(error && error.message ? error.message : '');
  return message.includes('public.fp_members') || message.includes('fp_members');
}
