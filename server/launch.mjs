import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
const home = process.env.WIZARD_MUSIC_HUB_HOME || '/data'
mkdirSync(home, { recursive: true, mode: 0o700 })
if (!process.env.WIZARD_MUSIC_HUB_TOKEN) {
  const file = join(home, 'hub-token')
  try { writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  chmodSync(file, 0o600)
  process.env.WIZARD_MUSIC_HUB_TOKEN = readFileSync(file, 'utf8').trim()
  if (!/^[a-f0-9]{64}$/.test(process.env.WIZARD_MUSIC_HUB_TOKEN)) throw new Error('Invalid persisted hub token')
}
process.env.WIZARD_MUSIC_HUB_ORIGIN ||= 'http://127.0.0.1:8793'
const children = []
let stopping = false
function stop(code = 0) { if (stopping) return; stopping = true; for (const p of children) p.kill('SIGTERM'); setTimeout(() => process.exit(code), 1000).unref() }
function launch(cmd, args) { const p = spawn(cmd, args, {stdio: 'inherit', env: process.env}); children.push(p); p.on('error', () => stop(1)); p.on('exit', code => { if (!stopping) stop(code || 1) }); }
if (process.env.WIZARD_MUSIC_EXTERNAL_HUB !== '1') launch(process.env.WIZARD_MUSIC_PYTHON || 'python3', ['hub/hub.py'])
launch(process.execPath, ['server/index.mjs'])
process.on('SIGTERM', () => stop()); process.on('SIGINT', () => stop())
