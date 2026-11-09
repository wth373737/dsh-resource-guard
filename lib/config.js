/** Tunable defaults. Every value can be overridden from cordis.patch.yml. */
export const DEFAULTS = {
  /** Master switch; false leaves the profile exactly as it was. */
  enabled: true,
  /** What an over-budget call does: 'ask' | 'deny' | 'warn'. */
  mode: 'ask',
  /** 'heavy' gates only known-expensive tools; 'all' gates every tool call. */
  scope: 'heavy',
  /** Headroom kept free, in GB, when judging physical memory pressure. */
  reserveGb: 6,
  /** Projected commit / commit-limit at which we ask the user. */
  askRatio: 0.8,
  /** Projected commit / commit-limit at which we refuse outright. */
  denyRatio: 0.94,
  /** Projected VRAM / VRAM capacity at which we ask. */
  vramAskRatio: 0.85,
  /** Projected VRAM / VRAM capacity at which we refuse outright. */
  vramDenyRatio: 0.97,
  /** Estimates below this size are never gated. */
  minEstimateGb: 4,
  /** Watch a call while it runs and annotate its result when it crossed the line. */
  breaker: true,
  /** Observed commit / commit-limit that counts as a breach. */
  breakerRatio: 0.92,
  /** Write a live resource budget into the system prompt of every session. */
  injectBudget: true,
  /** Feed observed peaks back into the estimators. */
  learn: true,
  /** Extra tool names always treated as heavy. */
  tools: [],
  /** Extra debug logging to stderr. */
  debug: false,
}

const NUMERIC = {
  reserveGb: [0, 256],
  askRatio: [0.3, 0.99],
  denyRatio: [0.4, 1],
  vramAskRatio: [0.3, 0.99],
  vramDenyRatio: [0.4, 1],
  minEstimateGb: [0, 512],
  breakerRatio: [0.5, 1],
}

const MODES = new Set(['ask', 'deny', 'warn'])
const SCOPES = new Set(['heavy', 'all'])

function finiteNumber(value, fallback, [min, max]) {
  const n = typeof value === 'number' ? value : Number.parseFloat(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Merge a raw patch config over the defaults, clamping every value into range. */
export function readConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const config = { ...DEFAULTS }

  for (const [key, [min, max]] of Object.entries(NUMERIC)) {
    config[key] = finiteNumber(source[key], DEFAULTS[key], [min, max])
  }

  config.enabled = source.enabled === undefined ? DEFAULTS.enabled : Boolean(source.enabled)
  config.breaker = source.breaker === undefined ? DEFAULTS.breaker : Boolean(source.breaker)
  config.injectBudget = source.injectBudget === undefined ? DEFAULTS.injectBudget : Boolean(source.injectBudget)
  config.learn = source.learn === undefined ? DEFAULTS.learn : Boolean(source.learn)
  config.debug = source.debug === undefined ? DEFAULTS.debug : Boolean(source.debug)

  config.mode = MODES.has(source.mode) ? source.mode : DEFAULTS.mode
  config.scope = SCOPES.has(source.scope) ? source.scope : DEFAULTS.scope

  config.tools = Array.isArray(source.tools)
    ? source.tools.filter((name) => typeof name === 'string' && name.length > 0)
    : []

  // A deny threshold below the ask threshold would make 'ask' unreachable.
  if (config.denyRatio < config.askRatio) config.denyRatio = config.askRatio
  if (config.vramDenyRatio < config.vramAskRatio) config.vramDenyRatio = config.vramAskRatio

  return config
}
