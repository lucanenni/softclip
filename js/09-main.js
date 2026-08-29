"use strict";
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
