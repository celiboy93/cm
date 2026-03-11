// deno-lint-ignore-file no-explicit-any
const PORT = 8000;
const PROXY_PREFIX = "/proxy/";
const TARGET_COOKIE = "__proxy_target_origin";

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

// Hosts that are known to serve images for pyazz (TMDB, CDNs, etc.)
const KNOWN_IMAGE_HOSTS = new Set([
  "image.tmdb.org",
  "m.media-amazon.com",
  "images-na.ssl-images-amazon.com",
  "i.imgur.com",
]);

// ===== Short-lived caches =====
const DETAIL_CACHE_TTL_MS = 2 * 60 * 1000;
const MEDIA_RESOLVE_CACHE_TTL_MS = 3 * 1000;
// Cache for resolved video redirect chains (longer TTL since signed URLs typically last minutes)
const VIDEO_RESOLVE_CACHE_TTL_MS = 10 * 60 * 1000;

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
const videoResolveCache = new Map<string, ResolveCacheEntry>();

Deno.serve({ port: PORT }, handler);
console.log(`Pyazz-only proxy running on http://localhost:${PORT}`);

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

  if (reqUrl.pathname === "/" && !reqUrl.searchParams.has("url")) {
    return new Response(homePage(), {
      status: 200,
      headers: htmlHeaders(),
    });
  }

  let target = extractTargetUrl(req, reqUrl);

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
    const refererOrigin = inferOriginFromReferer(req) || "";
    const pyazzContext =
      isPyazzOrigin(cookieOrigin) || isPyazzOrigin(refererOrigin);

    if (!isAllowedTarget(targetUrl, req, pyazzContext)) {
      return new Response(
        errorPage(
          "This proxy only supports pyazz.com resources.",
          targetUrl.href,
        ),
        {
          status: 403,
          headers: htmlHeaders(),
        },
      );
    }

    const isMedia = looksLikeMediaRequest(targetUrl, req);

    // --- Special handler for video stream requests (2-step redirect links) ---
    if (isMedia && isVideoStreamRequest(targetUrl)) {
      return await handleVideoStream(req, targetUrl, cookieOrigin || targetUrl.origin, proxyOrigin);
    }

    if (req.method === "GET" && !isMedia && isDetailLikePage(targetUrl)) {
      const cacheKey = makeDetailCacheKey(
        targetUrl.href,
        cookieOrigin || targetUrl.origin,
      );
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

    if (
      !effectiveIsMedia &&
      [301, 302, 303, 307, 308].includes(upstream.status)
    ) {
      const loc = upstream.headers.get("location");
      if (loc) {
        const abs = new URL(loc, effectiveTargetUrl.href).href;
        outHeaders.set("location", proxyOrigin + PROXY_PREFIX + abs);
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
        proxyOrigin + PROXY_PREFIX,
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

      if (
        req.method === "GET" &&
        !effectiveIsMedia &&
        isDetailLikePage(effectiveTargetUrl)
      ) {
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
      css = rewriteCss(
        css,
        effectiveTargetUrl.href,
        proxyOrigin + PROXY_PREFIX,
      );

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
      let jsText = await upstream.text();
      jsText = rewriteJavaScript(
        jsText,
        effectiveTargetUrl.href,
        proxyOrigin + PROXY_PREFIX,
        cookieOrigin || targetUrl.origin,
      );

      outHeaders.delete("content-length");
      outHeaders.delete("content-encoding");
      outHeaders.append(
        "set-cookie",
        `${TARGET_COOKIE}=${encodeURIComponent(cookieOrigin || targetUrl.origin)}; Path=/; SameSite=Lax`,
      );

      return new Response(jsText, {
        status: upstream.status,
        headers: outHeaders,
      });
    }

    if (
      contentType.includes("application/json") ||
      contentType.includes("+json")
    ) {
      let txt = await upstream.text();
      txt = rewriteJsonUrls(
        txt,
        effectiveTargetUrl.href,
        proxyOrigin + PROXY_PREFIX,
        cookieOrigin || targetUrl.origin,
      );

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

// ===== NEW: Handle video stream 2-step redirect =====
// The video links go: original URL → 302/301 → R2 signed URL
// Instead of just proxying headers, we follow the redirect chain server-side
// and then stream the final content back through the proxy
function isVideoStreamRequest(url: URL): boolean {
  const path = url.pathname.toLowerCase();
  const host = url.hostname.toLowerCase();
  return (
    path.endsWith(".mp4") ||
    path.endsWith(".m3u8") ||
    path.endsWith(".mkv") ||
    path.endsWith(".webm") ||
    path.includes("/d/") ||
    host.includes("r2.dev") ||
    host.includes("r2.cloudflarestorage.com") ||
    (host.includes("railway.app") &&
      !host.includes("pyazzindex-production") &&
      !host.includes("getmeilimeilisearchv190-production"))
  );
}

async function handleVideoStream(
  req: Request,
  targetUrl: URL,
  cookieOrigin: string,
  proxyOrigin: string,
): Promise<Response> {
  const cacheKey = `video::${targetUrl.href}`;

  // Step 1: Resolve the final URL by following all redirects
  let finalUrl: string;

  const cached = videoResolveCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    finalUrl = cached.finalUrl;
    console.log(`[VideoStream] Using cached final URL for ${targetUrl.href}`);
  } else {
    try {
      finalUrl = await resolveVideoFinalUrl(targetUrl, cookieOrigin);
      videoResolveCache.set(cacheKey, {
        expiresAt: Date.now() + VIDEO_RESOLVE_CACHE_TTL_MS,
        finalUrl,
      });
      console.log(`[VideoStream] Resolved ${targetUrl.href} -> ${finalUrl}`);
    } catch (err) {
      console.error(`[VideoStream] Failed to resolve: ${err}`);
      finalUrl = targetUrl.href;
    }
  }

  // Step 2: Fetch the actual content from the final URL and stream it back
  const finalUrlObj = new URL(finalUrl);
  const streamHeaders = new Headers();

  streamHeaders.set(
    "user-agent",
    req.headers.get("user-agent") ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  );
  streamHeaders.set("accept", req.headers.get("accept") || "*/*");
  streamHeaders.set("accept-encoding", "identity");

  // Pass through Range header for partial content requests (seeking in video)
  const rangeHeader = req.headers.get("range");
  if (rangeHeader) {
    streamHeaders.set("range", rangeHeader);
  }

  // For R2 signed URLs, set the referer to the R2 host itself
  // (R2 URLs don't typically check referer, but just in case)
  if (
    finalUrlObj.hostname.includes("r2.dev") ||
    finalUrlObj.hostname.includes("r2.cloudflarestorage.com")
  ) {
    streamHeaders.set("referer", finalUrlObj.origin + "/");
  } else {
    const refBase = /^https?:\/\//i.test(cookieOrigin)
      ? cookieOrigin
      : targetUrl.origin;
    streamHeaders.set("referer", refBase + "/");
    streamHeaders.set("origin", refBase);
  }

  let upstream: Response;
  try {
    upstream = await fetch(finalUrl, {
      method: req.method,
      headers: streamHeaders,
      redirect: "follow",
    });
  } catch (fetchErr) {
    // If cached URL fails, try resolving fresh
    if (cached) {
      videoResolveCache.delete(cacheKey);
      try {
        finalUrl = await resolveVideoFinalUrl(targetUrl, cookieOrigin);
        videoResolveCache.set(cacheKey, {
          expiresAt: Date.now() + VIDEO_RESOLVE_CACHE_TTL_MS,
          finalUrl,
        });

        // For R2 signed URLs, update referer
        const freshUrlObj = new URL(finalUrl);
        if (
          freshUrlObj.hostname.includes("r2.dev") ||
          freshUrlObj.hostname.includes("r2.cloudflarestorage.com")
        ) {
          streamHeaders.set("referer", freshUrlObj.origin + "/");
          streamHeaders.delete("origin");
        }

        upstream = await fetch(finalUrl, {
          method: req.method,
          headers: streamHeaders,
          redirect: "follow",
        });
      } catch (retryErr) {
        console.error(`[VideoStream] Retry also failed: ${retryErr}`);
        return new Response("Video stream unavailable", {
          status: 502,
          headers: textHeaders(),
        });
      }
    } else {
      console.error(`[VideoStream] Fetch failed: ${fetchErr}`);
      return new Response("Video stream unavailable", {
        status: 502,
        headers: textHeaders(),
      });
    }
  }

  // If the resolved URL also returns a redirect, follow it again
  if ([301, 302, 303, 307, 308].includes(upstream.status)) {
    const loc = upstream.headers.get("location");
    if (loc) {
      const absLoc = new URL(loc, finalUrl).href;
      videoResolveCache.set(cacheKey, {
        expiresAt: Date.now() + VIDEO_RESOLVE_CACHE_TTL_MS,
        finalUrl: absLoc,
      });

      const retryHeaders = new Headers(streamHeaders);
      const retryUrlObj = new URL(absLoc);
      if (
        retryUrlObj.hostname.includes("r2.dev") ||
        retryUrlObj.hostname.includes("r2.cloudflarestorage.com")
      ) {
        retryHeaders.set("referer", retryUrlObj.origin + "/");
        retryHeaders.delete("origin");
      }

      upstream = await fetch(absLoc, {
        method: req.method,
        headers: retryHeaders,
        redirect: "follow",
      });
    }
  }

  // If still failing, clear cache for next try
  if (!upstream.ok && upstream.status !== 206) {
    videoResolveCache.delete(cacheKey);
    console.warn(
      `[VideoStream] Final fetch returned ${upstream.status} for ${finalUrl}`,
    );
  }

  // Build response headers
  const outHeaders = new Headers();
  const copyHeaders = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "content-disposition",
    "cache-control",
    "etag",
    "last-modified",
  ];
  for (const key of copyHeaders) {
    const val = upstream.headers.get(key);
    if (val) outHeaders.set(key, val);
  }

  // CORS headers
  outHeaders.set("access-control-allow-origin", "*");
  outHeaders.set(
    "access-control-allow-methods",
    "GET, POST, OPTIONS, HEAD",
  );
  outHeaders.set("access-control-allow-headers", "*");
  outHeaders.set("access-control-expose-headers", "*");

  // Remove restrictive headers
  outHeaders.delete("content-security-policy");
  outHeaders.delete("x-frame-options");
  outHeaders.delete("strict-transport-security");
  outHeaders.delete("cross-origin-opener-policy");
  outHeaders.delete("cross-origin-resource-policy");
  outHeaders.delete("cross-origin-embedder-policy");

  outHeaders.append(
    "set-cookie",
    `${TARGET_COOKIE}=${encodeURIComponent(cookieOrigin)}; Path=/; SameSite=Lax`,
  );

  return new Response(upstream.body, {
    status: upstream.status,
    headers: outHeaders,
  });
}

async function resolveVideoFinalUrl(
  targetUrl: URL,
  cookieOrigin: string,
): Promise<string> {
  // Follow redirect chain manually to get the final signed URL
  let currentUrl = targetUrl.href;
  const maxRedirects = 10;

  for (let i = 0; i < maxRedirects; i++) {
    const currentUrlObj = new URL(currentUrl);
    const headers = new Headers();
    headers.set(
      "user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    );
    headers.set("accept", "*/*");
    headers.set("accept-encoding", "identity");

    const refBase = /^https?:\/\//i.test(cookieOrigin)
      ? cookieOrigin
      : targetUrl.origin;
    headers.set("referer", refBase + "/");
    headers.set("origin", refBase);

    const resp = await fetch(currentUrl, {
      method: "HEAD",
      headers,
      redirect: "manual",
    });

    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const loc = resp.headers.get("location");
      if (loc) {
        currentUrl = new URL(loc, currentUrl).href;
        console.log(`[VideoResolve] Redirect ${i + 1}: ${currentUrl}`);
        continue;
      }
    }

    // Not a redirect, this is the final URL
    break;
  }

  return currentUrl;
}

async function fetchUpstreamWithRetry(
  req: Request,
  originalTargetUrl: URL,
  cookieOrigin: string,
): Promise<{ upstream: Response; effectiveTargetUrl: URL }> {
  const isMedia = looksLikeMediaRequest(originalTargetUrl, req);
  const resolveKey = makeResolveCacheKey(originalTargetUrl.href, cookieOrigin);
  const bypassResolvedCache =
    shouldBypassResolvedMediaCache(originalTargetUrl);

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

    if (
      isMedia &&
      usedCachedResolve &&
      shouldRetryMediaStatus(upstream.status)
    ) {
      mediaResolveCache.delete(resolveKey);
      effectiveTargetUrl = originalTargetUrl;
      upstream = await doFetch(req, effectiveTargetUrl, cookieOrigin);
    }

    if (
      isMedia &&
      !usedCachedResolve &&
      shouldRetryMediaStatus(upstream.status)
    ) {
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
    h.includes("pyazzindex-production.up.railway.app") || p.includes("/d/")
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

function isPyazzOrigin(origin: string): boolean {
  return PYAZZ_ORIGINS.has(origin.toLowerCase());
}

function isTempMediaHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h.endsWith(".r2.dev") || h.endsWith(".r2.cloudflarestorage.com");
}

function isKnownImageHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  for (const known of KNOWN_IMAGE_HOSTS) {
    if (h === known || h.endsWith("." + known)) return true;
  }
  return false;
}

function isTopLevelDocumentRequest(req: Request): boolean {
  const dest = (req.headers.get("sec-fetch-dest") || "").toLowerCase();
  const mode = (req.headers.get("sec-fetch-mode") || "").toLowerCase();
  return dest === "document" || mode === "navigate";
}

function isMeilisearchApiRequest(url: URL): boolean {
  const h = url.hostname.toLowerCase();
  return (
    h.includes("getmeilimeilisearchv190-production") &&
    h.endsWith(".railway.app")
  );
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

  // Allow known image CDN hosts in pyazz context (TMDB posters, etc.)
  if (pyazzContext && isKnownImageHost(host)) {
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

function cleanupCaches() {
  const now = Date.now();

  for (const [k, v] of detailHtmlCache.entries()) {
    if (v.expiresAt <= now) detailHtmlCache.delete(k);
  }

  for (const [k, v] of mediaResolveCache.entries()) {
    if (v.expiresAt <= now) mediaResolveCache.delete(k);
  }

  for (const [k, v] of videoResolveCache.entries()) {
    if (v.expiresAt <= now) videoResolveCache.delete(k);
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
    p.startsWith("/search") ||
    p.startsWith("/latest")
  );
}

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
  const referer =
    req.headers.get("referer") || req.headers.get("referrer") || "";

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

function looksLikeMediaRequest(url: URL, req: Request): boolean {
  if (isMeilisearchApiRequest(url)) return false;

  const path = url.pathname.toLowerCase();
  const host = url.hostname.toLowerCase();
  const accept = (req.headers.get("accept") || "").toLowerCase();

  if (
    host.includes("pyazzindex-production") &&
    host.endsWith(".railway.app")
  )
    return false;

  // Next.js data routes are NOT media
  if (path.startsWith("/_next/")) return false;

  return (
    path.endsWith(".mp4") ||
    path.endsWith(".m3u8") ||
    path.endsWith(".mkv") ||
    path.endsWith(".webm") ||
    path.endsWith(".ts") ||
    path.includes("/d/") ||
    host.includes("r2.dev") ||
    host.includes("r2.cloudflarestorage.com") ||
    (host.includes("railway.app") &&
      !host.includes("pyazzindex-production") &&
      !host.includes("getmeilimeilisearchv190-production")) ||
    accept.includes("video/") ||
    accept.includes("application/octet-stream")
  );
}

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

  const loc = h.get("location");
  if (loc) {
    try {
      const abs = new URL(loc).href;
      h.set("location", proxyOrigin + PROXY_PREFIX + abs);
    } catch {
      // ignore
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

// Rewrite JavaScript to fix hardcoded origin URLs and Next.js image loader
function rewriteJavaScript(
  js: string,
  baseUrl: string,
  proxyBase: string,
  targetOrigin: string,
): string {
  // Replace hardcoded pyazz.com origins in JS bundles
  for (const origin of PYAZZ_ORIGINS) {
    js = js.replaceAll(`"${origin}"`, `"${proxyBase}${origin}"`);
    js = js.replaceAll(`'${origin}'`, `'${proxyBase}${origin}'`);
  }

  // Fix Next.js image loader - rewrite /_next/image URLs to go through proxy
  // Next.js generates code like: src="/_next/image?url=..."
  // We need these to go through: /proxy/https://pyazz.com/_next/image?url=...
  js = js.replaceAll(
    '"/_next/image',
    `"${proxyBase}${targetOrigin}/_next/image`,
  );
  js = js.replaceAll(
    "'/_next/image",
    `'${proxyBase}${targetOrigin}/_next/image`,
  );

  // Also rewrite relative /_next/data/ paths for client-side data fetching
  // Match patterns like "/_next/data/BUILD_ID/
  js = js.replace(
    /(['"])(\/_next\/data\/[^'"]+)(['"])/g,
    (_m, q1, path, q2) => {
      return `${q1}${proxyBase}${targetOrigin}${path}${q2}`;
    },
  );

  return js;
}

// Rewrite JSON responses that may contain URLs
function rewriteJsonUrls(
  json: string,
  _baseUrl: string,
  proxyBase: string,
  targetOrigin: string,
): string {
  // Rewrite image URLs in JSON (e.g., poster paths from TMDB in API responses)
  // Match "https://image.tmdb.org/..." and similar image CDN URLs
  try {
    // Rewrite absolute URLs pointing to pyazz origin
    for (const origin of PYAZZ_ORIGINS) {
      // In JSON strings, URLs may be escaped
      const escaped = origin.replace(/\//g, "\\/");
      json = json.replaceAll(escaped, proxyBase.replace(/\//g, "\\/") + origin.replace(/\//g, "\\/"));
      json = json.replaceAll(`"${origin}`, `"${proxyBase}${origin}`);
    }
  } catch {
    // Don't break on JSON rewrite errors
  }
  return json;
}

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

  // ===== FIX 1: Rewrite Next.js Image component src attributes =====
  // Next.js Image component generates src like: /_next/image?url=<encoded>&w=640&q=75
  // We need to proxy these through: /proxy/https://pyazz.com/_next/image?url=<encoded>&w=640&q=75
  html = html.replace(
    /(src\s*=\s*["'])(\/\_next\/image\?[^"']*)(["'])/gi,
    (_m, prefix, path, quote) => {
      return `${prefix}${proxyBase}${targetOrigin}${path}${quote}`;
    },
  );

  // Also rewrite srcSet for Next.js Image (responsive images)
  html = html.replace(
    /(srcSet\s*=\s*["'])([^"']*\/_next\/image[^"']*)(["'])/gi,
    (_m, prefix, val, quote) => {
      const parts = val.split(",").map((p: string) => {
        const t = p.trim();
        if (!t) return t;
        const i = t.search(/\s/);
        const url = i === -1 ? t : t.slice(0, i);
        const desc = i === -1 ? "" : t.slice(i);
        if (url.startsWith("/_next/image")) {
          return `${proxyBase}${targetOrigin}${url}${desc}`;
        }
        return t;
      });
      return `${prefix}${parts.join(", ")}${quote}`;
    },
  );

  // Rewrite data-src and data-srcset attributes (lazy loading)
  html = html.replace(
    /(data-src\s*=\s*["'])(\/\_next\/image\?[^"']*)(["'])/gi,
    (_m, prefix, path, quote) => {
      return `${prefix}${proxyBase}${targetOrigin}${path}${quote}`;
    },
  );

  html = html.replace(
    /((?:href|src|action|poster)\s*=\s*)(["'])([^"']*?)\2/gi,
    (_m, prefix, quote, value) => {
      // Skip if already rewritten above (/_next/image)
      if (value.includes(proxyBase)) {
        return `${prefix}${quote}${value}${quote}`;
      }
      if (!shouldProxy(value) || isAlreadyProxied(value, proxyBase)) {
        return `${prefix}${quote}${value}${quote}`;
      }
      const abs = toAbs(value, baseUrl);
      return abs
        ? `${prefix}${quote}${proxyBase}${abs}${quote}`
        : `${prefix}${quote}${value}${quote}`;
    },
  );

  html = html.replace(
    /(srcset\s*=\s*)(["'])([^"']*?)\2/gi,
    (_m, prefix, quote, val) => {
      // Skip if already contains proxy base
      if (val.includes(proxyBase)) {
        return `${prefix}${quote}${val}${quote}`;
      }
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

  html = html.replace(
    /(style\s*=\s*)(["'])([^"']*?)\2/gi,
    (_m, prefix, quote, val) => {
      return `${prefix}${quote}${rewriteCssUrls(val, baseUrl, proxyBase)}${quote}`;
    },
  );

  html = html.replace(
    /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_m, open, css, close) => {
      return open + rewriteCss(css, baseUrl, proxyBase) + close;
    },
  );

  // ===== FIX 2: Rewrite __NEXT_DATA__ script to fix image URLs and page props =====
  html = html.replace(
    /(<script\s+id\s*=\s*["']__NEXT_DATA__["'][^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_m, open, content, close) => {
      try {
        // Parse the JSON and rewrite image URLs inside
        const data = JSON.parse(content);
        rewriteNextDataImages(data, proxyBase, targetOrigin);
        return open + JSON.stringify(data) + close;
      } catch {
        return open + content + close;
      }
    },
  );

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

// Recursively walk __NEXT_DATA__ and rewrite image URLs
function rewriteNextDataImages(
  obj: any,
  proxyBase: string,
  targetOrigin: string,
): void {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (typeof obj[i] === "string") {
        obj[i] = rewriteNextDataString(obj[i], proxyBase, targetOrigin);
      } else {
        rewriteNextDataImages(obj[i], proxyBase, targetOrigin);
      }
    }
    return;
  }

  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === "string") {
      // Rewrite image/poster URL strings
      if (
        key === "poster" ||
        key === "image" ||
        key === "thumbnail" ||
        key === "backdrop" ||
        key === "cover" ||
        key === "poster_path" ||
        key === "backdrop_path" ||
        key === "img" ||
        key === "src" ||
        key === "url" ||
        key === "photo"
      ) {
        if (val.startsWith("http") && !val.includes(proxyBase)) {
          obj[key] = proxyBase + val;
        } else if (val.startsWith("/") && !val.startsWith("//") && !val.startsWith("/proxy/")) {
          // Relative URL like /some/image/path - proxy through target origin
          obj[key] = proxyBase + targetOrigin + val;
        }
      }
      // Rewrite any string that looks like an absolute image URL
      else if (
        /^https?:\/\/.+\.(jpg|jpeg|png|webp|gif|avif|svg)/i.test(val) &&
        !val.includes(proxyBase)
      ) {
        obj[key] = proxyBase + val;
      }
    } else {
      rewriteNextDataImages(val, proxyBase, targetOrigin);
    }
  }
}

function rewriteNextDataString(
  val: string,
  proxyBase: string,
  targetOrigin: string,
): string {
  if (
    /^https?:\/\/.+\.(jpg|jpeg|png|webp|gif|avif|svg)/i.test(val) &&
    !val.includes(proxyBase)
  ) {
    return proxyBase + val;
  }
  return val;
}

function rewriteCss(css: string, baseUrl: string, proxyBase: string): string {
  css = rewriteCssUrls(css, baseUrl, proxyBase);

  css = css.replace(/@import\s+["']([^"']+)["']/gi, (m, link) => {
    if (!shouldProxy(link) || isAlreadyProxied(link, proxyBase)) return m;
    const abs = toAbs(link, baseUrl);
    return abs ? `@import "${proxyBase}${abs}"` : m;
  });

  css = css.replace(
    /@import\s+url\s*\(\s*["']?([^"')]+?)["']?\s*\)/gi,
    (_m, link) => {
      if (!shouldProxy(link) || isAlreadyProxied(link, proxyBase)) {
        return `url("${link}")`;
      }
      const abs = toAbs(link, baseUrl);
      return abs ? `url("${proxyBase}${abs}")` : `url("${link}")`;
    },
  );

  return css;
}

function rewriteCssUrls(
  css: string,
  baseUrl: string,
  proxyBase: string,
): string {
  return css.replace(
    /url\s*\(\s*["']?([^"')]+?)["']?\s*\)/gi,
    (_m, link) => {
      if (!shouldProxy(link) || isAlreadyProxied(link, proxyBase)) {
        return `url("${link}")`;
      }
      const abs = toAbs(link, baseUrl);
      return abs ? `url("${proxyBase}${abs}")` : `url("${link}")`;
    },
  );
}

function shouldProxy(value: string): boolean {
  if (!value) return false;
  return !/^(javascript:|data:|blob:|#|about:|mailto:|tel:)/i.test(
    value.trim(),
  );
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

function injectedScript(
  proxyBase: string,
  targetOrigin: string,
  currentPageUrl: string,
): string {
  return `<script>
(function(){
'use strict';

var UNSUPPORTED_PATHS = ['/tvshow', '/adults', '/review', '/trends'];

function isUnsupportedLocalPath(path){
  try{
    var s = String(path || '').trim().toLowerCase();
    for(var i=0;i<UNSUPPORTED_PATHS.length;i++){
      var p = UNSUPPORTED_PATHS[i];
      if(s === p || s.indexOf(p + '?') === 0 || s.indexOf(p + '#') === 0 || s.indexOf(p + '/') === 0) return true;
    }
  }catch(e){}
  return false;
}

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

function isNextDataRoute(u){
  if(!u || typeof u !== 'string') return false;
  return /^\\/_next\\//i.test(u.trim()) || /\\/_next\\/data\\//i.test(u);
}

function isNextImageRoute(u){
  if(!u || typeof u !== 'string') return false;
  return /^\\/_next\\/image/i.test(u.trim()) || /\\/_next\\/image\\?/i.test(u);
}

function isPyazzPagePath(path){
  if(!path || typeof path !== 'string') return false;
  var p = path.trim().toLowerCase();
  if(p === '/' || p === '') return true;
  if(/^\\/video\\//i.test(p)) return true;
  if(/^\\/latest/i.test(p)) return true;
  if(/^\\/movies/i.test(p)) return true;
  if(/^\\/search/i.test(p)) return true;
  if(/^\\/request/i.test(p)) return true;
  if(/^\\/genre\\//i.test(p)) return true;
  if(/^\\/country\\//i.test(p)) return true;
  if(/^\\/year\\//i.test(p)) return true;
  return false;
}

function isMediaLike(u){
  if(!u || typeof u !== 'string') return false;
  u = u.toLowerCase();
  if(u.indexOf('getmeilimeilisearchv190-production') !== -1) return false;
  if(u.indexOf('pyazzindex-production') !== -1) return false;
  if(u.indexOf('/_next/') !== -1) return false;
  return (
    u.indexOf('/d/') !== -1 ||
    u.indexOf('.mp4') !== -1 ||
    u.indexOf('.m3u8') !== -1 ||
    u.indexOf('.ts') !== -1 ||
    u.indexOf('r2.dev') !== -1 ||
    u.indexOf('r2.cloudflarestorage.com') !== -1
  );
}

function unwrapSelfProxyUrl(u){
  try{
    var s = String(u || '').trim();
    var forms = [
      location.origin + '/proxy/https://' + location.host,
      location.origin + '/proxy/http://' + location.host,
      '/proxy/https://' + location.host,
      '/proxy/http://' + location.host
    ];

    for(var i=0;i<forms.length;i++){
      if(s.indexOf(forms[i]) === 0){
        var tail = s.substring(forms[i].length);
        if(!tail.startsWith('/')) tail = '/' + tail;
        if(isUnsupportedLocalPath(tail)) return '#';
        return PROXY_BASE + TARGET_ORIGIN + tail;
      }
    }
  }catch(e){}
  return null;
}

function proxify(u){
  if(!u || typeof u !== 'string') return u;
  u = u.trim();

  if(/^(javascript:|data:|blob:|#|about:|mailto:|tel:)/i.test(u)) return u;

  if(isUnsupportedLocalPath(u)) return '#';

  var selfFixed = unwrapSelfProxyUrl(u);
  if(selfFixed !== null) return selfFixed;

  if(u.indexOf(PROXY_BASE) === 0) return u;
  if(u.indexOf('/proxy/http') !== -1) return u;

  // Handle Next.js internal routes (image optimization, data fetching)
  if(isNextImageRoute(u) || isNextDataRoute(u)){
    return PROXY_BASE + TARGET_ORIGIN + u;
  }

  try{
    var parsedDirect = new URL(u);
    var directRoute = parsedDirect.pathname + parsedDirect.search + parsedDirect.hash;

    if(parsedDirect.origin === location.origin && parsedDirect.pathname.indexOf('/proxy/') !== 0){
      if(isUnsupportedLocalPath(directRoute)) return '#';
      return PROXY_BASE + TARGET_ORIGIN + directRoute;
    }

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
      var route2 = parsedAbs.pathname + parsedAbs.search + parsedAbs.hash;

      if(isUnsupportedLocalPath(route2)) return '#';

      if(parsedAbs.origin === location.origin && parsedAbs.pathname.indexOf('/proxy/') !== 0){
        return PROXY_BASE + TARGET_ORIGIN + route2;
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
        /\\/(tvshow|adults|review|trends)(?:[?#]|$)/i.test(raw) ||
        txt === 'tv show' ||
        txt === 'adults' ||
        txt === 'review' ||
        txt === 'trends';

      if(shouldHide){
        a.setAttribute('data-proxy-hidden', '1');
        a.style.display = 'none';
        a.removeAttribute('href');
      }
    }
  }catch(e){}
}

function showMovieTitles(root){
  try{
    var cards = (root && root.querySelectorAll ? root : document).querySelectorAll('a[href*="/video/"], a[href*="/proxy/"]');
    for(var i = 0; i < cards.length; i++){
      var card = cards[i];
      if(card.getAttribute('data-proxy-title-added') === '1') continue;

      var img = card.querySelector('img');
      if(!img) continue;

      var title = img.getAttribute('alt') || img.getAttribute('title') || '';

      if(!title){
        try{
          var href = card.getAttribute('href') || '';
          var match = href.match(/\\/video\\/([a-z0-9-]+)/i);
          if(match){
            title = match[1].replace(/-/g, ' ').replace(/\\b\\w/g, function(c){ return c.toUpperCase(); });
          }
        }catch(e){}
      }

      if(!title) continue;

      var existingTitle = card.querySelector('.movie-title, .title, [class*="title"], [class*="name"]');
      if(existingTitle && existingTitle.textContent.trim()) {
        card.setAttribute('data-proxy-title-added', '1');
        continue;
      }

      var titleEl = document.createElement('div');
      titleEl.className = 'proxy-movie-title';
      titleEl.textContent = title;
      titleEl.style.cssText = 'display:block;width:100%;text-align:center;color:#fff;font-size:12px;line-height:1.3;padding:4px 2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;background:rgba(0,0,0,0.6);border-radius:0 0 6px 6px;margin-top:-4px;';

      card.style.display = 'inline-flex';
      card.style.flexDirection = 'column';
      card.style.alignItems = 'center';
      card.style.overflow = 'hidden';

      card.appendChild(titleEl);
      card.setAttribute('data-proxy-title-added', '1');
    }
  }catch(e){}
}

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
        var errorCount = 0;

        video.addEventListener('error', function(e){
          errorCount++;
          try{
            var src = video.currentSrc || video.getAttribute('src') || '';
            console.log('[Proxy] Video error #' + errorCount + ' for: ' + src);
          }catch(ex){}
        });

        var currentSrc = video.getAttribute('src');
        if(currentSrc && currentSrc.indexOf('/proxy/') === -1 && /^https?:\\/\\//i.test(currentSrc)){
          video.setAttribute('src', proxify(currentSrc));
        }

        var sources = video.querySelectorAll('source');
        for(var s = 0; s < sources.length; s++){
          var srcAttr = sources[s].getAttribute('src');
          if(srcAttr && srcAttr.indexOf('/proxy/') === -1 && /^https?:\\/\\//i.test(srcAttr)){
            sources[s].setAttribute('src', proxify(srcAttr));
          }
        }

        var origLoad = video.load.bind(video);
        var lastLoadTime = 0;
        var loadCount = 0;
        video.load = function(){
          var now = Date.now();
          if(now - lastLoadTime < 3000){
            loadCount++;
            if(loadCount > 2){
              console.log('[Proxy] Blocked excessive video.load() call #' + loadCount);
              return;
            }
          } else {
            loadCount = 0;
          }
          lastLoadTime = now;
          return origLoad();
        };
      })(v);
    }
  }catch(e){}
}

// ===== FIX 3: Patch Next.js Image component =====
// Override the Next.js image loader to always go through proxy
function patchNextImages(root){
  try{
    var imgs = (root && root.querySelectorAll ? root : document).querySelectorAll('img');
    for(var i = 0; i < imgs.length; i++){
      var img = imgs[i];
      if(img.getAttribute('data-proxy-img-fixed') === '1') continue;

      // Fix src
      var src = img.getAttribute('src') || '';
      if(src && src.indexOf('/proxy/') === -1){
        // Handle /_next/image?url=... format
        if(src.indexOf('/_next/image') === 0){
          img.setAttribute('src', PROXY_BASE + TARGET_ORIGIN + src);
          img.setAttribute('data-proxy-img-fixed', '1');
        }
        // Handle absolute URLs to image CDNs
        else if(/^https?:\\/\\//i.test(src) && !src.startsWith(location.origin)){
          img.setAttribute('src', PROXY_BASE + src);
          img.setAttribute('data-proxy-img-fixed', '1');
        }
      }

      // Fix srcset
      var srcset = img.getAttribute('srcset') || '';
      if(srcset && srcset.indexOf('/proxy/') === -1 && srcset.indexOf('/_next/image') !== -1){
        img.setAttribute('srcset', rewriteSrcset(srcset));
        img.setAttribute('data-proxy-img-fixed', '1');
      }

      // Handle lazy loading - fix data-src and loading="lazy" images
      var dataSrc = img.getAttribute('data-src') || '';
      if(dataSrc && dataSrc.indexOf('/proxy/') === -1){
        if(dataSrc.indexOf('/_next/image') === 0){
          img.setAttribute('data-src', PROXY_BASE + TARGET_ORIGIN + dataSrc);
        } else if(/^https?:\\/\\//i.test(dataSrc)){
          img.setAttribute('data-src', PROXY_BASE + dataSrc);
        }
      }

      // If image failed to load, retry with proxied URL
      if(img.complete && img.naturalWidth === 0 && src){
        var proxiedSrc = proxify(src);
        if(proxiedSrc !== src){
          img.setAttribute('src', proxiedSrc);
          img.setAttribute('data-proxy-img-fixed', '1');
        }
      }
    }
  }catch(e){}
}

// ===== FIX 4: Monitor for broken images and fix them =====
function fixBrokenImages(){
  try{
    var imgs = document.querySelectorAll('img');
    for(var i = 0; i < imgs.length; i++){
      var img = imgs[i];
      if(img.getAttribute('data-proxy-retry') === '1') continue;
      if(!img.complete || img.naturalWidth > 0) continue;

      var src = img.getAttribute('src') || '';
      if(!src) continue;

      // Try to fix the broken image
      var proxiedSrc = '';
      if(src.indexOf('/_next/image') === 0 && src.indexOf('/proxy/') === -1){
        proxiedSrc = PROXY_BASE + TARGET_ORIGIN + src;
      } else if(/^https?:\\/\\//i.test(src) && src.indexOf('/proxy/') === -1){
        proxiedSrc = PROXY_BASE + src;
      }

      if(proxiedSrc && proxiedSrc !== src){
        img.setAttribute('data-proxy-retry', '1');
        img.setAttribute('src', proxiedSrc);
      }
    }
  }catch(e){}
}

persistTargetOrigin();

// ===== Intercept fetch for Next.js client-side data =====
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
      return res;
    }).catch(function(err){
      console.warn('[Proxy] Fetch error for:', finalUrl, err);
      throw err;
    });
  };
}catch(e){}

try{
  var originalXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url){
    var finalUrl = url;
    if(typeof url === 'string'){
      finalUrl = proxify(url);
      arguments[1] = finalUrl;
    }
    persistTargetOrigin();
    return originalXhrOpen.apply(this, arguments);
  };
}catch(e){}

// ===== Handle SPA navigation =====
try{
  var pushState = history.pushState;
  var replaceState = history.replaceState;

  history.pushState = function(s,t,u){
    if(u && typeof u === 'string'){
      try{
        var newPath = u;
        var proxyIdx = newPath.indexOf('/proxy/');
        if(proxyIdx !== -1){
          try{
            var afterProxy = newPath.substring(proxyIdx + 7);
            var parsed = new URL(afterProxy);
            newPath = parsed.pathname;
          }catch(e){}
        }

        // For pyazz page navigation, force full page load through proxy
        if(isPyazzPagePath(newPath)){
          var fullUrl = proxify(u);
          if(fullUrl && fullUrl !== '#' && fullUrl !== u){
            persistTargetOrigin();
            // Force full page navigation instead of SPA
            setTimeout(function(){
              location.href = fullUrl;
            }, 10);
            return;
          }
        }
      }catch(e){}

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

window.addEventListener('popstate', function(e){
  try{
    var path = location.pathname;
    if(path.indexOf('/proxy/') === 0){
      location.reload();
    } else if(isPyazzPagePath(path)){
      location.href = PROXY_BASE + TARGET_ORIGIN + path + location.search + location.hash;
    }
  }catch(ex){
    location.reload();
  }
});

try{
  var winOpen = window.open;
  window.open = function(u,n,f){
    persistTargetOrigin();
    return winOpen.call(this, u ? proxify(u) : u, n, f);
  };
}catch(e){}

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

// ===== Click handler - force full page navigation =====
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

      var finalUrl = proxify(href);
      if(finalUrl && finalUrl !== '#'){
        location.href = finalUrl;
      }
      return false;
    }
  }
}, true);

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
    if(ss && ss.indexOf('/proxy/') === -1) el.setAttribute('srcset', rewriteSrcset(ss));
  }catch(e){}
}

function rewriteTree(root){
  if(!root) return;

  hideUnsupportedTabs(root);
  patchVideoElements(root);
  patchNextImages(root);
  showMovieTitles(root);

  rewriteNode(root);
  try{
    var els = root.querySelectorAll('[src],[href],[action],[poster],[srcset]');
    for(var i=0;i<els.length;i++){
      rewriteNode(els[i]);
    }
  }catch(e){}

  hideUnsupportedTabs(root);
  patchVideoElements(root);
  patchNextImages(root);
  showMovieTitles(root);
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
  }
});

if(document.documentElement){
  mo.observe(document.documentElement, {
    childList:true,
    subtree:true
  });
}

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', function(){
    persistTargetOrigin();
    hideUnsupportedTabs(document);
    patchVideoElements(document);
    patchNextImages(document);
    showMovieTitles(document);
    rewriteTree(document.documentElement);
    // Delayed fix for images that load after initial render
    setTimeout(fixBrokenImages, 500);
    setTimeout(fixBrokenImages, 1500);
    setTimeout(fixBrokenImages, 3000);
  });
}else{
  persistTargetOrigin();
  hideUnsupportedTabs(document);
  patchVideoElements(document);
  patchNextImages(document);
  showMovieTitles(document);
  rewriteTree(document.documentElement);
  setTimeout(fixBrokenImages, 500);
  setTimeout(fixBrokenImages, 1500);
  setTimeout(fixBrokenImages, 3000);
}

window.addEventListener('load', function(){
  persistTargetOrigin();
  hideUnsupportedTabs(document);
  patchVideoElements(document);
  patchNextImages(document);
  showMovieTitles(document);
  rewriteTree(document.documentElement);
  setTimeout(function(){
    rewriteTree(document.documentElement);
    fixBrokenImages();
  }, 100);
  setTimeout(function(){
    rewriteTree(document.documentElement);
    fixBrokenImages();
  }, 800);
  setTimeout(function(){
    hideUnsupportedTabs(document);
    patchVideoElements(document);
    patchNextImages(document);
    showMovieTitles(document);
    fixBrokenImages();
  }, 1600);
  // Periodic check for broken images (handles lazy-loaded images)
  setTimeout(fixBrokenImages, 3000);
  setTimeout(fixBrokenImages, 5000);
});

// Also add error listener on all images to auto-fix
document.addEventListener('error', function(e){
  if(e.target && e.target.tagName === 'IMG'){
    var img = e.target;
    if(img.getAttribute('data-proxy-retry') === '1') return;

    var src = img.getAttribute('src') || '';
    if(!src) return;

    var proxiedSrc = '';
    if(src.indexOf('/_next/image') === 0 && src.indexOf('/proxy/') === -1){
      proxiedSrc = PROXY_BASE + TARGET_ORIGIN + src;
    } else if(/^https?:\\/\\//i.test(src) && src.indexOf('/proxy/') === -1){
      proxiedSrc = PROXY_BASE + src;
    }

    if(proxiedSrc && proxiedSrc !== src){
      img.setAttribute('data-proxy-retry', '1');
      img.setAttribute('src', proxiedSrc);
    }
  }
}, true);

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

console.log('[Proxy] pyazz-only proxy v3 - image fix + video stream fix + latest fix');
})();
<\/script>`;
}

function corsHeaders(): Headers {
  return new Headers({
    "access-control-allow-origin": "*",
    "access-control-allow-methods":
      "GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD",
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
  <small>Unsupported sites are blocked.</small>
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
