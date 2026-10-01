// Offline production-argument check; no provider connections.
import { hlsCodecArgs } from '../playback-strategy.js';
import { runCodecScan } from '../codec-probe.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync,readFileSync,mkdtempSync } from 'node:fs';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root=mkdtempSync(join(tmpdir(),'rh-timing-regression-'));
const source=join(root,'source.mkv');
execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','36','-c:v','libx264','-preset','ultrafast','-g','250','-keyint_min','250','-sc_threshold','0','-c:a','aac','-ac','6',source]);
const args=hlsCodecArgs({strategy:'HLS_FULL_TRANSCODE',videoMode:'transcode',audioMode:'transcode',frameRate:'24'},{enabledStrategies:{HLS_FULL_TRANSCODE:true}});
for (const [name,input,start] of [['start',source,0],['seek',source,16.7],...(process.argv[2]?[['captured',process.argv[2],0]]:[])]) {
 const dir=join(root,name);mkdirSync(dir,{recursive:true});
 execFileSync('ffmpeg',['-v','error',...(start?['-ss',String(start)]:[]),'-i',input,'-t','8','-map','0:v:0','-map','0:a:0',...args,'-f','hls','-hls_time','2','-hls_flags','independent_segments+temp_file','-hls_segment_filename',dir+'/segment-%06d.ts','-y',dir+'/master.m3u8'],{timeout:60000});
 const names=readFileSync(dir+'/master.m3u8','utf8').split('\n').filter(x=>x.endsWith('.ts'));
 assert.ok(names.length>=3);
 for(const file of names){
  const facts=await runCodecScan(dir+'/'+file);
  assert.equal(facts.videoTimingReliable,true,file);
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_packets','-show_entries','packet=stream_index,pts_time,flags','-of','json',dir+'/'+file]));
  const starts=[0,1].map(i=>Math.min(...probe.packets.filter(p=>p.stream_index===i).map(p=>Number(p.pts_time))));
  assert.ok(Math.abs(starts[0]-starts[1])<0.15, `${file} A/V offset ${starts}`);
  assert.match(probe.packets.find(p=>p.stream_index===0).flags,/K/);
  execFileSync('ffmpeg',['-v','error','-xerror','-i',dir+'/'+file,'-map','0:v:0','-map','0:a:0','-f','null','-'],{stdio:'pipe'});
 }
 console.log(name+': independent decoding, monotonic frame timing and A/V alignment passed');
}
