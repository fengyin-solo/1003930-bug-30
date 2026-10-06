import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { initStore } from './data/local-store'
import { initLog } from './data/init-log'
import './styles/global.css'

// 挂载前完成唯一一次统一初始化：dev、preview、静态托管构建产物走同一条路径。
// 失败时整批回退（localStorage 未被改动），仍挂载页面以便从日志定位问题，
// 但数据层保留旧快照，后续保存动作会被 Storage 失败/错误日志暴露出来。
try {
  const report = initStore()
  console.info(`[data-init] 初始化完成：mode=${report.mode} runId=${report.runId}`)
} catch (error) {
  initLog.persistFailure(typeof window !== 'undefined' ? window.localStorage : null)
  console.error('[data-init] 初始化整批回退，未写入任何数据：', error)
}

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
