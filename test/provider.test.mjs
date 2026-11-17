// Offline tests against the built package, with a mocked fetch. No API key or network needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embed, experimental_generateVideo, generateImage, generateText } from 'ai';
import { ApimodelsTaskFailedError, createApimodels } from '../dist/index.js';

const API = 'https://api.apimodels.app/v1';
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const MP4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Builds a fetch mock from [matcher, responder] routes and records every call. */
function mockFetch(routes) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    let body = init.body;
    if (typeof body === 'string') body = JSON.parse(body);
    const call = { url, method, headers, body };
    calls.push(call);
    for (const [match, respond] of routes) {
      if (match(call)) return respond(call, calls);
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };
  return { fetch, calls };
}

const provider = fetch => createApimodels({ apiKey: 'sk_test', fetch });

// The AI SDK downloads finished videos itself; serve them from memory.
const download = async () => ({ data: MP4, mediaType: 'video/mp4' });

test('generateImage submits an async task, polls it and downloads the result without the key', async () => {
  let polls = 0;
  const { fetch, calls } = mockFetch([
    [c => c.method === 'POST' && c.url === `${API}/images/generations`, () => json({ code: 200, msg: 'success', data: { taskId: 'img_1' } })],
    [c => c.method === 'GET' && c.url === `${API}/images/generations?task_id=img_1`, () =>
      json({ code: 200, data: ++polls < 2 ? { taskId: 'img_1', state: 'processing' } : { taskId: 'img_1', state: 'completed', resultUrls: ['https://r2.apimodels.app/results/a.png'], credits: 0.006 } })],
    [c => c.url === 'https://r2.apimodels.app/results/a.png', () => new Response(PNG, { headers: { 'content-type': 'image/png' } })],
  ]);

  const result = await generateImage({
    model: provider(fetch).image('flux-2-klein-4b'),
    prompt: 'a paper boat',
    aspectRatio: '16:9',
    providerOptions: { apimodels: { pollIntervalMs: 1, resolution: '1K' } },
  });

  assert.deepEqual(result.image.uint8Array, PNG);
  const submit = calls[0];
  assert.equal(submit.headers.authorization, 'Bearer sk_test');
  assert.match(submit.headers['user-agent'], /ai-sdk\/apimodels\//);
  assert.deepEqual(submit.body, {
    resolution: '1K',
    model: 'flux-2-klein-4b',
    prompt: 'a paper boat',
    aspect_ratio: '16:9',
    async: true,
    response_format: 'url',
  });
  const download = calls.find(c => c.url.startsWith('https://r2.'));
  assert.equal(download.headers.authorization, undefined, 'API key must not be sent to the result host');
  assert.deepEqual(result.providerMetadata.apimodels.images, [
    { url: 'https://r2.apimodels.app/results/a.png', taskId: 'img_1', credits: 0.006 },
  ]);
});

test('inline image bytes are uploaded to /v1/files and sent as image_url', async () => {
  const { fetch, calls } = mockFetch([
    [c => c.method === 'POST' && c.url === `${API}/files`, () => json({ code: 200, data: { publicUrl: 'https://r2.apimodels.app/uploads/in.png' } })],
    [c => c.method === 'POST' && c.url === `${API}/images/generations`, () => json({ code: 200, data: { taskId: 'img_2' } })],
    [c => c.method === 'GET', c =>
      c.url.startsWith('https://r2.')
        ? new Response(PNG)
        : json({ code: 200, data: { state: 'completed', resultUrls: ['https://r2.apimodels.app/results/b.png'] } })],
  ]);

  await generateImage({
    model: provider(fetch).image('gpt-image-2'),
    prompt: { images: [PNG], text: 'make it blue' },
    providerOptions: { apimodels: { pollIntervalMs: 1 } },
  });

  const upload = calls.find(c => c.url === `${API}/files`);
  assert.ok(upload.body instanceof FormData);
  const submit = calls.find(c => c.url === `${API}/images/generations`);
  assert.equal(submit.body.image_url, 'https://r2.apimodels.app/uploads/in.png');
  assert.equal(submit.body.image_urls, undefined);
});

test('a failed image task throws ApimodelsTaskFailedError with the reason', async () => {
  const { fetch } = mockFetch([
    [c => c.method === 'POST', () => json({ code: 200, data: { taskId: 'img_3' } })],
    [c => c.method === 'GET', () => json({ code: 200, data: { state: 'failed', failMsg: 'The prompt was rejected by content moderation' } })],
  ]);
  await assert.rejects(
    generateImage({
      model: provider(fetch).image('nano-banana-2-1'),
      prompt: 'x',
      maxRetries: 0,
      providerOptions: { apimodels: { pollIntervalMs: 1 } },
    }),
    err => {
      const cause = err instanceof ApimodelsTaskFailedError ? err : err.lastError ?? err.cause ?? err;
      assert.match(String(cause.message), /content moderation/);
      return true;
    },
  );
});

test('API errors surface the msg field', async () => {
  const { fetch } = mockFetch([
    [() => true, () => json({ code: 402, msg: 'Insufficient balance' }, 402)],
  ]);
  await assert.rejects(
    generateImage({ model: provider(fetch).image('gpt-image-2'), prompt: 'x', maxRetries: 0 }),
    /Insufficient balance/,
  );
});

test('experimental_generateVideo starts a task, polls doStatus and maps the first frame', async () => {
  let polls = 0;
  const { fetch, calls } = mockFetch([
    [c => c.method === 'POST' && c.url === `${API}/video/generations`, () => json({ code: 200, data: { taskId: 'vid_1' } })],
    [c => c.method === 'GET' && c.url === `${API}/video/generations?task_id=vid_1`, () =>
      json({ code: 200, data: ++polls < 2 ? { state: 'pending' } : { state: 'completed', resultUrls: ['https://r2.apimodels.app/results/v.mp4'] } })],
    [c => c.url === 'https://r2.apimodels.app/results/v.mp4', () => new Response(MP4, { headers: { 'content-type': 'video/mp4' } })],
  ]);

  const result = await experimental_generateVideo({
    model: provider(fetch).video('seedance-2.5'),
    prompt: { image: 'https://example.com/first.png', text: 'the boat drifts' },
    aspectRatio: '16:9',
    resolution: '1280x720',
    duration: 5,
    generateAudio: false,
    poll: { intervalMs: 1 },
    download,
  });

  const submit = calls[0];
  assert.deepEqual(submit.body.images, ['https://example.com/first.png']);
  assert.equal(submit.body.resolution, '720p');
  assert.equal(submit.body.duration, 5);
  assert.equal(submit.body.generate_audio, false);
  assert.equal(submit.body.aspect_ratio, undefined, 'Seedance 2.5 image-to-video must not send an aspect ratio');
  assert.ok(result.warnings.some(w => w.feature === 'aspectRatio'));
  assert.deepEqual(result.video.uint8Array, MP4);
});

test('Kling video models get the first frame as `image` and the last frame as image_tail', async () => {
  const { fetch, calls } = mockFetch([
    [c => c.method === 'POST', () => json({ code: 200, data: { taskId: 'vid_2' } })],
    [c => c.method === 'GET', c =>
      c.url.startsWith('https://r2.') ? new Response(MP4) : json({ code: 200, data: { state: 'completed', resultUrls: ['https://r2.apimodels.app/results/k.mp4'] } })],
  ]);
  await experimental_generateVideo({
    model: provider(fetch).video('kling-v2-6'),
    prompt: 'a door opens',
    frameImages: [
      { image: 'https://example.com/a.png', frameType: 'first_frame' },
      { image: 'https://example.com/b.png', frameType: 'last_frame' },
    ],
    aspectRatio: '9:16',
    poll: { intervalMs: 1 },
    download,
  });
  const submit = calls[0];
  assert.equal(submit.body.image, 'https://example.com/a.png');
  assert.equal(submit.body.image_tail, 'https://example.com/b.png');
  assert.equal(submit.body.aspect_ratio, '9:16');
});

test('a failed video task rejects with the API reason', async () => {
  const { fetch } = mockFetch([
    [c => c.method === 'POST', () => json({ code: 200, data: { taskId: 'vid_3' } })],
    [c => c.method === 'GET', () => json({ code: 200, data: { state: 'failed', failMsg: 'upstream timeout' } })],
  ]);
  await assert.rejects(
    experimental_generateVideo({ model: provider(fetch).video('veo-3.1-fast-fhd'), prompt: 'x', poll: { intervalMs: 1 } }),
    /upstream timeout/,
  );
});

test('chat models call /v1/chat/completions', async () => {
  const { fetch, calls } = mockFetch([
    [c => c.url === `${API}/chat/completions`, () =>
      json({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'gemini-3.5-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      })],
  ]);
  const { text } = await generateText({ model: provider(fetch)('gemini-3.5-flash'), prompt: 'Say hello' });
  assert.equal(text, 'Hello!');
  assert.equal(calls[0].body.model, 'gemini-3.5-flash');
  assert.equal(calls[0].headers.authorization, 'Bearer sk_test');
});

test('embedding models call /v1/embeddings', async () => {
  const { fetch, calls } = mockFetch([
    [c => c.url === `${API}/embeddings`, () =>
      json({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], model: 'text-embedding-3-small', usage: { prompt_tokens: 2, total_tokens: 2 } })],
  ]);
  const { embedding } = await embed({ model: provider(fetch).embeddingModel('text-embedding-3-small'), value: 'hi' });
  assert.deepEqual(embedding, [0.1, 0.2]);
  assert.equal(calls[0].body.model, 'text-embedding-3-small');
});
