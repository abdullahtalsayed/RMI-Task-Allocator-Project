// ── JOBS: CRUD, ACTIONS, COMMENTS, EXTENSION REVIEW ───────────────────────────
// Firestore/local write wrappers + job lifecycle actions + comments + extension
// approve/reject. Also hosts user-CRUD wrappers and calendar-day helpers that
// historically lived in this section.
import { USE_FIREBASE, addDoc, deleteDoc, updateDoc, setDoc, doc, writeBatch } from './firebase.js';
import { jobs, me, users, extRequests, lastDel, tagStores, setJobs, setUsers, setLastDel } from './state.js';
import { uid, toMillis, tdiff, fmt, escapeHtml, getJobDurationBreakdown, jobPauseDefaults } from './helpers.js';
import { setTags, showConfirm } from './modals.js';
import { db, jCol, uCol, extCol, calFilterEmp, calShowMode,
  renderBoard, isLead, isOverdue, visibleJobs, teamUsersForView, populateADrop,
  renderAssignEmpGrid, getJobEvents, pushNotif, renderDashExtensions, localSave,
  addEvent, showToastMsg, canManageJob, assignableUsers } from './main.js';
import { renderUList } from './admin.js';

// ── COMMENTS ──────────────────────────────────────────────────────────────────
export async function addComment(jobId,text){
  await addEvent(jobId,'comment','💬 '+me.name+': '+text,'blue');
}
window.submitComment=async function(jobId){
  const inp=document.getElementById('ci-'+jobId);
  if(!inp||!inp.value.trim())return;
  await addComment(jobId,inp.value.trim());
  inp.value='';
  // Re-render the card's comment section
  const section=document.getElementById('cs-'+jobId);
  if(section)section.innerHTML=renderCommentSection(jobId);
};
export function renderCommentSection(jobId){
  const comms=getJobEvents(jobId).filter(e=>e.type==='comment');
  return`<div class="comment-section"><h5>Comments & Activity</h5>${comms.map(c=>`<div class="comment"><div class="cmeta">${fmt(c.ts)}</div>${c.desc.replace('💬 ','')}</div>`).join('')}<div class="comment-input"><input id="ci-${jobId}" placeholder="Add a comment..." onkeydown="if(event.key==='Enter')submitComment('${jobId}')"/><button onclick="submitComment('${jobId}')">Send</button></div></div>`;
}

// ── CRUD WRAPPERS ─────────────────────────────────────────────────────────────
export async function jAdd(data){
  if(USE_FIREBASE){const r=await addDoc(jCol,data);return r.id;}
  else{data.id=uid();jobs.unshift(data);localSave();renderAll();if(me&&isLead())renderBoard();return data.id;}
}
export async function jUpdate(id,data){
  if(USE_FIREBASE){await updateDoc(doc(db,'jobs',id),data);}
  else{const j=jobs.find(x=>x.id===id);if(j){Object.assign(j,data);localSave();renderAll();if(me&&isLead())renderBoard();}}
}
export async function jDelete(id){
  if(USE_FIREBASE){await deleteDoc(doc(db,'jobs',id));}
  else{setJobs(jobs.filter(x=>x.id!==id));localSave();renderAll();}
}
export async function jRestore(j){
  if(USE_FIREBASE){const{id,...data}=j;await setDoc(doc(db,'jobs',id),data);}
  else{jobs.unshift(j);localSave();renderAll();}
}
export async function uAdd(id,data){
  if(USE_FIREBASE){await setDoc(doc(uCol,id),data);}
  else{users.push(data);localSave();populateADrop();renderUList();populateCalEmpDrop();}
}
export async function uUpdate(id,data){
  if(USE_FIREBASE){await updateDoc(doc(uCol,id),data);}
  else{const u=users.find(x=>x.id===id);if(u){Object.assign(u,data);localSave();populateADrop();renderUList();populateCalEmpDrop();}}
}
export async function uDelete(id){
  if(USE_FIREBASE){await deleteDoc(doc(uCol,id));}
  else{setUsers(users.filter(u=>u.id!==id));localSave();populateADrop();renderUList();populateCalEmpDrop();}
}
export function empOverdueJobs(uid){return visibleJobs().filter(j=>j.owner===uid&&isOverdue(j));}
export function dateKey(ts){const ms=toMillis(ts);if(!ms)return'';const d=new Date(ms);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
export function jobDateEntries(j){
  const evs=[];
  if(j.started)evs.push({kind:'started',ts:j.started});
  if(j.completed)evs.push({kind:'completed',ts:j.completed});
  if(j.deadline)evs.push({kind:'deadline',ts:j.deadline,overdue:j.status!=='completed'&&isOverdue(j)});
  return evs;
}
export function jobsForCalendarDay(ds){
  const out=[];
  visibleJobs().forEach(j=>{
    if(calFilterEmp&&j.owner!==calFilterEmp)return;
    jobDateEntries(j).forEach(ev=>{
      if(dateKey(ev.ts)!==ds)return;
      if(calShowMode==='deadline'&&ev.kind!=='deadline')return;
      if(calShowMode==='activity'&&ev.kind==='deadline')return;
      out.push({job:j,kind:ev.kind,overdue:!!ev.overdue});
    });
  });
  return out;
}
export function populateCalEmpDrop(){
  // legacy alias — now uses pills
  populateCalEmpPills();
}
export function populateCalEmpPills(){
  const wrap=document.getElementById('cal-emp-pills');if(!wrap)return;
  const pool=teamUsersForView().filter(u=>u.role!=='manager');
  wrap.innerHTML=`<button class="cal-emp-pill${!calFilterEmp?' cep-on':''}" onclick="setCalFilter('')">All</button>`
    +pool.map(u=>`<button class="cal-emp-pill${calFilterEmp===u.id?' cep-on':''}" onclick="setCalFilter('${u.id}')">${escapeHtml(u.name.split(' ')[0])}</button>`).join('');
}
export async function extAdd(data){
  if(USE_FIREBASE){const r=await addDoc(extCol,data);return r.id;}
  else{data.id=uid();extRequests.unshift(data);localSave();return data.id;}
}
export async function extUpdate(id,data){
  if(USE_FIREBASE){await updateDoc(doc(extCol,id),data);}
  else{const e=extRequests.find(x=>x.id===id);if(e){Object.assign(e,data);localSave();}}
}

// ── JOB ACTIONS ───────────────────────────────────────────────────────────────
window.addJob=async function(){
  const c=document.getElementById('jc').value.trim(),n=document.getElementById('jn').value.trim();
  if(!c||!n){alert('Client and Job # required.');return;}
  const dlv=document.getElementById('jdl').value;
  const id=await jAdd({client:c,jobNum:n,type:document.getElementById('jtype').value,priority:document.getElementById('jp').value,notes:document.getElementById('jnotes').value,tags:tagStores.jtags,owner:me.id,assignedBy:me.name,status:'pending',created:Date.now(),started:null,completed:null,deadline:dlv?new Date(dlv).getTime():null,managerAssigned:false,pinned:false,...jobPauseDefaults()});
  await addEvent(id,'created',`Job created by ${me.name} — ${c} (#${n})`,'green');
  document.getElementById('jc').value='';document.getElementById('jn').value='';document.getElementById('jnotes').value='';document.getElementById('jdl').value='';
  setTags('jtags','jtag-input','jtags-wrap',[]);
  showToastMsg('✅ Job added!');goTab('my-jobs');
};

window.assignJob=async function(){
  const oid=document.getElementById('mat').value,c=document.getElementById('mc').value.trim(),n=document.getElementById('mn').value.trim();
  if(!oid||!c||!n){alert('Fill all required fields.');return;}
  if(!assignableUsers().some(u=>u.id===oid)){showToastMsg('You cannot assign to that user.');return;}
  const dlv=document.getElementById('mdl').value;
  const id=await jAdd({client:c,jobNum:n,type:document.getElementById('mtype').value,priority:document.getElementById('mpri').value,notes:document.getElementById('mnotes').value,managerNote:document.getElementById('mpnote').value,tags:tagStores.mtags,owner:oid,assignedBy:'👔 '+me.name,status:'pending',created:Date.now(),started:null,completed:null,deadline:dlv?new Date(dlv).getTime():null,managerAssigned:true,pinned:false,...jobPauseDefaults()});
  const toName=users.find(u=>u.id===oid)?.name||oid;
  await addEvent(id,'created',`Job assigned to ${toName} by ${me.name} — ${c} (#${n})`,'purple');
  document.getElementById('mc').value='';document.getElementById('mn').value='';document.getElementById('mnotes').value='';document.getElementById('mpnote').value='';document.getElementById('mdl').value='';
  setTags('mtags','mtag-input','mtags-wrap',[]);
  showToastMsg(`✅ Assigned to ${toName}!`);
  renderAssignEmpGrid();
  const prev=document.getElementById('assign-emp-preview');if(prev)prev.style.display='none';
};

window.startJob=async function(id){
  const j=jobs.find(x=>x.id===id);if(!j)return;
  if(!canManageJob(j)){showToastMsg('Not authorized.');return;}
  await updateJob(id,{status:'ongoing',started:Date.now(),pausedAt:null});
  await addEvent(id,'started',`${me.name} started the job`,'blue');
};
window.pauseJob=async function(id){
  const j=jobs.find(x=>x.id===id);
  if(!j||j.status!=='ongoing'){showToastMsg('Only ongoing jobs can be paused.');return;}
  if(!canManageJob(j)){showToastMsg('Not authorized.');return;}
  await updateJob(id,{status:'paused',pausedAt:Date.now()});
  await addEvent(id,'paused',`${me.name} paused the job`,'yellow');
  showToastMsg('⏸ Job paused');
};
window.resumeJob=async function(id){
  const j=jobs.find(x=>x.id===id);
  if(!j||j.status!=='paused')return;
  if(!canManageJob(j)){showToastMsg('Not authorized.');return;}
  const pauseMs=j.pausedAt?Date.now()-toMillis(j.pausedAt):0;
  const totalPausedMs=(j.totalPausedMs||0)+pauseMs;
  await updateJob(id,{status:'ongoing',pausedAt:null,totalPausedMs});
  await addEvent(id,'resumed',`${me.name} resumed the job (paused for ${tdiff(0,pauseMs)})`,'blue');
  showToastMsg('▶ Job resumed');
};
window.doneJob=function(id){openCompleteModal(id);};

export async function updateJob(id,data){
  // Build audit entry
  const j=jobs.find(x=>x.id===id);
  if(j&&data.status&&data.status!==j.status){
    // status change logged in calling functions
  }
  await jUpdate(id,data);
}

window.delJob=async function(id){
  const j=jobs.find(x=>x.id===id);
  if(!j||!canManageJob(j)){showToastMsg('Not authorized.');return;}
  if(j.managerAssigned&&me.role!=='manager'){showToastMsg('Cannot delete manager-assigned tasks.');return;}
  showConfirm('Delete Job','This job will be deleted. You can undo within 15 seconds.',async()=>{
    setLastDel(j);
    await addEvent(id,'deleted',`Job deleted by ${me.name}`,'red');
    await jDelete(id);
    const t=document.getElementById('toast');t.style.display='block';setTimeout(()=>t.style.display='none',15000);
  },'Delete',true);
};
window.undoDel=async function(){
  if(!lastDel)return;
  if(!canManageJob(lastDel)){showToastMsg('Not authorized.');return;}
  await jRestore(lastDel);
  await addEvent(lastDel.id,'restored',`Job restored by ${me.name}`,'green');
  setLastDel(null);document.getElementById('toast').style.display='none';
};

window.editJob=function(id){
  const j=jobs.find(x=>x.id===id);if(!j)return;
  if(!canManageJob(j)){showToastMsg('Not authorized.');return;}
  document.getElementById('eid').value=j.id;
  document.getElementById('ec').value=j.client;
  document.getElementById('en').value=j.jobNum;
  document.getElementById('etype').value=j.type;
  document.getElementById('epri').value=j.priority;
  document.getElementById('est').value=j.status;
  document.getElementById('enotes').value=j.notes||'';
  document.getElementById('edl').value=j.deadline?new Date(j.deadline).toISOString().slice(0,16):'';
  setTags('etags','etag-input','etags-wrap',j.tags||[]);
  document.getElementById('editarea').style.display='block';
  goTab('add-job');
  setTimeout(()=>document.getElementById('editarea').scrollIntoView({behavior:'smooth'}),100);
};
window.saveEdit=async function(){
  const id=document.getElementById('eid').value;
  const dlv=document.getElementById('edl').value;
  const j=jobs.find(x=>x.id===id);
  const oldPri=j?.priority,newPri=document.getElementById('epri').value;
  const oldSt=j?.status,newSt=document.getElementById('est').value;
  const patch={client:document.getElementById('ec').value,jobNum:document.getElementById('en').value,type:document.getElementById('etype').value,priority:newPri,status:newSt,notes:document.getElementById('enotes').value,tags:tagStores.etags,deadline:dlv?new Date(dlv).getTime():null};
  if(newSt==='paused'&&oldSt==='ongoing')patch.pausedAt=Date.now();
  if(newSt==='ongoing'&&oldSt==='paused'&&j?.pausedAt){
    patch.totalPausedMs=(j.totalPausedMs||0)+(Date.now()-toMillis(j.pausedAt));
    patch.pausedAt=null;
  }
  if(newSt!=='paused'&&newSt!=='ongoing')patch.pausedAt=null;
  if(oldSt==='completed'&&newSt!=='completed')patch.completionNote=null;
  if(newSt==='completed'&&j){
    let totalPausedMs=j.totalPausedMs||0;
    if(j.status==='paused'&&j.pausedAt)totalPausedMs+=Date.now()-toMillis(j.pausedAt);
    const completed=Date.now();
    const br=getJobDurationBreakdown({...j,...patch,status:'completed',completed,totalPausedMs,pausedAt:null});
    Object.assign(patch,{completed,pausedAt:null,totalPausedMs,durationTotalMs:br.totalMs,durationPausedMs:br.pausedMs,durationActiveMs:br.activeMs});
  }
  await updateJob(id,patch);
  let changes=[];
  if(oldPri!==newPri)changes.push(`priority changed from ${oldPri} to ${newPri}`);
  if(oldSt!==newSt)changes.push(`status changed from ${oldSt} to ${newSt}`);
  const desc=changes.length?`${me.name} edited job — ${changes.join(', ')}`:`${me.name} edited job details`;
  await addEvent(id,'edited',desc,'yellow');
  if(oldSt!==newSt&&newSt==='paused')await addEvent(id,'paused',`${me.name} paused the job (via edit)`,'yellow');
  if(oldSt!==newSt&&newSt==='ongoing'&&oldSt==='paused')await addEvent(id,'resumed',`${me.name} resumed the job (via edit)`,'blue');
  document.getElementById('editarea').style.display='none';goTab('my-jobs');
};

window.pinJob=async function(id){
  const j=jobs.find(x=>x.id===id);if(!j)return;
  const pinned=!j.pinned;
  await jUpdate(id,{pinned});
  await addEvent(id,'pinned',`${me.name} ${pinned?'pinned':'unpinned'} the job`,'orange');
};

window.expTXT=function(id){
  const j=jobs.find(x=>x.id===id);if(!j)return;
  const own=users.find(u=>u.id===j.owner)?.name||j.owner;
  const evs=getJobEvents(id).map(e=>`  [${fmt(e.ts)}] ${e.desc}`).join('\n');
  const dur=j.started||j.completed?getJobDurationBreakdown(j):null;
  const durLines=dur?[
    `Duration (started → ${j.completed?'completed':'now'}): ${tdiff(0,dur.totalMs)}`,
    dur.pausedMs>0?`  Paused time: ${tdiff(0,dur.pausedMs)}`:'',
    dur.pausedMs>0?`  Active work time: ${tdiff(0,dur.activeMs)}`:''
  ].filter(Boolean):[];
  const lines=[`RMI Task Allocator & Progress Tracker — Task Export`,`═══════════════════════`,`Client: ${j.client}`,`Job #: ${j.jobNum}`,`Type: ${j.type}`,`Employee: ${own}`,`Assigned By: ${j.assignedBy}`,`Priority: ${j.priority}`,`Status: ${j.status}`,`Tags: ${(j.tags||[]).join(', ')||'None'}`,`Created: ${fmt(j.created)}`,`Started: ${j.started?fmt(j.started):'N/A'}`,`Completed: ${j.completed?fmt(j.completed):'N/A'}`,...durLines,j.deadline?`Deadline: ${fmt(j.deadline)}`:'',j.notes?`Notes: ${j.notes}`:'',j.completionNote?`Completion Note: ${j.completionNote}`:'',``,`Activity Timeline:`,evs||'  No activity logged'].filter(x=>x!==undefined&&x!==null);
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([lines.join('\n')],{type:'text/plain'}));a.download=`Job-${j.jobNum}.txt`;a.click();
};

// ── EXTENSION REVIEW ──────────────────────────────────────────────────────────
window.approveExt=async function(eid){
  const req=extRequests.find(x=>x.id===eid);if(!req)return;
  if(!me||!canManageJob(jobs.find(x=>x.id===req.jobId)||{owner:req.requestedBy}))return;
  if(USE_FIREBASE&&db&&extCol){
    const batch=writeBatch(db);
    batch.update(doc(extCol,eid),{status:'approved',reviewedBy:me.name,reviewedAt:Date.now()});
    batch.update(doc(db,'jobs',req.jobId),{deadline:req.newDeadline});
    await batch.commit();
    const e=extRequests.find(x=>x.id===eid);if(e){e.status='approved';e.reviewedBy=me.name;e.reviewedAt=Date.now();}
    const j=jobs.find(x=>x.id===req.jobId);if(j)j.deadline=req.newDeadline;
  }else{
    await extUpdate(eid,{status:'approved',reviewedBy:me.name,reviewedAt:Date.now()});
    await jUpdate(req.jobId,{deadline:req.newDeadline});
  }
  await addEvent(req.jobId,'ext_approved',`${me.name} approved deadline extension requested by ${req.requestedByName}`,'green');
  pushNotif(req.requestedBy,'✅ Extension Approved',`Your deadline extension for ${req.client} (#${req.jobNum}) was approved.`);
  renderDashExtensions();
};
window.rejectExt=async function(eid){
  const req=extRequests.find(x=>x.id===eid);if(!req)return;
  showConfirm('Reject Extension Request',`Reject extension for ${req.client} (#${req.jobNum})?`,async()=>{
    await extUpdate(eid,{status:'rejected',reviewedBy:me.name,reviewedAt:Date.now()});
    await addEvent(req.jobId,'ext_rejected',`${me.name} rejected deadline extension requested by ${req.requestedByName}`,'red');
    pushNotif(req.requestedBy,'❌ Extension Rejected',`Your deadline extension for ${req.client} (#${req.jobNum}) was rejected.`);
    renderDashExtensions();
  },'Reject',true);
};
