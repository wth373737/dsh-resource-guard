import fs from 'node:fs'

import { GIB } from './probe.js'

/** Tools whose arguments are a command line that can spawn anything. */
const SHELL_TOOLS = new Set(['pwsh', 'win_bash', 'terminal_send', 'terminal_open'])

/** Tools that fan out into several agents, each with its own memory footprint. */
const FANOUT_TOOLS = new Set(['workflow', 'subagent', 'subagent_fork'])

const WORKER_PATTERNS = [
  /max_workers\s*[=:]\s*(\d+)/gim,
  /--jobs\s*[=\s]\s*(\d+)/gim,
  /(?:^|[^\w-])-j\s*(\d+)/gim,
  /(?:^|[^\w-])-P\s*(\d+)/gim,
  /--threads\s*[=\s]\s*(\d+)/gim,
  /-ThrottleLimit\s+(\d+)/gim,
  /--parallel\s+(\d+)/gim,
  /--concurrency\s*[=\s]\s*(\d+)/gim,
]

const BINARIES = [
  'qwen3-aligner',
  'ollama',
  'python3',
  'python',
  'py',
  'ffmpeg',
  'melt',
  'kdenlive',
  'pnpm',
  'npm',
  'node',
  'java',
  'dotnet',
  'pip',
  'torch',
]

/**
 * Peak committed memory one worker of this binary family reaches in practice.
 * 6 GB for the forced aligner is measured on this machine: 1.75 GB of weights
 * plus the CPU torch arena and librosa/numba caches.
 */
const PER_WORKER_GB = {
  'qwen3-aligner': 6,
  python: 3.2,
  python3: 3.2,
  py: 3.2,
  torch: 3.2,
  pip: 1.5,
  ffmpeg: 1.2,
  melt: 2,
  kdenlive: 3,
  node: 1.2,
  pnpm: 1.6,
  npm: 1.6,
  java: 2.5,
  dotnet: 1.6,
  ollama: 6,
  default: 1.2,
}

const MODEL_PATH = /[A-Za-z]:\\[^"'\r\n|<>;]*?\.(?:safetensors|gguf|onnx|pt|pth|ckpt|bin)\b/gi

/** A command usually names a script; the concurrency lives inside the file. */
const SCRIPT_PATH = /[A-Za-z]:\\[^"'\r\n|<>;]*?\.(?:py|ps1|sh|js|mjs|cjs|bat|cmd)\b/gi
const MAX_SCRIPT_BYTES = 1024 * 1024
const MAX_SCAN_CHARS = 64 * 1024

const TORCH_MARKERS = /(torch|transformers|onnxruntime|diffusers|librosa|soundfile|sentence_transformers)/i

/**
 * Decide whether a call can plausibly be expensive, and estimate its peak.
 * Returns null for calls this plugin should not look at.
 */
export function analyzeCall(exec, config, history, probe) {
  const name = String(exec.name || '')
  const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}
  const forcedHeavy = config.tools.includes(name)

  if (!forcedHeavy && config.scope !== 'all' && !isHeavyTool(name)) return null

  if (SHELL_TOOLS.has(name) || forcedHeavy || config.scope === 'all') {
    const command = commandText(args)
    if (command.length === 0) return null
    return estimateShell(name, command, config, history, probe)
  }

  if (name.startsWith('ollama_')) return estimateOllama(name, args, config, history)

  if (name.startsWith('video_local_')) {
    return buildPlan({
      name,
      signature: `${name}:default`,
      commitGb: 5.5,
      vramGb: 4,
      workers: 1,
      binary: name,
      confidence: 'low',
      reasons: ['视频/语音流水线按固定档位估计'],
      config,
      history,
    })
  }

  if (FANOUT_TOOLS.has(name)) {
    return buildPlan({
      name,
      signature: `${name}:fanout`,
      commitGb: 4,
      vramGb: 0.5,
      workers: 2,
      binary: name,
      confidence: 'low',
      reasons: ['多智能体扇出，按 2 个子进程估计'],
      config,
      history,
    })
  }

  return null
}

function isHeavyTool(name) {
  return SHELL_TOOLS.has(name) || FANOUT_TOOLS.has(name) || name.startsWith('ollama_') || name.startsWith('video_local_')
}

function commandText(args) {
  for (const key of ['command', 'script', 'text', 'cmd']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return ''
}

function estimateShell(name, command, config, history, probe) {
  const expanded = expandScripts(command)
  const scan = expanded.text
  const workers = countWorkers(scan)
  const binary = detectBinary(scan)
  const isAligner = /qwen3-aligner/i.test(scan)
  const torchish = TORCH_MARKERS.test(scan)
  const modelGb = modelBytes(command) / GIB

  let perWorker = isAligner ? PER_WORKER_GB['qwen3-aligner'] : PER_WORKER_GB[binary] ?? PER_WORKER_GB.default
  if (!isAligner && binary && (binary === 'python' || binary === 'python3' || binary === 'py') && torchish) {
    perWorker = PER_WORKER_GB.python
  }
  if (binary === null && workers > 1) perWorker = PER_WORKER_GB.default

  const base = 0.6
  let commitGb = base + workers * perWorker
  if (workers === 1 && modelGb > 0.5 && perWorker < 3) commitGb += modelGb * 1.4

  let vramGb = 0.4
  if (isAligner) vramGb = 0
  if (binary === 'ffmpeg' && /nvenc|amf|qsv|vaapi|hevc_amf|h264_amf/i.test(command)) vramGb = 1.5
  if (binary === 'ollama') vramGb = 6

  const reasons = []
  if (workers > 1) reasons.push(`检测到 ${workers} 路并发`)
  if (expanded.scripts.length > 0) reasons.push(`已读取脚本 ${expanded.scripts.join('、')}`)
  if (isAligner) reasons.push('qwen3-aligner 每进程实测峰值约 6 GB')
  else if (torchish) reasons.push('PyTorch/ONNX 类进程按 3.2 GB/进程估计')
  if (modelGb > 0.5) reasons.push(`引用了 ${modelGb.toFixed(1)} GB 的模型文件`)
  if (reasons.length === 0) reasons.push(binary ? `按 ${binary} 的常规占用估计` : '未知命令，按保守基线估计')

  let confidence = 'low'
  if (isAligner) confidence = 'medium'
  if (workers > 1 && binary !== null) confidence = 'medium'
  if (expanded.scripts.length > 0 && workers > 1) confidence = 'high'

  return buildPlan({
    name,
    signature: `${binary ?? 'shell'}:w${workers}${isAligner ? ':aligner' : ''}`,
    commitGb,
    vramGb,
    workers,
    binary: binary ?? 'shell',
    confidence,
    reasons,
    config,
    history,
  })
}

function estimateOllama(name, args, config, history) {
  const items = Array.isArray(args.items) ? args.items.length : 0
  const concurrency = pickInteger(args.concurrency, 2, 1, 8)
  const modelGb = detectOllamaModelGb(args)
  const commitGb = 1.2 + concurrency * modelGb
  const vramGb = modelGb + (concurrency - 1) * Math.max(1, modelGb * 0.15)

  const reasons = [`本地模型约 ${modelGb.toFixed(1)} GB × ${concurrency} 并发`]
  if (items > 0) reasons.push(`批量 ${items} 条`)

  return buildPlan({
    name,
    signature: `${name}:m${Math.round(modelGb)}:c${concurrency}`,
    commitGb,
    vramGb,
    workers: concurrency,
    binary: name,
    confidence: 'medium',
    reasons,
    config,
    history,
  })
}

function detectOllamaModelGb(args) {
  const tag = typeof args.model === 'string' ? args.model : ''
  if (/70b|72b|65b/i.test(tag)) return 40
  if (/32b|34b/i.test(tag)) return 20
  if (/14b|13b/i.test(tag)) return 9
  if (/8b|7b/i.test(tag)) return 5
  if (/3b|4b/i.test(tag)) return 2.5
  if (/1\.5b|0\.5b|1b/i.test(tag)) return 1.2
  return 5
}

function countWorkers(command) {
  let max = 1
  let parallelKeyword = false
  for (const pattern of WORKER_PATTERNS) {
    pattern.lastIndex = 0
    let match = pattern.exec(command)
    while (match !== null) {
      const value = Number.parseInt(match[1], 10)
      if (Number.isFinite(value) && value > max && value <= 256) max = value
      match = pattern.exec(command)
    }
  }
  if (/ForEach-Object\s+-Parallel/i.test(command)) {
    parallelKeyword = true
    if (max === 1) max = 5
  }
  if (/xargs[^\r\n]*\s-P/i.test(command) && max === 1) max = 8
  if (parallelKeyword) return max
  return max
}

function detectBinary(command) {
  const haystack = command.toLowerCase()
  for (const binary of BINARIES) {
    const pattern = new RegExp(`(?:^|[^\\w-])${binary.replace('.', '\\.')}(?:[^\\w-]|$)`, 'i')
    if (pattern.test(haystack)) return binary
  }
  return null
}

/**
 * A one-line command like `py -3.12 align_parallel.py` hides its real shape in
 * the file. Reading that file is what turns "1 worker" into "6 workers, six
 * 6 GB aligners" before the processes exist.
 */
function expandScripts(command) {
  const files = new Set()
  SCRIPT_PATH.lastIndex = 0
  let match = SCRIPT_PATH.exec(command)
  while (match !== null && files.size < 3) {
    files.add(match[0])
    match = SCRIPT_PATH.exec(command)
  }

  let text = command
  const scripts = []
  for (const file of files) {
    try {
      const stat = fs.statSync(file, { throwIfNoEntry: false })
      if (!stat || !stat.isFile() || stat.size > MAX_SCRIPT_BYTES) continue
      const content = fs.readFileSync(file, 'utf8').slice(0, MAX_SCAN_CHARS)
      text += `\n${content}`
      scripts.push(file.split(/[\\/]/).pop())
    } catch {
      // Unreadable script: keep the command-line estimate.
    }
  }
  return { text, scripts }
}

function modelBytes(command) {
  const found = new Set()
  MODEL_PATH.lastIndex = 0
  let match = MODEL_PATH.exec(command)
  while (match !== null && found.size < 4) {
    found.add(match[0])
    match = MODEL_PATH.exec(command)
  }
  let total = 0
  for (const file of found) {
    try {
      const stat = fs.statSync(file, { throwIfNoEntry: false })
      if (stat && stat.isFile()) total += stat.size
    } catch {
      // Referenced but unreadable: fall through with no contribution.
    }
  }
  return total
}

function pickInteger(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/**
 * Merge the rule estimate with this machine's observed peaks for the same
 * signature, then clamp to something a human can act on.
 */
function buildPlan(input) {
  const learned = input.history ? input.history.lookup(input.signature) : null
  let commitGb = input.commitGb
  let vramGb = input.vramGb
  let confidence = input.confidence
  const reasons = [...input.reasons]

  if (learned && learned.runs > 0) {
    const observed = learned.peakCommitGb * 1.05
    if (observed > commitGb) {
      commitGb = observed
      reasons.push(`本机同类任务实测峰值 ${learned.peakCommitGb.toFixed(1)} GB`)
      confidence = 'high'
    } else {
      confidence = 'high'
    }
    if (learned.peakVramGb > vramGb) vramGb = learned.peakVramGb * 1.05
  }

  return {
    heavy: true,
    toolName: input.name,
    signature: input.signature,
    binary: input.binary,
    workers: input.workers,
    commitGb: round1(Math.min(commitGb, 512)),
    vramGb: round1(Math.min(vramGb, 128)),
    confidence,
    reasons,
  }
}

function round1(value) {
  return Math.round(value * 10) / 10
}
