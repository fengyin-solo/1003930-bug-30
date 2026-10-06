import type { EntryRow, ModuleMeta } from './types'

/**
 * 初始化与页面动作共用的派生口径：任何页面、任何启动方式都只从这里取规则，
 * 避免列表页、详情字段、验收页各算各的。
 */

/** pending 口径与 local-service 的状态流转保持同一规则：末态之外都算待处理。 */
export function isPending(meta: ModuleMeta, status: string): boolean {
  return status !== meta.statuses[meta.statuses.length - 1]
}

/**
 * 每个模块的最后一个字段是「状态」镜像（项目状态/验收状态/设备状态…），
 * 它是核心 status 的镜像字段。跨页面结论一致，意味着镜像必须与 status 同步。
 * 注意：不能用「任意以状态结尾的字段」——例如设备模块另有业务字段「通讯状态」。
 */
export function mirrorStatusField(meta: ModuleMeta): string | null {
  const last = meta.fields[meta.fields.length - 1]
  return last && last.endsWith('状态') ? last : null
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function hasDate(value: unknown): boolean {
  return typeof value === 'string' && DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(value))
}

/**
 * 治理工程缺来源项目的状态回填口径：
 * 有竣工日期 → 已竣工；否则有开工日期 → 施工中；两者皆无 → 待立项。
 * 仅用于「存储里有、种子里没有同 id 来源」的项目，且当前状态缺失或非法时。
 */
export function deriveEngineeringStatus(row: EntryRow): string {
  if (hasDate(row['竣工日期'])) {
    return '已竣工'
  }
  if (hasDate(row['开工日期'])) {
    return '施工中'
  }
  return '待立项'
}

/**
 * 来源指纹：剔除 pending（派生量）后对整条记录做规范化 JSON 的 FNV-1a 哈希。
 * 指纹相同 = 与种子逐字段一致（未被人工修改），种子升级时可以安全替换；
 * 指纹不同 = 人工改动过，初始化一律保留。
 */
export function rowFingerprint(row: EntryRow): string {
  const source: Record<string, unknown> = {}
  for (const key of Object.keys(row).sort()) {
    if (key === 'pending') {
      continue
    }
    source[key] = row[key]
  }
  return fnv1aHex(JSON.stringify(source))
}

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 由种子行集合生成指纹表，用于识别「未被人工修改」的行。 */
export function seedFingerprintSet(rows: EntryRow[]): Set<string> {
  return new Set(rows.map(rowFingerprint))
}
