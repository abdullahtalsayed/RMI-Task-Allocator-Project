// ── SHARED STATE + CONSTANTS ──────────────────────────────────────────────────
// Mutable state lives here as `export let` (live bindings). Other modules READ via
// import; they REASSIGN only through the setters below (can't reassign an import).

export const JOB_TYPES=[
  'Panels Release','Flashings Release','Accessories Release','Purlins Release',
  'Panels + Flashings Release','Panels + Accessories Release','Flashings + Accessories Release',
  'Panels + Flashings + Accessories Release','Full Job Release','Shop Drawing',
  'Editing Internally','Editing Revision','Erection Drawing','Civil Defense','BOM','Other'
];

export const ACTIVITY_TYPE_LABELS={
  login:'Login',logout:'Logout',created:'Job Created',assigned:'Job Assigned',started:'Job Started',
  completed:'Job Completed',paused:'Job Paused',resumed:'Job Resumed',edited:'Job Edited',deleted:'Job Deleted',restored:'Job Restored',
  pinned:'Job Pinned',reassigned:'Job Reassigned',bulk_edit:'Bulk Status Change',
  extension_request:'Extension Request',ext_approved:'Extension Approved',ext_rejected:'Extension Rejected',
  comment:'Comment',broadcast:'Broadcast',user_added:'User Added',user_removed:'User Removed',
  report_export:'Report exported',jobs_archived:'Jobs archived',attachment_added:'Attachment added',
  broadcast_edited:'Broadcast edited',settings_changed:'Settings changed',audit:'Audit',user_edited:'User Edited'
};

export const FB_LIMITS={notifications:60,activityLog:200,broadcasts:40,extensions:30,jobEvents:40,dashActivity:25,jobsListen:500};
export const JOBS_PAGE_SIZE=50;
export const ARCHIVE_AFTER_MS=90*86400000;
export const DEFAULT_SETTINGS={dashStatsView:'cards',notifSound:true,desktopNotif:true,muteLoginNotif:false,managerJobsScope:'all',jobsSort:'created',jobsPage:0,emailAssigned:true,emailStatus:true,emailDeadline:true,emailOverdue:true,emailExtension:true};
export const NOTIF_BUBBLE_TTL=120000;
export const NOTIF_TOAST_MAX=12;

// ── ORG-WIDE EMAIL CONTROL (manager-set, stored in Firestore config/email) ────
// Cascading gate: master → per-event .on → per-recipient flag. All default on.
// RMI branch / entity tag on each user account (independent of team).
export const BRANCHES=['RMI - Syria','RMI - UAE','RMI - India'];
export const SPECIALIZATIONS=['Drafter','Releaser'];

export const EMAIL_EVENTS=['assigned','status','deadline','overdue','extension'];
export const EMAIL_RECIPS=['owner','teamLeader','supervisor','manager'];
export function defaultEmailConfig(){
  const ev={};
  for(const e of EMAIL_EVENTS){ev[e]={on:true,owner:true,teamLeader:true,supervisor:true,manager:true};}
  return {master:true,events:ev};
}
export let emailConfig=defaultEmailConfig();
export function setEmailConfig(v){emailConfig=v;}

export let jobs=[], users=[], events=[], notifications=[], extRequests=[], broadcasts=[], activityLogs=[];
export let me=null, myFilter='all', lastDel=null, isDark=true, currentATab='overview';
export let userSettings={...DEFAULT_SETTINGS};
export let tagStores={jtags:[],etags:[],mtags:[]};  // job-form tag inputs (property-mutated, never rebound)

// ── SETTERS (enable cross-module reassignment) ────────────────────────────────
export function setMe(v){me=v;}
export function setJobs(v){jobs=v;}
export function setUsers(v){users=v;}
export function setEvents(v){events=v;}
export function setNotifications(v){notifications=v;}
export function setExtRequests(v){extRequests=v;}
export function setBroadcasts(v){broadcasts=v;}
export function setActivityLogs(v){activityLogs=v;}
export function setMyFilter(v){myFilter=v;}
export function setLastDel(v){lastDel=v;}
export function setIsDark(v){isDark=v;}
export function setCurrentATab(v){currentATab=v;}
export function setUserSettings(v){userSettings=v;}
