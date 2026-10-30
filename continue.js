(()=>{
if(window.__CHATGPT_AUTO_CONTINUE_CONTINUE_V1030__)return;
window.__CHATGPT_AUTO_CONTINUE_CONTINUE_V1030__=true;

const VERSION='1.0.30';
const D={
  enabled:false,targetOrigin:"",targetPath:"",targetTabId:0,continueText:"继续",delaySeconds:3,maxCycles:100,continueWithoutDownload:true,
  cycleCount:0,lastHandledMessageKey:"",lastBackfillMessageKey:"",lastStatus:"未启动",pendingContinueKey:"",pendingContinueAt:0,
  pendingContinueMode:"",downloadRetryKey:"",downloadRetryCount:0,downloadRetryAt:0,logs:[]
};
const DONE=[/研究状态[:：]\s*(?:全书现有正文覆盖完成|全书覆盖完成|已完成全书覆盖)/i,/全书研究完成/i,/全书完成验收(?:通过|完成)/i,/全部章节(?:均已|已)完成归属/i];
const STOP=[/已达到此对话的长度上限/i,/reached (?:the )?conversation.*limit/i,/something went wrong/i,/出现(?:了)?错误/i];
const SETTLE_SAMPLE_MS=850;
const GENERATION_END_GRACE_MS=1400;
const PASSIVE_FOLLOW_MIN_GAP_MS=700;
const PASSIVE_BOTTOM_THRESHOLD_PX=360;
const HOVER_DISCOVERY_MS=1250;
const PREVIEW_DISCOVERY_MS=9000;
const PREVIEW_CLOSE_DISCOVERY_MS=1200;
const DOWNLOAD_CONFIRM_MS=2400;
const DOWNLOAD_LATE_CONFIRM_MS=15000;
const DOWNLOAD_LATE_POLL_MS=450;
const MAX_DOWNLOAD_TARGETS=12;
const FILE_GROUP_EXPAND_MS=1800;
const MAX_FILE_GROUP_EXPAND_PASSES=4;
const MAX_FILE_DOWNLOAD_PASSES=2;
const DOWNLOAD_RETRY_DELAY_MS=4000;
const MAX_DOWNLOAD_RETRIES=8;
const DOWNLOAD_RETRY_SLOW_MS=30000;
const FILE_EXT_RE=/\.(?:pdf|zip|docx?|xlsx?|pptx?|txt|md|csv|json|rtf|odt|ods|odp|epub|html?|xml|yaml|yml|py|js|ts|tsx|jsx|java|c|cpp|h|hpp|go|rs|sql|ipynb|png|jpe?g|gif|webp|svg|mp3|wav|m4a|mp4|mov|webm)(?:\b|(?=[?#&/]))/i;
const FILE_NAME_RE=/([^\s<>:"'|?*\\/]+\.(?:pdf|zip|docx?|xlsx?|pptx?|txt|md|csv|json|rtf|odt|ods|odp|epub|html?|xml|yaml|yml|py|js|ts|tsx|jsx|java|c|cpp|h|hpp|go|rs|sql|ipynb|png|jpe?g|gif|webp|svg|mp3|wav|m4a|mp4|mov|webm))/i;
const DOWNLOAD_CTA_NOUN_RE=/(?:\b(?:zip|pdf|docx?|xlsx?|pptx?|txt|md|csv|json|epub|png|jpe?g|gif|webp|svg|mp3|wav|mp4|mov|webm)\b|插件|扩展|压缩包|文件|附件|文档|表格|演示|图片|图像|音频|视频|源码|代码|package|plugin|extension|archive|file|attachment|document|spreadsheet|presentation|image|audio|video|source)/i;
let s={...D},busy=false,timer=null,timerDue=0,followTimer=null,invalidSince=0,generationQuietSince=0,lastPassiveFollowAt=0;
const downloadProgressByMessage=new Map();

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const clean=x=>String(x||"").replace(/\u00a0/g," ").replace(/\r\n?/g,"\n").trim();
const rect=el=>{try{return el.getBoundingClientRect()}catch{return {width:0,height:0,left:0,right:0,top:0,bottom:0}}};
const rendered=el=>{if(!el||!el.isConnected)return false;const st=getComputedStyle(el);const r=rect(el);return st.display!=="none"&&st.visibility!=="hidden"&&r.width>0&&r.height>0};
// opacity:0 is intentionally NOT rejected. ChatGPT often keeps hover-only icon buttons in layout and merely fades them out.
const clickableBox=el=>{if(!el||!el.isConnected)return false;const st=getComputedStyle(el);const r=rect(el);return st.display!=="none"&&st.visibility!=="hidden"&&r.width>0&&r.height>0};
const matchPath=()=>location.origin===s.targetOrigin&&location.pathname===s.targetPath;

const TURN_SELECTOR='[data-testid^="conversation-turn-"],[data-turn-id]';
const ROLE_SELECTOR='[data-message-author-role],[data-turn-role],[data-author-role],[data-turn="assistant"],[data-turn="user"],[data-author="assistant"],[data-author="user"],[data-role="assistant"],[data-role="user"]';

function normalizedRole(value){
  const v=clean(value).toLowerCase();
  if(v==='assistant'||v==='agent'||v==='chatgpt')return 'assistant';
  if(v==='user'||v==='human')return 'user';
  return '';
}

// ChatGPT has used several role markers over time. Resolve the semantic role from the
// message node, its conversation-turn wrapper, or strong descendants instead of tying
// supervision to one private DOM attribute.
function messageRole(node){
  if(!node)return '';
  const attrs=['data-message-author-role','data-turn-role','data-author-role','data-turn','data-author','data-role'];
  const readAttrs=el=>{
    for(const name of attrs){
      const role=normalizedRole(el?.getAttribute?.(name));
      if(role)return role;
    }
    return '';
  };
  let role=readAttrs(node);
  if(role)return role;
  const turn=node.closest?.(TURN_SELECTOR);
  role=readAttrs(turn);
  if(role)return role;
  const root=turn||node;
  const marked=root.querySelector?.(ROLE_SELECTOR);
  role=readAttrs(marked);
  if(role)return role;

  if(root.querySelector?.('[data-testid="assistant-message"],[data-testid*="assistant-message" i],[class*="agent-turn"]'))return 'assistant';
  if(root.querySelector?.('[data-testid="user-message"],[data-testid*="user-message" i],[class*="user-message"]'))return 'user';

  // Last-resort compatibility for builds which keep conversation-turn wrappers but remove
  // role data attributes. User bubbles are identified first; markdown/prose is a strong
  // assistant signal in ChatGPT's conversation stream.
  if(root.matches?.('[class*="user-message"]')||root.querySelector?.('[class*="user-message-bubble"]'))return 'user';
  if(root.querySelector?.('.markdown,.prose,[data-testid*="markdown" i]'))return 'assistant';
  return '';
}

// Do not restrict message discovery to the current viewport. Long conversations can be scrolled elsewhere.
function msgs(){
  const turns=[...document.querySelectorAll(TURN_SELECTOR)];
  const result=[],covered=new Set();
  for(const turn of turns){
    const marked=turn.querySelector?.(ROLE_SELECTOR);
    const node=marked&&messageRole(marked)?marked:turn;
    if(!messageRole(node))continue;
    result.push(node);covered.add(turn);
  }
  for(const node of document.querySelectorAll(ROLE_SELECTOR)){
    const turn=node.closest?.(TURN_SELECTOR);
    if((turn&&covered.has(turn))||!messageRole(node))continue;
    result.push(node);
  }
  return result.sort((a,b)=>{
    if(a===b)return 0;
    const pos=a.compareDocumentPosition(b);
    return pos&Node.DOCUMENT_POSITION_FOLLOWING?-1:pos&Node.DOCUMENT_POSITION_PRECEDING?1:0;
  }).filter((x,i,a)=>a.indexOf(x)===i);
}
const lastAssistant=()=>msgs().filter(x=>messageRole(x)==='assistant').at(-1)||null;
const lastRole=()=>messageRole(msgs().at(-1));

// ChatGPT can render generated-file cards/media as siblings of [data-message-author-role]
// inside the same conversation turn. Always scan the complete turn wrapper when possible.
function assistantTurnRoot(messageNode){
  if(!messageNode)return null;
  const turn=messageNode.closest?.(TURN_SELECTOR);
  if(turn&&turn.contains(messageNode))return turn;
  const article=messageNode.closest?.('article');
  if(article&&article.contains(messageNode))return article;
  return messageNode;
}

function stopButton(){
  const selectors=[
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop generating" i]',
    'button[aria-label*="Stop response" i]',
    'button[aria-label*="停止生成"]',
    'button[aria-label*="停止回复"]'
  ];
  for(const q of selectors){
    const el=[...document.querySelectorAll(q)].find(rendered);
    if(el)return el;
  }
  return null;
}
const generating=()=>!!stopButton();

function key(m){
  const id=m?.getAttribute('data-message-id')||m?.closest('[data-message-id]')?.getAttribute('data-message-id');
  const turn=m?.closest?.(TURN_SELECTOR);
  const turnId=turn?.getAttribute?.('data-turn-id')||turn?.getAttribute?.('data-testid');
  // A conversation-turn id is already stable and unique inside the locked chat. Do not
  // append innerText: expanding a grouped file card changes the text and would otherwise
  // make this same assistant reply look new, causing duplicate downloads/continuations.
  return id?`m:${id}`:turnId?`a:${turnId}`:`t:${clean(m?.innerText).slice(0,220)}`;
}
function text(m){
  const md=[...m.querySelectorAll('.markdown')].map(x=>x.innerText||'').filter(Boolean).join('\n');
  return clean(md||m.innerText);
}
function assistantSignature(){
  const m=lastAssistant();
  if(!m)return '';
  const tx=text(m);
  return `${key(m)}|${tx.length}|${tx.slice(-500)}`;
}

async function patchState(patch={}){
  s={...s,...patch};
  const res=await chrome.runtime.sendMessage({type:'CONTINUE_PATCH_TARGET',patch}).catch(()=>null);
  if(!res?.ok)throw new Error(res?.error||'无法保存当前监督页状态');
  if(res.state)s={...D,...res.state};
  return s;
}
function withLog(text,level="info"){
  const now=Date.now();
  const logs=Array.isArray(s.logs)?s.logs.slice(-79):[];
  const last=logs.at(-1);
  if(last?.text===text&&last?.level===level&&now-Number(last.at||0)<2500)return logs;
  logs.push({at:now,level,text:String(text||"")});
  return logs.slice(-80);
}
async function status(x,extra={},level="info"){
  const patch={lastStatus:x,...extra};
  const stateChanged=Object.entries(patch).some(([k,v])=>s[k]!==v);
  if(!stateChanged)return s;
  if(s.lastStatus!==x)patch.logs=withLog(x,level);
  return patchState(patch);
}
async function stop(reason){
  s.enabled=false;s.pendingContinueKey="";s.pendingContinueAt=0;s.pendingContinueMode="";s.lastStatus=reason;
  await chrome.runtime.sendMessage({type:'CONTINUE_STOP_SELF',reason}).catch(()=>null);
}

async function targetGate(){
  try{
    return await chrome.runtime.sendMessage({type:'CONTINUE_IS_TARGET',url:location.href});
  }catch{
    return {ok:false,isTarget:false};
  }
}

// Based on the exporter plug-in's safer strategy: the conversation scroller must contain the newest message.
// This prevents an open file preview panel or the left navigation from becoming the chosen scroll target.
function isConversationScroller(el,anchor){
  if(!el||!anchor||!el.isConnected||!el.contains(anchor))return false;
  try{
    const st=getComputedStyle(el);
    const range=el.scrollHeight-el.clientHeight;
    if(!/auto|scroll|overlay/.test(st.overflowY||'')||range<=40)return false;
    const isRoot=el===document.scrollingElement||el===document.documentElement||el===document.body;
    if(isRoot)return true;
    const r=rect(el);
    return r.width>=Math.max(420,window.innerWidth*0.36);
  }catch{return false}
}
function findScrollContainer(seed){
  const anchor=seed||msgs().at(-1)||document.querySelector('main');
  let el=anchor;
  while(el&&el!==document.documentElement){
    if(isConversationScroller(el,anchor))return el;
    el=el.parentElement;
  }
  const roots=[document.scrollingElement,document.documentElement,document.body].filter(Boolean);
  for(const root of roots){
    if(root.contains?.(anchor)&&root.scrollHeight>root.clientHeight+40)return root;
  }
  return document.scrollingElement||document.documentElement;
}
function scrollToBottomButton(){
  const selectors=[
    '[data-testid="scroll-to-bottom-button"]',
    'button[aria-label*="scroll to bottom" i]',
    'button[aria-label*="jump to bottom" i]',
    'button[aria-label*="latest" i]',
    'button[aria-label*="底部"]',
    'button[aria-label*="最新"]'
  ];
  for(const q of selectors){
    const b=[...document.querySelectorAll(q)].find(x=>rendered(x)&&!x.closest('nav,[role="navigation"]'));
    if(b)return b;
  }
  return null;
}
function isRootScroller(sc){
  return sc===document.scrollingElement||sc===document.documentElement||sc===document.body;
}
function scrollBottomGap(sc){
  try{
    if(!sc)return Infinity;
    if(isRootScroller(sc)){
      const height=Math.max(document.body?.scrollHeight||0,document.documentElement?.scrollHeight||0);
      return Math.max(0,height-(window.scrollY+window.innerHeight));
    }
    return Math.max(0,sc.scrollHeight-sc.clientHeight-sc.scrollTop);
  }catch{return Infinity}
}
function setScrollerToBottom(sc){
  try{
    if(!sc)return false;
    if(isRootScroller(sc)){
      window.scrollTo({top:Math.max(document.body?.scrollHeight||0,document.documentElement?.scrollHeight||0),behavior:'auto'});
    }else{
      sc.scrollTop=sc.scrollHeight;
      sc.dispatchEvent(new Event('scroll',{bubbles:true}));
    }
    return true;
  }catch{return false}
}
async function scrollConversationToBottom(rounds=3){
  for(let i=0;i<rounds;i++){
    const latestMessage=msgs().at(-1)||document.querySelector('main');
    const latestTurn=messageRole(latestMessage)==='assistant'?(assistantTurnRoot(latestMessage)||latestMessage):latestMessage;
    const sc=findScrollContainer(latestTurn||latestMessage);
    setScrollerToBottom(sc);
    await sleep(120);
    // Only use ChatGPT's own jump-to-bottom control as a fallback. Repeatedly combining
    // scrollIntoView + button.click + scrollTop caused visible up/down oscillation.
    if(scrollBottomGap(sc)>120){
      try{scrollToBottomButton()?.click()}catch{}
      await sleep(140);
      setScrollerToBottom(sc);
    }
  }
}

function passiveFollowBottom(){
  if(!s.enabled||!matchPath()||!generating())return false;
  const latestMessage=msgs().at(-1)||document.querySelector('main');
  const latestTurn=messageRole(latestMessage)==='assistant'?(assistantTurnRoot(latestMessage)||latestMessage):latestMessage;
  const sc=findScrollContainer(latestTurn||latestMessage);
  // Respect manual reading: only keep following if the user is already near the bottom.
  // A single direct scroll is intentionally used here—no scrollIntoView and no button click.
  if(scrollBottomGap(sc)>PASSIVE_BOTTOM_THRESHOLD_PX)return false;
  const moved=setScrollerToBottom(sc);
  if(moved)lastPassiveFollowAt=Date.now();
  return moved;
}

function forbiddenNavigationContext(el){
  if(!el)return false;
  if(el.closest?.('nav,[role="navigation"],[data-testid*="sidebar" i],[data-testid*="navigation" i],[data-testid*="history" i]'))return true;
  const href=clean(el.closest?.('a[href]')?.getAttribute?.('href')||el.getAttribute?.('href'));
  return /(?:^|\/)library(?:\/|$|[?#])/i.test(href);
}
function descriptor(el){
  const aria=clean(el?.getAttribute?.('aria-label'));
  const title=clean(el?.getAttribute?.('title'));
  const testid=clean(el?.getAttribute?.('data-testid'));
  const name=clean(el?.getAttribute?.('name'));
  const text=clean(el?.innerText||el?.textContent).slice(0,180);
  const href=clean(el?.getAttribute?.('href'));
  return {aria,title,testid,name,text,href,all:[aria,title,testid,name,text,href].join(' ')};
}
function conversationPositionControl(el){
  if(!el)return false;
  const ctl=el.closest?.('button,a,[role="button"],[role="link"],[tabindex]')||el;
  const d=descriptor(ctl);
  const low=clean(`${d.aria} ${d.title} ${d.testid} ${d.name} ${d.text}`).toLowerCase();
  if(/scroll[-_ ]?to[-_ ]?bottom|jump[-_ ]?to[-_ ]?bottom|scroll[-_ ]?down|jump[-_ ]?down|latest[-_ ]?message|go[-_ ]?to[-_ ]?latest/.test(low))return true;
  if(/(?:回到|滚动到|跳到|定位到).{0,6}(?:底部|最新)|(?:底部|最新).{0,6}(?:消息|位置)/.test(low))return true;
  try{if(scrollToBottomButton()===ctl)return true}catch{}
  return false;
}
function svgDownloadGlyphScore(el){
  const svg=el?.matches?.('svg')?el:el?.querySelector?.('svg');
  if(!svg)return 0;
  let n=0;
  const attrs=clean([
    svg.getAttribute?.('data-lucide'),svg.getAttribute?.('data-icon'),svg.getAttribute?.('aria-label'),
    svg.getAttribute?.('class'),svg.getAttribute?.('data-testid'),el?.getAttribute?.('class')
  ].join(' ')).toLowerCase();
  if(/download|arrow[-_ ]?down[-_ ]?to[-_ ]?line|arrow[-_ ]?down[-_ ]?tray|save/.test(attrs))n+=340;
  // Common Lucide-style Download glyph: downward arrow plus a lower tray.  This is only
  // treated as strong evidence inside a file card / preview; generic down chevrons alone do not match.
  const html=String(svg.outerHTML||'').toLowerCase().replace(/\s+/g,' ');
  const hasArrow=(/points=["'][^"']*7 10 12 15 17 10/.test(html)||/m?12[^>]{0,90}(?:15|16)[^>]{0,90}(?:3|4)/.test(html)||/m?7[^>]{0,90}10[^>]{0,90}12[^>]{0,90}15[^>]{0,90}17[^>]{0,90}10/.test(html));
  const hasTray=(/m?21[^>]{0,80}15[^>]{0,120}(?:v4|19|21)/.test(html)||/m?3[^>]{0,80}15[^>]{0,120}(?:v4|19|21)/.test(html)||/h5[^>]{0,120}h19/.test(html));
  if(hasArrow&&hasTray)n+=260;
  return n;
}
function closeControlEvidence(el){
  const d=descriptor(el);const low=d.all.toLowerCase();
  if(/^(?:close|关闭|dismiss|取消)(?:\b|$)/i.test(clean(`${d.aria} ${d.title} ${d.text}`)))return true;
  if(/close|dismiss/.test(d.testid.toLowerCase()))return true;
  const svg=el?.querySelector?.('svg');
  const html=String(svg?.outerHTML||'').toLowerCase().replace(/\s+/g,' ');
  const diagonalA=/(?:x1=["']?18[^>]+y1=["']?6[^>]+x2=["']?6[^>]+y2=["']?18|m\s*18[ ,]+6(?:\s*l)?[ ,]+6[ ,]+18|m\s*18[ ,]+6(?:\s*l)?[ ,]+-?12[ ,]+12)/.test(html);
  const diagonalB=/(?:x1=["']?6[^>]+y1=["']?6[^>]+x2=["']?18[^>]+y2=["']?18|m\s*6[ ,]+6(?:\s*l)?[ ,]+18[ ,]+18|m\s*6[ ,]+6(?:\s*l)?[ ,]+12[ ,]+12)/.test(html);
  return diagonalA&&diagonalB;
}
function explicitDownloadScore(el,{panel=false,allowHidden=false}={}){
  if(!el?.isConnected||forbiddenNavigationContext(el)||conversationPositionControl(el))return -9999;
  if(!allowHidden&&!clickableBox(el))return -9999;
  if(el.disabled||el.getAttribute?.('aria-disabled')==='true')return -9999;
  const d=descriptor(el);
  const low=d.all.toLowerCase();
  let n=0;
  n+=svgDownloadGlyphScore(el);
  if(/^(?:download|下载)(?:\b|文件|附件|此文件| file| attachment|$)/i.test(d.aria))n+=360;
  if(/^(?:download|下载)(?:\b|文件|附件|此文件| file| attachment|$)/i.test(d.title))n+=340;
  if(/download-file|file-download|download_button|download-button|downloadattachment|attachment-download/.test(d.testid.toLowerCase()))n+=320;
  if(/download/.test(d.name.toLowerCase()))n+=260;
  if(el.matches?.('a[download]'))n+=360;
  if(/^(?:download|下载)(?:文件|附件)?$/i.test(d.text))n+=230;
  if(el.querySelector?.('[data-testid*="download" i],[aria-label*="download" i],[aria-label*="下载" i]'))n+=180;
  if(/preview|预览|open|打开|menu|更多|more|ellipsis|overflow|share|分享|copy|复制|close|关闭|project|项目|history|历史|writing|写作/.test(low))n-=260;
  if(closeControlEvidence(el))n-=900;
  if(panel){
    const r=rect(el);
    if(r.left>window.innerWidth*0.50)n+=120;
    if(el.closest?.('[role="dialog"],[aria-modal="true"]'))n+=100;
  }
  return n;
}
function explicitDownloadControls(root=document,{panel=false,allowHidden=false}={}){
  const selectors='button,a,[role="button"],[role="link"],[tabindex]';
  return [...root.querySelectorAll(selectors)]
    .map(el=>({el,n:explicitDownloadScore(el,{panel,allowHidden})}))
    .filter(x=>x.n>=220)
    .sort((a,b)=>b.n-a.n||rect(b.el).left-rect(a.el).left);
}
async function downloadsSince(since,ms=1800,names=[]){
  const end=Date.now()+ms;
  // Browser download events can be timestamped a few hundred ms before the page click callback
  // returns. A small look-back prevents a real download from falling through that race window.
  const querySince=Math.max(0,Number(since||0)-650);
  while(Date.now()<end){
    const res=await chrome.runtime.sendMessage({type:'DOWNLOADS_SINCE',since:querySince,names:Array.isArray(names)?names:[]}).catch(()=>null);
    if(res?.matches?.length)return res.matches;
    await sleep(170);
  }
  return [];
}

async function suppressNativeDownloadUi(durationMs=4200){
  try{
    const res=await chrome.runtime.sendMessage({type:'CONTINUE_SUPPRESS_DOWNLOAD_UI',durationMs});
    return !!res?.ok;
  }catch{return false}
}

function newDownloadUiBatchToken(){
  try{return crypto.randomUUID()}catch{return `${Date.now()}-${Math.random().toString(36).slice(2)}`}
}

async function beginNativeDownloadUiBatch(){
  const token=newDownloadUiBatchToken();
  try{
    const res=await chrome.runtime.sendMessage({type:'CONTINUE_BEGIN_DOWNLOAD_UI_BATCH',token});
    if(res?.token===token){
      if(!res?.ok)console.warn('[AutoContinueContinue] Edge 下载面板接口本次未确认，批次结束时仍会执行安全恢复',res?.error||'未知错误');
      if(res?.warning)console.warn('[AutoContinueContinue] Edge 下载面板恢复兜底暂不可用',res.warning);
      return token;
    }
    console.warn('[AutoContinueContinue] 无法建立 Edge 下载面板关闭批次',res?.error||'未知错误');
  }catch(e){
    console.warn('[AutoContinueContinue] 无法持续关闭 Edge 下载面板',e);
  }
  return '';
}

async function endNativeDownloadUiBatch(token){
  if(!token)return;
  try{
    const res=await chrome.runtime.sendMessage({type:'CONTINUE_END_DOWNLOAD_UI_BATCH',token});
    if(!res?.ok)console.warn('[AutoContinueContinue] 无法恢复 Edge 下载面板状态',res?.error||'未知错误');
    if(res?.warning)console.warn('[AutoContinueContinue] Edge 下载面板恢复兜底暂不可用',res.warning);
  }catch(e){
    console.warn('[AutoContinueContinue] 无法恢复 Edge 下载面板状态',e);
  }
}

async function lateConfirmDownload(messageKey,since,expectedCount=1,names=[]){
  if(!messageKey||!since)return;
  const end=Date.now()+DOWNLOAD_LATE_CONFIRM_MS;
  const querySince=Math.max(0,Number(since)-900);
  while(Date.now()<end){
    // Prefer a filename-correlated match when the generated file name is known.
    let res=null;
    if(Array.isArray(names)&&names.length){
      res=await chrome.runtime.sendMessage({type:'DOWNLOADS_SINCE',since:querySince,names}).catch(()=>null);
    }
    // Some ChatGPT downloads are served from opaque/UUID URLs and Chrome may expose a
    // browser-renamed filename. Fall back to a tightly bounded time-window match.
    if(!res?.matches?.length){
      res=await chrome.runtime.sendMessage({type:'DOWNLOADS_SINCE',since:querySince,names:[]}).catch(()=>null);
    }
    if(res?.matches?.length){
      await chrome.runtime.sendMessage({
        type:'CONTINUE_LATE_DOWNLOAD_CONFIRMED',
        messageKey,
        expectedCount:Math.max(1,Number(expectedCount)||1),
        matches:res.matches.slice(0,12)
      }).catch(()=>null);
      return;
    }
    await sleep(DOWNLOAD_LATE_POLL_MS);
  }
}
async function clickAndCheckDownload(el,waitMs=1900){
  if(!el?.isConnected)return {clicked:false,downloaded:false,matches:[]};
  await suppressNativeDownloadUi(Math.max(4200,waitMs+1400));
  const since=Date.now()-80;
  try{
    el.click();
  }catch{
    return {clicked:false,downloaded:false,matches:[]};
  }
  const matches=await downloadsSince(since,waitMs);
  return {clicked:true,downloaded:matches.length>0,matches};
}

// Synthetic hover does not move the physical mouse, but it DOES trigger React/onPointer
// handlers in ChatGPT builds that lazily mount file-action buttons only after hover.
// CSS-only opacity hover buttons are already handled by clickableBox + programmatic click.
function dispatchSyntheticHover(el){
  if(!el?.isConnected)return;
  const r=rect(el);
  const clientX=Math.max(0,Math.min(window.innerWidth-1,r.left+Math.max(1,r.width/2)));
  const clientY=Math.max(0,Math.min(window.innerHeight-1,r.top+Math.max(1,r.height/2)));
  const base={bubbles:true,cancelable:true,composed:true,clientX,clientY,screenX:clientX,screenY:clientY,buttons:0};
  for(const type of ['pointerover','pointerenter','pointermove']){
    try{
      const E=window.PointerEvent||window.MouseEvent;
      el.dispatchEvent(new E(type,{...base,pointerId:1,pointerType:'mouse',isPrimary:true}));
    }catch{}
  }
  for(const type of ['mouseover','mouseenter','mousemove']){
    try{el.dispatchEvent(new MouseEvent(type,{...base,view:window}))}catch{}
  }
}

function compactUnique(nodes){
  const out=[];
  for(const el of nodes||[]){
    if(!el?.isConnected||out.includes(el)||forbiddenNavigationContext(el))continue;
    const r=rect(el);
    if(r.width<=0||r.height<=0)continue;
    out.push(el);
  }
  return out;
}

async function waitForFinder(finder,timeout=1200){
  const first=finder();
  if(first)return first;
  return await new Promise(resolve=>{
    let done=false;
    const finish=v=>{if(done)return;done=true;try{obs.disconnect()}catch{};clearInterval(iv);clearTimeout(to);resolve(v||null)};
    const probe=()=>{try{const v=finder();if(v)finish(v)}catch{}};
    const obs=new MutationObserver(probe);
    try{obs.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style','aria-label','title','data-testid','role','href','download']})}catch{}
    const iv=setInterval(probe,90);
    const to=setTimeout(()=>finish(null),Math.max(100,timeout));
  });
}

async function hoverScopesAndFind(scopes,finder,perScopeMs=HOVER_DISCOVERY_MS){
  for(const scope of compactUnique(scopes)){
    dispatchSyntheticHover(scope);
    const found=await waitForFinder(finder,perScopeMs);
    if(found)return found;
  }
  return finder()||null;
}

function downloadMenuScore(el,expectedFilename=''){
  if(!rendered(el)||forbiddenNavigationContext(el))return -9999;
  const d=descriptor(el);
  const label=clean(`${d.text} ${d.aria} ${d.title}`).toLowerCase();
  if(!label||label.length>220)return -9999;
  const expected=clean(expectedFilename).toLowerCase();
  const ext=(expected.match(/\.([a-z0-9]{1,8})$/i)?.[1]||'').toLowerCase();
  let n=0;
  if(expected&&label.includes(expected))n+=520;
  if(ext&&new RegExp(`(?:^|[^a-z0-9])\\.?${ext}(?:[^a-z0-9]|$)`,'i').test(label))n+=360;
  if(/download|下载|save|保存|original|原文件|原始/.test(label))n+=180;
  if(/open|打开|preview|预览|share|分享|copy|复制|delete|删除|rename|重命名|library|文件库/.test(label))n-=400;
  const inMenu=!!el.closest?.('[role="menu"],[role="listbox"],[data-radix-menu-content],[data-headlessui-state="open"]');
  if(inMenu)n+=150;
  return n;
}
function downloadMenuCandidates(expectedFilename=''){
  const roots=[...document.querySelectorAll('[role="menu"],[role="listbox"],[data-radix-menu-content],[data-headlessui-state="open"]')].filter(rendered);
  const items=[];
  for(const root of roots){
    for(const el of root.querySelectorAll('button,a,[role="menuitem"],[role="option"],[role="button"],[role="link"]')){
      const n=downloadMenuScore(el,expectedFilename);
      if(n>=300)items.push({el,n});
    }
  }
  return items.sort((a,b)=>b.n-a.n);
}

async function clickDownloadControlWithMenu(el,expectedFilename='',waitMs=DOWNLOAD_CONFIRM_MS){
  if(!el?.isConnected)return {clicked:false,downloaded:false,matches:[],menu:false};
  await suppressNativeDownloadUi(Math.max(4200,waitMs+1600));
  const beforePath=`${location.origin}${location.pathname}`;
  const since=Date.now()-80;
  try{
    el.click();
  }catch{return {clicked:false,downloaded:false,matches:[],menu:false}}

  let early=await downloadsSince(since,Math.min(1100,waitMs),expectedFilename?[expectedFilename]:[]);
  if(!early.length&&expectedFilename)early=await downloadsSince(since,220,[]);
  if(early.length)return {clicked:true,downloaded:true,matches:early,menu:false};
  if(`${location.origin}${location.pathname}`!==beforePath)return {clicked:true,downloaded:false,matches:[],menu:false,navigated:true};

  // Some download glyphs open a format/action menu instead of starting the transfer.
  const menuItem=await waitForFinder(()=>downloadMenuCandidates(expectedFilename)[0]?.el,900);
  if(menuItem){
    await suppressNativeDownloadUi(Math.max(4200,waitMs+1600));
    const menuSince=Date.now()-80;
    try{menuItem.click()}catch{}
    let menuDl=await downloadsSince(menuSince,waitMs,expectedFilename?[expectedFilename]:[]);
    if(!menuDl.length&&expectedFilename)menuDl=await downloadsSince(menuSince,260,[]);
    return {clicked:true,downloaded:menuDl.length>0,matches:menuDl,menu:true};
  }
  let late=await downloadsSince(since,Math.max(300,waitMs-1100),expectedFilename?[expectedFilename]:[]);
  if(!late.length&&expectedFilename)late=await downloadsSince(since,260,[]);
  return {clicked:true,downloaded:late.length>0,matches:late,menu:false};
}

function decoded(x){try{return decodeURIComponent(String(x||''))}catch{return String(x||'')}}
function extractFilename(value){
  const m=decoded(value).match(FILE_NAME_RE);
  return clean(m?.[1]||'').toLowerCase();
}
function likelyFileHref(href=''){
  const h=decoded(href);
  if(!h)return false;
  return FILE_EXT_RE.test(h)||/^(?:sandbox:|blob:)/i.test(h)||/\/(?:backend-api\/)?files\//i.test(h)||/backend-api\/estuary\/content/i.test(h)||/files\/download/i.test(h)||/attachment/i.test(h)||/file-service:/i.test(h);
}
function looksLikeDownloadCta(el){
  if(!el||forbiddenNavigationContext(el))return false;
  const d=descriptor(el);
  const label=clean(`${d.text} ${d.aria} ${d.title}`).replace(/\s+/g,' ');
  if(!label||label.length>220)return false;
  const starts=/^(?:下载|download)(?:\s|[:：-]|$)/i.test(label);
  if(!starts)return false;
  // ChatGPT's generated-file link may be a React button/link with no useful href at all.
  // Require an artifact/file noun (or a file-like href) so ordinary prose containing “下载” is not clicked.
  return DOWNLOAD_CTA_NOUN_RE.test(label)||FILE_EXT_RE.test(label)||likelyFileHref(d.href);
}
function actionableForFile(el){
  if(!el||!el.isConnected||forbiddenNavigationContext(el))return false;
  if(el.matches?.('a[href],a,[role="link"],button,[role="button"],[tabindex]'))return true;
  try{return getComputedStyle(el).cursor==='pointer'}catch{return false}
}
function normalizeFileTarget(seed,root){
  if(!seed||!root?.contains(seed))return null;
  const direct=seed.closest?.('a[href],a,[role="link"],button,[role="button"],[tabindex]');
  if(direct&&root.contains(direct)&&!forbiddenNavigationContext(direct))return direct;
  const descendants=[...seed.querySelectorAll?.('a[href],a,[role="link"],button,[role="button"],[tabindex]')||[]]
    .filter(el=>root.contains(el)&&actionableForFile(el)&&!forbiddenNavigationContext(el));
  const contained=descendants
    .map(el=>{
      const d=descriptor(el);const href=decoded(d.href||'');
      let n=0;
      if(extractFilename(`${d.text} ${href} ${d.aria} ${d.title}`))n+=420;
      if(likelyFileHref(href))n+=260;
      if(explicitDownloadScore(el,{allowHidden:true})>=220)n+=120;
      return {el,n};
    })
    .sort((a,b)=>b.n-a.n)[0]?.el;
  if(contained)return contained;
  let el=seed;
  for(let i=0;i<6&&el&&el!==root;i++,el=el.parentElement){
    if(!root.contains(el))break;
    const r=rect(el);
    const tx=clean(el.innerText||el.textContent);
    if(r.width>=100&&r.height>=24&&r.height<=170&&tx.length<=320&&actionableForFile(el))return el;
  }
  return null;
}
function fileTargetIdentity(el,index=0){
  const d=descriptor(el);
  const href=decoded(d.href||el.closest?.('a[href]')?.getAttribute('href')||'');
  const filename=extractFilename(`${d.text} ${href} ${d.aria} ${d.title}`);
  if(filename)return `name:${filename}`;
  if(href)return `href:${href.toLowerCase()}`;
  const testid=d.testid.toLowerCase();
  if(testid)return `testid:${testid}:${clean(d.text).slice(0,100).toLowerCase()}`;
  return `text:${clean(d.text).slice(0,140).toLowerCase()}:${index}`;
}
function fileTargetScore(el){
  if(!el||!clickableBox(el)||!actionableForFile(el)||forbiddenNavigationContext(el))return -9999;
  const d=descriptor(el);
  const href=decoded(d.href||'');
  const low=d.all.toLowerCase();
  let n=0;
  if(likelyFileHref(href))n+=360;
  if(looksLikeDownloadCta(el))n+=380;
  if(extractFilename(`${d.text} ${href} ${d.aria} ${d.title}`))n+=300;
  if(/file|attachment|文件|附件/.test(d.testid.toLowerCase()))n+=260;
  if(/file|attachment|文件|附件|文档/.test(`${d.aria} ${d.title}`.toLowerCase()))n+=140;
  if(el.matches?.('a[href]'))n+=80;
  else if(el.matches?.('a,[role="link"]'))n+=55;
  if(/source|citation|引用|来源|网页|website/.test(low)&&!FILE_EXT_RE.test(`${d.text} ${href}`))n-=260;
  if(/copy|复制|share|分享|more|更多|regenerate|重新生成|edit|编辑|thumb|反馈/.test(low))n-=300;
  if(/^https?:/i.test(href)&&!FILE_EXT_RE.test(href)&&!/(?:chatgpt\.com|openai\.com)\//i.test(href))n-=260;
  return n;
}
function fileCardPreference(el){
  if(!el)return -9999;
  const d=descriptor(el);
  const href=decoded(d.href||el.closest?.('a[href]')?.getAttribute?.('href')||'');
  const filename=extractFilename(`${d.text} ${href} ${d.aria} ${d.title}`);
  const genericCta=looksLikeDownloadCta(el);
  let n=0;

  // A named file card is the safest scope for locating ChatGPT's row-level hover download
  // button. Generic prose CTAs often sit above that card and open the preview instead.
  if(filename)n+=420;
  if(likelyFileHref(href))n+=260;
  if(el.matches?.('[data-testid*="file" i],[data-testid*="attachment" i]')||el.closest?.('[data-testid*="file" i],[data-testid*="attachment" i]'))n+=260;
  if(filename&&!genericCta)n+=220;
  if(actionableForFile(el))n+=360;
  else n-=360;
  if(genericCta)n-=360;
  return n;
}
function discoverFileTargets(root){
  const seeds=[];
  const add=x=>{if(x&&root.contains(x)&&!seeds.includes(x))seeds.push(x)};

  for(const a of root.querySelectorAll('a[href],a,[role="link"]')){
    const d=descriptor(a);
    if(likelyFileHref(d.href)||FILE_EXT_RE.test(`${d.text} ${d.aria} ${d.title}`)||looksLikeDownloadCta(a))add(a);
  }
  // Current ChatGPT builds can render generated-artifact links as React buttons/role=button
  // with a human label such as “下载 v1.0.11 插件 ZIP”, but without a file-like href.
  for(const el of root.querySelectorAll('button,[role="button"],[tabindex]')){
    if(looksLikeDownloadCta(el))add(el);
  }
  for(const el of root.querySelectorAll('[data-testid*="file" i],[data-testid*="attachment" i]')){
    // A bare download icon is a control, not a separate file identity. It will be discovered inside its file row or by the legacy fallback.
    if(explicitDownloadScore(el)>=220&&!extractFilename(descriptor(el).all))continue;
    add(normalizeFileTarget(el,root));
  }

  // File-card rows are sometimes plain clickable divs. Search short text nodes that contain a filename,
  // then climb to the nearest clickable row. This covers the card shown in the user's screenshot.
  for(const el of root.querySelectorAll('div,span,p')){
    const tx=clean(el.innerText||el.textContent);
    if(!tx||tx.length>220)continue;
    if(!FILE_EXT_RE.test(tx)&&!looksLikeDownloadCta(el))continue;
    const target=normalizeFileTarget(el,root);
    if(target)add(target);
  }

  const ranked=seeds
    .map((el,i)=>({el,n:fileTargetScore(el),preference:fileCardPreference(el),id:fileTargetIdentity(el,i)}))
    .filter(x=>x.n>=260)
    .sort((a,b)=>b.preference-a.preference||b.n-a.n);

  // ChatGPT often renders BOTH a prose CTA (e.g. “下载 TXT 文件”) and a file card
  // immediately below it.  They open the same preview and must represent one file, not two
  // independent download targets.  Pair generic CTAs with the nearest named file card.
  const named=ranked.map(x=>({item:x,filename:extractFilename(descriptor(x.el).all)})).filter(x=>x.filename);
  for(const item of ranked){
    const own=extractFilename(descriptor(item.el).all);
    if(own){item.filenameHint=own;continue}
    if(!looksLikeDownloadCta(item.el))continue;
    const ir=rect(item.el);
    let best=null,bestDist=1e9;
    for(const cand of named){
      if(cand.item===item)continue;
      const cr=rect(cand.item.el);
      const dy=Math.max(0,Math.max(cr.top-ir.bottom,ir.top-cr.bottom));
      const dx=Math.max(0,Math.max(cr.left-ir.right,ir.left-cr.right));
      const dist=dy+dx*0.35;
      if(dist<bestDist){best=cand;bestDist=dist}
    }
    if(best){item.filenameHint=best.filename;item.id=`name:${best.filename}`}
  }

  const order=[],preferredById=new Map();
  for(const item of ranked){
    if(!preferredById.has(item.id))order.push(item.id);
    const current=preferredById.get(item.id);
    // Pairing can give a prose CTA and a real file card the same identity. Always retain
    // the card-shaped/named target so its local download button is searched first.
    if(!current||item.preference>current.preference||(item.preference===current.preference&&item.n>current.n))preferredById.set(item.id,item);
  }
  return order.slice(0,MAX_DOWNLOAD_TARGETS).map(id=>preferredById.get(id)).filter(Boolean);
}
function targetFilename(item){
  if(item?.filenameHint)return item.filenameHint;
  const d=descriptor(item?.el);
  return extractFilename(`${d.text} ${d.href} ${d.aria} ${d.title}`);
}

function collapsedFileGroupLabel(value=''){
  const label=clean(value).replace(/\s+/g,' ').trim();
  if(!label||label.length>90)return false;
  // Current Chinese UI: “还有 2 个”. Keep this deliberately narrow so ordinary
  // assistant prose such as “还有 2 个问题” is never clicked.
  if(/^(?:还有|另有|另外还有|剩余)\s*\d+\s*(?:个|项|份)?(?:\s*(?:文件|附件|文档))?$/i.test(label))return true;
  if(/^(?:显示|展开|查看)\s*(?:剩余|另外)?\s*\d+\s*(?:个|项|份)?\s*(?:文件|附件|文档)$/i.test(label))return true;
  // English UI variants: “2 more”, “Show 2 more files”.
  return /^(?:show|view|expand)?\s*\d+\s+more(?:\s+(?:files?|attachments?|documents?|items?))?$/i.test(label);
}

function descriptorHasCollapsedFileGroupLabel(d){
  return [d?.text,d?.aria,d?.title].some(collapsedFileGroupLabel);
}

function fileGroupExpandScore(el,root){
  if(!el?.isConnected||!root?.contains(el)||!rendered(el)||forbiddenNavigationContext(el))return -9999;
  if(el.disabled||el.getAttribute?.('aria-disabled')==='true'||el.getAttribute?.('aria-expanded')==='true')return -9999;
  const d=descriptor(el);
  if(!descriptorHasCollapsedFileGroupLabel(d))return -9999;
  let n=500;
  if(el.matches?.('button,[role="button"],summary'))n+=220;
  if(el.getAttribute?.('aria-expanded')==='false')n+=180;
  if(/file|attachment|文件|附件/.test(`${d.testid} ${d.aria} ${d.title}`.toLowerCase()))n+=120;
  return n;
}

function fileGroupExpanders(root){
  const found=[];
  const add=seed=>{
    if(!seed||!root?.contains(seed))return;
    let ctl=seed.closest?.('button,[role="button"],summary,a,[role="link"],[tabindex]')||seed;
    if(!root.contains(ctl))return;
    const score=fileGroupExpandScore(ctl,root);
    if(score<500||found.some(x=>x.el===ctl))return;
    found.push({el:ctl,n:score});
  };
  for(const el of root.querySelectorAll('button,[role="button"],summary,a,[role="link"],[tabindex],div,span')){
    const d=descriptor(el);
    if(descriptorHasCollapsedFileGroupLabel(d))add(el);
  }
  return found.sort((a,b)=>b.n-a.n).map(x=>x.el);
}

async function expandCollapsedFileGroups(root){
  const clicked=new WeakSet();
  let expanded=0;
  for(let pass=0;pass<MAX_FILE_GROUP_EXPAND_PASSES;pass++){
    const controls=fileGroupExpanders(root).filter(el=>!clicked.has(el));
    if(!controls.length)break;
    let acted=false;
    for(const control of controls){
      if(!control?.isConnected)continue;
      clicked.add(control);
      const before=discoverFileTargets(root).length;
      await status(`发现折叠的文件卡片，正在展开（当前可见 ${before} 个）`);
      try{control.click();acted=true}catch{continue}
      await waitForFinder(()=>{
        if(!control.isConnected||control.getAttribute?.('aria-expanded')==='true')return true;
        return discoverFileTargets(root).length>before?true:null;
      },FILE_GROUP_EXPAND_MS);
      const after=discoverFileTargets(root).length;
      if(after>before)expanded+=after-before;
      await sleep(120);
    }
    if(!acted)break;
  }
  return expanded;
}
function localDirectDownloadControl(item){
  const el=item?.el;
  if(!el)return null;
  if(explicitDownloadScore(el,{allowHidden:true})>=220)return el;
  // Search several compact card ancestors. ChatGPT may mount the hover arrow as a sibling
  // two or three levels above the filename/link. Hidden semantic download controls are
  // intentionally included because HTMLElement.click() can activate React handlers even
  // when CSS keeps the glyph at opacity:0/display:none until hover.
  const scopes=[el];
  let p=el.parentElement;
  for(let i=0;i<4&&p&&p!==document.body;i++,p=p.parentElement){
    const r=rect(p),tx=clean(p.innerText||p.textContent);
    if((r.height<=240||r.height===0)&&tx.length<=700)scopes.push(p);
  }
  for(const scope of scopes){
    const c=explicitDownloadControls(scope,{allowHidden:true})[0]?.el;
    if(c)return c;
  }
  // Do NOT infer a download button merely from a round down-arrow sitting below/near the
  // file card. ChatGPT uses a visually similar circular ↓ as the conversation
  // “scroll/jump to latest” positioning control. A message-level download control must
  // carry real download semantics (label/testid/download attribute) or a download glyph
  // with a tray/line, not geometry alone.
  return null;
}
function messageHoverScopes(item,messageRoot){
  const el=item?.el;
  const scopes=[];
  if(el)scopes.push(el);
  let cur=el?.parentElement;
  for(let i=0;i<6&&cur&&messageRoot?.contains(cur);i++,cur=cur.parentElement){
    const r=rect(cur),tx=clean(cur.innerText||cur.textContent);
    if(r.width>=90&&r.height>=24&&r.height<=220&&tx.length<=500)scopes.push(cur);
  }
  if(messageRoot){
    for(const x of messageRoot.querySelectorAll('[data-testid*="file" i],[data-testid*="attachment" i],[class*="file" i],[class*="attachment" i]')){
      const r=rect(x);
      if(r.width>=60&&r.height>=20&&r.height<=260)scopes.push(x);
    }
  }
  return compactUnique(scopes);
}

function previewRoots(messageRoot,expectedFilename=''){
  const expected=clean(expectedFilename).toLowerCase();
  const candidates=[];
  const add=(el,boost=0)=>{
    if(!el?.isConnected||messageRoot?.contains(el)||forbiddenNavigationContext(el))return;
    const r=rect(el);
    if(r.width<220||r.height<120)return;
    let n=boost;
    const tx=clean(el.innerText||el.textContent).toLowerCase();
    if(expected&&tx.includes(expected))n+=520;
    if(r.left>window.innerWidth*0.38)n+=180;
    if(r.right>window.innerWidth*0.82)n+=120;
    if(el.matches?.('[role="dialog"],[aria-modal="true"]'))n+=220;
    if(/preview|预览|download|下载|could not|无法|failed|失败/.test(tx))n+=80;
    candidates.push({el,n});
  };
  for(const el of document.querySelectorAll('[role="dialog"],[aria-modal="true"],[data-testid*="preview" i],[data-testid*="viewer" i],[data-testid*="artifact" i]'))add(el,180);
  // Right-side preview implementations often have no stable testid. Walk ancestors of right-side controls/text.
  for(const seed of document.querySelectorAll('button,[role="button"],a,[role="link"],h1,h2,h3,[data-testid]')){
    if(messageRoot?.contains(seed)||forbiddenNavigationContext(seed))continue;
    const sr=rect(seed);
    if(sr.left<window.innerWidth*0.42)continue;
    let cur=seed;
    for(let i=0;i<7&&cur&&cur!==document.body;i++,cur=cur.parentElement){
      const r=rect(cur);
      if(r.width>=260&&r.height>=180&&r.left>window.innerWidth*0.30){add(cur);break}
    }
  }
  return candidates.sort((a,b)=>b.n-a.n).map(x=>x.el).filter((x,i,a)=>a.indexOf(x)===i).slice(0,8);
}

function previewCloseControls(messageRoot,expectedFilename=''){
  const expected=clean(expectedFilename).toLowerCase();
  const byElement=new Map();
  for(const root of previewRoots(messageRoot,expectedFilename)){
    const rr=rect(root);
    const rootText=clean(root.innerText||root.textContent).toLowerCase();
    for(const el of root.querySelectorAll('button,a,[role="button"],[role="link"],[tabindex]')){
      if(messageRoot?.contains(el)||forbiddenNavigationContext(el)||!clickableBox(el)||!closeControlEvidence(el))continue;
      const er=rect(el);
      let n=420;
      if(root.matches?.('[role="dialog"],[aria-modal="true"],[data-testid*="preview" i],[data-testid*="viewer" i],[data-testid*="artifact" i]'))n+=220;
      if(expected&&rootText.includes(expected))n+=260;
      if(er.top<=rr.top+130)n+=170;
      if(er.right>=rr.right-170)n+=170;
      if(er.left>window.innerWidth*0.42)n+=100;
      const old=byElement.get(el);
      if(!old||n>old.n)byElement.set(el,{el,root,n});
    }
  }
  return [...byElement.values()].sort((a,b)=>b.n-a.n||rect(b.el).left-rect(a.el).left);
}

function capturePreviewState(messageRoot,expectedFilename=''){
  const roots=previewRoots(messageRoot,expectedFilename);
  return {
    roots:new Set(roots),
    rootText:new Map(roots.map(root=>[root,clean(root.innerText||root.textContent).toLowerCase()])),
    controls:new Set(previewCloseControls(messageRoot,expectedFilename).map(x=>x.el))
  };
}

async function closePreviewOpenedByContinue(messageRoot,expectedFilename='',before=null,forceCurrent=false){
  const baseline=before||{roots:new Set(),rootText:new Map(),controls:new Set()};
  const expected=clean(expectedFilename).toLowerCase();
  const rootText=root=>clean(root.innerText||root.textContent).toLowerCase();
  const rootChanged=root=>baseline.roots.has(root)&&rootText(root)!==(baseline.rootText?.get(root)||'');
  const expectedAppeared=root=>expected&&rootText(root).includes(expected)&&!(baseline.rootText?.get(root)||'').includes(expected);
  const ownedRoots=()=>previewRoots(messageRoot,expectedFilename).filter(root=>
    !baseline.roots.has(root)||expectedAppeared(root)||(forceCurrent&&rootChanged(root))
  );
  const pickOwnedClose=()=>{
    const controls=previewCloseControls(messageRoot,expectedFilename);
    const roots=new Set(ownedRoots());
    return controls.find(x=>roots.has(x.root)&&!baseline.controls.has(x.el))?.el||controls.find(x=>roots.has(x.root))?.el||null;
  };
  const ownedPreviewOpen=()=>{
    if(pickOwnedClose())return true;
    return ownedRoots().some(root=>{
      const tx=rootText(root);
      return (expected&&tx.includes(expected))||/preview|预览|download|下载|could not|无法|failed|失败/.test(tx)||
        root.matches?.('[role="dialog"],[aria-modal="true"],[data-testid*="preview" i],[data-testid*="viewer" i],[data-testid*="artifact" i]');
    });
  };
  const waitUntil=async(predicate,timeout)=>{
    const end=Date.now()+timeout;
    while(Date.now()<end){
      try{if(predicate())return true}catch{}
      await sleep(70);
    }
    try{return !!predicate()}catch{return false}
  };

  try{
    let close=pickOwnedClose();
    if(!close){
      // File previews can mount noticeably after the card click. Keep the full discovery
      // window for that path even when no owned root is visible on the first probe.
      const timeout=(forceCurrent||ownedRoots().length)?PREVIEW_CLOSE_DISCOVERY_MS:360;
      close=await waitForFinder(pickOwnedClose,timeout);
    }
    if(close?.isConnected){
      try{close.click()}catch{}
      if(await waitUntil(()=>!ownedPreviewOpen(),700))return true;
      // React can replace the toolbar during its closing transition. Resolve the current
      // button instead of assuming disappearance of the old node means the panel is gone.
      close=pickOwnedClose();
      if(close?.isConnected){
        try{close.click()}catch{}
        if(await waitUntil(()=>!ownedPreviewOpen(),700))return true;
      }
    }

    // A few preview builds expose no semantic label on their close affordance. Escape is
    // reserved for a newly-created preview root, so an unrelated preview that was already
    // open before the extension clicked the file is left alone.
    if(ownedPreviewOpen()){
      const init={key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true,composed:true};
      document.dispatchEvent(new KeyboardEvent('keydown',init));
      document.dispatchEvent(new KeyboardEvent('keyup',init));
      return await waitUntil(()=>!ownedPreviewOpen(),700);
    }
  }catch(e){
    console.warn('[AutoContinueContinue] 无法关闭自动打开的文件预览',e);
  }
  return false;
}

function previewHoverScopes(messageRoot,expectedFilename=''){
  const out=[];
  for(const root of previewRoots(messageRoot,expectedFilename)){
    out.push(root);
    // Toolbar/title bands are frequent hover targets for the download arrow.
    for(const el of root.querySelectorAll('header,[role="toolbar"],[data-testid*="toolbar" i],[data-testid*="header" i],button,[role="button"]')){
      const r=rect(el);
      if(r.width>0&&r.height>0&&r.top<window.innerHeight*0.45)out.push(el);
    }
  }
  return compactUnique(out).slice(0,16);
}

function previewPositionalDownloadScore(el,root){
  if(!el?.isConnected||!root?.contains(el)||forbiddenNavigationContext(el)||conversationPositionControl(el)||closeControlEvidence(el))return -9999;
  const er=rect(el),rr=rect(root);
  if(er.width<=0||er.height<=0)return -9999;
  const d=descriptor(el);const label=clean(`${d.text} ${d.aria} ${d.title}`).toLowerCase();
  let n=svgDownloadGlyphScore(el);
  // Large/unpreviewable file state: a centered rounded “下载 / Download” CTA.
  if(/^(?:下载|download)(?:\s*(?:文件|file))?$/.test(label)){
    const cx=er.left+er.width/2,cy=er.top+er.height/2;
    const rcx=rr.left+rr.width/2,rcy=rr.top+rr.height/2;
    if(Math.abs(cx-rcx)<rr.width*0.34&&Math.abs(cy-rcy)<rr.height*0.42)n+=460;
  }
  // Rendered preview state: top-right icon button.  If an explicit close control sits just
  // to its right, the immediately-left icon is a strong download candidate even when its SVG
  // has no aria-label/title in this ChatGPT build.
  const nearTop=er.top<=rr.top+110;
  const nearRight=er.right>=rr.right-210;
  const iconLike=!!el.querySelector?.('svg')&&er.width<=72&&er.height<=72;
  if(nearTop&&nearRight&&iconLike)n+=110;
  if(nearTop&&iconLike){
    const buttons=[...root.querySelectorAll('button,a,[role="button"],[role="link"],[tabindex]')].filter(x=>x!==el&&rendered(x));
    for(const other of buttons){
      if(!closeControlEvidence(other))continue;
      const or=rect(other);
      if(or.top<=rr.top+120&&or.left>=er.right-12&&or.left-er.right<=90){n+=420;break}
    }
  }
  return n;
}
function panelDownloadControls(messageRoot,expectedFilename=''){
  const expected=clean(expectedFilename).toLowerCase();
  const roots=previewRoots(messageRoot,expectedFilename);
  const semantic=explicitDownloadControls(document,{panel:true,allowHidden:true});
  const positional=[];
  for(const root of roots){
    for(const el of root.querySelectorAll('button,a,[role="button"],[role="link"],[tabindex]')){
      const n=previewPositionalDownloadScore(el,root);
      if(n>=300)positional.push({el,n});
    }
  }
  return [...semantic,...positional]
    .filter(({el})=>!messageRoot?.contains(el))
    .filter(({el})=>clickableBox(el)||roots.some(root=>root.contains(el)))
    .map(item=>{
      let n=item.n;
      const containingRoot=roots.find(root=>root.contains(item.el));
      if(containingRoot)n=Math.max(n,previewPositionalDownloadScore(item.el,containingRoot));
      const r=rect(item.el);
      if(r.left>window.innerWidth*0.48)n+=120;
      if(roots.some(root=>root.contains(item.el)))n+=220;
      let anc=item.el;
      for(let i=0;i<7&&anc;i++,anc=anc.parentElement){
        const ar=rect(anc);
        if(ar.width>=240&&ar.left>window.innerWidth*0.38){
          const tx=clean(anc.innerText||anc.textContent).toLowerCase();
          if(expected&&tx.includes(expected))n+=260;
          if(/preview|预览|download|下载/.test(tx))n+=35;
          break;
        }
      }
      return {el:item.el,n};
    })
    .filter(x=>x.n>=300)
    .sort((a,b)=>b.n-a.n);
}

async function waitForPanelDownloadControl(messageRoot,expectedFilename='',timeout=PREVIEW_DISCOVERY_MS){
  const finder=()=>panelDownloadControls(messageRoot,expectedFilename)[0]?.el||null;
  const immediate=finder();
  if(immediate)return immediate;

  // Give the preview time to mount, then synthesize hover over the right-side viewer/toolbars.
  const warm=await waitForFinder(finder,700);
  if(warm)return warm;
  const start=Date.now();
  while(Date.now()-start<timeout){
    const scopes=previewHoverScopes(messageRoot,expectedFilename);
    const found=await hoverScopesAndFind(scopes,finder,Math.min(HOVER_DISCOVERY_MS,Math.max(250,timeout-(Date.now()-start))));
    if(found)return found;
    const passive=await waitForFinder(finder,Math.min(600,Math.max(150,timeout-(Date.now()-start))));
    if(passive)return passive;
  }
  return null;
}
async function clickFileTarget(item,messageRoot,sourceMessageKey=''){
  const el=item?.el;
  if(!el?.isConnected)return {attempted:false,downloaded:false,navigated:false,method:'missing'};
  const expected=targetFilename(item);
  const beforePath=`${location.origin}${location.pathname}`;
  const stableMessageKey=sourceMessageKey||key(messageRoot);
  const previewBefore=capturePreviewState(messageRoot,expected);
  let clickedByContinue=false;
  let fileEntryClicked=false;

  try{

  // 1) Existing explicit download button in/near the file row. This covers always-mounted and CSS-opacity hover icons.
  await status('文件下载：检查消息内直接下载按钮/箭头');
  let direct=localDirectDownloadControl(item);
  if(direct){
    clickedByContinue=true;
    const dl=await clickDownloadControlWithMenu(direct,expected,DOWNLOAD_CONFIRM_MS);
    if(dl.navigated)return {attempted:true,downloaded:false,navigated:true,method:'message-download-navigation'};
    if(dl.downloaded)return {attempted:dl.clicked,downloaded:true,navigated:false,method:dl.menu?'message-download-menu':'message-button'};
  }

  // 2) React-lazy hover button: trigger pointer/mouse hover handlers on the card/row and rescan.
  await status('文件下载：未确认直下，正在触发文件卡片悬浮并等待带下载语义的动态控件');
  const hoverDirect=await hoverScopesAndFind(
    messageHoverScopes(item,messageRoot),
    ()=>localDirectDownloadControl(item),
    HOVER_DISCOVERY_MS
  );
  if(hoverDirect&&hoverDirect!==direct){
    clickedByContinue=true;
    const dl=await clickDownloadControlWithMenu(hoverDirect,expected,DOWNLOAD_CONFIRM_MS);
    if(dl.navigated)return {attempted:true,downloaded:false,navigated:true,method:'hover-download-navigation'};
    if(dl.downloaded)return {attempted:true,downloaded:true,navigated:false,method:dl.menu?'hover-download-menu':'hover-button'};
  }

  // 3) File link/card path. The first click may download immediately or merely open the current-chat preview.
  await status('文件下载：消息内未发现可靠直下控件，正在点击当前文件入口并检查是否直下/打开预览');
  await suppressNativeDownloadUi(4200);
  const since=Date.now()-80;
  try{
    clickedByContinue=true;
    fileEntryClicked=true;
    el.click();
  }catch{return {attempted:false,downloaded:false,navigated:false,method:'opener-failed'}}
  await sleep(180);
  const early=await downloadsSince(since,1200);
  if(early.length)return {attempted:true,downloaded:true,navigated:false,method:'direct-link'};

  if(`${location.origin}${location.pathname}`!==beforePath){
    return {attempted:true,downloaded:false,navigated:true,method:'navigation'};
  }

  // 4) Preview path. The viewer may render, fail to render, or lazily expose its toolbar only after hover.
  await status('文件下载：正在当前对话预览区域寻找下载按钮，并尝试悬浮预览工具栏');
  const panelButton=await waitForPanelDownloadControl(messageRoot,expected,PREVIEW_DISCOVERY_MS);
  if(!panelButton)return {attempted:true,downloaded:false,navigated:false,method:'preview-no-download'};

  await status('文件下载：已定位预览下载控件，正在点击并确认浏览器下载任务');
  const dl=await clickDownloadControlWithMenu(panelButton,expected,DOWNLOAD_CONFIRM_MS);
  if(dl.navigated)return {attempted:true,downloaded:false,navigated:true,method:'preview-download-navigation'};
  if(dl.downloaded)return {attempted:true,downloaded:true,navigated:false,method:dl.menu?'preview-download-menu':'preview-download'};

  // A first click on a stale/hidden toolbar icon can cause React to remount it. Hover the preview once more and retry a fresh control.
  const retry=await hoverScopesAndFind(
    previewHoverScopes(messageRoot,expected),
    ()=>panelDownloadControls(messageRoot,expected).find(x=>x.el!==panelButton)?.el||panelDownloadControls(messageRoot,expected)[0]?.el||null,
    HOVER_DISCOVERY_MS
  );
  if(retry&&retry.isConnected){
    const dl2=await clickDownloadControlWithMenu(retry,expected,DOWNLOAD_CONFIRM_MS);
    if(dl2.navigated)return {attempted:true,downloaded:false,navigated:true,method:'preview-retry-navigation'};
    if(dl2.downloaded)return {attempted:true,downloaded:true,navigated:false,method:dl2.menu?'preview-retry-menu':'preview-retry'};
  }
  return {attempted:true,downloaded:false,navigated:false,method:'preview-download-unconfirmed'};
  }finally{
    if(clickedByContinue&&`${location.origin}${location.pathname}`===beforePath){
      const liveMessage=msgs().filter(x=>messageRole(x)==='assistant').find(x=>key(x)===stableMessageKey);
      const liveRoot=assistantTurnRoot(liveMessage)||messageRoot;
      await closePreviewOpenedByContinue(liveRoot,expected,previewBefore,fileEntryClicked);
    }
  }
}

async function downloadFilesFromMessage(m){
  const sourceKey=key(m);
  const scanRoot=assistantTurnRoot(m)||m;
  await expandCollapsedFileGroups(scanRoot);
  const initialTargets=discoverFileTargets(scanRoot);
  const plans=initialTargets.map(x=>({id:x.id,filename:targetFilename(x),original:x}));
  const downloadUiBatchToken=await beginNativeDownloadUiBatch();
  try{
  if(!downloadProgressByMessage.has(sourceKey)&&downloadProgressByMessage.size>=12){
    downloadProgressByMessage.delete(downloadProgressByMessage.keys().next().value);
  }
  const existingProgress=downloadProgressByMessage.get(sourceKey)||null;
  const progress=existingProgress||{startedAt:Date.now()-250,completedKeys:new Set()};
  downloadProgressByMessage.set(sourceKey,progress);
  const planKey=(plan,index)=>plan.filename?`name:${plan.filename}`:(plan.id||`index:${index}`);
  const attemptStartedAt=progress.startedAt;
  const expectedNames=[...new Set(plans.map(x=>x.filename).filter(Boolean))];
  let attempted=0,downloaded=0,preview=0,failed=0;

  if(plans.length){
    const completed=new Set();
    for(let i=0;i<plans.length;i++){
      if(progress.completedKeys.has(planKey(plans[i],i)))completed.add(i);
    }
    // On a strict-mode retry, first reconcile downloads which Chrome reported after the
    // previous scan. This also preserves already completed targets across retry cycles.
    if(existingProgress){
      for(let i=0;i<plans.length;i++){
        if(completed.has(i)||!plans[i].filename)continue;
        const late=await downloadsSince(attemptStartedAt,220,[plans[i].filename]);
        if(late.length){
          completed.add(i);
          progress.completedKeys.add(planKey(plans[i],i));
        }
      }
    }
    for(let pass=0;pass<MAX_FILE_DOWNLOAD_PASSES;pass++){
      let pending=plans.map((_,i)=>i).filter(i=>!completed.has(i));
      if(!pending.length)break;
      if(pass>0){
        await status(`仍有 ${pending.length}/${plans.length} 个文件未确认，正在补试`);
        await sleep(500);
        // A real browser download can appear just after the per-click confirmation window.
        // Reconcile each named pending item before clicking it again, avoiding needless
        // “(1)” duplicate files when only the event notification was late.
        for(const i of pending){
          if(!plans[i].filename)continue;
          const late=await downloadsSince(attemptStartedAt,260,[plans[i].filename]);
          if(late.length){
            completed.add(i);
            progress.completedKeys.add(planKey(plans[i],i));
          }
        }
        pending=plans.map((_,i)=>i).filter(i=>!completed.has(i));
        if(!pending.length)break;
      }
      for(let pendingIndex=0;pendingIndex<pending.length;pendingIndex++){
        const i=pending[pendingIndex];
        if(generating())break;
        const phase=pass===0?'正在处理':'正在补试';
        await status(`发现 ${plans.length} 个文件目标，${phase} ${pendingIndex+1}/${pending.length}`);

        // Opening the right preview can cause React to reflow/remount the conversation.
        // Re-resolve the SAME assistant turn first. This is important for startup backfill,
        // because a newer user message (or a currently generating assistant turn) may already exist.
        const freshMessage=msgs().filter(x=>messageRole(x)==='assistant').find(x=>key(x)===sourceKey)||m;
        const freshRoot=assistantTurnRoot(freshMessage)||freshMessage;
        let freshTargets=discoverFileTargets(freshRoot);
        let item=freshTargets.find(x=>x.id===plans[i].id);
        if(!item&&plans[i].filename)item=freshTargets.find(x=>targetFilename(x)===plans[i].filename);
        if(!item&&fileGroupExpanders(freshRoot).length){
          await expandCollapsedFileGroups(freshRoot);
          freshTargets=discoverFileTargets(freshRoot);
          item=freshTargets.find(x=>x.id===plans[i].id);
          if(!item&&plans[i].filename)item=freshTargets.find(x=>targetFilename(x)===plans[i].filename);
        }
        if(!item&&plans[i].original?.el?.isConnected)item=plans[i].original;
        if(!item)continue;

        const result=await clickFileTarget(item,freshRoot,sourceKey);
        if(result.navigated)return {targets:plans.length,attempted,downloaded:completed.size,preview,failed:plans.length-completed.size,navigated:true,attemptStartedAt,expectedNames};
        if(result.attempted)attempted++;
        if(result.downloaded){
          completed.add(i);
          progress.completedKeys.add(planKey(plans[i],i));
        }
        if(String(result.method||'').startsWith('preview'))preview++;
        await sleep(180);
      }
      if(generating())break;
    }
    downloaded=completed.size;
    failed=plans.length-downloaded;
    if(!failed)downloadProgressByMessage.delete(sourceKey);
    return {targets:plans.length,attempted,downloaded,preview,failed,navigated:false,attemptStartedAt,expectedNames};
  }

  // 3) Legacy safety net: some ChatGPT builds expose download icons but no recognizable file row.
  // Process every strong download control in the newest assistant reply, not just the first one.
  const legacy=[...new Set(explicitDownloadControls(scanRoot).map(x=>x.el))].slice(0,MAX_DOWNLOAD_TARGETS);
  for(let i=0;i<legacy.length;i++){
    await status(`发现 ${legacy.length} 个下载控件，正在处理 ${i+1}/${legacy.length}`);
    const dl=await clickDownloadControlWithMenu(legacy[i],'',DOWNLOAD_CONFIRM_MS);
    if(dl.clicked)attempted++;
    if(dl.downloaded)downloaded++;else if(dl.clicked)failed++;
  }
  if(downloaded>=legacy.length)downloadProgressByMessage.delete(sourceKey);
  return {targets:legacy.length,attempted,downloaded,preview:0,failed,navigated:false,attemptStartedAt,expectedNames};
  }finally{
    await endNativeDownloadUiBatch(downloadUiBatchToken);
  }
}

function hasFileSignal(root){
  const scanRoot=assistantTurnRoot(root)||root;
  const tx=clean(scanRoot?.innerText||scanRoot?.textContent);
  return /下载|download/i.test(tx)||FILE_EXT_RE.test(tx)||
    !!scanRoot?.querySelector?.('[data-testid*="file" i],[data-testid*="attachment" i],a[download],a[href^="sandbox:"],a[href*="/files/" i],a[href*="/backend-api/estuary/content" i],button[aria-label*="download" i],button[aria-label*="下载" i]');
}

function continuationDecision({fileSignal,downloadComplete=false,allowUnconfirmed=true}={}){
  if(!fileSignal)return 'continue-no-file';
  if(downloadComplete)return 'continue-downloaded';
  return allowUnconfirmed!==false?'continue-unconfirmed':'wait-download';
}

// Startup/backfill path: if the user has already spoken after the last generated file,
// normal tail-only supervision would miss that previous assistant link. Find the newest
// earlier assistant turn with a file signal and download it exactly once per continuation start.
function historicalFileCandidate(){
  if(s.lastBackfillMessageKey||s.lastHandledMessageKey||(s.cycleCount||0)>0||s.pendingContinueKey)return null;
  const all=msgs();
  const tail=all.at(-1)||null;
  const tailRole=messageRole(tail);
  const isGen=generating();
  if(!isGen&&tailRole==='assistant')return null;
  const assistants=all.filter(x=>messageRole(x)==='assistant');
  let candidate=assistants.at(-1)||null;
  if(isGen&&tailRole==='assistant'&&candidate===tail)candidate=assistants.at(-2)||null;
  if(!candidate)return null;
  const k=key(candidate);
  if(!k||k===s.lastBackfillMessageKey||k===s.lastHandledMessageKey)return null;
  return hasFileSignal(candidate)?candidate:null;
}

async function processHistoricalFileBackfill(){
  const m=historicalFileCandidate();
  if(!m)return false;
  const k=key(m);
  try{
    await status('检测上一条助手回复：发现文件，正在下载');
    const dl=await downloadFilesFromMessage(m);
    if(dl.navigated){
      await stop('历史文件入口导致页面跳转，已停止以防误操作');
      return true;
    }
    s.lastBackfillMessageKey=k;
    let downloadStatus='';
    if(dl.downloaded>0){
      downloadStatus=`上一条回复已确认下载 ${dl.downloaded}/${Math.max(dl.targets,dl.downloaded)} 个文件`;
      if(dl.failed>0)downloadStatus+=`，${dl.failed} 个未确认`;
    }else if(dl.attempted>0){
      downloadStatus=`上一条回复已尝试 ${dl.attempted} 个文件入口，未确认下载`;
    }else{
      downloadStatus='上一条回复有文件信号，但未定位到可点击入口';
    }
    downloadProgressByMessage.delete(k);
    await patchState({lastBackfillMessageKey:k,lastStatus:`${downloadStatus}，等待最新回复`});
    schedule(900);
    return true;
  }finally{
    await scrollConversationToBottom(3).catch(()=>{});
  }
}

function composer(){
  for(const q of ['#prompt-textarea','textarea[data-testid="prompt-textarea"]','[contenteditable="true"][data-virtualkeyboard="true"]','div[contenteditable="true"][role="textbox"]']){
    const e=[...document.querySelectorAll(q)].find(rendered);
    if(e)return e;
  }
  return null;
}
function ctext(c){return clean(c instanceof HTMLTextAreaElement?c.value:c?.innerText||c?.textContent)}
function fill(c,val){
  c.focus();
  if(c instanceof HTMLTextAreaElement){
    const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
    set?set.call(c,val):c.value=val;
    c.dispatchEvent(new Event('input',{bubbles:true}));
    return;
  }
  const sel=window.getSelection(),r=document.createRange();
  r.selectNodeContents(c);sel.removeAllRanges();sel.addRange(r);
  try{document.execCommand('insertText',false,val)}catch{c.textContent=val}
  c.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:val}));
}
function sendBtn(c){
  const root=c?.closest('form')||document;
  for(const q of [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="发送"]'
  ]){
    const b=[...root.querySelectorAll(q)].find(x=>rendered(x)&&!x.disabled&&x.getAttribute('aria-disabled')!=='true');
    if(b)return b;
  }
  return null;
}

async function waitForSendArrow(c,timeout=3200){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    if(generating())return null;
    const b=sendBtn(c);
    if(b)return b;
    await sleep(120);
  }
  return null;
}

async function verifySent(){
  for(let i=0;i<20;i++){
    if(generating()||lastRole()==='user')return true;
    await sleep(160);
  }
  return false;
}

async function assistantReplySettled(){
  if(generating())return false;
  const sig1=assistantSignature();
  if(!sig1)return false;
  await sleep(SETTLE_SAMPLE_MS);
  if(generating())return false;
  const sig2=assistantSignature();
  return !!sig2&&sig1===sig2&&lastRole()==='assistant';
}

async function sendContinue(){
  await scrollConversationToBottom(3);
  let c=composer();
  if(!c){
    await scrollConversationToBottom(2);
    c=composer();
  }
  if(!c)throw new Error('找不到输入框');

  const ex=ctext(c);
  if(ex&&ex!==s.continueText){await stop('检测到手动输入，已停止');return false}
  if(!ex)fill(c,s.continueText);

  const b=await waitForSendArrow(c);
  if(b){
    b.click();
    if(await verifySent())return true;
  }

  if(generating())return false;
  c.focus();
  for(const type of ['keydown','keypress','keyup']){
    c.dispatchEvent(new KeyboardEvent(type,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));
  }
  if(await verifySent())return true;
  throw new Error('续作指令未发送成功');
}

async function processPending(){
  if(!s.pendingContinueKey)return false;
  if(generating()){
    generationQuietSince=0;
    await status('检测到停止生成方块，继续等待回复完成');
    return true;
  }
  if(!generationQuietSince)generationQuietSince=Date.now();
  const quietFor=Date.now()-generationQuietSince;
  if(quietFor<GENERATION_END_GRACE_MS){
    schedule(Math.max(120,GENERATION_END_GRACE_MS-quietFor+40));
    return true;
  }
  if(Date.now()<(s.pendingContinueAt||0)){
    schedule(Math.max(100,(s.pendingContinueAt||0)-Date.now()+50));
    return true;
  }
  if(!(await assistantReplySettled())){
    await status('回复看似结束，正在确认内容稳定');
    schedule(900);
    return true;
  }
  if(await sendContinue()){
    const n=(s.cycleCount||0)+1;
    s.cycleCount=n;s.pendingContinueKey='';s.pendingContinueAt=0;s.pendingContinueMode='';
    await patchState({cycleCount:n,pendingContinueKey:'',pendingContinueAt:0,pendingContinueMode:'',downloadRetryKey:'',downloadRetryCount:0,downloadRetryAt:0,lastStatus:`已发送“${s.continueText}”`,logs:withLog(`已发送“${s.continueText}”`)});
  }
  return true;
}

function conversationHealth(){
  const all=msgs();
  const main=document.querySelector('main');
  const mainText=clean(main?.innerText||'').slice(0,5000);
  const explicitMissing=/(?:unable to load conversation|conversation (?:not found|was deleted|does not exist)|couldn['’]?t load conversation|无法加载(?:此)?对话|对话(?:不存在|已删除|未找到)|找不到(?:此)?对话)/i.test(mainText);
  const hasConversation=all.length>0 && !!lastAssistant()?.closest?.('main');
  const hasComposer=!!composer();
  const hasConcretePath=/(?:^|\/)c\/[^/?#]+\/?$/i.test(location.pathname);
  return {explicitMissing,hasConversation,hasComposer,hasConcretePath,hasMain:!!main};
}

async function check(){
  if(busy)return;
  busy=true;
  try{
    const gate=await targetGate();
    if(!gate?.ok||!gate.isTarget)return;
    s={...D,...(gate.state||{})};
    if(!s.enabled)return;
    if(!gate.conversationMatches||!matchPath()){
      await stop('目标标签页已离开锁定对话，监督已停止');
      return;
    }

    const health=conversationHealth();
    if(health.explicitMissing){
      await stop('目标对话已删除或不存在，监督已自动取消');
      return;
    }
    if(!health.hasConversation && !health.hasComposer){
      if(!invalidSince)invalidSince=Date.now();
      if(Date.now()-invalidSince>=12000){
        await stop('目标对话页面已失效，监督已自动取消');
        return;
      }
      await status('正在确认目标对话页面是否仍有效');
      schedule(1500);
      return;
    }
    invalidSince=0;

    if((s.cycleCount||0)>=(s.maxCycles||100)){await stop('达到最大轮次');return}

    if(await processPending())return;
    // Do this before the generating gate: the user may start supervision while a NEW reply is
    // already streaming, and still wants the PREVIOUS file link downloaded immediately.
    if(await processHistoricalFileBackfill())return;
    if(s.downloadRetryKey&&Date.now()<(s.downloadRetryAt||0)){
      schedule(Math.max(150,(s.downloadRetryAt||0)-Date.now()+50));
      return;
    }
    if(generating()){
      generationQuietSince=0;
      await status('检测到停止生成方块，等待回复完成');
      return;
    }
    if(!generationQuietSince)generationQuietSince=Date.now();
    const quietFor=Date.now()-generationQuietSince;
    if(quietFor<GENERATION_END_GRACE_MS){
      // Keep the existing status during short stop-button flickers. This prevents the popup from
      // bouncing between “generating” and “reply stable” while ChatGPT swaps UI states.
      schedule(Math.max(120,GENERATION_END_GRACE_MS-quietFor+40));
      return;
    }

    await scrollConversationToBottom(1);

    if(lastRole()!=='assistant'){
      await status('等待助手回复');
      return;
    }

    if(!(await assistantReplySettled())){
      await status('停止生成方块已消失，正在确认回复稳定');
      schedule(900);
      return;
    }

    await scrollConversationToBottom(2);
    const m=lastAssistant();
    if(!m)return;
    const k=key(m),tx=text(m);
    if(!k||k===s.lastHandledMessageKey)return;
    if(STOP.some(r=>r.test(tx))){await stop('检测到对话错误/长度上限');return}

    const fileSignal=hasFileSignal(m);
    if(continuationDecision({fileSignal,allowUnconfirmed:s.continueWithoutDownload})==='continue-no-file'){
      const waitSeconds=Math.max(1,Number(s.delaySeconds)||3);
      const due=Date.now()+waitSeconds*1000;
      const resultText='回复已完成，未检测到文件';
      await patchState({
        lastHandledMessageKey:k,
        pendingContinueKey:k,
        pendingContinueAt:due,
        pendingContinueMode:'no-file',
        downloadRetryKey:'',
        downloadRetryCount:0,
        downloadRetryAt:0,
        lastStatus:`${resultText}；等待 ${waitSeconds} 秒后发送“${s.continueText}”`,
        logs:withLog(`${resultText}；无文件回复会正常续作，将发送“${s.continueText}”`)
      });
      if(DONE.some(r=>r.test(tx))){await stop('研究完成，已停止');return}
      schedule(Math.max(150,due-Date.now()+50));
      return;
    }

    await status('回复已完成，发现文件信号；正在扫描整条助手回复与文件卡片');
    const dl=await downloadFilesFromMessage(m);
    await scrollConversationToBottom(3);
    if(dl.navigated){await stop('文件入口导致页面跳转，已停止以防误操作');return}

    const targetTotal=Math.max(dl.targets,dl.downloaded,1);
    const missingCount=Math.max(0,targetTotal-dl.downloaded);
    if(missingCount>0){
      if(dl.attempted>0&&dl.attemptStartedAt){
        // Do not hold up the user's continuation timer. Keep watching the browser download
        // registry in parallel, and correct the status/log if Chrome reports the task late.
        void lateConfirmDownload(k,dl.attemptStartedAt,targetTotal,dl.expectedNames||[]);
      }
      if(continuationDecision({fileSignal:true,allowUnconfirmed:s.continueWithoutDownload})==='continue-unconfirmed'){
        const waitSeconds=Math.max(1,Number(s.delaySeconds)||3);
        const due=Date.now()+waitSeconds*1000;
        const resultText=dl.downloaded>0
          ? `已确认下载 ${dl.downloaded}/${targetTotal} 个文件，仍有 ${missingCount} 个未确认`
          : (dl.attempted>0?'未确认文件下载成功':'未找到可下载文件入口');
        const reason=`${resultText}；已按选项允许续作，等待 ${waitSeconds} 秒后发送“${s.continueText}”`;
        downloadProgressByMessage.delete(k);
        await patchState({
          lastHandledMessageKey:k,
          pendingContinueKey:k,
          pendingContinueAt:due,
          pendingContinueMode:'unconfirmed',
          downloadRetryKey:'',
          downloadRetryCount:0,
          downloadRetryAt:0,
          lastStatus:reason,
          logs:withLog(`${resultText}；不会卡住任务，将继续发送“${s.continueText}”`,'warn')
        });
        if(DONE.some(r=>r.test(tx))){await stop('研究完成，已停止');return}
        schedule(Math.max(150,due-Date.now()+50));
        return;
      }

      const rawRetryCount=(s.downloadRetryKey===k?(s.downloadRetryCount||0):0)+1;
      const retryCount=Math.min(rawRetryCount,MAX_DOWNLOAD_RETRIES);
      const slow=rawRetryCount>MAX_DOWNLOAD_RETRIES;
      const retryDelay=slow?DOWNLOAD_RETRY_SLOW_MS:DOWNLOAD_RETRY_DELAY_MS;
      const retryAt=Date.now()+retryDelay;
      const partial=dl.downloaded>0;
      const reason=partial
        ? (slow
          ? `严格模式：已下载 ${dl.downloaded}/${targetTotal} 个文件，仍缺 ${missingCount} 个；不会发送“${s.continueText}”，继续监督并于 30 秒后再检查`
          : `严格模式：已下载 ${dl.downloaded}/${targetTotal} 个文件，仍缺 ${missingCount} 个；不会发送“${s.continueText}”，第 ${retryCount}/${MAX_DOWNLOAD_RETRIES} 次快速重试后再检查`)
        : dl.attempted>0
        ? (slow
          ? `严格模式：文件仍未确认下载；不会发送“${s.continueText}”，继续监督并于 30 秒后再检查`
          : `严格模式：未确认文件下载；不会发送“${s.continueText}”，第 ${retryCount}/${MAX_DOWNLOAD_RETRIES} 次快速重试后再检查`)
        : (slow
          ? `严格模式：仍未找到可下载文件入口；不会发送“${s.continueText}”，继续监督并于 30 秒后再检查`
          : `严格模式：未找到可下载文件入口；不会发送“${s.continueText}”，第 ${retryCount}/${MAX_DOWNLOAD_RETRIES} 次快速重试后再检查`);
      await status(reason,{
        downloadRetryKey:k,
        downloadRetryCount:retryCount,
        downloadRetryAt:retryAt,
        pendingContinueKey:'',
        pendingContinueAt:0,
        pendingContinueMode:''
      },'warn');
      schedule(retryDelay+50);
      return;
    }

    const due=Date.now()+Math.max(1,Number(s.delaySeconds)||3)*1000;
    const downloadStatus=`已确认下载 ${dl.downloaded}/${Math.max(dl.targets,dl.downloaded)} 个文件`;
    await patchState({
      lastHandledMessageKey:k,
      pendingContinueKey:k,
      pendingContinueAt:due,
      pendingContinueMode:'downloaded',
      downloadRetryKey:'',
      downloadRetryCount:0,
      downloadRetryAt:0,
      lastStatus:`${downloadStatus}，等待 ${Math.max(1,Number(s.delaySeconds)||3)} 秒后发送“${s.continueText}”`,
      logs:withLog(`${downloadStatus}，已满足续作条件`)
    });

    if(DONE.some(r=>r.test(tx))){await stop('研究完成，已停止');return}
    schedule(Math.max(150,due-Date.now()+50));
  }catch(e){
    console.error('[AutoContinueContinue]',e);
    await stop(`错误：${e?.message||e}`);
  }finally{
    busy=false;
  }
}

function schedule(ms=700){
  const due=Date.now()+Math.max(0,Number(ms)||0);
  // Coalesce wakeups without continually postponing an existing earlier check.
  if(timer&&timerDue&&timerDue<=due)return;
  if(timer)clearTimeout(timer);
  timerDue=due;
  timer=setTimeout(()=>{timer=null;timerDue=0;check()},Math.max(0,due-Date.now()));
}
function followBottomSoon(){
  if(followTimer)return;
  const wait=Math.max(120,PASSIVE_FOLLOW_MIN_GAP_MS-(Date.now()-lastPassiveFollowAt));
  followTimer=setTimeout(()=>{
    followTimer=null;
    passiveFollowBottom();
  },wait);
}
const obs=new MutationObserver(()=>{followBottomSoon();schedule(450)});
obs.observe(document.documentElement,{
  childList:true,subtree:true,characterData:true,attributes:true,
  // Avoid class/style animation noise; child/character changes and semantic attributes are enough
  // to detect generation, file controls, and completion without creating a scroll feedback loop.
  attributeFilter:['disabled','aria-disabled','aria-label','href','title','data-testid','data-turn','data-turn-id','data-message-author-role','data-turn-role','data-author-role','download','role']
});

chrome.runtime.onMessage.addListener((m,_sender,sendResponse)=>{
  if(m?.type==='CONTINUE_PING'){
    sendResponse({ok:true,version:VERSION});
    return true;
  }
  if(m?.type==='CONTINUE_PAGE_INFO'){
    const all=msgs();
    const health=conversationHealth();
    const assistantCount=all.filter(x=>messageRole(x)==='assistant').length;
    const inMain=!!lastAssistant()?.closest?.('main');
    sendResponse({
      ok:true,version:VERSION,origin:location.origin,path:location.pathname,
      messageCount:all.length,
      assistantCount,
      hasComposer:health.hasComposer,
      hasConversation:health.hasConversation,
      hasConcretePath:health.hasConcretePath,
      hasMain:health.hasMain,
      inMain,
      explicitMissing:health.explicitMissing,
      isConcrete:assistantCount>0 && health.hasComposer && inMain
    });
    return true;
  }
  if(m?.type==='CONTINUE_REFRESH')schedule(80);
  if(m?.type==='CONTINUE_TICK'){
    check();
    sendResponse({ok:true});
    return true;
  }
});

chrome.storage.onChanged.addListener((_c,a)=>{
  if(a==='local')schedule(120);
});

schedule(450);
})();
