import React, { useEffect, useState } from 'react'
import { RollingBall } from './RollingBall'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { SessionSummary, TurnView } from '@shared/types'
import { CodeMarkdown } from './CodeBlock'
import { webSources } from './web-sources'

/** Presentation of individual chat turns and the running goal tracker. */

/** Markdown component overrides: render fenced code with the rich CodeBlock. */
const MARKDOWN_COMPONENTS = {
    code: CodeMarkdown,
    // Our CodeBlock provides its own container, so drop the default <pre> wrapper.
    pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}

/** Render assistant text as Markdown; user text stays plain. */
const revealedTurns = new Set<string>()
export function TurnBody({ turn, animate = false, query }: { turn: TurnView; animate?: boolean; query?: string }): React.JSX.Element {
    const presentation = turn.role === 'assistant' ? webSources(turn.text ?? '') : { text: turn.text ?? '', sources: [] }
    const text = presentation.text
    const [shouldReveal] = useState(() => animate && !revealedTurns.has(turn.id))
    const [visible, setVisible] = useState(shouldReveal ? 0 : text.length)
    useEffect(() => {
        revealedTurns.add(turn.id)
        if (!shouldReveal || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setVisible(text.length); return }
        // Fixed small increments avoid large bursts on longer answers and pause at line breaks.
        let cursor = 0
        let timer: number
        const reveal = (): void => {
            const point = text.codePointAt(cursor)
            cursor = Math.min(text.length, cursor + (point !== undefined && point > 0xffff ? 2 : 1))
            setVisible(cursor)
            if (cursor < text.length) timer = window.setTimeout(reveal, text[cursor - 1] === '\n' ? 100 : 14)
        }
        timer = window.setTimeout(reveal, 14)
        return () => window.clearTimeout(timer)
    }, [shouldReveal, text, turn.id])
    if (turn.role === 'assistant') {
        return (
            <div className={`glass-markdown${visible < text.length ? ' glass-markdown--revealing' : ''}`}>
                {presentation.sources.length > 0 && <details className="web-sources">
                    <summary>Searched the web <span className="web-sources__chevron" aria-hidden="true">›</span></summary>
                    <div className="web-sources__card">
                        {query && <div className="web-sources__query"><span>Searched the web</span> {query}</div>}
                        <ul>{presentation.sources.map(source => <li key={source.url}><a href={source.url} target="_blank" rel="noopener noreferrer"><span className="web-sources__title">{source.title}</span><span className="web-sources__domain">{source.domain}</span></a></li>)}</ul>
                    </div>
                </details>}
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                    {text.slice(0, visible)}
                </ReactMarkdown>
                {visible < text.length && <RollingBall rolling />}
            </div>
        )
    }
    return <>{turn.text}</>
}

/** Compact goal/step tracker — surfaces the running session summary. */
export function GoalTracker({ summary }: { summary: SessionSummary }): React.JSX.Element | null {
    const hasGoal = summary.inferredIntent.trim().length > 0
    const steps = summary.completedSteps
    if (!hasGoal && steps.length === 0) {
        return null
    }
    return (
        <div className="glass-tracker">
            <div className="glass-tracker__label">Goal</div>
            <div className="glass-tracker__goal">
                {hasGoal ? summary.inferredIntent : 'Figuring out your goal…'}
            </div>
            {steps.length > 0 && (
                <ul className="glass-tracker__steps">
                    {steps.map((step, i) => (
                        <li key={i} className="glass-tracker__step">
                            <span className="glass-tracker__check">✓</span>
                            {step}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}
