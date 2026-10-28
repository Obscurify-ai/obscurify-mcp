// Thin client for the Obscurify.ai API (https://obscurify.ai/api-docs).
import { createRequire } from "node:module";

export const VERSION: string = createRequire(import.meta.url)("../package.json").version;
export const SITE_URL = "https://obscurify.ai/?utm_source=mcp";

export interface Config {
  apiKey?: string;
  /** OpenAI-compatible base URL, e.g. https://obscurify.ai/v1 */
  baseUrl: string;
  defaultModel: string;
  secondOpinionModels: string[];
  timeoutMs: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const list = (s: string | undefined) =>
    (s ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  return {
    apiKey: env.OBSCURIFY_API_KEY?.trim() || undefined,
    baseUrl: (env.OBSCURIFY_BASE_URL?.trim() || "https://obscurify.ai/v1").replace(/\/+$/, ""),
    defaultModel: env.OBSCURIFY_DEFAULT_MODEL?.trim() || "deepseek/deepseek-v4-flash",
    secondOpinionModels: list(env.OBSCURIFY_SECOND_OPINION_MODELS).length
      ? list(env.OBSCURIFY_SECOND_OPINION_MODELS)
      : ["deepseek/deepseek-v4-flash", "meta-llama/llama-3.3-70b-instruct", "qwen/qwen3.8-27b"],
    timeoutMs: Number(env.OBSCURIFY_TIMEOUT_MS) > 0 ? Number(env.OBSCURIFY_TIMEOUT_MS) : 180_000,
  };
}

export class ObscurifyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type Role = "system" | "user" | "assistant";
export interface Message {
  role: Role;
  content: string;
}

export interface Completion {
  model: string;
  content: string;
  reasoning?: string;
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  cost?: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  context_length: number;
  input_per_million: number;
  output_per_million: number;
  tools: boolean;
  plan: "any" | "casual" | "pro";
}

export interface ImageModel {
  id: string;
  name: string;
  family: string;
  pipelines: string[];
  price: number;
}

export interface AccountInfo {
  balance_usd: number;
  plan: string;
  included_credit_usd: number;
  included_credit_used_usd: number;
  input_tokens_this_period: number;
  output_tokens_this_period: number;
  can_use_frontier_models: boolean;
  can_use_uncensored_models: boolean;
  next_charge_date: string | null;
}

/** `**opus-5**` style patterns from /frontier_models and /uncensored_models. */
function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

const CACHE_MS = 10 * 60 * 1000;

export class ObscurifyClient {
  private modelsCache?: { at: number; models: ModelInfo[] };
  private imageModelsCache?: { at: number; models: ImageModel[] };

  constructor(readonly config: Config) {}

  /** Site root, for the non-/v1 account and image endpoints. */
  private get root(): string {
    return this.config.baseUrl.replace(/\/v1$/, "");
  }

  private requireKey(): string {
    if (!this.config.apiKey) {
      throw new ObscurifyError(
        "No API key. Set OBSCURIFY_API_KEY to an Obscurify.ai API key (sk-obs1_...). " +
          `Create an account at ${SITE_URL} (a random account number, no email), add a balance, then click Show API Key on https://obscurify.ai/account.`,
      );
    }
    return this.config.apiKey;
  }

  private async request<T>(url: string, init: RequestInit & { auth?: boolean; timeoutMs?: number } = {}): Promise<T> {
    const timeoutMs = init.timeoutMs ?? this.config.timeoutMs;
    const headers: Record<string, string> = {
      "User-Agent": `obscurify-mcp/${VERSION}`,
      Accept: "application/json",
    };
    if (init.body) headers["Content-Type"] = "application/json";
    if (init.auth) headers.Authorization = `Bearer ${this.requireKey()}`;
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const err = e as Error;
      if (err.name === "TimeoutError") {
        throw new ObscurifyError(`Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
      }
      throw new ObscurifyError(`Could not reach Obscurify.ai: ${err.message}`);
    }
    const text = await res.text();
    if (!res.ok) throw new ObscurifyError(explainStatus(res.status, text), res.status);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ObscurifyError(`Unexpected response from Obscurify.ai (HTTP ${res.status}).`, res.status);
    }
  }

  async complete(opts: {
    model?: string;
    messages: Message[];
    reasoningEffort?: string;
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
  }): Promise<Completion> {
    const body: Record<string, unknown> = {
      model: opts.model || this.config.defaultModel,
      messages: opts.messages,
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;
    type Resp = {
      model?: string;
      choices?: { finish_reason?: string; message?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    const data = await this.request<Resp>(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      auth: true,
      body: JSON.stringify(body),
      timeoutMs: opts.timeoutMs,
    });
    const choice = data.choices?.[0];
    return {
      model: data.model || String(body.model),
      content: choice?.message?.content ?? "",
      reasoning: choice?.message?.reasoning || choice?.message?.reasoning_content || undefined,
      finishReason: choice?.finish_reason,
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
      cost: data.usage?.cost,
    };
  }

  async models(): Promise<ModelInfo[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < CACHE_MS) return this.modelsCache.models;
    type Raw = {
      id: string;
      name?: string;
      context_length?: number;
      decisions?: boolean;
      tools?: boolean;
      pricing?: { prompt?: number | string; completion?: number | string };
    };
    const [list, frontier, uncensored] = await Promise.all([
      this.request<{ data: Raw[] }>(`${this.config.baseUrl}/models`),
      this.request<{ frontier_models?: string[] }>(`${this.root}/frontier_models`).catch(() => ({ frontier_models: [] })),
      this.request<{ uncensored_models?: string[] }>(`${this.root}/uncensored_models`).catch(() => ({ uncensored_models: [] })),
    ]);
    const frontierRe = (frontier.frontier_models ?? []).map(globToRegex);
    const uncensoredRe = (uncensored.uncensored_models ?? []).map(globToRegex);
    const perM = (v: number | string | undefined) => Math.round(Number(v ?? 0) * 1e6 * 1000) / 1000;
    const models = list.data
      .filter((m) => !m.decisions)
      .map((m): ModelInfo => ({
        id: m.id,
        name: m.name ?? m.id,
        context_length: m.context_length ?? 0,
        input_per_million: perM(m.pricing?.prompt),
        output_per_million: perM(m.pricing?.completion),
        tools: Boolean(m.tools),
        plan: uncensoredRe.some((r) => r.test(m.id)) ? "pro" : frontierRe.some((r) => r.test(m.id)) ? "casual" : "any",
      }));
    this.modelsCache = { at: Date.now(), models };
    return models;
  }

  async imageModels(): Promise<ImageModel[]> {
    if (this.imageModelsCache && Date.now() - this.imageModelsCache.at < CACHE_MS) return this.imageModelsCache.models;
    const data = await this.request<{ models: ImageModel[] }>(`${this.root}/img_gen_models`);
    // The API generates with these base families only (see POST /image_generation).
    const families = new Set(["stable-diffusion", "stable-diffusion-xl", "latent-consistency"]);
    const models = data.models.filter(
      (m) => families.has(m.family) && m.pipelines?.includes("text-to-image") && !/inpainting|pix2pix/.test(m.id),
    );
    this.imageModelsCache = { at: Date.now(), models };
    return models;
  }

  async generateImage(opts: {
    prompt: string;
    model: string;
    negativePrompt?: string;
    width?: number;
    height?: number;
    seed?: number;
  }): Promise<{ data?: string; url?: string; mimeType: string; model: ImageModel }> {
    const models = await this.imageModels();
    const model = models.find((m) => m.id === opts.model);
    if (!model) {
      throw new ObscurifyError(
        `Unknown image model "${opts.model}". Text-to-image models: ${models.map((m) => m.id).join(", ")}`,
      );
    }
    const body: Record<string, unknown> = { base: model.family, model: model.id, prompt: opts.prompt };
    if (opts.negativePrompt) body.negative_prompt = opts.negativePrompt;
    if (opts.width) body.width = opts.width;
    if (opts.height) body.height = opts.height;
    if (opts.seed !== undefined) body.seed = opts.seed;
    const res = await this.request<{ image: string }>(`${this.root}/image_generation`, {
      method: "POST",
      auth: true,
      body: JSON.stringify(body),
    });
    const image = res.image ?? "";
    if (/^https?:\/\//.test(image)) return { url: image, mimeType: "", model };
    const b64 = image.replace(/^data:[^,]+,/, "");
    const mimeType = b64.startsWith("iVBOR")
      ? "image/png"
      : b64.startsWith("UklGR")
        ? "image/webp"
        : "image/jpeg";
    return { data: b64, mimeType, model };
  }

  async account(): Promise<AccountInfo> {
    type Tier = {
      tier: string;
      included_credit: number;
      credit_used: number;
      input_tokens_used: number;
      output_tokens_used: number;
      can_access_frontier: boolean;
      can_access_uncensored: boolean;
      next_charge_date: string | null;
    };
    const [bal, tier] = await Promise.all([
      this.request<{ balance: number }>(`${this.root}/get_user_balance`, { auth: true }),
      this.request<Tier>(`${this.root}/account_tier`, { auth: true }),
    ]);
    const planNames: Record<string, string> = { pay_as_you_go: "Pay As You Go", casual: "Casual", pro: "Pro" };
    return {
      balance_usd: bal.balance,
      plan: planNames[tier.tier] ?? tier.tier,
      included_credit_usd: tier.included_credit,
      included_credit_used_usd: tier.credit_used,
      input_tokens_this_period: tier.input_tokens_used,
      output_tokens_this_period: tier.output_tokens_used,
      can_use_frontier_models: tier.can_access_frontier,
      can_use_uncensored_models: tier.can_access_uncensored,
      next_charge_date: tier.next_charge_date,
    };
  }
}

function explainStatus(status: number, body: string): string {
  let detail = body.trim();
  try {
    const j = JSON.parse(body);
    detail = j?.error?.message ?? j?.error ?? j?.message ?? detail;
    if (typeof detail !== "string") detail = JSON.stringify(detail);
  } catch {
    /* plain text */
  }
  detail = detail.slice(0, 500);
  switch (status) {
    case 401:
      return `Obscurify.ai rejected the API key (401). Check OBSCURIFY_API_KEY; keys look like sk-obs1_... ${detail}`;
    case 402:
      return `No balance to spend (402). Add credit to the account at ${SITE_URL} ${detail}`;
    case 403:
      return (
        `This model isn't on the account's plan (403): frontier models need Casual or Pro, uncensored models need Pro. ` +
        `Pick another model (list_models shows the plan each one needs) or see https://obscurify.ai/pricing. ${detail}`
      );
    case 404:
      return `Not found (404). If this was a model ID, check it with list_models. ${detail}`;
    case 429:
      return `Rate or usage limit reached (429). ${detail}`;
    default:
      return `Obscurify.ai returned HTTP ${status}. ${detail}`;
  }
}
