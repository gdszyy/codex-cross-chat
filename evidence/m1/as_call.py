# -*- coding: utf-8 -*-
"""One-shot app-server JSON-RPC call: initialize then <method> <params_json>.
Usage: python as_call.py <method> <params_json> [--experimental]
Prints the JSON result (or error) on one line.
"""
import subprocess, threading, time, os, shutil, json, sys

sys.stdout.reconfigure(line_buffering=True)


def cli_entry():
    p = shutil.which("codex")
    node = shutil.which("node")
    script = os.path.join(os.path.dirname(p), "node_modules/@openai/codex/bin/codex.js")
    if os.name == "nt" and os.path.exists(p + ".cmd"):
        script = os.path.join(os.path.dirname(p), "node_modules", "@openai", "codex", "bin", "codex.js")
    return [node, script]


method = sys.argv[1] if len(sys.argv) > 1 else "thread/list"
params = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}

proc = subprocess.Popen(
    cli_entry() + ["app-server", "--stdio"],
    cwd=os.getcwd(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, encoding="utf-8", errors="replace", bufsize=1,
)
lines = []
lock = threading.Lock()


def rd(pipe, tag):
    for line in pipe:
        with lock:
            lines.append((tag, line.rstrip("\n")))


threading.Thread(target=rd, args=(proc.stdout, "OUT"), daemon=True).start()
threading.Thread(target=rd, args=(proc.stderr, "ERR"), daemon=True).start()

next_id = [1]


def send(m, p):
    rid = next_id[0]
    next_id[0] += 1
    wire = json.dumps({"jsonrpc": "2.0", "id": rid, "method": m, "params": p}, ensure_ascii=False)
    proc.stdin.write(wire + "\n")
    proc.stdin.flush()
    deadline = time.time() + 60
    while time.time() < deadline:
        with lock:
            for i, (tag, ln) in enumerate(lines):
                if tag != "OUT":
                    continue
                try:
                    obj = json.loads(ln)
                except ValueError:
                    continue
                if isinstance(obj, dict) and obj.get("id") == rid:
                    del lines[i]
                    return obj
        time.sleep(0.2)
    return {"error": "timeout", "method": m}


try:
    init = send("initialize", {"clientInfo": {"name": "m1call", "version": "0.1.0"},
                               "capabilities": {"experimentalApi": True}})
    proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "initialized", "params": {}}) + "\n")
    proc.stdin.flush()
    time.sleep(0.3)
    res = send(method, params)
    print(json.dumps({"method": method, "response": res}, ensure_ascii=False))
finally:
    try:
        proc.terminate(); proc.wait(timeout=5)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
