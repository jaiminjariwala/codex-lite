// Real React hook with synthetic audio and a fake recognizer. No mic or downloads.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {useSmoothDictation} from '/src/renderer/voice-lib-v2/useSmoothDictation';
window.micCalls=0;window.trackStops=0;window.resumeCalls=0;window.requests=[];
window.Worker=class {
 postMessage(message){window.requests.push(message);setTimeout(()=>this.onmessage?.({data:{id:message.id,ready:message.kind==='prepare',text:message.audio?.length>20000?'Hello from microphone':'Hello'}}),80)}
 terminate(){}
};
Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{
 window.micCalls++;return {getTracks:()=>[{stop:()=>window.trackStops++}]};
}}});
window.AudioContext=class {
 sampleRate=16000;state='running';destination={};
 resume(){window.resumeCalls++;return Promise.resolve()}
 close(){this.state='closed';return Promise.resolve()}
 createMediaStreamSource(){return {connect(){},disconnect(){}}}
 createScriptProcessor(){const processor={connect(){},disconnect(){},onaudioprocess:null};window.feedAudio=()=>processor.onaudioprocess?.({inputBuffer:{getChannelData:()=>new Float32Array(16000).fill(.1)}});return processor}
};
function Fixture(){
 const [text,setText]=React.useState('');const ref=React.useRef(text);ref.current=text;
 const dictation=useSmoothDictation({getText:()=>ref.current,setText,onError:message=>window.voiceError=message});
 return <><textarea value={text} readOnly placeholder={dictation.listening?'Listening…':'Message Codex Lite…'}/><button onClick={dictation.toggle}>{dictation.listening?'Stop':'Mic'}</button><button onClick={dictation.cancel}>Cancel</button></>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`
const server = await createServer({configFile:false,resolve:{alias:{'@shared':resolve('src/shared'),'@op-shared':resolve('src/main/operator/shared')}},plugins:[react(),{
 name:'dictation-fixture',resolveId:id=>id==='/voice-fixture.tsx'?'/voice-fixture.tsx':null,
 load:id=>id==='/voice-fixture.tsx'?fixture:null,
 configureServer(server){server.middlewares.use(async(req,res,next)=>{
  if(req.url!=='/voice.html')return next();res.setHeader('Content-Type','text/html');
  res.end(await server.transformIndexHtml(req.url,'<div id="root"></div><script type="module" src="/voice-fixture.tsx"></script>'));
 })}
}],server:{host:'127.0.0.1',port:0},logLevel:'error'})
let browser
try {
 await server.listen();browser=await chromium.launch({headless:true,channel:'chrome'})
 const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message))
 await page.goto(server.resolvedUrls.local[0]+'voice.html')
 await page.waitForFunction(()=>window.requests.length===1)
 assert.equal(await page.evaluate(()=>window.requests[0].kind),'prepare')
 assert.equal(await page.evaluate(()=>window.micCalls),0)
 await page.getByRole('button',{name:'Mic',exact:true}).click()
 await page.getByPlaceholder('Listening…').waitFor()
 await page.evaluate(()=>window.feedAudio())
 await page.waitForFunction(()=>document.querySelector('textarea').value==='Hello')
 await page.evaluate(()=>window.feedAudio())
 await page.getByRole('button',{name:'Stop',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('textarea').value==='Hello from microphone')
 assert.equal(await page.evaluate(()=>window.trackStops),1)
 assert.equal(await page.evaluate(()=>window.resumeCalls),1)
 await page.getByRole('button',{name:'Mic',exact:true}).click()
 await page.getByPlaceholder('Listening…').waitFor()
 await page.evaluate(()=>window.feedAudio())
 await page.waitForFunction(()=>window.requests.length>=4)
 await page.getByRole('button',{name:'Cancel',exact:true}).click()
 await page.waitForTimeout(250)
 assert.equal(await page.locator('textarea').inputValue(),'')
 assert.equal(await page.evaluate(()=>window.trackStops),2)
 assert.equal(await page.evaluate(()=>window.voiceError),undefined)
 assert.deepEqual(errors,[])
 console.log('Dictation smoke passed: silent startup preparation, Listening placeholder, final words, mic release, stale-result cancellation.')
} finally {await browser?.close();await server.close()}
