// ── JOB BASKET / WORKFLOW ─────────────────────────────────────────────────────
// Type-aware staged pipeline. Sales Op creates stub → weighted TL assignment →
// TL picks type + scope at intake → type-specific staged pipeline.
// workflow:true on all basket jobs. job.owner = current ball-holder.
// All types implemented. BOM and Other are intentional stubs (skip to completed).
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
import { emailWfDrafter, emailWfSalesOp, emailWfOversight } from './email.js';

// ── BASKET EMAIL HELPER ───────────────────────────────────────────────────────
// Dispatches gated basket emails. All send only if master is on + event.on + recip flag.
// exceptIds=[me.id] avoids emailing the TL who just triggered the event.
function _wfMail(evt, j, subject, msg){
  if(evt==='wf_assigned'){
    emailWfDrafter(evt,j,subject,msg);
    emailWfSalesOp(evt,j,subject,msg);
    emailWfOversight(evt,j,subject,msg);
  } else if(evt==='wf_rejected'){
    emailWfDrafter(evt,j,subject,msg);
    emailWfOversight(evt,j,subject,msg,[me.id]);
  } else if(evt==='wf_completed'){
    emailWfSalesOp(evt,j,subject,msg);
    emailWfOversight(evt,j,subject,msg,[me.id]);
  }
}

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
  // SD post-job-card pipeline
  sd_prod_submit:          { actor:'tl',      label:'Submit to Production',               short:'Prod Submit', color:'blue'   },
  sd_bom:                  { actor:'drafter', label:'Bill of Materials Preparation',      short:'BOM Prep',    color:'yellow' },
  sd_bom_review:           { actor:'tl',      label:'Bill of Materials Review',           short:'BOM Review',  color:'purple' },
  sd_erection_draft:       { actor:'drafter', label:'Erection Drawing Preparation',       short:'Erect Draft', color:'yellow' },
  sd_erection_review:      { actor:'tl',      label:'Erection Drawing Review',            short:'Erect Review',color:'purple' },
  // send-to-client confirmation step
  sd_send_to_client:       { actor:'tl',      label:'Send to Client',                     short:'Send Client', color:'orange' },
  // panels release
  pr_draft:                { actor:'drafter', label:'Panels Release Preparation',        short:'PR Draft',    color:'yellow' },
  pr_tl_review:            { actor:'tl',      label:'Panels Release Review',             short:'PR Review',   color:'purple' },
  // flashings release
  fl_draft:                { actor:'drafter', label:'Flashings Release Preparation',     short:'FL Draft',    color:'yellow' },
  fl_tl_review:            { actor:'tl',      label:'Flashings Release Review',          short:'FL Review',   color:'purple' },
  // accessories release
  ac_draft:                { actor:'drafter', label:'Accessories Release Preparation',   short:'AC Draft',    color:'yellow' },
  ac_tl_review:            { actor:'tl',      label:'Accessories Release Review',        short:'AC Review',   color:'purple' },
  // purlins release
  pu_draft:                { actor:'drafter', label:'Purlins Release Preparation',       short:'PU Draft',    color:'yellow' },
  pu_tl_review:            { actor:'tl',      label:'Purlins Release Review',            short:'PU Review',   color:'purple' },
  // panels + flashings
  pf_draft:                { actor:'drafter', label:'Panels + Flashings Preparation',    short:'PF Draft',    color:'yellow' },
  pf_tl_review:            { actor:'tl',      label:'Panels + Flashings Review',         short:'PF Review',   color:'purple' },
  // panels + accessories
  pa_draft:                { actor:'drafter', label:'Panels + Accessories Preparation',  short:'PA Draft',    color:'yellow' },
  pa_tl_review:            { actor:'tl',      label:'Panels + Accessories Review',       short:'PA Review',   color:'purple' },
  // flashings + accessories
  fa_draft:                { actor:'drafter', label:'Flashings + Accessories Prep',      short:'FA Draft',    color:'yellow' },
  fa_tl_review:            { actor:'tl',      label:'Flashings + Accessories Review',    short:'FA Review',   color:'purple' },
  // panels + flashings + accessories
  pfa_draft:               { actor:'drafter', label:'P+F+A Preparation',                 short:'PFA Draft',   color:'yellow' },
  pfa_tl_review:           { actor:'tl',      label:'P+F+A Review',                      short:'PFA Review',  color:'purple' },
  // full job release
  fj_draft:                { actor:'drafter', label:'Full Job Release Preparation',      short:'FJ Draft',    color:'yellow' },
  fj_tl_review:            { actor:'tl',      label:'Full Job Release Review',           short:'FJ Review',   color:'purple' },
  // shop drawing editing (internal audit)
  sdi_draft:               { actor:'drafter', label:'SD Editing (Internal Audit) Prep',  short:'SDI Draft',   color:'yellow' },
  sdi_tl_review:           { actor:'tl',      label:'SD Editing (Internal Audit) Review',short:'SDI Review',  color:'purple' },
  // shop drawing editing (revision)
  sdr_draft:               { actor:'drafter', label:'SD Editing (Revision) Prep',        short:'SDR Draft',   color:'yellow' },
  sdr_tl_review:           { actor:'tl',      label:'SD Editing (Revision) Review',      short:'SDR Review',  color:'purple' },
  // erection drawing
  ed_draft:                { actor:'drafter', label:'Erection Drawing Preparation',      short:'ED Draft',    color:'yellow' },
  ed_tl_review:            { actor:'tl',      label:'Erection Drawing Review',           short:'ED Review',   color:'purple' },
  // civil defense
  cd_draft:                { actor:'drafter', label:'Civil Defense — Submission Prep',   short:'CD Prep',     color:'yellow' },
  cd_pending:              { actor:'tl',      label:'Civil Defense — Awaiting Response', short:'CD Pending',  color:'orange' },
  // terminal
  completed:               { actor:'none',    label:'Completed',                          short:'Done',        color:'green'  },
  // reopen/continuation
  release:                 { actor:'drafter', label:'Continuation / Release',            short:'Release',     color:'yellow' },
};

export function wfStageMeta(s){ return WF_STAGES[s] || { actor:'none', label:s, short:s, color:'blue' }; }
window.WF_STAGES = WF_STAGES; // expose for analytics

// ── PIPELINE ORDER (scope-aware, for progress bar) ────────────────────────────
function _sdPipeline(j){
  const s = j.sdScope || 'roof_wall';
  const roof = s === 'roof' || s === 'roof_wall';
  const wall = s === 'wall' || s === 'roof_wall';
  const base = ['intake'];
  if(roof){ base.push('sd_roof_draft', 'sd_tl_roof_review'); }
  if(wall){ base.push('sd_wall_draft', 'sd_tl_wall_review'); }
  base.push('sd_send_to_client', 'sd_client_wait');
  const hasRevision = Array.isArray(j.wfHistory) && j.wfHistory.some(e => e.to === 'sd_revision_draft');
  if(hasRevision){ base.push('sd_revision_draft', 'sd_tl_revision_review'); }
  base.push('sd_jobcard', 'sd_tl_jobcard_review', 'sd_prod_submit', 'sd_bom', 'sd_bom_review', 'sd_erection_draft', 'sd_erection_review', 'completed');
  return base;
}

function _prPipeline(){ return ['intake','pr_draft','pr_tl_review','completed']; }
function _flPipeline(){ return ['intake','fl_draft','fl_tl_review','completed']; }

function _typedPipeline(j){
  const cfg = TYPED_WORKFLOW[j.type];
  if(cfg) return ['intake', cfg.draftStage, cfg.reviewStage, 'completed'];
  if(j.type === 'Civil Defense') return ['intake','cd_draft','cd_pending','completed'];
  return ['intake','completed'];
}

function wfPipeline(j){
  let pipeline;
  if(j.type === 'Shop Drawing' || !j.type)     pipeline = _sdPipeline(j);
  else if(j.type === 'Panels Release')          pipeline = _prPipeline();
  else if(j.type === 'Flashings Release')       pipeline = _flPipeline();
  else                                           pipeline = _typedPipeline(j);
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
    status:'pending', created:now, started:null, completed:null,
    deadline:now + ((window._jobSettings?.deadlineSalesOpBasketHours??24)*60*60*1000),
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
    // auto-reset to pending on every stage transition; wfStart sets it to ongoing
    if(patch.status === undefined) patch.status = 'pending';
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

// Multi-phase yes/no checklist — shows phase header; any No blocks
function wfAskPhased(title, phases, onAllYes, onNo){
  if(!phases || !phases.length){ onAllYes({}); return; }
  const allAnswers = {};
  let pi = 0, qi = 0;
  const total = phases.reduce((a,p) => a + p.questions.length, 0);
  let done = 0;
  function render(){
    const ph = phases[pi];
    const q  = ph.questions[qi];
    const showPhase = phases.length > 1 || ph.phaseTitle;
    wfModalHtml(`
      <div class="wf-q-title">${esc(title)}</div>
      ${showPhase ? `<div class="wf-q-phase">${esc(ph.phaseTitle)}</div>` : ''}
      <div class="wf-q-step">Question ${done+1}${total>1?' of '+total:''}</div>
      <div class="wf-q-text">${esc(q.q)}</div>
      <div class="wf-q-actions">
        <button class="wf-btn-no"  onclick="__wfAns(false)">No</button>
        <button class="wf-btn-yes" onclick="__wfAns(true)">Yes</button>
      </div>`);
  }
  window.__wfAns = function(yes){
    const ph = phases[pi];
    const q  = ph.questions[qi];
    allAnswers[q.key] = yes;
    done++;
    if(!yes){ window.wfCloseModal(); if(onNo) onNo(q, allAnswers); return; }
    qi++;
    if(qi >= ph.questions.length){ pi++; qi = 0;
      if(pi >= phases.length){ window.wfCloseModal(); onAllYes(allAnswers); return; }
    }
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

// ── LIVE QUESTION CACHE (populated by main.js listenWfQuestions) ─────────────
// Manager can add/remove/reorder questions per checklist key via Account Settings.
// Stored in Firestore config/wfQuestions. Falls back to hardcoded defaults when empty.
window._wfQuestions = {};

// Returns questions array for a checklist key. Uses live Firestore data if available,
// else falls back to provided default array. Normalises to {q, key} shape.
function getWfQ(key, fallback){
  const live = window._wfQuestions?.[key];
  if(live && live.length) return live.map(q=>({q:q.q, key:q.id||q.key||key+'_'+q.q.slice(0,8).replace(/\W/g,'')}));
  return fallback;
}

// Exported defaults map — used by manager UI to populate initial values
export const WF_Q_DEFAULTS = {};
function _regDefault(key, qs){ WF_Q_DEFAULTS[key] = qs; return qs; }

// ── DYNAMIC CHECKLISTS ────────────────────────────────────────────────────────
const _ROOF_DRAFTER_BASE = _regDefault('roofDrafter', [
  {q:'Did you prepare the roof layout plan?',    key:'roofLayout'},
  {q:'Did you prepare the roof cross section?',  key:'crossSection'},
]);
function _roofDrafterChecklist(j){
  const qs = getWfQ('roofDrafter', _ROOF_DRAFTER_BASE).slice();
  if(j.sdGutter && j.sdGutter !== 'none'){
    const lbl = j.sdGutter === 'eave_gutter' ? 'eave gutter' : 'curve';
    qs.push({q:`Did you prepare the ${lbl} sample?`, key:'gutterSample'});
  }
  if(j.sdSkylight){
    qs.push({q:'Did you prepare the skylight proposal?', key:'skylightProposal'});
  }
  return qs;
}

const _ROOF_TL_BASE = _regDefault('roofTL', [
  {q:'Did you check the panel lengths?',  key:'panelLengths'},
  {q:'Did you check the dimensions?',     key:'dimensions'},
  {q:'Did you check the cutback?',        key:'cutback'},
  {q:'Did you check the quantity (qty)?', key:'qty'},
]);
function _roofTLChecklist(){ return getWfQ('roofTL', _ROOF_TL_BASE); }

const _WALL_DRAFTER_BASE = _regDefault('wallDrafter', [
  {q:'Did you prepare the wall layout?',              key:'wallLayout'},
  {q:'Did you check the panel lengths?',              key:'panelLengths'},
  {q:'Did you check for any openings?',               key:'openings'},
  {q:'Did you check the specs (RW or PIR)?',          key:'specs'},
  {q:'Did you check the required flashings?',         key:'flashings'},
]);
function _wallDrafterChecklist(){ return getWfQ('wallDrafter', _WALL_DRAFTER_BASE); }

const _WALL_TL_BASE = _regDefault('wallTL', [
  {q:'Did you check the wall layout?',               key:'wallLayout'},
  {q:'Did you check the panel lengths?',             key:'panelLengths'},
  {q:'Did you check all openings?',                  key:'openings'},
  {q:'Did you check the material specs (RW/PIR)?',   key:'specs'},
  {q:'Did you check the flashing details?',          key:'flashings'},
]);
function _wallTLChecklist(){ return getWfQ('wallTL', _WALL_TL_BASE); }

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
const _QC5_BASE = _regDefault('jobCardQC', [
  {q:'Did you check the color?',                                  key:'color'},
  {q:'Did you check the material specs?',                         key:'material'},
  {q:'Did you check quantity availability in the quotation?',     key:'qtyQuote'},
  {q:'Did you check for any samples?',                            key:'samples'},
  {q:'Did you check the panel thickness specs / sketches?',       key:'thickness'},
]);
const QC5 = ()=>getWfQ('jobCardQC', _QC5_BASE);

// ── PANELS RELEASE CHECKLIST ─────────────────────────────────────────────────
const _PR_BASE = _regDefault('panelsRelease', [
  {q:'Did you check the panel orientation (LH or RH)?', key:'orientation'},
  {q:'Did you check the quantity?',                      key:'quantity'},
  {q:'Did you check the length?',                        key:'length'},
  {q:'Did you check the part mark?',                     key:'partMark'},
  {q:'Did you check the top sheet material?',            key:'topSheetMaterial'},
  {q:'Did you check the liner sheet material?',          key:'linerSheetMaterial'},
  {q:'Did you check the insulation material?',           key:'insulationMaterial'},
  {q:'Did you check the insulation thickness?',          key:'insulationThickness'},
  {q:'Did you check the insulation density?',            key:'insulationDensity'},
  {q:'Did you check the top sheet color?',               key:'topSheetColor'},
  {q:'Did you check the bottom sheet color?',            key:'bottomSheetColor'},
  {q:'Did you check the effective width? (1000 / 1050 / 1220 / 1090 mm)', key:'effectiveWidth'},
]);
const PR_CHECKLIST = ()=>getWfQ('panelsRelease', _PR_BASE);

// ── FLASHINGS RELEASE CHECKLIST ───────────────────────────────────────────────
const _FL_BASE = _regDefault('flashingsRelease', [
  {q:'Did you check the color?',                     key:'color'},
  {q:'Did you check the specs?',                     key:'specs'},
  {q:'Did you check the material?',                  key:'material'},
  {q:'Did you check the color side of flashing?',    key:'colorSide'},
]);
const FL_CHECKLIST = ()=>getWfQ('flashingsRelease', _FL_BASE);

// ── PURLINS RELEASE CHECKLIST ─────────────────────────────────────────────────
const _PU_BASE = _regDefault('purlinsRelease', [
  {q:'Did you check the flange thickness?',                    key:'flangeThickness'},
  {q:'Did you check that lengths match the purlin sketches?',  key:'lengthMatch'},
]);
const PU_CHECKLIST = ()=>getWfQ('purlinsRelease', _PU_BASE);

// ── ACCESSORIES SINGLE CHECK ──────────────────────────────────────────────────
const AC_SINGLE = [
  {q:'Did you prepare the accessories release package?',       key:'accessoriesPackage'},
];

// ── TYPED WORKFLOW CONFIG ─────────────────────────────────────────────────────
// Data-driven config for all simple draft→tl_review→completed types.
// phases(j) = array of {phaseTitle, questions} shown in wfAskPhased.
// null phases = no checklist (straight submit/approve).
// drafterPhases / tlPhases = separate phase arrays for Erection Drawing.
const TYPED_WORKFLOW = {
  'Accessories Release': {
    draftStage:'ac_draft', reviewStage:'ac_tl_review', phases:null,
  },
  'Purlins Release': {
    draftStage:'pu_draft', reviewStage:'pu_tl_review',
    phases:()=>[{phaseTitle:'Purlins Check', questions:PU_CHECKLIST()}],
  },
  'Panels + Flashings Release': {
    draftStage:'pf_draft', reviewStage:'pf_tl_review',
    phases:()=>[
      {phaseTitle:'Phase 1 of 2 — Panels',    questions:PR_CHECKLIST()},
      {phaseTitle:'Phase 2 of 2 — Flashings', questions:FL_CHECKLIST()},
    ],
  },
  'Panels + Accessories Release': {
    draftStage:'pa_draft', reviewStage:'pa_tl_review',
    phases:()=>[
      {phaseTitle:'Phase 1 of 2 — Panels',      questions:PR_CHECKLIST()},
      {phaseTitle:'Phase 2 of 2 — Accessories', questions:AC_SINGLE},
    ],
  },
  'Flashings + Accessories Release': {
    draftStage:'fa_draft', reviewStage:'fa_tl_review',
    phases:()=>[
      {phaseTitle:'Phase 1 of 2 — Flashings',   questions:FL_CHECKLIST()},
      {phaseTitle:'Phase 2 of 2 — Accessories', questions:AC_SINGLE},
    ],
  },
  'Panels + Flashings + Accessories Release': {
    draftStage:'pfa_draft', reviewStage:'pfa_tl_review',
    phases:()=>[
      {phaseTitle:'Phase 1 of 3 — Panels',      questions:PR_CHECKLIST()},
      {phaseTitle:'Phase 2 of 3 — Flashings',   questions:FL_CHECKLIST()},
      {phaseTitle:'Phase 3 of 3 — Accessories', questions:AC_SINGLE},
    ],
  },
  'Full Job Release': {
    draftStage:'fj_draft', reviewStage:'fj_tl_review',
    phases:()=>[
      {phaseTitle:'Phase 1 of 4 — Panels',      questions:PR_CHECKLIST()},
      {phaseTitle:'Phase 2 of 4 — Flashings',   questions:FL_CHECKLIST()},
      {phaseTitle:'Phase 3 of 4 — Accessories', questions:AC_SINGLE},
      {phaseTitle:'Phase 4 of 4 — Purlins',     questions:PU_CHECKLIST()},
    ],
  },
  'Shop Drawing Editing (Internal Audit)': {
    draftStage:'sdi_draft', reviewStage:'sdi_tl_review', phases:null,
  },
  'Shop Drawing Editing (Revision)': {
    draftStage:'sdr_draft', reviewStage:'sdr_tl_review', phases:null,
  },
  'Erection Drawing': {
    draftStage:'ed_draft', reviewStage:'ed_tl_review',
    drafterPhases:(j)=>{
      const s = j.sdScope || 'roof_wall'; const ps = [];
      if(s==='roof'||s==='roof_wall') ps.push({phaseTitle:'Roof Layout', questions:_roofDrafterChecklist(j)});
      if(s==='wall'||s==='roof_wall') ps.push({phaseTitle:'Wall Layout', questions:_wallDrafterChecklist()});
      return ps.length ? ps : null;
    },
    tlPhases:(j)=>{
      const s = j.sdScope || 'roof_wall'; const ps = [];
      if(s==='roof'||s==='roof_wall') ps.push({phaseTitle:'Roof Layout', questions:_roofTLChecklist()});
      if(s==='wall'||s==='roof_wall') ps.push({phaseTitle:'Wall Layout', questions:_wallTLChecklist()});
      return ps.length ? ps : null;
    },
  },
};

// ── PANELS RELEASE · DRAFTER: START / SUBMIT ─────────────────────────────────
window.wfSubmitPR = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  const scopeMap = {roof:'Roof Panels', wall:'Wall Panels', both:'Roof + Wall Panels'};
  const scopeLabel = scopeMap[j.prScope] || 'Panels';
  wfAsk(`Submit ${scopeLabel} Release`, PR_CHECKLIST(), async(ans)=>{
    await wfAdvance(jobId,'pr_tl_review',{
      action:'pr_submitted', checklist:ans, owner:j.teamLeaderId,
      note:`${scopeLabel} release submitted for TL review`,
    });
    await addEvent(jobId,'wf_pr_tl_review',
      `📦 ${me.name} submitted ${scopeLabel} release for review`,'purple');
    pushNotif(j.teamLeaderId,'📦 Panels Release Ready',
      `${j.client} (#${j.jobNum}) — review ${scopeLabel} release.`);
    showToastMsg('✅ Sent to team leader for review.');
    renderJobBasket();
  },(q)=>{ showToastMsg('Complete every check before submitting.'); });
};

// ── PANELS RELEASE · TL: REVIEW ──────────────────────────────────────────────
window.wfReviewPR = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  const scopeMap = {roof:'Roof Panels', wall:'Wall Panels', both:'Roof + Wall Panels'};
  const scopeLabel = scopeMap[j.prScope] || 'Panels';
  wfAsk(`Review ${scopeLabel} Release`, PR_CHECKLIST(), (ans)=>{
    _wfCtx = {jobId, checklist:ans};
    wfShowDecision(j,
      'Approve → job completed. Reject (comment required) → drafter fixes & resubmits.',
      'wfDecidePR', true);
  },(q)=>{ showToastMsg('Complete the checklist before reviewing.'); });
};

window.wfDecidePR = async function(approve){
  const j = jobs.find(x => x.id === _wfCtx.jobId); if(!j) return;
  const note = document.getElementById('wf-reject-note')?.value.trim() || null;
  if(!approve && !note){ alert('A comment is required when rejecting.'); return; }
  if(approve){
    await wfAdvance(j.id,'completed',{
      action:'pr_approved', checklist:_wfCtx.checklist,
      note:'Panels release approved — completed',
      statusComplete:true, extra:{releaseEligible:true},
    });
    await addEvent(j.id,'completed',`✅ ${me.name} approved panels release — completed`,'green');
    if(j.drafterId)   pushNotif(j.drafterId,'✅ Job Completed',
      `${j.client} (#${j.jobNum}) — panels release approved.`);
    if(j.wfCreatedBy) pushNotif(j.wfCreatedBy,'✅ Job Completed',
      `${j.client} (#${j.jobNum}) — done.`);
    _wfMail('wf_completed', j, `✅ Basket Job Completed — ${j.client} (#${j.jobNum})`,
      `Panels release approved by ${me.name}.\n\nClient: ${j.client}\nJob #: ${j.jobNum}`);
    showToastMsg('🎉 Panels release approved — job completed.');
  } else {
    const rejCount = (j.rejectionCount||0) + 1;
    await wfAdvance(j.id,'pr_draft',{
      action:'pr_rejected', checklist:_wfCtx.checklist, owner:j.drafterId,
      note:note, extra:{rejectionCount:rejCount, lastRejectNote:note, lastRejectPhase:'pr'},
    });
    await addEvent(j.id,'wf_pr_rejected',
      `🔴 ${me.name} rejected panels release (rejection #${rejCount}) — ${note}`,'red');
    pushNotif(j.drafterId,'🔴 Panels Release Rejected',
      `${j.client} (#${j.jobNum}) — fix & resubmit. Note: ${note}`);
    _wfMail('wf_rejected', j, `🔴 Basket Rejection — ${j.client} (#${j.jobNum})`,
      `${me.name} rejected Panels Release.\n\nClient: ${j.client}\nJob #: ${j.jobNum}\nNote: ${note||'—'}`);
    showToastMsg('Sent back for fixes.');
  }
  window.wfCloseModal();
  renderJobBasket();
};

// ── FLASHINGS RELEASE · DRAFTER: START / SUBMIT ───────────────────────────────
window.wfSubmitFL = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  const scopeMap = {roof:'Roof Flashings', wall:'Wall Flashings', both:'Roof + Wall Flashings'};
  const scopeLabel = scopeMap[j.flScope] || 'Flashings';
  wfAsk(`Submit ${scopeLabel} Release`, FL_CHECKLIST(), async(ans)=>{
    await wfAdvance(jobId,'fl_tl_review',{
      action:'fl_submitted', checklist:ans, owner:j.teamLeaderId,
      note:`${scopeLabel} release submitted for TL review`,
    });
    await addEvent(jobId,'wf_fl_tl_review',
      `🔩 ${me.name} submitted ${scopeLabel} release for review`,'purple');
    pushNotif(j.teamLeaderId,'🔩 Flashings Release Ready',
      `${j.client} (#${j.jobNum}) — review ${scopeLabel} release.`);
    showToastMsg('✅ Sent to team leader for review.');
    renderJobBasket();
  },(q)=>{ showToastMsg('Complete every check before submitting.'); });
};

// ── FLASHINGS RELEASE · TL: REVIEW ───────────────────────────────────────────
window.wfReviewFL = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  const scopeMap = {roof:'Roof Flashings', wall:'Wall Flashings', both:'Roof + Wall Flashings'};
  const scopeLabel = scopeMap[j.flScope] || 'Flashings';
  wfAsk(`Review ${scopeLabel} Release`, FL_CHECKLIST(), (ans)=>{
    _wfCtx = {jobId, checklist:ans};
    wfShowDecision(j,
      'Approve → job completed. Reject (comment required) → drafter fixes & resubmits.',
      'wfDecideFL', true);
  },(q)=>{ showToastMsg('Complete the checklist before reviewing.'); });
};

window.wfDecideFL = async function(approve){
  const j = jobs.find(x => x.id === _wfCtx.jobId); if(!j) return;
  const note = document.getElementById('wf-reject-note')?.value.trim() || null;
  if(!approve && !note){ alert('A comment is required when rejecting.'); return; }
  if(approve){
    await wfAdvance(j.id,'completed',{
      action:'fl_approved', checklist:_wfCtx.checklist,
      note:'Flashings release approved — completed',
      statusComplete:true, extra:{releaseEligible:true},
    });
    await addEvent(j.id,'completed',`✅ ${me.name} approved flashings release — completed`,'green');
    if(j.drafterId)   pushNotif(j.drafterId,'✅ Job Completed',
      `${j.client} (#${j.jobNum}) — flashings release approved.`);
    if(j.wfCreatedBy) pushNotif(j.wfCreatedBy,'✅ Job Completed',
      `${j.client} (#${j.jobNum}) — done.`);
    _wfMail('wf_completed', j, `✅ Basket Job Completed — ${j.client} (#${j.jobNum})`,
      `Flashings release approved by ${me.name}.\n\nClient: ${j.client}\nJob #: ${j.jobNum}`);
    showToastMsg('🎉 Flashings release approved — job completed.');
  } else {
    const rejCount = (j.rejectionCount||0) + 1;
    await wfAdvance(j.id,'fl_draft',{
      action:'fl_rejected', checklist:_wfCtx.checklist, owner:j.drafterId,
      note:note, extra:{rejectionCount:rejCount, lastRejectNote:note, lastRejectPhase:'fl'},
    });
    await addEvent(j.id,'wf_fl_rejected',
      `🔴 ${me.name} rejected flashings release (rejection #${rejCount}) — ${note}`,'red');
    pushNotif(j.drafterId,'🔴 Flashings Release Rejected',
      `${j.client} (#${j.jobNum}) — fix & resubmit. Note: ${note}`);
    _wfMail('wf_rejected', j, `🔴 Basket Rejection — ${j.client} (#${j.jobNum})`,
      `${me.name} rejected Flashings Release.\n\nClient: ${j.client}\nJob #: ${j.jobNum}\nNote: ${note||'—'}`);
    showToastMsg('Sent back for fixes.');
  }
  window.wfCloseModal();
  renderJobBasket();
};

// ── GENERIC TYPED WORKFLOW HANDLERS ──────────────────────────────────────────
window.wfSubmitType = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  const cfg = TYPED_WORKFLOW[j.type]; if(!cfg) return;
  const phases = cfg.drafterPhases ? cfg.drafterPhases(j) : (cfg.phases ? cfg.phases(j) : null);
  if(!phases || !phases.length){
    _wfTypeSubmitDone(j, cfg.reviewStage, null); return;
  }
  wfAskPhased(`Submit — ${j.type}`, phases, (ans)=>{
    _wfTypeSubmitDone(j, cfg.reviewStage, ans);
  },(q)=>{ showToastMsg('Complete every check before submitting.'); });
};

async function _wfTypeSubmitDone(j, reviewStage, checklist){
  await wfAdvance(j.id, reviewStage, {
    action:'type_submitted', checklist, owner:j.teamLeaderId,
    note:`${j.type} submitted for TL review`,
  });
  await addEvent(j.id, `wf_${reviewStage}`, `📤 ${me.name} submitted ${j.type} for review`, 'purple');
  pushNotif(j.teamLeaderId, `📋 ${j.type} Ready`,
    `${j.client} (#${j.jobNum}) — review & approve.`);
  showToastMsg('✅ Sent to team leader for review.');
  renderJobBasket();
}

window.wfReviewType = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  const cfg = TYPED_WORKFLOW[j.type]; if(!cfg) return;
  const phases = cfg.tlPhases ? cfg.tlPhases(j) : (cfg.phases ? cfg.phases(j) : null);
  if(!phases || !phases.length){
    _wfCtx = {jobId, checklist:null};
    wfShowDecision(j,
      'Approve → completed. Reject (comment required) → drafter fixes & resubmits.',
      'wfDecideType', true);
  } else {
    wfAskPhased(`Review — ${j.type}`, phases, (ans)=>{
      _wfCtx = {jobId, checklist:ans};
      wfShowDecision(j,
        'Approve → completed. Reject (comment required) → drafter fixes & resubmits.',
        'wfDecideType', true);
    },(q)=>{ showToastMsg('Complete the checklist before reviewing.'); });
  }
};

window.wfDecideType = async function(approve){
  const j = jobs.find(x => x.id === _wfCtx.jobId); if(!j) return;
  const cfg = TYPED_WORKFLOW[j.type]; if(!cfg) return;
  const note = document.getElementById('wf-reject-note')?.value.trim() || null;
  if(!approve && !note){ alert('A comment is required when rejecting.'); return; }
  if(approve){
    await wfAdvance(j.id, 'completed', {
      action:'type_approved', checklist:_wfCtx.checklist,
      note:`${j.type} approved — completed`,
      statusComplete:true, extra:{releaseEligible:true},
    });
    await addEvent(j.id, 'completed', `✅ ${me.name} approved ${j.type} — completed`, 'green');
    if(j.drafterId)   pushNotif(j.drafterId,   '✅ Job Completed',
      `${j.client} (#${j.jobNum}) — ${j.type} approved.`);
    if(j.wfCreatedBy) pushNotif(j.wfCreatedBy, '✅ Job Completed',
      `${j.client} (#${j.jobNum}) — done.`);
    _wfMail('wf_completed', j, `✅ Basket Job Completed — ${j.client} (#${j.jobNum})`,
      `${j.type} approved by ${me.name}.\n\nClient: ${j.client}\nJob #: ${j.jobNum}`);
    showToastMsg(`🎉 ${j.type} approved — job completed.`);
  } else {
    const rejCount = (j.rejectionCount||0) + 1;
    await wfAdvance(j.id, cfg.draftStage, {
      action:'type_rejected', checklist:_wfCtx.checklist, owner:j.drafterId,
      note, extra:{rejectionCount:rejCount, lastRejectNote:note, lastRejectPhase:j.type},
    });
    await addEvent(j.id, 'wf_type_rejected',
      `🔴 ${me.name} rejected ${j.type} (rejection #${rejCount}) — ${note}`, 'red');
    pushNotif(j.drafterId, `🔴 ${j.type} Rejected`,
      `${j.client} (#${j.jobNum}) — fix & resubmit. Note: ${note}`);
    _wfMail('wf_rejected', j, `🔴 Basket Rejection — ${j.client} (#${j.jobNum})`,
      `${me.name} rejected ${j.type}.\n\nClient: ${j.client}\nJob #: ${j.jobNum}\nNote: ${note||'—'}`);
    showToastMsg('Sent back for fixes.');
  }
  window.wfCloseModal();
  renderJobBasket();
};

// ── CIVIL DEFENSE HANDLERS ────────────────────────────────────────────────────
window.wfSubmitCD = async function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  await wfAdvance(jobId, 'cd_pending', {
    action:'cd_submitted', owner:j.teamLeaderId,
    note:'Civil Defense drawings submitted — awaiting response',
  });
  await addEvent(jobId, 'wf_cd_pending',
    `🏛 ${me.name} submitted drawings to Civil Defense`, 'orange');
  pushNotif(j.teamLeaderId, '🏛 Civil Defense Submitted',
    `${j.client} (#${j.jobNum}) — record response when received.`);
  showToastMsg('✅ Submitted to Civil Defense.');
  renderJobBasket();
};

window.wfRecordCDResponse = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  _wfCtx = {jobId};
  wfModalHtml(`
    <div class="wf-q-title">Civil Defense Response — ${esc(j.client)} <span class="tc-muted">#${esc(j.jobNum)}</span></div>
    <label class="wf-f">Comments / Notes
      <textarea id="wf-cd-note" rows="2" placeholder="Optional — paste response notes"></textarea>
    </label>
    <div class="wf-q-actions">
      <button class="wf-btn-reject" onclick="wfCDResult('denied')">✗ Denied — Fix Required</button>
      <button class="wf-btn-yes"    onclick="wfCDResult('approved')">✓ Approved</button>
    </div>`);
};

window.wfCDResult = async function(result){
  const j = jobs.find(x => x.id === _wfCtx.jobId); if(!j) return;
  const note = document.getElementById('wf-cd-note')?.value.trim() || null;
  if(result === 'approved'){
    await wfAdvance(j.id, 'completed', {
      action:'cd_approved', note:'Civil Defense approved',
      statusComplete:true, extra:{releaseEligible:true},
    });
    await addEvent(j.id, 'completed', `✅ Civil Defense approved — completed`, 'green');
    if(j.drafterId)   pushNotif(j.drafterId,   '✅ Civil Defense Approved',
      `${j.client} (#${j.jobNum})`);
    if(j.wfCreatedBy) pushNotif(j.wfCreatedBy, '✅ Job Completed',
      `${j.client} (#${j.jobNum}) — done.`);
    _wfMail('wf_completed', j, `✅ Basket Job Completed — ${j.client} (#${j.jobNum})`,
      `Civil Defense approved by ${me.name}.\n\nClient: ${j.client}\nJob #: ${j.jobNum}`);
    showToastMsg('🎉 Civil Defense approved — job completed.');
  } else {
    const rejCount = (j.rejectionCount||0) + 1;
    await wfAdvance(j.id, 'cd_draft', {
      action:'cd_denied', owner:j.drafterId,
      note: note ? `Civil Defense denied — ${note}` : 'Civil Defense denied — fix & resubmit',
      extra:{rejectionCount:rejCount, lastRejectNote:note, lastRejectPhase:'Civil Defense'},
    });
    await addEvent(j.id, 'wf_cd_denied',
      `🔴 Civil Defense denied${note ? ' — ' + note : ''}`, 'red');
    pushNotif(j.drafterId, '🔴 Civil Defense Denied',
      `${j.client} (#${j.jobNum}) — fix & resubmit.${note ? ' ' + note : ''}`);
    _wfMail('wf_rejected', j, `🔴 Basket Rejection — ${j.client} (#${j.jobNum})`,
      `${me.name} denied Civil Defense submission.\n\nClient: ${j.client}\nJob #: ${j.jobNum}\nNote: ${note||'—'}`);
    showToastMsg('Sent back to drafter for fixes.');
  }
  window.wfCloseModal();
  renderJobBasket();
};

// ── INTAKE: TL TAKE & ASSIGN ──────────────────────────────────────────────────
window.wfTakeJob = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  wfAsk('Pre-Assignment Check',[
    {q:'Did you check the Steel IFC drawings?',                       key:'steelIFC'},
    {q:'Did you check the Architectural drawings?',                   key:'architectural'},
    {q:'Has a Material Request (MR) been made for this job?',         key:'mrMade'},
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
    <div id="wf-pr-scope-wrap" style="display:none;">
      <label class="wf-f">Panels Scope
        <select id="wf-pr-scope">
          <option value="roof">Roof Panels</option>
          <option value="wall">Wall Panels</option>
          <option value="both" selected>Roof + Wall Panels</option>
        </select>
      </label>
    </div>
    <div id="wf-fl-scope-wrap" style="display:none;">
      <label class="wf-f">Flashings Scope
        <select id="wf-fl-scope">
          <option value="roof">Roof Flashings</option>
          <option value="wall">Wall Flashings</option>
          <option value="both" selected>Roof + Wall Flashings</option>
        </select>
      </label>
    </div>
    <label class="wf-f">Deadline<input type="datetime-local" id="wf-dl" oninput="this.dataset.userEdited=1"></label>
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
  window.wfTypeChange(); // init scope visibility + auto-fill deadline for default type
}

window.wfTypeChange = function(){
  const t = document.getElementById('wf-type')?.value;
  const sd = document.getElementById('wf-sd-scope-wrap');
  const pr = document.getElementById('wf-pr-scope-wrap');
  const fl = document.getElementById('wf-fl-scope-wrap');
  if(sd) sd.style.display = (t === 'Shop Drawing' || t === 'Erection Drawing') ? 'block' : 'none';
  if(pr) pr.style.display = (t === 'Panels Release')    ? 'block' : 'none';
  if(fl) fl.style.display = (t === 'Flashings Release') ? 'block' : 'none';
  // auto-fill deadline from job settings; skip if TL manually edited field
  const dlEl = document.getElementById('wf-dl');
  if(dlEl && !dlEl.dataset.userEdited){
    const cfg = window._jobSettings || {};
    let days;
    if(t === 'Shop Drawing')                                  days = cfg.deadlineShopDrawing  ?? 10;
    else if(t === 'Panels Release' || t === 'Flashings Release') days = cfg.deadlineRelease   ?? 5;
    else                                                         days = cfg.deadlineDefault    ?? 5;
    dlEl.value = new Date(Date.now() + days * 86400000).toISOString().slice(0,16);
  }
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
  } else if(type === 'Panels Release'){
    const scope = document.getElementById('wf-pr-scope').value;
    extra.prScope = scope;
    firstStage = 'pr_draft';
  } else if(type === 'Flashings Release'){
    const scope = document.getElementById('wf-fl-scope').value;
    extra.flScope = scope;
    firstStage = 'fl_draft';
  } else if(type === 'Erection Drawing'){
    const scope   = document.getElementById('wf-sd-scope').value;
    const gutter  = (scope==='roof'||scope==='roof_wall')
      ? document.getElementById('wf-sd-gutter').value : null;
    const skylight = (scope==='roof'||scope==='roof_wall')
      ? document.getElementById('wf-sd-skylight').checked : false;
    extra.sdScope   = scope;
    extra.sdGutter  = gutter;
    extra.sdSkylight = skylight;
    firstStage = 'ed_draft';
  } else if(type === 'Civil Defense'){
    extra.sdScope = null; extra.sdGutter = null; extra.sdSkylight = null;
    firstStage = 'cd_draft';
  } else {
    // typed workflow types (AC, PU, PF, PA, FA, PFA, FJ, SDI, SDR, BOM, Other)
    extra.sdScope = null; extra.sdGutter = null; extra.sdSkylight = null;
    const typedCfg = TYPED_WORKFLOW[type];
    if(typedCfg){
      firstStage = typedCfg.draftStage;
    } else {
      // BOM / Other stubs — mark complete immediately
      firstStage = 'completed';
      extra.status = 'completed';
      extra.completed = Date.now();
    }
  }

  const _scopeLabels = {
    roof:'Roof Only', wall:'Wall Only', roof_wall:'Roof + Wall', both:'Roof + Wall',
  };
  const scopeLabel = extra.sdScope ? (_scopeLabels[extra.sdScope]||'')
    : extra.prScope ? (_scopeLabels[extra.prScope]||'')
    : extra.flScope ? (_scopeLabels[extra.flScope]||'')
    : '';

  const proceed = async () => {
  await wfAdvance(j.id, firstStage, {
    action:'assigned', checklist:_wfCtx.checklist, owner:memberId, drafterId:memberId,
    note:`Assigned to ${member?.name} as ${type}${scopeLabel?' ('+scopeLabel+')':''}`,
    extra,
  });
  await addEvent(j.id,'wf_assigned',
    `🧭 ${me.name} assigned ${type}${scopeLabel?' ('+scopeLabel+')':''} to ${member?.name}`,'yellow');
  pushNotif(memberId,'🧺 New Workflow Job',
    `${j.client} (#${j.jobNum}) — ${type}${scopeLabel?' · '+scopeLabel:''}.`);
  _wfMail('wf_assigned',
    {drafterId:memberId, wfCreatedBy:j.wfCreatedBy},
    `📥 Basket Job Assigned — ${j.client} (#${j.jobNum})`,
    `${me.name} assigned "${type}" to ${member?.name}.\n\nClient: ${j.client}\nJob #: ${j.jobNum}\nType: ${type}${scopeLabel?' · '+scopeLabel:''}`);
  window.wfCloseModal();
  showToastMsg(`✅ Assigned to ${member?.name}.`);
  renderJobBasket();
  }; // end proceed

  // BOM / Other complete instantly — warn TL before committing
  if(firstStage === 'completed'){
    showConfirm(
      `⚠️ "${type}" — No Pipeline Stages`,
      `This job type has no workflow stages and will be marked completed immediately upon assignment.\n\nAre you sure you want to assign "${type}" to ${member?.name}?`,
      proceed,
      'Assign & Complete',
      true
    );
  } else {
    await proceed();
  }
};

// ── REASSIGN DRAFTER (TL-only, any active drafter stage) ─────────────────────
window.wfReassignDrafter = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  if(me.id !== j.teamLeaderId) return;
  const members = users.filter(u => u.teamId === me.teamId && (u.role === 'employee' || u.role === 'drafter'));
  if(!members.length){ showToastMsg('No team members available.'); return; }
  const currentDrafter = users.find(u => u.id === j.drafterId);
  wfShowModal(`Reassign Drafter — ${esc(j.client)} #${esc(j.jobNum)}`,
    `<p style="font-size:0.85rem;color:var(--text2);margin:0 0 0.75rem;">Current drafter: <strong>${esc(currentDrafter?.name||'—')}</strong></p>
    <label class="wf-f">Reassign to
      <select id="wf-reassign-member">
        ${members.filter(m=>m.id!==j.drafterId).map(m=>`<option value="${m.id}">${esc(m.name)}</option>`).join('')}
      </select>
    </label>
    <div class="wf-q-actions">
      <button class="wf-btn-no" onclick="wfCloseModal()">Cancel</button>
      <button class="wf-btn-yes" onclick="wfConfirmReassignDrafter('${jobId}')">Reassign</button>
    </div>`);
};
window.wfConfirmReassignDrafter = async function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  const newId = document.getElementById('wf-reassign-member')?.value; if(!newId) return;
  const newDrafter = users.find(u => u.id === newId);
  const oldDrafter = users.find(u => u.id === j.drafterId);
  await updateJob(jobId, {drafterId: newId, owner: newId, status:'pending', started:null});
  await addEvent(jobId,'wf_assigned',
    `🔄 ${me.name} reassigned drafter from ${oldDrafter?.name||'—'} to ${newDrafter?.name||'—'}`,'yellow');
  if(oldDrafter) pushNotif(oldDrafter.id,'🔄 Reassigned',
    `You have been removed from ${j.client} (#${j.jobNum}). ${me.name} reassigned it.`);
  pushNotif(newId,'🧺 New Workflow Job',
    `${j.client} (#${j.jobNum}) — ${j.type||''} reassigned to you by ${me.name}.`);
  wfCloseModal();
  showToastMsg(`✅ Reassigned to ${newDrafter?.name}.`);
  renderJobBasket();
};

// ── SD · DRAFTER: START JOB ───────────────────────────────────────────────────
window.wfStart = async function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  await updateJob(jobId, {status:'ongoing', started: j.started || Date.now()});
  await addEvent(jobId,'started',`${me.name} started the job`,'blue');
  // basket: explicitly notify TL (standard notifyTeamLeaderOf relies on user-profile data)
  if(j.workflow && j.teamLeaderId && me.id !== j.teamLeaderId)
    pushNotif(j.teamLeaderId,'▶ Task Started',
      `${me.name} started working on ${j.client} (#${j.jobNum}).`);
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
    const next = (s === 'wall' || s === 'roof_wall') ? 'sd_wall_draft' : 'sd_send_to_client';
    const nextOwner = (s === 'roof') ? j.teamLeaderId : j.drafterId;
    await wfAdvance(j.id, next, {
      action:'roof_approved', checklist:_wfCtx.checklist, owner:nextOwner,
      note:'Roof phase approved',
    });
    await addEvent(j.id,'wf_roof_approved',`🟢 ${me.name} approved roof phase`,'green');
    if(s !== 'roof'){
      pushNotif(j.drafterId,'🟢 Roof Approved',
        `${j.client} (#${j.jobNum}) — continue with wall layout.`);
    } else {
      pushNotif(j.drafterId,'🟢 Roof Approved',
        `${j.client} (#${j.jobNum}) — roof phase approved, awaiting client.`);
    }
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
    _wfMail('wf_rejected', j, `🔴 Basket Rejection — ${j.client} (#${j.jobNum})`,
      `${me.name} rejected Roof Phase.\n\nClient: ${j.client}\nJob #: ${j.jobNum}\nNote: ${note||'—'}`);
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
    await wfAdvance(j.id,'sd_send_to_client',{
      action:'wall_approved', checklist:_wfCtx.checklist, owner:j.teamLeaderId,
      note:'Wall phase approved — ready to send to client',
    });
    await addEvent(j.id,'wf_wall_approved',
      `🟢 ${me.name} approved wall phase — ready to send to client`,'green');
    showToastMsg('✅ Wall phase approved. Send to client when ready.');
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
    _wfMail('wf_rejected', j, `🔴 Basket Rejection — ${j.client} (#${j.jobNum})`,
      `${me.name} rejected Wall Phase.\n\nClient: ${j.client}\nJob #: ${j.jobNum}\nNote: ${note||'—'}`);
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
    _wfMail('wf_rejected', j, `🔴 Basket Rejection — ${j.client} (#${j.jobNum})`,
      `${me.name} rejected SD Revision.\n\nClient: ${j.client}\nJob #: ${j.jobNum}\nNote: ${note||'—'}`);
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
  wfAsk('Submit Job Cards — Self Check', QC5(), async(ans)=>{
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
  wfAsk('Close Job — Final QC', QC5(), async(ans)=>{
    await wfAdvance(jobId,'sd_prod_submit',{
      action:'jobcard_approved', checklist:ans, owner:j.teamLeaderId,
      note:'Job cards approved — ready for production submission',
    });
    await addEvent(jobId,'wf_prod_submit',`✅ ${me.name} approved job cards — submit to production`,'blue');
    pushNotif(j.teamLeaderId,'📋 Job Cards Approved',
      `${j.client} (#${j.jobNum}) — submit to production when ready.`);
    showToastMsg('✅ Job cards approved. Submit to production next.');
    renderJobBasket();
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
    extra:{completed:null, reopenType},
  });
  await addEvent(j.id,'wf_release',`♻️ ${me.name} reopened for ${reopenType} → ${who?.name}`,'blue');
  pushNotif(memberId,`♻️ ${reopenType}`,`${j.client} (#${j.jobNum}) — assigned for ${reopenType}.`);
  window.wfCloseModal();
  showToastMsg(`✅ Reopened for ${reopenType}, assigned to ${who?.name}.`);
  renderJobBasket();
};

window.wfSubmitRelease = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  wfAsk('Submit — Final QC', QC5(), async(ans)=>{
    await wfAdvance(jobId,'completed',{
      action:'release_completed', checklist:ans, owner:j.teamLeaderId,
      note:`${j.reopenType||'Release'} completed`, statusComplete:true,
    });
    await addEvent(jobId,'completed',
      `✅ ${me.name} completed ${j.reopenType||'release'}`,'green');
    pushNotif(j.teamLeaderId,'✅ Done',
      `${j.client} (#${j.jobNum}) — ${j.reopenType||'release'} completed by ${me.name}.`);
    if(j.wfCreatedBy) pushNotif(j.wfCreatedBy,'✅ Job Completed',
      `${j.client} (#${j.jobNum}) — ${j.reopenType||'release'} done.`);
    _wfMail('wf_completed', j, `✅ Basket Job Completed — ${j.client} (#${j.jobNum})`,
      `${j.reopenType||'Release'} completed by ${me.name}.\n\nClient: ${j.client}\nJob #: ${j.jobNum}`);
    showToastMsg('🎉 Completed.');
    renderJobBasket();
  },(q)=>{ showToastMsg('All QC checks must pass before submitting.'); });
};

// ── SD · TL: SEND TO CLIENT ───────────────────────────────────────────────────
window.wfSendToClient = async function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  await wfAdvance(jobId,'sd_client_wait',{
    action:'sent_to_client', owner:j.teamLeaderId,
    note:'Shop drawing sent to client — awaiting approval',
  });
  await addEvent(jobId,'wf_sent_to_client',`📨 ${me.name} sent shop drawing to client`,'orange');
  showToastMsg('📨 Sent to client. Awaiting approval.');
  renderJobBasket();
};

// ── SD · TL: SUBMIT TO PRODUCTION ─────────────────────────────────────────────
window.wfSubmitToProduction = async function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  await _wfAssignBOM(jobId, null);
};

async function _wfAssignBOM(jobId, note){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  const drafter = users.find(u => u.id === j.drafterId);
  const load = memberLoad(j.drafterId||'');
  if(load >= 3){
    const dls = jobs.filter(x=>x.owner===j.drafterId&&x.status!=='completed'&&x.deadline)
      .map(x=>fmt(x.deadline)).slice(0,3);
    _wfCtx = {jobId, pendingNote:note};
    wfModalHtml(`
      <div class="wf-q-title">BOM Assignment — Heads Up</div>
      <div class="wf-q-text" style="font-size:0.86rem;">
        <strong>${esc(drafter?.name||'Drafter')}</strong> has
        <strong>${load}</strong> active task${load>1?'s':''}
        ${dls.length?`with upcoming deadlines: ${dls.join(', ')}`:''}.
      </div>
      <div class="wf-q-actions">
        <button class="wf-btn-no" onclick="wfReassignBOM()">↻ Reassign to freest</button>
        <button class="wf-btn-yes" onclick="wfProceedBOM('${j.drafterId}')">
          Proceed with ${esc((drafter?.name||'').split(' ')[0])}
        </button>
      </div>`);
  } else {
    await _wfProceedAssignBOM(jobId, j.drafterId, note);
  }
}
window.wfReassignBOM = function(){
  const j = jobs.find(x => x.id === _wfCtx.jobId); if(!j) return;
  const next = freestMember(j.teamLeaderId, j.drafterId);
  if(!next){ showToastMsg('No other team member available.'); return; }
  window.wfCloseModal();
  _wfProceedAssignBOM(j.id, next.id, _wfCtx.pendingNote);
};
window.wfProceedBOM = function(drafterId){
  const j = jobs.find(x => x.id === _wfCtx.jobId); if(!j) return;
  window.wfCloseModal();
  _wfProceedAssignBOM(j.id, drafterId, _wfCtx.pendingNote);
};
async function _wfProceedAssignBOM(jobId, drafterId, note){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  const who = users.find(u => u.id === drafterId);
  await wfAdvance(jobId,'sd_bom',{
    action:'bom_assigned', owner:drafterId, drafterId,
    note:`BOM assigned to ${who?.name}${note?' — '+note:''}`,
  });
  await addEvent(jobId,'wf_bom',`📋 ${me.name} submitted to production & assigned BOM to ${who?.name}`,'blue');
  pushNotif(drafterId,'📋 BOM Preparation',
    `${j.client} (#${j.jobNum}) — job cards approved, prepare Bill of Materials.`);
  showToastMsg(`✅ BOM assigned to ${who?.name}.`);
  renderJobBasket();
}

// ── SD BOM / ERECTION CHECKLISTS ─────────────────────────────────────────────
const _BOM_DRAFTER_BASE = _regDefault('bomDrafter', [
  {q:'Did you prepare the Bill of Materials document?',     key:'bomDoc'},
  {q:'Did you check all material quantities?',              key:'quantities'},
  {q:'Did you check material specifications?',              key:'specs'},
  {q:'Did you cross-check with the job card data?',         key:'jobCardCheck'},
  {q:'Did you check the part marks?',                       key:'partMarks'},
]);
const BOM_DRAFTER_CHECKLIST = ()=>getWfQ('bomDrafter', _BOM_DRAFTER_BASE);
const _BOM_TL_BASE = _regDefault('bomTL', [
  {q:'Did you verify all material quantities?',             key:'quantities'},
  {q:'Did you check material specifications?',              key:'specs'},
  {q:'Did you check the part marks match the job card?',    key:'partMarks'},
  {q:'Did you verify the BOM against the shop drawings?',   key:'sdCheck'},
  {q:'Did you confirm no items are missing?',               key:'completeness'},
]);
const BOM_TL_CHECKLIST = ()=>getWfQ('bomTL', _BOM_TL_BASE);
const _ERECTION_DRAFTER_BASE = _regDefault('erectionDrafter', [
  {q:'Did you prepare the erection sequence drawings?',     key:'erectionSeq'},
  {q:'Did you check panel placement and orientation?',      key:'panelOrientation'},
  {q:'Did you check all dimensions?',                       key:'dimensions'},
  {q:'Did you include all fixing details?',                 key:'fixingDetails'},
  {q:'Did you verify against the approved shop drawing?',   key:'sdVerify'},
]);
const SD_ERECTION_DRAFTER_CHECKLIST = ()=>getWfQ('erectionDrafter', _ERECTION_DRAFTER_BASE);
const _ERECTION_TL_BASE = _regDefault('erectionTL', [
  {q:'Did you check the erection sequence?',                key:'erectionSeq'},
  {q:'Did you check panel placement and orientation?',      key:'panelOrientation'},
  {q:'Did you check all dimensions?',                       key:'dimensions'},
  {q:'Did you check fixing details?',                       key:'fixingDetails'},
  {q:'Did you verify against the approved shop drawing?',   key:'sdVerify'},
]);
const SD_ERECTION_TL_CHECKLIST = ()=>getWfQ('erectionTL', _ERECTION_TL_BASE);

// ── SD · DRAFTER: SUBMIT BOM ──────────────────────────────────────────────────
window.wfSubmitBOM = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  wfAsk('Submit BOM — Self Check', BOM_DRAFTER_CHECKLIST(), async(ans)=>{
    await wfAdvance(jobId,'sd_bom_review',{
      action:'bom_submitted', checklist:ans, owner:j.teamLeaderId,
      note:'BOM self-checked & submitted for TL review',
    });
    await addEvent(jobId,'wf_bom_review',`📋 ${me.name} submitted BOM for review`,'purple');
    pushNotif(j.teamLeaderId,'📋 BOM Ready',
      `${j.client} (#${j.jobNum}) — review Bill of Materials.`);
    showToastMsg('✅ BOM sent to team leader.');
    renderJobBasket();
  },(q)=>{ showToastMsg('Complete every check before submitting BOM.'); });
};

// ── SD · TL: REVIEW BOM ───────────────────────────────────────────────────────
window.wfReviewBOM = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  wfAsk('Review BOM', BOM_TL_CHECKLIST(), (ans)=>{
    _wfCtx = {jobId, checklist:ans};
    wfShowDecision(j,
      'Approve → auto-assign Erection Drawing. Reject (comment required) → drafter fixes & resubmits.',
      'wfDecideBOM', true);
  },(q)=>{ showToastMsg('Complete the checklist before reviewing.'); });
};
window.wfDecideBOM = async function(approve){
  const j = jobs.find(x => x.id === _wfCtx.jobId); if(!j) return;
  const note = document.getElementById('wf-reject-note')?.value.trim() || null;
  if(!approve && !note){ alert('A comment is required when rejecting.'); return; }
  if(approve){
    window.wfCloseModal();
    await _wfAssignSDErection(j.id, 'BOM approved — auto-assigning Erection Drawing');
  } else {
    const rejCount = (j.rejectionCount||0) + 1;
    await wfAdvance(j.id,'sd_bom',{
      action:'bom_rejected', checklist:_wfCtx.checklist, owner:j.drafterId,
      note:note, extra:{rejectionCount:rejCount, lastRejectNote:note, lastRejectPhase:'bom'},
    });
    await addEvent(j.id,'wf_bom_rejected',
      `🔴 ${me.name} rejected BOM (rejection #${rejCount}) — ${note}`,'red');
    pushNotif(j.drafterId,'🔴 BOM Rejected',
      `${j.client} (#${j.jobNum}) — fix & resubmit. Note: ${note}`);
    _wfMail('wf_rejected', j, `🔴 Basket Rejection — ${j.client} (#${j.jobNum})`,
      `${me.name} rejected BOM.\n\nClient: ${j.client}\nJob #: ${j.jobNum}\nNote: ${note||'—'}`);
    showToastMsg('Sent back for fixes.');
    window.wfCloseModal();
    renderJobBasket();
  }
};

async function _wfAssignSDErection(jobId, note){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  const drafter = users.find(u => u.id === j.drafterId);
  const load = memberLoad(j.drafterId||'');
  if(load >= 3){
    const dls = jobs.filter(x=>x.owner===j.drafterId&&x.status!=='completed'&&x.deadline)
      .map(x=>fmt(x.deadline)).slice(0,3);
    _wfCtx = {jobId, pendingNote:note};
    wfModalHtml(`
      <div class="wf-q-title">Erection Drawing Assignment — Heads Up</div>
      <div class="wf-q-text" style="font-size:0.86rem;">
        <strong>${esc(drafter?.name||'Drafter')}</strong> has
        <strong>${load}</strong> active task${load>1?'s':''}
        ${dls.length?`with upcoming deadlines: ${dls.join(', ')}`:''}.
      </div>
      <div class="wf-q-actions">
        <button class="wf-btn-no" onclick="wfReassignSDErection()">↻ Reassign to freest</button>
        <button class="wf-btn-yes" onclick="wfProceedSDErection('${j.drafterId}')">
          Proceed with ${esc((drafter?.name||'').split(' ')[0])}
        </button>
      </div>`);
  } else {
    await _wfProceedAssignSDErection(jobId, j.drafterId, note);
  }
}
window.wfReassignSDErection = function(){
  const j = jobs.find(x => x.id === _wfCtx.jobId); if(!j) return;
  const next = freestMember(j.teamLeaderId, j.drafterId);
  if(!next){ showToastMsg('No other team member available.'); return; }
  window.wfCloseModal();
  _wfProceedAssignSDErection(j.id, next.id, _wfCtx.pendingNote);
};
window.wfProceedSDErection = function(drafterId){
  const j = jobs.find(x => x.id === _wfCtx.jobId); if(!j) return;
  window.wfCloseModal();
  _wfProceedAssignSDErection(j.id, drafterId, _wfCtx.pendingNote);
};
async function _wfProceedAssignSDErection(jobId, drafterId, note){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  const who = users.find(u => u.id === drafterId);
  await wfAdvance(jobId,'sd_erection_draft',{
    action:'erection_assigned', owner:drafterId, drafterId,
    note:`Erection drawing assigned to ${who?.name}${note?' — '+note:''}`,
  });
  await addEvent(jobId,'wf_erection_draft',`📐 ${me.name} assigned erection drawing to ${who?.name}`,'yellow');
  pushNotif(drafterId,'📐 Erection Drawing',
    `${j.client} (#${j.jobNum}) — BOM approved, prepare Erection Drawing.`);
  showToastMsg(`✅ Erection drawing assigned to ${who?.name}.`);
  renderJobBasket();
}

// ── SD · DRAFTER: SUBMIT ERECTION DRAWING ─────────────────────────────────────
window.wfSubmitSDErection = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  wfAsk('Submit Erection Drawing — Self Check', SD_ERECTION_DRAFTER_CHECKLIST(), async(ans)=>{
    await wfAdvance(jobId,'sd_erection_review',{
      action:'erection_submitted', checklist:ans, owner:j.teamLeaderId,
      note:'Erection drawing self-checked & submitted for TL review',
    });
    await addEvent(jobId,'wf_erection_review',`📐 ${me.name} submitted erection drawing for review`,'purple');
    pushNotif(j.teamLeaderId,'📐 Erection Drawing Ready',
      `${j.client} (#${j.jobNum}) — review Erection Drawing.`);
    showToastMsg('✅ Erection drawing sent to team leader.');
    renderJobBasket();
  },(q)=>{ showToastMsg('Complete every check before submitting erection drawing.'); });
};

// ── SD · TL: REVIEW ERECTION DRAWING ─────────────────────────────────────────
window.wfReviewSDErection = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  wfAsk('Review Erection Drawing', SD_ERECTION_TL_CHECKLIST(), (ans)=>{
    _wfCtx = {jobId, checklist:ans};
    wfShowDecision(j,
      'Approve → job completed (eligible for continuation or permanent close). Reject (comment required) → drafter fixes & resubmits.',
      'wfDecideSDErection', true);
  },(q)=>{ showToastMsg('Complete the checklist before reviewing.'); });
};
window.wfDecideSDErection = async function(approve){
  const j = jobs.find(x => x.id === _wfCtx.jobId); if(!j) return;
  const note = document.getElementById('wf-reject-note')?.value.trim() || null;
  if(!approve && !note){ alert('A comment is required when rejecting.'); return; }
  if(approve){
    await wfAdvance(j.id,'completed',{
      action:'erection_approved', checklist:_wfCtx.checklist,
      note:'Erection drawing approved — job completed',
      statusComplete:true, extra:{releaseEligible:true},
    });
    await addEvent(j.id,'completed',`✅ ${me.name} approved erection drawing — job completed`,'green');
    if(j.drafterId)   pushNotif(j.drafterId,'✅ Job Completed',
      `${j.client} (#${j.jobNum}) — erection drawing approved.`);
    if(j.wfCreatedBy) pushNotif(j.wfCreatedBy,'✅ Job Completed',
      `${j.client} (#${j.jobNum}) — your basket job is done.`);
    _wfMail('wf_completed', j, `✅ Basket Job Completed — ${j.client} (#${j.jobNum})`,
      `Erection drawing approved by ${me.name}.\n\nClient: ${j.client}\nJob #: ${j.jobNum}`);
    showToastMsg('🎉 Erection drawing approved — job completed.');
    window.wfCloseModal();
    renderJobBasket();
    setTimeout(()=>_wfAskSampleExpectation(j.id), 400);
  } else {
    const rejCount = (j.rejectionCount||0) + 1;
    await wfAdvance(j.id,'sd_erection_draft',{
      action:'erection_rejected', checklist:_wfCtx.checklist, owner:j.drafterId,
      note:note, extra:{rejectionCount:rejCount, lastRejectNote:note, lastRejectPhase:'erection'},
    });
    await addEvent(j.id,'wf_erection_rejected',
      `🔴 ${me.name} rejected erection drawing (rejection #${rejCount}) — ${note}`,'red');
    pushNotif(j.drafterId,'🔴 Erection Drawing Rejected',
      `${j.client} (#${j.jobNum}) — fix & resubmit. Note: ${note}`);
    _wfMail('wf_rejected', j, `🔴 Basket Rejection — ${j.client} (#${j.jobNum})`,
      `${me.name} rejected Erection Drawing.\n\nClient: ${j.client}\nJob #: ${j.jobNum}\nNote: ${note||'—'}`);
    showToastMsg('Sent back for fixes.');
    window.wfCloseModal();
    renderJobBasket();
  }
};

// ── COMPLETE & CLOSE (permanent — no further releases) ────────────────────────
window.wfCloseJobFinal = function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  wfModalHtml(`
    <div class="wf-q-title">Complete & Close — ${esc(j.client)} <span class="tc-muted">#${esc(j.jobNum)}</span></div>
    <div class="wf-q-text" style="font-size:0.82rem;color:var(--text2);">
      This permanently closes the job. No further releases or continuations will be possible.
    </div>
    <div class="wf-q-actions">
      <button class="wf-btn-no" onclick="wfCloseModal()">Cancel</button>
      <button class="wf-btn-yes" onclick="wfConfirmCloseFinal('${jobId}')">🔒 Complete & Close</button>
    </div>`);
};
window.wfConfirmCloseFinal = async function(jobId){
  const j = jobs.find(x => x.id === jobId); if(!j) return;
  await updateJob(jobId, {sdClosed:true, releaseEligible:false});
  await addEvent(jobId,'wf_closed_final',`🔒 ${me.name} permanently closed the job`,'green');
  window.wfCloseModal();
  showToastMsg('🔒 Job permanently closed.');
  renderJobBasket();
};

// ── TAB RESOLVER (for notification navigation) ────────────────────────────────
window.wfTabForJob = function(job){
  if(!job || !me) return null;
  if(job.stage === 'completed') return 'done';
  const r = me.role;
  if(r === 'team_leader'){
    return wfActionFor(job) ? 'queue' : 'team';
  }
  if(r === 'sales_operation') return 'active';
  if(r === 'manager' || r === 'supervisor' || amDirector()) return 'overview';
  // drafter/employee
  return wfActionFor(job) ? 'tasks' : 'submitted';
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
  if(j.stage === 'sd_tl_roof_review' && amTL){
    if(j.status === 'pending') return {label:'▶ Start Review', fn:`wfStart('${j.id}')`, cls:'primary'};
    return {label:'🔍 Review Roof Phase', fn:`wfReviewRoof('${j.id}')`, cls:'primary'};
  }

  // wall phase
  if(j.stage === 'sd_wall_draft' && amDrafter){
    if(j.status === 'pending') return {label:'▶ Start Job', fn:`wfStart('${j.id}')`, cls:'primary'};
    return {label:'🧱 Submit Wall Layout & Flashings', fn:`wfSubmitWallPhase('${j.id}')`, cls:'primary'};
  }
  if(j.stage === 'sd_tl_wall_review' && amTL){
    if(j.status === 'pending') return {label:'▶ Start Review', fn:`wfStart('${j.id}')`, cls:'primary'};
    return {label:'🔍 Review Wall Phase', fn:`wfReviewWall('${j.id}')`, cls:'primary'};
  }

  // send-to-client step
  if(j.stage === 'sd_send_to_client' && amTL)
    return {label:'📨 Send to Client', fn:`wfSendToClient('${j.id}')`, cls:'primary'};

  // client wait
  if(j.stage === 'sd_client_wait' && amTL)
    return {label:'📋 Record Client Decision', fn:`wfRecordClientDecision('${j.id}')`, cls:'primary'};

  // revision
  if(j.stage === 'sd_revision_draft' && amDrafter){
    if(j.status === 'pending') return {label:'▶ Start Revision', fn:`wfStart('${j.id}')`, cls:'primary'};
    return {label:'📝 Submit Revision', fn:`wfSubmitRevision('${j.id}')`, cls:'primary'};
  }
  if(j.stage === 'sd_tl_revision_review' && amTL){
    if(j.status === 'pending') return {label:'▶ Start Review', fn:`wfStart('${j.id}')`, cls:'primary'};
    return {label:'🔍 Review Revision', fn:`wfReviewRevision('${j.id}')`, cls:'primary'};
  }

  // job card
  if(j.stage === 'sd_jobcard' && amDrafter){
    if(j.status === 'pending') return {label:'▶ Start Job Cards', fn:`wfStart('${j.id}')`, cls:'primary'};
    return {label:'🗂 Submit Job Cards', fn:`wfSubmitJobCard('${j.id}')`, cls:'primary'};
  }
  if(j.stage === 'sd_tl_jobcard_review' && amTL){
    if(j.status === 'pending') return {label:'▶ Start Review', fn:`wfStart('${j.id}')`, cls:'primary'};
    return {label:'🏁 Review & Close', fn:`wfCloseJobCard('${j.id}')`, cls:'primary'};
  }
  // SD post-job-card pipeline
  if(j.stage === 'sd_prod_submit' && amTL)
    return {label:'🏭 Submit to Production', fn:`wfSubmitToProduction('${j.id}')`, cls:'primary'};
  if(j.stage === 'sd_bom' && amDrafter){
    if(j.status === 'pending') return {label:'▶ Start BOM', fn:`wfStart('${j.id}')`, cls:'primary'};
    return {label:'📋 Submit BOM', fn:`wfSubmitBOM('${j.id}')`, cls:'primary'};
  }
  if(j.stage === 'sd_bom_review' && amTL){
    if(j.status === 'pending') return {label:'▶ Start BOM Review', fn:`wfStart('${j.id}')`, cls:'primary'};
    return {label:'🔍 Review BOM', fn:`wfReviewBOM('${j.id}')`, cls:'primary'};
  }
  if(j.stage === 'sd_erection_draft' && amDrafter){
    if(j.status === 'pending') return {label:'▶ Start Erection Drawing', fn:`wfStart('${j.id}')`, cls:'primary'};
    return {label:'📐 Submit Erection Drawing', fn:`wfSubmitSDErection('${j.id}')`, cls:'primary'};
  }
  if(j.stage === 'sd_erection_review' && amTL){
    if(j.status === 'pending') return {label:'▶ Start Erection Review', fn:`wfStart('${j.id}')`, cls:'primary'};
    return {label:'🔍 Review Erection Drawing', fn:`wfReviewSDErection('${j.id}')`, cls:'primary'};
  }

  // completed
  if(j.stage === 'completed' && amTL && j.releaseEligible){
    const reopen = {label:'♻️ Reopen for Continuation', fn:`wfReopenJob('${j.id}')`, cls:'sec'};
    if(j.type === 'Shop Drawing' && !j.sdClosed)
      return {...reopen, secondAction:{label:'🔒 Complete & Close', fn:`wfCloseJobFinal('${j.id}')`, cls:'sec'}};
    return reopen;
  }

  // panels release
  if(j.stage === 'pr_draft' && amDrafter){
    if(j.status === 'pending') return {label:'▶ Start Job', fn:`wfStart('${j.id}')`, cls:'primary'};
    return {label:'📦 Submit Panels Release', fn:`wfSubmitPR('${j.id}')`, cls:'primary'};
  }
  if(j.stage === 'pr_tl_review' && amTL){
    if(j.status === 'pending') return {label:'▶ Start Review', fn:`wfStart('${j.id}')`, cls:'primary'};
    return {label:'🔍 Review Panels Release', fn:`wfReviewPR('${j.id}')`, cls:'primary'};
  }

  // flashings release
  if(j.stage === 'fl_draft' && amDrafter){
    if(j.status === 'pending') return {label:'▶ Start Job', fn:`wfStart('${j.id}')`, cls:'primary'};
    return {label:'🔩 Submit Flashings Release', fn:`wfSubmitFL('${j.id}')`, cls:'primary'};
  }
  if(j.stage === 'fl_tl_review' && amTL){
    if(j.status === 'pending') return {label:'▶ Start Review', fn:`wfStart('${j.id}')`, cls:'primary'};
    return {label:'🔍 Review Flashings Release', fn:`wfReviewFL('${j.id}')`, cls:'primary'};
  }

  // release (reopen)
  if(j.stage === 'release' && amDrafter){
    if(j.status === 'pending') return {label:'▶ Start Release', fn:`wfStart('${j.id}')`, cls:'primary'};
    return {label:'📦 Submit Release', fn:`wfSubmitRelease('${j.id}')`, cls:'primary'};
  }

  // generic typed workflow
  const typedCfg = TYPED_WORKFLOW[j.type];
  if(typedCfg){
    if(j.stage === typedCfg.draftStage && amDrafter){
      if(j.status === 'pending') return {label:'▶ Start Job', fn:`wfStart('${j.id}')`, cls:'primary'};
      return {label:`📤 Submit ${j.type}`, fn:`wfSubmitType('${j.id}')`, cls:'primary'};
    }
    if(j.stage === typedCfg.reviewStage && amTL){
      if(j.status === 'pending') return {label:'▶ Start Review', fn:`wfStart('${j.id}')`, cls:'primary'};
      return {label:`🔍 Review ${j.type}`, fn:`wfReviewType('${j.id}')`, cls:'primary'};
    }
  }

  // civil defense
  if(j.stage === 'cd_draft' && amDrafter){
    if(j.status === 'pending') return {label:'▶ Start Job', fn:`wfStart('${j.id}')`, cls:'primary'};
    return {label:'🏛 Submit to Civil Defense', fn:`wfSubmitCD('${j.id}')`, cls:'primary'};
  }
  if(j.stage === 'cd_pending' && amTL)
    return {label:'🏛 Record Civil Defense Response', fn:`wfRecordCDResponse('${j.id}')`, cls:'primary'};

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
  pr_draft:'#ff9f0a',           pr_tl_review:'#bf5af2',
  fl_draft:'#64d2ff',           fl_tl_review:'#30d158',
  ac_draft:'#ffd60a',           ac_tl_review:'#bf5af2',
  pu_draft:'#ff9f0a',           pu_tl_review:'#5e5ce6',
  pf_draft:'#0a84ff',           pf_tl_review:'#bf5af2',
  pa_draft:'#30d158',           pa_tl_review:'#5e5ce6',
  fa_draft:'#64d2ff',           fa_tl_review:'#30d158',
  pfa_draft:'#ff6961',          pfa_tl_review:'#bf5af2',
  fj_draft:'#ffd60a',           fj_tl_review:'#5e5ce6',
  sdi_draft:'#ff9f0a',          sdi_tl_review:'#bf5af2',
  sdr_draft:'#ff453a',          sdr_tl_review:'#ff6961',
  ed_draft:'#0a84ff',           ed_tl_review:'#30d158',
  cd_draft:'#ffd60a',           cd_pending:'#ff9f0a',
  sd_send_to_client:'#ff9f0a',
  sd_prod_submit:'#5ac8fa',
  sd_bom:'#0a84ff',             sd_bom_review:'#bf5af2',
  sd_erection_draft:'#30d158',  sd_erection_review:'#ffd60a',
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
  const scopeMap = {roof:'Roof Only', wall:'Wall Only', roof_wall:'Roof + Wall',
                    both:'Roof + Wall'};
  const prScopeMap = {roof:'Roof Panels', wall:'Wall Panels', both:'Roof + Wall Panels'};
  const flScopeMap = {roof:'Roof Flashings', wall:'Wall Flashings', both:'Roof + Wall Flashings'};
  const scopeBdg = j.sdScope
    ? `<span class="wf-scope-bdg">${esc(scopeMap[j.sdScope]||j.sdScope)}</span>`
    : j.prScope
    ? `<span class="wf-scope-bdg">${esc(prScopeMap[j.prScope]||j.prScope)}</span>`
    : j.flScope
    ? `<span class="wf-scope-bdg">${esc(flScopeMap[j.flScope]||j.flScope)}</span>`
    : '';
  const gutterBdg = j.sdGutter && j.sdGutter !== 'none'
    ? `<span class="wf-scope-bdg" style="opacity:0.7;">${esc(j.sdGutter==='eave_gutter'?'Eave Gutter':'Curve')}</span>` : '';
  const skylightBdg = j.sdSkylight
    ? `<span class="wf-scope-bdg" style="opacity:0.7;">🌤 Skylight</span>` : '';

  // rejection warning
  const rejBanner = j.rejectionCount
    ? `<span class="wf-rej">⚠ ${j.rejectionCount} rejection${j.rejectionCount>1?'s':''}</span>` : '';
  const _rejectStages = new Set([
    'sd_roof_draft','sd_wall_draft','sd_revision_draft',
    'sd_bom','sd_erection_draft',
    'pr_draft','fl_draft',
    'ac_draft','pu_draft','pf_draft','pa_draft','fa_draft','pfa_draft','fj_draft',
    'sdi_draft','sdr_draft','ed_draft','cd_draft',
  ]);
  const lastRejectBanner = j.lastRejectNote && _rejectStages.has(j.stage)
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

  return `<div class="wf-card" id="wf-card-${j.id}">
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
      ${act?.secondAction?`<button class="wf-act ${act.secondAction.cls}" onclick="${act.secondAction.fn}">${act.secondAction.label}</button>`:''}
      ${(me.id===j.teamLeaderId&&j.stage!=='intake'&&j.stage!=='completed'&&j.stage!=='release'&&j.drafterId)?`<button class="wf-act sec" onclick="wfReassignDrafter('${j.id}')">🔄 Reassign Drafter</button>`:''}
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
      // Stuck intake alert — jobs sitting at intake past the configured pickup window
      const intakeThresholdMs = (window._jobSettings?.deadlineSalesOpBasketHours??24) * 3600000;
      const stuckIntake = active.filter(j => j.stage === 'intake' && j.created && (Date.now()-toMillis(j.created)) > intakeThresholdMs);
      const stuckBanner = stuckIntake.length
        ? `<div class="wf-stuck-banner">⚠️ <strong>${stuckIntake.length} job${stuckIntake.length>1?'s':''} stuck at intake</strong> — no TL has picked ${stuckIntake.length>1?'them':'it'} up yet.<div class="wf-stuck-list">${stuckIntake.map(j=>`<span>${esc(j.client)} #${esc(j.jobNum)} · ${esc(users.find(u=>u.id===j.teamLeaderId)?.name||'unassigned TL')}</span>`).join('')}</div></div>`
        : '';
      content = stuckBanner + (active.length ? active.map(j=>wfCard(j,false)).join('') : '<div class="empty" style="padding:1.25rem;">No active workflow jobs.</div>');
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
