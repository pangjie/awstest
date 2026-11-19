export type AttendanceAudio={context:AudioContext;buffers:Record<"in"|"out",AudioBuffer>;gain:GainNode;nextAt:number;sources:Set<AudioBufferSourceNode>};

// Same waveform as the approved crystal demo, generated locally without audio downloads.
export function createAttendanceAudio():AttendanceAudio{
  const context=new AudioContext();
  const gain=context.createGain();gain.connect(context.destination);
  const buffers={} as Record<"in"|"out",AudioBuffer>;
  for(const kind of ["in","out"] as const){
    const notes=kind==="in"?[[0,659.255,.48],[.17,987.767,.62]]:[[0,987.767,.48],[.19,659.255,.62]];
    const duration=Math.max(...notes.map(([start,,length])=>start+length))+.12;
    const buffer=context.createBuffer(1,Math.floor(duration*context.sampleRate),context.sampleRate);
    const samples=buffer.getChannelData(0);
    for(const [start,frequency,length] of notes){
      for(let i=0;i<Math.floor(length*context.sampleRate);i++){
        const time=i/context.sampleRate;
        let tone=0;
        for(const [ratio,amplitude] of [[1,1],[2,.20],[3,.055]])tone+=amplitude*Math.sin(2*Math.PI*frequency*ratio*time)*Math.exp(-time*(ratio-1)*3);
        samples[Math.floor(start*context.sampleRate)+i]+=tone*(1-Math.exp(-time/.004))*Math.exp(-6*time)*Math.min(1,Math.max(0,(length-time)/.08))**2;
      }
    }
    let peak=0;for(const value of samples)peak=Math.max(peak,Math.abs(value));
    for(let i=0;i<samples.length;i++)samples[i]*=.72/peak;
    buffers[kind]=buffer;
  }
  return {context,buffers,gain,nextAt:0,sources:new Set()};
}

export function stopAttendanceAudio(audio:AttendanceAudio|null){
  if(!audio)return;
  for(const source of audio.sources)source.stop();
  audio.sources.clear();audio.nextAt=0;
}

export function playAttendanceAudio(audio:AttendanceAudio,kinds:Array<"in"|"out">,volume:number){
  if(audio.context.state!=="running"||audio.nextAt>audio.context.currentTime+2)return;
  audio.gain.gain.setValueAtTime(volume,audio.context.currentTime);
  for(const kind of kinds){
    const source=audio.context.createBufferSource();source.buffer=audio.buffers[kind];source.connect(audio.gain);
    const start=Math.max(audio.context.currentTime,audio.nextAt);
    audio.sources.add(source);source.onended=()=>{audio.sources.delete(source);source.disconnect()};
    source.start(start);audio.nextAt=start+source.buffer.duration+.12;
  }
}
