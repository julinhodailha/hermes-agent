'use client'

import { useStore } from '@nanostores/react'
import { type FC, type ReactNode, useMemo } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { useElapsedSeconds } from '@/components/chat/activity-timer'
import { ActivityTimerText } from '@/components/chat/activity-timer-text'
import { SCAFFOLD_GLYPH_CLASS, SCAFFOLD_LABEL_CLASS, SCAFFOLD_META_CLASS } from '@/components/chat/scaffold-row'
import { type ResizeDirection, useFloatingPanel } from '@/components/chat/use-floating-panel'
import { Codicon } from '@/components/ui/codicon'
import { FadeText } from '@/components/ui/fade-text'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { useI18n } from '@/i18n'
import { AlertCircle, CheckCircle2 } from '@/lib/icons'
import { displayModelName } from '@/lib/model-status-label'
import { useSessionSlice } from '@/lib/use-session-slice'
import { cn } from '@/lib/utils'
import { $subagentsBySession } from '@/store/subagents'
import { openSessionInNewWindow } from '@/store/windows'

import {
  type DelegateRow,
  delegateRowsFromCall,
  type DelegateRowStatus,
  isDelegateRowLive,
  mergeDelegateRows
} from './delegate-model'
import { formatDurationSeconds, type ToolPart } from './fallback-model'
import { ToolRunTicker } from './run-ticker'

// Activity lines kept mounted behind the visible one. Enough for the reel to
// read as motion, few enough that a chatty child doesn't hold a hundred rows
// in the DOM per subagent.
const TICKER_DEPTH = 6

// 8 resize handles (4 edges + 4 corners).
const RESIZE_HANDLES: Array<[ResizeDirection, string]> = [
  ['n', 'absolute left-1 right-1 top-0 h-1.5 cursor-ns-resize'],
  ['s', 'absolute bottom-0 left-1 right-1 h-1.5 cursor-ns-resize'],
  ['w', 'absolute bottom-1 left-0 top-1 w-1.5 cursor-ew-resize'],
  ['e', 'absolute bottom-1 right-0 top-1 w-1.5 cursor-ew-resize'],
  ['nw', 'absolute left-0 top-0 h-2.5 w-2.5 cursor-nwse-resize'],
  ['ne', 'absolute right-0 top-0 h-2.5 w-2.5 cursor-nesw-resize'],
  ['sw', 'absolute bottom-0 left-0 h-2.5 w-2.5 cursor-nesw-resize'],
  ['se', 'absolute bottom-0 right-0 h-2.5 w-2.5 cursor-nwse-resize']
]

function statusGlyph(status: DelegateRowStatus, label: string): ReactNode {
  if (isDelegateRowLive(status)) {
    return (
      <GlyphSpinner ariaLabel={label} className="size-3.5 text-[0.95rem] text-(--ui-text-tertiary)" spinner="breathe" />
    )
  }

  if (status === 'failed' || status === 'interrupted') {
    return <AlertCircle aria-label={label} className="size-3.5 text-destructive" />
  }

  if (status === 'dispatched') {
    return <span aria-hidden className="size-1.5 rounded-full bg-(--ui-text-tertiary)" />
  }

  return <CheckCircle2 aria-label={label} className="size-3.5 text-emerald-600/85 dark:text-emerald-400/85" />
}

/**
 * One delegated child — a free-floating card the user can drag (header),
 * resize (all 8 edges/corners) and close. It identifies who it is on the
 * first line and what it is doing underneath.
 */
function DelegateRowView({ row, index }: { row: DelegateRow; index: number }) {
  const { t } = useI18n()
  const copy = t.assistant.tool
  const { sessionId } = row
  const live = isDelegateRowLive(row.status)
  const elapsed = useElapsedSeconds(live, `delegate:${row.id}`)
  const activity = row.activity.slice(-TICKER_DEPTH)
  const floating = useFloatingPanel({ x: 220 + index * 24, y: 160 + index * 24, w: 340, h: 120 })

  if (floating.closed) {
    return null
  }

  const statusLabel = live
    ? copy.statusRunning
    : row.status === 'failed' || row.status === 'interrupted'
      ? copy.statusError
      : copy.statusDone

  const meta = [
    row.model ? displayModelName(row.model) : '',
    !live && row.durationSeconds ? formatDurationSeconds(row.durationSeconds) : ''
  ].filter(Boolean)

  const open = sessionId ? () => void openSessionInNewWindow(sessionId, { watch: true }) : undefined

  return (
    <div
      className="fixed z-40 flex flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
      data-slot="delegate-floating-card"
      style={floating.style}
    >
      {/* Drag handle + close. */}
      <div
        className="flex cursor-grab items-center gap-1.5 border-b border-border px-3 py-2 active:cursor-grabbing"
        onPointerCancel={floating.drag.end}
        onPointerDown={floating.drag.start}
        onPointerMove={floating.drag.move}
        onPointerUp={floating.drag.end}
      >
        <span className={SCAFFOLD_GLYPH_CLASS}>{statusGlyph(row.status, statusLabel)}</span>
        <button
          className={cn(
            SCAFFOLD_LABEL_CLASS,
            'min-w-0 flex-1 truncate text-left transition-colors',
            open ? 'hover:text-foreground focus-visible:text-foreground focus-visible:outline-none' : 'cursor-default'
          )}
          disabled={!open}
          onClick={open}
          type="button"
        >
          {row.goal}
        </button>
        {meta.length > 0 && <span className={SCAFFOLD_META_CLASS}>{meta.join(' · ')}</span>}
        {live && <ActivityTimerText className={SCAFFOLD_META_CLASS} seconds={elapsed} />}
        <button
          aria-label="Fechar"
          className="shrink-0 rounded p-0.5 text-muted-foreground/70 hover:bg-muted hover:text-foreground"
          onClick={floating.close}
          type="button"
        >
          <Codicon name="close" size="0.75rem" />
        </button>
      </div>

      {/* Activity ticker. */}
      {activity.length > 0 && (
        <div className="min-w-0 flex-1 overflow-y-auto py-1.5 pl-5 pr-3">
          <ToolRunTicker>
            {activity.map((text, index) => (
              <FadeText
                className={cn(SCAFFOLD_LABEL_CLASS, 'text-(--conversation-scaffold-meta)', live && 'shimmer')}
                key={`${row.id}:${index}`}
              >
                {text}
              </FadeText>
            ))}
          </ToolRunTicker>
        </div>
      )}

      {/* Resize handles. */}
      {RESIZE_HANDLES.map(([dir, cls]) => {
        const r = floating.resize(dir)
        return (
          <div
            className={cls}
            data-slot={`delegate-resize-${dir}`}
            key={dir}
            onPointerCancel={r.end}
            onPointerDown={r.start}
            onPointerMove={r.move}
            onPointerUp={r.end}
          />
        )
      })}
    </div>
  )
}

/**
 * A `delegate_task` call, as the fan-out it is — each child rendered as its own
 * free-floating card the user can arrange on screen.
 */
export const DelegateTool: FC<Pick<ToolPart, 'args' | 'result' | 'toolCallId'>> = ({ args, result, toolCallId }) => {
  const sessionId = useStore(useSessionView().$runtimeId)
  const live = useSessionSlice($subagentsBySession, sessionId)

  const rows = useMemo(
    () => mergeDelegateRows(delegateRowsFromCall(args, result, toolCallId), live, toolCallId),
    [args, live, result, toolCallId]
  )

  if (rows.length === 0) {
    return null
  }

  return (
    <div data-delegate-card="" data-slot="tool-block">
      {rows.map((row, index) => (
        <DelegateRowView index={index} key={row.id} row={row} />
      ))}
    </div>
  )
}
