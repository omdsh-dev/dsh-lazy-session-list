import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.js'

const origin = process.argv[2] ?? 'http://127.0.0.1:3384'
const deferred = ['contextHeaders', 'turnOutline', 'better-goal-history']
const bytes = value => Buffer.byteLength(JSON.stringify(value))

async function rpc(method, args) {
  const response = await fetch(new URL('/api/' + method, origin), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
    signal: AbortSignal.timeout(20_000),
  })
  assert.equal(response.status, 200)
  const envelope = await response.json()
  assert.equal(envelope.result.ok, true, JSON.stringify(envelope.result.error))
  return envelope
}

// Read the live data once; install the plugin only in this isolated replay context.
// The running GUI, its profile and its packages are never modified by this script.
const envelope = await rpc('session/list', { _request: {} })
const original = envelope.result.value
const before = bytes(envelope)
class ReplayController extends Service {
  constructor(ctx) { super(ctx, 'sessionController') }
  async list() { return original }
}
const ctx = new Context()
try {
  await ctx.plugin(ReplayController)
  const addon = ctx.plugin(plugin)
  await addon
  const slim = await ctx.sessionController.list({})
  assert.deepEqual(slim.items.map(row => row.sessionId), original.items.map(row => row.sessionId))
  for (let index = 0; index < slim.items.length; index++) {
    const left = original.items[index]
    const right = slim.items[index]
    const { projections: source, ...sourceMeta } = left
    const { projections: target, ...targetMeta } = right
    assert.deepEqual(targetMeta, sourceMeta)
    if (source === undefined) continue
    assert.equal(target.kind, source.kind)
    assert.equal(target.asOfSeq, source.asOfSeq)
    for (const [key, value] of Object.entries(source.values)) {
      if (deferred.includes(key)) assert.equal(Object.hasOwn(target.values, key), false, key)
      else assert.equal(target.values[key], value, key)
    }
  }
  assert.equal(bytes(envelope), before, 'the full source response must not be mutated')
  const after = bytes({ ...envelope, result: { ...envelope.result, value: slim } })
  const sample = original.items.find(row => deferred.every(key => Object.hasOwn(row.projections?.values ?? {}, key)))
    ?? original.items.find(row => row.projections?.values.contextHeaders !== undefined)
  assert.ok(sample, 'need a real session containing deferred details')
  const detail = (await rpc('session/projections', { request: { sessionId: sample.sessionId } })).result.value
  assert.ok(detail)
  const keys = deferred.filter(key => Object.hasOwn(detail.values, key))
  assert.ok(keys.includes('contextHeaders'), 'the native detail endpoint must still serve deferred data')
  await addon.dispose()
  assert.equal(await ctx.sessionController.list({}), original, 'unload restores the full list')
  console.log(JSON.stringify({
    mode: 'isolated replay of a live response; not installed in the running GUI',
    rows: original.items.length, decodedBytesBefore: before, decodedBytesAfter: after,
    reductionPercent: Math.round((1 - after / before) * 1000) / 10,
    deferredKeys: deferred, nativeDetailKeysVerified: keys,
    keptSummaryKeys: ['contextTimeline', 'contextActivity'],
    verified: ['row order and metadata', 'whole retained values and watermarks', 'source immutability', 'native detail API', 'unload restoration'],
  }, null, 2))
} finally {
  await ctx.fiber.dispose()
}
