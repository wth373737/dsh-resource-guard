import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Roots a package may be resolved from. The Host process does not necessarily
 * export DSH_PROFILE_DIR (it is set for shells it spawns), so the profiles under
 * DSH_HOME are scanned as well — that is the layout that actually exists.
 */
function baseCandidates() {
  const bases = []
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0 && !bases.includes(value)) bases.push(value)
  }

  push(process.env.DSH_PROFILE_DIR)

  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.length > 0) {
    const profiles = path.join(home, 'profiles')
    try {
      for (const entry of fs.readdirSync(profiles, { withFileTypes: true })) {
        if (entry.isDirectory()) push(path.join(profiles, entry.name))
      }
    } catch {
      // No profiles directory: this install boots without one.
    }
  }

  return bases
}

/**
 * A plugin installed by absolute path cannot resolve the profile's packages, but
 * the settings page is projected from a schemastery schema and has to be the very
 * same module instance the Harness loaded — a second copy would produce schemas
 * the projection does not recognise.
 *
 * So: try normal resolution first (works when the package is a declared
 * dependency), then resolve from a profile root and import the ESM build.
 */
export async function loadSchemastery(log) {
  try {
    const direct = await import('@deepseek-ai/schemastery')
    if (direct && direct.default) return direct.default
  } catch {
    // Not resolvable from the plugin directory: fall through.
  }

  for (const base of baseCandidates()) {
    try {
      const require = createRequire(path.join(base, 'package.json'))
      const entry = require.resolve('@deepseek-ai/schemastery')
      const root = path.resolve(path.dirname(entry), '..')
      const esm = path.join(root, 'lib', 'index.mjs')
      const loaded = await import(pathToFileURL(esm).href)
      if (loaded && loaded.default) return loaded.default
    } catch (error) {
      log?.('warn', 'schemastery not resolvable from base', {
        base,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return null
}

/**
 * Build the Config schema. Field descriptions are what the settings page shows
 * as help text, so they explain the knob instead of restating its name.
 */
export function buildConfigSchema(Schema) {
  return Schema.object({
    enabled: Schema.boolean().default(true).description('总开关。关闭后本插件完全不介入任何工具调用。'),
    mode: Schema.union(['ask', 'deny', 'warn'])
      .default('ask')
      .description('超预算时的动作：ask 弹审批问你，deny 直接拒绝，warn 只记录不拦。'),
    scope: Schema.union(['heavy', 'all'])
      .default('heavy')
      .description('heavy 只检查已知重活工具（shell、ollama_*、video_local_*、workflow/subagent）；all 检查每次调用。'),
    reserveGb: Schema.number().default(6).description('判断物理内存压力时，为系统和桌面预留的 GB 数。'),
    askRatio: Schema.number()
      .default(0.8)
      .description('预计提交 / 提交上限 超过此比例就询问。分页文件很小时应调低。'),
    denyRatio: Schema.number().default(0.94).description('超过此比例直接拒绝，不再询问。'),
    vramAskRatio: Schema.number().default(0.85).description('预计显存 / 显存容量 超过此比例就询问。'),
    vramDenyRatio: Schema.number().default(0.97).description('显存超过此比例直接拒绝。'),
    minEstimateGb: Schema.number().default(4).description('预估小于此 GB 数的调用直接放行，不再打扰。'),
    perWorkerGb: Schema.number()
      .default(3.2)
      .description('计算安全并发时假定的单进程峰值（GB）。有足够历史数据时会被实测中位数替代。'),
    breaker: Schema.boolean().default(true).description('调用运行中每秒采样，越线时在结果里追加熔断告警。'),
    breakerRatio: Schema.number().default(0.92).description('运行中提交占比超过此值就算越线。'),
    injectBudget: Schema.boolean().default(true).description('把实时资源预算写进系统提示，让模型按机器能力规划并发。'),
    learn: Schema.boolean().default(true).description('把每次调用的实测峰值回填到估算画像。'),
    autoTune: Schema.union(['off', 'suggest', 'apply'])
      .default('suggest')
      .description('off 不生成建议；suggest 只生成依据文档；apply 生成文档并把本机推荐值写入配置。'),
    tools: Schema.array(Schema.string()).default([]).description('额外强制纳入门禁的工具名。'),
    debug: Schema.boolean().default(false).description('同时把诊断日志写到 stderr。'),
  })
}
