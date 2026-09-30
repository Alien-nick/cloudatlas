import Anthropic from '@anthropic-ai/sdk'
import type { CloudProvider } from '@cloudatlas/shared'
import { TOOLS, TOOL_BY_NAME, type ToolContext } from './tools.js'

/**
 * The troubleshooting agent.
 *
 * It answers questions about *this* account by calling the same provider the UI
 * calls — see tools.ts for why that boundary is the security story. What is
 * left here is the loop: send the conversation, run whatever tools the model
 * asks for, send the results back, repeat until it stops asking.
 *
 * The system prompt is deliberately strict about evidence. A model that guesses
 * plausibly about infrastructure is worse than no model at all, because the
 * guess is indistinguishable from a reading and someone will act on it.
 */

const SYSTEM_PROMPT = `You are the troubleshooting assistant inside CloudAtlas, a local tool that renders a live diagram of one AWS account.

You have read-only tools over the account that has been scanned. Use them.

Rules that matter more than being helpful:

- Never state a fact about this account that a tool did not return. If you have not checked, say you have not checked, then check.
- Distinguish "the metric shows nothing" from "the metric was not collected". The tools report an unavailableReason when a metric or log group could not be read; pass that distinction on rather than reporting an empty result as a healthy one.
- When a tool reports missingPermissions, say so. An incomplete answer that is labelled incomplete is useful; one that is not is misleading.
- Correlation is not causation. If an incident follows a deploy, say the timing lines up and name both — do not assert the deploy caused it unless the evidence shows the mechanism.
- Prefer naming the specific resource, metric and number you are reasoning from, so the user can check you.
- Never call an account or VPC "compliant". get_compliance measures configuration evidence toward HIPAA, SOC 2 and PCI DSS controls; name the gaps, and say which controls it could not assess.
- get_costs reports two different numbers: actual spend (billed, from Cost Explorer) and an estimated run-rate (list prices). Never present an estimate as the bill, and say when actual spend is disabled.
- When get_compliance returns fix commands, you may quote them for the user to run. Say they must review and run them themselves, repeat any caution, and point out <placeholders> they have to fill in.

You cannot change anything. Every tool is read-only. If the user asks you to fix something, explain what you would change and let them do it.

Be concise. Lead with the answer, then the evidence.`

export interface AgentOptions {
  apiKey: string
  model: string
  provider: CloudProvider
  selectedNodeId: string | null
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  signal?: AbortSignal
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; name: string; ok: boolean; summary: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

/** Tool-use rounds before we stop. Generous, but not unbounded. */
const MAX_ROUNDS = 12

/** A one-line description of a tool result, for the transcript in the UI. */
function summarize(result: unknown): string {
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>
    if (typeof record.error === 'string') return record.error
    if (typeof record.total === 'number') return `${record.total} result(s)`
    if (Array.isArray(record.series)) return `${record.series.length} metric series`
    if (typeof record.matches === 'number') return `${record.matches} matching log lines`
    if (record.resource) return 'resource details'
  }
  return 'ok'
}

export async function* runAgent(options: AgentOptions): AsyncIterable<AgentEvent> {
  const { apiKey, model, provider, selectedNodeId, signal } = options
  const client = new Anthropic({ apiKey })
  const context: ToolContext = { provider, selectedNodeId }

  const messages: Anthropic.MessageParam[] = options.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }))

  const tools: Anthropic.Tool[] = TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema as Anthropic.Tool['input_schema'],
  }))

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (signal?.aborted) return

      const response = await client.messages.create(
        {
          model,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages,
          tools,
        },
        signal ? { signal } : {},
      )

      const toolUses: Anthropic.ToolUseBlock[] = []
      for (const block of response.content) {
        if (block.type === 'text') yield { type: 'text', text: block.text }
        else if (block.type === 'tool_use') toolUses.push(block)
      }

      if (toolUses.length === 0) {
        yield { type: 'done' }
        return
      }

      messages.push({ role: 'assistant', content: response.content })

      const results: Anthropic.ToolResultBlockParam[] = []
      for (const use of toolUses) {
        const input = (use.input ?? {}) as Record<string, unknown>
        yield { type: 'tool', name: use.name, input }

        const tool = TOOL_BY_NAME.get(use.name)
        if (!tool) {
          // Only possible if the model invents a name; reported rather than
          // silently skipped, so the transcript stays honest.
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: `No such tool: ${use.name}`,
            is_error: true,
          })
          yield { type: 'tool_result', name: use.name, ok: false, summary: 'no such tool' }
          continue
        }

        try {
          const result = await tool.run(input, context)
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: JSON.stringify(result),
          })
          yield { type: 'tool_result', name: use.name, ok: true, summary: summarize(result) }
        } catch (error) {
          // A failing tool is given back to the model as an error rather than
          // ending the turn: it can often route around one.
          const message = error instanceof Error ? error.message : String(error)
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: message,
            is_error: true,
          })
          yield { type: 'tool_result', name: use.name, ok: false, summary: message }
        }
      }

      messages.push({ role: 'user', content: results })
    }

    yield {
      type: 'error',
      message: `Stopped after ${MAX_ROUNDS} rounds of tool use without reaching an answer.`,
    }
  } catch (error) {
    if (signal?.aborted) return
    yield { type: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}
