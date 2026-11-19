import assert from "node:assert/strict";
import {test} from "node:test";
import {exportLoader} from "./helpers/load-export-typescript.mjs";
const {createAttendanceAudio,playAttendanceAudio,stopAttendanceAudio}=exportLoader()("app/employee-status/attendance-audio.ts");

test("crystal audio stays below clipping, serializes sounds and cancels queued playback",()=>{
  const original=globalThis.AudioContext;
  const sources=[];
  globalThis.AudioContext=class {
    sampleRate=48000;currentTime=10;state="running";destination={};
    createGain(){return {connect(){},gain:{setValueAtTime(){}}}}
    createBuffer(_channels,length,rate){const data=new Float32Array(length);return {duration:length/rate,getChannelData:()=>data}}
    createBufferSource(){const source={connect(){},disconnect(){},start(at){this.at=at},stop(){this.stopped=true}};sources.push(source);return source}
  };
  try{
    const audio=createAttendanceAudio();
    for(const buffer of Object.values(audio.buffers)){
      assert.ok(buffer.duration<1);
      let peak=0;for(const value of buffer.getChannelData(0)){assert.ok(Number.isFinite(value));peak=Math.max(peak,Math.abs(value))}
      assert.ok(peak>.71&&peak<.73);
    }
    playAttendanceAudio(audio,["in","out"],.8);
    assert.equal(sources.length,2);
    assert.ok(sources[1].at>=sources[0].at+audio.buffers.in.duration);
    audio.context.currentTime+=.3;
    playAttendanceAudio(audio,["in"],.8);
    playAttendanceAudio(audio,["out"],.8);assert.equal(sources.length,3);
    stopAttendanceAudio(audio);assert.ok(sources.every(source=>source.stopped));assert.equal(audio.sources.size,0);
    assert.equal(audio.nextAt,0);
    audio.context.state="suspended";playAttendanceAudio(audio,["in"],.8);assert.equal(sources.length,3);
  }finally{if(original)globalThis.AudioContext=original;else delete globalThis.AudioContext}
});
