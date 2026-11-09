import fs from 'node:fs'
import path from 'node:path'

const MAX_ENTRIES = 400
const FLUSH_MS = 2500

/**
 * Per-signature peaks observed on this machine. History is a derived cache:
 * losing it costs accuracy, never correctness.
 */
export class History {
  constructor(directory, log, enabled = true) {
    this.directory = directory
    this.file = path.join(directory, 'history.json')
    this.log = log
    this.enabled = enabled
    this.entries = new Map()
    this.flushTimer = null
    this.load()
  }

  load() {
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return
    }
    if (!raw || typeof raw !== 'object' || !raw.entries || typeof raw.entries !== 'object') return
    for (const [key, value] of Object.entries(raw.entries)) {
      if (isEntry(value)) this.entries.set(key, value)
    }
  }

  lookup(signature) {
    return this.entries.get(signature) ?? null
  }

  record(signature, sample) {
    if (!this.enabled) return
    if (!Number.isFinite(sample.peakCommitGb) || sample.peakCommitGb <= 0) return
    const previous = this.entries.get(signature)
    const now = Date.now()
    // A small decay lets a one-off spike stop dominating once the workload shrinks.
    const entry = previous
      ? {
          runs: previous.runs + 1,
          peakCommitGb: round2(Math.max(previous.peakCommitGb * 0.98, sample.peakCommitGb)),
          peakVramGb: round2(Math.max(previous.peakVramGb * 0.98, sample.peakVramGb ?? 0)),
          lastAt: now,
        }
      : {
          runs: 1,
          peakCommitGb: round2(sample.peakCommitGb),
          peakVramGb: round2(sample.peakVramGb ?? 0),
          lastAt: now,
        }
    this.entries.set(signature, entry)
    this.scheduleFlush()
  }

  scheduleFlush() {
    if (this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, FLUSH_MS)
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref()
  }

  flush() {
    try {
      fs.mkdirSync(this.directory, { recursive: true })
      const pruned = [...this.entries.entries()]
        .sort((a, b) => b[1].lastAt - a[1].lastAt)
        .slice(0, MAX_ENTRIES)
      this.entries = new Map(pruned)
      const payload = JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        entries: Object.fromEntries(pruned),
      })
      const temporary = `${this.file}.tmp`
      fs.writeFileSync(temporary, payload, 'utf8')
      fs.renameSync(temporary, this.file)
    } catch (error) {
      this.log('warn', 'history flush failed', { message: error instanceof Error ? error.message : String(error) })
    }
  }

  dispose() {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.enabled) this.flush()
  }
}

function isEntry(value) {
  return (
    value &&
    typeof value === 'object' &&
    Number.isFinite(value.peakCommitGb) &&
    Number.isFinite(value.runs) &&
    value.runs > 0
  )
}

function round2(value) {
  return Math.round(value * 100) / 100
}
