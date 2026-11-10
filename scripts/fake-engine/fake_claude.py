#!/usr/bin/env python3
"""A scripted stand-in for `claude` (and `codex`), for whole agent turns with no model.

The fake-engine suite (`src-tauri/examples/agents_fake/`) puts this first on
PATH as `claude`. It speaks what the app reads from the real CLI, as
observed on Claude Code 2.1.318 (`src-tauri/src/agents/testdata/`):

- `claude --version`, `claude auth status` (signed in), `claude mcp list`.
- `claude --print --output-format stream-json …`: a `system/init` naming the
  session, the permission mode and the app's MCP server; streamed text
  (`stream_event` deltas, then the complete `assistant` block); tool calls
  as `assistant` tool_use + `user` tool_result; `rate_limit_event`s; one
  `result` with usage and cost.
- Tool calls to the app's own MCP server go to the agent bridge for real,
  over HTTP with the bearer secret from the turn's `--mcp-config` file, so
  cards, results and messages are the app's own. A `Bash` call asks first
  through `--permission-prompt-tool`, exactly as Claude Code does, and runs
  only when the app answers allow.
- Sessions: `--session-id` starts a transcript under
  `$CLAUDE_CONFIG_DIR` (or `~/.claude`)`/projects/<cwd folder>/<id>.jsonl`,
  `--resume` needs one there ("No conversation found with session ID").
- Sealed calls (`--output-format text|json`) get a short canned answer.

What a turn does is the script in its prompt: the LAST `#fake ` in it
(not one in quotes, which is a mention) followed by a JSON list of steps.
With none, it runs `$FAKE_ENGINE_DEFAULT` (the same JSON), else replies
"ok". Steps:

  {"say": "text"}                 a reply (streamed). {session} {turn}
                                  {account} {prompt_lines} are filled in.
  {"slow": "text", "every": 0.2}  a reply streamed one word per `every` s.
  {"tool": "share_result", "args": {...}}   any tool of the app's server.
  {"volley": {"to": "B", "back": "A"}}   message_agent to B carrying
                                  the same step with the names swapped:
                                  two agents messaging each other for ever.
  {"bash": "echo hi"}             Bash, asking through the approval tool.
  {"bash": "...", "ask": false}   Bash without asking (an allowed call).
  {"write": "f.txt", "text": "…"} the Write tool (acceptEdits: no ask).
  {"rate_limit": 0.85}            a rate_limit_event, seven-day window.
  {"usage_limit": true, "unless_env": "CLAUDE_CODE_OAUTH_TOKEN"}
                                  "Claude AI usage limit reached|<reset>",
                                  unless that variable is set (an added
                                  account has a token; this Mac's has none).
  {"sleep": 1.5}                  silence.
  {"hang": true}                  silence until killed.
  {"crash": true}                 half a reply, then SIGSEGV.
  {"stderr": "text"}              a line on stderr.
  {"exit": 2}                     exit now, no result.
  {"error": "text"}               end with an error result.
  {"result": true}                a `result` now, the process carrying on
                                  (a background task, a helper's round).
  {"raw": "text"}                 a raw stdout line (torn JSON, garbage).

Run as `codex` (a link named so), it is Codex's `exec` driver instead
(`codex exec --json`, JSONL out, threads under `$CODEX_HOME/sessions`):
the same steps, except that commands never ask (exec can't) and
`usage_limit` applies to Codex only with `"codex": true`. The app runs it on `exec` when
`SHIPSTUDIO_AGENTS_CODEX_EXEC` is set (debug builds).

`FAKE_ENGINE_PERMISSION_MODE` changes the permission mode its init
reports (the app stops a `bypassPermissions` turn).

Every bridge answer is appended to `$FAKE_ENGINE_LOG` (JSON lines) so a test
can see what the app said back.
"""

import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.request
import uuid

VERSION = "2.1.318 (Claude Code)"


def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log(entry):
    path = os.environ.get("FAKE_ENGINE_LOG")
    if not path:
        return
    entry = dict(entry)
    entry["pid"] = os.getpid()
    entry["at"] = time.time()
    with open(path, "a") as f:
        f.write(json.dumps(entry) + "\n")


def flag(args, name):
    """The value after `name`, if any."""
    if name in args:
        i = args.index(name)
        if i + 1 < len(args):
            return args[i + 1]
    return None


def config_dir():
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(
        os.path.expanduser("~"), ".claude"
    )


def claude_folder(cwd):
    real = os.path.realpath(cwd)
    return "".join(c if c.isascii() and c.isalnum() else "-" for c in real)


def transcript_path(session):
    return os.path.join(
        config_dir(), "projects", claude_folder(os.getcwd()), session + ".jsonl"
    )


def find_transcript(session):
    """Anywhere under projects/, as `--resume` finds it for the same cwd only."""
    path = transcript_path(session)
    return path if os.path.isfile(path) else None


class Bridge:
    def __init__(self, config_path):
        self.url = None
        self.headers = {}
        self.next_id = 1
        if not config_path:
            return
        try:
            if os.path.isfile(config_path):
                with open(config_path) as f:
                    config = json.load(f)
            else:
                config = json.loads(config_path)
        except Exception:
            return
        server = (config.get("mcpServers") or {}).get("app") or {}
        self.url = server.get("url")
        self.headers = server.get("headers") or {}

    def rpc(self, method, params=None):
        if not self.url:
            return {"error": {"message": "no app server in --mcp-config"}}
        body = {"jsonrpc": "2.0", "id": self.next_id, "method": method}
        self.next_id += 1
        if params is not None:
            body["params"] = params
        req = urllib.request.Request(
            self.url,
            data=json.dumps(body).encode(),
            headers=dict(self.headers, **{"Content-Type": "application/json",
                                           "Accept": "application/json, text/event-stream"}),
            method="POST",
        )
        try:
            # A card waits for a person: as long as Claude Code's own MCP timeout.
            timeout = int(os.environ.get("MCP_TOOL_TIMEOUT", "660000")) / 1000
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode() or "{}")
        except Exception as e:  # what Claude Code reports as a failed call
            return {"error": {"message": str(e)}}

    def call(self, tool, args):
        reply = self.rpc("tools/call", {"name": tool, "arguments": args})
        log({"tool": tool, "args": args, "reply": reply})
        if "error" in reply:
            return reply["error"].get("message", "error"), True
        result = reply.get("result") or {}
        text = "\n".join(
            c.get("text", "") for c in result.get("content", []) if c.get("type") == "text"
        )
        return text, bool(result.get("isError"))

    def tools(self):
        reply = self.rpc("tools/list", {})
        return [t.get("name") for t in (reply.get("result") or {}).get("tools", [])]


class Turn:
    def __init__(self, args, prompt):
        self.args = args
        self.prompt = prompt
        self.session = flag(args, "--resume") or flag(args, "--session-id") or str(uuid.uuid4())
        self.bridge = Bridge(flag(args, "--mcp-config"))
        self.permission_tool = flag(args, "--permission-prompt-tool")
        self.msg = 0
        self.tool_n = 0
        self.replies = []
        self.cost = 0.0

    # ------------------------------------------------------------ output

    def message_id(self):
        self.msg += 1
        return "msg_fake_%s_%d" % (os.getpid(), self.msg)

    def assistant(self, blocks):
        out({
            "type": "assistant",
            "message": {"id": self.message_id(), "type": "message", "role": "assistant",
                        "model": "claude-fake", "content": blocks,
                        "usage": {"input_tokens": 10, "output_tokens": 5}},
            "parent_tool_use_id": None,
            "session_id": self.session,
        })

    def stream(self, event):
        out({"type": "stream_event", "event": event, "parent_tool_use_id": None,
             "session_id": self.session})

    def say(self, text, every=0.0):
        text = self.fill(text)
        self.stream({"type": "message_start", "message": {"id": "m", "role": "assistant", "content": []}})
        self.stream({"type": "content_block_start", "index": 0,
                     "content_block": {"type": "text", "text": ""}})
        pieces = re.findall(r"\S+\s*", text) or [text]
        for piece in pieces:
            self.stream({"type": "content_block_delta", "index": 0,
                         "delta": {"type": "text_delta", "text": piece}})
            if every:
                time.sleep(every)
        self.assistant([{"type": "text", "text": text}])
        self.stream({"type": "content_block_stop", "index": 0})
        self.replies.append(text)

    def fill(self, text):
        account = os.path.basename(os.environ.get("CLAUDE_CONFIG_DIR", "")) or "this-mac"
        turns = 0
        path = find_transcript(self.session)
        if path:
            with open(path) as f:
                turns = sum(1 for line in f if '"type": "user"' in line)
        return (text.replace("{session}", self.session)
                    .replace("{turn}", str(turns))
                    .replace("{account}", account)
                    .replace("{prompt_lines}", str(len(self.prompt.splitlines()))))

    def tool_use(self, name, tool_input):
        self.tool_n += 1
        tid = "toolu_fake_%d_%d" % (os.getpid(), self.tool_n)
        self.assistant([{"type": "tool_use", "id": tid, "name": name, "input": tool_input}])
        return tid

    def tool_result(self, tid, text, is_error=False, rejected=False):
        line = {
            "type": "user",
            "message": {"role": "user", "content": [{
                "type": "tool_result", "tool_use_id": tid,
                "content": [{"type": "text", "text": text}], "is_error": is_error}]},
            "parent_tool_use_id": None,
            "session_id": self.session,
        }
        if rejected:
            line["tool_result_meta"] = [{"id": tid, "permission_decision": {"decision": "reject"}}]
        out(line)

    def result(self, error=None):
        line = {
            "type": "result",
            "subtype": "success" if error is None else "error_during_execution",
            "is_error": error is not None,
            "duration_ms": 1234,
            "num_turns": 1,
            "result": error if error is not None else (self.replies[-1] if self.replies else ""),
            "session_id": self.session,
            "total_cost_usd": 0.001,
            "usage": {"input_tokens": 100, "output_tokens": 20,
                      "cache_read_input_tokens": 50, "cache_creation_input_tokens": 10},
        }
        out(line)

    # ------------------------------------------------------------ steps

    def ask(self, name, tool_input, tid):
        """Claude Code's permission prompt: the app answers allow or deny."""
        tool = (self.permission_tool or "").split("__")[-1]
        if not tool:
            return True, ""
        text, is_error = self.bridge.call(tool, {"tool_name": name, "input": tool_input,
                                                 "tool_use_id": tid})
        if is_error:
            return False, text
        try:
            answer = json.loads(text)
        except Exception:
            return False, text
        if answer.get("behavior") == "allow":
            return True, ""
        return False, answer.get("message") or "denied"

    def bash(self, command, ask=True):
        tool_input = {"command": command, "description": "Run " + command}
        tid = self.tool_use("Bash", tool_input)
        if ask:
            allowed, why = self.ask("Bash", tool_input, tid)
            if not allowed:
                self.tool_result(tid, why, is_error=True, rejected=True)
                return
        run = subprocess.run(["/bin/sh", "-c", command], capture_output=True, text=True)
        self.tool_result(tid, (run.stdout + run.stderr).strip(), is_error=run.returncode != 0)

    def write(self, path, text):
        full = os.path.join(os.getcwd(), path)
        tid = self.tool_use("Write", {"file_path": full, "content": text})
        with open(full, "w") as f:
            f.write(text)
        self.tool_result(tid, "File created successfully at: " + full)

    def mcp(self, tool, args):
        tid = self.tool_use("mcp__app__" + tool, args)
        text, is_error = self.bridge.call(tool, args)
        self.tool_result(tid, text, is_error=is_error)

    def rate_limit(self, used):
        resets = int(time.time()) + 3 * 24 * 3600
        out({"type": "rate_limit_event", "session_id": self.session, "rate_limit_info": {
            "status": "allowed_warning" if used >= 0.75 else "allowed",
            "resetsAt": resets, "rateLimitType": "seven_day", "utilization": used,
            "unifiedWindows": {"seven_day": {"utilization": used, "resetsAt": resets,
                                             "status": "allowed"}}}})

    def run(self, steps):
        for step in steps:
            if "say" in step:
                self.say(step["say"])
            elif "slow" in step:
                self.say(step["slow"], every=float(step.get("every", 0.2)))
            elif "tool" in step:
                self.mcp(step["tool"], step.get("args") or {})
            elif "volley" in step:
                v = step["volley"]
                back = [{"volley": {"to": v["back"], "back": v["to"]}}]
                self.mcp("message_agent", {"agent": v["to"],
                                           "message": "volley #fake " + json.dumps(back)})
            elif "bash" in step:
                self.bash(step["bash"], ask=step.get("ask", True))
            elif "write" in step:
                self.write(step["write"], step.get("text", ""))
            elif "rate_limit" in step:
                self.rate_limit(float(step["rate_limit"]))
            elif "usage_limit" in step:
                if not os.environ.get(step.get("unless_env", "\0") or "\0"):
                    resets = int(time.time()) + 3600
                    self.result(error="Claude AI usage limit reached|%d" % resets)
                    sys.exit(1)
            elif "sleep" in step:
                time.sleep(float(step["sleep"]))
            elif "hang" in step:
                while True:
                    time.sleep(3600)
            elif "crash" in step:
                self.stream({"type": "content_block_start", "index": 0,
                             "content_block": {"type": "text", "text": ""}})
                self.stream({"type": "content_block_delta", "index": 0,
                             "delta": {"type": "text_delta",
                                       "text": "Here is the first half of my answer"}})
                os.kill(os.getpid(), signal.SIGSEGV)
            elif "stderr" in step:
                sys.stderr.write(step["stderr"] + "\n")
                sys.stderr.flush()
            elif "exit" in step:
                sys.exit(int(step["exit"]))
            elif "error" in step:
                self.result(error=step["error"])
                sys.exit(1)
            elif "result" in step:
                # A `result` mid-process: what Claude Code sends when its
                # turn is over but a background task keeps it alive, or
                # before a helper reports back and another round starts.
                self.result()
            elif "raw" in step:
                sys.stdout.write(step["raw"] + "\n")
                sys.stdout.flush()


def script_of(prompt):
    found = None
    for line in prompt.splitlines():
        for m in re.finditer(r"#fake ", line):
            # A script quoted inside the prompt is a mention, not this
            # turn's ("Step 2 is “#fake …”" in a routine's step 1).
            if m.start() > 0 and line[m.start() - 1] in "\u201c\"'":
                continue
            found = line[m.end():]
    if found is None:
        found = os.environ.get("FAKE_ENGINE_DEFAULT")
    if found is None:
        return [{"say": "ok"}]
    try:
        # Whatever follows the JSON on that line (the "]" of a routine's
        # "[Scheduled routine you set: …]") isn't part of it.
        steps, _ = json.JSONDecoder().raw_decode(found.strip())
        return steps if isinstance(steps, list) else [steps]
    except Exception as e:
        return [{"say": "bad #fake script: %s" % e}]


def stream_turn(args):
    prompt = sys.stdin.read()
    resume = flag(args, "--resume")
    if resume and not find_transcript(resume):
        sys.stderr.write("No conversation found with session ID: %s\n" % resume)
        sys.exit(1)
    new = flag(args, "--session-id")
    if new and find_transcript(new):
        sys.stderr.write("Error: Session ID %s is already in use.\n" % new)
        sys.exit(1)
    turn = Turn(args, prompt)
    path = transcript_path(turn.session)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a") as f:
        f.write(json.dumps({"type": "user", "sessionId": turn.session,
                            "message": {"role": "user", "content": prompt}}) + "\n")
    log({"turn": turn.session, "resume": bool(resume), "cwd": os.getcwd(),
         "account": os.environ.get("CLAUDE_CONFIG_DIR", "this-mac"), "prompt": prompt})
    tools = ["Bash", "Edit", "Read", "Write"] + ["mcp__app__" + t for t in turn.bridge.tools() if t]
    status = "connected" if turn.bridge.url else "failed"
    out({"type": "system", "subtype": "init", "session_id": turn.session,
         "cwd": os.getcwd(), "model": "claude-fake",
         "permissionMode": os.environ.get("FAKE_ENGINE_PERMISSION_MODE", "acceptEdits"),
         "claude_code_version": VERSION.split()[0], "tools": tools,
         "mcp_servers": [{"name": "app", "status": status}]})
    turn.run(script_of(prompt))
    with open(path, "a") as f:
        for reply in turn.replies:
            f.write(json.dumps({"type": "assistant", "sessionId": turn.session,
                                "message": {"role": "assistant", "content": reply}}) + "\n")
    turn.result()


# ------------------------------------------------------------------ Codex

class CodexTurn:
    """`codex exec --json [resume <thread>] -`, as observed on Codex 0.166
    (`testdata/codex-exec.jsonl`). Exec can't ask: commands just run."""

    def __init__(self, args, prompt, thread):
        self.prompt = prompt
        self.session = thread
        self.n = 0
        self.replies = []
        url = None
        for i, a in enumerate(args):
            if a == "-c" and i + 1 < len(args) and args[i + 1].startswith("mcp_servers.app="):
                m = re.search(r'url="([^"]+)"', args[i + 1])
                url = m.group(1) if m else None
        token = os.environ.get("SHIPSTUDIO_AGENTS_BRIDGE_TOKEN", "")
        self.bridge = Bridge(None)
        self.bridge.url = url
        self.bridge.headers = {"Authorization": "Bearer " + token}

    def item(self, kind, item):
        self.n += 1
        item = dict(item, id="item_%d" % self.n)
        if kind == "both":
            out({"type": "item.started", "item": dict(item, status="in_progress")})
            return item
        out({"type": "item.completed", "item": item})
        return item

    def say(self, text, every=0.0):
        text = text.replace("{session}", self.session).replace(
            "{account}", os.path.basename(os.environ.get("CODEX_HOME", "")) or "this-mac")
        text = text.replace("{turn}", str(rollout_turns(self.session)))
        if every:
            time.sleep(every * len(text.split()))
        self.item("done", {"type": "agent_message", "text": text})
        self.replies.append(text)

    def run(self, steps):
        for step in steps:
            if "say" in step:
                self.say(step["say"])
            elif "slow" in step:
                self.say(step["slow"], every=float(step.get("every", 0.2)))
            elif "tool" in step or "volley" in step:
                if "volley" in step:
                    v = step["volley"]
                    back = [{"volley": {"to": v["back"], "back": v["to"]}}]
                    tool, args = "message_agent", {"agent": v["to"],
                                                   "message": "volley #fake " + json.dumps(back)}
                else:
                    tool, args = step["tool"], step.get("args") or {}
                item = self.item("both", {"type": "mcp_tool_call", "server": "app", "tool": tool,
                                          "arguments": args, "result": None, "error": None})
                text, is_error = self.bridge.call(tool, args)
                done = dict(item, status="failed" if is_error else "completed",
                            result={"content": [{"type": "text", "text": text}]})
                out({"type": "item.completed", "item": done})
            elif "bash" in step or "write" in step:
                command = step.get("bash") or "printf %%s %s > %s" % (
                    json.dumps(step.get("text", "")), step["write"])
                item = self.item("both", {"type": "command_execution", "command": command,
                                          "aggregated_output": "", "exit_code": None})
                run = subprocess.run(["/bin/sh", "-c", command], capture_output=True, text=True)
                out({"type": "item.completed", "item": dict(
                    item, aggregated_output=run.stdout + run.stderr, exit_code=run.returncode,
                    status="completed" if run.returncode == 0 else "failed")})
            elif "usage_limit" in step:
                if step.get("codex") and not os.environ.get(step.get("unless_env", "\0") or "\0"):
                    out({"type": "turn.failed", "error": {"message":
                        "You've hit your usage limit. Try again at 7:18 PM."}})
                    sys.exit(1)
            elif "sleep" in step:
                time.sleep(float(step["sleep"]))
            elif "hang" in step:
                while True:
                    time.sleep(3600)
            elif "crash" in step:
                os.kill(os.getpid(), signal.SIGSEGV)
            elif "stderr" in step:
                sys.stderr.write(step["stderr"] + "\n")
                sys.stderr.flush()
            elif "exit" in step:
                sys.exit(int(step["exit"]))
            elif "error" in step:
                out({"type": "turn.failed", "error": {"message": step["error"]}})
                sys.exit(1)


def codex_home():
    return os.environ.get("CODEX_HOME") or os.path.join(os.path.expanduser("~"), ".codex")


def rollout_of(thread):
    for root, _, files in os.walk(os.path.join(codex_home(), "sessions")):
        for name in files:
            if name.startswith("rollout-") and name.endswith("-%s.jsonl" % thread):
                return os.path.join(root, name)
    return None


def rollout_turns(thread):
    path = rollout_of(thread)
    if not path:
        return 0
    with open(path) as f:
        return sum(1 for line in f if '"user_message"' in line)


def codex_turn(args):
    prompt = sys.stdin.read()
    rest = args[1:]
    thread = None
    if rest[:1] == ["resume"]:
        # The thread id is the argument before the closing `-`.
        thread = args[-2] if args[-1] == "-" else args[-1]
        if not rollout_of(thread):
            out({"type": "error", "message": "no rollout found for thread id %s" % thread})
            sys.exit(1)
    thread = thread or str(uuid.uuid4())
    path = rollout_of(thread)
    if not path:
        day = time.strftime("%Y/%m/%d")
        stamp = time.strftime("%Y-%m-%dT%H-%M-%S")
        folder = os.path.join(codex_home(), "sessions", day)
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, "rollout-%s-%s.jsonl" % (stamp, thread))
    with open(path, "a") as f:
        f.write(json.dumps({"type": "event_msg", "payload": {"type": "user_message",
                                                             "message": prompt}}) + "\n")
    log({"turn": thread, "engine": "codex", "resume": thread is not None, "cwd": os.getcwd(),
         "account": os.environ.get("CODEX_HOME", "this-mac"), "prompt": prompt})
    out({"type": "thread.started", "thread_id": thread})
    out({"type": "turn.started"})
    turn = CodexTurn(args, prompt, thread)
    turn.run(script_of(prompt))
    out({"type": "turn.completed", "usage": {"input_tokens": 100, "cached_input_tokens": 50,
                                             "output_tokens": 20, "reasoning_output_tokens": 0}})


def codex_main(args):
    if args[:1] == ["--version"]:
        print("codex-cli 0.166.0")
    elif args[:2] == ["login", "status"]:
        print("Logged in using ChatGPT")
    elif args[:2] == ["mcp", "list"]:
        print("[]")
    elif args[:1] == ["exec"]:
        codex_turn(args)
    elif args[:1] == ["app-server"]:
        # No app-server here: the app falls back to `exec`.
        sys.exit(2)
    else:
        print("fake codex: nothing to do for %s" % " ".join(args), file=sys.stderr)


def main():
    args = sys.argv[1:]
    if os.path.basename(sys.argv[0]).startswith("codex"):
        codex_main(args)
        return
    if args[:1] in (["--version"], ["-v"]):
        print(VERSION)
        return
    if args[:2] == ["auth", "status"]:
        print(json.dumps({"loggedIn": True, "authMethod": "claude.ai",
                          "email": "fake@example.com"}))
        return
    if args[:1] == ["mcp"]:
        print("No MCP servers configured.")
        return
    fmt = flag(args, "--output-format")
    if "--print" in args or "-p" in args:
        if fmt == "stream-json":
            stream_turn(args)
            return
        sys.stdin.read()
        if fmt == "json":
            print(json.dumps({"type": "result", "subtype": "success", "is_error": False,
                              "result": "{}", "total_cost_usd": 0.0}))
        else:
            print("Fake summary.")
        return
    print("fake claude: nothing to do for %s" % " ".join(args), file=sys.stderr)


if __name__ == "__main__":
    main()
