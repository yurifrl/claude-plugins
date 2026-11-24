// omp-claude-agent (omp side): lets Claude Code drive an interactive omp
// session. Loaded globally (from ~/.omp/agent/extensions or an omp plugin
// install) and/or with `omp -e <this file>` by the claude-omp-agent plugin's
// `open` tool; one copy serves per process, whichever loads first.
//
// Each omp process serves HTTP on the unix socket <dir>/sock, where <dir> is
// $OMP_CLAUDE_AGENT_DIR when the plugin's `open` set it, else
// ~/.cache/omp-claude-agent/omp-<pid>:
//
//   GET  /state                 session id, file, model, idle, seq
//   POST /prompt {message,mode} mode: prompt | steer | follow_up
//   GET  /wait?since=N&ms=M     holds until a turn settles after seq N
//   POST /ack?seq=N[&token=T]   {first:true} for the first caller only; a turn
//                               a token holder started is the holder's to ack
//   POST /release?token=T       drops that claim (a send that stopped waiting)
//   POST /abort, POST /shutdown
//
// Only interactive (TUI) omp serves: a child `omp -p` an agent runs stays out.
//
// While a Claude session drives this omp (the plugin keeps <dir>/owner while it
// does), each turn's system prompt gets DRIVEN_PROMPT appended.
//
// @ts-nocheck

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const SETTLE_DELAY_MS = 400;
const MAX_WAIT_MS = 25_000;
const STATE_ROOT = path.join(os.homedir(), ".cache", "omp-claude-agent");
const MODULE = import.meta.url;

const DRIVEN_PROMPT = `# Driven by Claude Code

A Claude Code session is driving this omp session: it sends your prompts and reads your replies. The person may still type here too.

- Report back in your reply: results, questions and decisions all go there, and Claude relays what the person needs to see.
- Do not use Plannotator (the plannotator command or its skills) or any other channel to reach the person directly.
- Track the work in tk (the tasks skill), when the working directory has a tk workspace. When Claude hands you a task id, claim it (\`tk update <id> --claim\`), record progress with \`tk note\`, attach evidence with \`tk attach\`, and hand over with \`tk update <id> --status ready-to-review\` plus a \`tk comment\`. Work Claude hands you without an id gets a task first (\`tk q "<title>"\`). Name the task id in your reply.
- tk's \`ask\`, \`say\` and \`annotate\` reach the person directly: do not use them; put questions in your reply.`;

// Read once, then dropped so omp started from inside this one (a bash tool
// running `omp -p`) does not take this process's socket.
const OPENED_DIR = process.env.OMP_CLAUDE_AGENT_DIR;
delete process.env.OMP_CLAUDE_AGENT_DIR;

type Shared = {
	owner: string; // the module file serving this process
	dir: string;
	openedByPlugin: boolean;
	server?: http.Server;
	ctx?: any;
	lastText: string; // newest non-empty reply
	turnText: string; // the reply of the turn running or just settled
	seq: number; // settled turns so far
	reservation?: { token: string; after: number };
	ackedSeq: number;
	waitingOnUser: boolean;
	settleTimer?: ReturnType<typeof setTimeout>;
	waiters: Set<() => void>;
	exitHooked?: boolean;
};

// omp runs a factory once per session (subagents and /new included), and a
// global install plus `omp -e` would load this file twice: keep one state per
// process, owned by the first copy that loads.
const shared: Shared = (globalThis.__ompClaudeAgent ??= {
	owner: MODULE,
	dir: OPENED_DIR || path.join(STATE_ROOT, `omp-${process.pid}`),
	openedByPlugin: Boolean(OPENED_DIR),
	lastText: "",
	turnText: "",
	seq: 0,
	ackedSeq: 0,
	waitingOnUser: false,
	waiters: new Set(),
});

function textOf(message: any): string {
	if (!message || !Array.isArray(message.content)) return "";
	return message.content
		.filter((block: any) => block?.type === "text")
		.map((block: any) => block.text ?? "")
		.join("")
		.trim();
}

function socketPath() {
	return path.join(shared.dir, "sock");
}

function state() {
	const ctx = shared.ctx;
	const manager = ctx?.sessionManager;
	return {
		name: path.basename(shared.dir),
		seq: shared.seq,
		isIdle: ctx?.isIdle?.() ?? true,
		hasPendingMessages: ctx?.hasPendingMessages?.() ?? false,
		waitingOnUser: shared.waitingOnUser,
		lastText: shared.lastText,
		sessionId: manager?.getSessionId?.() ?? null,
		sessionFile: manager?.getSessionFile?.() ?? null,
		sessionName: manager?.getSessionName?.() ?? null,
		model: ctx?.model?.id ?? null,
		cwd: ctx?.cwd ?? process.cwd(),
		pid: process.pid,
		block: process.env.TERN_PANE ?? null,
		openedByPlugin: shared.openedByPlugin,
	};
}

function readBody(request: http.IncomingMessage): Promise<any> {
	return new Promise((resolve) => {
		let raw = "";
		request.on("data", (chunk) => (raw += chunk));
		request.on("end", () => {
			try {
				resolve(raw ? JSON.parse(raw) : {});
			} catch {
				resolve(null);
			}
		});
	});
}

function wakeWaiters() {
	for (const wake of [...shared.waiters]) wake();
}

export default function ompClaudeAgent(pi: any) {
	if (shared.owner !== MODULE) return; // another copy serves this process

	const isMain = (context: any) => (context?.agent?.kind ?? "main") === "main";

	async function route(request: http.IncomingMessage, url: URL): Promise<[number, unknown]> {
		const key = `${request.method} ${url.pathname}`;
		switch (key) {
			case "GET /state":
				return [200, state()];
			case "POST /prompt": {
				const body = await readBody(request);
				if (!body || typeof body.message !== "string" || !body.message.trim()) {
					return [400, { error: "message must be a non-empty string" }];
				}
				// An explicit steer or follow-up only queues when omp is idle, and a
				// queued message never settles: send those as a plain prompt then.
				const isIdle = shared.ctx?.isIdle?.() ?? true;
				const deliverAs =
					isIdle ? undefined : body.mode === "steer" ? "steer" : body.mode === "follow_up" ? "followUp" : undefined;
				const before = shared.seq;
				if (typeof body.token === "string" && body.token) shared.reservation = { token: body.token, after: before };
				// attribution "agent": the text comes from another agent, not the operator.
				pi.sendUserMessage(body.message, { ...(deliverAs ? { deliverAs } : {}), attribution: "agent" });
				return [200, { ok: true, seq: before }];
			}
			case "GET /wait": {
				const since = Number(url.searchParams.get("since") ?? shared.seq);
				const ms = Math.min(Number(url.searchParams.get("ms") ?? MAX_WAIT_MS), MAX_WAIT_MS);
				if (shared.seq <= since) {
					await new Promise<void>((resolve) => {
						const done = () => {
							clearTimeout(timer);
							shared.waiters.delete(done);
							resolve();
						};
						const timer = setTimeout(done, ms);
						shared.waiters.add(done);
					});
				}
				return [200, { settled: shared.seq > since, seq: shared.seq, text: shared.turnText, waitingOnUser: shared.waitingOnUser }];
			}
			case "POST /ack": {
				const target = Number(url.searchParams.get("seq"));
				const token = url.searchParams.get("token");
				const held = shared.reservation;
				if (held && target > held.after && token !== held.token) return [200, { first: false, reserved: true }];
				if (held && token === held.token) shared.reservation = undefined;
				const first = target > shared.ackedSeq;
				if (first) shared.ackedSeq = target;
				return [200, { first }];
			}
			case "POST /release": {
				if (shared.reservation?.token === url.searchParams.get("token")) shared.reservation = undefined;
				return [200, { ok: true }];
			}
			case "POST /abort":
				shared.ctx?.abort?.();
				return [200, { ok: true }];
			case "POST /shutdown":
				setTimeout(() => shared.ctx?.shutdown?.(), 50);
				return [200, { ok: true }];
			default:
				return [404, { error: `unknown route: ${key}` }];
		}
	}

	function startServer() {
		if (shared.server) return;
		fs.mkdirSync(shared.dir, { recursive: true, mode: 0o700 });
		fs.rmSync(socketPath(), { force: true });
		const server = http.createServer(async (request, response) => {
			let status = 500;
			let body: unknown = { error: "bridge error" };
			try {
				[status, body] = await route(request, new URL(request.url ?? "/", "http://bridge"));
			} catch (error: any) {
				body = { error: String(error?.message ?? error) };
			}
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(body));
		});
		// A failed listen (a path past the socket length limit, permissions)
		// leaves no server, so a later session_start tries again.
		server.on("error", () => {
			if (shared.server === server) shared.server = undefined;
		});
		server.listen(socketPath());
		server.unref?.();
		shared.server = server;
	}

	function stopServer() {
		// A copy that never served (a worker thread's own globalThis) owns no socket.
		if (!shared.server) return;
		if (shared.settleTimer) clearTimeout(shared.settleTimer);
		wakeWaiters();
		shared.server?.close();
		shared.server = undefined;
		try {
			fs.rmSync(socketPath(), { force: true });
		} catch {
			// exiting anyway
		}
		// a folder this copy named after its pid is only ever this process's
		if (!shared.openedByPlugin) fs.rmSync(shared.dir, { recursive: true, force: true });
	}

	pi.on("session_start", (_event: any, context: any) => {
		if (!isMain(context) || context?.mode !== "tui") return;
		shared.ctx = context;
		shared.waitingOnUser = false;
		startServer();
	});

	pi.on("before_agent_start", (event: any, context: any) => {
		if (!isMain(context) || !fs.existsSync(path.join(shared.dir, "owner"))) return;
		const current = event?.systemPrompt;
		const sections = Array.isArray(current) ? current : typeof current === "string" ? [current] : [];
		return { systemPrompt: [...sections, DRIVEN_PROMPT] };
	});

	pi.on("agent_start", (_event: any, context: any) => {
		if (!isMain(context)) return;
		shared.ctx = context;
		shared.turnText = "";
		shared.waitingOnUser = false;
		if (shared.settleTimer) clearTimeout(shared.settleTimer);
	});

	pi.on("message_end", (event: any, context: any) => {
		if (!isMain(context) || event?.message?.role !== "assistant") return;
		const text = textOf(event.message);
		if (text) {
			shared.turnText = text;
			shared.lastText = text;
		}
	});

	pi.on("tool_execution_start", (event: any, context: any) => {
		if (isMain(context) && event?.toolName === "ask") shared.waitingOnUser = true;
	});

	pi.on("tool_execution_end", (event: any, context: any) => {
		if (isMain(context) && event?.toolName === "ask") shared.waitingOnUser = false;
	});

	// Retries and queued follow-ups end one loop and start another, so count a
	// turn as settled only once the session is still idle a moment after agent_end.
	pi.on("agent_end", (event: any, context: any) => {
		if (!isMain(context)) return;
		shared.ctx = context;
		if (shared.settleTimer) clearTimeout(shared.settleTimer);
		shared.settleTimer = setTimeout(() => {
			try {
				const ctx = shared.ctx;
				if (ctx?.isIdle?.() === false || ctx?.hasPendingMessages?.()) return;
				shared.waitingOnUser = false;
				shared.seq += 1;
				wakeWaiters();
			} catch {
				// never let a bridge error take the session down
			}
		}, SETTLE_DELAY_MS);
	});

	// session_shutdown also fires when /new or /resume swaps the session out
	// while the process lives on, so the socket goes only when omp exits. The
	// server is unref'd and never holds the process open.
	if (!shared.exitHooked) {
		shared.exitHooked = true;
		process.once("exit", stopServer);
	}
}
