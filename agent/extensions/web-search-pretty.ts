/**
 * Web Search/Fetch — themed TUI rendering for the local Ollama web tools.
 *
 * Replaces the `@ollama/pi-web-search` package: identical tool names,
 * parameters, and LLM-facing text (numbered results with URL + content), plus:
 *   - renderCall/renderResult — compact themed match list (title + domain +
 *     snippet); ctrl+o expands to fuller content, and web_fetch shows the
 *     link list
 *   - OLLAMA_HOST env support (default http://localhost:11434)
 *   - humanized connection errors
 *
 * Registering web_search/web_fetch here overrides the npm package. The
 * package must STAY in settings.json packages, but in object form with its
 * extension filtered out:
 *   { "source": "npm:@ollama/pi-web-search", "extensions": [] }
 * `ollama launch pi` re-adds the plain "npm:@ollama/pi-web-search" string
 * entry if the package is missing entirely, which causes a duplicate tool
 * registration conflict with this file — so the filtered object form is the
 * only durable configuration.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function ollamaHost(): string {
	const raw = process.env.OLLAMA_HOST?.trim() || "http://localhost:11434";
	return raw.replace(/\/+$/, "");
}

/** Clip a single-line snippet to n chars (collapses whitespace, adds ellipsis). */
function clip(s: string, n: number): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > n ? t.slice(0, Math.max(1, n - 1)).trimEnd() + "…" : t;
}

/** Hostname of a URL, www-stripped; falls back to the raw string. */
function domainOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** POST JSON to the local Ollama web tools API. */
async function ollamaWeb(
	path: string,
	body: Record<string, unknown>,
	signal: AbortSignal | undefined,
): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
	const host = ollamaHost();
	let response: Response;
	try {
		response = await fetch(`${host}/api/experimental/${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});
	} catch (error) {
		if (error instanceof Error && (error.message.includes("ECONNREFUSED") || error.message.includes("fetch failed"))) {
			return { ok: false, error: `Could not connect to Ollama at ${host}. Is it running, with web search/fetch enabled?` };
		}
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	if (!response.ok) {
		if (response.status === 401) {
			return { ok: false, error: "Unauthorized. Run `ollama signin` to authenticate." };
		}
		const errorText = await response.text().catch(() => "");
		return { ok: false, error: `${path} API error (status ${response.status}): ${errorText || response.statusText}` };
	}
	try {
		return { ok: true, data: await response.json() };
	} catch (error) {
		return { ok: false, error: `Ollama returned non-JSON output: ${error instanceof Error ? error.message : String(error)}` };
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// --- web_search ----------------------------------------------------------
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web for real-time information using your local Ollama instance's web_search API. Requires Ollama running locally with web search enabled. Returns numbered results (title, URL, content) with a themed TUI match list; ctrl+o expands to fuller result content.",
		parameters: Type.Object({
			query: Type.String({ description: "The search query to execute" }),
			max_results: Type.Optional(
				Type.Number({ description: "Maximum number of search results to return (default: 5)", default: 5 }),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const maxResults = params.max_results ?? 5;
			const res = await ollamaWeb("web_search", { query: params.query, max_results: maxResults }, signal);
			if (!res.ok) throw new Error(res.error);

			const results: Array<{ title: string; url: string; content: string }> = res.data.results ?? [];
			// Same LLM-facing format as the original package (numbered, URL + content).
			const formatted = results.map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.content}`).join("\n\n");

			return {
				content: [{ type: "text", text: formatted || "No results found." }],
				details: { results, query: params.query },
			};
		},

		renderCall(args, theme, _context) {
			const q = clip(args.query ?? "", 44);
			const k = args.max_results ? theme.fg("dim", ` k=${args.max_results}`) : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("muted", `"${q}"`) + k,
				0,
				0,
			);
		},

		renderResult(result, opts, theme, _context) {
			const details = result.details as
				| { results?: Array<{ title: string; url: string; content: string }>; query?: string }
				| undefined;
			if (opts?.isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);
			const results = details?.results ?? [];
			if (results.length === 0) return new Text(theme.fg("dim", "No results"), 0, 0);

			const expanded = opts?.expanded ?? false;
			const c = new Container();
			for (const r of results) {
				const title = clip(r.title || domainOf(r.url ?? ""), 64);
				const domain = theme.fg("dim", domainOf(r.url ?? ""));
				c.addChild(
					new Text(theme.fg("success", "◉ ") + theme.fg("accent", theme.bold(title)) + "  " + domain, 0, 0),
				);
				const snippet = clip(r.content ?? "", expanded ? 500 : 110);
				c.addChild(new Text(`   ${theme.fg("muted", snippet)}`, 0, 0));
			}
			if (!expanded) {
				c.addChild(new Text(theme.fg("dim", ` (${results.length} result(s) · ctrl+o for fuller content)`), 0, 0));
			}
			return c;
		},
	});

	// --- web_fetch -----------------------------------------------------------
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch and extract text content from a web page URL using your local Ollama instance's web_fetch API. Requires Ollama running locally with web fetch enabled. Returns title, extracted content, and discovered links; the TUI shows a themed page card (ctrl+o for more content and the link list).",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch and extract text content from" }),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const res = await ollamaWeb("web_fetch", { url: params.url }, signal);
			if (!res.ok) throw new Error(res.error);

			const data = res.data as { title?: string; content?: string; links?: string[] };
			const formatted = [
				`Title: ${data.title ?? "—"}`,
				"",
				"Content:",
				data.content ?? "",
				"",
				`Links found: ${data.links?.length ?? 0}`,
				...(data.links?.slice(0, 10).map((l) => `  - ${l}`) ?? []),
			].join("\n");

			return {
				content: [{ type: "text", text: formatted }],
				details: { title: data.title, content: data.content, links: data.links, url: params.url },
			};
		},

		renderCall(args, theme, _context) {
			return new Text(
				theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("accent", truncateToWidth(args.url ?? "", 64, "…")),
				0,
				0,
			);
		},

		renderResult(result, opts, theme, _context) {
			const details = result.details as
				| { title?: string; content?: string; links?: string[]; url?: string }
				| undefined;
			if (opts?.isPartial) return new Text(theme.fg("warning", "Fetching…"), 0, 0);
			if (!details || (details.content === undefined && !details.title)) {
				return new Text(theme.fg("dim", "No content"), 0, 0);
			}

			const expanded = opts?.expanded ?? false;
			const c = new Container();
			const title = clip(details.title || details.url || "untitled", 70);
			const bytes = new TextEncoder().encode(details.content ?? "").length;
			const linkCount = details.links?.length ?? 0;
			c.addChild(
				new Text(
					theme.fg("success", "◉ ") +
						theme.fg("accent", theme.bold(title)) +
						"  " +
						theme.fg("dim", `${formatBytes(bytes)}${linkCount > 0 ? ` · ${linkCount} links` : ""}`),
					0,
					0,
				),
			);
			if (details.url) c.addChild(new Text(theme.fg("dim", `   ${truncateToWidth(details.url, 90, "…")}`), 0, 0));

			const body = clip(details.content ?? "", expanded ? 2000 : 160);
			c.addChild(new Text(theme.fg("muted", body), 0, 0));

			if (expanded && linkCount > 0) {
				c.addChild(new Text(theme.fg("muted", `links (${linkCount}):`), 0, 0));
				for (const link of details.links!.slice(0, 15)) {
					c.addChild(new Text(theme.fg("dim", `   - ${truncateToWidth(link, 90, "…")}`), 0, 0));
				}
			}
			if (!expanded && (bytes > 160 || linkCount > 0)) {
				c.addChild(new Text(theme.fg("dim", " (ctrl+o for more content + links)"), 0, 0));
			}
			return c;
		},
	});
}