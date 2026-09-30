import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Editor from '@monaco-editor/react'
import { MONACO_THEME, ensureCopilotTheme } from './monacoSetup'
import type { CodeArtifact } from './codePanelContext'
import type { WorkspaceEntry, WorkspaceFile, WorkspaceRoot, WorkspaceTaskEvent } from '../../shared/workspace'
import './project-workspace.css'
import { BrowserTab } from './BrowserTab'
import { WorkspaceIcon } from './WorkspaceIcon'
import { FileTypeIcon } from './FileTypeIcon'
import type { BrowserSnapshot, BrowserTabState } from '../../shared/browser'

type Tab = { id: string; title: string; kind: 'files' | 'file' | 'generated' | 'review' | 'terminal' | 'browser'; file?: WorkspaceFile; draft?: string; code?: string; language?: string; browser?: BrowserTabState }
const language = (path: string): string => ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', py: 'python', json: 'json', css: 'css', html: 'html', md: 'markdown', sh: 'shell', swift: 'swift', go: 'go', rs: 'rust', yml: 'yaml', yaml: 'yaml' }[path.split('.').pop() ?? ''] || 'plaintext')

function ProjectTerminal(): React.JSX.Element {
    const [command, setCommand] = useState('')
    const [output, setOutput] = useState('')
    const [running, setRunning] = useState(false)
    return <div className="project-terminal"><pre>{output || 'Commands run in the selected project folder.\n'}</pre>
        <form onSubmit={event => {
            event.preventDefault()
            if (!command.trim() || running) return
            const sent = command
            setCommand(''); setRunning(true); setOutput(previous => `${previous}\n% ${sent}\n`)
            void window.workspace.run(sent).then(result => setOutput(previous => `${previous}${result.output}\n[exit ${result.exitCode}]\n`)).catch(error => setOutput(previous => previous + String(error))).finally(() => setRunning(false))
        }}><span>%</span><input aria-label="Project terminal command" value={command} onChange={event => setCommand(event.target.value)} disabled={running} spellCheck={false} />
        {running && <button type="button" onClick={() => void window.workspace.stop()}>Stop</button>}</form>
    </div>
}

export function ProjectWorkspace({ visible, artifact, onClose, width, onResize, browserObscured = false, tabHost }: {
    visible: boolean; artifact: CodeArtifact | null; onClose: () => void; width: number; onResize: (width: number) => void; browserObscured?: boolean; tabHost?: HTMLElement | null
}): React.JSX.Element {
    const [root, setRoot] = useState<WorkspaceRoot | null>(null)
    const [tree, setTree] = useState<Record<string, WorkspaceEntry[]>>({})
    const [expanded, setExpanded] = useState<Set<string>>(new Set(['']))
    const [filter, setFilter] = useState('')
    const [tabs, setTabs] = useState<Tab[]>([])
    const [active, setActive] = useState('')
    const [treeOpen, setTreeOpen] = useState(true)
    const [menu, setMenu] = useState(false)
    const [error, setError] = useState('')
    const [activity, setActivity] = useState<WorkspaceTaskEvent | null>(null)
    const [saveName, setSaveName] = useState<string | null>(null)
    const tab = tabs.find(item => item.id === active)
    const fileView = tab?.kind === 'file' || tab?.kind === 'files'
    const tabsRef = useRef(tabs)
    const saving = useRef(false)
    const fileRequest = useRef(0)
    tabsRef.current = tabs
    const fail = (reason: unknown): void => setError(reason instanceof Error ? reason.message : String(reason))
    const load = useCallback(async (path = '') => {
        const entries = await window.workspace.list(path)
        setTree(previous => ({ ...previous, [path]: entries }))
    }, [])
    const refresh = useCallback(async () => {
        setRoot(await window.workspace.root())
        await load()
    }, [load])
    const openFile = useCallback(async (path: string) => {
        const folder = tabsRef.current.find(item => item.id.startsWith('files:'))
        const current = folder ?? tabsRef.current.find(item => item.kind === 'file')
        const id = current?.id ?? 'files:workspace'
        if (current?.file?.path === path) { setActive(id); return }
        if (saving.current || (current?.file && current.draft !== current.file.content)) {
            throw new Error('Waiting for autosave. Please select the file again in a moment. Your edits are preserved.')
        }
        const request = ++fileRequest.current
        const file = await window.workspace.read(path)
        if (request !== fileRequest.current) return
        const next: Tab = { id, title: current?.title ?? 'Files and folders', kind: 'file', file, draft: file.content }
        setTabs(previous => previous.some(item => item.id === id) ? previous.map(item => item.id === id ? next : item) : [...previous, next])
        setActive(id)
        setTreeOpen(true)
        setError('')
    }, [])
    useEffect(() => { if (window.workspace) void refresh().catch(fail) }, [refresh])
    useEffect(() => {
        if (!window.browserWorkspace) return
        let lastFocus: string | null | undefined
        const sync = (state: BrowserSnapshot): void => {
            setTabs(previous => {
                const next = previous.filter(item => item.kind !== 'browser' || state.tabs.some(tab => item.browser?.id === tab.id))
                for (const browser of state.tabs) {
                    const id = `browser:${browser.id}`
                    const index = next.findIndex(item => item.id === id)
                    const item: Tab = {id,kind:'browser',title:browser.url === 'about:blank' ? 'New tab' : browser.title,browser}
                    if (index < 0) next.push(item); else next[index] = item
                }
                return next
            })
            if (state.focusId && state.focusId !== lastFocus) { setActive(`browser:${state.focusId}`); setTreeOpen(false) }
            lastFocus = state.focusId
        }
        const dispose = window.browserWorkspace.onChanged(sync)
        void window.browserWorkspace.list().then(sync).catch(fail)
        return dispose
    }, [])
    useEffect(() => {
        if (!window.workspace) return
        return window.workspace.onTask(event => {
            setActivity(event)
            if (event.path) {
                void load().catch(fail)
                const path = event.path
                if (tabsRef.current.some(item => item.file?.path === path)) {
                    void window.workspace.read(path).then(file => {
                        setTabs(previous => previous.map(item => item.file?.path === path && item.draft === item.file.content ? { ...item, file, draft: file.content } : item))
                    }).catch(fail)
                } else void openFile(path).catch(fail)
            }
        })
    }, [load, openFile])
    useEffect(() => {
        if (!artifact) return
        const id = `artifact:${Date.now()}`
        setTabs(previous => [...previous, { id, kind: artifact.language === 'diff' ? 'review' : 'generated', title: artifact.title || 'Generated code', code: artifact.code, language: artifact.language }])
        setActive(id)
    }, [artifact])
    const save = useCallback(async () => {
        if (saving.current) return
        saving.current = true
        try {
            for (const current of tabsRef.current) {
                if (!current.file || current.draft === current.file.content) continue
                const saved = await window.workspace.write({ ...current.file, content: current.draft ?? current.file.content })
                setTabs(previous => previous.map(item => item.id === current.id ? { ...item, file: saved } : item))
            }
            setError('')
        } finally { saving.current = false }
    }, [])
    useEffect(() => {
        if (!tabs.some(item => item.file && item.draft !== item.file.content)) return
        const timer = setTimeout(() => { void save().catch(fail) }, 700)
        return () => clearTimeout(timer)
    }, [tabs, save])
    useEffect(() => {
        if (!visible) return
        const listener = (event: KeyboardEvent): void => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save().catch(fail) }
        }
        window.addEventListener('keydown', listener)
        return () => window.removeEventListener('keydown', listener)
    }, [save, visible])
    const dirty = tabs.some(item => item.file && item.file.content !== item.draft)
    useEffect(() => {
        const listener = (event: BeforeUnloadEvent): void => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
        window.addEventListener('beforeunload', listener)
        return () => window.removeEventListener('beforeunload', listener)
    }, [dirty])
    const choose = async (): Promise<void> => {
        if (dirty || saving.current) { setError('Wait for autosave before changing project folders.'); return }
        const chosen = await window.workspace.choose()
        if (chosen) {
            const id = `files:${chosen.path}`
            setRoot(chosen); setTabs(previous => [...previous.filter(item => item.kind === 'browser'), { id, kind: 'files', title: chosen.name }]); setActive(id); setTreeOpen(true); setTree({}); setExpanded(new Set([''])); await load(); setError('')
        }
    }
    const add = async (kind: 'files' | 'terminal' | 'review' | 'browser'): Promise<void> => {
        setMenu(false)
        if (kind === 'files') { await choose(); return }
        if (kind === 'browser') { await window.browserWorkspace.create(); return }
        const id = `${kind}:${Date.now()}`
        const code = kind === 'review' ? await window.workspace.review() : undefined
        setTabs(previous => [...previous, { id, kind, title: { review: 'Review', terminal: 'Terminal', browser: 'Browser' }[kind], code }]); setActive(id)
    }
    const closeTab = (item: Tab): void => {
        if (item.file && item.draft !== item.file.content && !window.confirm(`Discard unsaved edits to ${item.title}?`)) return
        if (item.browser) void window.browserWorkspace.close(item.browser.id).catch(fail)
        const remaining = tabs.filter(value => value.id !== item.id)
        setTabs(remaining)
        if (active === item.id) setActive(remaining.at(-1)?.id ?? '')
    }
    const renderTree = (path = '', depth = 0): React.ReactNode => (tree[path] ?? []).map(entry => {
        if (!entry.directory && filter && !entry.path.toLowerCase().includes(filter.toLowerCase())) return null
        return <React.Fragment key={entry.path}><button className={`project-tree__entry${tab?.file?.path === entry.path ? ' is-selected' : ''}`} style={{ paddingLeft: 12 + depth * 14 }} onClick={() => {
            if (!entry.directory) { void openFile(entry.path).catch(fail); return }
            setExpanded(previous => { const next = new Set(previous); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next })
            void load(entry.path).catch(fail)
        }} title={entry.path}>{entry.directory ? <span className={`project-tree__chevron${expanded.has(entry.path) ? ' is-expanded' : ''}`}><WorkspaceIcon name="chevron" /></span> : <FileTypeIcon path={entry.path} />}<span className="project-tree__name">{entry.name}</span></button>
        {entry.directory && expanded.has(entry.path) && renderTree(entry.path, depth + 1)}</React.Fragment>
    })
    const tabStrip = <div className={`project-tabs${tabHost ? ' project-tabs--titlebar' : ''}`}><div role="tablist" aria-label="Workspace tabs">{tabs.map(item => <div className={active === item.id ? 'is-active' : ''} key={item.id}>
            <button role="tab" aria-selected={active === item.id} onClick={() => { setActive(item.id); setTreeOpen(item.kind === 'files' || item.kind === 'file') }}><WorkspaceIcon name={item.kind === 'generated' ? 'file' : item.kind} /><span>{item.title}{item.file && item.draft !== item.file.content ? ' •' : ''}</span></button><button aria-label={`Close ${item.title}`} onClick={() => closeTab(item)}><WorkspaceIcon name="close" /></button>
        </div>)}</div><div className="project-add"><button aria-label="Add workspace tab" aria-expanded={menu} onClick={() => setMenu(value => !value)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg></button>
        {menu && <><button className="project-menu-dismiss" aria-label="Dismiss tab menu" onClick={() => setMenu(false)} /><div className="project-menu" role="menu">{(['review', 'terminal', 'browser', 'files'] as const).map(kind => <button role="menuitem" key={kind} onClick={() => void add(kind).catch(fail)}><WorkspaceIcon name={kind} /><span>{kind === 'files' ? 'Files and folders' : kind[0].toUpperCase() + kind.slice(1)}</span>{(kind === 'browser' || kind === 'files') && <kbd>{kind === 'browser' ? '⌘T' : '⌘P'}</kbd>}</button>)}</div></>}</div>
        {!tabHost && <button className="project-tabs__hide" aria-label="Hide workspace" onClick={onClose}>×</button>}</div>
    return <aside className="project-workspace" aria-label="Project workspace" style={{ display: visible ? 'flex' : 'none', width, maxWidth: 'calc(100vw - 300px)' }}>
        <div className="project-resizer" role="separator" aria-label="Resize project workspace" aria-orientation="vertical" onPointerDown={event => {
            event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
        }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) onResize(Math.max(360, Math.min(window.innerWidth - 300, window.innerWidth - event.clientX))) }} />
        {tabHost ? visible && createPortal(tabStrip,tabHost) : tabStrip}
        {fileView && <nav className="project-breadcrumb" aria-label="File breadcrumb"><span>{tab?.file && [root?.name ?? 'Workspace', ...tab.file.path.split('/')].map((part, index, parts) => <React.Fragment key={index}>{index > 0 && <WorkspaceIcon name="chevron" />}<span aria-current={index === parts.length - 1 ? 'page' : undefined}>{part}</span></React.Fragment>)}</span><button className="project-tree-toggle" type="button" aria-label="Toggle files tree" aria-expanded={treeOpen} title={treeOpen ? 'Collapse files tree' : 'Expand files tree'} onClick={() => setTreeOpen(value => !value)}><WorkspaceIcon name="files" /></button></nav>}
        {tab?.kind === 'generated' && <button onClick={() => setSaveName(`untitled.${tab.language === 'typescript' ? 'ts' : tab.language === 'python' ? 'py' : 'txt'}`)}>Save as file</button>}
        {saveName !== null && tab?.kind === 'generated' && <form className="project-save-as" onSubmit={event => {
            event.preventDefault()
            const path = saveName.trim()
            if (path) void window.workspace.write({path,content:tab.code || '',revision:''}).then(async () => {setSaveName(null); await load(); await openFile(path)}).catch(fail)
        }}><input autoFocus aria-label="New file path" value={saveName} onChange={event => setSaveName(event.target.value)} /><button>Save file</button><button type="button" onClick={() => setSaveName(null)}>Cancel</button></form>}
        {error && <div className="project-error" role="alert">{error}<button onClick={() => setError('')}>×</button></div>}
        {activity?.running && <div className="project-activity" role="status"><span>{activity.message.slice(-800)}{activity.command && <code>{activity.command}</code>}</span>
            {activity.approvalId && <button onClick={() => void window.workspace.approve(activity.approvalId!, true)}>Run command</button>}
            <button onClick={() => void window.workspace.stop()}>Stop</button></div>}
        <div className="project-content"><main className="project-editor">
            {tabs.filter(item => item.kind === 'terminal' || item.kind === 'browser').map(item => <div className="project-surface" style={{ display: active === item.id ? 'flex' : 'none' }} key={item.id}>{item.kind === 'terminal' ? <ProjectTerminal /> : item.browser && <BrowserTab tab={item.browser} active={visible && active === item.id && !menu && !browserObscured} />}</div>)}
            {tab && ['file', 'generated', 'review'].includes(tab.kind) && <Editor height="100%" key={tab.file?.path ?? tab.id} path={tab.file ? `${tab.id}/${tab.file.path}` : tab.id} theme={MONACO_THEME} beforeMount={ensureCopilotTheme} language={tab.file ? language(tab.file.path) : tab.kind === 'review' ? 'diff' : tab.language} value={tab.file ? tab.draft : tab.code} onChange={value => setTabs(previous => previous.map(item => item.id === tab.id ? { ...item, draft: value ?? '' } : item))} options={{ readOnly: tab.kind !== 'file', domReadOnly: tab.kind !== 'file', fixedOverflowWidgets: true, minimap: { enabled: false }, automaticLayout: true, fontSize: 13, padding: { top: 16 }, scrollBeyondLastLine: false, scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6, verticalSliderSize: 6, horizontalSliderSize: 6, useShadows: false } }} />}
            {(!tab || tab.kind === 'files') && <div className="project-empty"><WorkspaceIcon name="files" /><strong>Open a file</strong><p>Select a file from the workspace tree or open a project folder.</p></div>}
        </main>{treeOpen && fileView && <nav className="project-tree" aria-label="Project files"><div><input placeholder="Filter files…" aria-label="Filter loaded files" value={filter} onChange={event => setFilter(event.target.value)} /></div>{renderTree()}{tree['']?.length === 0 && <p>No files yet. Ask the agent to build something here.</p>}</nav>}</div>
    </aside>
}
