// End-to-end check against the live Obscurify.ai API through a real MCP client.
// Usage: OBSCURIFY_API_KEY=sk-obs1_... node scripts/e2e.mjs [stdio|http] [--image]
// Spends well under a cent: short prompts, small max_tokens, one cheap image if --image.
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const mode = process.argv[2] ?? "stdio";
const withImage = process.argv.includes("--image");
const entry = new URL("../dist/index.js", import.meta.url).pathname;
let child;
let failures = 0;

function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
  if (!cond) failures++;
}
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

const client = new Client({ name: "obscurify-e2e", version: "0.0.0" });
if (mode === "http") {
  const port = 38000 + Math.floor(Math.random() * 1000);
  // The server runs without its own key: the client's bearer key must be used.
  const env = { ...process.env, OBSCURIFY_API_KEY: "" };
  child = spawn("node", [entry, "--http", "--port", String(port)], { env, stdio: ["ignore", "inherit", "pipe"] });
  await new Promise((resolve) => child.stderr.on("data", (d) => String(d).includes("listening") && resolve()));
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${process.env.OBSCURIFY_API_KEY}` } },
    }),
  );
} else {
  await client.connect(new StdioClientTransport({ command: "node", args: [entry], env: { ...process.env } }));
}

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
check("tools listed", names.join(",") === "ask,balance,chat,generate_image,list_models,second_opinion", names.join(","));

let r = await client.callTool({ name: "list_models", arguments: { search: "claude", limit: 5 } });
check("list_models", !r.isError && /anthropic\/claude/.test(text(r)), text(r).split("\n")[0]);
r = await client.callTool({ name: "list_models", arguments: { plan: "any", sort: "price", tools_only: true, limit: 3 } });
check("list_models plan/sort", !r.isError && r.structuredContent.models.every((m) => m.plan === "any" && m.tools));

r = await client.callTool({ name: "ask", arguments: { prompt: "Reply with exactly: pong", max_tokens: 20 } });
check("ask", !r.isError && /pong/i.test(text(r)), text(r).replace(/\s+/g, " ").slice(0, 120));

r = await client.callTool({
  name: "ask",
  arguments: { prompt: "What is 17*3? Answer with the number only.", model: "deepseek/deepseek-v4-flash", reasoning_effort: "low", max_tokens: 300 },
});
check("ask reasoning_effort", !r.isError && /51/.test(text(r)), text(r).replace(/\s+/g, " ").slice(0, 120));

r = await client.callTool({
  name: "chat",
  arguments: {
    messages: [
      { role: "system", content: "Answer in one word." },
      { role: "user", content: "My cat is called Mochi. Remember it." },
      { role: "assistant", content: "Okay." },
      { role: "user", content: "What is my cat called?" },
    ],
    max_tokens: 20,
  },
});
check("chat", !r.isError && /mochi/i.test(text(r)), text(r).replace(/\s+/g, " ").slice(0, 120));

r = await client.callTool({
  name: "second_opinion",
  arguments: { prompt: "Is 91 a prime number? Answer yes or no and one short reason.", max_tokens: 400 },
});
check("second_opinion", !r.isError && /3\/3 models answered/.test(text(r)), text(r).split("\n").pop());

r = await client.callTool({ name: "ask", arguments: { prompt: "hi", model: "no-such/model", max_tokens: 5 } });
check("bad model is a tool error", r.isError === true, text(r).slice(0, 120));

r = await client.callTool({ name: "balance", arguments: {} });
check("balance", !r.isError && /Balance: \$/.test(text(r)), text(r).split("\n").slice(0, 2).join(" | "));

r = await client.callTool({ name: "generate_image", arguments: { list: true } });
check("generate_image list", !r.isError && /realvis-xl-v4/.test(text(r)));
if (withImage) {
  r = await client.callTool({
    name: "generate_image",
    arguments: { prompt: "a small purple robot, studio photo", width: 512, height: 512 },
  });
  const img = r.content.find((c) => c.type === "image");
  check("generate_image", !r.isError && img && img.data.length > 1000, img ? `${img.mimeType}, ${img.data.length} b64 chars` : text(r));
}

await client.close();
child?.kill();
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
