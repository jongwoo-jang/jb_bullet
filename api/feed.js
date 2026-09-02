const { getSupabaseAdmin, readJson, requirePublicAccess } = require('./_public-access');
const { logActivity } = require('./_activity');

const FEED_EVENTS = new Set(['view', 'like', 'unlike', 'save', 'unsave', 'download', 'share', 'popup_view', 'popup_click']);
const DEFAULT_FEED_LIMIT = 30;
const MAX_FEED_LIMIT = 60;
const ACTUAL_LOSS_KEYWORDS = ['전환표준', '유병노후'];
const CORPORATE_GROUP_KEYWORD = '법인단체';
const SELF_CONTRACT_KEYWORD = '본인';
const AWARD_YEAR_LABELS = { firstYear: '1차년 시상', secondYear: '2차년 시상' };
const STAT_FIELDS = {
  view: 'view_count',
  like: 'like_count',
  unlike: 'like_count',
  save: 'save_count',
  unsave: 'save_count',
  download: 'download_count',
  share: 'share_count',
  popup_click: 'popup_click_count'
};

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const access = requirePublicAccess(req);
  if (access.error) return res.status(access.error.status).json({ error: access.error.message });

  if (req.method === 'POST') return recordFeedActivity(req, res, access.payload);

  try {
    const supabase = getSupabaseAdmin();
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.searchParams.get('view') === 'performance') {
      return getMyPerformance(req, res, supabase, access.payload);
    }
    const pagination = getPagination(req);
    let { data, error } = await supabase
      .from('fp_posts')
      .select('*')
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false })
      .range(pagination.offset, pagination.offset + pagination.limit - 1);
    if (isMissingPinnedColumn(error)) {
      const retry = await supabase
        .from('fp_posts')
        .select('*')
        .order('created_at', { ascending: false })
        .range(pagination.offset, pagination.offset + pagination.limit - 1);
      data = retry.data;
      error = retry.error;
    }
    if (error) throw new Error(error.message);
    data = await attachEngagement(supabase, data || [], access.payload);
    const popup = await getEntryPopup(supabase);
    const count = Array.isArray(data) ? data.length : 0;
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      posts: data || [],
      popup,
      pagination: {
        limit: pagination.limit,
        offset: pagination.offset,
        nextOffset: pagination.offset + count,
        hasMore: count === pagination.limit
      }
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || '자료를 불러오지 못했습니다.' });
  }
};

function getPagination(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const rawLimit = Number(url.searchParams.get('limit'));
  const rawOffset = Number(url.searchParams.get('offset'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), MAX_FEED_LIMIT)
    : DEFAULT_FEED_LIMIT;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  return { limit, offset };
}

async function getMyPerformance(req, res, supabase, payload = {}) {
  try {
    const codeNumber = cleanText(payload && payload.codeNumber, 80).replace(/\s+/g, '');
    if (!codeNumber) return res.status(403).json({ error: '로그인이 필요합니다.' });
    const { data, error } = await supabase
      .from('fp_performance_datasets')
      .select('id, month, title, award_conditions, performance_rows, row_count, created_at')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, performance: null });
    }
    const rows = Array.isArray(data.performance_rows) ? data.performance_rows : [];
    const myRows = rows.filter((row) => cleanText(row.userCode || row.user_code || row['사용인코드'], 80).replace(/\s+/g, '') === codeNumber);
    const insuranceRows = myRows.filter((row) => !isActualLossPerformanceRow(row));
    const conditions = Array.isArray(data.award_conditions) ? data.award_conditions : [];
    const awards = conditions.map((condition) => calculateAward(condition, myRows));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      performance: {
        id: data.id,
        month: data.month,
        title: data.title,
        rowCount: myRows.length,
        userCode: codeNumber,
        userName: payload.displayName || myRows[0] && (myRows[0].userName || myRows[0].user_name || myRows[0]['사용인명']) || '',
        summary: {
          rowCount: myRows.length,
          insuranceRowCount: insuranceRows.length,
          actualLossRowCount: myRows.length - insuranceRows.length,
          monthlyPremium: sumPerformanceField(myRows, 'monthlyPremium', 'monthly_premium', '월환산보험료'),
          paymentCount: sumPerformanceField(myRows, 'paymentCount', 'payment_count', '납입건수'),
          insuranceMonthlyPremium: sumPerformanceField(insuranceRows, 'monthlyPremium', 'monthly_premium', '월환산보험료'),
          insurancePaymentCount: sumPerformanceField(insuranceRows, 'paymentCount', 'payment_count', '납입건수')
        },
        awards,
        updatedAt: data.created_at
      }
    });
  } catch (error) {
    console.error(error);
    if (isMissingPerformanceTable(error)) {
      return res.status(500).json({ error: 'Supabase SQL Editor에서 최신 supabase-schema.sql을 먼저 실행해 주세요.' });
    }
    return res.status(500).json({ error: error.message || '내 실적을 불러오지 못했습니다.' });
  }
}

function isActualLossPerformanceRow(row = {}) {
  if (row.isActualLoss === true || row.is_actual_loss === true) return true;
  const actualLossType = cleanText(row.actualLossType || row.actual_loss_type || row['실손구분'], 80);
  return ACTUAL_LOSS_KEYWORDS.some((keyword) => actualLossType.includes(keyword));
}

function isCorporateGroupPerformanceRow(row = {}) {
  if (row.isCorporateGroup === true || row.is_corporate_group === true) return true;
  const corporateGroupType = cleanText(row.corporateGroupType || row.corporate_group_type || row['법인단체'], 80);
  return corporateGroupType.includes(CORPORATE_GROUP_KEYWORD);
}

function isSelfContractPerformanceRow(row = {}) {
  if (row.isSelfContract === true || row.is_self_contract === true) return true;
  const selfType = cleanText(row.selfType || row.self_type || row['본인여부'], 40).replace(/\s+/g, '');
  if (!selfType) return false;
  if (selfType.includes('外') || selfType.includes('외')) return false;
  return selfType === SELF_CONTRACT_KEYWORD || selfType === '본인계약';
}

function sumPerformanceField(rows = [], camelKey, snakeKey, koreanKey) {
  return rows.reduce((sum, row) => sum + toNumber(row[camelKey] || row[snakeKey] || row[koreanKey]), 0);
}

function calculateAward(condition = {}, rows = []) {
  const longTermTypes = normalizeStringList(condition.longTermTypes || condition.long_term_types);
  const excludeActualLoss = Boolean(condition.excludeActualLoss || condition.exclude_actual_loss);
  const excludeCorporateGroup = Boolean(condition.excludeCorporateGroup || condition.exclude_corporate_group);
  const excludeSelfContract = Boolean(condition.excludeSelfContract || condition.exclude_self_contract);
  const awardYearType = normalizeAwardYearType(condition.awardYearType || condition.award_year_type || condition.awardYearLabel || condition.award_year_label);
  const filtered = rows.filter((row) => {
    if (!isWithinAwardPeriod(row, condition)) return false;
    const longTermType = cleanText(row.longTermType || row.long_term_type || row['장기마케팅세분'], 12).toUpperCase().replace(/^AO/, 'A0');
    if (longTermTypes.length && !longTermTypes.includes(longTermType)) return false;
    if (excludeActualLoss && isActualLossPerformanceRow(row)) return false;
    if (excludeCorporateGroup && isCorporateGroupPerformanceRow(row)) return false;
    if (excludeSelfContract && isSelfContractPerformanceRow(row)) return false;
    return true;
  });
  const conditionType = String(condition.conditionType || condition.condition_type || '').includes('payment') ? 'paymentCount' : 'premiumSum';
  const currentValue = filtered.reduce((sum, row) => {
    return sum + (conditionType === 'paymentCount'
      ? toNumber(row.paymentCount || row.payment_count || row['납입건수'])
      : toNumber(row.monthlyPremium || row.monthly_premium || row['월환산보험료']));
  }, 0);
  const targetValue = toNumber(condition.targetValue || condition.target_value || condition.targetAmount || condition.target_amount);
  const tiers = normalizeAwardTiers(condition.tiers || condition.awardTiers || condition.award_tiers || condition);
  const nextTier = tiers.find((tier) => currentValue < tier.targetValue) || null;
  const achievedTier = [...tiers].reverse().find((tier) => currentValue >= tier.targetValue) || null;
  const displayTargetValue = nextTier ? nextTier.targetValue : (achievedTier ? achievedTier.targetValue : targetValue);
  const achieved = Boolean(achievedTier);
  return {
    name: cleanText(condition.name || condition.title || '인보험 시상', 120),
    awardYearType,
    awardYearLabel: AWARD_YEAR_LABELS[awardYearType],
    conditionType,
    awardDate: cleanText(condition.awardDate || condition.award_date, 30),
    awardStartDate: cleanText(condition.awardStartDate || condition.award_start_date || condition.startDate || condition.start_date, 30),
    awardEndDate: cleanText(condition.awardEndDate || condition.award_end_date || condition.endDate || condition.end_date || condition.awardDate || condition.award_date, 30),
    targetValue: displayTargetValue,
    currentValue,
    achievementRate: displayTargetValue > 0 ? Math.min(999, Math.round((currentValue / displayTargetValue) * 1000) / 10) : 0,
    achieved,
    awardAmount: achievedTier ? achievedTier.awardAmount : 0,
    awardItem: achievedTier ? achievedTier.awardItem : '',
    achievedTier,
    nextTier,
    tiers,
    eligibleRowCount: filtered.length
  };
}

function isWithinAwardPeriod(row = {}, condition = {}) {
  const start = dateKey(condition.awardStartDate || condition.award_start_date || condition.startDate || condition.start_date);
  const end = dateKey(condition.awardEndDate || condition.award_end_date || condition.endDate || condition.end_date || condition.awardDate || condition.award_date);
  if (!start && !end) return true;
  const closedAt = dateKey(row.contractClosedAt || row.contract_closed_at || row['계약마감시간']);
  if (!closedAt) return false;
  if (start && closedAt < start) return false;
  if (end && closedAt > end) return false;
  return true;
}

function dateKey(value) {
  const text = String(value || '').trim();
  const match = text.match(/(\d{4})[-.]?(\d{2})[-.]?(\d{2})/);
  return match ? `${match[1]}${match[2]}${match[3]}` : '';
}

async function recordFeedActivity(req, res, payload) {
  try {
    const body = await readJson(req);
    const eventType = String(body.eventType || '');
    if (!FEED_EVENTS.has(eventType)) {
      return res.status(400).json({ error: 'Unsupported activity type' });
    }
    const supabase = getSupabaseAdmin();
    await applyFeedEvent(supabase, eventType, body, payload);
    await logActivity(req, eventType, {
      actorRole: payload && payload.role === 'admin' ? 'admin' : 'member',
      actorCodeNumber: payload && payload.codeNumber,
      actorName: payload && payload.displayName,
      postId: body.postId,
      metadata: { source: 'feed' }
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || 'Activity logging failed' });
  }
}

function isMissingPinnedColumn(error) {
  return Boolean(error && String(error.message || '').includes('is_pinned'));
}

async function attachEngagement(supabase, posts, payload = {}) {
  const ids = posts.map((post) => normalizePostId(post.id)).filter(Boolean);
  if (!ids.length) return posts;
  const statsByPostId = await getStatsByPostId(supabase, ids);
  const reactionsByPostId = await getViewerReactionsByPostId(supabase, ids, payload);
  return posts.map((post) => {
    const key = String(post.id);
    return {
      ...post,
      stats: statsByPostId.get(key) || defaultStats(post.id),
      viewer_reactions: reactionsByPostId.get(key) || []
    };
  });
}

async function getStatsByPostId(supabase, ids) {
  const result = new Map();
  try {
    const { data, error } = await supabase
      .from('fp_post_stats')
      .select('*')
      .in('post_id', ids);
    if (error) throw new Error(error.message);
    (data || []).forEach((row) => result.set(String(row.post_id), normalizeStats(row)));
  } catch (error) {
    if (!isMissingEngagementTable(error)) console.error('post stats skipped:', error.message || error);
  }
  return result;
}

async function getViewerReactionsByPostId(supabase, ids, payload = {}) {
  const result = new Map();
  const codeNumber = cleanText(payload && payload.codeNumber, 80);
  if (!codeNumber) return result;
  try {
    const { data, error } = await supabase
      .from('fp_post_reactions')
      .select('post_id,reaction_type')
      .eq('actor_code_number', codeNumber)
      .in('post_id', ids);
    if (error) throw new Error(error.message);
    (data || []).forEach((row) => {
      const key = String(row.post_id);
      const list = result.get(key) || [];
      list.push(row.reaction_type);
      result.set(key, list);
    });
  } catch (error) {
    if (!isMissingEngagementTable(error)) console.error('post reactions skipped:', error.message || error);
  }
  return result;
}

async function applyFeedEvent(supabase, eventType, body = {}, payload = {}) {
  const postId = normalizePostId(body.postId);
  if (eventType !== 'popup_view' && !postId) throw new Error('게시물 ID가 필요합니다.');

  if (eventType === 'popup_view' || eventType === 'popup_click') {
    await recordPopupEvent(supabase, eventType, body, payload, postId);
  }
  if (eventType === 'like' || eventType === 'save') {
    const inserted = await createReaction(supabase, postId, eventType, payload);
    if (inserted) await incrementStat(supabase, postId, STAT_FIELDS[eventType], 1);
    return;
  }
  if (eventType === 'unlike' || eventType === 'unsave') {
    const reactionType = eventType === 'unlike' ? 'like' : 'save';
    const removed = await deleteReaction(supabase, postId, reactionType, payload);
    if (removed) await incrementStat(supabase, postId, STAT_FIELDS[eventType], -1);
    return;
  }
  const field = STAT_FIELDS[eventType];
  if (field && postId) await incrementStat(supabase, postId, field, 1);
}

async function createReaction(supabase, postId, reactionType, payload = {}) {
  const actorCodeNumber = cleanText(payload && payload.codeNumber, 80);
  if (!actorCodeNumber) return false;
  try {
    const { error } = await supabase.from('fp_post_reactions').insert({
      post_id: postId,
      actor_code_number: actorCodeNumber,
      actor_name: cleanText(payload && payload.displayName, 80) || null,
      reaction_type: reactionType
    });
    if (!error) return true;
    if (isDuplicateError(error)) return false;
    throw new Error(error.message);
  } catch (error) {
    if (!isMissingEngagementTable(error)) throw error;
    return false;
  }
}

async function deleteReaction(supabase, postId, reactionType, payload = {}) {
  const actorCodeNumber = cleanText(payload && payload.codeNumber, 80);
  if (!actorCodeNumber) return false;
  try {
    const { data, error } = await supabase
      .from('fp_post_reactions')
      .delete()
      .eq('post_id', postId)
      .eq('actor_code_number', actorCodeNumber)
      .eq('reaction_type', reactionType)
      .select('post_id');
    if (error) throw new Error(error.message);
    return Boolean(data && data.length);
  } catch (error) {
    if (!isMissingEngagementTable(error)) throw error;
    return false;
  }
}

async function incrementStat(supabase, postId, field, amount) {
  if (!postId || !field || !Number.isFinite(amount)) return;
  try {
    await supabase.from('fp_post_stats').upsert({ post_id: postId }, { onConflict: 'post_id' });
    const { data, error } = await supabase
      .from('fp_post_stats')
      .select(field)
      .eq('post_id', postId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const current = Math.max(0, Number(data && data[field] || 0));
    const next = Math.max(0, current + amount);
    const update = { [field]: next, updated_at: new Date().toISOString() };
    const updated = await supabase.from('fp_post_stats').update(update).eq('post_id', postId);
    if (updated.error) throw new Error(updated.error.message);
  } catch (error) {
    if (!isMissingEngagementTable(error)) console.error('post stat skipped:', error.message || error);
  }
}

async function recordPopupEvent(supabase, eventType, body = {}, payload = {}, postId = null) {
  try {
    const { error } = await supabase.from('fp_popup_views').insert({
      popup_version: cleanText(body.popupVersion, 120) || null,
      post_id: postId || null,
      actor_code_number: cleanText(payload && payload.codeNumber, 80) || null,
      actor_name: cleanText(payload && payload.displayName, 80) || null,
      event_type: eventType === 'popup_click' ? 'click' : 'view'
    });
    if (error) throw new Error(error.message);
  } catch (error) {
    if (!isMissingEngagementTable(error)) console.error('popup event skipped:', error.message || error);
  }
}

function normalizeStats(row = {}) {
  return {
    view_count: Number(row.view_count || 0),
    like_count: Number(row.like_count || 0),
    save_count: Number(row.save_count || 0),
    share_count: Number(row.share_count || 0),
    download_count: Number(row.download_count || 0),
    popup_click_count: Number(row.popup_click_count || 0)
  };
}

function defaultStats(postId) {
  return normalizeStats({ post_id: postId });
}

function normalizePostId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isDuplicateError(error) {
  const message = String(error && error.message || '');
  return message.includes('duplicate key') || message.includes('23505');
}

function isMissingEngagementTable(error) {
  const message = String(error && error.message || '');
  return message.includes('fp_post_stats') || message.includes('fp_post_reactions') || message.includes('fp_popup_views');
}

async function getEntryPopup(supabase) {
  try {
    const { data, error } = await supabase
      .from('fp_settings')
      .select('value,updated_at')
      .eq('key', 'entry_popup')
      .maybeSingle();
    if (error) {
      console.error('Entry popup setting skipped:', error.message);
      return null;
    }
    const value = parseJson(data && data.value);
    if (!value || !value.enabled) return null;
    const imageUrl = cleanText(value.imageUrl || value.mediaUrl, 1200);
    if (!imageUrl) return null;
    return {
      enabled: true,
      imageUrl,
      postId: cleanText(value.postId, 80),
      version: cleanText(value.version || data.updated_at, 80) || imageUrl
    };
  } catch (error) {
    console.error('Entry popup setting skipped:', error.message);
    return null;
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

function normalizeStringList(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,|\s]+/);
  return [...new Set(list.map((item) => cleanText(item, 12).toUpperCase().replace(/^AO/, 'A0')).filter(Boolean))];
}

function normalizeAwardYearType(value) {
  const text = cleanText(value, 40);
  return text === 'secondYear' || text.includes('2') ? 'secondYear' : 'firstYear';
}

function normalizeAwardTiers(value) {
  const list = Array.isArray(value) ? value : [value];
  return list.map((tier) => {
    const item = tier && typeof tier === 'object' ? tier : {};
    return {
      targetValue: toNumber(item.targetValue || item.target_value || item.targetAmount || item.target_amount),
      awardAmount: toNumber(item.awardAmount || item.award_amount),
      awardItem: cleanText(item.awardItem || item.award_item || item.prize, 160)
    };
  })
    .filter((tier) => tier.targetValue > 0 && (tier.awardAmount > 0 || tier.awardItem))
    .sort((a, b) => a.targetValue - b.targetValue);
}

function toNumber(value) {
  const number = Number(String(value || '').replace(/,/g, '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(number) ? number : 0;
}

function isMissingPerformanceTable(error) {
  const message = String(error && error.message || '');
  return message.includes('fp_performance_datasets') || message.includes('public.fp_performance_datasets');
}

function cleanText(value, maxLength) {
  return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, maxLength);
}
