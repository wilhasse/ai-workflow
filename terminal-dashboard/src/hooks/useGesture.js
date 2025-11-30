import { useRef, useCallback } from 'react'

const SWIPE_THRESHOLD = 50 // minimum distance for swipe
const VELOCITY_THRESHOLD = 0.3 // minimum velocity for swipe

export function useGesture({
  onSwipeLeft,
  onSwipeRight,
  onSwipeUp,
  onSwipeDown,
  onDrag,
  onDragEnd,
  enabled = true,
} = {}) {
  const touchState = useRef({
    startX: 0,
    startY: 0,
    startTime: 0,
    currentX: 0,
    currentY: 0,
    isDragging: false,
  })

  const handleTouchStart = useCallback(
    (e) => {
      if (!enabled) return
      const touch = e.touches[0]
      touchState.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        startTime: Date.now(),
        currentX: touch.clientX,
        currentY: touch.clientY,
        isDragging: true,
      }
    },
    [enabled]
  )

  const handleTouchMove = useCallback(
    (e) => {
      if (!enabled || !touchState.current.isDragging) return

      const touch = e.touches[0]
      const state = touchState.current
      state.currentX = touch.clientX
      state.currentY = touch.clientY

      const deltaX = state.currentX - state.startX
      const deltaY = state.currentY - state.startY

      if (onDrag) {
        onDrag({ deltaX, deltaY, event: e })
      }
    },
    [enabled, onDrag]
  )

  const handleTouchEnd = useCallback(
    (e) => {
      if (!enabled || !touchState.current.isDragging) return

      const state = touchState.current
      state.isDragging = false

      const deltaX = state.currentX - state.startX
      const deltaY = state.currentY - state.startY
      const deltaTime = Date.now() - state.startTime
      const velocityX = Math.abs(deltaX) / deltaTime
      const velocityY = Math.abs(deltaY) / deltaTime

      const isHorizontalSwipe = Math.abs(deltaX) > Math.abs(deltaY)

      if (onDragEnd) {
        onDragEnd({
          deltaX,
          deltaY,
          velocityX,
          velocityY,
          event: e,
        })
      }

      // Determine swipe direction
      if (isHorizontalSwipe) {
        if (
          Math.abs(deltaX) > SWIPE_THRESHOLD ||
          velocityX > VELOCITY_THRESHOLD
        ) {
          if (deltaX < 0 && onSwipeLeft) {
            onSwipeLeft({ deltaX, velocityX })
          } else if (deltaX > 0 && onSwipeRight) {
            onSwipeRight({ deltaX, velocityX })
          }
        }
      } else {
        if (
          Math.abs(deltaY) > SWIPE_THRESHOLD ||
          velocityY > VELOCITY_THRESHOLD
        ) {
          if (deltaY < 0 && onSwipeUp) {
            onSwipeUp({ deltaY, velocityY })
          } else if (deltaY > 0 && onSwipeDown) {
            onSwipeDown({ deltaY, velocityY })
          }
        }
      }
    },
    [enabled, onSwipeLeft, onSwipeRight, onSwipeUp, onSwipeDown, onDragEnd]
  )

  const handlers = {
    onTouchStart: handleTouchStart,
    onTouchMove: handleTouchMove,
    onTouchEnd: handleTouchEnd,
  }

  return handlers
}

export function useSwipeToDelete({ onDelete, threshold = 80 } = {}) {
  const stateRef = useRef({ translateX: 0 })

  const onDrag = useCallback(({ deltaX }) => {
    // Only allow left swipe (negative deltaX)
    if (deltaX < 0) {
      stateRef.current.translateX = Math.max(deltaX, -threshold * 1.5)
    }
    return stateRef.current.translateX
  }, [threshold])

  const onDragEnd = useCallback(
    ({ deltaX, velocityX }) => {
      const shouldDelete =
        Math.abs(deltaX) > threshold || velocityX > VELOCITY_THRESHOLD

      if (shouldDelete && deltaX < 0 && onDelete) {
        onDelete()
      }

      stateRef.current.translateX = 0
      return { shouldDelete: shouldDelete && deltaX < 0, translateX: 0 }
    },
    [threshold, onDelete]
  )

  return { onDrag, onDragEnd, stateRef }
}
