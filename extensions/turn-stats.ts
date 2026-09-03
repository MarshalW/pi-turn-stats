/**
 * turn-stats.ts — 单次对话耗时 & token 消耗统计
 *
 * 功能：
 * 1. 每次用户发消息到回复完成（before_agent_start → agent_settled，含工具调用循环/重试），
 *    在对话流中追加一张「对话统计」卡片（pi.appendEntry + registerEntryRenderer，
 *    不参与 LLM 上下文，不会发给模型）
 * 2. 底部状态栏实时显示上一次对话的 耗时 / 生成速度 / token / 费用（ctx.ui.setStatus）
 * 3. /turnstats 命令追加当前会话的累计统计卡片
 *
 * 数据来源：
 * - turn_end 事件携带每条 assistant 消息的 usage（input/output/cacheRead/cacheWrite/totalTokens/cost）
 * - before_agent_start / agent_settled 界定一次对话的起止时间
 *
 * 生成速度（tokens/s）：分子**只用输出 token**（自回归解码生成的量），
 * 分母为整次对话的墙钟耗时。绝不能用 totalTokens —— 它包含输入/缓存读/写，
 * 会把速度虚高几十倍（例：输入 2029 + 输出 139 → 2168/13.2s ≈ 164 t/s，
 * 而真实的 139/13.2s ≈ 10.5 t/s）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "turn-stats";

/** 是否在对话流中追加统计卡片（设为 false 可只保留状态栏） */
const SHOW_CARD = true;

interface TurnStatsData {
	kind: "exchange" | "session";
	startTime: number;
	endTime: number;
	/** LLM 调用次数（一次对话可能多次调用工具形成多个 turn） */
	turns: number;
	/** 对话次数（exchange=1，session=累计） */
	exchanges: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	/** 生成速度：输出 tok/s（仅 autoregressive 解码输出） */
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
 * 生成速度 = 输出 token 数（自回归解码量）÷ 墙钟耗时。
 * 分子只用 output，排除 input / cacheRead / cacheWrite / totalTokens。
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
	// ---- 会话累计统计 ----
	const sessionTotals = {
		...emptyAccum(),
		exchanges: 0,
		durationMs: 0,
	};

	// ---- 单次对话统计 ----
	let running = false;
	let startTime = 0;
	let turnCount = 0;
	let accum = emptyAccum();
	let lastModel = "";

	// ===== 统计卡片渲染（对话流内） =====
	pi.registerEntryRenderer<TurnStatsData>(ENTRY_TYPE, (entry, { expanded }, theme) => {
		const d = entry.data;
		if (!d) return new Text(theme.fg("dim", "(no stats)"), 0, 0);

		const isSession = d.kind === "session";
		const dur = fmtDuration(d.endTime - d.startTime);
		const cost = fmtCost(d.cost);

		const box = new Box(1, 1, (s) => theme.bg("customMessageBg", s));

		// 标题行
		const title = isSession ? "📊 会话统计" : "⏱ 对话统计";
		box.addChild(
			new Text(
				theme.fg("accent", theme.bold(title)) +
					theme.fg("dim", `  ${d.model}`),
				0,
				0,
			),
		);

		// 耗时 / 次数 / 生成速度 / 费用
		const genTps = fmtThroughput(d.tokensPerSec);
		const meta = isSession
			? `累计 ${d.exchanges} 次对话 · ${d.turns} 次 LLM 调用 · 输出 ${genTps} · 费用 `
			: `耗时 ${dur} · ${d.turns} 次 LLM 调用 · 输出 ${genTps} · 费用 `;
		box.addChild(
			new Text(
				theme.fg("dim", meta) + theme.fg("text", cost),
				0,
				0,
			),
		);

		// token 明细
		box.addChild(
			new Text(
				theme.fg("dim", "token 输入 ") +
					theme.fg("text", fmtTokens(d.input)) +
					theme.fg("dim", " · 输出 ") +
					theme.fg("text", fmtTokens(d.output)) +
					theme.fg("dim", " · 缓存读 ") +
					theme.fg("text", fmtTokens(d.cacheRead)) +
					theme.fg("dim", " / 写 ") +
					theme.fg("text", fmtTokens(d.cacheWrite)) +
					theme.fg("dim", " · 合计 ") +
					theme.fg("text", fmtTokens(d.totalTokens)),
				0,
				0,
			),
		);

		// 展开时显示起止时间
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

	// ===== 会话开始：初始化状态栏 =====
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("turn-stats", ctx.ui.theme.fg("dim", "⏱ 等待对话…"));
	});

	// ===== 用户提交消息：开始计时 =====
	pi.on("before_agent_start", (_event, ctx) => {
		running = true;
		startTime = Date.now();
		turnCount = 0;
		accum = emptyAccum();
		lastModel = ctx.model?.id ?? "unknown";
		if (ctx.hasUI) {
			ctx.ui.setStatus("turn-stats", ctx.ui.theme.fg("dim", "⏱ 统计中…"));
		}
	});

	// ===== 每个 LLM turn 结束：累计 usage =====
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

	// ===== 回复完成：出卡片 + 更新状态栏 =====
	pi.on("agent_settled", (_event, ctx) => {
		if (!running) return;
		running = false;
		const endTime = Date.now();
		const durMs = endTime - startTime;
		// 生成速度只统计输出 token（自回归解码），排除输入/缓存读/写
		const genTps = calcOutputPerSec(accum.output, durMs);

		// 累加会话统计
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"] as const) {
			sessionTotals[key] += accum[key];
		}
		sessionTotals.exchanges++;
		sessionTotals.durationMs += durMs;

		// 至少有一次 LLM 调用才出卡片（中途 Esc 取消且未发起调用则跳过）
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
					`⏱ ${fmtDuration(durMs)} · 输出 ${fmtThroughput(genTps)} · ${fmtTokens(accum.totalTokens)} tok · ${fmtCost(accum.cost)}`,
				),
			);
		}
	});

	// ===== /turnstats：追加会话累计统计卡片 =====
	pi.registerCommand("turnstats", {
		description: "追加当前会话的累计耗时与 token 统计卡片",
		handler: async () => {
			const sessDurMs = sessionTotals.durationMs;
			// 生成速度只统计输出 token（自回归解码），排除输入/缓存读/写
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
				model: "累计",
			});
		},
	});
}
