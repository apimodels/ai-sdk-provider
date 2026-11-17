import type { ImageModelV4, SharedV4Warning } from '@ai-sdk/provider';
import {
  createBinaryResponseHandler,
  createStatusCodeErrorResponseHandler,
  getFromApi,
  lazySchema,
  parseProviderOptions,
  zodSchema,
} from '@ai-sdk/provider-utils';
import { z } from 'zod/v4';
import {
  removeUndefinedEntries,
  submitGeneration,
  toPublicUrl,
  waitForTask,
  type ApimodelsConfig,
} from './apimodels-api';
import type { ApimodelsImageModelId } from './apimodels-model-ids';

/**
 * Options for `providerOptions.apimodels` on image models. Keys other than the
 * polling settings are sent to the API as-is, e.g. `resolution: '2K'`,
 * `quality: 'high'`, `output_format: 'webp'` or `background: 'transparent'`.
 * See the model's page at https://apimodels.app/docs for what each model reads.
 */
export type ApimodelsImageModelOptions = {
  /** How often to check the task, in milliseconds. Default 2000. */
  pollIntervalMs?: number;
  /** How long to wait for the image, in milliseconds. Default 600000 (10 minutes). */
  pollTimeoutMs?: number;
  [key: string]: unknown;
};

const imageOptionsSchema = lazySchema(() =>
  zodSchema(
    z.looseObject({
      pollIntervalMs: z.number().int().positive().nullish(),
      pollTimeoutMs: z.number().int().positive().nullish(),
    }),
  ),
);

const RESERVED_KEYS = new Set(['pollIntervalMs', 'pollTimeoutMs', 'model', 'prompt', 'async', 'response_format']);

export class ApimodelsImageModel implements ImageModelV4 {
  readonly specificationVersion = 'v4';
  // The API takes `n` on some models only, so the SDK sends one request per image.
  readonly maxImagesPerCall = 1;
  readonly supportsFileInputs = true;

  get provider(): string {
    return this.config.provider;
  }

  constructor(
    readonly modelId: ApimodelsImageModelId,
    private readonly config: ApimodelsConfig,
  ) {}

  async doGenerate(
    options: Parameters<ImageModelV4['doGenerate']>[0],
  ): Promise<Awaited<ReturnType<ImageModelV4['doGenerate']>>> {
    const { prompt, size, aspectRatio, seed, files, mask, providerOptions, headers, abortSignal } = options;
    const currentDate = this.config._internal?.currentDate?.() ?? new Date();
    const warnings: SharedV4Warning[] = [];

    const apimodelsOptions = (await parseProviderOptions({
      provider: 'apimodels',
      providerOptions,
      schema: imageOptionsSchema,
    })) as ApimodelsImageModelOptions | undefined;

    const extra = Object.fromEntries(
      Object.entries(apimodelsOptions ?? {}).filter(([key]) => !RESERVED_KEYS.has(key)),
    );

    const inputUrls = files?.length
      ? await Promise.all(
          files.map(file => toPublicUrl({ file, config: this.config, headers, abortSignal })),
        )
      : [];

    const body = removeUndefinedEntries({
      ...extra,
      model: this.modelId,
      prompt,
      size,
      aspect_ratio: aspectRatio,
      seed,
      image_url: inputUrls.length === 1 ? inputUrls[0] : undefined,
      image_urls: inputUrls.length > 1 ? inputUrls : undefined,
      mask_url: mask
        ? await toPublicUrl({ file: mask, config: this.config, headers, abortSignal })
        : undefined,
      // Always answer with a task id: with an exact `size` the endpoint would
      // otherwise switch to OpenAI's blocking mode on some models.
      async: true,
      response_format: 'url',
    });

    const submitted = await submitGeneration({
      kind: 'images',
      body,
      config: this.config,
      headers,
      abortSignal,
    });

    let urls = submitted.syncUrls ?? [];
    let responseHeaders = submitted.responseHeaders;
    let credits: number | undefined;
    if (submitted.taskId) {
      const done = await waitForTask({
        kind: 'images',
        taskId: submitted.taskId,
        config: this.config,
        headers,
        abortSignal,
        pollIntervalMs: apimodelsOptions?.pollIntervalMs ?? 2000,
        pollTimeoutMs: apimodelsOptions?.pollTimeoutMs ?? 600_000,
      });
      urls = done.task.resultUrls;
      responseHeaders = done.responseHeaders;
      credits = done.task.credits;
    }

    const images = await Promise.all(urls.map(url => this.download(url, abortSignal)));

    return {
      images,
      warnings,
      providerMetadata: {
        // Per-image entries: the AI SDK merges only `images` across calls.
        apimodels: {
          images: urls.map(url => ({
            url,
            ...(submitted.taskId ? { taskId: submitted.taskId } : {}),
            ...(credits != null ? { credits } : {}),
          })),
        },
      },
      response: {
        timestamp: currentDate,
        modelId: this.modelId,
        headers: responseHeaders,
      },
    };
  }

  private async download(url: string, abortSignal: AbortSignal | undefined): Promise<Uint8Array> {
    const { value } = await getFromApi({
      url,
      // A result URL from the API response; validated, and sent without the API key.
      validateUrl: true,
      trustedOrigin: this.config.baseURL,
      abortSignal,
      failedResponseHandler: createStatusCodeErrorResponseHandler(),
      successfulResponseHandler: createBinaryResponseHandler(),
      fetch: this.config.fetch,
    });
    return value;
  }
}
