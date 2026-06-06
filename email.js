// ── EMAILJS ───────────────────────────────────────────────────────────────────
// Client-side email via EmailJS (global `emailjs` loaded from CDN in index.html).
import { USE_FIREBASE } from './firebase.js';
import { users, me, userSettings } from './state.js';

const EJS_SERVICE='service_s2xci8q';
const EJS_TEMPLATE='template_4as1q75';
const EJS_KEY='N_HEKFKra4RbkbfFA';

export function sendEmail(toEmail,subject,message,prefKey){
  if(!toEmail||!USE_FIREBASE)return;
  if(typeof emailjs==='undefined')return;
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
