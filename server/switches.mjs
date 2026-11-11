// ---- wizard.app-switches/1 ---------------------------------------------------------------------------------------
// Owner feature switches for the Tracker's Try it (wizard-os docs/APP_SWITCHES.md). Shared module: the same text ships
// in every Node Wizard app (Python twin: wizard-app-manager templates/hello-wizard). Every new feature ships behind a
// switch, off by default: append it to SWITCHES with the issue it delivers, e.g.
//   { id: 'compact-header', name: 'Compact top bar', description: '...', default: false, issues: ['humanitylabs-org/<repo>#20'] }
// and gate the feature on switchOn('compact-header'). State lives on the box (<data dir>/switches.json), so the page,
// the Tracker (through the App Manager) and the agent see one state. GET/POST /api/switches, owner only: the box's
// Tailscale Serve owner login with X-Wizard-Switch: 1; never a bearer, agent grant or box-local host.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SWITCHES = []
const CONTRACT = 'wizard.app-switches/1'
const ROUTE = /^(?:\/[a-z0-9][a-z0-9-]{0,62})?\/api\/switches\/?$/
const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

const file = () => join(process.env.WIZARD_SWITCHES_DIR || process.env.DATA_DIR || '/data', 'switches.json')
function saved() {
  try { const v = JSON.parse(readFileSync(file(), 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {} } catch { return {} }
}
export function switchesDoc() {
  const s = saved()
  return { contract: CONTRACT, switches: SWITCHES.map(x => ({ ...x, on: typeof s[x.id] === 'boolean' ? s[x.id] : !!x.default })) }
}
export const switchOn = id => (switchesDoc().switches.find(x => x.id === id) || {}).on === true
function setSwitch(id, on) {
  const ids = new Set(SWITCHES.map(x => x.id))
  const next = Object.fromEntries(Object.entries(saved()).filter(([k, v]) => ids.has(k) && typeof v === 'boolean'))
  next[id] = on
  const f = file()
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f + '.tmp', JSON.stringify(next)); renameSync(f + '.tmp', f)
  return switchesDoc()
}
function owner(req, write) {
  const h = req.headers
  if (h.authorization || h['x-wizard-switch'] !== '1') return false
  if (!['same-origin', 'none', undefined].includes(h['sec-fetch-site'])) return false
  const host = String(h.host || '').trim().toLowerCase()
  const name = host.startsWith('[') ? host.split(']')[0] + ']' : host.replace(/:\d+$/, '')
  if (!name || LOCAL.has(name) || !name.includes('.')) return false
  const origin = h.origin
  const trusted = new Set((process.env.WIZARD_TRUSTED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean))
  if (origin) { let ok = trusted.has(origin); try { ok = ok || new URL(origin).host.toLowerCase() === host } catch {} if (!ok) return false }
  if (write && !origin) return false
  const login = h['tailscale-user-login']
  if (typeof login !== 'string' || !login.includes('@') || login.includes(',')) return false
  const owners = new Set((process.env.WIZARD_OWNER_LOGINS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean))
  return !owners.size || owners.has(login.trim().toLowerCase())
}
function send(res, code, doc, head) {
  const raw = Buffer.from(JSON.stringify(doc))
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': raw.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(head ? undefined : raw)
}
// Serve /api/switches (or /<app>/api/switches) and resolve true; false for every other request.
export async function handleSwitches(req, res) {
  const path = new URL(req.url || '/', 'http://local').pathname
  if (!ROUTE.test(path)) return false
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (!owner(req, false)) send(res, 403, { error: "Only this Wizard's owner can see these switches.", code: 'owner_only' }, req.method === 'HEAD')
    else send(res, 200, switchesDoc(), req.method === 'HEAD')
    return true
  }
  if (req.method !== 'POST') { send(res, 405, { error: 'method' }); return true }
  if (!owner(req, true)) { send(res, 403, { error: "Only this Wizard's owner can change these switches.", code: 'owner_only' }); return true }
  let body
  try {
    if (String(req.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') throw new Error()
    const chunks = []; let n = 0
    for await (const c of req) { n += c.length; if (n > 4096) throw new Error(); chunks.push(c) }
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || typeof body.id !== 'string' || typeof body.on !== 'boolean' || Object.keys(body).some(k => k !== 'id' && k !== 'on')) throw new Error()
  } catch { send(res, 400, { error: 'Send JSON {"id": "...", "on": true|false}', code: 'invalid_input' }); return true }
  if (!SWITCHES.some(x => x.id === body.id)) { send(res, 404, { error: 'No such switch', code: 'unknown_switch' }); return true }
  try { send(res, 200, setSwitch(body.id, body.on)) } catch { send(res, 500, { error: 'storage_failure' }) }
  return true
}
// ---- end wizard.app-switches/1 -----------------------------------------------------------------------------------
