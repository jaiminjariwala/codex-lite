import React, { useCallback, useEffect, useState } from 'react'
import { LocalAISetup } from './LocalAISetup'
import type { ConfigStatus, MemoryEntry } from '@shared/types'
import { getConfigBridge } from './config-bridge'
import { getChatBridge } from './bridges'
import { dockIcons, type DockPreferences, type DockIcon } from '@shared/dock-icon'

/**
 * AI settings — deliberately small. Two ways to connect, nothing else:
 *
 *  1. A free key (Google Gemini or OpenRouter), pasted once.
 *  2. Your own OpenAI-compatible endpoint (company gateway or personal), with
 *     base URL + model + key.
 *
 * Keys are sent to the main process, encrypted with the macOS keychain, and
 * never rendered back. The chain tries your own endpoint first (when set),
 * then the free providers.
 */

type SaveState =
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved' }
    | { kind: 'error'; message: string }

const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 12,
    color: 'var(--text-dim)',
    margin: '12px 0 4px'
}

const inputStyle: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 10px',
    fontSize: 13,
    color: 'var(--text)',
    background: 'var(--field-bg)',
    border: '1px solid var(--field-border)',
    borderRadius: 8,
    outline: 'none'
}

const sectionTitle: React.CSSProperties = {
    fontSize: 12.5,
    color: 'var(--text)',
    margin: '22px 0 2px',
    fontWeight: 600
}

const hintStyle: React.CSSProperties = {
    fontSize: 11.5,
    color: 'var(--text-dim)',
    margin: '0 0 4px',
    lineHeight: 1.4
}

const storedDot = <span style={{ color: '#19c37d' }}>●</span>

export function Settings({ onConfigStatusChange: _onConfigStatusChange, onBack }: { onConfigStatusChange?: (status: ConfigStatus) => void; onBack?: () => void } = {}): React.JSX.Element {
    return <section aria-label="AI settings" className="glass-settings">
        {onBack && <button type="button" className="settings-back" onClick={onBack}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m12 5-7 7 7 7M5 12h14" /></svg>
            Back to chat
        </button>}
        <DockIconSettings />
        <h3 style={sectionTitle}>Local AI</h3>
        <p style={hintStyle}>Ollama runs Qwen3.5 9B for text, code, and screenshots on this Mac. Images stay local. The download is about 6.6 GB; 16 GB RAM is recommended. Manage model downloads below.</p>
        <LocalAISetup />
        <MemorySection />
    </section>
}

function DockIconSettings(): React.JSX.Element {
    const [value, setValue] = useState<(DockPreferences & { previews: Record<DockIcon, string> }) | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    useEffect(() => { void window.glass.dockPreferences().then(setValue).catch(() => setError('Could not load app icons.')) }, [])
    const save = async (next: DockPreferences): Promise<void> => {
        setBusy(true); setError('')
        try { setValue(await window.glass.dockPreferences(next)); window.dispatchEvent(new Event('dock-icon-changed')) } catch { setError('Could not save app icon. Please try again.') } finally { setBusy(false) }
    }
    return <div>
        <h3 style={sectionTitle}>App icon</h3>
        <p style={hintStyle}>Choose your running app’s Dock icon. Your choice is remembered.</p>
        <div style={{ display: 'flex', gap: 12, margin: '12px 0' }}>
            {value && dockIcons.map(icon => <button type="button" key={icon} disabled={busy} aria-pressed={value.icon === icon}
                onClick={() => void save({ icon, rotating: value.rotating })}
                style={{ color: 'var(--text)', background: value.icon === icon ? 'var(--field-bg)' : 'transparent', border: value.icon === icon ? '1px solid var(--text-dim)' : '1px solid transparent', borderRadius: 12, padding: 10 }}>
                <img src={value.previews[icon]} alt="" width="64" height="64" style={{ display: 'block' }} />
                {icon === 'blue-ball' ? 'Coastal' : 'Classic'}
            </button>)}
        </div>
        {value && <label className="rotation-option"><span className="rotation-control"><input className="rotation-checkbox" type="checkbox" checked={value.rotating} disabled={busy}
            onChange={event => void save({ icon: value.icon, rotating: event.target.checked })} /><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 8 2.5 2.5L12 5" /></svg></span><span>Rotate icon</span></label>}
        <p style={hintStyle}>Rotation respects macOS Reduce Motion. The installed Finder icon stays static.</p>
        {error && <p role="alert">{error}</p>}
    </div>
}

/**
 * Persistent memory — the audit surface. Everything the assistant remembers
 * lives here: add a fact, delete one, or clear the lot. Entries also arrive
 * from chat when a message starts with "remember …". Local JSON only; the
 * only place memories ever travel is inside your own AI requests.
 */
function MemorySection(): React.JSX.Element {
    const [entries, setEntries] = useState<MemoryEntry[]>([])
    const [newFact, setNewFact] = useState('')

    const bridge = getChatBridge()

    useEffect(() => {
        if (bridge && typeof bridge.listMemories === 'function') {
            void bridge.listMemories().then(setEntries).catch(() => undefined)
        }
        // The bridge is a stable global; run once on mount.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const add = useCallback(() => {
        const text = newFact.trim()
        if (text.length === 0) return
        if (!bridge || typeof bridge.addMemory !== 'function') return
        void bridge
            .addMemory(text)
            .then((list) => {
                setEntries(list)
                setNewFact('')
            })
            .catch(() => undefined)
    }, [bridge, newFact])

    const remove = useCallback(
        (id: string) => {
            if (!bridge || typeof bridge.deleteMemory !== 'function') return
            void bridge.deleteMemory(id).then(setEntries).catch(() => undefined)
        },
        [bridge]
    )

    const clearAll = useCallback(() => {
        if (!bridge || typeof bridge.clearMemories !== 'function') return
        void bridge.clearMemories().then(setEntries).catch(() => undefined)
    }, [bridge])

    return (
        <div aria-label="Persistent memory">
            <h3 style={sectionTitle}>Memory</h3>
            <p style={hintStyle}>
                Facts the assistant keeps across chats. Say “remember …” in a chat, or add one
                here. Stored only on this Mac; delete anything, anytime.
            </p>

            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <input
                    type="text"
                    placeholder="e.g. I prefer short answers"
                    value={newFact}
                    onChange={(e) => setNewFact(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault()
                            add()
                        }
                    }}
                    style={{ ...inputStyle, flex: 1 }}
                    aria-label="New memory"
                />
                <button
                    type="button"
                    onClick={add}
                    disabled={newFact.trim().length === 0}
                    style={{
                        padding: '7px 14px',
                        fontSize: 13,
                        color: 'var(--text)',
                        background: 'var(--field-bg)',
                        border: '1px solid var(--field-border)',
                        borderRadius: 8,
                        cursor: newFact.trim().length === 0 ? 'default' : 'pointer',
                        opacity: newFact.trim().length === 0 ? 0.5 : 1
                    }}
                >
                    Add
                </button>
            </div>

            {entries.length === 0 ? (
                <p style={{ ...hintStyle, margin: '10px 0 0' }}>Nothing remembered yet.</p>
            ) : (
                <div style={{ marginTop: 10 }}>
                    {entries.map((entry) => (
                        <div
                            key={entry.id}
                            style={{
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: 8,
                                padding: '7px 2px',
                                borderBottom: '1px solid var(--field-border)'
                            }}
                        >
                            <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text)', lineHeight: 1.45 }}>
                                {entry.text}
                            </span>
                            <button
                                type="button"
                                onClick={() => remove(entry.id)}
                                aria-label={`Forget "${entry.text}"`}
                                title="Forget this"
                                style={{
                                    border: 'none',
                                    background: 'transparent',
                                    color: 'var(--text-dim)',
                                    fontSize: 14,
                                    lineHeight: 1,
                                    cursor: 'pointer',
                                    padding: '2px 6px'
                                }}
                            >
                                ×
                            </button>
                        </div>
                    ))}
                    <button
                        type="button"
                        onClick={clearAll}
                        style={{
                            marginTop: 10,
                            padding: '6px 12px',
                            fontSize: 12,
                            color: 'var(--text-dim)',
                            background: 'transparent',
                            border: '1px solid var(--field-border)',
                            borderRadius: 8,
                            cursor: 'pointer'
                        }}
                    >
                        Forget everything
                    </button>
                </div>
            )}
        </div>
    )
}
