"use strict";
/* tuner — autocorrelation pitch detection, same technique as softclip's */
let tunerOn=false;
const TN={buf:new Float32Array(2048),fx:0,note:-1,cents:0,frame:0};
function detectPitch(buf,sr){
  let rms=0;const N=buf.length;
  for(let i=0;i<N;i++)rms+=buf[i]*buf[i];
  rms=Math.sqrt(rms/N);
  if(rms<.006)return null;
  let bestOff=-1,bestCor=0;
  const maxOff=Math.min(N>>1,Math.floor(sr/65)),minOff=Math.floor(sr/620);
  for(let off=minOff;off<=maxOff;off++){
    let cor=0,nrm=0;
    for(let i=0;i<N-off;i+=2){cor+=buf[i]*buf[i+off];nrm+=buf[i]*buf[i];}
    const corr=cor/(nrm+1e-9);
    if(corr>.92&&corr>bestCor){bestCor=corr;bestOff=off;}
    else if(bestOff>0&&corr<bestCor*.7)break;
  }
  return bestOff<0?null:sr/bestOff;
}
function pollTuner(){
  if(!tunerOn||!ENG.on){TN.note=-1;return;}
  if(++TN.frame%3)return;
  ENG.tnAn.getFloatTimeDomainData(TN.buf);
  const f=detectPitch(TN.buf,ENG.ctx.sampleRate);
  if(f){
    TN.fx=f;
    const midi=69+12*Math.log2(f/440);
    TN.note=Math.round(midi);TN.cents=(midi-TN.note)*100;
  }else TN.note=-1;
}
