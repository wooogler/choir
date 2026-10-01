/**
 * Which sampling knobs a model accepts on the Responses API.
 *
 * Reasoning models reject `temperature` unless reasoning effort is `none`, and
 * not every model offers `none`. GPT-6 Luna and GPT-6 Sol do; GPT-6 Astra and
 * GPT-6.1 Sol start at `low`. For the GPT-6 family we pick the cheapest effort
 * the model supports — CHOIR's prompts are extraction and rewriting, not
 * reasoning, and GPT-5.4's default was `none` — and keep `temperature` only
 * where `none` makes it legal.
 *
 * Model lists drift faster than code, so this is backed by a runtime fallback:
 * a 400 naming `temperature` retries once without it and remembers the model
 * for the rest of the process.
 */

import type { Reasoning } from 'openai/resources/shared';

export interface SamplingParams {
  temperature?: number;
  reasoning?: Reasoning;
}

// Learned from 400s at runtime, so a model the lists below miss pays for one
// failed request per process, not one per call.
const modelsWithoutTemperature = new Set<string>();

// GPT-6 models that accept `reasoning.effort: 'none'`. `gpt-6.1-sol` is a
// different model from `gpt-6-sol` and does not.
const GPT6_NONE_EFFORT = /^gpt-6-(luna|sol)(-|$)/;

function isGpt6(model: string): boolean {
  return /^gpt-6([.-]|$)/.test(model);
}

export function reasoningFor(model: string): Reasoning | undefined {
  if (!isGpt6(model)) return undefined;
  // The installed SDK's ReasoningEffort type predates `none`; the API takes it.
  return { effort: (GPT6_NONE_EFFORT.test(model) ? 'none' : 'low') as Reasoning['effort'] };
}

export function samplingParamsFor(model: string, temperature: number | undefined): SamplingParams {
  const reasoning = reasoningFor(model);
  const temperatureAllowed =
    temperature !== undefined &&
    !modelsWithoutTemperature.has(model) &&
    (reasoning === undefined || (reasoning.effort as string) === 'none');

  return {
    ...(temperatureAllowed ? { temperature } : {}),
    ...(reasoning ? { reasoning } : {}),
  };
}

function isUnsupportedTemperatureError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { status, param, message } = error as { status?: unknown; param?: unknown; message?: unknown };
  if (status !== 400) return false;
  return param === 'temperature' || (typeof message === 'string' && message.includes("'temperature'"));
}

/**
 * Sends a request built from `samplingParamsFor`, retrying once without
 * `temperature` when the API says the model does not take it.
 */
export async function withTemperatureFallback<T>(
  model: string,
  temperature: number | undefined,
  send: (params: SamplingParams) => Promise<T>,
): Promise<T> {
  const params = samplingParamsFor(model, temperature);
  try {
    return await send(params);
  } catch (error) {
    if (params.temperature === undefined || !isUnsupportedTemperatureError(error)) throw error;
    modelsWithoutTemperature.add(model);
    return send(params.reasoning ? { reasoning: params.reasoning } : {});
  }
}

/** Test hook: forget models learned from earlier 400s. */
export function resetLearnedSamplingParams(): void {
  modelsWithoutTemperature.clear();
}
