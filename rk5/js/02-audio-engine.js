"use strict";
/* =====================================================================
   AUDIO ENGINE — Boost/Comp -> Grit -> Preamp -> [Reverb + Delay/Rotary
   in PARALLEL, summed] -> limiter -> destination. No noise gate: the
   pedal this models doesn't have one.
   ===================================================================== */

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
/* on/off edge-detector for the three serial insert stages (boost/grit/pre) —
   see softclip's js/02-audio-engine.js for the fuller writeup of why this
   exists instead of calling activate()/straight() unconditionally. */
function gateStage(w,on,entry,exit){
  if(w._routed===on)return;
  w._routed=on;
  on?w.activate(entry,exit):w.straight();
}
const quantize=(v,step)=>Math.round(v/step)*step;

const ENG={
  ctx:null,on:false,st:{},revCache:new Map(),inDb:-60,

  async boot(){
    if(this.ctx)return;
    const AC=window.AudioContext||window.webkitAudioContext;
    this.ctx=new AC({latencyHint:'interactive'});
    const c=this.ctx;

    this.head=c.createGain();
    this.tnAn=c.createAnalyser();this.tnAn.fftSize=2048;
    this.head.connect(this.tnAn);

    this.st.boost=this.makeBoost();
    this.st.grit =this.makeGrit();
    this.st.pre  =this.makePreamp();
    this.st.rev  =this.makeReverb();
    this.st.dly  =this.makeDelayRoto();

    for(const k of ['boost','grit','pre','rev','dly']){
      const s=this.st[k];
      if(!s||!(s.in instanceof AudioNode)||!(s.out instanceof AudioNode)||typeof s.set!=='function')
        throw new Error('boot: stage "'+k+'" failed init');
    }

    /* serial insert chain up to the preamp, then a parallel wet-send split:
       PRE's output feeds the mix bus directly (dry) AND feeds REV/DLY,
       whose own outputs are wet-only and rejoin the same mix bus. */
    this.head.connect(this.st.boost.in);
    this.st.boost.out.connect(this.st.grit.in);
    this.st.grit.out.connect(this.st.pre.in);

    this.mixBus=c.createGain();
    this.st.pre.out.connect(this.mixBus);
    this.st.pre.out.connect(this.st.rev.in);
    this.st.pre.out.connect(this.st.dly.in);
    this.st.rev.out.connect(this.mixBus);
    this.st.dly.out.connect(this.mixBus);

    this.limit=c.createDynamicsCompressor();
    this.limit.threshold.value=-1.5;this.limit.knee.value=0;
    this.limit.ratio.value=20;this.limit.attack.value=.002;this.limit.release.value=.12;
    this.anOut=c.createAnalyser();this.anOut.fftSize=1024;

    this.mixBus.connect(this.limit);this.limit.connect(this.anOut);this.anOut.connect(c.destination);

    this.applyGlobals();
  },

  async ensure(){ if(!this.ctx)await this.boot(); await this.ctx.resume(); },

  setEngine(onFlag){
    this.on=!!onFlag;
    document.body.classList.toggle('audio-on',this.on);
    if(this.on){this.sparkUntil=performance.now()+900;applyAllToAudio();}
    refreshStatus();
  },

  ping(){
    if(!this.ctx||!this.on){toast('Arm the engine first (pick an input)','err');return;}
    const c=this.ctx,o=c.createOscillator(),g=c.createGain();
    o.frequency.value=880;
    g.gain.setValueAtTime(.28,c.currentTime);
    g.gain.exponentialRampToValueAtTime(.0001,c.currentTime+.22);
    o.connect(g);g.connect(this.mixBus);
    o.start();o.stop(c.currentTime+.25);
    toast('Ping sent through the chain — hearing it means the signal path is alive','ok');
  },

  applyGlobals(){
    if(!this.ctx)return;const t=this.ctx.currentTime;
    this.head.gain.setTargetAtTime(db2g(CFG.in),t,.02);
    this.mixBus.gain.setTargetAtTime(db2g(CFG.out),t,.02);
  },

  /* ============================ BOOST & COMP ============================ */
  makeBoost(){
    const c=this.ctx,w=makeStage(c);
    const bg=c.createGain();
    const cmp=c.createDynamicsCompressor();  // fixed "old-school FET" character — no user params, just in/out of circuit
    cmp.threshold.value=-22;cmp.knee.value=8;cmp.ratio.value=3.5;cmp.attack.value=.006;cmp.release.value=.14;
    const lvl=c.createGain();
    cmp.connect(lvl);
    let compOn=null;
    return {
      in:w.in,out:w.out,
      set(st){
        gateStage(w,!!st.on,bg,lvl);
        if(!st.on)return;
        const t=c.currentTime;
        bg.gain.setTargetAtTime(db2g(st.amt),t,.02);
        if(st.comp!==compOn){
          compOn=st.comp;
          bg.disconnect();
          bg.connect(compOn?cmp:lvl);
        }
        lvl.gain.setTargetAtTime(db2g(st.lvl),t,.02);
      }
    };
  },

  /* ============================ GRIT (OD/fuzz) ============================ */
  makeGrit(){
    const c=this.ctx,w=makeStage(c);
    const hp=c.createBiquadFilter();hp.type='highpass';hp.frequency.value=120;hp.Q.value=.71;
    const sh=c.createWaveShaper();sh.oversample='4x';
    const dc=c.createBiquadFilter();dc.type='highpass';dc.frequency.value=9;dc.Q.value=.71;
    const lp=c.createBiquadFilter();lp.type='lowpass';lp.Q.value=.71;
    const mk=c.createGain();
    hp.connect(sh);sh.connect(dc);dc.connect(lp);lp.connect(mk);
    let cache='';
    function curve(drv,fuzz){
      const N=2048,arr=new Float32Array(N);
      const GG=fuzz?2.9:1.9,asym=fuzz?.16:.12;
      const soft=t=>Math.tanh(t*GG*1.6)/Math.tanh((1+asym)*GG*1.6);
      let mx=0;
      for(let i=0;i<N;i++){
        const x=i/(N-1)*2-1,u=x+asym;
        let y=soft(u)-(asym?soft(asym):0);
        y/=Math.sqrt(1+drv*.25);
        if(fuzz){
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
        const t=c.currentTime;
        // TONE: turning down darkens the top end without losing mids or going muddy; flat at max
        lp.frequency.setTargetAtTime(clamp(1200+Math.pow(st.tone/10,1.6)*9000,1200,12000),t,.02);
        const ck=(st.fuzz?'F':'N')+'|'+quantize(st.drv,.05);
        if(ck!==cache){cache=ck;sh.curve=curve(st.drv,st.fuzz);}
        mk.gain.setTargetAtTime(db2g(st.lvl)*1.1/(0.8+st.drv*.06),t,.02);
      }
    };
  },

  /* ============================ PREAMP ============================ */
  makePreamp(){
    const c=this.ctx,w=makeStage(c);
    const inHp=c.createBiquadFilter();inHp.type='highpass';inHp.frequency.value=70;inHp.Q.value=.71;
    const sh=c.createWaveShaper();sh.oversample='4x';
    const dc=c.createBiquadFilter();dc.type='highpass';dc.frequency.value=12;dc.Q.value=.71;
    // 3-band ACTIVE eq at fixed centers, flat at 12 o'clock (gain=0) — cut AND boost, not passive-cut-only
    const low=c.createBiquadFilter();low.type='peaking';low.frequency.value=120;low.Q.value=.9;
    const mid=c.createBiquadFilter();mid.type='peaking';mid.frequency.value=500;mid.Q.value=.9;
    const high=c.createBiquadFilter();high.type='peaking';high.frequency.value=3300;high.Q.value=.9;
    const cabLp=c.createBiquadFilter();cabLp.type='lowpass';cabLp.frequency.value=7200;cabLp.Q.value=.71; // built-in speaker/DI rolloff
    const mk=c.createGain();
    inHp.connect(sh);sh.connect(dc);dc.connect(low);low.connect(mid);mid.connect(high);high.connect(cabLp);cabLp.connect(mk);
    let cache='';
    function curve(drv){
      // gentler than GRIT: "focuses on clean tones", edge-of-breakup rather than outright distortion
      const N=1024,arr=new Float32Array(N);
      const k=1.1+drv*.55,nrm=Math.tanh(k);
      for(let i=0;i<N;i++){const x=i/(N-1)*2-1;arr[i]=Math.tanh(k*x)/nrm;}
      return arr;
    }
    return {
      in:w.in,out:w.out,
      set(st){
        gateStage(w,!!st.on,inHp,mk);
        if(!st.on)return;
        const t=c.currentTime;
        low.gain.setTargetAtTime(st.low,t,.02);
        mid.gain.setTargetAtTime(st.mid,t,.02);
        high.gain.setTargetAtTime(st.high,t,.02);
        const ck=quantize(st.drv,.1);
        if(ck!==cache){cache=ck;sh.curve=curve(st.drv);}
        mk.gain.setTargetAtTime(db2g(st.lvl)*1.3/(0.85+st.drv*.05),t,.02);
      }
    };
  },

  /* ============================ REVERB (parallel send) ============================ */
  makeReverb(){
    const c=this.ctx;
    const inG=c.createGain();
    const cv=c.createConvolver();
    const wet=c.createGain();wet.gain.value=0;
    inG.connect(cv);cv.connect(wet);
    let sizeKey='',pend=null;
    return {
      in:inG,out:wet,
      set(st){
        const t=c.currentTime,on=!!st.on;
        wet.gain.setTargetAtTime(on?st.mix/100*.8:0,t,.04);
        if(!on)return;
        if(sizeKey!==st.size){
          sizeKey=st.size;
          clearTimeout(pend);
          pend=setTimeout(()=>{cv.buffer=ENG.getRoomIR(st.size);},60);
        }
      }
    };
  },
  getRoomIR(size){
    // same algorithmic-IR technique as softclip's getRevIR, just two fixed room presets
    // instead of five continuously-tunable algorithms.
    const sr=Math.round(this.ctx.sampleRate);
    const key=size+'|'+sr;
    if(this.revCache.has(key))return this.revCache.get(key);
    const PROF={SMALL:{dec:1.1,bright:.72,e:2.6},LARGE:{dec:3.4,bright:.55,e:2.1}};
    const pr=PROF[size]||PROF.SMALL;
    const len=Math.min(Math.floor(sr*pr.dec),sr*10);
    const b=this.ctx.createBuffer(2,len,sr);
    for(let ch=0;ch<2;ch++){
      const d=b.getChannelData(ch),rnd=mulberry(41+ch*7);
      let lp=0;
      const aL=Math.exp(-TAU*lerp(2600,7800,pr.bright)/sr);
      for(let i=0;i<len;i++){
        const t=i/len,n=rnd()*2-1;
        lp+=(n-lp)*aL;
        d[i]=lp*Math.pow(1-t,pr.e)*Math.exp(-1.1*t);
      }
      let mx=0;for(let i=0;i<len;i++)mx=Math.max(mx,Math.abs(d[i]));
      if(mx>0)for(let i=0;i<len;i++)d[i]=d[i]/mx*.9;
    }
    if(this.revCache.size>4)this.revCache.clear();
    this.revCache.set(key,b);return b;
  },

  /* ============================ DELAY / ROTARY (parallel send, shared block) ============================
     One physical section, two modes, exactly like the hardware: TIME/DRIFT/
     REPEATS/LEVEL mean one thing in DELAY mode and something else entirely in
     ROTARY mode (where LEVEL/REPEATS/TIME simply don't apply). Tap tempo drives
     either the delay time or, in rotary mode, a target rotor speed that glides
     to it over ~1.5s instead of snapping — approximating motor inertia. */
  makeDelayRoto(){
    const c=this.ctx;
    const inG=c.createGain();
    const wetOut=c.createGain();
    let mode=null,net=null,driftTimer=null,rotoSpeed=.4,rotoTarget=.4,rotoTimer=null;

    function teardown(){
      if(driftTimer){clearInterval(driftTimer);driftTimer=null;}
      if(rotoTimer){clearInterval(rotoTimer);rotoTimer=null;}
      if(net){
        net.nodes.forEach(n=>{try{n.disconnect()}catch(e){}});
        net.oscs.forEach(o=>{try{o.stop()}catch(e){}});
      }
      net=null;inG.disconnect();
    }

    function buildDelay(){
      const damp=c.createBiquadFilter();damp.type='lowpass';damp.frequency.value=3400;damp.Q.value=.71;
      const sat=c.createWaveShaper();sat.oversample='2x';
      const N=256,curveArr=new Float32Array(N);
      for(let i=0;i<N;i++){const x=i/(N-1)*2-1;curveArr[i]=Math.tanh(1.4*x)/Math.tanh(1.4);}
      sat.curve=curveArr;
      const dl=c.createDelay(1.1);dl.delayTime.value=.3;
      const fb=c.createGain();
      const wet=c.createGain();wet.gain.value=0;
      inG.connect(damp);damp.connect(dl);dl.connect(sat);sat.connect(fb);fb.connect(damp);
      dl.connect(wet);wet.connect(wetOut);
      net={type:'DELAY',dl,fb,wet,damp,nodes:[damp,sat,dl,fb,wet],oscs:[]};
      /* DRIFT: not a periodic LFO — a randomly-timed, randomly-sized wobble on
         the delay time, closer to a real tape transport's unpredictable flutter
         than a clean sine sweep would be. */
      driftTimer=setInterval(()=>{
        const st=PC.dly;
        if(!st.on||st.mode!=='DELAY'||!net)return;
        const depth=st.drift/100;
        if(depth<=0)return;
        const base=clamp(st.time/1000,.021,1.0);
        const jitter=(Math.random()*2-1)*depth*base*.09;
        net.dl.delayTime.setTargetAtTime(base+jitter,c.currentTime,.03+Math.random()*.05);
      },90+Math.random()*60);
    }

    function buildRoto(){
      // reuses the same delay-line-doppler + AM-tremolo technique as softclip's
      // ROTARY modulation type, but rate is driven by rotoSpeed (see tap()) and
      // depth by DRIFT ("mic distance") instead of fixed knobs.
      const nodes=[],oscs=[];
      const pair=[[0,-.7],[.5,.7]];
      const legs=[];
      pair.forEach(p=>{
        const dl=c.createDelay(.2);dl.delayTime.value=.014;nodes.push(dl);
        const o=c.createOscillator();o.type='sine';o.frequency.value=rotoSpeed;
        const sh=c.createDelay(10);sh.delayTime.value=Math.min(9,p[0]/Math.max(.05,rotoSpeed));
        const g=c.createGain();g.gain.value=.0045;
        o.connect(sh);sh.connect(g);g.connect(dl.delayTime);o.start();
        nodes.push(sh,g);oscs.push(o,sh,g);
        const amGain=c.createGain();amGain.gain.value=0;nodes.push(amGain);
        const amDepth=c.createGain();amDepth.gain.value=0;nodes.push(amDepth);
        const amLfo=c.createOscillator();amLfo.type='sine';amLfo.frequency.value=rotoSpeed;
        amLfo.connect(amDepth);amDepth.connect(amGain.gain);amLfo.start();
        oscs.push(amLfo);
        if(c.createConstantSource){
          const cs=c.createConstantSource();cs.offset.value=.7;cs.connect(amGain.gain);cs.start();
          oscs.push(cs);nodes.push(cs);
        }
        const p2=c.createStereoPanner();p2.pan.value=p[1];nodes.push(p2);
        inG.connect(dl);dl.connect(amGain);amGain.connect(p2);p2.connect(wetOut);
        legs.push({dl,phaseFrac:p[0],rateNodes:[o,amLfo],depthNode:amDepth});
      });
      net={type:'ROTO',legs,nodes,oscs};
      rotoTimer=setInterval(()=>{
        const st=PC.dly;
        if(!st.on||st.mode!=='ROTO'||!net)return;
        rotoSpeed+=(rotoTarget-rotoSpeed)*.06;   // glide toward the tap-derived target: motor inertia
        const t=c.currentTime,depth=st.drift/100;
        net.legs.forEach(leg=>{
          leg.rateNodes.forEach(n=>n.frequency.setTargetAtTime(Math.max(.03,rotoSpeed),t,.08));
          leg.dl.delayTime.setTargetAtTime(Math.min(9,leg.phaseFrac/Math.max(.05,rotoSpeed)),t,.08);
          leg.depthNode.gain.setTargetAtTime(depth*.5,t,.08);
        });
      },50);
    }

    return {
      in:inG,out:wetOut,
      set(st){
        if(!st.on){wetOut.gain.setTargetAtTime(0,c.currentTime,.03);if(net)teardown();mode=null;return;}
        if(mode!==st.mode){teardown();mode=st.mode;mode==='ROTO'?buildRoto():buildDelay();}
        const t=c.currentTime;
        if(mode==='DELAY'){
          net.dl.delayTime.setTargetAtTime(clamp(st.time/1000,.021,1.0),t,.05);
          net.fb.gain.setTargetAtTime(clamp(st.repeats/100,0,.97),t,.02);
          net.wet.gain.setTargetAtTime(st.lvl/100*.9,t,.02);
          wetOut.gain.setTargetAtTime(1,t,.02);
        }else{
          // ROTO: LEVEL/REPEATS/TIME are intentionally ignored — see class comment above
          wetOut.gain.setTargetAtTime(.8,t,.02);
        }
      },
      /* TAP TEMPO: in DELAY mode, retime fast (short time-constant) rather than
         gliding like a manual TIME-knob turn — approximates the real unit's
         "tap doesn't transpose pitch, turning the knob does" distinction without
         a full crossfaded dual-delay-line implementation. In ROTO mode, only
         nudges the *target* speed — buildRoto()'s interval does the actual glide. */
      tap(periodMs){
        if(!PC.dly.on)return;
        if(PC.dly.mode==='DELAY'){
          const tv=clamp(periodMs/1000,.021,1.0);
          PC.dly.time=Math.round(tv*1000);
          if(net&&net.dl)net.dl.delayTime.setTargetAtTime(tv,c.currentTime,.01);
        }else{
          rotoTarget=clamp(1/Math.max(.05,periodMs/1000)/4,.15,8); // 4 "blades" per rotation, rough but musical
        }
      }
    };
  }
};
