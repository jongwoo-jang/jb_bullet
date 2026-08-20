const crypto = require('crypto');
const { createAccessToken, getSupabaseAdmin, readJson } = require('../_public-access');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = await readJson(req);
    const supabase = getSupabaseAdmin();
    if (body.mode === 'signup') return signup(body, supabase, res);
    if (body.mode === 'reset') return resetPassword(body, supabase, res);
    return login(body, supabase, res);
  } catch (error) {
    console.error(error);
    if (isMissingMemberTable(error)) {
      return res.status(500).json({ error: '관리자가 회원가입 코드 설정을 완료해야 합니다.' });
    }
    return res.status(500).json({ error: error.message || '접속 확인에 실패했습니다.' });
  }
};

async function signup(body, supabase, res) {
  const codeNumber = normalizeCodeNumber(body.codeNumber);
  const branch = normalizeBranch(body.branch);
  const displayName = normalizeDisplayName(body.displayName);
  const password = String(body.password || '');
  if (!codeNumber || !branch || !displayName || !isValidPassword(password)) {
    return res.status(400).json({ error: '실명, 코드번호, 소속지점, 비밀번호를 모두 입력해 주세요.' });
  }

  const code = await getActiveMemberCode(supabase, codeNumber);
  if (!code || normalizeBranch(code.branch) !== branch) {
    return res.status(403).json({ error: '등록된 소속지점과 코드번호가 일치하지 않습니다.' });
  }

  const { data: existing, error: existingError } = await supabase
    .from('fp_members')
    .select('id')
    .eq('code_number', codeNumber)
    .maybeSingle();
  if (existingError) throw new Error(existingError.message);
  if (existing) return res.status(409).json({ error: '이미 가입된 코드번호입니다. 로그인해 주세요.' });

  const { salt, hash } = hashPassword(password);
  const verifiedName = normalizeDisplayName(code.display_name) || displayName;
  const memberRow = {
    code_number: codeNumber,
    branch,
    display_name: verifiedName,
    password_hash: hash,
    password_salt: salt
  };
  let { error: insertError } = await supabase.from('fp_members').insert(memberRow);
  if (isMissingDisplayNameColumn(insertError)) {
    const fallback = { ...memberRow };
    delete fallback.display_name;
    const retry = await supabase.from('fp_members').insert(fallback);
    insertError = retry.error;
  }
  if (insertError) throw new Error(insertError.message);

  res.setHeader('Cache-Control', 'no-store');
  return res.status(201).json({ token: createAccessToken({ codeNumber, branch, displayName: verifiedName }), branch, codeNumber, displayName: verifiedName });
}

async function login(body, supabase, res) {
  const codeNumber = normalizeCodeNumber(body.codeNumber);
  const password = String(body.password || '');
  if (!codeNumber || !password) {
    return res.status(400).json({ error: '코드번호와 비밀번호를 입력해 주세요.' });
  }

  const member = await getMemberByCode(supabase, codeNumber);
  const { data: activeCode, error: codeError } = await supabase
    .from('fp_member_codes')
    .select('branch, is_active')
    .eq('code_number', codeNumber)
    .eq('is_active', true)
    .maybeSingle();
  if (codeError) throw new Error(codeError.message);
  const branch = normalizeBranch(member && member.branch);
  const displayName = normalizeDisplayName(member && member.display_name);
  if (!member || !activeCode || normalizeBranch(activeCode.branch) !== branch || !verifyPassword(password, member.password_salt, member.password_hash)) {
    return res.status(401).json({ error: '코드번호 또는 비밀번호를 확인해 주세요.' });
  }

  await supabase.from('fp_members').update({ last_login_at: new Date().toISOString() }).eq('code_number', codeNumber);

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ token: createAccessToken({ codeNumber, branch, displayName }), branch, codeNumber, displayName });
}

async function resetPassword(body, supabase, res) {
  const codeNumber = normalizeCodeNumber(body.codeNumber);
  const branch = normalizeBranch(body.branch);
  const displayName = normalizeDisplayName(body.displayName);
  const password = String(body.password || '');
  if (!codeNumber || !branch || !displayName || !isValidPassword(password)) {
    return res.status(400).json({ error: '실명, 소속지점, 코드번호, 새 비밀번호를 모두 입력해 주세요.' });
  }

  const code = await getActiveMemberCode(supabase, codeNumber);
  if (!code || normalizeBranch(code.branch) !== branch) {
    return res.status(403).json({ error: '등록된 소속지점과 코드번호가 일치하지 않습니다.' });
  }

  const member = await getMemberByCode(supabase, codeNumber);
  const memberBranch = normalizeBranch(member && member.branch);
  const memberName = normalizeDisplayName(member && member.display_name);
  const codeName = normalizeDisplayName(code.display_name);
  if (!member || memberBranch !== branch) {
    return res.status(404).json({ error: '가입된 회원 정보를 찾을 수 없습니다. 먼저 회원가입을 진행해 주세요.' });
  }
  if ((memberName && memberName !== '회원' && memberName !== displayName) || (codeName && codeName !== displayName)) {
    return res.status(403).json({ error: '실명, 소속지점, 코드번호를 확인해 주세요.' });
  }

  const { salt, hash } = hashPassword(password);
  const verifiedName = codeName || memberName || displayName;
  const updateRow = {
    password_hash: hash,
    password_salt: salt,
    display_name: verifiedName,
    last_login_at: new Date().toISOString()
  };
  let { error } = await supabase
    .from('fp_members')
    .update(updateRow)
    .eq('code_number', codeNumber);
  if (isMissingDisplayNameColumn(error)) {
    const fallback = { ...updateRow };
    delete fallback.display_name;
    const retry = await supabase
      .from('fp_members')
      .update(fallback)
      .eq('code_number', codeNumber);
    error = retry.error;
  }
  if (error) throw new Error(error.message);

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true, codeNumber, branch, displayName: verifiedName });
}

function normalizeCodeNumber(value) {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function normalizeBranch(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeDisplayName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 30);
}

function isValidPassword(value) {
  return String(value || '').length >= 4;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const left = Buffer.from(crypto.scryptSync(String(password), salt, 64).toString('hex'));
  const right = Buffer.from(String(hash));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function getActiveMemberCode(supabase, codeNumber) {
  let { data, error } = await supabase
    .from('fp_member_codes')
    .select('code_number, branch, display_name, is_active')
    .eq('code_number', codeNumber)
    .eq('is_active', true)
    .maybeSingle();
  if (isMissingDisplayNameColumn(error)) {
    const retry = await supabase
      .from('fp_member_codes')
      .select('code_number, branch, is_active')
      .eq('code_number', codeNumber)
      .eq('is_active', true)
      .maybeSingle();
    data = retry.data;
    error = retry.error;
  }
  if (error) throw new Error(error.message);
  return data;
}

async function getMemberByCode(supabase, codeNumber) {
  let { data, error } = await supabase
    .from('fp_members')
    .select('code_number, branch, display_name, password_hash, password_salt')
    .eq('code_number', codeNumber)
    .maybeSingle();
  if (isMissingDisplayNameColumn(error)) {
    const retry = await supabase
      .from('fp_members')
      .select('code_number, branch, password_hash, password_salt')
      .eq('code_number', codeNumber)
      .maybeSingle();
    data = retry.data;
    error = retry.error;
  }
  if (error) throw new Error(error.message);
  return data;
}

function isMissingDisplayNameColumn(error) {
  return Boolean(error && String(error.message || '').includes('display_name'));
}

function isMissingMemberTable(error) {
  const message = String(error && error.message ? error.message : '');
  return message.includes('public.fp_member_codes') || message.includes('public.fp_members');
}
