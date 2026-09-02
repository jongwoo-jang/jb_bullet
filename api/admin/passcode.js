const { requireAdmin } = require('../_auth');
const { createAccessToken, getSupabaseAdmin, readJson } = require('../_public-access');
const { getDrive } = require('../_google-drive');

const UPSERT_CHUNK_SIZE = 1000;
const LOOKUP_CHUNK_SIZE = 1000;
const DELETE_CHUNK_SIZE = 500;
const ADMIN_POST_LIMIT = 500;
const ADMIN_FEED_TOKEN_TTL_SECONDS = 60 * 60 * 3;
const PERFORMANCE_ROW_LIMIT = 20000;
const ACTUAL_LOSS_KEYWORDS = ['전환표준', '유병노후'];
const CORPORATE_GROUP_KEYWORD = '법인단체';
const DEFAULT_BRANCH = '전환법인';

module.exports = async function handler(req, res) {
  const admin = await requireAdmin(req);
  if (admin.error) return res.status(admin.error.status).json({ error: admin.error.message });

  const url = new URL(req.url, `https://${req.headers.host}`);
  if (url.searchParams.get('action') === 'feed-token') return createFeedToken(admin, res);
  if (url.searchParams.get('action') === 'popup') return handlePopupSetting(req, res);
  if (url.searchParams.get('action') === 'posts') return listAdminPosts(req, res, admin.supabase);
  if (url.searchParams.get('action') === 'pin') return updatePostPin(req, res, admin.supabase);
  if (url.searchParams.get('action') === 'performance') return handlePerformanceDataset(req, res, admin.supabase, admin.user);
  if (url.searchParams.get('action') === 'members') return handleMembers(req, res, admin.supabase);

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

async function listAdminPosts(req, res, supabase) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    let { data, error } = await supabase
      .from('fp_posts')
      .select('*')
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(ADMIN_POST_LIMIT);
    if (isMissingPinnedColumn(error)) {
      const retry = await supabase
        .from('fp_posts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(ADMIN_POST_LIMIT);
      data = retry.data;
      error = retry.error;
    }
    if (error) throw new Error(error.message);
    const posts = await attachPostStats(supabase, data || []);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, posts });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || '등록 자료를 불러오지 못했습니다.' });
  }
}

async function attachPostStats(supabase, posts) {
  const ids = posts.map((post) => Number(post.id)).filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!ids.length) return posts.map((post) => ({ ...post, stats: defaultStats() }));
  const statsByPostId = new Map();
  try {
    const { data, error } = await supabase
      .from('fp_post_stats')
      .select('post_id, view_count, like_count, share_count, download_count, save_count')
      .in('post_id', ids);
    if (error) throw new Error(error.message);
    (data || []).forEach((row) => {
      statsByPostId.set(String(row.post_id), {
        view_count: Number(row.view_count || 0),
        like_count: Number(row.like_count || 0),
        share_count: Number(row.share_count || 0),
        download_count: Number(row.download_count || 0),
        save_count: Number(row.save_count || 0)
      });
    });
  } catch (error) {
    if (!isMissingStatsTable(error)) console.error('admin post stats skipped:', error.message || error);
  }
  return posts.map((post) => ({ ...post, stats: statsByPostId.get(String(post.id)) || defaultStats() }));
}

async function updatePostPin(req, res, supabase) {
  if (req.method !== 'PATCH' && req.method !== 'POST') {
    res.setHeader('Allow', 'PATCH, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const body = await readJson(req);
    const id = String(body.id || '').trim();
    if (!id) return res.status(400).json({ error: '게시물 ID가 필요합니다.' });

    const { data, error } = await supabase
      .from('fp_posts')
      .update({ is_pinned: Boolean(body.isPinned) })
      .eq('id', id)
      .select('*')
      .single();
    if (isMissingPinnedColumn(error)) {
      return res.status(500).json({ error: 'Supabase fp_posts 테이블에 is_pinned 컬럼이 필요합니다. 최신 supabase-schema.sql을 SQL Editor에서 실행해 주세요.' });
    }
    if (error) throw new Error(error.message);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, post: data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || '상단고정 변경에 실패했습니다.' });
  }
}

function defaultStats() {
  return {
    view_count: 0,
    like_count: 0,
    share_count: 0,
    download_count: 0,
    save_count: 0
  };
}

async function handleMembers(req, res, supabase) {
  if (req.method === 'GET') return listMembers(req, res, supabase);
  if (req.method === 'POST' || req.method === 'DELETE') return deleteMember(req, res, supabase);
  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}

async function listMembers(req, res, supabase) {
  try {
    const url = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`);
    const q = cleanText(url.searchParams.get('q'), 80).toLowerCase();
    const data = await getAllMembers(supabase);
    const members = data
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
  for (let start = 0; ; start += LOOKUP_CHUNK_SIZE) {
    const { data, error } = await supabase
      .from('fp_members')
      .select('id, code_number, branch, display_name, created_at, last_login_at')
      .order('created_at', { ascending: false })
      .range(start, start + LOOKUP_CHUNK_SIZE - 1);
    if (error) throw new Error(error.message);
    members.push(...(data || []));
    if (!data || data.length < LOOKUP_CHUNK_SIZE) break;
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

async function handlePopupSetting(req, res) {
  if (req.method === 'GET') return getPopupSetting(res);
  if (req.method === 'POST') return savePopupSetting(req, res);
  if (req.method === 'DELETE') return deletePopupSetting(res);
  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}

async function getPopupSetting(res) {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('fp_settings')
      .select('value,updated_at')
      .eq('key', 'entry_popup')
      .maybeSingle();
    if (error) throw new Error(error.message);
    const setting = normalizePopupSetting(parseJson(data && data.value) || {});
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, setting: { ...setting, updatedAt: data && data.updated_at } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || '접속 팝업 설정을 불러오지 못했습니다.' });
  }
}

async function savePopupSetting(req, res) {
  try {
    const body = await readJson(req);
    const setting = normalizePopupSetting(body);
    setting.version = new Date().toISOString();
    if (setting.enabled && !setting.imageUrl) {
      return res.status(400).json({ error: '팝업 이미지가 필요합니다.' });
    }
    if (setting.enabled && !setting.postId) {
      return res.status(400).json({ error: '연결할 게시물을 선택해 주세요.' });
    }
    if (setting.driveFileId) await makeDriveFilePublic(setting.driveFileId);
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from('fp_settings')
      .upsert({
        key: 'entry_popup',
        value: JSON.stringify(setting),
        updated_at: setting.version
      }, { onConflict: 'key' });
    if (error) throw new Error(error.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, setting });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || '접속 팝업 설정을 저장하지 못했습니다.' });
  }
}

async function deletePopupSetting(res) {
  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from('fp_settings')
      .delete()
      .eq('key', 'entry_popup');
    if (error) throw new Error(error.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || '접속 팝업 설정을 삭제하지 못했습니다.' });
  }
}

async function handlePerformanceDataset(req, res, supabase, user = {}) {
  if (req.method === 'GET') return listPerformanceDatasets(res, supabase);
  if (req.method === 'POST') return savePerformanceDataset(req, res, supabase, user);
  if (req.method === 'DELETE') return deletePerformanceDataset(req, res, supabase);
  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}

async function listPerformanceDatasets(res, supabase) {
  try {
    const { data, error } = await supabase
      .from('fp_performance_datasets')
      .select('id, month, title, row_count, is_active, source_filename, uploaded_by, created_at')
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) throw new Error(error.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, datasets: data || [] });
  } catch (error) {
    console.error(error);
    if (isMissingPerformanceTable(error)) {
      return res.status(500).json({ error: 'Supabase SQL Editor에서 최신 supabase-schema.sql을 먼저 실행해 주세요.' });
    }
    return res.status(500).json({ error: error.message || '실적 반영 이력을 불러오지 못했습니다.' });
  }
}

async function savePerformanceDataset(req, res, supabase, user = {}) {
  try {
    const body = await readJson(req);
    const dataset = normalizePerformanceDataset(body.dataset || body.performance || body, body.filename || body.sourceFilename);
    if (!dataset.award_conditions.length) return res.status(400).json({ error: '시상조건이 필요합니다.' });
    if (!dataset.performance_rows.length) return res.status(400).json({ error: '실적데이터가 필요합니다.' });

    const now = new Date().toISOString();
    const activeClear = await supabase
      .from('fp_performance_datasets')
      .update({ is_active: false })
      .eq('is_active', true);
    if (activeClear.error && !isMissingPerformanceTable(activeClear.error)) throw new Error(activeClear.error.message);

    const { data, error } = await supabase
      .from('fp_performance_datasets')
      .insert({
        month: dataset.month,
        title: dataset.title,
        award_conditions: dataset.award_conditions,
        performance_rows: dataset.performance_rows,
        row_count: dataset.performance_rows.length,
        is_active: true,
        source_filename: dataset.source_filename,
        uploaded_by: String(user.email || '').slice(0, 160),
        created_at: now
      })
      .select('id, month, title, row_count, is_active, source_filename, uploaded_by, created_at')
      .single();
    if (error) throw new Error(error.message);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, dataset: data });
  } catch (error) {
    console.error(error);
    if (isMissingPerformanceTable(error)) {
      return res.status(500).json({ error: 'Supabase SQL Editor에서 최신 supabase-schema.sql을 먼저 실행해 주세요.' });
    }
    return res.status(500).json({ error: error.message || '실적 데이터를 저장하지 못했습니다.' });
  }
}

async function deletePerformanceDataset(req, res, supabase) {
  try {
    const body = await readJson(req);
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: '삭제할 실적 데이터 ID가 필요합니다.' });
    const { error } = await supabase
      .from('fp_performance_datasets')
      .delete()
      .eq('id', id);
    if (error) throw new Error(error.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    if (isMissingPerformanceTable(error)) {
      return res.status(500).json({ error: 'Supabase SQL Editor에서 최신 supabase-schema.sql을 먼저 실행해 주세요.' });
    }
    return res.status(500).json({ error: error.message || '실적 데이터를 삭제하지 못했습니다.' });
  }
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

function isMissingPinnedColumn(error) {
  return Boolean(error && String(error.message || '').includes('is_pinned'));
}

function isMissingStatsTable(error) {
  const message = String(error && error.message || '');
  return message.includes('fp_post_stats') || message.includes('public.fp_post_stats');
}

function isMissingPerformanceTable(error) {
  const message = String(error && error.message || '');
  return message.includes('fp_performance_datasets') || message.includes('public.fp_performance_datasets');
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

function normalizePerformanceDataset(value = {}, filename = '') {
  const source = value && typeof value === 'object' ? value : {};
  const awardConditions = normalizeAwardConditions(
    source.awardConditions || source.award_conditions || source.awardCondition || source.award_condition
  );
  const performanceRows = normalizePerformanceRows(
    source.performanceRows || source.performance_rows || source.rows || source.data || source.records
  );
  const month = cleanMonth(source.month || inferMonth(awardConditions) || new Date().toISOString().slice(0, 7));
  return {
    month,
    title: cleanText(source.title || source.name || (awardConditions[0] && awardConditions[0].name) || `${month} 인보험 실적`, 120),
    award_conditions: awardConditions,
    performance_rows: performanceRows,
    source_filename: cleanText(filename || source.sourceFilename || source.source_filename || '', 180)
  };
}

function normalizeAwardConditions(value) {
  const list = Array.isArray(value) ? value : (value ? [value] : []);
  return list.map((condition) => {
    const item = condition && typeof condition === 'object' ? condition : {};
    const tiers = normalizeAwardTiers(item.tiers || item.awardTiers || item.award_tiers || item);
    const firstTier = tiers[0] || {};
    const conditionType = normalizeConditionType(item.conditionType || item.condition_type || item.metric || item['달성조건']);
    const excludeActualLoss = Boolean(item.excludeActualLoss || item.exclude_actual_loss || item['실손제외']);
    const excludeCorporateGroup = Boolean(item.excludeCorporateGroup || item.exclude_corporate_group || item['법인단체제외']);
    return {
      name: cleanText(item.name || item.title || item['시상이름'], 120),
      conditionType,
      awardDate: cleanDate(item.awardDate || item.award_date || item['시상날짜']),
      awardStartDate: cleanDate(item.awardStartDate || item.award_start_date || item.startDate || item.start_date || item['시작일']),
      awardEndDate: cleanDate(item.awardEndDate || item.award_end_date || item.endDate || item.end_date || item['종료일'] || item.awardDate || item.award_date || item['시상날짜']),
      targetValue: firstTier.targetValue || 0,
      awardAmount: firstTier.awardAmount || 0,
      awardItem: firstTier.awardItem || '',
      tiers,
      longTermTypes: normalizeLongTermTypes(item.longTermTypes || item.long_term_types || item['장기세분'] || item['장기마케팅세분']),
      excludeActualLoss,
      actualLossKeywords: excludeActualLoss ? ACTUAL_LOSS_KEYWORDS : [],
      excludeCorporateGroup,
      corporateGroupKeyword: excludeCorporateGroup ? CORPORATE_GROUP_KEYWORD : ''
    };
  }).filter((condition) => condition.name && condition.tiers.length);
}

function normalizeAwardTiers(value) {
  const list = Array.isArray(value) ? value : [value];
  return list.map((tier) => {
    const item = tier && typeof tier === 'object' ? tier : {};
    return {
      targetValue: toNumber(item.targetValue || item.target_value || item.targetAmount || item.target_amount || item['달성금액'] || item['달성 기준값']),
      awardAmount: toNumber(item.awardAmount || item.award_amount || item['시상금액']),
      awardItem: cleanText(item.awardItem || item.award_item || item.prize || item['시상물품'], 160)
    };
  })
    .filter((tier) => tier.targetValue > 0 && (tier.awardAmount > 0 || tier.awardItem))
    .sort((a, b) => a.targetValue - b.targetValue);
}

function normalizePerformanceRows(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows.slice(0, PERFORMANCE_ROW_LIMIT).map((row) => {
    const actualLossType = cleanText(row.actualLossType || row.actual_loss_type || row['실손구분'], 80);
    const corporateGroupType = cleanText(row.corporateGroupType || row.corporate_group_type || row['법인단체'], 80);
    return {
      region: cleanText(row.region || row['지역단명'], 80),
      branch: cleanText(row.branch || row['지점명'], 80),
      contractClosedAt: cleanText(row.contractClosedAt || row.contract_closed_at || row['계약마감시간'], 32),
      longTermType: cleanText(row.longTermType || row.long_term_type || row['장기마케팅세분'], 12).toUpperCase().replace(/^AO/, 'A0'),
      agencyName: cleanText(row.agencyName || row.agency_name || row['성명_대리점'], 160),
      userCode: cleanText(row.userCode || row.user_code || row['사용인코드'], 80).replace(/\s+/g, ''),
      userName: cleanText(row.userName || row.user_name || row['사용인명'], 80),
      monthlyPremium: toNumber(row.monthlyPremium || row.monthly_premium || row['월환산보험료']),
      paymentCount: toNumber(row.paymentCount || row.payment_count || row['납입건수']),
      actualLossType,
      isActualLoss: ACTUAL_LOSS_KEYWORDS.some((keyword) => actualLossType.includes(keyword)),
      corporateGroupType,
      isCorporateGroup: corporateGroupType.includes(CORPORATE_GROUP_KEYWORD),
      selfType: cleanText(row.selfType || row.self_type || row['본인여부'], 40)
    };
  }).filter((row) => row.userCode);
}

function normalizeConditionType(value) {
  const text = cleanText(value, 80).toLowerCase();
  if (text.includes('납입') || text.includes('count')) return 'paymentCount';
  return 'premiumSum';
}

function normalizeLongTermTypes(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,|\s]+/);
  const allowed = new Set(['A01', 'A02', 'A03', 'A04', 'A05']);
  return [...new Set(list.map((item) => cleanText(item, 12).toUpperCase().replace(/^AO/, 'A0')).filter((item) => allowed.has(item)))];
}

function cleanMonth(value) {
  const text = cleanText(value, 20);
  const match = text.match(/(\d{4})[-.]?(\d{2})/);
  return match ? `${match[1]}-${match[2]}` : new Date().toISOString().slice(0, 7);
}

function cleanDate(value) {
  const text = cleanText(value, 30);
  const match = text.match(/(\d{4})[-.]?(\d{2})[-.]?(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : text;
}

function inferMonth(conditions = []) {
  const date = conditions.find((condition) => condition.awardStartDate || condition.awardEndDate || condition.awardDate);
  return date ? (date.awardStartDate || date.awardEndDate || date.awardDate) : '';
}

function toNumber(value) {
  const text = String(value || '').replace(/,/g, '').replace(/[^\d.-]/g, '');
  const number = Number(text);
  return Number.isFinite(number) ? number : 0;
}

function normalizePopupSetting(value) {
  return {
    enabled: Boolean(value && value.enabled),
    imageUrl: cleanText(value && (value.imageUrl || value.mediaUrl), 1200),
    postId: cleanText(value && value.postId, 80),
    driveFileId: cleanText(value && (value.driveFileId || value.drive_file_id), 120),
    version: cleanText(value && value.version, 80)
  };
}

async function makeDriveFilePublic(fileId) {
  if (!fileId) return;
  try {
    await getDrive().permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true
    });
  } catch (error) {
    const message = String(error && error.message || '');
    if (!message.includes('already exists')) throw error;
  }
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch (error) {
    return null;
  }
}

function cleanText(value, maxLength) {
  return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, maxLength);
}

function displayAdminName(value) {
  const id = String(value || '').split('@')[0].toLowerCase();
  const names = { lemuel05: '장종우', jaguar06: '정환석' };
  return names[id] || id || '관리자';
}
