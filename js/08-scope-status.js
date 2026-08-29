"use strict";
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
