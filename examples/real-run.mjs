// One real, paid run per modality through the built package (about $0.10 in total).
// Reads the key from APIMODELS_API_KEY. Usage: pnpm build && node examples/real-run.mjs [chat|embed|image|video]
import { writeFileSync } from 'node:fs';
import { embed, experimental_generateVideo, generateImage, generateText, streamText } from 'ai';
import { apimodels } from '../dist/index.js';

const only = process.argv[2];
const run = name => !only || only === name;
const t = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
let t0 = Date.now();

if (run('chat')) {
  t0 = Date.now();
  const { text, usage } = await generateText({
    model: apimodels('qwen3.8-flash'),
    prompt: 'Reply with exactly: provider ok',
    maxOutputTokens: 20,
  });
  console.log('[chat]', JSON.stringify(text), usage, t());

  t0 = Date.now();
  const stream = streamText({ model: apimodels('qwen3.8-flash'), prompt: 'Count from 1 to 5, comma separated.', maxOutputTokens: 30 });
  let streamed = '';
  for await (const part of stream.textStream) streamed += part;
  console.log('[stream]', JSON.stringify(streamed), t());
}

if (run('embed')) {
  t0 = Date.now();
  const { embedding } = await embed({ model: apimodels.embeddingModel('text-embedding-3-small'), value: 'a paper boat on a pond' });
  console.log('[embed] dims', embedding.length, t());
}

if (run('image')) {
  t0 = Date.now();
  const result = await generateImage({
    model: apimodels.image('flux-2-klein-4b'),
    prompt: 'A small orange paper boat floating on a calm pond at sunrise, soft morning light, minimal composition',
    aspectRatio: '16:9',
  });
  writeFileSync('examples/out-image.' + (result.image.mediaType.split('/')[1] || 'png'), result.image.uint8Array);
  console.log('[image]', result.image.mediaType, result.image.uint8Array.length, 'bytes', JSON.stringify(result.providerMetadata.apimodels), result.warnings, t());
}

if (run('video')) {
  t0 = Date.now();
  const result = await experimental_generateVideo({
    model: apimodels.video('veo-3.1-fast-fhd'),
    prompt: 'A small orange paper boat drifts slowly across a calm pond at sunrise, gentle ripples, static camera',
    aspectRatio: '16:9',
    poll: { intervalMs: 5000, timeoutMs: 900_000 },
  });
  writeFileSync('examples/out-video.mp4', result.video.uint8Array);
  console.log('[video]', result.video.mediaType, result.video.uint8Array.length, 'bytes', JSON.stringify(result.providerMetadata), result.warnings, t());
}
