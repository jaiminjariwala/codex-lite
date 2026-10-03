// UI smoke test with an in-memory IPC fixture. No model calls or real project edits.
// Run: node scripts/smoke-workspace.mjs
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

const entry = resolve('scripts/__workspace-smoke.tsx')
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectWorkspace } from '/src/renderer/sidebar/ProjectWorkspace';
import { ChatSidebar } from '/src/renderer/sidebar/ChatSidebar';
import { WorkspaceBar } from '/src/renderer/sidebar/WorkspaceBar';
import { TurnBody } from '/src/renderer/sidebar/turns';
import { fitPanelWidth } from '/src/renderer/sidebar/panel-layout';
import { followConversation } from '/src/renderer/sidebar/conversation-follow';
import '/src/renderer/sidebar/styles.css';
const files = {'src/main.ts': {path:'src/main.ts', content:'export const rocket = "Ready for launch";\\n', revision:'1'}, 'README.md': {path:'README.md', content:'# Rocket workspace', revision:'1'}};
let listener = () => {};
window.testFollow=followConversation;
window.glass = {getGitHubAuthStatus:async()=>({state:'signed-in',user:{login:'demo',name:'Demo user'}}), onGitHubAuthChanged:()=>()=>{}, getManagedAccountStatus:async()=>({configured:true,authenticated:true})};
window.workspace = {
 root: async () => ({path:'/fixture/Rocket',name:'Rocket'}),
 choose: async () => ({path:'/fixture/Rocket',name:'Rocket'}),
 list: async (path='') => path === 'src' ? [{name:'main.ts',path:'src/main.ts',directory:false}] : [{name:'src',path:'src',directory:true},{name:'README.md',path:'README.md',directory:false}],
 read: async path => ({...files[path]}),
 write: async file => {if(files[file.path]?.revision !== file.revision) throw Error('Conflict'); files[file.path]={...file,revision:'2'}; window.saved=file.content; return {...files[file.path]};},
 review: async () => '+ export const rocket = "Ready";',
 run: async command => ({command,output:'workspace-terminal-ok',exitCode:0,cwd:'/fixture/Rocket'}),
 stop: async () => {window.stopped=true; listener({running:false,message:'Stopped'});},
 approve: async () => {}, task: async () => {},
 onTask: cb => {listener=cb; window.emitActivity=cb; return () => {}},
};
let browserListener=()=>{};
let browserTabs=[];
window.browserWorkspace={
 list:async()=>({tabs:browserTabs,selectedId:null}),
 create:async()=>{const tab={id:'test',title:'New tab',url:'about:blank',loading:false,canGoBack:false,canGoForward:false};browserTabs=[tab];browserListener({tabs:browserTabs,selectedId:'test',focusId:'test'});return tab},
 navigate:async(id,address)=>{window.browserAddress=address},
 close:async()=>{browserTabs=[];browserListener({tabs:[],selectedId:null})},
 present:async(id,bounds)=>{window.browserBounds=bounds},action:async()=>{},onChanged:cb=>{browserListener=cb;return()=>{}},onFocusAddress:()=>()=>{}
};
function Fixture(){const [artifact,setArtifact]=React.useState(null); window.showGenerated=()=>setArtifact({code:'print("Hello")',language:'python',title:'Example code'}); return <div className="glass-app"><WorkspaceBar rightOpen terminalOpen={false} onToggleNav={()=>{}} onToggleRight={()=>{}} onToggleTerminal={()=>{}} /><div className="glass-workspace"><ChatSidebar items={[{id:'demo',title:'Sample question',description:'Thinking through your request…'}]} activeId="demo" running={true} computerUseSessionIds={new Set()} settingsOpen={false} onNewSession={()=>{}} onOpenSession={()=>{}} onChatContextMenu={()=>{}} onToggleSettings={()=>{}} /><main className="glass-main">Chat stays beside the project.<TurnBody turn={{id:"answer",role:"assistant",text:"A sourced answer [1](https://example.org/fact).\\n\\n<!-- web-sources -->\\n- [Example fact](https://example.org/fact)"}} query="Sample question"/></main><ProjectWorkspace visible artifact={artifact} onClose={()=>{}} width={fitPanelWidth(570,window.innerWidth,296)} onResize={()=>{}} /></div></div>}; createRoot(document.getElementById('root')).render(<Fixture/>);
`
const server = await createServer({
    configFile: false,
    resolve: { alias: { '@shared': resolve('src/shared'), '@op-shared': resolve('src/main/operator/shared') } },
    plugins: [react(), {
        name: 'workspace-smoke-fixture',
        resolveId(id) { if (id === '/__workspace-smoke.tsx') return entry },
        load(id) { if (id === entry) return fixture },
        configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
                if (req.url !== '/workspace-smoke.html') return next()
                res.setHeader('Content-Type', 'text/html')
                res.end(await server.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/__workspace-smoke.tsx"></script></body></html>'))
            })
        }
    }],
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error'
})
let browser
try {
    await server.listen()
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    const page = await browser.newPage({ viewport: {width:1440,height:900} })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${server.resolvedUrls.local[0]}workspace-smoke.html`)
    await page.getByRole('status', {name:'Task running'}).waitFor()
    await page.evaluate(()=>{window.glass.toggleWindowMaximize=async()=>{window.zoomed=(window.zoomed||0)+1};window.glass.moveWindow=async()=>{}})
    await page.locator('.workspace-bar').dblclick({position:{x:400,y:20}})
    assert.equal(await page.evaluate(()=>window.zoomed),1)
    await page.locator('.web-sources summary').click()
    await page.getByRole('link',{name:'Example fact example.org',exact:false}).waitFor()
    assert.equal(await page.locator('.web-sources__icon').count(),0)
    assert.equal(await page.locator('.web-sources summary').evaluate(node=>getComputedStyle(node.parentElement).borderTopWidth),'0px')
    const source=page.locator('.web-sources a').first()
    await source.hover()
    assert.equal(await source.evaluate(node=>getComputedStyle(node).textDecorationLine),'none')
    assert.equal(await source.evaluate(node=>getComputedStyle(node).backgroundColor),await page.locator('.glass-history__item--selected').evaluate(node=>getComputedStyle(node).backgroundColor))
    assert.equal(await page.locator('.glass-main a').count(),1)
    await page.locator('.web-sources summary').click()
    const chatBox=await page.locator('.glass-main').boundingBox()
    assert.ok(chatBox.width>=400)
    assert.equal(await page.locator('.glass-history__item-description').count(),0)
    const dot = page.locator('.glass-history__running-dot')
    assert.equal(await dot.evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(41, 98, 205)')
    const titleBox = await page.locator('.glass-history__item-title').boundingBox()
    const dotBox = await dot.boundingBox()
    assert.ok(dotBox.x > titleBox.x + titleBox.width)
    assert.equal(await page.getByRole('navigation',{name:'Project files'}).count(),0)
    await page.evaluate(()=>window.showGenerated())
    await page.getByRole('tab',{name:'Example code'}).waitFor()
    assert.equal(await page.getByRole('navigation',{name:'Project files'}).count(),0)
    assert.equal(await page.getByRole('button',{name:'Toggle files tree'}).count(),0)
    await page.getByRole('button',{name:'Close Example code'}).click()
    await page.getByRole('button',{name:'Add workspace tab'}).click()
    await page.getByRole('menuitem').filter({hasText:'Files'}).click()
    await page.getByRole('navigation',{name:'Project files'}).waitFor()
    await page.evaluate(()=>{document.documentElement.dataset.theme='light'})
    await page.screenshot({path:resolve(tmpdir(),'codex-lite-restored-light.png')})
    await page.getByTitle('src', {exact:true}).click()
    await page.getByTitle('src/main.ts', {exact:true}).click()
    await page.locator('.monaco-editor textarea').waitFor()
    assert.equal(await page.locator('.monaco-editor').first().evaluate(node => getComputedStyle(node).outlineStyle),'none')
    assert.equal(await page.locator('.monaco-editor .scrollbar.vertical').first().evaluate(node => getComputedStyle(node).width), '6px')
    assert.equal(await page.locator('.monaco-editor .scrollbar.vertical .slider').first().evaluate(node => getComputedStyle(node).borderRadius), '999px')
    await page.locator('.monaco-editor textarea').focus()
    await page.keyboard.press('Meta+End')
    await page.keyboard.type('// saved from workspace')
    await page.waitForFunction(() => window.saved?.includes('saved from workspace'))
    const countBefore = await page.getByRole('tab').count()
    await page.getByTitle('README.md', {exact:true}).click()
    await page.getByRole('navigation', {name:'File breadcrumb'}).getByText('README.md').waitFor()
    assert.equal(await page.getByRole('tab').count(), countBefore)
    await page.getByTitle('src/main.ts', {exact:true}).click()
    await page.getByRole('navigation', {name:'File breadcrumb'}).getByText('main.ts').waitFor()
    const treeBox = await page.getByRole('navigation', {name:'Project files'}).boundingBox()
    const editorBox = await page.locator('.project-editor').boundingBox()
    assert.ok(treeBox.x >= editorBox.x + editorBox.width - 1)
    await page.getByLabel('Filter loaded files').focus()
    assert.equal(await page.getByLabel('Filter loaded files').evaluate(node => getComputedStyle(node).outlineStyle), 'none')
    assert.equal(await page.getByLabel('Filter loaded files').evaluate(node => node.getBoundingClientRect().height), 28)
    const screenshot = resolve(tmpdir(), 'computer-browser-workspace.png')
    await page.screenshot({path:screenshot})
    await page.getByRole('button',{name:'Add workspace tab'}).click()
    await page.getByRole('menuitem').filter({hasText:'Terminal'}).click()
    await page.getByLabel('Project terminal command').fill('pwd')
    await page.getByLabel('Project terminal command').press('Enter')
    await page.getByText('workspace-terminal-ok',{exact:false}).waitFor()
    await page.getByRole('button',{name:'Add workspace tab'}).click()
    await page.getByRole('menuitem').filter({hasText:'Browser'}).click()
    await page.getByLabel('Search or enter a URL').fill('youtube.com')
    await page.getByRole('button',{name:'Go to address'}).click()
    await page.waitForFunction(()=>window.browserAddress==='youtube.com')
    await page.waitForFunction(()=>window.browserBounds !== null && window.browserBounds !== undefined)
    await page.evaluate(() => { const menu=document.createElement('div'); menu.id='account-menu-fixture'; menu.setAttribute('role','menu'); menu.style.cssText='position:fixed;left:0;top:0;width:100px;height:100px'; document.body.append(menu) })
    await page.waitForTimeout(100)
    assert.notEqual(await page.evaluate(()=>window.browserBounds),null)
    await page.evaluate(() => document.getElementById('account-menu-fixture').remove())
    assert.equal(await page.locator('iframe').count(),0)
    assert.equal(await page.getByRole('navigation',{name:'Project files'}).count(),0)
    await page.getByRole('button',{name:'Add workspace tab'}).click()
    assert.equal(await page.getByRole('menuitem').filter({hasText:'Files'}).locator('svg').count(),1)
    await page.getByRole('menuitem').filter({hasText:'Files'}).click()
    await page.getByRole('navigation',{name:'Project files'}).waitFor()
    assert.equal(await page.getByRole('button',{name:'Toggle files',exact:true}).count(),0)
    assert.equal(await page.getByRole('button',{name:'Refresh files',exact:true}).count(),0)
    await page.getByRole('button',{name:'Toggle files tree',exact:true}).click()
    assert.equal(await page.getByRole('navigation',{name:'Project files'}).count(),0)
    await page.getByRole('button',{name:'Toggle files tree',exact:true}).click()
    await page.getByRole('navigation',{name:'Project files'}).waitFor()
    await page.evaluate(() => window.emitActivity({running:true,message:'Creating rocket scene'}))
    await page.getByRole('button',{name:'Stop',exact:true}).click()
    assert.equal(await page.evaluate(() => window.stopped),true)
    assert.equal(await page.getByRole('button', {name:'Upgrade',exact:true}).count(),0)
    assert.deepEqual(errors,[])
    await page.evaluate(() => {
        const el=document.createElement('div'); el.id='follow-test'; el.style.cssText='position:fixed;left:0;top:0;width:100px;height:100px;overflow:auto';
        el.textContent='line '.repeat(300); document.body.append(el); window.testFollow(el);
    })
    await page.waitForFunction(()=>{const el=document.getElementById('follow-test');return el.scrollHeight-el.clientHeight-el.scrollTop<2})
    await page.evaluate(()=>document.getElementById('follow-test').append(' more text '.repeat(300)))
    await page.waitForFunction(()=>{const el=document.getElementById('follow-test');return el.scrollHeight-el.clientHeight-el.scrollTop<2})
    await page.evaluate(()=>{const el=document.getElementById('follow-test');el.dispatchEvent(new WheelEvent('wheel',{deltaY:-100}));el.scrollTop=0})
    await page.waitForTimeout(50)
    await page.evaluate(()=>document.getElementById('follow-test').append(' more text '.repeat(300)))
    await page.waitForTimeout(100)
    assert.equal(await page.evaluate(()=>document.getElementById('follow-test').scrollTop),0)
    console.log(`Workspace smoke passed: tree, editor, save, terminal tab, embedded browser controls, Stop. Screenshot: ${screenshot}`)
} finally {
    await browser?.close()
    await server.close()
}
