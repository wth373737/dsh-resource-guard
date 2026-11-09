import os from 'node:os'
import path from 'node:path'

import { readConfig } from './lib/config.js'
import { createLogger } from './lib/log.js'
import { Probe } from './lib/probe.js'
import { History } from './lib/history.js'
import { analyzeCall } from './lib/estimate.js'
import { judge, budgetText } from './lib/verdict.js'

export const inject = ['tools']

const TICK_MS = 1000
const MIN_LEARNABLE_MS = 1200
const DRIFT_THRESHOLD = 0.6
const STALE_RECORD_MS = 30 * 60 * 1000

/**
 * Predictive resource gate for the Harness.
 *
 * Two mechanisms, both fail-open:
 *   - `tools/pre-execute` estimates a heavy call and turns it into an approval
 *     question (or a refusal) before anything is spawned.
 *   - `tools/post-execute` reports the peak the call actually reached and feeds
 *     it back into the per-signature estimator.
 */
export function apply(ctx, raw) {
  const config = readConfig(raw)
  if (!config.enabled) return

  const directory = dataDirectory()
  const log = createLogger(directory, config.debug)
  const probe = new Probe(log)
  const history = new History(directory, log, config.learn)
  const active = new Map()
  let ticker = null

  probe.start()
  ctx.effect(() => () => probe.dispose())
  ctx.effect(() => () => history.dispose())

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt && config.injectBudget) {
    ctx.effect(() =>
      systemPrompt.context({
        name: 'resource-guard-budget',
        order: 150,
        text: () => safeBudgetText(),
      }),
    )
  }

  function safeBudgetText() {
    try {
      return budgetText(probe.snapshot(), probe.hardware(), config)
    } catch {
      return '## 本机资源预算\n- 资源采样暂不可用；大任务请先自行确认并发与内存需求。'
    }
  }

  function stopTicker() {
    if (ticker === null) return
    clearInterval(ticker)
    ticker = null
  }

  function ensureTicker() {
    if (ticker !== null) return
    ticker = setInterval(() => {
      try {
        if (active.size === 0) {
          stopTicker()
          return
        }
        const snapshot = probe.snapshot()
        const ratio = snapshot.commitLimitGb > 0 ? snapshot.commitUsedGb / snapshot.commitLimitGb : 0
        const now = Date.now()
        for (const [id, record] of active) {
          // A call that was asked and then declined never reaches post-execute.
          if (now - record.startedAt > STALE_RECORD_MS) {
            active.delete(id)
            continue
          }
          if (snapshot.commitUsedGb > record.peakCommitGb) record.peakCommitGb = snapshot.commitUsedGb
          if (snapshot.vramUsedGb !== null && snapshot.vramUsedGb > record.peakVramGb) {
            record.peakVramGb = snapshot.vramUsedGb
          }
          if (ratio >= config.breakerRatio) record.breached = true
        }
      } catch (error) {
        log('error', 'breaker tick failed', { message: messageOf(error) })
      }
    }, TICK_MS)
    if (typeof ticker.unref === 'function') ticker.unref()
  }

  function remember(exec, plan, verdict, snapshot) {
    if (!config.breaker) return
    const id = exec.callId === undefined || exec.callId === null ? '' : String(exec.callId)
    if (id.length === 0) return
    active.set(id, {
      toolName: plan.toolName,
      signature: plan.signature,
      estimateGb: plan.commitGb,
      estimateVramGb: plan.vramGb,
      startedAt: Date.now(),
      baselineCommitGb: snapshot.commitUsedGb,
      baselineVramGb: snapshot.vramUsedGb ?? 0,
      peakCommitGb: snapshot.commitUsedGb,
      peakVramGb: snapshot.vramUsedGb ?? 0,
      breached: false,
      level: verdict.level,
    })
    ensureTicker()
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const plan = analyzeCall(exec, config, history, probe)
      if (!plan) return next()

      const snapshot = probe.snapshot()
      const verdict = judge(plan, snapshot, config)

      if (verdict.level === 'ok' || config.mode === 'warn' || verdict.belowFloor) {
        remember(exec, plan, verdict, snapshot)
        return next()
      }

      if (verdict.level === 'deny' || config.mode === 'deny') {
        log('warn', 'denied over-budget call', {
          tool: plan.toolName,
          workers: plan.workers,
          estimateGb: plan.commitGb,
          projectedPct: Math.round(verdict.commitRatio * 100),
        })
        return {
          kind: 'deny',
          reason: verdict.zh,
          info: { name: 'resource-guard', code: 'over-budget', reason: verdict.zh },
        }
      }

      remember(exec, plan, verdict, snapshot)
      log('info', 'asking for over-budget call', {
        tool: plan.toolName,
        workers: plan.workers,
        estimateGb: plan.commitGb,
        projectedPct: Math.round(verdict.commitRatio * 100),
      })
      return {
        kind: 'ask',
        reason: verdict.zh,
        displayReason: { en: verdict.en, zh: verdict.zh },
      }
    } catch (error) {
      log('error', 'pre-execute failed, allowing', { message: messageOf(error) })
      return next()
    }
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    let note = null
    try {
      const id = exec.callId === undefined || exec.callId === null ? '' : String(exec.callId)
      const record = active.get(id)
      if (record) {
        active.delete(id)
        if (active.size === 0) stopTicker()
      }
      if (record) note = observe(record, result)
    } catch (error) {
      log('error', 'post-execute failed', { message: messageOf(error) })
    }

    const decision = await next()
    if (note === null || !decision || decision.kind !== 'accept') return decision
    return appendNote(decision, result, note)
  })

  function observe(record, result) {
    const snapshot = probe.snapshot()
    const durationMs = Date.now() - record.startedAt
    const peakCommitGb = Math.max(record.peakCommitGb, snapshot.commitUsedGb)
    const peakVramGb = Math.max(record.peakVramGb, snapshot.vramUsedGb ?? 0)

    // History stores what THIS task added over its own baseline. Storing the
    // system-wide total would teach the estimator that every shell call needs
    // the whole machine.
    const deltaCommitGb = Math.max(0, peakCommitGb - record.baselineCommitGb)
    const deltaVramGb = Math.max(0, peakVramGb - record.baselineVramGb)

    if (config.learn && durationMs >= MIN_LEARNABLE_MS) {
      history.record(record.signature, { peakCommitGb: deltaCommitGb, peakVramGb: deltaVramGb })
    }

    const drift = Math.abs(deltaCommitGb - record.estimateGb) / Math.max(1, record.estimateGb)
    const drifted = record.estimateGb >= config.minEstimateGb && drift >= DRIFT_THRESHOLD
    if (!record.breached && !drifted) return null

    log('warn', record.breached ? 'breaker breach' : 'estimate drift', {
      tool: record.toolName,
      peakCommitGb: Number(peakCommitGb.toFixed(1)),
      deltaCommitGb: Number(deltaCommitGb.toFixed(1)),
      estimateGb: record.estimateGb,
      durationMs,
    })

    const limit = snapshot.commitLimitGb
    const pct = limit > 0 ? Math.round((peakCommitGb / limit) * 100) : 0
    const lines = []
    if (record.breached) {
      lines.push(
        `🛡 resource-guard 熔断：本次调用期间系统提交内存达到 ${peakCommitGb.toFixed(1)} / ${limit.toFixed(
          1,
        )} GB（${pct}%），超过 ${Math.round(config.breakerRatio * 100)}% 警戒线。`,
        '如果还有并发子进程在跑，请立即用 job_kill 或终止进程收敛；否则桌面同样会卡死。',
      )
    } else {
      lines.push(
        `🛡 resource-guard：本次调用自身峰值约 ${deltaCommitGb.toFixed(1)} GB，与预估 ${record.estimateGb.toFixed(
          1,
        )} GB 相差较大，已更新本机画像。`,
      )
    }
    if (snapshot.vramUsedGb !== null && snapshot.vramCapGb > 0) {
      lines.push(`显存峰值为 ${peakVramGb.toFixed(1)} / ${snapshot.vramCapGb.toFixed(1)} GB。`)
    }
    return { type: 'text', text: lines.join(' ') }
  }

  ctx.effect(() => () => {
    stopTicker()
    active.clear()
  })
}

function appendNote(decision, result, note) {
  if (Array.isArray(decision.content)) {
    return { ...decision, content: [...decision.content, note] }
  }
  if (decision.value !== undefined) return decision
  const fallback = result && Array.isArray(result.content) ? result.content : []
  return { ...decision, content: [...fallback, note] }
}

function dataDirectory() {
  const home = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  const base = home.length > 0 ? home : path.join(os.homedir(), '.dsh')
  return path.join(base, 'resource-guard')
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
