import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker = await readFile(new URL('../ai-worker.js', import.meta.url), 'utf8');
const browser = await readFile(new URL('../public/speaking-voice.js', import.meta.url), 'utf8');

test('Voice endpoints require a server-verified adult account', () => {
  assert.match(worker, /app_metadata\?\.adult_verified\s*===\s*true/);
  assert.match(worker, /if\(!user\.adultVerified\)/);
  assert.match(worker, /\/voice\/session/);
  assert.match(worker, /\/voice\/analyze/);
});

test('daily Voice Mode cap rejects the sixth session', () => {
  assert.match(worker, /usageRows\.length\s*>=\s*5/);
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
