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
 */
import { z } from 'zod'

/** Cordis plugin name — also the client bundle id. */
export const name = 'dsh-notification-desktop'

/** Services required before load: the projection registry. */
export const inject = ['sessionProjections']

/** Character budget for the projection body, enforced host-side. */
const MAX_BODY_CHARS = 400

/** The empty-log view: a session with no completed turn yet. */
const EMPTY_VIEW = Object.freeze({ turn: 0, reason: '', body: '', tools: Object.freeze([]) })

const viewSchema = z
  .object({
    turn: z.number().int().nonnegative(),
    reason: z.string(),
    body: z.string(),
    tools: z.array(z.string()),
  })
  .strict()

const stateSchema = z
  .object({
    open: z
      .object({
        turn: z.number().int().nonnegative(),
        text: z.string(),
        tools: z.array(z.string()),
      })
      .strict()
      .nullable(),
    last: viewSchema.nullable(),
  })
  .strict()

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
}
