// Keyless smoke test for CI: the server starts, lists its tools and lists models from the public endpoint.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = new URL("../dist/index.js", import.meta.url).pathname;
const client = new Client({ name: "obscurify-smoke", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: { PATH: process.env.PATH ?? "" } }));
const names = (await client.listTools()).tools.map((t) => t.name).sort().join(",");
if (names !== "ask,balance,chat,generate_image,list_models,second_opinion") throw new Error(`tools: ${names}`);
const models = await client.callTool({ name: "list_models", arguments: { search: "llama", limit: 3 } });
if (models.isError || !models.structuredContent?.models?.length) throw new Error(JSON.stringify(models));
const ask = await client.callTool({ name: "ask", arguments: { prompt: "hi" } });
if (!ask.isError || !/OBSCURIFY_API_KEY/.test(ask.content[0].text)) throw new Error("ask without a key should explain the missing key");
console.log(`ok: ${names}; ${models.structuredContent.total} models`);
await client.close();
