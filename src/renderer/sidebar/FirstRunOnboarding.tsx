import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountAuthRequest, AccountSnapshot, GitHubAuthStatus } from '@shared/types'
import blueBall from './assets/brand-ball.png'
import { MicrophoneIcon } from './MicrophoneIcon'
import './onboarding.css'

type Step = 'loading' | 'login' | 'accounts' | 'microphone' | 'accessibility' | 'github' | 'google'
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : 'Could not continue. Try again.').split(/Error:\s*/).pop()!
export function FirstRunOnboarding({ openRequested, onDismiss, onAuth, onVisible }: {
    openRequested: boolean; onDismiss: () => void; onAuth: (status: GitHubAuthStatus) => void; onVisible: (visible: boolean) => void
}): React.JSX.Element | null {
    const [visible, setVisible] = useState(true)
    const [step, setStep] = useState<Step>('loading')
    const [snapshot, setSnapshot] = useState<AccountSnapshot | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [githubCode, setGitHubCode] = useState('')
    const stepRef = useRef(step)
    stepRef.current = step
    const callbacks = useRef({ onAuth, onVisible, onDismiss })
    callbacks.current = { onAuth, onVisible, onDismiss }
    const apply = useCallback((status: AccountSnapshot) => {
        setSnapshot(status)
        callbacks.current.onAuth(status.auth)
        return status
    }, [])
    const action = useCallback(async (request: AccountAuthRequest): Promise<AccountSnapshot | null> => {
        setBusy(true); setError('')
        try { return apply(await window.glass.accountAuth(request)) }
        catch (error) { setError(errorMessage(error)); return null }
        finally { setBusy(false) }
    }, [apply])
    useEffect(() => {
        let mounted = true
        const refresh = async (): Promise<void> => {
            try {
                const status = await window.glass.accountAuth({ action: 'status' })
                if (!mounted) return
                apply(status)
                if (stepRef.current === 'github' && status.activeId) { setVisible(true); setStep('accounts') }
                else if (status.activeId && status.onboardingComplete) setVisible(false)
                else { setVisible(true); setStep(status.accounts.length ? 'accounts' : 'login') }
            } catch (error) { if (mounted) { setError(errorMessage(error)); setStep('login') } }
        }
        void refresh()
        // GitHub authorization occurs in the browser; poll status only after its event.
        const dispose = window.glass.onGitHubAuthChanged(status => {
            if (status.state === 'signed-in') void refresh()
            else if (status.state === 'error' || (status.state === 'signed-out' && status.message)) setError(status.message || 'GitHub sign-in could not finish. Try again.')
        })
        const disposeAccount = window.glass.onAccountChanged?.(status => {
            if (!mounted) return
            apply(status)
            if (status.googlePending) return
            if (!status.activeId) { setVisible(true); setStep(status.accounts.length ? 'accounts' : 'login') }
        })
        return () => { mounted = false; dispose(); disposeAccount?.() }
    }, [apply])
    useEffect(() => { callbacks.current.onVisible(visible) }, [visible])
    useEffect(() => {
        if (!openRequested) return
        setVisible(true); setStep(snapshot?.accounts.length ? 'accounts' : 'login'); setError('')
    }, [openRequested]) // snapshot is deliberately read when the menu is opened.
    useEffect(() => {
        if (step !== 'google') return
        let stopped = false
        let timer: ReturnType<typeof setTimeout>
        const poll = async (): Promise<void> => {
            try {
                const status = await window.glass.accountAuth({ action: 'google-poll' })
                if (stopped) return
                apply(status)
                if (!status.googlePending && status.activeId) { setStep('accounts'); return }
                timer = setTimeout(() => void poll(), 2000)
            } catch (error) {
                if (!stopped) { setError(errorMessage(error)); setStep('login') }
            }
        }
        timer = setTimeout(() => void poll(), 2000)
        return () => { stopped = true; clearTimeout(timer) }
    }, [step, apply])
    useEffect(() => {
        if (!visible || !['microphone', 'accessibility'].includes(step)) return
        let mounted = true
        const refresh = (): void => { void window.glass.accountAuth({ action: 'permissions' }).then(s => { if (mounted) apply(s) }).catch(() => undefined) }
        refresh(); window.addEventListener('focus', refresh)
        return () => { mounted = false; window.removeEventListener('focus', refresh) }
    }, [step, visible, apply])
    const close = (): void => { setVisible(false); callbacks.current.onDismiss() }
    const finish = async (): Promise<void> => { if (await action({ action: 'complete' })) close() }
    const choose = async (id: string): Promise<void> => {
        const status = await action({ action: 'switch', id })
        if (status) { if (status.onboardingComplete) close(); else setStep('microphone') }
    }
    if (!visible) return null
    const permission = step === 'microphone' || step === 'accessibility'
    return <section className={`onboarding${permission ? ' onboarding--permissions' : ''}`} aria-label="Codex Lite setup">
        <div className="onboarding__titlebar" />
        {step !== 'loading' && step !== 'login' && <button className="onboarding__back" aria-label="Back" disabled={busy} onClick={() => {
            setError('')
            if (step === 'google' || step === 'github') void action({ action: 'cancel-login' })
            if (step === 'accessibility') setStep('microphone')
            else if (step === 'microphone') setStep('accounts')
            else if (step === 'accounts' && snapshot?.activeId && snapshot.onboardingComplete) close()
            else setStep('login')
        }}>←</button>}
        <div className="onboarding__content">
            {permission ? <span className="onboarding__mic"><MicrophoneIcon /></span> : <img className="onboarding__ball" src={blueBall} alt="Codex Lite" />}
            {step === 'loading' && <h1>Welcome to Codex Lite</h1>}
            {step === 'login' && <div className="onboarding__login">
                <h1>Log in or create an account</h1>
                <p className="onboarding__email-description">Sign in securely in your browser. No password or email code needed.</p>
                <button className="onboarding__primary onboarding__login-continue" disabled={busy} onClick={async () => {
                    if (await action({ action: 'google' })) setStep('google')
                }}>Continue with Google</button>
                <button type="button" className="onboarding__primary onboarding__login-continue onboarding__github-button" disabled={busy} onClick={async () => {
                    const status = await action({ action: 'github' })
                    if (status) { setGitHubCode(status.challenge?.userCode || ''); setStep('github') }
                }}>Continue with GitHub</button>
                {!!snapshot?.accounts.length && <button type="button" className="onboarding__link" onClick={() => setStep('accounts')}>Choose a saved account</button>}
            </div>}
            {step === 'google' && <>
                <h1>Continue with Google</h1>
                <p className="onboarding__email-description">Choose your Google account in your browser. This window will update when you’re signed in.</p>
                <button className="onboarding__link" disabled={busy} onClick={() => void action({ action: 'google-reopen' })}>Reopen Google</button>
            </>}
            {step === 'github' && <>
                <h1>Continue with GitHub</h1>
                <p>Finish signing in in your browser. Codex Lite will update when you’re done.</p>
                {githubCode && <><p>Enter this code on GitHub:</p><strong className="onboarding__github-code">{githubCode}</strong></>}
                <button className="onboarding__link" onClick={() => void window.glass.openGitHubVerification().catch(e => setError(errorMessage(e)))}>Reopen GitHub</button>
                <button className="onboarding__primary" disabled={busy} onClick={async () => {
                    const status = await action({ action: 'status' }); if (status?.activeId) setStep('accounts')
                }}>I’ve finished signing in</button>
            </>}
            {step === 'accounts' && <div className="onboarding__account-chooser">
                <h1>Choose an account to continue</h1>
                <p>Use an account you’ve signed into on this Mac, or add another account to Codex Lite.</p>
                <div className="onboarding__accounts">{snapshot?.accounts.map(account => <button key={account.id} className="onboarding__account" disabled={busy} onClick={() => {
                    if (account.expired) { setStep('login'); setError('Your session expired. Sign in again.') }
                    else void choose(account.id)
                }}><span><strong>{account.email}</strong><small>{account.provider === 'github' ? 'GitHub account' : account.provider === 'google' ? 'Google account' : 'Previously saved account'}{account.expired ? ' · Sign in again' : ''}</small></span><svg className="onboarding__account-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg></button>)}</div>
                <button className="onboarding__link" onClick={() => setStep('login')}>Add another account</button>
            </div>}
            {permission && <>
                <h1>Enable dictation</h1>
                <p>Turn your speech into text in Codex Lite.</p>
                <div className="onboarding__permission-card">
                    <div className="onboarding__permission-row"><MicrophoneIcon /><span><strong>Microphone</strong>{!snapshot?.microphone && <small>Allow Codex Lite to access the microphone</small>}</span>
                        {snapshot?.microphone ? <span className="onboarding__check" aria-label="Microphone allowed">✓</span> : <button className="onboarding__allow" disabled={busy} onClick={async () => { const status = await action({ action: 'microphone' }); if (status?.microphone) setStep('accessibility'); else if (status) setError('Microphone access is off. You can enable it in macOS Privacy & Security or skip.') }}>Allow</button>}
                    </div>
                    {step === 'accessibility' && <div className="onboarding__permission-row"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="14" rx="2" /><path d="M8 21h8M12 17v4m-2-14 5 4-3 .6-1 3Z" /></svg><span><strong>Accessibility</strong><small>Optional: control other Mac apps for approved tasks</small></span>
                        {snapshot?.accessibility ? <span className="onboarding__check" aria-label="Accessibility allowed">✓</span> : <button className="onboarding__allow" disabled={busy} onClick={() => void action({ action: 'accessibility' })}>Allow</button>}
                    </div>}
                </div>
                {step === 'microphone' ? <button className="onboarding__link onboarding__skip" disabled={busy} onClick={() => setStep('accessibility')}>{snapshot?.microphone ? 'Continue' : 'Skip'}</button> : <>
                    <button className="onboarding__primary onboarding__finish" disabled={busy} onClick={() => void finish()}>Continue</button>
                    {!snapshot?.accessibility && <p>Accessibility is optional. You can continue without it.</p>}
                </>}
                <div className="onboarding__dots" aria-hidden="true"><i /><i /><i className="active" /></div>
            </>}
            {error && <p className="onboarding__error" role="alert">{error}</p>}
        </div>
    </section>
}
