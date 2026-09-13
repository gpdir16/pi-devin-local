import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AuthInteraction, OAuthCredential } from "@earendil-works/pi-ai";
import { DEFAULT_API_SERVER, DEVIN_API_URL, DEVIN_WEBAPP_URL, normalizeSessionToken } from "./metadata.js";
import { asString, encodeString, iterFields } from "./wire.js";

const PREFERRED_PORT = 59653;
const FALLBACK_EXPIRES_MS = 365 * 24 * 60 * 60 * 1000;

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	const verifier = Buffer.from(array).toString("base64url");
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	const challenge = Buffer.from(hash).toString("base64url");
	return { verifier, challenge };
}

function tokenExpiry(token: string): number {
	try {
		const payload = token.split(".")[1];
		if (!payload) return Date.now() + FALLBACK_EXPIRES_MS;
		const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
		if (typeof decoded.exp === "number") return decoded.exp * 1000 - 5 * 60 * 1000;
	} catch {
		// non-JWT
	}
	return Date.now() + FALLBACK_EXPIRES_MS;
}

function extractCode(input: string): string {
	const trimmed = input.trim();
	try {
		const url = new URL(trimmed);
		return url.searchParams.get("code") || url.searchParams.get("token") || trimmed;
	} catch {
		return trimmed;
	}
}

function html(body: string): string {
	return `<!doctype html><html><body style="font-family:system-ui;padding:2rem">${body}</body></html>`;
}

function listen(port: number): Promise<ReturnType<typeof createServer>> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve(server));
	});
}

async function bindCallbackServer(): Promise<ReturnType<typeof createServer>> {
	try {
		return await listen(PREFERRED_PORT);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return await listen(0);
		throw error;
	}
}

function boundPort(server: ReturnType<typeof createServer>): number {
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Devin OAuth callback server has no port");
	return address.port;
}

function waitForCode(
	server: ReturnType<typeof createServer>,
	port: number,
	expectedState: string,
	signal: AbortSignal,
): Promise<{ code: string; redirectUri: string }> {
	return new Promise((resolve, reject) => {
		const redirectUri = `http://127.0.0.1:${port}/callback`;
		const cleanup = () => {
			signal.removeEventListener("abort", onAbort);
			server.close();
		};
		const onAbort = () => {
			cleanup();
			reject(signal.reason instanceof Error ? signal.reason : new Error("Login cancelled"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		server.on("request", (req: IncomingMessage, res: ServerResponse) => {
			try {
				const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
				if (url.pathname !== "/callback") {
					res.writeHead(404).end("Not found");
					return;
				}
				const error = url.searchParams.get("error");
				if (error) {
					res.writeHead(400, { "Content-Type": "text/html" }).end(html(`<p>Login failed: ${error}</p>`));
					cleanup();
					reject(new Error(`Devin OAuth error: ${error}`));
					return;
				}
				const state = url.searchParams.get("state");
				const code = url.searchParams.get("code");
				if (state !== expectedState || !code) {
					res.writeHead(400, { "Content-Type": "text/html" }).end(html("<p>Invalid OAuth callback.</p>"));
					cleanup();
					reject(new Error("Devin OAuth callback missing code or state"));
					return;
				}
				res.writeHead(200, { "Content-Type": "text/html" }).end(
					html("<p>Devin login complete. You can close this tab and return to pi.</p>"),
				);
				cleanup();
				resolve({ code, redirectUri });
			} catch (error) {
				cleanup();
				reject(error);
			}
		});
	});
}

async function exchangeHttp(code: string, verifier: string, signal: AbortSignal): Promise<string | null> {
	const response = await fetch(`${DEVIN_API_URL}/auth/cli/token`, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({ code, code_verifier: verifier }),
		signal,
	});
	if (!response.ok) return null;
	const data = (await response.json()) as { token?: unknown; access_token?: unknown };
	const token = data.token ?? data.access_token;
	return typeof token === "string" && token.length > 0 ? token : null;
}

async function exchangeConnect(code: string, verifier: string, redirectUri: string, signal: AbortSignal): Promise<string | null> {
	const body = Buffer.concat([
		encodeString(1, code),
		encodeString(2, verifier),
		encodeString(3, redirectUri),
	]);
	const response = await fetch(
		`${DEFAULT_API_SERVER}/exa.seat_management_pb.SeatManagementService/ExchangeDevinCLIPKCECode`,
		{
			method: "POST",
			headers: {
				"content-type": "application/proto",
				"connect-protocol-version": "1",
				accept: "*/*",
			},
			body,
			signal,
		},
	);
	const raw = Buffer.from(await response.arrayBuffer());
	if (!response.ok) return null;
	const strings: string[] = [];
	const walk = (buf: Buffer, depth: number) => {
		for (const field of iterFields(buf)) {
			if (field.wire === 2) {
				const text = asString(field.value);
				if (text) strings.push(text);
				else if (Buffer.isBuffer(field.value) && depth < 3) walk(field.value, depth + 1);
			}
		}
	};
	walk(raw, 0);
	return strings.find((s) => s.startsWith("devin-session-token$") || s.length > 40) ?? null;
}

async function exchangeToken(code: string, verifier: string, redirectUri: string, signal: AbortSignal): Promise<string> {
	const httpToken = await exchangeHttp(code, verifier, signal);
	if (httpToken) return httpToken;
	const connectToken = await exchangeConnect(code, verifier, redirectUri, signal);
	if (connectToken) return connectToken;
	throw new Error("Devin PKCE token exchange failed");
}

function credentialFromToken(token: string): OAuthCredential {
	const access = normalizeSessionToken(token);
	return {
		type: "oauth",
		access,
		refresh: access,
		expires: tokenExpiry(token),
	};
}

export async function loginDevin(interaction: AuthInteraction): Promise<OAuthCredential> {
	const signal = interaction.signal ?? new AbortController().signal;
	const method = await interaction.prompt({
		type: "select",
		message: "How do you want to sign in to Devin Local?",
		options: [
			{ id: "browser", label: "Browser OAuth", description: "Open app.devin.ai and return via localhost" },
			{ id: "token", label: "Paste session token", description: "Paste a Devin session token directly" },
		],
	});

	if (method === "token") {
		const pasted = await interaction.prompt({
			type: "secret",
			message: "Paste Devin session token:",
		});
		if (!pasted.trim()) throw new Error("Login cancelled");
		return credentialFromToken(pasted);
	}

	const { verifier, challenge } = await generatePKCE();
	const state = crypto.randomUUID();
	const promptAbort = new AbortController();
	const onParentAbort = () => promptAbort.abort();
	signal.addEventListener("abort", onParentAbort, { once: true });

	const server = await bindCallbackServer();
	const port = boundPort(server);
	const redirectUri = `http://127.0.0.1:${port}/callback`;
	try {
		const callback = waitForCode(server, port, state, promptAbort.signal);
		const params = new URLSearchParams({
			redirect_uri: redirectUri,
			state,
			prompt: "select_account",
			code_challenge: challenge,
			code_challenge_method: "S256",
		});
		const url = `${DEVIN_WEBAPP_URL}/auth/cli/continue?${params.toString()}`;
		interaction.notify({
			type: "auth_url",
			url,
			instructions: "Sign in to Devin in your browser. If the callback never returns, paste the redirect URL.",
		});

		const pasted = interaction
			.prompt({
				type: "manual_code",
				message: "Paste the callback URL or authorization code:",
				signal: promptAbort.signal,
			})
			.then((text) => ({ source: "paste" as const, code: extractCode(text), redirectUri }))
			.catch(() => null);

		const raced = await Promise.race([
			callback.then((value) => ({ source: "callback" as const, ...value })),
			pasted,
		]);
		promptAbort.abort();
		server.close();
		if (!raced?.code) throw new Error("Login cancelled");
		interaction.notify({ type: "progress", message: "Exchanging Devin authorization code..." });
		const token = await exchangeToken(raced.code, verifier, raced.redirectUri, signal);
		return credentialFromToken(token);
	} finally {
		signal.removeEventListener("abort", onParentAbort);
		if (!promptAbort.signal.aborted) promptAbort.abort();
		server.close();
	}
}

export async function refreshDevin(credential: OAuthCredential, _signal: AbortSignal): Promise<OAuthCredential> {
	if (!credential.access) throw new Error("Devin credential is empty. Run /login devin.");
	return {
		...credential,
		access: normalizeSessionToken(credential.access),
		refresh: normalizeSessionToken(credential.refresh || credential.access),
		expires: Math.max(credential.expires || 0, Date.now() + FALLBACK_EXPIRES_MS),
	};
}
