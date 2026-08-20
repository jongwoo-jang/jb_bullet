const { requireAdmin } = require('../_auth');
const { createAccessToken, getSupabaseAdmin, readJson } = require('../_public-access');

const UPSERT_CHUNK_SIZE = 1000;
const LOOKUP_CHUNK_SIZE = 1000;
const DELETE_CHUNK_SIZE = 500;
const ADMIN_FEED_TOKEN_TTL_SECONDS = 60 * 60 * 3;
const DEFAULT_BRANCH = '전환법인';

module.exports = async function handler(req, res) {
  const admin = await requireAdmin(req);
  if (admin.error) return res.status(admin.error.status).json({ error: admin.error.message });

  const url = new URL(req.url, `https://${req.headers.host}`);
  if (url.searchParams.get('action') === 'feed-token') return createFeedToken(admin, res);

  if (req.method === 'GET') return getStatus(res);
  if (req.method === 'POST') return updatePasscode(req, res);
  if (req.method === 'DELETE') return clearMemberCodeData(res);

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
};

function createFeedToken(admin, res) {
  const email = String(admin.user.email || '');
  const displayName = displayAdminName(email);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    token: createAccessToken({
      role: 'admin',
      codeNumber: 'ADMIN',
      branch: '관리자',
      displayName,
      ttlSeconds: ADMIN_FEED_TOKEN_TTL_SECONDS
    })
  });
}

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
    if (!codes.length) return res.status(400).json({ error: '업로드할 코드번호 목록이 없습니다.' });

    const supabase = getSupabaseAdmin();
    const incoming = new Set(codes.map((row) => row.code_number));
    const existing = await getAllExistingCodeNumbers(supabase);
    const newCodes = codes.filter((row) => !existing.has(row.code_number));
    const removedCodes = [...existing].filter((codeNumber) => !incoming.has(codeNumber));
    await upsertMemberCodes(supabase, codes);
    const removed = await deleteRemovedMemberCodes(supabase, removedCodes);
    return res.status(200).json({
      ok: true,
      configured: true,
      count: newCodes.length,
      added: newCodes.length,
      skipped: codes.length - newCodes.length,
      removed,
      submitted: codes.length
    });
  } catch (error) {
    console.error(error);
    if (isMissingMemberTable(error)) {
      return res.status(500).json({ error: 'Supabase SQL Editor에서 최신 supabase-schema.sql을 먼저 실행해 주세요.' });
    }
    return res.status(500).json({ error: error.message || '회원가입 코드 목록을 저장하지 못했습니다.' });
  }
}

async function clearMemberCodeData(res) {
  try {
    const supabase = getSupabaseAdmin();
    const { count: codeCount, error: codeCountError } = await supabase
      .from('fp_member_codes')
      .select('code_number', { count: 'exact', head: true });
    if (codeCountError) throw new Error(codeCountError.message);

    let mode = 'deleted';
    const codeDelete = await supabase
      .from('fp_member_codes')
      .delete()
      .neq('code_number', '');
    if (codeDelete.error) {
      if (!isForeignKeyDeleteError(codeDelete.error)) throw new Error(codeDelete.error.message);
      const codeDeactivate = await supabase
        .from('fp_member_codes')
        .update({ is_active: false })
        .neq('code_number', '');
      if (codeDeactivate.error) throw new Error(codeDeactivate.error.message);
      mode = 'deactivated';
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, removedCodes: codeCount || 0, preservedMembers: true, mode });
  } catch (error) {
    console.error(error);
    if (isMissingMemberTable(error)) {
      return res.status(500).json({ error: 'Supabase SQL Editor에서 최신 supabase-schema.sql을 먼저 실행해 주세요.' });
    }
    return res.status(500).json({ error: error.message || '회원가입 코드 데이터를 삭제하지 못했습니다.' });
  }
}

async function getAllExistingCodeNumbers(supabase) {
  const existing = new Set();
  for (let start = 0; ; start += LOOKUP_CHUNK_SIZE) {
    const { data, error } = await supabase
      .from('fp_member_codes')
      .select('code_number')
      .order('code_number', { ascending: true })
      .range(start, start + LOOKUP_CHUNK_SIZE - 1);
    if (error) throw new Error(error.message);
    (data || []).forEach((row) => existing.add(row.code_number));
    if (!data || data.length < LOOKUP_CHUNK_SIZE) break;
  }
  return existing;
}

async function upsertMemberCodes(supabase, codes) {
  if (!codes.length) return;
  let useDisplayName = true;
  for (const chunk of chunkArray(codes, UPSERT_CHUNK_SIZE)) {
    const payload = useDisplayName ? chunk : chunk.map(({ display_name, ...row }) => row);
    let { error } = await supabase
      .from('fp_member_codes')
      .upsert(payload, { onConflict: 'code_number' });
    if (useDisplayName && isMissingDisplayNameColumn(error)) {
      useDisplayName = false;
      const retry = await supabase
        .from('fp_member_codes')
        .upsert(chunk.map(({ display_name, ...row }) => row), { onConflict: 'code_number' });
      error = retry.error;
    }
    if (error) throw new Error(error.message);
  }
}

async function deleteRemovedMemberCodes(supabase, codeNumbers) {
  if (!codeNumbers.length) return 0;
  let removed = 0;
  for (const chunk of chunkArray(codeNumbers, DELETE_CHUNK_SIZE)) {
    const memberDelete = await supabase
      .from('fp_members')
      .delete()
      .in('code_number', chunk);
    if (memberDelete.error) throw new Error(memberDelete.error.message);

    const codeDelete = await supabase
      .from('fp_member_codes')
      .delete()
      .in('code_number', chunk);
    if (codeDelete.error) throw new Error(codeDelete.error.message);
    removed += chunk.length;
  }
  return removed;
}

function normalizeCodeRow(row) {
  const codeNumber = String(row.codeNumber || row.code_number || '').trim().replace(/\s+/g, '').toUpperCase();
  const displayName = String(row.displayName || row.display_name || '').trim().replace(/\s+/g, ' ').slice(0, 30);
  if (!codeNumber) return null;
  return {
    branch: DEFAULT_BRANCH,
    code_number: codeNumber,
    display_name: displayName || null,
    is_active: true,
    created_at: new Date().toISOString()
  };
}

function isMissingMemberTable(error) {
  const message = String(error && error.message ? error.message : '');
  return message.includes('public.fp_member_codes') || message.includes('public.fp_members');
}

function isMissingDisplayNameColumn(error) {
  return Boolean(error && String(error.message || '').includes('display_name'));
}

function isForeignKeyDeleteError(error) {
  const message = String(error && error.message ? error.message : '');
  return message.includes('foreign key') || message.includes('violates foreign key constraint') || message.includes('23503');
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function displayAdminName(value) {
  const id = String(value || '').split('@')[0].toLowerCase();
  const names = { lemuel05: '장종우', jaguar06: '정환석' };
  return names[id] || id || '관리자';
}
