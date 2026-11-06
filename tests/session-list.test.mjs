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
const indexKeys = ['title', 'sessionListMetadata', 'subagentCatalog', 'agentPreset']
const deferred = ['fixtureDetail', 'fixtureIndex', 'fixtureUnknown']

function row(sessionId, kind = 'cached') {
  return {
    sessionId, updatedAt: 123, agentAvailable: true, formatStatus: 'current',
    running: false, blank: false, cwd: '/fixture',
    projections: {
      kind, asOfSeq: 7,
      values: {
        title: sessionId,
        sessionListMetadata: { blank: false, lastPromptAt: 123 },
        subagentCatalog: [], agentPreset: 'eng',
        fixtureDetail: { entries: [{ seq: 1, text: 'synthetic detail', nested: { count: 10 } }] },
        fixtureIndex: { count: 42, nested: { enabled: true } },
        fixtureUnknown: [{ opaque: ['new projection value'] }],
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

async function install(ctx, config) {
  if (plugin === undefined) return undefined
  const fiber = ctx.plugin(plugin, config)
  await fiber.await()
  return fiber
}

test('list keeps only native index keys and defers whole unknown values without mutation', async t => {
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
    assert.deepEqual(Object.keys(item.projections.values), indexKeys)
    for (const key of indexKeys) {
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
    assert.equal(manager.projectionStore(id).get('fixtureDetail'), undefined)
    assert.equal(manager.projectionStore(id).get('title'), id)
  }
  await Promise.all([manager.refreshProjections('two'), manager.refreshProjections('two')])
  assert.deepEqual(reads, ['two'], 'concurrent detail requests are deduplicated by the real client')
  for (const key of deferred) assert.deepEqual(manager.projectionStore('two').get(key), row('two').projections.values[key])
  assert.equal(manager.projectionStore('one').get('fixtureDetail'), undefined)
  await manager.refreshList()
  assert.deepEqual(manager.projectionStore('two').get('fixtureDetail'), row('two').projections.values.fixtureDetail)
})

test('only the mounted controller instance changes and unloading restores its original descriptor', async t => {
  const ctx = await fixture(t)
  const other = await fixture(t)
  const target = ctx.sessionController[symbols.original]
  const descriptor = Object.getOwnPropertyDescriptor(target, 'list')
  const protoMethod = Object.getPrototypeOf(target).list
  const fiber = await install(ctx)
  assert.equal(Object.getPrototypeOf(target).list, protoMethod)
  assert.ok((await other.sessionController.list({})).items[0].projections.values.fixtureDetail)
  await fiber?.dispose()
  assert.deepEqual(Object.getOwnPropertyDescriptor(target, 'list'), descriptor)
  assert.ok((await ctx.sessionController.list({})).items[0].projections.values.fixtureDetail)
})

test('listProjectionKeys explicitly selects whole arbitrary values and replaces the default allowlist', async t => {
  for (const keys of [[...indexKeys, 'fixtureIndex'], ['fixtureUnknown', 'fixtureUnknown', 'fixtureAbsent'], []]) {
    await t.test(JSON.stringify(keys), async t => {
      const rows = [row('one')]
      const ctx = await fixture(t, rows)
      const fiber = await install(ctx, { listProjectionKeys: keys })
      const result = await ctx.sessionController.list({})
      const expected = keys.includes('title') ? [...indexKeys, 'fixtureIndex']
        : keys.length === 0 ? [] : ['fixtureUnknown']
      assert.deepEqual(Object.keys(result.items[0].projections.values), expected)
      for (const key of expected) assert.equal(result.items[0].projections.values[key], rows[0].projections.values[key])
      assert.equal(result.items[0].projections.asOfSeq, 7)
      assert.equal(result.items[0].projections.kind, 'cached')
      await fiber?.dispose()
      assert.deepEqual((await ctx.sessionController.list({})).items, rows)
    })
  }
})

// An independent generic plugin: it owns one projection and wraps the same method.
function filterFixture(ctx, { key }) {
  const controller = ctx.sessionController[symbols.original]
  ctx.effect(() => {
    const original = controller.list
    const descriptor = Object.getOwnPropertyDescriptor(controller, 'list')
    let enabled = true
    async function wrapped(...args) {
      const result = await Reflect.apply(original, this, args)
      if (!enabled) return result
      return { ...result, items: result.items.map(item => ({
        ...item, projections: { ...item.projections, values: Object.fromEntries(
          Object.entries(item.projections.values).filter(([name]) => name !== key),
        ) },
      })) }
    }
    Object.defineProperty(controller, 'list', { configurable: true, writable: true, value: wrapped })
    return () => {
      enabled = false
      if (Object.getOwnPropertyDescriptor(controller, 'list')?.value !== wrapped) return
      if (descriptor === undefined) delete controller.list
      else Object.defineProperty(controller, 'list', descriptor)
    }
  })
}
filterFixture.inject = ['sessionController']

test('independent wrappers compose across both installation and disposal orders', async t => {
  for (const installOrder of [['lazy', 'other'], ['other', 'lazy']]) {
    for (const disposeOrder of [['lazy', 'other'], ['other', 'lazy']]) {
      await t.test(`install ${installOrder.join(' / ')}; dispose ${disposeOrder.join(' / ')}`, async t => {
        const rows = [row('one'), row('two')]
        const ctx = await fixture(t, rows)
        const other = await fixture(t)
        const fibers = {}
        for (const name of installOrder) {
          fibers[name] = name === 'lazy'
            ? await install(ctx, { listProjectionKeys: [...indexKeys, 'fixtureIndex'] })
            : await ctx.plugin(filterFixture, { key: 'fixtureIndex' }).await()
        }
        const restricted = ctx.extend({ invocation: { allowed: ['one'] } }).get('sessionController')
        const signal = new AbortController().signal
        async function listedKeys() {
          const result = await restricted.list({}, signal)
          assert.deepEqual(result.items.map(item => item.sessionId), ['one'])
          return Object.keys(result.items[0].projections.values)
        }
        assert.deepEqual(await listedKeys(), indexKeys)
        const nativeError = new Error('stacked cancellation')
        await assert.rejects(restricted.list({}, AbortSignal.abort(nativeError)), error => error === nativeError)
        await fibers[disposeOrder[0]]?.dispose()
        const expected = disposeOrder[0] === 'lazy'
          ? [...indexKeys, 'fixtureDetail', 'fixtureUnknown'] : [...indexKeys, 'fixtureIndex']
        assert.deepEqual(await listedKeys(), expected, 'only the remaining active wrapper may filter')
        await fibers[disposeOrder[1]]?.dispose()
        assert.deepEqual(await listedKeys(), Object.keys(rows[0].projections.values), 'both disposed wrappers must pass through')
        assert.deepEqual((await other.sessionController.list({})).items, [row('one'), row('two', 'sequenced')])
        assert.deepEqual(rows, [row('one'), row('two')], 'wrapper composition cannot mutate host rows')
      })
    }
  }
})

test('disposing while native list is pending leaves the response unfiltered', async t => {
  const rows = [row('one')]
  const ctx = await fixture(t, rows)
  let release
  let entered
  const pending = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  ctx.sessionController.listState.list = async () => { entered(); return pending }
  const fiber = await install(ctx)
  const request = ctx.sessionController.list({})
  await started
  await fiber?.dispose()
  release(rows)
  assert.deepEqual((await request).items, rows)
})

test('native index projections preserve the cold client list and child address without detail reads', async t => {
  const parent = row('parent')
  parent.blank = true
  parent.updatedAt = 1
  parent.projections.values.sessionListMetadata.lastPromptAt = 456
  parent.projections.values.subagentCatalog = [{ id: 'child', mode: 'one-shot', label: 'Fixture child' }]
  const child = { ...row('child'), parentSessionId: 'parent', origin: 'subagent' }
  const ctx = await fixture(t, [parent, child])
  await install(ctx)
  const manager = new SessionManager({ session: {
    list: async (...args) => ({ ok: true, value: await ctx.sessionController.list(...args) }),
    projections: async () => { assert.fail('the list index must not request session details') },
  } })
  t.after(() => manager.dispose())
  await manager.refreshList()
  const snapshot = manager.getListSnapshot()
  const entry = snapshot.items.find(item => item.sessionId === 'parent')
  assert.equal(entry.title, 'parent')
  assert.equal(entry.blank, false)
  assert.equal(entry.updatedAt, 456)
  assert.equal(entry.projectionValues.agentPreset, 'eng')
  assert.deepEqual(manager.subagentAddress('child'), { parentSessionId: 'parent', childSessionId: 'child', mode: 'one-shot' })
})

test('invalid projection key configuration is rejected before the controller is wrapped', async t => {
  const ctx = await fixture(t)
  const target = ctx.sessionController[symbols.original]
  const original = target.list
  const fiber = ctx.plugin(plugin, { listProjectionKeys: [123] })
  await assert.rejects(fiber.await(), /invalid config/)
  assert.equal(target.list, original)
  assert.ok((await ctx.sessionController.list({})).items[0].projections.values.fixtureUnknown)
})

test('unload restores an existing own descriptor exactly', async t => {
  const ctx = await fixture(t)
  const target = ctx.sessionController[symbols.original]
  const descriptor = { configurable: true, enumerable: true, writable: false, value: target.list }
  Object.defineProperty(target, 'list', descriptor)
  const fiber = await install(ctx)
  assert.equal(Object.hasOwn((await ctx.sessionController.list({})).items[0].projections.values, 'fixtureUnknown'), false)
  await fiber?.dispose()
  assert.deepEqual(Object.getOwnPropertyDescriptor(target, 'list'), descriptor)
})

test('unload preserves a newer accessor even when it returns the lazy wrapper', async t => {
  const ctx = await fixture(t)
  const target = ctx.sessionController[symbols.original]
  const fiber = await install(ctx)
  const wrapper = target.list
  let getterCalls = 0
  const get = () => { getterCalls++; return wrapper }
  Object.defineProperty(target, 'list', { configurable: true, enumerable: true, get })
  await fiber?.dispose()
  assert.equal(getterCalls, 0, 'cleanup must check the own descriptor without invoking a newer accessor')
  assert.equal(Object.getOwnPropertyDescriptor(target, 'list').get, get)
  assert.ok((await ctx.sessionController.list({})).items[0].projections.values.fixtureUnknown)
})

test('native cancellation and errors propagate instead of being hidden by the plugin', async t => {
  const ctx = await fixture(t)
  await install(ctx)
  const reason = new Error('cancelled fixture')
  await assert.rejects(ctx.sessionController.list({}, AbortSignal.abort(reason)), error => error === reason)
  const failure = new Error('native list failure')
  ctx.sessionController.listState.list = async () => { throw failure }
  await assert.rejects(ctx.sessionController.list({}), error => error === failure)
})
