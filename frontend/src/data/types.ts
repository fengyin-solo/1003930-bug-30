/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  /** 初始化管线写入：true 表示这条记录曾被人工动作改过，任何初始化/回填都不得覆盖。 */
  _manual?: boolean
  [field: string]: string | number | boolean | undefined
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  /**
   * 动作前置状态：只登记需要校验来源页的模块。key 为动作名，value 为允许发起该动作的当前状态。
   * 未登记的动作不限制来源，保持对其余模块的向后兼容。
   */
  actionGuards?: Record<string, string[]>
  /** 状态机终态：命中终态时 pending=false。缺省取 statuses 最后一个。 */
  terminalStatus?: string
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** localStorage 持久化信封：版本与初始化元信息随数据一起存，重启后能复现同一次初始化。 */
export type StoreEnvelope = {
  version: number
  meta: {
    /** 最近一次成功初始化的批次号（ISO 时间-序号），重复启动沿用，作为跨页面同一口径的凭证。 */
    initializedAt: string
    /** 初始化所用示例数据指纹：指纹不变则重复初始化结果必然一致。 */
    seedFingerprint: string
    /** 初始化基准日期（YYYY-MM-DD），日期回填以它为「今天」。 */
    referenceDate: string
    /** 最近一次初始化结果：success / rollback。 */
    lastResult: 'success' | 'rollback'
  }
  entries: Record<string, EntryRow[]>
}

export type InitLogLevel = 'info' | 'warn' | 'error'

export type InitLogEntry = {
  runId: string
  at: string
  level: InitLogLevel
  event: string
  detail: string
}
