import { describe, expect, it } from 'vitest'

import { toWireMessage } from '../src/harness/provider/strata'
import type { Message } from '../src/harness/types'

/**
 * The one place a conversation is translated into another format, asserted with no
 * model server and no network. A tool round-trip breaks here without anyone
 * noticing: the model asked for a call, and if the assistant half of that exchange
 * is not sent back, the model is being told the result of a request it never made.
 */

describe('the outgoing wire shape', () => {
  it('sends an assistant turn that requested a tool back with tool_calls', () => {
    const message: Message = {
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"notes.txt"}' }],
    }

    expect(toWireMessage(message)).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"notes.txt"}' },
        },
      ],
    })
  })

  it('keeps arguments as the string it was handed, even a cut-off one', () => {
    const message: Message = {
      role: 'assistant',
      content: null,
      toolCalls: [
        { id: 'call_2', name: 'write_file', arguments: '{"path":"out.txt","content":"the firs' },
      ],
    }

    expect(toWireMessage(message)).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_2',
          type: 'function',
          function: { name: 'write_file', arguments: '{"path":"out.txt","content":"the firs' },
        },
      ],
    })
  })

  it('writes no tool_calls key at all for a turn that carried none', () => {
    const wire = toWireMessage({ role: 'assistant', content: 'Two words.' })

    // Object.keys, because toEqual treats an absent key and an undefined one alike.
    expect(Object.keys(wire).sort()).toEqual(['content', 'role'])
  })

  it('sends tool_call_id on a tool result, and no tool name: the wire has no place for it', () => {
    const wire = toWireMessage({
      role: 'tool',
      content: 'the output',
      toolCallId: 'call_1',
      toolName: 'read_file',
    })

    expect(Object.keys(wire).sort()).toEqual(['content', 'role', 'tool_call_id'])
    expect(wire).toEqual({ role: 'tool', content: 'the output', tool_call_id: 'call_1' })
  })
})
