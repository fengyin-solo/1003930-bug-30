/**
 * 初始化口径的可复现验证：内存版 Storage + 确定性断言。
 * 运行：node scripts/verify-init.mjs（由 scripts/build-verifier.mjs 先 esbuild 打包数据层）
 */

export class MemoryStorage {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial))
    this.writeCount = 0
    this.throwOnWrite = false
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null
  }
  setItem(key, value) {
    if (this.throwOnWrite) {
      throw new Error('模拟 localStorage 写入失败（配额/隐私模式）')
    }
    this.writeCount += 1
    this.map.set(key, value)
  }
  snapshot(key) {
    return this.map.get(key) ?? null
  }
}
