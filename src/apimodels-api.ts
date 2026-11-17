import { APICallError } from '@ai-sdk/provider';
import {
  combineHeaders,
  convertBase64ToUint8Array,
  createJsonErrorResponseHandler,
  createJsonResponseHandler,
  delay,
  getFromApi,
  lazySchema,
  postFormDataToApi,
  postJsonToApi,
  zodSchema,
  type FetchFunction,
} from '@ai-sdk/provider-utils';
import { z } from 'zod/v4';

export type ApimodelsConfig = {
  provider: string;
  baseURL: string;
  headers: () => Record<string, string | undefined>;
  fetch?: FetchFunction;
  _internal?: {
    currentDate?: () => Date;
  };
};

/** The two asynchronous generation endpoints used by this provider. */
export type ApimodelsTaskKind = 'images' | 'video';

// Error bodies differ by endpoint: the generation endpoints answer { code, msg },
// the file and asset endpoints { message }, the LLM gateway { error: { message } }.
const apimodelsErrorSchema = lazySchema(() =>
  zodSchema(
    z.looseObject({
      code: z.union([z.number(), z.string()]).nullish(),
      msg: z.string().nullish(),
      message: z.string().nullish(),
      error: z
        .union([z.string(), z.looseObject({ message: z.string().nullish() })])
        .nullish(),
    }),
  ),
);

export const apimodelsFailedResponseHandler = createJsonErrorResponseHandler({
  errorSchema: apimodelsErrorSchema,
  errorToMessage: data =>
    data.msg ??
    data.message ??
    (typeof data.error === 'string' ? data.error : data.error?.message) ??
    'Unknown apimodels.app error',
});

const envelopeSchema = lazySchema(() =>
  zodSchema(
    z.looseObject({
      code: z.union([z.number(), z.string()]).nullish(),
      msg: z.string().nullish(),
      data: z.unknown().nullish(),
    }),
  ),
);

type Envelope = { code?: number | string | null; msg?: string | null; data?: unknown };

/** A generation task as returned by POST and GET /v1/{images,video}/generations. */
export type ApimodelsTask = {
  taskId?: string;
  state?: string;
  resultUrls: string[];
  resultJson?: unknown;
  failMsg?: string;
  failCode?: string;
  credits?: number;
  modelType?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readTask(data: unknown): ApimodelsTask {
  const d = asRecord(data);
  let resultJson: unknown = d.resultJson;
  if (typeof resultJson === 'string') {
    try {
      resultJson = JSON.parse(resultJson);
    } catch {
      // keep the raw string
    }
  }
  const fromJson = asRecord(resultJson).resultUrls;
  const urls = Array.isArray(d.resultUrls) && d.resultUrls.length > 0 ? d.resultUrls : fromJson;
  return {
    taskId: typeof d.taskId === 'string' ? d.taskId : undefined,
    state: typeof d.state === 'string' ? d.state : undefined,
    resultUrls: Array.isArray(urls) ? urls.filter((u): u is string => typeof u === 'string') : [],
    resultJson,
    failMsg: typeof d.failMsg === 'string' ? d.failMsg : undefined,
    failCode: d.failCode != null ? String(d.failCode) : undefined,
    credits: typeof d.credits === 'number' ? d.credits : undefined,
    modelType: typeof d.modelType === 'string' ? d.modelType : undefined,
  };
}

function rejectEnvelope(url: string, body: unknown, envelope: Envelope, raw: unknown): never {
  throw new APICallError({
    message: envelope.msg || `apimodels.app returned no task id: ${JSON.stringify(raw).slice(0, 300)}`,
    url,
    requestBodyValues: body,
    statusCode: typeof envelope.code === 'number' ? envelope.code : undefined,
    responseBody: JSON.stringify(raw),
    isRetryable: false,
  });
}

/**
 * Submits a generation. Returns either a task id to poll, or (for the OpenAI-style
 * synchronous image answer) the finished result URLs.
 */
export async function submitGeneration({
  kind,
  body,
  config,
  headers,
  abortSignal,
}: {
  kind: ApimodelsTaskKind;
  body: Record<string, unknown>;
  config: ApimodelsConfig;
  headers?: Record<string, string | undefined>;
  abortSignal?: AbortSignal;
}): Promise<{
  taskId?: string;
  syncUrls?: string[];
  responseHeaders: Record<string, string> | undefined;
}> {
  const url = `${config.baseURL}/${kind}/generations`;
  const { value, rawValue, responseHeaders } = await postJsonToApi({
    url,
    headers: mergeHeaders(config.headers(), headers),
    body,
    successfulResponseHandler: createJsonResponseHandler(envelopeSchema),
    failedResponseHandler: apimodelsFailedResponseHandler,
    abortSignal,
    fetch: config.fetch,
  });

  const task = readTask(value.data);
  if (task.taskId) {
    return { taskId: task.taskId, responseHeaders };
  }

  // OpenAI-style synchronous answer: { created, data: [{ url }] }.
  if (Array.isArray(value.data)) {
    const syncUrls = value.data
      .map(item => asRecord(item).url)
      .filter((u): u is string => typeof u === 'string');
    if (syncUrls.length > 0) {
      return { syncUrls, responseHeaders };
    }
  }

  return rejectEnvelope(url, body, value, rawValue);
}

/** Reads a task once. */
export async function getTask({
  kind,
  taskId,
  config,
  headers,
  abortSignal,
}: {
  kind: ApimodelsTaskKind;
  taskId: string;
  config: ApimodelsConfig;
  headers?: Record<string, string | undefined>;
  abortSignal?: AbortSignal;
}): Promise<{ task: ApimodelsTask; responseHeaders: Record<string, string> | undefined }> {
  const { value, responseHeaders } = await getFromApi({
    url: `${config.baseURL}/${kind}/generations?task_id=${encodeURIComponent(taskId)}`,
    // Built from the configured base URL, not from response data.
    validateUrl: false,
    headers: mergeHeaders(config.headers(), headers),
    successfulResponseHandler: createJsonResponseHandler(envelopeSchema),
    failedResponseHandler: apimodelsFailedResponseHandler,
    abortSignal,
    fetch: config.fetch,
  });
  const task = readTask(value.data);
  return { task: { ...task, taskId: task.taskId ?? taskId }, responseHeaders };
}

export class ApimodelsTaskFailedError extends Error {
  readonly taskId: string;
  readonly failCode?: string;
  constructor({ taskId, message, failCode }: { taskId: string; message: string; failCode?: string }) {
    super(`apimodels.app task ${taskId} failed: ${message}. Failed tasks are not billed.`);
    this.name = 'ApimodelsTaskFailedError';
    this.taskId = taskId;
    this.failCode = failCode;
  }
}

/** Polls a task until it completes, fails or the timeout passes. */
export async function waitForTask({
  kind,
  taskId,
  config,
  headers,
  abortSignal,
  pollIntervalMs,
  pollTimeoutMs,
}: {
  kind: ApimodelsTaskKind;
  taskId: string;
  config: ApimodelsConfig;
  headers?: Record<string, string | undefined>;
  abortSignal?: AbortSignal;
  pollIntervalMs: number;
  pollTimeoutMs: number;
}): Promise<{ task: ApimodelsTask; responseHeaders: Record<string, string> | undefined }> {
  const deadline = Date.now() + pollTimeoutMs;
  for (;;) {
    const result = await getTask({ kind, taskId, config, headers, abortSignal });
    const { task } = result;
    if (task.state === 'completed') {
      if (task.resultUrls.length === 0) {
        throw new ApimodelsTaskFailedError({ taskId, message: 'completed without result URLs' });
      }
      return result;
    }
    if (task.state === 'failed') {
      throw new ApimodelsTaskFailedError({
        taskId,
        message: task.failMsg || task.failCode || 'unknown error',
        failCode: task.failCode,
      });
    }
    if (Date.now() + pollIntervalMs > deadline) {
      throw new Error(
        `apimodels.app task ${taskId} is still running after ${Math.round(pollTimeoutMs / 1000)}s. ` +
          'It keeps running and is billed once when it completes; raise providerOptions.apimodels.pollTimeoutMs to wait longer.',
      );
    }
    await delay(pollIntervalMs, { abortSignal });
  }
}

/**
 * Returns a URL the apimodels.app servers can fetch. URLs pass through; inline
 * bytes (base64 or Uint8Array) are uploaded to /v1/files first.
 */
export async function toPublicUrl({
  file,
  config,
  headers,
  abortSignal,
}: {
  file:
    | { type: 'url'; url: string }
    | { type: 'file'; mediaType: string; data: string | Uint8Array };
  config: ApimodelsConfig;
  headers?: Record<string, string | undefined>;
  abortSignal?: AbortSignal;
}): Promise<string> {
  if (file.type === 'url') {
    return file.url;
  }

  let mediaType = file.mediaType;
  let bytes: Uint8Array;
  if (typeof file.data === 'string') {
    const dataUrl = file.data.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (dataUrl) {
      mediaType = dataUrl[1] || mediaType;
      bytes = dataUrl[2]
        ? convertBase64ToUint8Array(dataUrl[3])
        : new TextEncoder().encode(decodeURIComponent(dataUrl[3]));
    } else {
      bytes = convertBase64ToUint8Array(file.data);
    }
  } else {
    bytes = file.data;
  }

  const extension = (mediaType.split('/')[1] || 'bin').replace(/[^\w]/g, '');
  const formData = new FormData();
  formData.append('file', new Blob([bytes as BlobPart], { type: mediaType }), `input.${extension}`);

  const url = `${config.baseURL}/files`;
  const { value, rawValue } = await postFormDataToApi({
    url,
    headers: mergeHeaders(config.headers(), headers),
    formData,
    successfulResponseHandler: createJsonResponseHandler(envelopeSchema),
    failedResponseHandler: apimodelsFailedResponseHandler,
    abortSignal,
    fetch: config.fetch,
  });
  const publicUrl = asRecord(value.data).publicUrl;
  if (typeof publicUrl !== 'string') {
    return rejectEnvelope(url, { file: `input.${extension}` }, value, rawValue);
  }
  return publicUrl;
}

/**
 * Combines the provider headers with per-call headers. The AI SDK passes its own
 * user-agent per call; both user-agents are kept so requests stay attributable.
 */
export function mergeHeaders(
  base: Record<string, string | undefined>,
  extra: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> {
  const merged = combineHeaders(base, extra);
  const ua = (h: Record<string, string | undefined> | undefined) =>
    h ? Object.entries(h).find(([k]) => k.toLowerCase() === 'user-agent')?.[1] : undefined;
  const baseUa = ua(base);
  const extraUa = ua(extra);
  if (baseUa && extraUa && baseUa !== extraUa) {
    for (const key of Object.keys(merged)) {
      if (key.toLowerCase() === 'user-agent') delete merged[key];
    }
    merged['user-agent'] = `${extraUa} ${baseUa}`;
  }
  return merged;
}

export function removeUndefinedEntries(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined));
}
