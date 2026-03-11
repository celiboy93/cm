// deno-lint-ignore-file no-explicit-any
// ============================================================
// Deno SPA Proxy - Improved Full Version
// - HTML/CSS/JS URL rewriting
// - SPA/React/Vue/Next/Vite root-relative asset support
// - Referer-based fallback for /assets, /api, /build, etc.
// - Click/fetch/xhr/history overrides
// - Better compatibility for dynamic sites
// ============================================================

const PORT = 8000;
const PROXY_PATH_PREFIX = "/proxy/";

Deno.serve({ port: PORT }, handler);
console.log(`Proxy running on http://localhost:${PORT}`);

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const proxyOrigin = url.origin;

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  if (url.pathname === "/" && !url.searchParams.has("url")) {
    return new Response(getHomePage(), {
      status: 200,
      headers: htmlHeaders(),
    });
  }

  let targetUrlStr = extractTargetUrl(req, url);

  if (!targetUrlStr) {
    return new Response("URL not found", {
      status: 400,
      headers: textHeaders(),
    });
  }

  if (!/^https?:\/\//i.test(targetUrlStr)) {
    targetUrlStr = "https://" + targetUrlStr;
  }

  const proxyBase = `${proxyOrigin}${PROXY_PATH_PREFIX}`;
  targetUrlStr = stripDoubleProxy(targetUrlStr, proxyBase);

  try {
    const targetUrl = new URL(targetUrlStr);

    const headers = buildRequestHeaders(req, targetUrl);
    const fetchOptions: RequestInit = {
      method: req.method,
      headers,
      redirect: "manual",
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      fetchOptions.body = req.body;
      // @ts-ignore - Deno supports duplex in runtime for stream body
      fetchOptions.duplex = "half";
    }

    const upstream = await fetch(targetUrl.href, fetchOptions);
    const contentType = upstream.headers.get("content-type") || "";
    const responseHeaders = buildResponseHeaders(upstream);

    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      const location = upstream.headers.get("location");
      if (location) {
        const absoluteLocation = new URL(location, targetUrl.href).href;
        responseHeaders.set("location", proxyBase + absoluteLocation);
      }
      return new Response(null, {
        status: upstream.status,
        headers: responseHeaders,
      });
    }

    if (contentType.includes("text/html")) {
      let html = await upstream.text();
      html = rewriteHtml(html, targetUrl.href, proxyBase, targetUrl);

      responseHeaders.delete("content-length");
      responseHeaders.delete("content-encoding");
      responseHeaders.set("content-type", "text/html; charset=utf-8");

      return new Response(html, {
        status: upstream.status,
        headers: responseHeaders,
      });
    }

    if (contentType.includes("text/css")) {
      let css = await upstream.text();
      css = rewriteCss(css, targetUrl.href, proxyBase);

      responseHeaders.delete("content-length");
      responseHeaders.delete("content-encoding");
      responseHeaders.set("content-type", "text/css; charset=utf-8");

      return new Response(css, {
        status: upstream.status,
        headers: responseHeaders,
      });
    }

    if (
      contentType.includes("javascript") ||
      contentType.includes("application/javascript") ||
      contentType.includes("text/javascript") ||
      contentType.includes("application/x-javascript")
    ) {
      let js = await upstream.text();
      js = rewriteJs(js, targetUrl.href, proxyBase, targetUrl.origin);

      responseHeaders.delete("content-length");
      responseHeaders.delete("content-encoding");
      responseHeaders.set("content-type", "application/javascript; charset=utf-8");

      return new Response(js, {
        status: upstream.status,
        headers: responseHeaders,
      });
    }

    if (
      contentType.includes("application/json") ||
      contentType.includes("+json")
    ) {
      const jsonText = await upstream.text();
      responseHeaders.delete("content-length");
      responseHeaders.delete("content-encoding");

      return new Response(jsonText, {
        status: upstream.status,
        headers: responseHeaders,
      });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error("Proxy Error:", err);
    return new Response(
      errorPage((err as Error).message || "Unknown error", targetUrlStr),
      {
        status: 500,
        headers: htmlHeaders(),
      },
    );
  }
}

// ============================================================
// Helpers
// ============================================================

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

function corsHeaders(): Headers {
  return new Headers({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD",
    "access-control-allow-headers": "*",
    "access-control-expose-headers": "*",
    "access-control-max-age": "86400",
  });
}

function extractTargetUrl(req: Request, url: URL): string {
  if (url.pathname.startsWith(PROXY_PATH_PREFIX)) {
    const full = req.url;
    const idx = full.indexOf(PROXY_PATH_PREFIX);
    if (idx !== -1) {
      return full.substring(idx + PROXY_PATH_PREFIX.length);
    }
  }

  if (url.searchParams.has("url")) {
    return url.searchParams.get("url") || "";
  }

  // Important SPA fallback:
  // when browser requests /assets/* or /api/* on proxy origin,
  // infer target origin from Referer
  if (url.pathname !== "/") {
    const inferredOrigin = inferTargetFromReferer(req);
    if (inferredOrigin) {
      return inferredOrigin + url.pathname + url.search;
    }
  }

  return "";
}

function inferTargetFromReferer(req: Request): string {
  const referer =
    req.headers.get("referer") ||
    req.headers.get("referrer") ||
    "";

  if (!referer) return "";

  try {
    const idx = referer.indexOf(PROXY_PATH_PREFIX);
    if (idx === -1) return "";

    let after = referer.substring(idx + PROXY_PATH_PREFIX.length);

    const hashIndex = after.indexOf("#");
    if (hashIndex !== -1) after = after.substring(0, hashIndex);

    try {
      const u = new URL(after);
      return u.origin;
    } catch {
      const m = after.match(/^https?:\/\/[^/]+/i);
      return m ? m[0] : "";
    }
  } catch {
    return "";
  }
}

function stripDoubleProxy(targetUrl: string, proxyBase: string): string {
  let result = targetUrl;
  let limit = 10;

  while (result.includes(proxyBase) && limit-- > 0) {
    result = result.replace(proxyBase, "");
  }

  try {
    let decoded = decodeURIComponent(result);
    let dlimit = 10;

    while (decoded.includes(proxyBase) && dlimit-- > 0) {
      decoded = decoded.replace(proxyBase, "");
    }

    if (decoded !== result) result = decoded;
  } catch {
    // ignore
  }

  return result;
}

function buildRequestHeaders(req: Request, targetUrl: URL): Headers {
  const headers = new Headers();

  headers.set("host", targetUrl.host);
  headers.set(
    "user-agent",
    req.headers.get("user-agent") ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  );
  headers.set("accept", req.headers.get("accept") || "*/*");
  headers.set(
    "accept-language",
    req.headers.get("accept-language") || "en-US,en;q=0.9",
  );

  // compressed response rewrite မခက်အောင် identity သတ်မှတ်
  headers.set("accept-encoding", "identity");

  headers.set("referer", targetUrl.origin + "/");
  headers.set("origin", targetUrl.origin);

  const passHeaders = [
    "content-type",
    "range",
    "if-none-match",
    "if-modified-since",
    "authorization",
    "x-requested-with",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-fetch-user",
    "cache-control",
    "pragma",
  ];

  for (const name of passHeaders) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }

  const cookie = req.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);

  return headers;
}

function buildResponseHeaders(upstream: Response): Headers {
  const h = new Headers();

  const copyList = [
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

  for (const key of copyList) {
    const value = upstream.headers.get(key);
    if (value) h.set(key, value);
  }

  try {
    const setCookies = (upstream.headers as any).getSetCookie?.() || [];
    for (const sc of setCookies) {
      h.append("set-cookie", sc);
    }
  } catch {
    const sc = upstream.headers.get("set-cookie");
    if (sc) h.set("set-cookie", sc);
  }

  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD");
  h.set("access-control-allow-headers", "*");
  h.set("access-control-expose-headers", "*");

  // restrictive headers remove
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

// ============================================================
// Rewrite helpers
// ============================================================

function shouldProxy(link: string): boolean {
  if (!link || typeof link !== "string") return false;
  const t = link.trim();
  return !/^(javascript:|data:|blob:|#|about:|mailto:|tel:)/i.test(t);
}

function makeAbsoluteUrl(link: string, baseUrl: string): string | null {
  try {
    return new URL(link, baseUrl).href;
  } catch {
    return null;
  }
}

function isAlreadyProxied(link: string, proxyBase: string): boolean {
  return link.startsWith(proxyBase) || link.includes("/proxy/http");
}

function rewriteHtml(
  html: string,
  baseUrl: string,
  proxyBase: string,
  targetUrl: URL,
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
    /((?:href|src|action|poster|data)\s*=\s*)(["'])([^"']*?)\2/gi,
    (_m, prefix, quote, link) => {
      if (!shouldProxy(link) || isAlreadyProxied(link, proxyBase)) {
        return `${prefix}${quote}${link}${quote}`;
      }
      const abs = makeAbsoluteUrl(link, baseUrl);
      return abs
        ? `${prefix}${quote}${proxyBase}${abs}${quote}`
        : `${prefix}${quote}${link}${quote}`;
    },
  );

  html = html.replace(
    /(srcset\s*=\s*)(["'])([^"']*?)\2/gi,
    (_m, prefix, quote, val) => {
      const parts = val.split(",").map((part: string) => {
        const trimmed = part.trim();
        if (!trimmed) return trimmed;

        const spaceIdx = trimmed.search(/\s/);
        const urlPart = spaceIdx === -1
          ? trimmed
          : trimmed.substring(0, spaceIdx);
        const descriptor = spaceIdx === -1 ? "" : trimmed.substring(spaceIdx);

        if (!shouldProxy(urlPart) || isAlreadyProxied(urlPart, proxyBase)) {
          return trimmed;
        }

        const abs = makeAbsoluteUrl(urlPart, baseUrl);
        return abs ? `${proxyBase}${abs}${descriptor}` : trimmed;
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

  html = html.replace(
    /(<meta\s+http-equiv\s*=\s*["']refresh["'][^>]*content\s*=\s*["']\d+;\s*url=)([^"']+)(["'][^>]*>)/gi,
    (_m, before, link, after) => {
      const abs = makeAbsoluteUrl(link, baseUrl);
      return abs ? `${before}${proxyBase}${abs}${after}` : _m;
    },
  );

  const injected = getInjectedScript(proxyBase, targetUrl.origin, baseUrl);

  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch) {
    const idx = html.indexOf(headMatch[0]) + headMatch[0].length;
    html = html.slice(0, idx) + injected + html.slice(idx);
  } else {
    const htmlMatch = html.match(/<html[^>]*>/i);
    if (htmlMatch) {
      const idx = html.indexOf(htmlMatch[0]) + htmlMatch[0].length;
      html = html.slice(0, idx) + "<head>" + injected + "</head>" +
        html.slice(idx);
    } else {
      html = injected + html;
    }
  }

  return html;
}

function rewriteCss(css: string, baseUrl: string, proxyBase: string): string {
  css = rewriteCssUrls(css, baseUrl, proxyBase);

  css = css.replace(/@import\s+["']([^"']+)["']/gi, (m, link) => {
    if (!shouldProxy(link) || isAlreadyProxied(link, proxyBase)) return m;
    const abs = makeAbsoluteUrl(link, baseUrl);
    return abs ? `@import "${proxyBase}${abs}"` : m;
  });

  css = css.replace(
    /@import\s+url\(\s*["']?([^"')]+)["']?\s*\)/gi,
    (m, link) => {
      if (!shouldProxy(link) || isAlreadyProxied(link, proxyBase)) return m;
      const abs = makeAbsoluteUrl(link, baseUrl);
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
    const abs = makeAbsoluteUrl(link, baseUrl);
    return abs ? `url("${proxyBase}${abs}")` : `url("${link}")`;
  });
}

function rewriteJs(
  js: string,
  _baseUrl: string,
  proxyBase: string,
  targetOrigin: string,
): string {
  // conservative text rewrite
  // root-relative assets/api/build/chunks တွေကို proxy ဖြတ်စေဖို့
  return js
    .replace(/(["'`])\/assets\//g, `$1${proxyBase}${targetOrigin}/assets/`)
    .replace(/(["'`])\/api\//g, `$1${proxyBase}${targetOrigin}/api/`)
    .replace(/(["'`])\/build\//g, `$1${proxyBase}${targetOrigin}/build/`)
    .replace(/(["'`])\/static\//g, `$1${proxyBase}${targetOrigin}/static/`)
    .replace(/(["'`])\/_next\//g, `$1${proxyBase}${targetOrigin}/_next/`)
    .replace(/(["'`])\/_nuxt\//g, `$1${proxyBase}${targetOrigin}/_nuxt/`);
}

// ============================================================
// Injected Script
// ============================================================

function getInjectedScript(
  proxyBase: string,
  targetOrigin: string,
  currentPageUrl: string,
): string {
  return `<script>
(function(){
'use strict';

var PROXY_BASE = ${JSON.stringify(proxyBase)};
var TARGET_ORIGIN = ${JSON.stringify(targetOrigin)};
var CURRENT_PAGE_FALLBACK = ${JSON.stringify(currentPageUrl)};

function currentTargetPage(){
  try{
    var p = location.pathname || '';
    var idx = p.indexOf('/proxy/');
    if(idx !== -1){
      var after = decodeURIComponent(p.substring(idx + 7) + location.search + location.hash);
      if(/^https?:\\/\\//i.test(after)) return after;
    }
  }catch(e){}
  return CURRENT_PAGE_FALLBACK;
}

function proxify(u){
  if(!u || typeof u !== 'string') return u;
  u = u.trim();
  if(/^(javascript:|data:|blob:|#|about:|mailto:|tel:)/i.test(u)) return u;
  if(u.indexOf(PROXY_BASE) === 0) return u;
  if(u.indexOf('/proxy/http') !== -1) return u;
  try{
    var abs = new URL(u, currentTargetPage()).href;
    return PROXY_BASE + abs;
  }catch(e){
    return u;
  }
}

function rewriteSrcsetValue(value){
  try{
    return value.split(',').map(function(part){
      part = part.trim();
      if(!part) return part;
      var spaceIdx = part.search(/\\s/);
      var urlPart = spaceIdx === -1 ? part : part.substring(0, spaceIdx);
      var desc = spaceIdx === -1 ? '' : part.substring(spaceIdx);
      if(urlPart && urlPart.indexOf(PROXY_BASE)!==0 && urlPart.indexOf('/proxy/http')===-1){
        urlPart = proxify(urlPart);
      }
      return urlPart + desc;
    }).join(', ');
  }catch(e){
    return value;
  }
}

function rewriteStyleUrls(v){
  try{
    return String(v).replace(/url\\(\\s*["']?([^"')]+?)["']?\\s*\\)/gi,function(_m,link){
      if(/^(data:|blob:|javascript:|#)/i.test(link)) return 'url("' + link + '")';
      return 'url("' + proxify(link) + '")';
    });
  }catch(e){
    return v;
  }
}

// fetch override
try{
  var originalFetch = window.fetch;
  window.fetch = function(input, init){
    try{
      if(typeof input === 'string'){
        input = proxify(input);
      }else if(input && typeof input === 'object'){
        var url = input.url || input.href || '';
        if(url){
          input = new Request(proxify(url), input);
        }
      }
    }catch(e){}
    return originalFetch.call(this, input, init);
  };
}catch(e){}

// XHR override
try{
  var originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(){
    if(arguments.length >= 2 && typeof arguments[1] === 'string'){
      arguments[1] = proxify(arguments[1]);
    }
    return originalXHROpen.apply(this, arguments);
  };
}catch(e){}

// EventSource
try{
  if(window.EventSource){
    var OriginalES = window.EventSource;
    window.EventSource = function(url, config){
      return new OriginalES(proxify(url), config);
    };
    window.EventSource.prototype = OriginalES.prototype;
  }
}catch(e){}

// window.open
try{
  var originalOpen = window.open;
  window.open = function(u,n,f){
    return originalOpen.call(window, u ? proxify(u) : u, n, f);
  };
}catch(e){}

// history API
try{
  var originalPush = history.pushState;
  var originalReplace = history.replaceState;

  history.pushState = function(state, title, url){
    if(url && typeof url === 'string') url = proxify(url);
    return originalPush.call(this, state, title, url);
  };

  history.replaceState = function(state, title, url){
    if(url && typeof url === 'string') url = proxify(url);
    return originalReplace.call(this, state, title, url);
  };
}catch(e){}

// location assign/replace
try{
  var oa = location.assign.bind(location);
  var orp = location.replace.bind(location);
  location.assign = function(u){ oa(proxify(u)); };
  location.replace = function(u){ orp(proxify(u)); };
}catch(e){}

function overrideProp(proto, prop){
  try{
    var d = Object.getOwnPropertyDescriptor(proto, prop);
    if(!d || !d.set) return;
    var oldSet = d.set;
    var oldGet = d.get;
    Object.defineProperty(proto, prop, {
      get: oldGet,
      set: function(v){
        if(typeof v === 'string' && v){
          if(prop === 'srcset'){
            v = rewriteSrcsetValue(v);
          }else if(prop === 'style'){
            v = rewriteStyleUrls(v);
          }else if(!/^(javascript:|data:|blob:|#|about:|mailto:|tel:)/i.test(v)){
            if(v.indexOf(PROXY_BASE)!==0 && v.indexOf('/proxy/http')===-1){
              v = proxify(v);
            }
          }
        }
        oldSet.call(this, v);
      },
      enumerable: true,
      configurable: true
    });
  }catch(e){}
}

[
  [HTMLImageElement,'src'],
  [HTMLScriptElement,'src'],
  [HTMLLinkElement,'href'],
  [HTMLIFrameElement,'src'],
  [HTMLVideoElement,'src'],
  [HTMLVideoElement,'poster'],
  [HTMLAudioElement,'src'],
  [HTMLSourceElement,'src'],
  [HTMLSourceElement,'srcset'],
  [HTMLAnchorElement,'href'],
  [HTMLFormElement,'action']
].forEach(function(item){
  try{ overrideProp(item[0].prototype, item[1]); }catch(e){}
});

// setAttribute override
try{
  var originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value){
    var n = String(name).toLowerCase();
    if(typeof value === 'string' && value){
      if((n === 'src' || n === 'href' || n === 'action' || n === 'poster' || n === 'data') &&
         !/^(javascript:|data:|blob:|#|about:|mailto:|tel:)/i.test(value) &&
         value.indexOf(PROXY_BASE)!==0 &&
         value.indexOf('/proxy/http')===-1){
        value = proxify(value);
      } else if(n === 'srcset'){
        value = rewriteSrcsetValue(value);
      } else if(n === 'style'){
        value = rewriteStyleUrls(value);
      }
    }
    return originalSetAttribute.call(this, name, value);
  };
}catch(e){}

function rewriteEl(el){
  if(!el || !el.getAttribute) return;

  ['src','href','action','poster','data'].forEach(function(attr){
    try{
      var v = el.getAttribute(attr);
      if(v &&
         !/^(javascript:|data:|blob:|#|about:|mailto:|tel:)/i.test(v.trim()) &&
         v.indexOf(PROXY_BASE)!==0 &&
         v.indexOf('/proxy/http')===-1){
        el.setAttribute(attr, proxify(v));
      }
    }catch(e){}
  });

  try{
    var ss = el.getAttribute('srcset');
    if(ss) el.setAttribute('srcset', rewriteSrcsetValue(ss));
  }catch(e){}

  try{
    var style = el.getAttribute('style');
    if(style) el.setAttribute('style', rewriteStyleUrls(style));
  }catch(e){}
}

function rewriteTree(root){
  if(!root) return;
  rewriteEl(root);
  try{
    var els = root.querySelectorAll('[src],[href],[action],[poster],[data],[srcset],[style]');
    for(var i=0;i<els.length;i++) rewriteEl(els[i]);
  }catch(e){}
}

// click handler for anchors
document.addEventListener('click', function(e){
  var el = e.target;
  var limit = 20;
  while(el && el.tagName !== 'A' && limit-- > 0) el = el.parentElement;

  if(el && el.tagName === 'A'){
    var href = el.getAttribute('href');
    var target = el.getAttribute('target');
    if(target === '_blank') return;
    if(href && !/^(javascript:|#|data:|blob:|mailto:|tel:)/i.test(href.trim())){
      if(href.indexOf(PROXY_BASE)!==0 && href.indexOf('/proxy/http')===-1){
        e.preventDefault();
        e.stopPropagation();
        location.href = proxify(href);
        return false;
      }
    }
  }
}, true);

// form submit
document.addEventListener('submit', function(e){
  var f = e.target;
  if(f && f.tagName === 'FORM'){
    var action = f.getAttribute('action') || currentTargetPage();
    if(action.indexOf(PROXY_BASE)!==0){
      f.setAttribute('action', proxify(action));
    }
  }
}, true);

// MutationObserver
var pending = [];
var raf = null;
var mo = new MutationObserver(function(mutations){
  for(var i=0;i<mutations.length;i++){
    var m = mutations[i];
    if(m.addedNodes){
      for(var j=0;j<m.addedNodes.length;j++){
        if(m.addedNodes[j].nodeType === 1) pending.push(m.addedNodes[j]);
      }
    }
    if(m.type === 'attributes' && m.target && m.target.nodeType === 1){
      pending.push(m.target);
    }
  }

  if(!raf){
    raf = requestAnimationFrame(function(){
      var items = pending.splice(0);
      for(var k=0;k<items.length;k++) rewriteTree(items[k]);
      raf = null;
    });
  }
});

if(document.documentElement){
  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src','href','action','poster','data','srcset','style']
  });
}

// disable service worker registration
try{
  Object.defineProperty(navigator, 'serviceWorker', {
    get: function(){
      return {
        register: function(){ return Promise.reject(new Error('Service Worker disabled in proxy')); },
        getRegistrations: function(){ return Promise.resolve([]); },
        ready: Promise.resolve({ unregister: function(){ return Promise.resolve(true); } })
      };
    },
    configurable: true
  });
}catch(e){}

// document.domain shim
try{
  Object.defineProperty(document, 'domain', {
    get: function(){ return TARGET_ORIGIN.replace(/^https?:\\/\\//, '').replace(/:\\d+$/, ''); },
    set: function(){},
    configurable: true
  });
}catch(e){}

// postMessage loosen
try{
  var opm = window.postMessage;
  window.postMessage = function(message, origin, transfer){
    if(origin && origin !== '*') origin = '*';
    return opm.call(this, message, origin, transfer);
  };
}catch(e){}

function fullRewrite(){
  rewriteTree(document.documentElement);
}

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', fullRewrite);
}else{
  setTimeout(fullRewrite, 0);
}

window.addEventListener('load', function(){
  setTimeout(fullRewrite, 50);
  setTimeout(fullRewrite, 300);
  setTimeout(fullRewrite, 1000);
  setTimeout(fullRewrite, 2500);
});

console.log('[Proxy] injected SPA rewrite active');
})();
<\/script>`;
}

// ============================================================
// Pages
// ============================================================

function getHomePage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Deno Web Proxy</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  min-height:100vh;
  display:flex;
  justify-content:center;
  align-items:center;
  background:linear-gradient(135deg,#0f172a,#111827,#1e293b);
  color:#fff
}
.card{
  width:min(92%,560px);
  background:rgba(255,255,255,.08);
  backdrop-filter:blur(14px);
  border:1px solid rgba(255,255,255,.12);
  border-radius:20px;
  padding:28px;
  box-shadow:0 20px 60px rgba(0,0,0,.35)
}
h1{font-size:28px;margin-bottom:10px}
p{color:#cbd5e1;margin-bottom:18px;line-height:1.5}
input{
  width:100%;
  padding:14px 16px;
  border-radius:12px;
  border:1px solid rgba(255,255,255,.15);
  background:rgba(255,255,255,.08);
  color:#fff;
  font-size:16px;
  outline:none;
  margin-bottom:14px
}
button{
  width:100%;
  padding:14px 16px;
  border:none;
  border-radius:12px;
  background:#2563eb;
  color:#fff;
  font-size:16px;
  font-weight:700;
  cursor:pointer
}
button:hover{opacity:.94}
ul{margin-top:16px;padding-left:20px;color:#dbeafe}
li{margin:8px 0}
small{display:block;margin-top:14px;color:#94a3b8}
</style>
</head>
<body>
  <div class="card">
    <h1>Deno Web Proxy</h1>
    <p>URL ထည့်ပြီး proxy ဖြတ်ဝင်နိုင်ပါတယ်။ SPA / React / Vite / dynamic sites တွေအတွက် rewrite support ပါပါတယ်။</p>
    <form onsubmit="go(event)">
      <input id="u" type="text" placeholder="https://www.homietv.com" required autocomplete="off" autofocus />
      <button type="submit">Browse</button>
    </form>
    <ul>
      <li>HTML / CSS / JS rewrite</li>
      <li>Assets / API fallback</li>
      <li>Links / buttons / form / fetch / xhr support</li>
      <li>Dynamic route support</li>
    </ul>
    <small>Example: https://www.homietv.com</small>
  </div>

<script>
function go(e){
  e.preventDefault();
  var u = document.getElementById('u').value.trim();
  if(!/^https?:\\/\\//i.test(u)) u = 'https://' + u;
  location.href = '/proxy/' + u;
}
</script>
</body>
</html>`;
}

function errorPage(message: string, url: string): string {
  const safeMessage = escapeHtml(message);
  const safeUrl = escapeHtml(url);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proxy Error</title>
<style>
body{
  margin:0;
  font-family:Arial,sans-serif;
  background:#0f172a;
  color:#fff;
  display:flex;
  align-items:center;
  justify-content:center;
  min-height:100vh;
  padding:20px;
}
.box{
  width:min(92%,700px);
  background:#111827;
  border:1px solid #334155;
  border-radius:16px;
  padding:24px;
}
h2{margin:0 0 14px 0}
pre{
  white-space:pre-wrap;
  word-break:break-word;
  background:#020617;
  border:1px solid #1e293b;
  border-radius:12px;
  padding:16px;
  overflow:auto;
}
a{color:#60a5fa;text-decoration:none}
</style>
</head>
<body>
  <div class="box">
    <h2>Proxy Error</h2>
    <pre>${safeMessage}</pre>
    <p>URL: ${safeUrl}</p>
    <p><a href="/">Back to home</a></p>
  </div>
</body>
</html>`;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
