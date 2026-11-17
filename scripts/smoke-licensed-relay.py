#!/usr/bin/env python3
"""Verify native licensed SRT publishing and running-publisher revocation; no cloud data."""
import hashlib
import http.server
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BASE = 'http://127.0.0.1:9790'

def port(kind=socket.SOCK_STREAM):
    with socket.socket(type=kind) as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]

def main():
    for number in (9790, 9791):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', number))
    binary = ROOT / 'target/debug/relay-server'
    assert binary.exists(), 'Build relay-server first'
    media_tool = os.environ.get('MEDIAMTX_BIN') or shutil.which('mediamtx')
    assert media_tool and shutil.which('ffmpeg'), 'Install MediaMTX and FFmpeg'
    admin, hook, activation = secrets.token_hex(32), secrets.token_hex(32), secrets.token_hex(32)
    class Checker(http.server.BaseHTTPRequestHandler):
        allowed = True
        checks = 0
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            valid = (self.headers.get('Authorization') == 'Bearer ' + admin and
                     body.get('channelId') == 'licensed-news' and body.get('token') == activation and Checker.allowed)
            Checker.checks += 1
            self.send_response(204 if valid else 403)
            self.end_headers()
        def log_message(self, *_args):
            pass
    checker = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Checker)
    threading.Thread(target=checker.serve_forever, daemon=True).start()
    def api(path, body=None):
        request = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body else None,
            headers={'Authorization': 'Bearer ' + admin, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)
    def online():
        return any(c['id'] == 'licensed-news' and c['online'] for c in api('/api/channels')['channels'])
    def wait(fn):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                if fn():
                    return
            except OSError:
                pass
            time.sleep(.2)
        raise AssertionError('Timed out waiting for licensed relay')
    media = relay = publisher = None
    with tempfile.TemporaryDirectory(prefix='signaldesk-license-smoke-') as folder:
        folder = Path(folder)
        api_port, hls_port, srt_port = port(), port(), port(socket.SOCK_DGRAM)
        config = (ROOT/'docker/relay-mediamtx.yml').read_text().replace('apiAddress: :9997',f'apiAddress: 127.0.0.1:{api_port}').replace('hlsAddress: :8888',f'hlsAddress: 127.0.0.1:{hls_port}').replace('srtAddress: :8890',f'srtAddress: 127.0.0.1:{srt_port}')
        config += '\nauthHTTPAddress: http://127.0.0.1:9791/auth/' + hook + '\n'
        (folder/'media.yml').write_text(config)
        try:
            media = subprocess.Popen([media_tool,str(folder/'media.yml')],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            relay = subprocess.Popen([str(binary)],env={**os.environ,'RELAY_ADMIN_TOKEN':admin,'RELAY_HOOK_TOKEN':hook,'RELAY_HOME':str(folder/'data'),'RELAY_MEDIA_API':f'http://127.0.0.1:{api_port}','RELAY_HLS_ORIGIN':f'http://127.0.0.1:{hls_port}','RELAY_LICENSE_URL':f'http://127.0.0.1:{checker.server_port}/private/publish'},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            wait(lambda: api('/api/health')['ok'])
            key = api('/api/channels',{'id':'licensed-news','name':'Licensed News TV','policy':{'licenseRequired':True,'enabled':True,'maxReaders':10,'egressMbps':20,'ingestMbps':10,'domain':''}})['publishingKey']
            proof = hashlib.sha256(('signaldesk-srt-auth-v1:' + key).encode()).hexdigest()
            def publish(token):
                password = proof + ('.' + token if token else '')
                url = f'srt://127.0.0.1:{srt_port}?mode=caller&connect_timeout=5000&streamid=publish:streams/licensed-news:licensed-news:{password}&passphrase={key}&pbkeylen=32&pkt_size=1316'
                return subprocess.Popen(['ffmpeg','-v','error','-re','-f','lavfi','-i','testsrc2=size=320x240:rate=25','-t','45','-c:v','libx264','-preset','ultrafast','-g','50','-b:v','1M','-f','mpegts',url],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            publisher = publish('')
            assert publisher.wait(timeout=12) != 0
            assert not online()
            publisher = publish(activation)
            wait(online)
            with urllib.request.urlopen(BASE+'/streams/licensed-news/index.m3u8',timeout=20) as response:
                assert b'#EXTM3U' in response.read()
            time.sleep(6)
            assert online() and publisher.poll() is None and Checker.checks >= 2
            Checker.allowed = False
            assert publisher.wait(timeout=15) != 0
            wait(lambda: not online())
            publisher = publish(activation)
            assert publisher.wait(timeout=12) != 0
            print('PASS: encrypted licensed SRT/HLS; activation required; running publisher kicked and reconnect rejected after revocation',flush=True)
        finally:
            for process in (publisher,relay,media):
                if process and process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=8)
                    except subprocess.TimeoutExpired:
                        process.kill(); process.wait()
            checker.shutdown(); checker.server_close()

if __name__ == '__main__':
    main()
