import { app, BrowserWindow, ipcMain, globalShortcut, session, nativeImage, desktopCapturer, systemPreferences } from 'electron'
import { join } from 'path'
import { registerDockSettings } from './dock-settings'
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { tmpdir } from 'os'
import { readFile, unlink } from 'fs/promises'
import type { TurnCapture, WorkspaceContext } from '@shared/types'
import {
    registerConfigIpc,
    emitCredentialsRequiredIfMissing,
    HOSTED_FALLBACKS,
    type HostedFallbackId
} from './config'
import { registerGitHubAuthIpc } from './github-auth'
import { ManagedBackendClient } from './managed-backend'
import { LocalAI } from './local-ai'
import { LOCAL_MODEL } from '../shared/local-ai'
import { WorkspaceService } from './workspace'
import { WorkspaceAgent } from './workspace-agent'
import { registerWorkspaceIpc } from './workspace-ipc'
import { EmbeddedBrowser, registerBrowserIpc } from './embedded-browser'
import { EmbeddedBrowserEnvironment } from './embedded-browser-environment'
import { zeroCostChatReply } from './local-chat'
import {
    registerGlassIpc,
    emitError,
    emitPending,
    emitRequestStarted,
    emitRequestSettled,
    emitTurnAppended,
    emitSessionState,
    emitSummary,
    emitCaptureStaged
} from './ipc'
import { HotkeyManager, applyRegistrationResult } from './hotkey'
import { TrayManager } from './tray'
import { SessionManager } from './session'
import { SessionStore } from './session-store'
import { MemoryStore, extractMemoryFact } from './memory-store'
import { readSelectedMail } from './mail-connector'
import { GatewayAIClient } from './ai'
import { ChatFlow } from './chat-flow'
import { Summarizer } from './summarizer'
import { WindowManager } from './windows'
import { checkScreenPermission } from './permissions'
import { CaptureService } from './capture'
import { CaptureOrchestrator } from './capture-orchestrator'
// Merged Codex Lite engine (autonomous computer-use agent). Vendored under
// `./operator` as a self-contained subtree with `op:`-prefixed IPC channels so
// it never collides with Codex Lite's own services.
import { createOperatorServices } from './operator/main/bootstrap/services'
import { createStartGoalHandler } from './operator/main/bootstrap/start-gate-runner'
import { createPlaybookScheduler, type PlaybookScheduler } from './operator/main/scheduler'
import { presentNotification } from './operator/main/notifications'
import { wireOperatorIpc } from './operator/main/bootstrap/ipc-wiring'
import { createEmergencyStopManager, type HotkeyManager as OperatorHotkeyManager } from './operator/main/hotkey'

/**
 * Entry point for the Glass main process.
 *
 * Launches the sidebar BrowserWindow and wires the Config / Credential Store
 * IPC (task 3). The Sidebar/Overlay window managers and remaining services are
 * filled in by their respective tasks.
 */

// Display name shown in the macOS menu bar / Dock (in dev this is otherwise
// "Electron"). The packaged app name comes from electron-builder's productName.
// Keep the legacy data directory so upgrades retain chats, credentials and memory.
app.setPath('userData', join(app.getPath('appData'), 'Computer or Browser Use'))
app.setName('Codex Lite')

let mainWindow: BrowserWindow | null = null
let hotkeyManager: HotkeyManager | null = null
let trayManager: TrayManager | null = null
let windowManager: WindowManager | null = null
// Operator engine long-lived singletons (cleanup on quit).
let operatorHotkey: OperatorHotkeyManager | null = null

function runGit(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd: process.cwd(), maxBuffer: 2_000_000 }, (error, stdout) => {
            if (error) reject(error)
            else resolve(stdout.trimEnd())
        })
    })
}

async function readWorkspaceContext(): Promise<WorkspaceContext> {
    const empty: WorkspaceContext = {
        root: process.cwd(),
        repositoryName: process.cwd().split('/').pop() ?? '',
        isGitRepository: false,
        branch: '',
        additions: 0,
        deletions: 0,
        changedFiles: 0,
        ahead: 0,
        behind: 0,
        lastCommit: '',
        diff: ''
    }
    try {
        const [root, branch, status, numstat, lastCommit, diff] = await Promise.all([
            runGit(['rev-parse', '--show-toplevel']),
            runGit(['branch', '--show-current']),
            runGit(['status', '--porcelain=v1']),
            runGit(['diff', '--numstat', 'HEAD']),
            runGit(['log', '-1', '--pretty=%h · %s']),
            runGit(['diff', '--no-ext-diff', '--unified=3', 'HEAD'])
        ])
        let additions = 0
        let deletions = 0
        for (const line of numstat.split('\n')) {
            const [added, removed] = line.split('\t')
            if (/^\d+$/.test(added ?? '')) additions += Number(added)
            if (/^\d+$/.test(removed ?? '')) deletions += Number(removed)
        }
        let ahead = 0
        let behind = 0
        try {
            const counts = await runGit(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
            const [aheadText, behindText] = counts.trim().split(/\s+/)
            ahead = Number(aheadText) || 0
            behind = Number(behindText) || 0
        } catch {
            // A local branch without an upstream is valid.
        }
        return {
            root,
            repositoryName: root.split('/').pop() ?? '',
            isGitRepository: true,
            branch: branch || 'detached HEAD',
            additions,
            deletions,
            changedFiles: status ? status.split('\n').filter(Boolean).length : 0,
            ahead,
            behind,
            lastCommit,
            diff: diff.slice(0, 1_500_000)
        }
    } catch {
        return empty
    }
}

/**
 * Enforce a single running instance. Codex Lite is a global-hotkey app, so a
 * stray second instance (e.g. left over from a dev restart) would grab the
 * Cmd+Shift+D shortcut and pop up its OWN window when you capture. The lock
 * makes any second launch quit immediately and just focus the window we already
 * have, so a capture always lands in the one live window.
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
    app.quit()
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore()
            mainWindow.show()
            mainWindow.focus()
        }
    })
}
let disposeOperatorIpc: (() => void) | null = null
let disposeOperatorConfigIpc: (() => void) | null = null
let disposeGitHubAuthIpc: (() => void) | null = null
let flushOperatorSessions: (() => Promise<void>) | null = null
let playbookScheduler: PlaybookScheduler | null = null

/**
 * Show and focus the Sidebar_Panel, creating it if necessary. Used by the
 * menu-bar (Tray) fallback when the hotkey could not be registered (Req 1.5).
 */
function showSidebar(): void {
    if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow()
    }
    mainWindow?.show()
    mainWindow?.focus()
}

/**
 * Toggle the Sidebar_Panel: show+focus when hidden, hide when visible
 * (Req 1.2, 1.3). Creates the window on first use so the hotkey works even
 * before the sidebar has been shown.
 */
function toggleSidebar(): void {
    if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow()
        mainWindow?.show()
        mainWindow?.focus()
        return
    }
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
        mainWindow.hide()
    } else {
        mainWindow.show()
        mainWindow.focus()
    }
}

function createWindow(): void {
    // Never create a second sidebar: if one already exists, just reveal it.
    // Without this guard an accidental call would orphan the old window,
    // leaving a stray "extra" Codex Lite window on screen.
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show()
        mainWindow.focus()
        return
    }

    mainWindow = new BrowserWindow({
        // Desktop-first workspace: the ~300px chat rail stays visible beside a
        // useful conversation canvas at launch. Narrow resizing still switches
        // the rail to its responsive overlay behavior.
        width: 1040,
        height: 760,
        minWidth: 680,
        minHeight: 520,
        show: false,
        // Frameless floating panel: removes the native title bar (and its
        // centered title) while keeping the macOS traffic-light buttons.
        frame: false,
        titleBarStyle: 'hidden',
        // Default to a NORMAL window (not pinned on top) so it behaves like any
        // other app window and can sit behind others. The user can pin it on top
        // from the header when they want the floating-panel behavior.
        alwaysOnTop: false,
        fullscreenable: true,
        // Show the app in the macOS Dock like a normal app (skipTaskbar would
        // hide the Dock tile on macOS).
        skipTaskbar: false,
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    })

    mainWindow.on('closed', () => {
        mainWindow = null
    })

    mainWindow.on('ready-to-show', () => {
        mainWindow?.show()
    })

    if (!app.isPackaged) {
        mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
            console.error('Sidebar failed to load', { code, description, url })
        })
        mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
            if (level >= 2) console.error(`Sidebar console (${sourceId}:${line})`, message)
        })
    }

    // electron-vite injects ELECTRON_RENDERER_URL during `dev`.
    const devServerUrl = process.env['ELECTRON_RENDERER_URL']
    if (devServerUrl) {
        void mainWindow.loadURL(`${devServerUrl}/sidebar/index.html`).catch((error) => {
            console.error('Could not open sidebar renderer', error)
        })
    } else {
        void mainWindow.loadFile(join(__dirname, '../renderer/sidebar/index.html')).catch((error) => {
            console.error('Could not open packaged sidebar renderer', error)
        })
    }
}

let stopDockAnimation: (() => void) | undefined
app.whenReady().then(async () => {
    // A second instance never sets anything up; it already asked the primary to
    // focus (see 'second-instance' above) and is quitting.
    if (!gotSingleInstanceLock) return

    // Dock icon: a packaged build gets its icon from the app bundle (set by
    // electron-builder), but `electron-vite dev` runs the stock Electron binary,
    // which shows the default Electron icon in the Dock. Set our custom icon at
    // runtime so the dev build's Dock icon matches the packaged app.
    if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
        const devIconPath = join(process.cwd(), 'build', 'icon-1024.png')
        try {
            app.dock.setIcon(devIconPath)
        } catch {
            // Non-fatal: a missing/unloadable dev icon just leaves the default.
        }
    }

    stopDockAnimation = registerDockSettings(() => mainWindow)
    const trustedWindow = (event: Electron.IpcMainInvokeEvent): BrowserWindow => {
        if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted window request')
        return mainWindow
    }
    ipcMain.handle('window:toggle-maximize', event => {
        const window = trustedWindow(event)
        if (window.isMaximized()) window.unmaximize()
        else window.maximize()
    })
    ipcMain.handle('window:move', (event, dx: number, dy: number) => {
        const window = trustedWindow(event)
        if (![dx, dy].every(value => Number.isFinite(value) && Math.abs(value) <= 1000) || window.isMaximized() || window.isFullScreen()) return
        const [x, y] = window.getPosition()
        window.setPosition(Math.round(x + dx), Math.round(y + dy))
    })

    // Allow camera/microphone and clipboard WRITES only for the trusted
    // sidebar renderer. Dictation requests audio; the local video recorder
    // requests video and, when available, audio; GitHub sign-in copies the
    // one-time device code. Clipboard READS and every other permission and
    // renderer are denied.
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        const trustedSidebar = mainWindow !== null && webContents === mainWindow.webContents
        const allowed = permission === 'media' || permission === 'clipboard-sanitized-write'
        callback(allowed && trustedSidebar)
    })

    // Config / Credential Store IPC + prompt when credentials are missing.
    // `onSaved` re-seeds the operator provider chain from the just-saved keys so
    // adding a key in Settings makes the operator usable at once (no restart).
    // Assigned a no-op until the operator services exist; replaced below.
    let seedOperatorProviders: () => Promise<void> = async () => { }
    const configStore = registerConfigIpc({
        getSidebarWindow: () => mainWindow,
        onSaved: () => seedOperatorProviders()
    })

    // GitHub uses OAuth Device Flow in the privileged main process. The public
    // client id is build/runtime configuration; no client secret is bundled,
    // and the encrypted access token never crosses the preload boundary.
    let managedBackend: ManagedBackendClient | null = null
    const githubAuth = registerGitHubAuthIpc({
        getSidebarWindow: () => mainWindow,
        onLogout: () => managedBackend?.clearSession()
    })
    disposeGitHubAuthIpc = githubAuth.dispose
    managedBackend = new ManagedBackendClient({
        getGitHubToken: () => githubAuth.service.getAccessToken()
    })

    // Persistent session store: writes the active session to
    // `userData/sessions/current.json` after each change and loads it on launch
    // (Req 9.2, 9.3). Kept separate from the manager so disk I/O never collides
    // with concurrent in-memory edits; writes are coalesced/serialized inside.
    const sessionStore = new SessionStore()
    // Persistent user memory: explicit "remember ..." facts, local JSON under
    // userData, listed/deletable in Settings, folded into chat requests.
    const memoryStore = new MemoryStore({ userDataDir: app.getPath('userData') })

    // Session Manager: in-memory source of truth for the active conversation.
    // The `onTurnAppended` hook drives the Summarizer (wired below); it is
    // referenced lazily so the manager can be constructed before the client.
    // The `onSessionChanged` hook persists the active session after every
    // mutation (append/new/restore) so it survives a restart (Req 9.2). The
    // fire-and-forget save is safe because the store serializes writes.
    let summarizer: Summarizer | null = null
    const sessionManager = new SessionManager({
        hooks: {
            onTurnAppended: (turn, session) => summarizer?.onTurnAppended(turn, session),
            onSessionChanged: (session) => {
                void sessionStore.save(session)
                // Push the running goal/step summary to the tracker UI.
                emitSummary(mainWindow, session.summary)
            }
        }
    })

    // Restore the most recent session before the sidebar requests it via
    // `session:get`, so the prior conversation is rendered on launch (Req 9.3).
    // A missing/corrupt file yields null and the fresh empty session is kept.
    const restored = await sessionStore.load()
    if (restored) {
        sessionManager.restore(restored)
    }

    // AI Gateway client, backed by the Config / Credential Store so settings
    // changes take effect on the next request (Req 7.2).
    const localAI = new LocalAI(app.getPath('userData'))
    app.on('before-quit', () => localAI.dispose())
    for (const action of ['status', 'start', 'pause'] as const) {
        ipcMain.handle(`local-ai:${action}`, async (event) => {
            if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Untrusted local AI request')
            if (action === 'start') void localAI.start(true)
            if (action === 'pause') await localAI.pause()
            return localAI.status()
        })
    }
    ipcMain.handle('local-ai:prepare', (event) => {
        if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Untrusted local AI request')
        void localAI.start()
        return localAI.status()
    })
    const aiClient = new GatewayAIClient({
        textOnly: true,
        getVisionProvider: () => localAI.provider(true),
        // The newer installed Qwen3 model also handles text-only research synthesis.
        // CODEX_SEARCH_MODEL overrides the synthesis model when set (e.g. to a
        // larger pulled model such as qwen2.5:7b for better answer quality).
        // The model must already be pulled into the app's private Ollama.
        getSearchProvider: async () => {
            const override = process.env.CODEX_SEARCH_MODEL?.trim()
            if (override) {
                const base = await localAI.provider().catch(() => null)
                if (base) return { ...base, model: override }
            }
            return localAI.provider(true).catch(() => localAI.provider())
        },
        // Signed-in release users reach the publisher-managed service first;
        // no provider key crosses into the app. Developer-owned local keys
        // remain available as an explicit fallback during backend development.
        getManagedProvider: () => {
            return localAI.provider()
        },
        getConfig: () => configStore.readConfig(),
        getApiKey: () => configStore.getApiKey(),
        // Built-in free hosted providers (OpenRouter -> Gemini), tried after
        // the user's own (corporate/personal) gateway.
        getFallbackProviders: async () => [],
        // Automatic memory: durable user facts the summarize pass extracts
        // land in the same auditable store as explicit "remember ..." writes.
        onUserFacts: (facts) => {
            for (const fact of facts) void memoryStore.add(fact)
        }
    })

    // Summarizer: folds older turns into the running summary once the unfolded
    // backlog crosses the threshold, keeping each request bounded (Req 6). The
    // threshold is lowered to 5 so the goal/step tracker populates earlier in a
    // session rather than only after a long backlog accumulates.
    summarizer = new Summarizer({ client: aiClient, store: sessionManager, threshold: 5 })

    // Route an assistant answer to the chat it was ASKED in (its origin), even
    // if the user has since switched or created a new chat. When the origin is
    // still the active session the turn appends + emits live; otherwise the
    // answer is written to the origin's archived copy on disk so it is there
    // when the user reopens that chat. Pending is cleared for the active session
    // only (a background chat has no live spinner to clear).
    const deliverAssistant = async (sessionId: string, text: string): Promise<void> => {
        const active = sessionManager.getSession()
        if (!sessionId || active.id === sessionId) {
            const turn = sessionManager.appendAssistantText(text)
            emitTurnAppended(mainWindow, turn)
            // Pending is owned by ChatFlow's request tracker: it clears only
            // once NO question is still in flight, so a second concurrent
            // question keeps its thinking state when the first one answers.
            return
        }
        await appendToArchived(sessionId, text, 'ok')
    }

    // Deliver a failure to the origin chat. Active origin -> surface the error
    // banner + clear pending; a background origin gets a persisted error turn so
    // the user sees "could not answer" when they return to that chat.
    const deliverErrorTurn = async (sessionId: string, message: string): Promise<void> => {
        const active = sessionManager.getSession()
        if (!sessionId || active.id === sessionId) {
            emitError(mainWindow, { kind: 'render-failed', message, recoverable: true })
            return
        }
        await appendToArchived(sessionId, message, 'error')
    }

    // Append an assistant turn to an archived (on-disk) session that is no
    // longer the active conversation. Best-effort: a missing/corrupt archive is
    // skipped rather than throwing, since the request already left that chat.
    const appendToArchived = async (
        sessionId: string,
        text: string,
        status: 'ok' | 'error'
    ): Promise<void> => {
        const stored = await sessionStore.readSessionById(sessionId)
        if (!stored) return
        const createdAt = new Date().toISOString()
        stored.turns.push({
            id: randomUUID(),
            role: 'assistant',
            text,
            createdAt,
            status
        })
        stored.updatedAt = createdAt
        await sessionStore.archive(stored)
    }

    // Flow A orchestrator: append+emit user turn, call the gateway, append+emit
    // the assistant turn, and toggle pending around the request (design "Flow A").
    const chatFlow = new ChatFlow({
        // Wrap the manager with the origin-routing seams so a slow answer lands
        // in the chat it was asked in, not whatever chat is active on arrival.
        session: {
            appendUserText: (t) => sessionManager.appendUserText(t),
            appendUserCapture: (c, t) => sessionManager.appendUserCapture(c, t),
            appendUserCaptures: (c, t) => sessionManager.appendUserCaptures(c, t),
            appendAssistantText: (t, s) => sessionManager.appendAssistantText(t, s),
            buildContext: (c) => sessionManager.buildContext(c),
            activeSessionId: () => sessionManager.getSession().id,
            deliverAssistant
        },
        // Persistent memory: explicitly saved facts ride along on every
        // request, and "remember ..." messages write deterministically.
        memories: {
            list: () => memoryStore.texts(),
            captureFromMessage: async (text) => {
                const fact = extractMemoryFact(text)
                if (fact) await memoryStore.add(fact)
            }
        },
        ai: aiClient,
        localResponder: zeroCostChatReply,
        emitters: {
            turnAppended: (turn) => emitTurnAppended(mainWindow, turn),
            pending: (pending) => emitPending(mainWindow, pending),
            error: (error) => emitError(mainWindow, error),
            credentialsRequired: () =>
                mainWindow?.webContents.send('credentials:required'),
            // Every provider failed. Two very different reasons, two outcomes:
            //  - Nothing is configured at all (fresh install): show the in-chat
            //    setup card so the user can paste a free key right there.
            //  - Keys exist but nothing answered (outage / bad key): drop a
            //    short error turn into the origin chat.
            providersExhausted: (_ctx, originId, requestId) => {
                void (async () => {
                    if (chatFlow.wasCancelled(requestId)) return
                    const status = await configStore.getStatus()
                    const anyProviderConfigured =
                        status.hasCredentials || status.hasOpenrouter || status.hasGemini
                    if (!anyProviderConfigured) {
                        await deliverErrorTurn(
                            originId,
                            'The managed AI service is not connected in this development build yet. Your GitHub sign-in is separate from model access; connect the app backend before asking a model question.'
                        )
                    } else {
                        await deliverErrorTurn(
                            originId,
                            'The selected AI provider could not answer. Check its connection in Settings and try again.'
                        )
                    }
                    chatFlow.settleRequest(requestId)
                })()
            },
            // Per-question thinking state so the sidebar can show (and cancel)
            // each in-flight question independently.
            requestStarted: (requestId) => emitRequestStarted(mainWindow, requestId),
            requestSettled: (requestId) => emitRequestSettled(mainWindow, requestId)
        }
    })

    // Window Manager owns the on-demand transparent Overlay_Window used for
    // region capture (task 8.1). The sidebar window remains managed directly
    // above; the manager is used here for the overlay lifecycle.
    windowManager = new WindowManager()

    // Capture Service: captures the active display and crops it to the selected
    // rectangle, producing a base64 PNG + thumbnail (task 8.2). The send-to-
    // gateway half of Flow B lands in task 8.3.
    const captureService = new CaptureService()

    // Capture orchestrator: stitches the permission gate, overlay, Capture
    // Service, and ChatFlow into the three capture IPC handlers (Flow B). Kept
    // in its own Electron-free module so the pipeline is testable end-to-end
    // (task 8.4) through the real production logic.
    const captureOrchestrator = new CaptureOrchestrator({
        checkPermission: (options) => checkScreenPermission(options),
        captureService,
        overlay: windowManager,
        // No follow-up typed during capture -> park the shot in the carousel
        // above the input so the user can add more or type later.
        stageCapture: (capture) => emitCaptureStaged(mainWindow, capture),
        // Follow-up typed during capture -> send screenshot + text to the chat
        // and run the AI immediately (the fast capture-and-ask path).
        chatFlow,
        emitError: (error) => emitError(mainWindow, error)
    })

    // Capture via macOS's NATIVE `screencapture` tool, then stage the shot in the
    // carousel above the input. Bound to the app's own shortcuts (below), so a
    // screenshot only lands in this app when the user presses OUR shortcut —
    // their normal macOS screenshots go wherever they intend. Writing to a temp
    // file (not the clipboard) makes a user cancel unambiguous (no file) and
    // never disturbs the clipboard.
    //   - 'region' -> `-i` interactive crosshair selection (Space toggles window)
    //   - 'window' -> `-iW` interactive window pick (the toolbar-style option)
    //   - 'full'   -> whole main display
    const captureViaMacScreenshot = async (
        mode: 'region' | 'window' | 'full' = 'region'
    ): Promise<void> => {
        const tmpPath = join(tmpdir(), `capture-${randomUUID()}.png`)
        const args =
            mode === 'full'
                ? ['-m', tmpPath]
                : mode === 'window'
                    ? ['-iW', tmpPath]
                    : ['-i', tmpPath]
        await new Promise<void>((resolve) => {
            execFile('screencapture', args, () => resolve())
        })
        let buf: Buffer
        try {
            buf = await readFile(tmpPath)
        } catch {
            return // Cancelled: no file was written.
        }
        await unlink(tmpPath).catch(() => undefined)
        if (buf.length === 0) return
        const image = nativeImage.createFromBuffer(buf)
        if (image.isEmpty()) return
        const size = image.getSize()
        const thumb = image.resize({ width: Math.min(size.width, 320) })
        const capture: TurnCapture = {
            dataUrl: image.toDataURL(),
            thumbnailUrl: thumb.toDataURL(),
            rect: { x: 0, y: 0, width: size.width, height: size.height }
        }
        emitCaptureStaged(mainWindow, capture)
        showSidebar()
    }

    // Chat / capture / session IPC. The type-a-message flow is now wired to the
    // Session Manager + AI client via ChatFlow (Flow A); `session:get` returns
    // the active in-memory session so the sidebar can render it (Req 9.3).
    //
    // `capture:trigger` checks Screen_Recording_Permission FIRST: when granted
    // it shows the full-screen overlay (Req 4.1); otherwise it skips the overlay
    // and surfaces System Settings instructions via `error:show` (Req 8.1). The
    // overlay closes on a completed selection or cancel (Req 4.3, 4.4); the
    // crop + Flow B wiring lands in tasks 8.2 / 8.3.
    const requireSignedIn = async (): Promise<void> => {
        const status = await githubAuth.service.getStatus()
        if (status.state !== 'signed-in') {
            throw new Error('Sign in with GitHub before starting a chat.')
        }
        await managedBackend!.requireAccess()
    }
    const projectFiles = new WorkspaceService(app.getPath('userData'))
    await projectFiles.init()
    const workspaceAgent = new WorkspaceAgent(projectFiles,
        (ctx, prompt, signal) => aiClient.complete(ctx, prompt, signal),
        event => mainWindow?.webContents.send('project:activity', event),
        async name => {
            if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') throw new Error('Allow Screen Recording in macOS settings to inspect the app window.')
            const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1600, height: 1000 } })
            const source = sources.find(value => value.name.toLowerCase().includes(name.toLowerCase()))
            if (!source || source.thumbnail.isEmpty()) throw new Error(`No visible ${name} window was found. Open the design or attach a screenshot.`)
            const size = source.thumbnail.getSize()
            return { dataUrl: source.thumbnail.toDataURL(), thumbnailUrl: source.thumbnail.resize({ width: 240 }).toDataURL(), rect: { x: 0, y: 0, ...size } }
        })
    registerWorkspaceIpc(projectFiles, workspaceAgent, {
        window: () => mainWindow,
        authenticate: requireSignedIn,
        task: async (text, captures) => {
            const origin = sessionManager.getSession().id
            const previous = sessionManager.buildContext()
            const turn = captures.length ? sessionManager.appendUserCaptures(captures, text) : sessionManager.appendUserText(text)
            emitTurnAppended(mainWindow, turn)
            const answer = await workspaceAgent.start(text, captures, previous)
            await deliverAssistant(origin, answer)
        }
    })
    app.on('before-quit', () => workspaceAgent.stop())
    registerGlassIpc({
        getSidebarWindow: () => mainWindow,
        onSendMessage: async (text) => {
            await requireSignedIn()
            await chatFlow.handleSendMessage(text)
        },
        // Operator work belongs to the same chat timeline. Record the user
        // message in the normal SessionManager without asking the chat model
        // to answer it; the renderer already shows the submitted bubble.
        onRecordTaskMessage: async (text) => {
            await requireSignedIn()
            sessionManager.appendUserText(text)
        },
        onSendCaptures: async (captures, text) => {
            await requireSignedIn()
            await chatFlow.handleCaptures(captures, text)
        },
        getSession: () => sessionManager.getSessionView(),
        onTriggerCapture: () => {
            void captureViaMacScreenshot('region')
        },
        onSubmitRegion: async (rect, text) => {
            await requireSignedIn()
            // The user captured a region (incl. an optional follow-up question),
            // so surface the chat to show the incoming guidance.
            showSidebar()
            await captureOrchestrator.handleSubmitRegion(rect, text)
        },
        onCancelRegion: () => {
            captureOrchestrator.handleCancel()
        },
        // New Session (Req 9.1). The rail contract:
        //  1. New chat parks the outgoing conversation and shows a fresh empty
        //     chat at the top of the rail.
        //  2. New chat is IDEMPOTENT: if the open chat is already empty it IS
        //     the new chat — never stack a second one.
        //  3. If an empty chat was parked earlier (the user created one, then
        //     navigated to an older chat), New chat REOPENS that parked empty
        //     chat instead of minting another.
        // Every archive is awaited: the renderer refreshes its list the moment
        // this IPC call resolves, and a fire-and-forget write intermittently
        // lost the race and dropped rows from the rail.
        onNewSession: async () => {
            const current = sessionManager.getSession()
            if (current.turns.length === 0) {
                emitSessionState(mainWindow, sessionManager.getSessionView())
                return
            }
            await sessionStore.archive(current)
            const items = await sessionStore.listSessions()
            const parkedEmpty = items.find((item) => item.turnCount === 0)
            const stored = parkedEmpty
                ? await sessionStore.readSessionById(parkedEmpty.id)
                : null
            if (stored) {
                sessionManager.restore(stored)
            } else {
                sessionManager.newSession()
            }
            emitSessionState(mainWindow, sessionManager.getSessionView())
        },
        // Chat history: list past sessions and reopen one. Opening archives the
        // current conversation first (only if it has content, to avoid empty
        // archives), then restores the chosen session as the active one and
        // pushes it to the sidebar so the view updates.
        onListSessions: () => sessionStore.listSessions(),
        // Persistent memory audit surface (Settings): list / add / delete / clear.
        onListMemories: () => memoryStore.list(),
        onAddMemory: (text) => memoryStore.add(text),
        onDeleteMemory: (id) => memoryStore.delete(id),
        onClearMemories: () => memoryStore.clear(),
        // Email connector: read the selected Mail/Outlook message on demand.
        onReadSelectedMail: (source) => readSelectedMail(source),
        getWorkspaceContext: () => readWorkspaceContext(),
        onRunTerminalCommand: command => projectFiles.run(command),
        getManagedAccountStatus: () => managedBackend!.status(),
        onStartPlusCheckout: () => managedBackend!.createCheckout(),
        onOpenBillingPortal: () => managedBackend!.openBillingPortal(),
        onOpenSession: async (id) => {
            const current = sessionManager.getSession()
            // The renderer synthesizes the current in-memory session alongside
            // archives. Its disk copy can be older, so selecting the live id is
            // a no-op rather than a restore from stale persisted history.
            if (current.id === id) return
            const chosen = await sessionStore.readSessionById(id)
            if (!chosen) return
            // Archive the outgoing chat even when EMPTY: an open "New chat"
            // must stay in the rail until the user deletes it, and it reopens
            // through this same path (it lists as a normal turnCount-0 row).
            await sessionStore.archive(current)
            sessionManager.restore(chosen)
            emitSessionState(mainWindow, sessionManager.getSessionView())
        },
        onDeleteSessions: async (ids) => {
            await sessionStore.deleteSessions(ids)
            // If the chat currently open in the view was deleted, reset to a
            // fresh empty session and push it so the chat area clears at once
            // (otherwise the deleted conversation lingers until New is clicked).
            // `newSession()` does NOT archive, so the just-deleted chat is not
            // recreated.
            const active = sessionManager.getSession()
            if (active && ids.includes(active.id)) {
                sessionManager.newSession()
                emitSessionState(mainWindow, sessionManager.getSessionView())
            }
        },
        onListModels: () => aiClient.listModels().catch(() => []),
        onTranscribe: (audioBase64, format) =>
            aiClient.transcribe(audioBase64, format).catch(() => ''),
        // The renderer's local fallback model answered (or reported failure).
        // Route the result to the ORIGIN chat (via `originId`): a live answer if
        // that chat is still active, otherwise a persisted turn so it shows on
        // reopen. Handles pending/error itself through the deliver helpers.
        onCancelRequest: (requestId) => chatFlow.cancelRequest(requestId)
    })

    createWindow()

    // App-owned capture shortcuts: a screenshot lands in this app ONLY when the
    // user presses one of OUR shortcuts, so their ordinary macOS screenshots
    // (for other apps) are never hijacked. Each runs the native `screencapture`
    // tool and stages the result above the input.
    //   ⌘⇧D — region (crosshair)   ⌘⇧F — window (toolbar-style pick)   ⌘⇧S — full
    globalShortcut.register('CommandOrControl+Shift+D', () => {
        void captureViaMacScreenshot('region')
    })
    globalShortcut.register('CommandOrControl+Shift+F', () => {
        void captureViaMacScreenshot('window')
    })
    globalShortcut.register('CommandOrControl+Shift+S', () => {
        void captureViaMacScreenshot('full')
    })

    // Register the Global_Hotkey so the user can summon Glass from any app
    // (Req 1.1, 1.6). Inspect the result and drive the conflict/failure
    // fallback (task 6.2): a conflict surfaces a "choose a different shortcut"
    // error (Req 1.4); any other failure surfaces a message and brings up the
    // menu-bar (Tray) icon that can open the sidebar (Req 1.5).
    trayManager = new TrayManager({ showSidebar })
    hotkeyManager = new HotkeyManager({ toggleSidebar })
    applyRegistrationResult(hotkeyManager.register(), {
        emitError: (error) => emitError(mainWindow, error),
        showTray: () => trayManager?.show()
    })

    // Let the user pick a different accelerator after a conflict (Req 1.4).
    // The renderer invokes this with the chosen accelerator; the result is run
    // back through the same fallback so a still-conflicting choice re-prompts.
    ipcMain.handle('hotkey:reregister', (_event, accelerator: string): boolean => {
        if (!hotkeyManager || typeof accelerator !== 'string' || accelerator.length === 0) {
            return false
        }
        const result = hotkeyManager.reRegister(accelerator)
        applyRegistrationResult(result, {
            emitError: (error) => emitError(mainWindow, error),
            showTray: () => trayManager?.show()
        })
        return result.success
    })

    mainWindow?.webContents.once('did-finish-load', () => {
        void emitCredentialsRequiredIfMissing(configStore, mainWindow)
    })

    // -----------------------------------------------------------------------
    // Merged Codex Lite engine
    // -----------------------------------------------------------------------
    // Construct + wire the autonomous operator engine. Every main -> renderer
    // operator event targets the existing Sidebar window (getHostWindow), so
    // the operator's live activity renders inside the Codex Lite chat rather
    // than a separate Console_Window. The engine owns its own (isolated)
    // provider config + session store and drives the Control_Indicator overlay
    // and the sandboxed-desktop noVNC view through its own Window Manager.
    const embeddedBrowser = new EmbeddedBrowser(() => mainWindow)
    registerBrowserIpc(embeddedBrowser, () => mainWindow)
    const embeddedEnvironment = new EmbeddedBrowserEnvironment(embeddedBrowser)
    const operatorServices = createOperatorServices({ getHostWindow: () => mainWindow, browserEnvironment: embeddedEnvironment, onBrowserStop: () => embeddedEnvironment.cancel() })
    app.on('before-quit', () => embeddedBrowser.dispose())
    const startOperatorGoal = createStartGoalHandler(operatorServices)
    const handleStartGoal: typeof startOperatorGoal = async input => {
        await requireSignedIn()
        throw new Error('Visual computer/browser automation needs a vision model. The local starter model currently supports text and code only.')
    }
    const operatorIpc = wireOperatorIpc(operatorServices, handleStartGoal)
    disposeOperatorIpc = operatorIpc.disposeOperatorIpc
    disposeOperatorConfigIpc = operatorIpc.disposeConfigIpc
    flushOperatorSessions = () => operatorServices.sessions.flush()

    // Playbook scheduler: daily-at-HH:MM runs while the app is open. Runs go
    // through the SAME start-gate as a user click (safety gate, budgets,
    // confirmations all apply), and the task-1 notifier covers their
    // completion/failure/help banners. `lastRunDate` stamps only on a real
    // start, so busy/rejected runs retry on later ticks the same day.
    const busyStates = new Set(['perceiving', 'reasoning', 'awaiting-confirmation', 'acting', 'paused', 'awaiting-help'])
    playbookScheduler = createPlaybookScheduler({
        store: operatorServices.playbooks,
        isBusy: () => busyStates.has(operatorServices.loop.getState()),
        runPlaybook: async (pb) => {
            const result = await handleStartGoal({
                goal: pb.goal,
                autonomy: pb.autonomy,
                stepBudget: pb.stepBudget,
                environment: pb.environment
            })
            return result.ok
        },
        onStarted: (pb) => {
            presentNotification({
                title: 'Scheduled task started',
                body: pb.name
            })
        }
    })
    playbookScheduler.start()

    // Seed the operator's (isolated) provider chain from Codex Lite's stored
    // credentials, so the operator runs on whatever the user already configured
    // with no separate operator setup. Re-seeded every launch. The chain is the
    // user's primary OpenAI-compatible provider, then the same free hosted
    // providers the copilot uses (Gemini / OpenRouter), tried in order.
    // Defined as a function so it runs both now (launch) and after every
    // `config:save` (via the `onSaved` hook above), keeping the operator in sync
    // with keys the user adds while the app is running.
    seedOperatorProviders = async (): Promise<void> => {
        await operatorServices.configStore.saveProviders({
            chain: { providerIds: ['local-ollama'] },
            providers: [{id:'local-ollama',kind:'local',baseURL:'http://127.0.0.1:11435/v1',
                model:LOCAL_MODEL,requiresKey:false}]
        })
    }
    await seedOperatorProviders()

    // Restore the most recent operator task for review (acting stays gated
    // behind an explicit start, Req 18.3).
    const restoredOperator = await operatorServices.sessions.load()
    if (restoredOperator) {
        operatorServices.sessionManager.restore(restoredOperator)
    }

    // Emergency_Stop hotkey (⌘⇧Esc). Registering through the Safety Controller
    // records the result; a failed registration blocks starting an operator
    // task while the on-screen fallback stays available (Req 7.7, 7.8).
    operatorHotkey = createEmergencyStopManager({ onEmergencyStop: () => {
        workspaceAgent.stop()
        embeddedEnvironment.cancel()
        operatorServices.safety.onEmergencyStop()
    } })
    operatorServices.safety.registerHotkey(operatorHotkey)

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow()
        }
    })
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

// Release the Global_Hotkey on quit so the OS-level binding is cleared.
app.on('will-quit', () => {
    stopDockAnimation?.()
    hotkeyManager?.unregister()
    trayManager?.destroy()
    windowManager?.stopPencilFollow()
    // Operator engine teardown.
    operatorHotkey?.unregister()
    playbookScheduler?.stop()
    disposeOperatorIpc?.()
    disposeOperatorConfigIpc?.()
    disposeGitHubAuthIpc?.()
    void flushOperatorSessions?.()
})
