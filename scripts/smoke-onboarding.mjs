// In-memory UI fixtures only: no email, real accounts, microphone or system prompts.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

const entry = resolve('scripts/__onboarding-smoke.tsx')
const fixture = `
import React from 'react'; import { createRoot } from 'react-dom/client';
import { FirstRunOnboarding } from '/src/renderer/sidebar/FirstRunOnboarding';
import '/src/renderer/sidebar/styles.css';
const state={accounts:[],activeId:null,onboardingComplete:false,auth:{state:'signed-out'},microphone:false,accessibility:false};
window.calls=[]; let notify=()=>{}; let loginCount=0;
window.glass={
 onGitHubAuthChanged:()=>()=>{}, onAccountChanged:cb=>{notify=cb;return()=>{}},
 accountAuth:async request=>{
  window.calls.push(request.action);
  if(request.action==='status' && window.holdFirstStatus) {
   window.holdFirstStatus=false;
   await new Promise(resolve=>{window.releaseInitialStatus=resolve});
  }
  switch(request.action) {
   case 'google': state.googlePending=true;notify({...state});break;
   case 'cancel-login':state.googlePending=false;break;
   case 'google-poll':
    const email=++loginCount===1?'one@example.com':'two@example.com';
    const id='google-'+email;
    state.accounts=[...state.accounts.filter(a=>a.id!==id),{id,email,name:email,provider:'google',expired:false}];
    state.activeId=id; state.googlePending=false;state.auth={state:'signed-in',user:{login:email,name:email}}; notify({...state}); break;
   case 'switch': state.activeId=request.id; state.auth={state:'signed-in',user:{login:state.accounts.find(a=>a.id===request.id).email}}; notify({...state});break;
   case 'microphone': state.microphone=true;break;
   case 'accessibility': state.accessibility=true;break;
   case 'complete':state.onboardingComplete=true;break;
  }
  return {...state,accounts:[...state.accounts]}
 }
};
function Fixture(){const [open,setOpen]=React.useState(false);return <><button onClick={()=>setOpen(true)}>Open accounts</button><FirstRunOnboarding openRequested={open} onDismiss={()=>setOpen(false)} onAuth={()=>{}} onVisible={value=>{window.onboardingVisible=value}}/></>}
createRoot(document.getElementById('root')).render(<Fixture/>);
`
const server=await createServer({
 configFile:false,resolve:{alias:{'@shared':resolve('src/shared'),'@op-shared':resolve('src/main/operator/shared')}},
 plugins:[react(),{
  name:'onboarding-smoke',resolveId(id){if(id==='/__onboarding-smoke.tsx')return entry},
  load(id){if(id===entry)return fixture},
  configureServer(server){server.middlewares.use(async(req,res,next)=>{
   if(req.url!=='/onboarding-smoke.html')return next();
   res.setHeader('Content-Type','text/html');
   res.end(await server.transformIndexHtml(req.url,'<html><body><div id="root"></div><script type="module" src="/__onboarding-smoke.tsx"></script></body></html>'));
  })}
 }],server:{host:'127.0.0.1',port:0},logLevel:'error'
})
let browser
try {
 await server.listen()
 browser=await chromium.launch({headless:true,channel:'chrome'})
 const page=await browser.newPage({viewport:{width:1280,height:850}})
 const errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.addInitScript(()=>{window.holdFirstStatus=true})
 await page.goto(server.resolvedUrls.local[0]+'onboarding-smoke.html')
 await page.getByRole('heading',{name:'Welcome to Codex Lite'}).waitFor()
 assert.equal(await page.getByRole('button',{name:'Back',exact:true}).count(),0)
 await page.waitForFunction(()=>typeof window.releaseInitialStatus==='function')
 await page.evaluate(()=>window.releaseInitialStatus())
 const google=page.getByRole('button',{name:'Continue with Google',exact:true})
 await google.waitFor()
 assert.equal(await page.getByRole('heading').innerText(),'Log in or create an account')
 assert.equal(await page.getByRole('textbox').count(),0)
 assert.equal(await page.getByRole('button',{name:'Continue with GitHub',exact:true}).count(),1)
 assert.equal(await google.evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(41, 98, 205)')
 assert.equal(await page.locator('.onboarding h1').evaluate(n=>getComputedStyle(n).color),'rgb(17, 17, 18)')
 assert.equal(await page.getByRole('button',{name:'Back',exact:true}).count(),0)
 assert.equal(await page.locator('.onboarding p').first().evaluate(n=>getComputedStyle(n).color),'rgb(105, 107, 110)')
 assert.equal(await page.locator('.onboarding p').first().evaluate(n=>getComputedStyle(n).fontSize),'13px')
 assert.equal(await page.locator('.onboarding p').first().evaluate(n=>getComputedStyle(n).marginTop),'8px')
 assert.equal(await google.evaluate(n=>getComputedStyle(n).fontSize),'16px')
 assert.equal(await google.evaluate(n=>n.getBoundingClientRect().height),44)
 assert.equal(await google.evaluate(n=>n.getBoundingClientRect().width),390)
 assert.equal(await page.locator('.onboarding__ball').evaluate(n=>getComputedStyle(n).animationName),'onboarding-roll')
 assert.equal(await page.evaluate(()=>window.calls.includes('microphone')),false)
 await page.screenshot({path:resolve(tmpdir(),'codex-onboarding-login.png')})
 await google.click()
 await page.getByRole('heading',{name:'Continue with Google',exact:true}).waitFor()
 await page.getByRole('button',{name:'Reopen Google'}).click()
 await page.getByRole('button',{name:'Back',exact:true}).click()
 await google.waitFor()
 await google.click()
 await page.getByRole('heading',{name:'Choose an account to continue'}).waitFor()
 assert.equal(await page.locator('.onboarding__back svg').getAttribute('stroke-width'),'1.25')
 assert.equal(await page.locator('.onboarding__back svg').evaluate(n=>n.getBoundingClientRect().width),24)
 assert.equal(await page.locator('.onboarding__back svg').evaluate(n=>getComputedStyle(n).strokeWidth),'1.25px')
 assert.equal(await page.locator('.onboarding__back').evaluate(n=>getComputedStyle(n).backgroundColor),'rgba(0, 0, 0, 0)')
 assert.equal(await page.locator('.onboarding__back').evaluate(n=>getComputedStyle(n).boxShadow),'none')
 await page.getByRole('button',{name:'Add another account'}).click()
 await google.click()
 await page.getByRole('heading',{name:'Choose an account to continue'}).waitFor()
 assert.equal(await page.locator('.onboarding__account').count(),2)
 assert.equal(await page.locator('.onboarding__account').first().evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(236, 236, 236)')
 await page.screenshot({path:resolve(tmpdir(),'codex-onboarding-accounts.png')})
 await page.getByRole('button',{name:'one@example.com',exact:false}).click()
 await page.getByRole('heading',{name:'Enable dictation'}).waitFor()
 assert.equal(await page.evaluate(()=>window.calls.includes('microphone')),false)
 await page.getByRole('button',{name:'Allow',exact:true}).click()
 await page.screenshot({path:resolve(tmpdir(),'codex-onboarding-accounts.png')})
 await page.getByRole('button',{name:'one@example.com',exact:false}).click()
 await page.getByRole('heading',{name:'Enable dictation'}).waitFor()
 assert.equal(await page.locator('.onboarding__back svg').evaluate(n=>n.getBoundingClientRect().width),24)
 assert.equal(await page.locator('.onboarding__back').evaluate(n=>getComputedStyle(n).backgroundColor),'rgba(0, 0, 0, 0)')
 assert.equal(await page.locator('.onboarding__back').evaluate(n=>getComputedStyle(n).boxShadow),'none')
 assert.equal(await page.evaluate(()=>window.calls.includes('microphone')),false)
 await page.getByRole('button',{name:'Allow',exact:true}).click()
 assert.equal(await page.locator('.onboarding__account-chooser p').evaluate(n=>getComputedStyle(n).color),'rgb(105, 107, 110)')
 assert.equal(await page.locator('.onboarding__account small').first().evaluate(n=>getComputedStyle(n).color),'rgb(105, 107, 110)')
 assert.equal(await page.locator('.onboarding__account small').first().evaluate(n=>getComputedStyle(n).marginTop),'2px')
 assert.equal(await page.locator('.onboarding__account-chevron').first().getAttribute('stroke-width'),'1.5')
 assert.equal(await page.locator('.onboarding__account-chooser h1').evaluate(n=>n.getBoundingClientRect().width),270)
 await page.getByText('Accessibility',{exact:true}).waitFor()
 assert.equal(await page.getByLabel('Microphone allowed').count(),1)
 await page.getByRole('button',{name:'Allow',exact:true}).click()
 await page.getByLabel('Accessibility allowed').waitFor()
 await page.screenshot({path:resolve(tmpdir(),'codex-onboarding-permissions.png')})
 await page.getByRole('button',{name:'Continue',exact:true}).click()
 await page.waitForFunction(()=>!window.onboardingVisible)
 await page.getByRole('button',{name:'Open accounts'}).click()
 await page.getByRole('button',{name:'two@example.com',exact:false}).click()
 await page.waitForFunction(()=>!window.onboardingVisible)
 assert.deepEqual(errors,[])
 // A fresh small window can skip both permission requests.
 const small=await browser.newPage({viewport:{width:700,height:650}})
 await small.goto(server.resolvedUrls.local[0]+'onboarding-smoke.html')
 await small.getByRole('button',{name:'Continue with Google',exact:true}).click()
 await small.getByRole('button',{name:'one@example.com',exact:false}).click()
 await small.getByRole('button',{name:'Skip',exact:true}).click()
 await small.getByRole('button',{name:'Continue',exact:true}).click()
 await small.waitForFunction(()=>!window.onboardingVisible)
 assert.equal(await small.evaluate(()=>window.calls.some(a=>a==='microphone'||a==='accessibility')),false)
 console.log('Onboarding smoke passed: Google and GitHub buttons, browser handoff, cancellation, multiple accounts, switching and optional permissions.')
} finally {await browser?.close();await server.close()}
