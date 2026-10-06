/**
 * 初始化日志：纯结构化、字段固定、不含时间戳与随机值。
 * 同一份存储 + 同一份种子重放任意次，得到的事件序列完全一致（可复现）。
 * 日志同时输出到 console，并尽力持久化一份到 localStorage，方便从浏览器里取回。
 */

export type InitLogLevel = 'info' | 'warn' | 'error'

export type InitLogEvent = {
  level: InitLogLevel
  /** 稳定事件码，脚本据此断言，不靠中文文案。 */
  code: string
  message: string
  module?: string
  id?: number
  detail?: Record<string, unknown>
}

const RING_LIMIT = 20
const LOG_STORAGE_KEY = 'geohazard-monitor-prevention:init-log'

let events: InitLogEvent[] = []

function emit(level: InitLogLevel, code: string, message: string, extra?: Omit<InitLogEvent, 'level' | 'code' | 'message'>): void {
  const event: InitLogEvent = { level, code, message, ...(extra ?? {}) }
  events.push(event)
  if (events.length > RING_LIMIT) {
    events = events.slice(events.length - RING_LIMIT)
  }
  const line = `[data-init] ${JSON.stringify(event)}`
  if (level === 'error') {
    // 失败必须显眼：console.error 在浏览器与 Node 里都能被测试捕获。
    console.error(line)
  } else if (level === 'warn') {
    console.warn(line)
  } else {
    console.info(line)
  }
}

export const initLog = {
  info(code: string, message: string, extra?: Omit<InitLogEvent, 'level' | 'code' | 'message'>): void {
    emit('info', code, message, extra)
  },
  warn(code: string, message: string, extra?: Omit<InitLogEvent, 'level' | 'code' | 'message'>): void {
    emit('warn', code, message, extra)
  },
  error(code: string, message: string, extra?: Omit<InitLogEvent, 'level' | 'code' | 'message'>): void {
    emit('error', code, message, extra)
  },
  events(): InitLogEvent[] {
    return events.map((event) => ({ ...event, detail: event.detail ? { ...event.detail } : undefined }))
  },
  /** 初始化整体失败时，把失败批次的日志落盘，供事后复现。 */
  persistFailure(storage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void } | null): void {
    if (!storage) {
      return
    }
    try {
      storage.setItem(LOG_STORAGE_KEY, JSON.stringify(events, null, 2))
    } catch {
      // 日志落盘只是尽力而为，不能反过来影响初始化的回退结论。
    }
  },
  clear(): void {
    events = []
  },
}

export function logStorageKey(): string {
  return LOG_STORAGE_KEY
}
