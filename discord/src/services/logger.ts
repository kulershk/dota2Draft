type Level = 'debug' | 'info' | 'warn' | 'error'

function ts(): string {
  return new Date().toISOString()
}

function log(level: Level, msg: unknown, extra?: unknown): void {
  const out = level === 'error' || level === 'warn' ? console.error : console.log
  if (extra !== undefined) out(`[${ts()}] [${level}] ${String(msg)}`, extra)
  else out(`[${ts()}] [${level}] ${String(msg)}`)
}

export const Logger = {
  debug: (msg: unknown, extra?: unknown) => log('debug', msg, extra),
  info: (msg: unknown, extra?: unknown) => log('info', msg, extra),
  warn: (msg: unknown, extra?: unknown) => log('warn', msg, extra),
  error: (msg: unknown, extra?: unknown) => log('error', msg, extra),
}
