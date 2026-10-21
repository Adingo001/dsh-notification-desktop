/**
 * dsh-notification-desktop — browser half.
 *
 * Watches the client session list for a rising `notification` projection turn
 * (the host half's summary of the last completed turn) and shows a desktop
 * notification through the browser Notification API. Also registers the
 * settings page under Settings → 完成提醒 / Completion reminders.
 *
 * 0.2.x notes (why this differs from the 0.1.4 upstream):
 *  - `ctx.sessions.list` is the snapshot store `{ ids, byId, phase,
 *    projectionsBySession }`; each row carries `projectionValues`, `title`,
 *    `displayTitle`, `origin`, `running`, and `retainedBy`.
 *  - Session rows no longer carry `pendingInteraction`; pending-interaction
 *    notifications therefore are not ported (the completion edge is).
 *  - Preferences live in localStorage behind a tiny observable instead of
 *    `@deepseek-ai/dsh-client-store`, which is not resolvable from a profile
 *    plugin.
 */
window.__ModuleLoader__.load({
  id: 'dsh-notification-desktop',
  factory: require => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const name = 'dsh-notification-desktop'
    const inject = ['slots', 'locale']
    const NS = 'dsh-notification-desktop'
    const STORAGE_KEY = 'dsh-notification-desktop.v1'

    // ─── dictionaries ──────────────────────────────────────────────────────

    const zh = {
      nav: '完成提醒',
      desc: '会话跑完一轮时弹一条系统通知，可以按结束原因过滤。',
      master: '启用完成提醒',
      masterHint: '总开关。关闭后任何原因都不弹通知。',
      permission: '系统通知权限',
      permGranted: '已授权',
      permDenied: '已被拒绝（需要在系统/浏览器设置里放行本应用）',
      permDefault: '尚未授权',
      permUnsupported: '当前环境没有 Notification API',
      request: '请求权限',
      test: '发送测试通知',
      okShow: '已发出测试通知',
      failShow: '发送失败：{message}',
      reasonTitle: '按结束原因',
      reasonCompleted: '正常完成',
      reasonError: '报错结束',
      reasonAborted: '被中断',
      reasonBlocked: '被拦截',
      reasonMaxTokens: '触顶最大输出',
      behaviorTitle: '行为',
      backgroundOnly: '只在页面不在前台时提醒',
      backgroundOnlyHint: '关掉后，正在看的会话也会弹。',
      requireInteraction: '通知停留到手动关闭',
      bodyChars: '正文长度上限（字符）',
      titleCompleted: '任务完成',
      titleError: '任务出错',
      titleAborted: '任务已中断',
      titleBlocked: '任务被拦截',
      titleMaxTokens: '输出触顶',
      titleTest: '这是一条测试通知',
      emptyBody: '（这轮没有文字回复）',
      untitled: '未命名会话',
      bodyOf: '{title}',
    }

    const en = {
      nav: 'Completion reminders',
      desc: 'Post a system notification when a session finishes a turn, filtered by how it ended.',
      master: 'Enable completion reminders',
      masterHint: 'Master switch. Off means no notification for any reason.',
      permission: 'System notification permission',
      permGranted: 'granted',
      permDenied: 'denied (allow this app in the OS/browser settings)',
      permDefault: 'not requested yet',
      permUnsupported: 'this environment has no Notification API',
      request: 'Request permission',
      test: 'Send a test notification',
      okShow: 'Test notification sent',
      failShow: 'Could not send: {message}',
      reasonTitle: 'Notify on',
      reasonCompleted: 'Completed',
      reasonError: 'Ended with an error',
      reasonAborted: 'Interrupted',
      reasonBlocked: 'Blocked',
      reasonMaxTokens: 'Hit the output limit',
      behaviorTitle: 'Behaviour',
      backgroundOnly: 'Only while the page is in the background',
      backgroundOnlyHint: 'Turn off to also notify for the session you are looking at.',
      requireInteraction: 'Keep the notification until dismissed',
      bodyChars: 'Body length limit (characters)',
      titleCompleted: 'Task complete',
      titleError: 'Task failed',
      titleAborted: 'Task interrupted',
      titleBlocked: 'Task blocked',
      titleMaxTokens: 'Output limit reached',
      titleTest: 'This is a test notification',
      emptyBody: '(this turn had no text reply)',
      untitled: 'Untitled session',
      bodyOf: '{title}',
    }

    // ─── settings store ────────────────────────────────────────────────────

    const DEFAULTS = Object.freeze({
      enabled: true,
      notifyCompleted: true,
      notifyError: true,
      notifyAborted: false,
      notifyBlocked: false,
      notifyMaxTokens: false,
      backgroundOnly: true,
      requireInteraction: false,
      bodyChars: 160,
    })

    function loadSettings() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (raw === null) return { ...DEFAULTS }
        const saved = JSON.parse(raw)
        if (saved === null || typeof saved !== 'object') return { ...DEFAULTS }
        return { ...DEFAULTS, ...saved }
      } catch {
        return { ...DEFAULTS }
      }
    }

    function createStore() {
      let value = loadSettings()
      const listeners = new Set()
      const persist = () => {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
        } catch {
          /* storage may be unavailable; the in-memory value still works */
        }
      }
      return {
        get: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        set(patch) {
          value = { ...value, ...patch }
          persist()
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch (error) {
              console.error('[dsh-notification-desktop] settings subscriber failed', error)
            }
          }
        },
      }
    }

    // ─── reason mapping ────────────────────────────────────────────────────

    /** Turn-end reason → the settings flag that gates it. Unknown reasons never notify. */
    const REASON_FLAG = {
      completed: 'notifyCompleted',
      error: 'notifyError',
      aborted: 'notifyAborted',
      interrupted: 'notifyAborted',
      blocked: 'notifyBlocked',
      'max-tokens': 'notifyMaxTokens',
    }

    /** Turn-end reason → the locale key of its notification title. */
    const REASON_TITLE = {
      completed: 'titleCompleted',
      error: 'titleError',
      aborted: 'titleAborted',
      interrupted: 'titleAborted',
      blocked: 'titleBlocked',
      'max-tokens': 'titleMaxTokens',
    }

    // ─── notification plumbing ─────────────────────────────────────────────

    function notificationApi() {
      return typeof Notification === 'undefined' ? undefined : Notification
    }

    function currentPermission() {
      const api = notificationApi()
      return api === undefined ? 'unsupported' : api.permission
    }

    /** One base64-free stable tag per session per turn, so each turn replaces only itself. */
    function tagOf(sessionId, turn) {
      return `dsh-notification-${sessionId}-${turn}`
    }

    function clampBody(body, limit) {
      const text = String(body ?? '').trim()
      if (limit <= 0 || text.length <= limit) return text
      return text.slice(0, Math.max(0, limit - 1)) + '…'
    }

    /**
     * Construct one system notification.
     * @returns {{ ok: true } | { ok: false, message: string }}
     */
    function show(api, title, body, tag, requireInteraction) {
      if (api === undefined) return { ok: false, message: 'Notification API unavailable' }
      if (api.permission !== 'granted') return { ok: false, message: `permission=${api.permission}` }
      try {
        const notification = new api(title, { body, tag, requireInteraction })
        notification.onclick = () => {
          try {
            window.focus()
          } catch {
            /* focusing is best effort */
          }
        }
        notification.onerror = () => {
          console.error('[dsh-notification-desktop] the browser reported a delivery error')
        }
        return { ok: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, message }
      }
    }

    function sessionTitleOf(row, t) {
      const title = row?.displayTitle ?? row?.title
      return typeof title === 'string' && title.trim() !== '' ? title.trim() : t('untitled')
    }

    function isMainView(row) {
      const main = row?.retainedBy?.mainView
      return typeof main === 'number' && main > 0
    }

    function turnOf(row) {
      const value = row?.projectionValues?.notification
      if (value === undefined || value === null) return 0
      return typeof value.turn === 'number' && value.turn > 0 ? value.turn : 0
    }

    // ─── the completion runner ─────────────────────────────────────────────

    /**
     * Subscribe to the session list and notify when a session's `notification`
     * projection turn rises past the last observed turn. The first observation
     * seeds the baseline, so history is never re-notified; a reconnect re-seeds
     * for the same reason.
     */
    function startRunner(ctx, store, t) {
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
      const list = sessions !== undefined && sessions !== null ? sessions.list : undefined
      if (list === undefined || typeof list.subscribe !== 'function' || typeof list.getSnapshot !== 'function') {
        console.warn('[dsh-notification-desktop] ctx.sessions.list is unavailable; completion reminders stay off')
        return () => {}
      }

      const observed = new Map()

      const seed = () => {
        const state = list.getSnapshot()
        observed.clear()
        if (state === undefined || !Array.isArray(state.ids)) return
        for (const id of state.ids) observed.set(id, turnOf(state.byId?.[id]))
      }

      const fire = (api, row, projection, settings) => {
        const title = t(REASON_TITLE[projection.reason] ?? 'titleCompleted')
        const limit = settings.bodyChars
        const body = clampBody(projection.body, limit) || t('emptyBody')
        const subtitle = sessionTitleOf(row, t)
        const tag = tagOf(row.id, projection.turn)
        const deliver = () => {
          const result = show(api, title, subtitle === '' ? body : `${subtitle}\n${body}`, tag, settings.requireInteraction)
          if (!result.ok) console.error(`[dsh-notification-desktop] notification failed: ${result.message}`)
        }
        if (api.permission === 'granted') deliver()
        else if (api.permission === 'default') {
          api.requestPermission().then(status => {
            if (status === 'granted') deliver()
          })
        }
      }

      const run = () => {
        const state = list.getSnapshot()
        if (state === undefined || !Array.isArray(state.ids)) return
        const settings = store.get()
        const api = notificationApi()
        for (const id of state.ids) {
          const row = state.byId?.[id]
          if (row === undefined || row === null) continue
          const projection = row.projectionValues?.notification
          const turn = turnOf(row)
          const previous = observed.get(id)
          observed.set(id, turn)
          if (previous === undefined || turn <= previous) continue
          if (!settings.enabled || api === undefined) continue
          if (projection === undefined || projection === null) continue
          const flag = REASON_FLAG[projection.reason]
          if (flag === undefined || settings[flag] !== true) continue
          if (settings.backgroundOnly && !document.hidden && isMainView(row)) continue
          fire(api, row, projection, settings)
        }
        const live = new Set(state.ids)
        for (const id of [...observed.keys()]) if (!live.has(id)) observed.delete(id)
      }

      seed()
      const offList = list.subscribe(run)
      const offReset =
        typeof ctx.on === 'function'
          ? ctx.on('connection/reset', () => {
              seed()
            })
          : () => {}
      return () => {
        offList()
        if (typeof offReset === 'function') offReset()
      }
    }

    // ─── settings section ──────────────────────────────────────────────────

    const STYLE = `
.dsh-ntf-root { display: flex; flex-direction: column; gap: 18px; color: var(--dsw-alias-label-primary); font-size: 13px; }
.dsh-ntf-desc { color: var(--dsw-alias-label-secondary); line-height: 1.55; margin: 0; }
.dsh-ntf-group { display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 14px 16px; background: var(--dsw-alias-bg-layer-1); }
.dsh-ntf-legend { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
.dsh-ntf-row { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; }
.dsh-ntf-row input { margin: 2px 0 0; accent-color: var(--dsw-alias-brand-primary); }
.dsh-ntf-row-main { display: flex; flex-direction: column; gap: 2px; }
.dsh-ntf-hint { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; }
.dsh-ntf-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.dsh-ntf-btn { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 6px 12px; font-size: 12px; cursor: pointer; }
.dsh-ntf-btn:hover { border-color: var(--dsw-alias-brand-primary); }
.dsh-ntf-btn:disabled { opacity: .55; cursor: default; }
.dsh-ntf-status { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-ntf-bad { color: var(--dsw-alias-state-error-primary); }
.dsh-ntf-good { color: var(--dsw-alias-state-success-primary); }
.dsh-ntf-num { width: 84px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 5px 8px; font-size: 12px; }
`

    function CheckRow(props) {
      const { checked, onChange, label, hint } = props
      return h(
        'label',
        { className: 'dsh-ntf-row' },
        h('input', { type: 'checkbox', checked: checked === true, onChange: event => onChange(event.target.checked) }),
        h(
          'span',
          { className: 'dsh-ntf-row-main' },
          h('span', null, label),
          hint === undefined ? null : h('span', { className: 'dsh-ntf-hint' }, hint),
        ),
      )
    }

    function Section(props) {
      const { t, store } = props
      const [settings, setSettings] = useState(() => store.get())
      const [permission, setPermission] = useState(currentPermission)
      const [note, setNote] = useState('')

      useEffect(() => store.subscribe(() => setSettings(store.get())), [store])

      const update = useCallback(
        patch => {
          store.set(patch)
          setSettings(store.get())
        },
        [store],
      )

      const requestPermission = useCallback(() => {
        const api = notificationApi()
        if (api === undefined) {
          setPermission('unsupported')
          return
        }
        Promise.resolve(api.requestPermission()).then(status => {
          setPermission(status)
          setNote('')
        })
      }, [])

      const sendTest = useCallback(() => {
        const api = notificationApi()
        const result = show(api, t('titleTest'), 'dsh-notification-desktop', `dsh-notification-test-${Date.now()}`, false)
        setPermission(currentPermission())
        setNote(result.ok ? t('okShow') : t('failShow').replace('{message}', result.message))
      }, [t])

      const permissionText =
        permission === 'granted'
          ? t('permGranted')
          : permission === 'denied'
            ? t('permDenied')
            : permission === 'unsupported'
              ? t('permUnsupported')
              : t('permDefault')

      const reasonRow = (flag, labelKey) =>
        h(CheckRow, {
          checked: settings[flag] === true,
          onChange: value => update({ [flag]: value }),
          label: t(labelKey),
        })

      return h(
        'div',
        { className: 'dsh-ntf-root' },
        h('style', null, STYLE),
        h('p', { className: 'dsh-ntf-desc' }, t('desc')),
        h(
          'div',
          { className: 'dsh-ntf-group' },
          h(CheckRow, {
            checked: settings.enabled === true,
            onChange: value => update({ enabled: value }),
            label: t('master'),
            hint: t('masterHint'),
          }),
          h(
            'div',
            { className: 'dsh-ntf-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ntf-btn',
                onClick: requestPermission,
                disabled: permission === 'granted' || permission === 'unsupported',
              },
              t('request'),
            ),
            h('button', { type: 'button', className: 'dsh-ntf-btn', onClick: sendTest }, t('test')),
            h(
              'span',
              {
                className:
                  'dsh-ntf-status ' +
                  (permission === 'granted' ? 'dsh-ntf-good' : permission === 'denied' || permission === 'unsupported' ? 'dsh-ntf-bad' : ''),
              },
              `${t('permission')}: ${permissionText}`,
            ),
          ),
          note === '' ? null : h('span', { className: 'dsh-ntf-status' }, note),
        ),
        h(
          'div',
          { className: 'dsh-ntf-group' },
          h('div', { className: 'dsh-ntf-legend' }, t('reasonTitle')),
          reasonRow('notifyCompleted', 'reasonCompleted'),
          reasonRow('notifyError', 'reasonError'),
          reasonRow('notifyAborted', 'reasonAborted'),
          reasonRow('notifyBlocked', 'reasonBlocked'),
          reasonRow('notifyMaxTokens', 'reasonMaxTokens'),
        ),
        h(
          'div',
          { className: 'dsh-ntf-group' },
          h('div', { className: 'dsh-ntf-legend' }, t('behaviorTitle')),
          h(CheckRow, {
            checked: settings.backgroundOnly === true,
            onChange: value => update({ backgroundOnly: value }),
            label: t('backgroundOnly'),
            hint: t('backgroundOnlyHint'),
          }),
          h(CheckRow, {
            checked: settings.requireInteraction === true,
            onChange: value => update({ requireInteraction: value }),
            label: t('requireInteraction'),
          }),
          h(
            'label',
            { className: 'dsh-ntf-row' },
            h(
              'span',
              { className: 'dsh-ntf-row-main' },
              h('span', null, t('bodyChars')),
              h('input', {
                className: 'dsh-ntf-num',
                type: 'number',
                min: 20,
                max: 400,
                step: 10,
                value: settings.bodyChars,
                onChange: event => {
                  const next = Number(event.target.value)
                  if (Number.isFinite(next)) update({ bodyChars: Math.min(400, Math.max(20, Math.round(next))) })
                },
              }),
            ),
          ),
        ),
      )
    }

    // ─── plugin body ───────────────────────────────────────────────────────

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-notification-desktop: dictionaries')
      const t = ctx.locale.bind(NS)
      const store = createStore()

      ctx.effect(() => startRunner(ctx, store, t), 'dsh-notification-desktop: completion runner')
      console.info(`[dsh-notification-desktop] loaded (permission=${currentPermission()})`)

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'notification',
            order: 60,
            label: () => t('nav'),
            inject: () => ({ t, store }),
          },
          Section,
        ),
      )
    }

    return { name, inject, apply }
  },
})
