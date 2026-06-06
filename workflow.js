// ── JOB BASKET / SHOP-DRAWING WORKFLOW ────────────────────────────────────────
// Sales Operation creates a job stub → auto-assigned (weighted by team health) to
// a Team Leader → staged shop-drawing pipeline with gated checklists at every
// handoff. Fully separate from the manual job flow (jobs carry workflow:true).
//
// Ownership model: job.owner = the CURRENT ball-holder (flips each handoff) so the
// existing `where owner==me` Firestore listener always delivers the job to whoever
// must act next. job.teamLeaderId = workflow TL. job.drafterId = assigned employee.
import { jobs, users, me, JOB_TYPES } from './state.js';
import { escapeHtml, fmt, tdiff, toMillis } from './helpers.js';
import { jAdd, updateJob } from './jobs.js';
import { addEvent, showToastMsg, pushNotif, isOverdue, isTeamLeader, amDirector } from './main.js';

const esc=escapeHtml;

// ── STAGE MACHINE ─────────────────────────────────────────────────────────────
// actor: who must act next ('tl' = teamLeaderId, 'drafter' = owner/drafterId)
export const WF_STAGES={
  intake:           {actor:'tl',      label:'TL Intake',                  short:'Intake',          color:'blue'},
  drafting:         {actor:'drafter', label:'Roof Layout, Cross Section, Gutter/Curve Sample', short:'Layout & Sample', color:'yellow'},
  tl_sample_review: {actor:'tl',      label:'Initial Roof Layout, Cross Section, Gutter/Curve Sample Review', short:'Sample Review', color:'purple'},
  detailing:        {actor:'drafter', label:'Shop Drawing Detailing',     short:'Detailing',       color:'yellow'},
  tl_sd_review:     {actor:'tl',      label:'Shop Drawing Review',        short:'SD Review',       color:'purple'},
  client_wait:      {actor:'tl',      label:'Awaiting Client Approval',   short:'Client Wait',     color:'orange'},
  jobcard:          {actor:'drafter', label:'Job Card Preparation',       short:'Job Card',        color:'yellow'},
  tl_jobcard_review:{actor:'tl',      label:'Job Card Review',            short:'Card Review',     color:'purple'},
  completed:        {actor:'none',    label:'Completed',                  short:'Done',            color:'green'},
  release:          {actor:'drafter', label:'Release Preparation',        short:'Release',         color:'yellow'},
};
export function wfStageMeta(s){return WF_STAGES[s]||{actor:'none',label:s,short:s,color:'blue'};}

// ── HEALTH / WEIGHTED PICK ────────────────────────────────────────────────────
function teamMemberIdsOf(tlId){return new Set([tlId,...users.filter(u=>u.teamLeaderId===tlId).map(u=>u.id)]);}
export function wfHealthScore(tlId){
  const ids=teamMemberIdsOf(tlId);
  let active=0,overdue=0;
  jobs.forEach(j=>{if(ids.has(j.owner)&&j.status!=='completed'){active++;if(isOverdue(j))overdue++;}});
  return active+overdue*2; // overdue counts double — penalize struggling teams
}
// weighted random: freer team (lower score) gets more tickets → more likely, not guaranteed
export function pickTeamLeaderWeighted(){
  const tls=users.filter(u=>u.role==='team_leader');
  if(!tls.length)return null;
  const scored=tls.map(tl=>({tl,score:wfHealthScore(tl.id)}));
  const maxScore=Math.max(...scored.map(s=>s.score));
  const tickets=scored.map(s=>({tl:s.tl,t:(maxScore-s.score)+1})); // +1 floor so everyone has a chance
  const total=tickets.reduce((a,x)=>a+x.t,0);
  let r=Math.random()*total;
  for(const x of tickets){if(r<x.t)return x.tl;r-=x.t;}
  return tickets[0].tl;
}
function memberLoad(uId){return jobs.filter(j=>j.owner===uId&&j.status!=='completed').length;}
function teamMembers(tlId){return users.filter(u=>u.teamLeaderId===tlId&&u.role==='employee');}
function freestMember(tlId,excludeId){
  const ms=teamMembers(tlId).filter(m=>m.id!==excludeId);
  if(!ms.length)return null;
  return ms.map(m=>({m,load:memberLoad(m.id)})).sort((a,b)=>a.load-b.load)[0].m;
}

// ── SALES OPERATION: SUBMIT TO BASKET ─────────────────────────────────────────
window.wfSubmitToBasket=async function(){
  const c=document.getElementById('wf-so-client')?.value.trim();
  const n=document.getElementById('wf-so-jobnum')?.value.trim();
  const p=document.getElementById('wf-so-project')?.value.trim();
  if(!c||!n){alert('Client Name and Job # are required.');return;}
  const tl=pickTeamLeaderWeighted();
  if(!tl){alert('No team leaders available to receive the job.');return;}
  const now=Date.now();
  const id=await jAdd({
    client:c,jobNum:n,projectName:p||'',type:null,priority:'Medium',
    workflow:true,source:'sales',stage:'intake',
    owner:tl.id,teamLeaderId:tl.id,drafterId:null,
    wfCreatedBy:me.id,wfCreatedByName:me.name,
    status:'pending',created:now,started:null,completed:null,deadline:null,
    wfHistory:[{stage:'_new',to:'intake',action:'submitted',by:me.name,byId:me.id,at:now,note:`Sent to ${tl.name}'s team`}],
    pinned:false,totalPausedMs:0,pausedAt:null
  });
  await addEvent(id,'wf_intake',`📥 ${me.name} (Sales Op) sent job to basket → auto-assigned to ${tl.name}'s team`,'blue');
  pushNotif(tl.id,'🧺 New Job in Basket',`${c} (#${n}) was routed to your team. Review & assign.`);
  document.getElementById('wf-so-client').value='';
  document.getElementById('wf-so-jobnum').value='';
  document.getElementById('wf-so-project').value='';
  showToastMsg(`✅ Job sent to ${tl.name}'s team.`);
  renderJobBasket();
};

// ── STAGE ADVANCE (records history + flips owner) ──────────────────────────────
async function wfAdvance(jobId,toStage,opts={}){
  const j=jobs.find(x=>x.id===jobId);if(!j)return;
  const {action='advance',checklist=null,note=null,owner=null,drafterId,extra={},statusComplete=false}=opts;
  const hist=Array.isArray(j.wfHistory)?[...j.wfHistory]:[];
  hist.push({stage:j.stage,to:toStage,action,by:me.name,byId:me.id,at:Date.now(),checklist,note});
  const patch={stage:toStage,wfHistory:hist,...extra};
  if(owner)patch.owner=owner;
  if(drafterId!==undefined)patch.drafterId=drafterId;
  if(statusComplete){
    patch.status='completed';patch.completed=Date.now();
    if(j.started)patch.durationTotalMs=Date.now()-toMillis(j.started);
  }else if(toStage!=='completed'){
    // keep ongoing once work has started
    if(j.status==='completed')patch.status='ongoing';
  }
  await updateJob(jobId,patch);
}

// ── GENERIC SEQUENTIAL YES/NO POPUP ───────────────────────────────────────────
let _wfCtx={};
function wfModalHtml(html){
  const m=document.getElementById('wf-modal');
  document.getElementById('wf-modal-body').innerHTML=html;
  m.classList.add('open');
}
window.wfCloseModal=function(){document.getElementById('wf-modal').classList.remove('open');};
// questions:[{q,key}] — every Yes advances; any No → onNo(question). All Yes → onAllYes(answers).
function wfAsk(title,questions,onAllYes,onNo){
  const st={i:0,answers:{}};
  function render(){
    const q=questions[st.i];
    wfModalHtml(`
      <div class="wf-q-title">${esc(title)}</div>
      <div class="wf-q-step">Question ${st.i+1} of ${questions.length}</div>
      <div class="wf-q-text">${esc(q.q)}</div>
      <div class="wf-q-actions">
        <button class="wf-btn-no" onclick="__wfAns(false)">No</button>
        <button class="wf-btn-yes" onclick="__wfAns(true)">Yes</button>
      </div>`);
  }
  window.__wfAns=function(yes){
    const q=questions[st.i];
    st.answers[q.key]=yes;
    if(!yes){window.wfCloseModal();if(onNo)onNo(q,st.answers);return;}
    st.i++;
    if(st.i>=questions.length){window.wfCloseModal();onAllYes(st.answers);return;}
    render();
  };
  render();
}

// ── STAGE 1→2: TL TAKE & ASSIGN ───────────────────────────────────────────────
window.wfTakeJob=function(jobId){
  const j=jobs.find(x=>x.id===jobId);if(!j)return;
  wfAsk('Pre-Assignment Check',[
    {q:'Did you check the Steel IFC drawings?',key:'steelIFC'},
    {q:'Did you check the Architectural drawings?',key:'architectural'}
  ],(ans)=>{
    _wfCtx={jobId,checklist:ans};
    const tlId=j.teamLeaderId;
    const ms=teamMembers(tlId);
    const freest=freestMember(tlId);
    if(!ms.length){showToastMsg('No employees in your team to assign to.');return;}
    wfModalHtml(`
      <div class="wf-q-title">Assign — ${esc(j.client)} <span class="tc-muted">#${esc(j.jobNum)}</span></div>
      ${j.projectName?`<div class="wf-q-sub">📁 ${esc(j.projectName)}</div>`:''}
      <label class="wf-f">Type of Job<select id="wf-type">${JOB_TYPES.map(t=>`<option ${t==='Shop Drawing'?'selected':''}>${esc(t)}</option>`).join('')}</select></label>
      <label class="wf-f">Deadline<input type="datetime-local" id="wf-dl"></label>
      <label class="wf-f">Assign to (freest first)<select id="wf-member">${ms.map(m=>({m,l:memberLoad(m.id)})).sort((a,b)=>a.l-b.l).map(({m,l})=>`<option value="${m.id}" ${m.id===freest?.id?'selected':''}>${esc(m.name)} · ${l} active</option>`).join('')}</select></label>
      <div class="wf-q-actions"><button class="wf-btn-no" onclick="wfCloseModal()">Cancel</button><button class="wf-btn-yes" onclick="wfConfirmAssign()">Assign Job</button></div>
    `);
  },(q)=>{showToastMsg(`Check the ${q.key==='steelIFC'?'Steel IFC':'Architectural'} drawings before assigning.`);});
};
window.wfConfirmAssign=async function(){
  const j=jobs.find(x=>x.id===_wfCtx.jobId);if(!j)return;
  const type=document.getElementById('wf-type').value;
  const dlv=document.getElementById('wf-dl').value;
  const memberId=document.getElementById('wf-member').value;
  if(!memberId){alert('Pick a team member.');return;}
  const member=users.find(u=>u.id===memberId);
  await wfAdvance(j.id,'drafting',{
    action:'assigned',checklist:_wfCtx.checklist,owner:memberId,drafterId:memberId,
    note:`Assigned to ${member?.name} as ${type}`,
    extra:{type,deadline:dlv?new Date(dlv).getTime():null,status:'pending',started:null,rejectedSample:false}
  });
  await addEvent(j.id,'wf_drafting',`🧭 ${me.name} checked IFC+Architectural, assigned ${type} to ${member?.name} — prepare Roof Layout, Cross Section, Gutter/Curve Sample`,'yellow');
  pushNotif(memberId,'🧺 New Workflow Job',`${j.client} (#${j.jobNum}) — prepare Roof Layout, Cross Section, Gutter/Curve Sample.`);
  window.wfCloseModal();
  showToastMsg(`✅ Assigned to ${member?.name}.`);
  renderJobBasket();
};

// ── STAGE 2: DRAFTER START / SUBMIT SAMPLE ────────────────────────────────────
window.wfStart=async function(jobId){
  const j=jobs.find(x=>x.id===jobId);if(!j)return;
  await updateJob(jobId,{status:'ongoing',started:j.started||Date.now()});
  await addEvent(jobId,'started',`${me.name} started the job`,'blue');
  renderJobBasket();
};
window.wfSubmitSample=function(jobId){
  const j=jobs.find(x=>x.id===jobId);if(!j)return;
  wfAsk('Submit for Sample Review',[
    {q:'Did you prepare the roof layout plan?',key:'roofLayout'},
    {q:'Did you prepare the roof cross section?',key:'crossSection'},
    {q:'Did you check the purlin spacing and orientation?',key:'purlin'},
    {q:'Did you prepare the gutter / curve required to send sample for?',key:'gutter'}
  ],async(ans)=>{
    await wfAdvance(jobId,'tl_sample_review',{action:'sample_submitted',checklist:ans,owner:j.teamLeaderId,note:'Sample submitted for TL review'});
    await addEvent(jobId,'wf_tl_sample_review',`📐 ${me.name} submitted roof layout & sample for review`,'purple');
    pushNotif(j.teamLeaderId,'📐 Sample Ready for Review',`${j.client} (#${j.jobNum}) — review roof & gutter sample.`);
    showToastMsg('✅ Sent to team leader for review.');
    renderJobBasket();
  },(q)=>{showToastMsg('Complete every preparation step before submitting.');});
};

// ── STAGE 3: TL SAMPLE REVIEW (approve / reject) ──────────────────────────────
window.wfReviewSample=function(jobId){
  const j=jobs.find(x=>x.id===jobId);if(!j)return;
  wfAsk('Pre-Detailing Check',[
    {q:'Did you check the panel lengths?',key:'panelLengths'},
    {q:'Did you check the dimensions?',key:'dimensions'},
    {q:'Did you check the cutback?',key:'cutback'},
    {q:'Did you check the quantity (qty)?',key:'qty'}
  ],(ans)=>{
    _wfCtx={jobId,checklist:ans};
    wfShowDecision(j,'Approve sample → drafter continues detailing. Reject → drafter must fix & resubmit.','wfDecideSample');
  },(q)=>{showToastMsg('Complete the checklist before approving or rejecting.');});
};
function wfShowDecision(j,desc,fnName){
  wfModalHtml(`
    <div class="wf-q-title">Review — ${esc(j.client)} <span class="tc-muted">#${esc(j.jobNum)}</span></div>
    <div class="wf-q-text" style="font-size:0.82rem;color:var(--text2);">${esc(desc)}</div>
    <label class="wf-f">Comment <span class="tc-muted">(optional, shown if rejected)</span><textarea id="wf-reject-note" rows="2" placeholder="What needs fixing?"></textarea></label>
    <div class="wf-q-actions">
      <button class="wf-btn-reject" onclick="${fnName}(false)">✗ Reject</button>
      <button class="wf-btn-yes" onclick="${fnName}(true)">✓ Approve</button>
    </div>`);
}
window.wfDecideSample=async function(approve){
  const j=jobs.find(x=>x.id===_wfCtx.jobId);if(!j)return;
  const note=document.getElementById('wf-reject-note')?.value.trim()||null;
  if(approve){
    await wfAdvance(j.id,'detailing',{action:'sample_approved',checklist:_wfCtx.checklist,owner:j.drafterId,note:'Sample approved — continue detailing'});
    await addEvent(j.id,'wf_detailing',`🟢 ${me.name} approved sample — green light to ${users.find(u=>u.id===j.drafterId)?.name||'drafter'}`,'green');
    pushNotif(j.drafterId,'🟢 Sample Approved',`${j.client} (#${j.jobNum}) — green light. Continue shop drawing.`);
    showToastMsg('✅ Approved.');
  }else{
    await wfAdvance(j.id,'drafting',{action:'sample_rejected',checklist:_wfCtx.checklist,owner:j.drafterId,note:note||'Sample rejected — fix & resubmit',extra:{rejectedSample:true,rejectNote:note}});
    await addEvent(j.id,'wf_drafting',`🔴 ${me.name} rejected sample${note?' — '+note:''}`,'red');
    pushNotif(j.drafterId,'🔴 Sample Rejected',`${j.client} (#${j.jobNum}) — fix & resubmit.${note?' Note: '+note:''}`);
    showToastMsg('Sent back for fixes.');
  }
  window.wfCloseModal();
  renderJobBasket();
};

// ── STAGE 4: DRAFTER SUBMIT SHOP DRAWING ──────────────────────────────────────
window.wfSubmitSD=async function(jobId){
  const j=jobs.find(x=>x.id===jobId);if(!j)return;
  await wfAdvance(jobId,'tl_sd_review',{action:'sd_submitted',owner:j.teamLeaderId,note:'Shop drawing submitted for review'});
  await addEvent(jobId,'wf_tl_sd_review',`📑 ${me.name} submitted shop drawing for review`,'purple');
  pushNotif(j.teamLeaderId,'📑 Shop Drawing Ready',`${j.client} (#${j.jobNum}) — review & submit to client.`);
  showToastMsg('✅ Shop drawing sent to team leader.');
  renderJobBasket();
};

// ── STAGE 5: TL SHOP DRAWING REVIEW → CLIENT ──────────────────────────────────
window.wfReviewSD=function(jobId){
  const j=jobs.find(x=>x.id===jobId);if(!j)return;
  wfAsk('Shop Drawing Review',[
    {q:'Submit shop drawing for client?',key:'submitClient'}
  ],async(ans)=>{
    await wfAdvance(jobId,'client_wait',{action:'sd_to_client',checklist:ans,owner:j.teamLeaderId,note:'Shop drawing submitted to client — awaiting approval'});
    await addEvent(jobId,'wf_client_wait',`📨 ${me.name} submitted shop drawing to client`,'orange');
    showToastMsg('✅ Marked submitted to client.');
    renderJobBasket();
  });
};

// ── STAGE 6: CLIENT APPROVED → ASSIGN JOB CARD (overload check) ───────────────
window.wfAssignJobCard=function(jobId){
  const j=jobs.find(x=>x.id===jobId);if(!j)return;
  const drafter=users.find(u=>u.id===j.drafterId);
  const load=memberLoad(j.drafterId);
  if(load>=3){
    // overload warning — offer reassign
    const dls=jobs.filter(x=>x.owner===j.drafterId&&x.status!=='completed'&&x.deadline).map(x=>fmt(x.deadline)).slice(0,3);
    _wfCtx={jobId};
    wfModalHtml(`
      <div class="wf-q-title">Heads up</div>
      <div class="wf-q-text" style="font-size:0.86rem;">While <strong>${esc(drafter?.name||'they')}</strong> prepared the shop drawing, they currently have <strong>${load}</strong> active task${load>1?'s':''}${dls.length?` with deadlines: ${dls.join(', ')}`:''}.</div>
      <div class="wf-q-actions">
        <button class="wf-btn-no" onclick="wfDoReassignJobCard()">↻ Reassign to freest</button>
        <button class="wf-btn-yes" onclick="wfProceedJobCard('${j.drafterId}')">Proceed with ${esc((drafter?.name||'').split(' ')[0])}</button>
      </div>`);
  }else{
    wfProceedAssignCard(jobId,j.drafterId);
  }
};
window.wfDoReassignJobCard=function(){
  const j=jobs.find(x=>x.id===_wfCtx.jobId);if(!j)return;
  const next=freestMember(j.teamLeaderId,j.drafterId);
  if(!next){showToastMsg('No other team member available.');return;}
  window.wfCloseModal();
  wfProceedAssignCard(j.id,next.id);
};
window.wfProceedJobCard=function(drafterId){
  const j=jobs.find(x=>x.id===_wfCtx.jobId);if(!j)return;
  window.wfCloseModal();
  wfProceedAssignCard(j.id,drafterId);
};
async function wfProceedAssignCard(jobId,drafterId){
  const j=jobs.find(x=>x.id===jobId);if(!j)return;
  const who=users.find(u=>u.id===drafterId);
  await wfAdvance(jobId,'jobcard',{action:'jobcard_assigned',owner:drafterId,drafterId,note:`Job card preparation assigned to ${who?.name}`,extra:{status:'ongoing'}});
  await addEvent(jobId,'wf_jobcard',`🗂 ${me.name} assigned job card prep to ${who?.name}`,'yellow');
  pushNotif(drafterId,'🗂 Job Card Preparation',`${j.client} (#${j.jobNum}) — shop drawing approved, prepare job cards.`);
  showToastMsg(`✅ Job card assigned to ${who?.name}.`);
  renderJobBasket();
}

// ── STAGE 7: DRAFTER SUBMIT JOB CARDS ─────────────────────────────────────────
window.wfSubmitJobCard=function(jobId){
  const j=jobs.find(x=>x.id===jobId);if(!j)return;
  wfAsk('Submit Job Cards — Self Check',QC5,async(ans)=>{
    await wfAdvance(jobId,'tl_jobcard_review',{action:'jobcard_submitted',checklist:ans,owner:j.teamLeaderId,note:'Job cards self-checked & submitted for review'});
    await addEvent(jobId,'wf_tl_jobcard_review',`🗂 ${me.name} self-checked & submitted job cards`,'purple');
    pushNotif(j.teamLeaderId,'🗂 Job Cards Ready',`${j.client} (#${j.jobNum}) — final review to close.`);
    showToastMsg('✅ Job cards sent to team leader.');
    renderJobBasket();
  },(q)=>{showToastMsg('Complete every check before submitting job cards.');});
};

// 5-point final QC checklist (reused for job card close AND release submit)
const QC5=[
  {q:'Did you check the color?',key:'color'},
  {q:'Did you check the material specs?',key:'material'},
  {q:'Did you check quantity availability in the quotation?',key:'qtyQuote'},
  {q:'Did you check for any samples?',key:'samples'},
  {q:'Did you check the panel thickness specs / sketches?',key:'thickness'}
];

// ── STAGE 8: TL REVIEW JOB CARDS → COMPLETE ───────────────────────────────────
window.wfCloseJobCard=function(jobId){
  const j=jobs.find(x=>x.id===jobId);if(!j)return;
  wfAsk('Close Job — Final QC',QC5,async(ans)=>{
    await wfAdvance(jobId,'completed',{action:'completed',checklist:ans,note:'Job cards approved — job completed',statusComplete:true,extra:{releaseEligible:true}});
    await addEvent(jobId,'completed',`✅ ${me.name} passed final QC — job completed`,'green');
    if(j.drafterId)pushNotif(j.drafterId,'✅ Job Completed',`${j.client} (#${j.jobNum}) — closed by ${me.name}.`);
    if(j.wfCreatedBy)pushNotif(j.wfCreatedBy,'✅ Job Completed',`${j.client} (#${j.jobNum}) — your basket job is done.`);
    showToastMsg('🎉 Job completed.');
    renderJobBasket();
  },(q)=>{showToastMsg('All QC checks must pass before closing.');});
};

// ── STAGE 9: REOPEN FOR RELEASE (post-completion, samples approved) ────────────
window.wfReopenRelease=function(jobId){
  const j=jobs.find(x=>x.id===jobId);if(!j)return;
  const drafter=users.find(u=>u.id===j.drafterId);
  const load=memberLoad(j.drafterId);
  _wfCtx={jobId};
  const others=teamMembers(j.teamLeaderId).filter(m=>m.id!==j.drafterId);
  wfModalHtml(`
    <div class="wf-q-title">Reopen for Release — ${esc(j.client)} <span class="tc-muted">#${esc(j.jobNum)}</span></div>
    <div class="wf-q-text" style="font-size:0.82rem;color:var(--text2);">Samples approved by client. Assign release continuation.</div>
    <label class="wf-f">Assign to<select id="wf-rel-member"><option value="${j.drafterId}">${esc(drafter?.name||'original drafter')} · ${load} active (did shop drawing)</option>${others.map(m=>`<option value="${m.id}">${esc(m.name)} · ${memberLoad(m.id)} active</option>`).join('')}</select></label>
    <div class="wf-q-actions"><button class="wf-btn-no" onclick="wfCloseModal()">Cancel</button><button class="wf-btn-yes" onclick="wfConfirmRelease()">Assign Release</button></div>
  `);
};
window.wfConfirmRelease=async function(){
  const j=jobs.find(x=>x.id===_wfCtx.jobId);if(!j)return;
  const memberId=document.getElementById('wf-rel-member').value;
  const who=users.find(u=>u.id===memberId);
  await wfAdvance(j.id,'release',{action:'release_assigned',owner:memberId,drafterId:memberId,note:`Release continuation assigned to ${who?.name}`,extra:{status:'ongoing',completed:null}});
  await addEvent(j.id,'wf_release',`♻️ ${me.name} reopened for release → ${who?.name}`,'blue');
  pushNotif(memberId,'♻️ Release Continuation',`${j.client} (#${j.jobNum}) — samples approved, prepare releases.`);
  window.wfCloseModal();
  showToastMsg(`✅ Release assigned to ${who?.name}.`);
  renderJobBasket();
};

// ── STAGE 10: DRAFTER SUBMIT RELEASE → COMPLETE ───────────────────────────────
window.wfSubmitRelease=function(jobId){
  const j=jobs.find(x=>x.id===jobId);if(!j)return;
  wfAsk('Submit Releases — Final QC',QC5,async(ans)=>{
    await wfAdvance(jobId,'completed',{action:'release_completed',checklist:ans,owner:j.teamLeaderId,note:'Releases prepared & QC passed — completed',statusComplete:true});
    await addEvent(jobId,'completed',`✅ ${me.name} prepared releases & passed QC — completed`,'green');
    pushNotif(j.teamLeaderId,'✅ Releases Done',`${j.client} (#${j.jobNum}) — released & completed by ${me.name}.`);
    showToastMsg('🎉 Releases submitted — job completed.');
    renderJobBasket();
  },(q)=>{showToastMsg('All QC checks must pass before submitting.');});
};

// ── ACTION BUTTON RESOLUTION ──────────────────────────────────────────────────
// returns {label, fn} for the current user on this job, or null
function wfActionFor(j){
  const meta=wfStageMeta(j.stage);
  const amTL=me.id===j.teamLeaderId;
  const amDrafter=me.id===j.drafterId;
  if(j.stage==='intake'&&amTL)return{label:'📥 Take & Assign',fn:`wfTakeJob('${j.id}')`,cls:'primary'};
  if(j.stage==='drafting'&&amDrafter){
    if(j.status==='pending')return{label:'▶ Start Job',fn:`wfStart('${j.id}')`,cls:'primary'};
    return{label:'📐 Submit Roof Layout, CS & Gutter/Curve Sample',fn:`wfSubmitSample('${j.id}')`,cls:'primary'};
  }
  if(j.stage==='tl_sample_review'&&amTL)return{label:'🔍 Review Sample',fn:`wfReviewSample('${j.id}')`,cls:'primary'};
  if(j.stage==='detailing'&&amDrafter)return{label:'📑 Submit Shop Drawing',fn:`wfSubmitSD('${j.id}')`,cls:'primary'};
  if(j.stage==='tl_sd_review'&&amTL)return{label:'📨 Review → Submit to Client',fn:`wfReviewSD('${j.id}')`,cls:'primary'};
  if(j.stage==='client_wait'&&amTL)return{label:'✅ Client Approved → Job Card',fn:`wfAssignJobCard('${j.id}')`,cls:'primary'};
  if(j.stage==='jobcard'&&amDrafter)return{label:'🗂 Submit Job Cards',fn:`wfSubmitJobCard('${j.id}')`,cls:'primary'};
  if(j.stage==='tl_jobcard_review'&&amTL)return{label:'🏁 Review & Close',fn:`wfCloseJobCard('${j.id}')`,cls:'primary'};
  if(j.stage==='completed'&&amTL&&j.releaseEligible)return{label:'♻️ Reopen for Release',fn:`wfReopenRelease('${j.id}')`,cls:'sec'};
  if(j.stage==='release'&&amDrafter)return{label:'📦 Submit Releases',fn:`wfSubmitRelease('${j.id}')`,cls:'primary'};
  return null;
}

// ── TIMELINE HELPERS ──────────────────────────────────────────────────────────
function _evtColor(e){
  const a=e.action||'';
  if(a.includes('reject'))return'red';
  if(a.includes('approv')||a==='completed'||a==='release_completed')return'green';
  if(e.to==='client_wait'||a.includes('client'))return'orange';
  if(a==='assigned'||a==='release_assigned')return'blue';
  return wfStageMeta(e.to).color;
}
function _evtIcon(e){
  const a=e.action||'';
  if(a.includes('reject'))return'🔴';
  if(a.includes('approv'))return'🟢';
  if(a==='completed'||a==='release_completed')return'✅';
  if(a.includes('submit'))return'📤';
  if(a==='assigned'||a==='release_assigned')return'🧭';
  if(e.to==='client_wait')return'📨';
  if(a==='submitted')return'📥';
  return'📌';
}
function _checksHtml(checklist){
  if(!checklist)return'';
  return`<div class="wf-tl-checks">${Object.entries(checklist).map(([k,v])=>`<span class="wf-chk ${v?'ok':'no'}">${v?'✓':'✗'} ${esc(k)}</span>`).join('')}</div>`;
}

// List mode (compact)
function _wfTlList(j){
  const h=Array.isArray(j.wfHistory)?j.wfHistory:[];
  if(!h.length)return'<div class="tc-muted" style="font-size:0.78rem;">No history yet.</div>';
  let prev=null;
  return`<div class="wf-timeline">${h.map(e=>{
    const col=_evtColor(e);
    const dur=prev?` <span class="wf-tl-dur">(+${tdiff(prev.at,e.at)})</span>`:'';
    prev=e;
    const noteHtml=e.note?`<div class="wf-tl-note">${esc(e.note)}</div>`:'';
    return`<div class="wf-tl-row">
      <span class="wf-tl-dot wf-dot-${col}"></span>
      <div class="wf-tl-body">
        <div class="wf-tl-head"><strong>${_evtIcon(e)} ${esc(wfStageMeta(e.to).label)}</strong>${dur}</div>
        <div class="wf-tl-meta">${esc(e.by)} · ${fmt(e.at)}</div>
        ${noteHtml}${_checksHtml(e.checklist)}
      </div>
    </div>`;
  }).join('')}</div>`;
}

// Visual mode (horizontal interactive timeline)
function _wfTlVisual(j){
  const h=Array.isArray(j.wfHistory)?j.wfHistory:[];
  if(!h.length)return'<div class="tc-muted" style="font-size:0.78rem;">No history yet.</div>';
  const events=h.map((e,i)=>{
    const col=_evtColor(e);
    const icon=_evtIcon(e);
    const dur=i>0?`+${tdiff(h[i-1].at,e.at)}`:'Start';
    const above=i%2===0;
    const shortLabel=`<div class="wf-htl-label">${icon} ${esc(wfStageMeta(e.to).short)}</div><div class="wf-htl-sublabel">${esc(dur)}</div>`;
    const checks=_checksHtml(e.checklist);
    const noteHtml=e.note?`<div class="wf-htl-tt-note">${esc(e.note)}</div>`:'';
    // edge-align tooltip so it doesn't clip
    // tooltip lives on .wf-htl-event (position:relative), not inside the dot
    const ttEdge=i===0?'left:0;transform:none;':i===h.length-1?'right:0;left:auto;transform:none;':'left:50%;transform:translateX(-50%);';
    const tooltip=`<div class="wf-htl-tooltip" style="${ttEdge}">
      <div class="wf-htl-tt-stage">${icon} ${esc(wfStageMeta(e.to).label)}</div>
      <div class="wf-htl-tt-meta">${esc(e.by)} · ${fmt(e.at)}</div>
      <div class="wf-htl-tt-dur">${esc(dur)}</div>
      ${noteHtml}${checks}
    </div>`;
    return`<div class="wf-htl-event" tabindex="0">
      <div class="wf-htl-above">${above?shortLabel:''}</div>
      <div class="wf-htl-stem ${above?'wf-htl-stem-down':'wf-htl-stem-up'}"></div>
      <div class="wf-htl-dot wf-htl-dot-${col}">${i+1}</div>
      <div class="wf-htl-stem ${above?'wf-htl-stem-up':'wf-htl-stem-down'}"></div>
      <div class="wf-htl-below">${above?'':shortLabel}</div>
      ${tooltip}
    </div>`;
  }).join('');
  return`<div class="wf-htl"><div class="wf-htl-track">
    <div class="wf-htl-line"></div>
    <div class="wf-htl-events">${events}</div>
  </div></div>`;
}

// Public export used by analytics section
export function wfTimeline(j){return _wfTlList(j);}

// ── TIMELINE TOGGLE ───────────────────────────────────────────────────────────
const _tlMode={};
function _renderTl(id){
  const el=document.getElementById('wf-tl-'+id);
  if(!el||el.style.display==='none')return;
  const j=jobs.find(x=>x.id===id);if(!j)return;
  const mode=_tlMode[id]||'list';
  const modeTabs=`<div class="wf-tl-modetabs">
    <button class="wf-tl-mtab${mode==='list'?' active':''}" onclick="wfSetTlMode('${id}','list')">☰ List</button>
    <button class="wf-tl-mtab${mode==='visual'?' active':''}" onclick="wfSetTlMode('${id}','visual')">📊 Visual</button>
  </div>`;
  el.innerHTML=modeTabs+(mode==='visual'?_wfTlVisual(j):_wfTlList(j));
}
window.wfToggleTimeline=function(id){
  const el=document.getElementById('wf-tl-'+id);
  if(!el)return;
  const hidden=el.style.display==='none'||!el.style.display;
  el.style.display=hidden?'block':'none';
  if(hidden)_renderTl(id);
};
window.wfSetTlMode=function(id,mode){_tlMode[id]=mode;_renderTl(id);};

// ── STAGE PROGRESS PIPELINE (visual) ──────────────────────────────────────────
const PIPELINE=['intake','drafting','tl_sample_review','detailing','tl_sd_review','client_wait','jobcard','tl_jobcard_review','completed'];
function wfPipeline(j){
  const cur=PIPELINE.indexOf(j.stage==='release'?'completed':j.stage);
  return`<div class="wf-pipe">${PIPELINE.map((s,i)=>{
    const st=i<cur?'done':i===cur?'cur':'todo';
    return`<span class="wf-pipe-seg ${st}" title="${esc(wfStageMeta(s).short)}"></span>`;
  }).join('')}</div>`;
}

// ── JOB CARD RENDER ───────────────────────────────────────────────────────────
function wfCard(j,showAction){
  const meta=wfStageMeta(j.stage);
  const tl=users.find(u=>u.id===j.teamLeaderId);
  const drafter=users.find(u=>u.id===j.drafterId);
  const act=showAction?wfActionFor(j):null;
  const rej=j.stage==='drafting'&&j.rejectedSample?`<span class="wf-rej">🔴 Sample rejected — resubmit${j.rejectNote?': '+esc(j.rejectNote):''}</span>`:'';
  const od=j.deadline&&j.status!=='completed'&&isOverdue(j)?'<span class="wf-od">⚠ overdue</span>':'';
  return`<div class="wf-card">
    <div class="wf-card-top">
      <div class="wf-card-id"><strong>${esc(j.client)}</strong> <span class="tc-muted">#${esc(j.jobNum)}</span>${j.projectName?` <span class="wf-proj">📁 ${esc(j.projectName)}</span>`:''}</div>
      <span class="wf-stage-bdg wf-bdg-${meta.color}">${esc(meta.label)}</span>
    </div>
    ${wfPipeline(j)}
    <div class="wf-card-meta">
      ${j.type?`<span>🏷 ${esc(j.type)}</span>`:''}
      ${tl?`<span>🧭 ${esc(tl.name)}</span>`:''}
      ${drafter?`<span>👤 ${esc(drafter.name)}</span>`:''}
      ${j.deadline?`<span>📅 ${fmt(j.deadline)}</span>`:''}
      ${od}
    </div>
    ${rej}
    <div class="wf-card-actions">
      ${act?`<button class="wf-act ${act.cls}" onclick="${act.fn}">${act.label}</button>`:''}
      <button class="wf-act sec" onclick="wfToggleTimeline('${j.id}')">🕐 Timeline</button>
    </div>
    <div class="wf-tl-wrap" id="wf-tl-${j.id}" style="display:none;">${wfTimeline(j)}</div>
  </div>`;
}

// ── WORKFLOW ANALYTICS (stage durations / bottleneck / rejects) ───────────────
function wfAnalytics(pool){
  const done=pool.filter(j=>j.stage==='completed'&&Array.isArray(j.wfHistory));
  if(done.length<1)return'';
  // avg duration per transition
  const trans={};
  done.forEach(j=>{
    const h=j.wfHistory;
    for(let i=1;i<h.length;i++){
      const key=wfStageMeta(h[i].to).short;
      const d=h[i].at-h[i-1].at;
      if(d>0){(trans[key]=trans[key]||[]).push(d);}
    }
  });
  const rows=Object.entries(trans).map(([k,arr])=>({k,avg:arr.reduce((a,b)=>a+b,0)/arr.length,n:arr.length})).sort((a,b)=>b.avg-a.avg);
  if(!rows.length)return'';
  const max=Math.max(...rows.map(r=>r.avg));
  const rejects=pool.reduce((a,j)=>a+(Array.isArray(j.wfHistory)?j.wfHistory.filter(e=>e.action==='sample_rejected').length:0),0);
  return`<div class="wf-analytics">
    <div class="wf-an-hd">⏱ Stage Durations <span class="tc-muted">avg, slowest first · ${done.length} completed</span></div>
    ${rows.map(r=>`<div class="an-bar-row"><span class="an-bar-label">${esc(r.k)}</span><div class="an-bar-track"><div class="an-bar-fill" style="width:${Math.max(Math.round(r.avg/max*100),3)}%;background:${r.avg===max?'var(--red)':'var(--blue)'}"></div></div><span class="an-bar-val">${tdiff(0,r.avg)}</span></div>`).join('')}
    <div class="wf-an-foot">🔴 Sample rejections: <strong>${rejects}</strong> · Bottleneck: <strong>${esc(rows[0].k)}</strong></div>
  </div>`;
}

// ── ANALYTICS-PAGE SECTION (stage timing, cycle, bottleneck, throughput) ──────
export function wfAnalyticsSection(){
  if(!me)return'';
  let pool=jobs.filter(j=>j.workflow);
  if(me.role==='team_leader')pool=pool.filter(j=>j.teamLeaderId===me.id);
  else if(!['manager','supervisor'].includes(me.role)&&!amDirector())return'';
  if(!pool.length)return'';
  const done=pool.filter(j=>j.stage==='completed'&&Array.isArray(j.wfHistory));
  const active=pool.filter(j=>j.stage!=='completed');
  // full cycle time (first entry → completion)
  const cycles=done.map(j=>{const h=j.wfHistory;return h.length>1?h[h.length-1].at-h[0].at:0;}).filter(x=>x>0);
  const avgCycle=cycles.length?cycles.reduce((a,b)=>a+b,0)/cycles.length:0;
  // stage durations
  const trans={};
  done.forEach(j=>{const h=j.wfHistory;for(let i=1;i<h.length;i++){const k=wfStageMeta(h[i].to).short;const d=h[i].at-h[i-1].at;if(d>0)(trans[k]=trans[k]||[]).push(d);}});
  const rows=Object.entries(trans).map(([k,a])=>({k,avg:a.reduce((x,y)=>x+y,0)/a.length})).sort((a,b)=>b.avg-a.avg);
  const max=rows.length?Math.max(...rows.map(r=>r.avg)):1;
  const rejects=pool.reduce((a,j)=>a+(Array.isArray(j.wfHistory)?j.wfHistory.filter(e=>e.action==='sample_rejected').length:0),0);
  // throughput per drafter (completed)
  const byDrafter={};
  done.forEach(j=>{if(j.drafterId){const u=users.find(x=>x.id===j.drafterId);const nm=u?.name||'?';byDrafter[nm]=(byDrafter[nm]||0)+1;}});
  const draftRows=Object.entries(byDrafter).map(([k,v])=>({k,v})).sort((a,b)=>b.v-a.v);
  const maxD=draftRows.length?Math.max(...draftRows.map(r=>r.v)):1;
  const kpi=(l,v,c)=>`<div class="an-kpi"><div class="an-kpi-label">${l}</div><div class="an-kpi-value" style="color:${c}">${v}</div></div>`;
  return`<div class="an-section-title">🧺 Job Basket Workflow</div>
    <div class="an-kpis">
      ${kpi('Active',active.length,'var(--blue)')}
      ${kpi('Completed',done.length,'var(--green)')}
      ${kpi('Avg Cycle',avgCycle?tdiff(0,avgCycle):'—','var(--text)')}
      ${kpi('Sample Rejections',rejects,rejects?'var(--red)':'var(--text3)')}
    </div>
    <div class="an-row-2">
      <div class="an-widget"><div class="an-widget-hd">Stage Durations <span class="an-hd-note">avg · slowest = bottleneck</span></div>${rows.length?rows.map(r=>`<div class="an-bar-row"><span class="an-bar-label">${esc(r.k)}</span><div class="an-bar-track"><div class="an-bar-fill" style="width:${Math.max(Math.round(r.avg/max*100),3)}%;background:${r.avg===max?'var(--red)':'var(--blue)'}"></div></div><span class="an-bar-val">${tdiff(0,r.avg)}</span></div>`).join(''):'<div class="empty" style="padding:0.5rem 0;">No completed workflow jobs yet.</div>'}</div>
      <div class="an-widget"><div class="an-widget-hd">Workflow Throughput <span class="an-hd-note">completed per drafter</span></div>${draftRows.length?draftRows.map(r=>`<div class="an-bar-row"><span class="an-bar-label">${esc(r.k)}</span><div class="an-bar-track"><div class="an-bar-fill" style="width:${Math.max(Math.round(r.v/maxD*100),3)}%;background:var(--purple)"></div></div><span class="an-bar-val">${r.v}</span></div>`).join(''):'<div class="empty" style="padding:0.5rem 0;">No data.</div>'}</div>
    </div>`;
}

// ── TAB STATE ─────────────────────────────────────────────────────────────────
let _wfTab=null;
window.wfSetTab=function(key){_wfTab=key;renderJobBasket();};
function _tabBar(tabs,cur){
  return`<div class="wf-tabs">${tabs.map(t=>`<button class="wf-tab${t.key===cur?' active':''}" onclick="wfSetTab('${t.key}')">${t.label}${t.n?` <span class="wf-tab-count">${t.n}</span>`:''}</button>`).join('')}</div>`;
}
function _pickTab(tabs,preferred){
  const keys=tabs.map(t=>t.key);
  return keys.includes(preferred)?preferred:keys[0];
}

// ── MAIN RENDER ───────────────────────────────────────────────────────────────
export function renderJobBasket(){
  const root=document.getElementById('job-basket-root');
  if(!root||!me)return;
  const wfJobs=jobs.filter(j=>j.workflow);
  const r=me.role;

  // ── SALES OPERATION ──
  if(r==='sales_operation'){
    const mine=wfJobs.filter(j=>j.wfCreatedBy===me.id).sort((a,b)=>(b.created||0)-(a.created||0));
    const active=mine.filter(j=>j.stage!=='completed');
    const done=mine.filter(j=>j.stage==='completed');
    const tabs=[
      {key:'submit',label:'📤 Submit'},
      {key:'active',label:'🔄 Active',n:active.length||null},
      {key:'done',label:'✅ Done',n:done.length||null}
    ];
    const tab=_pickTab(tabs,_wfTab);_wfTab=tab;
    let content='';
    if(tab==='submit'){
      content=`<div class="wf-so-form">
        <div class="wf-an-hd">📤 Send Job to Basket</div>
        <label class="wf-f">Client Name<input id="wf-so-client" placeholder="Client name"></label>
        <label class="wf-f">Job #<input id="wf-so-jobnum" placeholder="Job number"></label>
        <label class="wf-f">Project Name<input id="wf-so-project" placeholder="Project name (optional)"></label>
        <button class="wf-act primary" style="margin-top:0.5rem;" onclick="wfSubmitToBasket()">🧺 Send to Basket</button>
        <div class="tc-muted" style="font-size:0.72rem;margin-top:0.4rem;">Auto-assigned to the freest team leader's team.</div>
      </div>`;
    }else if(tab==='active'){
      content=active.length?active.map(j=>wfCard(j,false)).join(''):'<div class="empty" style="padding:1.5rem;">No active jobs.</div>';
    }else{
      content=done.length?done.map(j=>wfCard(j,false)).join(''):'<div class="empty" style="padding:1.5rem;">No completed jobs yet.</div>';
    }
    root.innerHTML=_tabBar(tabs,tab)+`<div class="wf-tab-content">${content}</div>`;
    return;
  }

  // ── TEAM LEADER ──
  if(r==='team_leader'){
    // BUG FIX: completed jobs excluded from action queue; shown only in Completed tab with Reopen button
    const myAction=wfJobs.filter(j=>wfActionFor(j)&&j.stage!=='completed').sort((a,b)=>(a.deadline||9e15)-(b.deadline||9e15));
    const withTeam=wfJobs.filter(j=>j.teamLeaderId===me.id&&!wfActionFor(j)&&j.stage!=='completed');
    const doneJobs=wfJobs.filter(j=>j.teamLeaderId===me.id&&j.stage==='completed');
    const tabs=[
      {key:'queue',label:'⚡ My Queue',n:myAction.length||null},
      {key:'team',label:'⏳ My Team',n:withTeam.length||null},
      {key:'done',label:'✅ Completed',n:doneJobs.length||null}
    ];
    const tab=_pickTab(tabs,_wfTab);_wfTab=tab;
    let content='';
    if(tab==='queue'){
      content=myAction.length?myAction.map(j=>wfCard(j,true)).join(''):'<div class="empty" style="padding:1.25rem;">Nothing waiting on you 🎉</div>';
    }else if(tab==='team'){
      content=withTeam.length?withTeam.map(j=>wfCard(j,false)).join(''):'<div class="empty" style="padding:1.25rem;">No jobs currently with your team.</div>';
    }else{
      // pass showAction=true so Reopen for Release button appears in completed tab
      content=doneJobs.length?doneJobs.map(j=>wfCard(j,true)).join(''):'<div class="empty" style="padding:1.25rem;">No completed jobs yet.</div>';
    }
    root.innerHTML=_tabBar(tabs,tab)+`<div class="wf-tab-content">${content}</div>`;
    return;
  }

  // ── MANAGER / SUPERVISOR / DIRECTOR ──
  if(r==='manager'||r==='supervisor'||amDirector()){
    const active=wfJobs.filter(j=>j.stage!=='completed').sort((a,b)=>(a.deadline||9e15)-(b.deadline||9e15));
    const doneJobs=wfJobs.filter(j=>j.stage==='completed');
    const tabs=[
      {key:'overview',label:'🧺 Overview',n:active.length||null},
      {key:'done',label:'✅ Completed',n:doneJobs.length||null}
    ];
    const tab=_pickTab(tabs,_wfTab);_wfTab=tab;
    let content='';
    if(tab==='overview'){
      content=active.length?active.map(j=>wfCard(j,false)).join(''):'<div class="empty" style="padding:1.25rem;">No active workflow jobs.</div>';
    }else{
      content=doneJobs.length?doneJobs.map(j=>wfCard(j,false)).join(''):'<div class="empty" style="padding:1.25rem;">No completed jobs yet.</div>';
    }
    root.innerHTML=_tabBar(tabs,tab)+`<div class="wf-tab-content">${content}</div>`;
    return;
  }

  // ── EMPLOYEE / DRAFTER ──
  const myAction=wfJobs.filter(j=>j.drafterId===me.id&&wfActionFor(j)).sort((a,b)=>(a.deadline||9e15)-(b.deadline||9e15));
  const submitted=wfJobs.filter(j=>j.drafterId===me.id&&!wfActionFor(j)&&j.stage!=='completed');
  const doneJobs=wfJobs.filter(j=>j.drafterId===me.id&&j.stage==='completed');
  const tabs=[
    {key:'tasks',label:'⚡ My Tasks',n:myAction.length||null},
    {key:'submitted',label:'⏳ Submitted',n:submitted.length||null},
    {key:'done',label:'✅ Completed',n:doneJobs.length||null}
  ];
  const tab=_pickTab(tabs,_wfTab);_wfTab=tab;
  let content='';
  if(tab==='tasks'){
    content=myAction.length?myAction.map(j=>wfCard(j,true)).join(''):'<div class="empty" style="padding:1.25rem;">No workflow tasks waiting on you 🎉</div>';
  }else if(tab==='submitted'){
    content=submitted.length?submitted.map(j=>wfCard(j,false)).join(''):'<div class="empty" style="padding:1.25rem;">Nothing submitted awaiting review.</div>';
  }else{
    content=doneJobs.length?doneJobs.map(j=>wfCard(j,false)).join(''):'<div class="empty" style="padding:1.25rem;">No completed jobs yet.</div>';
  }
  root.innerHTML=_tabBar(tabs,tab)+`<div class="wf-tab-content">${content}</div>`;
}
