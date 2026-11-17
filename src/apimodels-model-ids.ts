// A selection of model ids for editor autocompletion. Any id listed at
// https://api.apimodels.app/v1/models (or https://apimodels.app/models) works.

export type ApimodelsChatModelId =
  | 'claude-opus-5-5'
  | 'claude-sonnet-5-5'
  | 'claude-haiku-5-5'
  | 'claude-fable-5-2'
  | 'gpt-6.1-sol'
  | 'gpt-6.1-terra'
  | 'gpt-6-astra'
  | 'gpt-6-luna'
  | 'gpt-5.6-luna'
  | 'gemini-4-carbon'
  | 'gemini-4-hydrogen'
  | 'gemini-4-argon'
  | 'gemini-3.8-flash'
  | 'gemini-3.5-flash'
  | 'qwen4-max'
  | 'qwen3.8-max'
  | 'qwen3.8-flash'
  | 'deepseek-v4-pro'
  | 'deepseek-v4.1-flash'
  | 'glm-5.3'
  | 'grok-4.6'
  | (string & {});

export type ApimodelsEmbeddingModelId =
  | 'text-embedding-3-small'
  | 'text-embedding-3-large'
  | (string & {});

export type ApimodelsImageModelId =
  | 'gpt-image-2'
  | 'gpt-image-2-lite'
  | 'gpt-image-2.6-sunburst'
  | 'gpt-image-2.6-flare'
  | 'nano-banana-2-1'
  | 'gemini-3-pro-image'
  | 'gemini-3.1-flash-image'
  | 'doubao-seedream-5-5'
  | 'doubao-seedream-5-0-pro'
  | 'doubao-seedream-5-0-flash'
  | 'qwen3-image'
  | 'qwen3-image-pro'
  | 'flux-2-klein-4b'
  | 'grok-imagine-image-2'
  | 'kling-v3'
  | 'muse-image'
  | (string & {});

export type ApimodelsVideoModelId =
  | 'veo-3.1-fast-fhd'
  | 'veo-3.1'
  | 'kling-4.0'
  | 'kling-4.0-flash'
  | 'seedance-2.5'
  | 'seedance-2.5-lite'
  | 'seedance-2.0'
  | 'seedance-2.0-fast'
  | 'wan-3.0-video'
  | 'minimax-h3'
  | 'minimax-h3-lite'
  | 'grok-imagine-video-1.5'
  | 'vidu-q4'
  | 'ltx-2.3'
  | (string & {});
