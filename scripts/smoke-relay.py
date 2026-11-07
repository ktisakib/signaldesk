#!/usr/bin/env python3
"""Real LAN relay integration test; never uploads media files to the relay."""
import datetime
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
ENV=dict(line.split('=',1) for line in (ROOT/'.env.relay').read_text().splitlines() if line and not line.startswith('#'))
BASE='http://127.0.0.1:'+ENV.get('RELAY_HTTP_PORT','8088')
KEY=ENV['RELAY_ADMIN_TOKEN']
SRT=int(ENV.get('RELAY_SRT_PORT','8890'))
def api(base,path,method='GET',body=None,admin=False,expected=200):
    headers={'Content-Type':'application/json'}
    if base!=BASE: headers['Host']='127.0.0.1:9780'
    if admin: headers['Authorization']='Bearer '+KEY
    req=urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),headers=headers,method=method)
    try:
        with urllib.request.urlopen(req,timeout=15) as r:
            assert r.status==expected
            return json.load(r)
    except urllib.error.HTTPError as e:
        assert e.code==expected, f'{method} {path}: {e.code}'
        return None

def wait(fn,seconds=35):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        try:
            value=fn()
            if value:return value
        except (OSError,AssertionError,ValueError):pass
        time.sleep(.5)
    raise AssertionError('Timed out waiting for relay integration condition')
def port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
def decode(path):
    r=subprocess.run(['ffmpeg','-v','error','-i',BASE+path,'-t','3','-f','null','-'],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=25)
    assert r.returncode==0,'HLS decoding failed'
compose=['docker','compose','--env-file','.env.relay','-f','compose.relay.yaml']
media_id=subprocess.check_output(compose+['ps','-q','mediamtx'],cwd=ROOT,text=True).strip()
networks=json.loads(subprocess.check_output(['docker','inspect','--format','{{json .NetworkSettings.Networks}}',media_id],text=True))
network=next(iter(networks))
procs=[];containers=[];channels=[]
suffix=str(os.getpid())
try:
    api(BASE,'/api/channels','POST',{'id':'unauthorized','name':'Forbidden'},expected=401)
    for i in range(2):
        cid=f'qa-{suffix}-{i}';result=api(BASE,'/api/channels','POST',{'id':cid,'name':f'Integration {i}'},admin=True);channels.append(result)
    assert 'publishingKey' not in json.dumps(api(BASE,'/api/channels'))
    with tempfile.TemporaryDirectory(prefix='signaldesk-relay-qa-') as work:
        home=Path(work)
        home.chmod(0o755)
        clip=home/'local-show.mp4'
        subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=25','-f','lavfi','-i','sine=frequency=440','-t','8','-c:v','libx264','-preset','ultrafast','-g','50','-pix_fmt','yuv420p','-c:a','aac',str(clip)],check=True,timeout=30)
        for i,c in enumerate(channels):
            p=port(); container=f'signaldesk-relay-qa-{suffix}-{i}'
            subprocess.run(['docker','run','-d','--name',container,'--network',network,'-p',f'127.0.0.1:{p}:9780','--mount',f'type=bind,source={home},target=/media,readonly','-e','BROADCAST_BIND=0.0.0.0:9780','-e','BROADCAST_HOME=/tmp/engine','signaldesk:local'],check=True,stdout=subprocess.DEVNULL)
            containers.append(container)
            base=f'http://127.0.0.1:{p}';c['base']=base
            wait(lambda:api(base,'/api/health'))
            settings=api(base,'/api/settings');settings.update(hlsPort=port(),rtspPort=port(),loopQueue=True);api(base,'/api/settings','PUT',settings)
            api(base,'/api/relay/config','PUT',{'channelName':c['id'],'host':'mediamtx','port':8890,'viewerUrl':'http://gateway:8088','streamKey':c['publishingKey']})
            assert c['publishingKey'] not in json.dumps(api(base,'/api/relay/config'))
            api(base,'/api/relay/test','POST',{})
            api(base,'/api/relay/start','POST',{})
            if i==0:
                m=api(base,'/api/library','POST',{'path':'/media/local-show.mp4'});api(base,'/api/queue','PUT',{'ids':[m['id']]})
                at=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=4)).isoformat()
                api(base,'/api/schedule/start','PUT',{'startAt':at})
                wait(lambda:api(base,'/api/schedule/start')['status']=='started')
            else:api(base,'/api/broadcast/start','POST',{'source':'test'})
        def online():
            items={c['id']:c for c in api(BASE,'/api/channels')['channels']}
            return all(items[c['id']]['online'] for c in channels)
        wait(online)
        for c in channels:decode('/streams/'+c['id']+'/index.m3u8')
        print('PASS: two local engines, scheduled queue, encrypted SRT and independent HLS playback')
        def reject_publish(channel, user, password):
            target=f"srt://mediamtx:8890?mode=caller&streamid=publish:streams/{channel['id']}:{user}:{password}&passphrase={channel['publishingKey']}&pbkeylen=32&pkt_size=1316&connect_timeout=3000"
            r=subprocess.run(['docker','exec',containers[0],'ffmpeg','-v','error','-re','-i','/media/local-show.mp4','-t','2','-c','copy','-f','mpegts',target],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15)
            assert r.returncode!=0,'Unauthorized or duplicate publisher accepted'
        reject_publish(channels[0],channels[0]['id'],channels[0]['publishingKey'])
        reject_publish(channels[1],channels[0]['id'],channels[0]['publishingKey'])
        reject_publish(channels[1],channels[1]['id'],'wrong-key-0123456789')
        assert online()
        print('PASS: duplicate publisher, cross-channel credentials and incorrect keys rejected')

        # Revocation must stop the active publisher and reject its reconnects.
        c=channels[1];new=api(BASE,f"/api/channels/{c['id']}/rotate",'POST',{},admin=True)
        wait(lambda:not next(x for x in api(BASE,'/api/channels')['channels'] if x['id']==c['id'])['online'])
        time.sleep(5)
        assert not next(x for x in api(BASE,'/api/channels')['channels'] if x['id']==c['id'])['online']
        api(c['base'],'/api/relay/stop','POST',{})
        api(c['base'],'/api/relay/config','PUT',{'channelName':c['id'],'host':'mediamtx','port':8890,'viewerUrl':'http://gateway:8088','streamKey':new['publishingKey']})
        api(c['base'],'/api/relay/start','POST',{})
        wait(online)
        print('PASS: key rotation disconnects/rejects the old key; replacement key restores playback')
        subprocess.run(['docker','compose','--env-file','.env.relay','-f','compose.relay.yaml','restart','mediamtx'],cwd=ROOT,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        wait(online,50)
        for c in channels:decode('/streams/'+c['id']+'/index.m3u8')
        print('PASS: media-server restart restores channels and both publishers reconnect')
finally:
    for c in channels:
        if 'base' in c:
            try:api(c['base'],'/api/broadcast/stop','POST',{})
            except Exception:pass
    for container in containers:
        subprocess.run(['docker','rm','-f',container],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    for proc in procs:
        proc.terminate()
        try:proc.wait(timeout=10)
        except subprocess.TimeoutExpired:proc.kill();proc.wait()
    for c in channels:
        try:api(BASE,f"/api/channels/{c['id']}",'DELETE',admin=True)
        except Exception:pass
