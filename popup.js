const $=id=>document.getElementById(id);
const VERSION='1.0.30';
const SETTINGS_KEY='continueSettings';
const SETTINGS_DEFAULTS={continueWithoutDownload:true};
const els={
  statusText:$('statusText'),cycleText:$('cycleText'),targetCountText:$('targetCountText'),tabTargetCount:$('tabTargetCount'),
  continueText:$('continueText'),delaySeconds:$('delaySeconds'),maxCycles:$('maxCycles'),continueWithoutDownload:$('continueWithoutDownload'),
  startButton:$('startButton'),stopButton:$('stopButton'),refreshButton:$('refreshButton'),clearConsoleButton:$('clearConsoleButton'),
  currentTabButton:$('currentTabButton'),manageTabButton:$('manageTabButton'),optionsTabButton:$('optionsTabButton'),consoleTabButton:$('consoleTabButton'),
  currentPanel:$('currentPanel'),managePanel:$('managePanel'),optionsPanel:$('optionsPanel'),consolePanel:$('consolePanel'),
  pageList:$('pageList'),consoleOutput:$('consoleOutput')
};
const DEFAULTS={
  enabled:false,targetOrigin:'',targetPath:'',targetTabId:0,continueText:'继续',delaySeconds:3,maxCycles:100,cycleCount:0,
  continueWithoutDownload:true,lastStatus:'未启动',lastHandledMessageKey:'',lastBackfillMessageKey:'',pendingContinueKey:'',pendingContinueAt:0,
  pendingContinueMode:'',downloadRetryKey:'',downloadRetryCount:0,downloadRetryAt:0,logs:[]
};
let renderPagesPromise=null;
let uiLogs=[];
let currentState={...DEFAULTS};
let currentTabId=0;
let settings={...SETTINGS_DEFAULTS};

function syncPanelHeightFromCurrent(){
  // 以“当前页”的自然内容高度作为四个页面共同高度；控制台/列表只在内部滚动。
  const root=document.documentElement;
  root.classList.remove('panel-height-synced');
  root.style.removeProperty('--panel-height');
  requestAnimationFrame(()=>{
    if(!els.currentPanel.classList.contains('active'))return;
    const h=Math.ceil(els.currentPanel.getBoundingClientRect().height);
    if(h>0){
      root.style.setProperty('--panel-height',`${h}px`);
      root.classList.add('panel-height-synced');
    }
  });
}

function localLog(text,level='info'){
  const entry={at:Date.now(),level,text:String(text||'')};
  const last=uiLogs.at(-1);
  if(last?.text===entry.text&&last?.level===entry.level&&entry.at-last.at<1800)return;
  uiLogs.push(entry);uiLogs=uiLogs.slice(-20);renderConsole();
}
function supported(url=''){return url.startsWith('https://chatgpt.com/')||url.startsWith('https://chat.openai.com/')||/^https:\/\/[^/]+\.chatgpt\.com\//.test(url)}
function hasConcreteConversationPath(url=''){
  try{return /(?:^|\/)c\/[^/?#]{8,}\/?$/i.test(new URL(url).pathname)}catch{return false}
}
function supervisable(info,url=''){
  if(!info?.ok||info.explicitMissing)return false;
  if(info.isConcrete)return true;
  if(info.messageCount>=1&&info.assistantCount>=1&&info.hasComposer&&info.inMain)return true;
  // A /c/<conversation-id> route is already a concrete conversation. Current ChatGPT builds
  // can temporarily remove or rename private message-role attributes while rendering/thinking,
  // so accept the route when the page's conversation surface is present.
  return !!((info.hasConcretePath||hasConcreteConversationPath(url))&&(info.hasMain||info.hasComposer||info.hasConversation||info.messageCount>=1));
}
function shortPath(url=''){
  try{const u=new URL(url),p=u.pathname,m=p.match(/\/c\/([^/?#]+)/i);return m?`对话 ${m[1].slice(0,8)}…`:(p||'/')}catch{return ''}
}
function formatTime(at){
  if(!at)return '--:--:--';
  return new Date(at).toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
function renderConsole(){
  const persisted=Array.isArray(currentState.logs)?currentState.logs:[];
  const merged=[...persisted,...uiLogs].sort((a,b)=>Number(a.at||0)-Number(b.at||0)).slice(-80);
  els.consoleOutput.replaceChildren();
  if(!merged.length){const e=document.createElement('div');e.className='console-empty';e.textContent='等待输出…';els.consoleOutput.append(e);return}
  for(const line of merged){
    const row=document.createElement('div');row.className=`console-line ${line.level||'info'}`;
    const time=document.createElement('span');time.className='console-time';time.textContent=formatTime(line.at);
    const prefix=document.createElement('span');prefix.className='console-prefix';prefix.textContent=line.level==='error'?'×':line.level==='warn'?'!':'›';
    const text=document.createElement('span');text.className='console-text';text.textContent=line.text||'';
    row.append(time,prefix,text);els.consoleOutput.append(row);
  }
  els.consoleOutput.scrollTop=els.consoleOutput.scrollHeight;
}
function setPanel(name){
  const map={current:[els.currentPanel,els.currentTabButton],manage:[els.managePanel,els.manageTabButton],options:[els.optionsPanel,els.optionsTabButton],console:[els.consolePanel,els.consoleTabButton]};
  for(const [key,[panel,button]] of Object.entries(map)){
    const active=key===name;
    panel.hidden=!active;panel.classList.toggle('active',active);
    button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));
  }
  if(name==='manage')renderPages();
  if(name==='console')renderConsole();
}
async function currentTab(){const [t]=await chrome.tabs.query({active:true,currentWindow:true});return t}
async function getTarget(tabId){try{return await chrome.runtime.sendMessage({type:'CONTINUE_GET_TARGET',tabId})}catch{return null}}
async function pingContinue(tabId){try{return await chrome.tabs.sendMessage(tabId,{type:'CONTINUE_PING'})}catch{return null}}
async function pageInfo(tabId){try{return await chrome.tabs.sendMessage(tabId,{type:'CONTINUE_PAGE_INFO'})}catch{return null}}

async function readSettings(){
  const obj=await chrome.storage.local.get({[SETTINGS_KEY]:SETTINGS_DEFAULTS});
  settings={...SETTINGS_DEFAULTS,...(obj[SETTINGS_KEY]||{})};
  els.continueWithoutDownload.checked=settings.continueWithoutDownload!==false;
  return settings;
}
async function saveSettings(){
  settings={...settings,continueWithoutDownload:!!els.continueWithoutDownload.checked};
  await chrome.storage.local.set({[SETTINGS_KEY]:settings});
  const res=await chrome.runtime.sendMessage({type:'CONTINUE_APPLY_SETTINGS',settings}).catch(()=>null);
  if(!res?.ok)throw new Error(res?.error||'选项保存失败');
  localLog(settings.continueWithoutDownload?'已开启：文件下载未确认时也继续':'已开启严格下载模式：发现文件后需确认下载才继续；无文件回复仍会继续');
}

async function ensureContinue(tabId){
  const first=await pingContinue(tabId);
  if(first?.ok&&first.version===VERSION)return true;
  if(first?.ok&&first.version&&first.version!==VERSION)throw new Error(`该页面仍运行旧版监督脚本 v${first.version}。更新扩展后请刷新这个对话页。`);
  try{await chrome.scripting.executeScript({target:{tabId},files:['continue.js']})}
  catch(e){throw new Error(`监督脚本注入失败：${e?.message||e}`)}
  for(let i=0;i<10;i++){
    await new Promise(r=>setTimeout(r,100));
    const ping=await pingContinue(tabId);
    if(ping?.ok&&ping.version===VERSION)return true;
  }
  throw new Error(`v${VERSION} 监督脚本没有响应，请刷新该 ChatGPT 对话页后再试。`);
}

function configFor(tabId,info,url,title=''){
  const u=new URL(url),now=Date.now();
  const allowUnconfirmed=settings.continueWithoutDownload!==false;
  return {
    enabled:true,targetOrigin:info.origin||u.origin,targetPath:info.path||u.pathname,targetTabId:tabId,
    continueText:(els.continueText.value||'继续').trim()||'继续',
    delaySeconds:Math.max(1,Math.min(60,Number(els.delaySeconds.value)||3)),
    maxCycles:Math.max(1,Math.min(500,Number(els.maxCycles.value)||100)),
    continueWithoutDownload:allowUnconfirmed,
    cycleCount:0,lastHandledMessageKey:'',lastBackfillMessageKey:'',pendingContinueKey:'',pendingContinueAt:0,pendingContinueMode:'',
    downloadRetryKey:'',downloadRetryCount:0,downloadRetryAt:0,lastStatus:'等待新文件',
    logs:[
      {at:now,level:'info',text:`监督已启动${title?` · ${title}`:''}`},
      {at:now+1,level:'info',text:allowUnconfirmed?'规则：回复完成后会先尝试下载；没有文件或下载未确认时也会继续续作':'规则：无文件回复会正常续作；发现文件时，确认下载成功后才续作'}
    ]
  };
}

async function startTab(t,{quiet=false}={}){
  if(!t?.id||!t.url||!supported(t.url))throw new Error('这不是可监督的 ChatGPT 页面');
  await ensureContinue(t.id);
  const info=await pageInfo(t.id);
  if(!info?.ok)throw new Error('无法读取该页面状态');
  if(info.explicitMissing)throw new Error('这个对话已经删除或不存在');
  if(!supervisable(info,t.url))throw new Error('该页面不是可监督的具体对话');
  const res=await chrome.runtime.sendMessage({type:'CONTINUE_START_TARGET',tabId:t.id,state:configFor(t.id,info,t.url,t.title||shortPath(t.url))});
  if(!res?.ok)throw new Error(res?.error||'无法创建监督任务');
  await chrome.tabs.sendMessage(t.id,{type:'CONTINUE_REFRESH'}).catch(()=>{});
  if(!quiet)localLog('启动命令已提交');
  return res;
}

async function stopTab(tabId,_title='',{quiet=false}={}){
  const res=await chrome.runtime.sendMessage({type:'CONTINUE_STOP_TARGET',tabId,reason:'手动取消监督'}).catch(()=>null);
  if(!res?.ok)throw new Error(res?.error||'取消监督失败');
  await chrome.tabs.sendMessage(tabId,{type:'CONTINUE_REFRESH'}).catch(()=>{});
  if(!quiet)localLog('取消命令已提交');
  return res;
}

async function readCurrent(){
  const t=await currentTab();currentTabId=t?.id||0;
  const res=t?.id?await getTarget(t.id):null;
  const s={...DEFAULTS,...(res?.state||{})};currentState=s;
  const active=!!res?.state?.enabled,count=res?.activeCount||0;
  els.statusText.textContent=active?(s.lastStatus||'监督中'):(supported(t?.url||'')?'未监督':'非 ChatGPT 对话');
  els.cycleText.textContent=`${s.cycleCount||0} / ${s.maxCycles||100}`;
  els.targetCountText.textContent=String(count);els.tabTargetCount.textContent=String(count);
  if(active){els.continueText.value=s.continueText||'继续';els.delaySeconds.value=s.delaySeconds||3;els.maxCycles.value=s.maxCycles||100}
  els.stopButton.disabled=!active;els.startButton.disabled=active||!supported(t?.url||'');
  renderConsole();
}

async function collectPages(){
  const tabs=(await chrome.tabs.query({})).filter(t=>t?.id&&supported(t.url||''));
  const current=await currentTab(),rows=[];
  for(const t of tabs){
    const [res,info]=await Promise.all([getTarget(t.id),pageInfo(t.id)]),state=res?.state||null,enabled=!!state?.enabled;
    const concrete=supervisable(info,t.url);
    if(!concrete&&!enabled)continue;
    rows.push({t,state,enabled,concrete,current:t.id===current?.id});
  }
  return rows.sort((a,b)=>Number(b.enabled)-Number(a.enabled)||Number(b.current)-Number(a.current)||(a.t.title||'').localeCompare(b.t.title||''));
}

function rowEl(row){
  const item=document.createElement('div');item.className=`page-item${row.current?' current':''}`;
  const main=document.createElement('div');main.className='page-main';
  const title=document.createElement('div');title.className='page-title';title.textContent=row.t.title||shortPath(row.t.url);
  const status=document.createElement('div');status.className='page-status';
  if(row.current){const current=document.createElement('span');current.className='badge current';current.textContent='当前页';status.appendChild(current)}
  const badge=document.createElement('span');badge.className=`badge ${row.enabled?'on':'off'}`;badge.textContent=row.enabled?'监督中':'未监督';status.appendChild(badge);
  status.append(document.createTextNode(row.enabled?`${row.state?.cycleCount||0}/${row.state?.maxCycles||100} · ${row.state?.lastStatus||'监督中'}`:'可单独开启'));
  main.append(title,status);
  const btn=document.createElement('button');btn.className=`page-action ${row.enabled?'on':'off'}`;btn.textContent=row.enabled?'取消':'监督';btn.disabled=!row.enabled&&!row.concrete;
  btn.addEventListener('click',async()=>{
    btn.disabled=true;
    try{if(row.enabled)await stopTab(row.t.id,row.t.title);else await startTab(row.t);await refreshAll()}
    catch(e){localLog(e?.message||'操作失败','error');btn.disabled=false}
  });
  item.append(main,btn);return item;
}

function renderPages(){
  if(renderPagesPromise)return renderPagesPromise;
  renderPagesPromise=(async()=>{
    const rows=await collectPages();els.pageList.replaceChildren();
    if(!rows.length){const e=document.createElement('div');e.className='empty';e.textContent='没有可管理的 ChatGPT 对话页';els.pageList.append(e);return}
    for(const row of rows)els.pageList.append(rowEl(row));
  })().finally(()=>{renderPagesPromise=null});
  return renderPagesPromise;
}
async function refreshAll(){await readCurrent();if(els.managePanel.classList.contains('active'))await renderPages();await readCurrent()}

async function runButtonAction(button,action){
  button.disabled=true;
  try{await action()}
  catch(e){localLog(e?.message||'操作失败','error')}
  finally{await readCurrent().catch(()=>{button.disabled=false})}
}

els.currentTabButton.addEventListener('click',()=>{setPanel('current');syncPanelHeightFromCurrent()});
els.manageTabButton.addEventListener('click',()=>setPanel('manage'));
els.optionsTabButton.addEventListener('click',()=>setPanel('options'));
els.consoleTabButton.addEventListener('click',()=>setPanel('console'));
els.startButton.addEventListener('click',()=>runButtonAction(els.startButton,async()=>{const t=await currentTab();await startTab(t);await refreshAll()}));
els.stopButton.addEventListener('click',()=>runButtonAction(els.stopButton,async()=>{const t=await currentTab();if(!t?.id)throw new Error('无法确定当前标签页');await stopTab(t.id,t.title);await refreshAll()}));
els.refreshButton.addEventListener('click',async()=>{els.refreshButton.disabled=true;try{await renderPages();await readCurrent();localLog('页面列表已刷新')}finally{els.refreshButton.disabled=false}});
els.continueWithoutDownload.addEventListener('change',async()=>{
  els.continueWithoutDownload.disabled=true;
  try{await saveSettings();await readCurrent()}catch(e){localLog(e?.message||'选项保存失败','error');await readSettings()}
  finally{els.continueWithoutDownload.disabled=false}
});
els.clearConsoleButton.addEventListener('click',async()=>{
  uiLogs=[];
  if(currentTabId){await chrome.runtime.sendMessage({type:'CONTINUE_CLEAR_LOGS',tabId:currentTabId}).catch(()=>{});currentState={...currentState,logs:[]}}
  renderConsole();
});
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area!=='local')return;
  if(changes[SETTINGS_KEY])readSettings().catch(()=>{});
  readCurrent();if(els.managePanel.classList.contains('active'))renderPages();
});
chrome.tabs.onRemoved.addListener(()=>{readCurrent();if(els.managePanel.classList.contains('active'))renderPages()});
chrome.tabs.onUpdated.addListener(()=>{readCurrent();if(els.managePanel.classList.contains('active'))renderPages()});

(async()=>{
  await readSettings().catch(()=>{});
  setPanel('current');
  await readCurrent();
  syncPanelHeightFromCurrent();
})();
