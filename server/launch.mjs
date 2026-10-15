import { spawn } from 'node:child_process'
const children = []
let stopping = false
function stop(code = 0) { if (stopping) return; stopping = true; for (const p of children) p.kill('SIGTERM'); setTimeout(() => process.exit(code), 1000).unref() }
function launch(cmd, args) { const p = spawn(cmd, args, {stdio: 'inherit', env: process.env}); children.push(p); p.on('error', () => stop(1)); p.on('exit', code => { if (!stopping) stop(code || 1) }); }
if (process.env.WIZARD_MUSIC_HUB_TOKEN && process.env.WIZARD_MUSIC_EXTERNAL_HUB !== '1') launch(process.env.WIZARD_MUSIC_PYTHON || 'python3', ['hub/hub.py'])
launch(process.execPath, ['server/index.mjs'])
process.on('SIGTERM', () => stop()); process.on('SIGINT', () => stop())
