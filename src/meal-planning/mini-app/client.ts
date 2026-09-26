/** Data-free Mini App document. All plan content is fetched after Telegram authentication. */
const MINI_APP_STATE_SCRIPT = `<script>
(()=>{"use strict";
let state=null;
const originalFetch=window.fetch.bind(window);
const refresh=()=>window.dispatchEvent(new Event("kipp:plan-load"));
const activePlan=()=>state.plan||state.currentPlan;
const weekLabel=weekStart=>new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",timeZone:activePlan()?.timezone||"UTC"}).format(new Date(weekStart));
const renderState=()=>{
  if(!state)return;
  const app=document.getElementById("app");
  if(state.status==="generating"&&!state.currentPlan){
    if(!app.querySelector(".generating-empty")){
      const empty=document.createElement("div");
      empty.className="empty generating-empty";
      empty.textContent="Your first meal plan is being generated.";
      const button=document.createElement("button");
      button.textContent="Refresh plan";
      button.onclick=refresh;
      empty.append(" ",button);
      app.replaceChildren(empty);
    }
    return;
  }
  const card=app.querySelector(".card"),head=card?.querySelector(".head");
  if(!head)return;
  const readOnly=state.status!=="current"||state.currentPlan!==undefined;
  card.querySelectorAll(".plan-change,.meal button,.drafts").forEach(control=>control.hidden=readOnly);
  const title=head.querySelector(".title");
  if(state.history?.length>1){
    const picker=document.createElement("span");
    picker.className="week-picker";
    const select=document.createElement("select");
    select.className="week-select";
    select.setAttribute("aria-label","Choose meal plan week");
    const selectedId=activePlan()?.planId;
    state.history.forEach(entry=>{
      const option=document.createElement("option");
      option.value=entry.planId;
      option.textContent=weekLabel(entry.weekStart);
      option.selected=entry.planId===selectedId;
      select.append(option);
    });
    select.onchange=()=>{
      const entry=state.history.find(item=>item.planId===select.value);
      if(!entry)return;
      const url=new URL(window.location.href);
      if(entry.lifecycle==="current")url.searchParams.delete("planId");
      else url.searchParams.set("planId",entry.planId);
      window.history.pushState(null,"",url);
      refresh();
    };
    picker.append(select);
    title.replaceChildren(document.createTextNode("Week of "),picker);
  }
  if(readOnly){
    const indicator=document.createElement("span");
    indicator.className="read-only-indicator";
    indicator.setAttribute("role","img");
    indicator.setAttribute("aria-label","Read-only plan");
    indicator.innerHTML='<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';
    head.querySelector(".head-action").append(indicator);
  }
  if(state.status==="generating"){
    const notice=document.createElement("div");
    notice.className="notice";
    notice.textContent="A new plan is being generated.";
    const button=document.createElement("button");
    button.className="refresh-plan";
    button.textContent="Refresh plan";
    button.onclick=refresh;
    notice.append(" ",button);
    head.after(notice);
  }
};
window.fetch=async(input,init)=>{
  let url=typeof input==="string"?input:input.url;
  if(url.endsWith("/mini-app/api/plan")&&window.location.search)url+=window.location.search;
  const response=await originalFetch(url,init);
  if(url.includes("/mini-app/api/plan")){
    try{
      const body=await response.clone().json();
      state=body;
      if(body.status==="generating"&&body.currentPlan)return new Response(JSON.stringify({...body,status:"current",plan:body.currentPlan}),{status:response.status,headers:response.headers});
    }catch{}
  }
  return response;
};
new MutationObserver(renderState).observe(document.getElementById("app"),{childList:true});
})();
</script>`
export const MINI_APP_SHELL = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Kipp · School meal plan</title><style>
:root{color-scheme:dark;--bg:#101812;--card:#17271d;--line:#3a513f;--text:#f2f5ef;--muted:#b4c1b5;--accent:#cdebc9;--button:#27452e}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:17px/1.45 system-ui,sans-serif}main{max-width:680px;margin:auto;padding:env(safe-area-inset-top,16px) 10px calc(28px + env(safe-area-inset-bottom,0px))}.card{background:var(--card);border:1px solid var(--line);border-radius:28px;overflow:hidden}.head{padding:38px 34px 28px;border-bottom:1px solid var(--line)}.head-main{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:20px}.head-action{display:flex;align-items:center;flex:none}.eyebrow{color:var(--muted);font-weight:700;letter-spacing:.04em}.title{font-size:37px;line-height:1.1;margin:0;letter-spacing:-.045em;white-space:nowrap}.week-picker{display:inline-flex;position:relative;max-width:100%}.week-picker:after{content:"⌄";position:absolute;right:2px;top:48%;transform:translateY(-50%);font-size:.7em;pointer-events:none;color:var(--accent)}.week-select{appearance:none;-webkit-appearance:none;font:inherit;font-weight:inherit;letter-spacing:inherit;line-height:inherit;color:var(--text);background:transparent;border:0;border-bottom:2px solid var(--accent);border-radius:0;padding:0 26px 2px 0;max-width:100%;cursor:pointer}.week-select:focus-visible{outline:2px solid var(--accent);outline-offset:4px}.week-select option{color:#101812;background:#f2f5ef}.muted{color:var(--muted)}button{font:inherit;font-weight:700;color:var(--accent);background:var(--button);border:1px solid #547259;border-radius:17px;padding:10px 15px;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}.plan-change,.meal button{width:108px;height:44px;padding:8px;font-size:14px;line-height:1.2}.read-only-indicator{display:grid;place-items:center;width:48px;height:48px;color:var(--accent);background:var(--button);border:1px solid #547259;border-radius:17px}.notice{padding:14px 34px;color:var(--muted);border-bottom:1px solid var(--line)}.notice button{margin-left:8px}.days{display:grid;grid-template-columns:repeat(6,1fr);border-bottom:1px solid var(--line);padding:18px 12px;gap:4px}.day{position:relative;background:transparent;border:0;padding:8px 2px;color:var(--text);border-radius:12px}.day[aria-current=true]{background:#294230}.day small{display:block;color:var(--muted)}.badge{font-size:11px;color:var(--muted);display:block;position:absolute;right:6px;bottom:5px;line-height:1}.half-day-badge{font-size:16px;left:calc(50% + 17px);right:auto;bottom:12px}.content{padding:26px}.summary{color:var(--muted);margin:0 0 26px}.meal{display:grid;grid-template-columns:145px 1fr auto;gap:12px;align-items:center;border:1px solid var(--line);border-radius:25px;padding:22px 24px;margin:14px 0}.slot{font-weight:700;color:var(--muted)}.dish{font-size:24px;font-weight:750;line-height:1.15}.meta{color:var(--muted);margin-top:4px}.easy-buys{border:1px solid var(--line);border-radius:20px;padding:18px 20px;margin:26px 0 18px}.easy-buys h2{font-size:22px;margin:0 0 8px}.easy-buys ul{margin:0;padding-left:24px;color:var(--muted)}.easy-buys p{margin:0;color:var(--muted)}.drafts{margin:18px 0}.draft{display:flex;justify-content:space-between;align-items:center;gap:10px;border-top:1px solid var(--line);padding:11px 0}.draft button{height:52px}.status,.empty{padding:42px 28px;text-align:center}.sheet{position:fixed;inset:0;background:#000a;display:flex;align-items:end}.sheet>div{width:100%;background:#17271d;border-radius:28px 28px 0 0;padding:26px max(20px,env(safe-area-inset-right)) calc(24px + env(safe-area-inset-bottom));}.sheet textarea{width:100%;min-height:120px;margin:13px 0;background:#101812;color:var(--text);border:1px solid var(--line);border-radius:14px;padding:12px;font:inherit}.actions{display:flex;justify-content:flex-end;gap:10px}@media(max-width:520px){.meal{grid-template-columns:1fr auto}.slot{grid-column:1/-1}.dish{font-size:21px}.head{padding:28px 18px}.head-main{gap:8px}.title{font-size:23px}.notice{padding:14px 24px}.content{padding:20px}.days{font-size:15px}}@media(max-width:360px){.head{padding-inline:14px}.title{font-size:17px}}
</style></head><body><main id="app" aria-live="polite"><div class="status">Loading your plan…</div></main><script src="https://telegram.org/js/telegram-web-app.js"></script><script>
(()=>{"use strict";const app=document.getElementById("app"),tg=window.Telegram&&window.Telegram.WebApp,storage=tg&&tg.DeviceStorage;let token="",plan=null,selectedDay="",drafts=[],batchKey="";const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n};const request=async(path,opts={})=>{const r=await fetch(path,{...opts,headers:{...(opts.headers||{}),...(token?{Authorization:"Bearer "+token}:{})}});let body={};try{body=await r.json()}catch{}return{r,body}};const key=()=>plan?"kipp-meal-drafts:"+plan.planId+":v"+plan.version:"";const readDrafts=async()=>{const k=key();try{const v=storage&&storage.getItem?await new Promise(resolve=>storage.getItem(k,(e,x)=>resolve(e?null:x))):localStorage.getItem(k),parsed=JSON.parse(v||"[]");drafts=Array.isArray(parsed)?parsed:parsed.drafts||[];batchKey=Array.isArray(parsed)?"":parsed.idempotencyKey||""}catch{drafts=[];batchKey=""}};const saveDrafts=async()=>{const v=JSON.stringify({drafts,idempotencyKey:batchKey}),k=key();try{if(storage&&storage.setItem)await new Promise(resolve=>storage.setItem(k,v,()=>resolve()));else localStorage.setItem(k,v)}catch{}};const clearDrafts=async()=>{const k=key();drafts=[];batchKey="";try{if(storage&&storage.removeItem)await new Promise(resolve=>storage.removeItem(k,()=>resolve()));else localStorage.removeItem(k)}catch{}};const label=(d)=>d.target.kind==="plan"?"Whole plan":d.target.day+" · "+d.target.slot;const exception=(day,kind)=>((plan.weeklyExceptions.items||[]).some(x=>x.kind===kind&&x.appliesTo&&x.appliesTo.day===day));const dayDate=(i)=>{const parts=new Intl.DateTimeFormat("en-US",{year:"numeric",month:"2-digit",day:"2-digit",timeZone:plan.timezone}).formatToParts(new Date(plan.weekStart));const year=Number(parts.find(x=>x.type==="year").value),month=Number(parts.find(x=>x.type==="month").value),day=Number(parts.find(x=>x.type==="day").value);return new Date(Date.UTC(year,month-1,day+i))};const dateLabel=(i)=>dayDate(i).toLocaleDateString("en-US",{weekday:"short",day:"numeric",timeZone:"UTC"});
/** Shell. */
function shell(){app.replaceChildren();const card=el("section","card");const head=el("header","head");head.append(el("div","eyebrow","Kipp · School meal plan"));const headMain=el("div","head-main");headMain.append(el("h1","title","Week of "+dayDate(0).toLocaleDateString("en-US",{month:"short",day:"numeric",timeZone:"UTC"})));const action=el("div","head-action");const change=el("button","plan-change","Change plan");change.onclick=()=>openDraft({kind:"plan"});action.append(change);headMain.append(action);head.append(headMain);card.append(head);const days=el("nav","days");plan.schedule.days.forEach((day,i)=>{const holiday=exception(day,"school_closed"),half=exception(day,"half_day")||plan.schedule.halfDays?.includes(day),hasMeals=Object.keys(plan.candidate.grid[day]||{}).length>0;const b=el("button","day");b.disabled=holiday||!hasMeals;b.setAttribute("aria-current",String(day===selectedDay));b.setAttribute("aria-label",holiday?"Holiday — no meals planned":half?dateLabel(i)+" — half day":dateLabel(i));b.append(el("strong","",day));b.append(el("small","",dateLabel(i).split(" ").slice(-1)[0]));if(holiday)b.append(el("span","badge","🏖 Holiday"));else if(half)b.append(el("span","badge half-day-badge","◐"));b.onclick=()=>{selectedDay=day;shell()};days.append(b)});card.append(days);const content=el("div","content");const cells=plan.candidate.grid[selectedDay]||{};plan.schedule.slots.forEach(slot=>{const cell=cells[slot.id];if(!cell)return;const row=el("article","meal");row.append(el("div","slot",slot.name));const info=el("div");info.append(el("div","dish",cell.dish));const tags=[];if(cell.cookMinutes)tags.push(cell.cookMinutes+" min");if(cell.priorNightPrep)tags.push("prior-night prep");if(plan.candidate.easyBuys.includes(cell.dish))tags.push("easy buy");info.append(el("div","meta",tags.join(" · ")||"ready to pack"));row.append(info);const c=el("button","","Change");c.onclick=()=>openDraft({kind:"cell",day:selectedDay,slot:slot.id});row.append(c);content.append(row)});const easyBuys=el("section","easy-buys");easyBuys.append(el("h2","","Easy buys this week"));if(plan.candidate.easyBuys.length){const list=el("ul");plan.candidate.easyBuys.forEach(item=>list.append(el("li","",item)));easyBuys.append(list)}else easyBuys.append(el("p","","No easy buys needed this week."));content.append(easyBuys);const draftBox=el("section","drafts");if(drafts.length){draftBox.append(el("h2","","Feedback ready"));drafts.forEach((d,i)=>{const row=el("div","draft");row.append(el("span","",label(d)+": "+d.text));const x=el("button","","Remove");x.onclick=async()=>{drafts.splice(i,1);if(drafts.length)await saveDrafts();else await clearDrafts();shell()};row.append(x);draftBox.append(row)});const submit=el("button","","Send feedback to Kipp");submit.onclick=submitDrafts;draftBox.append(submit)}content.append(draftBox);card.append(content);app.append(card)}
/** Open draft. */
function openDraft(target){const wrap=el("div","sheet"),box=el("div");box.append(el("h2","","Feedback for "+(target.kind==="plan"?"the whole plan":target.day+" · "+target.slot)));box.append(el("p","muted","This stays on this device until you send it."));const input=el("textarea");input.maxLength=1000;input.placeholder="What would you like changed?";box.append(input);const actions=el("div","actions"),cancel=el("button","","Cancel"),save=el("button","","Add feedback");cancel.onclick=()=>wrap.remove();save.onclick=async()=>{const text=input.value.trim();if(!text)return;if(!batchKey)batchKey=crypto.randomUUID();drafts.push({target,text});await saveDrafts();wrap.remove();shell()};actions.append(cancel,save);box.append(actions);wrap.append(box);document.body.append(wrap);input.focus()}
/** Submit drafts. */
async function submitDrafts(){if(!batchKey){batchKey=crypto.randomUUID();await saveDrafts()}const b=el("div","status","Sending feedback…");app.replaceChildren(b);try{const res=await request("/mini-app/api/feedback",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({planId:plan.planId,baseVersion:plan.version,idempotencyKey:batchKey,items:drafts})});if(res.r.status===202){await clearDrafts();app.replaceChildren(el("div","status","Feedback sent — continue in Telegram. Kipp will message you when the new version is ready."));setTimeout(()=>tg&&tg.close&&tg.close(),1200);return}if(res.r.status===409){if(res.body.error==="generating"){app.replaceChildren(el("div","empty","Your next meal plan is still being generated. This draft is saved on this device for reference, but review and re-enter it on the new plan after Kipp sends it."));return}await clearDrafts();app.replaceChildren(el("div","empty","This plan has been replaced. Return to Telegram and open the newest review link."));return}}catch{}app.replaceChildren(el("div","empty","We could not send feedback. Your local drafts are still saved; please try again."))}
/** Load a selected plan using the existing Mini App session. */
async function loadPlan(){try{const result=await request("/mini-app/api/plan");if(!result.r.ok)throw new Error("plan");if(result.body.status==="empty"){app.replaceChildren(el("div","empty","No plan exists for this week. Return to Telegram and send /mealplan to create one."));return}if(result.body.status==="generating"&&!result.body.currentPlan){app.replaceChildren(el("div","empty","Your first meal plan is being generated. Return to Telegram and refresh when it is ready."));return}plan=result.body.status==="generating"?result.body.currentPlan:result.body.plan;if(!plan)throw new Error("plan");selectedDay=plan.schedule.days.find(d=>Object.keys(plan.candidate.grid[d]||{}).length>0)||plan.schedule.days[0];drafts=[];batchKey="";if(result.body.status==="current")await readDrafts();shell()}catch{app.replaceChildren(el("div","empty","We could not load this meal plan. Please try again from Telegram."))}}
/** Authenticate a Telegram launch once. */
async function load(){try{if(!tg||!tg.initData)throw new Error("telegram");tg.ready();tg.expand();const session=await request("/mini-app/api/session",{method:"POST",headers:{"Content-Type":"text/plain"},body:tg.initData});if(!session.r.ok)throw new Error("session");token=session.body.token;await loadPlan()}catch{app.replaceChildren(el("div","empty","Open this review from the Kipp Telegram message to authenticate your plan."))}}window.addEventListener("kipp:plan-load",()=>{if(token)void loadPlan()});window.addEventListener("popstate",()=>{if(token)void loadPlan()});load()})();
</script></body></html>`
  .replace('dateLabel(i).split(" ").slice(-1)[0]', "dayDate(i).getUTCDate()")
  .replace(
    "plan.candidate.easyBuys.includes(cell.dish)",
    "cell.items.some(item=>plan.candidate.easyBuys.includes(item))",
  )
  .replace("<script>\n(()=>", `${MINI_APP_STATE_SCRIPT}<script>\n(()=>`)
