/** Compare an estimate against the live machine and produce a bilingual verdict. */

export function judge(plan, snapshot, config) {
  const limit = snapshot.commitLimitGb
  const used = snapshot.commitUsedGb
  const projected = used + plan.commitGb
  const commitRatio = limit > 0 ? projected / limit : 0
  const physicalAfter = snapshot.availPhysGb - plan.commitGb

  let vramProjected = null
  let vramRatio = 0
  if (snapshot.vramCapGb > 0 && snapshot.vramUsedGb !== null) {
    vramProjected = snapshot.vramUsedGb + plan.vramGb
    vramRatio = vramProjected / snapshot.vramCapGb
  }

  const belowFloor =
    plan.commitGb < config.minEstimateGb && (vramProjected === null || plan.vramGb < config.minEstimateGb)

  const verdict = {
    level: 'ok',
    commitRatio,
    vramRatio,
    projected,
    vramProjected,
    physicalAfter,
    belowFloor,
  }
  if (belowFloor) return verdict

  const hard =
    commitRatio >= config.denyRatio || (vramProjected !== null && vramRatio >= config.vramDenyRatio)
  const soft =
    commitRatio >= config.askRatio ||
    (vramProjected !== null && vramRatio >= config.vramAskRatio) ||
    physicalAfter < config.reserveGb

  verdict.level = hard ? 'deny' : soft ? 'ask' : 'ok'
  if (verdict.level === 'ok') return verdict

  verdict.suggestedWorkers = suggestWorkers(plan, snapshot, config)
  verdict.zh = describe('zh', verdict.level, plan, snapshot, verdict, config)
  verdict.en = describe('en', verdict.level, plan, snapshot, verdict, config)
  return verdict
}

function suggestWorkers(plan, snapshot, config) {
  const perWorker = plan.workers > 0 ? (plan.commitGb - 0.6) / plan.workers : plan.commitGb
  if (!Number.isFinite(perWorker) || perWorker <= 0) return 1
  const room = Math.max(0, snapshot.commitLimitGb * config.askRatio - snapshot.commitUsedGb)
  return Math.max(1, Math.min(plan.workers, Math.floor(room / perWorker)))
}

function describe(locale, level, plan, snapshot, verdict, config) {
  const pct = Math.round(verdict.commitRatio * 100)
  const workers = verdict.suggestedWorkers
  const vramLine = (label) =>
    verdict.vramProjected === null
      ? ''
      : locale === 'zh'
        ? `显存预计 ${verdict.vramProjected.toFixed(1)} / ${snapshot.vramCapGb.toFixed(1)} GB（${Math.round(
            verdict.vramRatio * 100,
          )}%）。`
        : `VRAM projected ${verdict.vramProjected.toFixed(1)} / ${snapshot.vramCapGb.toFixed(1)} GB (${Math.round(
            verdict.vramRatio * 100,
          )}%).`

  if (locale === 'zh') {
    const head = level === 'deny' ? '资源门禁拒绝：预计会击穿本机上限。' : '资源门禁：本次调用预计占用较大，需要你确认。'
    return [
      head,
      `${plan.toolName} 预估峰值提交 ${plan.commitGb.toFixed(1)} GB（${plan.reasons.join('；')}）。`,
      `当前已提交 ${snapshot.commitUsedGb.toFixed(1)} / ${snapshot.commitLimitGb.toFixed(1)} GB，调用后预计达到 ${verdict.projected.toFixed(1)} GB（${pct}%）。`,
      vramLine('zh'),
      `物理内存调用后约余 ${verdict.physicalAfter.toFixed(1)} GB。`,
      level === 'deny'
        ? `建议把并发降到 ${workers} 路以下再执行，或先关闭占用大的程序。`
        : `建议并发不超过 ${workers} 路；确认继续将按当前参数执行。`,
    ]
      .filter(Boolean)
      .join(' ')
  }

  const head =
    level === 'deny'
      ? 'Resource gate refused: this call is projected to exceed a hard limit.'
      : 'Resource gate: this call is projected to be heavy and needs your confirmation.'
  return [
    head,
    `${plan.toolName} estimated peak commit ${plan.commitGb.toFixed(1)} GB (${plan.reasons.join('; ')}).`,
    `Committed now ${snapshot.commitUsedGb.toFixed(1)} / ${snapshot.commitLimitGb.toFixed(1)} GB; projected ${verdict.projected.toFixed(1)} GB (${pct}%).`,
    vramLine('en'),
    `Physical memory left afterwards about ${verdict.physicalAfter.toFixed(1)} GB.`,
    level === 'deny'
      ? `Lower concurrency to ${workers} or fewer, or close the large programs first.`
      : `Keep concurrency at ${workers} or below; confirming runs it as specified.`,
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * The live budget block that every session sees, so the model plans within the
 * machine instead of guessing (and then spawning six 6 GB processes).
 */
export function budgetText(snapshot, hardware, config) {
  const totalPhys = snapshot.totalPhysGb.toFixed(1)
  const availPhys = snapshot.availPhysGb.toFixed(1)
  const usedCommit = snapshot.commitUsedGb.toFixed(1)
  const limitCommit = snapshot.commitLimitGb.toFixed(1)
  const freeCommit = snapshot.commitFreeGb.toFixed(1)
  const vramCap = snapshot.vramCapGb
  const vramUsed = snapshot.vramUsedGb

  const perWorker = 3.2
  const room = Math.max(0, snapshot.commitLimitGb * config.askRatio - snapshot.commitUsedGb)
  const safeWorkers = Math.max(1, Math.min(Math.floor(snapshot.cores / 2), Math.floor(room / perWorker)))

  const gpuLine =
    vramCap > 0
      ? `显卡 ${gpuName(hardware)} ${vramCap.toFixed(1)} GB${vramUsed === null ? '（占用未采到）' : `（已用 ${vramUsed.toFixed(1)} GB）`}`
      : '显卡信息未采到'

  const lines = [
    '## 本机资源预算（resource-guard 实时观测）',
    `- CPU：${snapshot.cpuModel}，${snapshot.cores} 线程`,
    `- 内存：物理 ${totalPhys} GB（可用 ${availPhys} GB）｜提交 ${usedCommit} / ${limitCommit} GB（余 ${freeCommit}）`,
    `- ${gpuLine}`,
    `- 安全并发：≤ ${safeWorkers} 路（按单进程 ${perWorker} GB 估）`,
    `- 单次预计峰值超过 ${config.minEstimateGb} GB 的工具调用会先要求用户确认；低于此值不打扰`,
  ]

  if (!snapshot.fresh) lines.push('- 注意：采样器暂未就绪，以上内存数字来自系统兜底值')

  lines.push(
    `- 经验：本机 qwen3-aligner 单进程峰值约 6 GB，6 路并发曾在 8 秒内击穿提交上限并拖垮桌面。批量任务请先算「可用提交 ÷ 单进程峰值」再定并发。`,
  )

  return lines.join('\n')
}

function gpuName(hardware) {
  if (!hardware || !Array.isArray(hardware.gpus) || hardware.gpus.length === 0) return '未知型号'
  let best = hardware.gpus[0]
  for (const gpu of hardware.gpus) {
    if (Number.isFinite(gpu.vram) && gpu.vram > (best.vram ?? 0)) best = gpu
  }
  return String(best.name)
}
