import {
	createProvider,
	type AuthContext,
	type AuthResult,
	type Credential,
	type OAuthCredential,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchDevinCatalog } from "./catalog.js";
import { DEFAULT_API_SERVER, normalizeSessionToken, readStoredSessionToken } from "./metadata.js";
import { loginDevin, refreshDevin } from "./oauth.js";
import { streamDevin } from "./stream.js";

const PROVIDER_ID = "devin";

function tokenFromCredential(credential?: Credential): string | undefined {
	if (!credential) return undefined;
	if (credential.type === "oauth") return normalizeSessionToken(credential.access);
	if (credential.type === "api_key") return normalizeSessionToken(credential.key);
	return undefined;
}

function ambientToken(): string | undefined {
	return (
		normalizeSessionToken(process.env.DEVIN_API_KEY) ||
		normalizeSessionToken(process.env.WINDSURF_API_KEY) ||
		normalizeSessionToken(process.env.DEVIN_SESSION_TOKEN) ||
		readStoredSessionToken()
	);
}

async function resolveApiKey(input: {
	ctx: AuthContext;
	credential?: Credential;
}): Promise<AuthResult | undefined> {
	const stored = tokenFromCredential(input.credential);
	if (stored) return { auth: { apiKey: stored, baseUrl: DEFAULT_API_SERVER }, source: "OAuth" };
	const envToken =
		(await input.ctx.env("DEVIN_API_KEY")) ||
		(await input.ctx.env("WINDSURF_API_KEY")) ||
		(await input.ctx.env("DEVIN_SESSION_TOKEN"));
	if (envToken) {
		return {
			auth: { apiKey: normalizeSessionToken(envToken), baseUrl: DEFAULT_API_SERVER },
			source: "DEVIN_API_KEY",
		};
	}
	const fileToken = readStoredSessionToken();
	if (!fileToken) return undefined;
	return { auth: { apiKey: fileToken, baseUrl: DEFAULT_API_SERVER }, source: "Devin credentials" };
}

export default async function (pi: ExtensionAPI) {
	// No blocking catalog fetch here: createProvider's refreshModels restores the
	// persisted models-store synchronously at startup (allowNetwork:false) and the
	// host's standard post-init refresh calls fetchModels when network is allowed.
	pi.registerProvider(
		createProvider({
			id: PROVIDER_ID,
			name: "Devin Local",
			baseUrl: DEFAULT_API_SERVER,
			auth: {
				oauth: {
					name: "Devin Local",
					isSubscription: true,
					loginLabel: "Sign in with Devin",
					login: loginDevin,
					refresh: refreshDevin,
					async toAuth(credential: OAuthCredential) {
						return {
							apiKey: normalizeSessionToken(credential.access),
							baseUrl: DEFAULT_API_SERVER,
						};
					},
				},
				apiKey: {
					name: "Devin session token",
					async login(interaction) {
						const key = await interaction.prompt({
							type: "secret",
							message: "Paste Devin session token:",
						});
						return { type: "api_key", key: normalizeSessionToken(key) };
					},
					async resolve({ ctx, credential }) {
						return resolveApiKey({ ctx, credential });
					},
				},
			},
			models: [],
			fetchModels: async (context) => {
				const apiKey = tokenFromCredential(context.credential) || ambientToken();
				if (!apiKey) throw new Error("No Devin credentials. Run /login devin.");
				return fetchDevinCatalog(apiKey, context.signal);
			},
			api: {
				stream: streamDevin,
				streamSimple: streamDevin,
			},
		}),
	);
}
