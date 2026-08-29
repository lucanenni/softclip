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

/* =====================================================================
   AUDIO ENGINE
   ===================================================================== */
const WORKLET_SRC=`
class GateProc extends AudioWorkletProcessor{
  static get parameterDescriptors(){return[
    {name:'thr',defaultValue:-60,minValue:-90,maxValue:0},
    {name:'hld',defaultValue:.05,minValue:0,maxValue:.6},
    {name:'rel',defaultValue:.12,minValue:.01,maxValue:1}];}
  constructor(){super();this.env=0;this.g=0;this.open=false;this.hold=0;this.cnt=0;
    this.gb=new Float32Array(128);
    this.aC=Math.exp(-1/(.003*sampleRate));}
  process(inp,out,p){
    const i=inp[0],o=out[0];
    if(!i||!i[0]){for(const ch of o)ch.fill(0);return true;}
    const thr=Math.pow(10,p.thr[0]/20);
    const rC=Math.exp(-1/(p.rel[0]*sampleRate));
    const holdS=Math.min((p.hld[0]*sampleRate)|0,2147483000);
    const n=i[0].length,aC=this.aC;
    if(this.gb.length<n)this.gb=new Float32Array(n);
    const gb=this.gb;
    let env=this.env,g=this.g,open=this.open,hold=this.hold;
    for(let s=0;s<n;s++){
      const v=Math.abs(i[0][s]);
      env=env<v?aC*env+(1-aC)*v:rC*env+(1-rC)*v;
      if(env>thr){open=true;hold=holdS;}
      else if(open){if(hold>0)hold--;else open=false;}
      g+=((open?1:0)-g)*(open?aC:rC);
      gb[s]=g;
    }
    this.env=env;this.g=g;this.open=open;this.hold=hold;
    for(let ch=0;ch<o.length;ch++){
      const ic=i[ch]||i[0],oc=o[ch];
      for(let s=0;s<n;s++)oc[s]=ic[s]*gb[s];
    }
    if(++this.cnt>=20){this.cnt=0;this.port.postMessage({lvl:env});}
    return true;
  }
}
registerProcessor('sc-gate',GateProc);`;

function makeStage(ctx){
  const inG=ctx.createGain(),outG=ctx.createGain(),thru=ctx.createGain();
  inG.connect(thru);thru.connect(outG);
  return {
    in:inG,out:outG,ctx,
    activate(entry,exit){
      if(!entry||!exit)throw new Error('stage activate() missing endpoint');
      inG.disconnect();
      inG.connect(entry);
      thru.gain.setTargetAtTime(0,ctx.currentTime,.004);
      exit.connect(outG);
    },
    straight(){
      inG.disconnect();
      inG.connect(thru);
      thru.gain.setTargetAtTime(1,ctx.currentTime,.004);
    }
  };
}

const CAPROF={
  '4X12 VINT 30':{hp:90, ls:[90,1.5],  th:[105,2.5,.8], gr:[850,2.0,.9], dz:[2800,-2.0,1.1], tl:[3200,-1.0], lp:5400},
  '4X12 MODERN': {hp:110,ls:[95,1.0],  th:[120,3.0,1.0],gr:[950,2.5,.9], dz:[3100,-3.0,1.2], tl:[3600,-2.0], lp:4700},
  '2X12 PLEXI':  {hp:100,ls:[100,1.0], th:[115,2.0,.8], gr:[800,1.5,.8], dz:[2600,-1.5,1.0], tl:[3000,-.5],  lp:5800},
  '1X12 ALNICO': {hp:105,ls:[105,.5],  th:[125,3.5,.7], gr:[1050,2.2,.8],dz:[3300,-1.2,.9],  tl:[4000,.5],   lp:6800},
  '2X10 TWEED':  {hp:80, ls:[95,2.0],  th:[110,2.0,.8], gr:[700,1.5,.8], dz:[2400,-.8,.9],   tl:[2800,.8],   lp:6200},
  'OPEN 1X12':   {hp:95, ls:[110,.5],  th:[130,2.0,.7], gr:[1150,1.8,.8],dz:[3500,-1.5,.9],  tl:[4200,0],    lp:7000},
  'DARK 2X12':   {hp:80, ls:[90,1.5],  th:[100,2.0,.8], gr:[600,1.0,.8], dz:[2200,-2.5,1.0], tl:[2600,-2.0], lp:4300},
  'FLAT FRFR':   {hp:35, ls:[80,0],    th:[90,0,.7],    gr:[800,0,.8],   dz:[3000,0,1],      tl:[4000,0],    lp:16000}
};

const ENG={
  ctx:null,on:false,
  st:{},revCache:new Map(),
  inDb:-60,

  async boot(){
    if(this.ctx)return;
    const AC=window.AudioContext||window.webkitAudioContext;
    this.ctx=new AC({latencyHint:'interactive'});
    const c=this.ctx;

    /* ---- GATE: worklet preferred, graceful GainNode fallback ---- */
    this.head=c.createGain();
    this.gateWorklet=false;
    try{
      const url=URL.createObjectURL(new Blob([WORKLET_SRC],{type:'application/javascript'}));
      await c.audioWorklet.addModule(url);
      this.gateNode=new AudioWorkletNode(c,'sc-gate',{outputChannelCount:[2]});
      this.gateWorklet=true;
    }catch(err){
      console.warn('worklet unavailable, using open gate:',err);
      this.gateNode=c.createGain();               // fully-open stand-in
      toast('Gate DSP unavailable — running ungated (worklet blocked)','err');
    }
    this.gateParams={
      get:k=>({thr:{value:this._thrCache??-60}})[k],
      set:(k,v)=>{},
    };
    if(this.gateWorklet)this.gateNode.port.onmessage=e=>{this.inDb=20*Math.log10(Math.max(1e-5,e.data.lvl));};
    this.tnAn=c.createAnalyser();this.tnAn.fftSize=2048;

    this.compNode=c.createDynamicsCompressor();
    this.compLvl=c.createGain();

    this.st.drive=this.makeDrive(); this.st.amp=this.makeAmp();
    this.st.cab =this.makeCab();    this.st.mod=this.makeMod();
    this.st.dly =this.makeDly();    this.st.rev=this.makeRev();

    for(const k of ['drive','amp','cab','mod','dly','rev']){
      const s=this.st[k];
      if(!s||!(s.in instanceof GainNode)||!(s.out instanceof GainNode)||typeof s.set!=='function')
        throw new Error('boot: stage "'+k+'" failed init');
    }

    this.bus=c.createGain();
    this.limit=c.createDynamicsCompressor();
    this.limit.threshold.value=-1.5;this.limit.knee.value=0;
    this.limit.ratio.value=20;this.limit.attack.value=.002;this.limit.release.value=.12;
    this.anOut=c.createAnalyser();this.anOut.fftSize=1024;
    this.scAn=c.createAnalyser();this.scAn.fftSize=512;

    this.head.connect(this.tnAn);
    this.head.connect(this.gateNode);
    this.gateNode.connect(this.compNode);
    this.compNode.connect(this.compLvl);
    const seq=[this.st.drive,this.st.amp,this.st.cab,this.st.mod,this.st.dly,this.st.rev];
    this.compLvl.connect(seq[0].in);
    for(let i=0;i<seq.length-1;i++)seq[i].out.connect(seq[i+1].in);
    seq[seq.length-1].out.connect(this.scAn);
    this.scAn.connect(this.bus);
    this.bus.connect(this.limit);
    this.limit.connect(this.anOut);this.anOut.connect(c.destination);

    this.applyGlobals();
  },

  async ensure(){ if(!this.ctx)await this.boot(); await this.ctx.resume(); },

  setEngine(onFlag){
    this.on=!!onFlag;
    document.body.classList.toggle('audio-on',this.on);
    if(this.on){this.sparkUntil=performance.now()+900;applyAllToAudio();}
    else{this.inDb=-60;}
    refreshStatus();
  },

  /* drives gate params regardless of worklet/fallback */
  pushGate(st,liveMode){
    if(!this.ctx)return;
    const t=this.ctx.currentTime;
    if(this.gateWorklet){
      const p=this.gateNode.parameters;
      p.get('thr').setTargetAtTime((st.on&&liveMode)?st.thr:-90,t,.01);
      if(st.on&&liveMode){
        p.get('hld').setTargetAtTime(st.hld/1000,t,.01);
        p.get('rel').setTargetAtTime(st.rel/1000,t,.01);
      }
    }else{
      /* fallback gate: crude but functional mute-below-threshold via head? skip — stay open */
    }
  },

  ping(){
    /* SELF-TEST: inject past the source layer, proves chain end-to-end */
    if(!this.ctx||!this.on){toast('Arm the engine first (click DEMO RIFF)','err');return;}
    const c=this.ctx,o=c.createOscillator(),g=c.createGain();
    o.frequency.value=880;
    g.gain.setValueAtTime(.28,c.currentTime);
    g.gain.exponentialRampToValueAtTime(.0001,c.currentTime+.22);
    o.connect(g);g.connect(this.bus);         // AFTER chain bus → limiter out
    o.start();o.stop(c.currentTime+.25);
    toast('Ping sent direct to output — if you hear it, speakers/output are fine','ok');
    /* second ping INTO the chain */
    setTimeout(()=>{
      const o2=c.createOscillator(),g2=c.createGain();
      o2.frequency.value=660;
      g2.gain.setValueAtTime(.28,c.currentTime);
      g2.gain.exponentialRampToValueAtTime(.0001,c.currentTime+.22);
      o2.connect(g2);g2.connect(this.compLvl); // chain entry
      o2.start();o2.stop(c.currentTime+.25);
      toast('Ping sent through the FX chain — hearing this one means the blocks pass audio','ok');
    },500);
  },

  applyGlobals(){
    if(!this.ctx)return;const t=this.ctx.currentTime;
    this.head.gain.setTargetAtTime(db2g(CFG.in),t,.02);
    this.bus.gain.setTargetAtTime(db2g(CFG.out),t,.02);
  },

  /* ============================ DRIVE ============================ */
  makeDrive(){
    const c=this.ctx,w=makeStage(c);
    const hp=c.createBiquadFilter();hp.type='highpass';hp.Q.value=.71;
    const sh=c.createWaveShaper();sh.oversample='4x';
    const dc=c.createBiquadFilter();dc.type='highpass';dc.frequency.value=9;dc.Q.value=.71;
    const lp=c.createBiquadFilter();lp.type='lowpass';lp.Q.value=.71;
    const mk=c.createGain();
    hp.connect(sh);sh.connect(dc);dc.connect(lp);lp.connect(mk);
    const KIND={'SCREAMER':{kg:1.8,asym:.22,hpL:300},'BLUES DRV':{kg:1.25,asym:.1,hpL:180},
      'RAZOR':{kg:2.6,asym:0,hpL:150},'DIST+':{kg:2.2,asym:.06,hpL:120},'FUZZ':{kg:2.9,asym:.16,hpL:220,fz:true}};
    let cache='',routed='';
    function curve(kind,d10){
      const K=KIND[kind]||KIND.SCREAMER,N=2048,arr=new Float32Array(N);
      const GG=Math.max(1,K.kg*.8);let mx=0;
      const soft=t=>Math.tanh(t*GG*1.6)/Math.tanh((1+K.asym)*GG*1.6);
      for(let i=0;i<N;i++){
        const x=i/(N-1)*2-1,u=x+K.asym;
        let y=soft(u)-(K.asym?soft(K.asym):0);
        y/=Math.sqrt(1+d10*.28);
        if(K.fz){
          const yr=Math.tanh(Math.abs(u)*GG*2.4)*.38;
          y=Math.tanh(y*2.2)*.62+yr*Math.tanh(u*10)*.3;
        }
        arr[i]=y;if(Math.abs(y)>mx)mx=Math.abs(y);
      }
      if(mx>0)for(let i=0;i<N;i++)arr[i]/=mx;
      return arr;
    }
    return {
      in:w.in,out:w.out,
      set(st){
        const rk=String(st.on);
        if(routed!==rk){routed=rk;st.on?w.activate(hp,mk):w.straight();}
        if(!st.on)return;
        const K=KIND[st.type]||KIND.SCREAMER;
        hp.frequency.setTargetAtTime(K.hpL*.6,c.currentTime,.02);
        lp.frequency.setTargetAtTime(clamp(500*Math.pow(Math.max(.05,st.tone/10),1.9)*9,300,11000),c.currentTime,.02);
        const ck=st.type+'|'+st.drv.toFixed(2);
        if(ck!==cache){cache=ck;sh.curve=curve(st.type,st.drv);}
        mk.gain.setTargetAtTime(db2g(st.lvl)*1.15/(0.78+st.drv*.07),c.currentTime,.02);
      }
    };
  },

  /* ============================ AMP ============================ */
  makeAmp(){
    const c=this.ctx,w=makeStage(c);
    const vhp=c.createBiquadFilter();vhp.type='highpass';vhp.Q.value=.71;
    const vpk=c.createBiquadFilter();vpk.type='peaking';
    const vsh=c.createBiquadFilter();vsh.type='highshelf';
    const tB=c.createBiquadFilter();tB.type='lowshelf';tB.frequency.value=110;
    const tM=c.createBiquadFilter();tM.type='peaking';tM.frequency.value=650;tM.Q.value=.8;
    const tT=c.createBiquadFilter();tT.type='highshelf';tT.frequency.value=2600;
    const sh1=c.createWaveShaper();sh1.oversample='4x';
    const s1lp=c.createBiquadFilter();s1lp.type='lowpass';s1lp.Q.value=.71;
    const s2dc=c.createBiquadFilter();s2dc.type='highpass';s2dc.frequency.value=16;s2dc.Q.value=.71;
    const sh2=c.createWaveShaper();sh2.oversample='4x';
    const deep=c.createBiquadFilter();deep.type='lowshelf';deep.frequency.value=80;
    const pres=c.createBiquadFilter();pres.type='peaking';pres.frequency.value=3200;pres.Q.value=.9;
    const lpF=c.createBiquadFilter();lpF.type='lowpass';lpF.frequency.value=6500;lpF.Q.value=.71;
    const mkup=c.createGain();
    const sc=c.createDynamicsCompressor();sc.knee.value=14;sc.attack.value=.007;sc.release.value=.18;
    vhp.connect(vpk);vpk.connect(vsh);
    vsh.connect(tB);tB.connect(tM);tM.connect(tT);
    tT.connect(sh1);sh1.connect(s1lp);s1lp.connect(s2dc);s2dc.connect(sh2);
    sh2.connect(deep);deep.connect(pres);pres.connect(lpF);
    lpF.connect(mkup);mkup.connect(sc);
    const VOICE={
      'TWEED DLX':  {hp:60, hs:[1500,1.2],pk:[900,1,.7],  k:14, dark:[5200,3000], deep:0},
      'BLACKFACE':  {hp:70, hs:[1500,.4], pk:[700,.6,.7], k:6,  dark:[6000,3600], deep:0},
      'AC CHIME':   {hp:95, hs:[2200,1],  pk:[2600,1.4,.8],k:8, dark:[7200,4200], deep:0},
      'BLUES 30':   {hp:85, hs:[1800,.8], pk:[750,1.6,.9],k:11, dark:[6400,3800], deep:0},
      'PLEXI 100':  {hp:100,hs:[1300,.6], pk:[700,1,.8],  k:22, dark:[5200,2400], deep:1.5},
      'ROAR 800':   {hp:120,hs:[1300,.4], pk:[680,.8,.8], k:32, dark:[4800,2200], deep:1.5},
      'RECTO MODERN':{hp:135,hs:[1100,0], pk:[550,0,.8],  k:48, dark:[4200,1700], deep:2.5},
      'SLO LEAD':   {hp:110,hs:[1200,.6], pk:[620,1.8,.9],k:40, dark:[5000,2100], deep:1.5}
    };
    function curve1(k){
      const N=1024,a=new Float32Array(N),nrm=Math.tanh(k);
      for(let i=0;i<N;i++){const x=i/(N-1)*2-1;a[i]=Math.tanh(k*x)/nrm;}
      return a;
    }
    function curve2(k){
      const N=1024,a=new Float32Array(N),kb=k*.82;
      let mx=0;
      for(let i=0;i<N;i++){
        const x=i/(N-1)*2-1;
        const y=x>=0?Math.tanh(k*x)/Math.tanh(k):Math.tanh(kb*x)/Math.tanh(kb);
        a[i]=y;mx=Math.max(mx,Math.abs(y));
      }
      let mean=0;for(let i=0;i<N;i++){a[i]/=mx;mean+=a[i];}
      mean/=N;
      for(let i=0;i<N;i++)a[i]-=mean;
      return a;
    }
    let routed='',kc='';
    return {
      in:w.in,out:w.out,
      set(st){
        const rk=String(st.on);
        if(routed!==rk){routed=rk;st.on?w.activate(vhp,sc):w.straight();}
        if(!st.on)return;
        const t=c.currentTime,V=VOICE[st.type]||VOICE['TWEED DLX'];
        vhp.frequency.setTargetAtTime(V.hp,t,.02);
        vsh.frequency.value=V.hs[0];vsh.gain.setTargetAtTime(V.hs[1]+st.treble*.08,t,.02);
        vpk.frequency.value=V.pk[0];vpk.gain.setTargetAtTime(V.pk[1],t,.02);vpk.Q.value=V.pk[2];
        tB.gain.setTargetAtTime(st.bass,t,.02);
        tM.gain.setTargetAtTime(st.mid,t,.02);
        tT.gain.setTargetAtTime(st.treble*.65,t,.02);
        const kk=V.k*(0.35+st.gain*0.32);
        const key=Math.round(kk*2)/2;
        if(key!==kc){kc=key;sh1.curve=curve1(kk);sh2.curve=curve2(kk);}
        const frac=clamp((kk-V.k*.35)/(V.k*.65),0,1);
        s1lp.frequency.setTargetAtTime(lerp(V.dark[0],V.dark[1],frac),t,.05);
        lpF.frequency.setTargetAtTime(lerp(Math.min(V.dark[0]+900,7200),4500,frac),t,.05);
        deep.gain.setTargetAtTime(V.deep*(0.7+frac*.6),t,.05);
        pres.gain.setTargetAtTime(st.pres,t,.03);
        sc.threshold.setTargetAtTime(clamp(-30-kk*.5,-58,-18),t,.05);
        sc.ratio.setTargetAtTime(clamp(2+kk*.08,2,12),t,.05);
        mkup.gain.setTargetAtTime(clamp(1.2/Math.pow(kk,.40),.25,1.1)*db2g(st.lvl),t,.03);
      }
    };
  },

  /* ============================ CABINET ============================ */
  makeCab(){
    const c=this.ctx,w=makeStage(c);
    const lcf=c.createBiquadFilter();lcf.type='highpass';lcf.Q.value=.71;
    const hpB=c.createBiquadFilter();hpB.type='highpass';hpB.Q.value=.71;
    const ls=c.createBiquadFilter();ls.type='lowshelf';
    const thPk=c.createBiquadFilter();thPk.type='peaking';
    const grPk=c.createBiquadFilter();grPk.type='peaking';
    const dzPk=c.createBiquadFilter();dzPk.type='peaking';
    const tl=c.createBiquadFilter();tl.type='highshelf';
    const lpA=c.createBiquadFilter();lpA.type='lowpass';lpA.Q.value=.71;
    const lpB=c.createBiquadFilter();lpB.type='lowpass';lpB.Q.value=.71;
    const hcf=c.createBiquadFilter();hcf.type='lowpass';hcf.Q.value=.71;
    const g=c.createGain();
    lcf.connect(hpB);hpB.connect(ls);ls.connect(thPk);thPk.connect(grPk);
    grPk.connect(dzPk);dzPk.connect(tl);tl.connect(lpA);lpA.connect(lpB);
    lpB.connect(hcf);hcf.connect(g);
    let routed='',profKey='';
    return {
      in:w.in,out:w.out,
      set(st){
        const rk=String(st.on);
        if(routed!==rk){routed=rk;st.on?w.activate(lcf,g):w.straight();}
        if(!st.on)return;
        const t=c.currentTime,P=CAPROF[st.type]||CAPROF['FLAT FRFR'];
        if(profKey!==st.type){
          profKey=st.type;
          hpB.frequency.setTargetAtTime(P.hp,t,.04);
          ls.frequency.value=P.ls[0];ls.gain.setTargetAtTime(P.ls[1],t,.04);
          thPk.frequency.value=P.th[0];thPk.gain.setTargetAtTime(P.th[1],t,.04);thPk.Q.value=P.th[2];
          grPk.frequency.value=P.gr[0];grPk.gain.setTargetAtTime(P.gr[1],t,.04);grPk.Q.value=P.gr[2];
          dzPk.frequency.value=P.dz[0];dzPk.gain.setTargetAtTime(P.dz[1],t,.04);dzPk.Q.value=P.dz[2];
          tl.frequency.value=P.tl[0];tl.gain.setTargetAtTime(P.tl[1],t,.04);
          lpA.frequency.setTargetAtTime(P.lp,t,.04);
          lpB.frequency.setTargetAtTime(P.lp,t,.04);
        }
        lcf.frequency.setTargetAtTime(st.cut,t,.02);
        hcf.frequency.setTargetAtTime(st.hicut,t,.02);
        g.gain.setTargetAtTime(db2g(st.lvl)*1.25,t,.02);
      }
    };
  },

  /* ==================== MODULATION ==================== */
  makeMod(){
    const c=this.ctx,w=makeStage(c);
    const xin=c.createGain();
    const wetBus=c.createGain();
    wetBus.connect(w.out);
    let graph=null,routed=false;
    function teardown(){
      w.straight();routed=false;
      if(graph){
        graph.nodes.forEach(n=>{try{n.disconnect()}catch(e){}});
        graph.oscs.forEach(o=>{try{o.stop()}catch(e){}});
      }
      graph=null;
      xin.disconnect();
      wetBus.gain.cancelScheduledValues(c.currentTime);
    }
    function lfo(rate,phaseFrac,coef,nodes,lfd){
      const o=c.createOscillator();o.type='sine';o.frequency.value=rate;
      const sh=c.createDelay(10);sh.delayTime.value=Math.min(9,(phaseFrac||0)/Math.max(.05,rate));
      sh._phFrac=phaseFrac||0;
      const g=c.createGain();g._c=coef;
      o.connect(sh);sh.connect(g);o.start();
      nodes.push(sh,g);lfd.push(o,sh,g);
      return g;
    }
    function build(st){
      const nodes=[],oscRefs=[];
      const R=Math.max(.05,st.rate),T=st.type;
      graph={nodes,oscs:oscRefs,tremCarrier:null,type:T};
      const pan=v=>{const p=c.createStereoPanner();p.pan.value=v;nodes.push(p);return p;};
      const toWet=n=>n.connect(wetBus);

      if(T==='CHORUS'||T==='VIBRATO'){
        [[0,-.6],[.25,.6]].forEach(pair=>{
          const dl=c.createDelay(.2);dl.delayTime.value=.012;nodes.push(dl);
          const lg=lfo(R,pair[0],.0076,nodes,oscRefs);lg.connect(dl.delayTime);
          const p=pan(pair[1]);
          xin.connect(dl);dl.connect(p);toWet(p);
        });
        if(T==='CHORUS'){
          const dry=c.createGain();dry.gain.value=1;nodes.push(dry);
          xin.connect(dry);dry.connect(wetBus);
        }
      }
      else if(T==='FLANGER'){
        const dl=c.createDelay(.1);dl.delayTime.value=.0045;nodes.push(dl);
        const lg=lfo(R,0,.0032,nodes,oscRefs);lg.connect(dl.delayTime);
        const fb=c.createGain();fb.gain.value=.5;nodes.push(fb);
        const p=pan(.15);
        xin.connect(dl);dl.connect(fb);fb.connect(dl);
        dl.connect(p);toWet(p);
        const dry=c.createGain();dry.gain.value=1;nodes.push(dry);
        xin.connect(dry);dry.connect(wetBus);
      }
      else if(T==='PHASER'){
        const lg=lfo(R,0,520,nodes,oscRefs);
        let node=xin;
        for(let i=0;i<4;i++){
          const ap=c.createBiquadFilter();ap.type='allpass';
          ap.frequency.value=750;ap.Q.value=.7;
          lg.connect(ap.frequency);node.connect(ap);
          nodes.push(ap);node=ap;
        }
        const p=pan(0);node.connect(p);toWet(p);
        const dry=c.createGain();dry.gain.value=1;nodes.push(dry);
        xin.connect(dry);dry.connect(wetBus);
      }
      else if(T==='TREMOLO'){
        const carrier=c.createGain();carrier.gain.value=1;nodes.push(carrier);
        graph.tremCarrier=carrier;
        const ampGain=c.createGain();nodes.push(ampGain);
        const lg=lfo(R,0,1,nodes,oscRefs);
        ampGain.gain.value=0;
        lg.connect(ampGain);ampGain.connect(carrier.gain);
        const p=pan(0);
        xin.connect(carrier);carrier.connect(p);toWet(p);
      }
      else if(T==='ROTARY'){
        [[0,-.7],[.5,.7]].forEach(pair=>{
          const dl=c.createDelay(.2);dl.delayTime.value=.014;nodes.push(dl);
          const lg=lfo(R,pair[0],.0045,nodes,oscRefs);lg.connect(dl.delayTime);
          const amGain=c.createGain();amGain.gain.value=.7;nodes.push(amGain);
          const amDepth=c.createGain();amDepth.gain.value=.3;nodes.push(amDepth);
          lg.connect(amDepth);amDepth.connect(amGain.gain);
          if(c.createConstantSource){
            const cs=c.createConstantSource();cs.offset.value=.7;
            cs.connect(amGain.gain);cs.start();
            oscRefs.push(cs);nodes.push(cs);
          }
          const p=pan(pair[1]);
          xin.connect(dl);dl.connect(amGain);amGain.connect(p);toWet(p);
        });
        const dry=c.createGain();dry.gain.value=.85;nodes.push(dry);
        xin.connect(dry);dry.connect(wetBus);
      }

      if(st.on)w.activate(xin,wetBus);
      else w.straight();
      routed=st.on;
    }
    return {
      in:w.in,out:w.out,
      set(st){
        if(!st.on){if(graph)teardown();return;}
        if(!graph||graph.type!==st.type)build(st);
        if(!routed){w.activate(xin,wetBus);routed=true;}
        const t=c.currentTime,R=Math.max(.05,st.rate),d=st.dep/100;
        graph.nodes.forEach(n=>{
          if(n.frequency)n.frequency.setTargetAtTime(R,t,.03);
          if(n.delayTime&&n._phFrac!==undefined)n.delayTime.setTargetAtTime(Math.min(9,n._phFrac/R),t,.03);
        });
        graph.oscs.forEach(o=>{if(o.frequency)o.frequency.setTargetAtTime(R,t,.03);});
        graph.nodes.forEach(n=>{if(n.gain&&n._c!==undefined)n.gain.setTargetAtTime(n._c*d,t,.03);});
        if(graph.tremCarrier)graph.tremCarrier.gain.setTargetAtTime(1-d*.92,t,.03);
        wetBus.gain.setTargetAtTime(st.mix/100,t,.03);
      }
    };
  },

  /* ==================== DELAY ==================== */
  makeDly(){
    const c=this.ctx,w=makeStage(c);
    const xin=c.createGain();
    let net=null,routed=false;
    function timeOf(st){
      const raw=st.sync?(60000/(PC?PC.bpm:120))*parseFloat(st.div):st.time;
      return clamp(raw/1000,.021,1.49);
    }
    function teardown(){
      w.straight();routed=false;
      if(net){
        net.nodes.forEach(n=>{try{n.disconnect()}catch(e){}});
        net.oscs.forEach(o=>{try{o.stop()}catch(e){}});
      }
      net=null;
      xin.disconnect();
    }
    function satCurve(dark){
      const N=256,a=new Float32Array(N);
      for(let i=0;i<N;i++){const x=i/(N-1)*2-1;a[i]=dark?Math.tanh(1.5*x)/Math.tanh(1.5):x;}
      return a;
    }
    function build(st){
      const T=st.type,dark=T==='ANALOG'||T==='TAPE';
      const damp=c.createBiquadFilter();damp.type='lowpass';
      damp.frequency.value=T==='ANALOG'?2400:T==='TAPE'?3000:12000;
      damp.Q.value=.71;
      const wet=c.createGain();wet.gain.value=st.mix/100*.9;
      const sat=c.createWaveShaper();sat.oversample='2x';sat.curve=satCurve(dark);
      const fb=c.createGain();
      const nodes=[damp,wet,sat,fb],oscs=[],head=[];
      xin.connect(damp);
      if(T==='PING-PONG'){
        const dlL=c.createDelay(2),dlR=c.createDelay(2);
        const tv=timeOf(st);dlL.delayTime.value=tv;dlR.delayTime.value=tv;
        fb.gain.value=clamp(st.fb/100,0,.95)*.86;
        const pL=c.createStereoPanner();pL.pan.value=-.75;
        const pR=c.createStereoPanner();pR.pan.value=.75;
        damp.connect(dlL);
        dlL.connect(sat);sat.connect(fb);
        fb.connect(dlR);
        dlR.connect(damp);
        dlL.connect(pL);dlR.connect(pR);pL.connect(wet);pR.connect(wet);
        head.push(dlL,dlR);nodes.push(dlL,dlR,pL,pR);
      }else{
        const dl=c.createDelay(2);dl.delayTime.value=timeOf(st);
        fb.gain.value=clamp(st.fb/100,0,.95)*.88;
        damp.connect(dl);dl.connect(sat);sat.connect(fb);fb.connect(damp);
        dl.connect(wet);
        head.push(dl);nodes.push(dl);
        if(T==='TAPE'){
          const o=c.createOscillator();o.frequency.value=.7;
          const og=c.createGain();og.gain.value=timeOf(st)*.03;
          o.connect(og);og.connect(dl.delayTime);o.start();
          oscs.push(o);nodes.push(og);
        }
      }
      wet.connect(w.out);
      net={type:T,damp,wet,fb,head,nodes,oscs};
      if(st.on)w.activate(xin,wet);
      else w.straight();
      routed=st.on;
    }
    return {
      in:w.in,out:w.out,
      set(st){
        const wantType=st.on?st.type:null;
        if(!st.on){teardown();return;}
        if(net&&(net.type!==wantType))teardown();
        if(!net)build(st);
        if(!routed){w.activate(xin,net.wet);routed=true;}
        this.refresh(st);
      },
      refresh(st){
        if(!st.on||!net)return;
        const t=c.currentTime,tv=timeOf(st);
        net.head.forEach(dl=>dl.delayTime.setTargetAtTime(tv,t,.05));
        net.fb.gain.setTargetAtTime(clamp(st.fb/100,0,.95)*(net.type==='PING-PONG'?.86:.88),t,.02);
        net.wet.gain.setTargetAtTime(st.mix/100*.9,t,.02);
        const dark=net.type==='ANALOG'?2400:net.type==='TAPE'?3000:12000;
        net.damp.frequency.setTargetAtTime(
          clamp(dark*(0.35+.65*Math.max(.05,st.tone/10)),700,16000),t,.04);
      }
    };
  },

  /* ============================ REVERB ============================ */
  makeRev(){
    const c=this.ctx,w=makeStage(c);
    const pre=c.createDelay(.3);
    const cv=c.createConvolver();
    const tl=c.createBiquadFilter();tl.type='lowpass';tl.Q.value=.71;
    const wg=c.createGain();
    pre.connect(cv);cv.connect(tl);tl.connect(wg);
    let pend=null,routed='';
    return {
      in:w.in,out:w.out,
      set(st){
        const rk=String(st.on),t=c.currentTime;
        if(routed!==rk){routed=rk;st.on?w.activate(pre,wg):w.straight();}
        if(!st.on)return;
        pre.delayTime.setTargetAtTime(clamp(st.pre/1000,0,.29),t,.02);
        tl.frequency.setTargetAtTime(lerp(2400,15500,st.tone/10),t,.02);
        wg.gain.setTargetAtTime(st.mix/100*.7,t,.02);
        clearTimeout(pend);
        pend=setTimeout(()=>{
          const k=st.type+'|'+st.dec.toFixed(2)+'|'+st.tone.toFixed(1);
          if(this._rk===k)return;this._rk=k;
          cv.buffer=ENG.getRevIR(st.type,st.dec,st.tone);
        },140);
      }
    };
  },
  getRevIR(type,decay,tone){
    const sr=Math.round(this.ctx.sampleRate);
    const key=type+'|'+decay.toFixed(2)+'|'+tone.toFixed(1)+'|'+sr;
    if(this.revCache.has(key))return this.revCache.get(key);
    const PROF={ROOM:{e:2.8},HALL:{e:2.2},PLATE:{e:3.4},SPRING:{e:2.0},CATHEDRAL:{e:1.6}};
    const pr=PROF[type]||PROF.HALL;
    const len=Math.min(Math.floor(sr*decay),sr*10);
    const b=this.ctx.createBuffer(2,len,sr);
    const bright=lerp(.25,1,tone/10);
    for(let ch=0;ch<2;ch++){
      const d=b.getChannelData(ch),rnd=mulberry(77+ch*7);
      let lp=0,bp=0;
      const aL=Math.exp(-TAU*lerp(2600,8200,bright)/sr);
      const aB=Math.exp(-TAU*lerp(300,700,bright)/sr);
      const eps=type==='PLATE'?0:type==='SPRING'?.012:type==='CATHEDRAL'?.05:.015;
      const skip=Math.floor(sr*eps);
      const comb=type==='SPRING'?[1070,2260]:[];
      const combPh=comb.map(()=>rnd()*TAU);
      for(let i=0;i<len;i++){
        const t=i/len,n=rnd()*2-1;
        lp+=(n-lp)*aL;bp+=(n-bp)*aB;
        let v=type==='SPRING'?bp*.5+lp*.5:lp;
        if(i<skip)v*=i/skip*.6;
        for(let k2=0;k2<comb.length;k2++)
          v+=.06*Math.exp(-3.2*t)*Math.sin(TAU*comb[k2]*i/sr+combPh[k2])*lp;
        d[i]=v*Math.pow(1-t,pr.e)*Math.exp(-1.2*t);
      }
      let mx=0;for(let i=0;i<len;i++)mx=Math.max(mx,Math.abs(d[i]));
      if(mx>0)for(let i=0;i<len;i++)d[i]=d[i]/mx*.9;
    }
    if(this.revCache.size>8)this.revCache.clear();
    this.revCache.set(key,b);return b;
  }
};

/* =====================================================================
   SOURCE MANAGER — single owner of engine on/off + input routing
   ===================================================================== */
const SRC={
  mode:null, stream:null, micNode:null, devId:'',
  riffKit:null, riffTimer:null, riffNext:0, riffStep:0, riffVoices:[],
  fileBuf:null, fileNode:null,

  async start(mode,fileObj){
    try{ await ENG.ensure(); }
    catch(err){ toast('Audio engine failed to boot: '+(err.message||err),'err'); return; }

    /* tear down whatever is currently sounding */
    this.stopSources();

    /* route new source */
    try{
      if(mode==='MIC'){
        const cons={audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}};
        if(this.devId)cons.audio.deviceId={exact:this.devId};
        this.stream=await navigator.mediaDevices.getUserMedia(cons);
        this.micNode=ENG.ctx.createMediaStreamSource(this.stream);
        this.micNode.connect(ENG.head);
        await this.refreshDeviceList();
        toast('Live input armed'+(this.devLabel?' · '+this.devLabel:''),'ok');
      }
      else if(mode==='RIFF'){
        this.startRiff();
        toast('Demo riff looping — switch presets to compare tones','ok');
      }
      else if(mode==='FILE'){
        if(fileObj){
          this.fileBuf=fileObj;
          const n=ENG.ctx.createBufferSource();
          n.buffer=fileObj.data;n.loop=true;
          const g=ENG.ctx.createGain();g.gain.value=.9;
          n.connect(g);g.connect(ENG.head);
          n.start();
          this.fileNode=n;
          toast('Playing “'+fileObj.name+'” through the chain','ok');
        }else{
          this.startRiff();
          toast('No file loaded — switched to Demo Riff','err');
          mode='RIFF';
        }
      }
      this.mode=mode;
      ENG.setEngine(true);
      refreshSourceUI();
    }catch(err){
      /* rollback cleanly */
      this.stopSources();this.mode=null;
      ENG.setEngine(false);
      refreshSourceUI();
      if(err&&(err.name==='NotAllowedError'||err.name==='NotFoundError'))
        toast('Input device problem ('+err.name+') — pick another under IN:','err');
      else
        toast('Source error: '+(err.message||err),'err');
    }
  },

  stopSources(){
    if(this.riffTimer){clearInterval(this.riffTimer);this.riffTimer=null;}
    this.riffVoices.forEach(o=>{try{o.stop()}catch(e){}});
    this.riffVoices=[];
    if(this.fileNode){try{this.fileNode.stop()}catch(e){}this.fileNode=null;}
    if(this.micNode){try{this.micNode.disconnect()}catch(e){}this.micNode=null;}
    if(this.stream){this.stream.getTracks().forEach(t=>t.stop());this.stream=null;}
  },
  stop(){                       // full engine off
    this.stopSources();
    this.mode=null;
    ENG.setEngine(false);
    $('#srcLbl').textContent='no signal';
    refreshSourceUI();
  },

  /* ---------------- device enumeration for interface picking --------- */
  devLabel:'',
  async refreshDeviceList(){
    const sel=$('#devSel');
    if(!navigator.mediaDevices||!navigator.mediaDevices.enumerateDevices){sel.innerHTML='<option value="">(default)</option>';return;}
    try{
      const devs=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audioinput');
      sel.innerHTML='';
      devs.forEach(d=>{
        const o=document.createElement('option');
        o.value=d.deviceId;
        o.textContent=d.label||('input '+d.deviceId.slice(0,5));
        if(d.label)this.devLabel=d.label;
        sel.appendChild(o);
      });
      if(CFG.devId&&devs.some(d=>d.deviceId===CFG.devId))sel.value=CFG.devId;
      else if(devs.length)CFG.devId=sel.value=devs[0].deviceId;
      saveCfg();
    }catch(err){/* ignore */}
  },

  /* ---------------- karplus-strong demo riff ------------------------- */
  renderKit(){
    if(this.riffKit)return this.riffKit;
    const sr=ENG.ctx.sampleRate,DUR=2.4;
    const mk=freq=>{
      const N=Math.max(2,Math.round(sr/freq)),len=Math.floor(sr*DUR);
      const b=ENG.ctx.createBuffer(1,len,sr),d=b.getChannelData(0);
      const rnd=mulberry(Math.round(freq*97));
      let last=0;
      for(let i=0;i<N;i++){const n=rnd()*2-1;last+=(n-last)*.72;d[i]=last*1.15;}
      const loss=.9962;
      for(let i=N;i<len;i++)
        d[i]=loss*(.52*d[i-N]+.52*d[i-N-(i>N?1:0)]);
      const f=Math.floor(sr*.06);
      for(let i=len-f;i<len;i++)d[i]*=(len-i)/f;
      let mx=0;for(let i=0;i<len;i++)mx=Math.max(mx,Math.abs(d[i]));
      if(mx>0)for(let i=0;i<len;i++)d[i]/=mx;
      return b;
    };
    this.riffKit={open:[82.41,110,146.83,196,246.94,329.63].map(mk)};
    return this.riftKit_alias||this.riffKit;
  },
  startRiff(){
    const K=this.renderKit();
    this.riffStep=0;
    this.riffNext=ENG.ctx.currentTime+.1;
    /* predeclare pattern */
    const LEAD=[[0,0,1],[2,12,.9],[4,15,.9],[7,14,.75],
      [8,12,.95],[10,0,.7],[11,7,.9],[14,5,.85],
      [16,0,1],[18,7,.85],[20,10,.9],[23,12,.75],
      [24,12,.95],[26,15,.9],[28,17,.85],[30,15,.7],
      [36,0,.9],[38,7,.85],[40,12,.95],[43,10,.8],
      [44,7,.9],[46,5,.8],[48,0,1],[51,12,.85],
      [52,10,.9],[54,7,.8],[56,5,.9],[58,0,.85],[60,12,.7]];
    const STRUM={32:{notes:[0,7,12,16],vel:.95},48:{notes:[0,7,12,16],vel:1}};
    const leadByStep={};LEAD.forEach(L=>leadByStep[L[0]]=L);
    const tick=()=>{
      const c=ENG.ctx;
      const spb=60/(PC?PC.bpm:120)/4;
      while(this.riffNext<c.currentTime+.3){
        const st=this.riffStep,t=this.riffNext;
        const hit=(buf,when,vel,rate)=>{
          const s=c.createBufferSource();
          s.buffer=buf;s.playbackRate.value=rate;
          const g=c.createGain();g.gain.value=.6*vel;
          s.connect(g);g.connect(ENG.head);
          s.start(when);
          this.riffVoices.push(s);
        };
        const strum=STRUM[st];
        if(strum)strum.notes.forEach((semi,i)=>{
          hit(K.open[0],t+i*.014,strum.vel*(i===3?1:.8),Math.pow(2,semi/12));
        });
        const ld=leadByStep[st];
        if(ld)hit(K.open[Math.min(5,Math.floor(Math.abs(ld[1])/5))],t,ld[2],Math.pow(2,ld[1]/12));
        this.riffNext+=spb;
        this.riffStep=(this.riffStep+1)%64;
      }
      const now=c.currentTime;
      this.riffVoices=this.riffVoices.filter(s=>{
        try{return s.loop||false;}catch(e){return false;}
      });
      /* voices auto-stop when their buffers end; prune stale refs occasionally */
      if(this.riffVoices.length>160)this.riffVoices.splice(0,80);
      void now;
    };
    this.riffTimer=setInterval(tick,100);
    tick();
  }
};
function refreshSourceUI(){
  document.querySelectorAll('.srcbtn').forEach(b=>
    b.classList.toggle('on',b.dataset.src===SRC.mode));
  const lbl=SRC.mode==='MIC'?'live input'
    :SRC.mode==='RIFF'?'demo riff'
    :SRC.mode==='FILE'&&SRC.fileBuf?('file · '+SRC.fileBuf.name.slice(0,20))
    :'no signal';
  $('#srcLbl').textContent=lbl;
}

/* ------------------------------------------------------------ state → audio */
function applyParam(mod){
  if(!ENG.on||!ENG.ctx)return;
  const t=ENG.ctx.currentTime,st=PC[mod];
  switch(mod){
    case 'gate':
      ENG.pushGate(st,SRC.mode==='MIC');
      break;
    case 'comp':
      ENG.compNode.threshold.setTargetAtTime(-6-st.sus*3.2,t,.02);
      ENG.compNode.ratio.setTargetAtTime(2+st.sus*.65,t,.02);
      ENG.compNode.attack.setTargetAtTime(clamp(COMP_ATK[st.type]??
        Math.max(.001,st.att/1000),.001,st.att/1000),t,.02);
      ENG.compNode.release.setTargetAtTime(clamp(st.rel/1000,.05,(COMP_REL[st.type]||.24)+.2),t,.02);
      ENG.compNode.knee.setTargetAtTime(14,t,.02);
      ENG.compLvl.gain.setTargetAtTime(db2g(st.lvl),t,.02);
      break;
    default:{
      const stage=STAGEMAP[mod];
      if(stage&&ENG.st[stage])ENG.st[stage].set(st);
    }
  }
}
function setTypeAudio(mod){if(ENG.on)applyParam(mod);}
function applyAllToAudio(){
  if(!ENG.on||!ENG.ctx)return;
  for(const m of ORDER)applyParam(m);
  ENG.applyGlobals();
}

/* =====================================================================
   UI
   ===================================================================== */
const ICONS={
  gate:'<svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 5v16M22 5v16"/><path d="M4 9h5M17 9h5M4 17h5M17 17h5"/></svg>',
  comp:'<svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M13 3v7M9.5 7l3.5 3.5L16.5 7"/><path d="M5 13h16M5 17h16M7 21h12"/></svg>',
  drive:'<svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 16h4l3-9 4 12 3-9 2 6h6"/></svg>',
  amp:'<svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="5" width="18" height="14" rx="2"/><path d="M9 16l3-6 2 4 3-6"/></svg>',
  ir:'<svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="13" cy="13" r="9"/><circle cx="13" cy="13" r="4.5"/></svg>',
  mod:'<svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 13c3-8 6-8 9 0s6 8 9 0"/></svg>',
  delay:'<svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="6" cy="13" r="3"/><circle cx="15" cy="13" r="2.2" opacity=".65"/><circle cx="21.5" cy="13" r="1.4" opacity=".35"/></svg>',
  rev:'<svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 7a8.5 8.5 0 010 12"/><path d="M11 9a5.5 5.5 0 010 8"/><path d="M16 11a2.8 2.8 0 010 4"/><path d="M2 13h1"/></svg>'
};
const SUBABBR={
  drive:t=>t.slice(0,8),amp:t=>t.slice(0,9),ir:t=>t.slice(0,9),
  delay:t=>({'PING-PONG':'PPONG'})[t]||t.slice(0,7),
  rev:t=>({'CATHEDRAL':'CTHDRL'})[t]||t.slice(0,7)
};
function subOf(mod){const t=PC[mod].type;return SUBABBR[mod]?SUBABBR[mod](t):t;}

function buildChain(){
  const host=$('#chain');host.innerHTML='';
  ORDER.forEach((mod,i)=>{
    const grp=document.createElement('div');grp.className='blkgroup';
    if(i>0){const l=document.createElement('div');l.className='link';grp.appendChild(l);}
    const d=DEFS[mod];
    const blk=document.createElement('div');
    blk.className='blk';blk.dataset.mod=mod;blk.tabIndex=0;blk.setAttribute('role','button');
    blk.innerHTML='<div class="top"><span class="bname">'+d.abbr+'</span><span class="bled"></span></div>'+
      '<div class="bicon">'+ICONS[mod]+'</div><span class="bt"></span>'+
      '<button class="pw" title="bypass '+d.name.toLowerCase()+'" aria-label="toggle '+d.name.toLowerCase()+'">◦</button>';
    blk.addEventListener('click',()=>selectMod(mod));
    blk.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectMod(mod);}});
    blk.querySelector('.pw').addEventListener('click',e=>{
      e.stopPropagation();setPower(mod,!PC[mod].on);});
    grp.appendChild(blk);host.appendChild(grp);
  });
  const cap=document.createElement('div');cap.className='endcap';cap.textContent='MAIN OUT';
  $('#chain').appendChild(cap);
}
function refreshChain(){
  document.querySelectorAll('.blk').forEach(b=>{
    const m=b.dataset.mod;
    b.classList.toggle('sel',m===curMod);
    b.classList.toggle('off',!PC[m].on);
    b.querySelector('.bt').textContent=subOf(m);
    b.title=DEFS[m].name+(PC[m].on?'':' (off)');
  });
}

function makeKnob(host,def,get,set){
  const kw=document.createElement('div');kw.className='kw';
  const norm=v=>def.log?Math.log(v/def.min)/Math.log(def.max/def.min):(v-def.min)/(def.max-def.min);
  const denorm=t=>def.log?def.min*Math.pow(def.max/def.min,clamp(t,0,1)):lerp(def.min,def.max,clamp(t,0,1));
  kw.innerHTML='<span class="klabel">'+def.label+'</span>'+
    '<div class="knob" tabindex="0" role="slider" aria-label="'+def.label+'" '+
      'aria-valuemin="'+def.min+'" aria-valuemax="'+def.max+'">'+
      '<svg viewBox="0 0 100 100">'+
        '<circle cx="50" cy="50" r="44" fill="none" stroke="#26262c" stroke-width="4" '+
          'stroke-dasharray="'+(2*Math.PI*44*.75)+' '+(2*Math.PI*44)+'" transform="rotate(135 50 50)" stroke-linecap="round"/>'+
        '<circle class="varc" cx="50" cy="50" r="44" fill="none" stroke="#FF5A1F" stroke-width="4" '+
          'stroke-linecap="round" transform="rotate(135 50 50)"/>'+
      '</svg><div class="cap"></div><div class="ptr"></div></div>'+
    '<div class="kvalue"></div>';
  host.appendChild(kw);
  const circ=2*Math.PI*44*.75;
  const varc=kw.querySelector('.varc'),ptr=kw.querySelector('.ptr'),
        kv=kw.querySelector('.kvalue'),knobEl=kw.querySelector('.knob');
  kw.paint=function(){
    const v=get(),t=clamp(norm(v),0,1);
    kv.textContent=fmtVal(v,def.unit);
    varc.setAttribute('stroke-dasharray',(circ*t)+' '+circ);
    ptr.style.transform='rotate('+(-135+270*t)+'deg)';
    knobEl.setAttribute('aria-valuenow',v.toFixed(2));
  };
  function adjust(dt){
    set(clamp(denorm(clamp(norm(get())+dt,0,1)),def.min,def.max));
    kw.paint();
  }
  let dragging=false,py=0;
  knobEl.addEventListener('pointerdown',e=>{dragging=true;py=e.clientY;knobEl.setPointerCapture(e.pointerId);e.preventDefault();});
  knobEl.addEventListener('pointermove',e=>{if(!dragging)return;const dy=py-e.clientY;py=e.clientY;adjust(dy*(e.shiftKey?.0006:.005));});
  knobEl.addEventListener('pointerup',()=>dragging=false);
  knobEl.addEventListener('pointercancel',()=>dragging=false);
  knobEl.addEventListener('dblclick',()=>{set(def.def);kw.paint();});
  knobEl.addEventListener('wheel',e=>{e.preventDefault();adjust(-Math.sign(e.deltaY)*(e.shiftKey?.004:.02));},{passive:false});
  knobEl.addEventListener('keydown',e=>{
    let dt=0;
    if(e.key==='ArrowUp'||e.key==='ArrowRight')dt=e.shiftKey?.005:.03;
    if(e.key==='ArrowDown'||e.key==='ArrowLeft')dt=e.shiftKey?-.005:-.03;
    if(dt){e.preventDefault();adjust(dt);}
  });
  kv.addEventListener('dblclick',()=>{set(def.def);kw.paint();});
  return kw;
}

const knobRefs={};
function selectMod(mod){
  curMod=mod;refreshChain();renderParams();refreshLCD();
  $('#hint').textContent=DEFS[mod].name.toUpperCase()+' — DRAG KNOBS VERTICALLY · DOUBLE-CLICK RESETS · SHIFT FOR FINE';
}
function setPower(mod,on){
  PC[mod].on=on;
  if(ENG.on)applyParam(mod);
  markDirty();refreshChain();refreshParamsMeta();refreshLCD();
}
function renderParams(){
  const host=$('#params');host.innerHTML='';
  const d=DEFS[curMod],st=PC[curMod];
  const num=String(ORDER.indexOf(curMod)+1).padStart(2,'0');
  const head=document.createElement('div');head.className='phead';
  head.innerHTML='<div class="ghost">'+num+'</div>'+
    '<div class="ptitlebox"><div class="pkind">FX BLOCK '+num+'/08</div>'+
    '<div class="ptitle" style="color:'+(st.on?'var(--ink)':'var(--faint)')+'">'+d.name+'</div>'+
    '<div class="pdesc">'+d.desc+'</div></div>';
  const ctl=document.createElement('div');ctl.className='pcontrols';head.appendChild(ctl);
  host.appendChild(head);

  if(d.types){
    const s=document.createElement('select');s.className='sel';
    d.types.forEach(t2=>{const o=document.createElement('option');o.value=o.textContent=t2;o.selected=t2===st.type;s.appendChild(o);});
    s.addEventListener('change',()=>{
      st.type=s.value;markDirty();
      setTypeAudio(curMod);refreshChain();refreshLCD();
      if(curMod==='delay'&&st.sync)setSyncTime();
    });
    ctl.appendChild(s);
  }
  if(curMod==='delay'){
    const chk=document.createElement('span');chk.className='chk'+(st.sync?' on':'');
    chk.innerHTML='<span class="box"></span>SYNC';
    chk.addEventListener('click',()=>{
      st.sync=!st.sync;chk.classList.toggle('on',st.sync);markDirty();
      setSyncTime();refreshParamsMeta();
      if(ENG.on)ENG.st.dly.refresh(st);
    });
    ctl.appendChild(chk);
    const dv=document.createElement('select');dv.className='sel';
    [['4','1 BAR'],['2','1/2'],['1.5','DOT 1/4'],['1','1/4'],['.75','DOT 1/8'],['.5','1/8'],['.25','1/16']]
      .forEach(pair=>{const o=document.createElement('option');
        o.value=pair[0];o.textContent=pair[1];
        o.selected=parseFloat(pair[0])===parseFloat(st.div);dv.appendChild(o);});
    dv.addEventListener('change',()=>{
      st.div=parseFloat(dv.value);markDirty();setSyncTime();
      if(ENG.on)ENG.st.dly.refresh(st);
    });
    ctl.appendChild(dv);
  }

  const row=document.createElement('div');row.className='knobrow';host.appendChild(row);
  knobRefs[curMod]=[];
  d.knobs.forEach(kd=>{
    const kw=makeKnob(row,kd,
      ()=>PC[curMod][kd.key],
      v=>{
        PC[curMod][kd.key]=v;markDirty();applyParam(curMod);
        if(curMod==='delay'&&st.sync&&kd.key==='time')setSyncTime();
      });
    kw.paint();row.appendChild(kw);knobRefs[curMod].push(kw);
  });
  refreshParamsMeta();

  const tip=document.createElement('div');tip.className='tip';
  tip.textContent='PARAMETER TIPS · '+({
    gate:'Live-input only behaviour. Judge tones cleanly with DEMO RIFF selected.',
    comp:'Watch the OUTPUT meter while raising SUSTAIN; compensate with LEVEL.',
    drive:'LOUDNESS is normalized across the DRIVE sweep — judge tone, not volume.',
    amp:'More GAIN auto-darkens the preamp (anti-fizz). Use PRESENCE to reopen the top.',
    ir:'HI CUT stacks with the cabinet\u2019s own voicing — pull down for darker rooms.',
    mod:'Runs pre-delay: dreamy washes. Tight leads may prefer it bypassed.',
    delay:'Enable SYNC for tempo-locked repeats with the drum clock.',
    rev:'Long PRE-DLY (>40ms) preserves riff clarity under big washes.'}[curMod]);
  host.appendChild(tip);
}
function refreshParamsMeta(){
  const refs=knobRefs[curMod]||[];
  if(curMod==='delay'&&refs[0])refs[0].classList.toggle('dis',!!PC.delay.sync);
  refs.forEach(k=>k.paint());
}
function setSyncTime(){
  const st=PC.delay;if(!st.sync)return;
  st.time=clamp(60000/PC.bpm*parseFloat(st.div),25,1500);
  (knobRefs['delay']||[]).forEach(k=>k.paint());
  if(ENG.on)applyParam('delay');
  autosave();
}

function buildIO(){
  document.querySelectorAll('[data-global]').forEach(el=>{
    const which=el.dataset.global;
    const def=which==='in'
      ?knot('v','INPUT',-12,12,CFG.in,'dB')
      :knot('v','OUTPUT',-24,6,CFG.out,'dB');
    makeKnob(el,def,()=>CFG[which],
      v=>{CFG[which]=Math.round(v*10)/10;saveCfg();ENG.applyGlobals();});
  });
}

function refreshLCD(){
  const ent=combinedLib()[libIdx],fac=!importedName&&ent.fac;
  $('#ptag').textContent=importedName?('IMPORT')
    :(fac?('FACTORY '+String(libIdx+1).padStart(2,'0'))
          :('USER '+String(libIdx-FACTORY.length+1).padStart(2,'0')));
  $('#pname').textContent=displayName().toUpperCase();
  $('.lcdu').textContent=fac?'F':'U';
  $('#lcdnum').textContent=String((libIdx%32)+1).padStart(2,'0');
  $('#lcdname').textContent=displayName().toUpperCase();
  $('#pbpm').textContent=PC.bpm;$('#lcdbpm').textContent=PC.bpm;
  const ch=$('#lcdchain');ch.innerHTML='';
  ORDER.forEach(m=>{
    const s=document.createElement('span');
    s.className='ltag'+(PC[m].on?' on':'')+(m===curMod?' cur':'');
    s.textContent=DEFS[m].abbr;
    ch.appendChild(s);
  });
  refreshStomps();
}
function refreshStomps(){
  const map={drive:'#stdrive',mod:'#stmod',delay:'#stdelay',rev:'#strev'};
  document.querySelectorAll('.stomp').forEach(b=>{
    const k=b.dataset.stomp;
    if(k==='tuner'){b.classList.toggle('on',tunerOn);return;}
    b.classList.toggle('on',PC[k].on);
    $(map[k]).textContent=PC[k].on?(subOf(k)||'ON'):'OFF';
  });
}

let tabMode='F';
function openDrawer(tab){
  tabMode=tab||tabMode;
  $('#drawer').classList.add('show');$('#scrim').classList.add('show');
  $('#tabF').classList.toggle('on',tabMode==='F');
  $('#tabU').classList.toggle('on',tabMode==='U');
  renderList();
}
function closeDrawer(){$('#drawer').classList.remove('show');$('#scrim').classList.remove('show');hidePop();}
function metaLine(pc){
  const bits=[pc.amp.type];
  if(pc.mod.on)bits.push(pc.mod.type);
  if(pc.delay.on)bits.push(pc.delay.type+(pc.delay.sync?' SYNC':Math.round(pc.delay.time)+'ms'));
  if(pc.rev.on)bits.push(pc.rev.type);
  return bits.join(' · ');
}
function renderList(){
  const host=$('#plist');host.innerHTML='';
  const lib=combinedLib();
  const items=lib.map((e,i)=>({e,i})).filter(item=>(tabMode==='F')===item.e.fac);
  if(!items.length){
    host.innerHTML='<div class="drempty">NO USER PRESETS YET.<BR>PATCH SOMETHING YOU LIKE AND HIT “STORE”.</div>';
    return;
  }
  items.forEach(item=>{
    const row=document.createElement('div');
    row.className='prow'+(item.i===libIdx&&!importedName?' cur':'');
    const num=(item.e.fac?'F':'U')+String((item.e.fac?item.i:item.i-FACTORY.length)+1).padStart(2,'0');
    row.innerHTML='<span class="pnum">'+num+'</span>'+
      '<span class="pnm"><div class="pnmt">'+item.e.name+'</div>'+
      '<div class="pnmm">'+metaLine(mergedPC(item.e))+'</div></span>';
    if(!item.e.fac){
      const del=document.createElement('button');del.className='del';del.textContent='DELETE';
      del.addEventListener('click',ev=>{
        ev.stopPropagation();
        if(del.classList.contains('arm')){
          const uIdx=item.i-FACTORY.length;
          userLib.splice(uIdx,1);LS.set(NS+'users',userLib);
          libIdx=clamp(libIdx>item.i?libIdx-1:(libIdx===item.i?Math.min(libIdx,FACTORY.length+userLib.length-1):libIdx),
                       0,FACTORY.length+userLib.length-1);
          LS.set(NS+'idx',libIdx);
          curName=combinedLib()[libIdx].name;importedName=null;
          snapshotToLS();
          renderList();refreshLCD();toast('User preset deleted','ok');
        }else{
          del.classList.add('arm');del.textContent='SURE?';
          setTimeout(()=>{del.classList.remove('arm');del.textContent='DELETE';},2200);
        }
      });
      row.appendChild(del);
    }
    row.addEventListener('click',()=>{loadIndex(item.i);closeDrawer();});
    host.appendChild(row);
  });
}
function loadIndex(i){
  const lib=combinedLib();
  i=clamp(i,0,lib.length-1);
  libIdx=i;LS.set(NS+'idx',libIdx);
  PC=mergedPC(lib[i]);clearDirty();
  curName=lib[i].name;importedName=null;
  drums.bpm=PC.bpm;$('#bpmSl').value=PC.bpm;$('#bpmVal').textContent=PC.bpm;
  if(ENG.on)applyAllToAudio();
  refreshChain();renderParams();refreshLCD();
  toast('Loaded '+lib[i].name,'ok');
}

function hidePop(){$('#pop').classList.remove('show');}
function showStorePop(){
  $('#pop').classList.add('show');
  const inp=$('#popName');
  const ent=combinedLib()[libIdx];
  inp.value=(!ent.fac&&!importedName)?curName:('MY PATCH '+String(userLib.length+1).padStart(2,'0'));
  const r=$('#storeBtn').getBoundingClientRect();
  $('#pop').style.top=(r.bottom+10)+'px';
  $('#pop').style.left=clamp(r.left-140,10,window.innerWidth-274)+'px';
  inp.focus();inp.select();
}
function commitStore(){
  const nm=($('#popName').value.trim().toUpperCase().slice(0,16))||'UNTITLED';
  const snap=JSON.parse(JSON.stringify(PC));delete snap.name;
  const existing=userLib.findIndex(u=>u.name===nm);
  if(existing>=0){
    userLib[existing]={name:nm,p:snap};
    libIdx=FACTORY.length+existing;
    toast('“'+nm+'” overwritten in user bank','ok');
  }else{
    userLib.push({name:nm,p:snap});
    libIdx=FACTORY.length+userLib.length-1;
    toast('Stored “'+nm+'” to user bank','ok');
  }
  LS.set(NS+'users',userLib);LS.set(NS+'idx',libIdx);
  curName=nm;importedName=null;
  clearDirty();hidePop();
  refreshLCD();
  if($('#drawer').classList.contains('show'))renderList();
  $('#st-presets').textContent=(FACTORY.length+userLib.length)+' PRESET SLOTS';
}

function doExport(){
  const data={format:'softclip-preset',version:1,
    meta:{origin:importedName?'imported':(combinedLib()[libIdx].fac?'factory-clone':'user')},
    name:displayName(),patch:JSON.parse(JSON.stringify(PC))};
  delete data.patch.name;
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='SOFTCLIP_'+displayName().replace(/[^\w]+/g,'_')+'.preset.json';
  a.click();setTimeout(()=>URL.revokeObjectURL(a.href),4000);
  toast('Preset exported','ok');
}
 $('#fileimp').addEventListener('change',async e=>{
  const f=e.target.files[0];e.target.value='';
  if(!f)return;
  try{
    const j=JSON.parse(await f.text());
    if(!j.patch)throw new Error('no patch field');
    PC=mergedPC({name:j.name||'IMPORTED',p:j.patch});
    importedName=(j.name||'IMPORTED').toUpperCase().slice(0,16);
    markDirty();refreshChain();renderParams();refreshLCD();
    if(ENG.on)applyAllToAudio();
    toast('Imported “'+importedName+'” — press STORE to keep it','ok');
  }catch(err){toast('Not a valid preset file','err');}
});

/* tuner */
let tunerOn=false;
const TN={buf:new Float32Array(2048),fx:0,note:-1,cents:0,frame:0};
function detectPitch(buf,sr){
  let rms=0;const N=buf.length;
  for(let i=0;i<N;i++)rms+=buf[i]*buf[i];
  rms=Math.sqrt(rms/N);
  if(rms<.006)return null;
  let bestOff=-1,bestCor=0;
  const maxOff=Math.min(N>>1,Math.floor(sr/65)),minOff=Math.floor(sr/620);
  for(let off=minOff;off<=maxOff;off++){
    let cor=0,nrm=0;
    for(let i=0;i<N-off;i+=2){cor+=buf[i]*buf[i+off];nrm+=buf[i]*buf[i];}
    const corr=cor/(nrm+1e-9);
    if(corr>.92&&corr>bestCor){bestCor=corr;bestOff=off;}
    else if(bestOff>0&&corr<bestCor*.7)break;
  }
  return bestOff<0?null:sr/bestOff;
}
function pollTuner(){
  if(!tunerOn||!ENG.on){TN.note=-1;return;}
  if(++TN.frame%3)return;
  ENG.tnAn.getFloatTimeDomainData(TN.buf);
  const f=detectPitch(TN.buf,ENG.ctx.sampleRate);
  if(f){
    TN.fx=f;
    const midi=69+12*Math.log2(f/440);
    TN.note=Math.round(midi);TN.cents=(midi-TN.note)*100;
  }else TN.note=-1;
}

/* drum machine */
const PATS=(()=>{
  const rows={};
  const mk=(k,s,h)=>{
    const arr=str=>str.split('').map(c=>c==='x'?1:0);
    return {K:arr(k),S:arr(s),H:arr(h)};
  };
  rows['ROCK']      =Object.assign({sw:0},  mk('x...x...x...x...','....x.......x...','x.x.x.x.x.x.x.x.'));
  rows['FUNK 16']   =Object.assign({sw:0},  mk('x.....x...x.....','....x..x....x..x','xxxxxxxxxxxxxxxx'));
  rows['SHUFFLE']   =Object.assign({sw:.33},mk('x.....x.x.....x.','....x.......x...','xx.xx.xx.xx.xx.x'));
  rows['THRASH']    =Object.assign({sw:0},  mk('xx..xx..xx..xx..','....x.......x...','xxxxxxxxxxxxxxxx'));
  rows['SLOW BLUES']=Object.assign({sw:.28},mk('x.......x.......','........x.......','x..x..x.x..x..x.'));
  return rows;
})();
const drums={
  playing:false,bpm:120,step:0,nextT:0,timer:null,pat:'ROCK',lv:CFG.drumLv,
  setBpm(v,quiet){
    this.bpm=clamp(Math.round(v),40,240);
    PC.bpm=this.bpm;
    $('#bpmSl').value=this.bpm;$('#bpmVal').textContent=this.bpm;
    refreshLCD();autosave();
    if(PC.delay.sync){setSyncTime();if(ENG.on)ENG.st.dly.refresh(PC.delay);}
    if(!quiet&&this.playing)scheduleTick();
  },
  async start(){
    try{ await ENG.ensure(); }
    catch(err){ toast('Could not start audio: '+(err.message||err),'err'); return; }
    this.playing=true;this.step=0;this.nextT=ENG.ctx.currentTime+.06;
    this.timer=setInterval(scheduleTick,25);
    $('#drumBtn').classList.add('on');$('#drumBtn').textContent='■ STOP';
    refreshStatus();
  },
  stop(){
    this.playing=false;clearInterval(this.timer);this.timer=null;
    $('#drumBtn').classList.remove('on');$('#drumBtn').textContent='► PLAY';
    document.querySelectorAll('#beats i').forEach(b=>b.classList.remove('hit'));
    refreshStatus();
  },
  kick(t){const c=ENG.ctx,o=c.createOscillator(),g=c.createGain();
    o.frequency.setValueAtTime(150,t);o.frequency.exponentialRampToValueAtTime(44,t+.12);
    g.gain.setValueAtTime(this.lv,t);g.gain.exponentialRampToValueAtTime(.001,t+.26);
    o.connect(g);g.connect(c.destination);o.start(t);o.stop(t+.3);},
  snare(t,v){const c=ENG.ctx;
    const o=c.createOscillator(),og=c.createGain();o.type='triangle';o.frequency.value=196;
    og.gain.setValueAtTime(.35*this.lv*v,t);og.gain.exponentialRampToValueAtTime(.001,t+.12);
    o.connect(og);og.connect(c.destination);o.start(t);o.stop(t+.14);
    const nb=c.createBuffer(1,Math.floor(c.sampleRate*.18),c.sampleRate),d=nb.getChannelData(0);
    for(let i=0;i<d.length;i++)d[i]=(Math.random()*2-1)*Math.pow(1-i/d.length,1.7);
    const ns=c.createBufferSource();ns.buffer=nb;
    const nf=c.createBiquadFilter();nf.type='highpass';nf.frequency.value=1700;
    const ng=c.createGain();ng.gain.setValueAtTime(.5*this.lv*v,t);ng.gain.exponentialRampToValueAtTime(.001,t+.16);
    ns.connect(nf);nf.connect(ng);ng.connect(c.destination);ns.start(t);},
  hat(t,v){const c=ENG.ctx;
    const nb=c.createBuffer(1,Math.floor(c.sampleRate*.06),c.sampleRate),d=nb.getChannelData(0);
    for(let i=0;i<d.length;i++)d[i]=(Math.random()*2-1)*Math.pow(1-i/d.length,2.4);
    const ns=c.createBufferSource();ns.buffer=nb;
    const hf=c.createBiquadFilter();hf.type='highpass';hf.frequency.value=7800;
    const hg=c.createGain();hg.gain.setValueAtTime(.16*this.lv*v,t);hg.gain.exponentialRampToValueAtTime(.001,t+.05);
    ns.connect(hf);hf.connect(hg);hg.connect(c.destination);ns.start(t);}
};
function scheduleTick(){
  const c=ENG.ctx;if(!c||!drums.playing)return;
  const p=PATS[drums.pat],spb=60/drums.bpm/4;
  while(drums.nextT<c.currentTime+.12){
    const st=drums.step;
    const sway=(st%2===1)?p.sw*spb:0;
    const t=drums.nextT+sway;
    if(p.K[st])drums.kick(t);
    if(p.S[st])drums.snare(t,.9);
    if(p.H[st])drums.hat(t,p.H[st]);
    if(st%4===0)flashBeat(st/4,t);
    drums.nextT+=spb;
    drums.step=(drums.step+1)%16;
  }
}
function flashBeat(q,t){
  const delayMs=Math.max(0,(t-((ENG.ctx&&ENG.ctx.currentTime)||0))*1000);
  setTimeout(()=>{
    document.querySelectorAll('#beats i').forEach((b,i)=>b.classList.toggle('hit',i===q));
    const led=$('#tapled');led.classList.add('hit');
    setTimeout(()=>led.classList.remove('hit'),90);
    setTimeout(()=>document.querySelectorAll('#beats i').forEach(b=>b.classList.remove('hit')),130);
  },delayMs);
}
const taps=[];
function tap(){
  const now=performance.now();
  if(taps.length&&now-taps[taps.length-1]>2000)taps.length=0;
  taps.push(now);if(taps.length>5)taps.shift();
  if(taps.length>=2){
    let sum=0;for(let i=1;i<taps.length;i++)sum+=taps[i]-taps[i-1];
    drums.setBpm(60000/(sum/(taps.length-1)));
  }
  const led=$('#tapled');led.classList.add('hit');setTimeout(()=>led.classList.remove('hit'),80);
}

/* meters + scope */
const scopeCv=$('#scope');const sg=scopeCv.getContext('2d');
const pkIn={v:0,t:0},pkOut={v:0,t:0};
const inBuf=new Float32Array(512);
const waveBuf=new Float32Array(512);
function resizeScope(){
  const r=scopeCv.parentElement.getBoundingClientRect();
  const dpr=Math.min(2,devicePixelRatio||1);
  scopeCv.width=Math.max(2,Math.round(r.width*dpr));
  scopeCv.height=Math.max(2,Math.round(r.height*dpr));
  sg.setTransform(dpr,0,0,dpr,0,0);
}
addEventListener('resize',resizeScope);

function meterPair(fillId,pkId,numId,rms,hold){
  const db=20*Math.log10(Math.max(1e-4,rms));
  const nrm=clamp((db+54)/54,0,1);
  $(fillId).style.width=(nrm*100)+'%';
  $(numId).textContent=db<-53?'-∞':db.toFixed(0);
  const now=performance.now();
  if(nrm>hold.v){hold.v=nrm;hold.t=now;}
  else if(now-hold.t>900)hold.v=Math.max(0,hold.v-.012);
  $(pkId).style.left=(hold.v*100)+'%';
}
function drawSpark(now){
  const until=ENG.sparkUntil||0;
  if(until<=now)return false;
  const p=1-(until-now)/900;
  const dpr=Math.min(2,devicePixelRatio||1);
  const w=scopeCv.width/dpr,h=scopeCv.height/dpr;
  const frac=Math.min(1,p*1.25);
  const eased=frac<.5?2*frac*frac:1-Math.pow(-2*frac+2,2)/2;
  sg.save();
  sg.strokeStyle='#FF5A1F';sg.lineWidth=2;sg.lineCap='round';
  sg.shadowColor='rgba(255,90,31,.8)';sg.shadowBlur=8;
  sg.beginPath();
  const N=96,K=7.5,AMP=h*.37;
  let started=false;
  const M=Math.floor(N*eased);
  for(let i=0;i<=M;i++){
    const xn=i/N;
    const px=xn*w;
    const py=h/2-Math.tanh((xn-.5)*K)*AMP;
    started?sg.lineTo(px,py):(sg.moveTo(px,py),started=true);
  }
  sg.stroke();sg.restore();
  return until-now>60;
}
function drawFrame(){
  requestAnimationFrame(drawFrame);
  const now=performance.now();
  const dpr=Math.min(2,devicePixelRatio||1);
  const w=scopeCv.width/dpr,h=scopeCv.height/dpr;
  sg.clearRect(0,0,w,h);
  sg.strokeStyle='#182028';sg.lineWidth=1;
  for(let x=0;x<w;x+=26){sg.beginPath();sg.moveTo(x,0);sg.lineTo(x,h);sg.stroke();}
  const sparking=!tunerOn&&drawSpark(now);
  if(!tunerOn&&!sparking){
    if(ENG.on){
      ENG.scAn.getFloatTimeDomainData(waveBuf);
      sg.beginPath();sg.strokeStyle='#ffb347';sg.lineWidth=1.4;
      for(let i=0;i<waveBuf.length;i++){
        const x=i/(waveBuf.length-1)*w,y=h/2-waveBuf[i]*h*.46;
        i?sg.lineTo(x,y):sg.moveTo(x,y);
      }
      sg.stroke();
    }else{
      sg.strokeStyle='#3a4450';sg.beginPath();sg.moveTo(0,h/2);sg.lineTo(w,h/2);sg.stroke();
    }
  }
  const tp=$('#tunerpage');
  tp.classList.toggle('show',tunerOn);
  if(tunerOn){
    pollTuner();
    if(TN.note>=0){
      const nn=((TN.note%12)+12)%12,oct=Math.floor(TN.note/12)-1;
      $('#tnote').textContent=notes[nn];$('#tnoct').textContent=oct;
      $('#tfreq').textContent=TN.fx.toFixed(1)+' Hz';
      $('#tneedle').style.left=(50+clamp(TN.cents,-50,50))+'%';
      const vd=$('#tverd');
      if(Math.abs(TN.cents)<4){vd.textContent='IN TUNE';vd.className='tverdict ok';}
      else{vd.textContent=TN.cents<0?'FLAT ♭':'SHARP ♯';vd.className='tverdict';}
    }else{
      $('#tnote').textContent='—';$('#tnoct').textContent='';
      $('#tfreq').textContent='play a note…';
      $('#tneedle').style.left='50%';
      const vd=$('#tverd');vd.innerHTML='&nbsp;';vd.className='tverdict';
    }
  }
  /* input meter: non-mic sources measured at pre-comp analysers */
  if(ENG.on&&SRC.mode!=='MIC'){
    ENG.tnAn.getFloatTimeDomainData(inBuf);
    let s1=0;for(let i=0;i<inBuf.length;i++)s1+=inBuf[i]*inBuf[i];
    ENG.inDb=20*Math.log10(Math.max(1e-4,Math.sqrt(s1/inBuf.length)));
  }
  let inRms=0,outRms=0;
  if(ENG.on){
    inRms=Math.pow(10,ENG.inDb/20);
    ENG.anOut.getFloatTimeDomainData(waveBuf);
    let s2=0;for(let i=0;i<waveBuf.length;i++)s2+=waveBuf[i]*waveBuf[i];
    outRms=Math.sqrt(s2/waveBuf.length);
    $('#loutf').style.width=(clamp((20*Math.log10(Math.max(1e-4,outRms))+48)/48,0,1)*100)+'%';
    $('#lcdinfo2').textContent='SIGNAL LIVE';
  }else{
    $('#loutf').style.width='0%';
    $('#lcdinfo2').textContent='SIGNAL READY';
  }
  meterPair('#mfin','#mpkin','#ming',inRms,pkIn);
  meterPair('#mfout','#mpkout','#mout',outRms,pkOut);
}

function refreshStatus(){
  const st=$('#st-engine');
  st.textContent='ENGINE: '+(ENG.on?'LIVE':'BYPASS');
  st.className=ENG.on?'lit':'unlit';
  $('#lstatus').textContent=ENG.on?(tunerOn?'TUNER':(drums.playing?'DRUMS + CHAIN':'CHAIN LIVE')):'ENGINE OFF';
  $('#lcdmode').textContent=tunerOn?'TUNER':'PLAY';
  $('#lcdmode').classList.toggle('tun',tunerOn);
  $('#engageBtn').textContent=ENG.on?'● ENGINE ON':'● ENGINE OFF';
  $('#engageBtn').classList.toggle('on',ENG.on);
}

/* =====================================================================
   EVENT WIRING
   ===================================================================== */
 $('#prevP').addEventListener('click',()=>loadIndex((libIdx-1+combinedLib().length)%combinedLib().length));
 $('#nextP').addEventListener('click',()=>loadIndex((libIdx+1)%combinedLib().length));
 $('#ptitle').addEventListener('click',()=>openDrawer());
 $('#libBtn').addEventListener('click',()=>openDrawer());
 $('#storeBtn').addEventListener('click',showStorePop);
 $('#storeBtn2').addEventListener('click',showStorePop);
 $('#popCancel').addEventListener('click',hidePop);
 $('#popStore').addEventListener('click',commitStore);
 $('#popName').addEventListener('keydown',e=>{if(e.key==='Enter')commitStore();if(e.key==='Escape')hidePop();});
 $('#expBtn').addEventListener('click',doExport);
 $('#impBtn').addEventListener('click',()=>$('#fileimp').click());

 $('#pingBtn').addEventListener('click',()=>ENG.ping());

/* engine toggle remembers current source choice */
 $('#engageBtn').addEventListener('click',()=>{
  if(ENG.on)SRC.stop();
  else SRC.start(SRC.mode||'MIC');
});

document.querySelectorAll('.srcbtn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    const mode=btn.dataset.src;
    if(mode==='FILE'){$('#filesong').click();return;}
    SRC.start(mode);
  });
});
 $('#filesong').addEventListener('change',async e=>{
  const f=e.target.files[0];e.target.value='';
  if(!f)return;
  try{
    await ENG.ensure();
    const data=await ENG.ctx.decodeAudioData(await f.arrayBuffer());
    SRC.start('FILE',{data,name:f.name});
  }catch(err){toast('Could not decode that audio file','err');}
});

 $('#devSel').addEventListener('change',()=>{
  CFG.devId=$('#devSel').value;saveCfg();
  if(SRC.mode==='MIC'){         // hot-swap the input
    SRC.devId=CFG.devId;
    SRC.start('MIC');
  }
});

 $('#drClose').addEventListener('click',closeDrawer);
 $('#scrim').addEventListener('click',closeDrawer);
 $('#tabF').addEventListener('click',()=>openDrawer('F'));
 $('#tabU').addEventListener('click',()=>openDrawer('U'));
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){closeDrawer();hidePop();}
});

document.querySelectorAll('.stomp').forEach(btn=>{
  btn.addEventListener('click',()=>{
    const k=btn.dataset.stomp;
    if(k==='tuner'){
      tunerOn=!tunerOn;refreshStatus();refreshStomps();
      toast(tunerOn?'Tuner on — reads your raw input':'Tuner off');
      return;
    }
    setPower(k,!PC[k].on);
  });
});

const patSel=$('#patSel');
Object.keys(PATS).forEach(k=>{const o=document.createElement('option');o.value=o.textContent=k;patSel.appendChild(o);});
patSel.addEventListener('change',()=>drums.pat=patSel.value);
 $('#drumBtn').addEventListener('click',()=>drums.playing?drums.stop():drums.start());
 $('#tapBtn').addEventListener('click',tap);
 $('#bpmSl').addEventListener('input',e=>drums.setBpm(parseFloat(e.target.value)));
 $('#drmLv').addEventListener('input',e=>{drums.lv=parseFloat(e.target.value);CFG.drumLv=drums.lv;saveCfg();});

(function init(){
  loadLS();
  buildChain();
  selectMod(curMod);
  buildIO();
  refreshLCD();
  resizeScope();
  drums.bpm=PC.bpm;$('#bpmSl').value=PC.bpm;$('#bpmVal').textContent=PC.bpm;
  $('#drmLv').value=CFG.drumLv;
  $('#st-presets').textContent=(FACTORY.length+userLib.length)+' PRESET SLOTS';
  requestAnimationFrame(drawFrame);
})();
