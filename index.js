/**
 * dsh-notification-desktop — host half.
 *
 * Registers the `notification` session projection: a bounded summary of each
 * session's last completed turn (turn number, end reason, reply text, tool
 * names). The projection seam delivers the value to the client for every
 * session, so the browser half needs no harness change and no log access.
 *
 * Ported to DeepSeek Harness 0.2.x: `ctx.sessionProjections.register` keeps the
 * same definition shape (key / stateSchema / init / apply / wire / stateVersion)
 * as 0.1.x, so only the wiring is rewritten here.
 *
 * No `zod` dependency: the seam only ever calls `schema.parse(value)` on the
 * state and wire schemas (see `@deepseek-ai/dsh-session-projection`), so this
 * package ships structural validators with the same call shape. That keeps the
 * bundle dependency-free, which matters because a profile links a local
 * checkout without installing its dependencies.
 */

import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where the browser half's reports are mirrored for out-of-band diagnosis. */
const TRACE_FILE = join(tmpdir(), 'dsh-notification-trace.log')

/**
 * The AppUserModelID Windows attributes toasts to. Electron's desktop shell
 * never calls `app.setAppUserModelId`, so Chromium falls back to this value; the
 * tray registration this value needs is created by `scripts/fix-toast-aumid.ps1`.
 */
const AUMID = 'electron.app.DeepSeek Harness'

/** The ASCII-only Windows toast helper this host half spawns. */
const TOAST_SCRIPT = fileURLToPath(new URL('./scripts/toast.ps1', import.meta.url))

/** Cordis plugin name — also the client bundle id. */
export const name = 'dsh-notification-desktop'

/** Services required before load: the projection registry. */
export const inject = ['sessionProjections']

/** Character budget for the projection body, enforced host-side. */
const MAX_BODY_CHARS = 400

/**
 * Trace ring: the browser half reports each gating decision here, so a silent
 * plugin can be diagnosed without opening DevTools. Bounded, in memory, and
 * mirrored to a temp file so a host restart does not lose the last session.
 */
const TRACE_LIMIT = 200
const trace = []

/**
 * Append one browser report and mirror it to the trace file.
 * @param {unknown} record - one client-side trace record.
 */
function recordTrace(record) {
  trace.push(record)
  if (trace.length > TRACE_LIMIT) trace.splice(0, trace.length - TRACE_LIMIT)
  try {
    appendFileSync(TRACE_FILE, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    /* the in-memory ring is enough */
  }
}

/** The empty-log view: a session with no completed turn yet. */
const EMPTY_VIEW = Object.freeze({ turn: 0, reason: '', body: '', tools: Object.freeze([]) })

/**
 * Wrap one validator in the schema shape the projection seam consumes.
 * @param {(value: unknown) => void} validate - throws on an invalid value.
 * @returns {{ parse<T>(value: T): T }} a schema whose `parse` validates and returns the value.
 */
function shape(validate) {
  return {
    parse(value) {
      validate(value)
      return value
    },
  }
}

function fail(message) {
  throw new TypeError(`dsh-notification-desktop: ${message}`)
}

function assertView(value) {
  if (value === null || typeof value !== 'object') fail('view must be an object')
  if (!Number.isInteger(value.turn) || value.turn < 0) fail('view.turn must be a non-negative integer')
  if (typeof value.reason !== 'string') fail('view.reason must be a string')
  if (typeof value.body !== 'string') fail('view.body must be a string')
  if (!Array.isArray(value.tools) || value.tools.some(tool => typeof tool !== 'string')) {
    fail('view.tools must be a string array')
  }
}

function assertState(state) {
  if (state === null || typeof state !== 'object') fail('state must be an object')
  const open = state.open
  if (open !== null) {
    if (typeof open !== 'object') fail('state.open must be an object or null')
    if (!Number.isInteger(open.turn) || open.turn < 0) fail('state.open.turn must be a non-negative integer')
    if (typeof open.text !== 'string') fail('state.open.text must be a string')
    if (!Array.isArray(open.tools) || open.tools.some(tool => typeof tool !== 'string')) {
      fail('state.open.tools must be a string array')
    }
  }
  if (state.last !== null) assertView(state.last)
}

const stateSchema = shape(assertState)
const viewSchema = shape(assertView)

/**
 * Bound one reply to the body budget, ellipsizing on overflow.
 * @param {string} text - the accumulated reply text.
 * @returns {string} the bounded text.
 */
function bound(text) {
  if (text.length <= MAX_BODY_CHARS) return text
  return text.slice(0, MAX_BODY_CHARS - 1) + '…'
}

/**
 * Pure fold: one committed session event → the next projection state.
 * Uninteresting events return the same reference so the change feed
 * (Object.is gated) stays quiet.
 * @param {{ open: null | { turn: number, text: string, tools: string[] }, last: object | null }} state
 * @param {{ type: string, data: any }} event
 */
export function reduce(state, event) {
  switch (event.type) {
    case 'turn/start':
      return { ...state, open: { turn: event.data.turn, text: '', tools: [] } }
    case 'assistant/message': {
      const open = state.open
      if (open === null || open.turn !== event.data.turn) return state
      let text = open.text
      const content = event.data.message?.content ?? []
      for (const block of content) {
        if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
      }
      text = bound(text)
      if (text === open.text) return state
      return { ...state, open: { ...open, text } }
    }
    case 'tool/call': {
      const open = state.open
      if (open === null || open.turn !== event.data.turn) return state
      if (typeof event.data.name !== 'string' || open.tools.includes(event.data.name)) return state
      return { ...state, open: { ...open, tools: [...open.tools, event.data.name] } }
    }
    case 'turn/end': {
      // Advance the turn number even when this session was observed mid-turn
      // (no turn/start in memory): the client dedupes on a monotonic turn, so
      // a silent advance is safer than a missed one.
      const open = state.open
      const sameTurn = open !== null && open.turn === event.data.turn
      const body = sameTurn ? open.text.trim() : ''
      const tools = sameTurn ? open.tools : []
      const reason = event.data.reason?.kind ?? ''
      return { open: null, last: { turn: event.data.turn, reason, body, tools } }
    }
    default:
      return state
  }
}

/**
 * Show one Windows toast through the WinRT API, out of band from the page.
 *
 * The renderer `Notification` API is not trustworthy on this shell: Chromium's
 * Windows presenter constructs the toast, reports success, and Windows drops it
 * (see README). A direct WinRT toast under the same AppUserModelID does display,
 * so the desktop route goes through here. The helper script is ASCII-only and
 * reads its text from a UTF-8 JSON file, which keeps non-ASCII copy intact.
 * @param {{ title?: unknown, body?: unknown, turn?: unknown }} payload - toast content.
 */
function showToast(payload) {
  if (process.platform !== 'win32') {
    recordTrace({ kind: 'host-notify-skip', reason: 'not-windows' })
    return
  }
  const file = join(tmpdir(), `dsh-notification-toast-${process.pid}-${Date.now()}.json`)
  try {
    writeFileSync(
      file,
      JSON.stringify({ aumid: AUMID, title: String(payload.title ?? ''), body: String(payload.body ?? '') }),
      'utf8',
    )
  } catch (error) {
    recordTrace({ kind: 'host-notify-error', stage: 'write', message: String((error && error.message) || error) })
    return
  }
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', TOAST_SCRIPT, file],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    // Capture the helper's output: a toast that silently fails is otherwise
    // indistinguishable from one that displayed.
    let output = ''
    const collect = chunk => {
      output += chunk
      if (output.length > 4000) output = output.slice(-4000)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', error => {
      recordTrace({ kind: 'host-notify-error', stage: 'spawn', message: String((error && error.message) || error) })
    })
    child.on('close', code => {
      recordTrace({ kind: 'host-notify-result', code, output: output.trim() })
    })
  } catch (error) {
    recordTrace({ kind: 'host-notify-error', stage: 'spawn', message: String((error && error.message) || error) })
  }
}

/**
 * Register the `notification` projection unit. The registration is an effect on
 * this plugin's fiber, so unloading removes the key.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host cordis context.
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.sessionProjections.register({
        key: 'notification',
        stateSchema,
        init: () => ({ open: null, last: null }),
        apply: reduce,
        wire: {
          viewSchema,
          view: state => state.last ?? EMPTY_VIEW,
        },
        stateVersion: 1,
      }),
    'dsh-notification-desktop: notification projection',
  )

  ctx.inject(['webServer'], host => {
    host.effect(
      () =>
        host.webServer.register({
          path: '/dsh-notification-desktop/trace',
          handler: async (request, response) => {
            const headers = {
              'access-control-allow-origin': '*',
              'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
              'access-control-allow-headers': 'content-type',
              'cache-control': 'no-store',
            }
            if (request.method === 'OPTIONS') {
              response.writeHead(204, headers)
              response.end()
              return
            }
            if (request.method === 'POST') {
              try {
                let body = ''
                for await (const chunk of request) {
                  body += chunk
                  if (body.length > 64 * 1024) throw new Error('body too large')
                }
                const trimmed = body.trim()
                if (trimmed !== '') recordTrace(JSON.parse(trimmed))
                response.writeHead(204, headers)
                response.end()
              } catch (error) {
                response.writeHead(400, { ...headers, 'content-type': 'application/json' })
                response.end(JSON.stringify({ ok: false, error: String((error && error.message) || error) }))
              }
              return
            }
            if (request.method === 'DELETE') {
              trace.length = 0
              response.writeHead(204, headers)
              response.end()
              return
            }
            if (request.method === 'GET') {
              response.writeHead(200, { ...headers, 'content-type': 'application/json' })
              response.end(JSON.stringify({ ok: true, file: TRACE_FILE, count: trace.length, entries: trace }))
              return
            }
            response.writeHead(405, headers)
            response.end()
          },
        }),
      'dsh-notification-desktop: trace route',
    )

    host.effect(
      () =>
        host.webServer.register({
          path: '/dsh-notification-desktop/notify',
          handler: async (request, response) => {
            const headers = {
              'access-control-allow-origin': '*',
              'access-control-allow-methods': 'POST, OPTIONS',
              'access-control-allow-headers': 'content-type',
              'cache-control': 'no-store',
            }
            if (request.method === 'OPTIONS') {
              response.writeHead(204, headers)
              response.end()
              return
            }
            if (request.method !== 'POST') {
              response.writeHead(405, headers)
              response.end()
              return
            }
            try {
              let body = ''
              for await (const chunk of request) {
                body += chunk
                if (body.length > 64 * 1024) throw new Error('body too large')
              }
              const payload = JSON.parse(body.trim() === '' ? '{}' : body)
              showToast(payload)
              recordTrace({ kind: 'host-notify', title: payload.title, turn: payload.turn })
              response.writeHead(204, headers)
              response.end()
            } catch (error) {
              response.writeHead(400, { ...headers, 'content-type': 'application/json' })
              response.end(JSON.stringify({ ok: false, error: String((error && error.message) || error) }))
            }
          },
        }),
      'dsh-notification-desktop: notify route',
    )
  })
}
