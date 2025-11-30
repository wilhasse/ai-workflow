import { useRef, useEffect, useCallback, useState } from 'react'

const DISMISS_THRESHOLD = 100
const VELOCITY_THRESHOLD = 0.5

function BottomSheet({
  isOpen,
  onClose,
  title,
  children,
  height = 'half', // 'peek' (30vh), 'half' (50vh), 'full' (90vh)
}) {
  const sheetRef = useRef(null)
  const [translateY, setTranslateY] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const touchState = useRef({
    startY: 0,
    startTime: 0,
    currentY: 0,
  })

  const heightMap = {
    peek: '30vh',
    half: '50vh',
    full: '90vh',
  }

  const handleTouchStart = useCallback((e) => {
    const touch = e.touches[0]
    touchState.current = {
      startY: touch.clientY,
      startTime: Date.now(),
      currentY: touch.clientY,
    }
    setIsDragging(true)
  }, [])

  const handleTouchMove = useCallback((e) => {
    if (!isDragging) return

    const touch = e.touches[0]
    touchState.current.currentY = touch.clientY

    const deltaY = touch.clientY - touchState.current.startY

    // Only allow dragging down (positive deltaY)
    if (deltaY > 0) {
      // Apply resistance (0.6 factor)
      setTranslateY(deltaY * 0.6)
    }
  }, [isDragging])

  const handleTouchEnd = useCallback(() => {
    if (!isDragging) return
    setIsDragging(false)

    const deltaY = touchState.current.currentY - touchState.current.startY
    const deltaTime = Date.now() - touchState.current.startTime
    const velocity = deltaY / deltaTime

    // Dismiss if dragged past threshold or with high velocity
    if (deltaY > DISMISS_THRESHOLD || velocity > VELOCITY_THRESHOLD) {
      onClose()
    }

    // Reset translate
    setTranslateY(0)
  }, [isDragging, onClose])

  // Reset translateY when sheet opens/closes
  useEffect(() => {
    setTranslateY(0)
  }, [isOpen])

  // Handle backdrop click
  const handleBackdropClick = useCallback((e) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }, [onClose])

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  // Prevent body scroll when sheet is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [isOpen])

  if (!isOpen) return null

  return (
    <>
      <div
        className={`bottom-sheet-backdrop ${isOpen ? 'open' : ''}`}
        onClick={handleBackdropClick}
      />
      <div
        ref={sheetRef}
        className={`bottom-sheet ${isOpen ? 'open' : ''}`}
        style={{
          maxHeight: heightMap[height] || heightMap.half,
          transform: `translateY(${translateY}px)`,
          transition: isDragging ? 'none' : 'transform 0.3s ease-out',
        }}
      >
        <div
          className="sheet-handle-area"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          <div className="sheet-handle" />
        </div>
        {title && (
          <div className="sheet-header">
            <h2 className="sheet-title">{title}</h2>
            <button
              type="button"
              className="sheet-close"
              onClick={onClose}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        )}
        <div className="sheet-content">
          {children}
        </div>
      </div>
    </>
  )
}

export default BottomSheet
