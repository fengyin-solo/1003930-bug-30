import { MODULES, MODULE_BY_KEY } from './modules'
import { SEED_ROWS } from './seed'
import { LEGACY_V1_ROWS } from './legacy-v1'
import {
  deriveEngineeringStatus,
  isPending,
  mirrorStatusField,
  rowFingerprint,
  seedFingerprintSet,
} from './derive'
import { initLog } from './init-log'
import type { InitLogEvent } from './init-log'
import type { EntryRow, ModuleMeta } from './types'

/**
 * 统一初始化口径：本地开发（vite dev）、构建预览（vite preview / 静态托管）
 * 与存量浏览器数据都走这同一个 bootstrap。
 *
 * 性质：
 * - 幂等：按 (模块, id) 合流，重复启动不追加项目；已是当前口径则整体 no-op。
 * - 不覆盖人工修改：与种子指纹不同的行一律原样保留（仅刷新派生量）。
 * - 缺来源回填：存储里有、种子里没有同 id 的治理工程项目，状态缺失/非法时
 *   按竣工日期、开工日期回填（见 derive.ts）。
 * - 事务化：先在内存里整批构建并校验，只做一次 localStorage 写入；任何一步
 *   失败都不触碰存量数据（整批回退），并留下确定性的可复现日志。
 */

export const STORE_VERSION = 2
const STORAGE_KEY = 'geohazard-monitor-prevention:entries'

export type StoreEnvelope = {
  version: 2
  seedVersion: string
  /** 各模块当前种子行的指纹：运行时用来区分「人工修改」与「未修改种子行」。 */
  provenance: Record<string, string[]>
  modules: Record<string, EntryRow[]>
}

export type InitMode = 'fresh' | 'migrated' | 'restored' | 'reused'

export type InitCounters = {
  seeded: number
  upgraded: number
  preserved: number
  backfilled: number
  realigned: number
  ignoredModules: number
}

export type InitReport = {
  mode: InitMode
  seedVersion: string
  /** 确定性运行标识：只依赖种子内容，重放同一份输入得到同一个 runId。 */
  runId: string
  counters: InitCounters
  store: StoreEnvelope
}

export type StoragePort = Pick<Storage, 'getItem' | 'setItem'> | null

export function storageKey(): string {
  return STORAGE_KEY
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// ---- 种子自校验：种子本身非法属于代码缺陷，任何环境都必须快速失败 -------------

function validateSeed(): EntryRow[] {
  const problems: string[] = []
  for (const meta of MODULES) {
    const rows = SEED_ROWS[meta.key]
    if (!Array.isArray(rows)) {
      problems.push(`种子缺少模块 ${meta.key}`)
      continue
    }
    const seen = new Set<number>()
    for (const row of rows) {
      if (typeof row.id !== 'number' || seen.has(row.id)) {
        problems.push(`种子模块 ${meta.key} 的 id=${String(row.id)} 缺失或重复`)
      }
      seen.add(row.id)
      if (typeof row.status !== 'string' || !meta.statuses.includes(row.status)) {
        problems.push(`种子模块 ${meta.key} id=${row.id} 的状态「${String(row.status)}」不在状态表内`)
      }
      if (typeof row.pending !== 'boolean' || typeof row.abnormal !== 'boolean') {
        problems.push(`种子模块 ${meta.key} id=${row.id} 的 pending/abnormal 标记非法`)
      } else if (row.pending !== isPending(meta, String(row.status))) {
        problems.push(`种子模块 ${meta.key} id=${row.id} 的 pending 与状态末态口径不一致`)
      }
      const mirror = mirrorStatusField(meta)
      if (mirror && row[mirror] !== row.status) {
        problems.push(`种子模块 ${meta.key} id=${row.id} 的镜像字段「${mirror}」与 status 不一致`)
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`种子数据自校验失败：\n- ${problems.join('\n- ')}`)
  }
  // 给后续遍历返回一份稳定排序的扁平视图。
  return MODULES.flatMap((meta) => SEED_ROWS[meta.key])
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortValue((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

function makeSeedVersion(): string {
  return rowFingerprint(MODULES.flatMap((meta) => SEED_ROWS[meta.key]) as unknown as EntryRow)
}

function makeRunId(seedVersion: string): string {
  return rowFingerprint({ run: 'data-init', v: STORE_VERSION, seed: seedVersion } as unknown as EntryRow)
}

function makeProvenance(): Record<string, string[]> {
  return Object.fromEntries(
    MODULES.map((meta) => [meta.key, [...seedFingerprintSet(SEED_ROWS[meta.key])].sort()]),
  )
}

// ---- 存量数据解析：区分 v2 信封 / 无版本旧数据 / 损坏数据 ---------------------

type ParsedStorage =
  | { kind: 'v2'; envelope: StoreEnvelope }
  | { kind: 'v1'; modules: Record<string, EntryRow[]> }
  | { kind: 'empty' }
  | { kind: 'malformed'; reason: string; raw: string }

function parseStored(storage: StoragePort): ParsedStorage {
  if (!storage) {
    return { kind: 'empty' }
  }
  const raw = storage.getItem(STORAGE_KEY)
  if (raw === null) {
    return { kind: 'empty' }
  }
  if (raw.trim() === '') {
    return { kind: 'malformed', reason: '存储内容为空字符串', raw }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      kind: 'malformed',
      reason: error instanceof Error ? `JSON 解析失败：${error.message}` : 'JSON 解析失败',
      raw,
    }
  }
  if (parsed && typeof parsed === 'object' && (parsed as { version?: unknown }).version === STORE_VERSION) {
    const envelope = parsed as StoreEnvelope
    if (envelope.modules && typeof envelope.modules === 'object') {
      return { kind: 'v2', envelope }
    }
    return { kind: 'malformed', reason: 'v2 信封缺少 modules', raw }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { kind: 'v1', modules: parsed as Record<string, EntryRow[]> }
  }
  return { kind: 'malformed', reason: '根节点既不是模块字典也不是版本化信封', raw }
}

/** v2 信封的结构性校验：任何异常都让整批初始化失败，绝不带伤运行。 */
function validateStoredRows(modules: Record<string, EntryRow[]>): { ok: true } | { ok: false; reason: string; module?: string; id?: number } {
  for (const [key, rows] of Object.entries(modules)) {
    if (!Array.isArray(rows)) {
      return { ok: false, reason: `模块 ${key} 的内容不是数组`, module: key }
    }
    const seen = new Set<number>()
    for (const row of rows) {
      if (!row || typeof row !== 'object') {
        return { ok: false, reason: `模块 ${key} 存在非对象记录`, module: key }
      }
      if (typeof row.id !== 'number' || !Number.isFinite(row.id)) {
        return { ok: false, reason: `模块 ${key} 存在 id 非法的记录`, module: key }
      }
      if (seen.has(row.id)) {
        return { ok: false, reason: `模块 ${key} 存在重复 id=${row.id}`, module: key, id: row.id }
      }
      seen.add(row.id)
      if (typeof row.status !== 'string') {
        return { ok: false, reason: `模块 ${key} id=${row.id} 的 status 不是字符串`, module: key, id: row.id }
      }
    }
  }
  return { ok: true }
}

type LogExtra = Omit<InitLogEvent, 'level' | 'code' | 'message'>

function fail(code: string, message: string, extra?: LogExtra): never {
  initLog.error(code, message, extra)
  throw new Error(message)
}

// ---- 单模块合流 ---------------------------------------------------------------

function reconcileModule(
  key: string,
  stored: EntryRow[] | undefined,
  legacyFps: Set<string>,
  counters: InitCounters,
): EntryRow[] {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    return stored ?? []
  }
  const seedRows = SEED_ROWS[key]
  const storedRows = stored ?? []
  const v2Seeds = seedFingerprintSet(seedRows)
  const storedById = new Map<number, EntryRow>()
  for (const row of storedRows) {
    storedById.set(row.id, row)
  }

  const output: EntryRow[] = []
  const orderedIds = new Set<number>([...seedRows.map((row) => row.id), ...storedRows.map((row) => row.id)])

  for (const id of orderedIds) {
    const seed = seedRows.find((row) => row.id === id)
    const existing = storedById.get(id)

    if (seed && !existing) {
      // 存量里没有这条种子（首次安装、旧版缺失、或之前整批回退过）：原样补齐，
      // 种子必须逐字段保持规范态（validateSeed 已保证），不做任何派生改写。
      counters.seeded += 1
      output.push(clone(seed))
      initLog.info('row-seeded', '补齐种子缺失行', { module: key, id })
      continue
    }

    if (!seed && !existing) {
      continue
    }

    if (!seed && existing) {
      // 缺来源行：种子里没有同 id。治理工程按日期回填缺失/非法状态，其余模块原样保留。
      const validStatus = meta.statuses.includes(String(existing.status))
      const needsBackfill = !validStatus
      if (needsBackfill && key === 'engineering') {
        const derived = deriveEngineeringStatus(existing)
        counters.backfilled += 1
        initLog.info('row-backfilled', '缺来源项目按开工与竣工日期回填状态', {
          module: key,
          id,
          detail: { from: existing.status, to: derived, 开工日期: existing['开工日期'] ?? null, 竣工日期: existing['竣工日期'] ?? null },
        })
        output.push(normalizeRow(meta, { ...clone(existing), status: derived }))
        continue
      }
      if (needsBackfill) {
        counters.backfilled += 1
        initLog.warn('row-invalid-status-preserved', '缺来源行状态非法，保留原值并记录', {
          module: key,
          id,
          detail: { status: existing.status },
        })
      }
      counters.preserved += 1
      output.push(normalizeRow(meta, clone(existing)))
      continue
    }

    // 上面三个分支已覆盖其余组合；这里 seed 与 existing 必然同时存在。
    if (!seed || !existing) {
      continue
    }
    // 指纹一致说明用户没改过，按新种子升级；否则视为人工修改。
    const fingerprint = rowFingerprint(existing)
    const untouched = v2Seeds.has(fingerprint) || legacyFps.has(fingerprint)
    if (untouched && stableJson(existing) !== stableJson(seed)) {
      counters.upgraded += 1
      initLog.info('row-upgraded', '未修改的示例行随种子升级', { module: key, id })
      // 升级行直接采用新种子原文，保持逐字段规范态。
      output.push(clone(seed))
      continue
    }
    if (!untouched) {
      counters.preserved += 1
      initLog.info('row-preserved', '检测到人工修改，初始化不覆盖', {
        module: key,
        id,
        detail: { status: existing.status },
      })
    }
    // 未修改且与种子等价的行（指纹已一致）不需要任何改写；人工修改行只刷新派生量。
    output.push(untouched ? clone(existing) : normalizeRow(meta, clone(existing)))
  }

  return output
}

/**
 * 刷新派生量（不碰人工业务数据）：
 * - pending 永远由状态末态口径推导；
 * - 末尾「状态」展示字段是 status 的镜像，保持同步；
 * - 业务字段、abnormal 标记等一律保留。
 */
function normalizeRow(meta: ModuleMeta, row: EntryRow): EntryRow {
  const next: EntryRow = { ...row, pending: isPending(meta, String(row.status)) }
  const mirror = mirrorStatusField(meta)
  if (mirror && next[mirror] !== next.status) {
    next[mirror] = next.status
  }
  return next
}

// ---- 主流程 -------------------------------------------------------------------

export function bootstrapStore(storage: StoragePort = typeof window !== 'undefined' ? window.localStorage : null): InitReport {
  initLog.clear()
  const seedRows = validateSeed()
  const seedVersion = makeSeedVersion()
  const runId = makeRunId(seedVersion)
  initLog.info('init-start', '开始统一初始化', { detail: { version: STORE_VERSION, seedVersion, runId } })

  const parsed = parseStored(storage)

  let mode: InitMode
  let incoming: Record<string, EntryRow[]>
  if (parsed.kind === 'empty') {
    mode = 'fresh'
    incoming = {}
    initLog.info('storage-empty', '未发现存量数据，按种子全新初始化')
  } else if (parsed.kind === 'malformed') {
    // 损坏数据属于致命失败：不覆盖、不猜测，整批回退，留下可复现线索。
    fail('storage-malformed', `存量数据${parsed.reason}，初始化整批回退，未写入任何数据`, {
      detail: { rawHead: parsed.raw.slice(0, 200), runId },
    })
  } else if (parsed.kind === 'v1') {
    mode = 'migrated'
    incoming = clone(parsed.modules)
    initLog.info('storage-v1', '发现无版本号的旧数据，按迁移口径合流', {
      detail: { modules: Object.keys(parsed.modules).sort() },
    })
  } else {
    mode = parsed.envelope.seedVersion === seedVersion ? 'reused' : 'restored'
    incoming = clone(parsed.envelope.modules)
    initLog.info(mode === 'reused' ? 'storage-v2-current' : 'storage-v2-stale',
      mode === 'reused' ? '存量已是当前种子版本，做幂等复核' : '存量来自旧种子版本，按新口径合流', {
        detail: { storedSeedVersion: parsed.envelope.seedVersion, seedVersion },
      })
  }

  const structural = validateStoredRows(incoming)
  if (!structural.ok) {
    fail('storage-structure-invalid', `${structural.reason}，初始化整批回退，未写入任何数据`, {
      module: structural.module,
      id: structural.id,
      detail: { runId },
    })
  }

  // 仅 v1 迁移时承认旧版原文指纹；v2 存量里指纹对不上当前种子的一律视为人工修改。
  const legacyByModule: Record<string, Set<string>> = {}
  if (mode === 'migrated') {
    for (const [key, rows] of Object.entries(LEGACY_V1_ROWS)) {
      legacyByModule[key] = seedFingerprintSet(rows)
    }
  }

  const counters: InitCounters = { seeded: 0, upgraded: 0, preserved: 0, backfilled: 0, realigned: 0, ignoredModules: 0 }
  const nextModules: Record<string, EntryRow[]> = {}

  // 未知模块键不丢弃也不并入：无法确定结构时保留在 incoming 里并告警，不阻断业务模块。
  const knownKeys = new Set(MODULES.map((meta) => meta.key))
  for (const key of Object.keys(incoming)) {
    if (!knownKeys.has(key)) {
      counters.ignoredModules += 1
      initLog.warn('module-unknown', '存量中存在未登记模块，原样保留但不纳入初始化', {
        module: key,
        detail: { rows: incoming[key].length },
      })
      nextModules[key] = clone(incoming[key])
    }
  }

  for (const meta of MODULES) {
    nextModules[meta.key] = reconcileModule(meta.key, incoming[meta.key], legacyByModule[meta.key] ?? new Set(), counters)
  }

  // 镜像字段在合流时已逐行刷新；realigned 只做一次只读统计，供日志与测试断言。
  for (const meta of MODULES) {
    const mirror = mirrorStatusField(meta)
    if (!mirror) {
      continue
    }
    const before = incoming[meta.key] ?? []
    const after = nextModules[meta.key]
    for (const row of after) {
      const old = before.find((item) => item.id === row.id)
      if (old && old[mirror] !== row.status) {
        counters.realigned += 1
      }
    }
  }

  const envelope: StoreEnvelope = {
    version: STORE_VERSION,
    seedVersion,
    provenance: makeProvenance(),
    modules: nextModules,
  }

  // 写入前最后一次结构校验：合流过程自身出问题也宁可整批回退，不把脏数据落盘。
  const outgoing = validateStoredRows(nextModules)
  if (!outgoing.ok) {
    fail('init-result-invalid', `初始化结果${outgoing.reason}，整批回退，未写入任何数据`, {
      module: outgoing.module,
      id: outgoing.id,
      detail: { runId },
    })
  }

  // 单一写入点：要么整批成功，要么存量原样不动（整批回退）。
  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(envelope))
    } catch (error) {
      fail('storage-write-failed', `整批写入失败，存量数据保持不变：${error instanceof Error ? error.message : String(error)}`, {
        detail: { runId },
      })
    }
  }

  initLog.info('init-done', '统一初始化完成', {
    detail: {
      mode,
      runId,
      seedRows: seedRows.length,
      counters,
    },
  })

  return { mode, seedVersion, runId, counters, store: envelope }
}
