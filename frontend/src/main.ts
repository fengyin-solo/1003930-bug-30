import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { initializeStore } from './data/local-store'
import './styles/global.css'

// 挂载前先跑统一初始化：本地开发、构建预览、存量浏览器数据共用同一套口径，
// 任何页面挂载时读到的都是同一份、已回填并迁移过的数据。
initializeStore()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
