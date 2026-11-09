/**
 * Turn measured hardware into recommended thresholds, and explain every number
 * by the hardware fact it came from. The document is the point: a value without
 * a reason is just a default someone else picked.
 */

function round1(value) {
  return Math.round(value * 10) / 10
}

function round2(value) {
  return Math.round(value * 100) / 100
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function gpuLabel(hardware) {
  if (!hardware || !Array.isArray(hardware.gpus) || hardware.gpus.length === 0) return '未识别显卡'
  let best = hardware.gpus[0]
  for (const gpu of hardware.gpus) {
    if (Number.isFinite(gpu.vram) && gpu.vram > (best.vram ?? 0)) best = gpu
  }
  return String(best.name)
}

export function recommend({ snapshot, hardware, config, history }) {
  const totalPhys = round1(snapshot.totalPhysGb)
  const commitLimit = round1(snapshot.commitLimitGb)
  const pagefile = round1(Math.max(0, commitLimit - totalPhys))
  const ratio = totalPhys > 0 ? commitLimit / totalPhys : 1
  const vram = round1(snapshot.vramCapGb)
  const gpu = gpuLabel(hardware)
  const tight = ratio < 1.15

  const askRatio = tight ? 0.78 : 0.82
  const denyRatio = round2(Math.min(0.96, askRatio + 0.16))
  const reserveGb = clamp(Math.round(totalPhys * 0.1), 4, 16)
  const minEstimateGb = clamp(Math.round(commitLimit * 0.06), 2, 12)
  const breakerRatio = round2(clamp(askRatio + 0.12, 0.6, 0.95))
  const vramAskRatio = vram >= 16 ? 0.85 : vram >= 8 ? 0.8 : 0.75
  const vramDenyRatio = vram >= 16 ? 0.97 : vram >= 8 ? 0.92 : 0.9

  const stats = history && typeof history.stats === 'function' ? history.stats() : { entries: 0, medianPeakGb: 0 }
  const learned = stats.entries >= 3 && stats.medianPeakGb > 0
  const perWorkerGb = learned ? round1(clamp(stats.medianPeakGb, 0.5, 32)) : config.perWorkerGb

  const values = {
    askRatio,
    denyRatio,
    reserveGb,
    minEstimateGb,
    breakerRatio,
    vramAskRatio,
    vramDenyRatio,
    perWorkerGb,
  }

  const rows = [
    {
      key: 'askRatio',
      value: askRatio,
      because: `提交上限 ${commitLimit} GB ÷ 物理内存 ${totalPhys} GB = ${ratio.toFixed(
        2,
      )}，分页文件只有 ${pagefile} GB${
        tight ? '，几乎没有溢出空间，所以询问线压到 78%' : '，溢出空间尚可，询问线可以放宽到 82%'
      }`,
    },
    {
      key: 'denyRatio',
      value: denyRatio,
      because: `超过此比例即拒绝，硬留 ${round1(commitLimit * (1 - denyRatio))} GB 给系统、DWM 与输入法；上次事故里桌面正是在提交耗尽后崩掉的`,
    },
    {
      key: 'breakerRatio',
      value: breakerRatio,
      because: `询问线 ${askRatio} + 12 个百分点；运行中只要逼近询问线就该告警，而不是等它越过去`,
    },
    {
      key: 'reserveGb',
      value: reserveGb,
      because: `按物理内存的 10% 保留（${totalPhys} GB × 10% ≈ ${reserveGb} GB），避免把游戏或剪辑软件这类常驻程序挤到换页`,
    },
    {
      key: 'minEstimateGb',
      value: minEstimateGb,
      because: `提交上限的 6%（${commitLimit} GB × 6% ≈ ${minEstimateGb} GB）；低于这个量级的调用不值得打断你`,
    },
    {
      key: 'vramAskRatio',
      value: vramAskRatio,
      because:
        vram >= 16
          ? `显存 ${vram} GB（${gpu}），容量充裕，85% 之前不必打扰`
          : `显存 ${vram} GB（${gpu}），容量偏小、碎片化明显，占用到 ${Math.round(vramAskRatio * 100)}% 就该问`,
    },
    {
      key: 'vramDenyRatio',
      value: vramDenyRatio,
      because: `显存到 ${Math.round(vramDenyRatio * 100)}% 时新分配大概率失败，再排除已用之外没有意义`,
    },
    {
      key: 'perWorkerGb',
      value: perWorkerGb,
      because: learned
        ? `本机历史 ${stats.entries} 条实测，单进程提交峰值中位数 ${stats.medianPeakGb.toFixed(1)} GB`
        : `历史样本不足（${stats.entries} 条），沿用保守默认 ${config.perWorkerGb} GB；跑过几轮会自动收紧`,
    },
  ]

  return {
    values,
    rows,
    facts: {
      cpuModel: snapshot.cpuModel,
      cores: snapshot.cores,
      totalPhys,
      pagefile,
      commitLimit,
      vram,
      gpu,
      ratio,
    },
  }
}

export function renderRecommendation({ values, rows, facts, at = new Date() }) {
  const stamp = at.toISOString().replace('T', ' ').slice(0, 19)
  const lines = [
    '# resource-guard 配置建议',
    '',
    `生成时间：${stamp}（每次启动按当时的硬件与历史重新生成，不会覆盖你的设置）`,
    '',
    '## 本机实测',
    '',
    `- CPU：${facts.cpuModel}，${facts.cores} 线程`,
    `- 内存：物理 ${facts.totalPhys} GB｜分页文件 ${facts.pagefile} GB｜提交上限 ${facts.commitLimit} GB`,
    `- 显卡：${facts.gpu}，显存 ${facts.vram} GB`,
    '',
    '## 建议值及依据',
    '',
    '| 参数 | 建议 | 依据（来自哪项硬件属性） |',
    '| --- | --- | --- |',
    ...rows.map((row) => `| \`${row.key}\` | ${row.value} | ${row.because} |`),
    '',
    '## 怎么应用',
    '',
    '在 **设置 → 资源门禁** 里直接改这几个值，或把它们写进 profile 的 `cordis.patch.yml`。',
    '',
    '`autoTune` 设为 `apply` 时，插件会在硬件指纹变化后自动写入上表；默认 `suggest` 只生成这份文档，不碰你的配置。',
    '',
  ]

  if (facts.ratio < 1.15) {
    lines.push(
      '## 一句提醒',
      '',
      `提交上限只比物理内存多 ${round1(facts.commitLimit - facts.totalPhys)} GB，这是本机真正的瓶颈。把分页文件调到 32 GB 之后，\`askRatio\` 可以回到 0.82、\`denyRatio\` 回到 0.96，这套阈值就不必那么紧。`,
      '',
    )
  }

  return lines.join('\n')
}

export { round1, round2, clamp }
