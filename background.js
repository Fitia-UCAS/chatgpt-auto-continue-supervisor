const recent = [];
const ALARM = "chatgpt-continue-tick";
const TARGET_PREFIX = "continueTarget:";
const TARGET_INDEX_KEY = "continueTargetIds";
const DOWNLOAD_UI_SESSION_KEY = "continueDownloadUiSuppression";
const DOWNLOAD_UI_RECOVERY_ALARM = "chatgpt-continue-download-ui-recovery";
const DOWNLOAD_UI_SUPPRESS_MS = 4200;
const DOWNLOAD_UI_SUPPRESS_MAX_MS = 10000;
const DOWNLOAD_UI_BATCH_LEASE_MS = 180000;
const DOWNLOAD_UI_RELEASE_GRACE_MS = 1200;
const DOWNLOAD_UI_REHIDE_DELAYS_MS = [120, 400];

let downloadUiHiddenUntil = 0;
let downloadUiRestoreTimer = null;
let downloadUiSuppressionOwned = false;
let downloadUiRestoreNeeded = false;
let downloadUiQueue = Promise.resolve();
let downloadUiPersistQueue = Promise.resolve();
let downloadUiStateLoaded = false;
let downloadUiStateLoadPromise = null;
let downloadUiRestoreRetryCount = 0;
let downloadUiLastOwnerTabId = 0;
const downloadUiBatchLeases = new Map();
const downloadUiIssueSignatures = new Map();

function setDownloadUiEnabled(enabled){
  if(typeof chrome.downloads?.setUiOptions !== "function"){
    return Promise.resolve({ok:false,supported:false,error:"当前浏览器不支持 downloads.setUiOptions"});
  }
  const run = downloadUiQueue.then(()=>new Promise((resolve)=>{
    let settled=false;
    const finish=(result)=>{
      if(settled)return;
      settled=true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout=setTimeout(()=>finish({ok:false,supported:true,error:"downloads.setUiOptions 调用超时"}),1800);
    try{
      const pending = chrome.downloads.setUiOptions({enabled:!!enabled},()=>{
        const error=chrome.runtime.lastError?.message;
        finish(error
          ? {ok:false,supported:true,error}
          : {ok:true,supported:true,enabled:!!enabled});
      });
      if(pending?.then){
        pending.then(
          ()=>finish({ok:true,supported:true,enabled:!!enabled}),
          e=>finish({ok:false,supported:true,error:String(e?.message||e)})
        );
      }
    }catch(e){
      finish({ok:false,supported:true,error:String(e?.message||e)});
    }
  }));
  downloadUiQueue = run.catch(()=>{});
  return run;
}

function downloadUiDisableMayHaveTakenEffect(result){
  return !!result?.ok||/调用超时/.test(String(result?.error||''));
}

async function disableDownloadUi(){
  const previouslyNeeded=downloadUiRestoreNeeded;
  if(typeof chrome.downloads?.setUiOptions === "function")downloadUiRestoreNeeded=true;
  const result=await setDownloadUiEnabled(false);
  if(downloadUiDisableMayHaveTakenEffect(result)){
    downloadUiSuppressionOwned=true;
    downloadUiRestoreNeeded=true;
  }else if(!previouslyNeeded){
    downloadUiRestoreNeeded=false;
  }
  return result;
}

function pruneDownloadUiBatchLeases(){
  const now=Date.now();
  for(const [token,lease] of downloadUiBatchLeases){
    if(Number(lease?.expiresAt||0)<=now)downloadUiBatchLeases.delete(token);
  }
}

function downloadUiHoldUntil(){
  pruneDownloadUiBatchLeases();
  let until=Number(downloadUiHiddenUntil)||0;
  for(const lease of downloadUiBatchLeases.values())until=Math.max(until,Number(lease?.expiresAt)||0);
  return until;
}

function hasDownloadUiBatchLease(){
  pruneDownloadUiBatchLeases();
  return downloadUiBatchLeases.size>0;
}

function touchDownloadUiBatchLeases(tabId){
  const now=Date.now();
  for(const lease of downloadUiBatchLeases.values()){
    if(lease.tabId===tabId){
      lease.touchedAt=now;
      lease.expiresAt=Math.max(Number(lease.expiresAt)||0,now+DOWNLOAD_UI_BATCH_LEASE_MS);
    }
  }
}

function ensureDownloadUiStateLoaded(){
  if(downloadUiStateLoaded)return Promise.resolve();
  if(downloadUiStateLoadPromise)return downloadUiStateLoadPromise;
  downloadUiStateLoadPromise=(async()=>{
    try{
      const area=chrome.storage?.session;
      if(!area)return;
      const obj=await area.get(DOWNLOAD_UI_SESSION_KEY);
      const saved=obj?.[DOWNLOAD_UI_SESSION_KEY];
      if(!saved||typeof saved!=="object")return;
      downloadUiSuppressionOwned=!!saved.owned;
      downloadUiRestoreNeeded=!!saved.restoreNeeded||!!saved.owned;
      downloadUiLastOwnerTabId=Number(saved.lastOwnerTabId)||0;
      downloadUiHiddenUntil=Math.max(downloadUiHiddenUntil,Number(saved.hiddenUntil)||0);
      const now=Date.now();
      for(const lease of Array.isArray(saved.leases)?saved.leases:[]){
        const token=String(lease?.token||'').slice(0,160);
        const tabId=Number(lease?.tabId)||0;
        const expiresAt=Number(lease?.expiresAt)||0;
        if(token&&tabId&&expiresAt>now){
          downloadUiBatchLeases.set(token,{
            token,
            tabId,
            windowId:Number(lease?.windowId)||0,
            touchedAt:Number(lease?.touchedAt)||now,
            expiresAt
          });
        }
      }
    }catch{}
    finally{
      downloadUiStateLoaded=true;
      downloadUiStateLoadPromise=null;
    }
  })();
  return downloadUiStateLoadPromise;
}

function persistDownloadUiState(){
  const run=downloadUiPersistQueue.then(async()=>{
    const area=chrome.storage?.session;
    if(!area)return;
    pruneDownloadUiBatchLeases();
    const leases=[...downloadUiBatchLeases.values()].map(lease=>({
      token:lease.token,
      tabId:lease.tabId,
      windowId:lease.windowId,
      touchedAt:lease.touchedAt,
      expiresAt:lease.expiresAt
    }));
    const holdUntil=downloadUiHoldUntil();
    if(!downloadUiSuppressionOwned&&!downloadUiRestoreNeeded&&!leases.length&&holdUntil<=Date.now()){
      await area.remove(DOWNLOAD_UI_SESSION_KEY).catch(()=>{});
      await chrome.alarms.clear(DOWNLOAD_UI_RECOVERY_ALARM).catch(()=>{});
      return;
    }
    await area.set({
      [DOWNLOAD_UI_SESSION_KEY]:{
        owned:!!downloadUiSuppressionOwned,
        restoreNeeded:!!downloadUiRestoreNeeded,
        lastOwnerTabId:downloadUiLastOwnerTabId,
        hiddenUntil:Number(downloadUiHiddenUntil)||0,
        leases,
        updatedAt:Date.now()
      }
    });
    await chrome.alarms.create(DOWNLOAD_UI_RECOVERY_ALARM,{
      when:Math.max(Date.now()+1000,holdUntil+120)
    });
  });
  downloadUiPersistQueue=run.catch(()=>{});
  return run;
}

async function persistDownloadUiStateSafely(){
  try{
    await persistDownloadUiState();
    return {ok:true};
  }catch(e){
    return {ok:false,error:String(e?.message||e)};
  }
}

async function reportDownloadUiIssue(tabId,result){
  if(result?.ok||!tabId)return;
  const signature=`${result?.supported===false?'unsupported':'error'}:${result?.error||'未知错误'}`;
  const previous=downloadUiIssueSignatures.get(tabId);
  if(previous?.signature===signature&&Date.now()-previous.at<30000)return;
  downloadUiIssueSignatures.set(tabId,{signature,at:Date.now()});
  const current=await getTarget(tabId).catch(()=>null);
  if(!current?.enabled)return;
  await patchTarget(tabId,{
    logs:appendLog(current.logs,`无法调用 Edge 下载面板关闭接口：${result?.error||'浏览器不支持'}`,'error')
  }).catch(()=>{});
}

async function beginDownloadUiBatch(tabId,windowId,token){
  await ensureDownloadUiStateLoaded();
  const safeToken=String(token||'').slice(0,160);
  if(!safeToken)return {ok:false,error:"缺少下载批次标识"};
  const now=Date.now();
  downloadUiLastOwnerTabId=tabId;
  downloadUiBatchLeases.set(safeToken,{
    token:safeToken,
    tabId,
    windowId:Number(windowId)||0,
    touchedAt:now,
    expiresAt:now+DOWNLOAD_UI_BATCH_LEASE_MS
  });
  const result=await disableDownloadUi();
  scheduleDownloadUiRestore();
  const persistence=await persistDownloadUiStateSafely();
  await reportDownloadUiIssue(tabId,result);
  return {...result,token:safeToken,...(!persistence.ok?{warning:`恢复标记写入失败：${persistence.error}`}:{})};
}

async function endDownloadUiBatch(tabId,token){
  await ensureDownloadUiStateLoaded();
  const safeToken=String(token||'').slice(0,160);
  const lease=downloadUiBatchLeases.get(safeToken);
  if(lease?.tabId!==tabId)return {ok:true,released:false};
  downloadUiLastOwnerTabId=tabId;
  downloadUiBatchLeases.delete(safeToken);
  downloadUiHiddenUntil=Math.max(downloadUiHiddenUntil,Date.now()+DOWNLOAD_UI_RELEASE_GRACE_MS);
  // Edge may mount the flyout just after the final download event. Close it once
  // more, then keep UI disabled during a short settling window before restoring.
  const result=await disableDownloadUi();
  scheduleDownloadUiRestore();
  const persistence=await persistDownloadUiStateSafely();
  await reportDownloadUiIssue(tabId,result);
  return {...result,released:true,...(!persistence.ok?{warning:`恢复标记写入失败：${persistence.error}`}:{})};
}

function releaseDownloadUiBatchesForTab(tabId){
  let changed=false;
  for(const [token,lease] of downloadUiBatchLeases){
    if(lease.tabId===tabId){downloadUiBatchLeases.delete(token);changed=true}
  }
  if(changed){
    downloadUiHiddenUntil=Math.max(downloadUiHiddenUntil,Date.now()+DOWNLOAD_UI_RELEASE_GRACE_MS);
    scheduleDownloadUiRestore();
    void persistDownloadUiStateSafely();
  }
}

function scheduleDownloadUiRestore(){
  if(downloadUiRestoreTimer) clearTimeout(downloadUiRestoreTimer);
  const holdUntil=downloadUiHoldUntil();
  if(!downloadUiSuppressionOwned&&!downloadUiRestoreNeeded&&holdUntil<=Date.now())return;
  const delay=Math.max(80,holdUntil-Date.now()+40);
  downloadUiRestoreTimer=setTimeout(()=>{
    downloadUiRestoreTimer=null;
    restoreDownloadUiIfDue().catch(()=>{});
  },delay);
}

async function restoreDownloadUiIfDue(){
  await ensureDownloadUiStateLoaded();
  const holdUntil=downloadUiHoldUntil();
  if(Date.now()<holdUntil){scheduleDownloadUiRestore();return {ok:true,deferred:true}}
  downloadUiHiddenUntil=0;
  if(!downloadUiSuppressionOwned&&!downloadUiRestoreNeeded){
    await persistDownloadUiStateSafely();
    return {ok:true,restored:false};
  }
  const result=await setDownloadUiEnabled(true);
  if(result.ok){
    downloadUiSuppressionOwned=false;
    downloadUiRestoreNeeded=false;
    downloadUiRestoreRetryCount=0;
    downloadUiLastOwnerTabId=0;
  }else{
    downloadUiRestoreNeeded=true;
    downloadUiRestoreRetryCount++;
    const retryMs=Math.min(30000,600*(2**Math.min(6,downloadUiRestoreRetryCount-1)));
    downloadUiHiddenUntil=Date.now()+retryMs;
    scheduleDownloadUiRestore();
    const newest=[...downloadUiBatchLeases.values()].sort((a,b)=>b.touchedAt-a.touchedAt)[0];
    const reportTabId=newest?.tabId||downloadUiLastOwnerTabId;
    if(reportTabId)void reportDownloadUiIssue(reportTabId,{...result,error:`恢复下载界面失败：${result.error||'未知错误'}`});
  }
  await persistDownloadUiStateSafely();
  return {...result,restored:!!result.ok};
}

async function suppressDownloadUi(durationMs=DOWNLOAD_UI_SUPPRESS_MS){
  await ensureDownloadUiStateLoaded();
  const duration=Math.max(700,Math.min(DOWNLOAD_UI_SUPPRESS_MAX_MS,Number(durationMs)||DOWNLOAD_UI_SUPPRESS_MS));
  downloadUiHiddenUntil=Math.max(downloadUiHiddenUntil,Date.now()+duration);
  const result=await disableDownloadUi();
  scheduleDownloadUiRestore();
  await persistDownloadUiStateSafely();
  return {...result,hiddenUntil:downloadUiHiddenUntil};
}

async function resetDownloadUi(){
  const recoveryWasNeeded=downloadUiSuppressionOwned||downloadUiRestoreNeeded;
  downloadUiStateLoaded=true;
  downloadUiStateLoadPromise=null;
  downloadUiHiddenUntil=0;
  downloadUiBatchLeases.clear();
  if(downloadUiRestoreTimer){clearTimeout(downloadUiRestoreTimer);downloadUiRestoreTimer=null}
  const result=await setDownloadUiEnabled(true);
  if(result.ok){
    downloadUiSuppressionOwned=false;
    downloadUiRestoreNeeded=false;
    downloadUiRestoreRetryCount=0;
    downloadUiLastOwnerTabId=0;
  }else if(recoveryWasNeeded||/调用超时/.test(String(result?.error||''))){
    downloadUiSuppressionOwned=downloadUiSuppressionOwned||/调用超时/.test(String(result?.error||''));
    downloadUiRestoreNeeded=true;
    downloadUiHiddenUntil=Date.now()+1000;
    scheduleDownloadUiRestore();
  }else{
    downloadUiSuppressionOwned=false;
    downloadUiRestoreNeeded=false;
  }
  await persistDownloadUiStateSafely();
  return result;
}

const TARGET_DEFAULTS = {
  enabled:false,
  targetOrigin:"",
  targetPath:"",
  targetTabId:0,
  continueText:"继续",
  delaySeconds:3,
  maxCycles:100,
  continueWithoutDownload:true,
  cycleCount:0,
  lastHandledMessageKey:"",
  lastBackfillMessageKey:"",
  lastStatus:"未启动",
  pendingContinueKey:"",
  pendingContinueAt:0,
  pendingContinueMode:"",
  downloadRetryKey:"",
  downloadRetryCount:0,
  downloadRetryAt:0,
  logs:[],
  startedAt:0
};

const LEGACY_DEFAULTS = {...TARGET_DEFAULTS};
let indexQueue = Promise.resolve();

function appendLog(logs, text, level="info") {
  const now = Date.now();
  const next = Array.isArray(logs) ? logs.slice(-79) : [];
  const last = next.at(-1);
  if (last?.text === text && last?.level === level && now - Number(last.at || 0) < 2500) return next;
  next.push({at:now, level, text:String(text || "")});
  return next.slice(-80);
}

function targetKey(tabId){ return `${TARGET_PREFIX}${Number(tabId)||0}`; }
function withIndexLock(fn){
  const run = indexQueue.then(fn, fn);
  indexQueue = run.catch(()=>{});
  return run;
}

async function readIndex(){
  const obj = await chrome.storage.local.get({[TARGET_INDEX_KEY]:[]});
  return [...new Set((obj[TARGET_INDEX_KEY]||[]).map(Number).filter(Number.isInteger).filter(x=>x>0))];
}

async function writeIndex(ids){
  const clean = [...new Set((ids||[]).map(Number).filter(Number.isInteger).filter(x=>x>0))];
  await chrome.storage.local.set({[TARGET_INDEX_KEY]:clean});
  return clean;
}

async function addToIndex(tabId){
  return withIndexLock(async()=>{
    const ids = await readIndex();
    if(!ids.includes(tabId)) ids.push(tabId);
    return writeIndex(ids);
  });
}

async function removeFromIndex(tabId){
  return withIndexLock(async()=>{
    const ids = (await readIndex()).filter(id=>id!==tabId);
    return writeIndex(ids);
  });
}

async function getTarget(tabId){
  tabId = Number(tabId)||0;
  if(!tabId) return null;
  const key = targetKey(tabId);
  const obj = await chrome.storage.local.get(key);
  const raw = obj[key];
  if(!raw || typeof raw !== "object") return null;
  return {...TARGET_DEFAULTS, ...raw, targetTabId:tabId};
}

async function startTarget(tabId, data={}){
  tabId = Number(tabId)||0;
  if(!tabId) throw new Error("无效标签页");
  const next = {
    ...TARGET_DEFAULTS,
    ...data,
    enabled:true,
    targetTabId:tabId,
    startedAt:Date.now()
  };
  await chrome.storage.local.set({[targetKey(tabId)]:next});
  await addToIndex(tabId);
  await reconcileAlarm();
  return next;
}

async function patchTarget(tabId, patch={}){
  tabId = Number(tabId)||0;
  if(!tabId) throw new Error("无效标签页");
  const current = await getTarget(tabId);
  if(!current) throw new Error("当前标签页没有监督任务");
  if(!current.enabled) return current;
  const next = {...current, ...patch, targetTabId:tabId};
  await chrome.storage.local.set({[targetKey(tabId)]:next});
  if(next.enabled) await addToIndex(tabId); else await removeFromIndex(tabId);
  return next;
}

async function stopTarget(tabId, reason="已停止"){
  tabId = Number(tabId)||0;
  if(!tabId) return null;
  await ensureDownloadUiStateLoaded();
  releaseDownloadUiBatchesForTab(tabId);
  const current = await getTarget(tabId);
  if(current){
    const next = {
      ...current,
      enabled:false,
      pendingContinueKey:"",
      pendingContinueAt:0,
      pendingContinueMode:"",
      downloadRetryKey:"",
      downloadRetryCount:0,
      downloadRetryAt:0,
      lastStatus:reason,
      logs:appendLog(current.logs, reason, /错误|失败|失效|删除|不存在/.test(reason)?"error":"info"),
      targetTabId:tabId
    };
    await chrome.storage.local.set({[targetKey(tabId)]:next});
  }
  await removeFromIndex(tabId);
  await reconcileAlarm();
  return current ? {...current, enabled:false, pendingContinueKey:"", pendingContinueAt:0, pendingContinueMode:"", downloadRetryKey:"", downloadRetryCount:0, downloadRetryAt:0, lastStatus:reason} : null;
}

async function clearTargetLogs(tabId){
  tabId = Number(tabId)||0;
  if(!tabId) throw new Error("无效标签页");
  const current = await getTarget(tabId);
  if(!current) return null;
  const next = {...current, logs:[], targetTabId:tabId};
  await chrome.storage.local.set({[targetKey(tabId)]:next});
  return next;
}


async function applyContinueSettings(settings={}){
  const allow = settings.continueWithoutDownload !== false;
  const ids = await readIndex();
  const now = Date.now();
  await Promise.all(ids.map(async(tabId)=>{
    const current = await getTarget(tabId);
    if(!current?.enabled) return;
    const patch = {continueWithoutDownload:allow};
    if(allow){
      // If strict mode was waiting for another retry, wake it immediately.
      patch.downloadRetryAt = 0;
    }else if(current.pendingContinueMode === "unconfirmed" && current.pendingContinueKey){
      // Strict mode only cancels a pending send when a file was actually found but its
      // download was not confirmed. A no-file reply uses mode "no-file" and always continues.
      patch.downloadRetryKey = current.pendingContinueKey;
      patch.downloadRetryCount = current.downloadRetryCount || 0;
      patch.downloadRetryAt = now;
      if(current.lastHandledMessageKey === current.pendingContinueKey) patch.lastHandledMessageKey = "";
      patch.pendingContinueKey = "";
      patch.pendingContinueAt = 0;
      patch.pendingContinueMode = "";
    }
    await patchTarget(tabId, patch);
    try{ await chrome.tabs.sendMessage(tabId,{type:"CONTINUE_TICK",source:"settings-change"}); }catch{}
  }));
  return {ok:true,activeCount:await countActiveTargets()};
}

async function countActiveTargets(){
  const ids = await readIndex();
  if(!ids.length) return 0;
  const states = await Promise.all(ids.map(getTarget));
  return states.filter(s=>s?.enabled).length;
}

chrome.downloads.onCreated.addListener((item) => {
  recent.push({
    id: item.id,
    filename: item.filename || "",
    url: item.url || "",
    finalUrl: item.finalUrl || "",
    referrer: item.referrer || "",
    state: item.state || "",
    startTime: Date.now()
  });
  while (recent.length > 40) recent.shift();
  void ensureDownloadUiStateLoaded().then(()=>{
    // Edge can mount its Downloads flyout after onCreated. Re-apply the official hide
    // operation immediately and twice more after the browser UI has had time to mount.
    const shouldRehide=()=>hasDownloadUiBatchLease()||(downloadUiSuppressionOwned&&Date.now()<downloadUiHiddenUntil);
    const rehide=()=>{
      if(!shouldRehide())return;
      void disableDownloadUi().then(result=>{
        void persistDownloadUiStateSafely();
        const newest=[...downloadUiBatchLeases.values()].sort((a,b)=>b.touchedAt-a.touchedAt)[0];
        if(!result.ok&&newest?.tabId)void reportDownloadUiIssue(newest.tabId,result);
      });
    };
    rehide();
    for(const delay of DOWNLOAD_UI_REHIDE_DELAYS_MS)setTimeout(rehide,delay);
  }).catch(()=>{});
});

async function migrateLegacySingleTarget(){
  const index = await readIndex();
  if(index.length) return;
  const legacy = await chrome.storage.local.get(LEGACY_DEFAULTS);
  const tabId = Number(legacy.targetTabId)||0;
  if(!legacy.enabled || !tabId || !legacy.targetOrigin || !legacy.targetPath) return;
  await startTarget(tabId, legacy);
  await chrome.storage.local.set({enabled:false, lastStatus:"已迁移到多页面监督"});
}

const LEGACY_SETTINGS_KEY = "supervisorSettings";
const LEGACY_ALARMS = ["chatgpt-auto-continue-supervisor-tick","chatgpt-auto-continue-supervisor-download-ui-recovery"];
async function migrateLegacyNames(){
  try{
    const old = (await chrome.storage.local.get(LEGACY_SETTINGS_KEY))[LEGACY_SETTINGS_KEY];
    if(old){
      const current = (await chrome.storage.local.get("continueSettings")).continueSettings;
      if(!current) await chrome.storage.local.set({continueSettings:old});
      await chrome.storage.local.remove(LEGACY_SETTINGS_KEY);
    }
  }catch{}
  for(const name of LEGACY_ALARMS){try{await chrome.alarms.clear(name);}catch{}}
}

async function reconcileAlarm(){
  const ids = await readIndex();
  if(ids.length){
    // One shared alarm wakes every supervised ChatGPT tab. Each tab keeps an independent state record.
    await chrome.alarms.create(ALARM,{periodInMinutes:0.5});
  }else{
    await chrome.alarms.clear(ALARM);
  }
}

function sameLockedConversation(urlString,s){
  let u;
  try{u=new URL(urlString||"")}catch{return false}
  return u.origin===s.targetOrigin && u.pathname===s.targetPath;
}

async function wakeTarget(tabId){
  const s = await getTarget(tabId);
  if(!s?.enabled) return;

  let tab;
  try{ tab = await chrome.tabs.get(tabId); }catch{}
  if(!tab?.id){
    await stopTarget(tabId,"目标对话标签页已关闭，监督已停止");
    return;
  }
  if(!sameLockedConversation(tab.url,s)){
    await stopTarget(tabId,"目标标签页已离开锁定对话，监督已停止");
    return;
  }

  try{
    await chrome.tabs.sendMessage(tab.id,{type:"CONTINUE_TICK",source:"background-alarm"});
  }catch(e){
    try{
      await chrome.scripting.executeScript({target:{tabId:tab.id},files:["continue.js"]});
      await chrome.tabs.sendMessage(tab.id,{type:"CONTINUE_TICK",source:"background-alarm-reinject"});
    }catch(err){
      await patchTarget(tabId,{lastStatus:`后台巡检暂时无法连接目标页：${err?.message||err}`}).catch(()=>{});
    }
  }
}

async function wakeTargets(){
  const ids = await readIndex();
  await Promise.all(ids.map(id=>wakeTarget(id).catch(()=>{})));
}

chrome.alarms.onAlarm.addListener((alarm)=>{
  if(alarm?.name===ALARM) wakeTargets();
  if(alarm?.name===DOWNLOAD_UI_RECOVERY_ALARM){
    void ensureDownloadUiStateLoaded().then(()=>restoreDownloadUiIfDue()).catch(()=>{});
  }
});

chrome.tabs.onRemoved.addListener((tabId)=>{
  ensureDownloadUiStateLoaded().then(()=>{
    releaseDownloadUiBatchesForTab(tabId);
    return getTarget(tabId);
  }).then(s=>{
    if(s?.enabled) return stopTarget(tabId,"目标对话标签页已关闭，监督已停止");
  }).catch(()=>{});
});

chrome.tabs.onUpdated.addListener((tabId,changeInfo,tab)=>{
  if(!changeInfo.url) return;
  getTarget(tabId).then(s=>{
    if(!s?.enabled) return;
    if(!sameLockedConversation(changeInfo.url || tab?.url,s)){
      return stopTarget(tabId,"目标标签页已离开锁定对话，监督已停止");
    }
  }).catch(()=>{});
});

chrome.runtime.onStartup.addListener(()=>Promise.all([resetDownloadUi(),migrateLegacyNames(),migrateLegacySingleTarget().then(reconcileAlarm)]).catch(()=>{}));
chrome.runtime.onInstalled.addListener(()=>Promise.all([resetDownloadUi(),migrateLegacyNames(),migrateLegacySingleTarget().then(reconcileAlarm)]).catch(()=>{}));
chrome.runtime.onSuspend?.addListener(()=>{
  // Do not re-enable UI in the middle of an active batch. The session marker and
  // recovery alarm survive service-worker suspension and perform a confirmed restore.
  if(downloadUiSuppressionOwned||downloadUiRestoreNeeded||downloadUiBatchLeases.size)void persistDownloadUiStateSafely();
});
chrome.storage.onChanged.addListener((_changes,area)=>{
  if(area==='local') reconcileAlarm().catch(()=>{});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if(msg?.type === "CONTINUE_BEGIN_DOWNLOAD_UI_BATCH"){
    const tabId=sender?.tab?.id||0;
    if(!tabId){sendResponse({ok:false,error:"无法确定当前监督标签页"});return true}
    getTarget(tabId).then(current=>{
      if(!current?.enabled)return {ok:false,error:"监督任务已停止"};
      return beginDownloadUiBatch(tabId,sender?.tab?.windowId||0,msg.token);
    }).then(sendResponse).catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));
    return true;
  }

  if(msg?.type === "CONTINUE_END_DOWNLOAD_UI_BATCH"){
    const tabId=sender?.tab?.id||0;
    if(!tabId){sendResponse({ok:false,error:"无法确定当前监督标签页"});return true}
    endDownloadUiBatch(tabId,msg.token).then(sendResponse).catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));
    return true;
  }

  if(msg?.type === "CONTINUE_SUPPRESS_DOWNLOAD_UI"){
    const tabId=sender?.tab?.id||0;
    if(!tabId){sendResponse({ok:false,error:"无法确定当前监督标签页"});return true}
    Promise.all([getTarget(tabId),ensureDownloadUiStateLoaded()]).then(([current])=>{
      if(!current?.enabled)return {ok:false,error:"监督任务已停止"};
      downloadUiLastOwnerTabId=tabId;
      touchDownloadUiBatchLeases(tabId);
      return suppressDownloadUi(msg.durationMs);
    }).then(sendResponse).catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));
    return true;
  }

  if (msg?.type === "DOWNLOADS_SINCE") {
    const since = Number(msg.since) || 0;
    const names = Array.isArray(msg.names) ? msg.names.map(x => String(x).toLowerCase()).filter(Boolean) : [];
    const filterMatches = (items) => items.filter((x) => {
      const start = Number(x.startTime) || Date.parse(x.startTime || "") || 0;
      if (start < since) return false;
      if (!names.length) return true;
      let hay = `${x.filename || ""} ${x.url || ""} ${x.finalUrl || ""} ${x.referrer || ""}`.toLowerCase();
      try{ hay = decodeURIComponent(hay); }catch{}
      return names.some((n) => {
        let name=String(n||"").toLowerCase();
        try{ name=decodeURIComponent(name); }catch{}
        if(!name)return false;
        if(hay.includes(name))return true;
        const stem=name.replace(/\.[a-z0-9]{1,8}$/i,"");
        return stem.length>=4 && hay.includes(stem);
      });
    });

    const memoryMatches = filterMatches(recent);
    if (memoryMatches.length) {
      sendResponse({ matches: memoryMatches, source: "recent-event" });
      return true;
    }

    const startedAfter = new Date(Math.max(0, since)).toISOString();
    chrome.downloads.search({ startedAfter, limit: 40, orderBy: ["-startTime"] })
      .then((items) => {
        const normalized = (items || []).map((x) => ({
          id: x.id,
          filename: x.filename || "",
          url: x.url || "",
          finalUrl: x.finalUrl || "",
          referrer: x.referrer || "",
          state: x.state || "",
          startTime: Date.parse(x.startTime || "") || 0
        }));
        sendResponse({ matches: filterMatches(normalized), source: "downloads-search" });
      })
      .catch(() => sendResponse({ matches: [], source: "downloads-search-error" }));
    return true;
  }


  if(msg?.type === "CONTINUE_LATE_DOWNLOAD_CONFIRMED"){
    const tabId = sender?.tab?.id || 0;
    if(!tabId){ sendResponse({ok:false,error:"无法确定当前监督标签页"}); return true; }
    getTarget(tabId).then(async current=>{
      if(!current?.enabled){ sendResponse({ok:false,error:"监督任务已停止"}); return; }
      const messageKey=String(msg.messageKey||"");
      const count=Math.max(1,Array.isArray(msg.matches)?msg.matches.length:1);
      const expected=Math.max(1,Number(msg.expectedCount)||1);
      const text=`浏览器已补确认下载 ${count}/${expected} 个文件`;
      const patch={logs:appendLog(current.logs,text,"info")};
      // Only replace the visible status while this exact assistant turn is still waiting to send.
      // If continuation has already fired, keep the newer generation status and add only the log.
      if(current.pendingContinueKey===messageKey && current.pendingContinueMode==="unconfirmed"){
        patch.pendingContinueMode="downloaded-late";
        const remain=Math.max(0,Math.ceil(((Number(current.pendingContinueAt)||0)-Date.now())/1000));
        patch.lastStatus=remain>0?`${text}，仍按原计划于 ${remain} 秒后发送“${current.continueText}”`:`${text}，正在按原计划续作`;
      }
      const next=await patchTarget(tabId,patch);
      sendResponse({ok:true,state:next});
    }).catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));
    return true;
  }

  if(msg?.type === "CONTINUE_IS_TARGET"){
    const senderTabId = sender?.tab?.id || 0;
    Promise.all([getTarget(senderTabId), countActiveTargets()]).then(([s,activeCount])=>{
      const senderUrl = sender?.tab?.url || msg.url || "";
      sendResponse({
        ok:true,
        enabled:!!s?.enabled,
        isTarget:!!s?.enabled,
        conversationMatches:!!s?.enabled && sameLockedConversation(senderUrl,s),
        targetTabId:senderTabId,
        state:s,
        activeCount
      });
    }).catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));
    return true;
  }

  if(msg?.type === "CONTINUE_GET_TARGET"){
    const tabId = Number(msg.tabId)||0;
    Promise.all([getTarget(tabId), countActiveTargets()])
      .then(([s,activeCount])=>sendResponse({ok:true,state:s,activeCount}))
      .catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));
    return true;
  }

  if(msg?.type === "CONTINUE_START_TARGET"){
    const tabId = Number(msg.tabId)||0;
    startTarget(tabId,msg.state||{})
      .then(async s=>sendResponse({ok:true,state:s,activeCount:await countActiveTargets()}))
      .catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));
    return true;
  }

  if(msg?.type === "CONTINUE_PATCH_TARGET"){
    const tabId = sender?.tab?.id || 0;
    if(!tabId){ sendResponse({ok:false,error:"只能由被监督的 ChatGPT 标签页更新状态"}); return true; }
    patchTarget(tabId,msg.patch||{})
      .then(s=>sendResponse({ok:true,state:s}))
      .catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));
    return true;
  }

  if(msg?.type === "CONTINUE_STOP_SELF"){
    const tabId = sender?.tab?.id || 0;
    if(!tabId){ sendResponse({ok:false,error:"无法确定当前监督标签页"}); return true; }
    stopTarget(tabId,msg.reason||"已停止")
      .then(()=>sendResponse({ok:true}))
      .catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));
    return true;
  }

  if(msg?.type === "CONTINUE_STOP_TARGET"){
    const tabId = Number(msg.tabId)||0;
    stopTarget(tabId,msg.reason||"手动停止")
      .then(async()=>sendResponse({ok:true,activeCount:await countActiveTargets()}))
      .catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));
    return true;
  }


  if(msg?.type === "CONTINUE_APPLY_SETTINGS"){
    applyContinueSettings(msg.settings||{})
      .then(sendResponse)
      .catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));
    return true;
  }

  if(msg?.type === "CONTINUE_CLEAR_LOGS"){
    const tabId = Number(msg.tabId)||0;
    clearTargetLogs(tabId)
      .then(()=>sendResponse({ok:true}))
      .catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));
    return true;
  }

  if(msg?.type === "CONTINUE_BG_RECONCILE"){
    reconcileAlarm().then(()=>sendResponse({ok:true})).catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));
    return true;
  }
  if(msg?.type === "CONTINUE_BG_WAKE_NOW"){
    wakeTargets().then(()=>sendResponse({ok:true})).catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));
    return true;
  }
});

ensureDownloadUiStateLoaded().then(()=>{
  if(downloadUiSuppressionOwned||downloadUiRestoreNeeded||hasDownloadUiBatchLease()||downloadUiHiddenUntil>Date.now()){
    scheduleDownloadUiRestore();
    return persistDownloadUiStateSafely();
  }
  return resetDownloadUi();
}).catch(()=>{});
migrateLegacyNames().then(()=>migrateLegacySingleTarget()).then(reconcileAlarm).catch(()=>{});
