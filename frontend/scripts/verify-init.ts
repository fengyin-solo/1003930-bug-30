/* 数据初始化的可复现验证脚本（被 esbuild 打包成 CJS 后用 node --test 运行）。 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { bootstrapStore, storageKey, STORE_VERSION } from '../src/data/bootstrap'
import { bindStorage, initStore, listRows, saveRows, allRows } from '../src/data/local-store'
import { runAction } from '../src/api/local-service'
import { SEED_ROWS } from '../src/data/seed'
import { MODULES } from '../src/data/modules'
import { initLog, logStorageKey } from '../src/data/init-log'
import { deriveEngineeringStatus } from '../src/data/derive'
import { LEGACY_V1_ROWS } from '../src/data/legacy-v1'
import { MemoryStorage } from './memory-storage.mjs'
import type { EntryRow } from '../src/data/types'

const KEY = storageKey()

function write(storage: MemoryStorage, value: unknown): void {
  storage.setItem(KEY, typeof value === 'string' ? value : JSON.stringify(value))
}

function readEnvelope(storage: MemoryStorage): { version: number; modules: Record<string, EntryRow[]>; provenance: Record<string, string[]> } {
  return JSON.parse(storage.getItem(KEY) as string)
}

// ---- 1. 全新初始化：一次写入、版本化信封、种子全量落盘 -------------------------

test('fresh: 全新存储按种子初始化，一次写入，信封版本正确', () => {
  const storage = new MemoryStorage()
  const report = bootstrapStore(storage)
  assert.equal(report.mode, 'fresh')
  assert.equal(storage.writeCount, 1)
  const env = readEnvelope(storage)
  assert.equal(env.version, STORE_VERSION)
  assert.equal(typeof report.seedVersion, 'string')
  assert.equal(typeof report.runId, 'string')
  for (const meta of MODULES) {
    assert.deepEqual(env.modules[meta.key].map((r) => r.id), SEED_ROWS[meta.key].map((r) => r.id))
  }
})

// ---- 2. 幂等：重复启动不追加项目、内容不变、runId 可复现 ----------------------

test('idempotent: 重复初始化结果逐字节一致且不追加项目', () => {
  const storage = new MemoryStorage()
  const first = bootstrapStore(storage)
  const snapshot1 = storage.snapshot(KEY)
  const second = bootstrapStore(storage)
  assert.equal(second.mode, 'reused')
  assert.equal(storage.snapshot(KEY), snapshot1)
  for (const meta of MODULES) {
    assert.equal(second.store.modules[meta.key].length, SEED_ROWS[meta.key].length)
  }
  assert.equal(second.runId, first.runId, '同一份种子的 runId 确定不变')
  bootstrapStore(storage)
  assert.equal(storage.snapshot(KEY), snapshot1)
  const third = bootstrapStore(storage)
  assert.equal(third.counters.upgraded, 0)
  assert.equal(third.counters.preserved, 0)
  assert.equal(third.counters.seeded, 0)
})

// ---- 3. 人工修改不被覆盖 -------------------------------------------------------

test('manual-edit: 人工改过状态与业务字段的行，初始化后原样保留', () => {
  const storage = new MemoryStorage()
  bootstrapStore(storage)
  const env = readEnvelope(storage)
  const rows = env.modules.engineering
  // 模拟用户把 ENGI-0004（已竣工）申请验收，并改了承建方。
  rows[3].status = '待验收'
  rows[3]['项目状态'] = '待验收'
  rows[3]['承建方'] = '人工指定承建方'
  rows[3].pending = false
  write(storage, env)

  const report = bootstrapStore(storage)
  assert.equal(report.mode, 'reused')
  const after = readEnvelope(storage).modules.engineering
  assert.equal(after[3].status, '待验收')
  assert.equal(after[3]['项目状态'], '待验收')
  assert.equal(after[3]['承建方'], '人工指定承建方')
  assert.equal(after.length, 7, '没有新增或丢失项目')
  assert.ok(report.counters.preserved >= 1)
})

test('manual-edit: 运行时动作保存后再启动，动作结论与镜像字段不被重置', () => {
  const storage = new MemoryStorage()
  bindStorage(storage)
  initStore()
  const target = listRows('engineering').find((r) => r['项目编号'] === 'ENGI-0004') as EntryRow
  const result = runAction('engineering', target.id, '申请验收')
  assert.equal(result.ok, true)
  const report = bootstrapStore(storage)
  const moved = readEnvelope(storage).modules.engineering.find((r) => r.id === target.id) as EntryRow
  assert.equal(moved.status, '待验收')
  assert.equal(moved['项目状态'], '待验收', '镜像字段在初始化后仍一致')
  assert.equal(report.counters.upgraded, 0, '人工流转不被当成旧种子升级')
})

// ---- 4. 缺来源项目按开工/竣工日期回填 -----------------------------------------

test('backfill: 种子里没有同 id 的治理工程项目按日期回填，且只回填一次', () => {
  const storage = new MemoryStorage()
  bootstrapStore(storage)
  const env = readEnvelope(storage)
  env.modules.engineering.push(
    {
      id: 901, status: '', pending: true, abnormal: false,
      '项目编号': 'ENGI-0901', '开工日期': '2026-03-01', '竣工日期': '2026-05-01', '项目状态': '',
    },
    {
      id: 902, status: '某个未知状态', pending: true, abnormal: false,
      '项目编号': 'ENGI-0902', '开工日期': '2026-04-01', '竣工日期': '', '项目状态': '某个未知状态',
    },
    {
      id: 903, status: '错乱', pending: true, abnormal: false,
      '项目编号': 'ENGI-0903', '开工日期': '', '竣工日期': '', '项目状态': '错乱',
    },
  )
  write(storage, env)

  const report = bootstrapStore(storage)
  const after = readEnvelope(storage).modules.engineering
  assert.equal(after.find((r) => r.id === 901)?.status, '已竣工')
  assert.equal(after.find((r) => r.id === 902)?.status, '施工中')
  assert.equal(after.find((r) => r.id === 903)?.status, '待立项')
  assert.equal(after.find((r) => r.id === 901)?.['项目状态'], '已竣工', '回填同时同步镜像字段')
  assert.equal(report.counters.backfilled, 3)
  // 再启动一次：状态已合法，不再回填、不重复计数、不追加。
  const again = bootstrapStore(storage)
  assert.equal(again.counters.backfilled, 0)
  assert.equal(again.counters.preserved, 3, '回填后的项目之后按存量数据保留')
  assert.equal(readEnvelope(storage).modules.engineering.length, 10)
})

test('backfill-rule: 日期口径单元规则（非法日期不参与推导）', () => {
  assert.equal(deriveEngineeringStatus({ id: 1, status: 'x', pending: true, abnormal: false, '竣工日期': '2026-05-01' }), '已竣工')
  assert.equal(deriveEngineeringStatus({ id: 1, status: 'x', pending: true, abnormal: false, '开工日期': '2026-05-01' }), '施工中')
  assert.equal(deriveEngineeringStatus({ id: 1, status: 'x', pending: true, abnormal: false }), '待立项')
  assert.equal(
    deriveEngineeringStatus({ id: 1, status: 'x', pending: true, abnormal: false, '开工日期': '不是日期', '竣工日期': '2026-13-99' }),
    '待立项',
  )
})

// ---- 5. 存量 v1 数据迁移：未修改行升级、人工行保留、跨模块引用一致 -------------

test('migration: 无版本旧数据迁移到 v2，未修改示例行升级、人工修改保留', () => {
  const storage = new MemoryStorage()
  const oldEngineering = LEGACY_V1_ROWS.engineering.map((r) => ({ ...r }))
  const oldAcceptance = LEGACY_V1_ROWS.acceptance.map((r) => ({ ...r }))
  // 用户在旧版里手工把 ENGI-0002 改成了施工中（人工修改必须保留）。
  oldEngineering[1].status = '施工中'
  oldEngineering[1]['项目状态'] = '施工中'
  write(storage, { engineering: oldEngineering, acceptance: oldAcceptance })

  const report = bootstrapStore(storage)
  assert.equal(report.mode, 'migrated')
  const env = readEnvelope(storage)
  assert.equal(env.version, 2)
  const eng = env.modules.engineering
  const acc = env.modules.acceptance

  // 未修改的旧示例行升级为新种子：ENGI-0001 不再「有开工日期却待立项」。
  const e1 = eng.find((r) => r.id === 1) as EntryRow
  assert.equal(e1['项目编号'], 'ENGI-0001')
  assert.equal(e1.status, '待立项')
  assert.equal(e1['开工日期'], '', '旧矛盾行被新种子替换')
  assert.equal(e1['竣工日期'], '', '新字段在新种子里齐备')
  assert.equal(eng.find((r) => r.id === 4)?.status, '已竣工', '新版补齐的竣工项目可申请验收')
  assert.equal(eng.length, 7)
  // 人工修改保留。
  assert.equal(eng.find((r) => r.id === 2)?.status, '施工中')
  assert.equal(eng.find((r) => r.id === 2)?.['项目状态'], '施工中')
  // 验收页项目编号指向真实治理工程，跨页面口径一致。
  for (const row of acc) {
    assert.ok(eng.some((p) => p['项目编号'] === row['项目编号']), `验收 ${row['验收编号']} 关联不到治理工程`)
  }
  assert.equal(acc.find((r) => r.id === 1)?.['项目编号'], 'ENGI-0006')
  // 旧版缺失的模块全部补齐。
  for (const meta of MODULES) {
    assert.ok(Array.isArray(env.modules[meta.key]), `${meta.key} 已补齐`)
    assert.equal(env.modules[meta.key].length, SEED_ROWS[meta.key].length)
  }
  // 第二次启动：迁移只发生一次，不再升级。
  const again = bootstrapStore(storage)
  assert.notEqual(again.mode, 'migrated')
  assert.equal(again.counters.upgraded, 0)
})

// ---- 6. 跨页面口径一致：镜像字段、pending、工程/验收联动 -----------------------

test('consistency: 镜像字段与 pending 在所有模块所有行上口径一致', () => {
  const storage = new MemoryStorage()
  bootstrapStore(storage)
  for (const meta of MODULES) {
    const mirrorField = meta.fields[meta.fields.length - 1]
    for (const row of readEnvelope(storage).modules[meta.key]) {
      if (mirrorField.endsWith('状态')) {
        assert.equal(row[mirrorField], row.status, `${meta.key}#${row.id} 镜像字段不一致`)
      }
      assert.equal(row.pending, row.status !== meta.statuses[meta.statuses.length - 1], `${meta.key}#${row.id} pending 口径不一致`)
    }
  }
})

test('consistency: 工程页可申请验收的已竣工项目，验收页能按同一项目编号找到', () => {
  const storage = new MemoryStorage()
  bindStorage(storage)
  initStore()
  const eng = allRows().engineering
  const acc = allRows().acceptance
  for (const row of acc) {
    const project = eng.find((p) => p['项目编号'] === row['项目编号'])
    assert.ok(project, `验收记录 ${String(row['验收编号'])} 关联的项目在工程页存在`)
  }
  // 已竣工项目数量与验收页待处理项目互相对得上口径，而不是一个说待立项一个说可验收。
  const completed = eng.filter((r) => r.status === '已竣工').length
  assert.ok(completed >= 2)
})

// ---- 7. 整批回退 + 可复现日志 --------------------------------------------------

test('rollback: 损坏存量不被覆盖，抛出错误并记录带 runId 的日志', () => {
  const storage = new MemoryStorage()
  write(storage, '{这不是合法JSON')
  const before = storage.snapshot(KEY)
  storage.writeCount = 0
  initLog.clear()
  assert.throws(() => bootstrapStore(storage), /整批回退/)
  assert.equal(storage.snapshot(KEY), before, '存量原样保留')
  assert.equal(storage.writeCount, 0, '没有发生写入')
  const err = initLog.events().find((e) => e.level === 'error' && e.code === 'storage-malformed')
  assert.ok(err, '失败事件已记录')
  assert.ok(err?.detail && typeof err.detail.runId === 'string', '日志带 runId 便于复现')
})

test('rollback: 结构性非法（重复 id）整批回退', () => {
  const storage = new MemoryStorage()
  bootstrapStore(storage)
  const env = readEnvelope(storage)
  env.modules.hazard.push({ ...env.modules.hazard[0] })
  write(storage, env)
  const before = storage.snapshot(KEY)
  const writesBefore = storage.writeCount
  assert.throws(() => bootstrapStore(storage), /重复 id|整批回退/)
  assert.equal(storage.snapshot(KEY), before)
  assert.equal(storage.writeCount, writesBefore, '回退后无写入')
})

test('rollback: 同一份输入两次失败的 runId 相同，日志可复现', () => {
  const storage = new MemoryStorage()
  bootstrapStore(storage)
  const env = readEnvelope(storage)
  env.modules.hazard[0]['隐患点名称'] = '制造一次需合流的输入'
  write(storage, env)
  storage.throwOnWrite = true
  initLog.clear()
  assert.throws(() => bootstrapStore(storage), /整批写入失败/)
  const failEvent = initLog.events().find((e) => e.code === 'storage-write-failed')
  const runIdA = failEvent?.detail && (failEvent.detail as { runId?: string }).runId
  assert.equal(typeof runIdA, 'string')
  storage.throwOnWrite = false
  const runIdB = bootstrapStore(storage).runId
  assert.equal(runIdA, runIdB)
})

test('rollback: 失败日志可通过 persistFailure 落盘取回', () => {
  const storage = new MemoryStorage()
  write(storage, 'not-json')
  initLog.clear()
  assert.throws(() => bootstrapStore(storage))
  initLog.persistFailure(storage)
  const saved = JSON.parse(storage.getItem(logStorageKey()) as string) as { code: string }[]
  assert.ok(Array.isArray(saved) && saved.some((e) => e.code === 'storage-malformed'))
})

// ---- 8. dev/preview/build 同一入口：页面服务层复用 bootstrap -------------------

test('same-entry: local-store 复用 bootstrap；页面保存后信封完好、再启动幂等', () => {
  const storage = new MemoryStorage()
  bindStorage(storage)
  const report = initStore()
  assert.equal(report.mode, 'fresh')
  const rows = listRows('acceptance')
  const next = rows.map((r) => (r.id === 1 ? { ...r, status: '验收中', '验收状态': '验收中', pending: true } : r))
  saveRows('acceptance', next)
  const env = readEnvelope(storage)
  assert.equal(env.version, 2)
  assert.ok(Array.isArray(env.provenance.acceptance))
  const again = bootstrapStore(storage)
  assert.equal(readEnvelope(storage).modules.acceptance.length, rows.length, '不追加')
  assert.equal(readEnvelope(storage).modules.acceptance.find((r) => r.id === 1)?.status, '验收中', '人工状态保留')
  assert.equal(again.mode, 'reused')
})

// ---- 9. 浏览器升级全链路：旧版使用 → 升级 → 人工改动 → 刷新（再初始化）----------

test('browser-upgrade: 模拟真实升级链路（v1 使用→升级→改动→刷新）结论稳定', () => {
  const storage = new MemoryStorage()
  // 旧版用户已经在浏览器里积累了一版无版本号数据（含一条手工新增的治理工程）。
  const legacy = JSON.parse(JSON.stringify(LEGACY_V1_ROWS))
  legacy.engineering.push({
    id: 88,
    status: '施工中',
    pending: false,
    abnormal: false,
    '项目编号': 'ENGI-0088',
    '隐患点编号': 'HAZA-0088',
    '治理方案': '地方自筹治理工程',
    '承建方': '县工程队',
    '合同金额': 9.9,
    '开工日期': '2026-08-08',
    '计划工期': '60 天',
    '项目状态': '施工中',
  })
  write(storage, legacy)

  // 首次加载新版：迁移。
  const first = bootstrapStore(storage)
  assert.equal(first.mode, 'migrated')
  let eng = readEnvelope(storage).modules.engineering
  assert.equal(eng.find((r) => r.id === 88)?.status, '施工中', '人工新增项目保留')
  assert.equal(eng.find((r) => r.id === 88)?.pending, true, '施工中按统一口径应为待处理（旧值 false 被刷新）')

  // 用户在页面上把已竣工的 ENGI-0004 申请验收。
  bindStorage(storage)
  initStore()
  const p4 = listRows('engineering').find((r) => r['项目编号'] === 'ENGI-0004') as EntryRow
  assert.equal(p4.status, '已竣工', '升级后确有可申请验收的竣工项目')
  assert.equal(runAction('engineering', p4.id, '申请验收').ok, true)

  // 模拟刷新：缓存清空、只读存储、重新初始化。
  bindStorage(storage)
  const afterReload = initStore()
  assert.equal(afterReload.mode, 'reused')
  eng = listRows('engineering')
  const reloaded = eng.find((r) => r.id === p4.id) as EntryRow
  assert.equal(reloaded.status, '待验收')
  assert.equal(reloaded['项目状态'], '待验收')
  assert.equal(eng.length, 8, '7 条种子 + 1 条人工新增，刷新不追加')
  // 再次刷新依旧稳定。
  bindStorage(storage)
  initStore()
  assert.equal(listRows('engineering').length, 8)
})
