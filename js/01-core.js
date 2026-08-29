"use strict";
/* =====================================================================
   SOFTCLIP · VIRTUAL GUITAR RIG · v2.3 — TRANSPORT HARDENING

   v2.3 changes:
   · GLOBAL error trap: any uncaught JS error surfaces as a toast +
     console dump. Silent-dead-UI is no longer possible invisibly.
   · Worklet loaded defensively; if Blob/addModule is blocked
     (e.g. strict CSP), engine boots with a transparent gate stand-in
     instead of dying before any audio exists.
   · Input device picker (enumerateDevices → deviceId constraint):
     USB interfaces are usually NOT the OS-default record device,
     which is the most common cause of "no input".
   · Lifecycle flattened to ONE boolean (ENG.on). No on/muted/armed
     triangulation. Source manager owns start/stop exclusively.
   · Boot-time integrity assert retained; graph build aborts loudly.
   · Realism work of v2.2 (two-stage amp, filter-network cabinets,
     normalized drive) is retained.
   ===================================================================== */

/* ---- 1. surface every uncaught error instead of dying quietly ---- */
window.addEventListener('error',e=>{
  try{
    const t=document.createElement('div');
    t.className='toast err';
    t.textContent='JS error: '+e.message+' @'+(e.lineno||'?');
    document.getElementById('toasts').appendChild(t);
    setTimeout(()=>t.remove(),6000);
  }catch(_){}
});
window.addEventListener('unhandledrejection',e=>{
  try{
    const r=e.reason,msg=r&&r.message?r.message:String(r);
    const t=document.createElement('div');
    t.className='toast err';
    t.textContent='Promise error: '+msg;
    document.getElementById('toasts').appendChild(t);
    setTimeout(()=>t.remove(),6000);
  }catch(_){}
});

const $=s=>document.querySelector(s);
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const TAU=Math.PI*2;
const db2g=db=>Math.pow(10,db/20);
const notes=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function mulberry(seed){return function(){seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}

function toast(msg,kind){
  const t=document.createElement('div');t.className='toast '+(kind||'');t.textContent=msg;
  $('#toasts').appendChild(t);
  while($('#toasts').children.length>4)$('#toasts').firstChild.remove();
  setTimeout(()=>{t.style.opacity='0';t.style.transition='opacity .25s';setTimeout(()=>t.remove(),260)},3200);
}

function fmtVal(v,unit){
  switch(unit){
    case 'dB':return(v>0?'+':'')+v.toFixed(1)+'dB';
    case 'ms':return Math.round(v)+'ms';
    case 'Hz':return v>=1000?(v/1000).toFixed(2)+'kHz':Math.round(v)+'Hz';
    case '%':return Math.round(v)+'%';
    case 'sec':return v.toFixed(2)+'S';
    case 'x':return v.toFixed(1);
    default:return String(Math.round(v));
  }
}
function knot(key,label,min,max,def,unit,opt){return Object.assign({key,label,min,max,def,unit},opt||{});}

const NS='softclip.';
const LS={
  get(k,d){try{const v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}},
  set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
};

const TYPES={
  drive:['SCREAMER','BLUES DRV','RAZOR','DIST+','FUZZ'],
  comp:['OPTO','STUDIO','PUNCH'],
  amp:['TWEED DLX','BLACKFACE','AC CHIME','BLUES 30','PLEXI 100','ROAR 800','RECTO MODERN','SLO LEAD'],
  ir:['4X12 VINT 30','4X12 MODERN','2X12 PLEXI','1X12 ALNICO','2X10 TWEED','OPEN 1X12','DARK 2X12','FLAT FRFR'],
  mod:['CHORUS','PHASER','FLANGER','TREMOLO','VIBRATO','ROTARY'],
  delay:['DIGITAL','ANALOG','TAPE','PING-PONG'],
  rev:['ROOM','HALL','PLATE','SPRING','CATHEDRAL']
};

const DEFS={
  gate:{name:'NOISE GATE',abbr:'GT',
    desc:'Silences the pauses of live playing. Threshold just above your noise floor; hold/release shape the close. Applies to live input only.',
    knobs:[knot('thr','THRESH',-80,-20,-60,'dB'),knot('hld','HOLD',5,500,50,'ms'),knot('rel','REL',10,500,120,'ms')]},
  comp:{name:'COMPRESSOR',abbr:'CP',types:TYPES.comp,
    desc:'Opto-flavoured leveller. Sustain drives the ratio, attack lets transients breathe — low attack keeps pick definition, high attack squashes.',
    knobs:[knot('sus','SUSTAIN',0,10,3,'x'),knot('att','ATTACK',1,50,8,'ms'),knot('rel','REL',30,800,250,'ms'),knot('lvl','LEVEL',-12,12,0,'dB')]},
  drive:{name:'OVERDRIVE / DIST',abbr:'DS',types:TYPES.drive,
    desc:'Pedal stage in front of the amp. Screamer and Blues trim lows before clipping; Razor and Dist+ push squared grind; Fuzz goes splattery. Loudness-normalized across DRIVE.',
    knobs:[knot('drv','DRIVE',0,10,6,'x'),knot('tone','TONE',0,10,5,'x'),knot('lvl','LEVEL',-12,6,2,'dB')]},
  amp:{name:'GUITAR AMP',abbr:'AMP',types:TYPES.amp,
    desc:'Two-stage valve model: voice voicing, interactive tone stack pre-distortion, adaptive darkening as gain climbs, asymmetric power stage.',
    knobs:[knot('gain','GAIN',0,10,5,'x'),knot('bass','BASS',-12,12,0,'dB'),knot('mid','MID',-12,12,0,'dB'),
           knot('treble','TREBLE',-12,12,0,'dB'),knot('pres','PRES',-12,12,0,'dB'),knot('lvl','LEVEL',-12,12,0,'dB')]},
  ir:{name:'CABINET',abbr:'IR',types:TYPES.ir,
    desc:'Filter-network speaker voicing. LOW CUT tightens the bottom, HI CUT trims residual fizz — dial both against your room and monitors.',
    knobs:[knot('cut','LOW CUT',20,600,100,'Hz',{log:true}),knot('hicut','HI CUT',2500,20000,12000,'Hz',{log:true}),knot('lvl','LEVEL',-12,12,0,'dB')]},
  mod:{name:'MODULATION',abbr:'MDL',types:TYPES.mod,
    desc:'Stereo motion: chorus, phaser, flanger, tremolo, vibrato, rotary. Rate in Hz, depth, wet mix.',
    knobs:[knot('rate','RATE',.05,12,.8,'Hz',{log:true}),knot('dep','DEPTH',0,100,35,'%'),knot('mix','MIX',0,100,30,'%')]},
  delay:{name:'DELAY',abbr:'DLY',types:TYPES.delay,
    desc:'Digital, analog-darkened, wow-and-flutter tape or ping-pong repeats. SYNC locks time to the tempo clock.',
    knobs:[knot('time','TIME',25,1500,380,'ms',{log:true}),knot('fb','FEEDBACK',0,95,32,'%'),knot('tone','TONE',0,10,6,'x'),knot('mix','MIX',0,60,20,'%')]},
  rev:{name:'REVERB',abbr:'RVB',types:TYPES.rev,
    desc:'Room, hall, plate, spring and cathedral engines with variable decay — pre-delay keeps articulation under washes.',
    knobs:[knot('dec','DECAY',.2,10,2.2,'sec',{log:true}),knot('pre','PRE-DLY',0,120,20,'ms'),knot('tone','TONE',0,10,5,'x'),knot('mix','MIX',0,100,25,'%')]}
};
const ORDER=['gate','comp','drive','amp','ir','mod','delay','rev'];
const STAGEMAP={drive:'drive',amp:'amp',ir:'cab',mod:'mod',delay:'dly',rev:'rev'};
const COMP_ATK={'OPTO':.004,'STUDIO':.008,'PUNCH':.002};
const COMP_REL={'OPTO':.24,'STUDIO':.18,'PUNCH':.30};

function basePatch(){
  return {
    bpm:120,
    gate:{on:true,thr:-60,hld:50,rel:120},
    comp:{on:false,type:'OPTO',sus:3,att:8,rel:250,lvl:0},
    drive:{on:false,type:'SCREAMER',drv:6,tone:5,lvl:2},
    amp:{on:true,type:'TWEED DLX',gain:5,bass:0,mid:0,treble:0,pres:0,lvl:0},
    ir:{on:true,type:'4X12 VINT 30',cut:100,hicut:12000,lvl:0},
    mod:{on:false,type:'CHORUS',rate:.8,dep:35,mix:30},
    delay:{on:false,type:'DIGITAL',sync:false,div:1,time:380,fb:32,tone:6,mix:20},
    rev:{on:false,type:'HALL',dec:2.2,pre:20,tone:5,mix:25}
  };
}

const FACTORY=[
 {name:'CLEAN CHIME',p:{comp:{on:true,sus:2.5},amp:{type:'AC CHIME',gain:3},ir:{type:'1X12 ALNICO'},
   mod:{on:true,type:'CHORUS',rate:.8,dep:35,mix:25},delay:{on:true,type:'DIGITAL',time:420,fb:28,mix:15},
   rev:{on:true,type:'HALL',dec:2.4,mix:22}}},
 {name:'TEXAS HEAT',p:{comp:{on:true,sus:3},drive:{on:true,type:'SCREAMER',drv:5,lvl:3},
   amp:{type:'TWEED DLX',gain:6.5,treble:1.5},ir:{type:'2X10 TWEED'},
   delay:{on:true,type:'TAPE',time:95,fb:18,mix:14},rev:{on:true,type:'SPRING',dec:1.6,mix:20}}},
 {name:'BLUES CRUNCH',p:{drive:{on:true,type:'BLUES DRV',drv:4.5},amp:{type:'BLUES 30',gain:5.5,mid:1.5},
   ir:{type:'2X12 PLEXI'},rev:{on:true,type:'ROOM',dec:1.2,mix:14}}},
 {name:'STADIUM ROCK',p:{drive:{on:true,type:'BLUES DRV',drv:7,lvl:3},amp:{type:'PLEXI 100',gain:7.5},
   ir:{type:'4X12 VINT 30'},delay:{on:true,type:'ANALOG',time:460,fb:38,mix:18},rev:{on:true,type:'PLATE',dec:1.8,mix:16}}},
 {name:'BRIT CRUNCH',p:{amp:{type:'ROAR 800',gain:6.5,pres:2,mid:2},ir:{type:'4X12 VINT 30'}}},
 {name:'MODERN METAL',p:{gate:{thr:-45,rel:60},drive:{on:true,type:'RAZOR',drv:7},
   amp:{type:'RECTO MODERN',gain:8,bass:-2,mid:-3,pres:2.5},ir:{type:'4X12 MODERN',cut:120,hicut:9500},
   delay:{on:true,type:'DIGITAL',time:540,fb:35,mix:12},rev:{on:true,type:'HALL',dec:2,mix:12}}},
 {name:'DOWNTUNE DROP',p:{gate:{thr:-42,rel:60},drive:{on:true,type:'RAZOR',drv:8},
   amp:{type:'RECTO MODERN',gain:8.5,bass:-1,mid:-4,treble:1,pres:3},ir:{type:'4X12 MODERN',cut:140,hicut:9000}}},
 {name:'HERO LEAD',p:{comp:{on:true,sus:2},drive:{on:true,type:'BLUES DRV',drv:4},
   amp:{type:'SLO LEAD',gain:7,pres:2.5},ir:{type:'4X12 VINT 30'},
   delay:{on:true,type:'ANALOG',time:480,fb:42,mix:24},rev:{on:true,type:'PLATE',dec:2.6,mix:24}}},
 {name:'FUZZ PSYCH',p:{drive:{on:true,type:'FUZZ',drv:6.5,tone:3},amp:{type:'AC CHIME',gain:5},ir:{type:'1X12 ALNICO'},
   mod:{on:true,type:'VIBRATO',rate:.7,dep:30,mix:45},delay:{on:true,type:'TAPE',time:350,fb:55,mix:22},
   rev:{on:true,type:'SPRING',dec:2.2,mix:18}}},
 {name:'AMBIENT SHEEN',p:{amp:{type:'BLACKFACE',gain:2.5},ir:{type:'FLAT FRFR',hicut:14000},
   mod:{on:true,type:'CHORUS',rate:.4,dep:55,mix:50},
   delay:{on:true,type:'DIGITAL',sync:true,div:1.5,fb:58,tone:5,mix:45},
   rev:{on:true,type:'CATHEDRAL',dec:6.5,pre:40,tone:7,mix:45}}},
 {name:'SOUNDSCAPE',p:{amp:{type:'BLACKFACE',gain:1.5},ir:{type:'DARK 2X12'},
   mod:{on:true,type:'PHASER',rate:.12,dep:60,mix:40},
   delay:{on:true,type:'PING-PONG',sync:true,div:2,fb:62,mix:55},
   rev:{on:true,type:'CATHEDRAL',dec:8,pre:50,tone:7,mix:55}}},
 {name:'FUNK SQUASH',p:{comp:{on:true,sus:7,att:3},amp:{type:'BLACKFACE',gain:3,treble:1},ir:{type:'OPEN 1X12'},
   mod:{on:true,type:'PHASER',rate:2.2,dep:55,mix:30},
   delay:{on:true,type:'DIGITAL',time:82,fb:12,mix:12},rev:{on:true,type:'ROOM',dec:.8,mix:10}}},
 {name:'SKANK DUB',p:{comp:{on:true,sus:6},amp:{type:'ROAR 800',gain:3.5,treble:-4,mid:2},ir:{type:'DARK 2X12'},
   mod:{on:true,type:'TREMOLO',rate:4.5,dep:60,mix:65},
   delay:{on:true,type:'TAPE',time:210,fb:25,mix:18},rev:{on:true,type:'ROOM',dec:1,mix:10}}},
 {name:"SURF'S UP",p:{amp:{type:'TWEED DLX',gain:5,treble:3,bass:-2},ir:{type:'2X10 TWEED'},
   mod:{on:true,type:'TREMOLO',rate:5.5,dep:75,mix:50},
   rev:{on:true,type:'SPRING',dec:3.5,mix:55}}},
 {name:'STEEL STRINGS',p:{comp:{on:true,sus:3.5},amp:{type:'BLACKFACE',gain:1,treble:1,bass:-1},
   ir:{type:'FLAT FRFR',hicut:13000},
   mod:{on:true,type:'CHORUS',rate:.7,dep:25,mix:18},
   delay:{on:true,type:'DIGITAL',time:130,fb:10,mix:14},rev:{on:true,type:'PLATE',dec:1.6,mix:16}}},
 {name:'JAZZ BOX',p:{comp:{on:true,sus:2},amp:{type:'BLUES 30',gain:2,bass:1,mid:1.5,treble:-2},
   ir:{type:'DARK 2X12'},rev:{on:true,type:'ROOM',dec:1.4,mix:12}}}
];

let PC=null,libIdx=0,curMod='amp',curName='—',dirty=false,userLib=[],importedName=null;

function mergedPC(entry){
  const pc=basePatch();
  if(entry&&entry.p)for(const m of ORDER)Object.assign(pc[m],entry.p[m]||{});
  if(entry&&entry.p&&entry.p.bpm)pc.bpm=entry.p.bpm;
  return pc;
}
function combinedLib(){
  return FACTORY.map(e=>({name:e.name,p:e.p,fac:true}))
    .concat(userLib.map(e=>({name:e.name,p:e.p,fac:false})));
}
let CFG=Object.assign({in:0,out:-6,drumLv:.8,devId:''},LS.get(NS+'cfg',{}));
function saveCfg(){LS.set(NS+'cfg',CFG);}
function loadLS(){
  userLib=LS.get(NS+'users',[]);
  const total=FACTORY.length+userLib.length;
  libIdx=clamp(LS.get(NS+'idx',0),0,total-1);
  const wip=LS.get(NS+'wip',null);
  if(wip){
    PC=mergedPC(wip);dirty=!!wip._dirty;
    curName=(wip._name||combinedLib()[libIdx].name);
    importedName=wip._imported||null;
  }else{
    PC=mergedPC(combinedLib()[libIdx]);
    curName=combinedLib()[libIdx].name;
  }
}
let wipTimer=null;
function snapshotToLS(){
  const s=JSON.parse(JSON.stringify(PC));
  s._dirty=dirty;s._name=curName;s._imported=importedName;
  clearTimeout(wipTimer);
  LS.set(NS+'wip',s);
}
function autosave(){clearTimeout(wipTimer);wipTimer=setTimeout(snapshotToLS,350);}
function markDirty(){dirty=true;$('#pdirty').textContent='●';autosave();}
function clearDirty(){dirty=false;$('#pdirty').textContent='';autosave();}
function displayName(){return importedName||curName;}
