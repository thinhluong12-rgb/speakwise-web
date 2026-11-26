import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const indexHtml = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const syncJs = await readFile(new URL('../public/sync.js', import.meta.url), 'utf8');
const worker = await readFile(new URL('../ai-worker.js', import.meta.url), 'utf8');
const browser = await readFile(new URL('../public/speaking-voice.js', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20261117094612_secure_voice_session_creation_and_daily_quota.sql', import.meta.url), 'utf8');
const quotaSchemaMigration = await readFile(new URL('../supabase/migrations/20261117094920_harden_voice_session_creation.sql', import.meta.url), 'utf8');
const quotaMigration = await readFile(new URL('../supabase/migrations/20261117094951_voice_quota_trigger_and_invoker_rpc.sql', import.meta.url), 'utf8');
const ageMigration = await readFile(new URL('../supabase/migrations/20261123100000_self_declared_adult_confirmation.sql', import.meta.url), 'utf8');
const capsMigration = await readFile(new URL('../supabase/migrations/20261124080000_remove_voice_daily_and_duration_caps.sql', import.meta.url), 'utf8');
const rlsMigration = await readFile(new URL('../supabase/migrations/20261117095055_fix_voice_session_insert_policy_initplan.sql', import.meta.url), 'utf8');

test('Voice endpoints require a server-verified adult account', () => {
  assert.match(worker, /app_metadata\?\.adult_verified\s*===\s*true/);
  assert.match(worker, /if\(!user\.adultVerified\)/);
  assert.match(worker, /\/voice\/session/);
  assert.match(worker, /\/voice\/analyze/);
});

test('session creation is adult-gated and concurrency-safe in the database', () => {
  assert.match(worker, /rpc\/start_speakwise_voice_session/);
  assert.doesNotMatch(worker, /DAILY_VOICE_LIMIT/, 'the application no longer caps sessions per day');
});

test('browser uses WebRTC and never receives the standard API key', () => {
  assert.match(browser, /RTCPeerConnection/);
  assert.match(browser, /\/v1\/realtime\/calls/);
  assert.match(browser, /google\.ai\.generativelanguage\.v1alpha\.GenerativeService\.BidiGenerateContentConstrained/);
  assert.doesNotMatch(browser, /OPENAI_API_KEY/);
});

test('analysis does not claim to assess pronunciation from transcript alone', () => {
  assert.match(worker, /pronunciation:\{status:'not_assessed'/);
  assert.match(worker, /Pronunciation MUST be marked not_assessed/);
});

test('transcript storage metadata states that raw audio is not stored', () => {
  assert.match(browser, /raw_audio_stored:false/);
});

test('browser requests server authorization before opening the microphone for either provider', () => {
  const authorize = Math.min(
    ...[browser.indexOf("post('/voice/session',c)"), browser.indexOf("post('/voice/gemini-token',c)")].filter(x => x >= 0)
  );
  const microphone = browser.indexOf("navigator.mediaDevices.getUserMedia");
  assert.ok(authorize >= 0 && microphone > authorize);
  assert.doesNotMatch(browser, /from\('speakwise_voice_sessions'\)\.insert/);
});

test('analysis rejects evidence and corrections absent from the learner transcript', () => {
  assert.match(worker, /learnerEvidence\.includes\(normalizeEvidence\(x\.quote\)\)/);
  assert.match(worker, /learnerEvidence\.includes\(normalizeEvidence\(x\.original\)\)/);
  assert.match(worker, /generated\.modelUsed/);
});

test('database quota RPC is invoker-secure and only executable by authenticated users', () => {
  assert.match(migration, /security invoker/i);
  assert.match(migration, /app_metadata.*adult_verified/s);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /v_count >= 5/);
  assert.match(migration, /revoke all on function[\s\S]*from public/i);
  assert.match(migration, /grant execute on function[\s\S]*to authenticated/i);
});

test('adult verification precedes both providers and each quota row follows provider credential issuance', () => {
  const adultGate = worker.indexOf('if(!user.adultVerified)');
  const geminiProvider = worker.indexOf('https://generativelanguage.googleapis.com/v1alpha/auth_tokens');
  const geminiQuotaRpc = worker.indexOf('/rest/v1/rpc/start_speakwise_voice_session');
  const openAiProvider = worker.indexOf('https://api.openai.com/v1/realtime/client_secrets');
  const openAiQuotaRpc = worker.lastIndexOf('/rest/v1/rpc/start_speakwise_voice_session');
  assert.ok(adultGate >= 0 && geminiProvider > adultGate && openAiProvider > adultGate);
  assert.ok(geminiQuotaRpc > geminiProvider);
  assert.ok(openAiQuotaRpc > openAiProvider);
});

test('quota ledger is enforced by a non-callable private trigger function', () => {
  assert.match(quotaSchemaMigration, /create schema if not exists private/i);
  assert.match(quotaSchemaMigration, /create table if not exists private\.speakwise_voice_daily_usage/i);
  assert.match(quotaMigration, /security definer[\s\S]*set search_path = ''/i);
  assert.match(quotaMigration, /before insert on public\.speakwise_voice_sessions/i);
  assert.match(quotaMigration, /revoke all on function private\.enforce_speakwise_voice_daily_quota\(\) from public, anon, authenticated/i);
  assert.match(quotaMigration, /new\.started_at := pg_catalog\.now\(\)/);
});

test('voice session insert RLS wraps auth claims in an initplan', () => {
  assert.match(rlsMigration, /\(select auth\.uid\(\)\)/);
  assert.match(rlsMigration, /\(\(select auth\.jwt\(\)\) -> 'app_metadata'/);
});

test('saved session history is loaded through owner-scoped Supabase queries', () => {
  assert.match(browser, /dataset\.swv='open-history'/);
  assert.match(browser, /speakwise_voice_sessions'\)\.select\('id,topic,cefr_level,started_at,duration_seconds,analysis_status,analysis'\)/);
  assert.match(browser, /speakwise_voice_turns'\)\.select\('turn_id,turn_index,speaker,text,status,occurred_at'\)/);
  assert.match(browser, /\.limit\(8\)/);
});

test('adult confirmation is recorded only by a server-side function that never stores the birth date', () => {
  assert.match(ageMigration, /create or replace function public\.speakwise_confirm_adult\(p_birth_date date, p_confirmed boolean\)/i);
  assert.match(ageMigration, /security definer\s+set search_path = ''/i);
  assert.match(ageMigration, /v_user_id uuid := auth\.uid\(\)/);
  assert.match(ageMigration, /'adult_verified', true/);
  assert.match(ageMigration, /under_18_declared/);
  assert.match(ageMigration, /revoke all on function public\.speakwise_confirm_adult\(date, boolean\) from public, anon/i);
  assert.match(ageMigration, /grant execute on function public\.speakwise_confirm_adult\(date, boolean\) to authenticated/i);
  assert.doesNotMatch(ageMigration, /birth_date\s+date\s+not null|birth_date\s+date,\s*\n\s*status/i);
  assert.match(ageMigration, /revoke all on table private\.speakwise_age_declarations from public, anon, authenticated, service_role/i);
});

test('browser confirms age through the RPC, refreshes the session and never writes the adult flag itself', () => {
  assert.match(browser, /rpc\('speakwise_confirm_adult'/);
  assert.match(browser, /auth\.refreshSession\(\)/);
  assert.doesNotMatch(browser, /updateUser\(/);
  assert.doesNotMatch(browser, /adult_verified\s*[:=]\s*true\s*[,}]/);
});

test('age confirmation migration does not schema-qualify SQL constructs that are not functions', () => {
  assert.doesNotMatch(ageMigration, /pg_catalog\.(coalesce|nullif|greatest|least)\(/i);
});

test('voice migrations never call SQL syntax words as schema-qualified functions', async () => {
  const { readdir } = await import('node:fs/promises');
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const fixName = '20261124040000_fix_voice_functions_builtin_calls.sql';
  const fix = await readFile(new URL(fixName, dir), 'utf8');
  assert.match(fix, /replace\(d, 'pg_catalog\.coalesce\(', 'coalesce\('\)/);
  assert.match(fix, /replace\(d, 'pg_catalog\.trim\(', 'pg_catalog\.btrim\('\)/);
  const files = (await readdir(dir)).filter(name => name.endsWith('.sql') && name > '20261117' && name !== fixName && name !== '20261123100000_self_declared_adult_confirmation.sql');
  assert.ok(files.length > 0);
});

test('Gemini Live frames are decoded from binary as well as text', () => {
  assert.match(browser, /ws\.binaryType='arraybuffer'/);
  assert.match(browser, /new TextDecoder\(\)\.decode\(raw\)/);
});

test('Speaking Lab no longer shows consent, recent sessions, starters, principle, mute or interrupt controls', () => {
  for (const text of ['Before you begin', 'swvConsent', 'Recent sessions', 'Mute microphone', 'Interrupt Coach AI', 'data-swv="mute"', 'data-swv="interrupt"']) {
    assert.ok(!browser.includes(text), 'voice room must not contain: ' + text);
  }
  for (const text of ['Try a conversation starter', 'Learning principle']) {
    assert.ok(!indexHtml.includes(text), 'Speaking Lab page must not contain: ' + text);
  }
  assert.ok(!indexHtml.includes('How your coach helps'), 'the right-hand card was replaced by the collocation list');
  assert.match(indexHtml, /Collocations Coach AI will help you use/);
});

test('the topic collocations are sent to the coach and to the report', () => {
  assert.match(indexHtml, /window\.SpeakwiseSpeaking=\{targets:speakingTargetPhrases\}/);
  assert.match(browser, /targetPhrases/);
  assert.match(browser, /post\('\/voice\/analyze',\{sessionId:s\.dbId,targetPhrases:s\.targets\|\|\[\]\}\)/);
  assert.match(worker, /const coachInstructions=/);
  assert.match(worker, /cleanTargetPhrases\(b\.targetPhrases\)/);
});

test('voice sessions are not capped by the app: no daily limit, no duration limit, only Gemini limits apply', () => {
  assert.doesNotMatch(capsMigration, /DAILY_VOICE_LIMIT/);
  assert.doesNotMatch(capsMigration, />=\s*5\b/);
  assert.match(capsMigration, /check \(session_count >= 0\)/);
  assert.match(capsMigration, /duration_seconds <= 86400/);
  assert.match(capsMigration, /VOICE_OWNER_MISMATCH/);
  assert.match(capsMigration, /ADULT_VERIFICATION_REQUIRED/);
  assert.doesNotMatch(browser, /Session time limit reached/);
  assert.doesNotMatch(browser, /\?720:1200/);
});

test('browser keeps a Gemini conversation alive by reconnecting with the resumption handle', () => {
  assert.match(browser, /sessionResumptionUpdate/);
  assert.match(browser, /const reconnectGemini=/);
  assert.match(browser, /resumeSessionId:s\.dbId,resumptionHandle:s\.resumeHandle/);
  assert.match(browser, /if\(!s\.started\)\{s\.started=Date\.now\(\)/, 'a reconnect must not restart the session clock');
  assert.match(browser, /s\.ws===ws&&s\.status==='connected'&&!s\.busy/);
});

test('Collocations Coach AI will help you use follows the selected Conversation topic', () => {
  const seedStart = indexHtml.indexOf('window.SPEAKING_SEED');
  const jsonStart = indexHtml.indexOf('=', seedStart) + 1;
  const seed = JSON.parse(indexHtml.slice(jsonStart, indexHtml.indexOf('</script>', jsonStart)).trim().replace(/;$/, ''));
  assert.equal(seed.topics.length, 9);

  const fnStart = indexHtml.indexOf('function speakingTargetPhrases');
  const fnEnd = indexHtml.indexOf('window.SpeakwiseSpeaking=', fnStart);
  const cardStart = indexHtml.indexOf('function speakingTargetsCard');
  const cardEnd = indexHtml.indexOf('function speakingLabPage', cardStart);
  const store = { topics: seed.topics, entries: seed.entries };
  const ui = { labIds: [], speakingTopic: seed.topics[0].name };
  const api = new Function('store', 'ui', 'stageOf', 'esc', 'icon',
    indexHtml.slice(fnStart, fnEnd) + indexHtml.slice(cardStart, cardEnd) + ';return { speakingTargetPhrases, speakingTargetsCard };')(
    store, ui, () => 'new', x => String(x), () => '');

  for (const topic of seed.topics) {
    const expected = seed.entries.filter(e => e.topicId === topic.id).map(e => e.phrase).slice(0, 12);
    const got = api.speakingTargetPhrases(topic.name).map(x => x.phrase);
    assert.deepEqual(got, expected, 'collocations for ' + topic.name);
    ui.speakingTopic = topic.name;
    const html = api.speakingTargetsCard();
    assert.match(html, /Collocations Coach AI will help you use/);
    assert.ok(html.includes('Topic: <strong>' + topic.name + '</strong>'));
    for (const phrase of expected) assert.ok(html.includes('<strong>' + phrase + '</strong>'), phrase + ' listed for ' + topic.name);
  }
  const work = api.speakingTargetPhrases('Work & Business').map(x => x.phrase);
  const family = api.speakingTargetPhrases('Family & Relationships').map(x => x.phrase);
  assert.ok(work.length && family.length);
  assert.equal(work.filter(x => family.includes(x)).length, 0, 'different topics show different collocations');
});

test('the Conversation topic dropdown lists the web topics and the page reads the selected topic', () => {
  assert.match(indexHtml, /const speakingTopicNames=\(\)=>/);
  assert.match(indexHtml, /<select id="slTopic">'\+speakingTopicNames\(\)\.map/);
  assert.match(indexHtml, /if\(e\.target\.id==='slTopic'&&ui\.speakingTopic!==e\.target\.value\)\{ui\.speakingTopic=e\.target\.value;[^}]*render\(\)\}/);
  assert.match(indexHtml, /<aside class="sw-sl-side">'\+speakingTargetsCard\(\)\+'<\/aside>/);
});

test('Topic Collocations and Speaking Lab use larger type', () => {
  assert.match(indexHtml, /v4\.7 readability: Topic Collocations and Speaking Lab/);
  assert.match(indexHtml, /\.library-table \.phrase-cell\{font-size:19px/);
  assert.match(indexHtml, /\.sw-sl-bubble\{font-size:18px/);
  assert.match(indexHtml, /\.sw-sl-target-list strong\{font-size:18px/);
});

function loadTargetApi(store, ui) {
  const fnStart = indexHtml.indexOf('function speakingTargetPhrases');
  const fnEnd = indexHtml.indexOf('window.SpeakwiseSpeaking=', fnStart);
  const cardStart = indexHtml.indexOf('function speakingTargetsCard');
  const cardEnd = indexHtml.indexOf('function speakingLabPage', cardStart);
  return new Function('store', 'ui', 'stageOf', 'esc', 'icon', 'save',
    indexHtml.slice(fnStart, fnEnd) + indexHtml.slice(cardStart, cardEnd) + ';return { speakingTargetPhrases, speakingTargetsCard, toggleSpeakingUsed };')(
    store, ui, () => 'new', x => String(x), () => '', () => {});
}

test('collocations used in an earlier practice move to the bottom; ticks made in this practice keep their place', () => {
  const topics = [{ id: 't', name: 'Work & Business' }];
  const entries = ['a', 'b', 'c', 'd'].map((x, i) => ({ id: 'e' + i, topicId: 't', phrase: 'phrase ' + x, meaning: 'm ' + x }));
  const epoch = Date.parse('2026-11-25T10:00:00Z');
  const store = { topics, entries, speakingUsed: {
    e0: { used: true, usedAt: '2026-11-24T09:00:00Z', updatedAt: '2026-11-24T09:00:00Z' },
    e2: { used: true, usedAt: '2026-11-25T10:30:00Z', updatedAt: '2026-11-25T10:30:00Z' },
    e3: { used: false, usedAt: '2026-11-20T09:00:00Z', updatedAt: '2026-11-24T09:00:00Z' }
  } };
  const ui = { labIds: [], speakingTopic: 'Work & Business', targetsEpoch: epoch };
  const api = loadTargetApi(store, ui);
  const list = api.speakingTargetPhrases('Work & Business');
  assert.deepEqual(list.map(x => x.phrase), ['phrase b', 'phrase c', 'phrase d', 'phrase a'], 'e0 (earlier) goes last; e2 (this practice) and unticked e3 keep their place');
  assert.deepEqual(list.map(x => x.used), [false, true, false, true]);
  ui.targetsEpoch = Date.parse('2026-11-26T00:00:00Z');
  assert.deepEqual(api.speakingTargetPhrases('Work & Business').map(x => x.phrase), ['phrase b', 'phrase d', 'phrase a', 'phrase c'], 'after a new practice starts, e2 moves down too');
});

test('each collocation has a right-hand tick box that is remembered and synced', () => {
  const store = { topics: [{ id: 't', name: 'Daily' }], entries: [{ id: 'x1', topicId: 't', phrase: 'take a break', meaning: 'nghỉ' }], speakingUsed: {} };
  const ui = { labIds: [], speakingTopic: 'Daily', targetsEpoch: Date.now() };
  let saved = 0;
  const api = new Function('store', 'ui', 'stageOf', 'esc', 'icon', 'save',
    indexHtml.slice(indexHtml.indexOf('function speakingTargetPhrases'), indexHtml.indexOf('window.SpeakwiseSpeaking=')) +
    indexHtml.slice(indexHtml.indexOf('function speakingTargetsCard'), indexHtml.indexOf('function speakingLabPage')) +
    ';return { speakingTargetsCard, toggleSpeakingUsed };')(store, ui, () => 'new', x => String(x), () => '', () => { saved++; });
  assert.match(api.speakingTargetsCard(), /<input type="checkbox" class="sw-sl-target-check" data-used-id="x1"/);
  assert.match(api.speakingTargetsCard(), /0\/1 đã dùng/);
  api.toggleSpeakingUsed('x1', true, null);
  assert.equal(store.speakingUsed.x1.used, true);
  assert.equal(store.speakingUsed.x1.count, 1);
  assert.ok(saved >= 1, 'ticks are saved');
  assert.match(api.speakingTargetsCard(), /is-used/);
  assert.match(api.speakingTargetsCard(), /checked/);
  api.toggleSpeakingUsed('x1', false, null);
  assert.equal(store.speakingUsed.x1.used, false);
  assert.match(indexHtml, /speakingUsed:\(saved\.speakingUsed&&typeof saved\.speakingUsed==='object'/);
  assert.match(indexHtml, /e\.target\.classList\.contains\('sw-sl-target-check'\)\)\{toggleSpeakingUsed/);
  assert.match(syncJs, /speakingUsed:Object\.fromEntries/);
  assert.match(syncJs, /usedMerged/);
});

test('the collocation card matches the Coach AI panel height and scrolls inside', () => {
  assert.match(indexHtml, /\.sw-sl-targets-card\{position:absolute;inset:0;display:flex;flex-direction:column;overflow:hidden/);
  assert.match(indexHtml, /\.sw-sl-targets-card \.sw-sl-target-list\{flex:1 1 auto;min-height:0;overflow-y:auto/);
  assert.match(indexHtml, /\.sw-sl-targets-card\{position:static;max-height:480px\}/);
  assert.match(indexHtml, /ui\.targetsEpoch=Date\.now\(\);ui\.speakingStarted=false/);
});

test('sync never writes back shared topics and entries that have no owner', async () => {
  const start = syncJs.indexOf('async function withoutSharedRows');
  const end = syncJs.indexOf('async function push(){');
  assert.ok(start > 0 && end > start);
  const calls = [];
  const sharedIds = new Set(['travel-experiences', 'shared-entry-7']);
  const api = { from: table => ({ select: () => ({ in: (column, ids) => ({ is: async (field, value) => {
    calls.push({ table, column, field, value, count: ids.length });
    return { data: ids.filter(id => sharedIds.has(id)).map(id => ({ id })), error: null };
  } }) }) }) };
  const withoutSharedRows = new Function('api', syncJs.slice(start, end) + ';return withoutSharedRows;')(api);

  const mine = { id: 'my-custom-topic' };
  const result = await withoutSharedRows('speakwise_topics', [{ id: 'travel-experiences' }, mine]);
  assert.deepEqual(result, [mine], 'the shared topic is not pushed, the learner\'s own topic is');
  assert.deepEqual(calls[0], { table: 'speakwise_topics', column: 'id', field: 'owner_id', value: null, count: 2 });

  calls.length = 0;
  assert.deepEqual(await withoutSharedRows('speakwise_entries', []), []);
  assert.equal(calls.length, 0, 'nothing to check, no request');

  const many = Array.from({ length: 400 }, (_, i) => ({ id: 'e' + i }));
  many.push({ id: 'shared-entry-7' });
  const filtered = await withoutSharedRows('speakwise_entries', many);
  assert.equal(filtered.length, 400);
  assert.deepEqual(calls.map(c => c.count), [150, 150, 101], 'ids are checked in batches');

  const failing = new Function('api', syncJs.slice(start, end) + ';return withoutSharedRows;')({ from: () => ({ select: () => ({ in: () => ({ is: async () => ({ data: null, error: new Error('boom') }) }) }) }) });
  await assert.rejects(() => failing('speakwise_topics', [{ id: 'x' }]), /boom/);

  assert.match(syncJs, /const customTopics=await withoutSharedRows\('speakwise_topics',customTopicsAll\);/);
  assert.match(syncJs, /const entries=await withoutSharedRows\('speakwise_entries',entriesAll\);/);
});

test('sign-in screen shows the logo, the email and password form, then Google below it', () => {
  const start = syncJs.indexOf('function showDialog');
  const block = syncJs.slice(start, syncJs.indexOf('// ---------- account menu'));
  assert.match(syncJs, /const LOGO_SRC='\/speakwise-logo\.webp'/);
  assert.match(syncJs, /<div class="sw-auth-logo"><img src="'\+LOGO_SRC\+'"/);
  assert.ok(block.indexOf('id="swAuthEmail"') > 0 && block.indexOf('id="swAuthPassword"') > block.indexOf('id="swAuthEmail"'));
  assert.ok(block.indexOf("id=\"swGoogleLogin\"") > block.indexOf('id="swAuthSubmit"'), 'the Google button sits below the form');
  assert.match(block, /signInWithOAuth\(\{provider:'google'/);
  assert.match(block, /signInWithPassword/);
  assert.match(block, /signUp\(/);
  assert.match(block, /resetPasswordForEmail/);
  assert.match(indexHtml, /sync\.js\?v=8/);
});

test('bottom-left account chip shows a small avatar with the name; its menu changes photo and name or signs out', () => {
  assert.match(syncJs, /avatarHtml\('sw-avatar-sm'\)\+'<span class="sw-account-name">'/);
  assert.match(syncJs, /id="swMenuAvatar"[^]*?Thay đổi ảnh đại diện/);
  assert.match(syncJs, /id="swMenuRename"[^]*?Đổi tên hiển thị/);
  assert.match(syncJs, /id="swMenuLogout"[^]*?Đăng xuất/);
  assert.match(syncJs, /api\.auth\.updateUser\(\{data:\{display_name:value\}\}\)/);
  assert.match(syncJs, /api\.auth\.signOut\(\)/);
  assert.match(syncJs, /resizeToSquare\(file,192\)/);
  assert.match(syncJs, /profile:\{avatar:/, 'the picture is synced with the other preferences');
  assert.match(indexHtml, /#syncButton\.is-profile\{display:flex/);
  assert.match(indexHtml, /\.sw-account-menu\{position:fixed/);
});

test('profile helpers: display name, initials and a strict check of stored avatars', () => {
  const grab = name => { const m = syncJs.match(new RegExp('const ' + name + '=[^\\n]+;')); assert.ok(m, name); return m[0]; };
  const api = new Function(grab('displayName') + grab('initials') + grab('validAvatar') + ';return { displayName, initials, validAvatar };')();
  assert.equal(api.displayName({ email: 'thinh@example.com', user_metadata: {} }), 'thinh');
  assert.equal(api.displayName({ email: 'x@y.z', user_metadata: { full_name: 'Thịnh Lương' } }), 'Thịnh Lương');
  assert.equal(api.displayName({ email: 'x@y.z', user_metadata: { display_name: 'Coach', full_name: 'Other' } }), 'Coach');
  assert.equal(api.initials('thịnh'), 'T');
  assert.equal(api.initials(''), '?');
  assert.equal(api.validAvatar({ dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' }), true);
  assert.equal(api.validAvatar({ dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }), false, 'only JPEG data URLs made by the app are accepted');
  assert.equal(api.validAvatar({ dataUrl: 'javascript:alert(1)' }), false);
  assert.equal(api.validAvatar({ dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(70000) }), false, 'oversized values are refused');
  assert.equal(api.validAvatar(null), false);
});
