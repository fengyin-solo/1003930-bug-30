#!/usr/bin/env node
// 把 TS 验证脚本（含 @ 别名之外的数据层源码）打包成 CJS 后交给 node --test 运行。
// 不引入任何测试框架依赖，只用 Node 内置 node:test + 项目已有的 esbuild。
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { rm } from 'node:fs/promises'

const here = dirname(fileURLToPath(import.meta.url))
const outfile = join(here, '.verify-init.bundle.cjs')

await build({
  entryPoints: [join(here, 'verify-init.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile,
  sourcemap: false,
  logLevel: 'warning',
})

try {
  await import(`node:child_process`).then(({ execFileSync }) => {
    execFileSync(process.execPath, ['--test', outfile], { stdio: 'inherit', cwd: join(here, '..') })
  })
} finally {
  await rm(outfile, { force: true })
}
