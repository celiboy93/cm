// deno-lint-ignore-file no-explicit-any
const PORT = 8000;
const PROXY_PREFIX = "/proxy/";
const TARGET_COOKIE = "__proxy_target_origin";

// ===== pyazz-only allowlist =====
const PYAZZ_ORIGINS = new Set([
  "https://pyazz.com",
  "https://www.pyazz.com",
]);

const ALLOWED_ENTRY_HOSTS = new Set([
  "pyazz.com",
  "www.pyazz.com",
  "pyazzindex-production.up.railway.app",
]);

// ===== Short-lived caches =====
const DETAIL_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const MEDIA_RESOLVE_CACHE_TTL_MS = 15 * 1000; // 15 seconds

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
    const pyazzContext = isPyazzOrigin(cookieOrigin) || isPyazzOrigin(refererOrigin);

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
      css = rewriteCss(css, effectiveTargetUrl.href, proxyOrigin + PROXY_PREFIX);

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

// ================= Fetch with media retry =================

async function fetchUpstreamWithRetry(
  req: Request,
  originalTargetUrl: URL,
  cookieOrigin: string,
): Promise<{ upstream: Response; effectiveTargetUrl: URL }> {
  const isMedia = looksLikeMediaRequest(originalTargetUrl, req);
  const resolveKey = makeResolveCacheKey(originalTargetUrl.href, cookieOrigin);

  let effectiveTargetUrl = originalTargetUrl;
  let usedCachedResolve = false;

  if (req.method === "GET" && isMedia) {
    const cachedResolve = mediaResolveCache.get(resolveKey);
    if (cachedResolve && cachedResolve.expiresAt > Date.now()) {
      try {
        effectiveTargetUrl = new URL(cachedResolve.finalUrl);
        usedCachedResolve = true;
      } catch {
        mediaResolveCache.delete(resolveKey);
      }
    }
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

    if (req.method === "GET" && isMedia) {
      mediaResolveCache.set(resolveKey, {
        expiresAt: Date.now() + MEDIA_RESOLVE_CACHE_TTL_MS,
        finalUrl: upstream.url || effectiveTargetUrl.href,
      });
    }

    return { upstream, effectiveTargetUrl };
  } catch (e) {
    if (isMedia && usedCachedResolve) {
      mediaResolveCache.delete(resolveKey);
      effectiveTargetUrl = originalTargetUrl;
      const upstream = await doFetch(req, effectiveTargetUrl, cookieOrigin);

      mediaResolveCache.set(resolveKey, {
        expiresAt: Date.now() + MEDIA_RESOLVE_CACHE_TTL_MS,
        finalUrl: upstream.url || effectiveTargetUrl.href,
      });

      return { upstream, effectiveTargetUrl };
    }
    throw e;
  }
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

// ================= Allowlist =================

function isPyazzOrigin(origin: string): boolean {
  return PYAZZ_ORIGINS.has(origin.toLowerCase());
}

function isTempMediaHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h.endsWith(".r2.dev") || h.endsWith(".r2.cloudflarestorage.com");
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

  return false;
}

// ================= Cache helpers =================

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
  const referer =
    req.headers.get("referer") ||
    req.headers.get("referrer") ||
    "";

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

// ================= Request / response =================

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
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-fetch-user",
  ];

  for (const name of passHeaders) {
    const value = req.headers.get(name);
    if (value) h.set(name, value);
  }

  const cookie = req.headers.get("cookie");
  if (cookie) h.set("cookie", cookie);

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

// ================= Injected script =================

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
    u.indexOf('r2.dev') !== -1 ||
    u.indexOf('r2.cloudflarestorage.com') !== -1 ||
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

try{
  var originalFetch = window.fetch;
  window.fetch = function(input, init){
    try{
      if(typeof input === 'string'){
        input = proxify(input);
      }else if(input && typeof input === 'object'){
        var u = input.url || input.href || '';
        if(u){
          input = new Request(proxify(u), input);
        }
      }
    }catch(e){}
    persistTargetOrigin();
    return originalFetch.call(this, input, init);
  };
}catch(e){}

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
});

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

console.log('[Proxy] pyazz-only locked version active');
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
