import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { LocalAISetup } from './LocalAISetup'
import { followConversation } from './conversation-follow'
import { RollingBall } from './RollingBall'
import { fitPanelWidth } from './panel-layout'
import type { ConfigStatus, GitHubAuthStatus, GlassError, SessionListItem, SessionSummary, SessionView, TurnCapture, TurnView, WorkspaceContext } from '@shared/types'
import type { ConfirmationRequest, LoopStateView, Playbook } from '@op-shared/types'
import type { SelectedEmail } from '@shared/types'
import { Settings } from './Settings'
import { PlusUpgradeModal } from './PlusUpgradeModal'
import { ChatSidebar } from './ChatSidebar'
import { VideoRecorder } from './VideoRecorder'
import { extractVideoFrames, formatMediaDuration } from './video'
import { ProjectWorkspace } from './ProjectWorkspace'
import { CodePanelContext, type CodeArtifact } from './codePanelContext'
import { primaryCodeBlock } from './codeTheme'
import { getConfigBridge } from './config-bridge'
import { isSubmittable, makeTextTurn } from './chat'
import {
    describeConfirmationAction,
    describeStep,
    isBusyState,
    isTerminalState,
    sanitizeHelpText,
    type StepItem
} from './operator'
import { renderPdfToImages } from './pdf'
import { routeIntent, isWorkspaceTask } from './intentRouter'
import { useSmoothDictation as useDictation } from '../voice-lib-v2'
import {
    addUserMessage,
    appendTurn,
    clearError,
    initialConversationState,
    setError,
    setPending,
    type ConversationState
} from './conversation'
import { getChatBridge, getOperatorBridge } from './bridges'
import {
    CaretIcon,
    CheckIcon,
    ChevronIcon,
    ImageFileIcon,
    MailIcon,
    SendIcon,
    StopIcon,
    VideoCameraIcon
} from './icons'
import { TurnBody } from './turns'
import {
    finderName,
    formatEmailContext,
    makeShotName,
    MAX_STAGED_VIDEOS,
    type StagedAttachment
} from './attachments'
import {
    compactSidebarText,
    friendlyProvider,
    NAV_OVERLAY_BREAKPOINT,
    OPERATOR_DRAFT_ID,
    operatorViewToSteps,
    operatorViewToTurns,
    titleFromTurns
} from './rail'
import { HeaderSelect } from './HeaderSelect'
import { PermissionOnboarding } from './PermissionOnboarding'
import { EnvironmentMenu, type EnvironmentSource } from './EnvironmentMenu'
import { InspectorPanel, type InspectorArtifact } from './InspectorPanel'
import { WorkspaceBar } from './WorkspaceBar'
import { TerminalPanel } from './TerminalPanel'
import {
    TaskActivityCard,
} from './TaskActivity'

/**
 * Sidebar shell + chat UI.
 *
 * Capture is triggered from the floating pencil window. Assistant guidance is
 * rendered as Markdown. The header exposes History, New, and Settings panels.
 */

function usableSelectedModel(status: ConfigStatus): string {
    const selected = status.model.trim()
    if (selected.startsWith('gemini') && status.hasGemini) return selected
    if (selected.startsWith('openrouter') && status.hasOpenrouter) return selected
    if (selected && status.hasCredentials) return selected
    if (status.hasGemini) return status.geminiModel || 'gemini-2.5-flash'
    if (status.hasOpenrouter) return status.openrouterModel || 'openrouter/free'
    return ''
}

const ENVIRONMENT_COMPACT_BREAKPOINT = 1050

export function App(): React.JSX.Element {
    const [state, setState] = useState<ConversationState>(() => initialConversationState())
    const [draft, setDraft] = useState('')
    const [composerExpanded, setComposerExpanded] = useState(false)
    const [showSettings, setShowSettings] = useState(false)
    const [accessDialogOpen, setAccessDialogOpen] = useState(false)
    const checkingAccess = useRef(false)
    // The code artifact shown in the right-hand panel (Claude-style), or null.
    const [codeArtifact, setCodeArtifact] = useState<CodeArtifact | null>(null)
    const [inspectorArtifact, setInspectorArtifact] = useState<InspectorArtifact | null>(null)
    const [rightPanelOpen, setRightPanelOpen] = useState(() =>
        typeof window !== 'undefined'
            ? window.innerWidth > ENVIRONMENT_COMPACT_BREAKPOINT
            : true
    )
    const [terminalOpen, setTerminalOpen] = useState(false)
    const [projectOpen, setProjectOpen] = useState(false)
    const [projectTabHost, setProjectTabHost] = useState<HTMLDivElement | null>(null)
    const [projectRunning, setProjectRunning] = useState(false)
    const [workspaceMode, setWorkspaceMode] = useState(false)
    useEffect(() => {
        if (!window.workspace) return
        const dispose = window.workspace.onTask(event => {
            setProjectRunning(event.running)
            if (event.running) { setProjectOpen(true); setInspectorArtifact(null); setRightPanelOpen(false) }
        })
        const key = (event: KeyboardEvent): void => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p') {
                event.preventDefault(); setProjectOpen(true); setInspectorArtifact(null); setRightPanelOpen(false)
            }
        }
        window.addEventListener('keydown', key)
        return () => { dispose(); window.removeEventListener('keydown', key) }
    }, [])
    // User-draggable width of the right code panel (persists while open).
    const [codePanelWidth, setCodePanelWidth] = useState(() =>
        Math.max(260, Math.round((window.innerWidth - 296) / 2))
    )
    // Set while the on-device model downloads on first use (one-time), so the
    // wait shows a friendly status instead of looking like a hang.
    const [authStatus, setAuthStatus] = useState<GitHubAuthStatus | null>(null)
    const [configStatus, setConfigStatus] = useState<ConfigStatus | null>(null)
    const codePanelApi = useRef({ open: (a: CodeArtifact) => {
        setInspectorArtifact(null)
        setCodeArtifact(a)
        setRightPanelOpen(false)
    } }).current
    // Tracks the last copilot answer we auto-opened, so a fresh answer with code
    // opens the panel exactly once (clicking a pill re-opens it thereafter).
    const lastAutoOpenedTurnRef = useRef<string | null>(null)
    const [navOpen, setNavOpen] = useState(() =>
        typeof window !== 'undefined' ? window.innerWidth > NAV_OVERLAY_BREAKPOINT : true
    )
    const [navWidth, setNavWidth] = useState(() => {
        const saved = Number(localStorage.getItem('chat-sidebar-width'))
        return Number.isFinite(saved) && saved >= 230 && saved <= 420 ? saved : 296
    })

    const [viewportWidth, setViewportWidth] = useState(window.innerWidth)
    useEffect(() => {
        const resize = (): void => setViewportWidth(window.innerWidth)
        window.addEventListener('resize', resize)
        return () => window.removeEventListener('resize', resize)
    }, [])
    const panelWidth = fitPanelWidth(codePanelWidth, viewportWidth, navOpen && viewportWidth > NAV_OVERLAY_BREAKPOINT ? navWidth : 0)

    // This is deliberately task-scoped. Never point the product UI at this
    // application's own development repository: Changes is populated only by
    // files an agent task explicitly records as generated or edited.
    const taskWorkspaceContext: WorkspaceContext = {
        root: '',
        repositoryName: 'Task workspace',
        isGitRepository: false,
        branch: 'main',
        additions: 0,
        deletions: 0,
        changedFiles: 0,
        ahead: 0,
        behind: 0,
        lastCommit: '',
        diff: ''
    }
    const [history, setHistory] = useState<SessionListItem[]>([])
    const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
    const [summary, setSummary] = useState<SessionSummary | null>(null)
    const [currentModel, setCurrentModel] = useState('')
    // Operator controls (merged from Codex Lite): where the agent acts, how
    // much it may do on its own, and its step cap. Wired to the operator engine
    // in a later stage; here they own the header UI next to New/Instructions/Settings.
    // Computer/Browser Use is an internal capability, never a separate user mode.
    const operatorMode = false
    const [opEnvironment, setOpEnvironment] = useState<'browser' | 'container-desktop' | 'local'>('browser')
    const [opAutonomy, setOpAutonomy] = useState<'manual' | 'supervised' | 'autonomous'>('autonomous')

    // Live status pill (operator): the provider actually serving steps right now
    // (updates as the fallback chain shifts) and whether it is acting via the
    // DOM (api) or raw pixels (vision).
    const [opActiveProvider, setOpActiveProvider] = useState<string | null>(null)
    const [opActiveMode, setOpActiveMode] = useState<'api' | 'vision' | null>(null)
    const [visionSources, setVisionSources] = useState<EnvironmentSource[]>([])
    const [computerUseSessionIds, setComputerUseSessionIds] = useState<Set<string>>(() => {
        try {
            const ids = JSON.parse(localStorage.getItem('computer-use-session-ids') ?? '[]')
            return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [])
        } catch {
            return new Set()
        }
    })
    // Track the active chat/task independently so switching modes preserves the
    // selected row in each history rail.
    const [chatSessionId, setChatSessionId] = useState<string | null>(null)
    useEffect(() => { setWorkspaceMode(false) }, [chatSessionId])
    useEffect(() => {
        if (!window.browserWorkspace) return
        const dispose = window.browserWorkspace.onChanged(state => {
            if (state.focusId) { setProjectOpen(true); setInspectorArtifact(null); setRightPanelOpen(false); setWorkspaceMode(false) }
        })
        const key = (event: KeyboardEvent): void => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 't') {
                event.preventDefault()
                void window.browserWorkspace.create().catch(() => {})
            }
        }
        window.addEventListener('keydown',key)
        return () => {dispose(); window.removeEventListener('keydown',key)}
    }, [])
    const [opSessionId, setOpSessionId] = useState<string | null>(null)
    // True while the user has an unused "New task" draft. Operator sessions
    // only exist once a goal is submitted, so the draft is renderer state: it
    // keeps its rail row alive when the user browses older tasks, and is
    // consumed by the first goal or removed by right-click delete.
    const [opDraft, setOpDraft] = useState(false)
    // Saved reusable task templates, shown in the operator's New-task
    // workspace. Loaded from the main-process store on operator-mode entry.
    const [playbooks, setPlaybooks] = useState<Playbook[]>([])
    // The operator's live steps for the current run, rendered as a bordered
    // checklist (each with a tick; a spinner trails while the agent works).
    const [opSteps, setOpSteps] = useState<Array<{ id: string } & StepItem>>([])
    const [opStepBudget, setOpStepBudget] = useState('25')
    // The operator's pending confirmation request (Manual/Supervised autonomy),
    // rendered inline in the conversation with Approve/Decline.
    const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null)
    // A local goal waits here only while macOS permissions are being granted.
    // There is no generic up-front plan: live rows arrive from real engine events.
    const [permissionQueuedGoal, setPermissionQueuedGoal] = useState<{
        goal: string
        environment: 'browser' | 'container-desktop' | 'local'
        autonomy: 'manual' | 'supervised' | 'autonomous'
        stepBudget: number
    } | null>(null)
    const [opLoopState, setOpLoopState] = useState<LoopStateView['state']>('idle')
    const [permissions, setPermissions] = useState<import('@op-shared/types').PermissionSnapshot>({
        accessibility: 'not-determined',
        screenRecording: 'not-determined'
    })
    const [showPermissionOnboarding, setShowPermissionOnboarding] = useState(false)
    const [permissionBusyKind, setPermissionBusyKind] = useState<'accessibility' | 'screen-recording' | null>(null)
    // Screenshots captured with Cmd+Shift+D land here first (a horizontal
    // carousel above the composer) instead of being sent immediately, so the
    // user can stack several and send them together.
    const [staged, setStaged] = useState<StagedAttachment[]>([])
    const [showVideoRecorder, setShowVideoRecorder] = useState(false)
    const [showAttachMenu, setShowAttachMenu] = useState(false)
    // Mail connector: the Apple Mail message staged for the next chat message.
    const [stagedEmail, setStagedEmail] = useState<SelectedEmail | null>(null)
    const [mailBusy, setMailBusy] = useState(false)
    // User-turn ids whose questions are still processing. Several can be in
    // flight at once — a new question never supersedes an earlier one — and
    // each row offers Cancel for exactly that question.
    const [thinkingIds, setThinkingIds] = useState<readonly string[]>([])
    const [searching, setSearching] = useState(false)
    useEffect(() => window.glass.onSearchStatus?.(setSearching), [])
    const [freshAnswers, setFreshAnswers] = useState<readonly string[]>([])
    const cancelThinking = useCallback((requestId: string) => {
        // Optimistically clear the row; main confirms via request:settled.
        setThinkingIds((prev) => prev.filter((id) => id !== requestId))
        void getChatBridge()?.cancelRequest?.(requestId)?.catch(() => undefined)
    }, [])
    // Operator mode keeps its OWN conversation + history, separate from copilot.
    // Toggling modes swaps the visible chat (copilot chat is hidden, not lost),
    // so each mode reads like its own workspace.
    const [opState, setOpState] = useState<ConversationState>(() => initialConversationState())
    const [opHistory, setOpHistory] = useState<SessionListItem[]>([])
    const baseURLRef = useRef('')
    const conversationRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLTextAreaElement>(null)
    const addFileRef = useRef<HTMLInputElement>(null)
    const stagedRef = useRef<StagedAttachment[]>([])
    const draftRef = useRef('')

    // Revoke playable video blob URLs as soon as their attachment leaves the
    // composer, and again on unmount. Extracted JPEG frames are plain data URLs.
    useEffect(() => {
        const currentUrls = new Set(
            staged.flatMap((attachment) => attachment.previewUrl ? [attachment.previewUrl] : [])
        )
        for (const attachment of stagedRef.current) {
            if (attachment.previewUrl && !currentUrls.has(attachment.previewUrl)) {
                URL.revokeObjectURL(attachment.previewUrl)
            }
        }
        stagedRef.current = staged
    }, [staged])

    useEffect(() => () => {
        for (const attachment of stagedRef.current) {
            if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
        }
        stagedRef.current = []
    }, [])

    useEffect(() => {
        localStorage.setItem('chat-sidebar-width', String(navWidth))
    }, [navWidth])

    const beginNavResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (window.innerWidth <= NAV_OVERLAY_BREAKPOINT) return
        event.preventDefault()
        const startX = event.clientX
        const startWidth = navWidth
        document.body.classList.add('is-resizing-nav')

        const onMove = (moveEvent: PointerEvent): void => {
            const nextWidth = Math.min(420, Math.max(230, startWidth + moveEvent.clientX - startX))
            setNavWidth(Math.round(nextWidth))
        }
        const onUp = (): void => {
            document.body.classList.remove('is-resizing-nav')
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
    }, [navWidth])

    // Single dictation engine: Whisper base (WebGPU). The faster Moonshine
    // variant was dropped — it hallucinated too often to trust.
    const voiceOpts = {
        getText: () => draftRef.current,
        setText: setDraft,
        onError: (message: string) =>
            setState((s) => setError(s, { kind: 'render-failed', message: `Voice: ${message}`, recoverable: true }))
    }
    const dictation = useDictation(voiceOpts)

    // v1's Dictation has no cancel(); fall back to stop() + clear for it.
    const cancelActive = useCallback(() => {
        const d = dictation as { cancel?: () => void; stop: () => void }
        if (typeof d.cancel === 'function') d.cancel()
        else {
            d.stop()
            setDraft('')
        }
    }, [dictation])

    useEffect(() => {
        const bridge = getChatBridge()
        if (!bridge) {
            return
        }

        let active = true
        void bridge
            .getSession()
            .then((session) => {
                if (!active) return
                setChatSessionId(session.id || null)
                if (session.turns.length) {
                    setState(initialConversationState(session.turns))
                }
                setSummary(session.summary ?? null)
            })
            .catch(() => {
                /* No restorable session; start empty. */
            })

        // Populate the history sidebar on launch.
        if (typeof bridge.listSessions === 'function') {
            void bridge
                .listSessions()
                .then((items) => {
                    if (active) setHistory(items)
                })
                .catch(() => undefined)
        }

        const unsubscribers: Array<void | (() => void)> = [
            bridge.onTurnAppended((turn) => {
                if (turn.role === 'assistant' && turn.status !== 'error') setFreshAnswers(ids => [...ids.slice(-20), turn.id])
                setState((s) => appendTurn(s, turn))
            }),
            bridge.onPending((pending) => setState((s) => setPending(s, pending))),
            bridge.onError((err) => setState((s) => setError(s, err))),
            bridge.onSessionState?.((session) => {
                setChatSessionId(session.id || null)
                setState(initialConversationState(session.turns ?? []))
                setSummary(session.summary ?? null)
            }),
            bridge.onSummary?.((s) => setSummary(s)),
            bridge.onCaptureStaged?.((capture) =>
                setStaged((prev) => [
                    ...prev,
                    {
                        id: `shot-${Date.now()}-${prev.length}`,
                        kind: 'image',
                        status: 'ready',
                        captures: [capture],
                        name: makeShotName()
                    }
                ])
            ),
            // Missing model access is surfaced as an ordinary assistant error
            // turn. End users are never asked to paste provider secrets inline.
            bridge.onSetupNeeded?.(() => undefined),
            // Per-question thinking state: each in-flight question shows its own
            // indicator (+ Cancel) under the exact message that asked it.
            bridge.onRequestStarted?.((requestId) =>
                setThinkingIds((prev) => (prev.includes(requestId) ? prev : [...prev, requestId]))
            ),
            bridge.onRequestSettled?.((requestId) =>
                setThinkingIds((prev) => prev.filter((id) => id !== requestId))
            ),
            // Do NOT auto-open Settings on launch when credentials are missing;
            // the user opens Settings themselves. A missing-key error still
            // surfaces inline if they try to send without configuring.
            bridge.onCredentialsRequired?.(() => {
                /* intentionally no-op */
            })
        ]

        return () => {
            active = false
            for (const unsub of unsubscribers) {
                if (typeof unsub === 'function') unsub()
            }
        }
    }, [])

    // Bind the merged operator engine's activity stream into the chat. Each
    // trajectory step becomes an assistant turn; loop-state changes drive the
    // pending indicator; confirmations + agent questions render inline. Bound
    // Bound with cleanup so a re-mount (React StrictMode or a hot reload) always
    // rebinds to THIS component's state — a stale, once-bound subscription was
    // why live steps/status stopped updating after edits.
    useEffect(() => {
        const op = getOperatorBridge()
        if (!op) return

        // Operator activity is attached to the normal chat. The privileged
        // engine remains isolated internally, but there is no separate mode.
        const appendAssistant = (text: string): void => {
            const turn = makeTextTurn('assistant', text)
            if (turn) setState((s) => appendTurn(s, turn))
        }

        const unsubscribers: Array<void | (() => void)> = [
            op.onTrajectoryAppended?.((step) => {
                // Each step becomes a row in the live checklist (not a bubble).
                const item = describeStep(step)
                setOpSteps((prev) => [...prev, { id: `${step.index}-${prev.length}`, ...item }])
                if (step.previewDataUrl) {
                    if (step.result?.mode === 'vision') {
                        const sourceId = `vision-${step.index}`
                        setVisionSources((current) => current.some((source) => source.id === sourceId)
                            ? current
                            : [{
                                id: sourceId,
                                name: `Vision screenshot ${current.length + 1}`,
                                thumbnailUrl: step.previewDataUrl,
                                detail: `Captured during Codex Lite step ${step.index}`
                            }, ...current])
                    }
                }
                // Live status pill: which provider served this step (so a
                // fallback shows in real time) + whether it acted via the DOM
                // (api) or raw pixels (vision).
                if (step.providerId) setOpActiveProvider(step.providerId)
                if (step.result?.mode) setOpActiveMode(step.result.mode)
                if (step.outcome === 'completion' || step.outcome === 'failure') {
                    setState((s) => setPending(s, false))
                }
            }),
            op.onStateChanged?.((view: LoopStateView) => {
                if (view.sessionId) setOpSessionId(view.sessionId)
                setOpLoopState(view.state)
                setState((s) => setPending(s, isBusyState(view.state)))
                if (isTerminalState(view.state)) {
                    setConfirmation(null)
                }
            }),
            op.onConfirmationRequired?.((req) => {
                setConfirmation(req)
                setOpLoopState('awaiting-confirmation')
                setState((s) => setPending(s, false))
            }),
            op.onHelpRequired?.((question) => {
                appendAssistant(
                    sanitizeHelpText(question) ?? 'The agent needs more information to continue.'
                )
                setState((s) => setPending(s, false))
            }),
            op.onError?.((err) => {
                setState((s) => setError(s, { kind: 'render-failed', message: err.message, recoverable: true }))
            }),
            op.onPermissionChanged?.((snapshot) => setPermissions(snapshot))
        ]

        return () => {
            for (const unsub of unsubscribers) {
                if (typeof unsub === 'function') unsub()
            }
        }
    }, [])

    useEffect(() => {
        const el = conversationRef.current
        if (!el) return
        return followConversation(el)
    }, [showSettings])

    // Auto-open the newest copilot answer's code in the right-hand panel the
    // first time it arrives (Claude-style). Marked per-turn so it opens exactly
    // once; the code pill in the message re-opens it on demand thereafter.
    useEffect(() => {
        const turns = state.turns
        for (let i = turns.length - 1; i >= 0; i -= 1) {
            const t = turns[i]
            if (t.role !== 'assistant') continue
            if (t.id === lastAutoOpenedTurnRef.current) return
            lastAutoOpenedTurnRef.current = t.id
            const block = primaryCodeBlock(t.text ?? '')
            if (block) {
                setInspectorArtifact(null)
                setCodeArtifact({ code: block.code, language: block.language })
                setRightPanelOpen(false)
            }
            return
        }
    }, [state.turns])

    // Keep draftRef in sync (read synchronously by dictation), auto-grow the
    // input up to the CSS height limit, then scroll to the latest line. Runs
    // as a layout effect so the textarea is sized before paint — switching back
    // from the dictation transcript doesn't flash a collapsed height.
    useLayoutEffect(() => {
        draftRef.current = draft
        const el = inputRef.current
        if (!el) return
        const resize = (): void => {
            const composer = el.closest('.glass-composer')
            const probe = el.cloneNode() as HTMLTextAreaElement
            probe.removeAttribute('id')
            probe.value = el.value
            probe.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;height:0;min-height:0;max-height:none;width:${Math.max(80, (composer?.clientWidth ?? el.clientWidth) - 112)}px`
            document.body.appendChild(probe)
            setComposerExpanded(probe.scrollHeight > 36)
            probe.remove()
            el.style.height = 'auto'
            el.style.height = `${el.scrollHeight}px`
            el.scrollTop = el.scrollHeight
        }
        resize()
        let width = el.clientWidth
        const observer = new ResizeObserver(() => {
            if (el.clientWidth === width) return
            width = el.clientWidth
            resize()
        })
        observer.observe(el)
        return () => observer.disconnect()
    }, [draft, showSettings])

    // Auto-collapse the sidebar when the window narrows past the mobile
    // breakpoint, and re-open it when it widens again (only on crossing, so a
    // manual collapse/expand within a width band is preserved).
    useEffect(() => {
        let wasWide = window.innerWidth > NAV_OVERLAY_BREAKPOINT
        const onResize = (): void => {
            const isWide = window.innerWidth > NAV_OVERLAY_BREAKPOINT
            if (isWide !== wasWide) {
                wasWide = isWide
                setNavOpen(isWide)
            }
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
    }, [])

    // The floating Environment card should never cover the conversation just
    // because a window was opened or resized compactly. Hide it on entry into
    // the compact range; an explicit toolbar click can still reopen it, and CSS
    // then reserves a lane beside the card instead of allowing overlap.
    useEffect(() => {
        let wasCompact = window.innerWidth <= ENVIRONMENT_COMPACT_BREAKPOINT
        const onResize = (): void => {
            const compact = window.innerWidth <= ENVIRONMENT_COMPACT_BREAKPOINT
            if (compact === wasCompact) return
            wasCompact = compact
            setRightPanelOpen(!compact)
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
    }, [])

    // Load the currently configured model + gateway base URL for the picker.
    useEffect(() => {
        const cb = getConfigBridge()
        if (!cb) return
        void cb
            .getConfigStatus()
            .then((s) => {
                setConfigStatus(s)
                setCurrentModel(usableSelectedModel(s))
                baseURLRef.current = s.baseURL
            })
            .catch(() => undefined)
    }, [])

    const applyConfigStatus = useCallback((status: ConfigStatus): void => {
        setConfigStatus(status)
        setCurrentModel(usableSelectedModel(status))
        baseURLRef.current = status.baseURL
    }, [])


    // Start an operator task for `goal` in the given environment: record it in
    // the operator conversation and kick off the engine. Shared by the explicit
    // operator path and the auto-router (a copilot command routed to operator).
    const runOperatorGoal = useCallback(
        (
            goal: string,
            environment: 'browser' | 'container-desktop' | 'local',
            // Playbooks run with THEIR saved settings; the header pickers may
            // not have re-rendered yet when a run starts, so explicit
            // overrides beat possibly-stale state.
            overrides?: { autonomy?: 'manual' | 'supervised' | 'autonomous'; stepBudget?: number }
        ): Promise<boolean> => {
            setOpSessionId(null)
            // A submitted goal consumes the "New task" draft: the real task
            // takes over its place in the rail.
            setOpDraft(false)
            setState((s) => addUserMessage(s, goal).state)
            // The task is rendered immediately for a responsive UI, while the
            // main process records the same message in the unified chat store.
            void getChatBridge()?.recordTaskMessage?.(goal).catch(() => undefined)
            setOpSteps([]) // fresh checklist for the new run
            const op = getOperatorBridge()
            if (!op || typeof op.startGoal !== 'function') {
                setState((s) =>
                    setError(s, {
                        kind: 'render-failed',
                        message: 'Codex Lite is not connected yet. Your goal was kept.',
                        recoverable: true
                    })
                )
                return Promise.resolve(false)
            }
            setState((s) => setPending(s, true))
            return op
                .startGoal({
                    goal,
                    autonomy: overrides?.autonomy ?? opAutonomy,
                    stepBudget:
                        overrides?.stepBudget ?? Math.max(1, Number.parseInt(opStepBudget, 10) || 25),
                    environment
                })
                .then((result) => {
                    if (!result.ok) {
                        setState((s) => setPending(s, false))
                        setState((s) =>
                            setError(s, { kind: 'render-failed', message: result.error.message, recoverable: true })
                        )
                        return false
                    }
                    setOpSessionId(result.sessionId)
                    return true
                })
                .catch((err: unknown) => {
                    setState((s) => setPending(s, false))
                    const message = err instanceof Error ? err.message : 'Failed to start the task.'
                    setState((s) => setError(s, { kind: 'render-failed', message, recoverable: true }))
                    return false
                })
        },
        [opAutonomy, opStepBudget]
    )

    const beginOperatorGoal = useCallback(
        (
            goal: string,
            environment: 'browser' | 'container-desktop' | 'local',
            overrides?: { autonomy?: 'manual' | 'supervised' | 'autonomous'; stepBudget?: number }
        ) => {
            const autonomy = overrides?.autonomy ?? opAutonomy
            const stepBudget = overrides?.stepBudget ?? Math.max(1, Number.parseInt(opStepBudget, 10) || 25)
            setOpLoopState('idle')
            void (async () => {
                if (environment === 'local') {
                    const snapshot = await getOperatorBridge()?.getPermissions?.().catch(() => null)
                    if (snapshot) setPermissions(snapshot)
                    if (
                        !snapshot ||
                        snapshot.accessibility !== 'granted' ||
                        snapshot.screenRecording !== 'granted'
                    ) {
                        setPermissionQueuedGoal({ goal, environment, autonomy, stepBudget })
                        setShowPermissionOnboarding(true)
                        return
                    }
                }
                void runOperatorGoal(goal, environment, { autonomy, stepBudget })
            })()
        },
        [opAutonomy, opStepBudget, runOperatorGoal]
    )

    const requestOperatorPermission = useCallback((kind: 'accessibility' | 'screen-recording') => {
        const op = getOperatorBridge()
        if (!op?.requestPermission) return
        setPermissionBusyKind(kind)
        void op.requestPermission(kind)
            .then(setPermissions)
            .catch(() => undefined)
            .finally(() => setPermissionBusyKind(null))
    }, [])

    useEffect(() => {
        if (!showPermissionOnboarding) return
        const refresh = (): void => {
            void getOperatorBridge()?.getPermissions?.().then(setPermissions).catch(() => undefined)
        }
        refresh()
        const timer = window.setInterval(refresh, 1500)
        return () => window.clearInterval(timer)
    }, [showPermissionOnboarding])

    // ---- Playbooks: list / run / save / delete --------------------------
    const refreshPlaybooks = useCallback(() => {
        const op = getOperatorBridge()
        if (op && typeof op.listPlaybooks === 'function') {
            void op.listPlaybooks().then(setPlaybooks).catch(() => undefined)
        }
    }, [])
    useEffect(() => {
        if (operatorMode) refreshPlaybooks()
    }, [operatorMode, refreshPlaybooks])
    const runPlaybook = useCallback(
        (pb: Playbook) => {
            // Reflect the playbook's saved settings in the header pickers and
            // run with explicit overrides (state updates land next render).
            setOpAutonomy(pb.autonomy)
            setOpStepBudget(String(pb.stepBudget))
            setOpEnvironment(pb.environment)
            beginOperatorGoal(pb.goal, pb.environment, {
                autonomy: pb.autonomy,
                stepBudget: pb.stepBudget
            })
        },
        [beginOperatorGoal]
    )
    const saveDraftAsPlaybook = useCallback(() => {
        const goal = draft.trim()
        if (goal.length === 0) return
        const op = getOperatorBridge()
        if (!op || typeof op.savePlaybook !== 'function') return
        const firstLine = goal.split('\n', 1)[0] ?? goal
        const name = firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine
        void op
            .savePlaybook({
                name,
                goal,
                autonomy: opAutonomy,
                stepBudget: Math.max(1, Number.parseInt(opStepBudget, 10) || 25),
                environment: opEnvironment
            })
            .then(setPlaybooks)
            .catch(() => undefined)
    }, [draft, opAutonomy, opStepBudget, opEnvironment])
    const deletePlaybook = useCallback((id: string) => {
        const op = getOperatorBridge()
        if (!op || typeof op.deletePlaybooks !== 'function') return
        void op.deletePlaybooks([id]).then(setPlaybooks).catch(() => undefined)
    }, [])
    // Set / clear a playbook's daily schedule (null clears). Runs happen while
    // the app is open; a missed time catches up on next launch that day.
    const updatePlaybookSchedule = useCallback(
        (pb: Playbook, schedule: { timeOfDay: string; enabled: boolean } | null) => {
            const op = getOperatorBridge()
            if (!op || typeof op.savePlaybook !== 'function') return
            void op
                .savePlaybook({
                    id: pb.id,
                    name: pb.name,
                    goal: pb.goal,
                    autonomy: pb.autonomy,
                    stepBudget: pb.stepBudget,
                    environment: pb.environment,
                    schedule
                })
                .then(setPlaybooks)
                .catch(() => undefined)
        },
        []
    )

    // Mail connector: fetch the currently selected Mail message and stage it
    // as context for the next chat message. First use triggers the macOS
    // Automation permission prompt ("wants to control Mail").
    const attachSelectedEmail = useCallback((source: 'mail' | 'outlook' = 'mail') => {
        const bridge = getChatBridge()
        if (!bridge || typeof bridge.readSelectedMail !== 'function' || mailBusy) return
        setMailBusy(true)
        void bridge
            .readSelectedMail(source)
            .then((result) => {
                if (result.ok) {
                    setStagedEmail(result.email)
                    return
                }
                setState((s) =>
                    setError(s, { kind: 'render-failed', message: result.error, recoverable: true })
                )
            })
            .catch((err: unknown) => {
                const message =
                    err instanceof Error ? err.message : 'Could not read the selected email.'
                setState((s) => setError(s, { kind: 'render-failed', message, recoverable: true }))
            })
            .finally(() => setMailBusy(false))
    }, [mailBusy])

    const markComputerUseForCurrentChat = useCallback(() => {
        if (!chatSessionId) return
        setComputerUseSessionIds((previous) => {
            const next = new Set(previous)
            next.add(chatSessionId)
            localStorage.setItem('computer-use-session-ids', JSON.stringify([...next]))
            return next
        })
    }, [chatSessionId])

    const submit = useCallback(async () => {
        if (projectRunning) return
        if (authStatus?.state !== 'signed-in') {
            setState((current) =>
                setError(current, {
                    kind: 'render-failed',
                    message: 'Sign in with GitHub from the lower-left account button before starting a chat.',
                    recoverable: true
                })
            )
            return
        }
        const isPreparingAttachment = staged.some((attachment) => attachment.status === 'processing')
        if (isPreparingAttachment) {
            setState((current) =>
                setError(current, {
                    kind: 'render-failed',
                    message: 'Your video is still being converted into AI-readable frames.',
                    recoverable: true
                })
            )
            return
        }

        const captures = staged.flatMap((attachment) => attachment.captures)
        if (captures.length) {
            setState(current => setError(current, {kind:'render-failed',message:'The local starter model supports text and code, not images or video. Remove visual attachments to continue.',recoverable:true}))
            return
        }
        const hasCaptures = captures.length > 0
        // A staged email counts as content in copilot mode (like attachments).
        const emailStaged = stagedEmail !== null
        // Images, PDFs, and sampled videos can be sent without typed text.
        if (!isSubmittable(draft) && !hasCaptures && !emailStaged) {
            return
        }
        if (checkingAccess.current) return
        checkingAccess.current = true
        try {
            const access = await window.glass.getManagedAccountStatus()
            if (!access.authenticated || access.user?.plan !== 'plus' || access.user.subscription_status !== 'active') {
                setAccessDialogOpen(true)
                return // Keep the draft and attachments intact for after checkout.
            }
        } catch {
            setAccessDialogOpen(true)
            return
        } finally {
            checkingAccess.current = false
        }
        // Fold a staged Mail message into the outgoing text so the model gets
        // the exact email (sender/subject/body) alongside the user's ask.
        const text = emailStaged && stagedEmail ? formatEmailContext(stagedEmail, draft) : draft
        setDraft('')
        if (emailStaged) setStagedEmail(null)

        // Sending ends the utterance: turn the mic off so it isn't left
        // listening after the message goes out. Cancel (rather than stop) so no
        // trailing transcription lands back in the now-cleared field.
        if (dictation.listening) cancelActive()

        const explicitBrowserTask = /\b(open|visit|browse|navigate|search|play|go to)\b/i.test(text) && /\b(browser|youtube|https?|website|google|web|song|music)\b|\b[\w-]+\.(com|org|net|io)\b/i.test(text)
        const workspaceFollowUp = workspaceMode && /^(continue|keep going|fix (it|this|that)|make (it|this|that)|change (it|this|that)|add (it|this|that))\b/i.test(text.trim())
        if ((workspaceFollowUp && !explicitBrowserTask) || isWorkspaceTask(text)) {
            setWorkspaceMode(true)
            setProjectOpen(true)
            setRightPanelOpen(false)
            setInspectorArtifact(null)
            setStaged([])
            void window.workspace.task(text, hasCaptures ? captures : []).catch((error: unknown) => {
                setState(s => setError(s, { kind: 'render-failed', message: String(error), recoverable: true }))
            })
            return
        }

        // Every attachment reaches the provider as one or more image captures.
        // Video captures retain chronological frame metadata for request labels.
        if (hasCaptures) {
            setState((s) => addUserMessage(s, text).state)
            setStaged([])
            const bridge = getChatBridge()
            if (!bridge || typeof bridge.sendCaptures !== 'function') {
                setState((s) =>
                    setError(s, {
                        kind: 'render-failed',
                        message: 'Smart Copilot is not connected yet. Your message was kept.',
                        recoverable: true
                    })
                )
                return
            }
            void bridge.sendCaptures(captures, text).catch((err: unknown) => {
                const message = err instanceof Error ? err.message : 'Failed to send your attachments.'
                setState((s) => setError(s, { kind: 'render-failed', message, recoverable: true }))
            })
            return
        }

        // One chat, automatic capability routing. Commands are handed to the
        // operator internally; questions remain normal model conversation.
        const routed = routeIntent(text, false)
        if (routed.mode === 'operator') {
            setOpEnvironment(routed.environment)
            markComputerUseForCurrentChat()
            beginOperatorGoal(text, routed.environment)
            return
        }

        // Copilot text message.
        setState((s) => addUserMessage(s, text).state)
        const bridge = getChatBridge()
        if (!bridge) {
            setState((s) =>
                setError(s, {
                    kind: 'render-failed',
                    message: 'Smart Copilot is not connected yet. Your message was kept.',
                    recoverable: true
                })
            )
            return
        }
        void bridge.sendMessage(text).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : 'Failed to send your message.'
            setState((s) => setError(s, { kind: 'render-failed', message, recoverable: true }))
        })
    }, [workspaceMode, projectRunning, authStatus, draft, staged, stagedEmail, beginOperatorGoal, dictation, cancelActive, markComputerUseForCurrentChat])

    /** Remove one local attachment before sending. */
    const removeStaged = useCallback((id: string) => {
        setStaged((prev) => prev.filter((attachment) => attachment.id !== id))
    }, [])

    /**
     * Add images, PDFs, and videos to the same composer carousel. PDFs become
     * page images. Videos stay playable locally while a bounded chronological
     * set of JPEG frames is prepared for the vision model.
     */
    const onAddFiles = useCallback((files: FileList | readonly File[] | null) => {
        if (!files) return
        let availableVideoSlots = Math.max(
            0,
            MAX_STAGED_VIDEOS - stagedRef.current.filter((attachment) => attachment.kind === 'video').length
        )
        const stageImage = (dataUrl: string, name: string): void => {
            setStaged((prev) => [
                ...prev,
                {
                    id: `file-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                    kind: 'image',
                    status: 'ready',
                    captures: [{
                        dataUrl,
                        thumbnailUrl: dataUrl,
                        rect: { x: 0, y: 0, width: 0, height: 0 }
                    }],
                    name
                }
            ])
        }

        const stageVideo = (file: File): void => {
            const id = `video-${Date.now()}-${Math.random().toString(36).slice(2)}`
            const previewUrl = URL.createObjectURL(file)
            setStaged((prev) => [
                ...prev,
                {
                    id,
                    kind: 'video',
                    status: 'processing',
                    captures: [],
                    name: file.name,
                    previewUrl
                }
            ])
            void extractVideoFrames(file)
                .then(({ captures, durationSeconds }) => {
                    setStaged((prev) => prev.map((attachment) =>
                        attachment.id === id
                            ? { ...attachment, status: 'ready', captures, durationSeconds }
                            : attachment
                    ))
                })
                .catch((caught: unknown) => {
                    setStaged((prev) => prev.filter((attachment) => attachment.id !== id))
                    const detail = caught instanceof Error ? `: ${caught.message}` : ''
                    setState((current) =>
                        setError(current, {
                            kind: 'render-failed',
                            message: `Could not prepare the video "${file.name}"${detail}`,
                            recoverable: true
                        })
                    )
                })
        }

        for (const file of Array.from(files)) {
            const lowerName = file.name.toLowerCase()
            const isPdf = file.type === 'application/pdf' || lowerName.endsWith('.pdf')
            if (isPdf) {
                void renderPdfToImages(file)
                    .then((pages) => {
                        pages.forEach((dataUrl, index) => {
                            const label = pages.length > 1 ? `${file.name} p${index + 1}` : file.name
                            stageImage(dataUrl, label)
                        })
                    })
                    .catch((caught: unknown) => {
                        const detail = caught instanceof Error ? `: ${caught.message}` : ''
                        setState((current) =>
                            setError(current, {
                                kind: 'render-failed',
                                message: `Could not read the PDF "${file.name}"${detail}`,
                                recoverable: true
                            })
                        )
                    })
                continue
            }

            const isVideo =
                file.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|ogv)$/i.test(lowerName)
            if (isVideo) {
                if (availableVideoSlots <= 0) {
                    setState((current) =>
                        setError(current, {
                            kind: 'render-failed',
                            message: `Attach up to ${MAX_STAGED_VIDEOS} videos at a time so the AI request stays fast and reliable.`,
                            recoverable: true
                        })
                    )
                    continue
                }
                availableVideoSlots -= 1
                stageVideo(file)
                continue
            }

            if (!file.type.startsWith('image/')) continue
            const reader = new FileReader()
            reader.onload = () => {
                const dataUrl = String(reader.result ?? '')
                if (dataUrl) stageImage(dataUrl, file.name)
            }
            reader.onerror = () => {
                setState((current) =>
                    setError(current, {
                        kind: 'render-failed',
                        message: `Could not read the image "${file.name}".`,
                        recoverable: true
                    })
                )
            }
            reader.readAsDataURL(file)
        }
    }, [])

    // Prevent Electron from navigating to dropped files and route supported
    // images, PDFs, and videos through the same local attachment pipeline.
    useEffect(() => {
        const onDragOver = (event: DragEvent): void => {
            if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) event.preventDefault()
        }
        const onDrop = (event: DragEvent): void => {
            const files = event.dataTransfer?.files
            const hasSupportedFile =
                !!files &&
                files.length > 0 &&
                Array.from(files).some((file) =>
                    file.type.startsWith('image/') ||
                    file.type.startsWith('video/') ||
                    file.type === 'application/pdf' ||
                    /\.(pdf|mp4|m4v|mov|webm|ogv)$/i.test(file.name)
                )
            event.preventDefault()
            if (hasSupportedFile) onAddFiles(files!)
        }
        window.addEventListener('dragover', onDragOver)
        window.addEventListener('drop', onDrop)
        return () => {
            window.removeEventListener('dragover', onDragOver)
            window.removeEventListener('drop', onDrop)
        }
    }, [onAddFiles])

    // Approve/decline a pending operator confirmation (Manual/Supervised).
    const decideConfirmation = useCallback((approved: boolean) => {
        setConfirmation((req) => {
            if (req) {
                const op = getOperatorBridge()
                void op?.confirmAction?.({ stepId: req.stepId, approved })
                if (approved) {
                    setOpLoopState('acting')
                    setOpState((s) => setPending(s, true))
                }
            }
            return null
        })
    }, [])

    const onKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
            // While dictating, clearing the field (Backspace/Delete, e.g. after
            // Cmd/Ctrl+A) aborts dictation and turns the mic off.
            if (dictation.listening && (e.key === 'Backspace' || e.key === 'Delete')) {
                e.preventDefault()
                cancelActive()
                return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
            }
        },
        [submit, dictation, cancelActive]
    )

    const refreshHistory = useCallback(() => {
        const bridge = getChatBridge()
        if (bridge && typeof bridge.listSessions === 'function') {
            void bridge
                .listSessions()
                .then((items) => setHistory(items))
                .catch(() => setHistory([]))
        }
    }, [])

    // Operator task history, mapped into the same shape the sidebar renders.
    const refreshOpHistory = useCallback(() => {
        const op = getOperatorBridge()
        if (op && typeof op.listSessions === 'function') {
            void op
                .listSessions()
                .then((items) =>
                    setOpHistory(
                        items.map((it) => ({
                            id: it.id,
                            title:
                                it.goalText && it.goalText.trim().length > 0
                                    ? compactSidebarText(it.goalText, 54)
                                    : 'Untitled task',
                            description:
                                it.status === 'running'
                                    ? 'Working on this task…'
                                    : it.status === 'completed'
                                        ? 'Task completed'
                                        : it.status === 'paused' || it.status === 'awaiting-help'
                                            ? 'Waiting to continue'
                                            : it.status === 'failed' || it.status === 'budget-exhausted'
                                                ? 'Task needs attention'
                                                : it.status === 'stopped'
                                                    ? 'Task stopped'
                                                    : 'Ready to continue',
                            updatedAt: it.updatedAt,
                            turnCount: 0
                        }))
                    )
                )
                .catch(() => setOpHistory([]))
        }
    }, [])

    // Load operator task history whenever operator mode is entered.
    useEffect(() => {
        if (operatorMode) refreshOpHistory()
    }, [operatorMode, refreshOpHistory])

    // Cancel a running operator task WITHOUT clearing the conversation, so the
    // user can change a setting (e.g. Autonomy) and start again. Stops the loop,
    // clears the pending spinner, and dismisses any pending confirmation.
    const onCancelOperator = useCallback(() => {
        const op = getOperatorBridge()
        void op?.stopSession?.().catch(() => undefined)
        setState((s) => setPending(s, false))
        setConfirmation(null)
        setOpLoopState('stopped')
    }, [])

    const onNewSession = useCallback(() => {
        // Leave an open Settings panel so the fresh chat is actually visible,
        // and close the right-hand code panel.
        setShowSettings(false)
        setCodeArtifact(null)
        setInspectorArtifact(null)
        setRightPanelOpen(true)
        lastAutoOpenedTurnRef.current = null
        void getOperatorBridge()?.stopSession?.().catch(() => undefined)
        setOpSteps([])
        setConfirmation(null)
        setOpLoopState('idle')
        setOpActiveProvider(null)
        setOpActiveMode(null)
        setVisionSources([])
        // Operator mode: clear the operator workspace (hide, not delete) and stop
        // any running task so the next goal starts fresh.
        if (operatorMode) {
            const op = getOperatorBridge()
            void op?.stopSession?.().catch(() => undefined)
            setOpState(initialConversationState([]))
            setConfirmation(null)
            setPermissionQueuedGoal(null)
            setShowPermissionOnboarding(false)
            setOpLoopState('idle')
            setDraft('')
            setOpActiveProvider(null)
            setOpActiveMode(null)
            setOpSessionId(null)
            setOpSteps([])
            // Mark the draft so its rail row survives browsing older tasks
            // until a goal consumes it or the user deletes it. Clicking New
            // task again while the draft exists just returns to this same
            // draft — no second one is ever created.
            setOpDraft(true)
            refreshOpHistory()
            if (window.innerWidth <= NAV_OVERLAY_BREAKPOINT) setNavOpen(false)
            return
        }
        const bridge = getChatBridge()
        if (!bridge || typeof bridge.newSession !== 'function') {
            return
        }
        void bridge.newSession().then(() => refreshHistory()).catch(() => undefined)
        setChatSessionId(null)
        setState(initialConversationState([]))
        setDraft('')
        setSummary(null)
            setStaged([])
            setOpSteps([])
            setVisionSources([])
        if (window.innerWidth <= NAV_OVERLAY_BREAKPOINT) setNavOpen(false)
    }, [operatorMode, refreshHistory, refreshOpHistory])

    const onOpenSession = useCallback(
        (id: string) => {
            // Clicking the parked draft returns to the New task workspace
            // (same clearing flow as the New chat button — still one draft).
            if (id === OPERATOR_DRAFT_ID) {
                if (opSessionId !== null) onNewSession()
                return
            }
            // Opening a chat must leave an open Settings panel, otherwise the
            // selected conversation stays hidden behind it.
            setShowSettings(false)
            setCodeArtifact(null)
            setInspectorArtifact(null)
            setRightPanelOpen(true)
            void getOperatorBridge()?.stopSession?.().catch(() => undefined)
            setOpSteps([])
            setConfirmation(null)
            setOpLoopState('idle')
            setVisionSources([])
            // Keep the sidebar open on wide layouts (it's a persistent pane); only
            // auto-close on the narrow/mobile overlay where it covers the chat.
            if (window.innerWidth <= NAV_OVERLAY_BREAKPOINT) setNavOpen(false)

            // The first rail row can be a synthesized view of the live in-memory
            // session, newer than the archived copy with the same id. Selecting it
            // is navigation-only; never ask main to restore the stale archive.
            const activeId = operatorMode ? opSessionId : chatSessionId
            if (id === activeId) return

            if (operatorMode) {
                setOpSessionId(id)
                const op = getOperatorBridge()
                if (op && typeof op.openSession === 'function') {
                    void op
                        .openSession(id)
                        .then((view) => {
                            setOpState(initialConversationState(operatorViewToTurns(view)))
                            setOpSteps(operatorViewToSteps(view))
                        })
                        .catch(() => undefined)
                }
                return
            }
            setChatSessionId(id)
            const bridge = getChatBridge()
            if (bridge && typeof bridge.openSession === 'function') {
                void bridge.openSession(id).then(() => refreshHistory()).catch(() => undefined)
            }
        },
        [operatorMode, opSessionId, chatSessionId, refreshHistory, onNewSession]
    )

    const toggleSettings = useCallback(() => {
        setShowSettings((v) => !v)
        // Settings lives in the rail footer; close the narrow overlay so the
        // panel it opens is immediately visible rather than hidden underneath.
        if (window.innerWidth <= NAV_OVERLAY_BREAKPOINT) setNavOpen(false)
    }, [])

    const onChatContextMenu = useCallback(
        (e: React.MouseEvent, id: string) => {
            e.preventDefault()
            // The ACTIVE draft pill is just the empty workspace — nothing to
            // delete. A PARKED draft row is deletable like any other row.
            if (id === OPERATOR_DRAFT_ID && opSessionId === null) return
            setMenu({ x: e.clientX, y: e.clientY, id })
        },
        [opSessionId]
    )

    const deleteOne = useCallback(
        (id: string) => {
            setMenu(null)
            // The operator draft is renderer state, not a stored session:
            // deleting it just removes its row.
            if (id === OPERATOR_DRAFT_ID) {
                setOpDraft(false)
                return
            }
            // Delete from whichever store owns the active mode: operator tasks go
            // through the operator bridge, copilot chats through the chat bridge.
            const deletingOpen = id === (operatorMode ? opSessionId : chatSessionId)
            if (operatorMode) {
                const op = getOperatorBridge()
                if (!op || typeof op.deleteSessions !== 'function') return
                void op
                    .deleteSessions([id])
                    .then(async () => {
                        if (deletingOpen) {
                            setOpState(initialConversationState([]))
                            setOpActiveProvider(null)
                            setOpActiveMode(null)
                            setOpSessionId(null)
                            setOpSteps([])
                            setPermissionQueuedGoal(null)
                            setShowPermissionOnboarding(false)
                            setOpLoopState('idle')
                            setCodeArtifact(null)
                            lastAutoOpenedTurnRef.current = null
                        }
                        await refreshOpHistory()
                    })
                    .catch((error: unknown) => {
                        const detail = error instanceof Error ? error.message : String(error)
                        setOpState((state) =>
                            setError(state, {
                                kind: 'render-failed',
                                message: `Could not delete operator history: ${detail}`,
                                recoverable: true
                            })
                        )
                    })
                return
            }
            const bridge = getChatBridge()
            if (!bridge || typeof bridge.deleteSessions !== 'function') return
            void bridge
                .deleteSessions([id])
                .then(async () => {
                    if (deletingOpen) {
                        // Main replaces a deleted active chat with a fresh session
                        // and emits it before this invoke resolves. Read that source
                        // of truth as well so this continuation cannot overwrite its
                        // valid id with null if event delivery and promise settlement
                        // happen in the opposite order.
                        const replacement = await bridge.getSession().catch(() => null)
                        if (replacement) {
                            setChatSessionId(replacement.id || null)
                            setState(initialConversationState(replacement.turns ?? []))
                            setSummary(replacement.summary ?? null)
                        }
                        setStaged([])
                        setCodeArtifact(null)
                        lastAutoOpenedTurnRef.current = null
                    }
                    await refreshHistory()
                })
                .catch((error: unknown) => {
                    const detail = error instanceof Error ? error.message : String(error)
                    setState((state) =>
                        setError(state, {
                            kind: 'render-failed',
                            message: `Could not delete chat history: ${detail}`,
                            recoverable: true
                        })
                    )
                })
        },
        [operatorMode, opSessionId, chatSessionId, refreshHistory, refreshOpHistory]
    )

    // The visible conversation + history depend on the active mode. Copilot and
    // operator each keep their own; toggling swaps which one shows. The current
    // in-memory session is synthesized into the rail because disk history lists
    // only archives.
    const conv = operatorMode ? opState : state
    const setConv = operatorMode ? setOpState : setState
    const archivedHistory = operatorMode ? opHistory : history
    const activeSessionId = operatorMode ? opSessionId : chatSessionId
    const latestTurn = conv.turns.at(-1)
    const latestStep = opSteps.at(-1)
    const preparingAttachments = staged.some((attachment) => attachment.status === 'processing')
    const signedIn = authStatus?.state === 'signed-in'
    // The second line is live process status only. Completed/idle chats stay a
    // compact single row and do not reserve space for placeholder copy.
    const currentDescription = conv.pending
        ? operatorMode
            ? compactSidebarText(latestStep?.sub ?? latestStep?.label ?? 'Working on your task…')
            : 'Thinking through your request…'
        : ''
    const hasCurrentContent = conv.turns.length > 0 || conv.pending || (operatorMode && opSteps.length > 0)
    // The active chat is ALWAYS present in the rail: clicking New chat shows a
    // "New chat" pill immediately, which renames itself from the conversation
    // as soon as the first message lands (titleFromTurns).
    const currentItem: SessionListItem | null = activeSessionId
        ? {
            id: activeSessionId,
            title: hasCurrentContent
                ? titleFromTurns(
                    conv.turns,
                    operatorMode ? 'Untitled task' : summary?.inferredIntent ?? 'Untitled chat'
                )
                : operatorMode
                    ? 'New task'
                    : 'New chat',
            description: currentDescription,
            updatedAt:
                latestTurn?.createdAt ??
                archivedHistory.find((item) => item.id === activeSessionId)?.updatedAt ??
                new Date().toISOString(),
            turnCount: conv.turns.length
        }
        : operatorMode
            ? {
                // Operator draft state: tasks only exist once a goal is
                // submitted, so after "New task" there is no session id yet.
                // A navigation-inert pill keeps the rail's promise that the
                // active view is always visible (parity with chat).
                id: OPERATOR_DRAFT_ID,
                title: 'New task',
                description: '',
                updatedAt: new Date().toISOString(),
                turnCount: 0
            }
            : null
    // Strictly newest-first by last activity: opening an old chat does NOT
    // bump it to the top — only actually talking in it does (its latest turn
    // becomes its updatedAt, which floats it up with a fresh "now" stamp).
    const byNewest = (a: SessionListItem, b: SessionListItem): number =>
        (new Date(b.updatedAt).getTime() || 0) - (new Date(a.updatedAt).getTime() || 0)
    // The parked operator draft: the user clicked New task, then went browsing
    // older tasks. Its row stays in the rail (deletable, reopenable) until a
    // goal consumes it — parity with parked empty chats in copilot mode.
    const parkedDraft: SessionListItem | null =
        operatorMode && opDraft && opSessionId !== null
            ? {
                id: OPERATOR_DRAFT_ID,
                title: 'New task',
                description: '',
                updatedAt: new Date().toISOString(),
                turnCount: 0
            }
            : null
    const shownHistory = (
        currentItem
            ? [
                currentItem,
                ...(parkedDraft ? [parkedDraft] : []),
                ...archivedHistory.filter((item) => item.id !== currentItem.id)
            ]
            : [...archivedHistory]
    ).sort(byNewest)

    const operatorEngaged = opSteps.length > 0 || confirmation !== null || isBusyState(opLoopState)
    const sources: EnvironmentSource[] = [
        ...visionSources,
        ...staged.map((attachment) => ({
            id: attachment.id,
            name: attachment.name,
            thumbnailUrl: attachment.captures[0]?.thumbnailUrl,
            detail: attachment.kind === 'video' ? `${attachment.captures.length} sampled frames` : 'Image attachment'
        })),
        ...state.turns.flatMap((turn, turnIndex) => {
            const captures = turn.captures ?? (turn.capture ? [turn.capture] : [])
            return captures.map((capture, captureIndex) => ({
                id: `${turn.id}-source-${captureIndex}`,
                name: `Screenshot ${turnIndex + 1}.${captureIndex + 1}`,
                thumbnailUrl: capture.thumbnailUrl,
                detail: `Attached ${new Date(turn.createdAt).toLocaleString()}`
            }))
        })
    ]

    const openInspector = (artifact: InspectorArtifact): void => {
        setProjectOpen(false)
        setCodeArtifact(null)
        setInspectorArtifact(artifact)
        setRightPanelOpen(true)
    }

    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
                event.preventDefault()
                setNavOpen((open) => !open)
                return
            }
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
                event.preventDefault()
                setTerminalOpen((open) => !open)
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [])

    const environmentVisible = workspaceMode && rightPanelOpen && !projectOpen && !codeArtifact && !inspectorArtifact

    return (
        <CodePanelContext.Provider value={codePanelApi}>
            {accessDialogOpen && <PlusUpgradeModal onClose={() => setAccessDialogOpen(false)} />}
            <div
                className={`glass-app${navOpen ? '' : ' glass-app--navhidden'}${projectOpen || codeArtifact || inspectorArtifact ? ' glass-app--codeopen' : ''}`}
                style={{ '--chat-nav-width': `${navWidth}px` } as React.CSSProperties}
            >
                <div className="glass-upper-workspace">
                    <WorkspaceBar
                        projectWidth={projectOpen || codeArtifact ? panelWidth : undefined}
                        tabHostRef={setProjectTabHost}
                        rightOpen={!!environmentVisible || projectOpen || !!codeArtifact || !!inspectorArtifact}
                        terminalOpen={terminalOpen}
                        onToggleNav={() => setNavOpen((open) => !open)}
                        onToggleRight={() => {
                            if (projectOpen) { setProjectOpen(false); setCodeArtifact(null); return }
                            if (codeArtifact || inspectorArtifact) {
                                setCodeArtifact(null)
                                setInspectorArtifact(null)
                                setRightPanelOpen(true)
                            } else if (workspaceMode) {
                                setRightPanelOpen((open) => !open)
                            } else {
                                setProjectOpen(true)
                            }
                        }}
                        onToggleTerminal={() => setTerminalOpen((open) => !open)}
                    />
                <div
                    className={`glass-workspace${environmentVisible ? ' glass-workspace--environment-open' : ''}`}
                >
                <ChatSidebar
                    items={shownHistory}
                    activeId={currentItem?.id ?? null}
                    running={conv.pending || projectRunning || thinkingIds.length > 0}
                    computerUseSessionIds={computerUseSessionIds}
                    settingsOpen={showSettings}
                    onNewSession={onNewSession}
                    onOpenSession={onOpenSession}
                    onChatContextMenu={onChatContextMenu}
                    onToggleSettings={toggleSettings}
                    onAuthStatusChange={setAuthStatus}
                />

                {navOpen && <div className="glass-nav__scrim" onClick={() => setNavOpen(false)} />}

                {menu && (
                    <>
                        <div className="glass-ctx-backdrop" onClick={() => setMenu(null)} />
                        <div className="glass-ctx" style={{ left: menu.x, top: menu.y }}>
                            <button
                                type="button"
                                className="glass-ctx__item glass-ctx__item--danger"
                                onClick={() => deleteOne(menu.id)}
                            >
                                Delete
                            </button>
                        </div>
                    </>
                )}

                {showVideoRecorder && (
                    <VideoRecorder
                        onRecorded={(file) => onAddFiles([file])}
                        onClose={() => setShowVideoRecorder(false)}
                    />
                )}

                {showPermissionOnboarding && (
                    <PermissionOnboarding
                        permissions={permissions}
                        busyKind={permissionBusyKind}
                        onAllow={requestOperatorPermission}
                        onClose={() => {
                            setShowPermissionOnboarding(false)
                            if (permissionQueuedGoal) {
                                setDraft(permissionQueuedGoal.goal)
                                setOpEnvironment(permissionQueuedGoal.environment)
                                setOpAutonomy(permissionQueuedGoal.autonomy)
                                setOpStepBudget(String(permissionQueuedGoal.stepBudget))
                                setPermissionQueuedGoal(null)
                            }
                        }}
                        onContinue={() => {
                            setShowPermissionOnboarding(false)
                            if (permissionQueuedGoal) {
                                const queued = permissionQueuedGoal
                                setPermissionQueuedGoal(null)
                                void runOperatorGoal(queued.goal, queued.environment, {
                                    autonomy: queued.autonomy,
                                    stepBudget: queued.stepBudget
                                })
                            }
                        }}
                    />
                )}

                <div className="glass-content-column">
                <div className="glass-content-row">
                <div className="glass-main">
                  <div className="glass-main-content">
                    {showSettings ? (
                        <div className="glass-panel">
                            <div className="glass-settings__scroll">
                                <Settings onConfigStatusChange={applyConfigStatus} onBack={() => setShowSettings(false)} />
                            </div>
                        </div>
                    ) : (
                        <div className="glass-conversation" ref={conversationRef} aria-live="polite">
                            {operatorMode &&
                                conv.turns.length === 0 &&
                                opSteps.length === 0 &&
                                (playbooks.length > 0 || draft.trim().length > 0) && (
                                    <div className="glass-playbooks">
                                        <div className="glass-playbooks__head">
                                            <span className="glass-playbooks__title">Playbooks</span>
                                            {draft.trim().length > 0 && (
                                                <button
                                                    type="button"
                                                    className="glass-playbooks__save"
                                                    onClick={saveDraftAsPlaybook}
                                                    title="Save the task in the composer as a reusable playbook"
                                                >
                                                    Save current task
                                                </button>
                                            )}
                                        </div>
                                        {playbooks.map((pb) => (
                                            <div key={pb.id} className="glass-playbook">
                                                <button
                                                    type="button"
                                                    className="glass-playbook__run"
                                                    onClick={() => runPlaybook(pb)}
                                                    title={`Run: ${pb.goal}`}
                                                >
                                                    <span className="glass-playbook__name">{pb.name}</span>
                                                    <span className="glass-playbook__goal">{pb.goal}</span>
                                                </button>
                                                <div className="glass-playbook__schedule">
                                                    <input
                                                        type="time"
                                                        className="glass-playbook__time"
                                                        value={pb.schedule?.timeOfDay ?? ''}
                                                        onChange={(e) => {
                                                            const time = e.target.value
                                                            updatePlaybookSchedule(
                                                                pb,
                                                                time ? { timeOfDay: time, enabled: true } : null
                                                            )
                                                        }}
                                                        aria-label={`Daily run time for ${pb.name}`}
                                                        title="Run daily at this time (while the app is open)"
                                                    />
                                                    <button
                                                        type="button"
                                                        className={`glass-playbook__toggle${pb.schedule?.enabled ? ' glass-playbook__toggle--on' : ''}`}
                                                        onClick={() =>
                                                            updatePlaybookSchedule(
                                                                pb,
                                                                pb.schedule
                                                                    ? {
                                                                        timeOfDay: pb.schedule.timeOfDay,
                                                                        enabled: !pb.schedule.enabled
                                                                    }
                                                                    : { timeOfDay: '09:00', enabled: true }
                                                            )
                                                        }
                                                        aria-label={`${pb.schedule?.enabled ? 'Disable' : 'Enable'} daily schedule for ${pb.name}`}
                                                        title={
                                                            pb.schedule?.enabled
                                                                ? 'Scheduled daily; click to turn off'
                                                                : 'Click to run daily'
                                                        }
                                                    >
                                                        {pb.schedule?.enabled ? 'Daily' : 'Off'}
                                                    </button>
                                                </div>
                                                <button
                                                    type="button"
                                                    className="glass-playbook__delete"
                                                    onClick={() => deletePlaybook(pb.id)}
                                                    aria-label={`Delete playbook ${pb.name}`}
                                                    title="Delete playbook"
                                                >
                                                    ×
                                                </button>
                                            </div>
                                        ))}
                                        {playbooks.length === 0 && (
                                            <div className="glass-playbooks__empty">
                                                Save repeat tasks once, run them with one click.
                                            </div>
                                        )}
                                    </div>
                                )}

                            {conv.turns.map((turn, turnIndex) => (
                                <React.Fragment key={turn.id}>
                                    <div
                                        data-turn-index={turnIndex}
                                        className={[
                                            'glass-row',
                                            turn.role === 'user' ? 'glass-row--user' : 'glass-row--assistant',
                                            turn.status === 'error' ? 'glass-row--error' : ''
                                        ]
                                            .filter(Boolean)
                                            .join(' ')}
                                    >
                                        <div className="glass-bubble">
                                            {turn.captures && turn.captures.length > 0 && (
                                                <div className="glass-shots">
                                                    {turn.captures.map((cap, ci) => (
                                                        <img
                                                            key={ci}
                                                            className="glass-thumb"
                                                            src={cap.thumbnailUrl}
                                                            alt={cap.videoFrame
                                                                ? `Video frame ${cap.videoFrame.index} of ${cap.videoFrame.count}`
                                                                : `Captured screen region ${ci + 1}`}
                                                        />
                                                    ))}
                                                </div>
                                            )}
                                            {turn.capture?.thumbnailUrl && (
                                                <img
                                                    className="glass-thumb"
                                                    src={turn.capture.thumbnailUrl}
                                                    alt="Captured screen region"
                                                />
                                            )}
                                            {turn.text && <TurnBody turn={turn} query={conv.turns.slice(0, turnIndex).reverse().find(item => item.role === 'user')?.text} animate={freshAnswers.includes(turn.id)} />}
                                        </div>
                                    </div>
                                    {/* This question is still thinking: its own
                                    indicator + a Cancel for exactly this one. */}
                                    {!operatorMode && turn.role === 'user' && thinkingIds.includes(turn.id) && (
                                        <div className="glass-row glass-row--assistant">
                                            <div className="glass-pending glass-pending--perquestion" role="status" aria-label={searching ? 'Searching the internet' : 'Thinking about this question'}>
                                                <RollingBall rolling /><span className="glass-pending__label">{searching ? 'Searching the web…' : 'Thinking…'}</span>
                                                <button
                                                    type="button"
                                                    className="glass-pending__cancel"
                                                    onClick={() => cancelThinking(turn.id)}
                                                    title="Stop thinking about this question"
                                                >
                                                    Cancel
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </React.Fragment>
                            ))}

                            {/* Operator progress is grouped into readable phases,
                            but every row still comes from a real engine event. */}
                            {operatorEngaged && (
                                <TaskActivityCard
                                    steps={opSteps}
                                    pending={state.pending || confirmation !== null}
                                    loopState={opLoopState}
                                    environment={opEnvironment}
                                />
                            )}

                            {/* Classic bottom thinking row: only when no per-question
                            row is already visible. */}
                            {conv.pending &&
                                !operatorEngaged &&
                                !conv.turns.some(
                                    (t) => t.role === 'user' && thinkingIds.includes(t.id)
                                ) && (
                                    <div className="glass-row glass-row--assistant">
                                        <div className="glass-pending" role="status" aria-label={searching ? 'Searching the internet' : 'Thinking'}>
                                            <RollingBall rolling /><span className="glass-pending__label">{searching ? 'Searching the web…' : 'Thinking…'}</span>
                                        </div>
                                    </div>
                                )}
                            {confirmation && (
                                <div className="glass-confirm" role="alertdialog" aria-label="Confirm action">
                                    <div className="glass-confirm__title">
                                        {confirmation.highRisk ? 'Confirm high-risk action' : 'Confirm action'}
                                    </div>
                                    <div className="glass-confirm__action">
                                        {describeConfirmationAction(confirmation.action)}
                                    </div>
                                    <div className="glass-confirm__why">
                                        Review this exact action before allowing it to run.
                                    </div>
                                    <div className="glass-confirm__buttons">
                                        <button
                                            type="button"
                                            className="glass-confirm__btn glass-confirm__btn--approve"
                                            onClick={() => decideConfirmation(true)}
                                        >
                                            Approve
                                        </button>
                                        <button
                                            type="button"
                                            className="glass-confirm__btn glass-confirm__btn--decline"
                                            onClick={() => decideConfirmation(false)}
                                        >
                                            Decline
                                        </button>
                                    </div>
                                </div>
                            )}

                            {conv.error && (
                                <div className="glass-error" role="alert">
                                    <span className="glass-error__text">{conv.error.message}</span>
                                    <button
                                        type="button"
                                        className="glass-error__dismiss"
                                        onClick={() => setConv((s) => clearError(s))}
                                        aria-label="Dismiss error"
                                    >
                                        ✕
                                    </button>
                                </div>
                            )}
                        </div>
                    )}

                    {!showSettings && staged.length > 0 && (
                        <div className="glass-carousel" aria-label="Staged attachments">
                            {staged.map((attachment) => {
                                const thumbnail = attachment.captures[0]?.thumbnailUrl
                                return (
                                    <div
                                        className={`glass-shot${attachment.kind === 'video' ? ' glass-shot--video' : ''}`}
                                        key={attachment.id}
                                    >
                                        <button
                                            type="button"
                                            className="glass-shot__remove"
                                            onClick={() => removeStaged(attachment.id)}
                                            aria-label={`Remove ${attachment.name}`}
                                            title="Remove"
                                        >
                                            ×
                                        </button>
                                        <div className="glass-shot__thumb">
                                            {attachment.kind === 'video' && attachment.previewUrl ? (
                                                <video src={attachment.previewUrl} controls preload="metadata" playsInline />
                                            ) : thumbnail ? (
                                                <img src={thumbnail} alt={attachment.name} draggable={false} />
                                            ) : null}
                                            {attachment.status === 'processing' && (
                                                <div className="glass-shot__processing" role="status">
                                                    <span className="glass-spinner" />
                                                    Sampling frames…
                                                </div>
                                            )}
                                        </div>
                                        <div className="glass-shot__name">{finderName(attachment.name)}</div>
                                        {attachment.kind === 'video' && (
                                            <div className="glass-shot__meta">
                                                {attachment.status === 'ready'
                                                    ? `${formatMediaDuration(attachment.durationSeconds ?? 0)} · ${attachment.captures.length} AI frames`
                                                    : 'Preparing for AI'}
                                            </div>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    )}

                    {!showSettings && stagedEmail && (
                        <div className="glass-mailchip" role="status">
                            <span className="glass-mailchip__icon" aria-hidden="true">
                                <MailIcon />
                            </span>
                            <span className="glass-mailchip__text">
                                <span className="glass-mailchip__subject">{stagedEmail.subject}</span>
                                <span className="glass-mailchip__sender">{stagedEmail.sender}</span>
                            </span>
                            <button
                                type="button"
                                className="glass-mailchip__remove"
                                onClick={() => setStagedEmail(null)}
                                aria-label="Remove attached email"
                                title="Remove attached email"
                            >
                                ×
                            </button>
                        </div>
                    )}
                    {!showSettings && (
                        <div className="glass-composer-wrap">
                        <div className={`glass-composer${composerExpanded ? ' glass-composer--expanded' : ''}`}>
                            <div className="glass-composer__top">
                                <div className="glass-composer__text">
                                    <textarea
                                        ref={inputRef}
                                        className="glass-input"
                                        placeholder={
                                            !signedIn
                                                ? 'Sign in with GitHub to start chatting…'
                                                : dictation.listening
                                                ? 'Listening…'
                                                : 'Message Codex Lite…'
                                        }
                                        value={draft}
                                        onChange={(e) => setDraft(e.target.value)}
                                        onKeyDown={onKeyDown}
                                        readOnly={dictation.listening || !signedIn}
                                        disabled={!signedIn}
                                        rows={1}
                                        aria-label="Message Codex Lite"
                                    />
                                </div>
                                {operatorEngaged && (
                                    <div className="glass-composer__status">
                                        <div
                                            className="glass-status-pill"
                                            title="Active model, live. Updates as the fallback chain shifts. API = acting via the page's structure; Vision = reading pixels."
                                        >
                                            <span
                                                className={`glass-status-pill__dot glass-status-pill__dot--${opActiveMode ?? 'idle'}`}
                                            />
                                            <span className="glass-status-pill__text">
                                                {opActiveProvider ? friendlyProvider(opActiveProvider) : 'Auto'}
                                                {opActiveMode ? ` · ${opActiveMode === 'api' ? 'API' : 'Vision'}` : ''}
                                            </span>
                                        </div>
                                        {opState.pending && (
                                            <button
                                                type="button"
                                                className="glass-cancel-pill"
                                                onClick={onCancelOperator}
                                                title="Stop the running task so you can change settings and start again"
                                            >
                                                <StopIcon />
                                                <span>Cancel</span>
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                            <div className="glass-composer__bar">
                                <div className="glass-composer__left">
                                    <div className="glass-attach-wrap">
                                        {showAttachMenu && (
                                            <>
                                                <div
                                                    className="glass-model-backdrop"
                                                    onClick={() => setShowAttachMenu(false)}
                                                />
                                                <div className="glass-model-menu glass-attach-menu" role="menu">
                                                    <button
                                                        type="button"
                                                        className="glass-model-item"
                                                        role="menuitem"
                                                        onClick={() => {
                                                            setShowAttachMenu(false)
                                                            setShowVideoRecorder(true)
                                                        }}
                                                    >
                                                        <span className="glass-model-item__check"><VideoCameraIcon /></span>
                                                        <span className="glass-model-item__text">
                                                            <span className="glass-model-item__name">Camera</span>
                                                        </span>
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="glass-model-item"
                                                        role="menuitem"
                                                        onClick={() => {
                                                            setShowAttachMenu(false)
                                                            addFileRef.current?.click()
                                                        }}
                                                    >
                                                        <span className="glass-model-item__check"><ImageFileIcon /></span>
                                                        <span className="glass-model-item__text">
                                                            <span className="glass-model-item__name">Add files or photos</span>
                                                        </span>
                                                    </button>
                                                    {!operatorMode && (
                                                        <>
                                                            <button
                                                                type="button"
                                                                className="glass-model-item"
                                                                role="menuitem"
                                                                disabled={mailBusy}
                                                                onClick={() => {
                                                                    setShowAttachMenu(false)
                                                                    attachSelectedEmail('mail')
                                                                }}
                                                            >
                                                                <span className="glass-model-item__check"><MailIcon /></span>
                                                                <span className="glass-model-item__text">
                                                                    <span className="glass-model-item__name">Apple Mail</span>
                                                                </span>
                                                            </button>
                                                            <button
                                                                type="button"
                                                                className="glass-model-item"
                                                                role="menuitem"
                                                                disabled={mailBusy}
                                                                onClick={() => {
                                                                    setShowAttachMenu(false)
                                                                    attachSelectedEmail('outlook')
                                                                }}
                                                            >
                                                                <span className="glass-model-item__check"><MailIcon /></span>
                                                                <span className="glass-model-item__text">
                                                                    <span className="glass-model-item__name">Outlook</span>
                                                                </span>
                                                            </button>
                                                        </>
                                                    )}
                                                </div>
                                            </>
                                        )}
                                        <button
                                            type="button"
                                            className="glass-addfile"
                                            onClick={() => setShowAttachMenu((value) => !value)}
                                            disabled={!signedIn}
                                            aria-expanded={showAttachMenu}
                                            aria-haspopup="menu"
                                            aria-label="Attach from camera or files"
                                            title="Attach — camera or files"
                                        >
                                            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M12 4v16M4 12h16" /></svg>
                                        </button>
                                    </div>
                                    <input
                                        ref={addFileRef}
                                        type="file"
                                        accept="image/*,video/*,application/pdf,.pdf,.mp4,.m4v,.mov,.webm,.ogv"
                                        multiple
                                        className="glass-file-input"
                                        onChange={(e) => {
                                            onAddFiles(e.target.files)
                                            e.target.value = ''
                                        }}
                                    />
                                </div>
                                <div className="glass-composer__actions">
                                    {dictation.supported && (
                                        <button
                                            type="button"
                                            className={`glass-voicepill__mic${dictation.listening || dictation.transcribing ? ' glass-voicepill__mic--on' : ''}`}
                                            onClick={dictation.toggle}
                                            disabled={dictation.transcribing || !signedIn}
                                            aria-label={dictation.listening ? 'Stop dictation' : 'Dictate'}
                                            aria-pressed={dictation.listening}
                                            title={
                                                dictation.transcribing
                                                    ? 'Transcribing your speech…'
                                                    : dictation.listening
                                                        ? 'Stop dictation'
                                                        : 'Dictate: speak instead of typing'
                                            }
                                        >
                                            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M6 10v2a6 6 0 0 0 12 0v-2M12 18v3M9 21h6" /></svg>
                                        </button>
                                    )}
                                    {projectRunning && <button type="button" className="glass-send" aria-label="Stop workspace task" title="Stop workspace task (⌘⇧Esc)" onClick={() => void window.workspace.stop()}><StopIcon /></button>}
                                    {signedIn && !projectRunning && (isSubmittable(draft) || staged.length > 0) && (
                                        <button
                                            type="button"
                                            className="glass-send"
                                            onClick={submit}
                                            disabled={preparingAttachments}
                                            aria-label={preparingAttachments ? 'Preparing video frames' : 'Send message'}
                                            title={preparingAttachments ? 'Preparing video frames for the AI…' : 'Send'}
                                        >
                                            <SendIcon />
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                        <LocalAISetup label />
                        </div>
                    )}
                  </div>
                </div>
                <ProjectWorkspace
                        tabHost={projectTabHost}
                        visible={projectOpen || !!codeArtifact}
                        browserObscured={showSettings}
                        artifact={codeArtifact}
                        onClose={() => { setCodeArtifact(null); setProjectOpen(false) }}
                        width={panelWidth}
                        onResize={setCodePanelWidth}
                    />
                {inspectorArtifact && (
                    <InspectorPanel
                        artifact={inspectorArtifact}
                        onClose={() => { setInspectorArtifact(null); setRightPanelOpen(true) }}
                        width={panelWidth}
                        onResize={setCodePanelWidth}
                    />
                )}
                {environmentVisible && (
                    <aside className="environment-sidebar" aria-label="Environment panel">
                        <EnvironmentMenu
                            workspace={taskWorkspaceContext}
                            sources={sources}
                            onOpenChanges={() => {
                                setInspectorArtifact(null)
                                setCodeArtifact({ code: taskWorkspaceContext.diff, language: 'diff', title: 'Review' })
                            }}
                            onOpenDetails={(title, rows) => openInspector({ kind: 'details', title, rows })}
                            onOpenSource={(source) => openInspector({ kind: 'source', title: source.name, imageUrl: source.thumbnailUrl, detail: source.detail })}
                        />
                    </aside>
                )}
                </div>
                {terminalOpen && (
                    <TerminalPanel title={currentItem?.title ?? 'Task terminal'} onClose={() => setTerminalOpen(false)} />
                )}
                </div>
                </div>
                    {navOpen && (
                        <div
                            className="glass-nav-resizer"
                            role="separator"
                            aria-orientation="vertical"
                            aria-label="Resize conversation sidebar"
                            aria-valuemin={230}
                            aria-valuemax={420}
                            aria-valuenow={navWidth}
                            onPointerDown={beginNavResize}
                        />
                    )}
                </div>
            </div>
        </CodePanelContext.Provider>
    )
}
