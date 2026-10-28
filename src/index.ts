#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { configFromEnv, VERSION } from "./api.js";
import { createServer } from "./server.js";

const HELP = `obscurify-mcp ${VERSION}: MCP server for Obscurify.ai

Usage:
  obscurify-mcp                 stdio transport (what MCP clients launch)
  obscurify-mcp --http          Streamable HTTP on http://127.0.0.1:3000/mcp

Options:
  --http                 serve Streamable HTTP instead of stdio
  --port <n>             HTTP port (default $PORT or 3000)
  --host <addr>          HTTP bind address (default $HOST or 127.0.0.1)

Environment:
  OBSCURIFY_API_KEY                API key (sk-obs1_...). In HTTP mode a client may
                                   send its own key as "Authorization: Bearer <key>".
  OBSCURIFY_DEFAULT_MODEL          default model for ask/chat (deepseek/deepseek-v4-flash)
  OBSCURIFY_SECOND_OPINION_MODELS  comma-separated default models for second_opinion
  OBSCURIFY_BASE_URL               API base URL (https://obscurify.ai/v1)
  OBSCURIFY_TIMEOUT_MS             per-request timeout (180000)
`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 4 * 1024 * 1024) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

async function serveHttp(): Promise<void> {
  const port = Number(arg("--port") ?? process.env.PORT ?? 3000);
  const host = arg("--host") ?? process.env.HOST ?? "127.0.0.1";
  const base = configFromEnv();

  const http = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") return sendJson(res, 200, { ok: true, version: VERSION });
    if (url.pathname !== "/mcp") return sendJson(res, 404, { error: "Not found. The MCP endpoint is /mcp." });
    if (req.method !== "POST") {
      // Stateless server: no SSE stream to resume and no session to delete.
      return sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
    }
    // A caller's own key (Authorization: Bearer sk-obs1_...) wins over the server's key.
    const auth = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const config = { ...base, apiKey: auth || base.apiKey };
    try {
      const body = await readJson(req);
      const server = createServer(config);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) {
        sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: (e as Error).message }, id: null });
      }
    }
  });
  http.listen(port, host, () => {
    console.error(`obscurify-mcp ${VERSION} listening on http://${host}:${port}/mcp`);
  });
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (process.argv.includes("--http") || process.env.MCP_TRANSPORT === "http") return serveHttp();
  const server = createServer(configFromEnv());
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
