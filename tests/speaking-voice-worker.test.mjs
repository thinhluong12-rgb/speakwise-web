import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../ai-worker.js';

const baseEnv = {
  OPENAI_API_KEY: 'test-only-placeholder',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'test-publishable-placeholder',
  ALLOWED_ORIGIN: 'https://speakwise.example'
};

const request = (path, body = {}, token = 'test-user-token') => new Request('https://speakwise.example' + path, {
  method: 'POST',
  headers: {
    origin: 'https://speakwise.example',
    'content-type': 'application/json',
    ...(token ? { authorization: 'Bearer ' + token } : {})
  },
  body: JSON.stringify(body)
});

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' }
});

test('Voice session rejects missing authentication before contacting OpenAI', async t => {
  let openAiCalls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('/auth/v1/user')) return json({ message: 'invalid token' }, 401);
    if (String(url).includes('api.openai.com')) openAiCalls++;
    throw new Error('Unexpected network request: ' + url);
  });

  const response = await worker.fetch(request('/voice/session', {}, null), baseEnv);
  assert.equal(response.status, 401);
  assert.equal(openAiCalls, 0);
});

test('Voice session rejects accounts without server-controlled adult verification', async t => {
  let openAiCalls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('/auth/v1/user')) {
      return json({ id: 'user-1', app_metadata: { adult_verified: false } });
    }
    if (String(url).includes('api.openai.com')) openAiCalls++;
    throw new Error('Unexpected network request: ' + url);
  });

  const response = await worker.fetch(request('/voice/session'), baseEnv);
  assert.equal(response.status, 403);
  assert.equal(openAiCalls, 0);
});

test('provider failure does not create a database session or consume a session quota row', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const target = String(url);
    calls.push(target);
    if (target.includes('/auth/v1/user')) {
      return json({ id: 'adult-user', app_metadata: { adult_verified: true } });
    }
    if (target.includes('api.openai.com/v1/realtime/client_secrets')) {
      return json({ error: { message: 'simulated provider outage' } }, 503);
    }
    throw new Error('Unexpected network request: ' + target);
  });

  const response = await worker.fetch(request('/voice/session'), baseEnv);
  assert.equal(response.status, 502);
  assert.equal(calls.some(url => url.includes('/rpc/start_speakwise_voice_session')), false);
});

test('database quota rejection is returned as HTTP 429 after provider credential issuance', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const target = String(url);
    calls.push(target);
    if (target.includes('/auth/v1/user')) {
      return json({ id: 'adult-user', app_metadata: { adult_verified: true } });
    }
    if (target.includes('api.openai.com/v1/realtime/client_secrets')) {
      return json({ value: 'short-lived-test-secret', expires_at: 1234567890 });
    }
    if (target.includes('/rpc/start_speakwise_voice_session')) {
      return json({ code: 'P0001', message: 'DAILY_VOICE_LIMIT' }, 400);
    }
    throw new Error('Unexpected network request: ' + target);
  });

  const response = await worker.fetch(request('/voice/session'), baseEnv);
  assert.equal(response.status, 429);
  assert.ok(calls.findIndex(url => url.includes('api.openai.com')) < calls.findIndex(url => url.includes('/rpc/start_speakwise_voice_session')));
});

test('analysis endpoint rejects a session owned by another user', async t => {
  let turnsCalls = 0;
  const env = { ...baseEnv, AI: { run: async () => { throw new Error('AI must not run'); } } };
  t.mock.method(globalThis, 'fetch', async url => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) {
      return json({ id: 'signed-in-user', app_metadata: { adult_verified: true } });
    }
    if (target.includes('/rest/v1/speakwise_voice_sessions')) {
      return json([{ id: '11111111-1111-4111-8111-111111111111', owner_id: 'different-user', topic: 'Travel', cefr_level: 'B1' }]);
    }
    if (target.includes('/rest/v1/speakwise_voice_turns')) turnsCalls++;
    throw new Error('Unexpected network request: ' + target);
  });

  const response = await worker.fetch(request('/voice/analyze', {
    sessionId: '11111111-1111-4111-8111-111111111111'
  }), env);
  assert.equal(response.status, 404);
  assert.equal(turnsCalls, 0);
});

test('Voice endpoints enforce the configured origin and POST method', async () => {
  const wrongOrigin = new Request('https://speakwise.example/voice/session', {
    method: 'POST',
    headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal((await worker.fetch(wrongOrigin, baseEnv)).status, 403);

  const wrongMethod = new Request('https://speakwise.example/voice/session', {
    method: 'GET',
    headers: { origin: 'https://speakwise.example' }
  });
  assert.equal((await worker.fetch(wrongMethod, baseEnv)).status, 405);
});


test('Gemini Live token endpoint rejects unauthenticated and unverified accounts before contacting Google', async t => {
  let googleCalls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return json({ id: 'minor-user', app_metadata: { adult_verified: false } });
    if (target.includes('generativelanguage.googleapis.com')) googleCalls++;
    throw new Error('Unexpected network request: ' + target);
  });
  const env = { ...baseEnv, GEMINI_API_KEY: 'gemini-test-placeholder' };
  const response = await worker.fetch(request('/voice/gemini-token'), env);
  assert.equal(response.status, 403);
  assert.equal(googleCalls, 0);
});

test('Gemini Live endpoint issues a short-lived constrained token for verified adult accounts and creates a session', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, options });
    if (target.includes('/auth/v1/user')) {
      return json({ id: 'verified-adult', app_metadata: { adult_verified: true } });
    }
    if (target.includes('generativelanguage.googleapis.com/v1alpha/auth_tokens')) {
      const payload = JSON.parse(options.body);
      assert.equal(payload.authToken, undefined, 'Gemini auth_tokens expects the token fields at the top level');
      assert.equal(payload.uses, 1);
      assert.equal(payload.bidiGenerateContentSetup.model, 'models/gemini-3.8-live');
      assert.deepEqual(payload.bidiGenerateContentSetup.generationConfig.responseModalities, ['AUDIO']);
      assert.ok(payload.bidiGenerateContentSetup.inputAudioTranscription);
      assert.ok(payload.bidiGenerateContentSetup.outputAudioTranscription);
      assert.equal(options.headers['x-goog-api-key'], 'gemini-test-placeholder');
      return json({ name: 'ephemeral-test-token', expireTime: '2026-11-17T16:00:00Z' });
    }
    if (target.includes('/rpc/start_speakwise_voice_session')) {
      return json('11111111-1111-4111-8111-111111111111');
    }
    throw new Error('Unexpected network request: ' + target);
  });
  const env = { ...baseEnv, GEMINI_API_KEY: 'gemini-test-placeholder' };
  const response = await worker.fetch(request('/voice/gemini-token'), env);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.provider, 'gemini');
  assert.equal(body.ephemeralToken, 'ephemeral-test-token');
  assert.equal(body.sessionId, '11111111-1111-4111-8111-111111111111');
  assert.equal(body.model, 'gemini-3.8-live');
  assert.ok(calls.some(x => x.target.includes('/rpc/start_speakwise_voice_session')));
});
