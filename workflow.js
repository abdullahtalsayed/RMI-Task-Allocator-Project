// ── JOB BASKET / WORKFLOW ─────────────────────────────────────────────────────
// Type-aware staged pipeline. Sales Op creates stub → weighted TL assignment →
// TL picks type + scope at intake → type-specific staged pipeline.
// workflow:true on all basket jobs. job.owner = current ball-holder.
// Only Shop Drawing pipeline is fully implemented. Other types = stubs (future).
//
// Shop Drawing stages (scope-aware):
//   intake
//   → sd_roof_draft        (if roof in scope)
//   → sd_tl_roof_review    (if roof in scope)
//   → sd_wall_draft        (if wall in scope)
//   → sd_tl_wall_review    (if wall in scope)
//   → sd_client_wait
//   → sd_revision_draft    (only if client rejects)
//   → sd_tl_revision_review
//   → sd_jobcard
//   → sd_tl_jobcard_review
//   → completed
//   → release              (optional reopen)

import { jobs, users, me, JOB_TYPES } from './state.js';
import { escapeHtml, fmt, tdiff, toMillis } from './helpers.js';
import { jAdd, updateJob } from './jobs.js';
import { addEvent, showToastMsg, pushNotif, isOverdue, isTeamLeader, amDirector } from './main.js';

const esc = escapeHtml;

// ── FIXED TOOLTIP ─────────────────────────────────────────────────────────────
const _htlTipEl = (()=>{
  const d = document.createElement('div');
  d.className = 'wf-htl-gtip';
  document.body.appendChild(d);
  return d;
})();
const _htlTipData = {};
window.wfHtlShow = function(el, key){
  const html = _htlTipData[key]; if(!html) return;
  _htlTipEl.innerHTML = html; _htlTipEl.style.display = 'block';
  const r = el.getBoundingClientRect();
  const tw = _htlTipEl.offsetWidth; const th = _htlTipEl.offsetHeight;
  let left = r.left + r.width/2 - tw/2;
  let top = r.top - th - 10;
  if(top < 8){ top = r.bottom + 10; }
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  _htlTipEl.style.left = left + 'px'; _htlTipEl.style.top = top + 'px';
};
window.wfHtlHide = function(){ _htlTipEl.style.display = 'none'; };

// ── STAGE DEFINITIONS ─────────────────────────────────────────────────────────
export const WF_STAGES = {
  // shared
  intake:                  { actor:'tl',      label:'TL Intake',                          short:'Intake',      color:'blue'   },
  // shop drawing
  sd_roof_draft:           { actor:'drafter', label:'Roof Layout & Sample Preparation',   short:'Roof Draft',  color:'yellow' },
  sd_tl_roof_review:       { actor:'tl',      label:'Roof Layout & Sample Review',        short:'Roof Review', color:'purple' },
  sd_wall_draft:           { actor:'drafter', label:'Wall Layout & Flashing Details',     short:'Wall Draft',  color:'yellow' },
  sd_tl_wall_review:       { actor:'tl',      label:'Wall Layout & Flashing Review',      short:'Wall Review', color:'purple' },
  sd_client_wait:          { actor:'tl',      label:'Awaiting Client Approval',           short:'Client Wait', color:'orange' },
  sd_revision_draft:       { actor:'drafter', label:'Revision — Client Rejected',         short:'Revision',    color:'red'    },
  sd_tl_revision_review:   { actor:'tl',      label:'Revision Review',                   short:'Rev Review',  color:'purple' },
  sd_jobcard:              { actor:'drafter', label:'Job Card Preparation',              short:'Job Card',    color:'yellow' },
  sd_tl_jobcard_review:    { actor:'tl',      label:'Job Card Review',                   short:'Card Review', color:'purple' },
  // terminal
  completed:               { actor:'none',    label:'Completed',                          short:'Done',        color:'green'  },
  // reopen/continuation
  release:                 { actor:'drafter', label:'Continuation / Release',            short:'Release',     color:'yellow' },
};

export function wfStageMeta(s){ return WF_STAGES[s] || { actor:'none', label:s, short:s, color:'blue' }; }

// ── PIPELINE ORDER (scope-aware, for progress bar) ────────────────────────────
function _sdPipeline(j){
  const s = j.sdScope || 'roof_wall';
  const roof = s === 'roof' || s === 'roof_wall';
  const wall = s === 'wall' || s === 'roof_wall';
  const base = ['intake'];
  if(roof){ base.push('sd_roof_draft', 'sd_tl_roof_review'); }
  if(wall){ base.push('sd_wall_draft', 'sd_tl_wall_review'); }
  base.push('sd_client_wait');
  const hasRevision = Array.isArray(j.wfHistory) && j.wfHistory.some(e => e.to === 'sd_revision_draft');
  if(hasRevision){ base.push('sd_revision_draft', 'sd_tl_revision_review'); }
  base.push('sd_jobcard', 'sd_tl_jobcard_review', 'completed');
  return base;
}

function wfPipeline(j){
  let pipeline;
  if(j.type === 'Shop Drawing' || !j.type){ pipeline = _sdPipeline(j); }
  else { pipeline = ['intake', 'completed']; }
  const displayStage = j.stage === 'release' ? 'completed' : j.stage;
  const cur = pipeline.indexOf(displayStage);
  return `<div class="wf-pipe">${pipeline.map((s,i)=>{
    const st = i < cur ? 'done' : i === cur ? 'cur' : 'todo';
    return `<span class="wf-pipe-seg ${st}" title="${esc(wfStageMeta(s).short)}"></span>`;
  }).join('')}</div>`;
}

// ── HEALTH / WEIGHTED TL PICK ─────────────────────────────────────────────────
function teamMemberIdsOf(tlId){
  return new Set([tlId, ...users.filter(u => u.teamLeaderId === tlId).map(u => u.id)]);
}
export function wfHealthScore(tlId){
  const ids = teamMemberIdsOf(tlId);
  let active = 0, overdue = 0;
  jobs.forEach(j => {
    if(ids.has(j.owner) && j.status !== 'completed'){
      active++;
      if(isOverdue(j)) overdue++;
    }
  });
  return active + overdue * 2;
}
export function pickTeamLeaderWeighted(){
  const tls = users.filter(u => u.role === 'team_leader');
  if(!tls.length) return null;
  const scored = tls.map(tl => ({tl, score: wfHealthScore(tl.id)}));
  const maxScore = Math.max(...scored.map(s => s.score));
  const tickets = scored.map(s => ({tl: s.tl, t: (maxScore - s.score) + 1}));
  const total = tickets.reduce((a, x) => a + x.t, 0);
  let r = Math.random() * total;
  for(const x of tickets){ if(r < x.t) return x.tl; r -= x.t; }
  return tickets[0].tl;
}
function memberLoad(uId){ return jobs.filter(j => j.owner === uId && j.status !== 'completed').length; }
function teamMembers(tlId){ return users.filter(u => u.teamLeaderId === tlId && u.role === 'employee'); }
function freestMember(tlId, excludeId){
  const ms = teamMembers(tlId).filter(m => m.id !== excludeId);
  if(!ms.length) return null;
  return ms.map(m => ({m, load: memberLoad(m.id)})).sort((a,b) => a.load - b.load)[0].m;
}

// ── SALES OP: SUBMIT TO BASKET ─────────────────────────────────────────────────
window.wfSubmitToBasket = async function(){
  const c   = document.getElementById('wf-so-client')?.value.trim();
  const n   = document.getElementById('wf-so-jobnum')?.value.trim();
  const p   = document.getElementById('wf-so-project')?.value.trim();
  const rem = document.getElementById('wf-so-remarks')?.value.trim();
  if(!c || !n){ alert('Client Name and Job # are required.'); return; }
  const tl = pickTeamLeaderWeighted();
  if(!tl){ alert('No team leaders available to receive the job.'); return; }
  const now = Date.now();
  const id = await jAdd({
    client:c, jobNum:n, projectName:p||'', remarks:rem||'',
    type:null, priority:'Medium',
    workflow:true, source:'sales', stage:'intake',
    owner:tl.id, teamLeaderId:tl.id, drafterId:null,
    wfCreatedBy:me.id, wfCreatedByName:me.name,
    status:'pending', created:now, started:null, completed:null, deadline:null,
    sdScope:null, sdGutter:null, sdSkylight:null,
    rejectionCount:0,
    wfHistory:[{stage:'_new',to:'intake',action:'submitted',by:me.name,byId:me.id,at:now,
      note:`Sent to ${tl.name}'s team`}],
    pinned:false, totalPausedMs:0, pausedAt:null,
  });
  await addEvent(id,'wf_intake',`📥 ${me.name} (Sales Op) sent job to basket → auto-assigned to ${tl.name}'s team`,'blue');
  pushNotif(tl.id,'🧺 New Job in Basket',`${c} (#${n}) was routed to your team. Review & assign.`);
  ['wf-so-client','wf-so-jobnum','wf-so-project','wf-so-remarks'].forEach(id=>{
    const el = document.getElementById(id); if(el) el.value = '';
  });
  showToastMsg(`✅ Job sent to ${tl.name}'s team.`);
  renderJobBasket();
};

// ── STAGE ADVANCE ─────────────────────────────────────────────────────────────
async function wfAdvance(jobId, toStage, opts={}){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  const {
    action='advance', checklist=null, note=null,
    owner=null, drafterId, extra={}, statusComplete=false,
  } = opts;
  const hist = Array.isArray(j.wfHistory) ? [...j.wfHistory] : [];
  hist.push({stage:j.stage, to:toStage, action, by:me.name, byId:me.id, at:Date.now(), checklist, note});
  const patch = {stage:toStage, wfHistory:hist, ...extra};
  if(owner) patch.owner = owner;
  if(drafterId !== undefined) patch.drafterId = drafterId;
  if(statusComplete){
    patch.status = 'completed'; patch.completed = Date.now();
    if(j.started) patch.durationTotalMs = Date.now() - toMillis(j.started);
  } else if(toStage !== 'completed'){
    if(j.status === 'completed') patch.status = 'ongoing';
  }
  await updateJob(jobId, patch);
}

// ── MODAL HELPERS ─────────────────────────────────────────────────────────────
let _wfCtx = {};
function wfModalHtml(html){
  const m = document.getElementById('wf-modal');
  document.getElementById('wf-modal-body').innerHTML = html;
  m.classList.add('open');
}
window.wfCloseModal = function(){ document.getElementById('wf-modal').classList.remove('open'); };

// Sequential yes/no checklist — any No blocks; all Yes → onAllYes
function wfAsk(title, questions, onAllYes, onNo){
  const st = {i:0, answers:{}};
  function render(){
    const q = questions[st.i];
    wfModalHtml(`
      <div class="wf-q-title">${esc(title)}</div>
      <div class="wf-q-step">Question ${st.i+1} of ${questions.length}</div>
      <div class="wf-q-text">${esc(q.q)}</div>
      <div class="wf-q-actions">
        <button class="wf-btn-no" onclick="__wfAns(false)">No</button>
        <button class="wf-btn-yes" onclick="__wfAns(true)">Yes</button>
      </div>`);
  }
  window.__wfAns = function(yes){
    const q = questions[st.i];
    st.answers[q.key] = yes;
    if(!yes){ window.wfCloseModal(); if(onNo) onNo(q, st.answers); return; }
    st.i++;
    if(st.i >= questions.length){ window.wfCloseModal(); onAllYes(st.answers); return; }
    render();
  };
  render();
}

// Approve/reject decision modal (reject comment mandatory when rejectRequired=true)
function wfShowDecision(j, desc, fnName, rejectRequired=false){
  wfModalHtml(`
    <div class="wf-q-title">Review — ${esc(j.client)} <span class="tc-muted">#${esc(j.jobNum)}</span></div>
    <div class="wf-q-text" style="font-size:0.82rem;color:var(--text2);">${esc(desc)}</div>
    <label class="wf-f">
      Comment${rejectRequired
        ? ' <span style="color:var(--red);font-size:0.75rem;">* required when rejecting</span>'
        : ' <span class="tc-muted">(optional)</span>'}
      <textarea id="wf-reject-note" rows="2" placeholder="${rejectRequired?'Required: what needs fixing?':'What needs fixing?'}"></textarea>
    </label>
    <div class="wf-q-actions">
      <button class="wf-btn-reject" onclick="${fnName}(false)">✗ Reject</button>
      <button class="wf-btn-yes" onclick="${fnName}(true)">✓ Approve</button>
    </div>`);
}

// ── DYNAMIC CHECKLISTS ────────────────────────────────────────────────────────
function _roofDrafterChecklist(j){
  const qs = [
    {q:'Did you prepare the roof layout plan?',    key:'roofLayout'},
    {q:'Did you prepare the roof cross section?',  key:'crossSection'},
  ];
  if(j.sdGutter && j.sdGutter !== 'none'){
    const lbl = j.sdGutter === 'eave_gutter' ? 'eave gutter' : 'curve';
    qs.push({q:`Did you prepare the ${lbl} sample?`, key:'gutterSample'});
  }
  if(j.sdSkylight){
    qs.push({q:'Did you prepare the skylight proposal?', key:'skylightProposal'});
  }
  return qs;
}

function _roofTLChecklist(){
  return [
    {q:'Did you check the panel lengths?',  key:'panelLengths'},
    {q:'Did you check the dimensions?',     key:'dimensions'},
    {q:'Did you check the cutback?',        key:'cutback'},
    {q:'Did you check the quantity (qty)?', key:'qty'},
  ];
}

function _wallDrafterChecklist(){
  return [
    {q:'Did you prepare the wall layout?',              key:'wallLayout'},
    {q:'Did you check the panel lengths?',              key:'panelLengths'},
    {q:'Did you check for any openings?',               key:'openings'},
    {q:'Did you check the specs (RW or PIR)?',          key:'specs'},
    {q:'Did you check the required flashings?',         key:'flashings'},
  ];
}

function _wallTLChecklist(){
  return [
    {q:'Did you check the wall layout?',               key:'wallLayout'},
    {q:'Did you check the panel lengths?',             key:'panelLengths'},
    {q:'Did you check all openings?',                  key:'openings'},
    {q:'Did you check the material specs (RW/PIR)?',   key:'specs'},
    {q:'Did you check the flashing details?',          key:'flashings'},
  ];
}

// Revision checklist = union of all phases in scope
function _revisionDrafterChecklist(j){
  const s = j.sdScope || 'roof_wall';
  const qs = [];
  if(s === 'roof' || s === 'roof_wall') qs.push(..._roofDrafterChecklist(j));
  if(s === 'wall' || s === 'roof_wall') qs.push(..._wallDrafterChecklist());
  return qs;
}
function _revisionTLChecklist(j){
  const s = j.sdScope || 'roof_wall';
  const qs = [];
  if(s === 'roof' || s === 'roof_wall') qs.push(..._roofTLChecklist());
  if(s === 'wall' || s === 'roof_wall') qs.push(..._wallTLChecklist());
  return qs;
}

// 5-point job card QC (used for both drafter self-check and TL close)
const QC5 = [
  {q:'Did you check the color?',                                  key:'color'},
  {q:'Did you check the material specs?',                         key:'material'},
  {q:'Did you check quantity availability in the quotation?',     key:'qtyQuote'},
  {q:'Did you check for any samples?',                            key:'samples'},
  {q:'Did you check the panel thickness specs / sketches?',       key:'thickness'},
];

// ── INTAKE: TL TAKE & ASSIGN ──────────────────────────────────────────────────
window.wfTakeJob = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  wfAsk('Pre-Assignment Check',[
    {q:'Did you check the Steel IFC drawings?',     key:'steelIFC'},
    {q:'Did you check the Architectural drawings?', key:'architectural'},
  ],(ans)=>{
    _wfCtx = {jobId, checklist:ans};
    _wfShowAssignForm(j);
  },(q)=>{
    showToastMsg(`Check the ${q.key==='steelIFC'?'Steel IFC':'Architectural'} drawings before assigning.`);
  });
};

function _wfShowAssignForm(j){
  const ms = teamMembers(j.teamLeaderId);
  const freest = freestMember(j.teamLeaderId);
  if(!ms.length){ showToastMsg('No employees in your team to assign to.'); return; }
  wfModalHtml(`
    <div class="wf-q-title">Assign — ${esc(j.client)} <span class="tc-muted">#${esc(j.jobNum)}</span></div>
    ${j.projectName ? `<div class="wf-q-sub">📁 ${esc(j.projectName)}</div>` : ''}
    ${j.remarks     ? `<div class="wf-q-sub" style="color:var(--text2);">💬 ${esc(j.remarks)}</div>` : ''}
    <label class="wf-f">Type of Job
      <select id="wf-type" onchange="wfTypeChange()">
        ${JOB_TYPES.map(t=>`<option value="${esc(t)}"${t==='Shop Drawing'?' selected':''}>${esc(t)}</option>`).join('')}
      </select>
    </label>
    <div id="wf-sd-scope-wrap">
      <label class="wf-f">Scope of Work
        <select id="wf-sd-scope" onchange="wfScopeChange()">
          <option value="roof">Roof Only</option>
          <option value="wall">Wall Only</option>
          <option value="roof_wall" selected>Roof + Wall</option>
        </select>
      </label>
      <div id="wf-sd-roof-opts">
        <label class="wf-f">Gutter / Curve
          <select id="wf-sd-gutter">
            <option value="eave_gutter">Eave Gutter</option>
            <option value="curve">Curve</option>
            <option value="none">None</option>
          </select>
        </label>
        <label class="wf-f" style="flex-direction:row;align-items:center;gap:0.6rem;cursor:pointer;">
          <input type="checkbox" id="wf-sd-skylight"> Skylight included
        </label>
      </div>
    </div>
    <label class="wf-f">Deadline<input type="datetime-local" id="wf-dl"></label>
    <label class="wf-f">Assign to (freest first)
      <select id="wf-member">
        ${ms.map(m=>({m,l:memberLoad(m.id)})).sort((a,b)=>a.l-b.l)
          .map(({m,l})=>`<option value="${m.id}"${m.id===freest?.id?' selected':''}>${esc(m.name)} · ${l} active</option>`).join('')}
      </select>
    </label>
    <div class="wf-q-actions">
      <button class="wf-btn-no" onclick="wfCloseModal()">Cancel</button>
      <button class="wf-btn-yes" onclick="wfConfirmAssign()">Assign Job</button>
    </div>`);
}

window.wfTypeChange = function(){
  const t  = document.getElementById('wf-type')?.value;
  const sw = document.getElementById('wf-sd-scope-wrap');
  if(sw) sw.style.display = (t === 'Shop Drawing') ? 'block' : 'none';
};

window.wfScopeChange = function(){
  const s  = document.getElementById('wf-sd-scope')?.value;
  const ro = document.getElementById('wf-sd-roof-opts');
  if(ro) ro.style.display = (s === 'roof' || s === 'roof_wall') ? 'block' : 'none';
};

window.wfConfirmAssign = async function(){
  const j = jobs.find(x => x.id === _wfCtx.jobId); if(!j) return;
  const type     = document.getElementById('wf-type').value;
  const dlv      = document.getElementById('wf-dl').value;
  const memberId = document.getElementById('wf-member').value;
  if(!memberId){ alert('Pick a team member.'); return; }
  const member = users.find(u => u.id === memberId);

  const extra = {
    type,
    deadline: dlv ? new Date(dlv).getTime() : null,
    status:'pending', started:null,
  };

  let firstStage;
  if(type === 'Shop Drawing'){
    const scope   = document.getElementById('wf-sd-scope').value;
    const gutter  = (scope==='roof'||scope==='roof_wall')
      ? document.getElementById('wf-sd-gutter').value : null;
    const skylight = (scope==='roof'||scope==='roof_wall')
      ? document.getElementById('wf-sd-skylight').checked : false;
    extra.sdScope   = scope;
    extra.sdGutter  = gutter;
    extra.sdSkylight = skylight;
    firstStage = (scope === 'wall') ? 'sd_wall_draft' : 'sd_roof_draft';
  } else {
    // Other types not yet implemented — TL still assigns, job goes to stub stage
    extra.sdScope = null; extra.sdGutter = null; extra.sdSkylight = null;
    firstStage = 'sd_jobcard'; // placeholder until that type's flow is built
  }

  const scopeLabel = extra.sdScope
    ? ({roof:'Roof Only', wall:'Wall Only', roof_wall:'Roof + Wall'}[extra.sdScope] || '')
    : '';

  await wfAdvance(j.id, firstStage, {
    action:'assigned', checklist:_wfCtx.checklist, owner:memberId, drafterId:memberId,
    note:`Assigned to ${member?.name} as ${type}${scopeLabel?' ('+scopeLabel+')':''}`,
    extra,
  });
  await addEvent(j.id,'wf_assigned',
    `🧭 ${me.name} assigned ${type}${scopeLabel?' ('+scopeLabel+')':''} to ${member?.name}`,'yellow');
  pushNotif(memberId,'🧺 New Workflow Job',
    `${j.client} (#${j.jobNum}) — ${type}${scopeLabel?' · '+scopeLabel:''}.`);
  window.wfCloseModal();
  showToastMsg(`✅ Assigned to ${member?.name}.`);
  renderJobBasket();
};

// ── SD · DRAFTER: START JOB ───────────────────────────────────────────────────
window.wfStart = async function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  await updateJob(jobId, {status:'ongoing', started: j.started || Date.now()});
  await addEvent(jobId,'started',`${me.name} started the job`,'blue');
  renderJobBasket();
};

// ── SD · DRAFTER: SUBMIT ROOF PHASE ──────────────────────────────────────────
window.wfSubmitRoofPhase = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  wfAsk('Submit Roof Layout & Sample', _roofDrafterChecklist(j), async(ans)=>{
    await wfAdvance(jobId,'sd_tl_roof_review',{
      action:'roof_submitted', checklist:ans, owner:j.teamLeaderId,
      note:'Roof layout & sample submitted for TL review',
    });
    await addEvent(jobId,'wf_sd_tl_roof_review',
      `📐 ${me.name} submitted roof layout & sample for review`,'purple');
    pushNotif(j.teamLeaderId,'📐 Roof Layout Ready',
      `${j.client} (#${j.jobNum}) — review roof layout & sample.`);
    showToastMsg('✅ Sent to team leader for review.');
    renderJobBasket();
  },(q)=>{ showToastMsg('Complete every preparation step before submitting.'); });
};

// ── SD · TL: REVIEW ROOF PHASE ────────────────────────────────────────────────
window.wfReviewRoof = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  wfAsk('Roof Layout Review', _roofTLChecklist(), (ans)=>{
    _wfCtx = {jobId, checklist:ans};
    wfShowDecision(j,
      'Approve → drafter continues. Reject (comment required) → drafter fixes & resubmits.',
      'wfDecideRoof', true);
  },(q)=>{ showToastMsg('Complete the checklist before reviewing.'); });
};

window.wfDecideRoof = async function(approve){
  const j = jobs.find(x => x.id === _wfCtx.jobId); if(!j) return;
  const note = document.getElementById('wf-reject-note')?.value.trim() || null;
  if(!approve && !note){ alert('A comment is required when rejecting.'); return; }
  const s = j.sdScope || 'roof_wall';
  if(approve){
    // if wall in scope → wall draft; else → client wait (roof only scope)
    const next = (s === 'wall' || s === 'roof_wall') ? 'sd_wall_draft' : 'sd_client_wait';
    const nextOwner = (s === 'roof') ? j.teamLeaderId : j.drafterId;
    await wfAdvance(j.id, next, {
      action:'roof_approved', checklist:_wfCtx.checklist, owner:nextOwner,
      note:'Roof phase approved',
    });
    await addEvent(j.id,'wf_roof_approved',`🟢 ${me.name} approved roof phase`,'green');
    if(s !== 'roof') pushNotif(j.drafterId,'🟢 Roof Approved',
      `${j.client} (#${j.jobNum}) — continue with wall layout.`);
    showToastMsg('✅ Roof phase approved.');
  } else {
    const rejCount = (j.rejectionCount||0) + 1;
    await wfAdvance(j.id,'sd_roof_draft',{
      action:'roof_rejected', checklist:_wfCtx.checklist, owner:j.drafterId,
      note:note, extra:{rejectionCount:rejCount, lastRejectNote:note, lastRejectPhase:'roof'},
    });
    await addEvent(j.id,'wf_roof_rejected',
      `🔴 ${me.name} rejected roof phase (rejection #${rejCount}) — ${note}`,'red');
    pushNotif(j.drafterId,'🔴 Roof Rejected',
      `${j.client} (#${j.jobNum}) — fix & resubmit. Note: ${note}`);
    showToastMsg('Sent back for fixes.');
  }
  window.wfCloseModal();
  renderJobBasket();
};

// ── SD · DRAFTER: SUBMIT WALL PHASE ──────────────────────────────────────────
window.wfSubmitWallPhase = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  wfAsk('Submit Wall Layout & Flashings', _wallDrafterChecklist(), async(ans)=>{
    await wfAdvance(jobId,'sd_tl_wall_review',{
      action:'wall_submitted', checklist:ans, owner:j.teamLeaderId,
      note:'Wall layout & flashing details submitted for TL review',
    });
    await addEvent(jobId,'wf_sd_tl_wall_review',
      `🧱 ${me.name} submitted wall layout & flashing details for review`,'purple');
    pushNotif(j.teamLeaderId,'🧱 Wall Layout Ready',
      `${j.client} (#${j.jobNum}) — review wall layout & flashings.`);
    showToastMsg('✅ Sent to team leader for review.');
    renderJobBasket();
  },(q)=>{ showToastMsg('Complete every preparation step before submitting.'); });
};

// ── SD · TL: REVIEW WALL PHASE ────────────────────────────────────────────────
window.wfReviewWall = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  wfAsk('Wall Layout Review', _wallTLChecklist(), (ans)=>{
    _wfCtx = {jobId, checklist:ans};
    wfShowDecision(j,
      'Approve → proceed to client. Reject (comment required) → drafter fixes & resubmits.',
      'wfDecideWall', true);
  },(q)=>{ showToastMsg('Complete the checklist before reviewing.'); });
};

window.wfDecideWall = async function(approve){
  const j = jobs.find(x => x.id === _wfCtx.jobId); if(!j) return;
  const note = document.getElementById('wf-reject-note')?.value.trim() || null;
  if(!approve && !note){ alert('A comment is required when rejecting.'); return; }
  if(approve){
    await wfAdvance(j.id,'sd_client_wait',{
      action:'wall_approved', checklist:_wfCtx.checklist, owner:j.teamLeaderId,
      note:'Wall phase approved — awaiting client',
    });
    await addEvent(j.id,'wf_wall_approved',
      `🟢 ${me.name} approved wall phase — awaiting client`,'green');
    showToastMsg('✅ Wall phase approved. Awaiting client.');
  } else {
    const rejCount = (j.rejectionCount||0) + 1;
    await wfAdvance(j.id,'sd_wall_draft',{
      action:'wall_rejected', checklist:_wfCtx.checklist, owner:j.drafterId,
      note:note, extra:{rejectionCount:rejCount, lastRejectNote:note, lastRejectPhase:'wall'},
    });
    await addEvent(j.id,'wf_wall_rejected',
      `🔴 ${me.name} rejected wall phase (rejection #${rejCount}) — ${note}`,'red');
    pushNotif(j.drafterId,'🔴 Wall Rejected',
      `${j.client} (#${j.jobNum}) — fix & resubmit. Note: ${note}`);
    showToastMsg('Sent back for fixes.');
  }
  window.wfCloseModal();
  renderJobBasket();
};

// ── SD · TL: RECORD CLIENT DECISION ──────────────────────────────────────────
window.wfRecordClientDecision = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  _wfCtx = {jobId};
  wfModalHtml(`
    <div class="wf-q-title">Client Decision — ${esc(j.client)} <span class="tc-muted">#${esc(j.jobNum)}</span></div>
    <div class="wf-q-text" style="font-size:0.82rem;color:var(--text2);">What was the client's response?</div>
    <label class="wf-f">Client Feedback / Comments
      <textarea id="wf-client-note" rows="2" placeholder="Optional — paste client comments here"></textarea>
    </label>
    <div class="wf-q-actions" style="flex-wrap:wrap;gap:0.5rem;">
      <button class="wf-btn-reject" onclick="wfClientResult('rejected')">✗ Rejected — Fix Required</button>
      <button class="wf-btn-yes" onclick="wfClientResult('accepted')">✓ Accepted</button>
    </div>`);
};

window.wfClientResult = async function(result){
  const j = jobs.find(x => x.id === _wfCtx.jobId); if(!j) return;
  const note = document.getElementById('wf-client-note')?.value.trim() || null;
  if(result === 'accepted'){
    window.wfCloseModal();
    await _wfAssignJobCard(j.id, note ? `Client accepted${note?' — '+note:''}` : null);
  } else {
    await wfAdvance(j.id,'sd_revision_draft',{
      action:'client_rejected', owner:j.drafterId,
      note: note ? `Client rejected — ${note}` : 'Client rejected — fix & resubmit',
      extra:{clientRejectNote:note},
    });
    await addEvent(j.id,'wf_revision',
      `🔴 Client rejected shop drawing${note?' — '+note:''}`,'red');
    pushNotif(j.drafterId,'🔴 Client Rejected SD',
      `${j.client} (#${j.jobNum}) — fix per client feedback.${note?' Note: '+note:''}`);
    showToastMsg('Sent to drafter for revision.');
    window.wfCloseModal();
    renderJobBasket();
  }
};

// ── SD · DRAFTER: SUBMIT REVISION ─────────────────────────────────────────────
window.wfSubmitRevision = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  const qs = _revisionDrafterChecklist(j);
  wfAsk('Submit Revision', qs, async(ans)=>{
    await wfAdvance(jobId,'sd_tl_revision_review',{
      action:'revision_submitted', checklist:ans, owner:j.teamLeaderId,
      note:'Revision submitted for TL review',
    });
    await addEvent(jobId,'wf_revision_review',
      `📝 ${me.name} submitted revision for TL review`,'purple');
    pushNotif(j.teamLeaderId,'📝 Revision Ready',
      `${j.client} (#${j.jobNum}) — review revised shop drawing.`);
    showToastMsg('✅ Revision sent to team leader.');
    renderJobBasket();
  },(q)=>{ showToastMsg('Complete every check before submitting the revision.'); });
};

// ── SD · TL: REVIEW REVISION ──────────────────────────────────────────────────
window.wfReviewRevision = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  wfAsk('Revision Review', _revisionTLChecklist(j), (ans)=>{
    _wfCtx = {jobId, checklist:ans};
    wfShowDecision(j,
      'Approve → proceed to job card. Reject (comment required) → back to drafter.',
      'wfDecideRevision', true);
  },(q)=>{ showToastMsg('Complete the checklist before reviewing.'); });
};

window.wfDecideRevision = async function(approve){
  const j = jobs.find(x => x.id === _wfCtx.jobId); if(!j) return;
  const note = document.getElementById('wf-reject-note')?.value.trim() || null;
  if(!approve && !note){ alert('A comment is required when rejecting.'); return; }
  if(approve){
    window.wfCloseModal();
    await _wfAssignJobCard(j.id, 'Revision approved — proceeding to job card');
  } else {
    const rejCount = (j.rejectionCount||0) + 1;
    await wfAdvance(j.id,'sd_revision_draft',{
      action:'revision_rejected', checklist:_wfCtx.checklist, owner:j.drafterId,
      note:note, extra:{rejectionCount:rejCount, lastRejectNote:note, lastRejectPhase:'revision'},
    });
    await addEvent(j.id,'wf_revision_rejected',
      `🔴 ${me.name} rejected revision (rejection #${rejCount}) — ${note}`,'red');
    pushNotif(j.drafterId,'🔴 Revision Rejected',
      `${j.client} (#${j.jobNum}) — fix & resubmit. ${note}`);
    showToastMsg('Sent back for fixes.');
    window.wfCloseModal();
    renderJobBasket();
  }
};

// ── JOB CARD ASSIGNMENT (shared helper, with overload check) ──────────────────
async function _wfAssignJobCard(jobId, note){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  const drafter = users.find(u => u.id === j.drafterId);
  const load = memberLoad(j.drafterId||'');
  if(load >= 3){
    const dls = jobs.filter(x=>x.owner===j.drafterId&&x.status!=='completed'&&x.deadline)
      .map(x=>fmt(x.deadline)).slice(0,3);
    _wfCtx = {jobId, pendingNote:note};
    wfModalHtml(`
      <div class="wf-q-title">Heads Up</div>
      <div class="wf-q-text" style="font-size:0.86rem;">
        <strong>${esc(drafter?.name||'They')}</strong> currently has
        <strong>${load}</strong> active task${load>1?'s':''}
        ${dls.length?`with upcoming deadlines: ${dls.join(', ')}`:''}.
      </div>
      <div class="wf-q-actions">
        <button class="wf-btn-no" onclick="wfDoReassignJobCard()">↻ Reassign to freest</button>
        <button class="wf-btn-yes" onclick="wfProceedJobCard('${j.drafterId}')">
          Proceed with ${esc((drafter?.name||'').split(' ')[0])}
        </button>
      </div>`);
  } else {
    await _wfProceedAssignCard(jobId, j.drafterId, note);
  }
}

window.wfDoReassignJobCard = function(){
  const j = jobs.find(x => x.id === _wfCtx.jobId); if(!j) return;
  const next = freestMember(j.teamLeaderId, j.drafterId);
  if(!next){ showToastMsg('No other team member available.'); return; }
  window.wfCloseModal();
  _wfProceedAssignCard(j.id, next.id, _wfCtx.pendingNote);
};
window.wfProceedJobCard = function(drafterId){
  const j = jobs.find(x => x.id === _wfCtx.jobId); if(!j) return;
  window.wfCloseModal();
  _wfProceedAssignCard(j.id, drafterId, _wfCtx.pendingNote);
};

async function _wfProceedAssignCard(jobId, drafterId, note){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  const who = users.find(u => u.id === drafterId);
  await wfAdvance(jobId,'sd_jobcard',{
    action:'jobcard_assigned', owner:drafterId, drafterId,
    note:`Job card assigned to ${who?.name}${note?' — '+note:''}`,
    extra:{status:'ongoing'},
  });
  await addEvent(jobId,'wf_jobcard',`🗂 ${me.name} assigned job card prep to ${who?.name}`,'yellow');
  pushNotif(drafterId,'🗂 Job Card Preparation',
    `${j.client} (#${j.jobNum}) — shop drawing approved, prepare job cards.`);
  showToastMsg(`✅ Job card assigned to ${who?.name}.`);
  renderJobBasket();
}

// ── SD · DRAFTER: SUBMIT JOB CARDS ───────────────────────────────────────────
window.wfSubmitJobCard = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  wfAsk('Submit Job Cards — Self Check', QC5, async(ans)=>{
    await wfAdvance(jobId,'sd_tl_jobcard_review',{
      action:'jobcard_submitted', checklist:ans, owner:j.teamLeaderId,
      note:'Job cards self-checked & submitted for review',
    });
    await addEvent(jobId,'wf_tl_jobcard_review',
      `🗂 ${me.name} self-checked & submitted job cards`,'purple');
    pushNotif(j.teamLeaderId,'🗂 Job Cards Ready',
      `${j.client} (#${j.jobNum}) — final review to close.`);
    showToastMsg('✅ Job cards sent to team leader.');
    renderJobBasket();
  },(q)=>{ showToastMsg('Complete every check before submitting job cards.'); });
};

// ── SD · TL: CLOSE JOB ────────────────────────────────────────────────────────
window.wfCloseJobCard = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  wfAsk('Close Job — Final QC', QC5, async(ans)=>{
    await wfAdvance(jobId,'completed',{
      action:'completed', checklist:ans,
      note:'Job cards approved — job completed',
      statusComplete:true, extra:{releaseEligible:true},
    });
    await addEvent(jobId,'completed',`✅ ${me.name} passed final QC — job completed`,'green');
    if(j.drafterId)   pushNotif(j.drafterId,'✅ Job Completed',
      `${j.client} (#${j.jobNum}) — closed by ${me.name}.`);
    if(j.wfCreatedBy) pushNotif(j.wfCreatedBy,'✅ Job Completed',
      `${j.client} (#${j.jobNum}) — your basket job is done.`);
    showToastMsg('🎉 Job completed.');
    renderJobBasket();
    // prompt for sample expectation after a short delay so card re-renders first
    setTimeout(()=>_wfAskSampleExpectation(jobId), 400);
  },(q)=>{ showToastMsg('All QC checks must pass before closing.'); });
};

function _wfAskSampleExpectation(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  wfModalHtml(`
    <div class="wf-q-title">Sample Approval</div>
    <div class="wf-q-text">
      Are you expecting sample approval from the client for
      <strong>${esc(j.client)}</strong> (#${esc(j.jobNum)})?
    </div>
    <div class="wf-q-actions">
      <button class="wf-btn-no"  onclick="wfSetSampleExpectation('${jobId}',false)">No samples for this job</button>
      <button class="wf-btn-yes" onclick="wfSetSampleExpectation('${jobId}',true)">Yes — awaiting client sample approval</button>
    </div>`);
}
window.wfSetSampleExpectation = async function(jobId, expecting){
  await updateJob(jobId, {awaitingSampleApproval: expecting});
  window.wfCloseModal();
  showToastMsg(expecting ? '📋 Job marked: awaiting sample approval.' : '✅ Job fully closed.');
  renderJobBasket();
};

// ── REOPEN FOR CONTINUATION ───────────────────────────────────────────────────
const REOPEN_TYPES = JOB_TYPES.filter(t => t !== 'Shop Drawing');

window.wfReopenJob = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  const drafter = users.find(u => u.id === j.drafterId);
  const load = drafter ? memberLoad(drafter.id) : 0;
  const others = teamMembers(j.teamLeaderId).filter(m => m.id !== j.drafterId);
  _wfCtx = {jobId};
  wfModalHtml(`
    <div class="wf-q-title">Reopen — ${esc(j.client)} <span class="tc-muted">#${esc(j.jobNum)}</span></div>
    <div class="wf-q-text" style="font-size:0.82rem;color:var(--text2);">
      Select continuation type and assign to a team member.
    </div>
    <label class="wf-f">Continuation Type
      <select id="wf-reopen-type">
        ${REOPEN_TYPES.map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join('')}
      </select>
    </label>
    <label class="wf-f">Assign to
      <select id="wf-rel-member">
        ${drafter?`<option value="${j.drafterId}">${esc(drafter.name)} · ${load} active (did shop drawing)</option>`:''}
        ${others.map(m=>`<option value="${m.id}">${esc(m.name)} · ${memberLoad(m.id)} active</option>`).join('')}
      </select>
    </label>
    <div class="wf-q-actions">
      <button class="wf-btn-no"  onclick="wfCloseModal()">Cancel</button>
      <button class="wf-btn-yes" onclick="wfConfirmReopen()">Assign</button>
    </div>`);
};

window.wfConfirmReopen = async function(){
  const j = jobs.find(x => x.id === _wfCtx.jobId); if(!j) return;
  const memberId   = document.getElementById('wf-rel-member').value;
  const reopenType = document.getElementById('wf-reopen-type').value;
  const who = users.find(u => u.id === memberId);
  await wfAdvance(j.id,'release',{
    action:'reopened', owner:memberId, drafterId:memberId,
    note:`Reopened for ${reopenType} — assigned to ${who?.name}`,
    extra:{status:'ongoing', completed:null, reopenType},
  });
  await addEvent(j.id,'wf_release',`♻️ ${me.name} reopened for ${reopenType} → ${who?.name}`,'blue');
  pushNotif(memberId,`♻️ ${reopenType}`,`${j.client} (#${j.jobNum}) — assigned for ${reopenType}.`);
  window.wfCloseModal();
  showToastMsg(`✅ Reopened for ${reopenType}, assigned to ${who?.name}.`);
  renderJobBasket();
};

window.wfSubmitRelease = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  wfAsk('Submit — Final QC', QC5, async(ans)=>{
    await wfAdvance(jobId,'completed',{
      action:'release_completed', checklist:ans, owner:j.teamLeaderId,
      note:`${j.reopenType||'Release'} completed`, statusComplete:true,
    });
    await addEvent(jobId,'completed',
      `✅ ${me.name} completed ${j.reopenType||'release'}`,'green');
    pushNotif(j.teamLeaderId,'✅ Done',
      `${j.client} (#${j.jobNum}) — ${j.reopenType||'release'} completed by ${me.name}.`);
    showToastMsg('🎉 Completed.');
    renderJobBasket();
  },(q)=>{ showToastMsg('All QC checks must pass before submitting.'); });
};

// ── ACTION RESOLVER ───────────────────────────────────────────────────────────
function wfActionFor(j){
  const amTL      = me.id === j.teamLeaderId;
  const amDrafter = me.id === j.drafterId;

  if(j.stage === 'intake' && amTL)
    return {label:'📥 Take & Assign', fn:`wfTakeJob('${j.id}')`, cls:'primary'};

  // roof phase
  if(j.stage === 'sd_roof_draft' && amDrafter){
    if(j.status === 'pending') return {label:'▶ Start Job', fn:`wfStart('${j.id}')`, cls:'primary'};
    return {label:'📐 Submit Roof Layout & Sample', fn:`wfSubmitRoofPhase('${j.id}')`, cls:'primary'};
  }
  if(j.stage === 'sd_tl_roof_review' && amTL)
    return {label:'🔍 Review Roof Phase', fn:`wfReviewRoof('${j.id}')`, cls:'primary'};

  // wall phase
  if(j.stage === 'sd_wall_draft' && amDrafter){
    if(j.status === 'pending') return {label:'▶ Start Job', fn:`wfStart('${j.id}')`, cls:'primary'};
    return {label:'🧱 Submit Wall Layout & Flashings', fn:`wfSubmitWallPhase('${j.id}')`, cls:'primary'};
  }
  if(j.stage === 'sd_tl_wall_review' && amTL)
    return {label:'🔍 Review Wall Phase', fn:`wfReviewWall('${j.id}')`, cls:'primary'};

  // client wait
  if(j.stage === 'sd_client_wait' && amTL)
    return {label:'📋 Record Client Decision', fn:`wfRecordClientDecision('${j.id}')`, cls:'primary'};

  // revision
  if(j.stage === 'sd_revision_draft' && amDrafter)
    return {label:'📝 Submit Revision', fn:`wfSubmitRevision('${j.id}')`, cls:'primary'};
  if(j.stage === 'sd_tl_revision_review' && amTL)
    return {label:'🔍 Review Revision', fn:`wfReviewRevision('${j.id}')`, cls:'primary'};

  // job card
  if(j.stage === 'sd_jobcard' && amDrafter)
    return {label:'🗂 Submit Job Cards', fn:`wfSubmitJobCard('${j.id}')`, cls:'primary'};
  if(j.stage === 'sd_tl_jobcard_review' && amTL)
    return {label:'🏁 Review & Close', fn:`wfCloseJobCard('${j.id}')`, cls:'primary'};

  // completed
  if(j.stage === 'completed' && amTL && j.releaseEligible)
    return {label:'♻️ Reopen for Continuation', fn:`wfReopenJob('${j.id}')`, cls:'sec'};

  // release
  if(j.stage === 'release' && amDrafter)
    return {label:'📦 Submit Release', fn:`wfSubmitRelease('${j.id}')`, cls:'primary'};

  return null;
}

// ── TIMELINE HELPERS ──────────────────────────────────────────────────────────
function _evtColor(e){
  const a = e.action || '';
  if(a.includes('reject')) return 'red';
  if(a.includes('approv') || a === 'completed' || a === 'release_completed') return 'green';
  if(e.to === 'sd_client_wait' || a.includes('client')) return 'orange';
  if(a === 'assigned' || a === 'reopened') return 'blue';
  return wfStageMeta(e.to).color;
}
function _evtIcon(e){
  const a = e.action || '';
  if(a.includes('reject')) return '🔴';
  if(a.includes('approv')) return '🟢';
  if(a === 'completed' || a === 'release_completed') return '✅';
  if(a.includes('submit')) return '📤';
  if(a === 'assigned' || a === 'reopened') return '🧭';
  if(e.to === 'sd_client_wait') return '📨';
  if(a === 'submitted') return '📥';
  return '📌';
}
function _checksHtml(checklist){
  if(!checklist) return '';
  return `<div class="wf-tl-checks">${
    Object.entries(checklist).map(([k,v])=>
      `<span class="wf-chk ${v?'ok':'no'}">${v?'✓':'✗'} ${esc(k)}</span>`
    ).join('')
  }</div>`;
}

function _wfTlList(j){
  const h = Array.isArray(j.wfHistory) ? j.wfHistory : [];
  if(!h.length) return '<div class="tc-muted" style="font-size:0.78rem;">No history yet.</div>';
  let prev = null;
  return `<div class="wf-timeline">${h.map(e=>{
    const col = _evtColor(e);
    const dur = prev ? ` <span class="wf-tl-dur">(+${tdiff(prev.at,e.at)})</span>` : '';
    prev = e;
    const noteHtml = e.note ? `<div class="wf-tl-note">${esc(e.note)}</div>` : '';
    return `<div class="wf-tl-row">
      <span class="wf-tl-dot wf-dot-${col}"></span>
      <div class="wf-tl-body">
        <div class="wf-tl-head"><strong>${_evtIcon(e)} ${esc(wfStageMeta(e.to).label)}</strong>${dur}</div>
        <div class="wf-tl-meta">${esc(e.by)} · ${fmt(e.at)}</div>
        ${noteHtml}${_checksHtml(e.checklist)}
      </div>
    </div>`;
  }).join('')}</div>`;
}

function _wfTlVisual(j){
  const h = Array.isArray(j.wfHistory) ? j.wfHistory : [];
  if(!h.length) return '<div class="tc-muted" style="font-size:0.78rem;">No history yet.</div>';
  const events = h.map((e,i)=>{
    const col   = _evtColor(e);
    const icon  = _evtIcon(e);
    const dur   = i > 0 ? `+${tdiff(h[i-1].at,e.at)}` : 'Start';
    const above = i % 2 === 0;
    const shortLabel = `<div class="wf-htl-label">${icon} ${esc(wfStageMeta(e.to).short)}</div>`+
      `<div class="wf-htl-sublabel">${esc(dur)}</div>`;
    const tipKey = `${j.id}_${i}`;
    _htlTipData[tipKey] =
      `<div class="wf-htl-tt-stage">${icon} ${esc(wfStageMeta(e.to).label)}</div>`+
      `<div class="wf-htl-tt-meta">${esc(e.by)} · ${fmt(e.at)}</div>`+
      `<div class="wf-htl-tt-dur">${esc(dur)}</div>`+
      (e.note?`<div class="wf-htl-tt-note">${esc(e.note)}</div>`:'')+
      _checksHtml(e.checklist);
    return `<div class="wf-htl-event" onmouseenter="wfHtlShow(this,'${tipKey}')" onmouseleave="wfHtlHide()">
      <div class="wf-htl-above">${above?shortLabel:''}</div>
      <div class="wf-htl-stem ${above?'wf-htl-stem-down':'wf-htl-stem-up'}"></div>
      <div class="wf-htl-dot wf-htl-dot-${col}">${i+1}</div>
      <div class="wf-htl-stem ${above?'wf-htl-stem-up':'wf-htl-stem-down'}"></div>
      <div class="wf-htl-below">${above?'':shortLabel}</div>
    </div>`;
  }).join('');
  return `<div class="wf-htl"><div class="wf-htl-track">
    <div class="wf-htl-line"></div>
    <div class="wf-htl-events">${events}</div>
  </div></div>`;
}

export function wfTimeline(j){ return _wfTlList(j); }

window.wfToggleTimeline = function(id){
  const el  = document.getElementById('wf-tl-'+id);
  const gel = document.getElementById('wf-jg-'+id);
  const fel = document.getElementById('wf-fc-'+id);
  if(!el) return;
  if(gel) gel.style.display = 'none';
  if(fel) fel.style.display = 'none';
  const hidden = el.style.display === 'none' || !el.style.display;
  el.style.display = hidden ? 'block' : 'none';
  if(hidden){ const j = jobs.find(x=>x.id===id); if(j) el.innerHTML = _wfTlVisual(j); }
};

// ── PER-JOB GANTT ─────────────────────────────────────────────────────────────
const _WF_STAGE_COLORS = {
  intake:'#5ac8fa',
  sd_roof_draft:'#0a84ff',      sd_tl_roof_review:'#ffd60a',
  sd_wall_draft:'#30d158',      sd_tl_wall_review:'#ff9f0a',
  sd_client_wait:'#bf5af2',
  sd_revision_draft:'#ff453a',  sd_tl_revision_review:'#ff6961',
  sd_jobcard:'#64d2ff',         sd_tl_jobcard_review:'#ff9f0a',
  completed:'#32d74b',          release:'#30d158',
};

function _wfJobGantt(j){
  const h = Array.isArray(j.wfHistory) ? j.wfHistory : [];
  if(!h.length) return '<div class="tc-muted" style="font-size:0.78rem;padding:0.5rem;">No history yet.</div>';
  const now = Date.now();
  const jStart = toMillis(j.created) || now;
  const jEnd   = j.completed ? toMillis(j.completed) : now;
  const totalMs = Math.max(jEnd - jStart, 1);
  const pct = ts => Math.max(0, Math.min(100, (toMillis(ts) - jStart) / totalMs * 100));

  const spans = h.map((e,i)=>{
    const sStart = i === 0 ? jStart : toMillis(h[i-1].at) || jStart;
    const sEnd   = i === h.length-1 ? jEnd : toMillis(h[i].at) || jEnd;
    const dur = sEnd - sStart;
    const l = pct(sStart);
    const w = Math.max(Math.min((sEnd-sStart)/totalMs*100, 100-l), 0.8);
    const col = _WF_STAGE_COLORS[e.to] || '#8e8e93';
    return {e, l, w, dur, col, sStart, sEnd};
  });

  const weeks = [];
  let d = new Date(jStart); d.setDate(d.getDate()-d.getDay()); d.setHours(0,0,0,0);
  while(d.getTime() < jEnd + 7*864e5){
    weeks.push(new Date(d)); d = new Date(d); d.setDate(d.getDate()+7);
  }
  const weekTicks = weeks.map(w=>{
    const l = (w.getTime()-jStart)/totalMs*100;
    if(l < 0 || l > 105) return '';
    return `<div class="wfjg-tick" style="left:${l.toFixed(1)}%"><span>${
      w.toLocaleString('en-GB',{day:'numeric',month:'short'})
    }</span></div>`;
  }).join('');

  const rows = spans.map((s,i)=>{
    const tipKey = `jg_${j.id}_${i}`;
    const startStr = s.sStart ? new Date(s.sStart).toLocaleString('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
    const endStr   = s.sEnd   ? new Date(s.sEnd).toLocaleString('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
    _htlTipData[tipKey] =
      `<div class="wf-htl-tt-stage" style="color:${s.col}">${esc(wfStageMeta(s.e.to).label)}</div>`+
      `<div class="wf-htl-tt-meta">${startStr} → ${endStr}</div>`+
      `<div class="wf-htl-tt-dur">Duration: ${tdiff(0,s.dur)}</div>`;
    return `<div class="wfjg-row">
      <div class="wfjg-lbl">${esc(wfStageMeta(s.e.to).short)}</div>
      <div class="wfjg-track">
        <div class="wfjg-bar" style="left:${s.l.toFixed(2)}%;width:${s.w.toFixed(2)}%;background:${s.col};"
          onmouseenter="wfHtlShow(this,'${tipKey}')" onmouseleave="wfHtlHide()">
          <span class="wfjg-bar-lbl">${tdiff(0,s.dur)}</span>
        </div>
      </div>
    </div>`;
  }).join('');

  const todayPct = ((now-jStart)/totalMs*100).toFixed(2);
  return `<div class="wfjg">
    <div class="wfjg-axis">${weekTicks}
      <div class="wfjg-today-line" style="left:${todayPct}%" title="Today"></div>
    </div>
    ${rows}
  </div>`;
}

function _wfJobFlow(j){
  const h = Array.isArray(j.wfHistory) ? j.wfHistory : [];
  if(!h.length) return '<div class="tc-muted" style="font-size:0.78rem;padding:0.5rem;">No history yet.</div>';
  const REJECT_ACTIONS  = new Set(['roof_rejected','wall_rejected','revision_rejected','client_rejected','jobcard_rejected']);
  const APPROVE_ACTIONS = new Set(['roof_approved','wall_approved','revision_submitted','completed','release_completed','client_accepted']);
  function _arrowClass(a){
    return REJECT_ACTIONS.has(a)?'wfjg-arrow-reject':APPROVE_ACTIONS.has(a)?'wfjg-arrow-approve':'wfjg-arrow-neutral';
  }
  function _arrowLabel(a){
    if(REJECT_ACTIONS.has(a))  return '✗';
    if(APPROVE_ACTIONS.has(a)) return '✓';
    if(/submit/i.test(a)) return '↑';
    if(a === 'assigned' || a === 'reopened') return '→';
    return '→';
  }
  const now = Date.now();
  const jStart  = toMillis(j.created) || now;
  const jEnd    = j.completed ? toMillis(j.completed) : now;
  const totalMs = Math.max(jEnd - jStart, 1);
  const nodes = h.map((e,i)=>{
    const col    = _WF_STAGE_COLORS[e.to] || '#8e8e93';
    const sStart = i === 0 ? jStart : toMillis(h[i-1].at) || jStart;
    const sEnd   = i === h.length-1 ? jEnd : toMillis(h[i].at) || jEnd;
    const dur    = tdiff(0, sEnd - sStart);
    const arrow  = i > 0 ? `<div class="wfjg-fc-arrow ${_arrowClass(h[i-1].action)}">
      <div class="wfjg-fc-arrow-line-h"></div>
      <div class="wfjg-fc-arrow-lbl-h">${_arrowLabel(h[i-1].action)}</div>
      <div class="wfjg-fc-arrow-head-h">▶</div>
    </div>` : '';
    const dateStr = new Date(toMillis(e.at)).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
    return `${arrow}<div class="wfjg-fc-node-h" style="border-color:${col};">
      <div class="wfjg-fc-node-stage-h" style="background:${col}22;color:${col};">${esc(wfStageMeta(e.to).label)}</div>
      <div class="wfjg-fc-node-actor-h">👤 ${esc(e.by)}</div>
      <div class="wfjg-fc-node-date-h">🕐 ${dateStr}</div>
      <div class="wfjg-fc-node-dur-h" style="color:${col};">⏱ ${dur}</div>
      ${e.note?`<div class="wfjg-fc-node-note-h">${esc(e.note)}</div>`:''}
    </div>`;
  }).join('');
  return `<div class="wfjg-fc-h">${nodes}</div>`;
}

window.wfToggleJobGantt = function(id){
  const tl  = document.getElementById('wf-tl-'+id);
  const gel = document.getElementById('wf-jg-'+id);
  const fel = document.getElementById('wf-fc-'+id);
  if(!gel) return;
  if(tl)  tl.style.display  = 'none';
  if(fel) fel.style.display = 'none';
  const hidden = gel.style.display === 'none' || !gel.style.display;
  gel.style.display = hidden ? 'block' : 'none';
  if(hidden){ const j = jobs.find(x=>x.id===id); if(j) gel.innerHTML = _wfJobGantt(j); }
};
window.wfToggleJobFlow = function(id){
  const tl  = document.getElementById('wf-tl-'+id);
  const gel = document.getElementById('wf-jg-'+id);
  const fel = document.getElementById('wf-fc-'+id);
  if(!fel) return;
  if(tl)  tl.style.display  = 'none';
  if(gel) gel.style.display = 'none';
  const hidden = fel.style.display === 'none' || !fel.style.display;
  fel.style.display = hidden ? 'block' : 'none';
  if(hidden){ const j = jobs.find(x=>x.id===id); if(j) fel.innerHTML = _wfJobFlow(j); }
};

// ── OVERVIEW GANTT (all jobs) ─────────────────────────────────────────────────
function _wfGantt(pool){
  if(!pool.length) return '<div class="empty" style="padding:2rem;">No jobs to display in Gantt.</div>';
  const now = Date.now();
  const allTs = pool.flatMap(j=>[
    toMillis(j.created)||now,
    ...(j.wfHistory||[]).map(e=>toMillis(e.at)||now),
    j.completed?toMillis(j.completed):now,
  ]);
  const rawMin = Math.min(...allTs), rawMax = Math.max(...allTs, now);
  const sd = new Date(rawMin); sd.setDate(sd.getDate()-sd.getDay()); sd.setHours(0,0,0,0);
  const ed = new Date(rawMax); ed.setDate(ed.getDate()+(7-ed.getDay())%7||7); ed.setHours(23,59,59,999);
  const totalMs = ed - sd;
  const pct = ts => { const t = toMillis(ts)||now; return Math.max(0,Math.min(100,(t-sd)/totalMs*100)); };
  const weeks = []; let dw = new Date(sd);
  while(dw < ed){ weeks.push(new Date(dw)); dw = new Date(dw); dw.setDate(dw.getDate()+7); }
  const months = []; let prev = '';
  weeks.forEach(w=>{
    const lbl = w.toLocaleString('en-GB',{month:'short',year:'2-digit'});
    if(lbl !== prev){ months.push({lbl,count:0}); prev = lbl; }
    months[months.length-1].count++;
  });
  const todayPct = pct(now);
  const rows = pool.map(j=>{
    const h      = Array.isArray(j.wfHistory) ? j.wfHistory : [];
    const jStart = toMillis(j.created) || sd.getTime();
    const jEnd   = j.completed ? toMillis(j.completed) : now;
    let segs = '';
    if(h.length >= 2){
      h.forEach((e,i)=>{
        const sStart = i===0 ? jStart : toMillis(h[i-1].at)||jStart;
        const sEnd   = i===h.length-1 ? jEnd : toMillis(h[i].at)||jEnd;
        if(sEnd <= sStart) return;
        const l  = pct(sStart); const w2 = Math.max(pct(sEnd)-l, 0.3);
        segs += `<div class="wf-gantt-seg" style="left:${l.toFixed(2)}%;width:${w2.toFixed(2)}%;background:${_WF_STAGE_COLORS[e.to]||'#8e8e93'};" title="${esc(wfStageMeta(e.to).label)}"></div>`;
      });
    } else {
      const l = pct(jStart); const w2 = Math.max(pct(jEnd)-l, 0.5);
      segs = `<div class="wf-gantt-seg" style="left:${l.toFixed(2)}%;width:${w2.toFixed(2)}%;background:${_WF_STAGE_COLORS[j.stage]||'#8e8e93'};"></div>`;
    }
    const meta   = wfStageMeta(j.stage);
    const drafter = users.find(u => u.id === j.drafterId);
    const tl      = users.find(u => u.id === j.teamLeaderId);
    const person  = drafter || tl;
    return `<div class="wf-gantt-row">
      <div class="wf-gantt-lbl">
        ${person?`<div class="wf-gantt-person">${esc(person.name)}</div>`:''}
        <div class="wf-gantt-jobname">${esc(j.client)}</div>
        <div class="wf-gantt-jobsub"><span class="tc-muted">#${esc(j.jobNum)}</span> <span style="color:${_WF_STAGE_COLORS[j.stage]||'var(--text3)'};">· ${esc(meta.short)}</span></div>
      </div>
      <div class="wf-gantt-track">
        <div class="wf-gantt-grid">${weeks.map(()=>`<div class="wf-gantt-cell"></div>`).join('')}</div>
        <div class="wf-gantt-bars">${segs}</div>
        <div class="wf-gantt-today" style="left:${todayPct.toFixed(2)}%"></div>
      </div>
    </div>`;
  });
  const monthHdr = months.map(m=>`<div class="wf-gantt-mth" style="flex:${m.count}">${m.lbl}</div>`).join('');
  const weekHdr  = weeks.map((_,i)=>`<div class="wf-gantt-wk">W${(i%4)+1}</div>`).join('');
  return `<div class="wf-gantt">
    <div class="wf-gantt-hdr">
      <div class="wf-gantt-lbl-hd">Job</div>
      <div class="wf-gantt-tl-hd">
        <div class="wf-gantt-months">${monthHdr}</div>
        <div class="wf-gantt-wks">${weekHdr}</div>
      </div>
    </div>
    <div class="wf-gantt-body">${rows.join('')}</div>
    <div class="wf-gantt-legend">${
      Object.entries(_WF_STAGE_COLORS).map(([s,c])=>
        `<div class="wf-gantt-leg-item"><span class="wf-gantt-leg-dot" style="background:${c}"></span>${esc(wfStageMeta(s).short)}</div>`
      ).join('')
    }</div>
  </div>`;
}

// ── JOB CARD RENDER ───────────────────────────────────────────────────────────
function wfCard(j, showAction){
  const meta    = wfStageMeta(j.stage);
  const tl      = users.find(u => u.id === j.teamLeaderId);
  const drafter = users.find(u => u.id === j.drafterId);
  const act     = showAction ? wfActionFor(j) : null;

  // scope + extras badge
  const scopeMap = {roof:'Roof Only', wall:'Wall Only', roof_wall:'Roof + Wall'};
  const scopeBdg = j.sdScope
    ? `<span class="wf-scope-bdg">${esc(scopeMap[j.sdScope]||j.sdScope)}</span>` : '';
  const gutterBdg = j.sdGutter && j.sdGutter !== 'none'
    ? `<span class="wf-scope-bdg" style="opacity:0.7;">${esc(j.sdGutter==='eave_gutter'?'Eave Gutter':'Curve')}</span>` : '';
  const skylightBdg = j.sdSkylight
    ? `<span class="wf-scope-bdg" style="opacity:0.7;">🌤 Skylight</span>` : '';

  // rejection warning
  const rejBanner = j.rejectionCount
    ? `<span class="wf-rej">⚠ ${j.rejectionCount} rejection${j.rejectionCount>1?'s':''}</span>` : '';
  const lastRejectBanner = j.lastRejectNote && (j.stage==='sd_roof_draft'||j.stage==='sd_wall_draft'||j.stage==='sd_revision_draft')
    ? `<div class="wf-rej" style="display:block;margin-top:0.25rem;">🔴 ${esc(j.lastRejectNote)}</div>` : '';

  // overdue
  const od = j.deadline && j.status !== 'completed' && isOverdue(j)
    ? '<span class="wf-od">⚠ overdue</span>' : '';

  // awaiting sample approval
  const sampleBadge = j.stage === 'completed' && j.awaitingSampleApproval
    ? '<span class="wf-scope-bdg" style="background:rgba(255,159,10,0.15);color:#ff9f0a;border-color:rgba(255,159,10,0.3);">📋 Awaiting Sample Approval</span>' : '';

  // remarks
  const remarksBadge = j.remarks
    ? `<div style="font-size:0.74rem;color:var(--text3);margin-top:0.25rem;">💬 ${esc(j.remarks)}</div>` : '';

  return `<div class="wf-card">
    <div class="wf-card-top">
      <div class="wf-card-id">
        <strong>${esc(j.client)}</strong> <span class="tc-muted">#${esc(j.jobNum)}</span>
        ${j.projectName?` <span class="wf-proj">📁 ${esc(j.projectName)}</span>`:''}
      </div>
      <span class="wf-stage-bdg wf-bdg-${meta.color}">${esc(meta.label)}</span>
    </div>
    ${wfPipeline(j)}
    <div class="wf-card-meta" style="flex-wrap:wrap;gap:0.3rem 0.6rem;">
      ${j.type?`<span>🏷 ${esc(j.type)}</span>`:''}
      ${scopeBdg}${gutterBdg}${skylightBdg}${sampleBadge}
      ${tl     ? `<span>🧭 ${esc(tl.name)}</span>`      : ''}
      ${drafter? `<span>👤 ${esc(drafter.name)}</span>` : ''}
      ${j.deadline?`<span>📅 ${fmt(j.deadline)}</span>`:''}
      ${od}${rejBanner}
    </div>
    ${remarksBadge}${lastRejectBanner}
    <div class="wf-card-actions">
      ${act?`<button class="wf-act ${act.cls}" onclick="${act.fn}">${act.label}</button>`:''}
      <button class="wf-act sec" onclick="wfToggleTimeline('${j.id}')">🕐 Timeline</button>
      <button class="wf-act sec" onclick="wfToggleJobGantt('${j.id}')">📊 Gantt</button>
      <button class="wf-act sec" onclick="wfToggleJobFlow('${j.id}')">🔀 Flow</button>
    </div>
    <div class="wf-tl-wrap" id="wf-tl-${j.id}" style="display:none;">${wfTimeline(j)}</div>
    <div class="wf-jg-wrap" id="wf-jg-${j.id}" style="display:none;"></div>
    <div class="wf-jg-wrap" id="wf-fc-${j.id}" style="display:none;"></div>
  </div>`;
}

// ── ANALYTICS ─────────────────────────────────────────────────────────────────
export function wfAnalyticsSection(){
  if(!me) return '';
  let pool = jobs.filter(j => j.workflow);
  if(me.role === 'team_leader') pool = pool.filter(j => j.teamLeaderId === me.id);
  else if(!['manager','supervisor'].includes(me.role) && !amDirector()) return '';
  if(!pool.length) return '';

  const done   = pool.filter(j => j.stage === 'completed' && Array.isArray(j.wfHistory));
  const active = pool.filter(j => j.stage !== 'completed');

  const cycles = done.map(j=>{
    const h = j.wfHistory;
    return h.length > 1 ? h[h.length-1].at - h[0].at : 0;
  }).filter(x => x > 0);
  const avgCycle = cycles.length ? cycles.reduce((a,b)=>a+b,0)/cycles.length : 0;

  const trans = {};
  done.forEach(j=>{
    const h = j.wfHistory;
    for(let i=1; i<h.length; i++){
      const k = wfStageMeta(h[i].to).short;
      const d = h[i].at - h[i-1].at;
      if(d > 0)(trans[k] = trans[k]||[]).push(d);
    }
  });
  const rows   = Object.entries(trans).map(([k,a])=>({k, avg:a.reduce((x,y)=>x+y,0)/a.length})).sort((a,b)=>b.avg-a.avg);
  const max    = rows.length ? Math.max(...rows.map(r=>r.avg)) : 1;
  const rejects = pool.reduce((a,j)=>a+(Array.isArray(j.wfHistory)
    ? j.wfHistory.filter(e=>e.action&&e.action.includes('rejected')).length : 0), 0);

  const byDrafter = {};
  done.forEach(j=>{
    if(j.drafterId){
      const u = users.find(x=>x.id===j.drafterId);
      const nm = u?.name||'?';
      byDrafter[nm] = (byDrafter[nm]||0) + 1;
    }
  });
  const draftRows = Object.entries(byDrafter).map(([k,v])=>({k,v})).sort((a,b)=>b.v-a.v);
  const maxD = draftRows.length ? Math.max(...draftRows.map(r=>r.v)) : 1;
  const kpi  = (l,v,c) => `<div class="an-kpi"><div class="an-kpi-label">${l}</div><div class="an-kpi-value" style="color:${c}">${v}</div></div>`;

  return `<div class="an-section-title">🧺 Job Basket Workflow</div>
    <div class="an-kpis">
      ${kpi('Active',   active.length,   'var(--blue)')}
      ${kpi('Completed',done.length,     'var(--green)')}
      ${kpi('Avg Cycle',avgCycle?tdiff(0,avgCycle):'—','var(--text)')}
      ${kpi('Rejections',rejects,        rejects?'var(--red)':'var(--text3)')}
    </div>
    <div class="an-row-2">
      <div class="an-widget">
        <div class="an-widget-hd">Stage Durations <span class="an-hd-note">avg · slowest = bottleneck</span></div>
        ${rows.length ? rows.map(r=>`
          <div class="an-bar-row">
            <span class="an-bar-label">${esc(r.k)}</span>
            <div class="an-bar-track"><div class="an-bar-fill" style="width:${Math.max(Math.round(r.avg/max*100),3)}%;background:${r.avg===max?'var(--red)':'var(--blue)'}"></div></div>
            <span class="an-bar-val">${tdiff(0,r.avg)}</span>
          </div>`).join('')
        : '<div class="empty" style="padding:0.5rem 0;">No completed workflow jobs yet.</div>'}
      </div>
      <div class="an-widget">
        <div class="an-widget-hd">Workflow Throughput <span class="an-hd-note">completed per drafter</span></div>
        ${draftRows.length ? draftRows.map(r=>`
          <div class="an-bar-row">
            <span class="an-bar-label">${esc(r.k)}</span>
            <div class="an-bar-track"><div class="an-bar-fill" style="width:${Math.max(Math.round(r.v/maxD*100),3)}%;background:var(--purple)"></div></div>
            <span class="an-bar-val">${r.v}</span>
          </div>`).join('')
        : '<div class="empty" style="padding:0.5rem 0;">No data.</div>'}
      </div>
    </div>`;
}

// ── TAB STATE ─────────────────────────────────────────────────────────────────
let _wfTab = null;
let _wfGanttMode = false;
window.getWfTab  = () => _wfTab;
window.wfSetTab  = function(key){ _wfTab = key; _wfGanttMode = false; renderJobBasket(); window.renderSbBasketSubs?.(); };
window.wfToggleGantt = function(){ _wfGanttMode = !_wfGanttMode; renderJobBasket(); };

function _ganttBtn(){
  return `<div class="wf-gantt-bar-btn"><button class="wf-tab wf-gantt-btn${_wfGanttMode?' active':''}" onclick="wfToggleGantt()">📊 Gantt Chart</button></div>`;
}
function _tabBar(tabs, cur){
  return `<div class="wf-tabs">${tabs.map(t=>`
    <button class="wf-tab${t.key===cur?' active':''}" onclick="wfSetTab('${t.key}')">
      ${t.label}${t.n?` <span class="wf-tab-count">${t.n}</span>`:''}
    </button>`).join('')}
    <button class="wf-tab wf-gantt-btn${_wfGanttMode?' active':''}" onclick="wfToggleGantt()">📊 Gantt Chart</button>
  </div>`;
}
function _pickTab(tabs, preferred){
  const keys = tabs.map(t => t.key);
  return keys.includes(preferred) ? preferred : keys[0];
}

// ── MAIN RENDER ───────────────────────────────────────────────────────────────
export function renderJobBasket(){
  const root = document.getElementById('job-basket-root');
  if(!root || !me) return;
  const wfJobs = jobs.filter(j => j.workflow);
  const r = me.role;

  // ── SALES OPERATION ──────────────────────────────────────────────────────────
  if(r === 'sales_operation'){
    const mine   = wfJobs.filter(j => j.wfCreatedBy === me.id).sort((a,b)=>(b.created||0)-(a.created||0));
    const active = mine.filter(j => j.stage !== 'completed');
    const done   = mine.filter(j => j.stage === 'completed');
    const tabs = [
      {key:'submit', label:'📤 Submit'},
      {key:'active', label:'🔄 Active',    n:active.length||null},
      {key:'done',   label:'✅ Done',       n:done.length||null},
    ];
    const tab = _pickTab(tabs, _wfTab); _wfTab = tab;
    let content = '';
    if(tab === 'submit'){
      content = `<div class="wf-so-form">
        <div class="wf-an-hd">📤 Send Job to Basket</div>
        <label class="wf-f">Client Name<input id="wf-so-client" placeholder="Client name"></label>
        <label class="wf-f">Job #<input id="wf-so-jobnum" placeholder="Job number"></label>
        <label class="wf-f">Project Name<input id="wf-so-project" placeholder="Project name (optional)"></label>
        <label class="wf-f">Remarks / Comments<textarea id="wf-so-remarks" rows="2" placeholder="Any notes for the team leader (optional)"></textarea></label>
        <button class="wf-act primary" style="margin-top:0.5rem;" onclick="wfSubmitToBasket()">🧺 Send to Basket</button>
        <div class="tc-muted" style="font-size:0.72rem;margin-top:0.4rem;">Auto-assigned to the freest team leader's team.</div>
      </div>`;
    } else if(tab === 'active'){
      content = active.length ? active.map(j=>wfCard(j,false)).join('') : '<div class="empty" style="padding:1.5rem;">No active jobs.</div>';
    } else {
      content = done.length ? done.map(j=>wfCard(j,false)).join('') : '<div class="empty" style="padding:1.5rem;">No completed jobs yet.</div>';
    }
    if(_wfGanttMode){ root.innerHTML = _tabBar(tabs,tab) + _wfGantt(mine); return; }
    root.innerHTML = _ganttBtn() + `<div class="wf-tab-content">${content}</div>`;
    return;
  }

  // ── TEAM LEADER ───────────────────────────────────────────────────────────────
  if(r === 'team_leader'){
    const myAction = wfJobs.filter(j => wfActionFor(j) && j.stage !== 'completed')
      .sort((a,b) => (a.deadline||9e15) - (b.deadline||9e15));
    const withTeam = wfJobs.filter(j => j.teamLeaderId === me.id && !wfActionFor(j) && j.stage !== 'completed');
    const doneJobs = wfJobs.filter(j => j.teamLeaderId === me.id && j.stage === 'completed');
    const tabs = [
      {key:'queue', label:'⚡ My Queue',   n:myAction.length||null},
      {key:'team',  label:'⏳ My Team',    n:withTeam.length||null},
      {key:'done',  label:'✅ Completed',  n:doneJobs.length||null},
    ];
    const tab = _pickTab(tabs, _wfTab); _wfTab = tab;
    let content = '';
    if(tab === 'queue'){
      content = myAction.length ? myAction.map(j=>wfCard(j,true)).join('') : '<div class="empty" style="padding:1.25rem;">Nothing waiting on you 🎉</div>';
    } else if(tab === 'team'){
      content = withTeam.length ? withTeam.map(j=>wfCard(j,false)).join('') : '<div class="empty" style="padding:1.25rem;">No jobs currently with your team.</div>';
    } else {
      content = doneJobs.length ? doneJobs.map(j=>wfCard(j,true)).join('') : '<div class="empty" style="padding:1.25rem;">No completed jobs yet.</div>';
    }
    if(_wfGanttMode){ root.innerHTML = _tabBar(tabs,tab) + _wfGantt(wfJobs.filter(j=>j.teamLeaderId===me.id)); return; }
    root.innerHTML = _ganttBtn() + `<div class="wf-tab-content">${content}</div>`;
    return;
  }

  // ── MANAGER / SUPERVISOR / DIRECTOR ──────────────────────────────────────────
  if(r === 'manager' || r === 'supervisor' || amDirector()){
    const active   = wfJobs.filter(j => j.stage !== 'completed').sort((a,b)=>(a.deadline||9e15)-(b.deadline||9e15));
    const doneJobs = wfJobs.filter(j => j.stage === 'completed');
    const tabs = [
      {key:'overview', label:'🧺 Overview',  n:active.length||null},
      {key:'done',     label:'✅ Completed', n:doneJobs.length||null},
    ];
    const tab = _pickTab(tabs, _wfTab); _wfTab = tab;
    let content = '';
    if(tab === 'overview'){
      content = active.length ? active.map(j=>wfCard(j,false)).join('') : '<div class="empty" style="padding:1.25rem;">No active workflow jobs.</div>';
    } else {
      content = doneJobs.length ? doneJobs.map(j=>wfCard(j,false)).join('') : '<div class="empty" style="padding:1.25rem;">No completed jobs yet.</div>';
    }
    if(_wfGanttMode){ root.innerHTML = _tabBar(tabs,tab) + _wfGantt(wfJobs); return; }
    root.innerHTML = _ganttBtn() + `<div class="wf-tab-content">${content}</div>`;
    return;
  }

  // ── EMPLOYEE / DRAFTER ────────────────────────────────────────────────────────
  const myAction = wfJobs.filter(j => j.drafterId === me.id && wfActionFor(j))
    .sort((a,b) => (a.deadline||9e15) - (b.deadline||9e15));
  const submitted = wfJobs.filter(j => j.drafterId === me.id && !wfActionFor(j) && j.stage !== 'completed');
  const doneJobs  = wfJobs.filter(j => j.drafterId === me.id && j.stage === 'completed');
  const tabs = [
    {key:'tasks',     label:'⚡ My Tasks',  n:myAction.length||null},
    {key:'submitted', label:'⏳ Submitted', n:submitted.length||null},
    {key:'done',      label:'✅ Completed', n:doneJobs.length||null},
  ];
  const tab = _pickTab(tabs, _wfTab); _wfTab = tab;
  let content = '';
  if(tab === 'tasks'){
    content = myAction.length ? myAction.map(j=>wfCard(j,true)).join('') : '<div class="empty" style="padding:1.25rem;">No workflow tasks waiting on you 🎉</div>';
  } else if(tab === 'submitted'){
    content = submitted.length ? submitted.map(j=>wfCard(j,false)).join('') : '<div class="empty" style="padding:1.25rem;">Nothing submitted awaiting review.</div>';
  } else {
    content = doneJobs.length ? doneJobs.map(j=>wfCard(j,false)).join('') : '<div class="empty" style="padding:1.25rem;">No completed jobs yet.</div>';
  }
  if(_wfGanttMode){ root.innerHTML = _tabBar(tabs,tab) + _wfGantt(wfJobs.filter(j=>j.drafterId===me.id)); window.renderSbBasketSubs?.(); return; }
  root.innerHTML = _ganttBtn() + `<div class="wf-tab-content">${content}</div>`;
  window.renderSbBasketSubs?.();
}
