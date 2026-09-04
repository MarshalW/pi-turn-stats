/**
 * turn-stats.ts — per-exchange duration, token & cost stats
 *
 * Features:
 * 1. After each user→reply exchange (before_agent_start → agent_settled),
 *    append a stats card to the conversation stream (via pi.appendEntry +
 *    registerEntryRenderer, not part of LLM context).
 * 2. Status bar shows last exchange duration / throughput / tokens / cost.
 * 3. /turnstats command appends a session cumulative stats card.
 *
 * Data sources:
 * - turn_end event carries per-assistant-message usage
 *   (input/output/cacheRead/cacheWrite/totalTokens/cost)
 * - before_agent_start / agent_settled delimit the wall-clock duration
 *
 * Throughput (tok/s): numerator = output tokens only (autoregressive decode),
 * denominator = wall-clock time of the whole exchange.
 * Never use totalTokens — it inflates throughput dozens of times because it
 * includes input + cache read/write.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "turn-stats";

/** Whether to append a stats card after each exchange (false = status bar only) */
const SHOW_CARD = true;

// ===== i18n: auto-detect locale from system environment =====

type Locale = "zh" | "en";

function detectLocale(): Locale {
	const env = process.env.LANG ?? process.env.LC_ALL ?? "";
	if (env.startsWith("zh")) return "zh";
	try {
		const resolved = Intl.DateTimeFormat().resolvedLocales();
		if (resolved.length > 0 && resolved[0].startsWith("zh")) return "zh";
	} catch { /* Intl not available — fall through */ }
	return "en";
}

const locale: Locale = detectLocale();

type Msg = string | ((...args: any[]) => string);

const messages: Record<Locale, Record<string, Msg>> = {
	zh: {
		cardTitleExchange: "⏱ 对话统计",
		cardTitleSession: "📊 会话统计",
		metaExchange: (dur: string, turns: number, tps: string) =>
			`耗时 ${dur} · ${turns} 次 LLM 调用 · 输出 ${tps} · 费用 `,
		metaSession: (ex: number, turns: number, tps: string) =>
			`累计 ${ex} 次对话 · ${turns} 次 LLM 调用 · 输出 ${tps} · 费用 `,
		tokenInput: "token 输入 ",
		tokenOutput: " · 输出 ",
		cacheRead: " · 缓存读 ",
		cacheWrite: " / 写 ",
		tokenTotal: " · 合计 ",
		statusWaiting: "⏱ 等待对话…",
		statusRunning: "⏱ 统计中…",
		cmdDescription: "追加当前会话的累计耗时与 token 统计卡片",
		sessionModel: "累计",
	},
	en: {
		cardTitleExchange: "⏱ Turn Stats",
		cardTitleSession: "📊 Session Stats",
		metaExchange: (dur: string, turns: number, tps: string) =>
			`${dur} · ${turns} LLM calls · output ${tps} · cost `,
		metaSession: (ex: number, turns: number, tps: string) =>
			`${ex} exchanges · ${turns} LLM calls · output ${tps} · cost `,
		tokenInput: "token input ",
		tokenOutput: " · output ",
		cacheRead: " · cache read ",
		cacheWrite: " / write ",
		tokenTotal: " · total ",
		statusWaiting: "⏱ Waiting…",
		statusRunning: "⏱ Processing…",
		statusDone: (dur: string, tps: string, tokens: string, cost: string) =>
			`⏱ ${dur} · output ${tps} · ${tokens} tok · ${cost}`,
		cmdDescription: "Append session cumulative turn stats card",
		sessionModel: "Cumulative",
	},
};

function t(key: string, ...args: any[]): string {
	const msg = messages[locale][key] as Msg | undefined;
	if (typeof msg === "function") return msg(...args);
	return msg ?? key;
}

// ===== end i18n =====

interface TurnStatsData {
	kind: "exchange" | "session";
	startTime: number;
	endTime: number;
	/** LLM call count (one exchange may trigger multiple tool-call turns) */
	turns: number;
	/** Exchange count (1 for a single exchange, cumulative for session) */
	exchanges: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	/** Throughput: output tok/s (autoregressive decode only) */
	tokensPerSec: number;
	model: string;
}

interface TokenAccum {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

const emptyAccum = (): TokenAccum => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
});

function fmtDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	const rem = Math.round(s % 60);
	return rem > 0 ? `${m}m${rem}s` : `${m}m`;
}

function fmtTokens(n: number): string {
	if (n < 1000) return `${Math.round(n)}`;
	return `${(n / 1000).toFixed(1)}k`;
}

function fmtThroughput(tps: number): string {
	if (tps <= 0) return "—";
	if (tps < 1000) return `${Math.round(tps)} tok/s`;
	return `${(tps / 1000).toFixed(1)}k tok/s`;
}

/**
 * Throughput = output tokens (autoregressive decode) ÷ wall-clock elapsed.
 * Only output tokens — input / cacheRead / cacheWrite / totalTokens are
 * excluded to avoid inflating throughput.
 */
function calcOutputPerSec(outputTokens: number, elapsedMs: number): number {
	return elapsedMs > 0 ? outputTokens / (elapsedMs / 1000) : 0;
}

function fmtCost(c: number): string {
	if (c <= 0) return "$0";
	if (c < 0.01) return `$${c.toFixed(5)}`;
	return `$${c.toFixed(4)}`;
}

export default function (pi: ExtensionAPI) {
	// ---- session cumulative stats ----
	const sessionTotals = {
		...emptyAccum(),
		exchanges: 0,
		durationMs: 0,
	};

	// ---- per-exchange stats ----
	let running = false;
	let startTime = 0;
	let turnCount = 0;
	let accum = emptyAccum();
	let lastModel = "";

	// ===== Stats card renderer (in conversation stream) =====
	pi.registerEntryRenderer<TurnStatsData>(ENTRY_TYPE, (entry, { expanded }, theme) => {
		const d = entry.data;
		if (!d) return new Text(theme.fg("dim", "(no stats)"), 0, 0);

		const isSession = d.kind === "session";
		const dur = fmtDuration(d.endTime - d.startTime);
		const cost = fmtCost(d.cost);
		const genTps = fmtThroughput(d.tokensPerSec);

		const box = new Box(1, 1, (s) => theme.bg("customMessageBg", s));

		// title line
		const title = isSession ? t("cardTitleSession") : t("cardTitleExchange");
		box.addChild(
			new Text(
				theme.fg("accent", theme.bold(title)) +
					theme.fg("dim", `  ${d.model}`),
				0,
				0,
			),
		);

		// duration / count / throughput / cost
		const meta = isSession
			? t("metaSession", d.exchanges, d.turns, genTps)
			: t("metaExchange", dur, d.turns, genTps);
		box.addChild(
			new Text(
				theme.fg("dim", meta) + theme.fg("text", cost),
				0,
				0,
			),
		);

		// token breakdown
		box.addChild(
			new Text(
				theme.fg("dim", t("tokenInput")) +
					theme.fg("text", fmtTokens(d.input)) +
					theme.fg("dim", t("tokenOutput")) +
					theme.fg("text", fmtTokens(d.output)) +
					theme.fg("dim", t("cacheRead")) +
					theme.fg("text", fmtTokens(d.cacheRead)) +
					theme.fg("dim", t("cacheWrite")) +
					theme.fg("text", fmtTokens(d.cacheWrite)) +
					theme.fg("dim", t("tokenTotal")) +
					theme.fg("text", fmtTokens(d.totalTokens)),
				0,
				0,
			),
		);

		// expanded: show time range
		if (expanded && d.startTime > 0) {
			box.addChild(
				new Text(
					theme.fg("dim", `${new Date(d.startTime).toLocaleString()} → ${new Date(d.endTime).toLocaleString()}`),
					0,
					0,
				),
			);
		}

		return box;
	});

	// ===== Session start: init status bar =====
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("turn-stats", ctx.ui.theme.fg("dim", t("statusWaiting")));
	});

	// ===== User submits: start timer =====
	pi.on("before_agent_start", (_event, ctx) => {
		running = true;
		startTime = Date.now();
		turnCount = 0;
		accum = emptyAccum();
		lastModel = ctx.model?.id ?? "unknown";
		if (ctx.hasUI) {
			ctx.ui.setStatus("turn-stats", ctx.ui.theme.fg("dim", t("statusRunning")));
		}
	});

	// ===== Each LLM turn ends: accumulate usage =====
	pi.on("turn_end", (event, _ctx) => {
		if (!running) return;
		turnCount++;
		const msg = event.message;
		if (msg?.role !== "assistant") return;
		const u = msg.usage;
		if (u) {
			accum.input += u.input ?? 0;
			accum.output += u.output ?? 0;
			accum.cacheRead += u.cacheRead ?? 0;
			accum.cacheWrite += u.cacheWrite ?? 0;
			accum.totalTokens += u.totalTokens ?? 0;
			accum.cost += u.cost?.total ?? 0;
		}
	});

	// ===== Reply settled: emit card + update status bar =====
	pi.on("agent_settled", (_event, ctx) => {
		if (!running) return;
		running = false;
		const endTime = Date.now();
		const durMs = endTime - startTime;
		const genTps = calcOutputPerSec(accum.output, durMs);

		// accumulate session totals
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"] as const) {
			sessionTotals[key] += accum[key];
		}
		sessionTotals.exchanges++;
		sessionTotals.durationMs += durMs;

		if (SHOW_CARD && turnCount > 0) {
			pi.appendEntry<TurnStatsData>(ENTRY_TYPE, {
				kind: "exchange",
				startTime,
				endTime,
				turns: turnCount,
				exchanges: 1,
				...accum,
				tokensPerSec: genTps,
				model: lastModel,
			});
		}

		if (ctx.hasUI) {
			ctx.ui.setStatus(
				"turn-stats",
				ctx.ui.theme.fg(
					"dim",
					t("statusDone", fmtDuration(durMs), fmtThroughput(genTps), fmtTokens(accum.totalTokens), fmtCost(accum.cost)),
				),
			);
		}
	});

	// ===== /turnstats: append session cumulative stats card =====
	pi.registerCommand("turnstats", {
		description: t("cmdDescription"),
		handler: async () => {
			const sessDurMs = sessionTotals.durationMs;
			const sessGenTps = calcOutputPerSec(sessionTotals.output, sessDurMs);
			pi.appendEntry<TurnStatsData>(ENTRY_TYPE, {
				kind: "session",
				startTime: sessDurMs > 0 ? Date.now() - sessDurMs : Date.now(),
				endTime: Date.now(),
				turns: sessionTotals.exchanges,
				exchanges: sessionTotals.exchanges,
				input: sessionTotals.input,
				output: sessionTotals.output,
				cacheRead: sessionTotals.cacheRead,
				cacheWrite: sessionTotals.cacheWrite,
				totalTokens: sessionTotals.totalTokens,
				cost: sessionTotals.cost,
				tokensPerSec: sessGenTps,
				model: t("sessionModel"),
			});
		},
	});
}
