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
	const token = ambientToken();
	let initialModels: Awaited<ReturnType<typeof fetchDevinCatalog>> = [];
	if (token) {
		try {
			initialModels = await fetchDevinCatalog(token);
		} catch {
			initialModels = [];
		}
	}

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
			models: initialModels,
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

	pi.registerCommand("devin-refresh", {
		description: "Refresh the Devin Local model catalog",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Refreshing Devin Local models\u2026", "info");
			try {
				const result = await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], force: true });
				const error = result.errors.get(PROVIDER_ID);
				if (error) throw error;
				const count = ctx.modelRegistry.getAll().filter((model) => model.provider === PROVIDER_ID).length;
				ctx.ui.notify(`Devin Local: loaded ${count} models from the live catalog.`, "info");
			} catch (error) {
				ctx.ui.notify(`Devin refresh failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
