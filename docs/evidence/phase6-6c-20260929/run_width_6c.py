"""6C 三档宽度检查 runner（隔离 fixture，绝不触碰私人账本）。

用法：python3 run_width_6c.py <端口>
  - 启动 docs/evidence/phase5d-wiring-server.cjs 隔离服务（全新临时数据库，SIGTERM 自清理）；
  - 运行同目录 width_check.py 完成状态 + 三档宽度 + 弹层检查并写 width-result.json。
"""
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

root = Path(__file__).resolve().parents[3]  # ledger/
port = int(sys.argv[1])
base = f'http://127.0.0.1:{port}'

server = subprocess.Popen(
    ['node', str(root / 'docs/evidence/phase5d-wiring-server.cjs'), str(port)],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
)
try:
    line = server.stdout.readline().strip()
    print('server:', json.dumps(json.loads(line)))
    deadline = time.time() + 15
    while True:
        try:
            urllib.request.urlopen(base + '/api/v1/health', timeout=1)
            break
        except Exception:
            if time.time() > deadline:
                raise SystemExit('health check timeout')
            time.sleep(0.3)
    rc = subprocess.call([sys.executable, str(Path(__file__).parent / 'width_check.py'), str(port)])
    if rc != 0:
        raise SystemExit('WIDTH CHECK FAILED (' + str(rc) + ')')
finally:
    server.terminate()
    try:
        server.wait(timeout=10)
    except Exception:
        server.kill()
