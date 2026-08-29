"use strict";
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

/* Shared on/off edge-detector for the simple stages (drive/amp/cab/rev) whose
   processing chain is a fixed, always-built set of nodes — only the bypass
   crossfade needs to run, and only on an actual off<->on transition (calling
   activate()/straight() again on every set() would just re-trigger pointless
   setTargetAtTime ramps). Stages with a dynamically rebuilt graph (mod, delay)
   have their own on/off + teardown logic and don't use this. */
function gateStage(w,on,entry,exit){
  if(w._routed===on)return;
  w._routed=on;
  on?w.activate(entry,exit):w.straight();
}

/* Quantizes a continuous control value to a cache-key step, so an expensive
   Float32Array waveshaper curve gets rebuilt only when the knob has moved far
   enough to actually sound different — not on every animation-frame tick while
   dragging. */
const quantize=(v,step)=>Math.round(v/step)*step;

/* hp: input highpass corner (Hz)
   ls: low shelf {f,g} · th: "throat" peak {f,g,q} · gr: grit peak {f,g,q}
   dz: fizz-cut peak {f,g,q} (usually negative g — notches out speaker fizz)
   tl: top shelf {f,g} · lp: final lowpass corner (Hz), cascaded through two
       matched sections below for a steeper rolloff than one biquad gives */
const CAPROF={
  '4X12 VINT 30':{hp:90, ls:{f:90, g:1.5},      th:{f:105, g:2.5,q:.8},gr:{f:850, g:2.0,q:.9},dz:{f:2800,g:-2.0,q:1.1},tl:{f:3200,g:-1.0},lp:5400},
  '4X12 MODERN': {hp:110,ls:{f:95, g:1.0},      th:{f:120, g:3.0,q:1.0},gr:{f:950, g:2.5,q:.9},dz:{f:3100,g:-3.0,q:1.2},tl:{f:3600,g:-2.0},lp:4700},
  '2X12 PLEXI':  {hp:100,ls:{f:100,g:1.0},      th:{f:115, g:2.0,q:.8}, gr:{f:800, g:1.5,q:.8},dz:{f:2600,g:-1.5,q:1.0},tl:{f:3000,g:-.5}, lp:5800},
  '1X12 ALNICO': {hp:105,ls:{f:105,g:.5},       th:{f:125, g:3.5,q:.7}, gr:{f:1050,g:2.2,q:.8},dz:{f:3300,g:-1.2,q:.9}, tl:{f:4000,g:.5},  lp:6800},
  '2X10 TWEED':  {hp:80, ls:{f:95, g:2.0},      th:{f:110, g:2.0,q:.8}, gr:{f:700, g:1.5,q:.8},dz:{f:2400,g:-.8, q:.9}, tl:{f:2800,g:.8},  lp:6200},
  'OPEN 1X12':   {hp:95, ls:{f:110,g:.5},       th:{f:130, g:2.0,q:.7}, gr:{f:1150,g:1.8,q:.8},dz:{f:3500,g:-1.5,q:.9}, tl:{f:4200,g:0},   lp:7000},
  'DARK 2X12':   {hp:80, ls:{f:90, g:1.5},      th:{f:100, g:2.0,q:.8}, gr:{f:600, g:1.0,q:.8},dz:{f:2200,g:-2.5,q:1.0},tl:{f:2600,g:-2.0},lp:4300},
  'FLAT FRFR':   {hp:35, ls:{f:80, g:0},        th:{f:90,  g:0,  q:.7}, gr:{f:800, g:0,  q:.8},dz:{f:3000,g:0,  q:1},  tl:{f:4000,g:0},   lp:16000}
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
    let cache='';
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
        gateStage(w,!!st.on,hp,mk);
        if(!st.on)return;
        const K=KIND[st.type]||KIND.SCREAMER;
        hp.frequency.setTargetAtTime(K.hpL*.6,c.currentTime,.02);
        lp.frequency.setTargetAtTime(clamp(500*Math.pow(Math.max(.05,st.tone/10),1.9)*9,300,11000),c.currentTime,.02);
        const ck=st.type+'|'+quantize(st.drv,.05);
        if(ck!==cache){cache=ck;sh.curve=curve(st.type,st.drv);}
        /* loudness match: harder clipping (higher DRIVE) raises the curve's average
           level, so scale makeup gain back down as DRIVE climbs — keeps perceived
           volume roughly constant while sweeping the knob, per DEFS.drive's promise
           of a "loudness-normalized" DRIVE control. */
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
    /* hp:      input highpass corner (Hz)
       hs:      voicing highshelf {f,g} — TREBLE knob adds to hs.g on top
       pk:      voicing peaking filter {f,g,q} — the amp's character notch/bump
       k:       waveshaper drive-curve intensity at GAIN=10 (bigger = more clip)
       dark:    post-clip lowpass endpoints {bright,dark} (Hz) — lerped by how far
                GAIN has pushed the curve, so the tone darkens as gain climbs
       deep:    low-shelf boost (dB) added to the power-stage low end as gain climbs */
    const VOICE={
      'TWEED DLX':   {hp:60, hs:{f:1500,g:1.2}, pk:{f:900, g:1,  q:.7}, k:14, dark:{bright:5200,dark:3000}, deep:0},
      'BLACKFACE':   {hp:70, hs:{f:1500,g:.4},  pk:{f:700, g:.6, q:.7}, k:6,  dark:{bright:6000,dark:3600}, deep:0},
      'AC CHIME':    {hp:95, hs:{f:2200,g:1},   pk:{f:2600,g:1.4,q:.8}, k:8,  dark:{bright:7200,dark:4200}, deep:0},
      'BLUES 30':    {hp:85, hs:{f:1800,g:.8},  pk:{f:750, g:1.6,q:.9}, k:11, dark:{bright:6400,dark:3800}, deep:0},
      'PLEXI 100':   {hp:100,hs:{f:1300,g:.6},  pk:{f:700, g:1,  q:.8}, k:22, dark:{bright:5200,dark:2400}, deep:1.5},
      'ROAR 800':    {hp:120,hs:{f:1300,g:.4},  pk:{f:680, g:.8, q:.8}, k:32, dark:{bright:4800,dark:2200}, deep:1.5},
      'RECTO MODERN':{hp:135,hs:{f:1100,g:0},   pk:{f:550, g:0,  q:.8}, k:48, dark:{bright:4200,dark:1700}, deep:2.5},
      'SLO LEAD':    {hp:110,hs:{f:1200,g:.6},  pk:{f:620, g:1.8,q:.9}, k:40, dark:{bright:5000,dark:2100}, deep:1.5}
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
    let kc='';
    return {
      in:w.in,out:w.out,
      set(st){
        gateStage(w,!!st.on,vhp,sc);
        if(!st.on)return;
        const t=c.currentTime,V=VOICE[st.type]||VOICE['TWEED DLX'];
        vhp.frequency.setTargetAtTime(V.hp,t,.02);
        vsh.frequency.value=V.hs.f;vsh.gain.setTargetAtTime(V.hs.g+st.treble*.08,t,.02);
        vpk.frequency.value=V.pk.f;vpk.gain.setTargetAtTime(V.pk.g,t,.02);vpk.Q.value=V.pk.q;
        tB.gain.setTargetAtTime(st.bass,t,.02);
        tM.gain.setTargetAtTime(st.mid,t,.02);
        tT.gain.setTargetAtTime(st.treble*.65,t,.02);
        const kk=V.k*(0.35+st.gain*0.32);
        const key=quantize(kk,.5);
        if(key!==kc){kc=key;sh1.curve=curve1(kk);sh2.curve=curve2(kk);}
        /* frac: 0 at GAIN's lowest reach (.35×k), 1 at GAIN=10 (k) — drives the
           adaptive darkening described in DEFS.amp: as gain climbs, both the
           post-clip lowpass and the power-stage low end move with it. */
        const frac=clamp((kk-V.k*.35)/(V.k*.65),0,1);
        s1lp.frequency.setTargetAtTime(lerp(V.dark.bright,V.dark.dark,frac),t,.05);
        lpF.frequency.setTargetAtTime(lerp(Math.min(V.dark.bright+900,7200),4500,frac),t,.05);
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
    let profKey='';
    return {
      in:w.in,out:w.out,
      set(st){
        gateStage(w,!!st.on,lcf,g);
        if(!st.on)return;
        const t=c.currentTime,P=CAPROF[st.type]||CAPROF['FLAT FRFR'];
        if(profKey!==st.type){
          profKey=st.type;
          hpB.frequency.setTargetAtTime(P.hp,t,.04);
          ls.frequency.value=P.ls.f;ls.gain.setTargetAtTime(P.ls.g,t,.04);
          thPk.frequency.value=P.th.f;thPk.gain.setTargetAtTime(P.th.g,t,.04);thPk.Q.value=P.th.q;
          grPk.frequency.value=P.gr.f;grPk.gain.setTargetAtTime(P.gr.g,t,.04);grPk.Q.value=P.gr.q;
          dzPk.frequency.value=P.dz.f;dzPk.gain.setTargetAtTime(P.dz.g,t,.04);dzPk.Q.value=P.dz.q;
          tl.frequency.value=P.tl.f;tl.gain.setTargetAtTime(P.tl.g,t,.04);
          lpA.frequency.setTargetAtTime(P.lp,t,.04);
          lpB.frequency.setTargetAtTime(P.lp,t,.04);   // matched pair — see comment above CAPROF
        }
        lcf.frequency.setTargetAtTime(st.cut,t,.02);
        hcf.frequency.setTargetAtTime(st.hicut,t,.02);
        g.gain.setTargetAtTime(db2g(st.lvl)*1.25,t,.02);   // makeup gain: compensates the filter network's insertion loss above
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
    /* One sine oscillator per voice, phase-shifted with a DelayNode instead of a
       second oscillator: delaying a sinusoid by (phaseFrac × period) is exactly
       equivalent to a phaseFrac×360° phase shift, so a plain audio-rate delay
       gives an exact phase-offset LFO for free. `coef` scales the ±1 sine into
       the units the destination AudioParam expects (seconds, Hz, gain, ...). */
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
            /* recenters the AM around .7 instead of a GainNode's default 1, so the
               LFO (amDepth, below) has headroom to swing symmetrically without
               clipping against the 1.0 ceiling. Without ConstantSourceNode support
               this degrades gracefully to a 1.0 center — a slightly less pronounced
               rotary AM, but never broken. */
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
    let pend=null,lastIrKey='';
    return {
      in:w.in,out:w.out,
      set(st){
        const t=c.currentTime;
        gateStage(w,!!st.on,pre,wg);
        if(!st.on)return;
        pre.delayTime.setTargetAtTime(clamp(st.pre/1000,0,.29),t,.02);
        tl.frequency.setTargetAtTime(lerp(2400,15500,st.tone/10),t,.02);
        wg.gain.setTargetAtTime(st.mix/100*.7,t,.02);
        /* IR synthesis (getRevIR, below) is the expensive part — up to 10s of
           stereo noise-shaped audio — so debounce it: only resynthesize once
           DECAY/TONE/type have settled for 140ms, not on every drag tick. */
        clearTimeout(pend);
        pend=setTimeout(()=>{
          const k=st.type+'|'+st.dec.toFixed(2)+'|'+st.tone.toFixed(1);
          if(lastIrKey===k)return;
          lastIrKey=k;
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
