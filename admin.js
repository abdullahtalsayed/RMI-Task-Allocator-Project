// ── ADMIN: BROADCASTS + USER MANAGEMENT ───────────────────────────────────────
// Announcements (compose/list/edit/delete + unread badge) and user CRUD UI
// (add/edit/remove users, role pickers, team-leader assignment).
import { USE_FIREBASE, USE_AUTH, addDoc, doc, updateDoc, deleteDoc } from './firebase.js';
import { me, users, broadcasts, jobs, setBroadcasts, BRANCHES } from './state.js';
import { uid, toMillis, fmt, escapeHtml } from './helpers.js';
import { uAdd, uUpdate, uDelete } from './jobs.js';
import { showConfirm } from './modals.js';
import { bcastCol, isTeamLeader, logActivity, refreshBroadcastsRemote, pushNotif, dashRelTime, showToastMsg, localSave, amDirector, isDirectorRole } from './main.js';

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
  const toLabel=to==='all'?'everyone':to==='employees'?'employees':to==='supervisors'?'supervisors':to.startsWith('team:')?'my team':to.startsWith('branch:')?to.slice(7):to;
  await logActivity({type:'broadcast',category:'broadcast',desc:`${me.name} sent message to ${toLabel}: ${msg.slice(0,120)}${msg.length>120?'…':''}`,userId:me.id,userName:me.name,role:me.role});
  // Push notifications
  let targets=users;
  if(to==='employees')targets=users.filter(u=>u.role==='employee'||u.role==='team_leader'||u.role==='sales_operation');
  else if(to==='supervisors')targets=users.filter(u=>u.role==='supervisor');
  else if(to.startsWith('team:')){const lid=to.slice(5);targets=users.filter(u=>u.teamLeaderId===lid||u.id===lid);}
  else if(to.startsWith('branch:')){const br=to.slice(7);targets=users.filter(u=>u.branch===br);}
  targets.filter(u=>u.id!==me.id&&!isDirectorRole(u.role)).forEach(u=>pushNotif(u.id,'📢 Message from '+me.name,msg));
  document.getElementById('bcast-msg').value='';
  showToastMsg('Message sent!');
};
export function broadcastsForUser(u){
  if(!u)return[];
  if(u.role==='manager')return broadcasts;
  return broadcasts.filter(b=>{
    if(b.to==='all')return true;
    if(b.to==='employees'&&(u.role==='employee'||u.role==='team_leader'||u.role==='sales_operation'))return true;
    if(b.to==='supervisors'&&u.role==='supervisor')return true;
    // team-scoped: team:${leaderId}
    if(b.to&&b.to.startsWith('team:')){
      const leaderId=b.to.slice(5);
      if(u.id===leaderId)return true;
      if(u.teamLeaderId===leaderId)return true;
    }
    // branch-scoped: branch:${branchName}
    if(b.to&&b.to.startsWith('branch:')){
      const br=b.to.slice(7);
      if(u.branch===br)return true;
    }
    return false;
  });
}
window.setBcastAudience=function(to,btn){
  const sel=document.getElementById('bcast-to');if(sel)sel.value=to;
  document.querySelectorAll('.msg-aud-pill').forEach(b=>b.classList.toggle('on',b.dataset.to===to));
};
export function bcastMsgLastSeen(){return parseInt(localStorage.getItem('rmi_bcast_seen_'+(me?.id||''))||'0',10);}
export function markBroadcastsSeen(){
  if(!me)return;
  const latest=Math.max(0,...broadcastsForUser(me).map(b=>toMillis(b.created)));
  localStorage.setItem('rmi_bcast_seen_'+me.id,String(latest));
  updateMsgBadge();
}
export function unreadBroadcastCount(){
  if(!me)return 0;
  const seen=bcastMsgLastSeen();
  return broadcastsForUser(me).filter(b=>toMillis(b.created)>seen&&b.byId!==me.id).length;
}
export function updateMsgBadge(){
  const badge=document.getElementById('sb-msg-badge');if(!badge)return;
  const n=unreadBroadcastCount();
  badge.style.display=n>0?'inline-block':'none';
  badge.textContent=n;
}
export function updateBroadcastUI(){
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
    // Branch pills — inject once for manager
    const aud=compose.querySelector('.msg-audience');
    if(aud&&isMgr&&!aud.querySelector('.msg-aud-pill[data-to^="branch:"]')){
      const sel=document.getElementById('bcast-to');
      BRANCHES.forEach(br=>{
        const key=`branch:${br}`;
        const btn=document.createElement('button');
        btn.type='button';btn.className='msg-aud-pill';btn.dataset.to=key;
        btn.textContent='🌍 '+br;
        btn.onclick=()=>window.setBcastAudience(key,btn);
        aud.appendChild(btn);
        if(sel){const opt=document.createElement('option');opt.value=key;opt.textContent=br;sel.appendChild(opt);}
      });
    }
  }
  const hint=document.getElementById('broadcast-hint');
  if(hint)hint.style.display=canCompose?'none':'block';
  const msg=document.getElementById('bcast-msg');
  if(msg&&!msg._bound){msg._bound=true;msg.addEventListener('input',()=>{const c=document.getElementById('bcast-charcount');if(c)c.textContent=msg.value.length?msg.value.length+' chars':'';});}
  updateMsgBadge();
}
export function broadcastDayLabel(ts){
  const d=new Date(toMillis(ts));d.setHours(0,0,0,0);
  const today=new Date();today.setHours(0,0,0,0);
  const diff=Math.round((today-d)/86400000);
  if(diff===0)return'Today';
  if(diff===1)return'Yesterday';
  return d.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
}
export function renderBroadcasts(){
  const el=document.getElementById('bcast-list');if(!el||!me)return;
  const visible=[...broadcastsForUser(me)].sort((a,b)=>toMillis(b.created)-toMillis(a.created));
  const isMgr=me.role==='manager';
  const seen=bcastMsgLastSeen();
  if(!visible.length){el.innerHTML='<div class="empty" style="padding:2.5rem;text-align:center;">No announcements yet.</div>';return;}
  let html='',lastDay=null;
  visible.forEach(b=>{
    const day=broadcastDayLabel(b.created);
    if(day!==lastDay){html+=`<div class="msg-day-hd">${day}</div>`;lastDay=day;}
    const toLbl=b.to==='all'?'👥 Everyone':b.to==='employees'?'👤 Employees':b.to==='supervisors'?'🔰 Supervisors':(b.to&&b.to.startsWith('branch:'))?'🌍 '+escapeHtml(b.to.slice(7)):(b.to&&b.to.startsWith('team:'))?'🧭 Team':escapeHtml(b.to||'');
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
  const branch=document.getElementById('ubranch')?.value||'';
  const id=name.toLowerCase().replace(/\s+/g,'_')+'_'+Date.now();
  const data=USE_AUTH
    ?{id,name,role,email,viewAll,teamLeaderId,branch,needsActivation:true,tempPassword:pw}
    :{id,name,role,password:pw,email,viewAll,teamLeaderId,branch};
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
export function roleMeta(role){
  if(role==='managing_director')return{icon:'🎩',bdg:'md',label:'Managing Director'};
  if(role==='executive_director')return{icon:'🎖️',bdg:'ed',label:'Executive Director'};
  if(role==='manager')return{icon:'👔',bdg:'m',label:'Manager'};
  if(role==='sales_operation')return{icon:'💼',bdg:'so',label:'Sales Operation'};
  if(role==='supervisor')return{icon:'🔰',bdg:'sup',label:'Supervisor'};
  if(role==='team_leader')return{icon:'🧭',bdg:'tl',label:'Team Leader'};
  return{icon:'👤',bdg:'l',label:'Employee'};
}
// fill a <select> with team_leader users; keep current value if given
export function populateTeamLeadSelect(selId,current){
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
  const br=document.getElementById('ubranch');if(br)br.value='';
  populateTeamLeadSelect('u-teamlead','');
  onRoleChange('add');
  document.getElementById('add-user-modal').classList.add('open');
};
window.closeAddUserModal=function(){document.getElementById('add-user-modal').classList.remove('open');};
export function renderUList(){
  const el=document.getElementById('ulist');if(!el)return;
  const ro=amDirector(); // directors get a read-only directory (no add/edit/remove)
  const addBtn=document.getElementById('add-user-btn');if(addBtn)addBtn.style.display=ro?'none':'';
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
  const order={managing_director:0,executive_director:1,manager:2,sales_operation:3,supervisor:4,team_leader:5,employee:6};
  const roleGroups=[
    {roles:['managing_director','executive_director'],label:'Directors',grid:false},
    {roles:['manager'],label:'Managers',grid:false},
    {roles:['sales_operation'],label:'Sales Operation',grid:false},
    {roles:['supervisor'],label:'Supervisors',grid:false},
    {roles:['team_leader'],label:'Team Leaders',grid:false},
    {roles:['employee'],label:'Employees',grid:true},
  ];
  function branchBdg(branch){
    if(!branch)return'';
    let cls='';
    if(branch.includes('Syria'))cls='bdg-br-sy';
    else if(branch.includes('UAE'))cls='bdg-br-uae';
    else if(branch.includes('India'))cls='bdg-br-in';
    else cls='bdg-br-sy';
    return`<span class="bdg-br ${cls}">${escapeHtml(branch)}</span>`;
  }
  function userCard(u){
    const rmeta=roleMeta(u.role);
    const bdg=rmeta.bdg;
    const initial=(u.name||'?').trim().charAt(0).toUpperCase();
    const active=jobs.filter(j=>j.owner===u.id&&j.status!=='completed').length;
    const status=u.authUid?'<span class="user-status us-active">● Active</span>':(u.needsActivation?'<span class="user-status us-pending">● Pending</span>':'<span class="user-status us-active">● Active</span>');
    const rm=(!ro&&u.id!==me?.id)?`<button class="user-act user-act-danger" onclick="removeUser('${u.id}')">Remove</button>`:'';
    let teamMeta='';
    if(u.role==='employee'&&u.teamLeaderId){const tl=users.find(x=>x.id===u.teamLeaderId);if(tl)teamMeta=` · 🧭 ${escapeHtml(tl.name)}`;}
    else if(u.role==='team_leader'){const n=users.filter(x=>x.teamLeaderId===u.id).length;teamMeta=` · 👥 ${n} member${n!==1?'s':''}`;}
    return`<div class="user-row">
      <div class="user-avatar user-av-${bdg}">${escapeHtml(initial)}</div>
      <div class="user-info">
        <div class="user-name-row">${escapeHtml(u.name)} <span class="bdg bdg-${bdg}">${rmeta.label}</span>${branchBdg(u.branch)}</div>
        <div class="user-meta">${u.email?`✉️ ${escapeHtml(u.email)}`:'<span class="tc-muted">no email</span>'} · ${u.viewAll==='yes'?'All jobs':'Own only'}${teamMeta}</div>
      </div>
      <div class="user-stat"><span class="user-stat-n">${active}</span><span class="user-stat-l">active</span></div>
      ${status}
      <div class="user-actions">
        ${ro?'':`<button class="user-act" onclick="openEditUserModal('${u.id}')">✏️ Edit</button>`}
        ${rm}
      </div>
    </div>`;
  }
  let allList=[...users].sort((a,b)=>(order[a.role]??9)-(order[b.role]??9)||(a.name||'').localeCompare(b.name||''));
  if(q)allList=allList.filter(u=>(u.name||'').toLowerCase().includes(q)||(u.email||'').toLowerCase().includes(q));
  if(!allList.length){el.innerHTML='<div class="empty" style="padding:2rem;">No users match.</div>';return;}
  const groupsHtml=roleGroups.map(g=>{
    const members=allList.filter(u=>g.roles.includes(u.role));
    if(!members.length)return'';
    const gid='ug-'+g.roles[0];
    return`<div class="user-group">
      <div class="user-group-hdr" onclick="(function(el){const b=el.nextElementSibling;b.style.display=b.style.display==='none'?'':'none';el.querySelector('.user-group-chevron').style.transform=b.style.display==='none'?'rotate(-90deg)':'rotate(0deg)'})(this)">
        ${g.label}<span class="user-group-count">${members.length}</span>
        <span class="user-group-chevron" style="transform:rotate(-90deg)">▾</span>
      </div>
      <div class="user-group-body${g.grid?' grid2':''}" id="${gid}" style="display:none;">
        ${members.map(u=>userCard(u)).join('')}
      </div>
    </div>`;
  }).join('');
  el.innerHTML=`<div class="user-list">${groupsHtml}</div>`;
}
window.openEditUserModal=function(id){
  const u=users.find(x=>x.id===id);if(!u)return;
  document.getElementById('edit-user-id').value=id;
  document.getElementById('edit-uname').value=u.name||'';
  document.getElementById('edit-uemail').value=u.email||'';
  document.getElementById('edit-upw').value='';
  document.getElementById('edit-urole').value=u.role||'employee';
  document.getElementById('edit-uviewall').value=u.viewAll==='yes'?'yes':'no';
  const ebr=document.getElementById('edit-ubranch');if(ebr)ebr.value=u.branch||'';
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
  const branch=document.getElementById('edit-ubranch')?.value||'';
  const patch={name,email,role,viewAll,teamLeaderId,branch};
  if(pw)patch.password=pw;
  await uUpdate(id,patch);
  await logActivity({type:'user_edited',category:'user',desc:`${me.name} updated user ${name} (${role})`,userId:me.id,userName:me.name,role:me.role});
  if(id!==me.id)pushNotif(id,'✏️ Account Updated',`${me.name} updated your account settings`);
  closeEditUserModal();
  showToastMsg(`✅ ${name} updated`);
};
