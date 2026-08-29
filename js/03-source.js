"use strict";
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
    return this.riffKit;
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
