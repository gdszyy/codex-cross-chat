# -*- coding: utf-8 -*-
"""Raw JSON-RPC probe against `codex app-server --stdio`.

Exercises: initialize/initialized, thread/start, turn/start, thread/read
(poll to terminal), thread/resume. Writes a raw transcript log and prints a
one-line JSON summary. Used for M1 compatibility evidence.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

sys.stdout.reconfigure(line_buffering=True)


def cli_entry():
    executable = shutil.which("codex")
    if not executable:
        raise SystemExit("codex not on PATH")
    path = Path(executable)
    if os.name == "nt" and path.suffix.lower() in {".cmd", ".bat", ".ps1"}:
        node = shutil.which("node")
        script = path.parent / "node_modules/@openai/codex/bin/codex.js"
        if not node or not script.is_file():
            raise SystemExit("cannot resolve installed Codex node entry")
        return [node, str(script)]
    return [str(path)]


class Rpc:
    def __init__(self, cwd, logf):
        self.logf = logf
        self.cwd = str(Path(cwd).resolve())
        self.proc = subprocess.Popen(
            cli_entry() + ["app-server", "--stdio"],
            cwd=self.cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        self._lock = threading.Lock()
        self._loglock = threading.Lock()
        self._next_id = 1
        self._err_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._err_thread.start()

    def _drain_stderr(self):
        for line in self.proc.stderr:
            self._log("STDERR", line.rstrip("\n"))

    def _log(self, tag, text):
        with self._loglock:
            self.logf.write("[%s] %s\n" % (tag, text))
            self.logf.flush()

    def call(self, method, params=None, timeout=180):
        with self._lock:
            rid = self._next_id
            self._next_id += 1
            msg = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}
            wire = json.dumps(msg, ensure_ascii=False)
            self._log("SEND", wire)
            self.proc.stdin.write(wire + "\n")
            self.proc.stdin.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("App Server closed before replying")
            self._log("RECV", line.rstrip("\n"))
            try:
                reply = json.loads(line)
            except ValueError:
                continue
            if isinstance(reply, dict) and reply.get("id") == rid:
                if "error" in reply:
                    raise RuntimeError("%s: %s" % (method, json.dumps(reply["error"], ensure_ascii=False)))
                return reply.get("result")
        raise TimeoutError("App Server timed out on %s" % method)

    def notify(self, method, params=None):
        with self._lock:
            wire = json.dumps({"jsonrpc": "2.0", "method": method, "params": params or {}}, ensure_ascii=False)
            self._log("SEND", wire)
            self.proc.stdin.write(wire + "\n")
            self.proc.stdin.flush()

    def close(self):
        try:
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass


def last_agent_message(turn):
    msgs = [i for i in turn.get("items", []) if isinstance(i, dict) and i.get("type") == "agentMessage"]
    return msgs[-1].get("text") if msgs else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cwd", default=os.getcwd())
    ap.add_argument("--model", default=None)
    ap.add_argument("--prompt", default="Reply with exactly: PROBE-OK")
    ap.add_argument("--log", required=True)
    ap.add_argument("--timeout", type=int, default=180)
    ap.add_argument("--skip-start", action="store_true")
    ap.add_argument("--no-turn", action="store_true", help="only thread/start, then delete; no model inference")
    ap.add_argument("--thread", default=None, help="existing thread to resume+turn (for send scenario)")
    args = ap.parse_args()

    summary = {"probe": "app-server", "model": args.model, "thread_id": None, "turn_id": None,
               "turn_status": None, "last_agent_message": None, "resume_ok": False,
               "init_result_keys": None, "errors": []}

    logf = open(args.log, "w", encoding="utf-8", newline="\n")
    rpc = Rpc(args.cwd, logf)
    try:
        init = rpc.call("initialize", {
            "clientInfo": {"name": "m1-probe", "title": "M1 Probe", "version": "0.1.0"},
            "capabilities": {"experimentalApi": True, "requestAttestation": False},
        })
        rpc.notify("initialized")
        summary["init_result_keys"] = sorted(init.keys()) if isinstance(init, dict) else None
        summary["init_codexHome"] = init.get("codexHome") if isinstance(init, dict) else None
        summary["init_platformOs"] = init.get("platformOs") if isinstance(init, dict) else None
        summary["init_userAgent"] = init.get("userAgent") if isinstance(init, dict) else None

        if args.thread:
            thread_id = args.thread
            summary["thread_id"] = thread_id
            try:
                r = rpc.call("thread/resume", {"threadId": thread_id, "excludeTurns": True}, timeout=60)
                summary["resume_ok"] = bool(r and r.get("thread"))
            except Exception as e:
                summary["errors"].append("resume: %s" % e)
                raise
        else:
            params = {"cwd": str(Path(args.cwd).resolve()), "sandbox": "read-only", "ephemeral": False}
            if args.model:
                params["model"] = args.model
            started = rpc.call("thread/start", params)
            thread = started.get("thread", {})
            thread_id = thread.get("id")
            summary["thread_id"] = thread_id
            summary["thread_session_id"] = thread.get("sessionId")
            summary["thread_keys"] = sorted(thread.keys())
            summary["thread_model"] = thread.get("model")
            if args.no_turn:
                try:
                    rpc.call("thread/delete", {"threadId": thread_id})
                    summary["deleted"] = True
                except Exception as e:
                    summary["errors"].append("delete: %s" % e)
                print(json.dumps(summary, ensure_ascii=False))
                rpc.close()
                logf.close()
                return

        turn_params = {
            "threadId": thread_id,
            "input": [{"type": "text", "text": args.prompt, "text_elements": []}],
            "clientUserMessageId": str(uuid.uuid4()),
        }
        if args.model and not args.thread:
            turn_params["model"] = args.model
        t = rpc.call("turn/start", turn_params, timeout=60)
        turn_id = t.get("turn", {}).get("id")
        summary["turn_id"] = turn_id

        deadline = time.time() + args.timeout
        while time.time() < deadline:
            res = rpc.call("thread/read", {"threadId": thread_id, "includeTurns": True})
            turns = res.get("thread", {}).get("turns", [])
            match = [x for x in turns if x.get("id") == turn_id]
            if match:
                st = match[-1].get("status")
                summary["turn_status"] = st
                if st in ("completed", "failed", "interrupted"):
                    summary["last_agent_message"] = last_agent_message(match[-1])
                    summary["turn_keys"] = sorted(match[-1].keys())
                    break
            time.sleep(3)
    except Exception as e:
        summary["errors"].append(str(e))
    finally:
        rpc.close()
        logf.close()

    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
