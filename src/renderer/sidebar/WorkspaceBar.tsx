import React, { useEffect, useRef, useState } from 'react'
import { getTheme, setTheme } from './theme'

function PanelIcon({ side }: { side: 'left' | 'right' | 'bottom' }): React.JSX.Element {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="3" />
            {side === 'left' && <path d="M9 4v16" />}
            {side === 'right' && <path d="M15 4v16" />}
            {side === 'bottom' && <path d="M3 14h18" />}
        </svg>
    )
}

export function WorkspaceBar({
    rightOpen,
    terminalOpen,
    onToggleNav,
    onToggleRight,
    onToggleTerminal,
    projectWidth,
    tabHostRef
}: {
    rightOpen: boolean
    terminalOpen: boolean
    onToggleNav: () => void
    onToggleRight: () => void
    onToggleTerminal: () => void
    projectWidth?: number
    tabHostRef?: (node: HTMLDivElement | null) => void
}): React.JSX.Element {
    const [appearance, setAppearance] = useState(getTheme)
    const drag = useRef<{ x: number; y: number } | null>(null)
    const isControl = (target: EventTarget): boolean => target instanceof Element && !!target.closest('button,input,a,[role="tab"],[role="menu"]')
    useEffect(() => {
        const update = (): void => setAppearance(getTheme())
        window.addEventListener('desktop-theme-change', update)
        return () => window.removeEventListener('desktop-theme-change', update)
    }, [])
    return (
        <header className="workspace-bar"
            onDoubleClick={event => { if (!isControl(event.target)) void window.glass.toggleWindowMaximize?.() }}
            onPointerDown={event => {
                if (event.button !== 0 || isControl(event.target)) return
                drag.current = { x: event.screenX, y: event.screenY }
                event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={event => {
                if (!drag.current) return
                const dx = event.screenX - drag.current.x, dy = event.screenY - drag.current.y
                drag.current = { x: event.screenX, y: event.screenY }
                if (dx || dy) void window.glass.moveWindow?.(dx, dy)
            }}
            onPointerUp={() => { drag.current = null }}
            onPointerCancel={() => { drag.current = null }}>
            <div className="workspace-bar__left">
                <button type="button" className="workspace-bar__nav-toggle" onClick={onToggleNav} aria-label="Toggle chat sidebar" title="Toggle chat sidebar">
                    <PanelIcon side="left" />
                </button>
            </div>
            <div className={`workspace-bar__right${projectWidth !== undefined ? ' workspace-bar__right--project' : ''}`} style={projectWidth !== undefined ? {width:projectWidth,maxWidth:'calc(100vw - 300px)'} : undefined}>
            <div className="workspace-bar__tab-host" ref={tabHostRef} />
            <div className="workspace-bar__actions">
                <button type="button" className="workspace-theme" title={appearance === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} aria-label={appearance === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={() => setTheme(appearance === 'dark' ? 'light' : 'dark')}>
                    <svg viewBox="0 0 24 24" aria-hidden="true" strokeLinecap="round" strokeLinejoin="round">
                        {appearance === 'dark' ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5" /></> : <path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z" />}
                    </svg>
                </button>
                <button type="button" className={terminalOpen ? 'is-active' : ''} onClick={onToggleTerminal} aria-label="Toggle bottom terminal" title="Toggle bottom terminal (⌘J)">
                    <PanelIcon side="bottom" />
                </button>
                <button type="button" className={rightOpen ? 'is-active' : ''} onClick={onToggleRight} aria-label="Toggle Environment panel" title="Toggle Environment panel">
                    <PanelIcon side="right" />
                </button>
            </div>
            </div>
        </header>
    )
}
