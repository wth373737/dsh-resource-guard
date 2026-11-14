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
    // Below ~100 MB there is nothing worth remembering, and storing it would
    // pollute every aggregate that reads this profile.
    if (!Number.isFinite(sample.peakCommitGb) || sample.peakCommitGb < 0.1) return
    const previous = this.entries.get(signature)
    const now = Date.now()
    // Two numbers, because they answer different questions: `typical` is what
    // this signature usually costs (used for estimates), `peak` is the worst
    // seen (used to warn). Keeping only a decayed maximum meant one heavy run
    // made every later call of that name look heavy.
    const decayedPeak =
      previous && Number.isFinite(previous.peakCommitGb) ? previous.peakCommitGb * 0.98 : 0
    const previousTypical =
      previous && Number.isFinite(previous.typicalCommitGb)
        ? previous.typicalCommitGb
        : previous && Number.isFinite(previous.peakCommitGb)
          ? previous.peakCommitGb
          : sample.peakCommitGb
    const entry = {
      runs: (previous?.runs ?? 0) + 1,
      peakCommitGb: round2(Math.max(decayedPeak, sample.peakCommitGb)),
      typicalCommitGb: round2(previousTypical * 0.7 + sample.peakCommitGb * 0.3),
      peakVramGb: round2(Math.max(previous?.peakVramGb ?? 0, sample.peakVramGb ?? 0)),
      lastAt: now,
    }
    this.entries.set(signature, entry)
    this.scheduleFlush()
  }

  /**
   * Aggregate view used by the hardware-derived recommendation.
   *
   * Uses the typical cost, not the peak: a signature that once spiked would
   * otherwise inflate the safe-concurrency figure for everything else.
   */
  stats() {
    const values = [...this.entries.values()]
      .map((entry) => entry.typicalCommitGb ?? entry.peakCommitGb)
      .filter((value) => Number.isFinite(value) && value >= 1)
      .sort((a, b) => a - b)
    if (values.length < 2) return { entries: values.length, medianPeakGb: 0 }
    const middle = values.length >> 1
    const median =
      values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2
    return { entries: values.length, medianPeakGb: median }
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
