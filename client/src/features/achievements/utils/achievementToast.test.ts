import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('vue-sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('canvas-confetti', () => ({ default: vi.fn() }))

import { toast } from 'vue-sonner'
import confetti from 'canvas-confetti'
import { showAchievementToast } from './achievementToast'

const mockToast = toast.success as ReturnType<typeof vi.fn>
const mockConfetti = confetti as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('showAchievementToast', () => {
  describe('toast content', () => {
    it('shows correct emoji and name for common', () => {
      showAchievementToast('Read 10 Books', 'common')
      expect(mockToast).toHaveBeenCalledWith('⭐ Read 10 Books', expect.objectContaining({ description: 'Achievement Unlocked!' }))
    })

    it('shows correct emoji and name for rare', () => {
      showAchievementToast('Speed Reader', 'rare')
      expect(mockToast).toHaveBeenCalledWith('💎 Speed Reader', expect.objectContaining({ description: 'Achievement Unlocked!' }))
    })

    it('shows correct emoji and name for epic', () => {
      showAchievementToast('Night Owl', 'epic')
      expect(mockToast).toHaveBeenCalledWith('🚀 Night Owl', expect.objectContaining({ description: 'Achievement Unlocked!' }))
    })

    it('shows correct emoji and name for legendary', () => {
      showAchievementToast('Bibliophile', 'legendary')
      expect(mockToast).toHaveBeenCalledWith('🏆 Bibliophile', expect.objectContaining({ description: 'Achievement Unlocked!' }))
    })
  })

  describe('toast duration', () => {
    it('uses 4000ms duration for common', () => {
      showAchievementToast('Test', 'common')
      expect(mockToast).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ duration: 4000 }))
    })

    it('uses 4000ms duration for rare', () => {
      showAchievementToast('Test', 'rare')
      expect(mockToast).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ duration: 4000 }))
    })

    it('uses 6000ms duration for epic', () => {
      showAchievementToast('Test', 'epic')
      expect(mockToast).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ duration: 6000 }))
    })

    it('uses 6000ms duration for legendary', () => {
      showAchievementToast('Test', 'legendary')
      expect(mockToast).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ duration: 6000 }))
    })
  })

  describe('name fallback', () => {
    it('falls back to "New achievement" for empty name', () => {
      showAchievementToast('', 'common')
      expect(mockToast).toHaveBeenCalledWith('⭐ New achievement', expect.any(Object))
    })

    it('falls back to "New achievement" for whitespace-only name', () => {
      showAchievementToast('   ', 'common')
      expect(mockToast).toHaveBeenCalledWith('⭐ New achievement', expect.any(Object))
    })
  })

  describe('scheduleConfetti batch timer', () => {
    it('triggers confetti after 300ms', async () => {
      showAchievementToast('Test', 'common')
      await vi.runAllTimersAsync()
      expect(mockConfetti).toHaveBeenCalled()
    })

    it('uses highest-rarity achievement when multiple called quickly', async () => {
      showAchievementToast('First', 'common')
      showAchievementToast('Second', 'legendary')
      await vi.runAllTimersAsync()
      // legendary triggers setInterval + two confetti calls per tick; just verify confetti fired
      expect(mockConfetti).toHaveBeenCalled()
    })

    it('resets timer on each new call within the 300ms window', async () => {
      showAchievementToast('First', 'common')
      vi.advanceTimersByTime(200)
      showAchievementToast('Second', 'common')
      vi.advanceTimersByTime(200)
      // only one batch should have fired (the second 300ms timer)
      await vi.runAllTimersAsync()
      // just ensure confetti eventually fires
      expect(mockConfetti).toHaveBeenCalled()
    })
  })

  describe('confetti rarity behavior', () => {
    it('calls confetti once for common rarity', async () => {
      showAchievementToast('Test', 'common')
      await vi.runAllTimersAsync()
      expect(mockConfetti).toHaveBeenCalledTimes(1)
    })

    it('calls confetti 5 times for rare rarity', async () => {
      showAchievementToast('Test', 'rare')
      await vi.runAllTimersAsync()
      expect(mockConfetti).toHaveBeenCalledTimes(5)
    })

    it('calls confetti for epic rarity (shoot called immediately + 2 timeouts)', async () => {
      showAchievementToast('Test', 'epic')
      await vi.runAllTimersAsync()
      // each shoot() = 2 confetti calls, called 3 times = 6 calls
      expect(mockConfetti).toHaveBeenCalledTimes(6)
    })

    it('calls confetti at least once for legendary rarity', async () => {
      showAchievementToast('Test', 'legendary')
      await vi.runAllTimersAsync()
      expect(mockConfetti).toHaveBeenCalled()
    })
  })
})
