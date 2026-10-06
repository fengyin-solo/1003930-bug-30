import { SEED_ROWS } from './seed'
import { bootstrapStore, storageKey, STORE_VERSION, type InitReport, type StoragePort, type StoreEnvelope } from './bootstrap'
import { rowFingerprint, seedFingerprintSet } from './derive'
import { initLog } from './init-log'
import type { EntryRow } from './types'

// 本地持久化：所有读写都基于 bootstrap 产出的版本化信封，
// dev / preview / 存量数据共用同一套初始化口径。

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 解析宿主 localStorage：SSR / Node 测试下退化为内存外只读（不持久化）。 */
function hostStorage(): StoragePort {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage
  }
  return null
}

let storagePort: StoragePort = hostStorage()

/** 测试入口：注入内存版 Storage，让初始化与页面读写在 Node 下可重复验证。 */
export function bindStorage(port: StoragePort): void {
  cache = null
  lastReport = null
  storagePort = port
}

export const STORAGE_KEY = storageKey()

let cache: StoreEnvelope | null = null
let lastReport: InitReport | null = null

export function initStore(): InitReport {
  const report = bootstrapStore(storagePort)
  cache = report.store
  lastReport = report
  return report
}

function ensureCache(): StoreEnvelope {
  if (cache === null) {
    // 正常路径下 main.ts 会先调 initStore；这里兜底，保证任何页面单独读取也走同一口径。
    cache = initStore().store
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return ensureCache().modules
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

function commit(next: StoreEnvelope): void {
  cache = next
  if (storagePort) {
    storagePort.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const current = ensureCache()
  // provenance 只保留「当前仍与种子逐字段一致」的行指纹；人工修改或新增的行
  // 不登记为种子来源，之后任何一次初始化都不会把它们当示例行覆盖。
  const currentFps = new Set(rows.map(rowFingerprint))
  const next: StoreEnvelope = {
    ...current,
    modules: { ...current.modules, [key]: rows },
    provenance: {
      ...current.provenance,
      [key]: [...seedFingerprintSet(SEED_ROWS[key] ?? [])].filter((fp) => currentFps.has(fp)).sort(),
    },
  }
  commit(next)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageInfo(): { key: string; version: number; report: InitReport | null } {
  return { key: STORAGE_KEY, version: STORE_VERSION, report: lastReport }
}

// 初始化失败不应静默：main.ts 会显式调用 initStore，这里只做兜底日志。
export function initOrWarn(): InitReport | null {
  try {
    return initStore()
  } catch (error) {
    initLog.persistFailure(storagePort)
    console.error('[data-init] 初始化失败，页面本次不会写入任何数据：', error)
    return null
  }
}
