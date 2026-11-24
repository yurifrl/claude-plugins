// omp-claude-agent (omp side): lets Claude Code drive a normal interactive omp
// session. Loaded with `omp -e <this file>` by the omp-claude-agent plugin.
//
// Inert unless OMP_CLAUDE_AGENT_DIR names a state directory; then it serves
// HTTP on the unix socket <dir>/sock:
//
//   GET  /state                 session id, file, model, idle, seq
//   POST /prompt {message,mode} mode: prompt | steer | follow_up
//   GET  /wait?since=N&ms=M     holds until a turn settles after seq N
//   POST /ack?seq=N             {first:true} for the first caller only
//   POST /abort, POST /shutdown
//
// @ts-nocheck

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const STATE_DIR = process.env.OMP_CLAUDE_AGENT_DIR;
const SETTLE_DELAY_MS = 400;
const MAX_WAIT_MS = 25_000;

function textOf(message: any): string {
	if (!message || !Array.isArray(message.content)) return "";
	return message.content
		.filter((block: any) => block?.type === "text")
		.map((block: any) => block.text ?? "")
		.join("")
		.trim();
}

function lastAssistantText(messages: any[]): string {
	for (let index = (messages?.length ?? 0) - 1; index >= 0; index--) {
		if (messages[index]?.role === "assistant") {
			const text = textOf(messages[index]);
			if (text) return text;
		}
	}
	return "";
}

export default function ompClaudeAgent(pi: any) {
	if (!STATE_DIR) return;

	const socketPath = path.join(STATE_DIR, "sock");
	let server: http.Server | undefined;
	let ctx: any;
	let lastText = "";
	let seq = 0; // settled turns so far
	let ackedSeq = 0;
	let waitingOnUser = false;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	const waiters = new Set<() => void>();

	const isMain = (context: any) => (context?.agent?.kind ?? "main") === "main";

	function state() {
		const manager = ctx?.sessionManager;
		return {
			name: path.basename(STATE_DIR!),
			seq,
			isIdle: ctx?.isIdle?.() ?? true,
			hasPendingMessages: ctx?.hasPendingMessages?.() ?? false,
			waitingOnUser,
			lastText,
			sessionId: manager?.getSessionId?.() ?? null,
			sessionFile: manager?.getSessionFile?.() ?? null,
			model: ctx?.model?.id ?? null,
			cwd: ctx?.cwd ?? process.cwd(),
			pid: process.pid,
			block: process.env.TERN_PANE ?? null,
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
				const deliverAs = body.mode === "steer" ? "steer" : body.mode === "follow_up" ? "followUp" : undefined;
				const before = seq;
				// attribution "agent": the text comes from another agent, not the operator.
				pi.sendUserMessage(body.message, { ...(deliverAs ? { deliverAs } : {}), attribution: "agent" });
				return [200, { ok: true, seq: before }];
			}
			case "GET /wait": {
				const since = Number(url.searchParams.get("since") ?? seq);
				const ms = Math.min(Number(url.searchParams.get("ms") ?? MAX_WAIT_MS), MAX_WAIT_MS);
				if (seq <= since) {
					await new Promise<void>((resolve) => {
						const done = () => {
							clearTimeout(timer);
							waiters.delete(done);
							resolve();
						};
						const timer = setTimeout(done, ms);
						waiters.add(done);
					});
				}
				return [200, { settled: seq > since, seq, text: lastText, waitingOnUser }];
			}
			case "POST /ack": {
				const target = Number(url.searchParams.get("seq"));
				const first = target > ackedSeq;
				if (first) ackedSeq = target;
				return [200, { first }];
			}
			case "POST /abort":
				ctx?.abort?.();
				return [200, { ok: true }];
			case "POST /shutdown":
				setTimeout(() => ctx?.shutdown?.(), 50);
				return [200, { ok: true }];
			default:
				return [404, { error: `unknown route: ${key}` }];
		}
	}

	function startServer() {
		if (server) return;
		fs.mkdirSync(STATE_DIR!, { recursive: true });
		fs.rmSync(socketPath, { force: true });
		server = http.createServer(async (request, response) => {
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
		server.on("error", () => {});
		server.listen(socketPath);
		server.unref?.();
	}

	function stopServer() {
		if (settleTimer) clearTimeout(settleTimer);
		for (const wake of [...waiters]) wake();
		server?.close();
		server = undefined;
		fs.rmSync(socketPath, { force: true });
	}

	pi.on("session_start", (_event: any, context: any) => {
		if (!isMain(context)) return;
		ctx = context;
		startServer();
	});

	pi.on("agent_start", (_event: any, context: any) => {
		if (!isMain(context)) return;
		ctx = context;
		if (settleTimer) clearTimeout(settleTimer);
	});

	pi.on("message_end", (event: any, context: any) => {
		if (!isMain(context) || event?.message?.role !== "assistant") return;
		const text = textOf(event.message);
		if (text) lastText = text;
	});

	pi.on("tool_execution_start", (event: any, context: any) => {
		if (isMain(context) && event?.toolName === "ask") waitingOnUser = true;
	});

	pi.on("tool_execution_end", (event: any, context: any) => {
		if (isMain(context) && event?.toolName === "ask") waitingOnUser = false;
	});

	// Retries and queued follow-ups end one loop and start another, so count a
	// turn as settled only once the session is still idle a moment after agent_end.
	pi.on("agent_end", (event: any, context: any) => {
		if (!isMain(context)) return;
		ctx = context;
		const text = lastAssistantText(event?.messages);
		if (text) lastText = text;
		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = setTimeout(() => {
			try {
				if (ctx?.isIdle?.() === false || ctx?.hasPendingMessages?.()) return;
				seq += 1;
				for (const wake of [...waiters]) wake();
			} catch {
				// never let a bridge error take the session down
			}
		}, SETTLE_DELAY_MS);
	});

	pi.on("session_shutdown", (_event: any, context: any) => {
		if (!isMain(context)) return;
		stopServer();
	});
}
