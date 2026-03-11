// deno-lint-ignore-file no-explicit-any
const PORT = 8000;
const PROXY_PREFIX = "/proxy/";
const TARGET_COOKIE = "__proxy_target_origin";
const DEFAULT_TARGET_ORIGIN = "https://pyazz.com";

// ===== pyazz-only config =====
const PYAZZ_ORIGINS = new Set([
  "https://pyazz.com",
  "https://www.pyazz.com",
]);

const ALLOWED_ENTRY_HOSTS = new Set([
  "pyazz.com",
  "www.pyazz.com",
  "pyazzindex-production.up.railway.app",
  "getmeilimeilisearchv190-production-b165.up.railway.app",
]);

// ===== Short-lived caches =====
const DETAIL_CACHE_TTL_MS = 2 * 60 * 1000;
const MEDIA_RESOLVE_CACHE_TTL_MS = 3 * 1000;

type DetailCacheEntry = {
  expiresAt: number;
  status: number;
  headers: [string, string][];
  body: string;
};

type ResolveCacheEntry = {
  expiresAt: number;
  finalUrl: string;
};

const detailHtmlCache = new Map<string, DetailCacheEntry>();
const mediaResolveCache = new Map<string, ResolveCacheEntry>();

Deno.serve({ port: PORT }, handler);
console.log(`Pyazz-only proxy (clean URL) running on http://localhost:${PORT}`);

// ===== Clean URL helpers =====
function isPyazzAppPath(pathname: string): boolean {
  const p = pathname.toLowerCase();
  return (
    p === "/" ||
    p.startsWith("/video/") ||
    p.startsWith("/movies") ||
    p.startsWith("/search") ||
    p.startsWith("/genre") ||
    p.startsWith("/country") ||
    p.startsWith("/year") ||
    p.startsWith("/_next/") ||
    p.startsWith("/favicon") ||
    p.startsWith("/images/") ||
    p.startsWith("/api/") ||
    p.startsWith("/manifest") ||
    p.startsWith("/sitemap") ||
    p.startsWith("/robots") ||
    p.endsWith(".js") ||
    p.endsWith(".css") ||
    p.endsWith(".png") ||
    p.endsWith(".jpg") ||
    p.endsWith(".jpeg") ||
    p.endsWith(".gif") ||
    p.endsWith(".svg") ||
    p.endsWith(".ico") ||
    p.endsWith(".webp") ||
    p.endsWith(".json") ||
    p.endsWith(".woff2") ||
    p.endsWith(".woff") ||
    p.endsWith(".ttf") ||
    p.endsWith(".xml") ||
    p.endsWith(".txt")
  );
}

function toPyazzCleanPath(absUrl: string): string | null {
  try {
    const parsed = new URL(absUrl);
    if (isPyazzOrigin(parsed.origin)) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
  } catch { /* ignore */ }
  return null;
}

async function handler(req: Request): Promise<Response> {
  const reqUrl = new URL(req.url);
  const proxyOrigin = reqUrl.origin;

  cleanupCaches();

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  // Home page with no params → show landing or proxy pyazz.com root
  if (
    reqUrl.pathname === "/" &&
    !reqUrl.searchParams.has("url") &&
    !reqUrl.searchParams.toString()
  ) {
    return new Response(homePage(), {
      status: 200,
      headers: htmlHeaders(),
    });
  }

  let target = "";

  // ===== CLEAN URL MODE =====
  if (
    !reqUrl.pathname.startsWith(PROXY_PREFIX) &&
    !reqUrl.searchParams.has("url") &&
    isPyazzAppPath(reqUrl.pathname)
  ) {
    target = DEFAULT_TARGET_ORIGIN + reqUrl.pathname + reqUrl.search;
  } else {
    target = extractTargetUrl(req, reqUrl);
  }

  if (!target) {
    return new Response("URL not found", {
      status: 400,
      headers: textHeaders(),
    });
  }

  target = extractRealTargetFromProxyUrl(target, proxyOrigin, PROXY_PREFIX);

  if (!/^https?:\/\//i.test(target)) {
    target = "https://" + target;
  }

  try {
    const targetUrl = new URL(target);

    if (targetUrl.origin === proxyOrigin) {
      return new Response(
        errorPage(
          "Blocked self-proxy loop. The target URL points back to this proxy deployment.",
          target,
        ),
        {
          status: 508,
          headers: htmlHeaders(),
        },
      );
    }

    const cookieOrigin = getCookie(req, TARGET_COOKIE) || "";
    const refererOrigin = inferOriginFromReferer(req, proxyOrigin) || "";
    const pyazzContext =
      isPyazzOrigin(cookieOrigin) ||
      isPyazzOrigin(refererOrigin) ||
      isPyazzOrigin(targetUrl.origin);

    if (!isAllowedTarget(targetUrl, req, pyazzContext)) {
      return new Response(
        errorPage("This proxy only supports pyazz.com resources.", targetUrl.href),
        {
          status: 403,
          headers: htmlHeaders(),
        },
      );
    }

    const isMedia = looksLikeMediaRequest(targetUrl, req);

    if (req.method === "GET" && !isMedia && isDetailLikePage(targetUrl)) {
      const cacheKey = makeDetailCacheKey(targetUrl.href, cookieOrigin || targetUrl.origin);
      const cached = detailHtmlCache.get(cacheKey);

      if (cached && cached.expiresAt > Date.now()) {
        const h = new Headers(cached.headers);
        h.set("content-type", "text/html; charset=utf-8");
        h.set("x-proxy-cache", "HIT");
        h.append(
          "set-cookie",
          `${TARGET_COOKIE}=${encodeURIComponent(cookieOrigin || targetUrl.origin)}; Path=/; SameSite=Lax`,
        );

        return new Response(cached.body, {
          status: cached.status,
          headers: h,
        });
      }
    }

    const { upstream, effectiveTargetUrl } = await fetchUpstreamWithRetry(
      req,
      targetUrl,
      cookieOrigin || targetUrl.origin,
    );

    const effectiveIsMedia = looksLikeMediaRequest(effectiveTargetUrl, req);
    const contentType = upstream.headers.get("content-type") || "";
    const outHeaders = buildResponseHeaders(upstream, proxyOrigin);

    if (!effectiveIsMedia && [301, 302, 303, 307, 308].includes(upstream.status)) {
      const loc = upstream.headers.get("location");
      if (loc) {
        const abs = new URL(loc, effectiveTargetUrl.href);
        const cleanPath = toPyazzCleanPath(abs.href);
        if (cleanPath) {
          outHeaders.set("location", cleanPath);
        } else {
          outHeaders.set("location", proxyOrigin + PROXY_PREFIX + abs.href);
        }
      }

      outHeaders.append(
        "set-cookie",
        `${TARGET_COOKIE}=${encodeURIComponent(cookieOrigin || targetUrl.origin)}; Path=/; SameSite=Lax`,
      );

      return new Response(null, {
        status: upstream.status,
        headers: outHeaders,
      });
    }

    if (contentType.includes("text/html")) {
      let html = await upstream.text();
      html = rewriteHtml(
        html,
        effectiveTargetUrl.href,
        proxyOrigin,
        PROXY_PREFIX,
        cookieOrigin || targetUrl.origin,
      );

      outHeaders.delete("content-length");
      outHeaders.delete("content-encoding");
      outHeaders.set("content-type", "text/html; charset=utf-8");
      outHeaders.append(
        "set-cookie",
        `${TARGET_COOKIE}=${encodeURIComponent(cookieOrigin || targetUrl.origin)}; Path=/; SameSite=Lax`,
      );
      outHeaders.set("x-proxy-cache", "MISS");

      if (req.method === "GET" && !effectiveIsMedia && isDetailLikePage(effectiveTargetUrl)) {
        const cacheKey = makeDetailCacheKey(
          effectiveTargetUrl.href,
          cookieOrigin || targetUrl.origin,
        );
        detailHtmlCache.set(cacheKey, {
          expiresAt: Date.now() + DETAIL_CACHE_TTL_MS,
          status: upstream.status,
          headers: [...outHeaders.entries()],
          body: html,
        });
      }

      return new Response(html, {
        status: upstream.status,
        headers: outHeaders,
      });
    }

    if (contentType.includes("text/css")) {
      let css = await upstream.text();
      css = rewriteCss(css, effectiveTargetUrl.href, proxyOrigin, PROXY_PREFIX);

      outHeaders.delete("content-length");
      outHeaders.delete("content-encoding");
      outHeaders.set("content-type", "text/css; charset=utf-8");

      return new Response(css, {
        status: upstream.status,
        headers: outHeaders,
      });
    }

    if (
      contentType.includes("javascript") ||
      contentType.includes("application/javascript") ||
      contentType.includes("text/javascript") ||
      contentType.includes("application/x-javascript")
    ) {
      outHeaders.append(
        "set-cookie",
        `${TARGET_COOKIE}=${encodeURIComponent(cookieOrigin || targetUrl.origin)}; Path=/; SameSite=Lax`,
      );

      return new Response(upstream.body, {
        status: upstream.status,
        headers: outHeaders,
      });
    }

    if (contentType.includes("application/json") || contentType.includes("+json")) {
      const txt = await upstream.text();
      outHeaders.delete("content-length");
      outHeaders.delete("content-encoding");
      outHeaders.append(
        "set-cookie",
        `${TARGET_COOKIE}=${encodeURIComponent(cookieOrigin || targetUrl.origin)}; Path=/; SameSite=Lax`,
      );

      return new Response(txt, {
        status: upstream.status,
        headers: outHeaders,
      });
    }

    if (effectiveIsMedia) {
      outHeaders.set("cache-control", "no-store");
    }

    outHeaders.append(
      "set-cookie",
      `${TARGET_COOKIE}=${encodeURIComponent(cookieOrigin || targetUrl.origin)}; Path=/; SameSite=Lax`,
    );

    return new Response(upstream.body, {
      status: upstream.status,
      headers: outHeaders,
    });
  } catch (err) {
    console.error("Proxy Error:", err);
    return new Response(
      errorPage(String((err as Error)?.message || err), target),
      {
        status: 500,
        headers: htmlHeaders(),
      },
    );
  }
}

// ===== Upstream fetch with retry =====
async function fetchUpstreamWithRetry(
  req: Request,
  originalTargetUrl: URL,
  cookieOrigin: string,
): Promise<{ upstream: Response; effectiveTargetUrl: URL }> {
  const isMedia = looksLikeMediaRequest(originalTargetUrl, req);
  const resolveKey = makeResolveCacheKey(originalTargetUrl.href, cookieOrigin);
  const bypassResolvedCache = shouldBypassResolvedMediaCache(originalTargetUrl);

  let effectiveTargetUrl = originalTargetUrl;
  let usedCachedResolve = false;

  if (req.method === "GET" && isMedia && !bypassResolvedCache) {
    const cachedResolve = mediaResolveCache.get(resolveKey);
    if (cachedResolve && cachedResolve.expiresAt > Date.now()) {
      try {
        effectiveTargetUrl = new URL(cachedResolve.finalUrl);
        usedCachedResolve = true;
      } catch {
        mediaResolveCache.delete(resolveKey);
      }
    }
  } else if (bypassResolvedCache) {
    mediaResolveCache.delete(resolveKey);
  }

  try {
    let upstream = await doFetch(req, effectiveTargetUrl, cookieOrigin);

    if (isMedia && usedCachedResolve && shouldRetryMediaStatus(upstream.status)) {
      mediaResolveCache.delete(resolveKey);
      effectiveTargetUrl = originalTargetUrl;
      upstream = await doFetch(req, effectiveTargetUrl, cookieOrigin);
    }

    if (isMedia && !usedCachedResolve && shouldRetryMediaStatus(upstream.status)) {
      mediaResolveCache.delete(resolveKey);
      effectiveTargetUrl = originalTargetUrl;
      upstream = await doFetch(req, effectiveTargetUrl, cookieOrigin);
    }

    if (req.method === "GET" && isMedia && upstream.ok) {
      mediaResolveCache.set(resolveKey, {
        expiresAt: Date.now() + MEDIA_RESOLVE_CACHE_TTL_MS,
        finalUrl: upstream.url || effectiveTargetUrl.href,
      });
    }

    return { upstream, effectiveTargetUrl };
  } catch (_e) {
    if (isMedia) {
      mediaResolveCache.delete(resolveKey);
      effectiveTargetUrl = originalTargetUrl;
      const upstream = await doFetch(req, effectiveTargetUrl, cookieOrigin);

      if (upstream.ok) {
        mediaResolveCache.set(resolveKey, {
          expiresAt: Date.now() + MEDIA_RESOLVE_CACHE_TTL_MS,
          finalUrl: upstream.url || effectiveTargetUrl.href,
        });
      }

      return { upstream, effectiveTargetUrl };
    }
    throw _e;
  }
}

function shouldBypassResolvedMediaCache(url: URL): boolean {
  const h = url.hostname.toLowerCase();
  const p = url.pathname.toLowerCase();

  return (
    h.includes("railway.app") ||
    h.includes("pyazzindex-production.up.railway.app") ||
    p.includes("/d/")
  );
}

async function doFetch(
  req: Request,
  targetUrl: URL,
  cookieOrigin: string,
): Promise<Response> {
  const upstreamHeaders = buildUpstreamHeaders(req, targetUrl, cookieOrigin);
  const isMedia = looksLikeMediaRequest(targetUrl, req);

  const init: RequestInit = {
    method: req.method,
    headers: upstreamHeaders,
    redirect: isMedia ? "follow" : "manual",
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    // @ts-ignore
    init.duplex = "half";
  }

  return await fetch(targetUrl.href, init);
}

function shouldRetryMediaStatus(status: number): boolean {
  return [401, 403, 404, 410, 429, 500, 502, 503, 504].includes(status);
}

// ===== Origin / host checks =====
function isPyazzOrigin(origin: string): boolean {
  return PYAZZ_ORIGINS.has(origin.toLowerCase());
}

function isTempMediaHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h.endsWith(".r2.dev") || h.endsWith(".r2.cloudflarestorage.com");
}

function isTopLevelDocumentRequest(req: Request): boolean {
  const dest = (req.headers.get("sec-fetch-dest") || "").toLowerCase();
  const mode = (req.headers.get("sec-fetch-mode") || "").toLowerCase();
  return dest === "document" || mode === "navigate";
}

function isAllowedTarget(
  targetUrl: URL,
  req: Request,
  pyazzContext: boolean,
): boolean {
  const host = targetUrl.hostname.toLowerCase();

  if (ALLOWED_ENTRY_HOSTS.has(host)) return true;

  if (pyazzContext && looksLikeMediaRequest(targetUrl, req) && isTempMediaHost(host)) {
    return true;
  }

  if (pyazzContext) {
    if (isTopLevelDocumentRequest(req)) {
      return false;
    }
    return targetUrl.protocol === "https:";
  }

  return false;
}

// ===== Cache helpers =====
function cleanupCaches() {
  const now = Date.now();

  for (const [k, v] of detailHtmlCache.entries()) {
    if (v.expiresAt <= now) detailHtmlCache.delete(k);
  }

  for (const [k, v] of mediaResolveCache.entries()) {
    if (v.expiresAt <= now) mediaResolveCache.delete(k);
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

// ===== URL extraction =====
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
    const refererOrigin = inferOriginFromReferer(req, new URL(req.url).origin);
    if (refererOrigin) {
      return refererOrigin + url.pathname + url.search;
    }

    const cookieOrigin = getCookie(req, TARGET_COOKIE);
    if (cookieOrigin && /^https?:\/\//i.test(cookieOrigin)) {
      return cookieOrigin + url.pathname + url.search;
    }

    // Clean URL fallback: default target
    return DEFAULT_TARGET_ORIGIN + url.pathname + url.search;
  }

  return "";
}

function inferOriginFromReferer(req: Request, proxyOrigin: string): string {
  const referer =
    req.headers.get("referer") ||
    req.headers.get("referrer") ||
    "";

  if (!referer) return "";

  try {
    const idx = referer.indexOf(PROXY_PREFIX);
    if (idx !== -1) {
      let after = referer.substring(idx + PROXY_PREFIX.length);
      const hashIdx = after.indexOf("#");
      if (hashIdx !== -1) after = after.slice(0, hashIdx);

      try {
        return new URL(after).origin;
      } catch {
        const m = after.match(/^https?:\/\/[^/]+/i);
        return m ? m[0] : "";
      }
    }

    // Clean URL mode: referer is from proxy itself → default target
    try {
      const refUrl = new URL(referer);
      if (refUrl.origin === proxyOrigin) {
        return DEFAULT_TARGET_ORIGIN;
      }
    } catch { /* ignore */ }

    return "";
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
    } catch {
      // ignore
    }

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

// ===== Media detection =====
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
    path.includes("/d/") ||
    host.includes("r2.dev") ||
    host.includes("railway.app") ||
    accept.includes("video/") ||
    accept.includes("application/octet-stream")
  );
}

// ===== Header builders =====
function filterOutgoingCookie(cookieHeader: string): string {
  const parts = cookieHeader
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((pair) => !pair.startsWith(`${TARGET_COOKIE}=`));

  return parts.join("; ");
}

function buildUpstreamHeaders(
  req: Request,
  targetUrl: URL,
  cookieOrigin: string,
): Headers {
  const h = new Headers();

  h.set(
    "user-agent",
    req.headers.get("user-agent") ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  );
  h.set("accept", req.headers.get("accept") || "*/*");
  h.set(
    "accept-language",
    req.headers.get("accept-language") || "en-US,en;q=0.9",
  );
  h.set("accept-encoding", "identity");

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
    "authorization",
    "x-requested-with",
    "cache-control",
    "pragma",
  ];

  for (const name of passHeaders) {
    const value = req.headers.get(name);
    if (value) h.set(name, value);
  }

  const cookie = req.headers.get("cookie");
  if (cookie) {
    const filtered = filterOutgoingCookie(cookie);
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
  ];

  for (const key of copy) {
    const value = res.headers.get(key);
    if (value) h.set(key, value);
  }

  try {
    const setCookies = (res.headers as any).getSetCookie?.() || [];
    for (const sc of setCookies) h.append("set-cookie", sc);
  } catch {
    const sc = res.headers.get("set-cookie");
    if (sc) h.set("set-cookie", sc);
  }

  // Rewrite location header: pyazz → clean path, others → /proxy/
  const loc = h.get("location");
  if (loc) {
    try {
      const abs = new URL(loc);
      const cleanPath = toPyazzCleanPath(abs.href);
      if (cleanPath) {
        h.set("location", cleanPath);
      } else {
        h.set("location", proxyOrigin + PROXY_PREFIX + abs.href);
      }
    } catch {
      // relative — leave as-is
    }
  }

  h.set("access-control-allow-origin", "*");
  h.set(
    "access-control-allow-methods",
    "GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD",
  );
  h.set("access-control-allow-headers", "*");
  h.set("access-control-expose-headers", "*");

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

// ===== HTML rewriting (clean URL mode) =====
function rewriteHtml(
  html: string,
  baseUrl: string,
  proxyOrigin: string,
  proxyPrefix: string,
  targetOrigin: string,
): string {
  const proxyBase = proxyOrigin + proxyPrefix;

  html = html.replace(/<base\s[^>]*>/gi, "");
  html = html.replace(/\s+integrity\s*=\s*["'][^"']*["']/gi, "");
  html = html.replace(/\s+nonce\s*=\s*["'][^"']*["']/gi, "");
  html = html.replace(/\s+crossorigin(?:\s*=\s*["'][^"']*["'])?/gi, "");
  html = html.replace(
    /<meta\s+http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi,
    "",
  );

  function cleanProxify(value: string): string | null {
    if (!shouldProxy(value)) return null;
    const abs = toAbs(value, baseUrl);
    if (!abs) return null;

    try {
      const parsed = new URL(abs);
      if (isPyazzOrigin(parsed.origin)) {
        return parsed.pathname + parsed.search + parsed.hash;
      }
      return proxyBase + abs;
    } catch {
      return proxyBase + abs;
    }
  }

  html = html.replace(
    /((?:href|src|action|poster)\s*=\s*)(["'])([^"']*?)\2/gi,
    (_m, prefix, quote, value) => {
      if (!shouldProxy(value) || isAlreadyProxied(value, proxyBase)) {
        return `${prefix}${quote}${value}${quote}`;
      }
      const rewritten = cleanProxify(value);
      return rewritten
        ? `${prefix}${quote}${rewritten}${quote}`
        : `${prefix}${quote}${value}${quote}`;
    },
  );

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

        const rewritten = cleanProxify(url);
        return rewritten ? `${rewritten}${desc}` : t;
      });

      return `${prefix}${quote}${parts.join(", ")}${quote}`;
    },
  );

  html = html.replace(
    /(style\s*=\s*)(["'])([^"']*?)\2/gi,
    (_m, prefix, quote, val) => {
      return `${prefix}${quote}${rewriteCssUrls(val, baseUrl, proxyOrigin, proxyPrefix)}${quote}`;
    },
  );

  html = html.replace(
    /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_m, open, css, close) => {
      return open + rewriteCss(css, baseUrl, proxyOrigin, proxyPrefix) + close;
    },
  );

  const injected = injectedScript(proxyOrigin, proxyPrefix, targetOrigin, baseUrl);

  const headOpen = html.match(/<head[^>]*>/i);
  if (headOpen) {
    const idx = html.indexOf(headOpen[0]) + headOpen[0].length;
    html = html.slice(0, idx) + injected + html.slice(idx);
  } else {
    html = injected + html;
  }

  return html;
}

// ===== CSS rewriting (clean URL mode) =====
function rewriteCss(css: string, baseUrl: string, proxyOrigin: string, proxyPrefix: string): string {
  const proxyBase = proxyOrigin + proxyPrefix;

  css = rewriteCssUrls(css, baseUrl, proxyOrigin, proxyPrefix);

  css = css.replace(/@import\s+["']([^"']+)["']/gi, (m, link) => {
    if (!shouldProxy(link) || isAlreadyProxied(link, proxyBase)) return m;
    const abs = toAbs(link, baseUrl);
    if (!abs) return m;
    try {
      const parsed = new URL(abs);
      if (isPyazzOrigin(parsed.origin)) {
        return `@import "${parsed.pathname + parsed.search}"`;
      }
    } catch { /* fall through */ }
    return `@import "${proxyBase}${abs}"`;
  });

  css = css.replace(
    /@import\s+url\(\s*["']?([^"')]+)["']?\s*\)/gi,
    (m, link) => {
      if (!shouldProxy(link) || isAlreadyProxied(link, proxyBase)) return m;
      const abs = toAbs(link, baseUrl);
      if (!abs) return m;
      try {
        const parsed = new URL(abs);
        if (isPyazzOrigin(parsed.origin)) {
          return `@import url("${parsed.pathname + parsed.search}")`;
        }
      } catch { /* fall through */ }
      return `@import url("${proxyBase}${abs}")`;
    },
  );

  return css;
}

function rewriteCssUrls(css: string, baseUrl: string, proxyOrigin: string, proxyPrefix: string): string {
  const proxyBase = proxyOrigin + proxyPrefix;

  return css.replace(/url\(\s*["']?([^"')]+?)["']?\s*\)/gi, (_m, link) => {
    if (!shouldProxy(link) || isAlreadyProxied(link, proxyBase)) {
      return `url("${link}")`;
    }
    const abs = toAbs(link, baseUrl);
    if (!abs) return `url("${link}")`;
    try {
      const parsed = new URL(abs);
      if (isPyazzOrigin(parsed.origin)) {
        return `url("${parsed.pathname + parsed.search}")`;
      }
    } catch { /* fall through */ }
    return `url("${proxyBase}${abs}")`;
  });
}

// ===== Rewriting helpers =====
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

// ===== Injected client-side script (clean URL mode) =====
function injectedScript(
  proxyOrigin: string,
  proxyPrefix: string,
  targetOrigin: string,
  currentPageUrl: string,
): string {
  return `<script>
(function(){
'use strict';

var PROXY_ORIGIN = ${JSON.stringify(proxyOrigin)};
var PROXY_PREFIX = ${JSON.stringify(proxyPrefix)};
var PROXY_BASE = PROXY_ORIGIN + PROXY_PREFIX;
var TARGET_ORIGIN = ${JSON.stringify(targetOrigin)};
var CURRENT_PAGE = ${JSON.stringify(currentPageUrl)};
var TARGET_COOKIE = ${JSON.stringify(TARGET_COOKIE)};

var UNSUPPORTED_PATHS = ['/tvshow', '/adults', '/review', '/trends', '/latest'];

function isUnsupportedLocalPath(path){
  try{
    var s = String(path || '').trim().toLowerCase().split('?')[0].split('#')[0];
    for(var i=0;i<UNSUPPORTED_PATHS.length;i++){
      var p = UNSUPPORTED_PATHS[i];
      if(s === p || s === p + '/') return true;
    }
  }catch(e){}
  return false;
}

function isPyazzOriginCheck(origin){
  var o = String(origin || '').toLowerCase();
  return o === 'https://pyazz.com' || o === 'https://www.pyazz.com';
}

function shouldIgnoreDebugUrl(url){
  try{
    var s = String(url || '');
    if(/google-analytics\\.com|googletagmanager\\.com/i.test(s)) return true;
    if(/\\/indexes\\/alist\\/search/i.test(s)) return true;

    var p1 = location.origin + '/proxy/https://' + location.host + '/';
    var p2 = location.origin + '/proxy/http://' + location.host + '/';
    var p3 = location.origin + '/proxy/' + location.origin + '/';

    if(s.indexOf(p1) === 0) return true;
    if(s.indexOf(p2) === 0) return true;
    if(s.indexOf(p3) === 0) return true;

    return false;
  }catch(e){
    return false;
  }
}

function createDebugBox(){
  try{
    if(document.getElementById('__proxy_debug_box')) return;

    var box = document.createElement('div');
    box.id = '__proxy_debug_box';
    box.style.position = 'fixed';
    box.style.left = '8px';
    box.style.right = '8px';
    box.style.bottom = '8px';
    box.style.zIndex = '999999';
    box.style.maxHeight = '35vh';
    box.style.overflow = 'auto';
    box.style.background = 'rgba(0,0,0,0.92)';
    box.style.color = '#fff';
    box.style.fontSize = '12px';
    box.style.lineHeight = '1.4';
    box.style.padding = '10px';
    box.style.border = '1px solid rgba(255,255,255,0.2)';
    box.style.borderRadius = '10px';
    box.style.wordBreak = 'break-word';
    box.style.display = 'none';

    var title = document.createElement('div');
    title.textContent = 'Proxy Debug';
    title.style.fontWeight = '700';
    title.style.marginBottom = '6px';
    box.appendChild(title);

    var closeBtn = document.createElement('button');
    closeBtn.textContent = '\\u00d7';
    closeBtn.style.position = 'absolute';
    closeBtn.style.top = '6px';
    closeBtn.style.right = '8px';
    closeBtn.style.background = 'transparent';
    closeBtn.style.color = '#fff';
    closeBtn.style.border = 'none';
    closeBtn.style.fontSize = '18px';
    closeBtn.onclick = function(){ box.style.display = 'none'; };
    box.appendChild(closeBtn);

    var content = document.createElement('div');
    content.id = '__proxy_debug_content';
    box.appendChild(content);

    document.documentElement.appendChild(box);
  }catch(e){}
}

function reportFail(type, url, extra){
  try{
    if (shouldIgnoreDebugUrl(url)) return;

    createDebugBox();
    var box = document.getElementById('__proxy_debug_box');
    var content = document.getElementById('__proxy_debug_content');
    if(!box || !content) return;

    box.style.display = 'block';

    var item = document.createElement('div');
    item.style.padding = '6px 0';
    item.style.borderTop = '1px solid rgba(255,255,255,0.12)';

    var t = document.createElement('div');
    t.style.color = '#ff8080';
    t.style.fontWeight = '700';
    t.textContent = type;
    item.appendChild(t);

    var u = document.createElement('div');
    u.textContent = url || '(no url)';
    item.appendChild(u);

    if(extra){
      var e = document.createElement('div');
      e.style.color = '#ccc';
      e.textContent = extra;
      item.appendChild(e);
    }

    content.prepend(item);
  }catch(e){}
}

function persistTargetOrigin(){
  try{
    document.cookie = TARGET_COOKIE + "=" + encodeURIComponent(TARGET_ORIGIN) + "; path=/; SameSite=Lax";
  }catch(e){}
}

function currentTargetPage(){
  try{
    var p = location.pathname || '/';

    // If we're on a /proxy/ path, extract the real URL
    var idx = p.indexOf('/proxy/');
    if(idx !== -1){
      var after = decodeURIComponent(p.substring(idx + 7)) + location.search + location.hash;
      if(/^https?:\\/\\//i.test(after)) return after;
    }

    // Clean URL mode: path is the pyazz path directly
    return TARGET_ORIGIN + p + location.search + location.hash;
  }catch(e){}
  return CURRENT_PAGE;
}

function isMediaLike(u){
  if(!u || typeof u !== 'string') return false;
  u = u.toLowerCase();
  return (
    u.indexOf('/d/') !== -1 ||
    u.indexOf('.mp4') !== -1 ||
    u.indexOf('.m3u8') !== -1 ||
    u.indexOf('.ts') !== -1 ||
    u.indexOf('r2.dev') !== -1 ||
    u.indexOf('r2.cloudflarestorage.com') !== -1 ||
    u.indexOf('railway.app') !== -1
  );
}

function addRetryParam(url){
  try{
    var u = new URL(url, location.href);
    u.searchParams.set('_pvretry', String(Date.now()));
    return u.href;
  }catch(e){
    var sep = String(url).indexOf('?') === -1 ? '?' : '&';
    return String(url) + sep + '_pvretry=' + Date.now();
  }
}

// ===== Core proxify (clean URL mode) =====
function proxify(u){
  if(!u || typeof u !== 'string') return u;
  u = u.trim();

  if(/^(javascript:|data:|blob:|#|about:|mailto:|tel:)/i.test(u)) return u;

  // Unwrap self-proxy loops
  var selfForms = [
    location.origin + '/proxy/https://' + location.host,
    location.origin + '/proxy/http://' + location.host,
    '/proxy/https://' + location.host,
    '/proxy/http://' + location.host
  ];
  for(var i=0;i<selfForms.length;i++){
    if(u.indexOf(selfForms[i]) === 0){
      var tail = u.substring(selfForms[i].length);
      if(tail && tail.charAt(0) !== '/') tail = '/' + tail;
      if(!tail) tail = '/';
      if(isUnsupportedLocalPath(tail)) return '#';
      return tail;
    }
  }

  // Already has /proxy/ prefix
  if(u.indexOf(PROXY_BASE) === 0) return u;
  if(u.indexOf('/proxy/http') !== -1) return u;

  // Relative path starting with /
  if(u.charAt(0) === '/'){
    if(isUnsupportedLocalPath(u)) return '#';
    // These are pyazz paths served at our clean root
    return u;
  }

  // Try to parse as absolute URL
  try{
    var parsed;
    try{
      parsed = new URL(u);
    }catch(e){
      parsed = new URL(u, currentTargetPage());
    }

    // pyazz origin → clean path
    if(isPyazzOriginCheck(parsed.origin)){
      var cleanPath = parsed.pathname + parsed.search + parsed.hash;
      if(isUnsupportedLocalPath(cleanPath)) return '#';
      return cleanPath;
    }

    // Same proxy origin → clean path (unless already /proxy/)
    if(parsed.origin === location.origin){
      if(parsed.pathname.indexOf('/proxy/') === 0) return u;
      var selfPath = parsed.pathname + parsed.search + parsed.hash;
      if(isUnsupportedLocalPath(selfPath)) return '#';
      return selfPath;
    }

    // External → /proxy/ prefix
    return PROXY_BASE + parsed.href;
  }catch(e){}

  // Fallback: resolve relative to current target page
  try{
    var resolved = new URL(u, currentTargetPage());
    if(isPyazzOriginCheck(resolved.origin)){
      return resolved.pathname + resolved.search + resolved.hash;
    }
    return PROXY_BASE + resolved.href;
  }catch(e){}

  return u;
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

// ===== Hide unsupported tabs =====
function hideUnsupportedTabs(root){
  try{
    var links = [];

    if(root && root.tagName === 'A'){
      links.push(root);
    }

    try{
      var found = (root && root.querySelectorAll ? root : document).querySelectorAll('a');
      for(var i=0;i<found.length;i++) links.push(found[i]);
    }catch(e){}

    for(var j=0;j<links.length;j++){
      var a = links[j];
      if(!a || a.getAttribute('data-proxy-hidden') === '1') continue;

      var raw = (a.getAttribute('href') || '').trim();
      var txt = (a.textContent || '').trim().toLowerCase();

      var shouldHide =
        isUnsupportedLocalPath(raw) ||
        /\\/(tvshow|adults|review|trends|latest)(?:[?#]|$)/i.test(raw) ||
        txt === 'tv show' ||
        txt === 'adults' ||
        txt === 'review' ||
        txt === 'trends' ||
        txt === 'latest';

      if(shouldHide){
        a.setAttribute('data-proxy-hidden', '1');
        a.style.display = 'none';
        a.removeAttribute('href');
      }
    }
  }catch(e){}
}

// ===== Decorate poster titles =====
function decoratePosterTitles(root){
  try{
    try{
      var olds = document.querySelectorAll('.__proxy_poster_title');
      for(var x=0;x<olds.length;x++){
        olds[x].remove();
      }
    }catch(e){}

    var links = [];
    try{
      var found = (root && root.querySelectorAll ? root : document).querySelectorAll('a[href^="/video/"]');
      for(var i=0;i<found.length;i++) links.push(found[i]);
    }catch(e){}

    for(var j=0;j<links.length;j++){
      var a = links[j];
      if(!a) continue;

      var img = null;
      try{
        img = a.querySelector('img');
      }catch(e){}
      if(!img) continue;

      var title = (img.getAttribute('alt') || img.getAttribute('title') || '').trim();
      if(!title) continue;

      if(/logo|banner|advert|icon|avatar|profile|search/i.test(title)) continue;

      var next = a.nextElementSibling;
      if(next && next.classList && next.classList.contains('__proxy_poster_title')){
        continue;
      }

      var label = document.createElement('div');
      label.className = '__proxy_poster_title';
      label.textContent = title;
      label.style.fontSize = '12px';
      label.style.marginTop = '6px';
      label.style.color = '#e5e7eb';
      label.style.lineHeight = '1.3';
      label.style.display = 'block';
      label.style.textAlign = 'center';
      label.style.whiteSpace = 'nowrap';
      label.style.overflow = 'hidden';
      label.style.textOverflow = 'ellipsis';

      try{
        a.insertAdjacentElement('afterend', label);
      }catch(e){}
    }
  }catch(e){}
}

// ===== Hide header brand =====
function hideHeaderBrand(root){
  try{
    var nodes = [];
    try{
      var found = (root && root.querySelectorAll ? root : document).querySelectorAll('h1,h2,h3,h4,div,span,a,p');
      for(var i=0;i<found.length;i++) nodes.push(found[i]);
    }catch(e){}

    for(var j=0;j<nodes.length;j++){
      var el = nodes[j];
      if(!el || el.getAttribute('data-proxy-brand-hidden') === '1') continue;

      var txt = (el.textContent || '').trim().toLowerCase();
      if(txt === 'pyazz.com'){
        el.setAttribute('data-proxy-brand-hidden', '1');
        el.style.display = 'none';
      }
    }
  }catch(e){}
}

// ===== Patch video elements =====
function patchVideoElements(root){
  try{
    var vids = [];

    if(root && root.tagName === 'VIDEO'){
      vids.push(root);
    }

    try{
      var found = (root && root.querySelectorAll ? root : document).querySelectorAll('video');
      for(var i=0;i<found.length;i++) vids.push(found[i]);
    }catch(e){}

    for(var j=0;j<vids.length;j++){
      var v = vids[j];
      if(!v || v.__proxyPatched) continue;
      v.__proxyPatched = true;

      (function(video){
        var retried = false;
        var timer = 0;

        function safeRetry(){
          try{
            if(retried) return;
            if(video.currentTime && video.currentTime > 1) return;

            retried = true;
            clearTimeout(timer);

            timer = setTimeout(function(){
              try{
                var src = video.currentSrc || video.getAttribute('src') || '';
                var source = !src ? video.querySelector('source[src]') : null;
                if(!src && source) src = source.getAttribute('src') || '';
                if(!src) return;

                var next = addRetryParam(src);

                if(source){
                  source.setAttribute('src', next);
                  if(video.getAttribute('src')) video.removeAttribute('src');
                }else{
                  video.setAttribute('src', next);
                }

                video.load();
                var p = video.play && video.play();
                if(p && p.catch) p.catch(function(){});
              }catch(e){}
            }, 1000);
          }catch(e){}
        }

        video.addEventListener('error', safeRetry);
        video.addEventListener('stalled', safeRetry);
        video.addEventListener('loadeddata', function(){
          if(video.currentTime > 0 || (video.readyState && video.readyState >= 2)){
            retried = false;
          }
        });
      })(v);
    }
  }catch(e){}
}

// ===== Initialize =====
persistTargetOrigin();

// Patch fetch
try{
  var originalFetch = window.fetch;
  window.fetch = function(input, init){
    var finalUrl = '';
    try{
      if(typeof input === 'string'){
        finalUrl = proxify(input);
        input = finalUrl;
      }else if(input && typeof input === 'object'){
        var u = input.url || input.href || '';
        if(u){
          finalUrl = proxify(u);
          input = new Request(finalUrl, input);
        }
      }
    }catch(e){}
    persistTargetOrigin();

    return originalFetch.call(this, input, init).then(function(res){
      try{
        var showUrl = res && res.url ? res.url : finalUrl;
        if(!res.ok){
          reportFail('FETCH FAIL ' + res.status, showUrl, res.statusText || '');
        }
      }catch(e){}
      return res;
    }).catch(function(err){
      reportFail('FETCH ERROR', finalUrl, String(err));
      throw err;
    });
  };
}catch(e){}

// Patch XHR
try{
  var originalXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url){
    var finalUrl = url;
    if(typeof url === 'string'){
      finalUrl = proxify(url);
      arguments[1] = finalUrl;
    }

    this.addEventListener('load', function(){
      try{
        if(this.status >= 400){
          reportFail('XHR FAIL ' + this.status, finalUrl, this.statusText || '');
        }
      }catch(e){}
    });

    this.addEventListener('error', function(){
      reportFail('XHR ERROR', finalUrl, 'network error');
    });

    persistTargetOrigin();
    return originalXhrOpen.apply(this, arguments);
  };
}catch(e){}

// Window error handlers
window.addEventListener('error', function(e){
  try{
    reportFail('WINDOW ERROR', e.filename || '', e.message || '');
  }catch(err){}
});

window.addEventListener('unhandledrejection', function(e){
  try{
    var msg = '';
    try{ msg = String(e.reason); }catch(_) {}
    reportFail('PROMISE ERROR', '', msg);
  }catch(err){}
});

// Patch history (clean URLs in address bar)
try{
  var pushState = history.pushState;
  var replaceState = history.replaceState;

  history.pushState = function(s,t,u){
    if(u && typeof u === 'string'){
      u = proxify(u);
    }
    persistTargetOrigin();
    return pushState.call(this, s, t, u);
  };

  history.replaceState = function(s,t,u){
    if(u && typeof u === 'string'){
      u = proxify(u);
    }
    persistTargetOrigin();
    return replaceState.call(this, s, t, u);
  };
}catch(e){}

// Patch window.open
try{
  var winOpen = window.open;
  window.open = function(u,n,f){
    persistTargetOrigin();
    return winOpen.call(this, u ? proxify(u) : u, n, f);
  };
}catch(e){}

// Patch setAttribute
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

// Click handler
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
      if(isUnsupportedLocalPath(href)){
        e.preventDefault();
        e.stopPropagation();
        return false;
      }

      e.preventDefault();
      e.stopPropagation();
      persistTargetOrigin();

      location.href = proxify(href);
      return false;
    }
  }
}, true);

// Form submit handler
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

// DOM rewriting
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

  hideUnsupportedTabs(root);
  hideHeaderBrand(root);
  patchVideoElements(root);

  rewriteNode(root);
  try{
    var els = root.querySelectorAll('[src],[href],[action],[poster],[srcset]');
    for(var i=0;i<els.length;i++){
      rewriteNode(els[i]);
    }
  }catch(e){}

  hideUnsupportedTabs(root);
  hideHeaderBrand(root);
  patchVideoElements(root);
  decoratePosterTitles(root);
}

// MutationObserver
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
  }
});

if(document.documentElement){
  mo.observe(document.documentElement, {
    childList:true,
    subtree:true
  });
}

function fullRewrite(){
  persistTargetOrigin();
  hideUnsupportedTabs(document);
  hideHeaderBrand(document);
  patchVideoElements(document);
  rewriteTree(document.documentElement);
}

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', fullRewrite);
}else{
  fullRewrite();
}

window.addEventListener('load', function(){
  fullRewrite();
  setTimeout(fullRewrite, 100);
  setTimeout(fullRewrite, 800);
  setTimeout(function(){
    hideUnsupportedTabs(document);
    hideHeaderBrand(document);
    patchVideoElements(document);
    decoratePosterTitles(document);
  }, 1600);
});

// Disable service workers
try{
  Object.defineProperty(navigator, 'serviceWorker', {
    get: function(){
      return {
        register: function(){ return Promise.reject(new Error('SW disabled')); },
        getRegistrations: function(){ return Promise.resolve([]); },
        ready: Promise.resolve({
          unregister: function(){ return Promise.resolve(true); }
        })
      };
    },
    configurable: true
  });
}catch(e){}

console.log('[Proxy] Clean URL mode active');
})();
<\/script>`;
}

// ===== Static response helpers =====
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
    "cache-control": "no-store",
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
<title>Pyazz Access</title>
<style>
body{font-family:Arial,sans-serif;background:#0f172a;color:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:20px}
.box{width:min(92%,520px);background:#111827;border:1px solid #334155;border-radius:16px;padding:24px;text-align:center}
h1{margin:0 0 12px}
p{color:#cbd5e1;line-height:1.6}
a.btn{display:inline-block;margin-top:16px;padding:14px 20px;border-radius:10px;background:#2563eb;color:#fff;text-decoration:none;font-weight:700}
small{display:block;margin-top:14px;color:#94a3b8}
</style>
</head>
<body>
<div class="box">
  <h1>Pyazz Access</h1>
  <p>ဒီ proxy ကို pyazz.com အတွက်သာ အသုံးပြုနိုင်ပါသည်။</p>
  <a class="btn" href="/proxy/https://pyazz.com">Open Pyazz</a>
  <small>Unsupported pages are hidden.</small>
</div>
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
body{font-family:Arial,sans-serif;background:#0f172a;color:#fff;padding:30px}
pre{white-space:pre-wrap;background:#111827;padding:16px;border-radius:10px;border:1px solid #334155}
a{color:#60a5fa}
</style>
</head>
<body>
<h2>Proxy Error</h2>
<pre>${escapeHtml(msg)}</pre>
<p>URL: ${escapeHtml(url)}</p>
<p><a href="/">Back</a></p>
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
