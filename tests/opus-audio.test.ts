// wizard-os#820 (switch opus-audio, off by default): YouTube's Opus stream instead of AAC 128k, only for a player that
// can decode it. The app server tells the hub with X-Wizard-Music-Codec: opus; off, the hub is asked as before.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createMusicProxy, opusPlayer } from '../server/music.mjs'
import { SWITCHES } from '../server/switches.mjs'

const UA = {
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  webviewAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 WizardOS-DocScroll',
  androidPlayer: 'WizardBackgroundAudio/1',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  macApp: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
  iphoneFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/133.0 Mobile/15E148 Safari/605.1.15',
  iosPlayer: 'AppleCoreMedia/1.0.0.22B83 (iPhone; U; CPU OS 18_1 like Mac OS X; en_us)',
  ipadDesktop: 'Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
}

async function hubSaw(path: string, ua: string, on: boolean) {
  const seen: (string | undefined)[] = []
  const hub = createServer((req, res) => { seen.push(req.headers['x-wizard-music-codec'] as string | undefined); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
  await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve))
  const handle = createMusicProxy({ origin: `http://127.0.0.1:${(hub.address() as AddressInfo).port}`, token: 't', opus: () => on })
  const front = createServer((req, res) => { void handle(req, res, new URL(req.url ?? '/', 'http://x'), (r: import('node:http').ServerResponse, s: number, v: unknown) => { r.writeHead(s); r.end(JSON.stringify(v)) }) })
  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve))
  try {
    await (await fetch(`http://127.0.0.1:${(front.address() as AddressInfo).port}/wizard-music${path}`, { headers: { 'User-Agent': ua, 'X-Wizard-Music-Codec': 'opus' } })).text()
  } finally { hub.close(); front.close() }
  return seen[0]
}

describe('Opus audio (wizard-os#820)', () => {
  it('is a switch, off by default, linked to its issue', () => {
    const s = SWITCHES.find(x => x.id === 'opus-audio')
    expect(s?.default).toBe(false)
    expect(s?.issues).toEqual(['humanitylabs-org/wizard-os#820'])
  })

  it('knows which players can decode Opus', () => {
    for (const ua of [UA.chromeMac, UA.chromeAndroid, UA.webviewAndroid, UA.androidPlayer, UA.firefox, UA.edge]) expect(opusPlayer(ua)).toBe(true)
    for (const ua of [UA.safariMac, UA.macApp, UA.iphoneSafari, UA.iphoneChrome, UA.iphoneFirefox, UA.iosPlayer, UA.ipadDesktop, '', 'curl/8.5.0']) expect(opusPlayer(ua)).toBe(false)
  })

  it('switch off: the hub is never asked for Opus, whatever the player (a page cannot ask for it itself)', async () => {
    expect(await hubSaw('/stream/yt:zKmWd8DPrEc', UA.chromeMac, false)).toBe(undefined)
    expect(await hubSaw('/stream/yt:zKmWd8DPrEc', UA.androidPlayer, false)).toBe(undefined)
  })

  it('switch on: Opus only for songs played by a player that can decode it', async () => {
    expect(await hubSaw('/stream/yt:zKmWd8DPrEc', UA.chromeMac, true)).toBe('opus')
    expect(await hubSaw('/stream/yt:zKmWd8DPrEc', UA.androidPlayer, true)).toBe('opus')
    expect(await hubSaw('/stream/yt:zKmWd8DPrEc', UA.safariMac, true)).toBe(undefined)
    expect(await hubSaw('/stream/yt:zKmWd8DPrEc', UA.iosPlayer, true)).toBe(undefined)
    expect(await hubSaw('/art/yt:zKmWd8DPrEc', UA.chromeMac, true)).toBe(undefined)
    expect(await hubSaw('/api/home', UA.chromeMac, true)).toBe(undefined)
  })
})
