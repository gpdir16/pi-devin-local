import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	encodeMessage,
	encodePackedVarints,
	encodeString,
	encodeTimestampBody,
	encodeVarintField,
} from "./wire.js";

export const DEFAULT_API_SERVER = "https://server.codeium.com";
export const DEVIN_WEBAPP_URL = "https://app.devin.ai";
export const DEVIN_API_URL = "https://api.devin.ai";
export const SESSION_TOKEN_PREFIX = "devin-session-token$";

const PRODUCT_JSON = "/Applications/Devin.app/Contents/Resources/app/product.json";
const FALLBACK_DESKTOP_VERSION = "3.10.23";

export function desktopVersion(): string {
	try {
		if (!existsSync(PRODUCT_JSON)) return FALLBACK_DESKTOP_VERSION;
		const product = JSON.parse(readFileSync(PRODUCT_JSON, "utf8")) as { windsurfVersion?: string };
		return product.windsurfVersion || FALLBACK_DESKTOP_VERSION;
	} catch {
		return FALLBACK_DESKTOP_VERSION;
	}
}

export function normalizeSessionToken(token: string | undefined): string {
	if (!token) return "";
	const trimmed = token.trim();
	if (!trimmed) return "";
	return trimmed.startsWith(SESSION_TOKEN_PREFIX) ? trimmed : `${SESSION_TOKEN_PREFIX}${trimmed}`;
}

export function readStoredSessionToken(): string | undefined {
	try {
		const path = join(homedir(), ".local/share/devin/credentials.toml");
		if (!existsSync(path)) return undefined;
		const raw: Record<string, string> = {};
		for (const line of readFileSync(path, "utf8").split("\n")) {
			const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"(.*)"\s*$/);
			if (match) raw[match[1]] = match[2];
		}
		const token = raw.windsurf_api_key || raw.api_key;
		return token ? normalizeSessionToken(token) : undefined;
	} catch {
		return undefined;
	}
}

export type MetadataKind = "chat" | "discovery";

export function buildMetadata(opts: {
	apiKey: string;
	userJwt?: string;
	kind: MetadataKind;
	sessionId?: string;
	requestId?: bigint;
	triggerId?: string;
}): Buffer {
	const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
	const ide = opts.kind === "discovery" ? "chisel" : "devin-desktop";
	const version = opts.kind === "discovery" ? "0.0.0-dev" : desktopVersion();
	const sessionId = opts.sessionId ?? crypto.randomUUID();
	const triggerId = opts.triggerId ?? crypto.randomUUID();
	const requestId = opts.requestId ?? BigInt(Date.now());
	const parts: Buffer[] = [
		encodeString(1, ide),
		encodeString(2, version),
		encodeString(3, opts.apiKey),
		encodeString(4, "en"),
		encodeString(5, os),
		encodeString(7, version),
		encodeVarintField(9, requestId),
		encodeString(10, sessionId),
		encodeString(12, ide),
		encodeMessage(16, encodeTimestampBody()),
		encodeString(25, triggerId),
		encodeString(26, "Unset"),
		encodeString(28, ide),
	];
	if (opts.userJwt) parts.push(encodeString(21, opts.userJwt));
	if (opts.kind === "discovery") {
		// MODEL_ROUTER, QUICK_REVIEW, INTERNAL_DEFAULT, UNCLASSIFIED, NORMAL
		parts.push(encodePackedVarints(30, [1, 4, 6, 7, 8]));
	}
	return Buffer.concat(parts);
}
