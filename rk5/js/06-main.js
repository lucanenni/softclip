"use strict";
/* =====================================================================
   EVENT WIRING + INIT
   ===================================================================== */

/* ---- tap tempo: averages the last few intervals, feeds ENG.st.dly.tap() ---- */
let tapTimes=[];
function tap(){
  const now=performance.now();
  $('#tapled').classList.add('hit');setTimeout(()=>$('#tapled').classList.remove('hit'),120);
  tapTimes=tapTimes.filter(t=>now-t<2200);
  tapTimes.push(now);
  if(tapTimes.length<2)return;
  const iv=[];for(let i=1;i<tapTimes.length;i++)iv.push(tapTimes[i]-tapTimes[i-1]);
  const period=iv.reduce((a,b)=>a+b,0)/iv.length;
  if(!PC.dly.on){toast('Turn on DELAY/ROTO to use tap tempo','err');return;}
  ENG.st.dly.tap(period);
  refreshSection('dly');
  toast((PC.dly.mode==='ROTO'?'Rotor speed':'Delay time')+' set from tap','ok');
}

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
  if(SRC.mode==='MIC'){SRC.devId=CFG.devId;SRC.start('MIC');}
});
$('#pingBtn').addEventListener('click',()=>ENG.ping());
$('#tunerBtn').addEventListener('click',()=>{
  tunerOn=!tunerOn;
  $('#tunerBtn').classList.toggle('on',tunerOn);
  toast(tunerOn?'Tuner on — reads your raw input':'Tuner off');
});

(function init(){
  loadLS();
  Object.keys(SECTIONS).forEach(buildSection);
  buildIO();
  refreshAll();
  refreshStatus();
  requestAnimationFrame(drawFrame);
})();
