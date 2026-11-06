# dsh-lazy-session-list

DSH 宿主插件：把会话详情从 `POST /api/session/list` 延迟到打开对应会话时加载。适配并验证 DSH `0.2.1-rc.2`、Cordis `4.0.5`，纯 ESM，无构建步骤。

## 行为

列表返回时省略以下三个完整 projection key：

- `contextHeaders`：上下文头和工具统计记录。
- `turnOutline`：每轮输入与回复的预览。
- `better-goal-history`：历史目标。

打开会话后，原生 history baseline 会提供完整 projection；需要独立读取时可调用现有 `sessions.refreshProjections(sessionId)`，底层使用 `session/projections`。普通 projection 订阅本身不触发网络加载。

保留标题、排序、运行/空白状态、父子关系、预设和其他插件字段。尤其保留整个 `contextTimeline` 与 `contextActivity`：当前 dsh-context 的 Insights Overview 直接用全列表汇总历史用量和费用，没有独立的补载步骤。

列表仍返回全部可见会话行，本插件处理的是每行夹带的详情，不改变会话分页行为。若要进一步把列表缩至基本索引，需要同时为 Insights Overview 增加按页面加载的统计接口，不能直接删除统计字段。

## 接入边界

插件通过 Cordis 注入现有 `sessionController`，为当前实例的 `list` 安装包装器。调用原方法时保留调用方 receiver，因此仍走原有逐会话授权过滤；只在返回后、gateway 编码前省略详情 key。卸载时恢复原属性描述符，不修改共享 prototype，不注册第二个 HTTP/RPC 路由。

只省略完整 key，保留其余 value、`kind`、`asOfSeq` 原样。不能把某个 value 缩水后仍标原序号，否则同序号的完整 baseline 可能无法覆盖它。完整 history/control baseline 与 `session/projections` 不做裁剪。

本方案减少 JSON 编码、传输和浏览器处理量。宿主仍会先构造原列表快照，不宣称避免了宿主所有 projection 读取/计算。

## 本机验证

真实 Cordis、宿主原 `SessionController.list` 和真实客户端 `SessionManager` 的 5 项回归已通过，覆盖：

- 整 key 延迟与摘要、未知字段、水位线保留；原始数据不变。
- 并发调用方的权限过滤。
- 冷客户端不扇出详情请求；只补载指定会话；同序号能补齐；列表刷新不清除已加载详情。
- 实例隔离与卸载恢复。
- 原生取消和错误继续传播。

对当前 GUI 一份响应进行隔离重放，1,269 个会话的解压 JSON 从 **9,273,942 字节**降至 **4,395,656 字节**，减少 **52.6%**。另请求原生详情接口，确认三个详情 key 均仍可读取。重放只在测试进程挂载插件，未修改运行中的 GUI。

## 安装

在本包目录运行 `npm pack`，再将生成的包加入目标 profile：

```sh
# 本地构建包；无需前端构建。
npm pack

dsh plugin --profile web add ./dsh-lazy-session-list-0.1.0.tgz
```

应用 profile 变更后刷新浏览器。以全新页面验证列表响应，旧页面已缓存的详情不会因列表省略 key 而自动清空。安装前请确认目标 profile 使用受支持的宿主版本。

移除该 bundle 或禁用 `dsh-lazy-session-list` 行即可恢复原列表行为。

## 开发验证

正常安装本包 peer dependencies，另在独立目录安装真实浏览器 store 支持包：

```sh
npm install
npm ci --prefix tests/client-support
npm test

# 相同断言对未改动宿主运行：应有两项失败，证明测试能捕获全量详情问题。
LAZY_SESSION_LIST_BASELINE=1 node --test tests/session-list.test.mjs

# 只读读取当前 API，在本地隔离上下文挂载插件并比较体积。
npm run smoke -- http://127.0.0.1:3384
```

浏览器 store 的上游包把 Zustand/Immer 声明为开发依赖，测试支持目录显式固定相应版本。测试依赖和测试脚本不进入发布包；运行插件只需要宿主提供 peer 服务。
