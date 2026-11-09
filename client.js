// dsh-resource-guard — Web settings page.
//
// Plain React from the host module table. The page talks only to its own
// same-origin fenced route, which requires a custom header so a random website
// cannot CSRF the settings API.
window.__ModuleLoader__.load({
  id: '@local/dsh-resource-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const API = '/resource-guard/api'
    const UI_HEADER = 'x-resource-guard-ui'

    // Follow the system language, like the other pages do. `document.documentElement.lang`
    // is the app shell's own value and is not the user's language, so it is only a last resort.
    const LANG = (() => {
      const resolve = (raw) => {
        const value = String(raw || '').trim().toLowerCase()
        if (value.length === 0) return null
        return value.startsWith('zh') ? 'zh' : 'en'
      }
      try {
        const preference = []
        if (typeof navigator !== 'undefined') {
          if (Array.isArray(navigator.languages)) preference.push(...navigator.languages)
          preference.push(navigator.language)
        }
        if (typeof document !== 'undefined' && document.documentElement) {
          preference.push(document.documentElement.lang)
        }
        for (const candidate of preference) {
          const resolved = resolve(candidate)
          if (resolved) return resolved
        }
      } catch {
        // Fall through to the default below.
      }
      return 'en'
    })()
    const t = (zh, en) => (LANG === 'zh' ? zh : en)

    const TEXT = {
      title: t('资源门禁', 'Resource Guard'),
      subtitle: t(
        '在执行前估算工具调用的内存与显存开销，任务过重时先询问；阈值可以在这里直接改。',
        'Estimates a tool call before it runs, asks first when it is heavy; the thresholds are editable here.',
      ),
      loading: t('读取中…', 'Loading…'),
      save: t('保存', 'Save'),
      saving: t('保存中…', 'Saving…'),
      saved: t('已保存，配置正在热应用', 'Saved; applying live'),
      reset: t('填入推荐值', 'Fill recommended'),
      revert: t('撤销修改', 'Revert'),
      dirty: t('项待保存', 'pending'),
      error: t('操作失败', 'Failed'),
      budget: t('本机实时预算', 'Live budget'),
      commit: t('提交内存', 'Commit'),
      vram: t('显存', 'VRAM'),
      physical: t('可用物理内存', 'Physical free'),
      concurrency: t('安全并发', 'Safe concurrency'),
      cpu: t('CPU', 'CPU'),
      recommendation: t('硬件推导建议', 'Hardware-derived suggestion'),
      recNone: t('尚无建议文档', 'No suggestion yet'),
      recAt: t('生成于', 'generated'),
      history: t('实测画像', 'Measured profile'),
      historyRows: t('个签名', 'signatures'),
      median: t('中位峰值', 'median peak'),
      paths: t('状态文件', 'State files'),
      unsaved: t('有未保存修改', 'Unsaved changes'),
      gateHint: t(
        '注意：关闭总开关后，本插件不介入任何调用。这条设置本身就是"它在哪里生效"的答案——一旦关掉，门禁、预算区块与熔断全部停止。',
        'Note: switching the plugin off removes all of its behaviour. That is the honest answer to "where does it act" — no gate, no budget block, no breaker.',
      ),
      readOnly: t('配置服务不可用，只能查看', 'Config service unavailable; read-only'),
    }

    const styles = {
      page: { padding: '4px 0 24px', color: 'var(--dsw-alias-label-primary)' },
      h1: { fontSize: 15, fontWeight: 600, margin: '0 0 4px' },
      sub: { fontSize: 12.5, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)', margin: '0 0 16px' },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: 10,
        padding: '12px 14px',
        marginBottom: 14,
      },
      cardTitle: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', margin: '0 0 10px' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 },
      metric: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      metricValue: { fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginTop: 2 },
      group: { marginBottom: 14 },
      groupTitle: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', margin: '0 0 8px' },
      row: {
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        padding: '10px 0',
        display: 'flex',
        gap: 16,
        alignItems: 'flex-start',
        justifyContent: 'space-between',
      },
      rowMain: { minWidth: 0, flex: 1 },
      label: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' },
      help: { fontSize: 12, lineHeight: 1.55, color: 'var(--dsw-alias-label-tertiary)', marginTop: 3 },
      input: {
        width: 110,
        boxSizing: 'border-box',
        padding: '5px 8px',
        fontSize: 13,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 6,
      },
      select: {
        padding: '5px 8px',
        fontSize: 13,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 6,
      },
      bar: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' },
      primary: {
        padding: '6px 14px',
        fontSize: 13,
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: '#fff',
        cursor: 'pointer',
      },
      secondary: {
        padding: '6px 12px',
        fontSize: 13,
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      note: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      errorText: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5 },
    }

    function call(path, init) {
      // Spread callers' options first, then attach headers: spreading after the
      // merge replaced it wholesale whenever the caller passed its own headers
      // (the save request did), dropping the fence header.
      const options = init || {}
      const extraHeaders = options.headers || {}
      const { headers: _ignored, ...rest } = options
      return fetch(API + path, {
        credentials: 'same-origin',
        ...rest,
        headers: Object.assign({ [UI_HEADER]: '1' }, extraHeaders),
      }).then(async (response) => {
        const payload = await response.json().catch(() => ({}))
        if (!response.ok || payload.ok === false) {
          throw new Error(payload.error || `HTTP ${response.status}`)
        }
        return payload
      })
    }

    function Metric({ label, value }) {
      return h('div', { style: styles.metric }, label, h('div', { style: styles.metricValue }, value))
    }

    function Field({ field, value, onChange }) {
      const label = LANG === 'zh' ? field.zh : field.en
      const help = field.help ? field.help[LANG] || field.help.en : ''
      let control

      if (field.type === 'boolean') {
        control = h('input', {
          type: 'checkbox',
          checked: Boolean(value),
          onChange: (event) => onChange(event.target.checked),
        })
      } else if (field.type === 'enum') {
        control = h(
          'select',
          { style: styles.select, value: String(value), onChange: (event) => onChange(event.target.value) },
          field.options.map((option) => h('option', { key: option, value: option }, option)),
        )
      } else {
        control = h('input', {
          type: 'number',
          style: styles.input,
          value: value === undefined || value === null ? '' : String(value),
          min: field.min,
          max: field.max,
          step: field.step || 1,
          onChange: (event) => {
            const raw = event.target.value
            onChange(raw === '' ? '' : Number(raw))
          },
        })
      }

      return h(
        'div',
        { style: styles.row },
        h(
          'div',
          { style: styles.rowMain },
          h('div', { style: styles.label }, label),
          help ? h('div', { style: styles.help }, help) : null,
        ),
        control,
      )
    }

    function SettingsPage() {
      const [state, setState] = useState(null)
      const [draft, setDraft] = useState(null)
      const [error, setError] = useState('')
      const [status, setStatus] = useState('')
      const [busy, setBusy] = useState(false)

      const load = useCallback((attempt = 0) => {
        call('/state')
          .then((payload) => {
            setState(payload)
            setDraft(payload.values)
            setError('')
          })
          .catch((err) => {
            // The Host registers this route only once the web server is up, so a
            // 404 right after a restart is expected rather than fatal.
            if (/HTTP 404/.test(err.message) && attempt < 6) {
              setError(t('接口尚未就绪，正在重试…', 'API not ready yet, retrying…'))
              setTimeout(() => load(attempt + 1), 1500)
              return
            }
            setError(err.message)
          })
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const dirtyKeys = useMemo(() => {
        if (!state || !draft) return []
        return Object.keys(draft).filter((key) => draft[key] !== state.values[key])
      }, [state, draft])

      if (error && !state) {
        return h('div', { style: styles.page }, h('div', { style: styles.errorText }, `${TEXT.error}: ${error}`))
      }
      if (!state || !draft) {
        return h('div', { style: styles.page }, h('div', { style: styles.note }, TEXT.loading))
      }

      const budget = state.budget || {}
      const groups = state.groups || {}
      const grouped = new Map()
      for (const field of state.fields) {
        const key = field.group || 'advanced'
        if (!grouped.has(key)) grouped.set(key, [])
        grouped.get(key).push(field)
      }

      const onSave = () => {
        setBusy(true)
        setStatus('')
        call('/update', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ values: draft }),
        })
          .then(() => {
            setStatus(TEXT.saved)
            setTimeout(load, 600)
          })
          .catch((err) => setError(err.message))
          .finally(() => setBusy(false))
      }

      const fillRecommended = () => {
        const recommended = state.recommendation && state.recommendation.values
        if (!recommended) return
        setDraft((current) => ({ ...current, ...recommended }))
      }

      return h(
        'div',
        { style: styles.page },
        h('div', { style: styles.h1 }, TEXT.title),
        h('div', { style: styles.sub }, TEXT.subtitle),

        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.cardTitle }, TEXT.budget),
          h(
            'div',
            { style: styles.grid },
            h(Metric, {
              label: TEXT.commit,
              value: `${budget.commitUsedGb ?? '—'} / ${budget.commitLimitGb ?? '—'} GB`,
            }),
            h(Metric, {
              label: TEXT.vram,
              value:
                budget.vramUsedGb === null || budget.vramUsedGb === undefined
                  ? `${budget.vramCapGb ?? '—'} GB`
                  : `${budget.vramUsedGb} / ${budget.vramCapGb} GB`,
            }),
            h(Metric, { label: TEXT.physical, value: `${budget.availPhysGb ?? '—'} GB` }),
            h(Metric, {
              label: TEXT.concurrency,
              value: `${budget.safeWorkers ?? '—'} × ${budget.perWorkerGb ?? '—'} GB`,
            }),
            h(Metric, { label: TEXT.cpu, value: `${budget.cores ?? '—'} threads` }),
          ),
        ),

        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.cardTitle }, TEXT.recommendation),
          state.recommendation
            ? h(
                'div',
                null,
                h(
                  'div',
                  { style: styles.note },
                  `${TEXT.recAt} ${state.recommendation.at} · `,
                  h('span', { style: styles.mono }, state.paths.recommendationFile),
                ),
                h(
                  'div',
                  { style: styles.bar },
                  h(
                    'button',
                    { type: 'button', style: styles.secondary, onClick: fillRecommended },
                    TEXT.reset,
                  ),
                ),
              )
            : h('div', { style: styles.note }, TEXT.recNone),
        ),

        Array.from(grouped.entries()).map(([groupKey, fields]) =>
          h(
            'div',
            { key: groupKey, style: styles.group },
            h('div', { style: styles.groupTitle }, (groups[groupKey] && groups[groupKey][LANG]) || groupKey),
            fields.map((field) =>
              h(Field, {
                key: field.key,
                field,
                value: draft[field.key],
                onChange: (value) => setDraft((current) => ({ ...current, [field.key]: value })),
              }),
            ),
          ),
        ),

        h('div', { style: styles.sub }, TEXT.gateHint),

        h(
          'div',
          { style: styles.bar },
          h(
            'button',
            {
              type: 'button',
              style: Object.assign({}, styles.primary, busy || dirtyKeys.length === 0 ? { opacity: 0.5 } : null),
              disabled: busy || dirtyKeys.length === 0,
              onClick: onSave,
            },
            busy ? TEXT.saving : TEXT.save,
          ),
          h(
            'button',
            {
              type: 'button',
              style: styles.secondary,
              disabled: busy || dirtyKeys.length === 0,
              onClick: () => {
                setDraft(state.values)
                setStatus('')
              },
            },
            TEXT.revert,
          ),
          dirtyKeys.length > 0 ? h('span', { style: styles.note }, `${dirtyKeys.length} ${TEXT.dirty}`) : null,
          status ? h('span', { style: styles.note }, status) : null,
          error ? h('span', { style: styles.errorText }, `${TEXT.error}: ${error}`) : null,
        ),

        h(
          'div',
          { style: Object.assign({}, styles.note, { marginTop: 12 }) },
          `${TEXT.history}: ${state.history.entries} ${TEXT.historyRows} · ${TEXT.median} ${state.history.medianPeakGb} GB`,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(
          () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'resource-guard',
                  order: 66,
                  label: TEXT.title,
                  registrant: '@local/dsh-resource-guard',
                },
                SettingsPage,
              ),
            ),
          'resource-guard: settings section',
        )
      },
    }
  },
})
