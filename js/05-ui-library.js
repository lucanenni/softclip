"use strict";
/* preset library / drawer */
let tabMode='F';
function openDrawer(tab){
  tabMode=tab||tabMode;
  $('#drawer').classList.add('show');$('#scrim').classList.add('show');
  $('#tabF').classList.toggle('on',tabMode==='F');
  $('#tabU').classList.toggle('on',tabMode==='U');
  renderList();
}
function closeDrawer(){$('#drawer').classList.remove('show');$('#scrim').classList.remove('show');hidePop();}
function metaLine(pc){
  const bits=[pc.amp.type];
  if(pc.mod.on)bits.push(pc.mod.type);
  if(pc.delay.on)bits.push(pc.delay.type+(pc.delay.sync?' SYNC':Math.round(pc.delay.time)+'ms'));
  if(pc.rev.on)bits.push(pc.rev.type);
  return bits.join(' · ');
}
function renderList(){
  const host=$('#plist');host.innerHTML='';
  const lib=combinedLib();
  const items=lib.map((e,i)=>({e,i})).filter(item=>(tabMode==='F')===item.e.fac);
  if(!items.length){
    host.innerHTML='<div class="drempty">NO USER PRESETS YET.<BR>PATCH SOMETHING YOU LIKE AND HIT “STORE”.</div>';
    return;
  }
  items.forEach(item=>{
    const row=document.createElement('div');
    row.className='prow'+(item.i===libIdx&&!importedName?' cur':'');
    const num=(item.e.fac?'F':'U')+String((item.e.fac?item.i:item.i-FACTORY.length)+1).padStart(2,'0');
    row.innerHTML='<span class="pnum">'+num+'</span>'+
      '<span class="pnm"><div class="pnmt">'+item.e.name+'</div>'+
      '<div class="pnmm">'+metaLine(mergedPC(item.e))+'</div></span>';
    if(!item.e.fac){
      const del=document.createElement('button');del.className='del';del.textContent='DELETE';
      del.addEventListener('click',ev=>{
        ev.stopPropagation();
        if(del.classList.contains('arm')){
          const uIdx=item.i-FACTORY.length;
          userLib.splice(uIdx,1);LS.set(NS+'users',userLib);
          libIdx=clamp(libIdx>item.i?libIdx-1:(libIdx===item.i?Math.min(libIdx,FACTORY.length+userLib.length-1):libIdx),
                       0,FACTORY.length+userLib.length-1);
          LS.set(NS+'idx',libIdx);
          curName=combinedLib()[libIdx].name;importedName=null;
          snapshotToLS();
          renderList();refreshLCD();toast('User preset deleted','ok');
        }else{
          del.classList.add('arm');del.textContent='SURE?';
          setTimeout(()=>{del.classList.remove('arm');del.textContent='DELETE';},2200);
        }
      });
      row.appendChild(del);
    }
    row.addEventListener('click',()=>{loadIndex(item.i);closeDrawer();});
    host.appendChild(row);
  });
}
function loadIndex(i){
  const lib=combinedLib();
  i=clamp(i,0,lib.length-1);
  libIdx=i;LS.set(NS+'idx',libIdx);
  PC=mergedPC(lib[i]);clearDirty();
  curName=lib[i].name;importedName=null;
  drums.bpm=PC.bpm;$('#bpmSl').value=PC.bpm;$('#bpmVal').textContent=PC.bpm;
  if(ENG.on)applyAllToAudio();
  refreshChain();renderParams();refreshLCD();
  toast('Loaded '+lib[i].name,'ok');
}

function hidePop(){$('#pop').classList.remove('show');}
function showStorePop(){
  $('#pop').classList.add('show');
  const inp=$('#popName');
  const ent=combinedLib()[libIdx];
  inp.value=(!ent.fac&&!importedName)?curName:('MY PATCH '+String(userLib.length+1).padStart(2,'0'));
  const r=$('#storeBtn').getBoundingClientRect();
  $('#pop').style.top=(r.bottom+10)+'px';
  $('#pop').style.left=clamp(r.left-140,10,window.innerWidth-274)+'px';
  inp.focus();inp.select();
}
function commitStore(){
  const nm=($('#popName').value.trim().toUpperCase().slice(0,16))||'UNTITLED';
  const snap=JSON.parse(JSON.stringify(PC));delete snap.name;
  const existing=userLib.findIndex(u=>u.name===nm);
  if(existing>=0){
    userLib[existing]={name:nm,p:snap};
    libIdx=FACTORY.length+existing;
    toast('“'+nm+'” overwritten in user bank','ok');
  }else{
    userLib.push({name:nm,p:snap});
    libIdx=FACTORY.length+userLib.length-1;
    toast('Stored “'+nm+'” to user bank','ok');
  }
  LS.set(NS+'users',userLib);LS.set(NS+'idx',libIdx);
  curName=nm;importedName=null;
  clearDirty();hidePop();
  refreshLCD();
  if($('#drawer').classList.contains('show'))renderList();
  $('#st-presets').textContent=(FACTORY.length+userLib.length)+' PRESET SLOTS';
}

function doExport(){
  const data={format:'softclip-preset',version:1,
    meta:{origin:importedName?'imported':(combinedLib()[libIdx].fac?'factory-clone':'user')},
    name:displayName(),patch:JSON.parse(JSON.stringify(PC))};
  delete data.patch.name;
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='SOFTCLIP_'+displayName().replace(/[^\w]+/g,'_')+'.preset.json';
  a.click();setTimeout(()=>URL.revokeObjectURL(a.href),4000);
  toast('Preset exported','ok');
}
 $('#fileimp').addEventListener('change',async e=>{
  const f=e.target.files[0];e.target.value='';
  if(!f)return;
  try{
    const j=JSON.parse(await f.text());
    if(!j.patch)throw new Error('no patch field');
    PC=mergedPC({name:j.name||'IMPORTED',p:j.patch});
    importedName=(j.name||'IMPORTED').toUpperCase().slice(0,16);
    markDirty();refreshChain();renderParams();refreshLCD();
    if(ENG.on)applyAllToAudio();
    toast('Imported “'+importedName+'” — press STORE to keep it','ok');
  }catch(err){toast('Not a valid preset file','err');}
});
