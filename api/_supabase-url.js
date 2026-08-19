function normalizeSupabaseUrl(value) {
  return String(value || '').replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/, '');
}

module.exports = { normalizeSupabaseUrl };
