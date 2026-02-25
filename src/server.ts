import { Hono } from "hono"
import { cors } from "hono/cors"
import { serve } from "@hono/node-server"
import { query } from "@anthropic-ai/claude-agent-sdk"
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

function formatMessages(messages: any[]): string {
  return messages.map(m => {
    const role = m.role === "assistant" ? "Assistant" : "Human"
    if (typeof m.content === "string") {
      return `${role}: ${m.content}`
    }
    if (Array.isArray(m.content)) {
      const parts = m.content.map((block: any) => {
        if (block.type === "text") return block.text
        if (block.type === "tool_use") {
          return `[Tool Call: ${block.name}(${JSON.stringify(block.input)})]`
        }
        if (block.type === "tool_result") {
          const content = typeof block.content === "string"
            ? block.content
            : block.content?.map((b: any) => b.text).join("") || ""
          return `[Tool Result (${block.tool_use_id}): ${content}]`
        }
        return ""
      }).filter(Boolean)
      return `${role}: ${parts.join("\n")}`
    }
    return `${role}: ${String(m.content)}`
  }).join("\n\n")
}

function buildPrompt(body: any): string {
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

  if (body.tools?.length) {
    const toolDefs = body.tools.map((t: any) =>
      `- ${t.name}: ${t.description} (params: ${JSON.stringify(t.input_schema?.properties || {})})`
    ).join("\n")
    systemContext += `\n\nAvailable tools:\n${toolDefs}`
  }

  const conversation = body.messages?.length ? formatMessages(body.messages) : ""

  return systemContext ? `${systemContext}\n\n${conversation}` : conversation
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
      const prompt = buildPrompt(body)

      log("request", { model, stream, messages: body.messages?.length })

      const baseOptions = {
        maxTurns: 100,
        model,
        pathToClaudeCodeExecutable: claudeExecutable,
      }

      if (!stream) {
        let text = ""
        for await (const msg of query({ prompt, options: baseOptions })) {
          if (msg.type === "assistant") {
            for (const block of msg.message.content) {
              if (block.type === "text") text += block.text
            }
          }
        }

        return c.json({
          id: `msg_${Date.now()}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: text || "Could you provide more details?" }],
          model: body.model || "claude-sonnet-4-6",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        })
      }

      // Streaming
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

            try {
              for await (const msg of response) {
                if (msg.type !== "stream_event") continue
                const event = msg.event
                const eventType = event.type

                if (eventType === "message_delta") {
                  const patched = {
                    ...event,
                    delta: { ...((event as any).delta || {}), stop_reason: "end_turn" },
                    usage: (event as any).usage || { output_tokens: 0 },
                  }
                  controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(patched)}\n\n`))
                  continue
                }

                controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`))
              }
            } finally {
              clearInterval(heartbeat)
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
