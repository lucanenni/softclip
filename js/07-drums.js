"use strict";
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
