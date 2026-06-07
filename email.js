// ── EMAILJS ───────────────────────────────────────────────────────────────────
// Client-side email via EmailJS (global `emailjs` loaded from CDN in index.html).
import { USE_FIREBASE } from './firebase.js';
import { users, me, userSettings, emailConfig } from './state.js';

const EJS_SERVICE='service_s2xci8q';
const EJS_TEMPLATE='template_4as1q75';
const EJS_KEY='6SLEjcO01n04FBRGc';

export function sendEmail(toEmail,subject,message,prefKey){
  if(!toEmail||!USE_FIREBASE)return;
  if(typeof emailjs==='undefined')return;
  // HARD KILL-SWITCH: master off → nothing sends, regardless of caller path.
  if(emailConfig?.master===false)return;
  // check sender's own pref — only block if the email is TO the current user
  if(prefKey&&toEmail===me?.email&&userSettings[prefKey]===false)return;
  emailjs.send(EJS_SERVICE,EJS_TEMPLATE,{to_email:toEmail,subject,message},EJS_KEY).catch(()=>{});
}
export function emailPref(key){return userSettings[key]!==false;}
export function emailUser(userId,subject,message,exceptIds=[]){
  if(!userId||exceptIds.includes(userId))return;
  const u=users.find(x=>x.id===userId);
  if(u?.email)sendEmail(u.email,subject,message);
}
export function emailJobOwner(j,subject,message,exceptIds=[]){
  if(j?.owner)emailUser(j.owner,subject,message,exceptIds);
}
export function emailManagersAndSupervisors(subject,message,exceptIds=[]){
  users.filter(u=>['manager','supervisor'].includes(u.role)&&!exceptIds.includes(u.id)&&u.email)
    .forEach(u=>sendEmail(u.email,subject,message));
}
export function emailTeamLeaderOf(ownerId,subject,message,exceptIds=[]){
  const tl=users.find(u=>u.role==='team_leader'&&users.filter(x=>x.teamLeaderId===u.id).some(x=>x.id===ownerId));
  if(tl&&!exceptIds.includes(tl.id)&&tl.email)sendEmail(tl.email,subject,message);
}
export function emailAllOversight(j,subject,message,exceptIds=[]){
  emailManagersAndSupervisors(subject,message,exceptIds);
  if(j?.owner)emailTeamLeaderOf(j.owner,subject,message,exceptIds);
}

// ── ORG-WIDE GATING (manager Email Control panel) ─────────────────────────────
// Cascade: master must be on → event.on → per-recipient flag.
function gMaster(){return emailConfig?.master!==false;}
function gEvent(evt){return gMaster()&&emailConfig?.events?.[evt]?.on!==false;}
function gRecip(evt,recip){return gEvent(evt)&&emailConfig?.events?.[evt]?.[recip]!==false;}
function emailRole(role,subject,message,exceptIds=[]){
  users.filter(u=>u.role===role&&!exceptIds.includes(u.id)&&u.email).forEach(u=>sendEmail(u.email,subject,message));
}

// Event-aware senders — each checks the org config before delegating.
export function emailEventOwner(evt,j,subject,message,exceptIds=[]){
  if(gRecip(evt,'owner'))emailJobOwner(j,subject,message,exceptIds);
}
export function emailEventOwnerId(evt,userId,subject,message,exceptIds=[]){
  if(gRecip(evt,'owner'))emailUser(userId,subject,message,exceptIds);
}
export function emailEventTeamLeader(evt,ownerId,subject,message,exceptIds=[]){
  if(gRecip(evt,'teamLeader'))emailTeamLeaderOf(ownerId,subject,message,exceptIds);
}
export function emailEventManagers(evt,subject,message,exceptIds=[]){
  if(gRecip(evt,'manager'))emailRole('manager',subject,message,exceptIds);
}
export function emailEventSupervisors(evt,subject,message,exceptIds=[]){
  if(gRecip(evt,'supervisor'))emailRole('supervisor',subject,message,exceptIds);
}
// managers + supervisors + the owner's team leader, each independently gated.
export function emailEventOversight(evt,j,subject,message,exceptIds=[]){
  emailEventManagers(evt,subject,message,exceptIds);
  emailEventSupervisors(evt,subject,message,exceptIds);
  if(j?.owner)emailEventTeamLeader(evt,j.owner,subject,message,exceptIds);
}
