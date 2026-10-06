# 地质灾害隐患点监测防治管理系统

面向地质灾害隐患点形变裂缝观测、雨量预警、避险搬迁安置与治理工程验收全流程的地质灾害防治数字化管理平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 隐患点台账 | `hazard` | 隐患点 | 隐患点编号、隐患点名称、灾害类型 |
| 形变观测 | `deformation` | 形变记录 | 记录编号、隐患点编号、观测日期 |
| 裂缝监测 | `crack` | 裂缝测点 | 测点编号、隐患点编号、裂缝编号 |
| 倾斜监测 | `tilt` | 倾斜记录 | 记录编号、测点编号、观测方向 |
| 雨量监测 | `rain_gauge` | 雨量记录 | 记录编号、站点编号、观测时段 |
| 预警阈值 | `threshold` | 预警阈值 | 阈值编号、隐患点编号、监测类型 |
| 预警发布 | `alarm` | 预警通知 | 通知编号、隐患点编号、预警等级 |
| 避险搬迁 | `evacuation` | 搬迁安置户 | 户号、所属隐患点、户主姓名 |
| 巡查排查 | `patrol` | 巡查记录 | 巡查编号、隐患点编号、巡查日期 |
| 治理工程 | `engineering` | 治理工程项目 | 项目编号、隐患点编号、治理方案 |
| 工程验收 | `acceptance` | 验收报告 | 验收编号、项目编号、验收类型 |
| 整改跟踪 | `rectification` | 整改任务 | 任务编号、验收编号、整改内容 |
| 应急演练 | `drill` | 演练记录 | 演练编号、隐患点编号、演练主题 |
| 监测设备 | `device` | 监测设备 | 设备编号、设备类型、所属隐患点 |
| 灾情速报 | `report` | 灾情速报 | 速报编号、隐患点编号、发生时间 |
| 防灾宣传 | `propaganda` | 宣传活动 | 活动编号、宣传主题、宣传方式 |
| 承建单位 | `contract` | 承建单位 | 单位编号、单位名称、资质等级 |
| 群测群防培训 | `training` | 培训记录 | 培训编号、培训主题、培训对象 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `geohazard-monitor-prevention:entries` 这一项，或调用 `resetModule(模块)`。

## 统一初始化口径

本地开发（`npm run dev`）、构建预览（`npm run preview`）与浏览器里的存量数据，启动时都走
`frontend/src/data/init.ts` 里的**同一套纯函数初始化管线**，由 `main.ts` 在挂载前执行
（入口为 `local-store.ts` 的 `initializeStore()`）：

1. **版本信封**：存储结构为 `{ version, meta, entries }`（schema v2）。`meta` 记录初始化批次号、
   示例数据指纹（FNV-1a）、基准日期与上次结果，跨页面、跨重启读到的都是同一份口径。
2. **存量迁移**：旧版裸数据（无信封）按业务编号（如 `项目编号`）合并回示例数据，而不是整体覆盖；
   示例中已不存在的人工记录原样保留。迁移完成后后续启动直接沿用信封。
3. **缺来源回填**：治理工程中非人工的项目，状态按开工/竣工日期相对固定基准日期
   （`REFERENCE_DATE`，见 `init.ts`）回填——未开工→待立项、在建→施工中、已竣工→已竣工；
   「待验收」作为人工流转的权威状态直接保留。
4. **人工修改不覆盖**：任何动作流转落库的记录都打 `_manual: true`，初始化回填一律跳过；
   旧版数据则按其与旧示例状态的差异识别人工修改。
5. **跨页面一致**：验收记录带 `工程状态` 镜像字段，初始化时与治理工程侧结论对齐；
   「申请验收」只有「已竣工」项目可发起，「启动验收」只有「待验收」项目可发起，
   闸门集中在 `modules.ts` 的 `actionGuards`。
6. **幂等**：已是当前版本且指纹一致时重复启动只记一条 `init-skip-idempotent`，
   不重新播种、不追加项目。
7. **整批回退**：初始化全程只产出下一份信封，序列化成功后才唯一一次写入；
   任何一步失败（缺开工日期、业务编号重复、验收引用不存在的工程、存储损坏等）
   都不覆盖原数据，内存回退到纯示例数据，并把可复现日志写入
   `geohazard-monitor-prevention:init-logs`（运营概览页可见）。

验证初始化口径（不依赖浏览器，内存模拟 localStorage，共 42 项断言）：

```bash
cd frontend
npm run verify:init
```
