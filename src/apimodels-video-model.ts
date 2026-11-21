import type {
  Experimental_VideoModelV4 as VideoModelV4,
  Experimental_VideoModelV4File as VideoModelV4File,
  Experimental_VideoModelV4OperationStartResult as VideoModelV4OperationStartResult,
  Experimental_VideoModelV4OperationStatusResult as VideoModelV4OperationStatusResult,
  SharedV4Warning,
} from '@ai-sdk/provider';
import { getTopLevelMediaType, lazySchema, parseProviderOptions, zodSchema } from '@ai-sdk/provider-utils';
import { z } from 'zod/v4';
import {
  getTask,
  removeUndefinedEntries,
  submitGeneration,
  toPublicUrl,
  type ApimodelsConfig,
} from './apimodels-api';
import type { ApimodelsVideoModelId } from './apimodels-model-ids';

/**
 * Options for `providerOptions.apimodels` on video models. Every key is sent to
 * the API as-is, e.g. `resolution: '1080p'`, `negative_prompt`, `mode: 'pro'`,
 * `video_url` (video-in models) or `audio_url` (talking avatars). See the
 * model's page at https://apimodels.app/docs for what each model reads.
 */
export type ApimodelsVideoModelOptions = {
  [key: string]: unknown;
};

const videoOptionsSchema = lazySchema(() => zodSchema(z.looseObject({})));

/** Video models that read the first frame from the scalar `image` field instead of `images[]`. */
const FIRST_FRAME_AS_IMAGE = new Set([
  'kling-v2-6',
  'kling-video-o1',
  'kling-v3-omni',
  'kling-effects',
  'dreamactor-v2',
  'v3.1-fast-start-end',
  'wan-animate',
]);

/**
 * Video models whose route takes the first frame ONLY from `first_frame_url` and reads images[] as reference
 * images (checked against the apimodels backend, 2026-11-21). Sending images[] to them silently turned
 * image-to-video into reference-to-video; the two Wan Spicy image-to-video models received no image at all.
 * seedance-2.5-lite has no first-frame mode, so it answers first_frame_url with a clear 400.
 * Compared after normalizing "4-0" to "4.0", so alias spellings (kling-4-0, seedance-2-0-fast) match too.
 */
const FIRST_FRAME_AS_URL = new Set([
  'seedance-2.0', 'seedance-2.0-fast', 'seedance-2.0-mini', 'seedance-2.5', 'seedance-2.5-lite', 'seedance-2.5-flash',
  'dreamina-seedance-2.0', 'dreamina-seedance-2.0-fast', 'dreamina-seedance-2.0-mini',
  'wan-3.0-video', 'kling-4.0', 'kling-4.0-flash', 'ltx-2.5-fast', 'ltx-2.5-pro', 'muse-video', 'gemini-omni-1.2-flash',
  'flux-3-max', 'wan-2.2-i2v-spicy', 'wan-2.7-i2v-spicy', 'minimax-h3-max-turbo', 'minimax-h3-rh-enhanced',
]);

/** Which request field carries the first frame for this model. */
export function firstFrameField(model: string, hasLastFrame: boolean): 'first_frame_url' | 'image' | 'images' | 'input_urls' {
  const raw = model.trim().toLowerCase();
  const id = raw.replace(/(\d)-(\d)/g, '$1.$2');
  if (id.endsWith('motion-control')) return 'input_urls';
  if (FIRST_FRAME_AS_URL.has(id)) return 'first_frame_url';
  // MiniMax H3 Lite: first + last frame mode takes both as *_frame_url; with one image its only mode is reference.
  if (id === 'minimax-h3-lite' && hasLastFrame) return 'first_frame_url';
  // Published ids here are compared as-is (kling-v2-6 must not become kling-v2.6).
  if (FIRST_FRAME_AS_IMAGE.has(raw)) return 'image';
  return 'images';
}

const RESERVED_KEYS = new Set(['model', 'prompt', 'callback_url']);

/** '1280x720' -> '720p': the API names video resolutions by their short side. */
function toResolutionTier(resolution: `${number}x${number}`): string {
  const [w, h] = resolution.split('x').map(Number);
  return `${Math.min(w, h)}p`;
}

function mediaTypeFromUrl(url: string): string {
  const ext = url.toLowerCase().split(/[?#]/)[0].split('.').pop();
  if (ext === 'webm') return 'video/webm';
  if (ext === 'mov') return 'video/quicktime';
  return 'video/mp4';
}

function topLevelType(file: VideoModelV4File): string | undefined {
  return file.mediaType != null ? getTopLevelMediaType(file.mediaType) : undefined;
}

export class ApimodelsVideoModel implements VideoModelV4 {
  readonly specificationVersion = 'v4';
  readonly maxVideosPerCall = 1;

  get provider(): string {
    return this.config.provider;
  }

  constructor(
    readonly modelId: ApimodelsVideoModelId,
    private readonly config: ApimodelsConfig,
  ) {}

  async doStart(
    options: Parameters<NonNullable<VideoModelV4['doStart']>>[0],
  ): Promise<VideoModelV4OperationStartResult> {
    const currentDate = this.config._internal?.currentDate?.() ?? new Date();
    const warnings: SharedV4Warning[] = [];
    const { headers, abortSignal } = options;
    const model = this.modelId.toLowerCase();
    const upload = (file: VideoModelV4File) =>
      toPublicUrl({ file, config: this.config, headers, abortSignal });

    const apimodelsOptions = (await parseProviderOptions({
      provider: 'apimodels',
      providerOptions: options.providerOptions,
      schema: videoOptionsSchema,
    })) as ApimodelsVideoModelOptions | undefined;
    const extra = Object.fromEntries(
      Object.entries(apimodelsOptions ?? {}).filter(([key]) => !RESERVED_KEYS.has(key)),
    );

    const firstFrame =
      options.frameImages?.find(frame => frame.frameType === 'first_frame')?.image ?? options.image;
    const lastFrame = options.frameImages?.find(frame => frame.frameType === 'last_frame')?.image;

    const body: Record<string, unknown> = removeUndefinedEntries({
      ...extra,
      model: this.modelId,
      prompt: options.prompt,
      resolution: options.resolution ? toResolutionTier(options.resolution) : undefined,
      duration: options.duration,
      seed: options.seed,
      generate_audio: options.generateAudio,
    });

    // 'adaptive' is the API default: the output follows the input image's shape.
    if (options.aspectRatio != null && options.aspectRatio !== 'adaptive') {
      if (firstFrame != null && model.startsWith('seedance-2.5')) {
        warnings.push({
          type: 'unsupported',
          feature: 'aspectRatio',
          details:
            'Seedance 2.5 image-to-video follows the first frame\'s aspect ratio; aspectRatio was ignored.',
        });
      } else {
        body.aspect_ratio = options.aspectRatio;
      }
    }

    if (firstFrame != null) {
      const url = await upload(firstFrame);
      const field = firstFrameField(model, lastFrame != null);
      if (field === 'images' || field === 'input_urls') body[field] = [url];
      else body[field] = url;
    }

    if (lastFrame != null) {
      const url = await upload(lastFrame);
      // Seedance, MiniMax, Kling 4.0 and Muse read last_frame_url; Kling 2.x and v3.1-fast-start-end read image_tail.
      body.last_frame_url = url;
      body.image_tail = url;
    }

    if (options.inputReferences?.length) {
      const byType: Record<string, string[]> = {};
      for (const reference of options.inputReferences) {
        const type = topLevelType(reference);
        const key =
          type === 'video'
            ? 'reference_video_urls'
            : type === 'audio'
              ? 'reference_audio_urls'
              : 'reference_image_urls';
        (byType[key] ??= []).push(await upload(reference));
      }
      Object.assign(body, byType);
    }

    if (options.fps != null) {
      warnings.push({
        type: 'unsupported',
        feature: 'fps',
        details: 'apimodels.app video models use their native frame rate; fps was ignored.',
      });
    }

    if (options.webhookUrl != null) {
      body.callback_url = options.webhookUrl;
    }

    const submitted = await submitGeneration({
      kind: 'video',
      body,
      config: this.config,
      headers,
      abortSignal,
    });

    if (!submitted.taskId) {
      throw new Error('apimodels.app returned no task id for the video request.');
    }

    return {
      operation: { taskId: submitted.taskId },
      warnings,
      providerMetadata: { apimodels: { taskId: submitted.taskId } },
      response: {
        timestamp: currentDate,
        modelId: this.modelId,
        headers: submitted.responseHeaders,
      },
    };
  }

  async doStatus(
    options: Parameters<NonNullable<VideoModelV4['doStatus']>>[0],
  ): Promise<VideoModelV4OperationStatusResult> {
    const currentDate = this.config._internal?.currentDate?.() ?? new Date();
    const { taskId } = options.operation as { taskId: string };

    const { task, responseHeaders } = await getTask({
      kind: 'video',
      taskId,
      config: this.config,
      headers: options.headers,
      abortSignal: options.abortSignal,
    });

    const response = { timestamp: currentDate, modelId: this.modelId, headers: responseHeaders };

    if (task.state === 'completed' && task.resultUrls.length > 0) {
      return {
        status: 'completed',
        videos: task.resultUrls.map(url => ({ type: 'url' as const, url, mediaType: mediaTypeFromUrl(url) })),
        warnings: [],
        providerMetadata: {
          apimodels: {
            taskId,
            videos: task.resultUrls.map(url => ({ url })),
            ...(task.credits != null ? { credits: task.credits } : {}),
          },
        },
        response,
      };
    }

    if (task.state === 'failed' || task.state === 'completed') {
      return {
        status: 'error',
        error: `apimodels.app task ${taskId} failed: ${
          task.failMsg || task.failCode || 'no result URL'
        }. Failed tasks are not billed.`,
        providerMetadata: { apimodels: { taskId } },
        response,
      };
    }

    return { status: 'pending', response };
  }
}
