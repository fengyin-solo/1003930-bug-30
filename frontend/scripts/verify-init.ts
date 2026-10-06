/* 统一初始化的可重复验证脚本：node scripts/verify-init.mjs（由 npm script 经 esbuild 生成）。
 * 不依赖浏览器，用内存 Map 模拟 localStorage，断言需求里的每条口径。 */
import assert from 'node:assert'
import { SEED_ROWS } from '../src/data/seed'
import {
  REFERENCE_DATE,
  SCHEMA_VERSION,
  buildInitialEnvelope,
  deriveEngineeringStatus,
  makeRunId,
  seedFingerprint,
} from '../src/data/init'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

function run(overrides = {}) {
  return buildInitialEnvelope({
    envelope: null,
    legacy: null,
    runId: makeRunId(new Date('2026-10-06T08:00:00')),
    referenceDate: REFERENCE_DATE,
    ...overrides,
  })
}

console.log('1. 首次播种')
{
  const { envelope, migrated } = run()
  check('产出当前版本信封', () => assert.equal(envelope.version, SCHEMA_VERSION))
  check('记录基准日期与指纹', () => {
    assert.equal(envelope.meta.referenceDate, REFERENCE_DATE)
    assert.equal(envelope.meta.seedFingerprint, seedFingerprint())
    assert.equal(envelope.meta.lastResult, 'success')
  })
  check('不是迁移场景', () => assert.equal(migrated, false))
  const eng = envelope.entries.engineering
  check('治理工程共 6 条样例', () => assert.equal(eng.length, 6))
  const byCode = Object.fromEntries(eng.map((r) => [r['项目编号'], r]))
  check('ENGI-0001 未开工 → 待立项', () => assert.equal(byCode['ENGI-0001'].status, '待立项'))
  check('ENGI-0002 在建 → 施工中', () => assert.equal(byCode['ENGI-0002'].status, '施工中'))
  check('ENGI-0003 已竣工 → 已竣工（可申请验收）', () => assert.equal(byCode['ENGI-0003'].status, '已竣工'))
  check('ENGI-0004/5/6 → 待验收', () => {
    assert.equal(byCode['ENGI-0004'].status, '待验收')
    assert.equal(byCode['ENGI-0005'].status, '待验收')
    assert.equal(byCode['ENGI-0006'].status, '待验收')
  })
  check('待立项/施工中 pending=true，待验收 pending=false', () => {
    assert.equal(byCode['ENGI-0001'].pending, true)
    assert.equal(byCode['ENGI-0002'].pending, true)
    assert.equal(byCode['ENGI-0003'].pending, true)
    assert.equal(byCode['ENGI-0004'].pending, false)
  })
  const acc = envelope.entries.acceptance
  check('验收页工程状态镜像工程侧结论', () => {
    for (const row of acc) {
      assert.equal(row['工程状态'], '待验收')
    }
  })
}

console.log('2. 重复启动幂等，不追加项目')
{
  const first = run()
  const second = run({ envelope: first.envelope })
  check('第二次初始化项目数量不变', () => {
    assert.equal(second.envelope.entries.engineering.length, first.envelope.entries.engineering.length)
    assert.equal(second.envelope.entries.acceptance.length, first.envelope.entries.acceptance.length)
  })
  check('同输入得到同指纹、同状态序列', () => {
    assert.equal(second.envelope.meta.seedFingerprint, first.envelope.meta.seedFingerprint)
    assert.deepStrictEqual(
      second.envelope.entries.engineering.map((r) => r.status),
      first.envelope.entries.engineering.map((r) => r.status),
    )
  })
}

console.log('3. 存量旧版数据迁移')
{
  // 旧版三条样例：ENGI-0003 在旧数据里是「施工中」，但新种子该编号已竣工（日期回填会纠正）；
  // 若用户曾把 ENGI-0001 改成「施工中」（不同于旧种子的「待立项」），视为人工修改。
  const legacy = {
    engineering: [
      { id: 1, status: '施工中', pending: false, abnormal: false, '项目编号': 'ENGI-0001', '开工日期': '2026-11-20' },
      { id: 2, status: '招标中', pending: true, abnormal: true, '项目编号': 'ENGI-0002' },
      { id: 3, status: '施工中', pending: false, abnormal: false, '项目编号': 'ENGI-0003' },
      { id: 9, status: '施工中', pending: false, abnormal: false, '项目编号': 'ENGI-0999' },
    ],
    acceptance: [
      { id: 1, status: '待验收', pending: true, abnormal: false, '验收编号': 'ACCE-0001', '项目编号': 'ACCE-0001' },
    ],
  }
  const { envelope, migrated, logs } = run({ legacy })
  check('识别为迁移', () => assert.equal(migrated, true))
  const eng = envelope.entries.engineering
  const byCode = Object.fromEntries(eng.map((r) => [r['项目编号'], r]))
  check('人工改到「施工中」的 ENGI-0001 被锁定，不被日期回填覆盖', () => {
    assert.equal(byCode['ENGI-0001'].status, '施工中')
    assert.equal(byCode['ENGI-0001']._manual, true)
  })
  check('未被人动过的 ENGI-0003 按日期回填为已竣工', () => {
    assert.equal(byCode['ENGI-0003'].status, '已竣工')
    assert.equal(byCode['ENGI-0003']._manual, false)
  })
  check('示例中已不存在的 ENGI-0999 作为人工记录保留', () => {
    assert.equal(byCode['ENGI-0999']._manual, true)
  })
  check('旧验收记录按项目编号合并到新种子（ACCE-0001→ENGI-0004）', () => {
    // ACCE-0001 旧数据项目编号是 ACCE-0001，在新种子里找不到同编号，应作为孤儿保留而非污染新记录
    const orphan = envelope.entries.acceptance.find((r) => r['项目编号'] === 'ACCE-0001')
    assert.ok(orphan, '孤儿验收记录应保留')
    assert.equal(orphan._manual, true)
  })
  check('迁移日志可复现每一步', () => {
    const events = logs.map((l) => l.event)
    assert.ok(events.includes('legacy-detected'))
    assert.ok(events.includes('engineering-status-backfilled'))
    assert.ok(events.includes('engineering-skip-manual'))
  })
}

console.log('4. 缺来源项目按日期回填，非法输入整批失败')
{
  check('缺开工日期且非人工 → 抛错（由存储层整批回退）', () => {
    const badSeed = {
      ...SEED_ROWS,
      engineering: [{ id: 1, status: '待立项', pending: true, abnormal: false, '项目编号': 'ENGI-X', '开工日期': '' }],
    }
    assert.throws(
      () => run({ seed: badSeed }),
      /缺少开工日期/,
    )
  })
  check('人工记录缺日期也不回填、不报错', () => {
    const envelope = buildInitialEnvelope({
      envelope: null,
      legacy: null,
      runId: 't',
      seed: {
        ...SEED_ROWS,
        engineering: [{ id: 1, status: '招标中', pending: true, abnormal: false, '项目编号': 'ENGI-X', '开工日期': '', _manual: true }],
        acceptance: [],
      },
    }).envelope
    assert.equal(envelope.entries.engineering[0].status, '招标中')
  })
  check('验收记录引用不存在的工程 → 抛错整批回退', () => {
    const badSeed = {
      ...SEED_ROWS,
      acceptance: [{ id: 1, status: '待验收', pending: true, abnormal: false, '验收编号': 'ACCE-X', '项目编号': 'NO-SUCH' }],
    }
    assert.throws(() => run({ seed: badSeed }), /NO-SUCH/)
  })
  check('业务编号重复 → 抛错整批回退', () => {
    const badSeed = {
      ...SEED_ROWS,
      engineering: [
        ...SEED_ROWS.engineering,
        { id: 99, status: '待立项', pending: true, abnormal: false, '项目编号': 'ENGI-0001' },
      ],
    }
    assert.throws(() => run({ seed: badSeed }), /重复/)
  })
}

console.log('5. 日期回填口径')
{
  const mk = (start: string, end: string = ''): import('../src/data/types').EntryRow =>
    ({ id: 1, status: '待立项', pending: true, abnormal: false, '开工日期': start, '竣工日期': end })
  check('开工晚于基准日 → 待立项', () => assert.equal(deriveEngineeringStatus(mk('2026-12-01')), '待立项'))
  check('已开工未到竣工 → 施工中', () => assert.equal(deriveEngineeringStatus(mk('2026-09-01', '2026-12-31')), '施工中'))
  check('竣工已过 → 已竣工', () => assert.equal(deriveEngineeringStatus(mk('2026-05-01', '2026-09-01')), '已竣工'))
  check('待验收为权威状态直接保留', () => assert.equal(deriveEngineeringStatus({ ...mk('2026-05-01', '2026-09-01'), status: '待验收' }), '待验收'))
  check('非法日期抛错', () => assert.throws(() => deriveEngineeringStatus(mk('2026/09/01')), /YYYY-MM-DD/))
}

console.log(`\n全部 ${passed} 项断言通过`)
