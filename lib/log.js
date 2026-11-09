import fs from 'node:fs'
import path from 'node:path'

const MAX_LOG_BYTES = 512 * 1024

/**
 * Append-only diagnostic log kept beside the plugin's learned history.
 * Logging never throws: a broken log file must not take the gate down.
 */
export function createLogger(directory, debug) {
  let file = null
  try {
    fs.mkdirSync(directory, { recursive: true })
    file = path.join(directory, 'guard.log')
    const stat = fs.statSync(file, { throwIfNoEntry: false })
    if (stat && stat.size > MAX_LOG_BYTES) {
      fs.renameSync(file, path.join(directory, 'guard.1.log'))
    }
  } catch {
    file = null
  }

  return function log(level, message, extra) {
    const line = `${new Date().toISOString()} ${level} ${message}${
      extra === undefined ? '' : ` ${safeJson(extra)}`
    }`
    if (debug) process.stderr.write(`[resource-guard] ${line}\n`)
    if (file === null) return
    try {
      fs.appendFileSync(file, `${line}\n`)
    } catch {
      // Ignore: diagnostics are best effort.
    }
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return '"[unserializable]"'
  }
}
