export const MODEL_CATALOG = [
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    description: 'Fastest and lowest-cost option for routine card generation.',
    inputUsdPerMillion: 0.2,
    cachedInputUsdPerMillion: 0.02,
    outputUsdPerMillion: 1.2,
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    description: 'A stronger balance of card quality, speed, and cost.',
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.2,
    outputUsdPerMillion: 12,
  },
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    description: 'Highest-capability option for difficult or nuanced sources.',
    inputUsdPerMillion: 4,
    cachedInputUsdPerMillion: 0.4,
    outputUsdPerMillion: 20,
  },
] as const;

export type ModelId = (typeof MODEL_CATALOG)[number]['id'];

export const DEFAULT_MODEL_ID: ModelId = 'gpt-5.6-luna';

export function isModelId(value: string): value is ModelId {
  return MODEL_CATALOG.some((model) => model.id === value);
}

export function getModelConfig(value: string) {
  return MODEL_CATALOG.find((model) => model.id === value) ?? MODEL_CATALOG[0];
}

export function estimateTokenCostUsd(
  modelId: ModelId,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
) {
  const model = getModelConfig(modelId);
  const cached = Math.max(0, Math.min(inputTokens, cachedInputTokens));
  const uncached = Math.max(0, inputTokens - cached);
  return (
    uncached * model.inputUsdPerMillion
    + cached * model.cachedInputUsdPerMillion
    + Math.max(0, outputTokens) * model.outputUsdPerMillion
  ) / 1_000_000;
}
