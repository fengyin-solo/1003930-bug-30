/* 存储层验证：内存 localStorage 模拟，覆盖整批回退、损坏数据保留、重复启动不追加。
 * 由 verify:init 的同一套 tsc 工程编译。 */
import assert from 'node:assert'
import Module from 'node:module'
import path from 'node:path'

// 让运行时也认识源码里的 @/ 别名（tsc 只负责编译期解析）。
const origResolve = (Module as unknown as { _resolveFilename?: Function })._resolveFilename
;(Module as unknown as { _resolveFilename: Function })._resolveFilename = function (
  request: string,
  ...rest: unknown[]
) {
  if (request.startsWith('@/')) {
    request = path.join(__dirname, '..', 'src', request.slice(2))
  }
  return (origResolve as Function).call(this, request, ...rest)
}

function createMemoryStorage(): Storage & { dump: () => Record<string, string> } {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => {
      map.delete(k)
    },
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
    dump: () => Object.fromEntries(map),
  } as unknown as Storage & { dump: () => Record<string, string> }
}

// 在 require 存储层之前装好 window/localStorage
const storage = createMemoryStorage()
;(globalThis as unknown as { window: { localStorage: Storage } }).window = { localStorage: storage }

const { initializeStore, allRows, initMeta, initLogs, listRows } =
  require('../src/data/local-store') as typeof import('../src/data/local-store')
const { runAction, listEntries } =
  require('../src/api/local-service') as typeof import('../src/api/local-service')

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

console.log('A. 首次初始化与重复启动')
{
  const r1 = initializeStore(true)
  check('首次成功', () => assert.equal(r1.ok, true))
  const n1 = allRows().engineering.length
  const r2 = initializeStore(true)
  check('再次初始化仍是同一批次（沿用信封，不追加）', () => {
    assert.equal(r2.runId, r1.runId)
    assert.equal(allRows().engineering.length, n1)
  })
  check('元信息齐全', () => {
    const meta = initMeta()
    assert.equal(meta.lastResult, 'success')
    assert.match(meta.seedFingerprint, /^fnv1a-/)
  })
}

console.log('B. 人工动作落库后，重新初始化不覆盖')
{
  // ENGI-0003 已竣工 → 申请验收
  const row = listRows('engineering').find((r) => r['项目编号'] === 'ENGI-0003')!
  const res = runAction('engineering', Number(row.id), '申请验收')
  check('已竣工项目可以申请验收', () => assert.equal(res.ok, true))
  check('非已竣工项目不能申请验收（待立项被闸门拦截）', () => {
    const pending = listRows('engineering').find((r) => r['项目编号'] === 'ENGI-0001')!
    const blocked = runAction('engineering', Number(pending.id), '申请验收')
    assert.equal(blocked.ok, false)
    assert.match(blocked.message, /只有「已竣工」/)
  })
  initializeStore(true)
  check('重初始化后人工状态保留为待验收，且验收页工程状态同步', () => {
    const eng = listRows('engineering').find((r) => r['项目编号'] === 'ENGI-0003')!
    assert.equal(eng.status, '待验收')
    assert.equal(eng._manual, true)
    const acc = listRows('acceptance').find((r) => r['项目编号'] === 'ENGI-0003')
    // 种子里没有 ENGI-0003 的验收单：动作已返回提示信息，不应凭空造单
    assert.equal(acc, undefined)
  })
  check('验收动作受工程侧闸门约束：验收中不能重复启动验收', () => {
    const acc = listRows('acceptance').find((r) => r['项目编号'] === 'ENGI-0005')!
    assert.equal(runAction('acceptance', Number(acc.id), '启动验收').ok, false)
  })
}

console.log('C. 损坏的存储不被覆盖，整批回退并留日志')
{
  storage.setItem('geohazard-monitor-prevention:entries', '{这不是合法JSON')
  const before = storage.getItem('geohazard-monitor-prevention:entries')
  const r = initializeStore(true)
  check('报告失败', () => assert.equal(r.ok, false))
  check('原始损坏数据原样保留', () => {
    assert.equal(storage.getItem('geohazard-monitor-prevention:entries'), before)
  })
  check('内存回退到示例数据，页面仍可渲染', () => {
    assert.equal(listEntries('engineering').total, 6)
    assert.equal(initMeta().lastResult, 'rollback')
  })
  check('日志里留下可复现的失败记录', () => {
    assert.ok(initLogs().some((l) => l.event === 'storage-corrupt'))
  })
}

console.log('D. 旧版裸数据迁移且重复迁移不追加')
{
  const legacy = {
    engineering: [
      { id: 1, status: '待立项', pending: true, abnormal: false, '项目编号': 'ENGI-0001', '开工日期': '2026-11-20' },
      { id: 2, status: '招标中', pending: true, abnormal: false, '项目编号': 'ENGI-0002' },
      { id: 3, status: '施工中', pending: false, abnormal: false, '项目编号': 'ENGI-0003' },
    ],
  }
  storage.setItem('geohazard-monitor-prevention:entries', JSON.stringify(legacy))
  const r1 = initializeStore(true)
  check('迁移成功', () => assert.equal(r1.ok, true))
  check('ENGI-0003 旧数据的施工中被纠正为已竣工（日期口径）', () => {
    const r = listRows('engineering').find((x) => x['项目编号'] === 'ENGI-0003')!
    assert.equal(r.status, '已竣工')
  })
  check('ENGI-0002 旧数据招标中与日期回填一致，未误判为人工', () => {
    const r = listRows('engineering').find((x) => x['项目编号'] === 'ENGI-0002')!
    // 招标中不是日期回填可能产生的状态：与旧种子相同说明未被人改过，回填为施工中
    assert.equal(r._manual, false)
    assert.equal(r.status, '施工中')
  })
  const n = listRows('engineering').length
  initializeStore(true)
  check('第二次启动沿用已迁移信封，项目数量不变', () => {
    assert.equal(listRows('engineering').length, n)
  })
}

console.log(`\n存储层 ${passed} 项断言全部通过`)
