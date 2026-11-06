# dsh-lazy-session-list

DSH 宿主插件：为 `POST /api/session/list` 保留可配置的基本 projection 索引，其余字段通过原生接口按会话加载。面向任意 DSH 插件组合，不识别第三方插件名称、字段结构或私有接口。验证宿主版本为 DSH `0.2.1-rc.2`、Cordis `4.0.5`；纯 ESM，无构建步骤。

本插件独立发布、独立安装，不属于 Apollo 整合包。安装 Apollo 不会安装或启用本插件；需要时将本插件单独加入目标 DSH profile。

## 通用契约

默认仅保留四个 DSH 原生 projection key：

| Key | 官方宿主列表用途 |
| --- | --- |
| `title` | 会话标题。 |
| `sessionListMetadata` | 空白状态与最近提示时间，供列表状态、排序使用。 |
| `subagentCatalog` | 父子关系、子代理导航和侧栏运行中子代理计数。 |
| `agentPreset` | 已保存会话的预设索引与空白会话恢复。 |

以上按已安装官方 rc.2 的 `SessionManager.buildListSnapshot`、会话 service 列表派生与 workspace 侧栏消费点核对；均由官方 projection 注册。会话行的 `cwd`、父级、运行状态等宿主 metadata 保持原样。所有未选中的 projection key（包括未来新增或未知字段）整体省略。列表仍返回原方法授权后返回的全部会话行，不改变行数、行序或分页。

保留的每个 value 都是完整原值，`kind`、`asOfSeq` 及其余响应 metadata 保持原样；不裁剪 value 内部结构、不伪造水位线、不修改共享源数据。不允许把缩水后的 value 标成原序号，因为这会阻止相同序号的完整 baseline 补齐。

打开会话时，原生 history baseline 提供完整 projection；页面也可调用现有 `sessions.refreshProjections(sessionId)`，底层是 `session/projections`。普通 projection 订阅本身不发起网络加载。本插件不裁剪 history、control baseline 或单会话 projections。被省略的字段可在相同序号补齐；后续列表刷新也不会清除客户端已经加载的详情。

插件或页面若需要跨会话的额外信息，应自行设计按需加载，或由部署显式配置保留所需字段。本插件不会推测其他插件的依赖，也不会为全列表扇出详情请求。额外原生详情同样遵循此契约；默认最小索引并不承诺保留所有页面的统计、耗时或详情展示。

## 配置

`listProjectionKeys` 是完整白名单，显式配置会**替换**默认列表。要增加部署自定义索引，请一并写出需要保留的原生键。例如，下面的 `deploymentIndex` 只是任意字段名的示例：

```yaml
- id: dsh-lazy-session-list
  name: dsh-lazy-session-list
  config:
    listProjectionKeys:
      - title
      - sessionListMetadata
      - subagentCatalog
      - agentPreset
      - deploymentIndex
```

Cordis 通过导出的 Schemastery `Config` 验证字符串数组。省略配置使用默认四键；重复键不改变结果，未出现在源响应的键不会被合成。空数组 `[]` 会省略全部 projection key，适用于部署自担列表索引缺失影响的场景。配置不能恢复其他 wrapper 已经删除的字段。

## 接入和生命周期

插件注入现有 `sessionController`，只包装该服务实例的 `list` 方法。通过 `Reflect.apply(original, this, args)` 保留调用方 receiver、参数和取消信号，原有逐会话授权、错误传播继续生效；不改共享 prototype、不注册第二个 HTTP/RPC 路由。

卸载 effect 时先停用自己的 wrapper，包括等待原方法完成的调用，再仅在当前 **own 属性描述符的 value** 仍是自己时恢复原描述符或删除新增 own 属性。后安装的 wrapper 不被覆盖；如果旧 wrapper 仍在别人的调用链中，或后来被别人恢复，它只透传。遵守相同停用/所有权规则的独立 wrapper 可按任意顺序安装、卸载，无需互相识别。卸载其他任意插件的实现问题不由本插件接管。

本方案减少 JSON 编码、传输和客户端处理量。宿主仍先构造原始列表快照，不宣称避免所有 projection 读取、计算或加载成本。

## 安装

当前源码版本为 `0.2.0`，与旧版本的字段保留策略不同。确认部署所需字段后，在本包目录打包并加入目标 profile：

```sh
npm pack
dsh plugin --profile web add ./dsh-lazy-session-list-0.2.0.tgz
```

应用 profile 变更并刷新页面。冷客户端适合检查初始列表策略；旧客户端已缓存的详情不会因列表省略字段而自动清空。移除 bundle 或禁用插件行可恢复原列表行为。本轮源码修改不自动生成 tarball。

运行 peer dependencies：`@deepseek-ai/cordis ~4.0.5`、`@deepseek-ai/dsh-api-session-controller 0.2.1-rc.2`，以及新增的 `@deepseek-ai/schemastery ~3.18.5`（使用宿主已有版本）。测试继续使用独立 `tests/client-support` 的真实客户端 store、Zustand 和 Immer；这些支持依赖不进入发布包。

## 开发验证

```sh
npm install
npm ci --prefix tests/client-support
npm test

# 仅把默认列表与冷客户端的两个相同断言对未改动宿主运行：预期失败。
LAZY_SESSION_LIST_BASELINE=1 node --test --test-name-pattern="list keeps only|a cold client" tests/session-list.test.mjs

# 一次只读 list 请求，在本地隔离 Cordis 环境中重放默认策略。
npm run smoke -- http://127.0.0.1:3384
```

回归使用真实 Cordis、宿主原始 `SessionController.list` 和真实客户端 `SessionManager`，只控制查询源数据与授权策略。覆盖完整未知值延迟、通用配置、冷列表不扇出、单会话同序号补齐、保留原生索引、并发授权、取消/错误、实例隔离、原描述符恢复、独立 wrapper 双安装序与双卸载序，以及卸载时仍在途的请求。fixture 使用通用合成字段。

`live-smoke` 只检查通用白名单、原值与水位线、源数据不变、卸载恢复和解压 JSON 体积。它只请求一次 `session/list`，**不请求 history/projections 或任何单会话详情**，不改正在运行的 GUI/profile，不保存或输出会话内容、ID 或未知字段名称。输出仅包含行数、字节数、删键次数等汇总。它不验证实际浏览器渲染、线上压缩率或各插件页面是否实现了补载；按需完整加载由真实客户端回归验证。没有可省略字段时，体积可以保持不变。

## 本轮执行记录（2026-11-06）

- `npm test`：21 项通过（包含子测试），0 失败、0 跳过；使用现有已安装真实宿主/客户端支持环境。
- 上述未改动宿主基线命令：两项策略断言均按预期失败，证明能捕获默认全量详情与冷客户端提前加载。
- 仅在独立 Node 进程的模块加载时注入故障、未修改磁盘源码：把卸载停用改为仍启用会导致 4 项失败；恢复旧的属性值检查会导致 accessor 所有权用例失败。
- `git diff --check` 通过。只新增宿主已安装 Schema 的 peer 声明，没有安装新运行/测试依赖。
- 本地 smoke 回归使用合成 HTTP 响应与真实脚本子进程；本轮不据此宣称真实 GUI 渲染或现场体积已验证。真实部署测量由集成验证另行记录。
- 保留为隔离分支中的未提交修改；未生成新 tarball。
