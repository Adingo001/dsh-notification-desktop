// Pre-flight harness for the client half: runs client.js outside the page with
// a fake module loader, fake React, fake cordis context, and fake Notification.
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry
    },
  },
  focus() {},
}
globalThis.document = { hidden: false }

const storage = new Map()
globalThis.localStorage = {
  getItem: key => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key),
}

const shown = []
class FakeNotification {
  static permission = 'granted'
  static requestPermission() {
    return Promise.resolve(FakeNotification.permission)
  }
  constructor(title, options) {
    this.title = title
    this.options = options ?? {}
    shown.push(this)
  }
  close() {}
}
globalThis.Notification = FakeNotification

// ── fake React ──────────────────────────────────────────────────────────────
const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length ? children : props?.children } }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useCallback(fn) {
    return fn
  },
  useMemo(fn) {
    return fn()
  },
}
const requireShim = id => {
  if (id === 'react') return fakeReact
  throw new Error(`unexpected require(${id})`)
}

// ── run the client module ───────────────────────────────────────────────────
new Function(SOURCE)()
const entry = captured
if (!entry || typeof entry.factory !== 'function') throw new Error('module factory was not captured')

const mod = entry.factory(requireShim)
const assert = (cond, msg) => {
  if (cond) console.log('ok   ' + msg)
  else {
    console.error('FAIL ' + msg)
    process.exitCode = 1
  }
}

assert(entry.id === 'dsh-notification-desktop', 'module id matches the package name')
assert(mod.name === 'dsh-notification-desktop', 'exports name')
assert(Array.isArray(mod.inject) && mod.inject.includes('slots') && mod.inject.includes('locale'), 'exports service inject')
assert(typeof mod.apply === 'function', 'exports apply')

// ── fake cordis ctx + session list ──────────────────────────────────────────
let snapshot = { ids: [], byId: {}, phase: 'ready' }
let runList = () => {}
let sectionRegistration = null
let dictionaries = null
const dicts = {}

const ctx = {
  effect(fn, label) {
    try {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    } catch (error) {
      console.error(`FAIL effect '${label}' threw:`, error)
      process.exitCode = 1
      return () => {}
    }
  },
  on() {
    return () => {}
  },
  get(name) {
    if (name === 'sessions') return { list: { getSnapshot: () => snapshot, subscribe: fn => { runList = fn; return () => { runList = () => {} } } } }
    return undefined
  },
  locale: {
    register(ns, tables) {
      dictionaries = { ns, tables }
      Object.assign(dicts, tables)
      return () => {}
    },
    bind(ns) {
      return key => {
        for (const table of Object.values(dicts)) {
          if (Object.prototype.hasOwnProperty.call(table, key)) return table[key]
        }
        console.error(`FAIL missing locale key '${key}' in namespace ${ns}`)
        process.exitCode = 1
        return key
      }
    },
  },
  slots: {
    inject(name, callback) {
      if (name !== 'settings.section') console.error(`FAIL unexpected slot '${name}'`)
      callback()
      return () => {}
    },
    register(registration, component) {
      sectionRegistration = { registration, component }
      return () => {}
    },
  },
}

mod.apply(ctx)
assert(dictionaries !== null && dictionaries.ns === 'dsh-notification-desktop', 'locale dictionaries registered')
assert(sectionRegistration !== null, 'settings.section registered')
assert(sectionRegistration.registration.id === 'notification', 'section id = notification')
assert(typeof sectionRegistration.registration.label === 'function', 'section label is a function')
assert(typeof sectionRegistration.registration.inject === 'function', 'section inject is a function')

const injected = sectionRegistration.registration.inject()
assert(typeof injected.t === 'function' && typeof injected.store === 'object', 'section inject face carries t + store')

// ── render the section (walks every nested component) ───────────────────────
const seenKeys = new Set()
const walk = node => {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    node.forEach(walk)
    return
  }
  if (typeof node === 'string') {
    seenKeys.add(node)
    return
  }
  const { type, props } = node
  if (typeof type === 'function') {
    walk(type(props))
    return
  }
  if (props && props.children !== undefined) walk(props.children)
}
const rendered = sectionRegistration.component(injected)
walk(rendered)
assert(seenKeys.has('完成提醒') || [...seenKeys].some(v => typeof v === 'string' && v.length > 0), 'section renders text')
assert(![...seenKeys].some(v => typeof v === 'string' && /^[a-z][A-Za-z]*$/.test(v) && dicts.zh[v] === undefined && dicts.en[v] === undefined && !v.startsWith('dsh-')), 'no raw locale keys leaked into rendered text')

// ── the completion runner ───────────────────────────────────────────────────
const row = (id, turn, reason, mainView, title) => ({
  id,
  displayTitle: title,
  retainedBy: { mainView },
  projectionValues: { notification: { turn, reason, body: 'reply text', tools: [] } },
})

// baseline: the first observation must never notify
snapshot = { ids: ['s1'], byId: { s1: row('s1', 1, 'completed', 1, '会话一') }, phase: 'ready' }
runList()
assert(shown.length === 0, 'the first observation seeds the baseline (no notification for history)')

// a completed turn on the session in view, page visible → suppressed by backgroundOnly
snapshot = { ids: ['s1'], byId: { s1: row('s1', 2, 'completed', 1, '会话一') }, phase: 'ready' }
runList()
assert(shown.length === 0, 'backgroundOnly suppresses the session in the main view while visible')

// page hidden → notify
document.hidden = true
snapshot = { ids: ['s1'], byId: { s1: row('s1', 3, 'completed', 1, '会话一') }, phase: 'ready' }
runList()
assert(shown.length === 1, 'page hidden → one notification')
assert(shown[0].title === '任务完成', `title follows the reason (${shown[0]?.title})`)
assert(typeof shown[0].options.body === 'string' && shown[0].options.body.includes('reply text'), 'body carries the reply snippet')
assert(shown[0].options.tag === 'dsh-notification-s1-3', `per-turn tag (${shown[0]?.options.tag})`)

// a reason that is off by default
snapshot = { ids: ['s1'], byId: { s1: row('s1', 4, 'aborted', 1, '会话一') }, phase: 'ready' }
runList()
assert(shown.length === 1, 'aborted stays off by default')

// forked turn-ends never notify
snapshot = { ids: ['s1'], byId: { s1: row('s1', 5, 'forked', 1, '会话一') }, phase: 'ready' }
runList()
assert(shown.length === 1, 'forked turn-ends are ignored')

// a session with no main-view retention notifies even while visible
document.hidden = false
snapshot = { ids: ['s1', 's2'], byId: { s1: row('s1', 6, 'completed', 1, '会话一'), s2: row('s2', 1, 'completed', 0, '会话二') }, phase: 'ready' }
runList()
assert(shown.length === 1, 'a new session only seeds its baseline')
snapshot = { ids: ['s1', 's2'], byId: { s1: row('s1', 6, 'completed', 1, '会话一'), s2: row('s2', 2, 'error', 0, '会话二') }, phase: 'ready' }
runList()
assert(shown.length === 2, 'a non-main session notifies while the page is visible')
assert(shown[1].title === '任务出错', `error title (${shown[1]?.title})`)
assert(shown[1].options.body.includes('会话二'), 'body leads with the session title')

// master switch off
injected.store.set({ enabled: false })
snapshot = { ids: ['s1', 's2'], byId: { s1: row('s1', 6, 'completed', 1, '会话一'), s2: row('s2', 3, 'error', 0, '会话二') }, phase: 'ready' }
runList()
assert(shown.length === 2, 'the master switch stops everything')
injected.store.set({ enabled: true })
snapshot = { ids: ['s1', 's2'], byId: { s1: row('s1', 6, 'completed', 1, '会话一'), s2: row('s2', 4, 'error', 0, '会话二') }, phase: 'ready' }
runList()
assert(shown.length === 3, 're-enabling resumes notifications')

// settings persist
assert(localStorage.getItem('dsh-notification-desktop.v1') !== null, 'settings persist to localStorage')

// denied permission → nothing shown, no throw
FakeNotification.permission = 'denied'
snapshot = { ids: ['s1', 's2'], byId: { s1: row('s1', 6, 'completed', 1, '会话一'), s2: row('s2', 5, 'error', 0, '会话二') }, phase: 'ready' }
runList()
assert(shown.length === 3, 'a denied permission silently skips delivery')

console.log(process.exitCode ? '\nRESULT: FAILED' : '\nRESULT: all client checks passed')
