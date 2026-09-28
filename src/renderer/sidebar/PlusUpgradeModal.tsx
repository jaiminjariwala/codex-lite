import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

interface PlusUpgradeModalProps {
    onClose: () => void
}

function CheckIcon(): React.JSX.Element {
    return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m4.5 10.3 3.2 3.2 7.8-7.8" />
        </svg>
    )
}

export function PlusUpgradeModal({ onClose }: PlusUpgradeModalProps): React.JSX.Element {
    const [checkoutBusy, setCheckoutBusy] = useState(false)
    const [checkoutError, setCheckoutError] = useState('')
    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose])

    return createPortal(
        <div className="plus-upgrade" role="dialog" aria-modal="true" aria-labelledby="plus-upgrade-title">
            <button type="button" className="plus-upgrade__backdrop" onClick={onClose} aria-label="Close upgrade" />
            <article className="plus-plan-card">
                <button type="button" className="plus-plan-card__close" onClick={onClose} aria-label="Close upgrade">×</button>
                <div>
                    <span className="plus-plan-card__eyebrow">Codex Lite</span>
                    <h2 id="plus-upgrade-title">Desktop access</h2>
                    <div className="plus-plan-card__price"><sup>$</sup><strong>1</strong><span>USD / month</span></div>
                    <p>A lightweight workspace for everyday questions and code. The subscription pays for app access, not a Codex or premium model plan.</p>
                </div>

                <div className="plus-plan-card__speed">
                    <span>AI providers</span>
                    <strong>Ollama · Local Qwen3.5 9B</strong>
                </div>

                <button
                    type="button"
                    className="plus-plan-card__checkout"
                    disabled={checkoutBusy}
                    onClick={() => {
                        setCheckoutBusy(true)
                        setCheckoutError('')
                        void window.glass.startPlusCheckout()
                            .then(onClose)
                            .catch((error: unknown) => {
                                setCheckoutError(error instanceof Error ? error.message : 'Checkout could not be opened.')
                            })
                            .finally(() => setCheckoutBusy(false))
                    }}
                >
                    {checkoutBusy ? 'Opening secure checkout…' : 'Subscribe for $1/month'}
                </button>
                {checkoutError && <p className="plus-plan-card__error" role="alert">{checkoutError}</p>}

                <ul>
                    {[
                        'Ask everyday questions and get Python or other code answers',
                        'Code opens in the right-side workspace',
                        'GitHub sign-in, saved chats, and attachments'
                    ].map((feature) => (
                        <li key={feature}><CheckIcon /><span>{feature}</span></li>
                    ))}
                </ul>

                <p className="plus-plan-card__notice">Initial Ollama and model downloads require internet and disk space. Speed and answer quality depend on your Mac. Qwen3.5 9B handles text, code, and screenshots locally; visual automation is a separate feature. Sign-in and sandbox billing require internet. The demo checkout does not charge real money.</p>
                <p className="plus-plan-card__notice">Independent project; not affiliated with OpenAI.</p>
            </article>
        </div>,
        document.body
    )
}
