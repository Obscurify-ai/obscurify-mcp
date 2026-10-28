# Obscurify.ai MCP server

[![npm](https://img.shields.io/npm/v/@obscurify/mcp)](https://www.npmjs.com/package/@obscurify/mcp)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.Obscurify--ai%2Fobscurify--mcp-blue)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.Obscurify-ai/obscurify-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Give your AI agent private access to 200+ other models. This [Model Context Protocol](https://modelcontextprotocol.io) server lets Claude Desktop, Claude Code, Cursor, VS Code, Codex, opencode and any other MCP client ask Claude, GPT, Gemini, Llama, DeepSeek, Qwen and more through [Obscurify.ai](https://obscurify.ai/?utm_source=mcp).

Obscurify.ai is a privacy-focused, OpenAI-compatible AI platform. Text requests only use zero-data-retention routes, prompts and responses aren't stored on its servers, and accounts are a random 16-digit account number with no email, phone or password.

## Tools

| Tool | What it does |
|---|---|
| `ask` | One prompt to any model, with an optional system prompt, `reasoning_effort`, `max_tokens` and `temperature`. Returns the reply plus model, tokens and cost. |
| `chat` | Multi-turn: pass the whole `messages` history and get the next reply. |
| `second_opinion` | The same prompt to 2-5 models in parallel, every answer side by side. Good for checking a claim, reviewing code or a plan, or breaking a tie. |
| `list_models` | Model IDs with context window, price per million input/output tokens, tool support and the plan each needs. Filter by name, plan, price or tool support. Works without a key. |
| `generate_image` | Text-to-image with Stable Diffusion models (SDXL, SD 1.5, LCM). Returns the image. `list: true` shows the models and prices. |
| `balance` | Balance, plan, usage this billing period, and whether the account can use frontier and uncensored models. |

Defaults are cheap and fast: `ask` and `chat` use `deepseek/deepseek-v4-flash`, and `second_opinion` asks `deepseek/deepseek-v4-flash`, `meta-llama/llama-3.3-70b-instruct` and `qwen/qwen3.8-27b`. Pass `model` / `models` to use anything else, e.g. `anthropic/claude-sonnet-5.5` or `openai/gpt-5.5`.

## Get an API key

1. Create an account at [obscurify.ai](https://obscurify.ai/?utm_source=mcp). You get a random account number: no email, no password.
2. Add a balance (card, Monero, Bitcoin or Lightning). The API works on every plan with a positive balance. Frontier models need the Casual plan or higher, and uncensored models need Pro ([pricing](https://obscurify.ai/pricing?utm_source=mcp)).
3. On [obscurify.ai/account](https://obscurify.ai/account?utm_source=mcp), click **Show API Key** and copy the `sk-obs1_...` key.

Calls cost money from your balance at each model's listed price ([model cards](https://obscurify.ai/model_cards?utm_source=mcp)). Every reply shows what it cost.

## Setup

The server runs with `npx -y @obscurify/mcp` (Node.js 20 or newer) and reads the key from `OBSCURIFY_API_KEY`.

### Claude Code

```sh
claude mcp add obscurify -e OBSCURIFY_API_KEY=sk-obs1_... -- npx -y @obscurify/mcp
```

Add `-s user` to make it available in every project.

### Claude Desktop

Settings → Developer → Edit Config, then add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "obscurify": {
      "command": "npx",
      "args": ["-y", "@obscurify/mcp"],
      "env": { "OBSCURIFY_API_KEY": "sk-obs1_..." }
    }
  }
}
```

Restart Claude Desktop.

### Cursor

Add the same `mcpServers` block to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "obscurify": {
      "command": "npx",
      "args": ["-y", "@obscurify/mcp"],
      "env": { "OBSCURIFY_API_KEY": "sk-obs1_..." }
    }
  }
}
```

### VS Code (GitHub Copilot agent mode)

Create `.vscode/mcp.json`. VS Code asks for the key once and stores it securely:

```json
{
  "inputs": [
    { "type": "promptString", "id": "obscurify-key", "description": "Obscurify.ai API key", "password": true }
  ],
  "servers": {
    "obscurify": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@obscurify/mcp"],
      "env": { "OBSCURIFY_API_KEY": "${input:obscurify-key}" }
    }
  }
}
```

### Codex CLI

```sh
codex mcp add obscurify --env OBSCURIFY_API_KEY=sk-obs1_... -- npx -y @obscurify/mcp
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.obscurify]
command = "npx"
args = ["-y", "@obscurify/mcp"]
env = { OBSCURIFY_API_KEY = "sk-obs1_..." }
# Optional: don't ask before each paid call (ask, chat, second_opinion, generate_image)
default_tools_approval_mode = "approve"
```

The tools that spend from your balance are marked as not read-only, so Codex asks before running them unless you set `default_tools_approval_mode`.

### opencode

```sh
opencode mcp add obscurify --env OBSCURIFY_API_KEY=sk-obs1_... -- npx -y @obscurify/mcp
```

That writes this to `opencode.json` (add `--global` for your global config):

```json
{
  "mcp": {
    "servers": {
      "obscurify": {
        "type": "local",
        "command": ["npx", "-y", "@obscurify/mcp"],
        "environment": { "OBSCURIFY_API_KEY": "sk-obs1_..." }
      }
    }
  }
}
```

### Windsurf, Cline, Zed and other clients

Use the command `npx -y @obscurify/mcp` with the environment variable `OBSCURIFY_API_KEY` in the client's MCP settings.

### Docker

```sh
docker build -t obscurify-mcp https://github.com/Obscurify-ai/obscurify-mcp.git
docker run -i --rm -e OBSCURIFY_API_KEY=sk-obs1_... obscurify-mcp
```

### Streamable HTTP

For clients that connect over HTTP, run the server yourself:

```sh
OBSCURIFY_API_KEY=sk-obs1_... npx -y @obscurify/mcp --http --port 3000
# MCP endpoint: http://127.0.0.1:3000/mcp   health: /health
```

It binds to `127.0.0.1` unless you pass `--host`. Each request may carry its own key as `Authorization: Bearer sk-obs1_...`, which takes precedence over `OBSCURIFY_API_KEY`, so one server can serve several accounts. The HTTP mode is stateless.

## Configuration

| Variable | Default | |
|---|---|---|
| `OBSCURIFY_API_KEY` | (none) | Your `sk-obs1_...` key. Without it only `list_models` and `generate_image list` work. |
| `OBSCURIFY_DEFAULT_MODEL` | `deepseek/deepseek-v4-flash` | Model for `ask` and `chat` when none is given. |
| `OBSCURIFY_SECOND_OPINION_MODELS` | `deepseek/deepseek-v4-flash,meta-llama/llama-3.3-70b-instruct,qwen/qwen3.8-27b` | Comma-separated models for `second_opinion`. |
| `OBSCURIFY_BASE_URL` | `https://obscurify.ai/v1` | API base URL. |
| `OBSCURIFY_TIMEOUT_MS` | `180000` | Per-request timeout. `second_opinion` caps each model at 55 s so the answers that do arrive come back. |

## Example prompts

- "Ask Gemini and GPT what they think of this migration plan, then summarise where they disagree." (`second_opinion`)
- "Find the cheapest model with tool calling and a 1M context." (`list_models`)
- "Have Llama 3.3 70B rewrite this paragraph for a general audience." (`ask`)
- "How much have I spent on Obscurify this month?" (`balance`)

## Privacy

The server is a thin client: it sends your prompts to `https://obscurify.ai` with your key and nothing else. No telemetry, no logging to disk, no file access. What Obscurify.ai keeps is described in its [privacy policy](https://obscurify.ai/privacy?utm_source=mcp): prompts and responses are not stored, and identities are scrambled before requests reach model providers. Providers still see the prompt text, so don't send secrets you wouldn't send to the model itself.

## Tested

On 2026-10-28 with a Pay As You Go key, every tool was called from MCP Inspector 2.12 (CLI), Claude Code 2.1, Codex CLI 0.165 (both from the local build and from `npx -y @obscurify/mcp`), and the SDK client in `scripts/e2e.mjs` over stdio and Streamable HTTP. opencode 2.1 connects and lists the tools.

## Development

```sh
npm install
npm run build
OBSCURIFY_API_KEY=sk-obs1_... node scripts/e2e.mjs stdio --image   # live end-to-end test, costs well under a cent
OBSCURIFY_API_KEY=sk-obs1_... node scripts/e2e.mjs http
npx @modelcontextprotocol/inspector node dist/index.js
```

Releases: bump the version in `package.json` and `server.json`, then push a `vX.Y.Z` tag. The workflow publishes to npm with provenance and to the [MCP Registry](https://registry.modelcontextprotocol.io).

## Links

- Website: [obscurify.ai](https://obscurify.ai/?utm_source=mcp)
- API docs: [obscurify.ai/api-docs](https://obscurify.ai/api-docs?utm_source=mcp)
- Contact: contact@obscurify.ai

## License

MIT
