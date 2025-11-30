import { useState, useRef, useCallback } from 'react'
import BottomSheet from './BottomSheet'

function SwipeableItem({ children, onDelete }) {
  const [translateX, setTranslateX] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const touchState = useRef({ startX: 0, startTime: 0 })

  const handleTouchStart = useCallback((e) => {
    e.stopPropagation()
    touchState.current = {
      startX: e.touches[0].clientX,
      startTime: Date.now(),
    }
    setIsDragging(true)
  }, [])

  const handleTouchMove = useCallback((e) => {
    if (!isDragging) return
    const deltaX = e.touches[0].clientX - touchState.current.startX
    // Only allow left swipe
    if (deltaX < 0) {
      setTranslateX(Math.max(deltaX, -100))
    }
  }, [isDragging])

  const handleTouchEnd = useCallback(() => {
    setIsDragging(false)
    const shouldShowDelete = translateX < -50
    setTranslateX(shouldShowDelete ? -80 : 0)
  }, [translateX])

  const handleDelete = useCallback(() => {
    setTranslateX(0)
    onDelete()
  }, [onDelete])

  return (
    <div className="swipeable-item-wrapper">
      <div
        className="swipeable-item"
        style={{
          transform: `translateX(${translateX}px)`,
          transition: isDragging ? 'none' : 'transform 0.2s ease',
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {children}
      </div>
      <button
        type="button"
        className="swipe-delete-action"
        onClick={handleDelete}
        style={{
          opacity: translateX < 0 ? 1 : 0,
        }}
      >
        Delete
      </button>
    </div>
  )
}

function ProjectSheet({
  isOpen,
  onClose,
  projects,
  activeProjectId,
  onSelectProject,
  onDeleteProject,
  onAddProject,
}) {
  const [formName, setFormName] = useState('')
  const [formDescription, setFormDescription] = useState('')

  const handleSubmit = (e) => {
    e.preventDefault()
    const name = formName.trim()
    if (!name) return
    onAddProject({ name, description: formDescription.trim() })
    setFormName('')
    setFormDescription('')
  }

  const handleSelect = (projectId) => {
    onSelectProject(projectId)
    onClose()
  }

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="Projects" height="half">
      <div className="sheet-list">
        {projects.map((project) => {
          const isActive = project.id === activeProjectId
          const canDelete = projects.length > 1

          const content = (
            <div
              className={`sheet-list-item ${isActive ? 'active' : ''}`}
              onClick={() => handleSelect(project.id)}
            >
              <div className="sheet-list-item-content">
                <strong>{project.name}</strong>
                <span className="sheet-list-item-meta">
                  {project.terminals.length} terminal{project.terminals.length !== 1 ? 's' : ''}
                </span>
              </div>
              {isActive && <span className="active-indicator">✓</span>}
            </div>
          )

          if (canDelete) {
            return (
              <SwipeableItem
                key={project.id}
                onDelete={() => onDeleteProject(project.id)}
              >
                {content}
              </SwipeableItem>
            )
          }

          return <div key={project.id}>{content}</div>
        })}
      </div>

      <form className="sheet-form" onSubmit={handleSubmit}>
        <h3>Add Project</h3>
        <input
          type="text"
          placeholder="Project name"
          value={formName}
          onChange={(e) => setFormName(e.target.value)}
          required
        />
        <input
          type="text"
          placeholder="Description (optional)"
          value={formDescription}
          onChange={(e) => setFormDescription(e.target.value)}
        />
        <button type="submit" className="primary">
          Create Project
        </button>
      </form>
    </BottomSheet>
  )
}

export default ProjectSheet
