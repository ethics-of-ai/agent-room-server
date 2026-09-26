const llmModule = process.env.AGENTROOM_PROBE_LLM_MODULE
if (!llmModule) throw new Error('AGENTROOM_PROBE_LLM_MODULE is required')
const { LlmAdapter } = await import(llmModule)

let requestNumber = 0
const toolName = process.env.AGENTROOM_PROBE_TOOL_NAME ?? 'agentroom_probe_echo'
const toolArguments = JSON.parse(process.env.AGENTROOM_PROBE_TOOL_ARGUMENTS ?? '{}')

class AgentRoomProbeAdapter extends LlmAdapter {
  async * stream(options) {
    requestNumber += 1
    if (toolName !== '__history_probe__' && requestNumber % 2 === 1) {
      const names = JSON.parse(process.env.AGENTROOM_PROBE_TOOL_SEQUENCE ?? '[]')
      const currentName = names[Math.floor((requestNumber - 1) / 2)] ?? toolName
      const currentArguments = currentName === toolName ? toolArguments : {}
      const callId = `agentroom-probe-call-${requestNumber}`
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: callId, name: currentName, argumentsDelta: JSON.stringify(currentArguments) }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: callId, name: currentName, arguments: currentArguments },
      }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const history = JSON.stringify(options.messages)
    if (history.includes('Reply with OK.') && ((options.tools?.length ?? 0) !== 0 || options.maxTokens !== 32)) {
      throw new Error('Connection test must have no tools and a bounded token limit')
    }
    const text = toolName === '__history_probe__'
      ? `retained-marker=${history.includes('history-marker-before-restart')}`
      : 'AgentRoom native tool completed'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'agentroom-probe-llm'
export const inject = ['llm']
export function apply(ctx) {
  ctx.llm.registerAdapter(['agentroom-probe'], new AgentRoomProbeAdapter())
}
