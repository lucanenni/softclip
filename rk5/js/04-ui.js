"use strict";
/* =====================================================================
   UI — one card per section, in signal-flow order. Knobs reuse the same
   drag-to-adjust widget as softclip's chain UI.
   ===================================================================== */

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
  function adjust(dt){ set(clamp(denorm(clamp(norm(get())+dt,0,1)),def.min,def.max)); kw.paint(); }
  let dragging=false,py=0;
  knobEl.addEventListener('pointerdown',e=>{dragging=true;py=e.clientY;knobEl.setPointerCapture(e.pointerId);e.preventDefault();});
  knobEl.addEventListener('pointermove',e=>{
    if(!dragging)return;
    const dy=py-e.clientY;py=e.clientY;
    const fine=e.shiftKey?.28:1;
    adjust(dy*.006*fine);
  });
  knobEl.addEventListener('pointerup',e=>{dragging=false;try{knobEl.releasePointerCapture(e.pointerId)}catch(_){}});
  knobEl.addEventListener('dblclick',()=>{set(def.def);kw.paint();});
  knobEl.addEventListener('keydown',e=>{
    const fine=e.shiftKey?.02:.06;
    if(e.key==='ArrowUp'||e.key==='ArrowRight'){adjust(fine);e.preventDefault();}
    else if(e.key==='ArrowDown'||e.key==='ArrowLeft'){adjust(-fine);e.preventDefault();}
  });
  kv.addEventListener('click',()=>{
    const v=prompt(def.label+' ('+def.min+'..'+def.max+')',get().toFixed(2));
    if(v===null)return;
    const n=parseFloat(v);
    if(!isNaN(n)){set(clamp(n,def.min,def.max));kw.paint();}
  });
  kw.paint();
  return kw;
}

const PANELS={};   // section key -> {el, knobs:{key:kwEl}, ...}

function buildSection(key){
  const S=SECTIONS[key],st=PC[key];
  const card=document.createElement('div');card.className='card sect';card.dataset.sect=key;
  const head=document.createElement('div');head.className='secthead';
  head.innerHTML='<span class="sled"></span><span class="sname">'+S.name+'</span>';
  const onBtn=document.createElement('button');onBtn.className='onbtn';onBtn.textContent='ON';
  onBtn.addEventListener('click',()=>{PC[key].on=!PC[key].on;markDirty();refreshSection(key);applyParam(key);});
  head.appendChild(onBtn);
  card.appendChild(head);

  const extras=document.createElement('div');extras.className='extras';
  const knobRow=document.createElement('div');knobRow.className='knobrow';

  const kwMap={};
  S.knobs.forEach(def=>{
    const kw=makeKnob(knobRow,def,
      ()=>PC[key][def.key],
      v=>{PC[key][def.key]=v;markDirty();applyParam(key);if(key==='dly')refreshDlyLabels();});
    kwMap[def.key]=kw;
  });

  /* per-section extra switches that aren't generic knobs */
  if(key==='boost'){
    extras.appendChild(mkSwitch('COMP',()=>PC.boost.comp,v=>{PC.boost.comp=v;markDirty();applyParam('boost');}));
  }
  if(key==='grit'){
    extras.appendChild(mkSwitch('FUZZ',()=>PC.grit.fuzz,v=>{PC.grit.fuzz=v;markDirty();applyParam('grit');}));
  }
  if(key==='rev'){
    extras.appendChild(mkSwitch2('SIZE','SMALL','LARGE',()=>PC.rev.size,v=>{PC.rev.size=v;markDirty();applyParam('rev');}));
  }
  if(key==='dly'){
    extras.appendChild(mkSwitch2('MODE','DELAY','ROTO',()=>PC.dly.mode,v=>{PC.dly.mode=v;markDirty();applyParam('dly');refreshDlyLabels();}));
    const tapBtn=document.createElement('button');tapBtn.className='jbtn';tapBtn.textContent='TAP';
    tapBtn.addEventListener('click',tap);
    extras.appendChild(tapBtn);
  }

  card.appendChild(extras);
  card.appendChild(knobRow);
  $('#sections').appendChild(card);
  PANELS[key]={el:card,knobs:kwMap,onBtn};
}

function mkSwitch(label,get,set){
  const b=document.createElement('button');b.className='chk';
  b.innerHTML='<span class="box"></span><span>'+label+'</span>';
  b.addEventListener('click',()=>{set(!get());paintSwitch(b,get());});
  paintSwitch(b,get());
  b._get=get;b._paint=()=>paintSwitch(b,get());
  return b;
}
function paintSwitch(b,on){b.classList.toggle('on',!!on);}
function mkSwitch2(label,a,b_,get,set){
  const wrap=document.createElement('button');wrap.className='chk chk2';
  wrap.innerHTML='<span>'+label+'</span><span class="chk2val">'+get()+'</span>';
  wrap.addEventListener('click',()=>{set(get()===a?b_:a);wrap.querySelector('.chk2val').textContent=get();});
  wrap._paint=()=>{wrap.querySelector('.chk2val').textContent=get();};
  return wrap;
}

function refreshSection(key){
  const P=PANELS[key];if(!P)return;
  const on=!!PC[key].on;
  P.el.classList.toggle('off',!on);
  P.onBtn.classList.toggle('on',on);
  Object.values(P.knobs).forEach(kw=>kw.paint());
  P.el.querySelectorAll('.chk').forEach(b=>{if(b._paint)b._paint();});
}
function refreshAll(){ Object.keys(SECTIONS).forEach(refreshSection); refreshDlyLabels(); }

function refreshDlyLabels(){
  const roto=PC.dly.mode==='ROTO';
  const P=PANELS.dly;if(!P)return;
  ['time','repeats','lvl'].forEach(k=>{
    if(P.knobs[k])P.knobs[k].classList.toggle('dis',roto);
  });
  const dEl=$('#sections .sect[data-sect="dly"] .chk2val');
  if(dEl)dEl.textContent=PC.dly.mode;
}

/* ---------------------------------------------------------------- state -> audio bridge */
function applyParam(key){ if(ENG.on&&ENG.ctx)ENG.st[key].set(PC[key]); }
function applyAllToAudio(){
  if(!ENG.on||!ENG.ctx)return;
  Object.keys(SECTIONS).forEach(applyParam);
  ENG.applyGlobals();
}
function markDirty(){ autosave(); }

/* ---------------------------------------------------------------- I/O trim + meters */
function buildIO(){
  const host=$('#ioKnobs');
  makeKnob(host,knot('in','IN',-24,24,CFG.in,'dB'),()=>CFG.in,v=>{CFG.in=v;saveCfg();ENG.applyGlobals();});
  makeKnob(host,knot('out','OUT',-24,6,CFG.out,'dB'),()=>CFG.out,v=>{CFG.out=v;saveCfg();ENG.applyGlobals();});
}

/* ---------------------------------------------------------------- tuner readout */
function refreshTuner(){
  const notes=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  if(!tunerOn||TN.note<0){
    $('#tnote').textContent='—';$('#tnoct').textContent='';$('#tfreq').textContent='0.0 Hz';
    $('#tneedle').style.left='50%';$('#tverd').textContent=' ';$('#tverd').classList.remove('ok');
    return;
  }
  const name=notes[((TN.note%12)+12)%12],oct=Math.floor(TN.note/12)-1;
  $('#tnote').textContent=name;$('#tnoct').textContent=oct;
  $('#tfreq').textContent=TN.fx.toFixed(1)+' Hz';
  const pct=clamp(50+TN.cents/50*50,4,96);
  $('#tneedle').style.left=pct+'%';
  const inTune=Math.abs(TN.cents)<4;
  $('#tverd').textContent=inTune?'IN TUNE':(TN.cents>0?'▲ SHARP':'▼ FLAT');
  $('#tverd').classList.toggle('ok',inTune);
}

function refreshStatus(){
  $('#st-engine').textContent='ENGINE: '+(ENG.on?'LIVE':'BYPASS');
  $('#st-engine').className=ENG.on?'lit':'unlit';
  $('#engageBtn').textContent=ENG.on?'● ENGINE ON':'● ENGINE OFF';
  $('#engageBtn').classList.toggle('on',ENG.on);
}

function meterPair(fillId,numId,rms){
  const db=rms>0?20*Math.log10(rms):-60;
  const t=clamp((db+60)/60,0,1);
  const el=$('#'+fillId);el.style.width=(t*100)+'%';
  el.classList.toggle('hot',db>-6);
  $('#'+numId).textContent=db<-59?'-∞':db.toFixed(0);
}
const inBuf=new Float32Array(512);
function drawFrame(){
  requestAnimationFrame(drawFrame);
  pollTuner();refreshTuner();
  if(!ENG.on||!ENG.ctx)return;
  ENG.tnAn.getFloatTimeDomainData(inBuf);
  let rmsIn=0;for(let i=0;i<inBuf.length;i++)rmsIn+=inBuf[i]*inBuf[i];
  rmsIn=Math.sqrt(rmsIn/inBuf.length);
  meterPair('mfin','ming',rmsIn);
  ENG.anOut.getFloatTimeDomainData(inBuf);
  let rmsOut=0;for(let i=0;i<inBuf.length;i++)rmsOut+=inBuf[i]*inBuf[i];
  rmsOut=Math.sqrt(rmsOut/inBuf.length);
  meterPair('mfout','mout',rmsOut);
}
