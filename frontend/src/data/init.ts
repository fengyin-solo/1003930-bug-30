import { MODULES, MODULE_BY_KEY } from './modules'
import { SEED_ROWS } from './seed'
import type { EntryRow, InitLogEntry, StoreEnvelope } from './types'

/**
 * 统一初始化管线（dev / preview / 存量浏览器数据共用同一套口径）：
 * 1. 读取旧版裸数据或当前版本信封，按业务编号把存量记录合并回示例数据；
 * 2. 曾被人工动作改动的记录打 _manual 标记，后续任何回填都不覆盖；
 * 3. 治理工程缺来源（非人工、且没有权威状态）时按开工/竣工日期回填状态；
 * 4. 验收模块镜像工程侧状态，列表、详情、验收页读到的是同一份结论；
 * 5. 全程只产出下一份信封，任何一步抛错都由调用方整批回退，不写半截数据。
 */

export const SCHEMA_VERSION = 2
/** 初始化基准日期：固定为发布口径里的「今天」，保证任何机器上重复执行结果一致。 */
export const REFERENCE_DATE = '2026-09-30'
/** 旧版（裸 Record<key, rows>，无信封）数据的 schema 版本号。 */
export const LEGACY_VERSION = 0
/** 旧版每个模块固定三条样例时的状态序列，用于识别哪些存量记录是被人工改过的。 */
const LEGACY_TRIPLET_STATUS: Record<string, [string, string, string]> = {
  hazard: ['在册', '监测中', '已治理'],
  deformation: ['已观测', '待校核', '已校核'],
  crack: ['正常', '加速发展', '趋于稳定'],
  tilt: ['已观测', '待校核', '已校核'],
  rain_gauge: ['已采集', '已审核', '达预警值'],
  threshold: ['草稿', '已生效', '已调整'],
  alarm: ['待发布', '已发布', '已响应'],
  evacuation: ['待动员', '已签约', '已搬迁'],
  patrol: ['待巡查', '已巡查', '发现异常'],
  engineering: ['待立项', '招标中', '施工中'],
  acceptance: ['待验收', '验收中', '验收通过'],
  rectification: ['待整改', '整改中', '已整改'],
  drill: ['待筹备', '筹备中', '已实施'],
  device: ['正常运行', '信号异常', '低电量'],
  report: ['已录入', '待核实', '已核实'],
  propaganda: ['待开展', '进行中', '已完成'],
  contract: ['正常', '暂停合作', '列入黑名单'],
  training: ['待开展', '授课中', '已完成'],
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** 稳定的批次号：同一秒内多次执行靠序号区分，可在日志里复现具体是哪一次初始化。 */
export function makeRunId(now: Date = new Date(), seq: number = 1): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
    + `T${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}-${pad2(seq)}`
}

/** 示例数据指纹：对规范化后的 JSON 做 32 位 FNV-1a，指纹相同 = 输入相同 = 初始化结果可重复。 */
export function seedFingerprint(seed: Record<string, EntryRow[]> = SEED_ROWS): string {
  const canonical = JSON.stringify(
    MODULES.map((m) => m.key).map((key) => [key, seed[key] ?? []]),
  )
  let hash = 0x811c9dc5
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/** 解析 YYYY-MM-DD，非法日期抛错（由整批初始化捕获后回退）。 */
export function parseDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) {
    throw new Error(`日期「${value}」不是 YYYY-MM-DD 格式`)
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`日期「${value}」超出合法范围`)
  }
  return new Date(year, month - 1, day)
}

/**
 * 治理工程状态的唯一回填口径（以 referenceDate 为「今天」）：
 * - 「待验收」是人工申请验收后的流转状态，属于权威来源，直接保留；
 * - 开工日期晚于今天   → 待立项；
 * - 已开工、未竣工     → 施工中；
 * - 已竣工             → 已竣工（可申请验收）；
 * - 缺开工日期         → 视为缺来源，抛错触发整批回退。
 */
export function deriveEngineeringStatus(row: EntryRow, referenceDate: string = REFERENCE_DATE): string {
  const current = String(row.status ?? '')
  if (current === '待验收') {
    return current
  }
  const today = parseDate(referenceDate)
  const startRaw = String(row['开工日期'] ?? '').trim()
  if (!startRaw) {
    throw new Error(`治理工程 ${String(row['项目编号'] ?? row.id)} 缺少开工日期，无法按日期回填状态`)
  }
  const start = parseDate(startRaw)
  if (start.getTime() > today.getTime()) {
    return '待立项'
  }
  const endRaw = String(row['竣工日期'] ?? '').trim()
  if (endRaw) {
    const end = parseDate(endRaw)
    if (end.getTime() <= today.getTime()) {
      return '已竣工'
    }
  }
  return '施工中'
}

/** 模块首个业务字段即业务编号（验收页例外，业务身份落在项目编号上）。 */
export function businessKey(key: string, row: EntryRow): string {
  const meta = MODULE_BY_KEY.get(key)
  const field = key === 'acceptance' ? '项目编号' : meta?.fields[0]
  const value = field ? String(row[field] ?? '').trim() : ''
  return value || `id:${row.id}`
}

function isPending(meta: { statuses: string[]; terminalStatus?: string }, status: string): boolean {
  const terminal = meta.terminalStatus ?? meta.statuses[meta.statuses.length - 1]
  return status !== terminal
}

function validateUnique(rowsByKey: Record<string, EntryRow[]>, push: (e: Omit<InitLogEntry, 'runId' | 'at'>) => void): void {
  for (const meta of MODULES) {
    const seen = new Map<string, number>()
    for (const row of rowsByKey[meta.key] ?? []) {
      const key = businessKey(meta.key, row)
      const prev = seen.get(key)
      if (prev !== undefined) {
        push({
          level: 'error',
          event: 'duplicate-business-key',
          detail: `${meta.name} 业务编号 ${key} 在 id=${prev} 与 id=${row.id} 上重复，无法确定唯一身份`,
        })
        throw new Error(`${meta.name} 业务编号 ${key} 重复，初始化整批回退`)
      }
      seen.set(key, Number(row.id))
    }
  }
}

/** 旧版固定三条样例里，某条存量记录的原始状态；不在样例范围内的存量记录没有原始状态。 */
function legacySeedStatus(moduleKey: string, row: EntryRow): string | null {
  const triplet = LEGACY_TRIPLET_STATUS[moduleKey]
  if (!triplet) {
    return null
  }
  const id = Number(row.id)
  if (id >= 1 && id <= 3) {
    return triplet[id - 1]
  }
  return null
}

export type InitInputs = {
  /** 当前版本信封；首次启动为 null。 */
  envelope: StoreEnvelope | null
  /** 旧版裸数据；解析失败由调用方在外面记日志后传 null。 */
  legacy: Record<string, EntryRow[]> | null
  runId: string
  referenceDate?: string
  seed?: Record<string, EntryRow[]>
}

export type InitOutputs = {
  envelope: StoreEnvelope
  logs: Omit<InitLogEntry, 'runId' | 'at'>[]
  /** 是否执行了旧版数据迁移（用于在结果里区分「首次播种」与「存量迁移」）。 */
  migrated: boolean
}

/**
 * 纯函数初始化：输入（信封/旧数据/种子/基准日期/runId）确定，输出信封与日志就确定，
 * 不触碰 localStorage，便于在 dev、preview 与测试里复用同一套口径。
 */
export function buildInitialEnvelope(inputs: InitInputs): InitOutputs {
  const { envelope, legacy, runId } = inputs
  const referenceDate = inputs.referenceDate ?? REFERENCE_DATE
  const seed = inputs.seed ?? SEED_ROWS
  const logs: Omit<InitLogEntry, 'runId' | 'at'>[] = []
  const push = (entry: Omit<InitLogEntry, 'runId' | 'at'>) => logs.push(entry)
  const migrated = legacy !== null

  push({ level: 'info', event: 'init-start', detail: `批次 ${runId}，基准日期 ${referenceDate}，schema v${SCHEMA_VERSION}` })

  if (legacy) {
    push({ level: 'info', event: 'legacy-detected', detail: '检测到旧版裸数据（无版本信封），开始按业务编号迁移' })
  }
  if (envelope && envelope.version < SCHEMA_VERSION) {
    push({ level: 'warn', event: 'schema-stale', detail: `现有信封为 v${envelope.version}，按 v${SCHEMA_VERSION} 重新初始化` })
  }

  // 以示例数据为底，逐模块按业务编号合并存量记录；人工改动整体保留，绝不覆盖。
  const next: Record<string, EntryRow[]> = {}
  const failDuplicate = (moduleName: string, key: string, a: number, b: number): never => {
    push({
      level: 'error',
      event: 'duplicate-business-key',
      detail: `${moduleName} 业务编号 ${key} 在 id=${a} 与 id=${b} 上重复，无法确定唯一身份`,
    })
    throw new Error(`${moduleName} 业务编号 ${key} 重复，初始化整批回退`)
  }
  for (const meta of MODULES) {
    const seedRows = clone(seed[meta.key] ?? [])
    const byBiz = new Map<string, EntryRow>()
    for (const row of seedRows) {
      const key = businessKey(meta.key, row)
      const prev = byBiz.get(key)
      if (prev) {
        failDuplicate(meta.name, key, Number(prev.id), Number(row.id))
      }
      byBiz.set(key, row)
    }

    const prior: EntryRow[] | undefined = legacy
      ? legacy[meta.key]
      : envelope?.entries?.[meta.key]
    if (prior) {
      const seenPrior = new Set<string>()
      for (const oldRow of prior) {
        const key = businessKey(meta.key, oldRow)
        if (seenPrior.has(key)) {
          failDuplicate(meta.name, key, -1, Number(oldRow.id))
        }
        seenPrior.add(key)
        const base = byBiz.get(key)
        if (base) {
          // 同业务编号：旧版数据按状态差异识别人工修改；已是信封的数据直接沿用 _manual。
          let manual = base._manual === true || oldRow._manual === true
          if (legacy && !manual) {
            const original = legacySeedStatus(meta.key, oldRow)
            manual = original === null || String(oldRow.status) !== original
          }
          const merged: EntryRow = {
            ...base,
            ...clone(oldRow),
            id: base.id,
            _manual: manual,
          }
          byBiz.set(key, merged)
          if (legacy || manual) {
            push({
              level: 'info',
              event: 'row-merged',
              detail: `${meta.name} ${key} 已合并${manual ? '（保留人工修改，不覆盖）' : ''}`,
            })
          }
        } else {
          // 示例里已不存在的存量记录：整体保留并视为人工资料，回填逻辑不得改动。
          byBiz.set(key, { ...clone(oldRow), id: Number(oldRow.id), _manual: true })
          push({
            level: 'warn',
            event: 'row-orphan',
            detail: `${meta.name} ${key} 不在示例数据中，作为人工记录原样保留`,
          })
        }
      }
    }
    next[meta.key] = [...byBiz.values()].sort((a, b) => Number(a.id) - Number(b.id))
  }

  // 治理工程：缺来源（非人工）的项目按开工/竣工日期回填状态与待办标记。
  for (const row of next.engineering ?? []) {
    const code = businessKey('engineering', row)
    if (row._manual) {
      push({ level: 'info', event: 'engineering-skip-manual', detail: `${code} 曾被人工修改，状态「${row.status}」不参与日期回填` })
      continue
    }
    const derived = deriveEngineeringStatus(row, referenceDate)
    if (derived !== String(row.status)) {
      push({
        level: 'warn',
        event: 'engineering-status-backfilled',
        detail: `${code} 状态由「${row.status}」按开竣工日期回填为「${derived}」`,
      })
    }
    row.status = derived
    row['项目状态'] = derived
    row.pending = isPending(MODULE_BY_KEY.get('engineering')!, derived)
  }

  // 工程验收：工程状态镜像工程侧结论，两个页面看到的项目状态必然一致。
  const engineeringByCode = new Map<string, EntryRow>()
  for (const row of next.engineering ?? []) {
    engineeringByCode.set(String(row['项目编号']), row)
  }
  for (const row of next.acceptance ?? []) {
    const code = String(row['项目编号'])
    const project = engineeringByCode.get(code)
    if (!project) {
      // 人工保留的存量记录可能引用已下线的项目：原样保留、不参与镜像，也不阻断整批初始化。
      if (row._manual) {
        push({
          level: 'warn',
          event: 'acceptance-project-orphan',
          detail: `人工记录 ${String(row['验收编号'] ?? row.id)} 引用的项目 ${code} 已不存在，原样保留且不回写工程状态`,
        })
        continue
      }
      push({
        level: 'error',
        event: 'acceptance-project-missing',
        detail: `验收记录 ${String(row['验收编号'] ?? row.id)} 引用的项目 ${code} 在治理工程中不存在，跨页面口径无法对齐`,
      })
      throw new Error(`验收记录引用了不存在的治理工程 ${code}，初始化整批回退`)
    }
    const projectStatus = String(project.status)
    if (String(row['工程状态']) !== projectStatus) {
      push({
        level: 'warn',
        event: 'acceptance-project-synced',
        detail: `${code} 工程状态镜像为「${projectStatus}」`,
      })
    }
    row['工程状态'] = projectStatus
    if (!row._manual) {
      row.pending = isPending(MODULE_BY_KEY.get('acceptance')!, String(row.status))
    }
  }

  validateUnique(next, push)

  const resultEnvelope: StoreEnvelope = {
    version: SCHEMA_VERSION,
    meta: {
      initializedAt: runId,
      seedFingerprint: seedFingerprint(seed),
      referenceDate,
      lastResult: 'success',
    },
    entries: next,
  }

  const counts = MODULES.map((m) => `${m.name}:${(next[m.key] ?? []).length}`).join('，')
  push({ level: 'info', event: 'init-done', detail: `初始化完成（${counts}），指纹 ${resultEnvelope.meta.seedFingerprint}` })
  return { envelope: resultEnvelope, logs, migrated }
}

export function decorateLog(entry: Omit<InitLogEntry, 'runId' | 'at'>, runId: string, now: Date = new Date()): InitLogEntry {
  return { runId, at: now.toISOString(), ...entry }
}
