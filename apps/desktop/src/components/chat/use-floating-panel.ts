import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'

export interface FloatingPanelRect {
  x: number
  y: number
  w: number
  h: number
}

export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

interface DragState {
  pointerId: number
  startX: number
  startY: number
  rect: FloatingPanelRect
}

interface ResizeState extends DragState {
  dir: ResizeDirection
}

const MIN_W = 220
const MIN_H = 100

/**
 * Read persisted rect from localStorage, falling back to the provided initial
 * value. Silently ignores corrupted entries.
 */
function readPersisted(key: string | undefined, fallback: FloatingPanelRect): FloatingPanelRect {
  if (!key || typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.x === 'number' &&
      typeof parsed.y === 'number' &&
      typeof parsed.w === 'number' &&
      typeof parsed.h === 'number'
    ) {
      return parsed
    }
  } catch {
    // corrupted entry — ignore
  }
  return fallback
}

function writePersisted(key: string | undefined, rect: FloatingPanelRect): void {
  if (!key || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, JSON.stringify(rect))
  } catch {
    // quota / private mode — ignore
  }
}

/**
 * Minimal draggable + resizable (all 8 edges/corners) + closable floating
 * panel. `drag.*` goes on a drag handle; `resize(dir).*` goes on each edge /
 * corner handle. The returned `style` positions the panel as `position: fixed`;
 * position and size stay clamped to the viewport.
 *
 * Pass `persistKey` to save position/size across reloads under that
 * localStorage key. The panel also re-clamps to the viewport whenever the
 * window is resized, so a saved position that would now sit off-screen is
 * pulled back into view.
 */
export function useFloatingPanel(initial: FloatingPanelRect, persistKey?: string) {
  const [rect, setRect] = useState<FloatingPanelRect>(() => readPersisted(persistKey, initial))
  const [closed, setClosed] = useState(false)
  const dragRef = useRef<DragState | null>(null)
  const resizeRef = useRef<ResizeState | null>(null)

  const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max)

  // Persist position changes (debounced via rect identity; cheap for small panels).
  useEffect(() => {
    writePersisted(persistKey, rect)
  }, [persistKey, rect])

  // Re-clamp to the viewport on window resize so a saved rect doesn't land
  // off-screen after the window shrinks.
  useEffect(() => {
    const onResize = () => {
      setRect(prev => ({
        x: clamp(prev.x, 8 - prev.w, Math.max(8, window.innerWidth - 8)),
        y: clamp(prev.y, 0, Math.max(0, window.innerHeight - 40)),
        w: clamp(prev.w, MIN_W, Math.max(MIN_W, window.innerWidth - 16)),
        h: clamp(prev.h, MIN_H, Math.max(MIN_H, window.innerHeight - 16))
      }))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const drag = {
    start: useCallback(
      (event: ReactPointerEvent<HTMLElement>) => {
        if (event.button !== 0) return
        dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, rect }
        event.currentTarget.setPointerCapture(event.pointerId)
      },
      [rect]
    ),
    move: useCallback((event: ReactPointerEvent<HTMLElement>) => {
      const state = dragRef.current
      if (!state || event.pointerId !== state.pointerId) return
      const nx = state.rect.x + (event.clientX - state.startX)
      const ny = state.rect.y + (event.clientY - state.startY)
      setRect(prev => ({
        ...prev,
        x: clamp(nx, 8 - prev.w, window.innerWidth - 8),
        y: clamp(ny, 0, window.innerHeight - 40)
      }))
    }, []),
    end: useCallback((event: ReactPointerEvent<HTMLElement>) => {
      if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null
    }, [])
  }

  // Memoize the per-direction handlers map so consumers don't re-render on every
  // rect change — only when the rect itself actually moves.
  const resize = useMemo(
    () =>
      (dir: ResizeDirection) => ({
        start: (event: ReactPointerEvent<HTMLElement>) => {
          if (event.button !== 0) return
          event.stopPropagation()
          resizeRef.current = { dir, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, rect }
          event.currentTarget.setPointerCapture(event.pointerId)
        },
        move: (event: ReactPointerEvent<HTMLElement>) => {
          const state = resizeRef.current
          if (!state || event.pointerId !== state.pointerId) return
          const dx = event.clientX - state.startX
          const dy = event.clientY - state.startY
          const { x, y, w, h } = state.rect

          let nx = x
          let ny = y
          let nw = w
          let nh = h

          if (dir.includes('e')) nw = clamp(w + dx, MIN_W, window.innerWidth - x - 8)
          if (dir.includes('s')) nh = clamp(h + dy, MIN_H, window.innerHeight - y - 8)
          if (dir.includes('w')) {
            nw = clamp(w - dx, MIN_W, x + w - 8)
            nx = x + w - nw
          }
          if (dir.includes('n')) {
            nh = clamp(h - dy, MIN_H, y + h - 8)
            ny = y + h - nh
          }

          setRect({ x: nx, y: ny, w: nw, h: nh })
        },
        end: (event: ReactPointerEvent<HTMLElement>) => {
          if (resizeRef.current?.pointerId === event.pointerId) resizeRef.current = null
        }
      }),
    [rect]
  )

  const close = useCallback(() => setClosed(true), [])
  const show = useCallback(() => setClosed(false), [])

  const style = {
    position: 'fixed' as const,
    left: rect.x,
    top: rect.y,
    width: rect.w,
    height: rect.h
  }

  return { closed, close, drag, resize, show, style }
}
