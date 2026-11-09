/**
 * Run `callback` once a service is available.
 *
 * A plugin can be applied before the service it needs is mounted: on a cold boot
 * the settings route was skipped because `ctx.get('webServer')` returned
 * undefined at apply time and nothing ever retried. This keeps the ordering
 * problem out of every caller.
 *
 * The poll is bounded and unref'd, and its timer is disposed with the plugin.
 */
export function whenService(ctx, name, callback, log, options = {}) {
  const intervalMs = options.intervalMs ?? 500
  const maxAttempts = options.maxAttempts ?? 120

  const available = typeof ctx.get === 'function' ? ctx.get(name) : undefined
  if (available) {
    callback(available)
    return
  }

  let attempts = 0
  const timer = setInterval(() => {
    attempts += 1
    const service = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    if (service) {
      clearInterval(timer)
      try {
        callback(service)
      } catch (error) {
        log?.('warn', `${name} became available but the callback failed`, {
          message: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }
    if (attempts >= maxAttempts) {
      clearInterval(timer)
      log?.('warn', `${name} never became available; feature stays off`)
    }
  }, intervalMs)

  if (typeof timer.unref === 'function') timer.unref()
  ctx.effect(() => () => clearInterval(timer))
}
