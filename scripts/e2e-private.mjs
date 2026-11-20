// End to end for private mode (OBSCURIFY_PRIVATE=1): questions go through the local
// unlinkable-inference proxy, paid from a voucher wallet, and a model that needs a plan works
// because the proxy shows the server a pass for it (frontier, uncensored), never the account.
//
//   OBSCURIFY_API_KEY=sk-obs1_... (an account on Pro) [OBSCURIFY_PAYG_KEY=sk-obs1_... (no plan)]
//   [OBSCURIFY_BASE_URL=http://127.0.0.1:8230/v1] [UNLINKABLE_BIN=/path/to/unlinkable-inference]
//   node scripts/e2e-private.mjs
// Needs unlinkable-inference-cli 0.2 or newer. Spends about a cent.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = new URL("../dist/index.js", import.meta.url).pathname;
const OPEN = process.env.OPEN_MODEL || "deepseek/deepseek-v4.1-flash";
const FRONTIER = process.env.FRONTIER_MODEL || "anthropic/claude-haiku-5.5";
const UNCENSORED = process.env.UNCENSORED_MODEL || "deepseek/deepseek-v4.1-flash-uncensored";
let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
  if (!cond) failures++;
};
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const short = (r) => text(r).replace(/\s+/g, " ").slice(0, 110);

// One MCP server in private mode with its own proxy and wallet; `run` gets `ask(model)`.
async function withServer(key, port, run) {
  const dir = mkdtempSync(join(tmpdir(), "obscurify-mcp-private-"));
  const url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, OBSCURIFY_API_KEY: key, OBSCURIFY_PRIVATE: "1", OBSCURIFY_PRIVATE_URL: url, UNLINKABLE_WALLET: join(dir, "wallet.json") };
  const client = new Client({ name: "obscurify-e2e-private", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: "node", args: [entry], env }));
  try {
    await run((model, word) => client.callTool({ name: "ask", arguments: { model, prompt: `Reply with exactly: ${word}`, max_tokens: 20 } }), url);
  } finally {
    await client.close();
    // The proxy outlives the MCP server: close its sessions for their change and stop it.
    await fetch(`${url}/_unlinkable/close`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {});
    try { execFileSync("pkill", ["-INT", "-f", `serve --listen 127.0.0.1:${port}`]); } catch {}
    await new Promise((r) => setTimeout(r, 1500));
    rmSync(dir, { recursive: true, force: true });
  }
}

const port = 38900 + Math.floor(Math.random() * 90);
await withServer(process.env.OBSCURIFY_API_KEY, port, async (ask, url) => {
  let r = await ask(OPEN, "pong");
  check("private: an open model answers", !r.isError && /pong/i.test(text(r)), short(r));
  let st = await (await fetch(`${url}/_unlinkable/status`)).json();
  check("private: the proxy pays from a wallet it filled itself", st.wallet.paid_cents > 0 && st.sessions.length === 1, `${st.wallet.paid_cents} cents, ${st.sessions.length} session`);
  const stocked = st.wallet.pass_labels || {};
  check("private: the wallet holds a pass of each label the plan gives", stocked.frontier > 0 && stocked.uncensored > 0 && stocked.free > 0, JSON.stringify(stocked));
  r = await ask(FRONTIER, "ping");
  check("private: a frontier model answers", !r.isError && /ping/i.test(text(r)), short(r));
  r = await ask(UNCENSORED, "pang");
  check("private: an uncensored model answers", !r.isError && /pang/i.test(text(r)), short(r));
  st = await (await fetch(`${url}/_unlinkable/status`)).json();
  const left = st.wallet.pass_labels || {};
  check("private: each took one pass of its own label, the open model none", left.frontier === stocked.frontier - 1 && left.uncensored === stocked.uncensored - 1 && left.free === stocked.free, JSON.stringify(left));
  const chats = st.traffic.filter((t) => /\/v1\/chat\/completions/.test(t.server_sees));
  check("private: the account key never went with a chat", chats.length >= 3 && chats.every((t) => !t.server_sees.includes("sk-obs1_")), `${chats.length} chat requests seen`);
});

if (process.env.OBSCURIFY_PAYG_KEY) {
  await withServer(process.env.OBSCURIFY_PAYG_KEY, port + 1, async (ask) => {
    let r = await ask(OPEN, "pong");
    check("private, no plan: an open model answers", !r.isError && /pong/i.test(text(r)), short(r));
    r = await ask(FRONTIER, "ping");
    check("private, no plan: a frontier model is refused with the reason", r.isError === true && /plan/i.test(text(r)), short(r));
  });
}
console.log(failures ? `${failures} FAILED` : "all private checks passed");
process.exit(failures ? 1 : 0);
