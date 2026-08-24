const { getSupabaseAdmin, readJson, requirePublicAccess } = require('./_public-access');
const { logActivity } = require('./_activity');

const FEED_EVENTS = new Set(['view', 'like', 'unlike', 'save', 'unsave', 'download', 'share', 'popup_view', 'popup_click']);
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
    let { data, error } = await supabase
      .from('fp_posts')
      .select('*')
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false });
    if (isMissingPinnedColumn(error)) {
      const retry = await supabase.from('fp_posts').select('*').order('created_at', { ascending: false });
      data = retry.data;
      error = retry.error;
    }
    if (error) throw new Error(error.message);
    data = await attachEngagement(supabase, data || [], access.payload);
    const popup = await getEntryPopup(supabase);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ posts: data || [], popup });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || '자료를 불러오지 못했습니다.' });
  }
};

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

function cleanText(value, maxLength) {
  return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, maxLength);
}
