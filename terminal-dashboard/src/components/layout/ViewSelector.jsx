import { useEffect, useRef, useState } from 'react'

// Controlled dropdown selector. `options` is [{ value, label }]; `value` is the
// active option's value; `onChange(value)` fires on selection. `prefix` labels
// the trigger ("View: …", "Workspace: …"); `placeholder` shows when nothing matches.
export default function ViewSelector({ value, onChange, options, prefix = 'View', placeholder = '' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onDocClick = (event) => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const activeLabel = options.find((o) => o.value === value)?.label ?? placeholder

  return (
    <div className="view-selector" ref={ref}>
      <button
        type="button"
        className="view-selector-trigger secondary"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch view"
      >
        {prefix}: {activeLabel} ▾
      </button>
      {open && (
        <ul className="view-selector-menu" role="listbox">
          {options.map((option) => (
            <li key={option.value}>
              <button
                type="button"
                className={`view-selector-option ${option.value === value ? 'active' : ''}`}
                role="option"
                aria-selected={option.value === value}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                <span className="check">{option.value === value ? '✓' : ''}</span>
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
