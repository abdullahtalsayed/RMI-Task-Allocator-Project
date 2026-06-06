// ── PURE HELPERS ──────────────────────────────────────────────────────────────
// Stateless utilities — formatting, time math, escaping. No app state, no imports.

export function lsub(t){document.getElementById('lsub').textContent=t;}
export function toMillis(ts){
  if(ts==null||ts===undefined)return 0;
  if(typeof ts==='number'&&!isNaN(ts))return ts;
  if(typeof ts?.toMillis==='function')return ts.toMillis();
  if(typeof ts?.seconds==='number')return ts.seconds*1000+(ts.nanoseconds||0)/1e6;
  const n=new Date(ts).getTime();
  return isNaN(n)?0:n;
}
export function escapeHtml(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
export function fmt(ts){const ms=toMillis(ts);if(!ms)return'—';const d=new Date(ms);return d.toLocaleDateString('en-GB')+' '+d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});}
export function fmtShort(ts){const ms=toMillis(ts);if(!ms)return'—';return new Date(ms).toLocaleDateString('en-GB');}
export function tdiff(s,e){const d=Math.floor((toMillis(e)-toMillis(s))/1000);if(d<60)return d+'s';if(d<3600)return Math.floor(d/60)+'m';if(d<86400)return Math.floor(d/3600)+'h '+Math.floor((d%3600)/60)+'m';return Math.floor(d/86400)+'d '+Math.floor((d%86400)/3600)+'h';}
export function getJobPausedMs(j,endMs){
  let ms=j.totalPausedMs||0;
  if(j.status==='paused'&&j.pausedAt)ms+=toMillis(endMs||Date.now())-toMillis(j.pausedAt);
  return ms;
}
export function getJobDurationBreakdown(j,endMs){
  const end=toMillis(endMs||(j.completed||Date.now()));
  const start=toMillis(j.started||j.created);
  const totalMs=Math.max(0,end-start);
  const pausedMs=getJobPausedMs(j,end);
  const activeMs=Math.max(0,totalMs-pausedMs);
  return{totalMs,pausedMs,activeMs};
}
export function formatJobDurationHtml(j){
  if(!j.started&&!j.completed)return'';
  const {totalMs,pausedMs,activeMs}=getJobDurationBreakdown(j);
  if(j.status==='completed'){
    if(pausedMs>0)return`<br>Completed: ${fmt(j.completed)} — ⏱ Job took ${tdiff(0,totalMs)} (${tdiff(0,pausedMs)} paused, ${tdiff(0,activeMs)} active work)`;
    return`<br>Completed: ${fmt(j.completed)} — ⏱ ${tdiff(0,totalMs)}`;
  }
  if(j.status==='paused'){
    const curPause=j.pausedAt?toMillis(Date.now())-toMillis(j.pausedAt):0;
    return`<br><span style="color:var(--yellow);font-weight:500;">⏸ Paused${j.pausedAt?' since '+fmt(j.pausedAt):''} — this pause: ${tdiff(0,curPause)}, total paused: ${tdiff(0,pausedMs)}</span>`;
  }
  if((j.totalPausedMs||0)>0&&(j.status==='ongoing'||j.started)){
    return`<br><span style="color:var(--text2);">⏱ Active work so far: ${tdiff(0,activeMs)} (${tdiff(0,pausedMs)} total paused time)</span>`;
  }
  return'';
}
export function jobPauseDefaults(){return{totalPausedMs:0,pausedAt:null};}
export function uid(){return crypto.randomUUID();}
export function timeAgo(ts){const d=Date.now()-toMillis(ts);if(d<60000)return'just now';if(d<3600000)return Math.floor(d/60000)+'m ago';if(d<86400000)return Math.floor(d/3600000)+'h ago';return Math.floor(d/86400000)+'d ago';}
