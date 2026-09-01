"use strict";
/* =====================================================================
   FLYCLIP · DIRECT PREAMP RIG
   A faithful web clone of a well-known "fly rig" style pedal's signal
   chain and control set: Boost+Comp -> Grit (OD/fuzz) -> Preamp (drive +
   3-band active EQ + built-in cab rolloff) -> Reverb and Delay/Rotary
   mixed in PARALLEL off the preamp output, plus a tuner. See the repo's
   session notes for the source (an owner's manual) this was modeled on.
   Product-facing names are original — no third-party trademarks used.
   ===================================================================== */

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
    case '%':return Math.round(v)+'%';
    case 'x':return v.toFixed(1);
    default:return String(Math.round(v));
  }
}
function knot(key,label,min,max,def,unit,opt){return Object.assign({key,label,min,max,def,unit},opt||{});}

const NS='flyclip.';
const LS={
  get(k,d){try{const v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}},
  set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
};

/* ---- per-section knob descriptors, drives both the UI and fmtVal ---- */
const SECTIONS={
  boost:{name:'BOOST',knobs:[
    knot('amt','BOOST',0,12,6,'dB'),
    knot('lvl','LEVEL',-12,12,0,'dB')]},
  grit:{name:'GRIT',knobs:[
    knot('drv','DRIVE',0,10,5,'x'),
    knot('tone','TONE',0,10,7,'x'),
    knot('lvl','LEVEL',-12,6,0,'dB')]},
  pre:{name:'PREAMP',knobs:[
    knot('drv','DRIVE',0,10,4,'x'),
    knot('low','LOW',-12,12,0,'dB'),
    knot('mid','MID',-12,12,0,'dB'),
    knot('high','HIGH',-12,12,0,'dB'),
    knot('lvl','LEVEL',-12,12,0,'dB')]},
  rev:{name:'REVERB',knobs:[
    knot('mix','REVERB',0,100,25,'%')]},
  dly:{name:'DELAY / ROTARY',knobs:[
    knot('time','TIME',28,1000,300,'ms',{log:true}),
    knot('drift','DRIFT',0,100,0,'%'),
    knot('repeats','REPEATS',0,100,30,'%'),
    knot('lvl','LEVEL',0,100,20,'%')]}
};

function basePatch(){
  return {
    boost:{on:false,amt:6,comp:false,lvl:0},
    grit:{on:false,drv:5,tone:7,lvl:0,fuzz:false},
    pre:{on:true,drv:4,low:0,mid:0,high:0,lvl:0},
    rev:{on:false,size:'SMALL',mix:25},
    dly:{on:false,mode:'DELAY',time:300,drift:0,repeats:30,lvl:20}
  };
}

let PC=basePatch();
let CFG=Object.assign({in:0,out:-6,devId:''},LS.get(NS+'cfg',{}));
function saveCfg(){LS.set(NS+'cfg',CFG);}
let wipTimer=null;
function autosave(){
  clearTimeout(wipTimer);
  wipTimer=setTimeout(()=>LS.set(NS+'patch',PC),300);
}
function loadLS(){
  PC=Object.assign(basePatch(),LS.get(NS+'patch',null)||{});
  for(const k of Object.keys(SECTIONS))PC[k]=Object.assign(basePatch()[k],PC[k]||{});
}
