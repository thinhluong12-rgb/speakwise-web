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

test('a database error while creating a session is reported as a generic 503, there is no daily-cap branch', async t => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return json({ id: 'adult-user', app_metadata: { adult_verified: true } });
    if (target.includes('api.openai.com/v1/realtime/client_secrets')) return json({ value: 'short-lived-test-secret', expires_at: 1234567890 });
    if (target.includes('/rpc/start_speakwise_voice_session')) return json({ code: 'P0001', message: 'SOMETHING_ELSE' }, 400);
    throw new Error('Unexpected network request: ' + target);
  });
  const response = await worker.fetch(request('/voice/session'), baseEnv);
  assert.equal(response.status, 503);
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

test('Gemini Live coach receives the learner\'s target collocations and natural-correction instructions', async t => {
  let setup;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return json({ id: 'verified-adult', app_metadata: { adult_verified: true } });
    if (target.includes('generativelanguage.googleapis.com/v1alpha/auth_tokens')) {
      setup = JSON.parse(options.body).bidiGenerateContentSetup;
      return json({ name: 'ephemeral-test-token', expireTime: '2026-11-17T16:00:00Z' });
    }
    if (target.includes('/rpc/start_speakwise_voice_session')) return json('11111111-1111-4111-8111-111111111111');
    throw new Error('Unexpected network request: ' + target);
  });
  const env = { ...baseEnv, GEMINI_API_KEY: 'gemini-test-placeholder' };
  const many = Array.from({ length: 30 }, (_, i) => ({ phrase: 'filler phrase ' + i, meaning: 'meaning ' + i }));
  const response = await worker.fetch(request('/voice/gemini-token', {
    topic: 'Daily Life',
    targetPhrases: [{ phrase: 'take a break', meaning: 'nghỉ ngơi' }, 'catch up on sleep', { phrase: '   ' }, 42, ...many]
  }), env);
  assert.equal(response.status, 200);
  const text = setup.systemInstruction.parts[0].text;
  assert.match(text, /NATURAL CORRECTIVE FEEDBACK/);
  assert.match(text, /at most one correction per turn/i);
  assert.match(text, /"take a break" \(nghỉ ngơi\)/);
  assert.match(text, /"catch up on sleep"/);
  assert.equal((text.match(/filler phrase/g) || []).length, 10, 'only the first 12 target entries are used (2 real + 10 filler)');
});

test('Gemini Live coach still works without a target list', async t => {
  let setup;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return json({ id: 'verified-adult', app_metadata: { adult_verified: true } });
    if (target.includes('generativelanguage.googleapis.com/v1alpha/auth_tokens')) {
      setup = JSON.parse(options.body).bidiGenerateContentSetup;
      return json({ name: 'ephemeral-test-token' });
    }
    if (target.includes('/rpc/start_speakwise_voice_session')) return json('11111111-1111-4111-8111-111111111111');
    throw new Error('Unexpected network request: ' + target);
  });
  const response = await worker.fetch(request('/voice/gemini-token', { topic: 'Food & Dining' }), { ...baseEnv, GEMINI_API_KEY: 'x' });
  assert.equal(response.status, 200);
  assert.match(setup.systemInstruction.parts[0].text, /No target list was supplied/);
});

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const geminiEnv = { ...baseEnv, GEMINI_API_KEY: 'gemini-test-placeholder' };

test('Gemini Live first connection asks for compression and resumption so sessions can run long', async t => {
  let setup;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return json({ id: 'u1', app_metadata: { adult_verified: true } });
    if (target.includes('/v1alpha/auth_tokens')) { setup = JSON.parse(options.body).bidiGenerateContentSetup; return json({ name: 'tok' }); }
    if (target.includes('/rpc/start_speakwise_voice_session')) return json(SESSION_ID);
    throw new Error('Unexpected network request: ' + target);
  });
  const response = await worker.fetch(request('/voice/gemini-token', { topic: 'Daily Life' }), geminiEnv);
  assert.equal(response.status, 200);
  assert.deepEqual(setup.contextWindowCompression, { slidingWindow: {} });
  assert.deepEqual(setup.sessionResumption, {});
});

test('Gemini Live falls back to the plain setup if the long-session fields are rejected', async t => {
  const setups = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return json({ id: 'u1', app_metadata: { adult_verified: true } });
    if (target.includes('/v1alpha/auth_tokens')) {
      setups.push(JSON.parse(options.body).bidiGenerateContentSetup);
      return setups.length === 1 ? json({ error: { status: 'INVALID_ARGUMENT', message: 'Unknown field' } }, 400) : json({ name: 'tok2' });
    }
    if (target.includes('/rpc/start_speakwise_voice_session')) return json(SESSION_ID);
    throw new Error('Unexpected network request: ' + target);
  });
  const response = await worker.fetch(request('/voice/gemini-token', { topic: 'Daily Life' }), geminiEnv);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ephemeralToken, 'tok2');
  assert.equal(setups.length, 2);
  assert.equal(setups[1].contextWindowCompression, undefined);
  assert.equal(setups[1].sessionResumption, undefined);
});

test('resuming a Gemini Live session reuses the existing session row and never counts a new session', async t => {
  let setup; let inserts = 0;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return json({ id: 'u1', app_metadata: { adult_verified: true } });
    if (target.includes('/rest/v1/speakwise_voice_sessions?')) return json([{ id: SESSION_ID, owner_id: 'u1', status: 'active' }]);
    if (target.includes('/v1alpha/auth_tokens')) { setup = JSON.parse(options.body).bidiGenerateContentSetup; return json({ name: 'resume-tok' }); }
    if (target.includes('/rpc/start_speakwise_voice_session')) inserts++;
    throw new Error('Unexpected network request: ' + target);
  });
  const response = await worker.fetch(request('/voice/gemini-token', { topic: 'Daily Life', resumeSessionId: SESSION_ID, resumptionHandle: 'opaque-handle-123' }), geminiEnv);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.sessionId, SESSION_ID);
  assert.equal(body.resumed, true);
  assert.deepEqual(setup.sessionResumption, { handle: 'opaque-handle-123' });
  assert.equal(inserts, 0);
});

test('resuming is refused for a session that belongs to someone else or is no longer active', async t => {
  for (const row of [{ id: SESSION_ID, owner_id: 'someone-else', status: 'active' }, { id: SESSION_ID, owner_id: 'u1', status: 'completed' }]) {
    let tokenCalls = 0;
    const mock = t.mock.method(globalThis, 'fetch', async (url) => {
      const target = String(url);
      if (target.includes('/auth/v1/user')) return json({ id: 'u1', app_metadata: { adult_verified: true } });
      if (target.includes('/rest/v1/speakwise_voice_sessions?')) return json([row]);
      if (target.includes('/v1alpha/auth_tokens')) tokenCalls++;
      throw new Error('Unexpected network request: ' + target);
    });
    const response = await worker.fetch(request('/voice/gemini-token', { resumeSessionId: SESSION_ID, resumptionHandle: 'h' }), geminiEnv);
    assert.equal(response.status, 404);
    assert.equal(tokenCalls, 0);
    mock.mock.restore();
  }
});
