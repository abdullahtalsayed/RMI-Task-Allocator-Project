// ── MODALS + TAG INPUTS ───────────────────────────────────────────────────────
// Confirm / Complete / Extension / Reassign dialogs + the tag-chip input widget.
import { jobs, me, users, tagStores } from './state.js';
import { toMillis, tdiff, getJobDurationBreakdown } from './helpers.js';
import { updateJob, addEvent, extAdd, showToastMsg, assignableUsers, canManageJob, notifyReassign } from './main.js';

// modal-only state
let confirmCallback=null, completeJobId=null;

// ── TAGS ──────────────────────────────────────────────────────────────────────
window.handleTagInput=function(e,store,inputId,wrapId){
  if(e.key==='Enter'||e.key===','){
    e.preventDefault();
    const val=document.getElementById(inputId).value.trim().replace(/,$/,'');
    if(val&&!tagStores[store].includes(val)){
      tagStores[store].push(val);
      renderTags(store,inputId,wrapId);
    }
    document.getElementById(inputId).value='';
  }
};
export function renderTags(store,inputId,wrapId){
  const wrap=document.getElementById(wrapId);
  const inp=document.getElementById(inputId);
  wrap.innerHTML='';
  tagStores[store].forEach((t,i)=>{
    const chip=document.createElement('span');
    chip.className='tag-chip';
    chip.innerHTML=`${t}<button onclick="removeTag('${store}','${inputId}','${wrapId}',${i})">×</button>`;
    wrap.appendChild(chip);
  });
  wrap.appendChild(inp);
}
window.removeTag=function(store,inputId,wrapId,i){tagStores[store].splice(i,1);renderTags(store,inputId,wrapId);};
export function setTags(store,inputId,wrapId,arr){tagStores[store]=arr?[...arr]:[];renderTags(store,inputId,wrapId);}

// ── CONFIRM MODAL ─────────────────────────────────────────────────────────────
export function showConfirm(title,msg,cb,btnLabel='Confirm',danger=true){
  document.getElementById('confirm-title').textContent=title;
  document.getElementById('confirm-msg').textContent=msg;
  const ok=document.getElementById('confirm-ok');
  ok.textContent=btnLabel;
  ok.className='btn-confirm'+(danger?'':' green');
  confirmCallback=cb;
  document.getElementById('confirm-modal').classList.add('open');
}
window.closeConfirm=function(){document.getElementById('confirm-modal').classList.remove('open');confirmCallback=null;};
document.getElementById('confirm-ok').onclick=function(){if(confirmCallback)confirmCallback();closeConfirm();};

// ── COMPLETE MODAL ────────────────────────────────────────────────────────────
window.openCompleteModal=function(id){completeJobId=id;document.getElementById('complete-note').value='';document.getElementById('complete-modal').classList.add('open');};
window.closeCompleteModal=function(){document.getElementById('complete-modal').classList.remove('open');completeJobId=null;};
window.submitComplete=async function(){
  if(!completeJobId)return;
  const note=document.getElementById('complete-note').value.trim();
  const j=jobs.find(x=>x.id===completeJobId);
  if(!j)return;
  let totalPausedMs=j.totalPausedMs||0;
  if(j.status==='paused'&&j.pausedAt)totalPausedMs+=Date.now()-toMillis(j.pausedAt);
  const completed=Date.now();
  const {totalMs,pausedMs,activeMs}=getJobDurationBreakdown({...j,status:'completed',completed,totalPausedMs,pausedAt:null});
  await updateJob(completeJobId,{
    status:'completed',completed,completionNote:note||null,
    totalPausedMs,pausedAt:null,
    durationTotalMs:totalMs,durationPausedMs:pausedMs,durationActiveMs:activeMs
  });
  const durMsg=pausedMs>0?` — job took ${tdiff(0,totalMs)} (${tdiff(0,pausedMs)} paused, ${tdiff(0,activeMs)} active work)`:` — ${tdiff(0,totalMs)} total`;
  await addEvent(completeJobId,'completed',`${me.name} marked job complete${durMsg}${note?' — '+note:''}`,'green');
  closeCompleteModal();
};

// ── EXTENSION MODAL ───────────────────────────────────────────────────────────
window.openExtModal=function(id){document.getElementById('ext-job-id').value=id;document.getElementById('ext-new-dl').value='';document.getElementById('ext-reason').value='';document.getElementById('ext-modal').classList.add('open');};
window.closeExtModal=function(){document.getElementById('ext-modal').classList.remove('open');};
window.submitExtRequest=async function(){
  const id=document.getElementById('ext-job-id').value;
  const dl=document.getElementById('ext-new-dl').value;
  const reason=document.getElementById('ext-reason').value.trim();
  if(!dl||!reason){alert('Please fill in both fields.');return;}
  const j=jobs.find(x=>x.id===id);if(!j)return;
  const req={jobId:id,jobNum:j.jobNum,client:j.client,requestedBy:me.id,requestedByName:me.name,oldDeadline:j.deadline||null,newDeadline:new Date(dl).getTime(),reason,status:'pending',created:Date.now()};
  await extAdd(req);
  await addEvent(id,'extension_request',`${me.name} requested deadline extension: ${reason}`,'orange');
  showToastMsg('Extension request sent to manager.');
  closeExtModal();
};

// ── REASSIGN MODAL ────────────────────────────────────────────────────────────
window.openReassignModal=function(id){
  document.getElementById('reassign-job-id').value=id;
  document.getElementById('reassign-reason').value='';
  const sel=document.getElementById('reassign-to');
  sel.innerHTML='<option value="">-- Select employee --</option>';
  assignableUsers().filter(u=>u.id!==me.id).forEach(u=>{const o=document.createElement('option');o.value=u.id;o.textContent=u.name+(u.role==='supervisor'?' (Supervisor)':u.role==='team_leader'?' (Team Leader)':'');sel.appendChild(o);});
  document.getElementById('reassign-modal').classList.add('open');
};
window.closeReassignModal=function(){document.getElementById('reassign-modal').classList.remove('open');};
window.submitReassign=async function(){
  const id=document.getElementById('reassign-job-id').value;
  const toId=document.getElementById('reassign-to').value;
  const reason=document.getElementById('reassign-reason').value.trim();
  if(!toId){alert('Select an employee.');return;}
  const j=jobs.find(x=>x.id===id);if(!j)return;
  if(!canManageJob(j)){showToastMsg('Not authorized.');return;}
  const fromName=users.find(u=>u.id===j.owner)?.name||j.owner;
  const toName=users.find(u=>u.id===toId)?.name||toId;
  await updateJob(id,{owner:toId,reassignedBy:me.name,reassignedAt:Date.now()});
  await addEvent(id,'reassigned',`${me.name} reassigned from ${fromName} to ${toName}${reason?' — '+reason:''}`, 'purple');
  notifyReassign(j,j.owner,toId,me.name);
  showToastMsg(`Job reassigned to ${toName}.`);
  closeReassignModal();
};
