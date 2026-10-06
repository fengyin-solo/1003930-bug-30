import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

function terminalStatus(meta: ModuleMeta): string {
  return meta.terminalStatus ?? meta.statuses[meta.statuses.length - 1]
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 当前记录可执行的动作：统一按模块的来源状态闸门过滤，页面不再各写一套判断。 */
export function availableActions(key: string, row: EntryRow): string[] {
  const meta = moduleMeta(key)
  const current = String(row.status)
  return meta.actions.filter((action) => {
    const allowed = meta.actionGuards?.[action]
    if (allowed && !allowed.includes(current)) {
      return false
    }
    return meta.actionTargets[action] !== current
  })
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const allowedSources = meta.actionGuards?.[action]
  if (allowedSources && !allowedSources.includes(current)) {
    return {
      ok: false,
      message: `只有「${allowedSources.join('、')}」的${meta.entity}才能${action}，当前状态「${current}」`,
    }
  }
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== terminalStatus(meta),
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    // 人工动作落库即锁定：之后统一初始化不会再用日期回填覆盖它。
    _manual: true,
  }
  const next = [...rows]
  next[index] = updated

  // 治理工程申请验收后，验收侧记录镜像同一结论，保证两个页面口径一致。
  if (key === 'engineering' && action === '申请验收') {
    const projectCode = String(updated['项目编号'])
    const acceptanceRows = listRows('acceptance')
    const acceptanceIndex = acceptanceRows.findIndex(
      (row) => String(row['项目编号']) === projectCode,
    )
    if (acceptanceIndex < 0) {
      saveRows(key, next, [id])
      return {
        ok: true,
        message: `${meta.entity}已${action}，当前状态「${target}」；验收报告登记入口尚未接入，请在工程验收模块补登记`,
      }
    }
    const acceptanceNext = [...acceptanceRows]
    acceptanceNext[acceptanceIndex] = {
      ...acceptanceRows[acceptanceIndex],
      '工程状态': target,
    }
    saveRows(key, next, [id])
    saveRows('acceptance', acceptanceNext)
  } else {
    saveRows(key, next, [id])
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
