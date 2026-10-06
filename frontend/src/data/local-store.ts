import {
  buildInitialEnvelope,
  decorateLog,
  makeRunId,
  REFERENCE_DATE,
  SCHEMA_VERSION,
  seedFingerprint,
} from './init'
import { SEED_ROWS } from './seed'
import type { EntryRow, InitLogEntry, StoreEnvelope } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'geohazard-monitor-prevention:entries'
// 初始化日志单独留一份：失败整批回退时也要能查到是哪一步、什么输入导致的。
const LOG_KEY = 'geohazard-monitor-prevention:init-logs'
const LOG_LIMIT = 100

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

function readRaw(): string | null {
  return hasStorage() ? window.localStorage.getItem(STORAGE_KEY) : null
}

function writeRaw(raw: string): void {
  if (hasStorage()) {
    window.localStorage.setItem(STORAGE_KEY, raw)
  }
}

/**
 * 解析现有数据，区分三种形态：
 * - 当前版本信封（{ version, meta, entries }）；
 * - 旧版裸数据（Record<moduleKey, rows>）：返回 legacy，交给统一迁移；
 * - 损坏的 JSON：返回 corrupt，调用方按失败处理但不覆盖原始内容。
 */
function parseStored(raw: string): {
  envelope?: StoreEnvelope
  legacy?: Record<string, EntryRow[]>
  corrupt?: string
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { corrupt: error instanceof Error ? error.message : String(error) }
  }
  if (
    parsed
    && typeof parsed === 'object'
    && typeof (parsed as StoreEnvelope).version === 'number'
    && typeof (parsed as StoreEnvelope).entries === 'object'
    && (parsed as StoreEnvelope).entries !== null
  ) {
    return { envelope: parsed as StoreEnvelope }
  }
  if (parsed && typeof parsed === 'object' && !('version' in parsed)) {
    return { legacy: parsed as Record<string, EntryRow[]> }
  }
  return { corrupt: '无法识别的存储结构（既不是版本信封，也不是旧版裸数据）' }
}

const INITIAL_ENVELOPE = (): StoreEnvelope =>
  buildInitialEnvelope({
    envelope: null,
    legacy: null,
    runId: makeRunId(),
    referenceDate: REFERENCE_DATE,
  }).envelope

let cache: StoreEnvelope | null = null
let logBuffer: InitLogEntry[] = readLogs()
let initResult: { ok: boolean; runId: string; migrated: boolean } | null = null

function readLogs(): InitLogEntry[] {
  if (!hasStorage()) {
    return []
  }
  try {
    const raw = window.localStorage.getItem(LOG_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as InitLogEntry[]) : []
  } catch {
    return []
  }
}

function appendLogs(entries: InitLogEntry[]): void {
  if (!entries.length) {
    return
  }
  logBuffer = [...logBuffer, ...entries].slice(-LOG_LIMIT)
  if (hasStorage()) {
    window.localStorage.setItem(LOG_KEY, JSON.stringify(logBuffer))
  }
  for (const entry of entries) {
    const line = `[init ${entry.runId}] ${entry.level.toUpperCase()} ${entry.event}: ${entry.detail}`
    if (entry.level === 'error') {
      console.error(line)
    } else if (entry.level === 'warn') {
      console.warn(line)
    } else {
      console.info(line)
    }
  }
}

/**
 * 统一初始化入口：本地开发、构建预览和存量数据都走这里。
 * - 成功：原子写入完整信封（写之前不动旧数据，失败即回退）；
 * - 失败：保留原有存储内容，内存回退到纯示例数据信封并把 lastResult 标成 rollback；
 * - 重复启动：已是当前版本且指纹一致时直接沿用批次元信息，不追加任何项目。
 */
export function initializeStore(force: boolean = false): { ok: boolean; runId: string; migrated: boolean } {
  if (initResult && !force) {
    return initResult
  }
  const runId = makeRunId(new Date())
  const now = new Date()
  const raw = readRaw()

  // 已是当前版本且示例数据指纹一致：重复启动只记幂等日志，不重新播种、不追加项目。
  if (raw && !force) {
    const stored = parseStored(raw)
    if (stored.envelope && stored.envelope.version === SCHEMA_VERSION) {
      const currentFingerprint = seedFingerprint()
      if (stored.envelope.meta.seedFingerprint === currentFingerprint) {
        cache = stored.envelope
        initResult = { ok: true, runId: stored.envelope.meta.initializedAt, migrated: false }
        appendLogs([
          decorateLog(
            { level: 'info', event: 'init-skip-idempotent', detail: `当前版本已初始化（批次 ${stored.envelope.meta.initializedAt}，指纹 ${currentFingerprint}），沿用现有数据` },
            stored.envelope.meta.initializedAt,
            now,
          ),
        ])
        return initResult
      }
      appendLogs([
        decorateLog(
          { level: 'warn', event: 'seed-changed', detail: `示例数据指纹由 ${stored.envelope.meta.seedFingerprint} 变为 ${currentFingerprint}，按当前信封重新跑一遍统一口径（人工修改仍保留）` },
          runId,
          now,
        ),
      ])
    }
  }

  let envelope: StoreEnvelope | null = null
  let legacy: Record<string, EntryRow[]> | null = null
  let parseError: string | null = null

  if (raw) {
    const stored = parseStored(raw)
    if (stored.corrupt) {
      parseError = stored.corrupt
    } else {
      envelope = stored.envelope ?? null
      legacy = stored.legacy ?? null
    }
  }

  if (parseError) {
    // 损坏数据：绝不覆盖，记录可复现日志，内存用纯净示例数据兜底。
    appendLogs([
      decorateLog({ level: 'error', event: 'storage-corrupt', detail: `存储内容解析失败：${parseError}；原始数据保留未动，本次启动回退到示例数据` }, runId, now),
    ])
    const fallback = INITIAL_ENVELOPE()
    cache = { ...fallback, meta: { ...fallback.meta, initializedAt: runId, lastResult: 'rollback' } }
    initResult = { ok: false, runId, migrated: false }
    return initResult
  }

  try {
    const built = buildInitialEnvelope({ envelope, legacy, runId, referenceDate: REFERENCE_DATE })
    const candidate = JSON.stringify(built.envelope)
    // 原子点：序列化成功之后才唯一一次写入；写入抛错时旧数据完整保留。
    writeRaw(candidate)
    cache = built.envelope
    initResult = { ok: true, runId, migrated: built.migrated }
    appendLogs(built.logs.map((entry) => decorateLog(entry, runId, now)))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appendLogs([
      decorateLog({ level: 'error', event: 'init-rollback', detail: `初始化失败：${message}；未写入任何数据，整批回退到启动前状态` }, runId, now),
    ])
    const fallback = INITIAL_ENVELOPE()
    cache = { ...fallback, meta: { ...fallback.meta, initializedAt: runId, lastResult: 'rollback' } }
    initResult = { ok: false, runId, migrated: legacy !== null }
  }
  return initResult
}

function activeEnvelope(): StoreEnvelope {
  if (!cache) {
    initializeStore()
  }
  return cache as StoreEnvelope
}

export function allRows(): Record<string, EntryRow[]> {
  return activeEnvelope().entries
}

export function listRows(key: string): EntryRow[] {
  return activeEnvelope().entries[key] ?? []
}

/** 动作流转写库：人工动作落到记录上即打 _manual，之后任何初始化回填都不会再覆盖它。 */
export function saveRows(key: string, rows: EntryRow[], manualIds: number[] = []): void {
  const envelope = activeEnvelope()
  const manualSet = new Set(manualIds)
  const nextRows = rows.map((row) =>
    manualSet.has(Number(row.id)) ? { ...row, _manual: true } : row,
  )
  const next: StoreEnvelope = {
    ...envelope,
    entries: { ...envelope.entries, [key]: nextRows },
  }
  const candidate = JSON.stringify(next)
  writeRaw(candidate)
  cache = next
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

export function initMeta(): StoreEnvelope['meta'] {
  return activeEnvelope().meta
}

export function initLogs(): InitLogEntry[] {
  return logBuffer
}

export function lastInitResult(): { ok: boolean; runId: string; migrated: boolean } | null {
  return initResult
}

export { SCHEMA_VERSION }
