<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>

    <h3 class="init-head">初始化口径</h3>
    <p class="init-meta" v-if="meta">
      批次 {{ meta.initializedAt }} · schema v{{ version }} · 数据指纹 {{ meta.seedFingerprint }}
      · 基准日期 {{ meta.referenceDate }} · 上次结果
      <span :class="meta.lastResult === 'success' ? 'init-ok' : 'init-bad'">
        {{ meta.lastResult === 'success' ? '成功' : '失败回退' }}
      </span>
    </p>
    <table class="data-table init-log">
      <thead>
        <tr><th>时间</th><th>批次</th><th>级别</th><th>事件</th><th>说明</th></tr>
      </thead>
      <tbody>
        <tr v-for="(log, index) in recentLogs" :key="index">
          <td>{{ log.at }}</td>
          <td>{{ log.runId }}</td>
          <td>{{ log.level }}</td>
          <td>{{ log.event }}</td>
          <td>{{ log.detail }}</td>
        </tr>
        <tr v-if="!recentLogs.length">
          <td colspan="5" class="empty-state">暂无初始化日志</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>数据保存在本机浏览器里，初始化失败会整批回退且不覆盖原有数据；重复启动沿用同一批次，不追加项目</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { loadOverview } from '@/api/local-service'
import { initLogs, initMeta, SCHEMA_VERSION } from '@/data/local-store'
import type { InitLogEntry, OverviewResult, StoreEnvelope } from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const meta = ref<StoreEnvelope['meta'] | null>(null)
const version = SCHEMA_VERSION
const recentLogs = ref<InitLogEntry[]>([])

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  meta.value = initMeta()
  recentLogs.value = initLogs().slice(-12).reverse()
}

onMounted(refresh)
</script>

<style scoped>
.init-head { margin: 18px 0 8px; font-size: 15px; }
.init-meta { font-size: 12px; color: var(--muted); margin: 0 0 10px; }
.init-ok { color: #067647; }
.init-bad { color: #b42318; }
.init-log { font-size: 12px; }
</style>
