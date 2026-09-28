import React, { useEffect, useState } from 'react'
import type { LocalAIStatus } from '@shared/local-ai'

export function LocalAISetup({ hidden = false, label = false }: { hidden?: boolean; label?: boolean }): React.JSX.Element | null {
    const [status, setStatus] = useState<LocalAIStatus>({phase:'idle', message:'Preparing Qwen3.5 9B for text and screenshots (~6.6 GB).'})
    useEffect(() => {
        let active = true
        const update = (value: LocalAIStatus): void => { if (active) setStatus(value) }
        const failed = (): void => update({phase:'error', message:'Restart Codex Lite to load local AI setup.'})
        if (typeof window.glass.localAI !== 'function') { failed(); return }
        void window.glass.localAI('prepare').then(update).catch(failed)
        const timer = setInterval(() => { void window.glass.localAI('status').then(update).catch(failed) }, 1000)
        return () => { active = false; clearInterval(timer) }
    }, [])
    const busy = ['idle','installing','starting','downloading'].includes(status.phase)
    if (hidden) return null
    if (label) {
        const text = status.phase === 'ready' ? 'Downloaded. Text and screenshot models are ready.'
            : status.phase === 'downloading' ? `Downloading Qwen3.5 9B local model${status.percent === undefined ? '…' : ` · ${status.percent}%`}`
            : status.phase === 'error' || status.phase === 'paused' ? 'Manage model downloads in Settings'
            : 'Preparing Qwen local models…'
        return <div className="glass-composer-model" role="status">{text}</div>
    }
    if (status.phase === 'ready') return <p className="local-ai-setup">Text and screenshot models are ready.</p>
    return <div className="local-ai-setup" role="status">
        <span>{status.message}{status.percent === undefined ? '' : ` ${status.percent}%`}</span>
        <button type="button" onClick={() => {
            void window.glass.localAI(busy ? 'pause' : 'start').then(setStatus).catch(() => setStatus({phase:'error',message:'Could not update local AI setup. Restart the app.'}))
        }}>{busy ? 'Pause download' : 'Resume / retry'}</button>
    </div>
}
