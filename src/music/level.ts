// Music level (wizard-music#35): a Music-only ceiling on the player's loudness, kept on this device.
//
// At the bottom of the phone's media volume each tick is a big jump. With the level at, say, 30%, the same
// loudness sits several ticks higher on the phone's slider, so the volume buttons give finer steps. The level
// multiplies the player gain (voice "louder", "quieter", "volume 40" still work, inside this ceiling).
// Behind the box switch `music-level` (off by default); with the switch off the level is 100%.
import type { SessionStore } from './engine'

export const LEVEL_SWITCH = 'music-level'
export const LEVEL_KEY = 'wizard-music.level.v1'
/** Last switch state this device saw, so the ceiling is right from the first note, before the box answers. */
export const SWITCHES_KEY = 'wizard-music.switches.v1'
export const LEVEL_MIN = 0.05

export function clampLevel(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 1
  return Math.round(Math.min(1, Math.max(LEVEL_MIN, n)) * 100) / 100
}

export function readLevel(store: SessionStore | null): number {
  try { const raw = store?.getItem(LEVEL_KEY); return raw == null ? 1 : clampLevel(raw) } catch { return 1 }
}
export function writeLevel(store: SessionStore | null, value: number): number {
  const level = clampLevel(value)
  try { store?.setItem(LEVEL_KEY, String(level)) } catch { /* storage blocked */ }
  return level
}

export type SwitchStates = Record<string, boolean>
export function cachedSwitches(store: SessionStore | null): SwitchStates {
  try {
    const value = JSON.parse(store?.getItem(SWITCHES_KEY) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, on]) => typeof on === 'boolean')) as SwitchStates : {}
  } catch { return {} }
}
export function cacheSwitches(store: SessionStore | null, states: SwitchStates) {
  try { store?.setItem(SWITCHES_KEY, JSON.stringify(states)) } catch { /* storage blocked */ }
}

/** The ceiling the player should use now: the stored level with the switch on, else 100%. */
export function activeLevel(store: SessionStore | null, states: SwitchStates = cachedSwitches(store)): number {
  return states[LEVEL_SWITCH] === true ? readLevel(store) : 1
}

/** The box's switch states for this app's own page (read only). Null when the box did not answer. */
export async function fetchSwitches(base: string, fetchImpl: typeof fetch = fetch): Promise<SwitchStates | null> {
  try {
    const response = await fetchImpl(base + 'api/view/switches', { credentials: 'include', headers: { Accept: 'application/json' } })
    if (!response.ok) return null
    const body = await response.json() as { switches?: { id?: unknown; on?: unknown }[] }
    if (!Array.isArray(body.switches)) return null
    return Object.fromEntries(body.switches.filter((s) => typeof s.id === 'string' && typeof s.on === 'boolean').map((s) => [s.id as string, s.on as boolean]))
  } catch { return null }
}
