import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import { SessionController } from '@deepseek-ai/dsh-api-session-controller'

const require = createRequire(import.meta.url)
const clientRequire = createRequire(new URL('./client-support/package.json', import.meta.url))
const clientStore = pathToFileURL(clientRequire.resolve('@deepseek-ai/dsh-client-store')).href
// The host publishes browser source without installing this browser-only dependency.
registerHooks({ resolve: (specifier, context, next) => next(specifier === '@deepseek-ai/dsh-client-store' ? clientStore : specifier, context) })
const hostRoot = dirname(require.resolve('@deepseek-ai/dsh-api-session-controller/package.json'))
const { SessionManager } = await import(pathToFileURL(join(hostRoot, 'lib/types/client/sessions/manager.js')))
// Run the same assertions against the unmodified host to demonstrate the failure.
const plugin = process.env.LAZY_SESSION_LIST_BASELINE === '1' ? undefined : await import('../src/index.js')
const deferred = ['contextHeaders', 'turnOutline', 'better-goal-history']

function row(sessionId, kind = 'cached') {
  return {
    sessionId, updatedAt: 123, agentAvailable: true, formatStatus: 'current',
    running: false, blank: false, cwd: '/fixture',
    projections: {
      kind, asOfSeq: 7,
      values: {
        title: sessionId,
        sessionListMetadata: { blank: false, lastPromptAt: 123 },
        contextTimeline: { current: { total: 42 }, timing: { wallMs: 12 } },
        contextActivity: { days: { '2026-11-06': { tokens: 42 } } },
        subagentCatalog: [], agentPreset: 'eng',
        unknownPlugin: { retained: true },
        contextHeaders: { headers: [{ seq: 1, time: 123, tools: [{ name: 'read', tokens: 10, plugin: 'fs' }] }] },
        turnOutline: [{ turn: 1, seq: 1, prompt: 'prompt preview', response: 'response preview' }],
        'better-goal-history': { entries: [{ id: 'goal-1', objective: 'historical objective' }], error: null },
      },
    },
  }
}

// Real Cordis tracing and the host's actual list authorization implementation;
// only the session-query result and access policy are controlled fixture inputs.
class AccessPolicy extends Service {
  constructor(ctx) { super(ctx, 'remoteAccess') }
  allows(resource) {
    return this.ctx.invocation?.allowed === undefined || this.ctx.invocation.allowed.includes(resource.id)
  }
}

class ControllerFixture extends Service {
  constructor(ctx, rows) {
    super(ctx, 'sessionController')
    this.listState = { list: async (signal) => { signal?.throwIfAborted(); return rows } }
    this.rows = rows
  }
  list(...args) { return Reflect.apply(SessionController.prototype.list, this, args) }
  async projections({ sessionId }) {
    const source = this.rows.find(item => item.sessionId === sessionId)
    return source === undefined ? null : { ...source.projections, kind: 'sequenced' }
  }
}

async function fixture(t, rows = [row('one'), row('two', 'sequenced')]) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(AccessPolicy).await()
  await ctx.plugin(ControllerFixture, rows).await()
  return ctx
}

async function install(ctx) {
  if (plugin === undefined) return undefined
  const fiber = ctx.plugin(plugin)
  await fiber.await()
  return fiber
}

test('list defers entire detail keys and preserves summaries, unknown keys and watermarks', async t => {
  const rows = [row('one'), row('two', 'sequenced'), { sessionId: 'no-hints', blank: false }]
  const before = structuredClone(rows)
  const ctx = await fixture(t, rows)
  await install(ctx)
  const result = await ctx.sessionController.list({})
  assert.deepEqual(result.items.map(item => item.sessionId), rows.map(item => item.sessionId))
  for (let index = 0; index < 2; index++) {
    const item = result.items[index]
    for (const key of deferred) assert.equal(Object.hasOwn(item.projections.values, key), false, key)
    assert.equal(item.projections.kind, rows[index].projections.kind)
    assert.equal(item.projections.asOfSeq, 7)
    for (const key of ['title', 'sessionListMetadata', 'contextTimeline', 'contextActivity', 'unknownPlugin', 'subagentCatalog', 'agentPreset']) {
      assert.equal(item.projections.values[key], rows[index].projections.values[key], key)
    }
  }
  assert.equal(result.items[2], rows[2])
  assert.deepEqual(rows, before, 'shared host data must remain intact')
  const details = await ctx.sessionController.projections({ sessionId: 'one' })
  for (const key of deferred) assert.equal(details.values[key], rows[0].projections.values[key])
})

test('the original per-invocation access filter remains effective for concurrent callers', async t => {
  const ctx = await fixture(t)
  await install(ctx)
  const restricted = ctx.extend({ invocation: { allowed: ['one'] } }).get('sessionController')
  const owner = ctx.extend({ invocation: { allowed: ['one', 'two'] } }).get('sessionController')
  const [limited, full] = await Promise.all([restricted.list({}), owner.list({})])
  assert.deepEqual(limited.items.map(item => item.sessionId), ['one'])
  assert.deepEqual(full.items.map(item => item.sessionId), ['one', 'two'])
})

test('a cold client loads details only for the requested session, including at the same sequence', async t => {
  const ctx = await fixture(t)
  await install(ctx)
  const reads = []
  const manager = new SessionManager({ session: {
    list: async (...args) => ({ ok: true, value: await ctx.sessionController.list(...args) }),
    projections: async (request) => {
      reads.push(request.sessionId)
      return { ok: true, value: await ctx.sessionController.projections(request) }
    },
  } })
  t.after(() => manager.dispose())
  await manager.refreshList()
  assert.deepEqual(reads, [], 'listing must not fan out into detail requests')
  for (const id of ['one', 'two']) {
    assert.equal(manager.projectionStore(id).get('contextHeaders'), undefined)
    assert.equal(manager.projectionStore(id).get('title'), id)
  }
  await Promise.all([manager.refreshProjections('two'), manager.refreshProjections('two')])
  assert.deepEqual(reads, ['two'], 'concurrent detail requests are deduplicated by the real client')
  for (const key of deferred) assert.deepEqual(manager.projectionStore('two').get(key), row('two').projections.values[key])
  assert.equal(manager.projectionStore('one').get('contextHeaders'), undefined)
  await manager.refreshList()
  assert.deepEqual(manager.projectionStore('two').get('contextHeaders'), row('two').projections.values.contextHeaders)
})

test('only the mounted controller instance changes and unloading restores its original descriptor', async t => {
  const ctx = await fixture(t)
  const other = await fixture(t)
  const target = ctx.sessionController[symbols.original]
  const descriptor = Object.getOwnPropertyDescriptor(target, 'list')
  const protoMethod = Object.getPrototypeOf(target).list
  const fiber = await install(ctx)
  assert.equal(Object.getPrototypeOf(target).list, protoMethod)
  assert.ok((await other.sessionController.list({})).items[0].projections.values.contextHeaders)
  await fiber?.dispose()
  assert.deepEqual(Object.getOwnPropertyDescriptor(target, 'list'), descriptor)
  assert.ok((await ctx.sessionController.list({})).items[0].projections.values.contextHeaders)
})

test('native cancellation and errors propagate instead of being hidden by the plugin', async t => {
  const ctx = await fixture(t)
  await install(ctx)
  const reason = new Error('cancelled fixture')
  await assert.rejects(ctx.sessionController.list({}, AbortSignal.abort(reason)), error => error === reason)
})
