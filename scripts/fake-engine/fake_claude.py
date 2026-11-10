#!/usr/bin/env python3
"""A scripted stand-in for `claude` (and `codex`, `opencode`), for whole agent turns with no model.

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
  Every entry has a `uuid`; `--resume <s> --resume-session-at <uuid>
  --fork-session [--session-id <new>]` starts <new> as <s> up to and
  including that entry, <s> untouched (as Claude Code 2.1.322 does).
- Sealed calls (`--output-format text|json`) get a short canned answer.

What a turn does is the script in its prompt: the LAST `#fake ` in it
(not one in quotes, which is a mention) followed by a JSON list of steps.
With none, it runs `$FAKE_ENGINE_DEFAULT` (the same JSON), else replies
"ok". Steps:

  {"say": "text"}                 a reply (streamed). {session} {turn}
                                  {account} {prompt_lines} are filled in,
                                  and {last_tool}: what the turn's last
                                  tool of the app's said back (Claude only).
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
  {"list_tools": true}            log the app server's `tools/list` as this engine
                                  reaches it (`served` in the log).

Run as `codex` (a link named so), it is Codex's `app-server` (JSON-RPC on
stdin/stdout, as observed on Codex 0.166, `testdata/codex-app-server.jsonl`),
which the app prefers: `generate-json-schema` lists what the app checks for,
`thread/start` / `thread/resume` (an unknown thread fails), `turn/start`
running the same steps, a `bash` step asking with
`item/commandExecution/requestApproval` (a `write` with
`item/fileChange/requestApproval`), a decline ending that item `declined`,
steers logged as `{"steer": ...}`, `turn/interrupt`, `thread/compact/start`.
With `SHIPSTUDIO_AGENTS_CODEX_EXEC` set (debug builds) the app runs it as
the `exec` driver instead (`codex exec --json`, JSONL out): the same steps,
except that commands never ask (exec can't). Threads live under
`$CODEX_HOME/sessions` for both; `usage_limit` applies to Codex only with
`"codex": true`.

Run as `opencode`, it is OpenCode's `opencode acp` (the Agent Client
Protocol on stdin/stdout, as observed on OpenCode 1.18.29,
`testdata/opencode-acp.jsonl`): `initialize`, `session/new` / `session/load`
(which replays the conversation first; an unknown one fails as OpenCode's
does), `session/prompt` running the same steps, `session/cancel`. A `bash`
step asks with `session/request_permission` unless the inline config
(`OPENCODE_CONFIG_CONTENT`) says `allow`; a `write` step always asks; a
reject ends the round with nothing said, as OpenCode does, and a prompt
starting "[Note from the app" is answered "Noted: …". Tool steps call the
app's server with the header `session/new` gave it. Sessions are files
under `$XDG_DATA_HOME/opencode/fake-sessions`. `models --verbose` lists
`opencode/fake` and `local/fake` (served from 127.0.0.1).

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
        self.last_tool = ""
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
                    .replace("{prompt_lines}", str(len(self.prompt.splitlines())))
                    .replace("{last_tool}", self.last_tool))

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
        self.last_tool = text
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
            elif "list_tools" in step:
                log({"served": self.bridge.tools()})
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
    # As a Claude Code that dropped the hidden flag would: refused before any output.
    if os.environ.get("FAKE_CLAUDE_NO_RESUME_AT") and "--resume-session-at" in args:
        sys.stderr.write("error: unknown option '--resume-session-at'\n")
        sys.exit(1)
    if resume and not find_transcript(resume):
        sys.stderr.write("No conversation found with session ID: %s\n" % resume)
        sys.exit(1)
    new = flag(args, "--session-id")
    if new and find_transcript(new):
        sys.stderr.write("Error: Session ID %s is already in use.\n" % new)
        sys.exit(1)
    turn = Turn(args, prompt)
    if resume and "--fork-session" in args:
        turn.session = new or str(uuid.uuid4())
        at = flag(args, "--resume-session-at")
        kept, found = [], at is None
        with open(find_transcript(resume)) as f:
            for line in f:
                kept.append(line)
                if at is not None and json.loads(line).get("uuid") == at:
                    found = True
                    break
        if not found:
            sys.stderr.write("No message found with message.uuid of: %s\n" % at)
            sys.exit(1)
        os.makedirs(os.path.dirname(transcript_path(turn.session)), exist_ok=True)
        with open(transcript_path(turn.session), "w") as f:
            f.writelines(kept)
    path = transcript_path(turn.session)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a") as f:
        f.write(json.dumps({"type": "user", "sessionId": turn.session, "uuid": str(uuid.uuid4()),
                            "message": {"role": "user", "content": prompt}}) + "\n")
    log({"turn": turn.session, "resume": bool(resume), "fork": "--fork-session" in args,
         "cwd": os.getcwd(),
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
                                "uuid": str(uuid.uuid4()),
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
            elif "list_tools" in step:
                log({"served": self.bridge.tools()})
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
    elif args[:2] == ["app-server", "generate-json-schema"]:
        codex_schema(args)
    elif args[:1] == ["app-server"]:
        CodexApp(args).serve()
    else:
        print("fake codex: nothing to do for %s" % " ".join(args), file=sys.stderr)


# ------------------------------------------------------- Codex app-server

# What `codex app-server generate-json-schema` lists, as far as the app
# checks it (`codex_app::NEEDED`): every method name quoted in its file.
CODEX_SCHEMA = {
    "ClientRequest.json": ["initialize", "thread/start", "thread/resume", "turn/start",
                           "turn/steer", "turn/interrupt", "thread/compact/start",
                           "account/rateLimits/read"],
    "ServerRequest.json": ["item/commandExecution/requestApproval",
                           "item/fileChange/requestApproval",
                           "mcpServer/elicitation/request"],
    "ServerNotification.json": ["item/agentMessage/delta", "item/started", "item/completed",
                                "turn/started", "turn/completed", "thread/started",
                                "thread/tokenUsage/updated", "account/rateLimits/updated"],
}


def codex_schema(args):
    folder = flag(args, "--out")
    if not folder:
        sys.stderr.write("error: --out is required\n")
        sys.exit(2)
    os.makedirs(folder, exist_ok=True)
    for name, methods in CODEX_SCHEMA.items():
        with open(os.path.join(folder, name), "w") as f:
            json.dump({"oneOf": [{"properties": {"method": {"enum": [m]}}} for m in methods]}, f)


class CodexApp:
    """`codex app-server`: JSON-RPC over stdin/stdout, as observed on Codex
    0.166 (`testdata/codex-app-server.jsonl`). One thread per process; a
    `bash` step asks with `item/commandExecution/requestApproval` unless
    `"ask": false`, a `write` step with `item/fileChange/requestApproval`,
    and a decline ends that item `declined` and the steps go on, as Codex's
    model would carry on. Steers are logged and acknowledged; an interrupt
    ends the turn `interrupted`."""

    def __init__(self, args):
        import queue
        import threading
        self.inbox = queue.Queue()
        self.thread = None
        self.turn = None
        self.n = 0
        self.next_id = 0
        self.interrupted = False
        self.failed = None
        url = None
        for i, a in enumerate(args):
            if a == "-c" and i + 1 < len(args) and args[i + 1].startswith("mcp_servers.app="):
                m = re.search(r'url="([^"]+)"', args[i + 1])
                url = m.group(1) if m else None
        self.bridge = Bridge(None)
        self.bridge.url = url
        self.bridge.headers = {
            "Authorization": "Bearer " + os.environ.get("SHIPSTUDIO_AGENTS_BRIDGE_TOKEN", "")}
        self.argv = args

        def reader():
            for line in sys.stdin:
                line = line.strip()
                if line:
                    try:
                        self.inbox.put(json.loads(line))
                    except Exception:
                        pass
            self.inbox.put(None)

        threading.Thread(target=reader, daemon=True).start()

    # ------------------------------------------------------------ wire

    def reply(self, rid, result):
        out({"id": rid, "result": result})

    def notify(self, method, params):
        if self.thread and "threadId" not in params:
            params = dict(params, threadId=self.thread)
        if self.turn and method.startswith("item/") and "turnId" not in params:
            params = dict(params, turnId=self.turn)
        out({"method": method, "params": params})

    def take(self, timeout=None):
        """The next message, handling what can arrive mid-turn (steers,
        interrupts) on the way. None when nothing came in `timeout`."""
        import queue
        while True:
            try:
                msg = self.inbox.get(timeout=timeout)
            except queue.Empty:
                return None
            if msg is None:
                sys.exit(0)
            method, rid, params = msg.get("method"), msg.get("id"), msg.get("params") or {}
            if method == "turn/steer":
                text = "".join(i.get("text", "") for i in params.get("input") or [])
                log({"engine": "codex-app", "steer": text,
                     "expected": params.get("expectedTurnId") == self.turn})
                self.record("user_message", text)
                self.reply(rid, {"turnId": self.turn})
                continue
            if method == "turn/interrupt":
                self.interrupted = True
                self.reply(rid, {})
                continue
            return msg

    # ------------------------------------------------------------ rollout

    def rollout(self):
        path = rollout_of(self.thread)
        if path:
            return path
        folder = os.path.join(codex_home(), "sessions", time.strftime("%Y/%m/%d"))
        os.makedirs(folder, exist_ok=True)
        return os.path.join(folder, "rollout-%s-%s.jsonl" % (
            time.strftime("%Y-%m-%dT%H-%M-%S"), self.thread))

    def record(self, kind, text):
        with open(self.rollout(), "a") as f:
            f.write(json.dumps({"type": "event_msg",
                                "payload": {"type": kind, "message": text}}) + "\n")

    # ------------------------------------------------------------ items

    def item_id(self, prefix):
        self.n += 1
        return "%s_%d_%d" % (prefix, os.getpid(), self.n)

    def ask(self, method, params):
        """A server request; the app's decision ("accept", "decline", …)."""
        rid = self.next_id
        self.next_id += 1
        out({"method": method, "id": rid,
             "params": dict(params, threadId=self.thread, turnId=self.turn)})
        while True:
            msg = self.take()
            if msg.get("id") == rid and "method" not in msg:
                break
        decision = (msg.get("result") or {}).get("decision")
        log({"engine": "codex-app", "asked": method, "params": params, "answer": decision})
        return decision

    def say(self, text, every=0.0):
        text = (text.replace("{session}", self.thread)
                .replace("{turn}", str(rollout_turns(self.thread)))
                .replace("{account}",
                         os.path.basename(os.environ.get("CODEX_HOME", "")) or "this-mac"))
        mid = self.item_id("msg")
        self.notify("item/started", {"item": {"type": "agentMessage", "id": mid, "text": ""}})
        for piece in re.findall(r"\S+\s*", text) or [text]:
            self.notify("item/agentMessage/delta", {"itemId": mid, "delta": piece})
            if every:
                time.sleep(every)
        self.notify("item/completed", {"item": {"type": "agentMessage", "id": mid, "text": text}})
        self.record("agent_message", text)

    def mcp(self, tool, args):
        iid = self.item_id("call")
        item = {"type": "mcpToolCall", "id": iid, "server": "app", "tool": tool,
                "arguments": args, "status": "inProgress", "result": None, "error": None}
        self.notify("item/started", {"item": item})
        text, is_error = self.bridge.call(tool, args)
        done = dict(item, status="failed" if is_error else "completed")
        if is_error:
            done["error"] = {"message": text}
        else:
            done["result"] = {"content": [{"type": "text", "text": text}]}
        self.notify("item/completed", {"item": done})

    def bash(self, command, ask=True):
        iid = self.item_id("call")
        shell = command if "'" in command else "/bin/zsh -lc '%s'" % command
        item = {"type": "commandExecution", "id": iid, "command": shell,
                "cwd": os.getcwd(), "status": "inProgress", "aggregatedOutput": None,
                "exitCode": None}
        self.notify("item/started", {"item": item})
        if ask:
            decision = self.ask("item/commandExecution/requestApproval", {
                "itemId": iid, "command": shell, "cwd": os.getcwd(),
                "reason": "Write outside the sandbox?"})
            if decision != "accept":
                self.notify("item/completed", {"item": dict(item, status="declined")})
                return
        run = subprocess.run(["/bin/sh", "-c", command], capture_output=True, text=True)
        if run.stdout + run.stderr:
            self.notify("item/commandExecution/outputDelta",
                        {"itemId": iid, "delta": run.stdout + run.stderr})
        self.notify("item/completed", {"item": dict(
            item, status="completed" if run.returncode == 0 else "failed",
            aggregatedOutput=run.stdout + run.stderr, exitCode=run.returncode)})

    def write(self, path, text):
        iid = self.item_id("call")
        full = os.path.join(os.getcwd(), path)
        item = {"type": "fileChange", "id": iid, "status": "inProgress",
                "changes": [{"path": full, "kind": {"type": "add"}, "diff": text}]}
        self.notify("item/started", {"item": item})
        if self.ask("item/fileChange/requestApproval", {"itemId": iid}) != "accept":
            self.notify("item/completed", {"item": dict(item, status="declined")})
            return
        with open(full, "w") as f:
            f.write(text)
        self.notify("item/completed", {"item": dict(item, status="completed")})

    def wait(self, seconds):
        """Silence that an interrupt can end (None: until one). Zero just
        takes in whatever already arrived."""
        end = None if seconds is None else time.time() + seconds
        while not self.interrupted:
            left = 0.2 if end is None else min(0.2, end - time.time())
            msg = self.take(timeout=max(left, 0.001))
            if msg is not None and msg.get("id") is not None and msg.get("method"):
                out({"id": msg["id"], "error": {"code": -32600, "message": "turn in progress"}})
            if end is not None and time.time() >= end:
                return

    def run(self, steps):
        for step in steps:
            # Anything that came in between steps (an interrupt) first.
            self.wait(0)
            if self.interrupted or self.failed:
                return
            if "say" in step:
                self.say(step["say"])
            elif "slow" in step:
                self.say(step["slow"], every=float(step.get("every", 0.2)))
            elif "tool" in step or "volley" in step:
                if "volley" in step:
                    v = step["volley"]
                    back = [{"volley": {"to": v["back"], "back": v["to"]}}]
                    self.mcp("message_agent", {"agent": v["to"],
                                               "message": "volley #fake " + json.dumps(back)})
                else:
                    self.mcp(step["tool"], step.get("args") or {})
            elif "bash" in step:
                self.bash(step["bash"], ask=step.get("ask", True))
            elif "write" in step:
                self.write(step["write"], step.get("text", ""))
            elif "usage_limit" in step:
                if step.get("codex") and not os.environ.get(step.get("unless_env", "\0") or "\0"):
                    self.failed = "You've hit your usage limit. Try again at 7:18 PM."
            elif "list_tools" in step:
                log({"served": self.bridge.tools()})
            elif "sleep" in step:
                self.wait(float(step["sleep"]))
            elif "hang" in step:
                self.wait(None)
            elif "crash" in step:
                os.kill(os.getpid(), signal.SIGSEGV)
            elif "stderr" in step:
                sys.stderr.write(step["stderr"] + "\n")
                sys.stderr.flush()
            elif "exit" in step:
                sys.exit(int(step["exit"]))
            elif "error" in step:
                self.failed = step["error"]
            elif "raw" in step:
                sys.stdout.write(step["raw"] + "\n")
                sys.stdout.flush()

    # ------------------------------------------------------------ requests

    def open_thread(self, method, rid, params):
        if method == "thread/resume":
            self.thread = params.get("threadId")
            if not rollout_of(self.thread):
                out({"id": rid, "error": {"code": -32600,
                                          "message": "no rollout found for thread id %s"
                                          % self.thread}})
                self.thread = None
                return
        else:
            self.thread = str(uuid.uuid4())
            open(self.rollout(), "a").close()
        log({"engine": "codex-app", "method": method, "thread": self.thread,
             "cwd": os.getcwd(), "argv": self.argv,
             "env_has_bearer": any("Bearer" in v for v in os.environ.values()),
             "params": {k: v for k, v in params.items() if k != "developerInstructions"}})
        thread = {"id": self.thread, "cwd": params.get("cwd") or os.getcwd()}
        self.reply(rid, {"thread": thread, "model": params.get("model") or "gpt-fake",
                         "approvalPolicy": params.get("approvalPolicy")})
        self.notify("thread/started", {"thread": thread})

    def start_turn(self, rid, params):
        if params.get("threadId") != self.thread:
            out({"id": rid, "error": {"code": -32600, "message": "thread not found"}})
            return
        text = "".join(i.get("text", "") for i in params.get("input") or [])
        self.turn = str(uuid.uuid4())
        self.interrupted = False
        self.failed = None
        self.record("user_message", text)
        log({"turn": self.thread, "engine": "codex-app", "prompt": text, "cwd": os.getcwd(),
             "effort": params.get("effort"),
             "account": os.environ.get("CODEX_HOME", "this-mac")})
        turn = {"id": self.turn, "items": [], "status": "inProgress", "error": None}
        self.reply(rid, {"turn": turn})
        self.notify("turn/started", {"turn": turn})
        self.run(script_of(text))
        last = {"totalTokens": 120, "inputTokens": 100, "cachedInputTokens": 50,
                "cacheWriteInputTokens": 0, "outputTokens": 20, "reasoningOutputTokens": 0}
        self.notify("thread/tokenUsage/updated", {"turnId": self.turn, "tokenUsage": {
            "total": last, "last": last, "modelContextWindow": 272000}})
        if self.interrupted:
            status, error = "interrupted", None
        elif self.failed:
            status, error = "failed", {"message": self.failed}
        else:
            status, error = "completed", None
        self.notify("turn/completed", {"turn": dict(turn, status=status, error=error)})

    def serve(self):
        while True:
            msg = self.take()
            method, rid, params = msg.get("method"), msg.get("id"), msg.get("params") or {}
            if method == "initialize":
                self.reply(rid, {"userAgent": "fake/0.166.0", "codexHome": codex_home(),
                                 "platformFamily": "unix", "platformOs": "macos"})
            elif method == "account/rateLimits/read":
                self.reply(rid, {"rateLimits": {"limitId": "codex", "primary": None,
                                                "secondary": None, "credits": None,
                                                "planType": None}})
            elif method in ("thread/start", "thread/resume"):
                self.open_thread(method, rid, params)
            elif method == "turn/start":
                self.start_turn(rid, params)
            elif method == "thread/compact/start":
                self.reply(rid, {})
                iid = self.item_id("compact")
                self.notify("item/started", {"item": {"type": "contextCompaction", "id": iid}})
                self.notify("item/completed", {"item": {"type": "contextCompaction", "id": iid}})
            elif method is not None and rid is not None:
                out({"id": rid, "error": {"code": -32601, "message": "no " + method}})


# --------------------------------------------------------------- OpenCode

def opencode_sessions():
    base = os.environ.get("XDG_DATA_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "share")
    return os.path.join(base, "opencode", "fake-sessions")


class Acp:
    """`opencode acp`: JSON-RPC both ways, read by a thread into a queue so
    a step can wait on the app's answer to a permission ask."""

    def __init__(self):
        import queue
        import threading
        self.inbox = queue.Queue()
        self.next_id = 0
        self.session = None
        self.bridge = Bridge(None)
        self.cancelled = False
        self.replies = []
        self.msg = 0
        self.tool_n = 0
        try:
            self.config = json.loads(os.environ.get("OPENCODE_CONFIG_CONTENT") or "{}")
        except Exception:
            self.config = {}

        def reader():
            for line in sys.stdin:
                line = line.strip()
                if line:
                    try:
                        self.inbox.put(json.loads(line))
                    except Exception:
                        pass
            self.inbox.put(None)

        threading.Thread(target=reader, daemon=True).start()

    def update(self, update):
        out({"jsonrpc": "2.0", "method": "session/update",
             "params": {"sessionId": self.session, "update": update}})

    def path(self):
        return os.path.join(opencode_sessions(), self.session + ".jsonl")

    def record(self, entry):
        with open(self.path(), "a") as f:
            f.write(json.dumps(entry) + "\n")

    def permission(self, name):
        rules = self.config.get("permission") or {}
        rule = rules.get(name, rules.get("*", "ask"))
        if isinstance(rule, dict):
            rule = rule.get("*", "ask")
        return rule

    def take(self, block=True):
        """The next message from the app; a cancel is noted on the way."""
        import queue
        try:
            msg = self.inbox.get(timeout=None if block else 0.2)
        except queue.Empty:
            return "empty"
        if msg is None:
            sys.exit(0)
        if msg.get("method") == "session/cancel":
            self.cancelled = True
        return msg

    def ask(self, call_id, kind, title, raw):
        """`once` or not: the app's answer to `session/request_permission`."""
        rid = self.next_id
        self.next_id += 1
        out({"jsonrpc": "2.0", "id": rid, "method": "session/request_permission", "params": {
            "sessionId": self.session,
            "toolCall": {"toolCallId": call_id, "title": title, "kind": kind,
                         "status": "pending", "locations": [], "rawInput": raw},
            "options": [{"optionId": "once", "kind": "allow_once", "name": "Allow once"},
                        {"optionId": "always", "kind": "allow_always", "name": "Always allow"},
                        {"optionId": "reject", "kind": "reject_once", "name": "Reject"}]}})
        while True:
            msg = self.take()
            if msg.get("id") == rid and "method" not in msg:
                break
        option = ((msg.get("result") or {}).get("outcome") or {}).get("optionId")
        log({"engine": "opencode", "asked": raw, "answer": option})
        return option == "once"

    def tool_call(self, name, kind, raw):
        self.tool_n += 1
        cid = "call_fake_%d_%d" % (os.getpid(), self.tool_n)
        self.update({"sessionUpdate": "tool_call", "toolCallId": cid, "title": name,
                     "kind": kind, "status": "pending", "locations": [], "rawInput": {}})
        self.update({"sessionUpdate": "tool_call_update", "toolCallId": cid,
                     "status": "in_progress", "kind": kind, "title": name, "rawInput": raw})
        return cid

    def done(self, cid, text, failed=False, exit_code=None):
        update = {"sessionUpdate": "tool_call_update", "toolCallId": cid,
                  "status": "failed" if failed else "completed",
                  "content": [{"type": "content", "content": {"type": "text", "text": text}}],
                  "rawOutput": {"output": text}}
        if exit_code is not None:
            update["rawOutput"]["metadata"] = {"exit": exit_code}
        self.update(update)

    def say(self, text, every=0.0):
        self.msg += 1
        mid = "msg_fake_%d_%d" % (os.getpid(), self.msg)
        turns = 0
        if os.path.isfile(self.path()):
            with open(self.path()) as f:
                turns = sum(1 for line in f if '"user"' in line)
        text = (text.replace("{session}", self.session).replace("{turn}", str(turns))
                .replace("{account}", "this-mac"))
        for piece in re.findall(r"\S+\s*", text) or [text]:
            self.update({"sessionUpdate": "agent_message_chunk", "messageId": mid,
                         "content": {"type": "text", "text": piece}})
            if every:
                time.sleep(every)
        self.replies.append(text)
        self.record({"role": "assistant", "text": text})

    def run(self, steps):
        """The prompt's steps. A reject ends the round, as OpenCode's does."""
        for step in steps:
            if self.cancelled:
                return
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
                cid = self.tool_call("app_" + tool, "other", args)
                text, is_error = self.bridge.call(tool, args)
                self.done(cid, text, failed=is_error)
            elif "bash" in step:
                command = step["bash"]
                cid = self.tool_call("bash", "execute", {"command": command})
                if self.permission("bash") != "allow":
                    if not self.ask(cid, "execute", command, {"command": command}):
                        self.done(cid, "The user rejected permission to use this specific "
                                       "tool call.", failed=True)
                        return
                run = subprocess.run(["/bin/sh", "-c", command], capture_output=True, text=True)
                self.done(cid, run.stdout + run.stderr, exit_code=run.returncode)
            elif "write" in step:
                full = os.path.join(os.getcwd(), step["write"])
                cid = self.tool_call("write", "edit", {"filePath": full,
                                                       "content": step.get("text", "")})
                if not self.ask(cid, "edit", full, {"filepath": full, "diff": "+"}):
                    self.done(cid, "The user rejected permission to use this specific "
                                   "tool call.", failed=True)
                    return
                with open(full, "w") as f:
                    f.write(step.get("text", ""))
                self.done(cid, "Wrote file successfully.")
            elif "list_tools" in step:
                log({"served": self.bridge.tools()})
            elif "sleep" in step:
                time.sleep(float(step["sleep"]))
            elif "hang" in step:
                while not self.cancelled:
                    self.take(block=False)
            elif "crash" in step:
                self.update({"sessionUpdate": "agent_message_chunk", "messageId": "crash",
                             "content": {"type": "text",
                                         "text": "Here is the first half of my answer"}})
                os.kill(os.getpid(), signal.SIGSEGV)
            elif "stderr" in step:
                sys.stderr.write(step["stderr"] + "\n")
                sys.stderr.flush()
            elif "exit" in step:
                sys.exit(int(step["exit"]))
            elif "error" in step:
                raise RuntimeError(step["error"])

    def open_session(self, method, rid, params):
        for server in params.get("mcpServers") or []:
            if server.get("name") == "app":
                self.bridge.url = server.get("url")
                self.bridge.headers = {h["name"]: h["value"] for h in server.get("headers") or []}
        log({"engine": "opencode", "argv": sys.argv[1:], "config": self.config,
             "cwd": os.getcwd(), "method": method,
             "env_has_bearer": any("Bearer" in v for v in os.environ.values()),
             "header": bool(self.bridge.headers)})
        if method == "session/load":
            self.session = params.get("sessionId")
            if not os.path.isfile(self.path()):
                out({"jsonrpc": "2.0", "id": rid, "error": {
                    "code": -32603, "message": "Internal error: OpenCode service failure",
                    "data": {"service": "session"}}})
                return
            # Loading replays the whole conversation before answering.
            with open(self.path()) as f:
                for line in f:
                    entry = json.loads(line)
                    kind = "user_message_chunk" if entry["role"] == "user" else "agent_message_chunk"
                    self.update({"sessionUpdate": kind, "messageId": "old",
                                 "content": {"type": "text", "text": entry["text"]}})
        else:
            self.session = "ses_fake%s" % uuid.uuid4().hex[:20]
            open(self.path(), "a").close()
            # Where the app looks for a session (OpenCode's database).
            with open(os.path.join(os.path.dirname(opencode_sessions()), "opencode.db"), "a") as f:
                f.write(self.session + "\n")
        result = {"configOptions": [{"id": "model",
                                     "currentValue": self.config.get("model") or "opencode/fake"}]}
        if method == "session/new":
            result["sessionId"] = self.session
        out({"jsonrpc": "2.0", "id": rid, "result": result})

    def prompt(self, rid, params):
        text = "".join(p.get("text", "") for p in params.get("prompt") or [])
        self.record({"role": "user", "text": text})
        log({"turn": self.session, "engine": "opencode", "prompt": text, "cwd": os.getcwd()})
        self.cancelled = False
        # The app's note after a reject is answered in words.
        steps = ([{"say": "Noted: " + text[:300]}] if text.startswith("[Note from the app")
                 else script_of(text))
        try:
            self.run(steps)
        except RuntimeError as e:
            out({"jsonrpc": "2.0", "id": rid, "error": {"code": -32603, "message": str(e)}})
            return
        self.update({"sessionUpdate": "usage_update", "used": 1500, "size": 200000,
                     "cost": {"amount": 0.01, "currency": "USD"}})
        out({"jsonrpc": "2.0", "id": rid, "result": {
            "stopReason": "cancelled" if self.cancelled else "end_turn",
            "usage": {"inputTokens": 100, "outputTokens": 20, "totalTokens": 170,
                      "cachedReadTokens": 50}}})

    def serve(self):
        os.makedirs(opencode_sessions(), exist_ok=True)
        while True:
            msg = self.take()
            method, rid, params = msg.get("method"), msg.get("id"), msg.get("params") or {}
            if method == "initialize":
                out({"jsonrpc": "2.0", "id": rid, "result": {
                    "protocolVersion": 1, "agentInfo": {"name": "OpenCode", "version": "1.18.29"},
                    "agentCapabilities": {"loadSession": True}}})
            elif method in ("session/new", "session/load"):
                self.open_session(method, rid, params)
            elif method == "session/prompt":
                self.prompt(rid, params)
            elif method is not None and rid is not None:
                out({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601,
                                                             "message": "no " + method}})


OPENCODE_MODELS = """opencode/fake
{
  "id": "fake",
  "providerID": "opencode",
  "name": "Fake",
  "api": { "id": "fake", "url": "https://opencode.ai/zen/v1" }
}
local/fake
{
  "id": "fake",
  "providerID": "local",
  "name": "Local Fake",
  "api": { "id": "fake", "url": "http://127.0.0.1:11434/v1" }
}"""


def opencode_main(args):
    if args[:1] in (["--version"], ["-v"]):
        print("1.18.29")
    elif args[:1] == ["models"]:
        print(OPENCODE_MODELS if "--verbose" in args else "opencode/fake\nlocal/fake")
    elif args[:2] == ["debug", "config"]:
        print("{}")
    elif args[:1] == ["acp"]:
        Acp().serve()
    else:
        print("fake opencode: nothing to do for %s" % " ".join(args), file=sys.stderr)


def main():
    args = sys.argv[1:]
    if os.path.basename(sys.argv[0]).startswith("codex"):
        codex_main(args)
        return
    if os.path.basename(sys.argv[0]).startswith("opencode"):
        opencode_main(args)
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
