import { Hono } from "hono"
import { cors } from "hono/cors"
import { serve } from "@hono/node-server"
import { query, createSdkMcpServer, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod/v4"
import type { Context } from "hono"
import { execSync } from "child_process"
import { existsSync } from "fs"
import { createRequire } from "module"
import { join, dirname } from "path"

// --- Config ---

interface ProxyConfig {
  port: number
  host: string
}

const DEFAULT_CONFIG: ProxyConfig = {
  port: 3456,
  host: "127.0.0.1",
}

// --- Logging ---

const debug = process.env["CLAUDE_PROXY_DEBUG"] === "1"

function log(message: string, extra?: Record<string, unknown>) {
  if (!debug) return
  const parts = ["[claude-proxy]", message]
  if (extra && Object.keys(extra).length > 0) {
    parts.push(JSON.stringify(extra))
  }
  console.debug(parts.join(" "))
}

// --- Claude executable resolution ---

function resolveClaudeExecutable(): string {
  try {
    const require = createRequire(import.meta.url)
    const sdkPath = require.resolve("@anthropic-ai/claude-agent-sdk")
    const cliJs = join(dirname(sdkPath), "cli.js")
    if (existsSync(cliJs)) return cliJs
  } catch {}

  try {
    const claudePath = execSync("which claude", { encoding: "utf-8" }).trim()
    if (claudePath && existsSync(claudePath)) return claudePath
  } catch {}

  throw new Error("Could not find Claude Code executable. Install via: npm install -g @anthropic-ai/claude-code")
}

const claudeExecutable = resolveClaudeExecutable()

// --- Helpers ---

function mapModel(model: string): "sonnet" | "opus" | "haiku" {
  if (model.includes("opus")) return "opus"
  if (model.includes("haiku")) return "haiku"
  return "sonnet"
}

// Truncate long tool results to prevent Claude from echoing raw data
const MAX_TOOL_RESULT_LENGTH = 1500

function truncateToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_LENGTH) return content
  return content.slice(0, MAX_TOOL_RESULT_LENGTH) + "\n... [truncated]"
}

function formatMessages(messages: any[]): string {
  return messages.map(m => {
    const role = m.role === "assistant" ? "Assistant" : "Human"
    if (typeof m.content === "string") {
      return `${role}: ${m.content}`
    }
    if (Array.isArray(m.content)) {
      const textParts: string[] = []
      const toolParts: string[] = []

      for (const block of m.content) {
        if (block.type === "text") {
          textParts.push(block.text)
        } else if (block.type === "tool_use") {
          toolParts.push(`<tool_use name="${block.name}" id="${block.id}">\n${JSON.stringify(block.input)}\n</tool_use>`)
        } else if (block.type === "tool_result") {
          const raw = typeof block.content === "string"
            ? block.content
            : block.content?.map((b: any) => b.text).join("") || ""
          toolParts.push(`<tool_result id="${block.tool_use_id}">\n${truncateToolResult(raw)}\n</tool_result>`)
        } else if (block.type === "image") {
          log("warn: image block dropped (not supported through SDK string prompt)")
        } else if (block.type === "thinking") {
          // skip thinking from history
        }
      }

      const parts: string[] = []
      if (textParts.length) parts.push(textParts.join("\n"))
      if (toolParts.length) parts.push(`<internal_tool_interactions>\n${toolParts.join("\n")}\n</internal_tool_interactions>`)

      return parts.length ? `${role}: ${parts.join("\n")}` : ""
    }
    return `${role}: ${String(m.content)}`
  }).filter(Boolean).join("\n\n")
}

// Extract token usage from SDK result — handles both camelCase (SDK) and snake_case (API)
function normalizeUsage(usage: any): { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } {
  if (!usage) return { input_tokens: 0, output_tokens: 0 }
  return {
    input_tokens: usage.input_tokens ?? usage.inputTokens ?? 0,
    output_tokens: usage.output_tokens ?? usage.outputTokens ?? 0,
    ...(usage.cache_creation_input_tokens || usage.cacheCreationInputTokens
      ? { cache_creation_input_tokens: usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0 }
      : {}),
    ...(usage.cache_read_input_tokens || usage.cacheReadInputTokens
      ? { cache_read_input_tokens: usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? 0 }
      : {}),
  }
}

// SDK namespaces MCP tools as "mcp__<server>__<tool>". We need to strip this
// prefix so OpenClaw receives plain tool names it recognizes.
const MCP_SERVER_NAME = "proxy-tools"
const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`

function stripMcpPrefix(name: string): string {
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name
}

// Create MCP tool server from client's tool definitions
function createToolServer(tools: any[]): ReturnType<typeof createSdkMcpServer> | null {
  if (!tools?.length) return null

  try {
    const mcpTools = tools.map((t: any) => {
      const properties = t.input_schema?.properties || {}
      const zodShape: Record<string, z.ZodType> = {}
      for (const key of Object.keys(properties)) {
        zodShape[key] = z.any()
      }

      return sdkTool(
        t.name,
        t.description || t.name,
        zodShape,
        async () => ({
          content: [{ type: "text" as const, text: "Tool execution denied by proxy" }],
        })
      )
    })

    return createSdkMcpServer({ name: MCP_SERVER_NAME, tools: mcpTools })
  } catch (error) {
    log("warn: MCP tool server creation failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

// Extract system prompt from request body — passed separately via SDK systemPrompt option
function extractSystemPrompt(body: any, includeTools = true): string {
  let systemContext = ""
  if (body.system) {
    if (typeof body.system === "string") {
      systemContext = body.system
    } else if (Array.isArray(body.system)) {
      systemContext = body.system
        .filter((b: any) => b.type === "text" && b.text)
        .map((b: any) => b.text)
        .join("\n")
    }
  }

  // Only include tools as text if MCP bridge is not available (fallback mode)
  if (includeTools && body.tools?.length) {
    const toolDefs = body.tools.map((t: any) =>
      `- ${t.name}: ${t.description} (params: ${JSON.stringify(t.input_schema?.properties || {})})`
    ).join("\n")
    systemContext += `\n\nAvailable tools:\n${toolDefs}`
  }

  // Instruct Claude to never echo internal tool data in its response
  systemContext += `\n\nIMPORTANT: The conversation history may contain <internal_tool_interactions>, <tool_use>, and <tool_result> XML tags. These are internal metadata. NEVER reproduce, quote, or reference the raw content of these tags in your response. Only use the information within them to inform your answer. Your response should contain only the final answer text and tool_use blocks — never raw tool result data.`

  return systemContext
}

// Build the user prompt — history as context, last message as the actual prompt
function buildPrompt(body: any): string {
  const messages: any[] = body.messages || []
  const history = messages.slice(0, -1)
  const lastMessage = messages[messages.length - 1]

  const parts: string[] = []

  if (history.length > 0) {
    const historyText = formatMessages(history)
    parts.push(`<conversation_history>\n${historyText}\n</conversation_history>`)
  }

  // Extract the last message text as the actual prompt
  if (lastMessage) {
    if (typeof lastMessage.content === "string") {
      parts.push(lastMessage.content)
    } else if (Array.isArray(lastMessage.content)) {
      const textParts: string[] = []
      const toolParts: string[] = []

      for (const block of lastMessage.content) {
        if (block.type === "text") {
          textParts.push(block.text)
        } else if (block.type === "tool_result") {
          const raw = typeof block.content === "string"
            ? block.content
            : block.content?.map((b: any) => b.text).join("") || ""
          toolParts.push(`<tool_result id="${block.tool_use_id}">\n${truncateToolResult(raw)}\n</tool_result>`)
        } else if (block.type === "image") {
          log("warn: image block in prompt dropped")
        }
      }

      if (textParts.length) parts.push(textParts.join("\n"))
      if (toolParts.length) parts.push(`<internal_tool_interactions>\n${toolParts.join("\n")}\n</internal_tool_interactions>`)
    } else {
      parts.push(String(lastMessage.content))
    }
  }

  return parts.join("\n\n")
}

// --- Server ---

export function createProxyServer(config: Partial<ProxyConfig> = {}) {
  const finalConfig = { ...DEFAULT_CONFIG, ...config }
  const app = new Hono()

  app.use("*", cors())

  app.get("/", (c) => c.json({
    status: "ok",
    service: "openclaw-claude-proxy",
    endpoints: ["/v1/messages", "/messages"],
  }))

  const handleMessages = async (c: Context) => {
    try {
      const body = await c.req.json()
      const model = mapModel(body.model || "sonnet")
      const stream = body.stream ?? true
      const toolServer = createToolServer(body.tools)
      const systemPrompt = extractSystemPrompt(body, /* includeTools */ !toolServer)
      const prompt = buildPrompt(body)

      log("request", { model, stream, messages: body.messages?.length, hasMcpTools: !!toolServer })

      const baseOptions: Record<string, any> = {
        maxTurns: 1,
        model,
        pathToClaudeCodeExecutable: claudeExecutable,
        tools: [],
        canUseTool: async () => ({
          behavior: "deny" as const,
          message: "Tool execution denied by proxy",
        }),
        persistSession: false,
      }

      // Pass system prompt via SDK option instead of cramming into prompt
      if (systemPrompt) {
        baseOptions.systemPrompt = systemPrompt
      }

      // Register client tools as MCP server
      if (toolServer) {
        baseOptions.mcpServers = { "proxy-tools": toolServer }
      }

      // Pass through thinking/reasoning config if client requests it
      if (body.thinking) {
        if (body.thinking.type === "enabled" && body.thinking.budget_tokens) {
          baseOptions.thinking = { type: "enabled", budgetTokens: body.thinking.budget_tokens }
        } else {
          baseOptions.thinking = body.thinking
        }
      }

      if (!stream) {
        const content: any[] = []
        let resultUsage: any = null
        let stopReason = "end_turn"

        for await (const msg of query({ prompt, options: baseOptions })) {
          if (msg.type === "assistant") {
            for (const block of msg.message.content) {
              if (block.type === "text") {
                content.push({ type: "text", text: block.text })
              } else if (block.type === "tool_use") {
                content.push({
                  type: "tool_use",
                  id: (block as any).id,
                  name: stripMcpPrefix((block as any).name),
                  input: (block as any).input,
                })
              } else if ((block as any).type === "thinking") {
                content.push({
                  type: "thinking",
                  thinking: (block as any).thinking,
                })
              }
            }
            if ((msg.message as any).stop_reason) {
              stopReason = (msg.message as any).stop_reason
            }
          }
          if (msg.type === "result") {
            resultUsage = (msg as any).usage
            if ((msg as any).stop_reason) {
              stopReason = (msg as any).stop_reason
            }
          }
        }

        if (content.length === 0) {
          content.push({ type: "text", text: "Could you provide more details?" })
        }

        return c.json({
          id: `msg_${Date.now()}`,
          type: "message",
          role: "assistant",
          content,
          model: body.model || "claude-sonnet-4-6",
          stop_reason: stopReason,
          stop_sequence: null,
          usage: normalizeUsage(resultUsage),
        })
      }

      // Streaming — with maxTurns: 1, there is exactly one message lifecycle.
      // Forward all SDK stream events directly to the client.
      const encoder = new TextEncoder()
      const readable = new ReadableStream({
        async start(controller) {
          try {
            const response = query({
              prompt,
              options: { ...baseOptions, includePartialMessages: true },
            })

            const heartbeat = setInterval(() => {
              try { controller.enqueue(encoder.encode(`: ping\n\n`)) }
              catch { clearInterval(heartbeat) }
            }, 15_000)

            let resultUsage: any = null
            let sawMessageDelta = false
            let sawMessageStop = false
            let lastStopReason: string | null = null

            const emit = (type: string, data: any) => {
              controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`))
            }

            try {
              for await (const msg of response) {
                if (msg.type === "result") {
                  resultUsage = (msg as any).usage
                  continue
                }

                if (msg.type !== "stream_event") continue
                const event = msg.event
                const eventType = event.type

                if (eventType === "message_delta") {
                  sawMessageDelta = true
                  lastStopReason = (event as any).delta?.stop_reason || null
                }
                if (eventType === "message_stop") {
                  sawMessageStop = true
                }

                // Strip MCP prefix from tool_use names so client sees plain names
                if (eventType === "content_block_start" && (event as any).content_block?.type === "tool_use") {
                  const patched = {
                    ...event,
                    content_block: {
                      ...(event as any).content_block,
                      name: stripMcpPrefix((event as any).content_block.name),
                    },
                  }
                  emit(eventType, patched)
                  continue
                }

                // Forward all other events as-is
                emit(eventType, event)
              }
            } finally {
              clearInterval(heartbeat)
            }

            // Emit missing lifecycle events if SDK suppressed them
            if (!sawMessageDelta) {
              const usage = normalizeUsage(resultUsage)
              emit("message_delta", {
                type: "message_delta",
                delta: { stop_reason: lastStopReason || "end_turn" },
                usage,
              })
            }
            if (!sawMessageStop) {
              emit("message_stop", { type: "message_stop" })
            }

            controller.close()
          } catch (error) {
            log("stream.error", { error: error instanceof Error ? error.message : String(error) })
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({
              type: "error",
              error: { type: "api_error", message: error instanceof Error ? error.message : "Unknown error" },
            })}\n\n`))
            controller.close()
          }
        },
      })

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      })
    } catch (error) {
      log("error", { error: error instanceof Error ? error.message : String(error) })
      return c.json({
        type: "error",
        error: { type: "api_error", message: error instanceof Error ? error.message : "Unknown error" },
      }, 500)
    }
  }

  app.post("/v1/messages", handleMessages)
  app.post("/messages", handleMessages)

  return { app, config: finalConfig }
}

export async function startProxyServer(config: Partial<ProxyConfig> = {}) {
  const { app, config: finalConfig } = createProxyServer(config)

  const server = serve({
    fetch: app.fetch,
    port: finalConfig.port,
    hostname: finalConfig.host,
  })

  console.log(`Claude Max Proxy running at http://${finalConfig.host}:${finalConfig.port}`)
  console.log(`\nOpenClaw config (~/.openclaw/openclaw.json):`)
  console.log(JSON.stringify({
    models: { providers: { "claude-proxy": {
      baseUrl: `http://${finalConfig.host}:${finalConfig.port}`,
      apiKey: "dummy",
      api: "anthropic-messages",
      models: [
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
        { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
        { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
      ],
    }}},
  }, null, 2))

  return server
}
