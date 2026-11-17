import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker = await readFile(new URL('../ai-worker.js', import.meta.url), 'utf8');
const browser = await readFile(new URL('../public/speaking-voice.js', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20261117094612_secure_voice_session_creation_and_daily_quota.sql', import.meta.url), 'utf8');

test('Voice endpoints require a server-verified adult account', () => {
  assert.match(worker, /app_metadata\?\.adult_verified\s*===\s*true/);
  assert.match(worker, /if\(!user\.adultVerified\)/);
  assert.match(worker, /\/voice\/session/);
  assert.match(worker, /\/voice\/analyze/);
});

test('session creation is adult-gated and concurrency-safe in the database', () => {
  assert.match(worker, /rpc\/start_speakwise_voice_session/);
  assert.match(worker, /DAILY_VOICE_LIMIT/);
});

test('browser uses WebRTC and never receives the standard API key', () => {
  assert.match(browser, /RTCPeerConnection/);
  assert.match(browser, /\/v1\/realtime\/calls/);
  assert.doesNotMatch(browser, /OPENAI_API_KEY/);
});

test('analysis does not claim to assess pronunciation from transcript alone', () => {
  assert.match(worker, /pronunciation:\{status:'not_assessed'/);
  assert.match(worker, /Pronunciation MUST be marked not_assessed/);
});

test('transcript storage metadata states that raw audio is not stored', () => {
  assert.match(browser, /raw_audio_stored:false/);
});

test('browser requests server authorization before opening the microphone', () => {
  const authorize = browser.indexOf("post('/voice/session',c)");
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
