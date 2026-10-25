import { Readable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { handleMcp } from '../server/mcp.mjs'
afterEach(() => vi.unstubAllGlobals())
async function call(args: object) {
  const req = Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'music_account_library', arguments: args } }))]) as Readable & { method: string; headers: object }
  req.method = 'POST'; req.headers = { 'content-type': 'application/json' }
  let result: any
  await handleMcp(req, {}, (_res: unknown, _status: number, body: unknown) => { result = body }, 9205)
  return result
}
it('MCP exposes the bounded read-only library path and propagates errors', async () => {
  const fetcher = vi.fn(async () => ({ ok: false, text: async () => '{"error":"Connect and verify"}' }))
  vi.stubGlobal('fetch', fetcher)
  expect((await call({ kind: 'playlist', id: 'PL_one' })).result.isError).toBe(true)
  expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:9205/wizard-music/api/account-library/playlist?id=PL_one&limit=100')
  for (const args of [{ kind: 'playlist', id: '../bad' }, { kind: 'playlist' }, { kind: 'disconnect' }, { kind: 'likes', url: 'http://bad' }]) expect((await call(args)).error.code).toBe(-32602)
  expect(fetcher).toHaveBeenCalledOnce()
})
