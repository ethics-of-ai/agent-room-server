// A scripted DeepSeek Harness model route for background-work tests.
//
// AGENTROOM_BACKGROUND_LLM_SCRIPT maps a marker to the replies of the
// conversation whose user messages contain it. The Nth request in that
// conversation (counted by assistant messages already in its history) gets
// the Nth reply: {"tool": {"name", "arguments"}} or {"text"}. A parent and
// the subagent it starts carry different markers, so each follows its own
// script however their requests interleave. Past the end, the reply is "done".
const llmModule = process.env.AGENTROOM_PROBE_LLM_MODULE
if (!llmModule) throw new Error('AGENTROOM_PROBE_LLM_MODULE is required')
const { LlmAdapter } = await import(llmModule)

const scripts = JSON.parse(process.env.AGENTROOM_BACKGROUND_LLM_SCRIPT ?? '{}')

class AgentRoomBackgroundAdapter extends LlmAdapter {
  async * stream(options) {
    const messages = options.messages ?? []
    const asked = JSON.stringify(messages.filter((message) => message.role === 'user'))
    const marker = Object.keys(scripts).find((key) => asked.includes(key))
    const index = messages.filter((message) => message.role === 'assistant').length
    const reply = (marker && scripts[marker][index]) || { text: 'done' }
    if (reply.tool) {
      const id = `call-${marker}-${index}`
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: reply.tool.name, argumentsDelta: JSON.stringify(reply.tool.arguments) }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: reply.tool.name, arguments: reply.tool.arguments } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply.text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'agentroom-background-llm'
export const inject = ['llm']
export function apply(ctx) {
  ctx.llm.registerAdapter(['agentroom-background'], new AgentRoomBackgroundAdapter())
}
