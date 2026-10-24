import { useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react'

/** Horizontal swipe for track changes: left = next, right = previous. Vertical drags stay scrolls. */
export const SWIPE_DISTANCE = 56
const LOCK_DISTANCE = 10
const FLICK_SPEED = 0.45 // px per ms
const FLICK_DISTANCE = 28
const SETTLE_MS = 260

export type SwipeDirection = 'next' | 'previous'

/** Decide what a finished drag means. Pure so it can be unit-tested. */
export function swipeOutcome(dx: number, dy: number, ms: number): SwipeDirection | null {
  if (Math.abs(dx) < Math.abs(dy) * 1.2) return null
  const speed = Math.abs(dx) / Math.max(1, ms)
  if (Math.abs(dx) >= SWIPE_DISTANCE || (Math.abs(dx) >= FLICK_DISTANCE && speed >= FLICK_SPEED)) return dx < 0 ? 'next' : 'previous'
  return null
}

type Drag = { id: number; x: number; y: number; t: number; mode: 'pending' | 'horizontal' }
type Slide<T> = { track: T; at: number }

/**
 * YouTube Music style carousel: the current song follows your finger with the
 * previous / next song beside it; let go past the threshold and it slides the
 * whole way, then the player moves to that song. No neighbour = rubber band.
 */
export function SwipeDeck<T extends { id: string }>({ prev, current, next, render, onCommit, className = '', gap = 48, label }: {
  prev?: Slide<T>; current: Slide<T>; next?: Slide<T>
  render: (track: T) => ReactNode
  onCommit: (direction: SwipeDirection, to: number) => void
  className?: string; gap?: number; label?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const swallowClick = useRef(false)
  const committing = useRef<{ from: string; timer: number } | null>(null)
  const [dx, setDx] = useState(0)
  const [animate, setAnimate] = useState(false)
  const key = `${current.at}:${current.track.id}`

  // The player moved to the song we slid in: recentre before paint (same picture, now in the middle).
  useLayoutEffect(() => {
    const c = committing.current
    if (!c || c.from === key) return
    window.clearTimeout(c.timer)
    committing.current = null
    setAnimate(false)
    setDx(0)
  }, [key])

  const settle = (to: number) => { setAnimate(true); setDx(to) }

  const finish = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = drag.current
    if (!d || d.id !== event.pointerId) return
    drag.current = null
    if (d.mode !== 'horizontal') return
    swallowClick.current = true
    window.setTimeout(() => { swallowClick.current = false }, 350)
    const outcome = cancelled ? null : swipeOutcome(event.clientX - d.x, event.clientY - d.y, event.timeStamp - d.t)
    const target = outcome === 'next' ? next : outcome === 'previous' ? prev : undefined
    if (!outcome || !target) { settle(0); return }
    navigator.vibrate?.(8)
    const width = (box.current?.clientWidth ?? 320) + gap
    settle(outcome === 'next' ? -width : width)
    const from = key
    committing.current = { from, timer: 0 }
    window.setTimeout(() => {
      if (committing.current?.from !== from) return
      // If the player never moves (error, native lag), slide back instead of sticking off-screen.
      committing.current.timer = window.setTimeout(() => { if (committing.current?.from === from) { committing.current = null; settle(0) } }, 1500)
      onCommit(outcome, target.at)
    }, SETTLE_MS)
  }

  const handlers = {
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      if (committing.current || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return
      if ((event.target as HTMLElement).closest('input,textarea,[data-no-swipe]')) return
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp, mode: 'pending' }
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      const d = drag.current
      if (!d || d.id !== event.pointerId) return
      const x = event.clientX - d.x, y = event.clientY - d.y
      if (d.mode === 'pending') {
        if (Math.abs(x) < LOCK_DISTANCE && Math.abs(y) < LOCK_DISTANCE) return
        if (Math.abs(x) <= Math.abs(y) * 1.2) { drag.current = null; return }
        d.mode = 'horizontal'
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* pointer already gone */ }
      }
      setAnimate(false)
      setDx((x < 0 && !next) || (x > 0 && !prev) ? x * 0.3 : x)
    },
    onPointerUp(event: PointerEvent<HTMLDivElement>) { finish(event, false) },
    onPointerCancel(event: PointerEvent<HTMLDivElement>) { finish(event, true) },
    // A swipe that ends over a button must not also tap it.
    onClickCapture(event: MouseEvent<HTMLDivElement>) {
      if (!swallowClick.current) return
      swallowClick.current = false
      event.preventDefault()
      event.stopPropagation()
    },
  }

  return <div ref={box} className={`music-deck ${className}`} aria-label={label} {...handlers}>
    <div className="music-deck-rail" style={{ transform: `translate3d(${Math.round(dx)}px,0,0)`, transition: animate ? `transform ${SETTLE_MS}ms cubic-bezier(.2,.7,.3,1)` : 'none' }}>
      {prev && <div key={prev.at} className="music-deck-slide side" aria-hidden="true" style={{ left: `calc(-100% - ${gap}px)` }}>{render(prev.track)}</div>}
      <div key={current.at} className="music-deck-slide">{render(current.track)}</div>
      {next && <div key={next.at} className="music-deck-slide side" aria-hidden="true" style={{ left: `calc(100% + ${gap}px)` }}>{render(next.track)}</div>}
    </div>
  </div>
}
