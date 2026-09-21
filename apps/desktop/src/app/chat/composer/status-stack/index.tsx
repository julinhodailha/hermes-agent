import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router'

import { blurComposerInput } from '@/app/chat/composer/focus'
import { useComposerSurfaceId } from '@/app/chat/composer/scope'
import { useSessionView } from '@/app/chat/session-view'
import { AGENTS_ROUTE } from '@/app/routes'
import type { SubmitTextOptions } from '@/app/session/hooks/use-prompt-actions/utils'
import { BillingBanner } from '@/components/billing-banner'
import { StatusSection } from '@/components/chat/status-section'
import { type ResizeDirection, useFloatingPanel } from '@/components/chat/use-floating-panel'
import { FreeTierNoticeStrip, useFreeTierNoticeOwner } from '@/components/free-tier/notice-strip'
import { usePaneVisible } from '@/components/pane-shell/pane-visibility'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { Tip, TipKeybindLabel } from '@/components/ui/tooltip'
import { type Translations, useI18n } from '@/i18n'
import { useSessionSlice, useStoreSelector } from '@/lib/use-session-slice'
import { cn } from '@/lib/utils'
import { $billingBlock } from '@/store/billing-block'
import {
  $statusItemsBySession,
  type ComposerStatusItem,
  dismissBackgroundProcess,
  groupStatusItems,
  refreshBackgroundProcesses,
  type StatusGroup,
  stopBackgroundProcess
} from '@/store/composer-status'
import { $freeTierRoute, $freeTierStatus, freeTierStripPending } from '@/store/free-tier'
import { $previewStatusBySession, dismissPreviewArtifact } from '@/store/preview-status'
import { $sessionControlBySession, refreshSessionControl } from '@/store/session-control'
import { $threadScrolledUpBySession } from '@/store/thread-scroll'
import { openSessionInNewWindow } from '@/store/windows'

import { PreviewStatusRow } from './preview-row'
import { SessionControlSections } from './session-control'
import { useSessionValue } from './session-control-utils'
import { StatusItemRow } from './status-row'
import { SubagentSection } from './subagent-section'
import { useSubagentSnapshot } from './use-subagent-snapshot'

// Slow safety-net poll for silent exits (processes without notify_on_complete
// emit no event when they die). Only armed while a running row is on screen.
const BACKGROUND_POLL_MS = 5_000

// A localhost/loopback preview is only meaningful while its dev server is up, so
// we tie it to a live background process rather than persisting dismissals or
// letting dead URLs pile up. File previews (a real on-disk artifact) stand alone.
const isLocalhostPreview = (target: string): boolean => /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b/i.test(target)

// Real codicons per group (no sparkles): a checklist for todos, the agent glyph
// for subagents, a background process glyph for background tasks.
const GROUP_ICON: Record<StatusGroup['type'], string> = {
  goal: 'target',
  todo: 'checklist',
  subagent: 'agent',
  background: 'server-process'
}

const groupLabel = (group: StatusGroup, s: Translations['statusStack']) => {
  if (group.type === 'goal') {
    const status = group.items[0]?.goalStatus

    return status === 'paused'
      ? s.goalPaused
      : status === 'waiting'
        ? s.goalWaiting
        : status === 'done'
          ? s.goalDone
          : s.goalActive
  }

  if (group.type === 'todo') {
    return s.todos(group.items.filter(i => i.todoStatus === 'completed').length, group.items.length)
  }

  return group.type === 'subagent' ? s.subagents(group.items.length) : s.background(group.items.length)
}

const hasRunningTodo = (group: StatusGroup) =>
  group.type === 'todo' && group.items.some(item => item.todoStatus === 'in_progress' && item.state === 'running')

interface ComposerStatusStackProps {
  onSubmit?: (value: string, options?: SubmitTextOptions) => Promise<boolean> | boolean
  /** The queue, built by the composer (it owns the queue's callbacks). */
  queue: ReactNode
  sessionId: null | string
}

/**
 * The status "sink" above the composer: one card (the queue's chrome) holding
 * every session-scoped status — subagents, background tasks, queue — grouped by
 * type and separated by light dividers. Collapses to nothing when empty.
 */
export function ComposerStatusStack({ onSubmit, queue, sessionId }: ComposerStatusStackProps) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const storedSessionId = useStore(useSessionView().$storedId)
  useSubagentSnapshot(sessionId)
  // Subscribe to THIS session's slice only. Both maps churn on other
  // sessions' activity (subagent ticks, background polls, preview updates in
  // any tile); a whole-map `useStore` re-rendered every mounted stack — one
  // per open tile — on all of it. The per-key arrays are referentially stable
  // across unrelated writes, so the slice hook bails out unless OUR session's
  // items actually changed.
  const items = useSessionSlice($statusItemsBySession, sessionId)
  const previews = useSessionSlice($previewStatusBySession, sessionId)
  const controlEntry = useSessionValue($sessionControlBySession, sessionId)

  const surfaceId = useComposerSurfaceId()
  const scrollSessionId = sessionId ?? surfaceId

  const scrolledUp = useStoreSelector($threadScrolledUpBySession, map =>
    Boolean(scrollSessionId && map[scrollSessionId])
  )

  const billing = useStore($billingBlock)
  const freeTierStatus = useStore($freeTierStatus)
  const freeTierRoute = useStore($freeTierRoute)
  // One claimed owner across every mounted composer, so a split view shows the
  // notice once — and a non-owning stack adds no empty row to its card.
  const ownsFreeTierNotice = useFreeTierNoticeOwner()
  const freeTierNotice = ownsFreeTierNotice && freeTierStripPending(freeTierStatus, freeTierRoute)

  const isStructuredSupported = controlEntry?.capability === 'supported'

  const groups = useMemo(() => {
    const raw = groupStatusItems(items)

    if (isStructuredSupported) {
      return raw.filter(g => g.type !== 'goal')
    }

    return raw
  }, [items, isStructuredSupported])

  // Seed from the registry on session open; event-driven refreshes (terminal /
  // process tool completions) live in use-message-stream. This must NOT reset
  // the gone-polling latch: a mount/remount is not proof of a fresh runtime
  // binding (a boot-restored tile can remount repeatedly while still bound to
  // a dead runtime id), so clearing it here re-arms an endless 4001 storm
  // against that id. The latch is reset at the actual rebind seams instead —
  // gateway reconnect and runtime re-mint (see resetBackgroundPollingGuard
  // call sites in use-gateway-boot.ts and store/gateway.ts).
  useEffect(() => {
    if (sessionId) {
      void refreshBackgroundProcesses(sessionId)
      void refreshSessionControl(sessionId)
    }
  }, [sessionId])

  const hasRunningBackground = groups.some(g => g.type === 'background' && g.items.some(i => i.state === 'running'))

  // Drop localhost previews once no dev server is left running — that's what made
  // dead `localhost:5174` chips stick around. On-disk file previews are kept.
  const visiblePreviews = previews.filter(item => hasRunningBackground || !isLocalhostPreview(item.target))

  // Keep-alive keeps every ever-active tab mounted, so without this gate each
  // background tile's safety-net poll fires every 5s — N sessions means N
  // gateway round-trips plus shared-map churn forever. Hidden tabs skip the
  // poll (event-driven refreshes in use-message-stream still land through the
  // store) and resume it on reveal via `paneVisible` in the dep array.
  const paneVisible = usePaneVisible()

  // Floating + resizable + closable: the whole status stack is a free panel the
  // user can drag, resize (bottom-right corner) and close (reopen chip below).
  const floating = useFloatingPanel({ x: 16, y: 120, w: 380, h: 320 })

  useEffect(() => {
    if (!sessionId || !hasRunningBackground || !paneVisible) {
      return
    }

    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refreshBackgroundProcesses(sessionId)
      }
    }, BACKGROUND_POLL_MS)

    return () => clearInterval(timer)
  }, [hasRunningBackground, sessionId, paneVisible])

  const openAgents = () => navigate(AGENTS_ROUTE)

  const openSubagent = (item: ComposerStatusItem) =>
    item.sessionId ? void openSessionInNewWindow(item.sessionId, { watch: true }) : openAgents()

  const previewRows =
    visiblePreviews.length > 0 && sessionId
      ? visiblePreviews.map(item => (
          <PreviewStatusRow
            item={item}
            key={item.id}
            onDismiss={id => dismissPreviewArtifact(sessionId, id, storedSessionId ?? sessionId)}
          />
        ))
      : []

  const sections: { key: string; node: ReactNode }[] = []

  // Billing wall sits at the very top of the stack — it's the most important
  // thing above the composer when the account is out of credits. Rendered here
  // (not as a composer-disable) so slash commands stay usable.
  if (billing && sessionId && billing.sessionId === sessionId) {
    sections.push({ key: 'billing', node: <BillingBanner sessionId={sessionId} /> })
  }

  // Below the billing wall (a blocker outranks an offer), above everything the
  // session itself is doing. The strip retires itself the moment any of its
  // actions acks the notice.
  if (freeTierNotice) {
    sections.push({ key: 'free-tier', node: <FreeTierNoticeStrip /> })
  }

  const hasControlContent = Boolean(
    controlEntry &&
    (controlEntry.error ||
      controlEntry.snapshot?.goal ||
      controlEntry.snapshot?.loop ||
      controlEntry.snapshot?.heartbeat)
  )

  if (sessionId && controlEntry && hasControlContent) {
    sections.push({
      key: 'session-control',
      node: <SessionControlSections entry={controlEntry} onSubmit={onSubmit} sessionId={sessionId} />
    })
  }

  for (const group of groups) {
    if (group.type === 'subagent' && sessionId) {
      sections.push({ key: group.type, node: <SubagentSection key={sessionId} sessionId={sessionId} /> })

      continue
    }

    sections.push({
      key: group.type,
      node: (
        <StatusSection
          accessory={
            group.type === 'subagent' ? (
              <Tip label={<TipKeybindLabel actionId="nav.agents" text={t.statusStack.agents} />}>
                <Button
                  className="text-muted-foreground/75 hover:text-foreground/90"
                  onClick={openAgents}
                  size="micro"
                  type="button"
                  variant="text"
                >
                  {t.statusStack.agents}
                </Button>
              </Tip>
            ) : undefined
          }
          collapsedIndicator={
            hasRunningTodo(group) ? (
              <GlyphSpinner
                ariaLabel={t.statusStack.running}
                className="text-[0.8rem] leading-none text-muted-foreground/80"
                spinner="braille"
              />
            ) : undefined
          }
          defaultCollapsed={group.type !== 'todo'}
          icon={<Codicon className="text-muted-foreground/70" name={GROUP_ICON[group.type]} size="0.8rem" />}
          label={groupLabel(group, t.statusStack)}
        >
          {group.items.map(item => (
            <StatusItemRow
              item={item}
              key={item.id}
              onDismiss={sessionId ? id => dismissBackgroundProcess(sessionId, id) : undefined}
              onOpen={() => openSubagent(item)}
              onStop={sessionId ? id => void stopBackgroundProcess(sessionId, id) : undefined}
            />
          ))}
        </StatusSection>
      )
    })
  }

  if (queue) {
    sections.push({ key: 'queue', node: queue })
  }

  // Artifact links stay visible at the bottom, nearest the composer, even when
  // the queue or background group expands.
  if (previewRows.length > 0) {
    sections.push({ key: 'preview', node: <div className="status-artifacts">{previewRows}</div> })
  }

  // Micro actions are the TOP-MOST thing in the whole overlay lane — above the
  // status card, above the billing wall, above everything. They're the only
  // rows up here you press instead of read, so nothing may ever stack on top
  // of them. Rendered outside the card (below) so the pills float.
  const visible = sections.length > 0

  // No height to publish: the stack is an in-flow child of the composer dock,
  // so the dock's own measurement (--composer-measured-height) already covers
  // it and the thread clears both with one number.

  if (!visible) {
    return null
  }

  if (floating.closed) {
    return (
      <button
        className="fixed bottom-3 left-3 z-40 flex items-center gap-1.5 rounded-full border border-border bg-popover px-2.5 py-1 text-[0.65rem] text-muted-foreground shadow-sm hover:text-foreground"
        data-slot="status-stack-reopen"
        onClick={floating.show}
        type="button"
      >
        <Codicon name="agent" size="0.75rem" />
        status
      </button>
    )
  }

  return (
    <div
      className="fixed z-40 flex max-h-[50vh] flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
      data-slot="composer-status-stack"
      onPointerDownCapture={() => blurComposerInput()}
      style={{ ...floating.style, maxWidth: 560 }}
    >
      {/* Drag handle + close. */}
      <div
        className="flex cursor-grab items-center gap-2 border-b border-border px-2.5 py-1 active:cursor-grabbing"
        data-slot="status-stack-drag"
        onPointerCancel={floating.drag.end}
        onPointerDown={floating.drag.start}
        onPointerMove={floating.drag.move}
        onPointerUp={floating.drag.end}
      >
        <span className="flex-1 select-none text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">
          status
        </span>
        <button
          aria-label="Fechar"
          className="rounded p-0.5 text-muted-foreground/70 hover:bg-muted hover:text-foreground"
          onClick={floating.close}
          type="button"
        >
          <Codicon name="close" size="0.75rem" />
        </button>
      </div>

      <div className="min-h-0 overflow-y-auto overscroll-y-contain" data-slot="status-stack-scroll">
        <div
          className={cn(
            'transition-opacity duration-200 ease-out',
            scrolledUp ? 'opacity-30 group-hover/composer:opacity-100' : 'opacity-100'
          )}
          data-slot="status-stack-content"
        >
          {sections.map(section => (
            <div data-slot="status-stack-section" key={section.key}>
              {section.node}
            </div>
          ))}
        </div>
      </div>

      {/* Resize handles — 4 edges + 4 corners. */}
      {(
        [
          ['n', 'absolute left-1 right-1 top-0 h-1.5 cursor-ns-resize'],
          ['s', 'absolute bottom-0 left-1 right-1 h-1.5 cursor-ns-resize'],
          ['w', 'absolute bottom-1 left-0 top-1 w-1.5 cursor-ew-resize'],
          ['e', 'absolute bottom-1 right-0 top-1 w-1.5 cursor-ew-resize'],
          ['nw', 'absolute left-0 top-0 h-2.5 w-2.5 cursor-nwse-resize'],
          ['ne', 'absolute right-0 top-0 h-2.5 w-2.5 cursor-nesw-resize'],
          ['sw', 'absolute bottom-0 left-0 h-2.5 w-2.5 cursor-nesw-resize'],
          ['se', 'absolute bottom-0 right-0 h-2.5 w-2.5 cursor-nwse-resize']
        ] as Array<[ResizeDirection, string]>
      ).map(([dir, cls]) => {
        const r = floating.resize(dir)

        return (
          <div
            className={cls}
            data-slot={`status-stack-resize-${dir}`}
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
