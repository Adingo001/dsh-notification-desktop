// Host-side fold test: exercises the pure `reduce` in index.js.
//   $env:ELECTRON_RUN_AS_NODE = 1; & "D:\ai\DeepSeek Harness.exe" .\tests\host-fold.mjs
import { reduce, name, inject } from '../index.js'

const assert = (cond, msg) => {
  if (cond) console.log('ok   ' + msg)
  else {
    console.error('FAIL ' + msg)
    process.exitCode = 1
  }
}

let state = { open: null, last: null }

state = reduce(state, { type: 'turn/start', data: { turn: 1 } })
assert(state.open !== null && state.open.turn === 1, 'turn/start opens the turn')

state = reduce(state, {
  type: 'assistant/message',
  data: { turn: 1, message: { content: [{ type: 'text', text: 'hello ' }, { type: 'tool-call' }] } },
})
state = reduce(state, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'world' }] } } })
assert(state.open.text === 'hello world', 'assistant text accumulates across messages')

state = reduce(state, { type: 'tool/call', data: { turn: 1, name: 'bash' } })
state = reduce(state, { type: 'tool/call', data: { turn: 1, name: 'bash' } })
state = reduce(state, { type: 'tool/call', data: { turn: 1, name: 'read' } })
assert(state.open.tools.length === 2, 'tool names dedupe in first-seen order')

const before = state
state = reduce(state, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
assert(state.open === null, 'turn/end closes the turn')
assert(state.last.turn === 1 && state.last.reason === 'completed', 'turn/end records turn + reason')
assert(state.last.body === 'hello world', 'turn/end records the reply body')
assert(state.last.tools.join(',') === 'bash,read', 'turn/end carries the tool names')

assert(reduce(before, { type: 'step/start', data: {} }) === before, 'irrelevant events keep the same reference')
assert(reduce(before, { type: 'assistant/message', data: { turn: 9, message: { content: [] } } }) === before, 'other turns are ignored')

const midTurn = reduce({ open: null, last: null }, { type: 'turn/end', data: { turn: 7, reason: { kind: 'forked' } } })
assert(midTurn.last.turn === 7 && midTurn.last.body === '', 'an end without a seen start still advances the turn')

const long = reduce(
  reduce({ open: null, last: null }, { type: 'turn/start', data: { turn: 2 } }),
  { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: 'x'.repeat(900) }] } } },
)
const bounded = reduce(long, { type: 'turn/end', data: { turn: 2, reason: { kind: 'max-tokens' } } })
assert(bounded.last.body.length === 400, `body is bounded to 400 chars (${bounded.last.body.length})`)
assert(bounded.last.body.endsWith('…'), 'bounded body is ellipsized')

assert(name === 'dsh-notification-desktop', 'plugin name export')
assert(inject.length === 1 && inject[0] === 'sessionProjections', 'plugin inject export')

console.log(process.exitCode ? '\nRESULT: FAILED' : '\nRESULT: all host checks passed')
