import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type Completion, type Config, ObscurifyClient, ObscurifyError, SITE_URL, VERSION } from "./api.js";

const reasoningEffort = z
  .enum(["low", "medium", "high"])
  .optional()
  .describe("How hard a reasoning model should think. Ignored by models without reasoning. Omit for the model's default.");
const maxTokens = z
  .number()
  .int()
  .min(1)
  .max(200_000)
  .optional()
  .describe("Cap on the reply length in tokens (default 4096). Reasoning models spend some of these thinking.");
const temperature = z.number().min(0).max(2).optional().describe("Sampling temperature, 0-2. Omit for the model's default.");

function fail(e: unknown): CallToolResult {
  const msg = e instanceof ObscurifyError ? e.message : `Unexpected error: ${(e as Error)?.message ?? String(e)}`;
  return { isError: true, content: [{ type: "text", text: msg }] };
}

function usageLine(c: Completion): string {
  const parts = [`model: ${c.model}`];
  if (c.promptTokens !== undefined || c.completionTokens !== undefined) {
    parts.push(`tokens: ${c.promptTokens ?? "?"} in / ${c.completionTokens ?? "?"} out`);
  }
  if (typeof c.cost === "number") parts.push(`cost: $${c.cost.toFixed(c.cost < 0.01 ? 6 : 4)}`);
  if (c.finishReason === "length") parts.push("stopped at max_tokens");
  return `[${parts.join(" · ")}]`;
}

function completionText(c: Completion, showReasoning?: boolean): string {
  let text =
    c.content ||
    (c.finishReason === "length" && c.reasoning
      ? "(No reply: the model spent all of max_tokens reasoning. Raise max_tokens or set reasoning_effort to low.)"
      : "(empty reply)");
  if (showReasoning && c.reasoning) text = `<reasoning>\n${c.reasoning}\n</reasoning>\n\n${text}`;
  return `${text}\n\n${usageLine(c)}`;
}

function fmtCtx(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

// Calls that spend from the account balance aren't read-only, though they change nothing else.
const PAID = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

export function createServer(config: Config): McpServer {
  const client = new ObscurifyClient(config);
  const server = new McpServer(
    { name: "obscurify", title: "Obscurify.ai", version: VERSION, websiteUrl: SITE_URL },
    {
      instructions:
        "Obscurify.ai gives private access to 200+ AI models (Claude, GPT, Gemini, Llama, DeepSeek, Qwen and more) " +
        "through zero-data-retention routes; prompts and replies are not stored by Obscurify.ai. Use `ask` for a one-off " +
        "question to another model, `chat` to continue a conversation, `second_opinion` to compare answers from several " +
        "models, `list_models` to find model IDs, prices and context sizes, `generate_image` for pictures and `balance` " +
        "to check spending. Calls cost money from the account balance; the default model is cheap.",
    },
  );

  server.registerTool(
    "ask",
    {
      title: "Ask a model",
      description:
        "Send one prompt to any Obscurify.ai model and get its reply. Useful for delegating a subtask to a cheaper or " +
        "specialised model, getting an outside view, or using a model you don't otherwise have. Prompts go through " +
        "zero-data-retention routes and are not stored by Obscurify.ai. " +
        `Default model: ${config.defaultModel} (fast and cheap). Use list_models to find other model IDs. ` +
        "For follow-ups that need earlier turns use chat; to compare several models use second_opinion.",
      inputSchema: {
        prompt: z.string().min(1).describe("The full prompt. The model sees nothing else, so include any context it needs."),
        model: z
          .string()
          .optional()
          .describe(`Model ID such as "anthropic/claude-sonnet-5.5" or "openai/gpt-5.5". Default: ${config.defaultModel}.`),
        system: z.string().optional().describe("Optional system prompt."),
        reasoning_effort: reasoningEffort,
        max_tokens: maxTokens,
        temperature,
        show_reasoning: z.boolean().optional().describe("Include the model's reasoning text, when it returns one (default false)."),
      },
      annotations: PAID,
    },
    async (a) => {
      try {
        const messages = [
          ...(a.system ? [{ role: "system" as const, content: a.system }] : []),
          { role: "user" as const, content: a.prompt },
        ];
        const c = await client.complete({
          model: a.model,
          messages,
          reasoningEffort: a.reasoning_effort,
          maxTokens: a.max_tokens ?? 4096,
          temperature: a.temperature,
        });
        return { content: [{ type: "text", text: completionText(c, a.show_reasoning) }] };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "chat",
    {
      title: "Multi-turn chat",
      description:
        "Continue a multi-turn conversation with an Obscurify.ai model. Pass the whole history in `messages` " +
        "(the server keeps no state) and get the next assistant reply. For a single question, ask is simpler. " +
        `Default model: ${config.defaultModel}.`,
      inputSchema: {
        messages: z
          .array(
            z.object({
              role: z.enum(["system", "user", "assistant"]),
              content: z.string(),
            }),
          )
          .min(1)
          .describe("Conversation so far, oldest first. The last message is usually from the user."),
        model: z.string().optional().describe(`Model ID. Default: ${config.defaultModel}.`),
        reasoning_effort: reasoningEffort,
        max_tokens: maxTokens,
        temperature,
        show_reasoning: z.boolean().optional().describe("Include the model's reasoning text, when it returns one (default false)."),
      },
      annotations: PAID,
    },
    async (a) => {
      try {
        const c = await client.complete({
          model: a.model,
          messages: a.messages,
          reasoningEffort: a.reasoning_effort,
          maxTokens: a.max_tokens ?? 4096,
          temperature: a.temperature,
        });
        return { content: [{ type: "text", text: completionText(c, a.show_reasoning) }] };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "second_opinion",
    {
      title: "Second opinion from several models",
      description:
        "Send the same prompt to 2-5 different models at once and return every answer side by side, so you can compare " +
        "them, check a claim, review code or a plan, or break a tie. " +
        `Default models: ${config.secondOpinionModels.join(", ")}.`,
      inputSchema: {
        prompt: z.string().min(1).describe("The full prompt, with all the context the models need."),
        models: z
          .array(z.string())
          .min(2)
          .max(5)
          .optional()
          .describe("Model IDs to ask (2-5). Pick different families for independent views."),
        system: z.string().optional().describe("Optional system prompt for every model."),
        reasoning_effort: reasoningEffort,
        max_tokens: maxTokens,
      },
      annotations: PAID,
    },
    async (a) => {
      const models = [...new Set(a.models?.length ? a.models : config.secondOpinionModels)];
      const messages = [
        ...(a.system ? [{ role: "system" as const, content: a.system }] : []),
        { role: "user" as const, content: a.prompt },
      ];
      const results = await Promise.allSettled(
        models.map((model) =>
          client.complete({
            model,
            messages,
            reasoningEffort: a.reasoning_effort,
            maxTokens: a.max_tokens ?? 4096,
            // One slow model shouldn't sink the others: cap each so the answers that came back still arrive.
            timeoutMs: Math.min(config.timeoutMs, 55_000),
          }),
        ),
      );
      const sections = results.map((r, i) =>
        r.status === "fulfilled"
          ? `## ${models[i]}\n\n${completionText(r.value)}`
          : `## ${models[i]}\n\nFailed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const total = results.reduce((s, r) => s + (r.status === "fulfilled" ? (r.value.cost ?? 0) : 0), 0);
      const footer = `${ok}/${models.length} models answered · total cost: $${total.toFixed(6)}`;
      return {
        isError: ok === 0,
        content: [{ type: "text", text: `${sections.join("\n\n---\n\n")}\n\n---\n${footer}` }],
      };
    },
  );

  server.registerTool(
    "list_models",
    {
      title: "List models",
      description:
        "List Obscurify.ai chat models with their IDs, context window, price per million input/output tokens (USD), " +
        "tool-calling support and the plan they need (any = every account with a balance; casual = Casual or Pro; " +
        "pro = Pro only). Filter by name, plan, price or tool support. Use it to find a model ID for ask, chat or " +
        "second_opinion, or the cheapest model with what you need. Doesn't need an API key.",
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe('Case-insensitive text to match in the model ID or name, e.g. "claude", "deepseek", "coder".'),
        plan: z
          .enum(["any", "casual", "pro"])
          .optional()
          .describe("Only models usable on this plan: any (Pay As You Go and up), casual, or pro (everything)."),
        max_output_price: z.number().optional().describe("Only models whose output price is at most this many USD per million tokens."),
        tools_only: z.boolean().optional().describe("Only models that support tool/function calling."),
        sort: z.enum(["id", "price", "context"]).optional().describe("Sort order (default id). price = cheapest output first."),
        limit: z.number().int().min(1).max(500).optional().describe("Max rows (default 60)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) => {
      try {
        let models = await client.models();
        const total = models.length;
        if (a.search) {
          const q = a.search.toLowerCase();
          models = models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
        }
        if (a.plan === "any") models = models.filter((m) => m.plan === "any");
        if (a.plan === "casual") models = models.filter((m) => m.plan !== "pro");
        if (a.max_output_price !== undefined) models = models.filter((m) => m.output_per_million <= a.max_output_price!);
        if (a.tools_only) models = models.filter((m) => m.tools);
        if (a.sort === "price") models = [...models].sort((x, y) => x.output_per_million - y.output_per_million);
        else if (a.sort === "context") models = [...models].sort((x, y) => y.context_length - x.context_length);
        const matched = models.length;
        models = models.slice(0, a.limit ?? 60);
        const rows = models.map(
          (m) =>
            `${m.id} | ${fmtCtx(m.context_length)} | $${m.input_per_million} | $${m.output_per_million} | ${m.tools ? "yes" : "no"} | ${m.plan}`,
        );
        const head =
          `${matched} of ${total} models match${matched > models.length ? ` (showing ${models.length}; raise limit or narrow the search)` : ""}.\n` +
          "id | context | $/M in | $/M out | tools | plan\n";
        return {
          content: [{ type: "text", text: head + rows.join("\n") }],
          structuredContent: { total, matched, models },
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "generate_image",
    {
      title: "Generate an image",
      description:
        "Generate an image from a text prompt with Obscurify.ai's Stable Diffusion image models (SDXL, SD 1.5 and LCM checkpoints). " +
        "Returns the image. Costs a fraction of a cent per image from the account balance. " +
        "Pass `list: true` to see the available image models and prices instead.",
      inputSchema: {
        prompt: z.string().optional().describe("What to draw. Required unless list is true."),
        model: z
          .string()
          .optional()
          .describe('Image model ID (default "realvis-xl-v4", photorealistic). Others include "juggernaut-xl-v10" and "animagine-xl-v-3-1" (anime). Use list: true for all.'),
        negative_prompt: z.string().optional().describe("Things to keep out of the image."),
        width: z.number().int().min(256).max(2048).optional().describe("Width in pixels (default: the model's)."),
        height: z.number().int().min(256).max(2048).optional().describe("Height in pixels (default: the model's)."),
        seed: z.number().int().optional().describe("Seed for reproducible results."),
        list: z.boolean().optional().describe("List image models and prices instead of generating."),
      },
      annotations: PAID,
    },
    async (a) => {
      try {
        if (a.list || !a.prompt) {
          const models = await client.imageModels();
          const rows = models.map((m) => `${m.id} | ${m.name} | ${m.family} | $${m.price}`);
          const note = a.prompt || a.list ? "" : "No prompt given, so here are the image models.\n";
          return { content: [{ type: "text", text: `${note}id | name | family | $/image\n${rows.join("\n")}` }] };
        }
        const img = await client.generateImage({
          prompt: a.prompt,
          model: a.model ?? "realvis-xl-v4",
          negativePrompt: a.negative_prompt,
          width: a.width,
          height: a.height,
          seed: a.seed,
        });
        const caption = `[model: ${img.model.id} · price: $${img.model.price}/image]`;
        if (img.url) return { content: [{ type: "text", text: `${img.url}\n${caption}` }] };
        return {
          content: [
            { type: "image", data: img.data!, mimeType: img.mimeType },
            { type: "text", text: caption },
          ],
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "balance",
    {
      title: "Account balance and plan",
      description:
        "Show the Obscurify.ai account's balance (USD), plan, included credit used this billing period, token usage, " +
        "and whether it can use frontier and uncensored models. Use it before a large batch of calls, or when a call " +
        "fails with a balance (402) or plan (403) error.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const info = await client.account();
        const text =
          `Balance: $${info.balance_usd.toFixed(2)}\n` +
          `Plan: ${info.plan}\n` +
          (info.included_credit_usd > 0
            ? `Included credit used: $${info.included_credit_used_usd.toFixed(2)} of $${info.included_credit_usd.toFixed(2)}\n`
            : "") +
          `Tokens this period: ${info.input_tokens_this_period} in / ${info.output_tokens_this_period} out\n` +
          `Frontier models: ${info.can_use_frontier_models ? "yes" : "no (Casual or Pro)"}\n` +
          `Uncensored models: ${info.can_use_uncensored_models ? "yes" : "no (Pro)"}` +
          (info.next_charge_date ? `\nNext charge: ${info.next_charge_date}` : "");
        return { content: [{ type: "text", text }], structuredContent: { ...info } };
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
