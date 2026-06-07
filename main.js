// ── RMI Task Allocator — main module ──────────────────────────────────────────
// Entry point. Imports shared leaves (firebase / state / helpers / email),
// holds all app logic + bootstrap. Loaded via <script type="module" src="main.js">.
import { initializeApp, getFirestore, collection, doc, setDoc, addDoc, updateDoc, deleteDoc, deleteField, onSnapshot, getDocs, getDoc, query, where, limit, writeBatch, getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail, getStorage, ref, uploadBytes, getDownloadURL, deleteObject, CFG, MGR_PW, USE_FIREBASE, USE_AUTH } from './firebase.js';
import { JOB_TYPES, ACTIVITY_TYPE_LABELS, FB_LIMITS, JOBS_PAGE_SIZE, ARCHIVE_AFTER_MS, DEFAULT_SETTINGS, NOTIF_BUBBLE_TTL, NOTIF_TOAST_MAX, jobs, users, events, notifications, extRequests, broadcasts, activityLogs, me, myFilter, lastDel, isDark, currentATab, userSettings, setMe, setJobs, setUsers, setEvents, setNotifications, setExtRequests, setBroadcasts, setActivityLogs, setMyFilter, setLastDel, setIsDark, setCurrentATab, setUserSettings } from './state.js';
import { lsub, toMillis, escapeHtml, fmt, fmtShort, tdiff, getJobPausedMs, getJobDurationBreakdown, formatJobDurationHtml, jobPauseDefaults, uid, timeAgo } from './helpers.js';
import { sendEmail, emailPref, emailUser, emailJobOwner, emailManagersAndSupervisors, emailTeamLeaderOf, emailAllOversight, emailEventOwner, emailEventOwnerId, emailEventTeamLeader, emailEventManagers, emailEventSupervisors, emailEventOversight } from './email.js';
import { tagStores } from './state.js';
import { EMAIL_EVENTS, EMAIL_RECIPS, defaultEmailConfig, emailConfig, setEmailConfig, BRANCHES } from './state.js';
import { renderTags, setTags, showConfirm } from './modals.js';
import { populateCalEmpDrop, populateCalEmpPills, jobsForCalendarDay, empOverdueJobs, renderCommentSection, uAdd, uUpdate, uDelete, jUpdate, jDelete, jRestore } from './jobs.js';
import { renderUList, renderBroadcasts, updateBroadcastUI, roleMeta, markBroadcastsSeen } from './admin.js';
import { renderJobBasket, wfAnalyticsSection } from './workflow.js';

// ── MAIN-LOCAL STATE (firebase handles + UI-only mutables) ────────────────────
export let db, auth, storage, jCol, uCol, evCol, notifCol, extCol, bcastCol, logCol, authMapCol, archiveCol, cfgCol;
let authStateReady=false, authLoginInProgress=false;
export let calY=new Date().getFullYear(), calM=new Date().getMonth(), calFilterEmp='', calShowMode='all';
let selectedJobs=new Set();
let chartPrefs={bytype:{mode:'bar',showPct:true,showNum:true},bypriority:{mode:'bar',showPct:true,showNum:true}};
let knownNotifIds=new Set(), notifSoundReady=false, notifSnapshotReady=false, notifBulkClearing=false;
let fbUnsubs=[];
let notifToastTimers=new Map();

window.setF=function(f){
  setMyFilter(f);
  renderJobs();
};

// ── THEME ────────────────────────────────────────────────────────────────────
window.toggleTheme=function(){
  setIsDark(!isDark);
  document.body.classList.toggle('light-mode',!isDark);
  localStorage.setItem('rmi_theme',isDark?'dark':'light');
};

// ── EMAIL CONTROL (manager-only, org-wide, Firestore config/email) ────────────
const EMAIL_EVENT_LABELS={assigned:'Job Assigned / Reassigned',status:'Status Changes (start/pause/resume/complete)',deadline:'Deadline Soon (<24h)',overdue:'Job Overdue',extension:'Extension Requested'};
const EMAIL_RECIP_LABELS={owner:'Employee (job owner)',teamLeader:'Team Leader',supervisor:'Supervisor',manager:'Manager'};
// extension has no owner recipient (it's the requester's own action)
const EMAIL_EVENT_RECIPS={assigned:['owner','teamLeader','supervisor','manager'],status:['owner','teamLeader','supervisor','manager'],deadline:['owner','teamLeader','supervisor','manager'],overdue:['owner','teamLeader','supervisor','manager'],extension:['teamLeader','supervisor','manager']};

function mergeEmailConfig(raw){
  const cfg=defaultEmailConfig();
  if(raw&&typeof raw==='object'){
    if(raw.master===false)cfg.master=false;
    for(const e of EMAIL_EVENTS){
      const re=raw.events?.[e];if(!re)continue;
      if(re.on===false)cfg.events[e].on=false;
      for(const r of EMAIL_RECIPS)if(re[r]===false)cfg.events[e][r]=false;
    }
  }
  return cfg;
}
let emailCfgUnsub=null;
function listenEmailConfig(){
  if(!USE_FIREBASE||!cfgCol||emailCfgUnsub)return;
  emailCfgUnsub=onSnapshot(doc(cfgCol,'email'),snap=>{
    setEmailConfig(snap.exists()?mergeEmailConfig(snap.data()):defaultEmailConfig());
    if(document.getElementById('email-control-body'))renderEmailControl();
    updateEmailMasterBadge();
  },()=>{});
}
async function saveEmailConfig(){
  if(!me||me.role!=='manager'){showToastMsg('Only managers can change email settings.');return;}
  if(USE_FIREBASE&&cfgCol){
    try{await setDoc(doc(cfgCol,'email'),emailConfig);}
    catch(e){showToastMsg('Could not save — check permissions.');return;}
  }else{localStorage.setItem('rmi_email_config',JSON.stringify(emailConfig));}
}
window.toggleEmailMaster=async function(){
  if(!me||me.role!=='manager')return;
  setEmailConfig({...emailConfig,master:!(emailConfig.master!==false)});
  await saveEmailConfig();renderEmailControl();updateEmailMasterBadge();
  showToastMsg(emailConfig.master!==false?'📧 Email sending ON':'🚫 Email sending OFF (all held)');
};
window.toggleEmailEvent=async function(evt){
  if(!me||me.role!=='manager'||emailConfig.master===false)return;
  const cfg=mergeEmailConfig(emailConfig);
  cfg.events[evt].on=!(cfg.events[evt].on!==false);
  setEmailConfig(cfg);await saveEmailConfig();renderEmailControl();
};
window.toggleEmailRecip=async function(evt,recip){
  if(!me||me.role!=='manager'||emailConfig.master===false||emailConfig.events?.[evt]?.on===false)return;
  const cfg=mergeEmailConfig(emailConfig);
  cfg.events[evt][recip]=!(cfg.events[evt][recip]!==false);
  setEmailConfig(cfg);await saveEmailConfig();renderEmailControl();
};
function updateEmailMasterBadge(){
  const b=document.getElementById('sb-email-badge');if(!b)return;
  b.style.display=emailConfig.master===false?'inline-block':'none';
}
function emailSwitch(on,onclick,disabled){
  return `<button type="button" class="em-switch${on?' em-on':''}${disabled?' em-disabled':''}" ${disabled?'disabled':''} onclick="${onclick}"><span class="em-knob"></span></button>`;
}
export function renderEmailControl(){
  const body=document.getElementById('email-control-body');if(!body)return;
  if(!me||me.role!=='manager'){body.innerHTML='<div class="empty" style="padding:2rem;">Managers only.</div>';return;}
  const masterOn=emailConfig.master!==false;
  let html=`<div class="em-master ${masterOn?'em-master-on':'em-master-off'}">
    <div class="em-master-txt">
      <div class="em-master-title">${masterOn?'📧 Email Sending: ON':'🚫 Email Sending: OFF'}</div>
      <div class="em-master-sub">${masterOn?'Emails send per the rules below.':'All emails are held — nothing is sent regardless of the rules below.'}</div>
    </div>
    ${emailSwitch(masterOn,'toggleEmailMaster()',false)}
  </div>`;
  html+=`<div class="em-events ${masterOn?'':'em-locked'}">`;
  for(const evt of EMAIL_EVENTS){
    const eOn=masterOn&&emailConfig.events?.[evt]?.on!==false;
    html+=`<div class="em-event">
      <div class="em-event-hd">
        <div class="em-event-name">${EMAIL_EVENT_LABELS[evt]}</div>
        ${emailSwitch(eOn,`toggleEmailEvent('${evt}')`,!masterOn)}
      </div>
      <div class="em-recips ${eOn?'':'em-locked'}">
        ${EMAIL_EVENT_RECIPS[evt].map(r=>{
          const rOn=eOn&&emailConfig.events?.[evt]?.[r]!==false;
          return `<div class="em-recip"><span class="em-recip-lbl">${EMAIL_RECIP_LABELS[r]}</span>${emailSwitch(rOn,`toggleEmailRecip('${evt}','${r}')`,!eOn)}</div>`;
        }).join('')}
      </div>
    </div>`;
  }
  html+=`</div>`;
  body.innerHTML=html;
}

// ── LOCAL FALLBACK ────────────────────────────────────────────────────────────
export function localSave(){
  localStorage.setItem('rmi_jobs',JSON.stringify(jobs));
  localStorage.setItem('rmi_users',JSON.stringify(users));
  localStorage.setItem('rmi_events',JSON.stringify(events));
  localStorage.setItem('rmi_notifs',JSON.stringify(notifications));
  localStorage.setItem('rmi_exts',JSON.stringify(extRequests));
  localStorage.setItem('rmi_bcasts',JSON.stringify(broadcasts));
  localStorage.setItem('rmi_activitylogs',JSON.stringify(activityLogs));
}
function localLoad(){
  setUsers(JSON.parse(localStorage.getItem('rmi_users')||'[]'));
  setJobs(JSON.parse(localStorage.getItem('rmi_jobs')||'[]'));
  setEvents(JSON.parse(localStorage.getItem('rmi_events')||'[]'));
  setNotifications(JSON.parse(localStorage.getItem('rmi_notifs')||'[]'));
  setExtRequests(JSON.parse(localStorage.getItem('rmi_exts')||'[]'));
  setBroadcasts(JSON.parse(localStorage.getItem('rmi_bcasts')||'[]'));
  setActivityLogs(JSON.parse(localStorage.getItem('rmi_activitylogs')||localStorage.getItem('rmi_loginlogs')||'[]'));
  if(!users.find(u=>u.role==='manager'))users.push({id:'manager',name:'Manager',role:'manager',password:MGR_PW,email:'',viewAll:'yes'});
  localSave();
}

// ── INIT ──────────────────────────────────────────────────────────────────────
async function init(){
  // Restore theme
  const savedTheme=localStorage.getItem('rmi_theme');
  if(savedTheme==='light'){setIsDark(false);document.body.classList.add('light-mode');}

  if(!USE_FIREBASE){
    lsub('Running locally — fill in Firebase config to go online');
    setTimeout(()=>{localLoad();afterDataLoad();},800);
    return;
  }
  try{
    lsub('Connecting to Firebase...');
    const app=initializeApp(CFG);
    db=getFirestore(app);
    auth=getAuth(app);
    storage=getStorage(app);
    authMapCol=collection(db,'usersByAuth');
    archiveCol=collection(db,'jobsArchive');
    jCol=collection(db,'jobs');
    uCol=collection(db,'users');
    evCol=collection(db,'events');
    notifCol=collection(db,'notifications');
    extCol=collection(db,'extensions');
    bcastCol=collection(db,'broadcasts');
    logCol=collection(db,'loginlogs');
    cfgCol=collection(db,'config');
    // NOTE: listenEmailConfig() must run AFTER auth (config reads require signedIn) —
    // attached in attachFirebaseListeners(), not here.

    lsub('Checking users...');
    try{
      const uSnap=await getDocs(uCol);
      if(uSnap.empty){
        lsub('Creating manager account...');
        await setDoc(doc(uCol,'manager'),{name:'Manager',role:'manager',email:'',viewAll:'yes',needsActivation:true,tempPassword:MGR_PW});
        setUsers([{id:'manager',name:'Manager',role:'manager',email:'',viewAll:'yes',needsActivation:true,tempPassword:MGR_PW}]);
      }else{
        setUsers(uSnap.docs.map(d=>({id:d.id,...d.data()})));
      }
    }catch(loadErr){
      if(loadErr?.code==='permission-denied'){
        setUsers([]);
        console.warn('Users preload blocked — publish firestore.rules from project folder, then refresh.');
      }else throw loadErr;
    }
    setupLoginUI();
    lsub('Ready — sign in or first-time setup');
    onAuthStateChanged(auth,onFirebaseAuthChanged);
    document.getElementById('loading').style.display='none';
    showLoginScreen();
  }catch(e){
    const hint=e?.code==='permission-denied'
      ?"Cannot connect right now. Try again or contact your administrator."
      :'Check your config values in the HTML file';
    document.getElementById('loading').innerHTML=`<div style="text-align:center;padding:2rem;color:var(--red);">❌ Firebase Error: ${e.message}<br><small style="color:var(--text2);">${e.code||''}</small><br><br><small>${hint}</small></div>`;
  }
}

function afterDataLoad(){
  populateADrop();renderUList();
  setupLoginUI();
  document.getElementById('loading').style.display='none';
  document.getElementById('login').style.display='flex';
  const sess=localStorage.getItem('rmi_session');
  if(sess){const u=users.find(x=>x.id===sess);if(u)loginAs(u);}
}
function setupLoginUI(){
  const fb=document.getElementById('login-firebase');
  const leg=document.getElementById('login-legacy');
  if(!fb||!leg)return;
  if(USE_AUTH){fb.style.display='block';leg.style.display='none';}
  else{fb.style.display='none';leg.style.display='block';}
}
window.showLoginTab=function(tab){
  const signIn=tab==='signin';
  document.getElementById('tab-signin')?.classList.toggle('on',signIn);
  document.getElementById('tab-activate')?.classList.toggle('on',!signIn);
  document.getElementById('panel-signin').style.display=signIn?'block':'none';
  document.getElementById('panel-activate').style.display=signIn?'none':'block';
  showLoginErr('');
  const actErr=document.getElementById('login-err-act');
  if(actErr)actErr.style.display='none';
  const cardTitle=document.querySelector('.login-card-title');
  const cardSub=document.getElementById('login-subtitle');
  if(cardTitle)cardTitle.textContent=signIn?'Welcome back':'Set up your account';
  if(cardSub)cardSub.textContent=signIn?'Sign in to continue':'Activate your account to get started';
  const tabs=document.querySelector('.login-tabs');
  if(tabs)tabs.dataset.tab=signIn?'signin':'activate';
};
window.togglePw=function(id,btn){
  const inp=document.getElementById(id);if(!inp)return;
  const show=inp.type==='password';
  inp.type=show?'text':'password';
  if(btn)btn.classList.toggle('on',show);
};
function playPageTransition(){
  const ov=document.getElementById('page-transition');if(!ov)return;
  ov.className='';ov.style.display='flex';
  void ov.offsetWidth;            // reflow
  ov.classList.add('pt-bloom');   // brand circle expand to cover
  setTimeout(()=>{
    ov.classList.add('pt-lift');  // curtain lifts up, revealing app
    setTimeout(()=>{ov.style.display='none';ov.className='';},850);
  },620);
}
function lfBtnLoading(id,on,label){
  const b=document.getElementById(id);if(!b)return;
  if(on){b.dataset.label=b.textContent;b.disabled=true;b.classList.add('lf-loading');b.innerHTML=`<span class="lf-spin"></span>${label||'Please wait…'}`;}
  else{b.disabled=false;b.classList.remove('lf-loading');b.textContent=b.dataset.label||b.textContent;}
}
function showLoginErr(msg,isActivate){
  const ids=isActivate?['login-err-act']:['login-err'];
  ids.forEach(id=>{
    const el=document.getElementById(id);
    if(!el)return;
    if(msg){el.textContent=msg;el.style.display='block';}
    else{el.textContent='';el.style.display='none';}
  });
  if(!isActivate){
    const ok=document.getElementById('login-ok');
    if(ok){ok.style.display='none';}
  }
}
function showLoginOk(msg){
  const el=document.getElementById('login-ok');
  if(!el)return;
  el.textContent=msg;
  el.style.display=msg?'block':'none';
  showLoginErr('');
}
function authErrorMessage(e){
  const c=e?.code||'';
  if(c==='auth/invalid-credential'||c==='auth/wrong-password'||c==='auth/user-not-found')return 'Incorrect email or password.';
  if(c==='auth/email-already-in-use')return 'That email is already registered. Try Sign in or Forgot password.';
  if(c==='auth/weak-password')return 'Password must be at least 6 characters.';
  if(c==='auth/invalid-email')return 'Enter a valid email address.';
  return e?.message||'Authentication failed.';
}
async function resolveProfileFromAuth(authUser){
  if(!authUser||!db)return null;
  const mapSnap=await getDoc(doc(authMapCol,authUser.uid));
  let profileId=mapSnap.exists()?mapSnap.data().profileId:null;
  if(!profileId){
    const u=users.find(x=>x.authUid===authUser.uid);
    if(u)profileId=u.id;
  }
  if(!profileId)return null;
  return users.find(x=>x.id===profileId)||null;
}
async function linkAuthToProfile(authUid,profileId,email){
  await setDoc(doc(authMapCol,authUid),{profileId});
  await updateDoc(doc(uCol,profileId),{
    authUid,
    email,
    needsActivation:false,
    password:deleteField(),
    tempPassword:deleteField()
  });
  const u=users.find(x=>x.id===profileId);
  if(u){Object.assign(u,{authUid,email,needsActivation:false});delete u.password;delete u.tempPassword;}
}
async function onFirebaseAuthChanged(authUser){
  if(authLoginInProgress)return;
  authStateReady=true;
  if(!users.length&&uCol){
    try{const uSnap=await getDocs(uCol);setUsers(uSnap.docs.map(d=>({id:d.id,...d.data()})));}catch(e){}
  }
  if(authUser){
    const profile=await resolveProfileFromAuth(authUser);
    if(profile){
      const already=me&&me.id===profile.id;
      if(!already){
        loginAs(profile);
        logActivity({type:'login',category:'auth',desc:`${profile.name} signed in`,userId:profile.id,userName:profile.name,role:profile.role});
      }
    }else{
      showLoginScreen();
      showLoginErr('No profile linked to this email. Use First-time setup with your name.');
      try{await signOut(auth);}catch(e){}
    }
  }else{
    if(me)softLogoutUI();
    else showLoginScreen();
  }
}
function showLoginScreen(){
  document.getElementById('login').style.display='flex';
  document.getElementById('app').style.display='none';
  lfBtnLoading('signin-btn',false);
  lfBtnLoading('activate-btn',false);
}
function softLogoutUI(){
  detachFirebaseListeners();
  setMe(null);
  notifSoundReady=false;
  notifSnapshotReady=false;
  knownNotifIds=new Set();
  selectedJobs.clear();
  updateBulkBar();
  showLoginScreen();
}

function detachFirebaseListeners(){
  fbUnsubs.forEach(fn=>{try{fn();}catch(e){}});
  fbUnsubs=[];
  if(emailCfgUnsub){try{emailCfgUnsub();}catch(e){}emailCfgUnsub=null;} // allow re-attach next login
}
function canSeeAllJobs(){
  return me&&(me.role==='manager'||me.role==='supervisor'||amDirector()||me.viewAll==='yes');
}
// ── TEAMS / SCOPE ────────────────────────────────────────────────────────────
// Read-only oversight roles. See everything, change nothing, hidden from staff.
export const DIRECTOR_ROLES=['managing_director','executive_director'];
export function isDirectorRole(role){return DIRECTOR_ROLES.includes(role);}
export function amDirector(){return me&&isDirectorRole(me.role);}
export function isTeamLeader(){return me&&me.role==='team_leader';}
function teamMemberIds(leaderId){
  // members assigned to this leader + the leader themselves
  return [leaderId,...users.filter(u=>u.teamLeaderId===leaderId).map(u=>u.id)];
}
function myTeamIds(){return me?teamMemberIds(me.id):[];}
// central visibility: which jobs current user may see
export function visibleJobs(){
  if(!me)return[];
  // workflow (Job Basket) jobs live in their own section — exclude from manual views
  const pool=jobs.filter(j=>!j.workflow);
  // TL scope takes priority — viewAll='yes' on a TL should not expose all jobs
  if(isTeamLeader()){const ids=new Set(myTeamIds());return pool.filter(j=>ids.has(j.owner));}
  if(canSeeAllJobs())return pool;
  return pool.filter(j=>j.owner===me.id);
}
// can current user manage (edit/assign/reassign/extend) this job?
export function canManageJob(j){
  if(!me||!j)return false;
  if(me.role==='manager'||me.role==='supervisor')return true;
  if(me.id===j.owner)return true;
  if(isTeamLeader()&&myTeamIds().includes(j.owner))return true;
  return false;
}
// is current user a "lead" (manager/supervisor/team_leader) — gets assign, board, notes
export function isLead(){return me&&['manager','supervisor','team_leader'].includes(me.role);}
// users visible in board/assign/calendar/analytics dropdowns
// roles that never appear in staff/assign/board/calendar/analytics people lists
export function isNonStaffRole(role){return isDirectorRole(role)||role==='sales_operation';}
export function teamUsersForView(){
  if(!me)return[];
  // directors + sales operation are hidden from all team/board/calendar/analytics lists
  const staff=users.filter(u=>!isNonStaffRole(u.role));
  if(me.role==='manager'||me.role==='supervisor'||amDirector())return staff;
  if(isTeamLeader()){const ids=new Set(myTeamIds());return staff.filter(u=>ids.has(u.id));}
  return users.filter(u=>u.id===me.id);
}
// employees a lead may assign to
export function assignableUsers(){
  if(!me)return[];
  if(me.role==='manager')return users.filter(u=>!isNonStaffRole(u.role));
  if(me.role==='supervisor')return users.filter(u=>u.role!=='manager'&&!isNonStaffRole(u.role));
  if(isTeamLeader())return users.filter(u=>u.teamLeaderId===me.id||u.id===me.id);
  return [];
}
function jobsQueryForUser(){
  if(!me)return jCol;
  if(me.role==='sales_operation')return query(jCol,where('wfCreatedBy','==',me.id));
  if(canSeeAllJobs())return jCol;
  return query(jCol,where('owner','==',me.id));
}
async function refreshUsersRemote(){
  if(!USE_FIREBASE||!uCol)return;
  const snap=await getDocs(uCol);
  setUsers(snap.docs.map(d=>({id:d.id,...d.data()})));
  populateADrop();renderUList();populateReassignDrops();populateCalEmpDrop();
  if(document.getElementById('cal')?.classList.contains('on'))renderCal();
}
async function refreshActivityLogsRemote(){
  if(USE_FIREBASE&&logCol){
    const snap=await getDocs(query(logCol,limit(FB_LIMITS.activityLog)));
    setActivityLogs(snap.docs.map(d=>({id:d.id,...d.data()})));
    activityLogs.sort((a,b)=>(b.ts||0)-(a.ts||0));
  }
  populateActivityLogFilters();
  renderActivityLog();
}
export async function refreshBroadcastsRemote(){
  if(USE_FIREBASE&&bcastCol){
    const snap=await getDocs(query(bcastCol,limit(FB_LIMITS.broadcasts)));
    setBroadcasts(snap.docs.map(d=>({id:d.id,...d.data()})));
    broadcasts.sort((a,b)=>(b.created||0)-(a.created||0));
  }
  renderBroadcasts();
}
async function refreshExtensionsRemote(){
  if(!USE_FIREBASE||!extCol)return;
  const snap=await getDocs(query(extCol,limit(FB_LIMITS.extensions)));
  setExtRequests(snap.docs.map(d=>({id:d.id,...d.data()})));
  if(me?.role==='manager')renderDashExtensions();
}
async function refreshJobEventsRemote(jobId){
  if(!USE_FIREBASE||!evCol||!jobId)return;
  const snap=await getDocs(query(evCol,where('jobId','==',jobId),limit(FB_LIMITS.jobEvents)));
  setEvents(events.filter(e=>e.jobId!==jobId));
  snap.docs.forEach(d=>events.push({id:d.id,...d.data()}));
}
let _primaryJobs=[], _wfTeamJobs=[];
function applyMergedJobs(){
  const map=new Map();
  for(const j of _primaryJobs)map.set(j.id,j);
  for(const j of _wfTeamJobs)if(!map.has(j.id))map.set(j.id,j); // team workflow jobs not already in primary
  setJobs([...map.values()].sort((a,b)=>(b.created||0)-(a.created||0)));
  renderAll();
  if(isLead())renderBoard();
  updateSynced();
}
function attachFirebaseListeners(){
  detachFirebaseListeners();
  if(!USE_FIREBASE||!me||!db)return;
  listenEmailConfig(); // now signed-in → config read allowed
  _primaryJobs=[];_wfTeamJobs=[];
  const jq=jobsQueryForUser();
  fbUnsubs.push(onSnapshot(jq,snap=>{
    _primaryJobs=snap.docs.map(d=>({id:d.id,...d.data()}));
    applyMergedJobs();
  }));
  // Team Leaders without full visibility: second listener for their team's workflow
  // jobs (any owner) so the basket shows in-progress jobs sitting with drafters.
  if(me.role==='team_leader'&&!canSeeAllJobs()){
    fbUnsubs.push(onSnapshot(query(jCol,where('teamLeaderId','==',me.id)),snap=>{
      _wfTeamJobs=snap.docs.map(d=>({id:d.id,...d.data()}));
      applyMergedJobs();
    }));
  }
  fbUnsubs.push(onSnapshot(query(notifCol,where('userId','==',me.id),limit(FB_LIMITS.notifications)),snap=>{
    setNotifications(snap.docs.map(d=>({id:d.id,...d.data()})));
    onNotificationsUpdated();
  }));
}

function updateSynced(){document.getElementById('synced').textContent='● '+new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});}

// ── AUTH ──────────────────────────────────────────────────────────────────────
export function populateADrop(){
  const s=document.getElementById('mat');
  if(!s)return;
  s.innerHTML='<option value="">-- Select team member --</option>';
  const pool=assignableUsers();
  pool.forEach(u=>{
    const o=document.createElement('option');
    o.value=u.id;
    const tag=u.role==='manager'?' (Manager)':u.role==='supervisor'?' (Supervisor)':'';
    o.textContent=u.name+tag;
    s.appendChild(o);
  });
  renderAssignEmpGrid();
}

export function renderAssignEmpGrid(){
  const grid=document.getElementById('assign-emp-grid');
  if(!grid)return;
  const pool=assignableUsers();
  const selected=document.getElementById('mat')?.value||'';
  grid.innerHTML=pool.map(u=>{
    const active=jobs.filter(j=>j.owner===u.id&&j.status!=='completed'&&!j.workflow).length;
    const overdue=jobs.filter(j=>j.owner===u.id&&isOverdue(j)&&!j.workflow).length;
    const loadCls=overdue>0?'load-red':active>=5?'load-red':active>=3?'load-yellow':'load-green';
    const loadLbl=overdue>0?`⚠ ${overdue} overdue`:active>=5?'Overloaded':active>=3?'Busy':'Available';
    const roleIcon=u.role==='manager'?'👔':u.role==='supervisor'?'🔰':u.role==='team_leader'?'🧭':'👤';
    const isSel=u.id===selected;
    return`<div class="emp-card${isSel?' emp-card-sel':''}" onclick="selectAssignEmp('${u.id}')">
      <div class="emp-card-top">
        <span class="emp-card-avatar">${roleIcon}</span>
        <div class="emp-card-info">
          <div class="emp-card-name">${escapeHtml(u.name)}</div>
          <div class="emp-card-role">${u.role}</div>
        </div>
      </div>
      <div class="emp-card-load">
        <span class="emp-load-dot ${loadCls}"></span>
        <span class="emp-load-lbl">${loadLbl}</span>
        <span class="emp-load-count">${active} active</span>
      </div>
    </div>`;
  }).join('');
}
window.selectAssignEmp=function(id){
  const mat=document.getElementById('mat');
  if(mat)mat.value=id;
  renderAssignEmpGrid();
  // show preview of their current jobs
  const preview=document.getElementById('assign-emp-preview');
  const nameEl=document.getElementById('assign-preview-name');
  const jobsEl=document.getElementById('assign-preview-jobs');
  if(!preview)return;
  const u=users.find(x=>x.id===id);
  if(!u){preview.style.display='none';return;}
  const uj=jobs.filter(j=>j.owner===id&&j.status!=='completed'&&!j.workflow);
  nameEl.textContent=u.name+"'s current jobs";
  jobsEl.innerHTML=uj.length
    ?uj.map(j=>{
        const od=isOverdue(j);
        return`<div class="preview-job-row${od?' preview-job-od':''}">
          <span class="preview-job-client">${escapeHtml(j.client)}</span>
          <span class="preview-job-num">#${escapeHtml(j.jobNum)}</span>
          <span class="st-chip ${j.status==='ongoing'?'st-ongoing':j.status==='paused'?'st-paused':'st-pending'}" style="font-size:0.65rem;">${od?'Overdue':j.status}</span>
        </div>`;
      }).join('')
    :'<div class="preview-job-empty">No active jobs — good time to assign!</div>';
  preview.style.display='block';
};

function populateReassignDrops(){
  // Bulk reassign
  const s=document.getElementById('bulk-reassign');
  s.innerHTML='<option value="">Reassign to...</option>';
  const pool=assignableUsers();
  pool.forEach(u=>{const o=document.createElement('option');o.value=u.id;o.textContent=u.name+(u.role==='manager'?' (Manager)':'');s.appendChild(o);});
  // adv search emp filter
  const sf=document.getElementById('sf-emp');
  sf.innerHTML='<option value="">All Employees</option>';
  users.filter(u=>!isNonStaffRole(u.role)).forEach(u=>{const o=document.createElement('option');o.value=u.id;o.textContent=u.name;sf.appendChild(o);});
}

function doLegacyLogin(){
  const ident=document.getElementById('lu').value.trim().toLowerCase();
  const pw=document.getElementById('lp').value;
  const u=users.find(x=>x.name.trim().toLowerCase()===ident||(x.email&&x.email.trim().toLowerCase()===ident));
  const errEl=document.getElementById('login-err-legacy');
  if(!u||u.password!==pw){if(errEl)errEl.style.display='block';return;}
  if(errEl)errEl.style.display='none';
  loginAs(u);
  logActivity({type:'login',category:'auth',desc:`${u.name} signed in`,userId:u.id,userName:u.name,role:u.role});
}
window.doLogin=async function(){
  if(USE_AUTH){
    const email=document.getElementById('li-email').value.trim().toLowerCase();
    const pw=document.getElementById('li-password').value;
    if(!email||!pw){showLoginErr('Enter email and password.');return;}
    lfBtnLoading('signin-btn',true,'Signing in…');
    try{
      showLoginErr('');
      await signInWithEmailAndPassword(auth,email,pw);
    }catch(e){showLoginErr(authErrorMessage(e));lfBtnLoading('signin-btn',false);}
    return;
  }
  doLegacyLogin();
};
async function ensureUsersLoaded(){
  if(users.length||!USE_FIREBASE||!uCol)return;
  const uSnap=await getDocs(query(uCol,where('needsActivation','==',true)));
  setUsers(uSnap.docs.map(d=>({id:d.id,...d.data()})));
}
window.doActivate=async function(){
  if(!USE_AUTH){showLoginErr('Firebase not configured.',true);return;}
  try{await ensureUsersLoaded();}catch(e){
    const actErr=document.getElementById('login-err-act');
    if(actErr){actErr.textContent='Cannot load team list right now. Try again later or ask your manager.';actErr.style.display='block';}
    return;
  }
  const name=document.getElementById('act-name').value.trim();
  const oldPw=document.getElementById('act-oldpw').value;
  const email=document.getElementById('act-email').value.trim().toLowerCase();
  const pw=document.getElementById('act-newpw').value;
  const pw2=document.getElementById('act-newpw2').value;
  const actErr=id=>{const el=document.getElementById('login-err-act');if(el){el.textContent=id;el.style.display='block';}};
  const clearAct=()=>{const el=document.getElementById('login-err-act');if(el)el.style.display='none';};
  if(!name||!email||!pw){actErr('Fill name, email, and new password.');return;}
  if(pw!==pw2){actErr('Passwords do not match.');return;}
  if(pw.length<6){actErr('Password must be at least 6 characters.');return;}
  const u=users.find(x=>x.name.trim().toLowerCase()===name.toLowerCase());
  if(!u){actErr('No profile found for that name. Ask your manager to add you.');return;}
  if(u.authUid){actErr('Already activated — use Sign in with your email.');return;}
  if(u.password){
    if(u.password!==oldPw){actErr('Old password is incorrect.');return;}
  }else if(u.tempPassword){
    if(u.tempPassword!==oldPw){actErr('Temporary password is incorrect.');return;}
  }else{
    actErr('Ask your manager for a temporary password, or use your old password.');
    return;
  }
  clearAct();
  lfBtnLoading('activate-btn',true,'Setting up…');
  try{
    authLoginInProgress=true;
    const cred=await createUserWithEmailAndPassword(auth,email,pw);
    await linkAuthToProfile(cred.user.uid,u.id,email);
    await refreshUsersRemote();
    authLoginInProgress=false;
    loginAs(users.find(x=>x.id===u.id)||u);
    logActivity({type:'login',category:'auth',desc:`${u.name} activated account`,userId:u.id,userName:u.name,role:u.role});
    showToastMsg('Account activated!');
  }catch(e){
    authLoginInProgress=false;
    actErr(authErrorMessage(e));
    lfBtnLoading('activate-btn',false);
  }
};
window.doForgotPassword=async function(){
  if(!USE_AUTH)return;
  const email=document.getElementById('li-email').value.trim().toLowerCase();
  if(!email){showLoginErr('Enter your email first.');return;}
  try{
    await sendPasswordResetEmail(auth,email);
    showLoginOk('Password reset email sent — check your inbox.');
  }catch(e){showLoginErr(authErrorMessage(e));}
};

function loginAs(u){
  setMe(u);
  playPageTransition();
  document.getElementById('login').style.display='none';
  document.getElementById('app').style.display='block';
  document.getElementById('app').classList.add('app-reveal');
  setTimeout(()=>document.getElementById('app')?.classList.remove('app-reveal'),1200);
  const ico=u.role==='manager'?'👔':u.role==='supervisor'?'🔰':u.role==='team_leader'?'🧭':'👤';
  document.getElementById('ubadge').textContent=ico+' '+u.name;
  localStorage.setItem('rmi_session',u.id);
  setUserSettings(loadUserSettings());
  attachFirebaseListeners();
  refreshUsersRemote();
  applyMainNav();
  if(u.role==='sales_operation')goHub('work','job-basket');
  else goHub('insights','overview');
  showDeadlineBanner();
  seedNotifTracking();
  applyUserSettings();
  updateBroadcastUI();
  renderNotifPanel();
  updateNotifBadge();
  if(userSettings.desktopNotif!==false)ensureDesktopNotifPermission();
}

window.doLogout=async function(){
  if(me)logActivity({type:'logout',category:'auth',desc:`${me.name} signed out`,userId:me.id,userName:me.name,role:me.role});
  detachFirebaseListeners();
  setMe(null);
  notifSoundReady=false;
  notifSnapshotReady=false;
  knownNotifIds=new Set();
  localStorage.removeItem('rmi_session');
  if(document.getElementById('lp'))document.getElementById('lp').value='';
  if(document.getElementById('li-password'))document.getElementById('li-password').value='';
  selectedJobs.clear();
  updateBulkBar();
  if(USE_AUTH&&auth){try{await signOut(auth);}catch(e){}softLogoutUI();}
  else softLogoutUI();
};

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────
// ── USER SETTINGS ─────────────────────────────────────────────────────────────
function settingsStorageKey(){return me?'rmi_settings_'+me.id:'rmi_settings_guest';}
function loadUserSettings(){
  try{const s=JSON.parse(localStorage.getItem(settingsStorageKey())||'{}');return{...DEFAULT_SETTINGS,...s};}
  catch(e){return{...DEFAULT_SETTINGS};}
}
function saveUserSettings(){
  localStorage.setItem(settingsStorageKey(),JSON.stringify(userSettings));
  applyUserSettings();
}
function applyUserSettings(){
  if(me&&document.getElementById('dashboard')?.classList.contains('on'))renderDashboard();
  if(document.getElementById('analytics')?.classList.contains('on'))renderAnalyticsContent();
  if(document.getElementById('my-jobs')?.classList.contains('on'))renderJobs();
}
window.setUserSetting=function(key,val){
  userSettings[key]=val;
  saveUserSettings();
  if(key==='dashStatsView'){
    if(document.getElementById('analytics')?.classList.contains('on'))renderAnalyticsContent();
    if(document.getElementById('dashboard')?.classList.contains('on'))renderDashboard();
  }
};
window.saveSettingsFromUI=function(){
  const el=id=>document.getElementById(id);
  userSettings.dashStatsView=el('set-dash-view')?.value||userSettings.dashStatsView;
  userSettings.notifSound=el('set-notif-sound')?.checked!==false;
  userSettings.desktopNotif=el('set-desktop-notif')?.checked!==false;
  userSettings.muteLoginNotif=el('set-mute-login')?.checked===true;
  userSettings.emailAssigned=el('set-email-assigned')?.checked!==false;
  userSettings.emailStatus=el('set-email-status')?.checked!==false;
  userSettings.emailDeadline=el('set-email-deadline')?.checked!==false;
  userSettings.emailOverdue=el('set-email-overdue')?.checked!==false;
  userSettings.emailExtension=el('set-email-extension')?.checked!==false;
  saveUserSettings();
  if(userSettings.desktopNotif)ensureDesktopNotifPermission();
  showToastMsg('Settings saved');
};
window.resetUserSettings=function(){
  setUserSettings({...DEFAULT_SETTINGS});
  saveUserSettings();
  renderSettings();
  showToastMsg('Settings reset');
};
function renderAccountProfile(){
  const el=document.getElementById('account-pane-profile');if(!el||!me)return;
  const bdg=roleMeta(me.role).bdg;
  const initial=(me.name||'?').trim().charAt(0).toUpperCase();
  const isSalesOp=me.role==='sales_operation';
  let statA,statB,labA,labB;
  if(isSalesOp){
    const my=jobs.filter(j=>j.wfCreatedBy===me.id);
    statA=my.filter(j=>j.stage!=='completed').length;labA='in basket';
    statB=my.filter(j=>j.stage==='completed').length;labB='completed';
  }else{
    statA=jobs.filter(j=>j.owner===me.id&&j.status!=='completed'&&!j.workflow).length;labA='active';
    statB=jobs.filter(j=>j.owner===me.id&&j.status==='completed'&&!j.workflow).length;labB='done';
  }
  el.innerHTML=`
  <div class="acct-profile">
    <div class="acct-avatar acct-av-${bdg}">${escapeHtml(initial)}</div>
    <div class="acct-profile-info">
      <div class="acct-name">${escapeHtml(me.name)} <span class="bdg bdg-${bdg}">${roleMeta(me.role).label}</span></div>
      <div class="acct-email">${escapeHtml(me.email||'No email on file')}</div>
      ${me.viewAll==='yes'?'<div class="acct-viewall">👁 Can view all team jobs</div>':''}
    </div>
    <div class="acct-mini-stats">
      <div><span class="acct-ms-n">${statA}</span><span class="acct-ms-l">${labA}</span></div>
      <div><span class="acct-ms-n">${statB}</span><span class="acct-ms-l">${labB}</span></div>
    </div>
  </div>
  <div class="acct-actions-card">
    <div class="acct-ac-row">
      <div><div class="acct-ac-title">Password</div><div class="acct-ac-sub">We'll email you a reset link</div></div>
      <button type="button" class="bp sec" onclick="accountChangePassword()">Change password</button>
    </div>
  </div>`;
}
function renderAccountPreferences(){
  const el=document.getElementById('account-pane-prefs');if(!el)return;
  const s=userSettings;
  const toggle=(id,label,sub,checked)=>`<div class="pref-row">
    <div><div class="pref-label">${label}</div>${sub?`<div class="pref-sub">${sub}</div>`:''}</div>
    <label class="switch"><input type="checkbox" id="${id}" ${checked?'checked':''}/><span class="switch-track"></span></label>
  </div>`;
  el.innerHTML=`
  <div class="pref-card">
    <div class="pref-card-hd">In-App Notifications</div>
    ${toggle('set-notif-sound','Sound','Play a chime for new notifications',s.notifSound)}
    ${toggle('set-desktop-notif','Desktop alerts','Show browser notifications',s.desktopNotif!==false)}
    ${me.role==='manager'?toggle('set-mute-login','Mute sign-in alerts','Don\'t notify me when staff log in',s.muteLoginNotif):''}
  </div>
  <div class="pref-card" style="margin-top:0.85rem;">
    <div class="pref-card-hd">Email Alerts</div>
    ${toggle('set-email-assigned','Job assigned to me','Email when a job is assigned or reassigned to you',s.emailAssigned!==false)}
    ${toggle('set-email-status','Job status changes','Email when your job status changes',s.emailStatus!==false)}
    ${toggle('set-email-deadline','Deadline reminders','Email when a deadline is within 24 hours',s.emailDeadline!==false)}
    ${toggle('set-email-overdue','Overdue alerts','Email when a job becomes overdue',s.emailOverdue!==false)}
    ${isLead()?toggle('set-email-extension','Extension requests','Email when a team member requests a deadline extension',s.emailExtension!==false):''}
  </div>`;
}
window.accountChangePassword=async function(){
  const email=me?.email||document.getElementById('li-email')?.value?.trim();
  if(!email){showToastMsg('No email on file — ask your manager.');return;}
  if(!USE_AUTH||!auth){showToastMsg('Not available offline.');return;}
  try{await sendPasswordResetEmail(auth,email);showToastMsg('Password reset email sent.');}catch(e){showToastMsg('Could not send reset email.');}
};
function renderSettings(){renderAccountProfile();renderAccountPreferences();}

function playNotifSound(){
  if(!userSettings.notifSound)return;
  try{
    const ctx=new (window.AudioContext||window.webkitAudioContext)();
    const playTone=(freq,start,dur)=>{
      const o=ctx.createOscillator(),g=ctx.createGain();
      o.type='sine';o.frequency.value=freq;
      g.gain.setValueAtTime(0.12,start);
      g.gain.exponentialRampToValueAtTime(0.001,start+dur);
      o.connect(g);g.connect(ctx.destination);
      o.start(start);o.stop(start+dur);
    };
    const t=ctx.currentTime;
    playTone(880,t,0.12);
    playTone(1108.73,t+0.14,0.18);
  }catch(e){}
}
function seedNotifTracking(){
  knownNotifIds=new Set();
  notifSnapshotReady=false;
  notifSoundReady=true;
}
function getNotifVisual(title){
  const t=title||'';
  const rules=[
    {re:/📢|broadcast/i,emoji:'📢',color:'#9b6dde'},
    {re:/📋|assign/i,emoji:'📋',color:'#4a9eda'},
    {re:/➕|new job created/i,emoji:'➕',color:'#4caf7d'},
    {re:/▶|start|resum/i,emoji:'▶',color:'#4a9eda'},
    {re:/⏸|pause/i,emoji:'⏸',color:'#e8a838'},
    {re:/✅|complet|approv/i,emoji:'✅',color:'#4caf7d'},
    {re:/❌|reject/i,emoji:'❌',color:'#e05252'},
    {re:/✏️|edit/i,emoji:'✏️',color:'#e8a838'},
    {re:/🗑|delet/i,emoji:'🗑',color:'#e05252'},
    {re:/↩|restor/i,emoji:'↩',color:'#4a9eda'},
    {re:/📌|pin/i,emoji:'📌',color:'#e07c3a'},
    {re:/💬|comment/i,emoji:'💬',color:'#4a9eda'},
    {re:/🔄|reassign/i,emoji:'🔄',color:'#9b6dde'},
    {re:/📅|extension/i,emoji:'📅',color:'#e07c3a'},
    {re:/📦|bulk/i,emoji:'📦',color:'#e8a838'},
    {re:/🔐|sign/i,emoji:'🔐',color:'#7a8a9a'},
    {re:/👤|user|account/i,emoji:'👤',color:'#9b6dde'},
  ];
  for(const r of rules)if(r.re.test(t))return r;
  const lead=t.match(/^[\p{Extended_Pictographic}]/u);
  return{emoji:lead?lead[0]:'🔔',color:'#4a9eda'};
}
function dismissNotifBubble(el){
  if(!el?.parentNode)return;
  const tid=el.dataset.toastId;
  if(notifToastTimers.has(tid)){clearTimeout(notifToastTimers.get(tid));notifToastTimers.delete(tid);}
  el.classList.add('toast-out');
  setTimeout(()=>el.remove(),280);
}
function trimNotifToastStack(){
  const stack=document.getElementById('notif-toast-stack');
  if(!stack)return;
  while(stack.children.length>NOTIF_TOAST_MAX)dismissNotifBubble(stack.lastElementChild);
}
function showNotifBubble(n){
  if(!me||!n)return;
  const stack=document.getElementById('notif-toast-stack');
  if(!stack)return;
  const vis=getNotifVisual(n.title);
  const tid=n.id||'t-'+uid();
  const el=document.createElement('div');
  el.className='notif-toast';
  el.dataset.toastId=tid;
  el.style.setProperty('--toast-accent',vis.color);
  el.style.borderLeftColor=vis.color;
  const isBcast=(n.title||'').includes('Broadcast');
  el.innerHTML=`<div class="notif-toast-icon" style="background:${vis.color}22;color:${vis.color}">${vis.emoji}</div><div class="notif-toast-body"><div class="notif-toast-title">${escapeHtml((n.title||'').replace(/^[\p{Extended_Pictographic}]\s*/u,'').trim()||'Notification')}</div><div class="notif-toast-msg">${escapeHtml(n.body||'')}</div></div><button type="button" class="notif-toast-close" aria-label="Dismiss">✕</button>`;
  el.querySelector('.notif-toast-close').onclick=e=>{e.stopPropagation();dismissNotifBubble(el);};
  el.onclick=()=>{if(n.id)handleNotifClick(n.id,isBcast);dismissNotifBubble(el);};
  stack.prepend(el);
  notifToastTimers.set(tid,setTimeout(()=>dismissNotifBubble(el),NOTIF_BUBBLE_TTL));
  trimNotifToastStack();
}
function shouldShowDesktopNotif(){
  return userSettings.desktopNotif!==false&&('Notification' in window)&&Notification.permission==='granted'&&(document.hidden||!document.hasFocus());
}
function showSystemNotification(title,body){
  if(!shouldShowDesktopNotif())return;
  try{
    const vis=getNotifVisual(title);
    const n=new Notification((title||'RMI').replace(/^[\p{Extended_Pictographic}]\s*/u,'').trim(),{
      body:body||'',
      icon:'https://static.wixstatic.com/media/1fd987_2287b00fc2ae487ead69213eefd9aff6~mv2.png/v1/crop/x_0,y_34,w_591,h_278/fill/w_64,h_30,al_c,q_85/1fd987_2287b00fc2ae487ead69213eefd9aff6~mv2.png',
      tag:'rmi-'+uid(),
      silent:!userSettings.notifSound
    });
    n.onclick=()=>{window.focus();document.getElementById('notif-panel').style.display='block';n.close();};
    setTimeout(()=>n.close(),NOTIF_BUBBLE_TTL);
  }catch(e){}
}
async function ensureDesktopNotifPermission(){
  if(!('Notification' in window))return false;
  if(Notification.permission==='granted')return true;
  if(Notification.permission==='denied')return false;
  try{
    const p=await Notification.requestPermission();
    const st=document.getElementById('desktop-notif-status');
    if(st)st.textContent=p;
    return p==='granted';
  }catch(e){return false;}
}
function deliverNotifToUser(n){
  showNotifBubble(n);
  showSystemNotification(n.title,n.body);
}
function onNotificationsUpdated(){
  if(!me)return;
  const mine=notifications.filter(n=>n.userId===me.id);
  if(notifBulkClearing){
    renderNotifPanel();
    updateNotifBadge();
    return;
  }
  if(!notifSnapshotReady){
    knownNotifIds=new Set(mine.map(n=>n.id));
    notifSnapshotReady=true;
  }else if(notifSoundReady){
    const fresh=mine.filter(n=>!knownNotifIds.has(n.id));
    if(fresh.length){
      playNotifSound();
      fresh.forEach(n=>deliverNotifToUser(n));
    }
    knownNotifIds=new Set(mine.map(n=>n.id));
  }
  renderNotifPanel();
  updateNotifBadge();
}
async function deleteAllNotifsForUser(){
  let total=0;
  for(;;){
    const snap=await getDocs(query(notifCol,where('userId','==',me.id),limit(500)));
    if(snap.empty)break;
    const batch=writeBatch(db);
    snap.docs.forEach(d=>batch.delete(d.ref));
    await batch.commit();
    total+=snap.docs.length;
  }
  return total;
}
export function pushNotif(userId,title,body){
  const n={userId,title,body,read:false,ts:Date.now()};
  if(USE_FIREBASE){addDoc(notifCol,n);}
  else{n.id=uid();notifications.unshift(n);localSave();onNotificationsUpdated();}
}
function pushNotifToManagers(title,body,exceptIds=[]){
  users.filter(u=>u.role==='manager'&&!exceptIds.includes(u.id)).forEach(u=>pushNotif(u.id,title,body));
}
function pushNotifExcept(exceptIds,userId,title,body){
  if(!userId||exceptIds.includes(userId))return;
  pushNotif(userId,title,body);
}
function exceptActor(id){return id?[id]:[];}
function jobLabel(j){return j?`${j.client} (#${j.jobNum})`:'a job';}
function notifyManagersAndSupervisors(title,body,exceptIds=[]){
  users.filter(u=>['manager','supervisor'].includes(u.role)&&!exceptIds.includes(u.id)).forEach(u=>pushNotif(u.id,title,body));
}
function notifyTeamLeaderOf(ownerId,title,body,exceptIds=[]){
  const tl=users.find(u=>u.role==='team_leader'&&users.filter(x=>x.teamLeaderId===u.id).some(x=>x.id===ownerId));
  if(tl&&!exceptIds.includes(tl.id))pushNotif(tl.id,title,body);
}
function notifyJobOwner(j,title,body,exceptIds=[]){
  if(j?.owner)pushNotifExcept(exceptIds,j.owner,title,body);
}
export function notifyReassign(j,fromId,toId,byName){
  if(!j)return;
  const label=jobLabel(j);
  const ex=exceptActor(me?.id);
  const toName=users.find(u=>u.id===toId)?.name||'someone';
  pushNotifExcept(ex,toId,'🔄 Job Reassigned',`${label} reassigned to you by ${byName}`);
  if(fromId&&fromId!==toId)pushNotifExcept(ex,fromId,'🔄 Job Reassigned',`${label} reassigned from you to ${toName}`);
  notifyManagersAndSupervisors('🔄 Job Reassigned',`${byName} reassigned ${label} to ${toName}`,ex);
  // T2: email new owner on reassign
  if(emailPref('emailAssigned')){emailEventOwnerId('assigned',toId,`Job Reassigned to You: ${label}`,`${byName} has reassigned a job to you.\n\nJob: ${label}`,ex);emailEventOversight('assigned',j,`Job Reassigned: ${label}`,`${byName} reassigned ${label} to ${toName}`,ex);}
}
function notifyForJobEvent(jobId,type,desc){
  if(!me)return;
  const j=jobs.find(x=>x.id===jobId);
  const label=jobLabel(j);
  const owner=users.find(u=>u.id===j?.owner)?.name||'employee';
  const ex=exceptActor(me.id);
  const short=desc.length>120?desc.slice(0,120)+'…':desc;
  switch(type){
    case 'created':
      if(j?.managerAssigned){
        notifyJobOwner(j,'📋 New Job Assigned',`${me.name} assigned you: ${label}`,ex);
        notifyManagersAndSupervisors('📋 Job Assigned',`${me.name} assigned ${label} to ${owner}`,ex);
        notifyTeamLeaderOf(j?.owner,'📋 Job Assigned',`${me.name} assigned ${label} to ${owner}`,ex);
        // T1: email job owner on assignment
        if(emailPref('emailAssigned'))emailEventOwner('assigned',j,`New Job Assigned: ${label}`,`${me.name} has assigned you a new job.\n\nJob: ${label}\nAssigned by: ${me.name}`);
      }else{
        notifyManagersAndSupervisors('➕ New Job Created',`${me.name} created ${label}`,ex);
        notifyTeamLeaderOf(j?.owner,'➕ New Job Created',`${me.name} created ${label}`,ex);
      }
      break;
    case 'started':
      notifyJobOwner(j,'▶ Job Started',`${me.name} started ${label}`,ex);
      notifyManagersAndSupervisors('▶ Job Started',`${me.name} started ${label}`,ex);
      notifyTeamLeaderOf(j?.owner,'▶ Job Started',`${me.name} started ${label}`,ex);
      // T3: status change emails
      if(emailPref('emailStatus')){emailEventOwner('status',j,`Job Started: ${label}`,`${me.name} has started the job.\n\nJob: ${label}`,ex);emailEventOversight('status',j,`Job Started: ${label}`,`${me.name} started ${label}`,ex);}
      break;
    case 'paused':
      notifyJobOwner(j,'⏸ Job Paused',`${me.name} paused ${label}`,ex);
      notifyManagersAndSupervisors('⏸ Job Paused',`${me.name} paused ${label}`,ex);
      notifyTeamLeaderOf(j?.owner,'⏸ Job Paused',`${me.name} paused ${label}`,ex);
      if(emailPref('emailStatus')){emailEventOwner('status',j,`Job Paused: ${label}`,`${me.name} has paused the job.\n\nJob: ${label}`,ex);emailEventOversight('status',j,`Job Paused: ${label}`,`${me.name} paused ${label}`,ex);}
      break;
    case 'resumed':
      notifyJobOwner(j,'▶ Job Resumed',`${me.name} resumed ${label}`,ex);
      notifyManagersAndSupervisors('▶ Job Resumed',`${me.name} resumed ${label}`,ex);
      notifyTeamLeaderOf(j?.owner,'▶ Job Resumed',`${me.name} resumed ${label}`,ex);
      if(emailPref('emailStatus')){emailEventOwner('status',j,`Job Resumed: ${label}`,`${me.name} has resumed the job.\n\nJob: ${label}`,ex);emailEventOversight('status',j,`Job Resumed: ${label}`,`${me.name} resumed ${label}`,ex);}
      break;
    case 'completed':
      notifyJobOwner(j,'✅ Job Completed',`${me.name} completed ${label}`,ex);
      notifyManagersAndSupervisors('✅ Job Completed',`${me.name} completed ${label}`,ex);
      notifyTeamLeaderOf(j?.owner,'✅ Job Completed',`${me.name} completed ${label}`,ex);
      if(emailPref('emailStatus')){emailEventOwner('status',j,`Job Completed: ${label}`,`${me.name} has completed the job.\n\nJob: ${label}`,ex);emailEventOversight('status',j,`Job Completed: ${label}`,`${me.name} completed ${label}`,ex);}
      break;
    case 'edited':
      notifyJobOwner(j,'✏️ Job Edited',`${me.name} edited ${label}`,ex);
      notifyManagersAndSupervisors('✏️ Job Edited',short,ex);
      notifyTeamLeaderOf(j?.owner,'✏️ Job Edited',short,ex);
      break;
    case 'deleted':
      notifyJobOwner(j,'🗑 Job Deleted',`${me.name} deleted ${label}`,ex);
      notifyManagersAndSupervisors('🗑 Job Deleted',`${me.name} deleted ${label}`,ex);
      notifyTeamLeaderOf(j?.owner,'🗑 Job Deleted',`${me.name} deleted ${label}`,ex);
      break;
    case 'restored':
      notifyJobOwner(j,'↩ Job Restored',`${me.name} restored ${label}`,ex);
      notifyManagersAndSupervisors('↩ Job Restored',`${me.name} restored ${label}`,ex);
      notifyTeamLeaderOf(j?.owner,'↩ Job Restored',`${me.name} restored ${label}`,ex);
      break;
    case 'pinned':{
      const pinTitle=desc.includes('unpinned')?'📌 Job Unpinned':'📌 Job Pinned';
      notifyJobOwner(j,pinTitle,short,ex);
      notifyManagersAndSupervisors(pinTitle,short,ex);
      break;
    }
    case 'comment':{
      const txt=desc.replace(/^💬\s*[^:]+\s*:\s*/,'').slice(0,100);
      notifyJobOwner(j,'💬 New Comment',`${me.name} on ${label}: ${txt}`,ex);
      notifyManagersAndSupervisors('💬 New Comment',`${me.name} commented on ${label}`,ex);
      notifyTeamLeaderOf(j?.owner,'💬 New Comment',`${me.name} commented on ${label}`,ex);
      break;
    }
    case 'extension_request':
      pushNotifToManagers('📅 Extension Request',`${me.name} requested an extension for ${label}`,ex);
      notifyTeamLeaderOf(j?.owner,'📅 Extension Request',`${me.name} requested an extension for ${label}`,ex);
      // T7: extension request emails oversight
      if(emailPref('emailExtension'))emailEventOversight('extension',j,`Extension Request: ${label}`,`${me.name} has requested a deadline extension.\n\nJob: ${label}`,ex);
      break;
    case 'ext_approved':
      notifyManagersAndSupervisors('✅ Extension Approved',short,ex);
      break;
    case 'ext_rejected':
      notifyManagersAndSupervisors('❌ Extension Rejected',short,ex);
      break;
    case 'bulk_edit':
      notifyJobOwner(j,'📦 Bulk Status Update',`${me.name} bulk-updated ${label}`,ex);
      notifyManagersAndSupervisors('📦 Bulk Status Update',`${me.name} bulk-updated ${label}`,ex);
      break;
  }
}
function notifyForActivityLog(entry){
  if(!entry)return;
  const actor=entry.userId||me?.id;
  const ex=exceptActor(actor);
  const who=entry.userName||'Someone';
  switch(entry.category){
    case 'auth':
      if(entry.type==='login'&&entry.role!=='manager'&&!userSettings.muteLoginNotif)notifyManagersAndSupervisors('🔐 Sign In',`${who} signed in`,ex);
      if(entry.type==='logout'&&entry.role!=='manager'&&!userSettings.muteLoginNotif)notifyManagersAndSupervisors('🔐 Sign Out',`${who} signed out`,ex);
      break;
    case 'user':{
      const titles={user_added:'👤 User Added',user_removed:'👤 User Removed',user_edited:'✏️ User Edited'};
      if(titles[entry.type])notifyManagersAndSupervisors(titles[entry.type],entry.desc||'',ex);
      break;
    }
  }
}

function renderNotifPanel(){
  if(!me)return;
  const mine=notifications.filter(n=>n.userId===me.id).sort((a,b)=>(b.ts||0)-(a.ts||0));
  const list=document.getElementById('notif-list');
  if(!mine.length){list.innerHTML='<div class="notif-empty">No notifications</div>';return;}
  list.innerHTML=mine.slice(0,50).map(n=>{
    const t=escapeHtml(n.title||''),b=escapeHtml(n.body||'');
    const isBcast=(n.title||'').includes('Broadcast');
    return`<div class="notif-item ${n.read?'':'unread'}" onclick="handleNotifClick('${n.id}',${isBcast})"><div class="ni-title">${t}</div><div style="color:var(--text);font-size:0.78rem;margin:2px 0;">${b}</div><div class="ni-time">${timeAgo(n.ts)}</div><button class="notif-clear" onclick="event.stopPropagation();clearNotif('${n.id}')" title="Clear">✕</button></div>`;
  }).join('');
}
function updateNotifBadge(){
  if(!me)return;
  const cnt=notifications.filter(n=>n.userId===me.id&&!n.read).length;
  const badge=document.getElementById('notif-badge');
  badge.style.display=cnt>0?'flex':'none';
  badge.textContent=cnt>9?'9+':cnt;
}
window.toggleNotifPanel=function(){
  const p=document.getElementById('notif-panel');
  const open=p.style.display==='block';
  p.style.display=open?'none':'block';
  p.classList.toggle('panel-open',!open);
};
window.handleNotifClick=async function(id,isBcast){
  const n=notifications.find(x=>x.id===id);
  await markNotifRead(id);
  if(isBcast){goTab('broadcast');return;}
  const body=(n?.body||'')+(n?.title||'');
  const m=body.match(/#(\d+)/);
  if(m){
    const job=jobs.find(j=>String(j.jobNum)===m[1]);
    if(job){goTab('my-jobs');setTimeout(()=>{const c=document.getElementById('card-'+job.id);if(c){c.scrollIntoView({behavior:'smooth',block:'center'});c.classList.add('selected');setTimeout(()=>c.classList.remove('selected'),2500);}},200);}
  }
};
window.markNotifRead=async function(id){
  if(USE_FIREBASE){await updateDoc(doc(notifCol,id),{read:true});}
  else{const n=notifications.find(x=>x.id===id);if(n){n.read=true;localSave();renderNotifPanel();updateNotifBadge();}}
};
window.markAllRead=async function(){
  const mine=notifications.filter(n=>n.userId===me?.id&&!n.read);
  if(!mine.length)return;
  if(USE_FIREBASE){
    for(let i=0;i<mine.length;i+=500){
      const batch=writeBatch(db);
      mine.slice(i,i+500).forEach(n=>batch.update(doc(notifCol,n.id),{read:true}));
      await batch.commit();
    }
  }else{
    mine.forEach(n=>n.read=true);
    localSave();
    renderNotifPanel();
    updateNotifBadge();
  }
};
window.clearNotif=async function(id){
  if(USE_FIREBASE){
    try{await deleteDoc(doc(notifCol,id));}
    catch(e){showToastMsg('Could not clear that notification.');}
  }else{
    setNotifications(notifications.filter(n=>n.id!==id));
    knownNotifIds.delete(id);
    localSave();
    renderNotifPanel();
    updateNotifBadge();
  }
};
window.clearAllNotifs=async function(){
  if(!me||notifBulkClearing)return;
  const mine=notifications.filter(n=>n.userId===me.id);
  if(!mine.length)return;
  if(!confirm(`Clear all ${mine.length} notification(s) shown? Any older ones in the database will be removed too.`))return;
  notifBulkClearing=true;
  setNotifications([]);
  knownNotifIds=new Set();
  renderNotifPanel();
  updateNotifBadge();
  showToastMsg('Clearing notifications…');
  try{
    if(USE_FIREBASE){
      const total=await deleteAllNotifsForUser();
      showToastMsg(total?`Cleared ${total} notification(s).`:'Notifications cleared.');
    }else{
      const ids=new Set(mine.map(n=>n.id));
      setNotifications(notifications.filter(n=>!ids.has(n.id)));
      knownNotifIds=new Set();
      localSave();
      showToastMsg('Notifications cleared.');
    }
  }catch(e){
    console.error(e);
    showToastMsg('Could not clear all notifications. Check connection and try again.');
  }finally{
    notifBulkClearing=false;
    renderNotifPanel();
    updateNotifBadge();
  }
};

// ── DEADLINE BANNER ───────────────────────────────────────────────────────────
function showDeadlineBanner(){
  if(!me)return;
  const now=Date.now();
  const due=jobs.filter(j=>j.owner===me.id&&j.deadline&&j.status!=='completed'&&!j.workflow&&(j.deadline-now)<86400000&&(j.deadline-now)>-86400000*7);
  const banner=document.getElementById('dl-banner');
  if(!due.length){banner.style.display='none';return;}
  banner.style.display='block';
  banner.innerHTML='⏰ <strong>Upcoming deadlines:</strong> '+due.map(j=>`${j.client} (#${j.jobNum}) — ${fmt(j.deadline)}`).join(' | ');
}

// ── ACTIVITY LOG ──────────────────────────────────────────────────────────────
function activityCategory(type){
  if(type==='login'||type==='logout')return'auth';
  if(type==='broadcast')return'broadcast';
  if(type==='user_added'||type==='user_removed'||type==='user_edited')return'user';
  if(type==='created'||type==='assigned'||type==='started'||type==='completed'||type==='paused'||type==='resumed'||type==='edited'||
     type==='deleted'||type==='restored'||type==='pinned'||type==='reassigned'||type==='bulk_edit'||
     type==='extension_request'||type==='ext_approved'||type==='ext_rejected'||type==='comment')return'job';
  return'system';
}
export async function logActivity(entry){
  const j=entry.jobId?jobs.find(x=>x.id===entry.jobId):null;
  const logEntry={
    type:entry.type||'system',
    category:entry.category||activityCategory(entry.type),
    desc:entry.desc||'',
    userId:entry.userId||me?.id||'',
    userName:entry.userName||me?.name||'System',
    role:entry.role||me?.role||'',
    jobId:entry.jobId||'',
    client:entry.client||j?.client||'',
    jobNum:entry.jobNum||j?.jobNum||'',
    color:entry.color||'',
    ts:entry.ts||Date.now()
  };
  if(USE_FIREBASE){await addDoc(logCol,logEntry);}
  else{logEntry.id=uid();activityLogs.unshift(logEntry);localSave();renderActivityLog();}
  notifyForActivityLog(logEntry);
}
function normalizeActivityEntry(e){
  const type=e.type||((!e.desc&&!e.category&&e.userName)?'login':'system');
  return{
    ...e,
    type,
    category:e.category||activityCategory(type),
    desc:e.desc||(type==='login'?`${e.userName||'User'} signed in`:''),
    userName:e.userName||e.by||'System',
    userId:e.userId||e.byId||'',
    ts:toMillis(e.ts)||Date.now()
  };
}
function eventAlreadyInActivityLog(ev){
  const evTs=toMillis(ev.ts);
  return activityLogs.some(l=>
    l.jobId===ev.jobId&&l.type===ev.type&&l.desc===ev.desc&&
    Math.abs(toMillis(l.ts)-evTs)<3000
  );
}
function getAllActivityEntries(){
  const seen=new Set(),out=[];
  const push=raw=>{
    const e=normalizeActivityEntry(raw);
    const key=(e.id||'')+'|'+(e.ts||0)+'|'+(e.desc||'')+'|'+(e.type||'');
    if(seen.has(key))return;
    seen.add(key);
    out.push(e);
  };
  activityLogs.forEach(push);
  events.forEach(e=>{
    if(eventAlreadyInActivityLog(e))return;
    const j=jobs.find(x=>x.id===e.jobId);
    push({
      id:'ev-'+(e.id||e.ts),
      type:e.type,
      category:'job',
      userName:e.by||'System',
      userId:e.byId||'',
      role:users.find(u=>u.id===e.byId)?.role||'',
      ts:e.ts,
      desc:e.desc,
      jobId:e.jobId||'',
      client:j?.client||'',
      jobNum:j?.jobNum||'',
      color:e.color
    });
  });
  return out.sort((a,b)=>(b.ts||0)-(a.ts||0));
}
function populateActivityLogFilters(){
  const userSel=document.getElementById('alf-user');
  if(!userSel)return;
  const cur=userSel.value;
  userSel.innerHTML='<option value="">All users</option>'+
    users.map(u=>`<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
  userSel.value=cur;
}
window.setLogCat=function(cat,btn){
  const sel=document.getElementById('alf-category');
  if(sel)sel.value=cat;
  document.querySelectorAll('.log-cat').forEach(b=>b.classList.toggle('on',b.dataset.cat===cat));
  renderActivityLog();
};
// icon + color for each activity type
function activityVisual(type){
  const m={
    completed:['✓','green'],created:['+','blue'],started:['▶','blue'],assigned:['👔','purple'],
    reassigned:['🔄','purple'],paused:['⏸','yellow'],resumed:['▶','blue'],edited:['✏️','gray'],
    deleted:['🗑','red'],restored:['♻','green'],pinned:['📌','orange'],bulk_edit:['⚡','yellow'],
    extension_request:['📅','yellow'],ext_approved:['✅','green'],ext_rejected:['❌','red'],
    comment:['💬','blue'],broadcast:['📢','purple'],login:['🔓','gray'],logout:['🔒','gray'],
    user_added:['👤','green'],user_removed:['👤','red'],user_edited:['👤','gray'],
    report_export:['📥','gray'],jobs_archived:['📦','gray'],attachment_added:['📎','blue'],
    broadcast_edited:['📢','gray'],settings_changed:['⚙️','gray'],audit:['🔍','gray']
  };
  return m[type]||['•','gray'];
}
function activityDayLabel(ts){
  const d=new Date(toMillis(ts));d.setHours(0,0,0,0);
  const today=new Date();today.setHours(0,0,0,0);
  const diff=Math.round((today-d)/86400000);
  if(diff===0)return'Today';
  if(diff===1)return'Yesterday';
  return d.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'});
}
function filterActivityEntries(entries){
  const q=(document.getElementById('alf-q')?.value||'').toLowerCase();
  const cat=document.getElementById('alf-category')?.value||'';
  const typ=document.getElementById('alf-type')?.value||'';
  const usr=document.getElementById('alf-user')?.value||'';
  const from=document.getElementById('alf-from')?.value||'';
  const to=document.getElementById('alf-to')?.value||'';
  return entries.filter(e=>{
    const ts=toMillis(e.ts);
    if(cat&&e.category!==cat)return false;
    if(typ&&e.type!==typ)return false;
    if(usr&&e.userId!==usr)return false;
    if(from&&ts<new Date(from).getTime())return false;
    if(to&&ts>new Date(to).getTime()+86400000)return false;
    if(q){
      const hay=[e.desc,e.userName,e.client,e.jobNum,e.type,e.category,ACTIVITY_TYPE_LABELS[e.type]||''].join(' ').toLowerCase();
      if(!hay.includes(q))return false;
    }
    return true;
  });
}
let activityLogLimit=80;
function renderActivityLog(){
  const el=document.getElementById('login-log-list');if(!el)return;
  populateActivityLogFilters();
  const all=getAllActivityEntries();
  const filtered=filterActivityEntries(all).sort((a,b)=>toMillis(b.ts)-toMillis(a.ts));
  const cnt=document.getElementById('alf-count');
  if(cnt)cnt.textContent=filtered.length===all.length?`${filtered.length} records`:`${filtered.length} of ${all.length}`;

  // today summary
  const sumEl=document.getElementById('log-summary');
  if(sumEl){
    const today=new Date();today.setHours(0,0,0,0);
    const todayEntries=all.filter(e=>toMillis(e.ts)>=today.getTime());
    const c=t=>todayEntries.filter(e=>e.type===t).length;
    const bits=[];
    if(c('completed'))bits.push(`<strong>${c('completed')}</strong> completed`);
    if(c('created'))bits.push(`<strong>${c('created')}</strong> created`);
    if(c('assigned'))bits.push(`<strong>${c('assigned')}</strong> assigned`);
    if(c('login'))bits.push(`<strong>${c('login')}</strong> logins`);
    sumEl.innerHTML=todayEntries.length?`Today: ${bits.join(' · ')||todayEntries.length+' actions'}`:'No activity today yet.';
  }

  if(!filtered.length){
    el.innerHTML=`<div class="empty" style="padding:2rem;">${all.length?'No activity matches your filters.':'No activity logged yet.'}</div>`;
    return;
  }
  const shown=filtered.slice(0,activityLogLimit);
  // group by day
  let html='',lastDay=null;
  shown.forEach(e=>{
    const day=activityDayLabel(e.ts);
    if(day!==lastDay){
      if(lastDay!==null)html+='</div>';
      html+=`<div class="log-day-hd">${day}</div><div class="log-day-group">`;
      lastDay=day;
    }
    const [ico,color]=activityVisual(e.type);
    const time=new Date(toMillis(e.ts)).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
    const jobChip=e.jobNum?`<span class="log-jobchip" onclick="event.stopPropagation();openJobByNum('${escapeHtml(String(e.jobNum))}')">${e.client?escapeHtml(e.client)+' ':''}#${escapeHtml(String(e.jobNum))}</span>`:'';
    html+=`<div class="log-entry" title="${escapeHtml(fmt(e.ts))}">
      <span class="log-ico log-ico-${color}">${ico}</span>
      <div class="log-entry-body">
        <div class="log-entry-desc">${escapeHtml(e.desc||ACTIVITY_TYPE_LABELS[e.type]||'Activity')}</div>
        <div class="log-entry-meta">${escapeHtml(e.userName||'System')}${e.role?` · ${escapeHtml(e.role)}`:''} · ${time} ${jobChip}</div>
      </div>
    </div>`;
  });
  if(lastDay!==null)html+='</div>';
  if(filtered.length>activityLogLimit){
    html+=`<button class="log-loadmore" onclick="activityLogLimit+=80;renderActivityLog()">Load more (${filtered.length-activityLogLimit} remaining)</button>`;
  }
  el.innerHTML=html;
}
window.renderActivityLog=renderActivityLog;
window.openJobByNum=function(num){
  const j=jobs.find(x=>String(x.jobNum)===String(num));
  if(j&&window.openJobDetail)openJobDetail(j.id);
};
window.clearActivityLogFilters=function(){
  ['alf-q','alf-from','alf-to'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  ['alf-category','alf-type','alf-user'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  renderActivityLog();
};
window.exportActivityLogCSV=function(){
  const filtered=filterActivityEntries(getAllActivityEntries());
  if(!filtered.length){alert('No activity to export.');return;}
  const headers=['Timestamp','Action Type','Category','User','Role','Description','Job ID','Client','Job #'];
  const rows=filtered.map(e=>[
    fmt(e.ts),ACTIVITY_TYPE_LABELS[e.type]||e.type,e.category||'',e.userName||'',e.role||'',
    e.desc||'',e.jobId||'',e.client||'',e.jobNum||''
  ]);
  const csv=[headers,...rows].map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n');
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download=`RMI_activity_log_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
};

// ── EVENTS / AUDIT TRAIL ──────────────────────────────────────────────────────
export async function addEvent(jobId,type,desc,color='blue'){
  const e={jobId,type,desc,by:me?.name||'System',byId:me?.id||'',ts:Date.now(),color};
  if(USE_FIREBASE){
    await addDoc(evCol,e);
    const j=jobs.find(x=>x.id===jobId);
    await logActivity({type,category:'job',desc,userId:me?.id,userName:me?.name,role:me?.role,jobId,client:j?.client,jobNum:j?.jobNum,color});
  }else{
    e.id=uid();events.unshift(e);localSave();
    const j=jobs.find(x=>x.id===jobId);
    await logActivity({type,category:'job',desc,userId:me?.id,userName:me?.name,role:me?.role,jobId,client:j?.client,jobNum:j?.jobNum,color});
  }
  notifyForJobEvent(jobId,type,desc);
}
export function getJobEvents(jobId){return events.filter(e=>e.jobId===jobId).sort((a,b)=>(b.ts||0)-(a.ts||0));}

function renderTimeline(jobId){
  const evs=getJobEvents(jobId);
  if(!evs.length)return'<div style="color:var(--text2);font-size:0.78rem;font-style:italic;">No activity yet.</div>';
  let h='<div class="timeline">';
  evs.forEach((e,i)=>{
    h+=`<div class="tl-item"><div class="tl-dot ${e.color||'blue'}"></div><div class="tl-line"><div class="tl-what">${e.desc}</div><div class="tl-meta">${fmt(e.ts)}</div></div></div>`;
    if(i<evs.length-1)h+=`<div class="tl-connector"></div>`;
  });
  h+='</div>';return h;
}

// ── RENDER JOBS ───────────────────────────────────────────────────────────────
function applyJobsViewLayout(){}  // no-op, kept for compat

function renderJobs(){
  const wrap=document.getElementById('jobs-scope-wrap');
  if(wrap&&me)wrap.style.display=(me.role==='manager')?'inline-flex':'none';
  const list=document.getElementById('jobs-list');
  if(!list||!me)return;
  try{
    const q=(document.getElementById('srch')?.value||'').toLowerCase();
    let mine=(window._jobsForDisplay||visibleJobs)();
    let ef=myFilter;
    if(ef==='pending')mine=mine.filter(j=>j.status==='pending');
    else if(ef==='ongoing')mine=mine.filter(j=>j.status==='ongoing');
    else if(ef==='paused')mine=mine.filter(j=>j.status==='paused');
    else if(ef==='completed')mine=mine.filter(j=>j.status==='completed');
    else if(ef==='assigned')mine=mine.filter(j=>j.owner===me.id&&j.managerAssigned);
    else if(ef==='overdue')mine=mine.filter(j=>j.status!=='completed'&&isOverdue(j));
    else if(ef==='pinned')mine=mine.filter(j=>j.pinned);
    if(q)mine=mine.filter(j=>(j.client||'').toLowerCase().includes(q)||(j.jobNum||'').toLowerCase().includes(q)||(j.notes||'').toLowerCase().includes(q)||(j.tags||[]).some(t=>t.toLowerCase().includes(q)));
    const _pager=window._renderJobsPager||(()=>{});
    const total=mine.length;
    const page=userSettings.jobsPage||0;
    const slice=mine.slice(page*JOBS_PAGE_SIZE,(page+1)*JOBS_PAGE_SIZE);
    if(page>0&&slice.length===0){userSettings.jobsPage=0;saveUserSettings();return renderJobs();}
    const paged=[...slice.filter(j=>j.pinned),...slice.filter(j=>!j.pinned)];
    const active=paged.filter(j=>j.status!=='completed');
    const done=paged.filter(j=>j.status==='completed');
    list.innerHTML=renderJobsTable(active,done);
    _pager(total);
    updateTabBadges();
  }catch(err){
    console.error('renderJobs error:',err);
    list.innerHTML=`<div style="padding:1.5rem;color:var(--red);font-family:var(--mono);font-size:0.8rem;">⚠ Render error: ${err.message}</div>`;
  }
}

window.toggleCompleted=function(btn){
  const cl=document.getElementById('completed-list');
  if(!cl)return;
  const open=cl.style.display!=='none';
  cl.style.display=open?'none':'';
  const n=cl.querySelectorAll('tr.job-row').length;
  btn.innerHTML=open?`✅ Completed (${n}) ▼`:`✅ Completed (${n}) ▲`;
};

// ── TABLE VIEW ────────────────────────────────────────────────────────────────
function jobsFilterBar(){
  const f=myFilter||'all';
  const q=(document.getElementById('srch')?.value||'').trim();
  const list=[
    {id:'all',label:'All'},
    {id:'pending',label:'🟡 Pending'},
    {id:'ongoing',label:'🔵 Ongoing'},
    {id:'paused',label:'⏸ Paused'},
    {id:'completed',label:'✅ Done'},
    {id:'overdue',label:'⚠️ Overdue'},
    {id:'assigned',label:'👔 Mine'},
    {id:'pinned',label:'📌 Pinned'},
  ];
  const tabs=list.map(x=>`<button onclick="setF('${x.id}')" id="f-${x.id}" class="jtab-btn${f===x.id?' jtab-on':''}">${x.label}</button>`).join('');
  const searchChip=q?`<span class="jobs-search-chip">🔍 "${escapeHtml(q)}" <button onclick="document.getElementById('srch').value='';renderAll()" title="Clear search">×</button></span>`:'';
  return`<div class="jobs-integrated-bar">
    <div class="jtab-left">${tabs}${searchChip}</div>
    <div class="jtab-right" id="jobs-pager"></div>
  </div>`;
}

// ── SHARED JOB DETAIL PANEL (used by List expand + Board modal) ───────────────
function jobDetailHTML(j){
  const now=Date.now(),od=isOverdue(j);
  const own=users.find(u=>u.id===j.owner)?.name||j.owner||'—';
  const canEdit=canManageJob(j);
  const canDelete=me&&(me.id===j.owner||me.role==='manager'||(isTeamLeader()&&myTeamIds().includes(j.owner)))&&(!j.managerAssigned||me.role==='manager'||isTeamLeader());
  const canSup=isLead();
  // duration / pause breakdown
  let durHtml='';
  if(j.started||j.completed){
    const {totalMs,pausedMs,activeMs}=getJobDurationBreakdown(j);
    if(j.status==='completed'){
      durHtml=pausedMs>0
        ?`Took <strong>${tdiff(0,totalMs)}</strong> &nbsp;·&nbsp; ${tdiff(0,activeMs)} active, ${tdiff(0,pausedMs)} paused`
        :`Took <strong>${tdiff(0,totalMs)}</strong>`;
    }else if(j.status==='paused'){
      const curPause=j.pausedAt?now-toMillis(j.pausedAt):0;
      durHtml=`<span class="tc-yellow">⏸ Paused${j.pausedAt?' since '+fmt(j.pausedAt):''}</span> &nbsp;·&nbsp; this pause ${tdiff(0,curPause)}, total ${tdiff(0,pausedMs)}`;
    }else if((j.totalPausedMs||0)>0){
      durHtml=`Active ${tdiff(0,activeMs)} &nbsp;·&nbsp; ${tdiff(0,pausedMs)} paused total`;
    }
  }
  const dlInfo=j.deadline?(()=>{const diff=j.deadline-now;const c=diff<0?'tc-red':diff<86400000?'tc-yellow':'';return`<span class="${c}">${fmt(j.deadline)}</span>`;})():'—';
  const pendingExt=typeof extRequests!=='undefined'?extRequests.find(r=>r.jobId===j.id&&r.status==='pending'):null;
  const stChip=od?'<span class="st-chip st-overdue">Overdue</span>':
    j.status==='ongoing'?'<span class="st-chip st-ongoing">Ongoing</span>':
    j.status==='paused'?'<span class="st-chip st-paused">Paused</span>':
    j.status==='completed'?'<span class="st-chip st-done">Done</span>':
    '<span class="st-chip st-pending">Pending</span>';
  const srcBadge=j.managerAssigned?'<span class="bdg bdg-m">👔 Assigned</span>':'<span class="bdg bdg-s">✏️ Self-added</span>';
  let actions='';
  if(canEdit){
    if(j.status==='pending')actions+=`<button class="jd-btn bs" onclick="startJob('${j.id}')">▶ Start</button>`;
    if(j.status==='ongoing')actions+=`<button class="jd-btn" onclick="pauseJob('${j.id}')">⏸ Pause</button><button class="jd-btn bc" onclick="doneJob('${j.id}')">✓ Complete</button>`;
    if(j.status==='paused')actions+=`<button class="jd-btn bs" onclick="resumeJob('${j.id}')">▶ Resume</button><button class="jd-btn bc" onclick="doneJob('${j.id}')">✓ Complete</button>`;
    actions+=`<button class="jd-btn" onclick="editJob('${j.id}')">✏️ Edit</button>`;
    actions+=`<button class="jd-btn" onclick="pinJob('${j.id}')">${j.pinned?'📌 Unpin':'📌 Pin'}</button>`;
    if(canSup)actions+=`<button class="jd-btn" onclick="openReassignModal('${j.id}')">🔄 Reassign</button>`;
    if(j.deadline&&j.status!=='completed'){
      if(pendingExt)actions+=`<button class="jd-btn" disabled style="opacity:0.55;" title="Extension pending — awaiting review">📅 Extension Pending</button>`;
      else actions+=`<button class="jd-btn" onclick="openExtModal('${j.id}')">📅 Extend</button>`;
    }
    actions+=`<button class="jd-btn" onclick="expTXT('${j.id}')">📄 TXT</button>`;
    actions+=`<button class="jd-btn jd-tl-btn" onclick="toggleTimeline('${j.id}')">🕐 Timeline</button>`;
    if(canDelete)actions+=`<button class="jd-btn jd-btn-danger" onclick="delJob('${j.id}')">🗑 Delete</button>`;
  }
  const tags=(j.tags||[]).length?`<div class="jd-tags">${j.tags.map(t=>`<span class="bdg bdg-tag">#${escapeHtml(t)}</span>`).join(' ')}</div>`:'';
  const notes=j.notes?`<div class="jd-note">📝 ${escapeHtml(j.notes)}</div>`:'';
  const mgNote=(canSup&&j.managerNote)?`<div class="jd-note jd-note-mgr">🔒 Manager note: ${escapeHtml(j.managerNote)}</div>`:'';
  const compNote=j.completionNote?`<div class="jd-note jd-note-done">✅ ${escapeHtml(j.completionNote)}</div>`:'';
  return`<div class="job-detail">
    <div class="jd-grid">
      <div class="jd-field"><span class="jd-k">Type</span><span class="jd-v">${escapeHtml(j.type)}</span></div>
      <div class="jd-field"><span class="jd-k">Status</span><span class="jd-v">${stChip}</span></div>
      <div class="jd-field"><span class="jd-k">Employee</span><span class="jd-v">${escapeHtml(own)}</span></div>
      <div class="jd-field"><span class="jd-k">Priority</span><span class="jd-v">${j.priority||'—'}</span></div>
      <div class="jd-field"><span class="jd-k">Source</span><span class="jd-v">${srcBadge}</span></div>
      <div class="jd-field"><span class="jd-k">Deadline</span><span class="jd-v">${dlInfo}</span></div>
      <div class="jd-field"><span class="jd-k">Created</span><span class="jd-v">${fmt(j.created)}</span></div>
      ${j.started?`<div class="jd-field"><span class="jd-k">Started</span><span class="jd-v">${fmt(j.started)}</span></div>`:''}
    </div>
    ${durHtml?`<div class="jd-duration">⏱ ${durHtml}</div>`:''}
    ${tags}${notes}${mgNote}${compNote}
    ${actions?`<div class="jd-actions">${actions}</div>`:''}
    <div id="tl-${j.id}" class="jd-timeline" style="display:none;"></div>
  </div>`;
}
window.toggleJobDetail=function(id){
  closeRowMenus();
  const row=document.getElementById('detail-row-'+id);
  if(!row)return;
  const open=row.style.display!=='none';
  row.style.display=open?'none':'';
  document.getElementById('card-'+id)?.classList.toggle('detail-open',!open);
  if(!open){
    const j=jobs.find(x=>x.id===id);
    const c=document.getElementById('detail-'+id);
    if(j&&c)c.innerHTML=jobDetailHTML(j);
  }
};
window.openJobDetail=function(id){
  const j=jobs.find(x=>x.id===id);if(!j)return;
  document.getElementById('jobdetail-title').innerHTML=`${j.pinned?'📌 ':''}${escapeHtml(j.client)} <span style="color:var(--text3);font-weight:400;">#${escapeHtml(j.jobNum)}</span>`;
  const body=document.getElementById('jobdetail-body');
  body.innerHTML=jobDetailHTML(j);
  // close modal after any action except Timeline (the board re-renders behind it)
  body.querySelectorAll('.jd-btn').forEach(b=>{
    if(b.classList.contains('jd-tl-btn'))return;
    b.addEventListener('click',()=>setTimeout(closeJobDetail,60));
  });
  document.getElementById('job-detail-modal').classList.add('open');
};
window.closeJobDetail=function(){document.getElementById('job-detail-modal').classList.remove('open');};

function renderJobsTable(active,done){
  const showEmp=canSeeAllJobs();
  const cols=showEmp?9:8;
  const thead=`<thead><tr class="jobs-th-row">
    <th style="width:28px;"></th>
    <th style="width:28px;"></th>
    <th>Client</th><th>Job #</th><th class="col-type">Type</th>
    <th>Status</th><th>Priority</th><th>Deadline</th>
    ${showEmp?'<th class="col-emp">Employee</th>':''}
    <th style="min-width:130px;"></th>
  </tr></thead>`;
  const empty=!active.length&&!done.length;
  const activeRows=empty?`<tr><td colspan="${cols}" style="padding:2rem;text-align:center;color:var(--text2);">No jobs match this filter.</td></tr>`:active.map(j=>jobTableRow(j,showEmp)).join('');
  let html=`<div class="jobs-table-wrap">
    ${jobsFilterBar()}
    <table class="jobs-table">${thead}<tbody>${activeRows}</tbody></table>
  </div>`;
  if(done.length){
    const doneRows=done.map(j=>jobTableRow(j,showEmp)).join('');
    html+=`<div class="jobs-completed-section" style="margin-top:0.75rem;">
      <button type="button" onclick="toggleCompleted(this)" class="completed-toggle">✅ Completed (${done.length}) ▼</button>
      <div id="completed-list" style="display:none;margin-top:0.35rem;">
        <div class="jobs-table-wrap"><table class="jobs-table">${thead}<tbody>${doneRows}</tbody></table></div>
      </div>
    </div>`;
  }
  return html;
}


function jobTableRow(j,showEmp){
  const now=Date.now(),od=isOverdue(j);
  const own=users.find(u=>u.id===j.owner)?.name||'—';
  const canEdit=canManageJob(j);
  const canDelete=me&&(me.id===j.owner||me.role==='manager'||(isTeamLeader()&&myTeamIds().includes(j.owner)))&&(!j.managerAssigned||me.role==='manager'||isTeamLeader());
  const cols=showEmp?9:8;
  const stChip=od?'<span class="st-chip st-overdue">Overdue</span>':
    j.status==='ongoing'?'<span class="st-chip st-ongoing">Ongoing</span>':
    j.status==='paused'?'<span class="st-chip st-paused">Paused</span>':
    j.status==='completed'?'<span class="st-chip st-done">Done</span>':
    '<span class="st-chip st-pending">Pending</span>';
  const priDot=j.priority==='High'?'<span class="dot dot-red" title="High"></span>':
    j.priority==='Medium'?'<span class="dot dot-yellow" title="Medium"></span>':
    '<span class="dot dot-gray" title="Low"></span>';
  let dlHtml='<span class="tc-muted">—</span>';
  if(j.deadline){const diff=j.deadline-now;dlHtml=`<span class="${diff<0?'tc-red':diff<86400000?'tc-yellow':''}">${fmt(j.deadline)}</span>`;}
  let primary='';
  if(canEdit){
    if(j.status==='pending')primary=`<button class="tbl-btn bs" onclick="startJob('${j.id}')">▶ Start</button>`;
    else if(j.status==='ongoing')primary=`<button class="tbl-btn" onclick="pauseJob('${j.id}')">⏸</button><button class="tbl-btn bc" onclick="doneJob('${j.id}')">✓ Done</button>`;
    else if(j.status==='paused')primary=`<button class="tbl-btn bs" onclick="resumeJob('${j.id}')">▶</button><button class="tbl-btn bc" onclick="doneJob('${j.id}')">✓</button>`;
  }
  const moreBtn=canEdit?`<button class="tbl-more-btn" onclick="toggleRowMenu(event,'rmenu-${j.id}')" title="More">⋯</button>
    <div class="row-menu" id="rmenu-${j.id}">
      <button onclick="editJob('${j.id}');closeRowMenus();">✏️ Edit</button>
      <button onclick="pinJob('${j.id}');closeRowMenus();">${j.pinned?'Unpin':'📌 Pin'}</button>
      ${isLead()?`<button onclick="openReassignModal('${j.id}');closeRowMenus();">🔄 Reassign</button>`:''}
      ${j.deadline&&j.status!=='completed'?`<button onclick="openExtModal('${j.id}');closeRowMenus();">📅 Extend</button>`:''}
      <button onclick="expTXT('${j.id}');closeRowMenus();">📄 Export TXT</button>
      ${canDelete?`<button class="menu-danger" onclick="delJob('${j.id}');closeRowMenus();">🗑 Delete</button>`:''}
    </div>`:''
  ;
  const notesPreview=j.notes?`<div class="tc-note">${escapeHtml(j.notes.substring(0,60))}${j.notes.length>60?'…':''}</div>`:'';
  const stKey=od?'overdue':j.status;
  return`<tr id="card-${j.id}" class="job-row row-st-${stKey}${od?' row-overdue':''}${selectedJobs.has(j.id)?' row-selected':''}${j.pinned?' row-pinned':''}" onclick="if(!event.target.closest('button,input,.row-menu'))toggleJobDetail('${j.id}')">
    <td style="padding-left:0.65rem;" onclick="event.stopPropagation()"><input type="checkbox" class="sel-cb" ${selectedJobs.has(j.id)?'checked':''} onchange="toggleSelect('${j.id}',this)"/></td>
    <td><button class="tl-toggle-btn" onclick="event.stopPropagation();toggleJobDetail('${j.id}')" title="Details">›</button></td>
    <td><span class="tc-client">${j.pinned?'📌 ':''}${escapeHtml(j.client)}</span>${notesPreview}</td>
    <td class="tc-muted" style="white-space:nowrap;">#${escapeHtml(j.jobNum)}</td>
    <td class="col-type tc-muted">${escapeHtml(j.type)}</td>
    <td>${stChip}</td>
    <td class="tc-pri" style="white-space:nowrap;">${priDot}</td>
    <td class="tc-dl">${dlHtml}</td>
    ${showEmp?`<td class="col-emp tc-muted">${escapeHtml(own)}</td>`:''}
    <td class="tc-actions" style="position:relative;text-align:right;" onclick="event.stopPropagation()">${primary}${moreBtn}</td>
  </tr>
  <tr id="detail-row-${j.id}" class="jd-expand-row" style="display:none;">
    <td colspan="${cols}" style="padding:0;">
      <div id="detail-${j.id}"></div>
    </td>
  </tr>`;
}

window.toggleRowMenu=function(e,id){
  e.stopPropagation();
  const menu=document.getElementById(id);
  if(!menu)return;
  const isOpen=menu.classList.contains('open');
  closeRowMenus();
  if(!isOpen)menu.classList.add('open');
};
window.closeRowMenus=function(){
  document.querySelectorAll('.row-menu.open').forEach(m=>m.classList.remove('open'));
};
document.addEventListener('click',()=>closeRowMenus());

export function isOverdue(j){
  if(j.status==='completed')return false;
  const now=Date.now();
  if(j.deadline&&j.deadline<now)return true;
  if(j.status==='pending'&&now-j.created>172800000)return true;
  if(j.status==='ongoing'&&j.started&&now-j.started>259200000)return true;
  return false;
}
function computeSlaStats(scope){
  const done=scope.filter(j=>j.completed&&j.deadline);
  const onTime=done.filter(j=>toMillis(j.completed)<=toMillis(j.deadline));
  const open=scope.filter(j=>j.status!=='completed'&&j.deadline);
  const overdueOpen=open.filter(j=>isOverdue(j));
  return{onTimePct:done.length?Math.round(onTime.length/done.length*100):0,doneWithDl:done.length,overdueOpen:overdueOpen.length,openWithDl:open.length};
}

function card(j,acts){
  const now=Date.now();
  const od=isOverdue(j);
  const pc=j.priority==='High'?'ph':j.priority==='Medium'?'pm':'';
  const sc=j.managerAssigned?'mgr':'self';
  const pinCls=j.pinned?'pinned':'';
  const selCls=selectedJobs.has(j.id)?'selected':'';
  const own=users.find(u=>u.id===j.owner)?.name||j.owner||'—';
  let dl='';
  if(j.deadline){
    const diff=j.deadline-now;
    const col=diff<0?'var(--red)':diff<86400000?'var(--yellow)':'var(--text2)';
const lbl=j.status==='completed'?'📅 Deadline':diff<0?'⚠️ OVERDUE':diff<86400000?'⏰ Due soon':'📅 Deadline';
    dl=`<br><span style="color:${col};font-weight:500;">${lbl}: ${fmt(j.deadline)}</span>`;
  }
  const sb=j.managerAssigned?'<span class="bdg bdg-m">👔 Assigned</span>':'<span class="bdg bdg-s">✏️ Self-added</span>';
  const pb=`<span class="bdg bdg-${j.priority==='High'?'h':j.priority==='Medium'?'med':'l'}">${j.priority}</span>`;
  const tags=(j.tags||[]).length?'<br>'+j.tags.map(t=>`<span class="bdg bdg-tag">#${t}</span>`).join(' '):'';
  const pinIcon=j.pinned?'📌':'📍';
  const canSeeManagerNote=isLead();
  const mgNoteHtml=canSeeManagerNote&&j.managerNote?`<br><span style="color:var(--purple);font-size:0.76rem;">🔒 Manager note: ${j.managerNote}</span>`:'';
  const compNoteHtml=j.completionNote?`<br><span style="color:var(--green);font-size:0.76rem;">✅ ${j.completionNote}</span>`:'';
  const canEdit=canManageJob(j);
  const canDelete=me&&(me.id===j.owner||me.role==='manager')&&(!j.managerAssigned||me.role==='manager');
  let ab='';
  if(acts&&canEdit){
    ab=`<div class="arow">
      <input type="checkbox" class="sel-cb" ${selectedJobs.has(j.id)?'checked':''} onchange="toggleSelect('${j.id}',this)"/>
      <button class="star-btn ${j.pinned?'starred':''}" onclick="pinJob('${j.id}')" title="Pin">${pinIcon}</button>
      ${j.status==='pending'?`<button class="bs" onclick="startJob('${j.id}')">▶ Start</button>`:''}
      ${j.status==='ongoing'?`<button onclick="pauseJob('${j.id}')" title="Pause">⏸ Pause</button><button class="bc" onclick="doneJob('${j.id}')">✅ Complete</button>`:''}
      ${j.status==='paused'?`<button class="bs" onclick="resumeJob('${j.id}')">▶ Resume</button><button class="bc" onclick="doneJob('${j.id}')">✅ Complete</button>`:''}
      <button onclick="editJob('${j.id}')">✏️ Edit</button>
      ${canDelete?`<button class="bd" onclick="delJob('${j.id}')">🗑</button>`:''}
      ${isLead()?`<button onclick="openReassignModal('${j.id}')">🔄 Reassign</button>`:''}
      ${j.deadline&&j.status!=='completed'?`<button onclick="openExtModal('${j.id}')">📅 Extend</button>`:''}
      <button onclick="expTXT('${j.id}')">📄 TXT</button>
      <button onclick="toggleTimeline('${j.id}')">🕐 Timeline</button>
    </div>
    <div id="tl-${j.id}" style="display:none;margin-top:0.5rem;">${renderTimeline(j.id)}${renderCommentSection(j.id)}</div>`;
  }
  else if(acts&&amDirector()){
    // directors: read-only — timeline + comment only, no action buttons
    ab=`<div class="arow"><button onclick="toggleTimeline('${j.id}')">🕐 Timeline</button></div>
    <div id="tl-${j.id}" style="display:none;margin-top:0.5rem;">${renderTimeline(j.id)}${renderCommentSection(j.id)}</div>`;
  }
  const stLbl=j.status==='paused'?'<span class="bdg" style="background:#3a3a3a;color:var(--yellow);">⏸ paused</span>':`<strong>${j.status}</strong>`;
  return`<div class="card ${pc} ${sc} ${pinCls} ${selCls} ${j.status==='paused'?'paused':''} ${od?'od':''}" id="card-${j.id}">
    <h4>${j.pinned?'📌 ':''}<span>${j.client}</span> <span style="font-weight:400;color:var(--text2);">(#${j.jobNum})</span>${sb}${pb}</h4>
    <div class="meta">Type: ${j.type} | Status: ${stLbl} | Employee: ${own}${dl}${tags}${mgNoteHtml}${compNoteHtml}<br>
    Created: ${fmt(j.created)}${j.started?`<br>Started: ${fmt(j.started)}`:''}${formatJobDurationHtml(j)}${j.notes?`<br>📝 ${j.notes}`:''}</div>${ab}</div>`;
}

window.toggleTimeline=async function(id){
  closeRowMenus();
  const el=document.getElementById('tl-'+id);
  if(!el)return;
  const open=el.style.display==='block';
  el.style.display=open?'none':'block';
  if(!open){await refreshJobEventsRemote(id);el.innerHTML=renderTimeline(id)+renderCommentSection(id);}
};

// ── BULK ACTIONS ──────────────────────────────────────────────────────────────
window.toggleSelect=function(id,cb){
  if(cb.checked)selectedJobs.add(id);else selectedJobs.delete(id);
  const card=document.getElementById('card-'+id);
  if(card)card.classList.toggle('selected',cb.checked);
  updateBulkBar();
};
function updateBulkBar(){
  const bar=document.getElementById('bulk-bar');
  bar.style.display=selectedJobs.size>0?'flex':'none';
  document.getElementById('bulk-count').textContent=selectedJobs.size+' selected';
}
function clearSelection(){selectedJobs.clear();updateBulkBar();renderJobs();}
window.clearSelection=clearSelection;
window.bulkChangeStatus=async function(){
  const st=document.getElementById('bulk-status').value;if(!st)return;
  showConfirm('Change Status',`Change ${selectedJobs.size} job(s) to "${st}"?`,async()=>{
    for(const id of selectedJobs){
      const j=jobs.find(x=>x.id===id);
      const patch={status:st};
      if(st==='ongoing'){patch.started=j?.started||Date.now();patch.pausedAt=null;}
      if(st==='paused'&&j?.status==='ongoing'){patch.pausedAt=Date.now();}
      if(st==='paused'&&j?.status!=='ongoing'){continue;}
      if(st==='completed'){
        let totalPausedMs=j?.totalPausedMs||0;
        if(j?.status==='paused'&&j.pausedAt)totalPausedMs+=Date.now()-toMillis(j.pausedAt);
        const completed=Date.now();
        const br=getJobDurationBreakdown({...j,status:'completed',completed,totalPausedMs,pausedAt:null});
        Object.assign(patch,{completed,pausedAt:null,totalPausedMs,durationTotalMs:br.totalMs,durationPausedMs:br.pausedMs,durationActiveMs:br.activeMs});
      }
      if(st!=='completed')patch.completed=null;
      await jUpdate(id,patch);
      await addEvent(id,'bulk_edit',`${me.name} bulk-changed status to ${st}`,'yellow');
    }
    clearSelection();
  },'Apply',false);
};
window.bulkReassign=async function(){
  const toId=document.getElementById('bulk-reassign').value;if(!toId)return;
  const toName=users.find(u=>u.id===toId)?.name||toId;
  showConfirm('Bulk Reassign',`Reassign ${selectedJobs.size} job(s) to ${toName}?`,async()=>{
    for(const id of selectedJobs){
      const j=jobs.find(x=>x.id===id);
      const fromName=users.find(u=>u.id===j?.owner)?.name||'unknown';
      await jUpdate(id,{owner:toId});
      await addEvent(id,'reassigned',`${me.name} bulk-reassigned from ${fromName} to ${toName}`,'purple');
      notifyReassign(j,j?.owner,toId,me.name);
    }
    clearSelection();
  },'Reassign',false);
};
window.bulkDelete=async function(){
  showConfirm('Delete Selected',`Permanently delete ${selectedJobs.size} job(s)?`,async()=>{
    for(const id of selectedJobs){
      const j=jobs.find(x=>x.id===id);
      if(j?.managerAssigned&&me.role!=='manager')continue;
      await addEvent(id,'deleted',`${me.name} bulk-deleted job${j?` — ${j.client} (#${j.jobNum})`:''}`,'red');
      await jDelete(id);
    }
    clearSelection();
  },'Delete',true);
};

// ── SUMMARY & BADGES ─────────────────────────────────────────────────────────
function updateSummary(){
  const el=document.getElementById('summary');
  if(!el)return;
  const m=visibleJobs();
  const pending=m.filter(j=>j.status==='pending').length;
  const ongoing=m.filter(j=>j.status==='ongoing').length;
  const paused=m.filter(j=>j.status==='paused').length;
  const completed=m.filter(j=>j.status==='completed').length;
  const overdue=m.filter(j=>isOverdue(j)).length;
  const total=m.length||1;
  const slices=[
    {val:pending,  color:'#ffd60a',label:'Pending'},
    {val:ongoing,  color:'#0a84ff',label:'Ongoing'},
    {val:paused,   color:'#6e6e73',label:'Paused'},
    {val:completed,color:'#32d74b',label:'Done'},
  ];
  // Build SVG pie
  const size=34,cx=17,cy=17,r=14;
  let svgPaths='',start=0;
  const nonZero=slices.filter(s=>s.val>0);
  if(nonZero.length===1){
    // full circle
    const s=nonZero[0];
    svgPaths=`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${s.color}"/>`;
  } else {
    slices.forEach(s=>{
      if(!s.val)return;
      const frac=s.val/total;
      const angle=frac*2*Math.PI;
      const x1=cx+r*Math.sin(start), y1=cy-r*Math.cos(start);
      const x2=cx+r*Math.sin(start+angle), y2=cy-r*Math.cos(start+angle);
      const large=angle>Math.PI?1:0;
      svgPaths+=`<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z" fill="${s.color}"/>`;
      start+=angle;
    });
  }
  const tooltip=`Pending: ${pending} · Ongoing: ${ongoing} · Paused: ${paused} · Done: ${completed}${overdue?` · ⚠ ${overdue} overdue`:''}`;
  el.innerHTML=`<div class="summary-pie-wrap" title="${tooltip}">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="display:block;">
      ${svgPaths}
      <circle cx="${cx}" cy="${cy}" r="7" fill="var(--bg)"/>
    </svg>
    <div class="summary-pie-tooltip">
      ${slices.map(s=>`<div class="spt-row"><span class="spt-dot" style="background:${s.color}"></span>${s.label}: <strong>${s.val}</strong></div>`).join('')}
      ${overdue?`<div class="spt-row spt-overdue"><span class="spt-dot" style="background:var(--red)"></span>Overdue: <strong>${overdue}</strong></div>`:''}
      <div class="spt-total">Total: ${total}</div>
    </div>
  </div>`;
}
function updateTabBadges(){
  if(!me)return;
  const mine=jobs.filter(j=>j.owner===me.id&&j.status!=='completed'&&!j.workflow);
  setTabBadge('my-jobs',mine.length);
  const overdue=jobs.filter(j=>isOverdue(j)&&!j.workflow).length;
  if(overdue)setTabBadge('board',overdue,'⚠');
}
function setTabBadge(tab,count,prefix=''){
  const btn=document.querySelector(`nav button[data-tab="${tab}"]`);if(!btn)return;
  let badge=btn.querySelector('.tab-badge');
  if(!badge){badge=document.createElement('span');badge.className='tab-badge';btn.appendChild(badge);}
  badge.style.display=count>0?'flex':'none';
  badge.textContent=(prefix||'')+count;
}

// ── TEAM BOARD ────────────────────────────────────────────────────────────────
export function renderBoard(){
  const bj=visibleJobs();
  const emps=teamUsersForView().filter(u=>isTeamLeader()?u.id!==me.id:true).sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  const now=new Date(),ws=new Date(now);ws.setDate(now.getDate()-now.getDay());
  const overdue=bj.filter(j=>isOverdue(j));
  document.getElementById('tstats').innerHTML=`
    <div class="sc"><div class="n" style="color:var(--yellow)">${bj.filter(j=>j.status==='pending').length}</div><div class="l">Pending</div></div>
    <div class="sc"><div class="n" style="color:var(--blue)">${bj.filter(j=>j.status==='ongoing').length}</div><div class="l">Ongoing</div></div>
    <div class="sc"><div class="n" style="color:var(--green)">${bj.filter(j=>j.status==='completed').length}</div><div class="l">Completed</div></div>
    <div class="sc"><div class="n" style="color:var(--red)">${bj.filter(j=>j.completed&&new Date(j.completed)>=ws).length}</div><div class="l">Done This Week</div></div>
    <div class="sc"><div class="n" style="color:var(--red)">${overdue.length}</div><div class="l">⚠ Overdue</div></div>`;
  document.getElementById('wload').innerHTML=emps.length?emps.map(u=>{
    const a=jobs.filter(j=>j.owner===u.id&&j.status!=='completed'&&!j.workflow).length;
    const od=empOverdueJobs(u.id).length;
    const col=od>0?'var(--red)':a>=5?'var(--red)':a>=3?'var(--yellow)':'var(--green)';
    const lbl=od>0?`⚠ ${od} overdue`:a>=5?'🔴 Overloaded':a>=3?'🟡 Busy':'🟢 OK';
    const pct=Math.min(100,Math.round(a/6*100));
    return`<div style="margin-bottom:0.6rem;"><div style="display:flex;justify-content:space-between;font-size:0.82rem;margin-bottom:2px;flex-wrap:wrap;gap:0.25rem;"><span><strong>${escapeHtml(u.name)}</strong>${od>0?` <span style="color:var(--red);font-weight:600;">⚠ ${od} overdue</span>`:''}</span><span style="font-family:var(--mono);color:var(--text2);">${a} active — ${lbl}</span></div><div class="lbw"><div class="lb" style="width:${pct}%;background:${col}"></div></div></div>`;
  }).join(''):'<div class="empty">No team members yet.</div>';
  const sorted=[...emps].sort((a,b)=>empOverdueJobs(b.id).length-empOverdueJobs(a.id).length);
  const tboardEl=document.getElementById('tboard');
  tboardEl.innerHTML=`<div class="board-controls">
    <input class="board-search" id="board-search" placeholder="Filter employees..." oninput="filterBoard(this.value)"/>
    <button class="tbl-btn" onclick="boardExpandAll(true)">Expand All</button>
    <button class="tbl-btn" onclick="boardExpandAll(false)">Collapse All</button>
  </div>`+(sorted.length?sorted.map(u=>{
    const ej=bj.filter(j=>j.owner===u.id);
    const odJobs=empOverdueJobs(u.id);
    const active=ej.filter(j=>j.status!=='completed').length;
    const done=ej.filter(j=>j.status==='completed').length;
    const avgMs=ej.filter(j=>j.completed&&j.created).reduce((a,j,_,arr)=>a+(j.completed-j.created)/arr.length,0);
    const headIcon=u.role==='manager'?'👔':u.role==='supervisor'?'🔰':u.role==='team_leader'?'🧭':'👤';
    const loadDot=odJobs.length?'dot-red':active>=5?'dot-red':active>=3?'dot-yellow':'dot-green';
    const tableHtml=empJobTable(ej,odJobs);
    return`<div class="empblock${odJobs.length?' has-overdue':''}" data-emp-name="${escapeHtml(u.name.toLowerCase())}">
      <div class="emph" onclick="toggleEmp('e-${u.id}')">
        <span class="dot ${loadDot}" style="flex-shrink:0;width:8px;height:8px;border-radius:50%;"></span>
        <h3>${headIcon} ${escapeHtml(u.name)} <span class="emp-stats">${active} active · ${done} done${odJobs.length?` · <span style="color:var(--red);">⚠ ${odJobs.length} overdue</span>`:''}${avgMs?` · avg ${tdiff(0,avgMs)}`:''}</span></h3>
        <span class="emph-chevron">›</span>
      </div>
      <div class="empb" id="e-${u.id}">${tableHtml}</div>
    </div>`;
  }).join(''):'<div class="empty">No team members yet.</div>');
  window.filterBoard=function(q){
    document.querySelectorAll('#tboard .empblock').forEach(el=>{
      el.style.display=el.dataset.empName?.includes(q.toLowerCase())?'':'none';
    });
  };
  // restore expand state
  try{const s=JSON.parse(localStorage.getItem('rmi_board_expand')||'{}');Object.keys(s).forEach(id=>{if(s[id]){const el=document.getElementById(id);if(el){el.classList.add('open');el.closest('.empblock')?.classList.add('emp-open');}}});}catch(e){}
}
function empJobTable(ej,odJobs){
  if(!ej.length)return'<div class="empty" style="padding:1rem;">No jobs assigned.</div>';
  const now=Date.now();
  const statusOrder={ongoing:0,pending:1,paused:2,completed:3};
  const sorted=[...ej].sort((a,b)=>{
    const aOd=isOverdue(a)?-1:0,bOd=isOverdue(b)?-1:0;
    if(aOd!==bOd)return aOd-bOd;
    return (statusOrder[a.status]??9)-(statusOrder[b.status]??9);
  });
  // group by type
  const groups={};
  sorted.forEach(j=>{const t=j.type||'Other';if(!groups[t])groups[t]=[];groups[t].push(j);});
  const priDot=p=>p==='High'?'<span class="dot dot-red" title="High"></span>':p==='Medium'?'<span class="dot dot-yellow" title="Medium"></span>':'<span class="dot dot-gray" title="Low"></span>';
  const stChip=j=>{
    const od=isOverdue(j);
    if(od)return'<span class="st-chip st-overdue">Overdue</span>';
    if(j.status==='completed')return'<span class="st-chip st-done">Done</span>';
    if(j.status==='ongoing')return'<span class="st-chip st-ongoing">Ongoing</span>';
    if(j.status==='paused')return'<span class="st-chip st-paused">Paused</span>';
    return'<span class="st-chip st-pending">Pending</span>';
  };
  const dlCell=j=>{
    if(!j.deadline)return'<td class="tc-muted">—</td>';
    const diff=j.deadline-now;
    const cls=diff<0?'tc-red':diff<86400000?'tc-yellow':'';
    return`<td class="${cls}">${fmt(j.deadline)}</td>`;
  };
  const rows=Object.entries(groups).map(([type,tjobs])=>{
    const typeRow=`<tr class="type-group-row"><td colspan="6">📁 ${escapeHtml(type)} <span class="tc-muted">(${tjobs.length})</span></td></tr>`;
    const jobRows=tjobs.map(j=>`<tr class="${isOverdue(j)?'row-overdue':''}">
      <td><span class="tc-client">${escapeHtml(j.client)}</span><br><span class="tc-muted">#${escapeHtml(j.jobNum)}</span></td>
      <td>${stChip(j)}</td>
      <td>${priDot(j.priority)} ${j.priority||'—'}</td>
      ${dlCell(j)}
      <td class="tc-note">${j.notes?escapeHtml(j.notes.substring(0,60))+(j.notes.length>60?'…':''):'—'}</td>
      <td class="tc-actions">
        ${j.status==='pending'?`<button class="tbl-btn" onclick="startJob('${j.id}')">Start</button>`:''}
        ${j.status==='ongoing'?`<button class="tbl-btn" onclick="doneJob('${j.id}')">Complete</button>`:''}
        <button class="tbl-btn tbl-btn-ghost" onclick="editJob('${j.id}')">Edit</button>
      </td>
    </tr>`).join('');
    return typeRow+jobRows;
  }).join('');
  return`<div class="emp-table-wrap">
    <table class="emp-table">
      <thead><tr><th>Client / Job #</th><th>Status</th><th>Priority</th><th>Deadline</th><th>Notes</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}
window.toggleEmp=function(id){
  const el=document.getElementById(id);if(!el)return;
  const open=el.classList.toggle('open');
  el.closest('.empblock')?.classList.toggle('emp-open',open);
  try{const s=JSON.parse(localStorage.getItem('rmi_board_expand')||'{}');s[id]=open;localStorage.setItem('rmi_board_expand',JSON.stringify(s));}catch(e){}
};
window.boardExpandAll=function(open){
  document.querySelectorAll('#tboard .empb').forEach(el=>{el.classList.toggle('open',open);el.closest('.empblock')?.classList.toggle('emp-open',open);});
  try{const s={};document.querySelectorAll('#tboard .empb').forEach(el=>{if(el.id)s[el.id]=open;});localStorage.setItem('rmi_board_expand',JSON.stringify(s));}catch(e){}
};

// ── CALENDAR ──────────────────────────────────────────────────────────────────
function renderCal(){
  populateCalEmpPills();
  const mn=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const today=new Date();
  const fd=new Date(calY,calM,1).getDay();
  const dim=new Date(calY,calM+1,0).getDate();
  const dip=new Date(calY,calM,0).getDate();
  // Grid
  let h=`<div class="calh"><strong>${mn[calM]} ${calY}</strong></div>
  <div class="calgrid">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>`<div class="cdl">${d}</div>`).join('')}`;
  for(let i=fd-1;i>=0;i--)h+=`<div class="cd om"><div class="dn">${dip-i}</div></div>`;
  for(let d=1;d<=dim;d++){
    const ds=calY+'-'+String(calM+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    const it=today.getDate()===d&&today.getMonth()===calM&&today.getFullYear()===calY;
    const dayItems=jobsForCalendarDay(ds);
    const counts={deadline:0,deadlineOd:0,started:0,completed:0};
    dayItems.forEach(x=>{
      if(x.kind==='deadline'){counts.deadline++;if(x.overdue)counts.deadlineOd++;}
      else counts[x.kind]=(counts[x.kind]||0)+1;
    });
    // event dots — one per kind, with count badge
    const dots=[];
    if(counts.deadlineOd)dots.push(`<span class="cd-dot cd-dot-od">${counts.deadlineOd}</span>`);
    else if(counts.deadline)dots.push(`<span class="cd-dot cd-dot-dl">${counts.deadline}</span>`);
    if(counts.started)dots.push(`<span class="cd-dot cd-dot-st">${counts.started}</span>`);
    if(counts.completed)dots.push(`<span class="cd-dot cd-dot-dn">${counts.completed}</span>`);
    // client preview
    const clients=[...new Set(dayItems.map(x=>x.job.client))];
    const preview=clients.slice(0,2).map(c=>escapeHtml(c)).join(', ')+(clients.length>2?` <span class="cd-more">+${clients.length-2}</span>`:'');
    h+=`<div class="cd${it?' today':''}${dayItems.length?' has-ev':''}${counts.deadlineOd?' has-od':''}" onclick="showDay('${ds}')">
      <div class="dn">${d}</div>
      ${dots.length?`<div class="cd-dots">${dots.join('')}</div>`:''}
      ${preview?`<div class="cd-preview">${preview}</div>`:''}
    </div>`;
  }
  const tc=Math.ceil((fd+dim)/7)*7;
  for(let d=1;d<=tc-(fd+dim);d++)h+=`<div class="cd om"><div class="dn">${d}</div></div>`;
  h+='</div>';
  document.getElementById('calwrap').innerHTML=h;
  renderUpcomingDeadlines();
}
window.calNav=function(d){calM+=d;if(calM>11){calM=0;calY++;}if(calM<0){calM=11;calY--;}renderCal();};
window.calGoToday=function(){const t=new Date();calY=t.getFullYear();calM=t.getMonth();renderCal();};
window.setCalFilter=function(v){calFilterEmp=v;populateCalEmpPills();renderCal();};
window.setCalMode=function(v,btn){
  calShowMode=v;
  document.querySelectorAll('.cal-mode-pill').forEach(b=>b.classList.toggle('on',b.dataset.mode===v));
  renderCal();
};
function renderUpcomingDeadlines(){
  const el=document.getElementById('cal-upcoming');if(!el)return;
  const now=Date.now();
  const soon=14*24*60*60*1000;
  const pool=visibleJobs();
  const due=pool
    .filter(j=>j.deadline&&j.status!=='completed'&&(calFilterEmp?j.owner===calFilterEmp:true))
    .sort((a,b)=>toMillis(a.deadline)-toMillis(b.deadline));
  const overdue=due.filter(j=>toMillis(j.deadline)<now);
  const upcoming=due.filter(j=>toMillis(j.deadline)>=now&&toMillis(j.deadline)-now<=soon);
  const later=due.filter(j=>toMillis(j.deadline)>=now&&toMillis(j.deadline)-now>soon);
  function jobRow(j){
    const diff=toMillis(j.deadline)-now;
    const od=diff<0;
    const soon24=!od&&diff<86400000;
    const own=users.find(u=>u.id===j.owner)?.name||'—';
    return`<div class="upcoming-row${od?' upr-od':''}">
      <div class="upr-dot ${od?'dot-red':soon24?'dot-yellow':'dot-gray'}"></div>
      <div class="upr-info">
        <div class="upr-client">${escapeHtml(j.client)} <span class="upr-num">#${escapeHtml(j.jobNum)}</span></div>
        <div class="upr-meta">${escapeHtml(own)} · ${fmt(j.deadline)}</div>
      </div>
    </div>`;
  }
  let html='';
  if(overdue.length)html+=`<div class="upc-section-head upc-od">⚠ Overdue (${overdue.length})</div>${overdue.map(jobRow).join('')}`;
  if(upcoming.length)html+=`<div class="upc-section-head">Next 14 days (${upcoming.length})</div>${upcoming.map(jobRow).join('')}`;
  if(later.length)html+=`<div class="upc-section-head">Later (${later.length})</div>${later.map(jobRow).join('')}`;
  el.innerHTML=html||'<div class="upc-empty">No upcoming deadlines</div>';
}
const CAL_KIND_LABELS={deadline:'📅 Deadline',started:'▶ Started',completed:'✅ Completed'};
window.showDay=function(ds){
  const items=jobsForCalendarDay(ds);
  const d=new Date(ds+'T12:00:00');
  const groups={deadline:[],started:[],completed:[]};
  items.forEach(x=>{if(groups[x.kind])groups[x.kind].push(x);});
  const order=['deadline','started','completed'];
  let body='';
  order.forEach(kind=>{
    const list=groups[kind];if(!list.length)return;
    const colors={deadline:'#ffaaaa',started:'var(--blue)',completed:'var(--green)'};
    body+=`<div class="cd-modal-group">
      <div class="cd-modal-group-head" style="color:${colors[kind]}">${CAL_KIND_LABELS[kind]} <span>(${list.length})</span></div>`;
    list.forEach(({job:j,overdue})=>{
      const own=users.find(u=>u.id===j.owner)?.name||'—';
      const odBorder=kind==='deadline'&&overdue;
      body+=`<div class="cd-modal-item${odBorder?' cd-modal-od':''}">
        <div class="cd-mi-top">
          <span class="cd-mi-client">${escapeHtml(j.client)}</span>
          <span class="cd-mi-num">#${escapeHtml(j.jobNum)}</span>
          ${overdue?'<span class="cd-mi-badge-od">Overdue</span>':''}
        </div>
        <div class="cd-mi-meta">${escapeHtml(own)} · ${escapeHtml(j.type)} · <span class="st-chip st-${j.status==='ongoing'?'ongoing':j.status==='paused'?'paused':j.status==='completed'?'done':'pending'}" style="font-size:0.65rem;">${j.status}</span>${j.priority?` · ${j.priority}`:''}</div>
        ${kind==='deadline'&&j.deadline?`<div class="cd-mi-dl">Due: ${fmt(j.deadline)}</div>`:''}
      </div>`;
    });
    body+='</div>';
  });
  const title=d.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  document.getElementById('cal-day-title').textContent=title;
  document.getElementById('cal-day-body').innerHTML=body||'<div style="padding:1rem;color:var(--text2);text-align:center;">Nothing scheduled.</div>';
  document.getElementById('cal-day-modal').classList.add('open');
};
window.closeCalDayModal=function(){document.getElementById('cal-day-modal').classList.remove('open');};
window.closePopup=function(){document.getElementById('popup').style.display='none';document.getElementById('overlay').style.display='none';};

// ── ANALYTICS ─────────────────────────────────────────────────────────────────
const PRIORITY_CHART_COLORS={High:'#e05555',Medium:'#c9a227',Low:'#7a8a9a'};
const TYPE_CHART_COLORS=['#4a9eff','#9b59b6','#2ecc71','#e67e22','#1abc9c','#e74c3c','#3498db','#f39c12','#16a085','#8e44ad','#27ae60','#d35400','#2980b9','#c0392b','#fd79a8','#00cec9','#6c5ce7'];

window.setATab=function(tab,btn){
  setCurrentATab(tab);
  document.querySelectorAll('.atabs button').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
  renderAnalyticsContent();
};
window.setChartPref=function(key,field,val){
  if(!chartPrefs[key])return;
  chartPrefs[key][field]=val;
  renderAnalyticsContent();
};
function chartToolbarHtml(key){
  const p=chartPrefs[key];
  return`<div class="chart-toolbar">
    <button type="button" class="${p.mode==='bar'?'on':''}" onclick="setChartPref('${key}','mode','bar')">Bars</button>
    <button type="button" class="${p.mode==='pie'?'on':''}" onclick="setChartPref('${key}','mode','pie')">Pie</button>
    <span class="chart-toolbar-sep"></span>
    <label><input type="checkbox" ${p.showPct?'checked':''} onchange="setChartPref('${key}','showPct',this.checked)"> %</label>
    <label><input type="checkbox" ${p.showNum?'checked':''} onchange="setChartPref('${key}','showNum',this.checked)"> #</label>
  </div>`;
}
const CSS_COLOR_HEX={'var(--blue)':'#4a9eda','var(--yellow)':'#e8a838','var(--green)':'#4caf7d','var(--red)':'#e05252','var(--orange)':'#e07c3a','var(--text2)':'#999','var(--text)':'#e8e8e8'};
function colorToHex(c){return c&&(c.startsWith('#')?c:CSS_COLOR_HEX[c])||'#4a9eda';}
function showChartTooltip(html,x,y){
  const tip=document.getElementById('chart-tooltip');
  if(!tip)return;
  tip.innerHTML=html;
  tip.style.display='block';
  tip.style.left=Math.min(x+14,window.innerWidth-230)+'px';
  tip.style.top=Math.min(y+14,window.innerHeight-80)+'px';
}
function hideChartTooltip(){const t=document.getElementById('chart-tooltip');if(t)t.style.display='none';}
function bindChartInteractions(root){
  if(!root)return;
  root.querySelectorAll('.pie-interactive .pie-slice').forEach(path=>{
    const showTip=e=>{
      path.classList.add('pie-hover');
      let html=`<strong>${escapeHtml(path.dataset.label||'')}</strong>`;
      if(path.dataset.num)html+=`<span>${escapeHtml(path.dataset.num)}</span>`;
      if(path.dataset.pct)html+=`<span>${escapeHtml(path.dataset.pct)}</span>`;
      showChartTooltip(html,e.clientX,e.clientY);
    };
    path.onmouseenter=showTip;
    path.onmousemove=showTip;
    path.onmouseleave=()=>{path.classList.remove('pie-hover');hideChartTooltip();};
  });
}
function chartBarVal(row,prefs,isRate){
  const parts=[];
  if(isRate){
    if(prefs.showPct)parts.push(row.rate+'%');
    if(prefs.showNum){if(prefs.showPct)parts.push('·');parts.push(row.done+'/'+row.total);}
  }else{
    if(prefs.showNum)parts.push(String(row.value));
    if(prefs.showPct&&row.share!=null){if(parts.length)parts.push('·');parts.push(row.share+'%');}
  }
  return parts.join(' ')||'0';
}
function renderAnalyticsBarChart(rows,prefs,isRate){
  const max=isRate?100:Math.max(...rows.map(r=>r.value),1);
  return rows.map(row=>{
    const w=isRate?row.rate:Math.round(row.value/max*100);
    return`<div class="bar-row"><span class="bar-label" title="${escapeHtml(row.label)}">${escapeHtml(row.label)}</span><div class="bar-track"><div class="bar-fill" style="width:${row.value||row.total?Math.max(w,2):0}%;background:${row.color};"></div></div><span class="bar-val">${chartBarVal(row,prefs,isRate)}</span></div>`;
  }).join('');
}
function renderAnalyticsPieChart(rows,prefs,isRate){
  const items=rows.filter(r=>(isRate?r.total:r.value)>0);
  const total=items.reduce((s,r)=>s+(isRate?r.total:r.value),0);
  if(!total)return'<div class="empty" style="padding:1rem;">No data yet.</div>';
  const cx=100,cy=100,R=82;
  let angle=-Math.PI/2;
  const sliceData=items.map(row=>{
    const val=isRate?row.total:row.value;
    const pct=val/total;
    const sweep=pct*2*Math.PI;
    const x1=cx+R*Math.cos(angle),y1=cy+R*Math.sin(angle);
    angle+=sweep;
    const x2=cx+R*Math.cos(angle),y2=cy+R*Math.sin(angle);
    const lg=sweep>Math.PI?1:0;
    const d=`M ${cx} ${cy} L ${x1} ${y1} A ${R} ${R} 0 ${lg} 1 ${x2} ${y2} Z`;
    const share=Math.round(val/total*100);
    const numTxt=prefs.showNum?(isRate?`${row.done} / ${row.total} jobs`:`${row.value} jobs`):'';
    const pctTxt=prefs.showPct?(isRate?`${row.rate}% complete`:`${share}% of total`):'';
    return{row,d,numTxt,pctTxt};
  });
  const slices=sliceData.map(({d,row,numTxt,pctTxt})=>`<path class="pie-slice" d="${d}" fill="${row.color}" data-label="${escapeHtml(row.label)}" data-num="${escapeHtml(numTxt)}" data-pct="${escapeHtml(pctTxt)}"></path>`).join('');
  const legend=items.map(row=>{
    const val=isRate?row.total:row.value;
    const share=Math.round(val/total*100);
    const parts=[];
    if(prefs.showNum)isRate?parts.push(row.done+'/'+row.total):parts.push(String(row.value));
    if(prefs.showPct)isRate?parts.push(row.rate+'% done'):parts.push(share+'%');
    return`<div class="pie-legend-item"><span class="pie-swatch" style="background:${row.color}"></span><span class="pie-legend-label">${escapeHtml(row.label)}</span><span class="pie-legend-val">${parts.join(' · ')||'—'}</span></div>`;
  }).join('');
  return`<div class="pie-wrap pie-interactive pie-stage"><svg viewBox="0 0 200 200" class="pie-svg">${slices}</svg><div class="pie-legend">${legend}</div></div>`;
}
function renderChartBlock(title,key,rows,isRate,wide){
  const prefs=chartPrefs[key];
  const body=prefs.mode==='pie'?renderAnalyticsPieChart(rows,prefs,isRate):renderAnalyticsBarChart(rows,prefs,isRate);
  return`<div class="achart${wide?' achart-wide':''}"><h4>${title}</h4>${chartToolbarHtml(key)}${body}</div>`;
}
function renderAnalytics(){renderAnalyticsContent();}
function analyticsJobs(){
  if(!me)return[];
  const pool=jobs.filter(j=>!j.workflow);
  if(canSeeAllJobs())return pool;
  if(isTeamLeader()){const ids=new Set(myTeamIds());return pool.filter(j=>ids.has(j.owner));}
  return pool.filter(j=>j.owner===me.id);
}
function allJobTypesForAnalytics(scope){
  const fromJobs=new Set(scope.map(j=>j.type).filter(Boolean));
  JOB_TYPES.forEach(t=>fromJobs.add(t));
  return [...fromJobs];
}
let _anSubTab='overview';
window.setAnSubTab=function(t){_anSubTab=t;renderAnalyticsContent();renderSbAnalyticsSubs();};

function renderSbAnalyticsSubs(){
  const el=document.getElementById('sb-analytics-subs');
  if(el){el.innerHTML='';el.style.display='none';}
}
window.renderSbAnalyticsSubs=renderSbAnalyticsSubs;

window.renderSbBasketSubs=function(){
  const el=document.getElementById('sb-basket-subs');if(!el||!me)return;
  const r=me.role;
  const cur=window.getWfTab?.()||'';
  let tabs=[];
  if(r==='sales_operation')tabs=[{k:'submit',label:'📤 Submit'},{k:'active',label:'🔄 Active'},{k:'done',label:'✅ Done'}];
  else if(r==='team_leader')tabs=[{k:'queue',label:'⚡ My Queue'},{k:'team',label:'⏳ My Team'},{k:'done',label:'✅ Completed'}];
  else if(r==='manager'||r==='supervisor'||amDirector())tabs=[{k:'overview',label:'🧺 Overview'},{k:'done',label:'✅ Completed'}];
  else tabs=[{k:'tasks',label:'⚡ My Tasks'},{k:'submitted',label:'⏳ Submitted'},{k:'done',label:'✅ Completed'}];
  el.innerHTML=tabs.map(t=>`<button class="sb-sub-btn${t.k===cur?' active':''}" onclick="goHub('work','job-basket');window.wfSetTab('${t.k}')">${t.label}</button>`).join('');
};

// ── Analytics widget visibility ────────────────────────────────────────────
const AN_VIS_KEYS=['kpis','status_trend','my_rank','team','perf','jobs','branches','workflow','teams_overview'];
let _anVis={};
function loadAnVis(){
  if(!me)return;
  try{const s=localStorage.getItem('an-vis-'+me.id);const saved=s?JSON.parse(s):{};_anVis=AN_VIS_KEYS.reduce((o,k)=>{o[k]=k in saved?saved[k]:true;return o;},{});}
  catch(e){_anVis=AN_VIS_KEYS.reduce((o,k)=>{o[k]=true;return o;},{});}
}
function saveAnVis(){if(me)localStorage.setItem('an-vis-'+me.id,JSON.stringify(_anVis));}
function applyAnVis(root){
  if(!root)return;
  root.querySelectorAll('.an-section-wrap[data-vis]').forEach(el=>{
    el.style.display=_anVis[el.dataset.vis]===false?'none':'';
  });
}
window.setAnVis=function(key,val){_anVis[key]=val;saveAnVis();applyAnVis(document.getElementById('analytics-content'));};
window.anVisSetAll=function(val){AN_VIS_KEYS.forEach(k=>_anVis[k]=val);saveAnVis();applyAnVis(document.getElementById('analytics-content'));renderAnVisPanel();};
window.toggleAnVisPanel=function(){
  const p=document.getElementById('an-vis-panel');
  const btn=document.getElementById('an-vis-toggle');
  if(!p)return;
  const open=p.style.display==='none'||!p.style.display;
  p.style.display=open?'block':'none';
  if(btn)btn.classList.toggle('open',open);
  if(open)renderAnVisPanel();
};
function renderAnVisPanel(){
  const p=document.getElementById('an-vis-panel');if(!p||!me)return;
  loadAnVis();
  const r=me.role;
  const isMgrRole=['manager','supervisor','team_leader'].includes(r)||amDirector();
  const isEmpRole=r==='employee';
  const isSupRole=r==='supervisor'||r==='manager'||amDirector();
  const isMgrOnly=r==='manager'||amDirector();
  const hasWf=jobs.some(j=>j.workflow);
  const chk=(key,lbl)=>`<div class="an-vis-row"><input type="checkbox" id="anv-${key}" ${_anVis[key]!==false?'checked':''}  onchange="setAnVis('${key}',this.checked)"><label for="anv-${key}">${lbl}</label></div>`;
  const grp=lbl=>`<div class="an-vis-grp-lbl">${lbl}</div>`;
  let h=`<div class="an-vis-panel-hd"><span>📊 Widget Visibility</span><button onclick="toggleAnVisPanel()">✕</button></div>`;
  h+=grp('Overview');
  h+=chk('kpis','Key Metrics');
  h+=chk('status_trend','Status & Trend');
  if(isEmpRole){h+=grp('Personal');h+=chk('my_rank','My Rank & Speed');}
  if(isMgrRole){h+=grp('Team');h+=chk('team','Team Health');h+=chk('perf','Performance Leaderboard');}
  h+=grp('Jobs');
  h+=chk('jobs','Job Analysis');
  if(isSupRole)h+=chk('branches','Branch Analytics');
  if(hasWf)h+=chk('workflow','Workflow');
  if(isMgrOnly)h+=chk('teams_overview','Teams Overview');
  h+=`<div class="an-vis-footer"><button class="bp sec" style="flex:1;font-size:0.72rem;padding:0.28rem;" onclick="anVisSetAll(true)">Show All</button><button class="bp sec" style="flex:1;font-size:0.72rem;padding:0.28rem;" onclick="anVisSetAll(false)">Hide All</button></div>`;
  p.innerHTML=h;
}
// close panel when clicking outside
document.addEventListener('click',function(e){
  const p=document.getElementById('an-vis-panel');
  const btn=document.getElementById('an-vis-toggle');
  if(p&&p.style.display!=='none'&&!p.contains(e.target)&&e.target!==btn&&!btn?.contains(e.target)){
    p.style.display='none';if(btn)btn.classList.remove('open');
  }
});

function renderAnalyticsContent(){
  const el=document.getElementById('analytics-content');if(!el||!me)return;
  if(analyticsView==='teams'){renderTeamsAnalytics(el);bindChartInteractions(el);return;}

  const mgr=isLead();
  const myJobs=analyticsJobs();
  const now=new Date();
  const ws=new Date(now);ws.setDate(now.getDate()-now.getDay());ws.setHours(0,0,0,0);
  const total=myJobs.length||1;
  const hasWf=jobs.some(j=>j.workflow);
  // guard: if current tab not available for this role, reset
  if(_anSubTab==='team'&&!mgr)_anSubTab='overview';
  if(_anSubTab==='workflow'&&!hasWf)_anSubTab='overview';

  // ── shared data ──
  const pending=myJobs.filter(j=>j.status==='pending').length;
  const ongoing=myJobs.filter(j=>j.status==='ongoing').length;
  const paused=myJobs.filter(j=>j.status==='paused').length;
  const completed=myJobs.filter(j=>j.status==='completed').length;
  const overdueN=myJobs.filter(j=>isOverdue(j)).length;
  const dt=myJobs.filter(j=>j.completed&&new Date(toMillis(j.completed)).toDateString()===now.toDateString()).length;
  const dw=myJobs.filter(j=>j.completed&&toMillis(j.completed)>=ws.getTime()).length;
  const dn=myJobs.filter(j=>j.completed&&j.created);
  const avg=dn.reduce((a,j)=>a+(toMillis(j.completed)-toMillis(j.created)),0)/(dn.length||1);
  const compRate=Math.round(completed/total*100);
  const kpi=(label,val,color,sub='')=>
    `<div class="an-kpi"><div class="an-kpi-label">${label}</div><div class="an-kpi-value" style="color:${color}">${val}</div>${sub?`<div class="an-kpi-sub">${sub}</div>`:''}</div>`;

  let body='';

  // ── OVERVIEW ──
  if(_anSubTab==='overview'){
    const donutData=[
      {label:'Pending',value:pending,color:'#ffd60a'},
      {label:'Ongoing',value:ongoing,color:'#0a84ff'},
      {label:'Paused',value:paused,color:'#6e6e73'},
      {label:'Completed',value:completed,color:'#32d74b'}
    ];
    const byMonth={};
    myJobs.filter(j=>j.completed).forEach(j=>{
      const d=new Date(toMillis(j.completed));
      const k=d.toLocaleString('en-GB',{month:'short',year:'2-digit'});
      byMonth[k]=(byMonth[k]||0)+1;
    });
    const monthPts=Object.entries(byMonth).slice(-8).map(([label,value])=>({label,value}));
    body=`
      <div class="an-kpis">
        ${kpi('Pending',pending,'var(--yellow)')}
        ${kpi('Ongoing',ongoing,'var(--blue)')}
        ${kpi('Paused',paused,'var(--text2)')}
        ${kpi('Completed',completed,'var(--green)',compRate+'% rate')}
        ${kpi('Overdue',overdueN,overdueN?'var(--red)':'var(--text3)')}
        ${kpi('Done Today',dt,'var(--yellow)')}
        ${kpi('Done This Week',dw,'var(--blue)')}
        ${kpi('Avg Completion',dn.length?tdiff(0,avg):'—','var(--text2)')}
      </div>
      <div class="an-row-2">
        <div class="an-widget"><div class="an-widget-hd">Status Breakdown</div>${anDonut(donutData,myJobs.length,'jobs')}</div>
        <div class="an-widget"><div class="an-widget-hd">Monthly Completions</div>${anTrendChart(monthPts)}</div>
      </div>`;
  }

  // ── JOBS ──
  else if(_anSubTab==='jobs'){
    const typeRows=allJobTypesForAnalytics(myJobs)
      .filter(t=>myJobs.some(j=>j.type===t))
      .map((t,i)=>({label:t,value:myJobs.filter(j=>j.type===t).length,color:TYPE_CHART_COLORS[i%TYPE_CHART_COLORS.length]}))
      .filter(r=>r.value>0).sort((a,b)=>b.value-a.value).slice(0,14);
    const priRows=['High','Medium','Low'].map(p=>{
      const all=myJobs.filter(j=>j.priority===p);
      const done=all.filter(j=>j.status==='completed').length;
      const t=all.length;
      return{label:p,value:t?Math.round(done/t*100):0,sub:`${done}/${t}`,color:PRIORITY_CHART_COLORS[p]};
    }).filter(r=>r.sub!=='0/0');
    body=`
      <div class="an-row-2">
        <div class="an-widget"><div class="an-widget-hd">Jobs by Type</div>${anBars(typeRows)}</div>
        <div class="an-widget"><div class="an-widget-hd">Completion Rate by Priority</div>${anBars(priRows,{rate:true})}</div>
      </div>`;
  }

  // ── TEAM (manager+) ──
  else if(_anSubTab==='team'&&mgr){
    const pool=teamUsersForView().filter(u=>!isNonStaffRole(u.role)&&u.role!=='manager');
    const activeRows=pool.map(u=>{
      const c=myJobs.filter(j=>j.owner===u.id&&j.status!=='completed').length;
      return{label:u.name,value:c,color:c>=5?'var(--red)':c>=3?'var(--yellow)':'var(--green)'};
    }).sort((a,b)=>b.value-a.value);
    const totalRows=pool.map(u=>({
      label:u.name,value:myJobs.filter(j=>j.owner===u.id).length,color:'var(--purple)'
    })).sort((a,b)=>b.value-a.value);
    const perfCards=pool.map(u=>{
      const ej=myJobs.filter(j=>j.owner===u.id);
      const doneJ=ej.filter(j=>j.completed&&j.created);
      const avgT=doneJ.reduce((a,j)=>a+(toMillis(j.completed)-toMillis(j.created)),0)/(doneJ.length||1);
      const od=ej.filter(j=>isOverdue(j)).length;
      const wkDone=ej.filter(j=>j.completed&&toMillis(j.completed)>=ws.getTime()).length;
      return`<div class="an-perf-card">
        <div class="an-perf-name">👤 ${escapeHtml(u.name)}</div>
        <div class="an-perf-row"><span>Total</span><strong>${ej.length}</strong></div>
        <div class="an-perf-row"><span>Completed</span><strong style="color:var(--green)">${ej.filter(j=>j.status==='completed').length}</strong></div>
        <div class="an-perf-row"><span>Active</span><strong>${ej.filter(j=>j.status!=='completed').length}</strong></div>
        <div class="an-perf-row"><span>This Week</span><strong>${wkDone}</strong></div>
        <div class="an-perf-row"><span>Overdue</span><strong style="color:${od?'var(--red)':'var(--green)'}">${od}</strong></div>
        <div class="an-perf-row"><span>Avg Time</span><strong>${doneJ.length?tdiff(0,avgT):'—'}</strong></div>
      </div>`;
    }).join('');
    body=`
      <div class="an-row-2">
        <div class="an-widget"><div class="an-widget-hd">Active Jobs by Employee <span class="an-hd-note">red ≥5 · yellow ≥3</span></div>${anBars(activeRows)}</div>
        <div class="an-widget"><div class="an-widget-hd">Total Jobs by Employee</div>${anBars(totalRows)}</div>
      </div>
      <div class="an-widget" style="margin-top:0.4rem;"><div class="an-widget-hd">🏅 Performance</div><div class="an-perf-grid">${perfCards}</div></div>`;
  }

  // ── WORKFLOW ──
  else if(_anSubTab==='workflow'){
    body=wfAnalyticsSection()||'<div class="empty" style="padding:2rem;">No workflow data yet.</div>';
  }

  el.innerHTML=`<div class="an-sub-body">${body}</div>`;
  bindChartInteractions(el);
}

function getDashStatItems(ws){
  return[
    {label:'Total Jobs',value:jobs.length,color:'var(--blue)'},
    {label:'Pending',value:jobs.filter(j=>j.status==='pending').length,color:'var(--yellow)'},
    {label:'Ongoing',value:jobs.filter(j=>j.status==='ongoing').length,color:'var(--blue)'},
    {label:'Paused',value:jobs.filter(j=>j.status==='paused').length,color:'var(--text2)'},
    {label:'Completed',value:jobs.filter(j=>j.status==='completed').length,color:'var(--green)'},
    {label:'Overdue',value:jobs.filter(j=>isOverdue(j)).length,color:'var(--red)'},
    {label:'Done This Week',value:jobs.filter(j=>j.completed&&new Date(j.completed)>=ws).length,color:'var(--green)'},
    {label:'Employees',value:users.filter(u=>u.role==='employee').length,color:'var(--text)'},
    {label:'Ext. Requests',value:extRequests.filter(r=>r.status==='pending').length,color:'var(--orange)'}
  ];
}
function renderDashStatsBars(items){
  const max=Math.max(...items.map(s=>s.value),1);
  const maxH=130;
  return`<div class="dash-bars-wrap"><div class="dash-bars">${items.map(s=>{
    const h=Math.max(6,Math.round(s.value/max*maxH));
    const c=colorToHex(s.color);
    return`<div class="dash-bar-col"><div class="bar-2d" style="height:${h}px;background:${c}"></div><span class="val" style="color:${s.color}">${s.value}</span><span class="lbl">${s.label}</span></div>`;
  }).join('')}</div></div>`;
}
window.setDashStatsView=function(v){
  userSettings.dashStatsView=v;
  saveUserSettings();
};

// ── ADVANCED SEARCH ───────────────────────────────────────────────────────────
window.runAdvSearch=function(){
  const emp=document.getElementById('sf-emp').value;
  const status=document.getElementById('sf-status').value;
  const priority=document.getElementById('sf-priority').value;
  const type=document.getElementById('sf-type').value;
  const tag=document.getElementById('sf-tag').value.trim().toLowerCase();
  const assigned=document.getElementById('sf-assigned').value;
  const from=document.getElementById('sf-from').value;
  const to=document.getElementById('sf-to').value;
  const overdue=document.getElementById('sf-overdue').value;
  let res=jobs.filter(j=>!j.workflow); // workflow jobs live in Job Basket, not search
  if(emp)res=res.filter(j=>j.owner===emp);
  if(status)res=res.filter(j=>j.status===status);
  if(priority)res=res.filter(j=>j.priority===priority);
  if(type)res=res.filter(j=>j.type===type);
  if(tag)res=res.filter(j=>(j.tags||[]).some(t=>t.toLowerCase().includes(tag)));
  if(assigned==='manager')res=res.filter(j=>j.managerAssigned);
  if(assigned==='self')res=res.filter(j=>!j.managerAssigned);
  if(from)res=res.filter(j=>j.created>=new Date(from).getTime());
  if(to)res=res.filter(j=>j.created<=new Date(to).getTime()+86400000);
  if(overdue==='yes')res=res.filter(j=>isOverdue(j));
  document.getElementById('adv-results').innerHTML=`<div style="color:var(--text2);font-size:0.8rem;margin-bottom:0.5rem;">${res.length} result(s)</div>${res.map(j=>card(j,true)).join('')||'<div class="empty">No matching jobs.</div>'}`;
};
window.clearAdvSearch=function(){
  ['sf-emp','sf-status','sf-priority','sf-type','sf-assigned','sf-overdue'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  ['sf-tag','sf-from','sf-to'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  document.getElementById('adv-results').innerHTML='';
};
window.exportAdvSearchCSV=function(){
  const rows=document.getElementById('adv-results').querySelectorAll('.card');
  if(!rows.length){alert('Run a search first.');return;}
  exportCSV(jobs.filter(j=>document.getElementById('card-'+j.id)),'search_results');
};

// ── CSV EXPORT ────────────────────────────────────────────────────────────────
function exportCSV(data,filename){
  const headers=['Job #','Client','Type','Priority','Status','Employee','Assigned By','Tags','Created','Started','Completed','Deadline','Total Duration','Paused Time','Active Work Time','Notes','Completion Note','Manager Assigned'];
  const rows=data.map(j=>{
    const own=users.find(u=>u.id===j.owner)?.name||j.owner||'';
    const br=(j.started||j.completed)?getJobDurationBreakdown(j):null;
    return[j.jobNum,j.client,j.type,j.priority,j.status,own,j.assignedBy,(j.tags||[]).join(';'),fmt(j.created),j.started?fmt(j.started):'',j.completed?fmt(j.completed):'',j.deadline?fmt(j.deadline):'',br?tdiff(0,br.totalMs):'',br&&br.pausedMs>0?tdiff(0,br.pausedMs):'',br?tdiff(0,br.activeMs):'',j.notes||'',j.completionNote||'',j.managerAssigned?'Yes':'No'];
  });
  const csv=[headers,...rows].map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n');
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download=`RMI_${filename}_${new Date().toISOString().slice(0,10)}.csv`;a.click();
}
window.exportAllCSV=function(){exportCSV(jobs,'all_jobs');};
window.exportEmployeeCSV=function(uid){
  const scope=isTeamLeader()?visibleJobs():jobs;
  exportCSV(scope.filter(j=>j.owner===uid),users.find(u=>u.id===uid)?.name||uid);
};

// ── EMPLOYEE DASHBOARD ────────────────────────────────────────────────────────
function renderEmpDashboard(root){
  const now=new Date(),nowMs=now.getTime();
  const todayStart=new Date(now);todayStart.setHours(0,0,0,0);
  const todayEnd=new Date(now);todayEnd.setHours(23,59,59,999);
  const weekEnd=new Date(now);weekEnd.setDate(now.getDate()+7);
  const ws=new Date(now);ws.setDate(now.getDate()-now.getDay());ws.setHours(0,0,0,0);
  const lastWs=new Date(ws);lastWs.setDate(ws.getDate()-7);

  const myJobs=jobs.filter(j=>j.owner===me.id&&!j.workflow);
  const active=myJobs.filter(j=>j.status!=='completed');
  const overdue=myJobs.filter(j=>isOverdue(j));
  const dueToday=active.filter(j=>j.deadline&&toMillis(j.deadline)<=todayEnd.getTime()&&toMillis(j.deadline)>=nowMs);
  const dueWeek=active.filter(j=>j.deadline&&toMillis(j.deadline)>nowMs&&toMillis(j.deadline)<=weekEnd.getTime());
  const doneThisWeek=myJobs.filter(j=>j.completed&&toMillis(j.completed)>=ws.getTime());
  const doneLastWeek=myJobs.filter(j=>j.completed&&toMillis(j.completed)>=lastWs.getTime()&&toMillis(j.completed)<ws.getTime());
  const sla=computeSlaStats(myJobs);

  const hr=now.getHours();
  const greet=hr<12?'Good morning':hr<18?'Good afternoon':'Good evening';
  const dateStr=now.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});

  const weekDelta=doneThisWeek.length-doneLastWeek.length;
  const trendStr=weekDelta>0?`<span class="kpi-trend up">▲ ${weekDelta} vs last wk</span>`
    :weekDelta<0?`<span class="kpi-trend down">▼ ${Math.abs(weekDelta)} vs last wk</span>`
    :`<span class="kpi-trend">— same as last wk</span>`;

  const allClear=!overdue.length&&!dueToday.length;
  const healthBits=[`<strong>${active.length}</strong> active`];
  if(overdue.length)healthBits.push(`<strong class="tc-red">${overdue.length}</strong> overdue`);
  if(dueToday.length)healthBits.push(`<strong class="tc-yellow">${dueToday.length}</strong> due today`);

  const kpis=[
    {icon:'📋',label:'Active',value:active.length,sub:`${myJobs.filter(j=>j.status==='pending').length} pending · ${myJobs.filter(j=>j.status==='ongoing').length} ongoing`,accent:'var(--blue)'},
    {icon:'⚠️',label:'Overdue',value:overdue.length,sub:overdue.length?'needs attention':'all on track',accent:overdue.length?'var(--red)':'var(--text3)'},
    {icon:'📅',label:'Due This Week',value:dueToday.length+dueWeek.length,sub:`${dueToday.length} today · ${dueWeek.length} upcoming`,accent:'var(--orange)'},
    {icon:'✅',label:'Done This Week',value:doneThisWeek.length,sub:trendStr,accent:'var(--green)'},
    {icon:'🎯',label:'On-Time Rate',value:sla.onTimePct+'%',sub:`${sla.doneWithDl} completed with deadlines`,accent:sla.onTimePct>=70?'var(--green)':sla.onTimePct>=40?'var(--yellow)':'var(--red)'},
  ];

  // status donut
  const pending=myJobs.filter(j=>j.status==='pending').length;
  const ongoing=myJobs.filter(j=>j.status==='ongoing').length;
  const paused=myJobs.filter(j=>j.status==='paused').length;
  const completed=myJobs.filter(j=>j.status==='completed').length;
  const donutData=[{label:'Pending',value:pending,color:'#ffd60a'},{label:'Ongoing',value:ongoing,color:'#0a84ff'},{label:'Paused',value:paused,color:'#6e6e73'},{label:'Completed',value:completed,color:'#32d74b'}];
  const donutTotal=myJobs.length||1;let donutSvg='',dstart=0;
  const dnz=donutData.filter(s=>s.value>0);
  if(dnz.length===1){donutSvg=`<circle cx="60" cy="60" r="50" fill="${dnz[0].color}"/>`;}
  else{donutData.forEach(s=>{if(!s.value)return;const frac=s.value/donutTotal,ang=frac*2*Math.PI;const x1=60+50*Math.sin(dstart),y1=60-50*Math.cos(dstart);const x2=60+50*Math.sin(dstart+ang),y2=60-50*Math.cos(dstart+ang);const large=ang>Math.PI?1:0;donutSvg+=`<path d="M60,60 L${x1},${y1} A50,50 0 ${large} 1 ${x2},${y2} Z" fill="${s.color}"/>`;dstart+=ang;});}

  // recent activity — my jobs only
  const myJobIds=new Set(myJobs.map(j=>j.id));
  const recent=[...activityLogs].filter(e=>myJobIds.has(e.jobId)||e.userId===me.id).sort((a,b)=>(b.ts||0)-(a.ts||0)).slice(0,8);

  // upcoming deadlines
  const upcoming=[...active].filter(j=>j.deadline&&toMillis(j.deadline)>=nowMs&&toMillis(j.deadline)<=weekEnd.getTime()).sort((a,b)=>toMillis(a.deadline)-toMillis(b.deadline)).slice(0,6);

  // my extension requests
  const myExts=extRequests.filter(r=>r.requestedBy===me.id).sort((a,b)=>toMillis(b.created)-toMillis(a.created)).slice(0,5);

  // completion progress bar (done / total)
  const totalJobs=myJobs.length||1;
  const compPct=Math.round(completed/totalJobs*100);
  const pausedJobs=myJobs.filter(j=>j.status==='paused');

  root.innerHTML=`
  <div class="dash-hero">
    <div>
      <div class="dash-greet">${greet}, ${escapeHtml((me.name||'').split(' ')[0])}</div>
      <div class="dash-date">${dateStr}</div>
    </div>
    <div class="dash-health${allClear?' dash-health-ok':''}">
      ${allClear?'✓ Everything on track':healthBits.join('<span class="dash-health-sep">·</span>')}
    </div>
  </div>

  <div class="dash-kpis">
    ${kpis.map(k=>`<div class="kpi-card">
      <div class="kpi-top"><span class="kpi-icon">${k.icon}</span><span class="kpi-label">${k.label}</span></div>
      <div class="kpi-value" style="color:${k.accent}">${k.value}</div>
      <div class="kpi-sub">${k.sub}</div>
    </div>`).join('')}
  </div>

  <div class="dash-main">
    <div class="dash-col-left">
      <div class="dash-widget">
        <div class="dash-widget-hd">My Progress</div>
        <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.6rem;">
          <div style="flex:1;background:var(--card2);border-radius:var(--radius-pill);height:8px;overflow:hidden;">
            <div style="width:${compPct}%;height:8px;background:${compPct>=80?'var(--green)':compPct>=50?'var(--blue)':'var(--yellow)'};border-radius:var(--radius-pill);transition:width 0.6s;"></div>
          </div>
          <span style="font-family:var(--mono);font-size:0.82rem;font-weight:700;color:var(--text);flex-shrink:0;">${compPct}%</span>
        </div>
        <div style="font-size:0.72rem;color:var(--text3);">${completed} of ${myJobs.length} jobs completed</div>
        <div class="dash-donut-wrap" style="margin-top:0.85rem;">
          <svg width="100" height="100" viewBox="0 0 120 120">${donutSvg}<circle cx="60" cy="60" r="28" fill="var(--card)"/><text x="60" y="56" text-anchor="middle" class="donut-center-num">${myJobs.length}</text><text x="60" y="72" text-anchor="middle" class="donut-center-lbl">total</text></svg>
          <div class="dash-donut-legend">
            ${donutData.map(s=>`<div class="ddl-row"><span class="ddl-dot" style="background:${s.color}"></span>${s.label}<span class="ddl-val">${s.value}</span></div>`).join('')}
          </div>
        </div>
      </div>

      ${pausedJobs.length?`<div class="dash-widget">
        <div class="dash-widget-hd">⏸ Paused Jobs <span class="dash-count-badge">${pausedJobs.length}</span></div>
        ${pausedJobs.slice(0,4).map(j=>`<div class="dash-att-row" onclick="goHub('jobs','my-jobs')" style="cursor:pointer;">
          <div class="dash-att-main"><strong>${escapeHtml(j.client)}</strong> <span class="tc-muted">#${escapeHtml(j.jobNum)}</span></div>
          <div class="dash-att-sub tc-muted">Paused · ${j.deadline?fmt(j.deadline):'no deadline'}</div>
        </div>`).join('')}
      </div>`:''}

      <div class="dash-widget">
        <div class="dash-widget-hd">Recent Activity <a class="dash-widget-link" onclick="goHub('account','activity-log')">Full log →</a></div>
        <div class="dash-activity-feed">
          ${recent.length?recent.map(e=>`<div class="daf-item"><span class="daf-dot daf-${e.color||'blue'}"></span><div class="daf-body"><div class="daf-what">${escapeHtml(e.desc||'')}</div><div class="daf-time">${dashRelTime(e.ts)}</div></div></div>`).join(''):'<div class="empty" style="padding:1rem;">No recent activity.</div>'}
        </div>
      </div>
    </div>

    <div class="dash-col-right">
      <div class="dash-widget dash-attention${overdue.length?' has-items':''}">
        <div class="dash-widget-hd">⚠️ My Overdue Jobs <span class="dash-count-badge">${overdue.length}</span></div>
        ${overdue.length?overdue.slice(0,5).map(j=>`<div class="dash-att-row" onclick="goHub('jobs','my-jobs')" style="cursor:pointer;">
          <div class="dash-att-main"><strong>${escapeHtml(j.client)}</strong> <span class="tc-muted">#${escapeHtml(j.jobNum)}</span></div>
          <div class="dash-att-sub tc-red">${j.deadline?fmt(j.deadline):'no deadline'} · ${escapeHtml(j.type||'')}</div>
        </div>`).join('')+(overdue.length>5?`<div class="dash-att-more">+${overdue.length-5} more</div>`:''):'<div class="empty" style="padding:0.75rem;">No overdue jobs 🎉</div>'}
      </div>

      <div class="dash-widget">
        <div class="dash-widget-hd">📅 Upcoming Deadlines <a class="dash-widget-link" onclick="goHub('team','cal')">Calendar →</a></div>
        ${upcoming.length?upcoming.map(j=>{
          const diff=toMillis(j.deadline)-nowMs;
          const cls=diff<86400000?'tc-yellow':'tc-muted';
          return`<div class="dash-att-row">
            <div class="dash-att-main"><strong>${escapeHtml(j.client)}</strong> <span class="tc-muted">#${escapeHtml(j.jobNum)}</span></div>
            <div class="dash-att-sub ${cls}">${fmt(j.deadline)} · in ${tdiff(nowMs,toMillis(j.deadline))}</div>
          </div>`;
        }).join(''):'<div class="empty" style="padding:0.75rem;">Nothing due this week.</div>'}
      </div>

      <div class="dash-widget">
        <div class="dash-widget-hd">📬 My Extension Requests</div>
        ${myExts.length?myExts.map(r=>{
          const statusCol=r.status==='approved'?'var(--green)':r.status==='rejected'?'var(--red)':'var(--yellow)';
          const statusIcon=r.status==='approved'?'✅':r.status==='rejected'?'❌':'⏳';
          return`<div class="dash-att-row">
            <div class="dash-att-main"><strong>${escapeHtml(r.client)}</strong> <span class="tc-muted">#${escapeHtml(String(r.jobNum))}</span></div>
            <div class="dash-att-sub" style="color:${statusCol};">${statusIcon} ${r.status} · ${fmt(r.newDeadline)}</div>
          </div>`;
        }).join(''):'<div class="empty" style="padding:0.75rem;">No extension requests.</div>'}
      </div>
    </div>
  </div>`;
}

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
function renderDashboard(){
  if(!me)return;
  const root=document.getElementById('dash-root');
  if(!root)return;
  if(me.role==='sales_operation')return; // sales op uses Job Basket, not dashboard
  // ── EMPLOYEE personal dashboard ───────────────────────────────────────────
  if(me.role==='employee'){renderEmpDashboard(root);return;}

  const dj=visibleJobs();
  const teamIds=isTeamLeader()?new Set(myTeamIds()):null;
  const now=new Date();
  const ws=new Date(now);ws.setDate(now.getDate()-now.getDay());ws.setHours(0,0,0,0);
  const lastWs=new Date(ws);lastWs.setDate(ws.getDate()-7);
  const todayEnd=new Date(now);todayEnd.setHours(23,59,59,999);
  const weekEnd=new Date(now);weekEnd.setDate(now.getDate()+7);

  const active=dj.filter(j=>j.status!=='completed');
  const overdueJobs=dj.filter(j=>isOverdue(j));
  const dueToday=dj.filter(j=>j.status!=='completed'&&j.deadline&&toMillis(j.deadline)<=todayEnd.getTime()&&toMillis(j.deadline)>=now.getTime());
  const dueWeek=dj.filter(j=>j.status!=='completed'&&j.deadline&&toMillis(j.deadline)>now.getTime()&&toMillis(j.deadline)<=weekEnd.getTime());
  const doneThisWeek=dj.filter(j=>j.completed&&toMillis(j.completed)>=ws.getTime());
  const doneLastWeek=dj.filter(j=>j.completed&&toMillis(j.completed)>=lastWs.getTime()&&toMillis(j.completed)<ws.getTime());
  const pending=dj.filter(j=>j.status==='pending').length;
  const ongoing=dj.filter(j=>j.status==='ongoing').length;
  const paused=dj.filter(j=>j.status==='paused').length;
  const completed=dj.filter(j=>j.status==='completed').length;
  const pendExt=extRequests.filter(r=>r.status==='pending'&&(!teamIds||teamIds.has((jobs.find(x=>x.id===r.jobId)||{}).owner)));

  // greeting
  const hr=now.getHours();
  const greet=hr<12?'Good morning':hr<18?'Good afternoon':'Good evening';
  const dateStr=now.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  // health summary
  const healthBits=[`<strong>${active.length}</strong> active`];
  if(overdueJobs.length)healthBits.push(`<strong class="tc-red">${overdueJobs.length}</strong> overdue`);
  if(dueToday.length)healthBits.push(`<strong class="tc-yellow">${dueToday.length}</strong> due today`);
  if(pendExt.length)healthBits.push(`<strong class="tc-yellow">${pendExt.length}</strong> ext. request${pendExt.length>1?'s':''}`);
  const allClear=!overdueJobs.length&&!dueToday.length&&!pendExt.length;

  // week trend
  const weekDelta=doneThisWeek.length-doneLastWeek.length;
  const trendStr=weekDelta>0?`<span class="kpi-trend up">▲ ${weekDelta} vs last wk</span>`
    :weekDelta<0?`<span class="kpi-trend down">▼ ${Math.abs(weekDelta)} vs last wk</span>`
    :`<span class="kpi-trend">— same as last wk</span>`;

  const slaStats=computeSlaStats(dj);
  const kpis=[
    {icon:'📋',label:'Active Jobs',value:active.length,sub:`${pending} pending · ${ongoing} ongoing`,accent:'var(--blue)',filter:null},
    {icon:'⚠️',label:'Overdue',value:overdueJobs.length,sub:overdueJobs.length?'needs attention':'all on track',accent:overdueJobs.length?'var(--red)':'var(--text3)',filter:'overdue'},
    {icon:'📅',label:'Due This Week',value:dueToday.length+dueWeek.length,sub:`${dueToday.length} today · ${dueWeek.length} upcoming`,accent:'var(--orange)',filter:null},
    {icon:'✅',label:'Done This Week',value:doneThisWeek.length,sub:trendStr,accent:'var(--green)',filter:null},
    {icon:'🎯',label:'On-Time Rate',value:slaStats.onTimePct+'%',sub:`${slaStats.doneWithDl} completed with deadlines`,accent:slaStats.onTimePct>=70?'var(--green)':slaStats.onTimePct>=40?'var(--yellow)':'var(--red)',filter:null},
  ];

  // status donut
  const donutData=[
    {label:'Pending',value:pending,color:'#ffd60a'},
    {label:'Ongoing',value:ongoing,color:'#0a84ff'},
    {label:'Paused',value:paused,color:'#6e6e73'},
    {label:'Completed',value:completed,color:'#32d74b'},
  ];
  const donutTotal=dj.length||1;
  let donutSvg='',start=0;
  const dnz=donutData.filter(s=>s.value>0);
  if(dnz.length===1){donutSvg=`<circle cx="60" cy="60" r="50" fill="${dnz[0].color}"/>`;}
  else{donutData.forEach(s=>{if(!s.value)return;const frac=s.value/donutTotal,ang=frac*2*Math.PI;const x1=60+50*Math.sin(start),y1=60-50*Math.cos(start);const x2=60+50*Math.sin(start+ang),y2=60-50*Math.cos(start+ang);const large=ang>Math.PI?1:0;donutSvg+=`<path d="M60,60 L${x1},${y1} A50,50 0 ${large} 1 ${x2},${y2} Z" fill="${s.color}"/>`;start+=ang;});}

  // team workload (top busiest)
  const team=teamUsersForView().filter(u=>u.role!=='manager'||users.length<=2);
  const workload=team.map(u=>{
    const a=dj.filter(j=>j.owner===u.id&&j.status!=='completed').length;
    const od=overdueJobs.filter(j=>j.owner===u.id).length;
    return{u,a,od};
  }).filter(w=>w.a>0||w.od>0).sort((x,y)=>(y.od-x.od)||(y.a-x.a)).slice(0,6);

  // recent activity (scope to team for leaders)
  const recent=[...activityLogs].filter(e=>!teamIds||teamIds.has(e.userId)||teamIds.has((jobs.find(x=>x.id===e.jobId)||{}).owner)).sort((a,b)=>(b.ts||0)-(a.ts||0)).slice(0,8);
  // upcoming deadlines next 7 days
  const upcoming=[...dj].filter(j=>j.status!=='completed'&&j.deadline&&toMillis(j.deadline)>=now.getTime()&&toMillis(j.deadline)<=weekEnd.getTime())
    .sort((a,b)=>toMillis(a.deadline)-toMillis(b.deadline)).slice(0,6);

  root.innerHTML=`
  <div class="dash-hero">
    <div>
      <div class="dash-greet">${greet}, ${escapeHtml((me.name||'').split(' ')[0])}</div>
      <div class="dash-date">${dateStr}</div>
    </div>
    <div class="dash-health${allClear?' dash-health-ok':''}">
      ${allClear?'✓ Everything on track':healthBits.join('<span class="dash-health-sep">·</span>')}
    </div>
  </div>

  <div class="dash-kpis">
    ${kpis.map(k=>`<div class="kpi-card"${k.filter?` onclick="goHub('jobs','my-jobs');setF('${k.filter}')" style="cursor:pointer;"`:''}>
      <div class="kpi-top"><span class="kpi-icon">${k.icon}</span><span class="kpi-label">${k.label}</span></div>
      <div class="kpi-value" style="color:${k.accent}">${k.value}</div>
      <div class="kpi-sub">${k.sub}</div>
    </div>`).join('')}
  </div>

  <div class="dash-main">
    <div class="dash-col-left">
      <div class="dash-widget">
        <div class="dash-widget-hd">Status Breakdown</div>
        <div class="dash-donut-wrap">
          <svg width="120" height="120" viewBox="0 0 120 120">${donutSvg}<circle cx="60" cy="60" r="28" fill="var(--card)"/><text x="60" y="56" text-anchor="middle" class="donut-center-num">${jobs.length}</text><text x="60" y="72" text-anchor="middle" class="donut-center-lbl">jobs</text></svg>
          <div class="dash-donut-legend">
            ${donutData.map(s=>`<div class="ddl-row"><span class="ddl-dot" style="background:${s.color}"></span>${s.label}<span class="ddl-val">${s.value}</span></div>`).join('')}
          </div>
        </div>
      </div>

      <div class="dash-widget">
        <div class="dash-widget-hd">Team Workload <a class="dash-widget-link" onclick="goHub('team','board')">View board →</a></div>
        ${workload.length?workload.map(w=>{
          const col=w.od>0?'var(--red)':w.a>=5?'var(--red)':w.a>=3?'var(--yellow)':'var(--green)';
          const pct=Math.min(100,Math.round(w.a/6*100));
          return`<div class="dash-load-row" style="cursor:pointer;" onclick="goHub('insights','reports');setTimeout(()=>setAnalyticsEmp('${w.u.id}'),200)" title="View ${escapeHtml(w.u.name)}'s analytics">
            <span class="dash-load-name">${escapeHtml(w.u.name)}</span>
            <div class="dash-load-bar"><div class="dash-load-fill" style="width:${pct}%;background:${col}"></div></div>
            <span class="dash-load-meta">${w.a}${w.od?` <span class="tc-red">⚠${w.od}</span>`:''}</span>
          </div>`;
        }).join(''):'<div class="empty" style="padding:1rem;">No active assignments.</div>'}
      </div>

      <div class="dash-widget">
        <div class="dash-widget-hd">Recent Activity <a class="dash-widget-link" onclick="goHub('account','activity-log')">Full log →</a></div>
        <div class="dash-activity-feed">
          ${recent.length?recent.map(e=>`<div class="daf-item"><span class="daf-dot daf-${e.color||'blue'}"></span><div class="daf-body"><div class="daf-what">${escapeHtml(e.desc||'')}</div><div class="daf-time">${dashRelTime(e.ts)}</div></div></div>`).join(''):'<div class="empty" style="padding:1rem;">No recent activity.</div>'}
        </div>
      </div>
    </div>

    <div class="dash-col-right">
      <div class="dash-widget dash-attention${overdueJobs.length?' has-items':''}">
        <div class="dash-widget-hd">⚠️ Overdue <span class="dash-count-badge">${overdueJobs.length}</span></div>
        ${overdueJobs.length?overdueJobs.slice(0,6).map(j=>`<div class="dash-att-row" onclick="goHub('jobs','my-jobs');setTimeout(()=>openJobDetail&&openJobDetail('${j.id}'),50)">
          <div class="dash-att-main"><strong>${escapeHtml(j.client)}</strong> <span class="tc-muted">#${escapeHtml(j.jobNum)}</span></div>
          <div class="dash-att-sub">${escapeHtml(users.find(u=>u.id===j.owner)?.name||'?')} · ${j.deadline?fmt(j.deadline):'no deadline'}</div>
        </div>`).join('')+(overdueJobs.length>6?`<div class="dash-att-more">+${overdueJobs.length-6} more</div>`:''):'<div class="empty" style="padding:1rem;">No overdue jobs 🎉</div>'}
      </div>

      <div class="dash-widget">
        <div class="dash-widget-hd">📬 Extension Requests <span class="dash-count-badge">${pendExt.length}</span></div>
        <div id="dash-extensions"></div>
      </div>

      <div class="dash-widget">
        <div class="dash-widget-hd">📅 Upcoming Deadlines <a class="dash-widget-link" onclick="goHub('team','cal')">Calendar →</a></div>
        ${upcoming.length?upcoming.map(j=>{
          const diff=toMillis(j.deadline)-now.getTime();
          const cls=diff<86400000?'tc-yellow':'tc-muted';
          return`<div class="dash-att-row">
            <div class="dash-att-main"><strong>${escapeHtml(j.client)}</strong> <span class="tc-muted">#${escapeHtml(j.jobNum)}</span></div>
            <div class="dash-att-sub ${cls}">${fmt(j.deadline)} · ${escapeHtml(users.find(u=>u.id===j.owner)?.name||'?')}</div>
          </div>`;
        }).join(''):'<div class="empty" style="padding:1rem;">Nothing due this week.</div>'}
      </div>
    </div>
  </div>`;
  renderDashExtensions();
}
export function dashRelTime(ts){
  const ms=toMillis(ts);if(!ms)return'';
  const diff=Date.now()-ms;
  if(diff<60000)return'just now';
  if(diff<3600000)return Math.floor(diff/60000)+'m ago';
  if(diff<86400000)return Math.floor(diff/3600000)+'h ago';
  if(diff<604800000)return Math.floor(diff/86400000)+'d ago';
  return fmt(ts);
}
function extDeltaLabel(oldDl,newDl){
  if(!oldDl||!newDl)return'';
  const days=Math.round((toMillis(newDl)-toMillis(oldDl))/86400000);
  if(days===0)return'<span class="ext-delta">same day</span>';
  return`<span class="ext-delta ${days>0?'ext-delta-plus':'ext-delta-minus'}">${days>0?'+':''}${days} day${Math.abs(days)>1?'s':''}</span>`;
}
function extForView(){
  if(canSeeAllJobs())return extRequests;
  if(isTeamLeader()){const ids=new Set(myTeamIds());return extRequests.filter(r=>{const j=jobs.find(x=>x.id===r.jobId);return j&&ids.has(j.owner);});}
  return extRequests.filter(r=>r.requestedBy===me?.id);
}
export function renderDashExtensions(){
  // compact widget for the dashboard
  const el=document.getElementById('dash-extensions');
  if(el){
    const pending=extForView().filter(r=>r.status==='pending');
    el.innerHTML=pending.length?pending.slice(0,5).map(r=>`<div class="dash-att-row">
      <div class="dash-att-main"><strong>${escapeHtml(r.client)}</strong> <span class="tc-muted">#${escapeHtml(String(r.jobNum))}</span></div>
      <div class="dash-att-sub">${escapeHtml(r.requestedByName)} · ${fmt(r.newDeadline)}</div>
      <div class="ext-mini-actions"><button class="jd-btn bc" onclick="approveExt('${r.id}')">Approve</button><button class="jd-btn jd-btn-danger" onclick="rejectExt('${r.id}')">Reject</button></div>
    </div>`).join(''):'<div class="empty" style="padding:1rem;">No pending requests.</div>';
  }
  renderExtensionsPage();
}
function renderExtensionsPage(){
  const el=document.getElementById('ext-review-list');
  if(!el)return;
  const ev=extForView();
  const pending=ev.filter(r=>r.status==='pending');
  const history=ev.filter(r=>r.status!=='pending').sort((a,b)=>toMillis(b.reviewedAt||b.created)-toMillis(a.reviewedAt||a.created));
  const now=Date.now();
  const ws=new Date();ws.setDate(ws.getDate()-ws.getDay());ws.setHours(0,0,0,0);
  const apprWk=history.filter(r=>r.status==='approved'&&toMillis(r.reviewedAt)>=ws.getTime()).length;
  const rejWk=history.filter(r=>r.status==='rejected'&&toMillis(r.reviewedAt)>=ws.getTime()).length;
  // sort pending: overdue/high priority first
  const sortedPending=[...pending].sort((a,b)=>{
    const ja=jobs.find(x=>x.id===a.jobId),jb=jobs.find(x=>x.id===b.jobId);
    const oa=ja&&isOverdue(ja)?1:0,ob=jb&&isOverdue(jb)?1:0;
    if(oa!==ob)return ob-oa;
    return toMillis(a.created)-toMillis(b.created);
  });
  const summary=`<div class="ext-summary">
    <div class="ext-sum-card"><div class="ext-sum-n" style="color:var(--orange)">${pending.length}</div><div class="ext-sum-l">Pending</div></div>
    <div class="ext-sum-card"><div class="ext-sum-n" style="color:var(--green)">${apprWk}</div><div class="ext-sum-l">Approved this wk</div></div>
    <div class="ext-sum-card"><div class="ext-sum-n" style="color:var(--red)">${rejWk}</div><div class="ext-sum-l">Rejected this wk</div></div>
  </div>`;
  const pendingHtml=sortedPending.length?sortedPending.map(r=>{
    const j=jobs.find(x=>x.id===r.jobId);
    const od=j&&isOverdue(j);
    const pri=j?.priority;
    const oldDl=r.oldDeadline||j?.deadline;
    return`<div class="ext-card${od?' ext-card-od':''}">
      <div class="ext-card-hd">
        <span class="ext-client" onclick="openJobByNum('${escapeHtml(String(r.jobNum))}')">${escapeHtml(r.client)} <span class="tc-muted">#${escapeHtml(String(r.jobNum))}</span></span>
        ${pri?`<span class="bdg bdg-${pri==='High'?'h':pri==='Medium'?'med':'l'}">${pri}</span>`:''}
        ${od?'<span class="ext-od-flag">⚠ Overdue</span>':''}
      </div>
      <div class="ext-requester">Requested by <strong>${escapeHtml(r.requestedByName)}</strong>${j&&users.find(u=>u.id===j.owner)?.name!==r.requestedByName?` for <strong>${escapeHtml(users.find(u=>u.id===j?.owner)?.name||'')}</strong>`:''}${j?.type?` · ${escapeHtml(j.type)}`:''} · ${dashRelTime(r.created)}</div>
      <div class="ext-dl-change">
        <div class="ext-dl-box"><span class="ext-dl-lbl">Current</span><span class="ext-dl-val">${oldDl?fmt(oldDl):'—'}</span></div>
        <span class="ext-dl-arrow">→</span>
        <div class="ext-dl-box ext-dl-new"><span class="ext-dl-lbl">Requested</span><span class="ext-dl-val">${fmt(r.newDeadline)}</span></div>
        ${extDeltaLabel(oldDl,r.newDeadline)}
      </div>
      <div class="ext-reason">"${escapeHtml(r.reason||'')}"</div>
      <div class="ext-card-actions">
        <button class="bp ext-approve" onclick="approveExt('${r.id}')">✓ Approve</button>
        <button class="bp sec ext-reject" onclick="rejectExt('${r.id}')">✕ Reject</button>
      </div>
    </div>`;
  }).join(''):'<div class="ext-allclear">✓ No pending requests — you\'re all caught up.</div>';
  let historyHtml='';
  if(history.length){
    historyHtml=`<div class="ext-history">
      <button class="completed-toggle" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'':'none'">📜 History (${history.length})</button>
      <div style="display:none;margin-top:0.5rem;">
        ${history.slice(0,40).map(r=>`<div class="ext-hist-row">
          <span class="ext-hist-status ext-hist-${r.status}">${r.status==='approved'?'✅':'❌'}</span>
          <div class="ext-hist-body"><strong>${escapeHtml(r.client)}</strong> <span class="tc-muted">#${escapeHtml(String(r.jobNum))}</span> · ${escapeHtml(r.requestedByName)}<div class="ext-hist-meta">${r.status} by ${escapeHtml(r.reviewedBy||'?')} · ${r.reviewedAt?dashRelTime(r.reviewedAt):''}</div></div>
        </div>`).join('')}
      </div>
    </div>`;
  }
  el.innerHTML=summary+`<div class="ext-queue">${pendingHtml}</div>`+historyHtml;
}

// ── MISC ──────────────────────────────────────────────────────────────────────
export function showToastMsg(msg){
  const t=document.getElementById('toast');
  t.innerHTML=msg;
  t.style.display='block';
  setTimeout(()=>t.style.display='none',3000);
}
window.undoDel=async function(){
  if(!lastDel)return;
  if(!canManageJob(lastDel)){showToastMsg('Not authorized.');return;}
  await jRestore(lastDel);
  await addEvent(lastDel.id,'restored',`Job restored by ${me.name}`,'green');
  setLastDel(null);document.getElementById('toast').style.display='none';
};
setInterval(()=>{document.getElementById('clock').textContent=new Date().toLocaleDateString('en-GB')+' '+new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});},1000);

// ── TABS / HUB NAV ────────────────────────────────────────────────────────────
let currentHub='jobs',currentSub='my-jobs',lastAccountSub='profile';
const HUB_DEFAULTS={jobs:'my-jobs',team:'board',insights:'overview',messages:'broadcast',account:'profile',work:'job-basket',personal:'my-space'};
const SUB_TO_SECTION={
  'my-jobs':'my-jobs','add-job':'add-job',board:'board',cal:'cal',assign:'assign',
  overview:'dashboard',reports:'analytics',search:'adv-search',extensions:'extensions-review',activity:'login-log',
  broadcast:'broadcast',profile:'account',preferences:'account',users:'users','activity-log':'login-log',
  teams:'teams-overview','email-control':'email-control','job-basket':'job-basket',
  'my-space':'my-space'
};
const SECTION_TO_SB={
  'my-jobs':'my-jobs','add-job':'my-jobs',
  board:'board',cal:'cal',assign:'assign',
  dashboard:'dashboard','extensions-review':'extensions-review',
  analytics:'analytics','adv-search':'adv-search',
  broadcast:'broadcast',account:'account',users:'users','login-log':'login-log',
  'teams-overview':'teams-overview','email-control':'email-control','job-basket':'job-basket',
  'my-space':'my-space'
};
const SB_TO_HUB={
  'my-jobs':['jobs','my-jobs'],assign:['team','assign'],
  board:['team','board'],cal:['team','cal'],
  dashboard:['insights','overview'],'extensions-review':['insights','extensions'],
  analytics:['insights','reports'],'adv-search':['insights','search'],
  broadcast:['messages','broadcast'],account:['account','profile'],
  users:['account','users'],'login-log':['account','activity-log'],
  'teams-overview':['insights','teams'],'email-control':['insights','email-control'],
  'job-basket':['work','job-basket'],
  'my-space':['personal','my-space']
};
function applyMainNav(){
  const r=me?.role||'';
  // Sales Operation: only Job Basket + Account. Nothing else.
  if(r==='sales_operation'){
    const allow=new Set(['job-basket','account']);
    document.querySelectorAll('.sb-item').forEach(el=>{el.style.display=allow.has(el.dataset.sb)?'flex':'none';});
    const teamGrp=document.getElementById('sbg-team');if(teamGrp)teamGrp.style.display='none';
    document.querySelectorAll('.sb-admin').forEach(el=>el.style.display='none');
    const topbar=document.querySelector('.topbar');if(topbar)topbar.style.display='none';
    window.renderSbBasketSubs?.();
    return;
  }
  // Directors: read-only oversight. Only Dashboard, Analytics, Teams, Account, Accounts directory.
  if(isDirectorRole(r)){
    const allow=new Set(['dashboard','analytics','teams-overview','account','users','my-jobs','job-basket']);
    document.querySelectorAll('.sb-item').forEach(el=>{el.style.display=allow.has(el.dataset.sb)?'flex':'none';});
    const teamGrp=document.getElementById('sbg-team');if(teamGrp)teamGrp.style.display='none';
    // directors get a read-only "Jobs" view: rename the item + page title, hide "add job"
    document.querySelectorAll('[data-sb="my-jobs"] span').forEach(s=>s.textContent='Jobs');
    const t=document.getElementById('my-jobs-title');if(t)t.textContent='Jobs';
    const nb=document.getElementById('new-job-btn');if(nb)nb.style.display='none';
    const topbar=document.querySelector('.topbar');if(topbar)topbar.style.display=currentHub==='jobs'?'flex':'none';
    renderSbAnalyticsSubs();window.renderSbBasketSubs?.();
    return;
  }
  const isManager=r==='manager';
  const isTeam=['manager','supervisor','team_leader'].includes(r);
  const isLeadNav=['manager','supervisor','team_leader'].includes(r);
  document.querySelectorAll('.sb-assign').forEach(el=>el.style.display=isTeam?'flex':'none');
  document.querySelectorAll('.sb-team').forEach(el=>el.style.display=isTeam?'block':'none');
  document.querySelectorAll('.sb-ext').forEach(el=>el.style.display=isTeam?'flex':'none');
  document.querySelectorAll('.sb-lead').forEach(el=>el.style.display=isLeadNav?'flex':'none');
  document.querySelectorAll('.sb-manager').forEach(el=>el.style.display=isManager?'flex':'none');
  document.querySelectorAll('.sb-admin').forEach(el=>el.style.display=isManager?'flex':'none');
  document.querySelectorAll('.sb-work').forEach(el=>el.style.display='flex'); // Job Basket for all staff
  const topbar=document.querySelector('.topbar');
  if(topbar)topbar.style.display=currentHub==='jobs'?'flex':'none';
  renderSbAnalyticsSubs();
  window.renderSbBasketSubs?.();
}
function updateSidebarActive(sectionId){
  const sbKey=SECTION_TO_SB[sectionId]||sectionId;
  document.querySelectorAll('.sb-item').forEach(a=>a.classList.toggle('on',a.dataset.sb===sbKey));
  // auto-expand parent group of active item
  const active=document.querySelector(`.sb-item.on`);
  if(active?.closest('.sb-group-items')){
    const grp=active.closest('.sb-group');
    if(grp&&!grp.classList.contains('sb-grp-open'))grp.classList.add('sb-grp-open');
  }
}
// sidebar group toggle
window.toggleSbGroup=function(groupId){
  const grp=document.getElementById(groupId);
  if(grp)grp.classList.toggle('sb-grp-open');
};
// sidebar collapse
window.toggleSidebarCollapse=function(){
  const sb=document.getElementById('sidebar');
  const collapsed=sb.classList.toggle('sb-collapsed');
  localStorage.setItem('sb_collapsed',collapsed?'1':'');
  document.getElementById('sb-collapse-btn').textContent=collapsed?'▶':'◀';
};
// restore collapse state
(function(){
  if(localStorage.getItem('sb_collapsed')==='1'){
    document.getElementById('sidebar')?.classList.add('sb-collapsed');
    const btn=document.getElementById('sb-collapse-btn');
    if(btn)btn.textContent='▶';
  }
})();
function setAccountPane(pane){
  const p=document.getElementById('account-pane-profile');
  const pr=document.getElementById('account-pane-prefs');
  if(p)p.style.display=pane==='profile'?'block':'none';
  if(pr)pr.style.display=pane==='prefs'?'block':'none';
  if(pane==='hide'){if(p)p.style.display='none';if(pr)pr.style.display='none';}
}
window.setAccountTab=function(sub){
  document.querySelectorAll('.acct-tab').forEach(b=>b.classList.toggle('on',b.textContent.toLowerCase().startsWith(sub==='preferences'?'pref':'prof')));
  if(sub==='profile'){setAccountPane('profile');renderAccountProfile();return;}
  if(sub==='preferences'){setAccountPane('prefs');renderAccountPreferences();return;}
};
function runHubSideEffects(id){
  if(id==='my-jobs'||id==='add-job')renderJobs();
  if(id==='assign'){renderAssignEmpGrid();document.getElementById('assign-emp-preview').style.display='none';}
  if(id==='board')renderBoard();
  if(id==='cal'){calY=new Date().getFullYear();calM=new Date().getMonth();populateCalEmpDrop();renderCal();}
  if(id==='analytics')renderAnalytics();
  if(id==='dashboard'){
    renderDashboard();
    if(USE_FIREBASE)refreshActivityLogsRemote().then(()=>{refreshExtensionsRemote();renderDashboard();});
    else{refreshExtensionsRemote();renderDashboard();}
  }
  if(id==='extensions-review'){refreshExtensionsRemote();renderDashExtensions();}
  if(id==='teams-overview'){refreshUsersRemote();renderTeamsOverview();}
  if(id==='adv-search'){refreshUsersRemote();populateReassignDrops();}
  if(id==='email-control')renderEmailControl();
  if(id==='job-basket')renderJobBasket();
  if(id==='users')refreshUsersRemote();
  if(id==='login-log')refreshActivityLogsRemote();
  if(id==='broadcast'){updateBroadcastUI();refreshBroadcastsRemote();setTimeout(markBroadcastsSeen,1200);}
  if(id==='account'){renderAccountProfile();renderAccountPreferences();}
  if(id==='my-space')renderMySpace();
}
function goHub(hub,sub){
  if(hub==='account'&&!sub)sub=lastAccountSub;
  currentHub=hub;
  const subKey=sub||HUB_DEFAULTS[hub];
  const sectionId=SUB_TO_SECTION[subKey]||subKey;
  currentSub=subKey;
  if(hub==='account')lastAccountSub=subKey;
  document.querySelectorAll('section').forEach(s=>s.classList.remove('on'));
  document.getElementById(sectionId)?.classList.add('on');
  if(hub==='account'){
    if(subKey==='users'||subKey==='activity-log')setAccountPane('hide');
    else if(subKey==='preferences')setAccountPane('prefs');
    else setAccountPane('profile');
  }
  updateSidebarActive(sectionId);
  applyMainNav();
  runHubSideEffects(sectionId);
  document.getElementById('notif-panel').style.display='none';
  closeSidebar();
}
window.goHub=goHub;
window.openNewJob=function(){goHub('jobs','add-job');document.getElementById('jc')?.focus();};
function goTab(id){
  const map={
    'my-jobs':['jobs','my-jobs'],'add-job':['jobs','add-job'],
    board:['team','board'],cal:['team','cal'],assign:['team','assign'],
    dashboard:['insights','overview'],analytics:['insights','reports'],'adv-search':['insights','search'],
    'login-log':['insights','activity'],'extensions-review':['insights','extensions'],'teams-overview':['insights','teams'],
    broadcast:['messages','broadcast'],settings:['account','profile'],account:['account','profile'],
    users:['account','users'],'activity-log':['account','activity-log']
  };
  const t=map[id]||['jobs','my-jobs'];
  goHub(t[0],t[1]);
}
window.goTab=goTab;
// sidebar clicks
document.querySelectorAll('.sb-item').forEach(a=>{
  a.addEventListener('click',e=>{
    e.preventDefault();
    const k=SB_TO_HUB[a.dataset.sb];
    if(k)goHub(k[0],k[1]);
  });
});
// sidebar toggle
window.toggleSidebar=function(){
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sb-overlay').classList.toggle('open');
};
window.closeSidebar=function(){
  if(window.innerWidth<=768){
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sb-overlay').classList.remove('open');
  }
};

// ── RENDER ALL ────────────────────────────────────────────────────────────────
window.renderAll=function(){
  if(!me)return;
  renderJobs();updateSummary();renderAnalyticsContent();showDeadlineBanner();
  if(document.getElementById('job-basket')?.classList.contains('on'))renderJobBasket();
  if(document.getElementById('dashboard')?.classList.contains('on'))renderDashboard();
  if(['manager','supervisor','team_leader'].includes(me.role)){
    if(document.getElementById('login-log')?.classList.contains('on'))renderActivityLog();
  }
  renderSbAnalyticsSubs();
  window.renderSbBasketSubs?.();
};

// Click outside to close notif panel
document.addEventListener('click',function(e){
  const panel=document.getElementById('notif-panel');
  const bell=document.querySelector('.bell-wrap');
  if(panel.style.display==='block'&&!panel.contains(e.target)&&!bell.contains(e.target)){
    panel.style.display='none';
  }
});

(async function(){
  try{
    const v14=await fetch('./v14-features-snippet.js').then(r=>r.text());
    if(v14)eval(v14);
  }catch(e){console.warn('v1.4 features load skipped',e);}
  
// ── V1.4 FEATURES ───────────────────────────────────────────────────────────
function isManager(){return me?.role==='manager';}
function isSupervisor(){return me?.role==='supervisor';}
function canManageUsers(){return isManager();}
function canEditUser(target){
  if(!canManageUsers())return false;
  if(target?.id===me?.id)return true;
  return true;
}
function canDeleteUser(target){
  if(!isManager())return false;
  if(target?.id===me?.id)return false;
  return true;
}

async function auditManagersOnLogin(){
  if(!USE_FIREBASE||!uCol||!isManager())return;
  const fixes=[];
  users.forEach(u=>{
    if(u.role==='manager'&&u.viewAll!=='yes')fixes.push({id:u.id,patch:{viewAll:'yes'}});
  });
  for(const f of fixes){
    await updateDoc(doc(uCol,f.id),f.patch);
    const u=users.find(x=>x.id===f.id);
    if(u)u.viewAll='yes';
  }
}

function parseUrlJob(){
  const p=new URLSearchParams(location.search);
  const n=p.get('job')||p.get('jobNum');
  return n?String(n).trim():'';
}
function openJobFromUrl(){
  const num=parseUrlJob();
  if(!num||!me)return;
  const job=jobs.find(j=>String(j.jobNum)===num);
  if(!job)return;
  goTab('my-jobs');
  setTimeout(()=>{
    const c=document.getElementById('card-'+job.id);
    if(c){c.scrollIntoView({behavior:'smooth',block:'center'});c.classList.add('selected');setTimeout(()=>c.classList.remove('selected'),2500);}
  },300);
}

function setManagerJobsScope(v){
  userSettings.managerJobsScope=v;
  userSettings.jobsPage=0;
  saveUserSettings();
  renderJobs();
}
window.setManagerJobsScope=setManagerJobsScope;
function setJobsSort(v){
  userSettings.jobsSort=v;
  userSettings.jobsPage=0;
  saveUserSettings();
  renderJobs();
}
window.setJobsSort=setJobsSort;

function jobsForDisplay(){
  let mine=visibleJobs();
  if(canSeeAllJobs()&&userSettings.managerJobsScope==='mine')mine=jobs.filter(j=>j.owner===me.id);
  const prio={High:0,Medium:1,Low:2};
  const sort=userSettings.jobsSort||'created';
  mine=[...mine].sort((a,b)=>{
    if(sort==='deadline')return(toMillis(a.deadline)||9e15)-(toMillis(b.deadline)||9e15);
    if(sort==='priority')return(prio[a.priority]??9)-(prio[b.priority]??9);
    if(sort==='client')return(a.client||'').localeCompare(b.client||'');
    return(toMillis(b.created)||0)-(toMillis(a.created)||0);
  });
  return mine;
}
window._jobsForDisplay=jobsForDisplay;

function renderJobsPager(total){
  const page=userSettings.jobsPage||0;
  const pages=Math.max(1,Math.ceil(total/JOBS_PAGE_SIZE));
  const bar=document.getElementById('jobs-pager-bar');
  const lbl=document.getElementById('jobs-pager');
  if(lbl)lbl.textContent=total?`${page*JOBS_PAGE_SIZE+1}–${Math.min((page+1)*JOBS_PAGE_SIZE,total)} of ${total}`:'';
  if(!bar)return;
  if(total<=JOBS_PAGE_SIZE){bar.innerHTML='';return;}
  bar.innerHTML=`<button type="button" class="bp sec" ${page<=0?'disabled':''} onclick="jobsPagePrev()">◀ Prev</button>
    <span style="align-self:center;font-size:0.78rem;color:var(--text2);">Page ${page+1} / ${pages}</span>
    <button type="button" class="bp sec" ${page>=pages-1?'disabled':''} onclick="jobsPageNext()">Next ▶</button>`;
}
window._renderJobsPager=renderJobsPager;
window.jobsPagePrev=function(){userSettings.jobsPage=Math.max(0,(userSettings.jobsPage||0)-1);saveUserSettings();renderJobs();};
window.jobsPageNext=function(){
  userSettings.jobsPage=(userSettings.jobsPage||0)+1;
  saveUserSettings();
  renderJobs();
};

window.assignToMe=function(){
  if(!me)return;
  selectAssignEmp(me.id);
  showToastMsg('Assigning to yourself — fill in the details and click Assign Task.');
};

function showSectionLoading(on){
  const el=document.getElementById('section-loader');
  if(el)el.style.display=on?'flex':'none';
}

function parseMentions(text){
  const found=[];
  const re=/@([A-Za-z][A-Za-z0-9 ._-]{1,40})/g;
  let m;
  while((m=re.exec(text||''))){
    const name=m[1].trim().toLowerCase();
    const u=users.find(x=>x.name.trim().toLowerCase()===name||x.name.trim().toLowerCase().startsWith(name));
    if(u&&!found.includes(u.id))found.push(u.id);
  }
  return found;
}
async function notifyMentions(text,job,ctx){
  const ids=parseMentions(text);
  const label=job?`${job.client} (#${job.jobNum})`:'a job';
  for(const uid of ids){
    const u=users.find(x=>x.id===uid);
    if(!u||uid===me?.id)continue;
    await pushNotif(uid,'💬 Mentioned',`${me.name} mentioned you on ${label}: ${ctx.slice(0,80)}`);
  }
}

async function logAudit(type,desc,extra={}){
  await logActivity({type,category:'audit',desc,userId:me?.id,userName:me?.name,role:me?.role,...extra});
}

// Attachments
function renderJobAttachments(j){
  const el=document.getElementById('job-attach-list');
  if(!el)return;
  const list=j?.attachments||[];
  el.innerHTML=list.length?list.map(a=>`<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.name||'file')}</a>`).join(''):'<span style="color:var(--text2);">No files</span>';
}
window.uploadJobAttachments=async function(){
  const id=document.getElementById('eid')?.value;
  const input=document.getElementById('job-attach-input');
  if(!id||!input?.files?.length||!USE_FIREBASE||!storage){showToastMsg('Save job first or use Firebase.');return;}
  const j=jobs.find(x=>x.id===id);if(!j)return;
  const files=[...input.files];
  const attachments=[...(j.attachments||[])];
  for(const f of files){
    if(f.size>8*1024*1024){showToastMsg('Max 8MB per file: '+f.name);continue;}
    const path=`jobs/${id}/${Date.now()}_${f.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
    const r=ref(storage,path);
    await uploadBytes(r,f);
    const url=await getDownloadURL(r);
    attachments.push({name:f.name,url,path,uploaded:Date.now(),by:me?.name});
  }
  await jUpdate(id,{attachments});
  input.value='';
  renderJobAttachments(jobs.find(x=>x.id===id));
  await logAudit('attachment_added',`${me.name} added ${files.length} file(s) to ${j.client} (#${j.jobNum})`,{jobId:id,client:j.client,jobNum:j.jobNum});
  showToastMsg('Files uploaded.');
};

// Calendar day modal
window.openCalDayModal=function(ds){
  const items=jobsForCalendarDay(ds);
  document.getElementById('cal-day-title').textContent=new Date(ds+'T12:00:00').toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const body=document.getElementById('cal-day-body');
  body.innerHTML=items.length?items.map(x=>{
    if(x.kind==='deadline')return`<div style="padding:0.35rem 0;border-bottom:1px solid var(--border);">⏰ Deadline: <strong>${escapeHtml(x.job.client)}</strong> #${escapeHtml(x.job.jobNum)} ${x.overdue?'<span style="color:var(--red);">overdue</span>':''}</div>`;
    return`<div style="padding:0.35rem 0;border-bottom:1px solid var(--border);">${x.kind}: <strong>${escapeHtml(x.job.client)}</strong> #${escapeHtml(x.job.jobNum)}</div>`;
  }).join(''):'<div class="empty">Nothing on this day.</div>';
  document.getElementById('cal-day-modal').classList.add('open');
};
window.closeCalDayModal=function(){document.getElementById('cal-day-modal')?.classList.remove('open');};

// SLA — computeSlaStats defined at module scope (above IIFE)

// Weekly CSV export
function buildWeeklyCsv(){
  const now=new Date(),ws=new Date(now);ws.setDate(now.getDate()-now.getDay());ws.setHours(0,0,0,0);
  const weekJobs=jobs.filter(j=>{
    const t=toMillis(j.created);
    return t>=ws.getTime();
  });
  const headers=['Job #','Client','Type','Priority','Status','Employee','Assigned By','Created','Deadline','Completed','On time'];
  const rows=weekJobs.map(j=>{
    const own=users.find(u=>u.id===j.owner)?.name||'';
    const on=j.completed&&j.deadline?(toMillis(j.completed)<=toMillis(j.deadline)?'Yes':'No'):'';
    return[j.jobNum,j.client,j.type,j.priority,j.status,own,j.assignedBy,fmt(j.created),j.deadline?fmt(j.deadline):'',j.completed?fmt(j.completed):'',on];
  });
  return [headers,...rows].map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n');
}
window.exportWeeklyReport=function(){
  const csv=buildWeeklyCsv();
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
  a.download=`RMI_weekly_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  if(isManager())logAudit('report_export',`${me.name} downloaded weekly CSV`);
  showToastMsg('Weekly report downloaded.');
};
function checkDeadlineReminders(){
  if(!me)return;
  const now=Date.now();
  const reminded=JSON.parse(localStorage.getItem('rmi_dl_reminded')||'{}');
  const myJobs=visibleJobs().filter(j=>j.deadline&&j.status!=='completed');
  for(const j of myJobs){
    const dl=toMillis(j.deadline);
    const diff=dl-now;
    if(diff<0||diff>24*60*60*1000)continue;
    const key=j.id+'_24h';
    if(reminded[key]&&now-reminded[key]<20*60*60*1000)continue;
    const h=Math.max(0,Math.round(diff/3600000));
    const label=`${j.client} (#${j.jobNum})`;
    const msg=h<=1?`⏰ Due in under 1 hour: ${label}`:`⏰ Due in ~${h}h: ${label}`;
    const emailBody=`A job deadline is approaching.\n\nJob: ${label}\nDue: ${h<=1?'under 1 hour':'~'+h+' hours'}`;
    pushNotif(j.owner,'Deadline Soon',msg);
    if(j.owner!==me.id&&canManageJob(j))pushNotif(me.id,'Deadline Soon',msg);
    // T4: email job owner
    if(emailPref('emailDeadline'))emailEventOwnerId('deadline',j.owner,`Deadline Soon: ${label}`,emailBody);
    // T5: email oversight (TL + managers/supervisors)
    if(emailPref('emailDeadline'))emailEventOversight('deadline',j,`Deadline Soon: ${label}`,emailBody);
    reminded[key]=now;
  }
  localStorage.setItem('rmi_dl_reminded',JSON.stringify(reminded));
}
function checkOverdueEmails(){
  if(!me)return;
  const now=Date.now();
  const notified=JSON.parse(localStorage.getItem('rmi_overdue_emailed')||'{}');
  const overdueJobs=visibleJobs().filter(j=>j.deadline&&j.status!=='completed'&&toMillis(j.deadline)<now);
  for(const j of overdueJobs){
    const key=j.id+'_overdue';
    if(notified[key]&&now-notified[key]<20*60*60*1000)continue;
    const label=`${j.client} (#${j.jobNum})`;
    const emailBody=`A job is overdue and has not been completed.\n\nJob: ${label}\nDeadline passed: ${new Date(toMillis(j.deadline)).toLocaleString()}`;
    // T6: email owner + oversight
    if(emailPref('emailOverdue')){emailEventOwnerId('overdue',j.owner,`Overdue Job: ${label}`,emailBody);emailEventOversight('overdue',j,`Overdue Job: ${label}`,emailBody);}
    notified[key]=now;
  }
  localStorage.setItem('rmi_overdue_emailed',JSON.stringify(notified));
}
function checkScheduledWeeklyExport(){
  if(!isManager())return;
  const now=new Date();
  if(now.getDay()!==6)return;
  const h=now.getHours(),m=now.getMinutes();
  if(h===14&&m>=15&&m<20){
    const key='rmi_week_export_'+now.toISOString().slice(0,10);
    if(!localStorage.getItem(key)){
      localStorage.setItem(key,'1');
      exportWeeklyReport();
      showToastMsg('Scheduled weekly report downloaded (Sat 2:15 PM).');
    }
  }
}

// Archive old completed jobs
window.archiveOldJobs=async function(){
  if(!isManager())return;
  const cut=Date.now()-ARCHIVE_AFTER_MS;
  const old=jobs.filter(j=>j.status==='completed'&&j.completed&&toMillis(j.completed)<cut&&!j.workflow); // keep workflow jobs (reopen-for-release)
  if(!old.length){showToastMsg('No jobs old enough to archive (90+ days).');return;}
  showConfirm('Archive old jobs',`Move ${old.length} completed job(s) to archive? They leave the active list.`,async()=>{
    for(const j of old){
      if(USE_FIREBASE&&archiveCol){
        await setDoc(doc(archiveCol,j.id),{...j,archivedAt:Date.now(),archivedBy:me.name});
        await jDelete(j.id);
      }else{
        j.archived=true;
      }
    }
    if(!USE_FIREBASE)localSave();
    await logAudit('jobs_archived',`${me.name} archived ${old.length} job(s)`);
    showToastMsg(`Archived ${old.length} job(s).`);
  },'Archive',false);
};

// Keyboard shortcuts
document.addEventListener('keydown',function(e){
  if(e.target.matches('input,textarea,select')&&!e.ctrlKey&&!e.metaKey)return;
  if(e.key==='/'&&me){e.preventDefault();document.getElementById('srch')?.focus();}
  if((e.key==='n'||e.key==='N')&&me&&!e.ctrlKey){e.preventDefault();openNewJob();}
  if(e.key==='Escape'){
    document.getElementById('notif-panel').style.display='none';
    document.querySelectorAll('.modal-overlay.open').forEach(m=>m.classList.remove('open'));
  }
});

// PWA
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('./sw.js').then(reg=>{
    reg.update();
    // when a new SW takes control, reload once to show fresh build
    let reloaded=false;
    navigator.serviceWorker.addEventListener('controllerchange',()=>{
      if(reloaded)return;reloaded=true;location.reload();
    });
  }).catch(()=>{});
}

// Wrap goHub for loading indicator
const _goHub=goHub;
goHub=function(hub,sub){
  const slow=['insights','team','account'];
  if(slow.includes(hub))showSectionLoading(true);
  _goHub(hub,sub);
  setTimeout(()=>showSectionLoading(false),hub==='insights'&&sub==='overview'?400:150);
};

// Patch loginAs
const _loginAs=loginAs;
loginAs=function(u){
  _loginAs(u);
  const sw=document.getElementById('jobs-scope-wrap');
  if(sw)sw.style.display=isManager()?'inline-flex':'none';
  const sortEl=document.getElementById('jobs-sort');
  if(sortEl)sortEl.value=userSettings.jobsSort||'created';
  const scopeEl=document.getElementById('jobs-scope');
  if(scopeEl)scopeEl.value=userSettings.managerJobsScope||'all';
  auditManagersOnLogin();
  updateEmailMasterBadge();
  openJobFromUrl();
  checkScheduledWeeklyExport();
  setInterval(checkScheduledWeeklyExport,60000);
  checkDeadlineReminders();
  setInterval(checkDeadlineReminders,30*60*1000);
  checkOverdueEmails();
  setInterval(checkOverdueEmails,60*60*1000);
  if(isManager()){
    const dash=document.getElementById('dashboard');
    if(dash&&!document.getElementById('archive-jobs-btn')){
      const b=document.createElement('button');
      b.id='archive-jobs-btn';b.className='bp sec';b.style.marginTop='0.5rem';
      b.textContent='📦 Archive jobs completed 90+ days ago';
      b.onclick=()=>archiveOldJobs();
      dash.querySelector('h2')?.after(b);
    }
    const bar=document.getElementById('reports-export-bar');
    if(bar)bar.style.display='flex';
  }
  // directors land on Dashboard (their default tab — My Jobs is hidden for them)
  if(amDirector())goHub('insights','overview');
};


// Patch filterActivityEntries for job #
const _filterActivityEntries=filterActivityEntries;
filterActivityEntries=function(all){
  const jobF=document.getElementById('alf-job')?.value?.trim();
  return _filterActivityEntries(all).filter(e=>{
    if(!jobF)return true;
    return String(e.jobNum||'').includes(jobF);
  });
};

// Patch saveEditUser audit
const _saveEditUser=window.saveEditUser;
window.saveEditUser=async function(){
  const id=document.getElementById('edit-user-id').value;
  const before=users.find(x=>x.id===id);
  await _saveEditUser();
  const after=users.find(x=>x.id===id);
  if(before&&after)await logAudit('user_edited',`${me.name} updated user ${after.name}`,{targetUserId:id});
};

// Patch editBroadcast
const _editBroadcast=window.editBroadcast;
window.editBroadcast=async function(id){
  await _editBroadcast(id);
  await logAudit('broadcast_edited',`${me.name} edited a broadcast`);
};

// Patch saveSettingsFromUI
const _saveSettingsFromUI=saveSettingsFromUI;
saveSettingsFromUI=function(){
  _saveSettingsFromUI();
  logAudit('settings_changed',`${me.name} updated preferences`);
};

// ── ANALYTICS — single-scroll report (replaces tab-based renderer) ───────────
let analyticsRange='month',analyticsEmp='',analyticsType='',analyticsBranch='';
function branchOf(ownerId){return users.find(u=>u.id===ownerId)?.branch||'';}
function analyticsRangeStart(range){
  const n=new Date();
  if(range==='today'){const d=new Date(n);d.setHours(0,0,0,0);return d.getTime();}
  if(range==='week'){const d=new Date(n);d.setDate(n.getDate()-n.getDay());d.setHours(0,0,0,0);return d.getTime();}
  if(range==='month')return new Date(n.getFullYear(),n.getMonth(),1).getTime();
  if(range==='quarter')return new Date(n.getFullYear(),Math.floor(n.getMonth()/3)*3,1).getTime();
  return 0;
}
function analyticsScope(){
  if(!me)return[];
  let base=visibleJobs();
  if(analyticsEmp)base=base.filter(j=>j.owner===analyticsEmp);
  if(analyticsType)base=base.filter(j=>(j.type||'Other')===analyticsType);
  if(analyticsBranch)base=base.filter(j=>branchOf(j.owner)===analyticsBranch);
  const start=analyticsRangeStart(analyticsRange);
  if(!start)return base.slice();
  return base.filter(j=>toMillis(j.created)>=start);
}
window.setAnalyticsType=function(t){analyticsType=t;renderAnalyticsContent();};
function anPopulateType(){
  const sel=document.getElementById('an-type');if(!sel)return;
  const cur=analyticsType;
  const types=[...new Set(visibleJobs().map(j=>j.type||'Other'))].sort();
  sel.innerHTML='<option value="">All Types</option>'+types.map(t=>`<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  sel.value=cur;
}
window.setAnalyticsRange=function(r,btn){
  analyticsRange=r;
  document.querySelectorAll('.an-range-btn').forEach(b=>b.classList.toggle('on',b.dataset.r===r));
  renderAnalyticsContent();
};
window.setAnalyticsEmp=function(e){analyticsEmp=e;renderAnalyticsContent();};
window.setAnalyticsBranch=function(b){analyticsBranch=b;renderAnalyticsContent();};
function anPopulateBranch(){
  const sel=document.getElementById('an-branch');if(!sel)return;
  const cur=analyticsBranch;
  // branches actually present among visible jobs' owners, ordered by the master list
  const present=new Set(visibleJobs().map(j=>branchOf(j.owner)).filter(Boolean));
  const opts=BRANCHES.filter(b=>present.has(b));
  sel.innerHTML='<option value="">All Branches</option>'+opts.map(b=>`<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
  sel.value=cur;
}

let analyticsView='report';
window.setAnalyticsView=function(v,btn){
  analyticsView=v;
  document.querySelectorAll('.an-tab-btn').forEach(b=>b.classList.toggle('on',b.dataset.view===v));
  // hide range/emp controls when teams tab active (uses all-time data)
  const rangeSel=document.getElementById('an-range');
  const empSel=document.getElementById('an-emp');
  const typeSel=document.getElementById('an-type');
  if(rangeSel)rangeSel.style.display=v==='teams'?'none':'';
  if(empSel)empSel.style.display=v==='teams'?'none':'';
  if(typeSel)typeSel.style.display=v==='teams'?'none':'';
  renderAnalyticsContent();
};
function anPopulateEmp(){
  const sel=document.getElementById('an-emp');if(!sel)return;
  if(!canSeeAllJobs()&&!isTeamLeader()){sel.style.display='none';return;}
  sel.style.display='';
  const cur=analyticsEmp;
  const pool=teamUsersForView().filter(u=>u.role!=='manager'||users.length<=2);
  sel.innerHTML='<option value="">All team</option>'+pool.map(u=>`<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
  sel.value=cur;
}
function anDonut(data,centerNum,centerLbl){
  const total=data.reduce((s,d)=>s+d.value,0)||1;
  let svg='',start=0;
  const nz=data.filter(d=>d.value>0);
  if(nz.length===1){svg=`<circle cx="70" cy="70" r="60" fill="${nz[0].color}"/>`;}
  else nz.forEach(d=>{const frac=d.value/total,ang=frac*2*Math.PI;const x1=70+60*Math.sin(start),y1=70-60*Math.cos(start);const x2=70+60*Math.sin(start+ang),y2=70-60*Math.cos(start+ang);const lg=ang>Math.PI?1:0;svg+=`<path d="M70,70 L${x1},${y1} A60,60 0 ${lg} 1 ${x2},${y2} Z" fill="${d.color}"><title>${escapeHtml(d.label)}: ${d.value}</title></path>`;start+=ang;});
  return`<div class="an-donut-wrap">
    <svg width="110" height="110" viewBox="0 0 140 140">${svg||'<circle cx="70" cy="70" r="60" fill="var(--card2)"/>'}<circle cx="70" cy="70" r="34" fill="var(--card)"/><text x="70" y="66" text-anchor="middle" class="an-donut-num">${centerNum}</text><text x="70" y="82" text-anchor="middle" class="an-donut-lbl">${centerLbl}</text></svg>
    <div class="an-legend">${data.map(d=>`<div class="an-legend-row"><span class="an-legend-dot" style="background:${d.color}"></span>${d.label}<span class="an-legend-val">${d.value}</span></div>`).join('')}</div>
  </div>`;
}
function anBars(rows,opts={}){
  if(!rows.length)return'<div class="empty" style="padding:1rem;">No data for this period.</div>';
  const max=opts.rate?100:Math.max(...rows.map(r=>r.value),1);
  return`<div class="an-bars">${rows.map(r=>{
    const w=opts.rate?r.value:Math.round(r.value/max*100);
    const lbl=opts.rate?`${r.value}%${r.sub?` <span class="an-bar-sub">${r.sub}</span>`:''}`:`${r.value}${r.sub?` <span class="an-bar-sub">${r.sub}</span>`:''}`;
    return`<div class="an-bar-row"><span class="an-bar-label" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</span><div class="an-bar-track"><div class="an-bar-fill" style="width:${Math.max(w,2)}%;background:${r.color||'var(--blue)'}"></div></div><span class="an-bar-val">${lbl}</span></div>`;
  }).join('')}</div>`;
}
function anTrendChart(points){
  if(!points.length)return'<div class="empty" style="padding:1rem;">No completions yet.</div>';
  const max=Math.max(...points.map(p=>p.value),1);
  const W=Math.max(points.length*60,240),H=120,pad=20;
  const stepX=points.length>1?(W-pad*2)/(points.length-1):0;
  const xy=points.map((p,i)=>({x:pad+i*stepX,y:H-pad-(p.value/max)*(H-pad*2),...p}));
  const line=xy.map((p,i)=>`${i?'L':'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area=`M${xy[0].x},${H-pad} `+xy.map(p=>`L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')+` L${xy[xy.length-1].x},${H-pad} Z`;
  return`<div class="an-trend"><svg viewBox="0 0 ${W} ${H+18}" width="100%" height="auto" preserveAspectRatio="xMidYMid meet" style="overflow:visible;display:block;max-height:${H+18}px;">
    <path d="${area}" fill="rgba(50,215,75,0.12)"/>
    <path d="${line}" fill="none" stroke="var(--green)" stroke-width="2" stroke-linejoin="round"/>
    ${xy.map(p=>`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="var(--green)"><title>${escapeHtml(p.label)}: ${p.value}</title></circle>`).join('')}
    ${xy.map(p=>`<text x="${p.x.toFixed(1)}" y="${H+10}" text-anchor="middle" class="an-trend-lbl">${escapeHtml(p.label)}</text>`).join('')}
  </svg></div>`;
}
function anDualLineChart(seriesA,seriesB,labelA,labelB,colorA,colorB){
  if(!seriesA.length)return'<div class="empty" style="padding:1rem;">No data.</div>';
  const allVals=[...seriesA,...seriesB].map(p=>p.value);
  const max=Math.max(...allVals,1);
  const W=Math.max(seriesA.length*60,240),H=120,pad=20;
  const stepX=seriesA.length>1?(W-pad*2)/(seriesA.length-1):0;
  const pts=s=>s.map((p,i)=>({x:pad+i*stepX,y:H-pad-(p.value/max)*(H-pad*2),...p}));
  const xyA=pts(seriesA),xyB=pts(seriesB);
  const mkLine=(xy,col)=>`<path d="${xy.map((p,i)=>`${i?'L':'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>`;
  const mkDots=(xy,col)=>xy.map(p=>`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="${col}"><title>${escapeHtml(p.label)}: ${p.value}</title></circle>`).join('');
  const legend=(col,lbl)=>`<span style="display:inline-flex;align-items:center;gap:4px;font-size:0.75rem;color:var(--text2);"><span style="display:inline-block;width:14px;height:2px;background:${col};border-radius:1px;"></span>${lbl}</span>`;
  return`<div class="an-trend">
    <div style="display:flex;gap:1rem;margin-bottom:0.4rem;">${legend(colorA,labelA)}${legend(colorB,labelB)}</div>
    <svg viewBox="0 0 ${W} ${H+18}" width="100%" height="auto" preserveAspectRatio="xMidYMid meet" style="overflow:visible;display:block;max-height:${H+18}px;">
      ${mkLine(xyA,colorA)}${mkLine(xyB,colorB)}
      ${mkDots(xyA,colorA)}${mkDots(xyB,colorB)}
      ${xyA.map(p=>`<text x="${p.x.toFixed(1)}" y="${H+10}" text-anchor="middle" class="an-trend-lbl">${escapeHtml(p.label)}</text>`).join('')}
    </svg>
  </div>`;
}
function renderTeamsAnalytics(el){
  if(!el)return;
  const tls=users.filter(u=>u.role==='team_leader');
  if(!tls.length){el.innerHTML='<div class="empty" style="padding:2rem;">No team leaders yet.</div>';return;}
  const now=new Date(),ws=new Date(now);ws.setDate(now.getDate()-now.getDay());ws.setHours(0,0,0,0);

  const teamData=tls.map(tl=>{
    const members=users.filter(u=>u.teamLeaderId===tl.id);
    const memberIds=new Set([tl.id,...members.map(u=>u.id)]);
    const tj=jobs.filter(j=>memberIds.has(j.owner)&&!j.workflow);
    const active=tj.filter(j=>j.status!=='completed').length;
    const overdue=tj.filter(j=>isOverdue(j)).length;
    const completed=tj.filter(j=>j.status==='completed').length;
    const doneWk=tj.filter(j=>j.completed&&new Date(j.completed)>=ws).length;
    const sla=computeSlaStats(tj);
    const doneWithTime=tj.filter(j=>j.completed&&j.created);
    const avgMs=doneWithTime.length?doneWithTime.reduce((s,j)=>s+(toMillis(j.completed)-toMillis(j.created)),0)/doneWithTime.length:0;
    return{tl,members,memberIds,tj,active,overdue,completed,doneWk,sla,avgMs};
  });

  const barRow=(name,val,max,col)=>`<div class="an-bar-row"><span class="an-bar-label">${escapeHtml(name)}</span><div class="an-bar-track"><div class="an-bar-fill" style="width:${Math.max(Math.round(val/max*100),val?2:0)}%;background:${col}"></div></div><span class="an-bar-val">${val}</span></div>`;
  const maxActive=Math.max(...teamData.map(t=>t.active),1);
  const maxDoneWk=Math.max(...teamData.map(t=>t.doneWk),1);
  const maxCompleted=Math.max(...teamData.map(t=>t.completed),1);

  // per-team member breakdown widgets
  const teamWidgets=teamData.map(t=>{
    const slaCol=t.sla.onTimePct>=70?'var(--green)':t.sla.onTimePct>=40?'var(--yellow)':'var(--red)';
    const memberHtml=t.members.map(m=>{
      const mj=jobs.filter(j=>j.owner===m.id&&!j.workflow);
      const ma=mj.filter(j=>j.status!=='completed').length;
      const mo=mj.filter(j=>isOverdue(j)).length;
      const md=mj.filter(j=>j.status==='completed').length;
      const col=mo>0?'var(--red)':ma>=5?'var(--red)':ma>=3?'var(--yellow)':'var(--green)';
      const pct=Math.min(100,Math.round(ma/6*100));
      return`<div class="tov-member-row" style="cursor:pointer;" onclick="setAnalyticsView('report',document.querySelector('.an-tab-btn[data-view=report]'));setTimeout(()=>setAnalyticsEmp('${m.id}'),120)" title="View ${escapeHtml(m.name)}'s report">
        <span class="tov-member-name">${escapeHtml(m.name)}</span>
        <div class="tov-load-bar"><div style="width:${Math.max(pct,ma?2:0)}%;background:${col};height:100%;border-radius:2px;"></div></div>
        <span class="tov-member-load" style="color:${col}">${ma} active${mo?` ⚠${mo}`:''} · ${md} done</span>
      </div>`;
    }).join('');
    return`<div class="an-widget">
      <div class="an-widget-hd" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;">
        <span>🧭 ${escapeHtml(t.tl.name)}<span class="tc-muted" style="font-size:0.75rem;margin-left:0.4rem;">${t.members.length} member${t.members.length!==1?'s':''}</span></span>
        <div style="display:flex;gap:0.6rem;font-size:0.78rem;flex-wrap:wrap;">
          <span style="color:var(--blue)">${t.active} active</span>
          ${t.overdue?`<span style="color:var(--red)">⚠${t.overdue} overdue</span>`:'<span style="color:var(--green)">✓ clear</span>'}
          <span style="color:var(--green)">${t.doneWk} done wk</span>
          <span style="color:${slaCol}">${t.sla.onTimePct}% on-time</span>
          ${t.avgMs?`<span style="color:var(--text2)">⏱${tdiff(0,t.avgMs)} avg</span>`:''}
        </div>
      </div>
      ${t.members.length
        ?`<div class="tov-members">${memberHtml}</div>`
        :'<div class="tov-no-members">No team members assigned.</div>'}
    </div>`;
  }).join('');

  el.innerHTML=`
    <div class="an-kpis">
      ${teamData.map(t=>`<div class="an-kpi">
        <div class="an-kpi-label">🧭 ${escapeHtml(t.tl.name)}</div>
        <div class="an-kpi-value" style="color:var(--blue)">${t.tj.length}</div>
        <div class="an-kpi-sub">${t.members.length} members · ${t.active} active${t.overdue?` · <span style="color:var(--red)">⚠${t.overdue}</span>`:''}</div>
      </div>`).join('')}
    </div>
    <div class="an-row-2">
      <div class="an-widget">
        <div class="an-widget-hd">Active Jobs per Team</div>
        <div class="an-bars">${teamData.map(t=>barRow(t.tl.name,t.active,maxActive,t.overdue>0?'var(--red)':t.active>=5?'var(--yellow)':'var(--blue)')).join('')}</div>
      </div>
      <div class="an-widget">
        <div class="an-widget-hd">Overdue per Team</div>
        <div class="an-bars">${teamData.map(t=>barRow(t.tl.name,t.overdue,Math.max(...teamData.map(x=>x.overdue),1),t.overdue>0?'var(--red)':'var(--green)')).join('')}</div>
      </div>
    </div>
    <div class="an-row-2">
      <div class="an-widget">
        <div class="an-widget-hd">Done This Week per Team</div>
        <div class="an-bars">${teamData.map(t=>barRow(t.tl.name,t.doneWk,maxDoneWk,'var(--green)')).join('')}</div>
      </div>
      <div class="an-widget">
        <div class="an-widget-hd">On-Time Rate per Team</div>
        <div class="an-bars">${teamData.map(t=>{
          const col=t.sla.onTimePct>=70?'var(--green)':t.sla.onTimePct>=40?'var(--yellow)':'var(--red)';
          return`<div class="an-bar-row"><span class="an-bar-label">${escapeHtml(t.tl.name)}</span><div class="an-bar-track"><div class="an-bar-fill" style="width:${Math.max(t.sla.onTimePct,t.sla.doneWithDl?2:0)}%;background:${col}"></div></div><span class="an-bar-val">${t.sla.onTimePct}%</span></div>`;
        }).join('')}</div>
      </div>
    </div>
    <div class="an-widget">
      <div class="an-widget-hd">Total Completed per Team</div>
      <div class="an-bars">${teamData.map(t=>barRow(t.tl.name,t.completed,maxCompleted,'var(--purple)')).join('')}</div>
    </div>
    <div class="an-widget-hd" style="margin-top:1.25rem;margin-bottom:0.5rem;">👤 Member Breakdown <span class="an-hd-note">click member → their individual report</span></div>
    ${teamWidgets}`;
}

// ── NEW ANALYTICS HELPERS ─────────────────────────────────────────────────────
function anSpeedVsTeam(myId,allVisJobs){
  const myDone=allVisJobs.filter(j=>j.owner===myId&&j.completed&&j.created);
  const types=[...new Set(myDone.map(j=>j.type||'Other'))];
  if(!types.length)return'';
  const rows=types.map(t=>{
    const myT=myDone.filter(j=>(j.type||'Other')===t);
    const allT=allVisJobs.filter(j=>(j.type||'Other')===t&&j.completed&&j.created);
    if(!myT.length||!allT.length)return null;
    const myAvg=myT.reduce((a,j)=>a+(toMillis(j.completed)-toMillis(j.created)),0)/myT.length;
    const teamAvg=allT.reduce((a,j)=>a+(toMillis(j.completed)-toMillis(j.created)),0)/allT.length;
    const faster=myAvg<=teamAvg;
    return{label:t,myAvg,teamAvg,faster,n:myT.length};
  }).filter(Boolean);
  if(!rows.length)return'';
  return`<div class="an-widget"><div class="an-widget-hd">My Speed vs Team Average <span class="an-hd-note">per job type</span></div><div class="an-turn">${rows.map(r=>`<div class="an-turn-row"><span class="an-turn-type">${escapeHtml(r.label)}</span><span class="an-turn-time" style="color:${r.faster?'var(--green)':'var(--red)'}">${tdiff(0,r.myAvg)} ${r.faster?'↑':'↓'}</span><span class="an-turn-n" style="color:var(--text3)">team: ${tdiff(0,r.teamAvg)}</span></div>`).join('')}</div></div>`;
}
function anMyRankCard(myId,allVisJobs){
  const emps=users.filter(u=>u.role==='employee'||u.role==='team_leader');
  if(emps.length<2)return'';
  const ranked=emps.map(u=>({id:u.id,done:allVisJobs.filter(j=>j.owner===u.id&&j.status==='completed').length})).sort((a,b)=>b.done-a.done);
  const myRank=ranked.findIndex(r=>r.id===myId)+1;
  const myDone=ranked.find(r=>r.id===myId)?.done||0;
  const color=myRank===1?'var(--green)':myRank<=Math.ceil(ranked.length/3)?'var(--blue)':'var(--text)';
  return`<div class="an-widget"><div class="an-widget-hd">My Team Rank <span class="an-hd-note">by jobs completed (all time, anonymous)</span></div><div style="text-align:center;padding:0.75rem 0;"><div style="font-size:2.5rem;font-weight:700;font-family:var(--mono);color:${color}">#${myRank}</div><div style="color:var(--text2);font-size:0.82rem;margin-top:0.25rem;">of ${ranked.length} team members</div><div style="color:var(--text3);font-size:0.78rem;margin-top:0.2rem;">${myDone} jobs completed</div></div></div>`;
}
function anTeamHealthWidget(emps,allVisJobs){
  const rows=emps.map(u=>{
    const ej=allVisJobs.filter(j=>j.owner===u.id);
    const active=ej.filter(j=>j.status!=='completed').length;
    const done=ej.filter(j=>j.status==='completed').length;
    const od=ej.filter(j=>isOverdue(j)).length;
    const compRate=ej.length?Math.round(done/ej.length*100):0;
    return{name:u.name,od,active,compRate,color:od>0?'var(--red)':active>5?'var(--yellow)':'var(--green)'};
  }).filter(r=>r.active>0||r.compRate>0).sort((a,b)=>b.od-a.od||a.compRate-b.compRate);
  if(!rows.length)return'';
  return`<div class="an-widget"><div class="an-widget-hd">Team Member Health <span class="an-hd-note">overdue · active · completion %</span></div><div class="an-turn">${rows.map(r=>`<div class="an-turn-row"><span class="an-turn-type">${escapeHtml(r.name)}</span><span style="color:${r.color};font-family:var(--mono);font-size:0.8rem;font-weight:600;">${r.od} overdue</span><span class="an-turn-n">${r.active} active · ${r.compRate}% done</span></div>`).join('')}</div></div>`;
}
function anActiveVsPausedWidget(emps,allVisJobs){
  const rows=emps.map(u=>{
    const ej=allVisJobs.filter(j=>j.owner===u.id&&(j.durationActiveMs||j.durationPausedMs));
    if(!ej.length)return null;
    const active=ej.reduce((a,j)=>a+(j.durationActiveMs||0),0);
    const paused=ej.reduce((a,j)=>a+(j.durationPausedMs||0),0);
    const total=active+paused||1;
    return{name:u.name,activePct:Math.round(active/total*100)};
  }).filter(Boolean).sort((a,b)=>b.activePct-a.activePct);
  if(!rows.length)return'';
  return`<div class="an-widget"><div class="an-widget-hd">Active vs Paused Time <span class="an-hd-note">per employee</span></div><div class="an-bars">${rows.map(r=>`<div class="an-bar-row"><span class="an-bar-label">${escapeHtml(r.name)}</span><div class="an-bar-track" style="height:14px;display:flex;overflow:hidden;border-radius:var(--radius-pill);"><div style="width:${r.activePct}%;background:var(--green);height:100%;"></div><div style="width:${100-r.activePct}%;background:var(--orange);opacity:0.6;height:100%;"></div></div><span class="an-bar-val" style="font-size:0.72rem;">${r.activePct}% active</span></div>`).join('')}</div><div style="display:flex;gap:1rem;margin-top:0.6rem;font-size:0.72rem;color:var(--text3);"><span><span style="color:var(--green)">■</span> Active</span><span><span style="color:var(--orange)">■</span> Paused</span></div></div>`;
}
function anOverdueTrendWidget(allVisJobs,buckets){
  const pts=buckets.map(b=>{
    const inPeriod=allVisJobs.filter(j=>toMillis(j.created)>=b.start&&toMillis(j.created)<b.end);
    const od=inPeriod.filter(j=>isOverdue(j)||(j.deadline&&j.completed&&toMillis(j.completed)>toMillis(j.deadline))).length;
    return{label:b.label,value:inPeriod.length?Math.round(od/inPeriod.length*100):0};
  });
  return`<div class="an-widget"><div class="an-widget-hd">Overdue Rate Trend <span class="an-hd-note">% jobs overdue per period</span></div>${anTrendChart(pts)}</div>`;
}
function anCrossTeamTypeWidget(){
  const tls=users.filter(u=>u.role==='team_leader');
  if(tls.length<2)return'';
  const allVJ=visibleJobs();
  const types=[...new Set(allVJ.map(j=>j.type||'Other'))].slice(0,6);
  const colors=['var(--blue)','var(--green)','var(--purple)','var(--orange)','var(--red)','var(--yellow)'];
  const rows=types.map(t=>{
    const typeJobs=allVJ.filter(j=>(j.type||'Other')===t);
    return{type:t,teams:tls.map(tl=>{
      const teamIds=users.filter(u=>u.teamLeaderId===tl.id).map(u=>u.id);
      const tj=typeJobs.filter(j=>teamIds.includes(j.owner)||j.owner===tl.id);
      const done=tj.filter(j=>j.status==='completed').length;
      return{name:tl.name,total:tj.length,done,rate:tj.length?Math.round(done/tj.length*100):0};
    })};
  }).filter(r=>r.teams.some(t=>t.total>0));
  if(!rows.length)return'';
  return`<div class="an-widget"><div class="an-widget-hd">Cross-Team Comparison by Type <span class="an-hd-note">completion rate %</span></div>${rows.map(r=>`<div style="margin-bottom:0.85rem;"><div style="font-size:0.78rem;font-weight:600;color:var(--text2);margin-bottom:0.35rem;">${escapeHtml(r.type)}</div><div class="an-bars">${r.teams.filter(t=>t.total>0).map((t,i)=>`<div class="an-bar-row"><span class="an-bar-label">${escapeHtml(t.name)}</span><div class="an-bar-track"><div class="an-bar-fill" style="width:${t.rate}%;background:${colors[i%colors.length]}"></div></div><span class="an-bar-val">${t.rate}% <span class="an-bar-sub">${t.done}/${t.total}</span></span></div>`).join('')}</div></div>`).join('')}</div>`;
}

// Branch-level analytics (RMI - Syria / UAE / India). Visible to oversight roles.
// Always compares ALL branches (ignores the single-branch filter dropdown) over
// the selected date range; jobs roll up to their owner's branch.
function anBranchSection(){
  const branches=BRANCHES.filter(b=>users.some(u=>u.branch===b));
  if(branches.length<1)return'';
  const start=analyticsRangeStart(analyticsRange);
  const inRange=j=>!start||toMillis(j.created)>=start;
  const all=visibleJobs();
  const colors=['var(--blue)','var(--green)','var(--orange)','var(--purple)','var(--yellow)'];
  const stat={};
  branches.forEach((b,i)=>{
    const bj=all.filter(j=>branchOf(j.owner)===b);
    const withDl=bj.filter(j=>j.completed&&j.deadline);
    const onTime=withDl.filter(j=>toMillis(j.completed)<=toMillis(j.deadline)).length;
    const compDur=bj.filter(j=>j.completed&&j.created);
    const avgMs=compDur.length?compDur.reduce((a,j)=>a+(toMillis(j.completed)-toMillis(j.created)),0)/compDur.length:0;
    stat[b]={i,
      active:bj.filter(j=>j.status!=='completed').length,
      done:bj.filter(j=>j.completed&&inRange(j)).length,
      overdue:bj.filter(j=>isOverdue(j)).length,
      onTimePct:withDl.length?Math.round(onTime/withDl.length*100):0,
      onTimeN:withDl.length, avgMs};
  });
  const col=b=>colors[stat[b].i%colors.length];
  const activeRows=branches.map(b=>({label:b,value:stat[b].active,color:col(b)}));
  const doneRows=branches.map(b=>({label:b,value:stat[b].done,color:'var(--green)'}));
  const odRows=branches.map(b=>({label:b,value:stat[b].overdue,color:'var(--red)'}));
  const otRows=branches.map(b=>({label:b,value:stat[b].onTimePct,sub:`${stat[b].onTimeN} done`,color:stat[b].onTimePct>=70?'var(--green)':stat[b].onTimePct>=40?'var(--yellow)':'var(--red)'}));
  const turnRows=branches.filter(b=>stat[b].avgMs>0).sort((a,b)=>stat[a].avgMs-stat[b].avgMs)
    .map(b=>({label:b,value:Math.round(stat[b].avgMs/3600000),sub:tdiff(0,stat[b].avgMs),color:'var(--blue)'}));
  return`<div class="an-row-4">
      <div class="an-widget"><div class="an-widget-hd">Active / Branch</div>${anBars(activeRows)}</div>
      <div class="an-widget"><div class="an-widget-hd">Completed / Branch <span class="an-hd-note">in range</span></div>${anBars(doneRows)}</div>
      <div class="an-widget"><div class="an-widget-hd">Overdue / Branch</div>${anBars(odRows)}</div>
      <div class="an-widget"><div class="an-widget-hd">On-Time Rate / Branch</div>${anBars(otRows,{rate:true})}</div>
    </div>
    ${turnRows.length?`<div class="an-widget"><div class="an-widget-hd">Avg Turnaround per Branch <span class="an-hd-note">created → completed (hours, fastest first)</span></div>${anBars(turnRows)}</div>`:''}`;

}

// ── MY SPACE ───────────────────────────────────────────────────────────────
function _mysJobRow(j,showOwner){
  const od=isOverdue(j);
  const owner=showOwner?(users.find(u=>u.id===j.owner)||{}).name||'':'';
  return`<div class="mys-job-row" onclick="editJob('${j.id}')">
    <span class="mys-jnum">#${escapeHtml(j.jobNum||'')}</span>
    <span class="mys-jclient">${escapeHtml(j.client||'')}${owner?` <span class="tc-muted" style="font-size:0.7rem;">· ${escapeHtml(owner)}</span>`:''}</span>
    <span class="mys-jstatus${od?' tc-red':''}">${od?'⚠ overdue':j.status}</span>
  </div>`;
}
function _mysW(hd,body){return`<div class="an-widget"><div class="an-widget-hd">${hd}</div>${body}</div>`;}
function _mysEmpty(msg){return`<div class="empty" style="padding:0.6rem 0;font-size:0.8rem;">${msg}</div>`;}

const MYS_WIDGETS={
  // ── ANALYTICS ──────────────────────────────────────────────────────────
  'an-kpis':{label:'📊 Key Metrics',group:'Analytics',size:'full',
    roles:r=>r!=='sales_operation',
    render(){
      const scope=analyticsScope(),total=scope.length;
      const completed=scope.filter(j=>j.status==='completed').length;
      const overdue=scope.filter(j=>isOverdue(j)).length;
      const compRate=total?Math.round(completed/total*100):0;
      const doneWithTime=scope.filter(j=>j.completed&&j.created);
      const avgMs=doneWithTime.length?doneWithTime.reduce((a,j)=>a+(toMillis(j.completed)-toMillis(j.created)),0)/doneWithTime.length:0;
      const sla=computeSlaStats(scope);
      const pending=scope.filter(j=>j.status==='pending').length,ongoing=scope.filter(j=>j.status==='ongoing').length;
      const kpis=[
        {label:'Total Jobs',value:total,color:'var(--blue)',sub:`${pending} pending · ${ongoing} ongoing`},
        {label:'Completion Rate',value:compRate+'%',color:compRate>=70?'var(--green)':compRate>=40?'var(--yellow)':'var(--red)',sub:`${completed} of ${total}`},
        {label:'Avg Completion',value:doneWithTime.length?tdiff(0,avgMs):'—',color:'var(--text)',sub:`${doneWithTime.length} tracked`},
        {label:'On-Time Rate',value:sla.onTimePct+'%',color:sla.onTimePct>=70?'var(--green)':'var(--yellow)',sub:`${overdue} overdue open`},
      ];
      return`<div class="an-kpis">${kpis.map(k=>`<div class="an-kpi"><div class="an-kpi-label">${k.label}</div><div class="an-kpi-value" style="color:${k.color}">${k.value}</div><div class="an-kpi-sub">${k.sub}</div></div>`).join('')}</div>`;
    }},
  'an-status':{label:'🔵 Status Breakdown',group:'Analytics',size:'half',
    roles:r=>r!=='sales_operation',
    render(){
      const scope=analyticsScope(),total=scope.length;
      const pending=scope.filter(j=>j.status==='pending').length,ongoing=scope.filter(j=>j.status==='ongoing').length,paused=scope.filter(j=>j.status==='paused').length,completed=scope.filter(j=>j.status==='completed').length;
      return _mysW('Status Breakdown',anDonut([{label:'Pending',value:pending,color:'#ffd60a'},{label:'Ongoing',value:ongoing,color:'#0a84ff'},{label:'Paused',value:paused,color:'#6e6e73'},{label:'Completed',value:completed,color:'#32d74b'}],total,'jobs'));
    }},
  'an-trend':{label:'📈 Completion Trend',group:'Analytics',size:'half',
    roles:r=>r!=='sales_operation',
    render(){
      const ref=new Date();const buckets=[];
      for(let i=5;i>=0;i--){const d=new Date(ref.getFullYear(),ref.getMonth()-i,1);buckets.push({label:d.toLocaleString('en-GB',{month:'short'}),start:d.getTime(),end:new Date(ref.getFullYear(),ref.getMonth()-i+1,1).getTime()});}
      const scope=analyticsScope();
      const pts=buckets.map(b=>({label:b.label,value:scope.filter(j=>j.completed&&toMillis(j.completed)>=b.start&&toMillis(j.completed)<b.end).length}));
      return _mysW('Completion Trend <span class="an-hd-note">6 months</span>',anTrendChart(pts));
    }},
  'an-turnaround':{label:'⏱ Turnaround by Type',group:'Analytics',size:'half',
    roles:r=>r!=='sales_operation',
    render(){
      const scope=analyticsScope();
      const rows=Object.keys(scope.reduce((m,j)=>{m[j.type||'Other']=1;return m;},{})).map(t=>{const done=scope.filter(j=>j.type===t&&j.completed&&j.created);if(!done.length)return null;const avg=done.reduce((a,j)=>a+(toMillis(j.completed)-toMillis(j.created)),0)/done.length;return{type:t,avg,n:done.length};}).filter(Boolean).sort((a,b)=>a.avg-b.avg);
      return _mysW('Turnaround by Type <span class="an-hd-note">avg</span>',rows.length?`<div class="an-turn">${rows.map(r=>`<div class="an-turn-row"><span class="an-turn-type">${escapeHtml(r.type)}</span><span class="an-turn-time">${tdiff(0,r.avg)}</span><span class="an-turn-n">${r.n}j</span></div>`).join('')}</div>`:_mysEmpty('No completed jobs'));
    }},
  'an-jobs-type':{label:'🗂 Jobs by Type',group:'Analytics',size:'half',
    roles:r=>r!=='sales_operation',
    render(){
      const scope=analyticsScope();const typeMap={};scope.forEach(j=>{const t=j.type||'Other';typeMap[t]=(typeMap[t]||0)+1;});
      const entries=Object.entries(typeMap).sort((a,b)=>b[1]-a[1]);const total=scope.length;
      if(!entries.length)return _mysW('Jobs by Type',_mysEmpty('No jobs yet'));
      const colors=['#0a84ff','#32d74b','#ffd60a','#ff453a','#bf5af2','#ff9f0a','#5ac8fa','#30d158'];
      return _mysW('Jobs by Type',anDonut(entries.map(([t,v],i)=>({label:t,value:v,color:colors[i%colors.length]})),total,'jobs'));
    }},
  'an-my-rank':{label:'🏅 My Rank & Speed',group:'Analytics',size:'half',
    roles:r=>r==='employee',
    render(){return(anMyRankCard(me.id,visibleJobs())||'')+(anSpeedVsTeam(me.id,visibleJobs())||'');}},
  'an-team-health':{label:'👥 Team Health',group:'Analytics',size:'half',
    roles:r=>['team_leader','supervisor','manager'].includes(r)||amDirector(),
    render(){
      const emps=teamUsersForView().filter(u=>u.role!=='manager');
      return anTeamHealthWidget(emps,visibleJobs())||_mysW('Team Health',_mysEmpty('No team data'));
    }},
  'an-overdue-trend':{label:'⚠️ Overdue Rate Trend',group:'Analytics',size:'half',
    roles:r=>['team_leader','supervisor','manager'].includes(r)||amDirector(),
    render(){
      const ref=new Date();const buckets=[];
      for(let i=5;i>=0;i--){const d=new Date(ref.getFullYear(),ref.getMonth()-i,1);buckets.push({label:d.toLocaleString('en-GB',{month:'short'}),start:d.getTime(),end:new Date(ref.getFullYear(),ref.getMonth()-i+1,1).getTime()});}
      return anOverdueTrendWidget(visibleJobs(),buckets);
    }},
  'an-perf':{label:'🏆 Performance Leaderboard',group:'Analytics',size:'full',
    roles:r=>['team_leader','supervisor','manager'].includes(r)||amDirector(),
    render(){
      const emps=teamUsersForView().filter(u=>u.role!=='manager');
      const cards=emps.map(u=>{
        const ej=visibleJobs().filter(j=>j.owner===u.id);
        const done=ej.filter(j=>j.completed&&j.created);
        const avg=done.length?done.reduce((a,j)=>a+(toMillis(j.completed)-toMillis(j.created)),0)/done.length:0;
        const od=ej.filter(j=>isOverdue(j)).length;
        const ws=new Date();ws.setDate(ws.getDate()-ws.getDay());ws.setHours(0,0,0,0);
        const tw=ej.filter(j=>j.completed&&toMillis(j.completed)>=ws.getTime()).length;
        return{u,done:ej.filter(j=>j.status==='completed').length,active:ej.filter(j=>j.status!=='completed').length,od,tw,avg:done.length?tdiff(0,avg):'—',total:ej.length};
      }).filter(c=>c.total>0).sort((a,b)=>b.done-a.done);
      if(!cards.length)return _mysW('Performance Leaderboard',_mysEmpty('No team data yet'));
      return _mysW('Performance Leaderboard',`<div class="an-perf-grid">${cards.map(c=>`<div class="an-perf-card"><div class="an-perf-name">${c.u.role==='team_leader'?'🧭':'👤'} ${escapeHtml(c.u.name)}</div><div class="an-perf-stats"><div><span class="ap-n">${c.done}</span><span class="ap-l">done</span></div><div><span class="ap-n">${c.active}</span><span class="ap-l">active</span></div><div><span class="ap-n">${c.tw}</span><span class="ap-l">wk</span></div><div><span class="ap-n ${c.od?'tc-red':''}">${c.od}</span><span class="ap-l">OD</span></div></div><div class="an-perf-avg">⏱ ${c.avg}</div></div>`).join('')}</div>`);
    }},
  'an-branch':{label:'🏢 Branch Analytics',group:'Analytics',size:'full',
    roles:r=>['supervisor','manager'].includes(r)||amDirector(),
    render(){return anBranchSection()||_mysW('Branch Analytics',_mysEmpty('No branch data'));}},
  // ── JOBS ──────────────────────────────────────────────────────────────────
  'my-active':{label:'📋 My Active Jobs',group:'Jobs',size:'half',
    roles:r=>true,
    render(){
      const jj=jobs.filter(j=>j.owner===me.id&&j.status!=='completed'&&!j.workflow).sort((a,b)=>toMillis(a.created)-toMillis(b.created));
      return _mysW(`My Active Jobs <span class="an-hd-note">${jj.length}</span>`,jj.length?`<div class="mys-job-list">${jj.slice(0,12).map(j=>_mysJobRow(j)).join('')}${jj.length>12?`<div class="mys-more">+${jj.length-12} more — <a href="#" onclick="event.preventDefault();goHub('work','jobs')">view all</a></div>`:''}</div>`:_mysEmpty('No active jobs 🎉'));
    }},
  'my-overdue':{label:'⚠️ My Overdue Jobs',group:'Jobs',size:'half',
    roles:r=>true,
    render(){
      const od=jobs.filter(j=>j.owner===me.id&&isOverdue(j));
      return _mysW(`<span style="color:var(--red)">⚠ Overdue</span> <span class="an-hd-note tc-muted">${od.length}</span>`,od.length?`<div class="mys-job-list">${od.map(j=>_mysJobRow(j)).join('')}</div>`:_mysEmpty('None overdue 🎉'));
    }},
  'my-paused':{label:'⏸ My Paused Jobs',group:'Jobs',size:'half',
    roles:r=>true,
    render(){
      const jj=jobs.filter(j=>j.owner===me.id&&j.status==='paused');
      return _mysW(`Paused Jobs <span class="an-hd-note">${jj.length}</span>`,jj.length?`<div class="mys-job-list">${jj.map(j=>_mysJobRow(j)).join('')}</div>`:_mysEmpty('No paused jobs'));
    }},
  'my-deadlines':{label:'⏰ Upcoming Deadlines',group:'Jobs',size:'half',
    roles:r=>true,
    render(){
      const now=Date.now();
      const teamIds=isTeamLeader()?new Set([me.id,...(myTeamIds()||[])]):new Set([me.id]);
      const soon=jobs.filter(j=>j.deadline&&j.status!=='completed'&&teamIds.has(j.owner)&&toMillis(j.deadline)>now&&toMillis(j.deadline)<now+7*864e5).sort((a,b)=>toMillis(a.deadline)-toMillis(b.deadline));
      return _mysW('Deadlines <span class="an-hd-note">next 7 days</span>',soon.length?`<div class="mys-job-list">${soon.map(j=>{const diff=toMillis(j.deadline)-now;const col=diff<864e5?'var(--red)':diff<3*864e5?'var(--yellow)':'var(--green)';return`<div class="mys-job-row" onclick="editJob('${j.id}')"><span class="mys-jnum">#${escapeHtml(j.jobNum||'')}</span><span class="mys-jclient">${escapeHtml(j.client||'')}</span><span class="mys-jstatus" style="color:${col}">${tdiff(0,diff)}</span></div>`;}).join('')}</div>`:_mysEmpty('No deadlines this week'));
    }},
  'my-recently-done':{label:'✅ My Recent Completions',group:'Jobs',size:'half',
    roles:r=>true,
    render(){
      const jj=jobs.filter(j=>j.owner===me.id&&j.status==='completed'&&j.completed).sort((a,b)=>toMillis(b.completed)-toMillis(a.completed)).slice(0,8);
      return _mysW('Recently Completed',jj.length?`<div class="mys-job-list">${jj.map(j=>`<div class="mys-job-row" onclick="editJob('${j.id}')"><span class="mys-jnum">#${escapeHtml(j.jobNum||'')}</span><span class="mys-jclient">${escapeHtml(j.client||'')}</span><span class="mys-jstatus tc-green">✓ ${timeAgo(j.completed)}</span></div>`).join('')}</div>`:_mysEmpty('No completed jobs yet'));
    }},
  'all-pending':{label:'🕐 All Pending Jobs',group:'Jobs',size:'half',
    roles:r=>['team_leader','supervisor','manager'].includes(r)||amDirector(),
    render(){
      const jj=visibleJobs().filter(j=>j.status==='pending').sort((a,b)=>toMillis(a.created)-toMillis(b.created));
      return _mysW(`All Pending <span class="an-hd-note">${jj.length}</span>`,jj.length?`<div class="mys-job-list">${jj.slice(0,12).map(j=>_mysJobRow(j,true)).join('')}${jj.length>12?`<div class="mys-more">+${jj.length-12} more</div>`:''}</div>`:_mysEmpty('No pending jobs'));
    }},
  'all-active':{label:'🔄 All Active Jobs',group:'Jobs',size:'half',
    roles:r=>['team_leader','supervisor','manager'].includes(r)||amDirector(),
    render(){
      const jj=visibleJobs().filter(j=>j.status==='ongoing').sort((a,b)=>toMillis(a.created)-toMillis(b.created));
      return _mysW(`All Active <span class="an-hd-note">${jj.length}</span>`,jj.length?`<div class="mys-job-list">${jj.slice(0,12).map(j=>_mysJobRow(j,true)).join('')}${jj.length>12?`<div class="mys-more">+${jj.length-12} more</div>`:''}</div>`:_mysEmpty('No active jobs'));
    }},
  'all-overdue':{label:'🔴 All Overdue Jobs',group:'Jobs',size:'half',
    roles:r=>['team_leader','supervisor','manager'].includes(r)||amDirector(),
    render(){
      const jj=visibleJobs().filter(j=>isOverdue(j)).sort((a,b)=>toMillis(a.created)-toMillis(b.created));
      return _mysW(`<span style="color:var(--red)">All Overdue</span> <span class="an-hd-note tc-muted">${jj.length}</span>`,jj.length?`<div class="mys-job-list">${jj.slice(0,12).map(j=>_mysJobRow(j,true)).join('')}${jj.length>12?`<div class="mys-more">+${jj.length-12} more</div>`:''}</div>`:_mysEmpty('No overdue jobs 🎉'));
    }},
  'all-recent-done':{label:'✅ Recently Completed (All)',group:'Jobs',size:'half',
    roles:r=>['team_leader','supervisor','manager'].includes(r)||amDirector(),
    render(){
      const jj=visibleJobs().filter(j=>j.status==='completed'&&j.completed).sort((a,b)=>toMillis(b.completed)-toMillis(a.completed)).slice(0,10);
      return _mysW('Recently Completed',jj.length?`<div class="mys-job-list">${jj.map(j=>`<div class="mys-job-row" onclick="editJob('${j.id}')"><span class="mys-jnum">#${escapeHtml(j.jobNum||'')}</span><span class="mys-jclient">${escapeHtml(j.client||'')}</span><span class="mys-jstatus tc-green">✓ ${timeAgo(j.completed)}</span></div>`).join('')}</div>`:_mysEmpty('No completed jobs yet'));
    }},
  // ── WORKFLOW ──────────────────────────────────────────────────────────────
  'wf-my-queue':{label:'⚡ WF My Queue',group:'Workflow',size:'half',
    roles:r=>r==='team_leader',
    render(){
      const wj=jobs.filter(j=>j.workflow&&j.tlId===me.id&&j.status!=='completed');
      const byStage=wj.reduce((m,j)=>{const s=j.stage||'intake';m[s]=(m[s]||0)+1;return m;},{});
      return _mysW(`WF My Queue <span class="an-hd-note">${wj.length}</span>`,wj.length?`<div class="mys-job-list">${wj.slice(0,10).map(j=>`<div class="mys-job-row" onclick="goHub('work','job-basket')"><span class="mys-jnum">#${escapeHtml(j.jobNum||'')}</span><span class="mys-jclient">${escapeHtml(j.client||'')}</span><span class="mys-jstatus">${escapeHtml(j.stage||'intake')}</span></div>`).join('')}</div>`:_mysEmpty('Queue empty'));
    }},
  'wf-pending-review':{label:'👁 WF Pending Review',group:'Workflow',size:'half',
    roles:r=>r==='team_leader',
    render(){
      const reviewStages=['tl_sample_review','tl_sd_review','tl_jobcard_review'];
      const jj=jobs.filter(j=>j.workflow&&reviewStages.includes(j.stage));
      return _mysW(`Pending Review <span class="an-hd-note">${jj.length}</span>`,jj.length?`<div class="mys-job-list">${jj.slice(0,10).map(j=>`<div class="mys-job-row" onclick="goHub('work','job-basket')"><span class="mys-jnum">#${escapeHtml(j.jobNum||'')}</span><span class="mys-jclient">${escapeHtml(j.client||'')}</span><span class="mys-jstatus tc-yellow">${escapeHtml(j.stage||'')}</span></div>`).join('')}</div>`:_mysEmpty('Nothing to review'));
    }},
  'wf-my-tasks':{label:'📌 WF My Tasks',group:'Workflow',size:'half',
    roles:r=>r==='employee',
    render(){
      const jj=jobs.filter(j=>j.workflow&&j.owner===me.id&&j.status!=='completed');
      return _mysW(`WF My Tasks <span class="an-hd-note">${jj.length}</span>`,jj.length?`<div class="mys-job-list">${jj.slice(0,10).map(j=>`<div class="mys-job-row" onclick="goHub('work','job-basket')"><span class="mys-jnum">#${escapeHtml(j.jobNum||'')}</span><span class="mys-jclient">${escapeHtml(j.client||'')}</span><span class="mys-jstatus">${escapeHtml(j.stage||'')}</span></div>`).join('')}</div>`:_mysEmpty('No WF tasks'));
    }},
  'wf-overview':{label:'🧺 WF Pipeline Overview',group:'Workflow',size:'full',
    roles:r=>['team_leader','supervisor','manager'].includes(r)||amDirector(),
    render(){
      const stageOrder=['intake','drafting','tl_sample_review','detailing','tl_sd_review','client_wait','jobcard','tl_jobcard_review','completed','release'];
      const stageLabels={intake:'Intake',drafting:'Drafting',tl_sample_review:'TL Review',detailing:'Detailing',tl_sd_review:'TL S/D',client_wait:'Client Wait',jobcard:'Job Card',tl_jobcard_review:'TL JC',completed:'Done',release:'Released'};
      const wj=jobs.filter(j=>j.workflow);
      const counts=stageOrder.reduce((m,s)=>{m[s]=wj.filter(j=>j.stage===s).length;return m;},{});
      const max=Math.max(1,...Object.values(counts));
      return _mysW(`WF Pipeline <span class="an-hd-note">${wj.length} total</span>`,`<div class="mys-wf-overview">${stageOrder.map(s=>`<div class="mys-wf-stage"><div class="mys-wf-bar-wrap"><div class="mys-wf-bar" style="height:${Math.round(counts[s]/max*48)+4}px;background:${counts[s]?'var(--blue)':'var(--border)'};"></div></div><div class="mys-wf-count">${counts[s]}</div><div class="mys-wf-lbl">${stageLabels[s]||s}</div></div>`).join('')}</div>`);
    }},
  'wf-submitted':{label:'📤 My WF Submissions',group:'Workflow',size:'half',
    roles:r=>r==='sales_operation',
    render(){
      const jj=jobs.filter(j=>j.workflow&&j.submittedBy===me.id).sort((a,b)=>toMillis(b.created)-toMillis(a.created));
      return _mysW(`My Submissions <span class="an-hd-note">${jj.length}</span>`,jj.length?`<div class="mys-job-list">${jj.slice(0,10).map(j=>`<div class="mys-job-row" onclick="goHub('work','job-basket')"><span class="mys-jnum">#${escapeHtml(j.jobNum||'')}</span><span class="mys-jclient">${escapeHtml(j.client||'')}</span><span class="mys-jstatus">${escapeHtml(j.stage||'intake')}</span></div>`).join('')}</div>`:_mysEmpty('No submissions yet'));
    }},
  // ── TEAM ──────────────────────────────────────────────────────────────────
  'team-workload':{label:'⚖️ Team Workload',group:'Team',size:'half',
    roles:r=>['team_leader','supervisor','manager'].includes(r)||amDirector(),
    render(){
      const emps=teamUsersForView().filter(u=>u.role!=='manager');
      const rows=emps.map(u=>{const jj=visibleJobs().filter(j=>j.owner===u.id&&j.status!=='completed');const od=jj.filter(j=>isOverdue(j)).length;return{u,active:jj.length,od};}).sort((a,b)=>b.active-a.active);
      return _mysW('Team Workload',rows.length?`<div class="mys-team-list">${rows.map(r=>`<div class="mys-team-row"><span class="mys-team-name">${escapeHtml(r.u.name)}</span><span class="mys-team-bar-wrap"><span class="mys-team-bar" style="width:${Math.min(100,r.active*8)}%;background:${r.od?'var(--red)':'var(--blue)'};"></span></span><span class="mys-team-count">${r.active}${r.od?` <span class="tc-red">(${r.od}OD)</span>`:''}</span></div>`).join('')}</div>`:_mysEmpty('No team data'));
    }},
  'team-members':{label:'👤 Team Members',group:'Team',size:'half',
    roles:r=>['team_leader','supervisor','manager'].includes(r)||amDirector(),
    render(){
      const emps=teamUsersForView();
      return _mysW(`Team <span class="an-hd-note">${emps.length}</span>`,emps.length?`<div class="mys-team-list">${emps.map(u=>{const jj=visibleJobs().filter(j=>j.owner===u.id&&j.status!=='completed');return`<div class="mys-team-row"><span class="mys-team-name">${escapeHtml(u.name)}</span><span class="mys-team-role">${u.role||''}</span><span class="mys-team-count">${jj.length} active</span></div>`;}).join('')}</div>`:_mysEmpty('No team members'));
    }},
  // ── NOTIFICATIONS ─────────────────────────────────────────────────────────
  'my-notifs':{label:'🔔 My Notifications',group:'Notifications',size:'half',
    roles:r=>true,
    render(){
      const nn=[...notifications].filter(n=>n.userId===me.id).sort((a,b)=>toMillis(b.ts||b.created)-toMillis(a.ts||a.created)).slice(0,10);
      const unread=nn.filter(n=>!n.read).length;
      return _mysW(`Notifications${unread?` <span class="an-hd-note" style="background:var(--red);color:#fff;border-radius:999px;padding:0 0.4rem;">${unread}</span>`:''}`,nn.length?`<div class="mys-activity-list">${nn.map(n=>`<div class="mys-act-row${!n.read?' mys-notif-unread':''}"><span class="mys-act-type">${escapeHtml(n.message||n.body||'Notification')}</span><span class="mys-act-time">${timeAgo(n.ts||n.created||0)}</span></div>`).join('')}</div>`:_mysEmpty('No notifications'));
    }},
  // ── EXTENSIONS ────────────────────────────────────────────────────────────
  'ext-pending':{label:'📎 Pending Extensions',group:'Extensions',size:'half',
    roles:r=>['team_leader','supervisor','manager'].includes(r)||amDirector(),
    render(){
      const pp=extRequests.filter(r=>r.status==='pending');
      return _mysW(`Extension Requests <span class="an-hd-note">${pp.length}</span>`,pp.length?`<div class="mys-job-list">${pp.map(r=>{const j=jobs.find(j=>j.id===r.jobId)||{};return`<div class="mys-job-row" onclick="goHub('work','jobs')"><span class="mys-jnum">#${escapeHtml(j.jobNum||r.jobId||'')}</span><span class="mys-jclient">${escapeHtml(j.client||r.reason||'')}</span><span class="mys-jstatus tc-yellow">pending</span></div>`;}).join('')}</div>`:_mysEmpty('No pending requests'));
    }},
  'my-ext-requests':{label:'📎 My Extension Requests',group:'Extensions',size:'half',
    roles:r=>true,
    render(){
      const pp=extRequests.filter(r=>r.requestedBy===me.id).sort((a,b)=>toMillis(b.created)-toMillis(a.created));
      return _mysW(`My Ext. Requests <span class="an-hd-note">${pp.length}</span>`,pp.length?`<div class="mys-job-list">${pp.slice(0,8).map(r=>{const j=jobs.find(j=>j.id===r.jobId)||{};const col=r.status==='approved'?'tc-green':r.status==='rejected'?'tc-red':'tc-yellow';return`<div class="mys-job-row"><span class="mys-jnum">#${escapeHtml(j.jobNum||'')}</span><span class="mys-jclient">${escapeHtml(j.client||r.reason||'')}</span><span class="mys-jstatus ${col}">${r.status}</span></div>`;}).join('')}</div>`:_mysEmpty('No requests made'));
    }},
  // ── ACTIVITY & MESSAGES ───────────────────────────────────────────────────
  'my-activity':{label:'📜 My Recent Activity',group:'Activity',size:'half',
    roles:r=>true,
    render(){
      const logs=[...activityLogs].filter(e=>e.userId===me.id||e.actorId===me.id).slice(-15).reverse();
      return _mysW('My Recent Activity',logs.length?`<div class="mys-activity-list">${logs.map(e=>`<div class="mys-act-row"><span class="mys-act-type">${escapeHtml(ACTIVITY_TYPE_LABELS[e.type]||e.type||'Activity')}</span><span class="mys-act-time">${timeAgo(e.ts||e.timestamp||0)}</span></div>`).join('')}</div>`:_mysEmpty('No recent activity'));
    }},
  'team-activity':{label:'📜 Team Activity',group:'Activity',size:'half',
    roles:r=>['team_leader','supervisor','manager'].includes(r)||amDirector(),
    render(){
      const teamIds=new Set([me.id,...(myTeamIds()||[])]);
      const logs=[...activityLogs].filter(e=>teamIds.has(e.userId)||teamIds.has(e.actorId)).slice(-20).reverse();
      return _mysW('Team Activity',logs.length?`<div class="mys-activity-list">${logs.map(e=>`<div class="mys-act-row"><span class="mys-act-type">${escapeHtml((e.userName||'').split(' ')[0]||'')} — ${escapeHtml(ACTIVITY_TYPE_LABELS[e.type]||e.type||'')}</span><span class="mys-act-time">${timeAgo(e.ts||e.timestamp||0)}</span></div>`).join('')}</div>`:_mysEmpty('No team activity'));
    }},
  'my-broadcasts':{label:'📢 Recent Messages',group:'Messages',size:'half',
    roles:r=>true,
    render(){
      const recent=[...broadcasts].sort((a,b)=>toMillis(b.created)-toMillis(a.created)).slice(0,6);
      return _mysW('Recent Messages',recent.length?`<div class="mys-activity-list">${recent.map(b=>`<div class="mys-act-row" onclick="goHub('messages','broadcast')"><span class="mys-act-type">${escapeHtml((b.subject||b.title||'Message').slice(0,50))}</span><span class="mys-act-time">${timeAgo(b.created||0)}</span></div>`).join('')}</div>`:_mysEmpty('No messages yet'));
    }},
  // ── QUICK LINKS ───────────────────────────────────────────────────────────
  'quick-links':{label:'🔗 Quick Links',group:'Quick Links',size:'half',
    roles:r=>true,
    render(){
      const r=me.role;
      const links=[
        {label:'New Job',icon:'➕',onclick:`goHub('work','jobs')`,show:r!=='sales_operation'},
        {label:'Job Basket',icon:'🧺',onclick:`goHub('work','job-basket')`,show:true},
        {label:'Messages',icon:'📢',onclick:`goHub('messages','broadcast')`,show:true},
        {label:'Analytics',icon:'📊',onclick:`goHub('insights','reports')`,show:r!=='sales_operation'},
        {label:'Activity Log',icon:'📜',onclick:`goHub('insights','activity')`,show:true},
        {label:'Users',icon:'👥',onclick:`goHub('admin','users')`,show:['supervisor','manager'].includes(r)||amDirector()},
      ].filter(l=>l.show);
      return _mysW('Quick Links',`<div class="mys-quick-links">${links.map(l=>`<button class="mys-ql-btn" onclick="${l.onclick}">${l.icon}<span>${l.label}</span></button>`).join('')}</div>`);
    }},
};

function getMysDefaults(){
  if(!me)return[];
  const r=me.role;
  if(r==='sales_operation')return['quick-links','my-active','my-overdue','my-deadlines','wf-submitted','my-broadcasts'];
  if(r==='employee')return['quick-links','an-kpis','an-status','an-trend','an-my-rank','my-active','my-overdue','my-deadlines','wf-my-tasks'];
  if(r==='team_leader')return['quick-links','an-kpis','an-team-health','an-overdue-trend','an-perf','my-deadlines','all-overdue','wf-my-queue','wf-pending-review'];
  if(r==='supervisor'||r==='manager'||amDirector())return['quick-links','an-kpis','an-branch','an-perf','all-overdue','all-pending','wf-overview','my-activity'];
  return['quick-links','my-active','my-overdue','my-deadlines'];
}
function loadMysConfig(){
  if(!me)return[];
  try{const s=localStorage.getItem('mys-cfg-'+me.id);return s?JSON.parse(s):getMysDefaults();}
  catch(e){return getMysDefaults();}
}
function saveMysConfig(cfg){if(me)localStorage.setItem('mys-cfg-'+me.id,JSON.stringify(cfg));}
window.addMysWidget=function(key){
  const cfg=loadMysConfig();
  if(!cfg.includes(key)){cfg.push(key);saveMysConfig(cfg);}
  renderMySpace();
};
window.removeMysWidget=function(key){
  saveMysConfig(loadMysConfig().filter(k=>k!==key));
  renderMySpace();
};
let _mysEditMode=false;
window.toggleMysEdit=function(){
  _mysEditMode=!_mysEditMode;
  const grid=document.getElementById('mys-grid');
  const picker=document.getElementById('mys-picker');
  const btn=document.getElementById('mys-edit-btn');
  if(grid)grid.classList.toggle('mys-edit-mode',_mysEditMode);
  if(picker)picker.style.display=_mysEditMode?'block':'none';
  if(btn){btn.textContent=_mysEditMode?'✓ Done':'✏️ Customize';btn.classList.toggle('active',_mysEditMode);}
};
let _mysSortable=null;
function _mysInitDrag(grid){
  if(!grid||!window.Sortable)return;
  if(_mysSortable){try{_mysSortable.destroy();}catch(e){}}
  _mysSortable=new window.Sortable(grid,{
    animation:180,
    ghostClass:'mys-drag-ghost',
    chosenClass:'mys-drag-chosen',
    dragClass:'mys-drag-active',
    forceFallback:false,
    onEnd(){
      const order=[...grid.children].map(el=>el.dataset.key).filter(Boolean);
      const cfg=loadMysConfig();
      const hidden=cfg.filter(k=>!order.includes(k));
      saveMysConfig([...order,...hidden]);
    }
  });
}
function renderMySpace(){
  const el=document.getElementById('mys-content');if(!el||!me)return;
  const cfg=loadMysConfig();
  const widgetsHtml=cfg.map(key=>{
    const def=MYS_WIDGETS[key];
    if(!def||!def.roles(me.role))return'';
    let body='';
    try{body=def.render()||'';}catch(e){body=_mysW('Widget Error',`<div style="color:var(--red);font-size:0.78rem;">${e.message||'render failed'}</div>`);}
    return`<div class="mys-widget${def.size==='full'?' full':''}" data-key="${key}"><button class="mys-remove-btn" onclick="removeMysWidget('${key}')" title="Remove">✕</button>${body}</div>`;
  }).join('');
  const groups={};
  Object.entries(MYS_WIDGETS).forEach(([key,def])=>{
    if(!def.roles(me.role))return;
    if(!groups[def.group])groups[def.group]=[];
    groups[def.group].push({key,def});
  });
  const pickerHtml=Object.entries(groups).map(([grp,items])=>`<div><div class="mys-pick-grp-lbl">${grp}</div><div class="mys-pick-items">${items.map(({key,def})=>`<button class="mys-pick-btn"${cfg.includes(key)?' disabled':''} onclick="addMysWidget('${key}')">${def.label}</button>`).join('')}</div></div>`).join('');
  el.innerHTML=`
    <div class="mys-grid${_mysEditMode?' mys-edit-mode':''}" id="mys-grid">
      ${widgetsHtml||'<div style="grid-column:1/-1;padding:2.5rem;text-align:center;color:var(--text3);">Click ✏️ Customize to add widgets.</div>'}
    </div>
    <div class="mys-picker" id="mys-picker" style="display:${_mysEditMode?'block':'none'};">
      <div class="mys-picker-hd"><span>➕ Add Widget</span><button class="bp sec" style="font-size:0.75rem;padding:0.28rem 0.6rem;" onclick="toggleMysEdit()">✓ Done</button></div>
      <div class="mys-picker-groups">${pickerHtml}</div>
    </div>`;
  const btn=document.getElementById('mys-edit-btn');
  if(btn){btn.textContent=_mysEditMode?'✓ Done':'✏️ Customize';btn.classList.toggle('active',_mysEditMode);}
  bindChartInteractions(el);
  _mysInitDrag(document.getElementById('mys-grid'));
}
window.renderMySpace=renderMySpace;

renderAnalyticsContent=function(){
  const el=document.getElementById('analytics-content');if(!el||!me)return;
  if(me.role==='sales_operation')return;
  loadAnVis();
  anPopulateEmp();anPopulateType();anPopulateBranch();
  const isMgr=isLead()||amDirector();
  const now=Date.now();
  const scope=analyticsScope();
  const total=scope.length;
  const pending=scope.filter(j=>j.status==='pending').length;
  const ongoing=scope.filter(j=>j.status==='ongoing').length;
  const paused=scope.filter(j=>j.status==='paused').length;
  const completed=scope.filter(j=>j.status==='completed').length;
  const overdue=scope.filter(j=>isOverdue(j)).length;
  const compRate=total?Math.round(completed/total*100):0;
  const doneWithTime=scope.filter(j=>j.completed&&j.created);
  const avgMs=doneWithTime.length?doneWithTime.reduce((a,j)=>a+(toMillis(j.completed)-toMillis(j.created)),0)/doneWithTime.length:0;
  const sla=computeSlaStats(scope);

  // KPI row
  const kpis=[
    {label:'Total Jobs',value:total,color:'var(--blue)',sub:`${pending} pending · ${ongoing} ongoing`},
    {label:'Completion Rate',value:compRate+'%',color:compRate>=70?'var(--green)':compRate>=40?'var(--yellow)':'var(--red)',sub:`${completed} of ${total}`},
    {label:'Avg Completion',value:doneWithTime.length?tdiff(0,avgMs):'—',color:'var(--text)',sub:`${doneWithTime.length} tracked`},
    {label:'On-Time Rate',value:sla.onTimePct+'%',color:sla.onTimePct>=70?'var(--green)':'var(--yellow)',sub:`${overdue} overdue open`},
  ];

  // status donut
  const statusData=[
    {label:'Pending',value:pending,color:'#ffd60a'},
    {label:'Ongoing',value:ongoing,color:'#0a84ff'},
    {label:'Paused',value:paused,color:'#6e6e73'},
    {label:'Completed',value:completed,color:'#32d74b'},
  ];

  // by type
  const typeMap={};
  scope.forEach(j=>{const t=j.type||'Other';typeMap[t]=(typeMap[t]||0)+1;});
  const typeRows=Object.entries(typeMap).map(([t,c],i)=>({label:t,value:c,color:TYPE_CHART_COLORS[i%TYPE_CHART_COLORS.length],sub:total?Math.round(c/total*100)+'%':''})).sort((a,b)=>b.value-a.value);

  // priority completion rate
  const priRows=['High','Medium','Low'].map(p=>{
    const all=scope.filter(j=>j.priority===p);const d=all.filter(j=>j.status==='completed').length;
    return{label:p,value:all.length?Math.round(d/all.length*100):0,sub:`${d}/${all.length}`,color:PRIORITY_CHART_COLORS[p]};
  }).filter(r=>r.sub!=='0/0');

  // completion trend (last 6 periods by week or month)
  const byMonth=analyticsRange==='week'||analyticsRange==='month';
  const buckets=[];
  const ref=new Date();
  if(byMonth){
    for(let i=5;i>=0;i--){const d=new Date(ref.getFullYear(),ref.getMonth()-i,1);buckets.push({label:d.toLocaleString('en-GB',{month:'short'}),start:d.getTime(),end:new Date(ref.getFullYear(),ref.getMonth()-i+1,1).getTime()});}
  }else{
    for(let i=5;i>=0;i--){const d=new Date(ref);d.setDate(ref.getDate()-i*7);d.setHours(0,0,0,0);const wk=new Date(d);wk.setDate(d.getDate()-d.getDay());buckets.push({label:wk.toLocaleString('en-GB',{day:'numeric',month:'short'}),start:wk.getTime(),end:wk.getTime()+7*864e5});}
  }
  const scopeForTrend=analyticsEmp?visibleJobs().filter(j=>j.owner===analyticsEmp):visibleJobs();
  const trendPts=buckets.map(b=>({label:b.label,value:scopeForTrend.filter(j=>j.completed&&toMillis(j.completed)>=b.start&&toMillis(j.completed)<b.end).length}));
  const createdPts=buckets.map(b=>({label:b.label,value:scopeForTrend.filter(j=>toMillis(j.created)>=b.start&&toMillis(j.created)<b.end).length}));

  // job age buckets (active jobs only)
  const nowMs=Date.now();
  const activeJobs=scope.filter(j=>j.status!=='completed');
  const ageGroups=[
    {label:'0–3 days',min:0,max:3*864e5,color:'var(--green)'},
    {label:'3–7 days',min:3*864e5,max:7*864e5,color:'var(--yellow)'},
    {label:'1–2 weeks',min:7*864e5,max:14*864e5,color:'var(--orange)'},
    {label:'2+ weeks',min:14*864e5,max:Infinity,color:'var(--red)'},
  ];
  const ageRows=ageGroups.map(g=>{const c=activeJobs.filter(j=>{const age=nowMs-toMillis(j.created);return age>=g.min&&age<g.max;}).length;return{label:g.label,value:c,color:g.color};});

  // oldest active jobs list
  const oldestActive=[...activeJobs].sort((a,b)=>toMillis(a.created)-toMillis(b.created)).slice(0,8);

  // priority vs actual urgency (overdue rate per priority)
  const priUrgency=['High','Medium','Low'].map(p=>{
    const pj=scope.filter(j=>j.priority===p&&j.status!=='completed');
    const od=pj.filter(j=>isOverdue(j)).length;
    return{label:p,overdueCount:od,active:pj.length,pct:pj.length?Math.round(od/pj.length*100):0,color:PRIORITY_CHART_COLORS[p]};
  }).filter(r=>r.active>0);

  // deadline extension rate
  const jobsWithDl=scope.filter(j=>j.deadline);
  const jobIdsWithExt=new Set(extRequests.filter(r=>scope.some(j=>j.id===r.jobId)).map(r=>r.jobId));
  const extRate=jobsWithDl.length?Math.round(jobIdsWithExt.size/jobsWithDl.length*100):0;
  const extApproved=extRequests.filter(r=>r.status==='approved'&&scope.some(j=>j.id===r.jobId)).length;
  const extRejected=extRequests.filter(r=>r.status==='rejected'&&scope.some(j=>j.id===r.jobId)).length;
  const extPending=extRequests.filter(r=>r.status==='pending'&&scope.some(j=>j.id===r.jobId)).length;

  // peak workload days
  const dayNames=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const createdByDay=Array(7).fill(0),completedByDay=Array(7).fill(0);
  scope.forEach(j=>{
    if(j.created)createdByDay[new Date(toMillis(j.created)).getDay()]++;
    if(j.completed)completedByDay[new Date(toMillis(j.completed)).getDay()]++;
  });
  const maxDay=Math.max(...createdByDay,...completedByDay,1);

  // reassignment frequency from activity logs
  const reassignMap={};
  activityLogs.filter(e=>e.type==='reassigned'&&e.jobId).forEach(e=>{reassignMap[e.jobId]=(reassignMap[e.jobId]||0)+1;});
  const topReassigned=Object.entries(reassignMap).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([id,cnt])=>{const j=jobs.find(x=>x.id===id);return{label:j?`${j.client} #${j.jobNum}`:id,value:cnt,color:'var(--purple)'};});

  // throughput by employee (leads with team view)
  let throughputHtml='';
  if(isMgr&&!analyticsEmp){
    const emps=teamUsersForView().filter(u=>u.role!=='manager');
    const rows=emps.map(u=>{
      const ej=scope.filter(j=>j.owner===u.id);
      return{label:u.name,value:ej.length,sub:`${ej.filter(j=>j.status==='completed').length} done`,color:'var(--purple)'};
    }).filter(r=>r.value>0).sort((a,b)=>b.value-a.value);
    if(rows.length)throughputHtml=`<div class="an-widget"><div class="an-widget-hd">Throughput by Employee</div>${anBars(rows)}</div>`;
  }

  // turnaround by type (avg completion time)
  const turnRows=Object.keys(typeMap).map(t=>{
    const done=scope.filter(j=>j.type===t&&j.completed&&j.created);
    if(!done.length)return null;
    const avg=done.reduce((a,j)=>a+(toMillis(j.completed)-toMillis(j.created)),0)/done.length;
    return{type:t,avg,n:done.length};
  }).filter(Boolean).sort((a,b)=>a.avg-b.avg);
  /* note: renderAnalyticsContent is assigned (not declared) so it overrides the module-level binding */

  // performance leaderboard (leads, team-scoped)
  let perfHtml='';
  if(isMgr&&!analyticsEmp){
    const emps=teamUsersForView().filter(u=>u.role!=='manager');
    const cards=emps.map(u=>{
      const ej=visibleJobs().filter(j=>j.owner===u.id);
      const done=ej.filter(j=>j.completed&&j.created);
      const avg=done.length?done.reduce((a,j)=>a+(toMillis(j.completed)-toMillis(j.created)),0)/done.length:0;
      const od=ej.filter(j=>isOverdue(j)).length;
      const ws=new Date();ws.setDate(ws.getDate()-ws.getDay());ws.setHours(0,0,0,0);
      const tw=ej.filter(j=>j.completed&&toMillis(j.completed)>=ws.getTime()).length;
      return{u,total:ej.length,done:ej.filter(j=>j.status==='completed').length,active:ej.filter(j=>j.status!=='completed').length,od,tw,avg:done.length?tdiff(0,avg):'—'};
    }).filter(c=>c.total>0).sort((a,b)=>b.done-a.done);
    if(cards.length)perfHtml=`<div class="an-widget"><div class="an-widget-hd">Performance Leaderboard</div>
      <div class="an-perf-grid">${cards.map(c=>`<div class="an-perf-card">
        <div class="an-perf-name">${c.u.role==='supervisor'?'🔰':c.u.role==='team_leader'?'🧭':'👤'} ${escapeHtml(c.u.name)}</div>
        <div class="an-perf-stats">
          <div><span class="ap-n">${c.done}</span><span class="ap-l">done</span></div>
          <div><span class="ap-n">${c.active}</span><span class="ap-l">active</span></div>
          <div><span class="ap-n">${c.tw}</span><span class="ap-l">this wk</span></div>
          <div><span class="ap-n ${c.od?'tc-red':''}">${c.od}</span><span class="ap-l">overdue</span></div>
        </div>
        <div class="an-perf-avg">⏱ avg ${c.avg}</div>
      </div>`).join('')}</div></div>`;
  }

  // shared reusable blocks
  const dayBarRow=(name,cre,com,max)=>`<div class="an-day-row"><span class="an-day-lbl">${name}</span><div class="an-day-bars"><div class="an-day-bar" style="width:${Math.max(Math.round(cre/max*100),cre?2:0)}%;background:var(--blue);" title="Created: ${cre}"></div><div class="an-day-bar" style="width:${Math.max(Math.round(com/max*100),com?2:0)}%;background:var(--green);" title="Completed: ${com}"></div></div><span class="an-day-vals">${cre} / ${com}</span></div>`;
  const kpiHtml=`<div class="an-kpis">${kpis.map(k=>`<div class="an-kpi"><div class="an-kpi-label">${k.label}</div><div class="an-kpi-value" style="color:${k.color}">${k.value}</div><div class="an-kpi-sub">${k.sub}</div></div>`).join('')}</div>`;
  const turnHtml=turnRows.length?`<div class="an-widget"><div class="an-widget-hd">Turnaround by Type <span class="an-hd-note">avg time to complete</span></div><div class="an-turn">${turnRows.map(r=>`<div class="an-turn-row"><span class="an-turn-type">${escapeHtml(r.type)}</span><span class="an-turn-time">${tdiff(0,r.avg)}</span><span class="an-turn-n">${r.n} job${r.n>1?'s':''}</span></div>`).join('')}</div></div>`:'';
  // compact bar-only cards for 3-col row
  const priUrgencyCard=`<div class="an-widget"><div class="an-widget-hd">Priority vs Urgency <span class="an-hd-note">% overdue</span></div>${priUrgency.map(p=>`<div class="an-bar-row"><span class="an-bar-label">${p.label}</span><div class="an-bar-track"><div class="an-bar-fill" style="width:${Math.max(p.pct,p.overdueCount?2:0)}%;background:${p.color}"></div></div><span class="an-bar-val">${p.pct}% <span class="tc-muted">${p.overdueCount}/${p.active}</span></span></div>`).join('')}${priUrgency.every(p=>p.pct===0)?'<div class="empty" style="padding:0.35rem 0;">No overdue jobs 🎉</div>':''}</div>`;
  const extCard=`<div class="an-widget"><div class="an-widget-hd">Extension Rate</div><div style="display:flex;align-items:baseline;gap:0.5rem;margin-bottom:0.45rem;"><span style="font-size:1.6rem;font-weight:700;font-family:var(--mono);color:${extRate>=30?'var(--red)':extRate>=15?'var(--yellow)':'var(--green)'}">${extRate}%</span><span style="font-size:0.72rem;color:var(--text3);">${jobIdsWithExt.size} of ${jobsWithDl.length} jobs</span></div>${extApproved+extRejected+extPending>0?anBars([{label:'Approved',value:extApproved,color:'var(--green)'},{label:'Rejected',value:extRejected,color:'var(--red)'},{label:'Pending',value:extPending,color:'var(--yellow)'}].filter(r=>r.value>0)):''}</div>`;
  const peakCard=`<div class="an-widget"><div class="an-widget-hd">Peak Workload <span class="an-hd-note"><span style="color:var(--blue)">■ cre</span> <span style="color:var(--green)">■ done</span></span></div><div class="an-day-chart">${dayNames.map((d,i)=>dayBarRow(d,createdByDay[i],completedByDay[i],maxDay)).join('')}</div></div>`;
  const jobAnalysisHtml=`
    <div class="an-row-2">
      <div class="an-widget"><div class="an-widget-hd">Created vs Completed <span class="an-hd-note">last 6 ${byMonth?'months':'weeks'}</span></div>${anDualLineChart(createdPts,trendPts,'Created','Completed','var(--blue)','var(--green)')}</div>
      ${priRows.length?`<div class="an-widget"><div class="an-widget-hd">Completion Rate by Priority</div>${anBars(priRows,{rate:true})}</div>`:''}
    </div>
    <div class="an-row-3">
      ${priUrgencyCard}${extCard}${peakCard}
    </div>
    <div class="an-row-2">
      <div class="an-widget"><div class="an-widget-hd">Job Age <span class="an-hd-note">active jobs by how long open</span></div>${anBars(ageRows)}${oldestActive.length?`<div class="an-hd-note" style="margin-top:0.55rem;margin-bottom:0.3rem;">Oldest active jobs</div>${oldestActive.map(j=>{const age=nowMs-toMillis(j.created);const col=age>14*864e5?'var(--red)':age>7*864e5?'var(--orange)':'var(--text2)';const own=users.find(u=>u.id===j.owner)?.name||'?';return`<div class="an-turn-row"><span class="an-turn-type">${escapeHtml(j.client)} <span class="tc-muted">#${escapeHtml(j.jobNum)}</span></span><span class="an-turn-time" style="color:${col}">${tdiff(0,age)}</span><span class="an-turn-n">${escapeHtml(own)}</span></div>`;}).join('')}`:''}
      </div>
      ${turnHtml}
    </div>
    ${topReassigned.length?`<div class="an-widget"><div class="an-widget-hd">Most Reassigned Jobs <span class="an-hd-note">times reassigned</span></div>${anBars(topReassigned)}</div>`:''}
  `;

  const isEmp=me.role==='employee';
  const isTL_=isTeamLeader();
  const isSup=me.role==='supervisor';
  const leadEmps=teamUsersForView().filter(u=>u.role!=='manager');
  const crossTeam=anCrossTeamTypeWidget();
  const overdueTrend=anOverdueTrendWidget(visibleJobs(),buckets);
  const hasWf=jobs.some(j=>j.workflow);

  const set=html=>{el.innerHTML=`<div class="an-sub-body">${html}</div>`;bindChartInteractions(el);applyAnVis(el);};
  const sec=lbl=>`<div class="an-section-lbl">${lbl}</div>`;
  const wrap=(key,html)=>`<div class="an-section-wrap" data-vis="${key}">${html}</div>`;

  // ── EMPLOYEE ──────────────────────────────────────────────────────────────
  if(isEmp){
    set(`${wrap('kpis',kpiHtml)}
      ${wrap('status_trend',`<div class="an-row-2">
        <div class="an-widget"><div class="an-widget-hd">Status Breakdown</div>${anDonut(statusData,total,'jobs')}</div>
        <div class="an-widget"><div class="an-widget-hd">Completion Trend <span class="an-hd-note">last 6 ${byMonth?'months':'weeks'}</span></div>${anTrendChart(trendPts)}</div>
      </div>`)}
      ${wrap('my_rank',anMyRankCard(me.id,visibleJobs())+anSpeedVsTeam(me.id,visibleJobs()))}
      ${wrap('jobs',sec('📋 Job Analysis')+jobAnalysisHtml)}`);
    return;
  }

  // ── TEAM LEADER ───────────────────────────────────────────────────────────
  if(isTL_){
    set(`${wrap('kpis',kpiHtml)}
      ${wrap('status_trend',`<div class="an-row-2">
        <div class="an-widget"><div class="an-widget-hd">Status Breakdown</div>${anDonut(statusData,total,'jobs')}</div>
        ${throughputHtml}
      </div>`)}
      ${wrap('team',sec('👥 Team')+`<div class="an-row-2">${anTeamHealthWidget(leadEmps,visibleJobs())}${anActiveVsPausedWidget(leadEmps,visibleJobs())}</div>`+anOverdueTrendWidget(visibleJobs(),buckets))}
      ${wrap('perf',perfHtml)}
      ${wrap('jobs',sec('📋 Job Analysis')+jobAnalysisHtml)}
      ${hasWf?wrap('workflow',sec('🧺 Workflow')+'<div id="an-wf-inline"></div>'):''}`);
    if(hasWf){const wfEl=el.querySelector('#an-wf-inline');if(wfEl)wfEl.innerHTML=wfAnalyticsSection()||'<div class="empty" style="padding:1rem;">No workflow data yet.</div>';}
    return;
  }

  // ── SUPERVISOR ────────────────────────────────────────────────────────────
  if(isSup){
    set(`${wrap('kpis',kpiHtml)}
      ${wrap('status_trend',`<div class="an-row-2">
        <div class="an-widget"><div class="an-widget-hd">Status Breakdown</div>${anDonut(statusData,total,'jobs')}</div>
        ${throughputHtml}
      </div>`)}
      ${wrap('team',sec('👥 Team')+`<div class="an-row-2">${anTeamHealthWidget(leadEmps,visibleJobs())}${anActiveVsPausedWidget(leadEmps,visibleJobs())}</div>`+(crossTeam?`<div class="an-row-2">${overdueTrend}${crossTeam}</div>`:overdueTrend))}
      ${wrap('perf',perfHtml)}
      ${wrap('branches',sec('📋 Jobs & Branches')+anBranchSection())}
      ${wrap('jobs',jobAnalysisHtml)}
      ${hasWf?wrap('workflow',sec('🧺 Workflow')+'<div id="an-wf-inline"></div>'):''}`);
    if(hasWf){const wfEl=el.querySelector('#an-wf-inline');if(wfEl)wfEl.innerHTML=wfAnalyticsSection()||'<div class="empty" style="padding:1rem;">No workflow data yet.</div>';}
    return;
  }

  // ── MANAGER / DIRECTOR ────────────────────────────────────────────────────
  set(`${wrap('kpis',kpiHtml)}
    ${wrap('status_trend',`<div class="an-row-2">
      <div class="an-widget"><div class="an-widget-hd">Status Breakdown</div>${anDonut(statusData,total,'jobs')}</div>
      ${throughputHtml}
    </div>`)}
    ${wrap('team',sec('👥 Team')+`<div class="an-row-2">${anTeamHealthWidget(leadEmps,visibleJobs())}${anActiveVsPausedWidget(leadEmps,visibleJobs())}</div>`+(crossTeam?`<div class="an-row-2">${overdueTrend}${crossTeam}</div>`:overdueTrend))}
    ${wrap('perf',perfHtml)}
    ${wrap('branches',sec('📋 Jobs & Branches')+anBranchSection())}
    ${wrap('jobs',jobAnalysisHtml)}
    ${hasWf?wrap('workflow',sec('🧺 Workflow')+'<div id="an-wf-inline"></div>'):''}
    ${wrap('teams_overview',sec('👥 Teams Overview')+'<div id="an-teams-inline"></div>')}`);
  if(hasWf){const wfEl=el.querySelector('#an-wf-inline');if(wfEl)wfEl.innerHTML=wfAnalyticsSection()||'';}
  const teamsEl=el.querySelector('#an-teams-inline');if(teamsEl)renderTeamsAnalytics(teamsEl);
}

// handleNotifClick with URL update
const _handleNotifClick=window.handleNotifClick;
window.handleNotifClick=async function(id,isBcast){
  await _handleNotifClick(id,isBcast);
  const n=notifications.find(x=>x.id===id);
  const body=(n?.body||'')+(n?.title||'');
  const m=body.match(/#(\d+)/);
  if(m){const u=new URL(location.href);u.searchParams.set('job',m[1]);history.replaceState(null,'',u);}
};

// saveEdit mentions + attachments display on editJob
const _saveEdit=window.saveEdit;
window.saveEdit=async function(){
  const id=document.getElementById('eid').value;
  const notes=document.getElementById('enotes').value;
  await _saveEdit();
  const j=jobs.find(x=>x.id===id);
  if(j&&notes)await notifyMentions(notes,j,'job update');
};

const _editJob=window.editJob;
window.editJob=function(id){
  _editJob(id);
  renderJobAttachments(jobs.find(x=>x.id===id));
};

// assignJob mention on notes
const _assignJob=window.assignJob;
window.assignJob=async function(){
  const notes=document.getElementById('mnotes').value;
  await _assignJob();
  if(notes)await notifyMentions(notes,null,'new assignment');
};

// Patch submitComment for mention notifications
const _submitComment=window.submitComment;
window.submitComment=async function(jobId){
  const inp=document.getElementById('ci-'+jobId);
  const text=inp?.value?.trim()||'';
  await _submitComment(jobId);
  if(text){const j=jobs.find(x=>x.id===jobId);if(j)await notifyMentions(text,j,text);}
};

// removeUser permission
const _removeUser=window.removeUser;
window.removeUser=function(id){
  const u=users.find(x=>x.id===id);
  if(!canDeleteUser(u)){showToastMsg('You cannot remove this user.');return;}
  _removeUser(id);
};

// cal click - patch renderCal day cells
const _renderCal=renderCal;
renderCal=function(){
  _renderCal();
  document.querySelectorAll('.calgrid .cd:not(.om)').forEach(cell=>{
    const ds=cell.dataset.date;
    if(!ds)return;
    const items=jobsForCalendarDay(ds);
    if(items.length)cell.classList.add('cal-day-has');
    cell.onclick=()=>openCalDayModal(ds);
  });
};

// ── TEAMS OVERVIEW (manager-only) ─────────────────────────────────────────────
function renderTeamsOverview(){
  const root=document.getElementById('teams-overview-root');if(!root)return;
  if(!me||!(me.role==='manager'||amDirector())){root.innerHTML='<div class="empty" style="padding:2rem;">Manager access only.</div>';return;}
  const tls=users.filter(u=>u.role==='team_leader');
  if(!tls.length){root.innerHTML='<div class="empty" style="padding:2rem;">No team leaders yet. Add team leaders in Manage Users.</div>';return;}

  const nowD=new Date(),ws=new Date(nowD);ws.setDate(nowD.getDate()-nowD.getDay());ws.setHours(0,0,0,0);
  const nowMs=Date.now();

  // build data per team
  const teams=tls.map(tl=>{
    const members=users.filter(u=>u.teamLeaderId===tl.id);
    const memberIds=new Set([tl.id,...members.map(u=>u.id)]);
    const tj=jobs.filter(j=>memberIds.has(j.owner)&&!j.workflow);
    const active=tj.filter(j=>j.status!=='completed');
    const overdueJobs=tj.filter(j=>isOverdue(j));
    const doneWk=tj.filter(j=>j.completed&&new Date(j.completed)>=ws);
    const pending=tj.filter(j=>j.status==='pending').length;
    const ongoing=tj.filter(j=>j.status==='ongoing').length;
    const paused=tj.filter(j=>j.status==='paused').length;
    const completed=tj.filter(j=>j.status==='completed').length;
    const pendExt=extRequests.filter(r=>r.status==='pending'&&memberIds.has((jobs.find(x=>x.id===r.jobId)||{}).owner));
    const sla=computeSlaStats(tj);
    const doneWithTime=tj.filter(j=>j.completed&&j.created);
    const avgMs=doneWithTime.length?doneWithTime.reduce((s,j)=>s+(toMillis(j.completed)-toMillis(j.created)),0)/doneWithTime.length:0;
    // health score 0-100
    const health=Math.max(0,Math.round(100-(overdueJobs.length/Math.max(active.length,1))*60-(pendExt.length*5)));
    return{tl,members,memberIds,tj,active,overdueJobs,doneWk,pending,ongoing,paused,completed,pendExt,sla,avgMs,health};
  });

  // global summary
  const totalMembers=teams.reduce((s,t)=>s+t.members.length,0);
  const totalActive=teams.reduce((s,t)=>s+t.active.length,0);
  const totalOverdue=teams.reduce((s,t)=>s+t.overdueJobs.length,0);
  const totalDoneWk=teams.reduce((s,t)=>s+t.doneWk.length,0);
  const totalExt=teams.reduce((s,t)=>s+t.pendExt.length,0);

  // comparison bar helper
  const maxActive=Math.max(...teams.map(t=>t.active.length),1);
  const cmpBar=(t,val,max,col)=>`<div class="tov-cmp-row">
    <span class="tov-cmp-lbl">${escapeHtml(t.tl.name)}</span>
    <div class="tov-cmp-track"><div class="tov-cmp-fill" style="width:${Math.max(Math.round(val/max*100),val?3:0)}%;background:${col};"></div></div>
    <span class="tov-cmp-val">${val}</span>
  </div>`;

  // per-team card
  const teamCards=teams.map(t=>{
    const healthCol=t.health>=70?'var(--green)':t.health>=40?'var(--yellow)':'var(--red)';
    const healthLabel=t.health>=70?'Healthy':t.health>=40?'At Risk':'Needs Attention';

    // member rows with full detail
    const memberRows=t.members.map(m=>{
      const mj=jobs.filter(j=>j.owner===m.id&&j.status!=='completed'&&!j.workflow);
      const mOd=jobs.filter(j=>j.owner===m.id&&isOverdue(j)&&!j.workflow);
      const mDone=jobs.filter(j=>j.owner===m.id&&j.status==='completed'&&!j.workflow).length;
      const col=mOd.length?'var(--red)':mj.length>=5?'var(--red)':mj.length>=3?'var(--yellow)':'var(--green)';
      const pct=Math.min(100,Math.round(mj.length/6*100));
      const statusDots=[
        mj.filter(j=>j.status==='ongoing').length?`<span style="color:var(--blue)">${mj.filter(j=>j.status==='ongoing').length} ongoing</span>`:'',
        mj.filter(j=>j.status==='pending').length?`<span style="color:var(--yellow)">${mj.filter(j=>j.status==='pending').length} pending</span>`:'',
        mOd.length?`<span style="color:var(--red)">⚠${mOd.length} overdue</span>`:'',
      ].filter(Boolean).join(' · ');
      return`<div class="tov-member-row" onclick="goHub('insights','reports');setTimeout(()=>setAnalyticsEmp('${m.id}'),200)" title="View ${escapeHtml(m.name)}'s analytics">
        <div class="tov-member-info">
          <span class="tov-member-name">${escapeHtml(m.name)}</span>
          <span class="tov-member-status">${statusDots||`<span style="color:var(--text3)">${mDone} done · no active jobs</span>`}</span>
        </div>
        <div class="tov-load-bar"><div style="width:${Math.max(pct,mj.length?3:0)}%;background:${col};height:100%;border-radius:2px;transition:width 0.3s;"></div></div>
        <span class="tov-member-load" style="color:${col}">${mj.length}</span>
      </div>`;
    }).join('');

    // overdue jobs list
    const odHtml=t.overdueJobs.slice(0,4).map(j=>{
      const own=users.find(u=>u.id===j.owner)?.name||'?';
      const age=nowMs-toMillis(j.created);
      return`<div class="tov-od-row">
        <span class="tov-od-dot"></span>
        <div class="tov-od-info"><span class="tov-od-client">${escapeHtml(j.client)}</span><span class="tc-muted"> #${escapeHtml(j.jobNum)}</span>
          <span class="tov-od-meta"> · ${escapeHtml(own)} · ${j.deadline?'due '+fmtShort(j.deadline):'no deadline'}</span>
        </div>
        <button class="tbl-btn tbl-btn-ghost" style="font-size:0.7rem;padding:0.1rem 0.4rem;" onclick="openJobDetail('${j.id}')">View</button>
      </div>`;
    }).join('');

    // pending extensions
    const extHtml=t.pendExt.slice(0,3).map(r=>`<div class="tov-ext-row">
      <span>${escapeHtml(r.client)} <span class="tc-muted">#${escapeHtml(String(r.jobNum))}</span> · ${escapeHtml(r.requestedByName)}</span>
      <div style="display:flex;gap:0.3rem;">
        <button class="bp" style="font-size:0.7rem;padding:0.15rem 0.5rem;" onclick="approveExt('${r.id}')">✓</button>
        <button class="bp sec" style="font-size:0.7rem;padding:0.15rem 0.5rem;" onclick="rejectExt('${r.id}')">✕</button>
      </div>
    </div>`).join('');

    return`<div class="tov-card-full">
      <!-- header -->
      <div class="tov-card-header">
        <div class="tov-card-title-row">
          <div class="user-avatar user-av-tl" style="width:42px;height:42px;font-size:1.15rem;flex-shrink:0;">${escapeHtml(t.tl.name.trim().charAt(0).toUpperCase())}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:1rem;font-weight:600;">${escapeHtml(t.tl.name)} <span class="bdg bdg-tl">TL</span></div>
            <div style="font-size:0.75rem;color:var(--text2);margin-top:2px;">${t.members.length} member${t.members.length!==1?'s':''} · ${t.tj.length} total jobs${t.avgMs?` · ⏱ avg ${tdiff(0,t.avgMs)}`:''}</div>
          </div>
          <div class="tov-health-pill" style="background:${healthCol}22;color:${healthCol};border:1px solid ${healthCol}55;">${healthLabel}</div>
        </div>
        <!-- kpi row -->
        <div class="tov-kpi-row">
          <div class="tov-kpi"><span style="color:var(--blue)">${t.active.length}</span><span>Active</span></div>
          <div class="tov-kpi"><span style="color:${t.overdueJobs.length?'var(--red)':'var(--green)'}">${t.overdueJobs.length}</span><span>Overdue</span></div>
          <div class="tov-kpi"><span style="color:var(--green)">${t.doneWk.length}</span><span>Done Wk</span></div>
          <div class="tov-kpi"><span style="color:var(--yellow)">${t.pending}</span><span>Pending</span></div>
          <div class="tov-kpi"><span style="color:var(--blue)">${t.ongoing}</span><span>Ongoing</span></div>
          <div class="tov-kpi"><span style="color:${t.sla.onTimePct>=70?'var(--green)':'var(--yellow)'}">${t.sla.onTimePct}%</span><span>On-Time</span></div>
          <div class="tov-kpi"><span style="color:var(--green)">${t.completed}</span><span>Done Total</span></div>
          ${t.pendExt.length?`<div class="tov-kpi"><span style="color:var(--orange)">${t.pendExt.length}</span><span>Ext. Req</span></div>`:''}
        </div>
      </div>
      <!-- body: members + issues -->
      <div class="tov-card-body">
        <div class="tov-section">
          <div class="tov-section-hd">👤 Team Members</div>
          ${t.members.length?`<div class="tov-members">${memberRows}</div>`:'<div class="tov-no-members">No members assigned.</div>'}
        </div>
        ${t.overdueJobs.length?`<div class="tov-section">
          <div class="tov-section-hd" style="color:var(--red);">⚠ Overdue Jobs (${t.overdueJobs.length})</div>
          ${odHtml}
          ${t.overdueJobs.length>4?`<div style="font-size:0.72rem;color:var(--text2);margin-top:0.35rem;">+${t.overdueJobs.length-4} more</div>`:''}
        </div>`:''}
        ${t.pendExt.length?`<div class="tov-section">
          <div class="tov-section-hd" style="color:var(--orange);">📬 Pending Extensions (${t.pendExt.length})</div>
          ${extHtml}
        </div>`:''}
      </div>
      <!-- footer -->
      <div class="tov-card-foot">
        <button class="bp sec" style="font-size:0.75rem;" onclick="goHub('insights','reports');setTimeout(()=>setAnalyticsView('teams',document.querySelector('.an-tab-btn[data-view=teams]')),200)">📊 Team Analytics</button>
        <button class="bp sec" style="font-size:0.75rem;" onclick="goHub('team','board')">📋 Board</button>
      </div>
    </div>`;
  }).join('');

  // comparison section
  const maxOd=Math.max(...teams.map(t=>t.overdueJobs.length),1);
  const maxDone=Math.max(...teams.map(t=>t.doneWk.length),1);

  root.innerHTML=`
    <!-- global summary bar -->
    <div class="tov-summary-bar">
      <div class="tov-sum-item"><span class="tov-sum-n">${tls.length}</span><span class="tov-sum-l">Teams</span></div>
      <div class="tov-sum-item"><span class="tov-sum-n">${totalMembers}</span><span class="tov-sum-l">Members</span></div>
      <div class="tov-sum-item"><span class="tov-sum-n" style="color:var(--blue)">${totalActive}</span><span class="tov-sum-l">Active Jobs</span></div>
      <div class="tov-sum-item"><span class="tov-sum-n" style="color:${totalOverdue?'var(--red)':'var(--green)'}">${totalOverdue}</span><span class="tov-sum-l">Overdue</span></div>
      <div class="tov-sum-item"><span class="tov-sum-n" style="color:var(--green)">${totalDoneWk}</span><span class="tov-sum-l">Done This Week</span></div>
      ${totalExt?`<div class="tov-sum-item"><span class="tov-sum-n" style="color:var(--orange)">${totalExt}</span><span class="tov-sum-l">Ext. Requests</span></div>`:''}
    </div>

    <!-- comparison mini-charts -->
    <div class="tov-compare-row">
      <div class="tov-compare-card">
        <div class="tov-compare-hd">Active Load</div>
        ${teams.map(t=>cmpBar(t,t.active.length,maxActive,t.overdueJobs.length?'var(--red)':t.active.length>=5?'var(--yellow)':'var(--blue)')).join('')}
      </div>
      <div class="tov-compare-card">
        <div class="tov-compare-hd">Overdue</div>
        ${teams.map(t=>cmpBar(t,t.overdueJobs.length,maxOd,t.overdueJobs.length?'var(--red)':'var(--green)')).join('')}
      </div>
      <div class="tov-compare-card">
        <div class="tov-compare-hd">Done This Week</div>
        ${teams.map(t=>cmpBar(t,t.doneWk.length,maxDone,'var(--green)')).join('')}
      </div>
      <div class="tov-compare-card">
        <div class="tov-compare-hd">On-Time Rate</div>
        ${teams.map(t=>{const col=t.sla.onTimePct>=70?'var(--green)':t.sla.onTimePct>=40?'var(--yellow)':'var(--red)';return`<div class="tov-cmp-row"><span class="tov-cmp-lbl">${escapeHtml(t.tl.name)}</span><div class="tov-cmp-track"><div class="tov-cmp-fill" style="width:${Math.max(t.sla.onTimePct,t.sla.doneWithDl?3:0)}%;background:${col};"></div></div><span class="tov-cmp-val">${t.sla.onTimePct}%</span></div>`;}).join('')}
      </div>
    </div>

    <!-- per-team cards -->
    <div class="tov-cards-grid">${teamCards}</div>`;
}
window.renderTeamsOverview=renderTeamsOverview;

init();

// Keep --header-h in sync with actual header height
(function syncHeaderHeight(){
  const hdr=document.querySelector('header');
  if(!hdr)return;
  const update=()=>document.documentElement.style.setProperty('--header-h',hdr.offsetHeight+'px');
  update();
  new ResizeObserver(update).observe(hdr);
})();
})();