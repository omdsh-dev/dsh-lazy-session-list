import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const smokeScript = fileURLToPath(new URL('../scripts/live-smoke.mjs', import.meta.url))

test('live smoke makes only one list request and prints aggregate policy/size data', async t => {
  const secret = 'private-synthetic-fixture-' + crypto.randomUUID()
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const envelope = JSON.parse(Buffer.concat(chunks).toString())
    requests.push({ method: request.method, url: request.url, rpcMethod: envelope.method })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ result: { ok: true, value: { items: [{
      sessionId: secret, updatedAt: 1, blank: false,
      projections: { kind: 'cached', asOfSeq: 7, values: {
        title: secret, sessionListMetadata: { blank: false, lastPromptAt: 1 },
        subagentCatalog: [], agentPreset: 'fixture',
        [secret]: { text: secret.repeat(100) },
      } },
    }] } } }))
  })
  t.after(() => new Promise(resolve => server.close(resolve)))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { stdout, stderr } = await execute(process.execPath, [smokeScript, `http://127.0.0.1:${server.address().port}`])
  assert.deepEqual(requests, [{ method: 'POST', url: '/api/session/list', rpcMethod: 'session/list' }])
  assert.equal(stderr, '')
  assert.equal(stdout.includes(secret), false, 'session IDs, titles, arbitrary keys and values must stay private')
  const report = JSON.parse(stdout)
  assert.equal(report.rows, 1)
  assert.equal(report.listRequests, 1)
  assert.equal(report.detailRequests, 0)
  assert.equal(report.rowsWithOmissions, 1)
  assert.equal(report.omittedKeyOccurrences, 1)
  assert.ok(report.decodedBytesAfter < report.decodedBytesBefore)
  assert.deepEqual(report.listProjectionKeys, ['title', 'sessionListMetadata', 'subagentCatalog', 'agentPreset'])
})

test('live smoke does not echo a private RPC error response', async t => {
  const secret = 'private-error-fixture-' + crypto.randomUUID()
  let requests = 0
  const server = createServer((_request, response) => {
    requests++
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ result: { ok: false, error: { message: secret } } }))
  })
  t.after(() => new Promise(resolve => server.close(resolve)))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await assert.rejects(execute(process.execPath, [smokeScript, `http://127.0.0.1:${server.address().port}`]), error => {
    assert.equal(error.code, 1)
    assert.equal(error.stdout, '')
    assert.equal(error.stderr.includes(secret), false)
    assert.match(error.stderr, /session.list RPC failed/)
    return true
  })
  assert.equal(requests, 1)
})
