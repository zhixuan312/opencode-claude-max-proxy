# openclaw-claude-max-proxy

Use your **Claude Max subscription** with [OpenClaw](https://github.com/openclaw) (Telegram bot) — or any client that speaks the Anthropic Messages API.

Forked from [rynfar/opencode-claude-max-proxy](https://github.com/rynfar/opencode-claude-max-proxy) and rewritten for OpenClaw's tool-calling workflow.

## Why This Exists

Anthropic doesn't let Claude Max subscribers use their subscription through the standard API. The only programmatic access is through the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)'s `query()` function, which spawns a Claude Code CLI process under the hood.

This proxy translates Anthropic Messages API requests into SDK `query()` calls, so any client (OpenClaw, OpenCode, etc.) can use your Max subscription at zero additional cost.

## What Changed From the Original Fork

The original proxy (rynfar v1.0.2) was a proof-of-concept that worked for basic text chat but broke down with tool-calling clients like OpenClaw. This fork is a complete rewrite of the proxy logic.

### Architecture Change

```
ORIGINAL (v1.0.2):
  Client → proxy → query(maxTurns:100, bypassPermissions)
                     ↓
             SDK runs internal 100-turn agent loop
             tool_use blocks FILTERED OUT (never reach client)
             stop_reason HARDCODED "end_turn"
             usage HARDCODED { input_tokens: 0, output_tokens: 0 }
             system prompt CRAMMED into user message
                     ↓
             Only text blocks returned to client

THIS FORK:
  Client → proxy → query(maxTurns:1, tools:[], mcpServers:{bridge})
                     ↓
             SDK makes ONE API call
             ALL content blocks forwarded (text, tool_use, thinking)
             Real stop_reason ("end_turn" or "tool_use")
             Real token usage from SDK
                     ↓
  Client receives tool_use → executes tools → sends new request → repeat
```

### Detailed Delta

| Area | Original (rynfar v1.0.2) | This Fork |
|------|--------------------------|-----------|
| **Runtime** | Bun | Node.js + tsx |
| **SDK version** | `^0.2.0` | `^0.2.62` |
| **Dependencies** | hono | hono, @hono/node-server, zod 4 |
| **File structure** | `src/proxy/server.ts`, `src/proxy/types.ts`, `src/logger.ts` | Single `src/server.ts` |
| **Tool support** | None. Tools ignored. | MCP bridge — client tools registered as in-process MCP server via `createSdkMcpServer()` |
| **tool_use blocks** | Filtered out, never forwarded | Forwarded with MCP prefix stripped (`mcp__proxy-tools__` → plain name) |
| **stop_reason** | Always hardcoded `"end_turn"` | Real value from SDK (`"end_turn"` or `"tool_use"`) |
| **Token usage** | Hardcoded `{ input_tokens: 0, output_tokens: 0 }` | Real usage extracted from SDK result message |
| **System prompt** | Crammed into user message alongside history | Passed via SDK `systemPrompt` option (separate from prompt) |
| **Conversation history** | Flattened into same string as system prompt | Wrapped in `<conversation_history>` tags in prompt, separated from system |
| **Thinking/reasoning** | Not supported | Passthrough — `thinking` config forwarded, thinking blocks included in response |
| **maxTurns** | `100` (SDK runs its own agent loop) | `1` (single API round-trip, client controls the loop) |
| **Permissions** | None set (SDK default) | `tools: []` disables built-in tools, `canUseTool` deny-all prevents execution |
| **Session persistence** | SDK default (may persist) | `persistSession: false` (stateless, matches client's history-in-every-request pattern) |
| **Streaming** | Manually constructs SSE envelope, emits one text block from final result | Forwards raw SDK stream events directly, only patches missing lifecycle events |
| **Image blocks** | Silently dropped | Logged warning + placeholder text |
| **Error handling** | Basic | Graceful MCP fallback — if tool server creation fails, falls back to text-only mode |

## How It Works

```
OpenClaw sends request with tools: [web_search, browse, ...]
                    ↓
Proxy creates in-process MCP server from tool definitions
  (each tool gets a permissive zod schema + stub handler)
                    ↓
Proxy calls SDK query() with:
  - prompt: conversation history + last message
  - systemPrompt: extracted system instructions
  - tools: [] (no built-in Claude Code tools)
  - mcpServers: { "proxy-tools": <MCP server> }
  - maxTurns: 1 (single API round-trip)
  - canUseTool: deny-all (prevent any tool execution)
  - thinking: passthrough from client config
                    ↓
SDK streams response events to proxy
  - Proxy strips MCP prefix from tool names
  - Forwards all content blocks (text, tool_use, thinking)
  - Emits real stop_reason and token usage
                    ↓
Client receives tool_use blocks
  → executes tools itself
  → sends new request with tool_result
  → cycle repeats until done
```

The proxy never executes tools. Three layers prevent it:
1. `tools: []` — no built-in Claude Code tools registered
2. `canUseTool` callback — returns deny for any tool call
3. `maxTurns: 1` — SDK won't loop back even if a tool somehow ran

## Prerequisites

1. **Claude Max subscription** — [Subscribe here](https://claude.ai/settings/subscription)

2. **Claude CLI** installed and authenticated:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude login
   ```

3. **Node.js** >= 18

## Installation

```bash
git clone https://github.com/zhixuan312/opencode-claude-max-proxy
cd opencode-claude-max-proxy
npm install
```

## Usage

### Start the Proxy

```bash
npm start
```

The proxy prints its config on startup. Default: `http://127.0.0.1:3456`.

### Configure OpenClaw

Add to `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "providers": {
      "claude-proxy": {
        "baseUrl": "http://127.0.0.1:3456",
        "apiKey": "dummy",
        "api": "anthropic-messages",
        "models": [
          { "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6" },
          { "id": "claude-opus-4-6", "name": "Claude Opus 4.6" },
          { "id": "claude-haiku-4-5", "name": "Claude Haiku 4.5" }
        ]
      }
    }
  }
}
```

### Use With Other Clients

Any client that speaks the Anthropic Messages API works:

```bash
ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:3456 <your-client>
```

### Debug Mode

```bash
CLAUDE_PROXY_DEBUG=1 npm start
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CLAUDE_PROXY_PORT` | `3456` | Proxy server port |
| `CLAUDE_PROXY_HOST` | `127.0.0.1` | Proxy server host |
| `CLAUDE_PROXY_DEBUG` | `0` | Enable debug logging |

## Known Limitations

These are SDK architectural ceilings — not fixable without bypassing the SDK (which isn't possible with Max subscriptions):

| Limitation | Reason |
|-----------|--------|
| **No prompt caching** | SDK doesn't expose `cache_control` |
| **No vision/images** | SDK `prompt` is a string, can't pass image content blocks |
| **History flattened to text** | Conversation history serialized as `[Tool Call: ...]` / `[Tool Result: ...]` text, not structured API messages |
| **No full Anthropic API parity** | Always going through the SDK translation layer |

## FAQ

### Why not use the Anthropic API directly?

Claude Max subscription tokens only work through the Claude Agent SDK's `query()` function. There's no way to use them with the standard Anthropic API.

### Why `ANTHROPIC_API_KEY=dummy`?

Most clients require an API key to be set. The proxy never uses it — the SDK authenticates through your Claude CLI login. Any non-empty string works.

### Why fork instead of contributing upstream?

The original was designed for OpenCode (a coding IDE). This fork is rewritten for OpenClaw (a Telegram bot) with fundamentally different requirements: tool-calling passthrough, real token usage, thinking support. The architecture changed completely.

### What about rate limits?

Your Claude Max subscription has its own usage limits. The proxy doesn't add any.

### Is my data sent anywhere else?

No. The proxy runs on your machine. Requests go directly to Claude through the official SDK.

## License

MIT

## Credits

- Original proxy by [rynfar](https://github.com/rynfar/opencode-claude-max-proxy)
- Built with the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) by Anthropic
