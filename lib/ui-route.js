import { FIELDS, GROUPS } from './fields.js'

const API_PREFIX = '/resource-guard/api'
const UI_HEADER = 'x-resource-guard-ui'
const MAX_BODY_BYTES = 64 * 1024

/**
 * The settings page needs data the Client cannot reach: the live budget and the
 * config values live in the Host. This fenced same-origin route is that channel.
 *
 * The custom header is the CSRF fence: a random website cannot set it on a
 * cross-origin request without a preflight this route never answers.
 */
export function registerUiApi(ctx, deps) {
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (!webServer) {
    deps.log('warn', 'webServer unavailable: the settings page has no data source')
    return
  }

  const handler = (req, res) => {
    handle(req, res, ctx, deps).catch((error) => {
      deps.log('warn', 'settings api failed', { message: messageOf(error) })
      send(res, 500, { ok: false, error: 'internal error' })
    })
  }

  try {
    ctx.effect(() => webServer.register({ kind: 'prefix', path: API_PREFIX, handler }))
    deps.log('info', 'settings api registered', { path: API_PREFIX })
  } catch (error) {
    deps.log('warn', 'could not register the settings api', { message: messageOf(error) })
  }
}

async function handle(req, res, ctx, deps) {
  if (req.headers[UI_HEADER] !== '1') {
    send(res, 403, { ok: false, error: 'missing ui header' })
    return
  }

  const pathname = String(req.url ?? '').split('?')[0].slice(API_PREFIX.length) || '/'

  if (req.method === 'GET' && pathname === '/state') {
    send(res, 200, buildState(ctx, deps))
    return
  }

  if (req.method === 'POST' && pathname === '/update') {
    let body
    try {
      body = await readJson(req)
    } catch (error) {
      send(res, 400, { ok: false, error: messageOf(error) })
      return
    }
    send(res, 200, await applyUpdate(ctx, deps, body))
    return
  }

  send(res, 404, { ok: false, error: 'not found' })
}

function buildState(ctx, deps) {
  const snapshot = deps.probe.snapshot()
  const perWorker = deps.effectivePerWorker()
  const room = Math.max(0, snapshot.commitLimitGb * deps.config.askRatio - snapshot.commitUsedGb)
  const safeWorkers = Math.max(
    1,
    Math.min(Math.floor(snapshot.cores / 2), Math.floor(room / perWorker)),
  )

  return {
    ok: true,
    version: deps.version,
    fields: FIELDS,
    groups: GROUPS,
    values: readValues(ctx, deps),
    budget: {
      cpuModel: snapshot.cpuModel,
      cores: snapshot.cores,
      commitUsedGb: round1(snapshot.commitUsedGb),
      commitLimitGb: round1(snapshot.commitLimitGb),
      availPhysGb: round1(snapshot.availPhysGb),
      vramCapGb: round1(snapshot.vramCapGb),
      vramUsedGb: snapshot.vramUsedGb === null ? null : round1(snapshot.vramUsedGb),
      perWorkerGb: perWorker,
      safeWorkers,
      fresh: snapshot.fresh,
    },
    recommendation: deps.recommendation(),
    history: deps.history.stats(),
    paths: {
      stateDir: deps.directory,
      recommendationFile: deps.recommendationFile,
    },
  }
}

function readValues(ctx, deps) {
  try {
    const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
    if (settings) {
      const entry = findEntry(settings)
      if (entry && entry.value && typeof entry.value === 'object') {
        return { ...deps.config, ...entry.value }
      }
    }
  } catch {
    // Fall back to the config this instance loaded with.
  }
  return { ...deps.config }
}

function findEntry(settings) {
  const entries = settings.describe()
  return entries.find((entry) => String(entry.ns).includes('resource-guard'))
}

async function applyUpdate(ctx, deps, body) {
  const raw = body && typeof body === 'object' ? body.values : undefined
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'values required' }

  const patch = {}
  for (const field of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, field.key)) continue
    const coerced = coerce(field, raw[field.key])
    if (coerced === undefined) return { ok: false, error: `invalid value for ${field.key}` }
    patch[field.key] = coerced
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'nothing to update' }

  // A deny line below the ask line would make 'ask' unreachable.
  const merged = { ...deps.config, ...patch }
  if (merged.denyRatio < merged.askRatio) {
    return { ok: false, error: 'denyRatio 必须大于或等于 askRatio' }
  }
  if (merged.vramDenyRatio < merged.vramAskRatio) {
    return { ok: false, error: 'vramDenyRatio 必须大于或等于 vramAskRatio' }
  }

  const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
  if (!settings) return { ok: false, error: 'settings service unavailable' }

  try {
    const entry = findEntry(settings)
    if (!entry) return { ok: false, error: 'own profile entry not found' }
    await settings.update(entry.ns, patch)
    deps.log('info', 'settings updated from the settings page', { keys: Object.keys(patch) })
    return { ok: true, applied: Object.keys(patch), ns: String(entry.ns) }
  } catch (error) {
    deps.log('warn', 'settings update failed', { message: messageOf(error) })
    return { ok: false, error: messageOf(error) }
  }
}

function coerce(field, value) {
  if (field.type === 'boolean') {
    if (typeof value === 'boolean') return value
    if (value === 'true') return true
    if (value === 'false') return false
    return undefined
  }
  if (field.type === 'enum') {
    return field.options.includes(value) ? value : undefined
  }
  if (field.type === 'number') {
    const number = typeof value === 'number' ? value : Number.parseFloat(String(value))
    if (!Number.isFinite(number)) return undefined
    const min = Number.isFinite(field.min) ? field.min : -Infinity
    const max = Number.isFinite(field.max) ? field.max : Infinity
    return Math.min(max, Math.max(min, number))
  }
  return undefined
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', (error) => reject(error))
  })
}

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function round1(value) {
  return Math.round(value * 10) / 10
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
