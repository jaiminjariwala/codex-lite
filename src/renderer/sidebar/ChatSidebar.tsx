import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
    GitHubAuthStatus,
    GitHubDeviceChallenge,
    ManagedAccountStatus,
    SessionListItem
} from '@shared/types'
import { PlusUpgradeModal } from './PlusUpgradeModal'

interface ChatSidebarProps {
    items: SessionListItem[]
    activeId: string | null
    running: boolean
    computerUseSessionIds: ReadonlySet<string>
    settingsOpen: boolean
    onNewSession: () => void
    onOpenSession: (id: string) => void
    onChatContextMenu: (event: React.MouseEvent, id: string) => void
    onToggleSettings: () => void
    onAuthStatusChange?: (status: GitHubAuthStatus) => void
}

/** Compose pencil — the familiar "start something new" glyph. */
function NewChatIcon(): React.JSX.Element {
    return (
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
            <path d="m15 5 4 4" />
        </svg>
    )
}

function BrowserUseIcon(): React.JSX.Element {
    return (
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="14" rx="2.5" />
            <path d="M8 21h8M12 18v3" />
            <path d="m16.5 7 .45 1.05L18 8.5l-1.05.45L16.5 10l-.45-1.05L15 8.5l1.05-.45Z" />
        </svg>
    )
}

function SettingsIcon(): React.JSX.Element {
    return (
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
        </svg>
    )
}

function UsageIcon(): React.JSX.Element {
    return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M4.2 15.7a8.5 8.5 0 1 1 15.6 0" />
            <path d="m12 12 4.3-3.1" />
            <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
        </svg>
    )
}

function LogoutIcon(): React.JSX.Element {
    return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 5H5.8A1.8 1.8 0 0 0 4 6.8v10.4A1.8 1.8 0 0 0 5.8 19H10" />
            <path d="M13 8l4 4-4 4M17 12H8" />
        </svg>
    )
}

function authLabel(status: GitHubAuthStatus | null): { primary: string; secondary: string } {
    if (!status) return { primary: 'GitHub account', secondary: 'Checking sign-in…' }
    if (status.state === 'signed-in') {
        return status.user
            ? {
                primary: status.user.name || `@${status.user.login}`,
                secondary: status.user.name ? `@${status.user.login}` : 'Connected with GitHub'
            }
            : { primary: 'GitHub account', secondary: 'Signed in' }
    }
    if (status.state === 'authorizing') {
        return { primary: 'Finish GitHub sign-in', secondary: status.message ?? 'Waiting for approval…' }
    }
    if (status.state === 'unconfigured') {
        return { primary: 'Log in or sign up', secondary: 'Continue with GitHub' }
    }
    if (status.state === 'error') {
        return { primary: 'Try GitHub sign-in again', secondary: status.message ?? 'Connection failed' }
    }
    return { primary: 'Log in or sign up', secondary: 'Continue with GitHub' }
}

export function ChatSidebar({
    items,
    activeId,
    running,
    computerUseSessionIds,
    settingsOpen,
    onNewSession,
    onOpenSession,
    onChatContextMenu,
    onToggleSettings,
    onAuthStatusChange
}: ChatSidebarProps): React.JSX.Element {
    const [authStatus, setAuthStatus] = useState<GitHubAuthStatus | null>(null)
    const [challenge, setChallenge] = useState<GitHubDeviceChallenge | null>(null)
    const [authBusy, setAuthBusy] = useState(false)
    const [copied, setCopied] = useState(false)
    const [accountMenuOpen, setAccountMenuOpen] = useState(false)
    const [upgradeOpen, setUpgradeOpen] = useState(false)
    const [managedStatus, setManagedStatus] = useState<ManagedAccountStatus | null>(null)
    const accountMenuRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!accountMenuOpen) return
        void window.glass.getManagedAccountStatus().then(setManagedStatus).catch(() => {
            setManagedStatus({ configured: true, authenticated: false, message: 'Usage is temporarily unavailable.' })
        })
        const closeOnOutsideClick = (event: MouseEvent): void => {
            if (!accountMenuRef.current?.contains(event.target as Node)) {
                setAccountMenuOpen(false)
            }
        }
        const closeOnEscape = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') setAccountMenuOpen(false)
        }
        document.addEventListener('mousedown', closeOnOutsideClick)
        document.addEventListener('keydown', closeOnEscape)
        return () => {
            document.removeEventListener('mousedown', closeOnOutsideClick)
            document.removeEventListener('keydown', closeOnEscape)
        }
    }, [accountMenuOpen])

    useEffect(() => {
        let mounted = true
        const apply = (status: GitHubAuthStatus): void => {
            if (!mounted) return
            setAuthStatus(status)
            onAuthStatusChange?.(status)
            if (status.state !== 'authorizing') setChallenge(null)
        }
        void window.glass.getGitHubAuthStatus().then(apply).catch(() => {
            apply({ state: 'error', message: 'GitHub sign-in status is unavailable.' })
        })
        const unsubscribe = window.glass.onGitHubAuthChanged(apply)
        return () => {
            mounted = false
            unsubscribe()
        }
    }, [onAuthStatusChange])

    const beginGitHubLogin = useCallback(() => {
        if (authBusy) return
        setAuthBusy(true)
        setCopied(false)
        void window.glass
            .startGitHubLogin()
            .then((nextChallenge) => {
                setChallenge(nextChallenge)
                if (!nextChallenge.userCode) {
                    setAuthStatus({ state: 'authorizing', message: 'Continue with GitHub in your browser. This app will update automatically.' })
                    return
                }
                // Copy the one-time code up front so the user only has to
                // paste (⌘V) on the GitHub page that just opened.
                void navigator.clipboard
                    .writeText(nextChallenge.userCode)
                    .then(() => {
                        setCopied(true)
                        setAuthStatus({
                            state: 'authorizing',
                            message: 'Code copied — just press ⌘V on the GitHub page to authorize.'
                        })
                    })
                    .catch(() => {
                        setCopied(false)
                        setAuthStatus({
                            state: 'authorizing',
                            message: 'Enter this code in the GitHub page opened in your browser.'
                        })
                    })
            })
            .catch((error: unknown) => {
                // IPC failures read like "Error invoking remote method
                // 'github-auth:start': Error: <reason>" — surface only the reason.
                const raw = error instanceof Error ? error.message : ''
                const reason = raw.split(/Error:\s*/).pop()?.trim() ?? ''
                setAuthStatus({
                    state: 'error',
                    message: reason.length > 0 ? reason : 'GitHub sign-in could not start.'
                })
            })
            .finally(() => setAuthBusy(false))
    }, [authBusy])

    const logout = useCallback(() => {
        setAuthBusy(true)
        void window.glass
            .logoutGitHub()
            .then(() => {
                setChallenge(null)
                setAuthStatus({ state: 'signed-out' })
            })
            .catch((error: unknown) => {
                setAuthStatus({
                    state: 'error',
                    message: error instanceof Error ? error.message : 'GitHub sign-out failed.'
                })
            })
            .finally(() => setAuthBusy(false))
    }, [])

    const copyCode = useCallback(() => {
        if (!challenge) return
        void navigator.clipboard
            .writeText(challenge.userCode)
            .then(() => setCopied(true))
            .catch(() => setCopied(false))
    }, [challenge])

    // Closed the GitHub tab before pasting? Reopen the same verification page
    // for the still-valid code instead of restarting the whole sign-in.
    const reopenGitHub = useCallback(() => {
        void window.glass.openGitHubVerification().catch((error: unknown) => {
            const raw = error instanceof Error ? error.message : ''
            const reason = raw.split(/Error:\s*/).pop()?.trim() ?? ''
            setAuthStatus({
                state: 'error',
                message: reason.length > 0 ? reason : 'Could not reopen the GitHub page.'
            })
        })
    }, [])

    const account = authLabel(authStatus)
    const signedIn = authStatus?.state === 'signed-in'
    const accountInitial = account.primary.trim().charAt(0).toUpperCase() || 'U'
    const managedUsage = managedStatus?.usage
    const isPlus = managedUsage?.plan === 'plus'
    const remainingPercent = managedUsage && managedUsage.limit_units > 0
        ? Math.max(0, Math.round((managedUsage.remaining_units / managedUsage.limit_units) * 100))
        : null

    return (
        <aside className="glass-nav glass-nav--open" aria-label="Conversation sidebar">
            <div className="glass-nav__brand-row">
                <span>Codex Lite</span>
            </div>

            <div className="glass-nav__primary">
                <button
                    type="button"
                    className="glass-nav__new"
                    onClick={signedIn ? onNewSession : beginGitHubLogin}
                    disabled={authBusy || authStatus?.state === 'authorizing'}
                    title={signedIn ? 'Start a new chat' : 'Sign in with GitHub to start a chat'}
                >
                    <NewChatIcon />
                    <span>New chat</span>
                </button>
            </div>

            <div className="glass-nav__list">
                {items.map((item) => {
                    const active = item.id === activeId
                    const isRunning = active && running
                    return (
                        <button
                            type="button"
                            key={item.id}
                            className={`glass-history__item${active ? ' glass-history__item--selected' : ''}${isRunning ? ' glass-history__item--running' : ''}`}
                            onClick={() => onOpenSession(item.id)}
                            onContextMenu={(event) => onChatContextMenu(event, item.id)}
                            aria-current={active ? 'page' : undefined}
                        >
                            <span className="glass-history__text">
                                <span className="glass-history__item-title">{item.title}</span>
                            </span>
                            {computerUseSessionIds.has(item.id) && <span className="glass-history__time">
                                    <span className="glass-history__capability" title="Codex Lite was used in this chat" aria-label="Codex Lite used"><BrowserUseIcon /></span>
                            </span>}
                            {isRunning && (
                                <span className="glass-history__status" role="status" aria-label="Task running">
                                    <span className="glass-history__running-dot" title="Task running" />
                                </span>
                            )}
                        </button>
                    )
                })}
            </div>

            <div className="glass-nav__footer" ref={accountMenuRef}>
                {challenge && authStatus?.state === 'authorizing' && (
                    <div className="glass-account-code" role="status">
                        <span>{challenge.userCode ? 'GitHub code' : 'Waiting for GitHub approval…'}</span>
                        {challenge.userCode && <span className="glass-account-code__value">{challenge.userCode}</span>}
                        {challenge.userCode && <button type="button" onClick={copyCode} title="Copy the GitHub verification code">
                            {copied ? 'Copied' : 'Copy'}
                        </button>}
                        <button type="button" onClick={reopenGitHub} title="Reopen the GitHub authorize page">
                            Reopen
                        </button>
                    </div>
                )}
                {accountMenuOpen && (
                    <div className="glass-account-menu" role="menu" aria-label="Account menu">
                        <div className="glass-account-menu__identity">
                            {authStatus?.user?.avatarUrl ? (
                                <img src={authStatus.user.avatarUrl} alt="" />
                            ) : (
                                <span className="glass-account-menu__avatar" aria-hidden="true">{accountInitial}</span>
                            )}
                            <span>{account.primary}</span>
                        </div>
                        <button
                            type="button"
                            className="glass-account-menu__item glass-account-menu__usage"
                            onClick={() => {
                                setAccountMenuOpen(false)
                                if (isPlus) void window.glass.openBillingPortal()
                                else setUpgradeOpen(true)
                            }}
                        >
                            <span className="glass-account-menu__icon"><UsageIcon /></span>
                            <span>{isPlus ? 'Manage subscription' : 'Upgrade'}</span>
                        </button>
                        <button
                            type="button"
                            className={`glass-account-menu__item${settingsOpen ? ' is-selected' : ''}`}
                            onClick={() => {
                                setAccountMenuOpen(false)
                                onToggleSettings()
                            }}
                        >
                            <span className="glass-account-menu__icon"><SettingsIcon /></span>
                            <span>Settings</span>
                        </button>
                        <button
                            type="button"
                            className="glass-account-menu__item"
                            onClick={() => {
                                setAccountMenuOpen(false)
                                logout()
                            }}
                            disabled={!signedIn || authBusy}
                        >
                            <span className="glass-account-menu__icon"><LogoutIcon /></span>
                            <span>Log out</span>
                        </button>
                    </div>
                )}
                <div className="glass-account">
                    <button
                        type="button"
                        className={`glass-nav__footer-button glass-account__button${accountMenuOpen ? ' is-open' : ''}`}
                        onClick={() => signedIn ? setAccountMenuOpen((open) => !open) : beginGitHubLogin()}
                        disabled={authBusy || authStatus?.state === 'authorizing'}
                        title={authStatus?.message ?? account.primary}
                        aria-expanded={signedIn ? accountMenuOpen : undefined}
                    >
                        <span className="glass-account__avatar">
                            {authStatus?.user?.avatarUrl
                                ? <img src={authStatus.user.avatarUrl} alt="" />
                                : <span aria-hidden="true">{accountInitial}</span>}
                        </span>
                        <span className="glass-nav__footer-copy">
                            <span>{account.primary}</span>
                        </span>
                    </button>
                </div>
            </div>
            {upgradeOpen && <PlusUpgradeModal onClose={() => setUpgradeOpen(false)} />}
        </aside>
    )
}
