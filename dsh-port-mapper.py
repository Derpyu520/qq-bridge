"""把我的 DSH 端口同步给 qq-bridge 的 config.json。

为什么需要它：DSH 每次启动都换随机端口（5033 → 9782 → 5744 …），而 qq-bridge 的
dsh.baseUrl 只能写死一个值；端口一变，桥接就 401/ECONNREFUSED，表现为「QQ 发消息没反应」。
这个 mapper 每 15 秒看一次 DSH 进程的启动参数/env，端口变了就把 config.json 里的
baseUrl 改掉并留备份。桥接下次启动、或它自己重试时就读到新端口。

读取方式说明：用 PowerShell `Get-CimInstance Win32_Process` 拿命令行（wmic 已废弃），
输出以 UTF-8 解码（这台机器上 GBK 解码会抛 UnicodeDecodeError）。
"""
import io, json, os, re, shutil, subprocess, sys, time, datetime

BRIDGE = r'C:\Users\stop\Documents\deepseek-harness\default-workspace\qq-bridge'
CONFIG = os.path.join(BRIDGE, 'config.json')
LOG = os.path.join(BRIDGE, 'state', 'port-mapper.log')

def log(msg):
    line = '[%s] %s' % (datetime.datetime.now().strftime('%H:%M:%S'), msg)
    print(line, flush=True)
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with io.open(LOG, 'a', encoding='utf-8') as f:
        f.write(line + '\n')

def dsh_procs():
    ps = r'''
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
  [PSCustomObject]@{ pid = $_.ProcessId; cmd = $_.CommandLine }
} | ConvertTo-Json -Compress -Depth 3
'''
    try:
        out = subprocess.run(['powershell', '-NoProfile', '-Command', ps],
                             capture_output=True, timeout=30)
        text = out.stdout.decode('utf-8', 'replace').strip()
        if not text:
            return []
        data = json.loads(text)
        if isinstance(data, dict):
            data = [data]
        return data
    except Exception as exc:
        log('读取进程失败：%s' % exc)
        return []

LISTEN_PS = r'''
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
$pids = @(Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*app.asar*' -and $_.CommandLine -like '*lib\host.js*' -and $_.CommandLine -like '*--expose-internals*' } |
  ForEach-Object { $_.ProcessId })
$rows = @()
foreach ($p in $pids) {
  Get-NetTCPConnection -State Listen -OwningProcess $p -ErrorAction SilentlyContinue |
    ForEach-Object { $rows += [PSCustomObject]@{ pid = $p; addr = $_.LocalAddress; port = $_.LocalPort } }
}
$rows | ConvertTo-Json -Compress -Depth 3
'''

def listen_ports():
    """谁在监听？只认 DSH 桌面宿主进程（命令行含 app.asar\\dsh + dsh-desktop-host）。"""
    try:
        out = subprocess.run(['powershell', '-NoProfile', '-Command', LISTEN_PS],
                             capture_output=True, timeout=40)
        text = out.stdout.decode('utf-8', 'replace').strip()
        if not text:
            return []
        data = json.loads(text)
        if isinstance(data, dict):
            data = [data]
        # 回环优先，端口小的优先（DSH 的 web 端口是随机高位，但回环这一条最可靠）
        rows = [r for r in data if isinstance(r, dict)]
        rows.sort(key=lambda r: (0 if str(r.get('addr')) == '127.0.0.1' else 1, int(r.get('port') or 0)))
        return [int(r['port']) for r in rows if r.get('port')]
    except Exception as exc:
        log('读监听端口失败：%s' % exc)
        return []

def find_port():
    """找到 DSH 真正在服务的那个端口（听着的端口里，回 401/200 的那个）。"""
    alive = []
    for port in listen_ports():
        if probe(port):
            alive.append(port)
    return sorted(set(alive))

def probe(port):
    """DSH 指纹：/api/webui/manifest 要么 200+providers，要么 401+{"status":...}。

    用 urllib 而不是 PowerShell：Invoke-WebRequest 在 401 时 ErrorDetails.Message 常常是空的，
    拿不到响应体就没法跟别的服务区分开。urllib 在 HTTPError 上也能读出 body。
    """
    import urllib.request, urllib.error, socket
    url = 'http://127.0.0.1:%d/api/webui/manifest' % port
    try:
        with urllib.request.urlopen(url, timeout=4) as resp:
            body = resp.read(4096).decode('utf-8', 'replace')
            return '"providers"' in body or 'webui' in body.lower()
    except urllib.error.HTTPError as err:
        body = err.read(4096).decode('utf-8', 'replace')
        low = body.lower()
        # 新版桌面版（DSH NEXT）在没带会话 Cookie 时对 /api/webui/manifest 直接回
        # 403 "Browser access is disabled"——这依然是 DSH 的指纹，别当成"不是 DSH"。
        return err.code in (401, 403) and (
            'status' in low or 'token' in low or 'un' in low or 'browser access' in low
        )
    except (urllib.error.URLError, socket.timeout, OSError):
        return False
    except Exception:
        # 判官：这一堆端口里混着 JSON-RPC 的裸服务，会抛 http.client.BadStatusLine
        # （不是 OSError 的子类）。单个端口探不通不该影响判定，更不该打死守护进程。
        return False

def current_base():
    with io.open(CONFIG, encoding='utf-8') as f:
        return json.load(f)['dsh']['baseUrl']

def set_base(url):
    shutil.copyfile(CONFIG, CONFIG + '.bak-' + datetime.datetime.now().strftime('%Y-%m-%dT%H-%M-%S'))
    with io.open(CONFIG, encoding='utf-8') as f:
        cfg = json.load(f)
    cfg['dsh']['baseUrl'] = url
    with io.open(CONFIG, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
        f.write('\n')

def main():
    once = '--once' in sys.argv
    log('启动：盯着 DSH 端口（每 15 秒一次）')
    while True:
        try:
            ports = find_port()
        except Exception as exc:
            log('本轮探测失败：%s（下一轮继续）' % exc)
            ports = []
        if ports:
            want = 'http://127.0.0.1:%d' % ports[0]
            have = current_base()
            if have != want:
                set_base(want)
                log('端口变了：%s -> %s（已写入 config.json，桥接重连即可用）' % (have, want))
            else:
                log('不变：%s' % want)
        else:
            log('没找到活着的 DSH 端口（DSH 没开？）')
        if once:
            return
        time.sleep(15)

if __name__ == '__main__':
    main()