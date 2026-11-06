import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.js'

const origin = process.argv[2] ?? 'http://127.0.0.1:3384'
const listProjectionKeys = ['title', 'sessionListMetadata', 'subagentCatalog', 'agentPreset']
const retained = new Set(listProjectionKeys)
const serialize = value => JSON.stringify(value)
const bytes = value => Buffer.byteLength(serialize(value))

// Exactly one list request; no history/projections requests or per-session fan-out.
// Never print response bodies, titles, session IDs, unknown keys or retained values.
const response = await fetch(new URL('/api/session/list', origin), {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: serialize({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'session/list', payload: { args: { _request: {} } } }),
  signal: AbortSignal.timeout(20_000),
})
assert.equal(response.status, 200, 'session/list HTTP request failed')
const envelope = await response.json().catch(() => { throw new Error('session/list returned invalid JSON') })
assert.ok(envelope?.result?.ok === true, 'session/list RPC failed')
assert.ok(Array.isArray(envelope.result.value?.items), 'session/list returned an invalid list')
const original = envelope.result.value
const sourceJson = serialize(envelope)
const before = Buffer.byteLength(sourceJson)

// Replay only in an isolated Cordis instance; the running GUI is never modified.
class ReplayController extends Service {
  constructor(ctx) { super(ctx, 'sessionController') }
  async list() { return original }
}
const ctx = new Context()
try {
  await ctx.plugin(ReplayController).await()
  const addon = ctx.plugin(plugin)
  await addon.await()
  const slim = await ctx.sessionController.list({})
  assert.equal(slim.items.length, original.items.length, 'row count changed')
  let omittedKeyOccurrences = 0
  let rowsWithOmissions = 0
  for (let index = 0; index < slim.items.length; index++) {
    const { projections: source, ...sourceMeta } = original.items[index]
    const { projections: target, ...targetMeta } = slim.items[index]
    assert.ok(isDeepStrictEqual(targetMeta, sourceMeta), 'row order or metadata changed')
    if (source === undefined) {
      assert.ok(target === undefined, 'projection block was synthesized')
      continue
    }
    const { values: sourceValues, ...sourceBlock } = source
    const { values: targetValues, ...targetBlock } = target
    assert.ok(isDeepStrictEqual(targetBlock, sourceBlock), 'projection kind, watermark or envelope changed')
    assert.ok(Object.keys(targetValues).every(key => retained.has(key) && Object.hasOwn(sourceValues, key)), 'list contains an unselected or synthesized key')
    let omitted = 0
    for (const [key, value] of Object.entries(sourceValues)) {
      if (retained.has(key)) assert.ok(targetValues[key] === value, 'a retained whole value changed')
      else {
        assert.ok(!Object.hasOwn(targetValues, key), 'an unselected key was retained')
        omitted++
      }
    }
    omittedKeyOccurrences += omitted
    if (omitted > 0) rowsWithOmissions++
  }
  const { items: _sourceItems, ...sourceListMeta } = original
  const { items: _targetItems, ...targetListMeta } = slim
  assert.ok(isDeepStrictEqual(targetListMeta, sourceListMeta), 'list envelope changed')
  assert.ok(serialize(envelope) === sourceJson, 'source response was mutated')
  const after = bytes({ ...envelope, result: { ...envelope.result, value: slim } })
  assert.ok(after <= before, 'the policy increased the serialized response size')
  await addon.dispose()
  assert.ok(await ctx.sessionController.list({}) === original, 'unload did not restore the source list')
  console.log(serialize({
    mode: 'isolated replay of one live list response; not installed in the running GUI',
    listRequests: 1, detailRequests: 0, rows: original.items.length,
    decodedBytesBefore: before, decodedBytesAfter: after,
    reductionPercent: Math.round((1 - after / before) * 1000) / 10,
    listProjectionKeys, rowsWithOmissions, omittedKeyOccurrences,
    verified: ['row order and metadata', 'generic allowlist', 'whole retained values and watermarks', 'source immutability', 'unload restoration'],
  }))
} finally {
  await ctx.fiber.dispose()
}
