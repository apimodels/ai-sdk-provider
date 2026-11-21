# apimodels.app provider for the Vercel AI SDK

[apimodels.app](https://apimodels.app) serves 170+ chat, image, video and audio models from one API key and one endpoint, paid per use. Failed generations are not billed.

This package lets you use those models with the [Vercel AI SDK](https://ai-sdk.dev) (version 7 and later):

- **Chat** with `generateText` / `streamText`: Claude, GPT, Gemini, Qwen, DeepSeek, GLM and Grok, with tool calling and image input
- **Embeddings** with `embed` / `embedMany`
- **Images** with `generateImage`: GPT Image 2, Nano Banana 2.1, Gemini 3 Pro Image, Seedream, Qwen Image, FLUX.2 Klein, Grok Imagine and more, including edits from reference images
- **Video** with `experimental_generateVideo`: Veo 3.1, Kling 4.0, Seedance 2.5, Wan 3.0, MiniMax H3, LTX 2.5 and more, from text, a first frame, first and last frames, or reference images

## Setup

```bash
pnpm add apimodels-ai-sdk-provider ai
```

Create an API key at [apimodels.app/console/api-keys](https://apimodels.app/console/api-keys) and set it as an environment variable:

```bash
APIMODELS_API_KEY=sk_...
```

## Provider instance

Import the default instance, which reads `APIMODELS_API_KEY`:

```ts
import { apimodels } from 'apimodels-ai-sdk-provider';
```

Or create one with your own settings:

```ts
import { createApimodels } from 'apimodels-ai-sdk-provider';

const apimodels = createApimodels({
  apiKey: process.env.MY_APIMODELS_KEY,
});
```

Settings:

- `apiKey`: sent as a Bearer token. Defaults to the `APIMODELS_API_KEY` environment variable.
- `baseURL`: defaults to `https://api.apimodels.app/v1`.
- `headers`: extra headers for every request.
- `fetch`: a custom fetch implementation.

## Chat

```ts
import { apimodels } from 'apimodels-ai-sdk-provider';
import { generateText, streamText } from 'ai';

const { text } = await generateText({
  model: apimodels('claude-sonnet-5-5'),
  prompt: 'Write a haiku about paper boats.',
});

const result = streamText({
  model: apimodels('gemini-3.5-flash'),
  prompt: 'Explain diffusion models in three sentences.',
});
for await (const part of result.textStream) process.stdout.write(part);
```

`apimodels(id)` is the same as `apimodels.languageModel(id)` and `apimodels.chatModel(id)`. Any chat model id listed at [apimodels.app/models](https://apimodels.app/models) works, for example `claude-opus-5-5`, `gpt-6.1-sol`, `gemini-4-carbon`, `qwen4-max`, `deepseek-v4-pro` or `grok-4.6`.

## Embeddings

```ts
import { apimodels } from 'apimodels-ai-sdk-provider';
import { embed } from 'ai';

const { embedding } = await embed({
  model: apimodels.embeddingModel('text-embedding-3-small'),
  value: 'a paper boat on a pond',
});
```

## Images

```ts
import { apimodels } from 'apimodels-ai-sdk-provider';
import { generateImage } from 'ai';

const { image, providerMetadata } = await generateImage({
  model: apimodels.image('nano-banana-2-1'),
  prompt: 'A small orange paper boat on a calm pond at sunrise',
  aspectRatio: '16:9',
  providerOptions: {
    apimodels: { resolution: '2K' },
  },
});

// image.uint8Array holds the file. The hosted URL (kept for 30 days), task id
// and the amount charged are in the provider metadata:
const [meta] = providerMetadata.apimodels.images as Array<{ url: string; taskId: string; credits: number }>;
console.log(meta.url, meta.credits);
```

Edit or combine images by passing them in the prompt. URLs are passed through; inline bytes are uploaded to apimodels.app file storage first.

```ts
const { image } = await generateImage({
  model: apimodels.image('gpt-image-2'),
  prompt: {
    images: ['https://example.com/product.png'],
    text: 'Place this product on a marble counter in soft window light',
  },
});
```

Image generation runs as a task on apimodels.app: the provider submits it, polls until it finishes and downloads the result. `n` images are requested one task each.

## Video

```ts
import { apimodels } from 'apimodels-ai-sdk-provider';
import { experimental_generateVideo as generateVideo } from 'ai';

const { video } = await generateVideo({
  model: apimodels.video('veo-3.1-fast-fhd'),
  prompt: 'A paper boat drifts across a calm pond at sunrise, static camera',
  aspectRatio: '16:9',
});
```

Image-to-video, first and last frames, and reference images:

```ts
// Animate a first frame
await generateVideo({
  model: apimodels.video('kling-4.0'),
  prompt: { image: 'https://example.com/first-frame.png', text: 'The camera slowly pushes in' },
  duration: 5,
});

// First and last frame
await generateVideo({
  model: apimodels.video('seedance-2.5'),
  prompt: 'The door opens and light floods the room',
  frameImages: [
    { image: 'https://example.com/start.png', frameType: 'first_frame' },
    { image: 'https://example.com/end.png', frameType: 'last_frame' },
  ],
});
```

- `resolution` such as `'1280x720'` is sent as the API's tier (`720p`); you can also pass `providerOptions.apimodels.resolution` directly.
- `aspectRatio: 'adaptive'` (or leaving it out on image-to-video) lets the output follow the input image.
- `generateAudio` turns sound on or off on models that support it (Veo, Seedance, Kling 4.0).
- A video takes about 2.5 minutes at the median, and 9 in 10 finish within 8 minutes. Set `poll: { timeoutMs }` on `generateVideo` to wait longer than the default 10 minutes.

## Provider options

Keys under `providerOptions.apimodels` are sent to the API as-is, so any model-specific parameter from the model's page in the [apimodels.app docs](https://apimodels.app/docs) can be used, for example:

```ts
providerOptions: {
  apimodels: {
    resolution: '4K',          // image resolution tier: 1K, 2K or 4K (model-dependent)
    quality: 'high',           // GPT Image models
    output_format: 'webp',
    negative_prompt: 'text, watermark', // video models that support it
  },
}
```

Image models also accept `pollIntervalMs` (default 2000) and `pollTimeoutMs` (default 600000).

## Errors and billing

- API errors (invalid key, insufficient balance, rejected prompt) are thrown as `APICallError` with the message from apimodels.app.
- A task that fails on the model side throws `ApimodelsTaskFailedError` (images) or rejects `generateVideo` with the reason. Failed tasks are not billed.
- The amount charged for each image or video is returned in `providerMetadata.apimodels` (`credits`, in USD).

## Links

- Models and prices: [apimodels.app/models](https://apimodels.app/models)
- API documentation: [apimodels.app/docs](https://apimodels.app/docs)
- Support: support@apimodels.app

## License

MIT
