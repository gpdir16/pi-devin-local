import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { buildMetadata, DEFAULT_API_SERVER, normalizeSessionToken } from "./metadata.js";
import { asBuffer, asFloat32, asString, encodeMessage, iterFields } from "./wire.js";

const GET_CLI_MODEL_CONFIGS = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const EFFORT_BY_NAME: Record<string, Effort> = {
	none: "off",
	nothinking: "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

const EFFORT_PREF: Effort[] = ["high", "medium", "max", "xhigh", "low", "minimal", "off"];
const ALL_EFFORTS: Effort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const SKIP_DISPLAY = new Set([4, 6]); // quick-review, internal-default

interface FamilyMeta {
	label: string;
	effort?: Effort;
	thinking?: boolean;
	fast: boolean;
	context1m: boolean;
	isDefault: boolean;
}

interface ClientConfig {
	uid: string;
	label: string;
	disabled: boolean;
	supportsImages: boolean;
	supportsThinking: boolean;
	isRouter: boolean;
	displayOption: number;
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	family?: FamilyMeta;
	isDefaultInFamily: boolean;
}

function decodeFamily(buf: Buffer): FamilyMeta | undefined {
	let label = "";
	let isDefault = false;
	let effort: Effort | undefined;
	let thinking: boolean | undefined;
	let fast = false;
	let context1m = false;
	for (const field of iterFields(buf)) {
		if (field.num === 1 && field.wire === 2) {
			label = asString(field.value)?.trim() ?? "";
		} else if (field.num === 3 && field.wire === 0) {
			isDefault = field.value === 1n;
		} else if (field.num === 2 && field.wire === 2) {
			const entry = asBuffer(field.value);
			if (!entry) continue;
			let key = "";
			let order = 0;
			let name = "";
			for (const inner of iterFields(entry)) {
				if (inner.num === 1 && inner.wire === 2) key = (asString(inner.value) ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
				if (inner.num === 2 && inner.wire === 2) {
					const valueBuf = asBuffer(inner.value);
					if (!valueBuf) continue;
					for (const v of iterFields(valueBuf)) {
						if (v.num === 1 && v.wire === 0) order = Number(v.value);
						if (v.num === 2 && v.wire === 2) name = asString(v.value) ?? "";
					}
				}
			}
			if (key === "fast mode") fast = order === 1;
			else if (key === "thinking") thinking = order === 1;
			else if (key === "1m context") context1m = order === 1;
			else if (key === "effort" || key === "reasoning effort") {
				effort = EFFORT_BY_NAME[name.toLowerCase().replace(/[^a-z0-9]+/g, "")];
			}
		}
	}
	if (!label) return undefined;
	if (thinking === false) effort = "off";
	return { label, effort, thinking, fast, context1m, isDefault };
}

function decodeCost(buf: Buffer): { input: number; output: number; cacheRead: number; cacheWrite: number } {
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let label = "";
	let value = 0;
	let denominator = "1M tokens";
	let kind = 0;
	for (const field of iterFields(buf)) {
		if (field.num === 1 && field.wire === 2) label = (asString(field.value) ?? "").trim().toLowerCase();
		else if (field.num === 2 && field.wire === 5) value = asFloat32(field.value) ?? 0;
		else if (field.num === 3 && field.wire === 2) denominator = asString(field.value) ?? denominator;
		else if (field.num === 6 && field.wire === 0) kind = Number(field.value);
	}
	if (kind !== 0 && kind !== 1) return cost;
	const match = /(\d+(?:\.\d+)?)\s*([kmb])?/i.exec(denominator);
	let tokens = 1_000_000;
	if (match) {
		const scale = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[match[2]?.toLowerCase() ?? ""] ?? 1;
		tokens = Number(match[1]) * scale || 1_000_000;
	}
	const perMillion = Math.round(((value * 1_000_000) / tokens) * 1e6) / 1e6;
	if (label === "input") cost.input = perMillion;
	else if (label === "cached input") cost.cacheRead = perMillion;
	else if (label === "output") cost.output = perMillion;
	return cost;
}

function decodeConfig(buf: Buffer): ClientConfig | null {
	let uid = "";
	let label = "";
	let disabled = false;
	let supportsImages = false;
	let supportsThinking = false;
	let isRouter = false;
	let displayOption = 0;
	let contextWindow = 0;
	let maxTokens = 0;
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let family: FamilyMeta | undefined;
	let isDefaultInFamily = false;

	for (const field of iterFields(buf)) {
		if (field.num === 1 && field.wire === 2) label = asString(field.value)?.trim() ?? "";
		else if (field.num === 5 && field.wire === 0) supportsImages = field.value === 1n;
		else if (field.num === 18 && field.wire === 0) contextWindow = Number(field.value);
		else if (field.num === 22 && field.wire === 2) uid = asString(field.value)?.trim() ?? "";
		else if (field.num === 31 && field.wire === 0) isDefaultInFamily = field.value === 1n;
		else if (field.num === 33) disabled = true;
		else if (field.num === 30 && field.wire === 2) {
			const parsed = asBuffer(field.value);
			if (parsed) family = decodeFamily(parsed);
		} else if (field.num === 32 && field.wire === 2) {
			const parsed = asBuffer(field.value);
			if (parsed) {
				const one = decodeCost(parsed);
				if (one.input) cost.input = one.input;
				if (one.output) cost.output = one.output;
				if (one.cacheRead) cost.cacheRead = one.cacheRead;
			}
		} else if (field.num === 23 && field.wire === 2) {
			const info = asBuffer(field.value);
			if (!info) continue;
			for (const inner of iterFields(info)) {
				if (inner.num === 13 && inner.wire === 0) maxTokens = Number(inner.value);
				else if (inner.num === 22 && inner.wire === 0) displayOption = Number(inner.value);
				else if (inner.num === 25 && inner.wire === 0) isRouter = inner.value === 1n;
				else if (inner.num === 6 && inner.wire === 2) {
					const features = asBuffer(inner.value);
					if (!features) continue;
					for (const f of iterFields(features)) {
						if (f.wire !== 0) continue;
						if (f.num === 11) supportsThinking = f.value === 1n;
						if (f.num === 15 && f.value === 1n) supportsImages = true;
					}
				}
			}
		}
	}

	if (!uid) return null;
	return {
		uid,
		label: label || uid,
		disabled,
		supportsImages,
		supportsThinking,
		isRouter,
		displayOption,
		contextWindow: contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW,
		maxTokens: maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS,
		cost,
		family,
		isDefaultInFamily: isDefaultInFamily || Boolean(family?.isDefault),
	};
}

interface Lane {
	name: string;
	members: ClientConfig[];
	routing: Partial<Record<Effort, string>>;
	defaultUid?: string;
}

function laneKey(config: ClientConfig): string {
	const family = config.family;
	if (!family) return `\0${config.uid}`;
	return `${family.label}\0${family.context1m ? "1m" : ""}\0${family.fast ? "fast" : ""}`;
}

function toModel(config: ClientConfig, extras?: { thinkingLevelMap?: ThinkingLevelMap; reasoning?: boolean }): Model<"devin-local"> {
	return {
		id: config.uid,
		name: extras?.thinkingLevelMap ? config.family?.label ?? config.label : config.label,
		api: "devin-local",
		provider: "devin",
		baseUrl: DEFAULT_API_SERVER,
		reasoning: extras?.reasoning ?? config.supportsThinking,
		thinkingLevelMap: extras?.thinkingLevelMap,
		input: config.supportsImages ? ["text", "image"] : ["text"],
		cost: config.cost,
		contextWindow: config.contextWindow,
		maxTokens: config.maxTokens,
	};
}

export function modelsFromConfigs(rawConfigs: Buffer[]): Model<"devin-local">[] {
	const configs = rawConfigs
		.map(decodeConfig)
		.filter((c): c is ClientConfig => Boolean(c) && !c.disabled && !c.isRouter && !SKIP_DISPLAY.has(c.displayOption));

	const lanes = new Map<string, Lane>();
	const standalone: ClientConfig[] = [];
	for (const config of configs) {
		if (!config.family) {
			standalone.push(config);
			continue;
		}
		const key = laneKey(config);
		let lane = lanes.get(key);
		if (!lane) {
			const suffix = `${config.family.context1m ? " 1M" : ""}${config.family.fast ? " Fast" : ""}`;
			lane = { name: `${config.family.label}${suffix}`, members: [], routing: {} };
			lanes.set(key, lane);
		}
		lane.members.push(config);
		if (config.family.effort && lane.routing[config.family.effort] === undefined) {
			lane.routing[config.family.effort] = config.uid;
		}
		if (!lane.defaultUid && config.isDefaultInFamily) lane.defaultUid = config.uid;
	}

	const models: Model<"devin-local">[] = standalone.map((c) => toModel(c));
	for (const lane of lanes.values()) {
		const mapped = (Object.keys(lane.routing) as Effort[]).filter((k) => typeof lane.routing[k] === "string");
		if (mapped.length <= 1) {
			for (const member of lane.members) models.push(toModel(member));
			continue;
		}
		const thinkingLevelMap: ThinkingLevelMap = {};
		for (const level of ALL_EFFORTS) {
			thinkingLevelMap[level] = lane.routing[level] ?? null;
		}
		const defaultUid =
			lane.defaultUid ??
			EFFORT_PREF.map((level) => lane.routing[level]).find((uid): uid is string => typeof uid === "string") ??
			lane.members[0]?.uid;
		const sample = lane.members.find((m) => m.uid === defaultUid) ?? lane.members[0];
		if (!sample) continue;
		models.push({
			...toModel(sample, { thinkingLevelMap, reasoning: true }),
			id: defaultUid!,
			name: lane.name,
		});
	}

	models.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	return models;
}

export async function fetchDevinCatalog(apiKey: string, signal?: AbortSignal): Promise<Model<"devin-local">[]> {
	const host = (process.env.DEVIN_API_SERVER_URL || DEFAULT_API_SERVER).replace(/\/$/, "");
	const body = encodeMessage(1, buildMetadata({ apiKey: normalizeSessionToken(apiKey), kind: "discovery" }));
	const response = await fetch(`${host}${GET_CLI_MODEL_CONFIGS}`, {
		method: "POST",
		headers: {
			"content-type": "application/proto",
			"connect-protocol-version": "1",
			accept: "*/*",
		},
		body,
		signal,
	});
	const raw = Buffer.from(await response.arrayBuffer());
	if (!response.ok) {
		throw new Error(`GetCliModelConfigs HTTP ${response.status}: ${raw.toString("utf8").slice(0, 240)}`);
	}
	const configs: Buffer[] = [];
	for (const field of iterFields(raw)) {
		if (field.num === 1 && field.wire === 2) {
			const buf = asBuffer(field.value);
			if (buf) configs.push(buf);
		}
	}
	const models = modelsFromConfigs(configs);
	if (models.length === 0) {
		throw new Error("Devin Local catalog was empty. Re-run /login devin.");
	}
	return models;
}

export function resolveModelUid(
	modelId: string,
	thinkingLevelMap: ThinkingLevelMap | undefined,
	reasoning?: string,
): string {
	if (reasoning && thinkingLevelMap) {
		const mapped = thinkingLevelMap[reasoning as keyof ThinkingLevelMap];
		if (typeof mapped === "string") return mapped;
	}
	if (thinkingLevelMap) {
		for (const level of EFFORT_PREF) {
			const mapped = thinkingLevelMap[level];
			if (typeof mapped === "string") return mapped;
		}
	}
	return modelId;
}
