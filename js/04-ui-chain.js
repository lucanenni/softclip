"use strict";
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
