import os from 'node:os'
import { execFile, spawn } from 'node:child_process'

export const GIB = 1024 ** 3

const MEM_TICK_MS = 3000
const GPU_TICK_MS = 9000
const STALE_MS = 15000
const RESTART_MS = 5000

/**
 * Reads commit charge from GlobalMemoryStatusEx on a short loop: it costs a
 * fraction of a millisecond once the type is compiled, unlike Get-Counter which
 * blocks for a full sample interval.
 */
const MEM_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshResProbe {
  [StructLayout(LayoutKind.Sequential)]
  public struct MemStatus {
    public uint length;
    public uint load;
    public ulong totalPhys;
    public ulong availPhys;
    public ulong totalPage;
    public ulong availPage;
    public ulong totalVirt;
    public ulong availVirt;
    public ulong availExt;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GlobalMemoryStatusEx(ref MemStatus status);
}
'@
$status = New-Object 'DshResProbe+MemStatus'
$status.length = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($status)
while ($true) {
  [void][DshResProbe]::GlobalMemoryStatusEx([ref]$status)
  $obj = @{
    commit = [double]($status.totalPage - $status.availPage)
    limit  = [double]$status.totalPage
    avail  = [double]$status.availPhys
    total  = [double]$status.totalPhys
  }
  Write-Output ($obj | ConvertTo-Json -Compress)
  Start-Sleep -Milliseconds 3000
}
`

/**
 * Dedicated VRAM usage is only exposed through the WDDM performance counters.
 * One Get-Counter measurement blocks for about a second, so it runs on its own
 * loop at a slow cadence instead of on the memory loop.
 */
const GPU_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $sum = -1.0
  try {
    $sample = Get-Counter -Counter '\GPU Adapter Memory(*)\Dedicated Usage' -ErrorAction Stop
    $sum = 0.0
    foreach ($s in $sample.CounterSamples) { $sum += [double]$s.CookedValue }
  } catch {
    $sum = -1.0
  }
  Write-Output (@{ gpu = $sum } | ConvertTo-Json -Compress)
  Start-Sleep -Milliseconds 9000
}
`

/** One-shot hardware profile: adapters and capacity, page files, memory speed. */
const HW_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$gpus = @()
$base = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
Get-ChildItem $base -ErrorAction SilentlyContinue | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
  if ($p.DriverDesc) {
    $vram = 0.0
    $raw = $p.'HardwareInformation.qwMemorySize'
    if ($raw) { $vram = [double]$raw }
    $gpus += [pscustomobject]@{ name = [string]$p.DriverDesc; vram = $vram; driver = [string]$p.DriverVersion }
  }
}
$mm = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management'
$paging = @((Get-ItemProperty $mm -ErrorAction SilentlyContinue).PagingFiles)
$speed = @()
Get-CimInstance Win32_PhysicalMemory -ErrorAction SilentlyContinue | ForEach-Object { $speed += [int]$_.Speed }
[pscustomobject]@{ gpus = @($gpus); paging = $paging; memSpeed = $speed } | ConvertTo-Json -Depth 5 -Compress
`

function powershellArgs(script) {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ]
}

/**
 * Live machine telemetry plus a one-shot hardware profile.
 *
 * Every reading degrades rather than throws: when a sampler dies the snapshot
 * falls back to Node's own numbers and reports `fresh: false`.
 */
export class Probe {
  constructor(log) {
    this.log = log
    this.mem = null
    this.memAt = 0
    this.vramBytes = null
    this.vramAt = 0
    this.hw = null
    this.children = []
    this.disposed = false
  }

  start() {
    this.spawnLoop('memory', MEM_SCRIPT, (payload) => {
      if (!isFiniteNumber(payload.commit) || !isFiniteNumber(payload.limit)) return
      this.mem = {
        commit: payload.commit,
        limit: payload.limit,
        avail: payload.avail,
        total: payload.total,
      }
      this.memAt = Date.now()
    })
    this.spawnLoop('vram', GPU_SCRIPT, (payload) => {
      if (!isFiniteNumber(payload.gpu) || payload.gpu < 0) return
      this.vramBytes = payload.gpu
      this.vramAt = Date.now()
    })
    this.loadHardware()
  }

  spawnLoop(kind, script, onPayload, attempt = 0) {
    if (this.disposed) return
    let child
    try {
      child = spawn('powershell.exe', powershellArgs(script), {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch (error) {
      this.log('warn', `sampler ${kind} could not start`, { message: errorMessage(error) })
      return
    }

    const entry = { child, timer: null }
    this.children.push(entry)

    let attempts = attempt
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.length > 0) {
          try {
            onPayload(JSON.parse(line))
            attempts = 0
          } catch {
            // A sampler printing anything else is not fatal.
          }
        }
        newline = buffer.indexOf('\n')
      }
      if (buffer.length > 64 * 1024) buffer = ''
    })

    child.on('error', (error) => {
      this.log('warn', `sampler ${kind} errored`, { message: errorMessage(error) })
    })

    child.on('exit', (code) => {
      if (this.disposed) return
      const nextAttempt = attempts + 1
      this.log('warn', `sampler ${kind} exited`, { code, attempt: nextAttempt })
      if (nextAttempt > 5) {
        this.log('error', `sampler ${kind} gave up after repeated exits`)
        return
      }
      entry.timer = setTimeout(() => {
        entry.timer = null
        this.spawnLoop(kind, script, onPayload, nextAttempt)
      }, RESTART_MS)
      if (typeof entry.timer.unref === 'function') entry.timer.unref()
    })
  }

  loadHardware() {
    let child
    try {
      child = execFile(
        'powershell.exe',
        powershellArgs(HW_SCRIPT),
        { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            this.log('warn', 'hardware profile failed', { message: errorMessage(error) })
            return
          }
          try {
            const parsed = JSON.parse(String(stdout).trim())
            this.hw = {
              gpus: Array.isArray(parsed.gpus) ? parsed.gpus : [],
              paging: Array.isArray(parsed.paging) ? parsed.paging : [],
              memSpeed: Array.isArray(parsed.memSpeed) ? parsed.memSpeed : [],
            }
            this.log('info', 'hardware profile loaded', {
              gpus: this.hw.gpus.length,
              vramGb: Number(this.vramCapGb().toFixed(1)),
            })
          } catch (parseError) {
            this.log('warn', 'hardware profile not parseable', { message: errorMessage(parseError) })
          }
        },
      )
    } catch (error) {
      this.log('warn', 'hardware profile could not start', { message: errorMessage(error) })
      return
    }
    if (child && typeof child.unref === 'function') child.unref()
  }

  vramCapGb() {
    if (!this.hw || !Array.isArray(this.hw.gpus)) return 0
    let max = 0
    for (const gpu of this.hw.gpus) {
      if (isFiniteNumber(gpu.vram) && gpu.vram > max) max = gpu.vram
    }
    return max / GIB
  }

  vramLabel() {
    if (!this.hw || !Array.isArray(this.hw.gpus)) return 'unknown'
    let best = null
    for (const gpu of this.hw.gpus) {
      if (!best || (isFiniteNumber(gpu.vram) && gpu.vram > best.vram)) best = gpu
    }
    return best ? String(best.name) : 'unknown'
  }

  hardware() {
    return this.hw
  }

  /** Current readings, always usable even before the first sample arrives. */
  snapshot() {
    const now = Date.now()
    const memFresh = this.mem !== null && now - this.memAt < STALE_MS
    let total
    let avail
    let commitUsed
    let commitLimit
    if (memFresh) {
      total = numberOr(this.mem.total, os.totalmem())
      avail = numberOr(this.mem.avail, os.freemem())
      commitUsed = numberOr(this.mem.commit, Math.max(0, total - avail))
      commitLimit = numberOr(this.mem.limit, commitUsed)
    } else {
      total = os.totalmem()
      avail = os.freemem()
      commitUsed = Math.max(0, total - avail)
      commitLimit = Math.max(total, commitUsed)
    }

    const vramFresh = this.vramBytes !== null && now - this.vramAt < STALE_MS + GPU_TICK_MS
    const cpus = os.cpus()

    return {
      at: now,
      fresh: memFresh,
      totalPhysGb: total / GIB,
      availPhysGb: avail / GIB,
      commitUsedGb: commitUsed / GIB,
      commitLimitGb: commitLimit / GIB,
      commitFreeGb: Math.max(0, commitLimit - commitUsed) / GIB,
      vramCapGb: this.vramCapGb(),
      vramUsedGb: vramFresh ? this.vramBytes / GIB : null,
      cores: cpus.length,
      cpuModel: cpus[0] ? String(cpus[0].model).replace(/\s+/g, ' ').trim() : 'unknown',
    }
  }

  dispose() {
    this.disposed = true
    for (const entry of this.children) {
      if (entry.timer) clearTimeout(entry.timer)
      try {
        entry.child.kill()
      } catch {
        // Already gone.
      }
    }
    this.children = []
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function numberOr(value, fallback) {
  return isFiniteNumber(value) ? value : fallback
}

function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
