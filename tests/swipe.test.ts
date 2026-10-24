import { describe, expect, it } from 'vitest'
import { swipeOutcome } from '../src/music/swipe'

describe('track swipe', () => {
  it('left is next, right is previous', () => {
    expect(swipeOutcome(-80, 5, 300)).toBe('next')
    expect(swipeOutcome(80, -5, 300)).toBe('previous')
  })
  it('a quick flick counts even when short', () => {
    expect(swipeOutcome(-34, 0, 50)).toBe('next')
    expect(swipeOutcome(-34, 0, 400)).toBeNull()
  })
  it('vertical or tiny drags do nothing', () => {
    expect(swipeOutcome(-70, 90, 200)).toBeNull()
    expect(swipeOutcome(-12, 0, 100)).toBeNull()
  })
})
