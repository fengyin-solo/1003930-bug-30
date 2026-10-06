# 地质灾害隐患点监测防治管理系统

面向地质灾害隐患点形变裂缝观测、雨量预警、避险搬迁安置与治理工程验收全流程的地质灾害防治数字化管理平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供。本地开发（`vite dev`）、构建预览（`vite preview`
或静态托管产物）与存量浏览器数据共用**同一个初始化入口**
`frontend/src/data/bootstrap.ts`：应用挂载前执行一次幂等、事务化的合流，结果持久化在
浏览器 `localStorage` 里（`geohazard-monitor-prevention:entries`，版本化信封），刷新或重开
浏览器都还在。dev server 已关掉自动打开页面，启动后按终端打印的地址手工打开。

## 数据初始化口径

初始化只做一次整批构建、一次写入，任何一步失败都**整批回退**（不改动存量数据），并在
console 与 `geohazard-monitor-prevention:init-log` 留下带确定性 `runId` 的结构化日志。

- **幂等**：按 `(模块, id)` 合流，重复启动不追加项目；结果逐字节稳定。
- **人工修改不被覆盖**：每行有来源指纹（剔除派生量 `pending` 后整行哈希）。与种子逐字段
  一致的行才会随种子升级；任何业务字段被改过就原样保留，只刷新派生量。
- **缺来源项目回填**：存储里有、种子里没有同 id 的治理工程项目，状态缺失或非法时按
  「竣工日期 → 已竣工；否则开工日期 → 施工中；都没有 → 待立项」回填，且只回填一次。
- **派生口径统一**：`pending` 一律按「状态末态之外都算待处理」推导；各模块最后一个
  「…状态」字段（项目状态、验收状态、设备状态…）是核心 `status` 的镜像，初始化、页面
  动作流转共用同一规则（`src/data/derive.ts`），列表、详情、验收页结论一致。
- **存量迁移**：无版本号的旧数据自动迁移到 v2，旧版未修改的示例行按
  `src/data/legacy-v1.ts` 原文识别后升级，人工修改继续保留。

可重复验证（内存版 Storage + Node 内置 test runner，无需额外依赖）：

```bash
cd frontend
npm run verify:init
```

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
  `frontend/src/data/seed.ts`（种子必须自洽：末字段镜像与 status 一致、pending 合口径）。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断；派生规则统一放在
  `frontend/src/data/derive.ts`，初始化与运行时动作都从这里取。
- 初始化逻辑集中在 `frontend/src/data/bootstrap.ts`，由 `main.ts` 在挂载前调用；
  `local-store.ts` 只读写它产出的版本化信封。
- 想回到初始数据：清掉浏览器里 `geohazard-monitor-prevention:entries` 这一项（下次启动会
  全新播种），或对单个模块调用 `resetModule(模块)`。
- 初始化失败时数据不会被半写：查看 console 里的 `[data-init]` 日志或
  `geohazard-monitor-prevention:init-log`，用其中的 `runId` 复现该批次。
