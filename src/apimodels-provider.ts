import {
  OpenAICompatibleChatLanguageModel,
  OpenAICompatibleEmbeddingModel,
} from '@ai-sdk/openai-compatible';
import {
  type EmbeddingModelV4,
  type Experimental_VideoModelV4 as VideoModelV4,
  type ImageModelV4,
  type LanguageModelV4,
  type ProviderV4,
} from '@ai-sdk/provider';
import {
  loadApiKey,
  withoutTrailingSlash,
  withUserAgentSuffix,
  type FetchFunction,
} from '@ai-sdk/provider-utils';
import type { ApimodelsConfig } from './apimodels-api';
import { ApimodelsImageModel } from './apimodels-image-model';
import type {
  ApimodelsChatModelId,
  ApimodelsEmbeddingModelId,
  ApimodelsImageModelId,
  ApimodelsVideoModelId,
} from './apimodels-model-ids';
import { ApimodelsVideoModel } from './apimodels-video-model';
import { VERSION } from './version';

export interface ApimodelsProviderSettings {
  /**
   * apimodels.app API key (starts with `sk_`). Defaults to the
   * `APIMODELS_API_KEY` environment variable. Create one at
   * https://apimodels.app/console/api-keys.
   */
  apiKey?: string;

  /** API base URL. Default: https://api.apimodels.app/v1 */
  baseURL?: string;

  /** Extra headers sent with every request. */
  headers?: Record<string, string>;

  /** Custom fetch implementation, e.g. for testing or proxies. */
  fetch?: FetchFunction;
}

export interface ApimodelsProvider extends ProviderV4 {
  /** Chat model (same as `languageModel`). */
  (modelId: ApimodelsChatModelId): LanguageModelV4;

  /** Chat model served from /v1/chat/completions (Claude, GPT, Gemini, Qwen, DeepSeek, GLM, Grok). */
  languageModel(modelId: ApimodelsChatModelId): LanguageModelV4;
  chatModel(modelId: ApimodelsChatModelId): LanguageModelV4;

  /** Text embedding model served from /v1/embeddings. */
  embeddingModel(modelId: ApimodelsEmbeddingModelId): EmbeddingModelV4;

  /** Image generation and editing model served from /v1/images/generations. */
  image(modelId: ApimodelsImageModelId): ImageModelV4;
  imageModel(modelId: ApimodelsImageModelId): ImageModelV4;

  /** Video generation model served from /v1/video/generations (use with `experimental_generateVideo`). */
  video(modelId: ApimodelsVideoModelId): VideoModelV4;
  videoModel(modelId: ApimodelsVideoModelId): VideoModelV4;
}

const DEFAULT_BASE_URL = 'https://api.apimodels.app/v1';

/** Creates an apimodels.app provider instance. */
export function createApimodels(options: ApimodelsProviderSettings = {}): ApimodelsProvider {
  const baseURL = withoutTrailingSlash(options.baseURL ?? DEFAULT_BASE_URL) ?? DEFAULT_BASE_URL;

  const getHeaders = () =>
    withUserAgentSuffix(
      {
        Authorization: `Bearer ${loadApiKey({
          apiKey: options.apiKey,
          environmentVariableName: 'APIMODELS_API_KEY',
          description: 'apimodels.app',
        })}`,
        ...options.headers,
      },
      `ai-sdk/apimodels/${VERSION}`,
    );

  const url = ({ path }: { path: string }) => `${baseURL}${path}`;

  const createChatModel = (modelId: ApimodelsChatModelId) =>
    new OpenAICompatibleChatLanguageModel(modelId, {
      provider: 'apimodels.chat',
      url,
      headers: getHeaders,
      fetch: options.fetch,
      includeUsage: true,
      supportsStructuredOutputs: true,
    });

  const createEmbeddingModel = (modelId: ApimodelsEmbeddingModelId) =>
    new OpenAICompatibleEmbeddingModel(modelId, {
      provider: 'apimodels.embedding',
      url,
      headers: getHeaders,
      fetch: options.fetch,
    });

  const mediaConfig = (provider: string): ApimodelsConfig => ({
    provider,
    baseURL,
    headers: getHeaders,
    fetch: options.fetch,
  });

  const createImageModel = (modelId: ApimodelsImageModelId) =>
    new ApimodelsImageModel(modelId, mediaConfig('apimodels.image'));

  const createVideoModel = (modelId: ApimodelsVideoModelId) =>
    new ApimodelsVideoModel(modelId, mediaConfig('apimodels.video'));

  const provider = function (modelId: ApimodelsChatModelId) {
    if (new.target) {
      throw new Error('The apimodels model function cannot be called with the new keyword.');
    }
    return createChatModel(modelId);
  };

  provider.specificationVersion = 'v4' as const;
  provider.languageModel = createChatModel;
  provider.chatModel = createChatModel;
  provider.embeddingModel = createEmbeddingModel;
  provider.image = createImageModel;
  provider.imageModel = createImageModel;
  provider.video = createVideoModel;
  provider.videoModel = createVideoModel;

  return provider as ApimodelsProvider;
}

/** Default provider instance. Reads the API key from `APIMODELS_API_KEY`. */
export const apimodels = createApimodels();
