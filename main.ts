// deno-lint-ignore-file no-explicit-any

// ===== Configuration =====
const PORT = 8000;
const PROXY_PREFIX = "/proxy/";
const TARGET_COOKIE = "__proxy_target_origin";

// Cache TTLs
const DETAIL_CACHE_TTL_MS = 2 * 60 * 1000;       // 2 minutes
const MEDIA_RESOLVE_CACHE_TTL_MS = 30 * 1000;     // 30 seconds
const CACHE_CLEANUP_INTERVAL_MS = 30 * 1000;       // cleanup every 30s

// Limits
const MAX_DETAIL_CACHE_ENTRIES = 500;
const MAX_MEDIA_CACHE_ENTRIES = 1000;
const MAX_CONCURRENT_REQUESTS = 200;
const MAX_REQUESTS_PER_IP_PER_MINUTE = 120;
const UPSTREAM_TIMEOUT_MS = 30_000;                 // 30 seconds for HTML etc.
const UPSTREAM_MEDIA_TIMEOUT_MS = 120_000;          // 120 seconds for media
const MAX_HTML_BODY_CACHE_SIZE = 2 * 1024 * 1024;  // 2 MB max per cached page
const ALLOWED_HOSTS: string[] = [];                 // Empty = allow all. Add hosts to restrict, e.g. ["pyazz.com"]
const BLOCKED_INTERNAL_CIDRS = [
  "127.", "10.", "192.168.", "172.16.", "172.17.", "172.18.", "172.19.",
  "172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.",
  "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.",
  "0.", "169.254.", "::1", "fc00:", "fd00:", "fe80:",
];

// ===== Types =====
type DetailCacheEntry = {
  expiresAt: number;
  status: number;
  headers: [string, string][];
  body: string;
  size: number;
};

type ResolveCacheEntry = {
  expiresAt: number;
  finalUrl: string;
};

// ===== State =====
const detailHtmlCache = new Map<string, DetailCacheEntry>();
const mediaResolveCache = new Map<string, ResolveCacheEntry>();
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
let currentConcurrent = 0;

// ===== Periodic cache cleanup (non-blocking) =====
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of detailHtmlCache) {
    if (v.expiresAt <= now) detailHtmlCache.delete(k);
  }
  for (const [k, v] of mediaResolveCache) {
    if (v.expiresAt <= now) mediaResolveCache.delete(k);
  }
  for (const [k, v] of rateLimitMap) {
    if (v.resetAt <= now) rateLimitMap.delete(k);
  }
}, CACHE_CLEANUP_INTERVAL_MS);

// ===== Server =====
Deno.serve({ port: PORT }, handler);
console.log(`Proxy running on http://localhost:${PORT}`);

// ===== Main Handler =====
async function handler(req: Request): Promise<Response> {
  const reqUrl = new URL(req.url);
  const proxyOrigin = reqUrl.origin;

  // --- CORS preflight ---
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // --- Rate limiting ---
  const clientIp = getClientIp(req);
  if (!checkRateLimit(clientIp)) {
    return new Response(
      errorPage("Rate limit exceeded. Please wait and try again.", ""),
      { status: 429, headers: htmlHeaders() },
    );
  }

  // --- Concurrent connection limit ---
  if (currentConcurrent >= MAX_CONCURRENT_REQUESTS) {
    return new Response(
      errorPage("Server is busy. Please try again in a moment.", ""),
      { status: 503, headers: htmlHeaders() },
    );
  }

  // --- Home page ---
  if (reqUrl.pathname === "/" && !reqUrl.searchParams.has("url")) {
    return new Response(homePage(), { status: 200, headers: htmlHeaders() });
  }

  // --- Extract target URL ---
  let target = extractTargetUrl(req, reqUrl);
  if (!target) {
    return new Response("URL not found", { status: 400, headers: textHeaders() });
  }

  target = extractRealTargetFromProxyUrl(target, proxyOrigin, PROXY_PREFIX);

  if (!/^https?:\/\//i.test(target)) {
    target = "https://" + target;
  }

  // --- Validate target ---
  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return new Response(
      errorPage("Invalid URL: " + target, target),
      { status: 400, headers: htmlHeaders() },
    );
  }

  // Block self-proxy loop
  if (targetUrl.origin === proxyOrigin) {
    return new Response(
      errorPage("Blocked self-proxy loop. The target URL points back to this proxy.", target),
      { status: 508, headers: htmlHeaders() },
    );
  }

  // Block internal/private network access (SSRF protection)
  if (isBlockedTarget(targetUrl)) {
    return new Response(
      errorPage("Access to internal networks is not allowed.", target),
      { status: 403, headers: htmlHeaders() },
    );
  }

  // Host allowlist (if configured)
  if (ALLOWED_HOSTS.length > 0 && !isAllowedHost(targetUrl.hostname)) {
    return new Response(
      errorPage("This host is not in the allowed list.", target),
      { status: 403, headers: htmlHeaders() },
    );
  }

  currentConcurrent++;
  try {
    return await proxyRequest(req, reqUrl, targetUrl, proxyOrigin);
  } catch (err) {
    console.error("Proxy Error:", err);
    return new Response(
      errorPage(String((err as Error)?.message || err), target),
      { status: 500, headers: htmlHeaders() },
    );
  } finally {
    currentConcurrent--;
  }
}

// ===== Core Proxy Logic =====
async function proxyRequest(
  req: Request,
  _reqUrl: URL,
  targetUrl: URL,
  proxyOrigin: string,
): Promise<Response> {
  const cookieOrigin = getCookie(req, TARGET_COOKIE) || targetUrl.origin;
  const isMedia = looksLikeMediaRequest(targetUrl, req);

  // --- HTML detail cache (GET only, non-media) ---
  if (req.method === "GET" && !isMedia && isDetailLikePage(targetUrl)) {
    const cacheKey = makeDetailCacheKey(targetUrl.href, cookieOrigin);
    const cached = detailHtmlCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      const h = new Headers(cached.headers);
      h.set("content-type", "text/html; charset=utf-8");
      h.set("x-proxy-cache", "HIT");
      h.append(
        "set-cookie",
        `${TARGET_COOKIE}=${encodeURIComponent(cookieOrigin)}; Path=/; SameSite=Lax`,
      );
      return new Response(cached.body, { status: cached.status, headers: h });
    }
  }

  // --- Media resolve cache ---
  let effectiveTargetUrl = targetUrl;
  if (req.method === "GET" && isMedia) {
    const resolveKey = makeResolveCacheKey(targetUrl.href, cookieOrigin);
    const cachedResolve = mediaResolveCache.get(resolveKey);
    if (cachedResolve && cachedResolve.expiresAt > Date.now()) {
      try {
        effectiveTargetUrl = new URL(cachedResolve.finalUrl);
      } catch { /* ignore */ }
    }
  }

  const upstreamHeaders = buildUpstreamHeaders(req, effectiveTargetUrl);
  const effectiveIsMedia = looksLikeMediaRequest(effectiveTargetUrl, req);

  // --- Build fetch init ---
  const controller = new AbortController();
  const timeoutMs = effectiveIsMedia ? UPSTREAM_MEDIA_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const init: RequestInit = {
    method: req.method,
    headers: upstreamHeaders,
    redirect: effectiveIsMedia ? "follow" : "manual",
    signal: controller.signal,
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    // @ts-ignore Deno supports duplex
    init.duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await fetch(effectiveTargetUrl.href, init);
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === "AbortError") {
      return new Response(
        errorPage("Upstream request timed out.", effectiveTargetUrl.href),
        { status: 504, headers: htmlHeaders() },
      );
    }
    throw err;
  }
  clearTimeout(timer);

  // Save final media resolved URL
  if (req.method === "GET" && effectiveIsMedia) {
    const resolveKey = makeResolveCacheKey(targetUrl.href, cookieOrigin);
    mediaResolveCache.set(resolveKey, {
      expiresAt: Date.now() + MEDIA_RESOLVE_CACHE_TTL_MS,
      finalUrl: upstream.url || effectiveTargetUrl.href,
    });
    evictIfNeeded(mediaResolveCache, MAX_MEDIA_CACHE_ENTRIES);
  }

  const contentType = upstream.headers.get("content-type") || "";
  const outHeaders = buildResponseHeaders(upstream, proxyOrigin);

  // --- Redirect handling (non-media) ---
  if (!effectiveIsMedia && [301, 302, 303, 307, 308].includes(upstream.status)) {
    const loc = upstream.headers.get("location");
    if (loc) {
      const abs = new URL(loc, effectiveTargetUrl.href).href;
      outHeaders.set("location", proxyOrigin + PROXY_PREFIX + abs);
    }
    outHeaders.append(
      "set-cookie",
      `${TARGET_COOKIE}=${encodeURIComponent(cookieOrigin)}; Path=/; SameSite=Lax`,
    );
    return new Response(null, { status: upstream.status, headers: outHeaders });
  }

  // --- HTML ---
  if (contentType.includes("text/html")) {
    let html = await upstream.text();
    html = rewriteHtml(
      html,
      effectiveTargetUrl.href,
      proxyOrigin + PROXY_PREFIX,
      cookieOrigin,
    );

    outHeaders.delete("content-length");
    outHeaders.delete("content-encoding");
    outHeaders.set("content-type", "text/html; charset=utf-8");
    outHeaders.append(
      "set-cookie",
      `${TARGET_COOKIE}=${encodeURIComponent(cookieOrigin)}; Path=/; SameSite=Lax`,
    );
    outHeaders.set("x-proxy-cache", "MISS");

    // Cache detail-like pages
    if (
      req.method === "GET" &&
      !effectiveIsMedia &&
      isDetailLikePage(effectiveTargetUrl) &&
      html.length <= MAX_HTML_BODY_CACHE_SIZE
    ) {
      const cacheKey = makeDetailCacheKey(effectiveTargetUrl.href, cookieOrigin);
      detailHtmlCache.set(cacheKey, {
        expiresAt: Date.now() + DETAIL_CACHE_TTL_MS,
        status: upstream.status,
        headers: [...outHeaders.entries()],
        body: html,
        size: html.length,
      });
      evictIfNeeded(detailHtmlCache, MAX_DETAIL_CACHE_ENTRIES);
    }

    return new Response(html, { status: upstream.status, headers: outHeaders });
  }

  // --- CSS ---
  if (contentType.includes("text/css")) {
    let css = await upstream.text();
    css = rewriteCss(css, effectiveTargetUrl.href, proxyOrigin + PROXY_PREFIX);

    outHeaders.delete("content-length");
    outHeaders.delete("content-encoding");
    outHeaders.set("content-type", "text/css; charset=utf-8");

    return new Response(css, { status: upstream.status, headers: outHeaders });
  }

  // --- JavaScript ---
  if (
    contentType.includes("javascript") ||
    contentType.includes("application/javascript") ||
    contentType.includes("text/javascript") ||
    contentType.includes("application/x-javascript")
  ) {
    outHeaders.append(
      "set-cookie",
      `${TARGET_COOKIE}=${encodeURIComponent(cookieOrigin)}; Path=/; SameSite=Lax`,
    );
    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  }

  // --- JSON ---
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    const txt = await upstream.text();
    outHeaders.delete("content-length");
    outHeaders.delete("content-encoding");
    outHeaders.append(
      "set-cookie",
      `${TARGET_COOKIE}=${encodeURIComponent(cookieOrigin)}; Path=/; SameSite=Lax`,
    );
    return new Response(txt, { status: upstream.status, headers: outHeaders });
  }

  // --- Media / Binary streaming (pass-through with backpressure) ---
  outHeaders.append(
    "set-cookie",
    `${TARGET_COOKIE}=${encodeURIComponent(cookieOrigin)}; Path=/; SameSite=Lax`,
  );

  // For media, stream the body directly — no buffering
  if (effectiveIsMedia && upstream.body) {
    // Ensure we pass content-range and accept-ranges for resumable downloads
    const contentRange = upstream.headers.get("content-range");
    if (contentRange) outHeaders.set("content-range", contentRange);
    const acceptRanges = upstream.headers.get("accept-ranges");
    if (acceptRanges) outHeaders.set("accept-ranges", acceptRanges);
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) outHeaders.set("content-length", contentLength);

    // Optionally add content-disposition for download
    if (!outHeaders.has("content-disposition")) {
      const filename = guessFilename(effectiveTargetUrl);
      if (filename) {
        // Don't force download — let browser decide based on context
        outHeaders.set("content-disposition", `inline; filename="${filename}"`);
      }
    }

    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  }

  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

// ================= Rate Limiting =================

function getClientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    req.headers.get("cf-connecting-ip") ||
    "unknown"
  );
}

function checkRateLimit(ip: string): boolean {
  if (MAX_REQUESTS_PER_IP_PER_MINUTE <= 0) return true;

  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || entry.resetAt <= now) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }

  entry.count++;
  return entry.count <= MAX_REQUESTS_PER_IP_PER_MINUTE;
}

// ================= Security Helpers =================

function isBlockedTarget(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host === "localhost") return true;

  for (const cidr of BLOCKED_INTERNAL_CIDRS) {
    if (host.startsWith(cidr) || host === cidr) return true;
  }

  return false;
}

function isAllowedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  for (const allowed of ALLOWED_HOSTS) {
    if (h === allowed || h.endsWith("." + allowed)) return true;
  }
  return false;
}

// ================= Cache helpers =================

function evictIfNeeded<T>(cache: Map<string, T>, maxEntries: number): void {
  if (cache.size <= maxEntries) return;

  // Evict oldest entries (first inserted — Map insertion order)
  const toDelete = cache.size - maxEntries;
  let deleted = 0;
  for (const key of cache.keys()) {
    if (deleted >= toDelete) break;
    cache.delete(key);
    deleted++;
  }
}

function makeDetailCacheKey(url: string, origin: string): string {
  return `${origin}::detail::${url}`;
}

function makeResolveCacheKey(url: string, origin: string): string {
  return `${origin}::media::${url}`;
}

function isDetailLikePage(url: URL): boolean {
  const p = url.pathname.toLowerCase();
  return (
    /^\/video\/[a-z0-9-]+(?:\/)?$/i.test(url.pathname) ||
    p === "/" ||
    p.startsWith("/movies") ||
    p.startsWith("/search")
  );
}

// ================= URL extraction =================

function extractTargetUrl(req: Request, url: URL): string {
  if (url.pathname.startsWith(PROXY_PREFIX)) {
    const idx = req.url.indexOf(PROXY_PREFIX);
    if (idx !== -1) {
      return req.url.substring(idx + PROXY_PREFIX.length);
    }
  }

  if (url.searchParams.has("url")) {
    return url.searchParams.get("url") || "";
  }

  if (url.pathname !== "/") {
    const refererOrigin = inferOriginFromReferer(req);
    if (refererOrigin) {
      return refererOrigin + url.pathname + url.search;
    }

    const cookieOrigin = getCookie(req, TARGET_COOKIE);
    if (cookieOrigin && /^https?:\/\//i.test(cookieOrigin)) {
      return cookieOrigin + url.pathname + url.search;
    }
  }

  return "";
}

function inferOriginFromReferer(req: Request): string {
  const referer = req.headers.get("referer") || req.headers.get("referrer") || "";
  if (!referer) return "";

  try {
    const idx = referer.indexOf(PROXY_PREFIX);
    if (idx === -1) return "";

    let after = referer.substring(idx + PROXY_PREFIX.length);
    const hashIdx = after.indexOf("#");
    if (hashIdx !== -1) after = after.slice(0, hashIdx);

    try {
      return new URL(after).origin;
    } catch {
      const m = after.match(/^https?:\/\/[^/]+/i);
      return m ? m[0] : "";
    }
  } catch {
    return "";
  }
}

function getCookie(req: Request, name: string): string {
  const cookie = req.headers.get("cookie") || "";
  const parts = cookie.split(";");

  for (const part of parts) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) {
      return decodeURIComponent(rest.join("=") || "");
    }
  }

  return "";
}

function normalizeProxyTarget(
  input: string,
  proxyOrigin: string,
  proxyPrefix: string,
): string {
  let out = input.trim();

  for (let i = 0; i < 10; i++) {
    let changed = false;

    try {
      const dec = decodeURIComponent(out);
      if (dec !== out) {
        out = dec;
        changed = true;
      }
    } catch { /* ignore */ }

    const fullPrefix = proxyOrigin + proxyPrefix;

    if (out.startsWith(fullPrefix)) {
      out = out.slice(fullPrefix.length);
      changed = true;
    }

    if (out.startsWith(proxyPrefix)) {
      out = out.slice(proxyPrefix.length);
      changed = true;
    }

    if (!changed) break;
  }

  return out;
}

function extractRealTargetFromProxyUrl(
  possibleProxyUrl: string,
  proxyOrigin: string,
  proxyPrefix: string,
): string {
  let out = possibleProxyUrl;

  for (let i = 0; i < 10; i++) {
    out = normalizeProxyTarget(out, proxyOrigin, proxyPrefix);

    if (!out.startsWith("http://") && !out.startsWith("https://")) break;

    try {
      const u = new URL(out);
      if (u.origin === proxyOrigin && u.pathname.startsWith(proxyPrefix)) {
        out = u.pathname.slice(proxyPrefix.length) + u.search + u.hash;
        continue;
      }
    } catch {
      break;
    }

    break;
  }

  return out;
}

// ================= Request / Response Headers =================

function looksLikeMediaRequest(url: URL, req: Request): boolean {
  const path = url.pathname.toLowerCase();
  const host = url.hostname.toLowerCase();
  const accept = (req.headers.get("accept") || "").toLowerCase();

  return (
    path.endsWith(".mp4") ||
    path.endsWith(".m3u8") ||
    path.endsWith(".mkv") ||
    path.endsWith(".webm") ||
    path.endsWith(".ts") ||
    path.endsWith(".avi") ||
    path.endsWith(".flv") ||
    path.endsWith(".mov") ||
    path.endsWith(".m4v") ||
    path.endsWith(".mp3") ||
    path.endsWith(".aac") ||
    path.endsWith(".m4a") ||
    path.includes("/d/") ||
    host.includes("r2.dev") ||
    host.includes("railway.app") ||
    accept.includes("video/") ||
    accept.includes("audio/") ||
    accept.includes("application/octet-stream")
  );
}

function guessFilename(url: URL): string {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "";
  const last = segments[segments.length - 1];
  // Return if it looks like a filename with extension
  if (/\.\w{2,5}$/.test(last)) return last;
  return "";
}

function buildUpstreamHeaders(req: Request, targetUrl: URL): Headers {
  const h = new Headers();

  h.set(
    "user-agent",
    req.headers.get("user-agent") ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  );
  h.set("accept", req.headers.get("accept") || "*/*");
  h.set("accept-language", req.headers.get("accept-language") || "en-US,en;q=0.9");

  // Allow gzip/br for non-media to save bandwidth; identity for media (for Range support)
  const isMedia = looksLikeMediaRequest(targetUrl, { headers: { get: () => null } } as any);
  h.set("accept-encoding", isMedia ? "identity" : "gzip, deflate, br");

  const cookieOrigin = getCookie(req, TARGET_COOKIE) || "";
  const refererBase = /^https?:\/\//i.test(cookieOrigin)
    ? cookieOrigin
    : targetUrl.origin;

  h.set("referer", refererBase + "/");
  h.set("origin", refererBase);

  const passHeaders = [
    "content-type",
    "range",
    "if-none-match",
    "if-modified-since",
    "if-range",
    "authorization",
    "x-requested-with",
    "cache-control",
    "pragma",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-fetch-user",
  ];

  for (const name of passHeaders) {
    const value = req.headers.get(name);
    if (value) h.set(name, value);
  }

  // Don't forward the proxy's own cookies to upstream
  // Parse upstream cookies only (exclude proxy cookies)
  const cookie = req.headers.get("cookie");
  if (cookie) {
    const filtered = cookie
      .split(";")
      .map((c) => c.trim())
      .filter((c) => !c.startsWith(TARGET_COOKIE + "="))
      .join("; ");
    if (filtered) h.set("cookie", filtered);
  }

  return h;
}

function buildResponseHeaders(res: Response, proxyOrigin: string): Headers {
  const h = new Headers();

  const copy = [
    "content-type",
    "content-disposition",
    "cache-control",
    "etag",
    "last-modified",
    "content-range",
    "accept-ranges",
    "content-length",
    "vary",
    "expires",
    "pragma",
    "location",
    "content-encoding",
  ];

  for (const key of copy) {
    const value = res.headers.get(key);
    if (value) h.set(key, value);
  }

  // Forward upstream set-cookie
  try {
    const setCookies = (res.headers as any).getSetCookie?.() || [];
    for (const sc of setCookies) h.append("set-cookie", sc);
  } catch {
    const sc = res.headers.get("set-cookie");
    if (sc) h.set("set-cookie", sc);
  }

  // Rewrite location header
  const loc = h.get("location");
  if (loc) {
    try {
      const abs = new URL(loc).href;
      h.set("location", proxyOrigin + PROXY_PREFIX + abs);
    } catch { /* ignore relative locations — they'll be handled by redirect logic */ }
  }

  // CORS headers
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD");
  h.set("access-control-allow-headers", "*");
  h.set("access-control-expose-headers", "*");

  // Remove restrictive security headers
  h.delete("content-security-policy");
  h.delete("content-security-policy-report-only");
  h.delete("x-frame-options");
  h.delete("strict-transport-security");
  h.delete("cross-origin-opener-policy");
  h.delete("cross-origin-resource-policy");
  h.delete("cross-origin-embedder-policy");
  h.delete("x-content-type-options");

  return h;
}

// ================= Rewrite =================

function rewriteHtml(
  html: string,
  baseUrl: string,
  proxyBase: string,
  targetOrigin: string,
): string {
  html = html.replace(/<base\s[^>]*>/gi, "");
  html = html.replace(/\s+integrity\s*=\s*["'][^"']*["']/gi, "");
  html = html.replace(/\s+nonce\s*=\s*["'][^"']*["']/gi, "");
  html = html.replace(/\s+crossorigin(?:\s*=\s*["'][^"']*["'])?/gi, "");
  html = html.replace(
    /<meta\s+http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi,
    "",
  );

  // Rewrite src, href, action, poster attributes
  html = html.replace(
    /((?:href|src|action|poster)\s*=\s*)(["'])([^"']*?)\2/gi,
    (_m, prefix, quote, value) => {
      if (!shouldProxy(value) || isAlreadyProxied(value, proxyBase)) {
        return `${prefix}${quote}${value}${quote}`;
      }
      const abs = toAbs(value, baseUrl);
      return abs
        ? `${prefix}${quote}${proxyBase}${abs}${quote}`
        : `${prefix}${quote}${value}${quote}`;
    },
  );

  // Rewrite srcset
  html = html.replace(
    /(srcset\s*=\s*)(["'])([^"']*?)\2/gi,
    (_m, prefix, quote, val) => {
      const parts = val.split(",").map((p: string) => {
        const t = p.trim();
        if (!t) return t;

        const i = t.search(/\s/);
        const url = i === -1 ? t : t.slice(0, i);
        const desc = i === -1 ? "" : t.slice(i);

        if (!shouldProxy(url) || isAlreadyProxied(url, proxyBase)) return t;

        const abs = toAbs(url, baseUrl);
        return abs ? `${proxyBase}${abs}${desc}` : t;
      });

      return `${prefix}${quote}${parts.join(", ")}${quote}`;
    },
  );

  // Rewrite inline styles
  html = html.replace(
    /(style\s*=\s*)(["'])([^"']*?)\2/gi,
    (_m, prefix, quote, val) => {
      return `${prefix}${quote}${rewriteCssUrls(val, baseUrl, proxyBase)}${quote}`;
    },
  );

  // Rewrite <style> blocks
  html = html.replace(
    /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_m, open, css, close) => {
      return open + rewriteCss(css, baseUrl, proxyBase) + close;
    },
  );

  // Inject client-side script
  const injected = injectedScript(proxyBase, targetOrigin, baseUrl);
  const headOpen = html.match(/<head[^>]*>/i);
  if (headOpen) {
    const idx = html.indexOf(headOpen[0]) + headOpen[0].length;
    html = html.slice(0, idx) + injected + html.slice(idx);
  } else {
    html = injected + html;
  }

  return html;
}

function rewriteCss(css: string, baseUrl: string, proxyBase: string): string {
  css = rewriteCssUrls(css, baseUrl, proxyBase);

  css = css.replace(/@import\s+["']([^"']+)["']/gi, (m, link) => {
    if (!shouldProxy(link) || isAlreadyProxied(link, proxyBase)) return m;
    const abs = toAbs(link, baseUrl);
    return abs ? `@import "${proxyBase}${abs}"` : m;
  });

  css = css.replace(
    /@import\s+url\(\s*["']?([^"')]+)["']?\s*\)/gi,
    (m, link) => {
      if (!shouldProxy(link) || isAlreadyProxied(link, proxyBase)) return m;
      const abs = toAbs(link, baseUrl);
      return abs ? `@import url("${proxyBase}${abs}")` : m;
    },
  );

  return css;
}

function rewriteCssUrls(css: string, baseUrl: string, proxyBase: string): string {
  return css.replace(/url\(\s*["']?([^"')]+?)["']?\s*\)/gi, (_m, link) => {
    if (!shouldProxy(link) || isAlreadyProxied(link, proxyBase)) {
      return `url("${link}")`;
    }
    const abs = toAbs(link, baseUrl);
    return abs ? `url("${proxyBase}${abs}")` : `url("${link}")`;
  });
}

function shouldProxy(value: string): boolean {
  if (!value) return false;
  return !/^(javascript:|data:|blob:|#|about:|mailto:|tel:)/i.test(value.trim());
}

function isAlreadyProxied(value: string, proxyBase: string): boolean {
  return value.startsWith(proxyBase) || value.includes("/proxy/http");
}

function toAbs(value: string, baseUrl: string): string | null {
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return null;
  }
}

// ================= Injected Script =================

function injectedScript(
  proxyBase: string,
  targetOrigin: string,
  currentPageUrl: string,
): string {
  return `<script>
(function(){
'use strict';

var PROXY_BASE = ${JSON.stringify(proxyBase)};
var TARGET_ORIGIN = ${JSON.stringify(targetOrigin)};
var CURRENT_PAGE = ${JSON.stringify(currentPageUrl)};
var TARGET_COOKIE = ${JSON.stringify(TARGET_COOKIE)};

function persistTargetOrigin(){
  try{
    document.cookie = TARGET_COOKIE + "=" + encodeURIComponent(TARGET_ORIGIN) + "; path=/; SameSite=Lax";
  }catch(e){}
}

function currentTargetPage(){
  try{
    var p = location.pathname || '';
    var idx = p.indexOf('/proxy/');
    if(idx !== -1){
      var after = decodeURIComponent(p.substring(idx + 7)) + location.search + location.hash;
      if(/^https?:\\/\\//i.test(after)) return after;
    }
  }catch(e){}
  return CURRENT_PAGE;
}

function isAppRoute(u){
  if(!u || typeof u !== 'string') return false;
  return /^\\/video\\/[a-z0-9-]+(?:[/?#].*)?$/i.test(u.trim());
}

function isMediaLike(u){
  if(!u || typeof u !== 'string') return false;
  u = u.toLowerCase();
  return (
    u.indexOf('/d/') !== -1 ||
    u.indexOf('.mp4') !== -1 ||
    u.indexOf('.m3u8') !== -1 ||
    u.indexOf('.ts') !== -1 ||
    u.indexOf('.mkv') !== -1 ||
    u.indexOf('.webm') !== -1 ||
    u.indexOf('.avi') !== -1 ||
    u.indexOf('.mov') !== -1 ||
    u.indexOf('.mp3') !== -1 ||
    u.indexOf('.aac') !== -1 ||
    u.indexOf('r2.dev') !== -1 ||
    u.indexOf('railway.app') !== -1
  );
}

function toLocalProxyRoute(u){
  try{
    if(typeof u !== 'string') return u;
    if(isAppRoute(u)) return u;

    var parsed = new URL(u, currentTargetPage());
    if(parsed.origin === TARGET_ORIGIN && /^\\/video\\/[a-z0-9-]+(?:[/?#].*)?$/i.test(parsed.pathname + parsed.search + parsed.hash)){
      return parsed.pathname + parsed.search + parsed.hash;
    }
  }catch(e){}
  return null;
}

function proxify(u){
  if(!u || typeof u !== 'string') return u;
  u = u.trim();

  if(/^(javascript:|data:|blob:|#|about:|mailto:|tel:)/i.test(u)) return u;

  var localRoute = toLocalProxyRoute(u);
  if(localRoute) return localRoute;

  if(u.indexOf(PROXY_BASE) === 0) return u;
  if(u.indexOf('/proxy/http') !== -1) return u;

  try{
    var parsedDirect = new URL(u);
    if(parsedDirect.origin === location.origin && parsedDirect.pathname.indexOf('/proxy/') === 0){
      return u;
    }
  }catch(e){}

  try{
    var abs = new URL(u, currentTargetPage()).href;

    if(isMediaLike(abs)){
      return PROXY_BASE + abs;
    }

    try{
      var parsedAbs = new URL(abs);

      if(parsedAbs.origin === TARGET_ORIGIN && /^\\/video\\/[a-z0-9-]+(?:[/?#].*)?$/i.test(parsedAbs.pathname + parsedAbs.search + parsedAbs.hash)){
        return parsedAbs.pathname + parsedAbs.search + parsedAbs.hash;
      }

      if(parsedAbs.origin === location.origin && parsedAbs.pathname.indexOf('/proxy/') === 0){
        return abs;
      }
    }catch(e){}

    return PROXY_BASE + abs;
  }catch(e){
    return u;
  }
}

function rewriteSrcset(v){
  try{
    return String(v).split(',').map(function(part){
      part = part.trim();
      if(!part) return part;
      var idx = part.search(/\\s/);
      var url = idx === -1 ? part : part.substring(0, idx);
      var desc = idx === -1 ? '' : part.substring(idx);
      return proxify(url) + desc;
    }).join(', ');
  }catch(e){
    return v;
  }
}

persistTargetOrigin();

// --- Intercept fetch ---
try{
  var originalFetch = window.fetch;
  window.fetch = function(input, init){
    try{
      if(typeof input === 'string'){
        input = proxify(input);
      }else if(input instanceof URL){
        input = proxify(input.href);
      }else if(input && typeof input === 'object' && input.url){
        input = new Request(proxify(input.url), input);
      }
    }catch(e){}
    persistTargetOrigin();
    return originalFetch.call(this, input, init);
  };
}catch(e){}

// --- Intercept XMLHttpRequest ---
try{
  var originalXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(){
    if(arguments.length >= 2 && typeof arguments[1] === 'string'){
      arguments[1] = proxify(arguments[1]);
    }
    persistTargetOrigin();
    return originalXhrOpen.apply(this, arguments);
  };
}catch(e){}

// --- Intercept WebSocket ---
try{
  var OrigWebSocket = window.WebSocket;
  window.WebSocket = function(url, protocols){
    // Rewrite ws/wss URLs through proxy if needed
    // For now, just allow them as-is since most proxy setups don't handle WS
    return protocols ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
  };
  window.WebSocket.prototype = OrigWebSocket.prototype;
  window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
  window.WebSocket.OPEN = OrigWebSocket.OPEN;
  window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
  window.WebSocket.CLOSED = OrigWebSocket.CLOSED;
}catch(e){}

// --- Intercept history ---
try{
  var pushState = history.pushState;
  var replaceState = history.replaceState;

  history.pushState = function(s,t,u){
    if(u && typeof u === 'string'){
      var localRoute = toLocalProxyRoute(u);
      if(localRoute){
        u = localRoute;
      }else if(u.indexOf(PROXY_BASE) !== 0 && u.indexOf('/proxy/http') === -1){
        u = proxify(u);
      }
    }
    persistTargetOrigin();
    return pushState.call(this, s, t, u);
  };

  history.replaceState = function(s,t,u){
    if(u && typeof u === 'string'){
      var localRoute = toLocalProxyRoute(u);
      if(localRoute){
        u = localRoute;
      }else if(u.indexOf(PROXY_BASE) !== 0 && u.indexOf('/proxy/http') === -1){
        u = proxify(u);
      }
    }
    persistTargetOrigin();
    return replaceState.call(this, s, t, u);
  };
}catch(e){}

// --- Intercept window.open ---
try{
  var winOpen = window.open;
  window.open = function(u,n,f){
    persistTargetOrigin();
    return winOpen.call(this, u ? proxify(u) : u, n, f);
  };
}catch(e){}

// --- Intercept setAttribute ---
try{
  var setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value){
    var n = String(name).toLowerCase();

    if(typeof value === 'string' && value){
      if(n === 'src' || n === 'href' || n === 'action' || n === 'poster'){
        if(value.indexOf(PROXY_BASE) !== 0 && value.indexOf('/proxy/http') === -1){
          value = proxify(value);
        }
      }else if(n === 'srcset'){
        value = rewriteSrcset(value);
      }
    }

    return setAttr.call(this, name, value);
  };
}catch(e){}

// --- Intercept property setters for src/href ---
try{
  ['HTMLImageElement','HTMLScriptElement','HTMLLinkElement','HTMLSourceElement',
   'HTMLVideoElement','HTMLAudioElement','HTMLIFrameElement','HTMLEmbedElement'].forEach(function(ctorName){
    try{
      var proto = window[ctorName] && window[ctorName].prototype;
      if(!proto) return;

      var srcDesc = Object.getOwnPropertyDescriptor(proto, 'src');
      if(srcDesc && srcDesc.set){
        var origSet = srcDesc.set;
        Object.defineProperty(proto, 'src', {
          get: srcDesc.get,
          set: function(v){
            if(typeof v === 'string' && v && v.indexOf(PROXY_BASE) !== 0 && v.indexOf('/proxy/http') === -1){
              v = proxify(v);
            }
            return origSet.call(this, v);
          },
          enumerable: true,
          configurable: true
        });
      }
    }catch(e){}
  });

  // Intercept HTMLAnchorElement.href setter
  try{
    var anchorProto = HTMLAnchorElement.prototype;
    var hrefDesc = Object.getOwnPropertyDescriptor(anchorProto, 'href');
    if(hrefDesc && hrefDesc.set){
      var origHrefSet = hrefDesc.set;
      Object.defineProperty(anchorProto, 'href', {
        get: hrefDesc.get,
        set: function(v){
          if(typeof v === 'string' && v && v.indexOf(PROXY_BASE) !== 0 && v.indexOf('/proxy/http') === -1){
            v = proxify(v);
          }
          return origHrefSet.call(this, v);
        },
        enumerable: true,
        configurable: true
      });
    }
  }catch(e){}
}catch(e){}

// --- Click handler ---
document.addEventListener('click', function(e){
  var el = e.target;
  var limit = 20;

  while(el && el.tagName !== 'A' && limit-- > 0){
    el = el.parentElement;
  }

  if(el && el.tagName === 'A'){
    var href = el.getAttribute('href');
    var target = el.getAttribute('target');

    if(target === '_blank') return;

    if(href && !/^(javascript:|#|data:|blob:|mailto:|tel:)/i.test(href.trim())){
      e.preventDefault();
      e.stopPropagation();
      persistTargetOrigin();

      var localRoute = toLocalProxyRoute(href);
      if(localRoute){
        location.href = localRoute;
        return false;
      }

      if(href.indexOf(PROXY_BASE) === 0 || href.indexOf('/proxy/http') !== -1){
        location.href = href;
        return false;
      }

      location.href = proxify(href);
      return false;
    }
  }
}, true);

// --- Form submit handler ---
document.addEventListener('submit', function(e){
  var f = e.target;
  if(f && f.tagName === 'FORM'){
    var action = f.getAttribute('action') || currentTargetPage();
    if(action.indexOf(PROXY_BASE) !== 0 && action.indexOf('/proxy/http') === -1){
      f.setAttribute('action', proxify(action));
    }
    persistTargetOrigin();
  }
}, true);

// --- MutationObserver ---
function rewriteNode(el){
  if(!el || !el.getAttribute) return;

  ['src','href','action','poster'].forEach(function(attr){
    try{
      var v = el.getAttribute(attr);
      if(v && v.indexOf(PROXY_BASE) !== 0 && v.indexOf('/proxy/http') === -1){
        el.setAttribute(attr, proxify(v));
      }
    }catch(e){}
  });

  try{
    var ss = el.getAttribute('srcset');
    if(ss) el.setAttribute('srcset', rewriteSrcset(ss));
  }catch(e){}
}

function rewriteTree(root){
  if(!root) return;
  rewriteNode(root);
  try{
    var els = root.querySelectorAll('[src],[href],[action],[poster],[srcset]');
    for(var i=0;i<els.length;i++){
      rewriteNode(els[i]);
    }
  }catch(e){}
}

var mo = new MutationObserver(function(muts){
  for(var i=0;i<muts.length;i++){
    var m = muts[i];
    if(m.addedNodes){
      for(var j=0;j<m.addedNodes.length;j++){
        if(m.addedNodes[j].nodeType === 1){
          rewriteTree(m.addedNodes[j]);
        }
      }
    }
    // Also handle attribute changes
    if(m.type === 'attributes' && m.target && m.target.nodeType === 1){
      rewriteNode(m.target);
    }
  }
});

if(document.documentElement){
  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src','href','action','poster','srcset']
  });
}

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', function(){
    persistTargetOrigin();
    rewriteTree(document.documentElement);
  });
}else{
  persistTargetOrigin();
  rewriteTree(document.documentElement);
}

window.addEventListener('load', function(){
  persistTargetOrigin();
  setTimeout(function(){ rewriteTree(document.documentElement); }, 100);
  setTimeout(function(){ rewriteTree(document.documentElement); }, 800);
  setTimeout(function(){ rewriteTree(document.documentElement); }, 2000);
});

// --- Disable Service Worker ---
try{
  Object.defineProperty(navigator, 'serviceWorker', {
    get: function(){
      return {
        register: function(){ return Promise.reject(new Error('SW disabled by proxy')); },
        getRegistrations: function(){ return Promise.resolve([]); },
        getRegistration: function(){ return Promise.resolve(undefined); },
        ready: Promise.resolve({
          unregister: function(){ return Promise.resolve(true); }
        }),
        addEventListener: function(){},
        removeEventListener: function(){}
      };
    },
    configurable: true
  });
}catch(e){}

// --- Intercept createElement to catch dynamic script src ---
try{
  var origCreateElement = document.createElement.bind(document);
  document.createElement = function(tag){
    var el = origCreateElement(tag);
    if(tag.toLowerCase() === 'script' || tag.toLowerCase() === 'link' || tag.toLowerCase() === 'img'){
      // Property will be intercepted by our property setter above
    }
    return el;
  };
}catch(e){}

console.log('[Proxy] Enhanced proxy with streaming & concurrency support active');
})();
<\/script>`;
}

// ================= Basic headers/pages =================

function corsHeaders(): Headers {
  return new Headers({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD",
    "access-control-allow-headers": "*",
    "access-control-expose-headers": "*",
    "access-control-max-age": "86400",
  });
}

function htmlHeaders(): Headers {
  return new Headers({
    "content-type": "text/html; charset=utf-8",
  });
}

function textHeaders(): Headers {
  return new Headers({
    "content-type": "text/plain; charset=utf-8",
  });
}

function homePage(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deno Proxy</title>
<style>
*{box-sizing:border-box}
body{font-family:'Segoe UI',Arial,sans-serif;background:#0f172a;color:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:20px}
.box{width:min(92%,560px);background:#111827;border:1px solid #334155;border-radius:16px;padding:28px;box-shadow:0 8px 32px rgba(0,0,0,.4)}
h1{margin:0 0 8px;font-size:1.6rem}
.subtitle{color:#94a3b8;font-size:.85rem;margin-bottom:16px}
.stats{display:flex;gap:12px;margin-bottom:18px;flex-wrap:wrap}
.stat{background:#1e293b;border-radius:8px;padding:8px 14px;font-size:.8rem;color:#cbd5e1}
.stat b{color:#60a5fa}
p{color:#cbd5e1;margin:0 0 6px;font-size:.95rem}
input{width:100%;padding:14px;border-radius:10px;border:1px solid #475569;background:#0b1220;color:#fff;margin:14px 0;font-size:1rem;outline:none;transition:border .2s}
input:focus{border-color:#2563eb}
button{width:100%;padding:14px;border:none;border-radius:10px;background:#2563eb;color:#fff;font-weight:700;font-size:1rem;cursor:pointer;transition:background .2s}
button:hover{background:#1d4ed8}
small{display:block;margin-top:12px;color:#64748b}
.features{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:16px}
.feat{background:#1e293b;border-radius:8px;padding:10px 12px;font-size:.8rem;color:#94a3b8}
.feat b{color:#34d399;font-weight:600}
</style>
</head>
<body>
<div class="box">
  <h1>Deno Proxy</h1>
  <div class="subtitle">High-performance streaming proxy with caching</div>
  <div class="stats">
    <div class="stat">Concurrent: <b id="cc">-</b></div>
    <div class="stat">Cache entries: <b id="ce">-</b></div>
  </div>
  <form onsubmit="go(event)">
    <input id="u" type="text" placeholder="https://pyazz.com" required autocomplete="url">
    <button type="submit">Browse</button>
  </form>
  <small>Example: https://pyazz.com</small>
  <div class="features">
    <div class="feat"><b>Stream</b> — Video streaming with Range support</div>
    <div class="feat"><b>Cache</b> — Smart HTML & resolve caching</div>
    <div class="feat"><b>Rate Limit</b> — Per-IP request throttling</div>
    <div class="feat"><b>Security</b> — SSRF protection built-in</div>
  </div>
</div>
<script>
function go(e){
  e.preventDefault();
  var u = document.getElementById('u').value.trim();
  if(!/^https?:\\/\\//i.test(u)) u = 'https://' + u;
  location.href = '/proxy/' + u;
}
// Fetch stats
fetch('/proxy/__stats__').then(r=>r.json()).then(d=>{
  document.getElementById('cc').textContent=d.concurrent||0;
  document.getElementById('ce').textContent=(d.detailCacheSize||0)+(d.mediaCacheSize||0);
}).catch(()=>{});
</script>
</body>
</html>`;
}

function errorPage(msg: string, url: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proxy Error</title>
<style>
body{font-family:'Segoe UI',Arial,sans-serif;background:#0f172a;color:#fff;padding:30px}
.container{max-width:600px;margin:0 auto}
h2{color:#f87171}
pre{white-space:pre-wrap;word-break:break-all;background:#111827;padding:16px;border-radius:10px;border:1px solid #334155;font-size:.9rem}
.url{color:#94a3b8;font-size:.85rem;margin:8px 0}
a{color:#60a5fa;text-decoration:none}
a:hover{text-decoration:underline}
.actions{margin-top:16px;display:flex;gap:10px}
.btn{display:inline-block;padding:10px 20px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#fff;text-decoration:none;font-size:.9rem}
.btn:hover{background:#334155}
</style>
</head>
<body>
<div class="container">
<h2>Proxy Error</h2>
<pre>${escapeHtml(msg)}</pre>
${url ? `<p class="url">URL: ${escapeHtml(url)}</p>` : ""}
<div class="actions">
  <a href="/" class="btn">Home</a>
  <a href="javascript:history.back()" class="btn">Go Back</a>
  ${url ? `<a href="/proxy/${escapeHtml(url)}" class="btn">Retry</a>` : ""}
</div>
</div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
