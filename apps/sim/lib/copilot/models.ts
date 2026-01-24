export const COPILOT_MODEL_IDS = [
  'deepseek-r1',
  'glm-4-5-air-128k',
  'glm-4-7-128k',
  'mixtral-8x22b',
  'llama4-scout-17b',
  'qwen3-coder-30b-a3b-instruct',
  'qwen3-30b-a3b-thinking-2507',
  'qwen3-30b-a3b-instruct-2507',
  'qwen3-235b-a22b-instruct-2507',
  'qwen3-235b-a22b-thinking-2507',
  'litellm',
] as const

export type CopilotModelId = (typeof COPILOT_MODEL_IDS)[number]

export const COPILOT_MODES = ['ask', 'build', 'plan'] as const
export type CopilotMode = (typeof COPILOT_MODES)[number]

export const COPILOT_TRANSPORT_MODES = ['ask', 'agent', 'plan'] as const
export type CopilotTransportMode = (typeof COPILOT_TRANSPORT_MODES)[number]

export const COPILOT_REQUEST_MODES = ['ask', 'build', 'plan', 'agent'] as const
export type CopilotRequestMode = (typeof COPILOT_REQUEST_MODES)[number]
