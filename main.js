// ── RMI Task Allocator — main module ──────────────────────────────────────────
// Entry point. Imports shared leaves (firebase / state / helpers / email),
// holds all app logic + bootstrap. Loaded via <script type="module" src="main.js">.
import { initializeApp, getFirestore, collection, doc, setDoc, addDoc, updateDoc, deleteDoc, deleteField, onSnapshot, getDocs, getDoc, query, where, limit, writeBatch, getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail, getStorage, ref, uploadBytes, getDownloadURL, deleteObject, CFG, MGR_PW, USE_FIREBASE, USE_AUTH } from './firebase.js';
import { JOB_TYPES, ACTIVITY_TYPE_LABELS, FB_LIMITS, JOBS_PAGE_SIZE, ARCHIVE_AFTER_MS, DEFAULT_SETTINGS, NOTIF_BUBBLE_TTL, NOTIF_TOAST_MAX, jobs, users, events, notifications, extRequests, broadcasts, activityLogs, me, myFilter, lastDel, isDark, currentATab, userSettings, setMe, setJobs, setUsers, setEvents, setNotifications, setExtRequests, setBroadcasts, setActivityLogs, setMyFilter, setLastDel, setIsDark, setCurrentATab, setUserSettings } from './state.js';
import { lsub, toMillis, escapeHtml, fmt, fmtShort, tdiff, getJobPausedMs, getJobDurationBreakdown, formatJobDurationHtml, jobPauseDefaults, uid, timeAgo } from './helpers.js';
import { sendEmail, emailPref, emailUser, emailJobOwner, emailManagersAndSupervisors, emailTeamLeaderOf, emailAllOversight } from './email.js';

// ── MAIN-LOCAL STATE (firebase handles + UI-only mutables) ────────────────────
let db, auth, storage, jCol, uCol, evCol, notifCol, extCol, bcastCol, logCol, authMapCol, archiveCol;
let authStateReady=false, authLoginInProgress=false;
let calY=new Date().getFullYear(), calM=new Date().getMonth(), calFilterEmp='', calShowMode='all';
let selectedJobs=new Set();
let chartPrefs={bytype:{mode:'bar',showPct:true,showNum:true},bypriority:{mode:'bar',showPct:true,showNum:true}};
let knownNotifIds=new Set(), notifSoundReady=false, notifSnapshotReady=false, notifBulkClearing=false;
let fbUnsubs=[];
let notifToastTimers=new Map();
let confirmCallback=null, completeJobId=null;
let tagStores={jtags:[],etags:[],mtags:[]};

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

// ── TAGS ─────────────────────────────────────────────────────────────────────
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
function renderTags(store,inputId,wrapId){
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
function setTags(store,inputId,wrapId,arr){tagStores[store]=arr?[...arr]:[];renderTags(store,inputId,wrapId);}

// ── CONFIRM MODAL ─────────────────────────────────────────────────────────────
function showConfirm(title,msg,cb,btnLabel='Confirm',danger=true){
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

// ── LOCAL FALLBACK ────────────────────────────────────────────────────────────
function localSave(){
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
    try{const uSnap=await getDocs(uCol);users=uSnap.docs.map(d=>({id:d.id,...d.data()}));}catch(e){}
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
}
function canSeeAllJobs(){
  return me&&(me.role==='manager'||me.role==='supervisor'||me.viewAll==='yes');
}
// ── TEAMS / SCOPE ────────────────────────────────────────────────────────────
function isTeamLeader(){return me&&me.role==='team_leader';}
function teamMemberIds(leaderId){
  // members assigned to this leader + the leader themselves
  return [leaderId,...users.filter(u=>u.teamLeaderId===leaderId).map(u=>u.id)];
}
function myTeamIds(){return me?teamMemberIds(me.id):[];}
// central visibility: which jobs current user may see
function visibleJobs(){
  if(!me)return[];
  // TL scope takes priority — viewAll='yes' on a TL should not expose all jobs
  if(isTeamLeader()){const ids=new Set(myTeamIds());return jobs.filter(j=>ids.has(j.owner));}
  if(canSeeAllJobs())return jobs;
  return jobs.filter(j=>j.owner===me.id);
}
// can current user manage (edit/assign/reassign/extend) this job?
function canManageJob(j){
  if(!me||!j)return false;
  if(me.role==='manager'||me.role==='supervisor')return true;
  if(me.id===j.owner)return true;
  if(isTeamLeader()&&myTeamIds().includes(j.owner))return true;
  return false;
}
// is current user a "lead" (manager/supervisor/team_leader) — gets assign, board, notes
function isLead(){return me&&['manager','supervisor','team_leader'].includes(me.role);}
// users visible in board/assign/calendar/analytics dropdowns
function teamUsersForView(){
  if(!me)return[];
  if(me.role==='manager'||me.role==='supervisor')return users;
  if(isTeamLeader()){const ids=new Set(myTeamIds());return users.filter(u=>ids.has(u.id));}
  return users.filter(u=>u.id===me.id);
}
// employees a lead may assign to
function assignableUsers(){
  if(!me)return[];
  if(me.role==='manager')return users;
  if(me.role==='supervisor')return users.filter(u=>u.role!=='manager');
  if(isTeamLeader())return users.filter(u=>u.teamLeaderId===me.id||u.id===me.id);
  return [];
}
function jobsQueryForUser(){
  if(!me)return jCol;
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
async function refreshBroadcastsRemote(){
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
function attachFirebaseListeners(){
  detachFirebaseListeners();
  if(!USE_FIREBASE||!me||!db)return;
  const jq=jobsQueryForUser();
  fbUnsubs.push(onSnapshot(jq,snap=>{
    setJobs(snap.docs.map(d=>({id:d.id,...d.data()})));
    jobs.sort((a,b)=>(b.created||0)-(a.created||0));
    renderAll();
    if(isLead())renderBoard();
    updateSynced();
  }));
  fbUnsubs.push(onSnapshot(query(notifCol,where('userId','==',me.id),limit(FB_LIMITS.notifications)),snap=>{
    setNotifications(snap.docs.map(d=>({id:d.id,...d.data()})));
    onNotificationsUpdated();
  }));
}

function updateSynced(){document.getElementById('synced').textContent='● '+new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});}

// ── AUTH ──────────────────────────────────────────────────────────────────────
function populateADrop(){
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

function renderAssignEmpGrid(){
  const grid=document.getElementById('assign-emp-grid');
  if(!grid)return;
  const pool=assignableUsers();
  const selected=document.getElementById('mat')?.value||'';
  grid.innerHTML=pool.map(u=>{
    const active=jobs.filter(j=>j.owner===u.id&&j.status!=='completed').length;
    const overdue=jobs.filter(j=>j.owner===u.id&&isOverdue(j)).length;
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
  const uj=jobs.filter(j=>j.owner===id&&j.status!=='completed');
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
  users.forEach(u=>{const o=document.createElement('option');o.value=u.id;o.textContent=u.name;sf.appendChild(o);});
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
  if(['manager','supervisor','team_leader'].includes(u.role))goHub('insights','overview');
  else goHub('jobs','my-jobs');
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
  const myActive=jobs.filter(j=>j.owner===me.id&&j.status!=='completed').length;
  const myDone=jobs.filter(j=>j.owner===me.id&&j.status==='completed').length;
  el.innerHTML=`
  <div class="acct-profile">
    <div class="acct-avatar acct-av-${bdg}">${escapeHtml(initial)}</div>
    <div class="acct-profile-info">
      <div class="acct-name">${escapeHtml(me.name)} <span class="bdg bdg-${bdg}">${roleMeta(me.role).label}</span></div>
      <div class="acct-email">${escapeHtml(me.email||'No email on file')}</div>
      ${me.viewAll==='yes'?'<div class="acct-viewall">👁 Can view all team jobs</div>':''}
    </div>
    <div class="acct-mini-stats">
      <div><span class="acct-ms-n">${myActive}</span><span class="acct-ms-l">active</span></div>
      <div><span class="acct-ms-n">${myDone}</span><span class="acct-ms-l">done</span></div>
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
function pushNotif(userId,title,body){
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
function notifyReassign(j,fromId,toId,byName){
  if(!j)return;
  const label=jobLabel(j);
  const ex=exceptActor(me?.id);
  const toName=users.find(u=>u.id===toId)?.name||'someone';
  pushNotifExcept(ex,toId,'🔄 Job Reassigned',`${label} reassigned to you by ${byName}`);
  if(fromId&&fromId!==toId)pushNotifExcept(ex,fromId,'🔄 Job Reassigned',`${label} reassigned from you to ${toName}`);
  notifyManagersAndSupervisors('🔄 Job Reassigned',`${byName} reassigned ${label} to ${toName}`,ex);
  // T2: email new owner on reassign
  if(emailPref('emailAssigned')){emailUser(toId,`Job Reassigned to You: ${label}`,`${byName} has reassigned a job to you.\n\nJob: ${label}`,ex);emailAllOversight(j,`Job Reassigned: ${label}`,`${byName} reassigned ${label} to ${toName}`,ex);}
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
        if(emailPref('emailAssigned'))emailJobOwner(j,`New Job Assigned: ${label}`,`${me.name} has assigned you a new job.\n\nJob: ${label}\nAssigned by: ${me.name}`);
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
      if(emailPref('emailStatus')){emailJobOwner(j,`Job Started: ${label}`,`${me.name} has started the job.\n\nJob: ${label}`,ex);emailAllOversight(j,`Job Started: ${label}`,`${me.name} started ${label}`,ex);}
      break;
    case 'paused':
      notifyJobOwner(j,'⏸ Job Paused',`${me.name} paused ${label}`,ex);
      notifyManagersAndSupervisors('⏸ Job Paused',`${me.name} paused ${label}`,ex);
      notifyTeamLeaderOf(j?.owner,'⏸ Job Paused',`${me.name} paused ${label}`,ex);
      if(emailPref('emailStatus')){emailJobOwner(j,`Job Paused: ${label}`,`${me.name} has paused the job.\n\nJob: ${label}`,ex);emailAllOversight(j,`Job Paused: ${label}`,`${me.name} paused ${label}`,ex);}
      break;
    case 'resumed':
      notifyJobOwner(j,'▶ Job Resumed',`${me.name} resumed ${label}`,ex);
      notifyManagersAndSupervisors('▶ Job Resumed',`${me.name} resumed ${label}`,ex);
      notifyTeamLeaderOf(j?.owner,'▶ Job Resumed',`${me.name} resumed ${label}`,ex);
      if(emailPref('emailStatus')){emailJobOwner(j,`Job Resumed: ${label}`,`${me.name} has resumed the job.\n\nJob: ${label}`,ex);emailAllOversight(j,`Job Resumed: ${label}`,`${me.name} resumed ${label}`,ex);}
      break;
    case 'completed':
      notifyJobOwner(j,'✅ Job Completed',`${me.name} completed ${label}`,ex);
      notifyManagersAndSupervisors('✅ Job Completed',`${me.name} completed ${label}`,ex);
      notifyTeamLeaderOf(j?.owner,'✅ Job Completed',`${me.name} completed ${label}`,ex);
      if(emailPref('emailStatus')){emailJobOwner(j,`Job Completed: ${label}`,`${me.name} has completed the job.\n\nJob: ${label}`,ex);emailAllOversight(j,`Job Completed: ${label}`,`${me.name} completed ${label}`,ex);}
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
      if(emailPref('emailExtension')){emailManagersAndSupervisors(`Extension Request: ${label}`,`${me.name} has requested a deadline extension.\n\nJob: ${label}`,ex);emailTeamLeaderOf(j?.owner,`Extension Request: ${label}`,`${me.name} requested a deadline extension for ${label}`,ex);}
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
  const due=jobs.filter(j=>j.owner===me.id&&j.deadline&&j.status!=='completed'&&(j.deadline-now)<86400000&&(j.deadline-now)>-86400000*7);
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
async function logActivity(entry){
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
async function addEvent(jobId,type,desc,color='blue'){
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
function getJobEvents(jobId){return events.filter(e=>e.jobId===jobId).sort((a,b)=>(b.ts||0)-(a.ts||0));}

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

// ── COMMENTS ──────────────────────────────────────────────────────────────────
async function addComment(jobId,text){
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
function renderCommentSection(jobId){
  const comms=getJobEvents(jobId).filter(e=>e.type==='comment');
  return`<div class="comment-section"><h5>Comments & Activity</h5>${comms.map(c=>`<div class="comment"><div class="cmeta">${fmt(c.ts)}</div>${c.desc.replace('💬 ','')}</div>`).join('')}<div class="comment-input"><input id="ci-${jobId}" placeholder="Add a comment..." onkeydown="if(event.key==='Enter')submitComment('${jobId}')"/><button onclick="submitComment('${jobId}')">Send</button></div></div>`;
}

// ── CRUD WRAPPERS ─────────────────────────────────────────────────────────────
async function jAdd(data){
  if(USE_FIREBASE){const r=await addDoc(jCol,data);return r.id;}
  else{data.id=uid();jobs.unshift(data);localSave();renderAll();if(me&&isLead())renderBoard();return data.id;}
}
async function jUpdate(id,data){
  if(USE_FIREBASE){await updateDoc(doc(db,'jobs',id),data);}
  else{const j=jobs.find(x=>x.id===id);if(j){Object.assign(j,data);localSave();renderAll();if(me&&isLead())renderBoard();}}
}
async function jDelete(id){
  if(USE_FIREBASE){await deleteDoc(doc(db,'jobs',id));}
  else{setJobs(jobs.filter(x=>x.id!==id));localSave();renderAll();}
}
async function jRestore(j){
  if(USE_FIREBASE){const{id,...data}=j;await setDoc(doc(db,'jobs',id),data);}
  else{jobs.unshift(j);localSave();renderAll();}
}
async function uAdd(id,data){
  if(USE_FIREBASE){await setDoc(doc(uCol,id),data);}
  else{users.push(data);localSave();populateADrop();renderUList();populateCalEmpDrop();}
}
async function uUpdate(id,data){
  if(USE_FIREBASE){await updateDoc(doc(uCol,id),data);}
  else{const u=users.find(x=>x.id===id);if(u){Object.assign(u,data);localSave();populateADrop();renderUList();populateCalEmpDrop();}}
}
async function uDelete(id){
  if(USE_FIREBASE){await deleteDoc(doc(uCol,id));}
  else{setUsers(users.filter(u=>u.id!==id));localSave();populateADrop();renderUList();populateCalEmpDrop();}
}
function empOverdueJobs(uid){return visibleJobs().filter(j=>j.owner===uid&&isOverdue(j));}
function dateKey(ts){const ms=toMillis(ts);if(!ms)return'';const d=new Date(ms);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function jobDateEntries(j){
  const evs=[];
  if(j.started)evs.push({kind:'started',ts:j.started});
  if(j.completed)evs.push({kind:'completed',ts:j.completed});
  if(j.deadline)evs.push({kind:'deadline',ts:j.deadline,overdue:j.status!=='completed'&&isOverdue(j)});
  return evs;
}
function jobsForCalendarDay(ds){
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
function populateCalEmpDrop(){
  // legacy alias — now uses pills
  populateCalEmpPills();
}
function populateCalEmpPills(){
  const wrap=document.getElementById('cal-emp-pills');if(!wrap)return;
  const pool=teamUsersForView().filter(u=>u.role!=='manager');
  wrap.innerHTML=`<button class="cal-emp-pill${!calFilterEmp?' cep-on':''}" onclick="setCalFilter('')">All</button>`
    +pool.map(u=>`<button class="cal-emp-pill${calFilterEmp===u.id?' cep-on':''}" onclick="setCalFilter('${u.id}')">${escapeHtml(u.name.split(' ')[0])}</button>`).join('');
}
async function extAdd(data){
  if(USE_FIREBASE){const r=await addDoc(extCol,data);return r.id;}
  else{data.id=uid();extRequests.unshift(data);localSave();return data.id;}
}
async function extUpdate(id,data){
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

async function updateJob(id,data){
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

// ── BROADCAST ─────────────────────────────────────────────────────────────────
window.sendBroadcast=async function(){
  const msg=document.getElementById('bcast-msg').value.trim();
  let to=document.getElementById('bcast-to').value;
  if(!msg){alert('Message cannot be empty.');return;}
  // TL sends to their team — store as team:${leaderId}
  if(to==='team'&&isTeamLeader())to=`team:${me.id}`;
  const bcast={msg,to,by:me.name,byId:me.id,created:Date.now()};
  if(USE_FIREBASE){await addDoc(bcastCol,bcast);await refreshBroadcastsRemote();}
  else{bcast.id=uid();broadcasts.unshift(bcast);localSave();renderBroadcasts();}
  const toLabel=to==='all'?'everyone':to==='employees'?'employees':to==='supervisors'?'supervisors':to.startsWith('team:')?'my team':to;
  await logActivity({type:'broadcast',category:'broadcast',desc:`${me.name} sent message to ${toLabel}: ${msg.slice(0,120)}${msg.length>120?'…':''}`,userId:me.id,userName:me.name,role:me.role});
  // Push notifications
  let targets=users;
  if(to==='employees')targets=users.filter(u=>u.role==='employee'||u.role==='team_leader');
  else if(to==='supervisors')targets=users.filter(u=>u.role==='supervisor');
  else if(to.startsWith('team:')){const lid=to.slice(5);targets=users.filter(u=>u.teamLeaderId===lid||u.id===lid);}
  targets.filter(u=>u.id!==me.id).forEach(u=>pushNotif(u.id,'📢 Message from '+me.name,msg));
  document.getElementById('bcast-msg').value='';
  showToastMsg('Message sent!');
};
function broadcastsForUser(u){
  if(!u)return[];
  if(u.role==='manager')return broadcasts;
  return broadcasts.filter(b=>{
    if(b.to==='all')return true;
    if(b.to==='employees'&&(u.role==='employee'||u.role==='team_leader'))return true;
    if(b.to==='supervisors'&&u.role==='supervisor')return true;
    // team-scoped: team:${leaderId}
    if(b.to&&b.to.startsWith('team:')){
      const leaderId=b.to.slice(5);
      if(u.id===leaderId)return true;
      if(u.teamLeaderId===leaderId)return true;
    }
    return false;
  });
}
window.setBcastAudience=function(to,btn){
  const sel=document.getElementById('bcast-to');if(sel)sel.value=to;
  document.querySelectorAll('.msg-aud-pill').forEach(b=>b.classList.toggle('on',b.dataset.to===to));
};
function bcastMsgLastSeen(){return parseInt(localStorage.getItem('rmi_bcast_seen_'+(me?.id||''))||'0',10);}
function markBroadcastsSeen(){
  if(!me)return;
  const latest=Math.max(0,...broadcastsForUser(me).map(b=>toMillis(b.created)));
  localStorage.setItem('rmi_bcast_seen_'+me.id,String(latest));
  updateMsgBadge();
}
function unreadBroadcastCount(){
  if(!me)return 0;
  const seen=bcastMsgLastSeen();
  return broadcastsForUser(me).filter(b=>toMillis(b.created)>seen&&b.byId!==me.id).length;
}
function updateMsgBadge(){
  const badge=document.getElementById('sb-msg-badge');if(!badge)return;
  const n=unreadBroadcastCount();
  badge.style.display=n>0?'inline-block':'none';
  badge.textContent=n;
}
function updateBroadcastUI(){
  if(!me)return;
  const isMgr=me.role==='manager';
  const isTL=isTeamLeader();
  const canCompose=isMgr||isTL;
  const compose=document.getElementById('bcast-compose');
  if(compose){
    compose.style.display=canCompose?'block':'none';
    // show team audience pill for TL, hide global audience pills
    const allPill=document.querySelector('.msg-aud-pill[data-to="all"]');
    const empPill=document.querySelector('.msg-aud-pill[data-to="employees"]');
    const supPill=document.querySelector('.msg-aud-pill[data-to="supervisors"]');
    const teamPill=document.querySelector('.msg-aud-pill[data-to="team"]');
    if(isTL&&!isMgr){
      if(allPill)allPill.style.display='none';
      if(empPill)empPill.style.display='none';
      if(supPill)supPill.style.display='none';
      if(teamPill){teamPill.style.display='';teamPill.classList.add('on');const sel=document.getElementById('bcast-to');if(sel)sel.value='team';}
    }else{
      if(allPill)allPill.style.display='';
      if(empPill)empPill.style.display='';
      if(supPill)supPill.style.display='';
      if(teamPill)teamPill.style.display=isMgr?'none':'';
    }
  }
  const hint=document.getElementById('broadcast-hint');
  if(hint)hint.style.display=canCompose?'none':'block';
  const msg=document.getElementById('bcast-msg');
  if(msg&&!msg._bound){msg._bound=true;msg.addEventListener('input',()=>{const c=document.getElementById('bcast-charcount');if(c)c.textContent=msg.value.length?msg.value.length+' chars':'';});}
  updateMsgBadge();
}
function broadcastDayLabel(ts){
  const d=new Date(toMillis(ts));d.setHours(0,0,0,0);
  const today=new Date();today.setHours(0,0,0,0);
  const diff=Math.round((today-d)/86400000);
  if(diff===0)return'Today';
  if(diff===1)return'Yesterday';
  return d.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
}
function renderBroadcasts(){
  const el=document.getElementById('bcast-list');if(!el||!me)return;
  const visible=[...broadcastsForUser(me)].sort((a,b)=>toMillis(b.created)-toMillis(a.created));
  const isMgr=me.role==='manager';
  const seen=bcastMsgLastSeen();
  if(!visible.length){el.innerHTML='<div class="empty" style="padding:2.5rem;text-align:center;">No announcements yet.</div>';return;}
  let html='',lastDay=null;
  visible.forEach(b=>{
    const day=broadcastDayLabel(b.created);
    if(day!==lastDay){html+=`<div class="msg-day-hd">${day}</div>`;lastDay=day;}
    const toLbl=b.to==='all'?'👥 Everyone':b.to==='employees'?'👤 Employees':b.to==='supervisors'?'🔰 Supervisors':escapeHtml(b.to);
    const unread=toMillis(b.created)>seen&&b.byId!==me.id;
    const initial=(b.by||'?').trim().charAt(0).toUpperCase();
    const editBtn=isMgr&&b.id?`<button type="button" class="msg-act" onclick="editBroadcast('${b.id}')" title="Edit">✎</button>`:'';
    const delBtn=isMgr&&b.id?`<button type="button" class="msg-act" onclick="deleteBroadcast('${b.id}')" title="Delete">✕</button>`:'';
    html+=`<div class="msg-card${unread?' msg-unread':''}">
      <div class="msg-avatar">${escapeHtml(initial)}</div>
      <div class="msg-body">
        <div class="msg-card-hd">
          <span class="msg-sender">${escapeHtml(b.by||'')}</span>
          <span class="msg-aud-chip">${toLbl}</span>
          <span class="msg-time" title="${escapeHtml(fmt(b.created))}">${dashRelTime(b.created)}</span>
          ${unread?'<span class="msg-unread-dot"></span>':''}
          <span class="msg-card-actions">${editBtn}${delBtn}</span>
        </div>
        <div class="msg-text">${escapeHtml(b.msg||'')}</div>
      </div>
    </div>`;
  });
  el.innerHTML=html;
  updateMsgBadge();
}
window.editBroadcast=async function(id){
  if(!me||me.role!=='manager')return;
  const b=broadcasts.find(x=>x.id===id);if(!b)return;
  const msg=prompt('Edit message:',b.msg||'');if(msg===null)return;
  const trimmed=msg.trim();if(!trimmed){alert('Message cannot be empty.');return;}
  if(USE_FIREBASE&&bcastCol){await updateDoc(doc(bcastCol,id),{msg:trimmed});}
  else{b.msg=trimmed;localSave();}
  await refreshBroadcastsRemote();
  showToastMsg('Broadcast updated.');
};
window.deleteBroadcast=function(id){
  if(!me||me.role!=='manager')return;
  const b=broadcasts.find(x=>x.id===id);
  if(!b)return;
  const preview=(b.msg||'').slice(0,80)+(b.msg&&b.msg.length>80?'…':'');
  showConfirm('Delete Broadcast',`Remove this message from history?\n\n"${preview}"`,async()=>{
    if(USE_FIREBASE&&bcastCol){await deleteDoc(doc(bcastCol,id));}
    setBroadcasts(broadcasts.filter(x=>x.id!==id));
    if(!USE_FIREBASE)localSave();
    await logActivity({type:'broadcast',category:'broadcast',desc:`${me.name} deleted broadcast: ${preview}`,userId:me.id,userName:me.name,role:me.role});
    renderBroadcasts();
    showToastMsg('Broadcast deleted.');
  });
};

// ── USER CRUD ─────────────────────────────────────────────────────────────────
window.addUser=async function(){
  const name=document.getElementById('uname').value.trim(),pw=document.getElementById('upw').value.trim(),role=document.getElementById('urole').value,email=document.getElementById('uemail').value.trim().toLowerCase();
  let viewAll=document.getElementById('uviewall').value;
  if(role==='manager')viewAll='yes';
  const rawTlId=role==='employee'?(document.getElementById('u-teamlead')?.value||null):null;
  const teamLeaderId=rawTlId&&users.find(u=>u.id===rawTlId&&u.role==='team_leader')?rawTlId:null;
  if(!name||!pw){alert('Name and password required.');return;}
  if(USE_AUTH&&!email){alert('Email is required so the employee can activate their account.');return;}
  const id=name.toLowerCase().replace(/\s+/g,'_')+'_'+Date.now();
  const data=USE_AUTH
    ?{id,name,role,email,viewAll,teamLeaderId,needsActivation:true,tempPassword:pw}
    :{id,name,role,password:pw,email,viewAll,teamLeaderId};
  await uAdd(id,data);
  await logActivity({type:'user_added',category:'user',desc:`${me.name} added user ${name} (${role})`,userId:me.id,userName:me.name,role:me.role});
  pushNotif(id,'👤 Account Created',USE_AUTH
    ?`${me.name} added you. Use First-time setup with name "${name}", temp password from manager, and your email.`
    :`${me.name} added you to RMI Task Allocator & Progress Tracker as ${role}`);
  document.getElementById('uname').value='';document.getElementById('upw').value='';document.getElementById('uemail').value='';
  closeAddUserModal();
  renderUList();
  showToastMsg(`✅ ${name} added as ${role}!`);
};
window.removeUser=async function(id){
  const u=users.find(x=>x.id===id);
  showConfirm('Remove User','This will permanently remove the user and they will no longer be able to log in.',async()=>{
    await uDelete(id);
    await logActivity({type:'user_removed',category:'user',desc:`${me.name} removed user ${u?.name||id}`,userId:me.id,userName:me.name,role:me.role});
    if(id!==me.id)pushNotif(id,'👤 Account Removed',`Your account was removed by ${me.name}`);
  },'Remove',true);
};
// role display meta
function roleMeta(role){
  if(role==='manager')return{icon:'👔',bdg:'m',label:'Manager'};
  if(role==='supervisor')return{icon:'🔰',bdg:'sup',label:'Supervisor'};
  if(role==='team_leader')return{icon:'🧭',bdg:'tl',label:'Team Leader'};
  return{icon:'👤',bdg:'l',label:'Employee'};
}
// fill a <select> with team_leader users; keep current value if given
function populateTeamLeadSelect(selId,current){
  const sel=document.getElementById(selId);if(!sel)return;
  const tls=users.filter(u=>u.role==='team_leader');
  sel.innerHTML='<option value="">— None —</option>'+tls.map(u=>`<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
  sel.value=current||'';
}
// show/hide team-leader picker based on selected role (only employees get a leader)
window.onRoleChange=function(ctx){
  const roleSel=document.getElementById(ctx==='edit'?'edit-urole':'urole');
  const wrap=document.getElementById(ctx==='edit'?'edit-teamlead-wrap':'add-teamlead-wrap');
  if(!roleSel||!wrap)return;
  wrap.style.display=roleSel.value==='employee'?'block':'none';
};
window.openAddUserModal=function(){
  ['uname','uemail','upw'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});
  const r=document.getElementById('urole');if(r)r.value='employee';
  const v=document.getElementById('uviewall');if(v)v.value='no';
  populateTeamLeadSelect('u-teamlead','');
  onRoleChange('add');
  document.getElementById('add-user-modal').classList.add('open');
};
window.closeAddUserModal=function(){document.getElementById('add-user-modal').classList.remove('open');};
function renderUList(){
  const el=document.getElementById('ulist');if(!el)return;
  const q=(document.getElementById('user-search')?.value||'').toLowerCase();
  // summary
  const sumEl=document.getElementById('user-summary');
  if(sumEl){
    const mgr=users.filter(u=>u.role==='manager').length;
    const sup=users.filter(u=>u.role==='supervisor').length;
    const tl=users.filter(u=>u.role==='team_leader').length;
    const emp=users.filter(u=>u.role==='employee').length;
    const pending=users.filter(u=>!u.authUid&&u.needsActivation).length;
    sumEl.innerHTML=`
      <div class="ext-sum-card"><div class="ext-sum-n">${users.length}</div><div class="ext-sum-l">Total</div></div>
      <div class="ext-sum-card"><div class="ext-sum-n" style="color:var(--purple)">${mgr}</div><div class="ext-sum-l">Managers</div></div>
      <div class="ext-sum-card"><div class="ext-sum-n" style="color:var(--yellow)">${sup}</div><div class="ext-sum-l">Supervisors</div></div>
      ${tl?`<div class="ext-sum-card"><div class="ext-sum-n" style="color:var(--green)">${tl}</div><div class="ext-sum-l">Team Leaders</div></div>`:''}
      <div class="ext-sum-card"><div class="ext-sum-n" style="color:var(--blue)">${emp}</div><div class="ext-sum-l">Employees</div></div>
      ${pending?`<div class="ext-sum-card"><div class="ext-sum-n" style="color:var(--orange)">${pending}</div><div class="ext-sum-l">Pending setup</div></div>`:''}`;
  }
  const order={manager:0,supervisor:1,team_leader:2,employee:3};
  let list=[...users].sort((a,b)=>(order[a.role]??9)-(order[b.role]??9)||(a.name||'').localeCompare(b.name||''));
  if(q)list=list.filter(u=>(u.name||'').toLowerCase().includes(q)||(u.email||'').toLowerCase().includes(q));
  if(!list.length){el.innerHTML='<div class="empty" style="padding:2rem;">No users match.</div>';return;}
  el.innerHTML=`<div class="user-list">${list.map(u=>{
    const rmeta=roleMeta(u.role);
    const bdg=rmeta.bdg;
    const initial=(u.name||'?').trim().charAt(0).toUpperCase();
    const active=jobs.filter(j=>j.owner===u.id&&j.status!=='completed').length;
    const status=u.authUid?'<span class="user-status us-active">● Active</span>':(u.needsActivation?'<span class="user-status us-pending">● Setup pending</span>':'<span class="user-status us-active">● Active</span>');
    const rm=u.id!==me?.id?`<button class="user-act user-act-danger" onclick="removeUser('${u.id}')" title="Remove">Remove</button>`:'';
    // extra meta: employee → their team leader; team_leader → member count
    let teamMeta='';
    if(u.role==='employee'&&u.teamLeaderId){const tl=users.find(x=>x.id===u.teamLeaderId);if(tl)teamMeta=` · 🧭 ${escapeHtml(tl.name)}`;}
    else if(u.role==='team_leader'){const n=users.filter(x=>x.teamLeaderId===u.id).length;teamMeta=` · 👥 ${n} member${n!==1?'s':''}`;}
    return`<div class="user-row">
      <div class="user-avatar user-av-${bdg}">${escapeHtml(initial)}</div>
      <div class="user-info">
        <div class="user-name-row">${escapeHtml(u.name)} <span class="bdg bdg-${bdg}">${rmeta.label}</span></div>
        <div class="user-meta">${u.email?`✉️ ${escapeHtml(u.email)}`:'<span class="tc-muted">no email</span>'} · ${u.viewAll==='yes'?'All jobs':'Own only'}${teamMeta}</div>
      </div>
      <div class="user-stat"><span class="user-stat-n">${active}</span><span class="user-stat-l">active</span></div>
      ${status}
      <div class="user-actions">
        <button class="user-act" onclick="openEditUserModal('${u.id}')" title="Edit">✏️ Edit</button>
        ${rm}
      </div>
    </div>`;
  }).join('')}</div>`;
}
window.openEditUserModal=function(id){
  const u=users.find(x=>x.id===id);if(!u)return;
  document.getElementById('edit-user-id').value=id;
  document.getElementById('edit-uname').value=u.name||'';
  document.getElementById('edit-uemail').value=u.email||'';
  document.getElementById('edit-upw').value='';
  document.getElementById('edit-urole').value=u.role||'employee';
  document.getElementById('edit-uviewall').value=u.viewAll==='yes'?'yes':'no';
  populateTeamLeadSelect('edit-uteamlead',u.teamLeaderId||'');
  onRoleChange('edit');
  document.getElementById('edit-user-modal').classList.add('open');
};
window.closeEditUserModal=function(){document.getElementById('edit-user-modal').classList.remove('open');};
window.saveEditUser=async function(){
  const id=document.getElementById('edit-user-id').value;
  const u=users.find(x=>x.id===id);if(!u)return;
  const name=document.getElementById('edit-uname').value.trim();
  const email=document.getElementById('edit-uemail').value.trim();
  const pw=document.getElementById('edit-upw').value.trim();
  const role=document.getElementById('edit-urole').value;
  let viewAll=document.getElementById('edit-uviewall').value;
  if(role==='manager')viewAll='yes';
  const rawEditTlId=role==='employee'?(document.getElementById('edit-uteamlead')?.value||null):null;
  const teamLeaderId=rawEditTlId&&users.find(u=>u.id===rawEditTlId&&u.role==='team_leader')?rawEditTlId:null;
  if(!name){alert('Name is required.');return;}
  const patch={name,email,role,viewAll,teamLeaderId};
  if(pw)patch.password=pw;
  await uUpdate(id,patch);
  await logActivity({type:'user_edited',category:'user',desc:`${me.name} updated user ${name} (${role})`,userId:me.id,userName:me.name,role:me.role});
  if(id!==me.id)pushNotif(id,'✏️ Account Updated',`${me.name} updated your account settings`);
  closeEditUserModal();
  showToastMsg(`✅ ${name} updated`);
};

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

function isOverdue(j){
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
  const mine=jobs.filter(j=>j.owner===me.id&&j.status!=='completed');
  setTabBadge('my-jobs',mine.length);
  const overdue=jobs.filter(j=>isOverdue(j)).length;
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
function renderBoard(){
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
    const a=jobs.filter(j=>j.owner===u.id&&j.status!=='completed').length;
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
  if(canSeeAllJobs())return jobs;
  if(isTeamLeader()){const ids=new Set(myTeamIds());return jobs.filter(j=>ids.has(j.owner));}
  return jobs.filter(j=>j.owner===me.id);
}
function allJobTypesForAnalytics(scope){
  const fromJobs=new Set(scope.map(j=>j.type).filter(Boolean));
  JOB_TYPES.forEach(t=>fromJobs.add(t));
  return [...fromJobs];
}
function renderAnalyticsContent(){
  const el=document.getElementById('analytics-content');if(!el||!me)return;
  const isManager=isLead();
  const showChartTools=isManager;
  const myJobs=analyticsJobs();
  const now=new Date(),ws=new Date(now);ws.setDate(now.getDate()-now.getDay());
  const jobTotal=myJobs.length||1;

  if(currentATab==='overview'){
    const dt=myJobs.filter(j=>j.completed&&new Date(j.completed).toDateString()===now.toDateString()).length;
    const dw=myJobs.filter(j=>j.completed&&new Date(j.completed)>=ws).length;
    const dn=myJobs.filter(j=>j.completed&&j.created);
    const avg=dn.reduce((a,j)=>a+(j.completed-j.created),0)/(dn.length||1);
    el.innerHTML=`<div class="analytics-grid">${[
      ['Pending',myJobs.filter(j=>j.status==='pending').length,'var(--yellow)'],
      ['Ongoing',myJobs.filter(j=>j.status==='ongoing').length,'var(--blue)'],
      ['Paused',myJobs.filter(j=>j.status==='paused').length,'var(--text2)'],
      ['Completed',myJobs.filter(j=>j.status==='completed').length,'var(--green)'],
      ['Done Today',dt,'var(--yellow)'],
      ['Done This Week',dw,'var(--blue)'],
      ['Overdue',myJobs.filter(j=>isOverdue(j)).length,'var(--red)'],
      ['Avg Completion',dn.length?tdiff(0,avg):'—','var(--text2)',true]
    ].map(([l,n,c,small])=>`<div class="sc"><div class="n" style="color:${c};${small?'font-size:1rem;':''}">${n}</div><div class="l">${l}</div></div>`).join('')}</div>`;
  } else if(currentATab==='bytype'){
    const types=allJobTypesForAnalytics(myJobs).filter(t=>myJobs.some(j=>j.type===t));
    const counts=types.map((t,i)=>{const cnt=myJobs.filter(j=>j.type===t).length;return{label:t,value:cnt,color:TYPE_CHART_COLORS[i%TYPE_CHART_COLORS.length],share:jobTotal?Math.round(cnt/jobTotal*100):0};}).filter(r=>r.value>0).sort((a,b)=>b.value-a.value);
    if(showChartTools){
      el.innerHTML=`<div class="analytics-grid">${renderChartBlock('Jobs by Type','bytype',counts,false,true)}</div>`;
    }else{
      const max=Math.max(...counts.map(r=>r.value),1);
      el.innerHTML=`<div class="analytics-grid"><div class="achart achart-wide"><h4>Jobs by Type</h4>${counts.map(r=>`<div class="bar-row"><span class="bar-label" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round(r.value/max*100)}%;background:${r.color};"></div></div><span class="bar-val">${r.value}</span></div>`).join('')}</div></div>`;
    }
  } else if(currentATab==='bypriority'){
    const pris=['High','Medium','Low'];
    const rows=pris.map(p=>{
      const all=myJobs.filter(j=>j.priority===p);
      const done=all.filter(j=>j.status==='completed').length;
      const total=all.length;
      return{label:p,value:total,done,total,rate:total?Math.round(done/total*100):0,color:PRIORITY_CHART_COLORS[p]};
    }).filter(r=>r.total>0);
    if(showChartTools){
      el.innerHTML=`<div class="analytics-grid">${renderChartBlock('Completion Rate by Priority','bypriority',rows,true,true)}</div>`;
    }else{
      const max=Math.max(...rows.map(r=>r.total),1);
      el.innerHTML=`<div class="analytics-grid"><div class="achart achart-wide"><h4>Jobs by Priority</h4>${rows.map(r=>`<div class="bar-row"><span class="bar-label">${r.label}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round(r.total/max*100)}%;background:${r.color};"></div></div><span class="bar-val">${r.total}</span></div>`).join('')}</div></div>`;
    }
  } else if(currentATab==='completion'){
    const total=myJobs.length||1;
    const done=myJobs.filter(j=>j.status==='completed').length;
    const rate=Math.round(done/total*100);
    const byMonth={};
    myJobs.filter(j=>j.completed).forEach(j=>{const d=new Date(j.completed);const k=d.toLocaleString('en-GB',{month:'short',year:'numeric'});byMonth[k]=(byMonth[k]||0)+1;});
    const months=Object.entries(byMonth).slice(-6);
    const maxM=Math.max(...months.map(x=>x[1]),1);
    const pris=['High','Medium','Low'];
    const priRows=pris.map(p=>{
      const all=myJobs.filter(j=>j.priority===p);
      const d=all.filter(j=>j.status==='completed').length;
      const t=all.length;
      return{label:p,value:t,done:d,total:t,rate:t?Math.round(d/t*100):0,color:PRIORITY_CHART_COLORS[p]};
    }).filter(r=>r.total>0);
    let priBlock='';
    if(showChartTools&&priRows.length){
      priBlock=renderChartBlock('Completion Rate by Priority','bypriority',priRows,true);
    }else if(priRows.length){
      priBlock=`<div class="achart"><h4>Completion by Priority</h4>${priRows.map(r=>`<div class="bar-row"><span class="bar-label">${r.label}</span><div class="bar-track"><div class="bar-fill" style="width:${r.rate}%;background:${r.color};"></div></div><span class="bar-val">${r.rate}% (${r.done}/${r.total})</span></div>`).join('')}</div>`;
    }
    const monthChart=months.length?`<div class="achart"><h4>Completions by Month</h4>${months.map(([m,c])=>`<div class="bar-row"><span class="bar-label">${m}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round(c/maxM*100)}%;background:var(--green);"></div></div><span class="bar-val">${c}</span></div>`).join('')}</div>`:'';
    el.innerHTML=`<div class="analytics-grid">
      <div class="achart"><h4>Overall Completion</h4><div style="text-align:center;font-size:2.5rem;font-weight:600;font-family:var(--mono);color:${rate>=70?'var(--green)':rate>=40?'var(--yellow)':'var(--red)'};">${rate}%</div><div style="text-align:center;color:var(--text2);font-size:0.8rem;margin-top:0.5rem;">${done} of ${total} jobs</div></div>
      ${priBlock}${monthChart}
    </div>`;
  } else if(currentATab==='employee'&&isManager){
    const emps=users.filter(u=>u.role!=='manager');
    const max=Math.max(...emps.map(u=>jobs.filter(j=>j.owner===u.id).length),1);
    el.innerHTML=`<div class="analytics-grid">
      <div class="achart"><h4>Total Jobs by Employee</h4>${emps.map(u=>{const cnt=jobs.filter(j=>j.owner===u.id).length;return`<div class="bar-row"><span class="bar-label">${escapeHtml(u.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round(cnt/max*100)}%;background:var(--purple);"></div></div><span class="bar-val">${cnt}</span></div>`;}).join('')}</div>
      <div class="achart"><h4>Active Jobs by Employee</h4>${emps.map(u=>{const cnt=jobs.filter(j=>j.owner===u.id&&j.status!=='completed').length;const col=cnt>=5?'var(--red)':cnt>=3?'var(--yellow)':'var(--green)';return`<div class="bar-row"><span class="bar-label">${escapeHtml(u.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round(cnt/6*100)}%;background:${col};"></div></div><span class="bar-val">${cnt}</span></div>`;}).join('')}</div>
    </div>`;
  } else if(currentATab==='performance'&&isManager){
    const emps=users.filter(u=>u.role!=='manager');
    el.innerHTML=`<div class="perf-grid">${emps.map(u=>{
      const ej=jobs.filter(j=>j.owner===u.id);
      const done=ej.filter(j=>j.completed&&j.created);
      const avg=done.reduce((a,j)=>a+(j.completed-j.created),0)/(done.length||1);
      const od=ej.filter(j=>isOverdue(j)).length;
      const now2=new Date(),ws2=new Date(now2);ws2.setDate(now2.getDate()-now2.getDay());
      const thisWeek=ej.filter(j=>j.completed&&new Date(j.completed)>=ws2).length;
      return`<div class="perf-block"><h4>👤 ${escapeHtml(u.name)} <span class="bdg bdg-${u.role==='supervisor'?'sup':'l'}">${u.role}</span></h4>
        <div class="perf-row"><span>Total</span><span>${ej.length}</span></div>
        <div class="perf-row"><span>Done</span><span>${ej.filter(j=>j.status==='completed').length}</span></div>
        <div class="perf-row"><span>Active</span><span>${ej.filter(j=>j.status!=='completed').length}</span></div>
        <div class="perf-row"><span>This Week</span><span>${thisWeek}</span></div>
        <div class="perf-row"><span>Overdue</span><span style="color:${od?'var(--red)':'var(--green)'}">${od}</span></div>
        <div class="perf-row"><span>Avg Time</span><span style="font-size:0.72rem;">${done.length?tdiff(0,avg):'—'}</span></div>
      </div>`;
    }).join('')}</div>`;
  }
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
  let res=jobs;
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

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
function renderDashboard(){
  if(!me||!['manager','supervisor','team_leader'].includes(me.role))return;
  const root=document.getElementById('dash-root');
  if(!root)return;
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
function dashRelTime(ts){
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
function renderDashExtensions(){
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
function showToastMsg(msg){
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
const HUB_DEFAULTS={jobs:'my-jobs',team:'board',insights:'overview',messages:'broadcast',account:'profile'};
const SUB_TO_SECTION={
  'my-jobs':'my-jobs','add-job':'add-job',board:'board',cal:'cal',assign:'assign',
  overview:'dashboard',reports:'analytics',search:'adv-search',extensions:'extensions-review',activity:'login-log',
  broadcast:'broadcast',profile:'account',preferences:'account',users:'users','activity-log':'login-log',
  teams:'teams-overview'
};
const SECTION_TO_SB={
  'my-jobs':'my-jobs','add-job':'my-jobs',
  board:'board',cal:'cal',assign:'assign',
  dashboard:'dashboard','extensions-review':'extensions-review',
  analytics:'analytics','adv-search':'adv-search',
  broadcast:'broadcast',account:'account',users:'users','login-log':'login-log',
  'teams-overview':'teams-overview'
};
const SB_TO_HUB={
  'my-jobs':['jobs','my-jobs'],assign:['team','assign'],
  board:['team','board'],cal:['team','cal'],
  dashboard:['insights','overview'],'extensions-review':['insights','extensions'],
  analytics:['insights','reports'],'adv-search':['insights','search'],
  broadcast:['messages','broadcast'],account:['account','profile'],
  users:['account','users'],'login-log':['account','activity-log'],
  'teams-overview':['insights','teams']
};
function applyMainNav(){
  const r=me?.role||'';
  const isManager=r==='manager';
  const isTeam=['manager','supervisor','team_leader'].includes(r);
  const isLeadNav=['manager','supervisor','team_leader'].includes(r);
  document.querySelectorAll('.sb-assign').forEach(el=>el.style.display=isTeam?'flex':'none');
  document.querySelectorAll('.sb-team').forEach(el=>el.style.display=isTeam?'block':'none');
  document.querySelectorAll('.sb-ext').forEach(el=>el.style.display=isTeam?'flex':'none');
  document.querySelectorAll('.sb-lead').forEach(el=>el.style.display=isLeadNav?'flex':'none');
  document.querySelectorAll('.sb-manager').forEach(el=>el.style.display=isManager?'flex':'none');
  document.querySelectorAll('.sb-admin').forEach(el=>el.style.display=isManager?'flex':'none');
  const topbar=document.querySelector('.topbar');
  if(topbar)topbar.style.display=currentHub==='jobs'?'flex':'none';
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
  if(id==='users')refreshUsersRemote();
  if(id==='login-log')refreshActivityLogsRemote();
  if(id==='broadcast'){updateBroadcastUI();refreshBroadcastsRemote();setTimeout(markBroadcastsSeen,1200);}
  if(id==='account'){renderAccountProfile();renderAccountPreferences();}
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
  if(['manager','supervisor','team_leader'].includes(me.role)){
    if(document.getElementById('dashboard')?.classList.contains('on'))renderDashboard();
    if(document.getElementById('login-log')?.classList.contains('on'))renderActivityLog();
  }
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
    if(emailPref('emailDeadline'))emailUser(j.owner,`Deadline Soon: ${label}`,emailBody);
    // T5: email oversight (TL + managers/supervisors)
    if(emailPref('emailDeadline')){emailTeamLeaderOf(j.owner,`Team Deadline Soon: ${label}`,emailBody);emailManagersAndSupervisors(`Deadline Soon: ${label}`,emailBody);}
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
    if(emailPref('emailOverdue')){emailUser(j.owner,`Overdue Job: ${label}`,emailBody);emailTeamLeaderOf(j.owner,`Overdue Job (Team): ${label}`,emailBody);emailManagersAndSupervisors(`Overdue Job: ${label}`,emailBody);}
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
  const old=jobs.filter(j=>j.status==='completed'&&j.completed&&toMillis(j.completed)<cut);
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
let analyticsRange='month',analyticsEmp='',analyticsType='';
function analyticsRangeStart(range){
  const n=new Date();
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
    <svg width="140" height="140" viewBox="0 0 140 140">${svg||'<circle cx="70" cy="70" r="60" fill="var(--card2)"/>'}<circle cx="70" cy="70" r="34" fill="var(--card)"/><text x="70" y="66" text-anchor="middle" class="an-donut-num">${centerNum}</text><text x="70" y="82" text-anchor="middle" class="an-donut-lbl">${centerLbl}</text></svg>
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
  return`<div class="an-trend"><svg viewBox="0 0 ${W} ${H+18}" width="${W}" height="${H+18}" preserveAspectRatio="xMidYMid meet" style="overflow:visible;max-width:100%;display:block;">
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
    <svg viewBox="0 0 ${W} ${H+18}" width="${W}" height="${H+18}" preserveAspectRatio="xMidYMid meet" style="overflow:visible;max-width:100%;display:block;">
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
    const tj=jobs.filter(j=>memberIds.has(j.owner));
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
      const mj=jobs.filter(j=>j.owner===m.id);
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

renderAnalyticsContent=function(){
  const el=document.getElementById('analytics-content');if(!el||!me)return;
  // show Teams tab for managers only
  document.querySelectorAll('.sb-manager-tab').forEach(b=>b.style.display=me.role==='manager'?'':'none');
  // teams view
  if(analyticsView==='teams'){renderTeamsAnalytics(el);return;}
  anPopulateEmp();anPopulateType();
  const isMgr=isLead();
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
  let turnHtml='';
  if(turnRows.length){
    turnHtml=`<div class="an-widget"><div class="an-widget-hd">Turnaround by Type <span class="an-hd-note">avg time to complete</span></div>
      <div class="an-turn">${turnRows.map(r=>`<div class="an-turn-row"><span class="an-turn-type">${escapeHtml(r.type)}</span><span class="an-turn-time">${tdiff(0,r.avg)}</span><span class="an-turn-n">${r.n} job${r.n>1?'s':''}</span></div>`).join('')}</div></div>`;
  }
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
  const jobAnalysisHtml=`
    <div class="an-row-2">
      <div class="an-widget"><div class="an-widget-hd">Created vs Completed <span class="an-hd-note">last 6 ${byMonth?'months':'weeks'}</span></div>${anDualLineChart(createdPts,trendPts,'Created','Completed','var(--blue)','var(--green)')}</div>
      ${priRows.length?`<div class="an-widget"><div class="an-widget-hd">Completion Rate by Priority</div>${anBars(priRows,{rate:true})}</div>`:''}
    </div>
    <div class="an-row-2">
      <div class="an-widget"><div class="an-widget-hd">Job Age <span class="an-hd-note">active jobs by how long open</span></div>${anBars(ageRows)}${oldestActive.length?`<div class="an-hd-note" style="margin-top:0.75rem;margin-bottom:0.35rem;">Oldest active jobs</div>${oldestActive.map(j=>{const age=nowMs-toMillis(j.created);const col=age>14*864e5?'var(--red)':age>7*864e5?'var(--orange)':'var(--text2)';const own=users.find(u=>u.id===j.owner)?.name||'?';return`<div class="an-turn-row"><span class="an-turn-type">${escapeHtml(j.client)} <span class="tc-muted">#${escapeHtml(j.jobNum)}</span></span><span class="an-turn-time" style="color:${col}">${tdiff(0,age)}</span><span class="an-turn-n">${escapeHtml(own)}</span></div>`;}).join('')}`:''}
      </div>
      <div class="an-widget"><div class="an-widget-hd">Priority vs Actual Urgency <span class="an-hd-note">% overdue per priority</span></div>${priUrgency.map(p=>`<div class="an-bar-row"><span class="an-bar-label">${p.label}</span><div class="an-bar-track"><div class="an-bar-fill" style="width:${Math.max(p.pct,p.overdueCount?2:0)}%;background:${p.color}"></div></div><span class="an-bar-val">${p.pct}% <span class="tc-muted">${p.overdueCount}/${p.active}</span></span></div>`).join('')}${priUrgency.every(p=>p.pct===0)?'<div class="empty" style="padding:0.5rem;">No overdue jobs 🎉</div>':''}</div>
    </div>
    <div class="an-row-2">
      <div class="an-widget"><div class="an-widget-hd">Peak Workload Days <span class="an-hd-note" style="display:inline-flex;gap:0.5rem;"><span style="color:var(--blue)">■ created</span><span style="color:var(--green)">■ completed</span></span></div><div class="an-day-chart">${dayNames.map((d,i)=>dayBarRow(d,createdByDay[i],completedByDay[i],maxDay)).join('')}</div></div>
      <div class="an-widget"><div class="an-widget-hd">Deadline Extension Rate</div><div style="text-align:center;padding:0.75rem 0;"><div style="font-size:2.2rem;font-weight:700;font-family:var(--mono);color:${extRate>=30?'var(--red)':extRate>=15?'var(--yellow)':'var(--green)'}">${extRate}%</div><div style="color:var(--text2);font-size:0.78rem;margin-top:0.25rem;">${jobIdsWithExt.size} of ${jobsWithDl.length} jobs with deadlines requested extensions</div></div><div class="an-bars" style="margin-top:0.5rem;">${anBars([{label:'Approved',value:extApproved,color:'var(--green)'},{label:'Rejected',value:extRejected,color:'var(--red)'},{label:'Pending',value:extPending,color:'var(--yellow)'}].filter(r=>r.value>0))}</div></div>
    </div>
    ${turnHtml}
    ${topReassigned.length?`<div class="an-widget"><div class="an-widget-hd">Most Reassigned Jobs <span class="an-hd-note">times reassigned</span></div>${anBars(topReassigned)}</div>`:''}
  `;

  const isEmp=me.role==='employee';
  const isTL_=isTeamLeader();
  const isSup=me.role==='supervisor';
  const leadEmps=teamUsersForView().filter(u=>u.role!=='manager');

  // ── EMPLOYEE ──────────────────────────────────────────────────────────────
  if(isEmp){
    el.innerHTML=`
      ${kpiHtml}
      <div class="an-row-2">
        <div class="an-widget"><div class="an-widget-hd">Status Breakdown</div>${anDonut(statusData,total,'jobs')}</div>
        ${typeRows.length?`<div class="an-widget"><div class="an-widget-hd">My Jobs by Type</div>${anBars(typeRows)}</div>`:''}
      </div>
      <div class="an-row-2">
        <div class="an-widget"><div class="an-widget-hd">My Completion Trend <span class="an-hd-note">last 6 ${byMonth?'months':'weeks'}</span></div>${anTrendChart(trendPts)}</div>
        ${anSpeedVsTeam(me.id,visibleJobs())}
      </div>
      ${anMyRankCard(me.id,visibleJobs())}
      ${jobAnalysisHtml}`;
    return;
  }

  // ── TEAM LEADER ───────────────────────────────────────────────────────────
  if(isTL_){
    el.innerHTML=`
      ${kpiHtml}
      <div class="an-row-2">
        <div class="an-widget"><div class="an-widget-hd">Status Breakdown</div>${anDonut(statusData,total,'jobs')}</div>
        ${throughputHtml}
      </div>
      <div class="an-row-2">
        ${anTeamHealthWidget(leadEmps,visibleJobs())}
        ${anActiveVsPausedWidget(leadEmps,visibleJobs())}
      </div>
      ${anOverdueTrendWidget(visibleJobs(),buckets)}
      ${perfHtml}
      ${jobAnalysisHtml}`;
    return;
  }

  // ── SUPERVISOR ────────────────────────────────────────────────────────────
  if(isSup){
    el.innerHTML=`
      ${kpiHtml}
      <div class="an-row-2">
        <div class="an-widget"><div class="an-widget-hd">Status Breakdown</div>${anDonut(statusData,total,'jobs')}</div>
        ${throughputHtml}
      </div>
      <div class="an-row-2">
        ${anTeamHealthWidget(leadEmps,visibleJobs())}
        ${anActiveVsPausedWidget(leadEmps,visibleJobs())}
      </div>
      ${anOverdueTrendWidget(visibleJobs(),buckets)}
      ${anCrossTeamTypeWidget()}
      ${perfHtml}
      ${jobAnalysisHtml}`;
    return;
  }

  // ── MANAGER ───────────────────────────────────────────────────────────────
  el.innerHTML=`
    ${kpiHtml}
    <div class="an-row-2">
      <div class="an-widget"><div class="an-widget-hd">Status Breakdown</div>${anDonut(statusData,total,'jobs')}</div>
      ${throughputHtml}
    </div>
    <div class="an-row-2">
      ${anTeamHealthWidget(leadEmps,visibleJobs())}
      ${anActiveVsPausedWidget(leadEmps,visibleJobs())}
    </div>
    ${anOverdueTrendWidget(visibleJobs(),buckets)}
    ${anCrossTeamTypeWidget()}
    ${perfHtml}
    ${jobAnalysisHtml}`;
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
  if(!me||me.role!=='manager'){root.innerHTML='<div class="empty" style="padding:2rem;">Manager access only.</div>';return;}
  const tls=users.filter(u=>u.role==='team_leader');
  if(!tls.length){root.innerHTML='<div class="empty" style="padding:2rem;">No team leaders yet. Add team leaders in Manage Users.</div>';return;}

  const nowD=new Date(),ws=new Date(nowD);ws.setDate(nowD.getDate()-nowD.getDay());ws.setHours(0,0,0,0);
  const nowMs=Date.now();

  // build data per team
  const teams=tls.map(tl=>{
    const members=users.filter(u=>u.teamLeaderId===tl.id);
    const memberIds=new Set([tl.id,...members.map(u=>u.id)]);
    const tj=jobs.filter(j=>memberIds.has(j.owner));
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
      const mj=jobs.filter(j=>j.owner===m.id&&j.status!=='completed');
      const mOd=jobs.filter(j=>j.owner===m.id&&isOverdue(j));
      const mDone=jobs.filter(j=>j.owner===m.id&&j.status==='completed').length;
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