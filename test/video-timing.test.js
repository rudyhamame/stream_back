import test from 'node:test';
import assert from 'node:assert/strict';
import { videoTimestampFacts, mergeProbeFacts } from '../codec-probe.js';
import { getPlaybackCapabilities, hlsCodecArgs, confidentDirectPlayback } from '../playback-strategy.js';
import { selectEnabledHlsForMedia } from '../stream-strategy-selection.js';
const media = {container:'matroska',videoCodec:'h264',videoProfile:'High',videoLevel:41,pixelFormat:'yuv420p',width:1920,height:1032,frameRate:'24',audioCodec:'aac',audioChannels:6,audioSampleRate:48000};
const caps = getPlaybackCapabilities('roku');
const enabled = {DIRECT:true,HLS_REMUX:true,HLS_VIDEO_TRANSCODE:true,HLS_AUDIO_TRANSCODE:true,HLS_FULL_TRANSCODE:true};
test('decoded timestamps detect repeats/reversals, ignore audio and missing facts', () => {
 const frames = values => values.map(x=>({media_type:'video',best_effort_timestamp_time:String(x)}));
 assert.deepEqual(videoTimestampFacts(frames([0,.04,.08])),{videoTimingReliable:true});
 assert.deepEqual(videoTimestampFacts(frames([0,.04,.04])),{videoTimingReliable:false});
 assert.deepEqual(videoTimestampFacts(frames([0,.08,.04])),{videoTimingReliable:false});
 assert.deepEqual(videoTimestampFacts([{media_type:'audio',best_effort_timestamp_time:'1'}]),{});
 assert.equal(mergeProbeFacts({videoTimingReliable:false},{videoTimingReliable:true}).videoTimingReliable,false);
});
test('known broken timing plus incompatible audio requires checked Full',()=>{
 const broken={...media,videoTimingReliable:false};
 assert.equal(selectEnabledHlsForMedia(media,caps,enabled).strategy,'HLS_AUDIO_TRANSCODE');
 assert.equal(selectEnabledHlsForMedia(broken,caps,enabled).strategy,'HLS_FULL_TRANSCODE');
 assert.equal(selectEnabledHlsForMedia(broken,caps,{...enabled,HLS_FULL_TRANSCODE:false}),null);
 assert.equal(selectEnabledHlsForMedia(broken,caps,enabled,{exact:'HLS_AUDIO_TRANSCODE'}),null);
 assert.equal(confidentDirectPlayback({...broken,audioChannels:2},caps,'mkv').compatible,false);
});
test('timing correction only changes video under checked video/full conversion',()=>{
 for(const strategy of ['HLS_REMUX','HLS_AUDIO_TRANSCODE','HLS_VIDEO_TRANSCODE','HLS_FULL_TRANSCODE']){
  const videoMode=['HLS_VIDEO_TRANSCODE','HLS_FULL_TRANSCODE'].includes(strategy)?'transcode':'copy';
  const audioMode=['HLS_AUDIO_TRANSCODE','HLS_FULL_TRANSCODE'].includes(strategy)?'transcode':'copy';
  const args=hlsCodecArgs({strategy,videoMode,audioMode,frameRate:'24'},{enabledStrategies:enabled});
  assert.equal(args.includes('-fps_mode:v'),videoMode==='transcode');
  assert.equal(args.includes('aresample=async=1:first_pts=0'),strategy==='HLS_FULL_TRANSCODE');
 }
});
