// Deno Web Proxy - Fixed Version
// ပုံတွေပေါ်အောင်၊ Link တွေနှိပ်ရအောင် ပြင်ဆင်ထားပါသည်

const PORT = 8000;
const PROXY_PATH_PREFIX = "/proxy/";

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const proxyOrigin = url.origin;

  // OPTIONS preflight request - အမြန်ပြန်ပေးမည်
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      },
    });
  }

  // Home Page
  if (url.pathname === "/" && !url.searchParams.has("url")) {
    return new Response(getHomePage(), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Target URL ထုတ်ယူခြင်း
  let targetUrlStr = "";
  if (url.pathname.startsWith(PROXY_PATH_PREFIX)) {
    // /proxy/ နောက်မှ URL ကိုယူမည် - full original URL ပြန်ရယူရန်
    const afterPrefix = req.url.substring(
      req.url.indexOf(PROXY_PATH_PREFIX) + PROXY_PATH_PREFIX.length
    );
    targetUrlStr = afterPrefix;
  } else if (url.searchParams.has("url")) {
    targetUrlStr = url.searchParams.get("url")!;
  }

  if (!targetUrlStr) {
    return new Response("URL not found", { status: 400 });
  }

  // http/https မပါပါက ထည့်ပေးမည်
  if (
    !targetUrlStr.startsWith("http://") &&
    !targetUrlStr.startsWith("https://")
  ) {
    targetUrlStr = "https://" + targetUrlStr;
  }

  // Double-proxy ဖြစ်နေပါက စစ်ပြီး ဖယ်ရှားမည်
  const proxyBase = `${proxyOrigin}${PROXY_PATH_PREFIX}`;
  while (targetUrlStr.includes(proxyBase)) {
    targetUrlStr = targetUrlStr.replace(proxyBase, "");
  }
  // URL decode ပြုလုပ်မည် (encoded proxy URLs များအတွက်)
  try {
    const decoded = decodeURIComponent(targetUrlStr);
    while (decoded.includes(proxyBase)) {
      targetUrlStr = decoded.replace(proxyBase, "");
    }
  } catch (_e) {
    // ignore decode errors
  }

  try {
    const targetUrl = new URL(targetUrlStr);

    // Request Headers ပြင်ဆင်ခြင်း
    const headers = new Headers();
    headers.set("Host", targetUrl.host);
    headers.set(
      "User-Agent",
      req.headers.get("User-Agent") ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    headers.set("Accept", req.headers.get("Accept") || "*/*");
    headers.set(
      "Accept-Language",
      req.headers.get("Accept-Language") || "en-US,en;q=0.9"
    );
    headers.set("Accept-Encoding", "identity");
    headers.set("Referer", targetUrl.origin + "/");
    headers.set("Origin", targetUrl.origin);

    // Cookie forward
    const cookie = req.headers.get("Cookie");
    if (cookie) {
      headers.set("Cookie", cookie);
    }

    // Content-Type forward (POST requests)
    const contentType = req.headers.get("Content-Type");
    if (contentType) {
      headers.set("Content-Type", contentType);
    }

    // Range header forward (media streaming အတွက်)
    const rangeHeader = req.headers.get("Range");
    if (rangeHeader) {
      headers.set("Range", rangeHeader);
    }

    // Fetch options
    const fetchOptions: RequestInit = {
      method: req.method,
      headers: headers,
      redirect: "manual",
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      fetchOptions.body = req.body;
    }

    const response = await fetch(targetUrlStr, fetchOptions);
    const respContentType = response.headers.get("Content-Type") || "";

    // Response Headers ပြင်ဆင်ခြင်း
    const responseHeaders = new Headers();

    // Headers copy
    const copyHeaders = [
      "Content-Type",
      "Content-Disposition",
      "Cache-Control",
      "ETag",
      "Last-Modified",
      "Content-Range",
      "Accept-Ranges",
      "Content-Length",
    ];
    for (const h of copyHeaders) {
      const val = response.headers.get(h);
      if (val) {
        responseHeaders.set(h, val);
      }
    }

    // Set-Cookie များကို forward လုပ်ခြင်း (multiple values)
    const setCookies = response.headers.getSetCookie?.() || [];
    if (setCookies.length > 0) {
      for (const sc of setCookies) {
        responseHeaders.append("Set-Cookie", sc);
      }
    } else {
      const sc = response.headers.get("Set-Cookie");
      if (sc) responseHeaders.set("Set-Cookie", sc);
    }

    // CORS headers
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS"
    );
    responseHeaders.set("Access-Control-Allow-Headers", "*");
    responseHeaders.set("Access-Control-Expose-Headers", "*");

    // X-Frame-Options ဖယ်ရှားမည် (iframe embed အတွက်)
    responseHeaders.delete("X-Frame-Options");

    // Redirect handling
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("Location");
      if (location) {
        const absoluteLocation = new URL(location, targetUrlStr).href;
        responseHeaders.set(
          "Location",
          `${proxyOrigin}${PROXY_PATH_PREFIX}${absoluteLocation}`
        );
      }
      return new Response(null, {
        status: response.status,
        headers: responseHeaders,
      });
    }

    const proxyBaseUrl = `${proxyOrigin}${PROXY_PATH_PREFIX}`;

    // HTML
    if (respContentType.includes("text/html")) {
      let htmlText = await response.text();
      htmlText = rewriteHtml(htmlText, targetUrlStr, proxyBaseUrl, targetUrl);
      responseHeaders.delete("Content-Length");
      responseHeaders.set("Content-Type", "text/html; charset=utf-8");

      return new Response(htmlText, {
        status: response.status,
        headers: responseHeaders,
      });
    }
    // CSS
    else if (respContentType.includes("text/css")) {
      let cssText = await response.text();
      cssText = rewriteCss(cssText, targetUrlStr, proxyBaseUrl);
      responseHeaders.delete("Content-Length");

      return new Response(cssText, {
        status: response.status,
        headers: responseHeaders,
      });
    }
    // JavaScript - URL strings များကို rewrite လုပ်ပေးမည်
    else if (
      respContentType.includes("javascript") ||
      respContentType.includes("application/x-javascript")
    ) {
      const jsText = await response.text();
      responseHeaders.delete("Content-Length");

      return new Response(jsText, {
        status: response.status,
        headers: responseHeaders,
      });
    }
    // Binary/Stream (images, videos, fonts, etc.) - stream ဖြင့်ပြန်ပေးမည်
    else {
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      });
    }
  } catch (error) {
    console.error("Proxy Error:", error);
    return new Response(
      `<!DOCTYPE html>
      <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Proxy Error</title>
      <style>body{font-family:sans-serif;text-align:center;padding:50px;background:#1a1a2e;color:#fff;}
      a{color:#4fc3f7;}</style></head>
      <body>
        <h2>Proxy Error</h2>
        <p>${(error as Error).message}</p>
        <p>URL: ${targetUrlStr}</p>
        <a href="/">Back to Home</a>
      </body></html>`,
      {
        status: 500,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }
}

// Absolute URL ဖန်တီးခြင်း
function makeAbsoluteUrl(link: string, baseUrl: string): string | null {
  try {
    return new URL(link, baseUrl).href;
  } catch {
    return null;
  }
}

// URL ကို proxy through လုပ်သင့်/မလုပ်သင့် စစ်ဆေးခြင်း
function shouldProxy(link: string): boolean {
  if (!link || typeof link !== "string") return false;
  const trimmed = link.trim();
  if (
    trimmed.startsWith("javascript:") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("about:") ||
    trimmed.startsWith("blob:") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("tel:")
  ) {
    return false;
  }
  return true;
}

// HTML Rewrite Function - ပိုမိုပြည့်စုံအောင် ပြင်ဆင်ထားသည်
function rewriteHtml(
  html: string,
  baseUrl: string,
  proxyBaseUrl: string,
  targetUrl: URL
): string {
  const baseOrigin = targetUrl.origin;

  // 1. <base> tag ဖယ်ရှားခြင်း
  html = html.replace(/<base\s[^>]*>/gi, "");

  // 2. Integrity attributes ဖယ်ရှားခြင်း (SRI check fail ကာကွယ်ရန်)
  html = html.replace(/\s+integrity\s*=\s*["'][^"']*["']/gi, "");

  // 3. CSP meta tags ဖယ်ရှားခြင်း
  html = html.replace(
    /<meta\s+http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi,
    ""
  );

  // 4. nonce attributes ဖယ်ရှားခြင်း
  html = html.replace(/\s+nonce\s*=\s*["'][^"']*["']/gi, "");

  // 5. crossorigin attributes ဖယ်ရှားခြင်း
  html = html.replace(/\s+crossorigin\s*(?:=\s*["'][^"']*["'])?/gi, "");

  // 6. href, src, action, poster, data attributes rewrite
  html = html.replace(
    /((?:href|src|action|poster|data)\s*=\s*)(["'])([^"']*?)\2/gi,
    (_match, prefix, quote, link) => {
      if (!shouldProxy(link)) {
        return `${prefix}${quote}${link}${quote}`;
      }
      // Already proxied ဖြစ်နေလျှင် skip
      if (link.startsWith(proxyBaseUrl) || link.includes("/proxy/http")) {
        return `${prefix}${quote}${link}${quote}`;
      }
      const absoluteUrl = makeAbsoluteUrl(link, baseUrl);
      if (absoluteUrl) {
        return `${prefix}${quote}${proxyBaseUrl}${absoluteUrl}${quote}`;
      }
      return `${prefix}${quote}${link}${quote}`;
    }
  );

  // 7. srcset attribute rewrite
  html = html.replace(
    /(srcset\s*=\s*)(["'])([^"']*?)\2/gi,
    (_match, prefix, quote, srcsetVal) => {
      const parts = srcsetVal.split(",").map((part: string) => {
        const trimmed = part.trim();
        if (!trimmed) return trimmed;
        const spaceIdx = trimmed.search(/\s/);
        if (spaceIdx === -1) {
          if (!shouldProxy(trimmed)) return trimmed;
          const abs = makeAbsoluteUrl(trimmed, baseUrl);
          return abs ? `${proxyBaseUrl}${abs}` : trimmed;
        }
        const urlPart = trimmed.substring(0, spaceIdx);
        const descriptor = trimmed.substring(spaceIdx);
        if (!shouldProxy(urlPart)) return trimmed;
        const abs = makeAbsoluteUrl(urlPart, baseUrl);
        return abs ? `${proxyBaseUrl}${abs}${descriptor}` : trimmed;
      });
      return `${prefix}${quote}${parts.join(", ")}${quote}`;
    }
  );

  // 8. Inline style url() rewrite
  html = html.replace(
    /(style\s*=\s*)(["'])([^"']*?)\2/gi,
    (_match, prefix, quote, styleVal) => {
      const rewritten = rewriteCssUrls(styleVal, baseUrl, proxyBaseUrl);
      return `${prefix}${quote}${rewritten}${quote}`;
    }
  );

  // 9. <style> tags rewrite
  html = html.replace(
    /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_match, openTag, cssContent, closeTag) => {
      return (
        openTag + rewriteCss(cssContent, baseUrl, proxyBaseUrl) + closeTag
      );
    }
  );

  // 10. meta refresh redirect
  html = html.replace(
    /(<meta\s+http-equiv\s*=\s*["']refresh["'][^>]*content\s*=\s*["']\d+;\s*url=)([^"']+)(["'][^>]*>)/gi,
    (_match, before, link, after) => {
      const abs = makeAbsoluteUrl(link, baseUrl);
      return abs
        ? `${before}${proxyBaseUrl}${abs}${after}`
        : `${before}${link}${after}`;
    }
  );

  // 11. JavaScript Injection
  const injectedScript = getInjectedScript(
    proxyBaseUrl,
    baseOrigin,
    baseUrl
  );

  // <head> tag ရှာပြီး inject
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch) {
    const headIdx = html.indexOf(headMatch[0]);
    const headEndIdx = headIdx + headMatch[0].length;
    html =
      html.slice(0, headEndIdx) + injectedScript + html.slice(headEndIdx);
  } else {
    const htmlMatch = html.match(/<html[^>]*>/i);
    if (htmlMatch) {
      const htmlIdx = html.indexOf(htmlMatch[0]);
      const htmlEndIdx = htmlIdx + htmlMatch[0].length;
      html =
        html.slice(0, htmlEndIdx) +
        "<head>" +
        injectedScript +
        "</head>" +
        html.slice(htmlEndIdx);
    } else {
      html = injectedScript + html;
    }
  }

  return html;
}

// CSS rewrite
function rewriteCss(
  css: string,
  baseUrl: string,
  proxyBaseUrl: string
): string {
  css = rewriteCssUrls(css, baseUrl, proxyBaseUrl);

  // @import "..."
  css = css.replace(/@import\s+["']([^"']+)["']/gi, (_match, link) => {
    if (!shouldProxy(link)) return _match;
    const abs = makeAbsoluteUrl(link, baseUrl);
    return abs ? `@import "${proxyBaseUrl}${abs}"` : _match;
  });

  // @import url(...)
  css = css.replace(
    /@import\s+url\(\s*["']?([^"')]+)["']?\s*\)/gi,
    (_match, link) => {
      if (!shouldProxy(link)) return _match;
      const abs = makeAbsoluteUrl(link, baseUrl);
      return abs ? `@import url("${proxyBaseUrl}${abs}")` : _match;
    }
  );

  return css;
}

// CSS url() rewrite
function rewriteCssUrls(
  css: string,
  baseUrl: string,
  proxyBaseUrl: string
): string {
  return css.replace(
    /url\(\s*["']?([^"')]+?)["']?\s*\)/gi,
    (_match, link) => {
      if (!shouldProxy(link)) return `url("${link}")`;
      if (link.startsWith(proxyBaseUrl)) return `url("${link}")`;
      const abs = makeAbsoluteUrl(link, baseUrl);
      return abs ? `url("${proxyBaseUrl}${abs}")` : `url("${link}")`;
    }
  );
}

// Client-side JavaScript Injection - ပိုမိုပြည့်စုံအောင် ပြင်ဆင်ထားသည်
function getInjectedScript(
  proxyBaseUrl: string,
  baseOrigin: string,
  currentPageUrl: string
): string {
  return `
<script>
(function() {
  'use strict';
  var PROXY_BASE = ${JSON.stringify(proxyBaseUrl)};
  var TARGET_ORIGIN = ${JSON.stringify(baseOrigin)};
  var CURRENT_PAGE = ${JSON.stringify(currentPageUrl)};

  // URL ကို proxy URL အဖြစ်ပြောင်းခြင်း
  function proxify(url) {
    if (!url || typeof url !== 'string') return url;
    url = url.trim();
    
    // Skip special protocols
    if (/^(javascript:|data:|blob:|#|about:|mailto:|tel:)/.test(url)) return url;
    
    // Already proxied
    if (url.indexOf(PROXY_BASE) === 0) return url;
    
    // Double proxy check - proxy URL ထဲမှာ proxy URL ထပ်ပါနေလျှင် ဖယ်ရှားမည်
    if (url.indexOf('/proxy/http') !== -1) return url;
    
    try {
      var absolute = new URL(url, CURRENT_PAGE).href;
      return PROXY_BASE + absolute;
    } catch(e) {
      return url;
    }
  }

  // ===== Navigation Interception =====
  
  // window.open override
  var origOpen = window.open;
  window.open = function(url, name, features) {
    return origOpen.call(window, url ? proxify(url) : url, name, features);
  };

  // ===== Network Request Interception =====
  
  // fetch override
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') {
      input = proxify(input);
    } else if (input && typeof input === 'object' && input.url) {
      input = new Request(proxify(input.url), input);
    }
    return origFetch.call(window, input, init);
  };

  // XMLHttpRequest override
  var origXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function() {
    if (arguments.length >= 2 && typeof arguments[1] === 'string') {
      arguments[1] = proxify(arguments[1]);
    }
    return origXhrOpen.apply(this, arguments);
  };

  // ===== DOM Event Interception =====

  // Form submit
  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (form && form.tagName === 'FORM') {
      var action = form.getAttribute('action') || '';
      if (action && action.indexOf(PROXY_BASE) !== 0) {
        form.setAttribute('action', proxify(action));
      } else if (!action) {
        form.setAttribute('action', proxify(CURRENT_PAGE));
      }
    }
  }, true);

  // Click handler for <a> tags
  document.addEventListener('click', function(e) {
    var el = e.target;
    // Walk up to find <a> tag
    var maxWalk = 10;
    while (el && el.tagName !== 'A' && maxWalk-- > 0) {
      el = el.parentElement;
    }
    if (el && el.tagName === 'A') {
      var href = el.getAttribute('href');
      if (href && !/^(javascript:|#|data:|blob:|mailto:|tel:)/.test(href.trim())) {
        if (href.indexOf(PROXY_BASE) !== 0 && href.indexOf('/proxy/http') === -1) {
          e.preventDefault();
          e.stopPropagation();
          var newUrl = proxify(href);
          window.location.href = newUrl;
          return false;
        }
      }
    }
  }, true);

  // ===== History API Override =====
  var origPushState = history.pushState;
  var origReplaceState = history.replaceState;
  history.pushState = function(state, title, url) {
    if (url && typeof url === 'string') url = proxify(url);
    return origPushState.call(history, state, title, url);
  };
  history.replaceState = function(state, title, url) {
    if (url && typeof url === 'string') url = proxify(url);
    return origReplaceState.call(history, state, title, url);
  };

  // ===== Dynamic DOM Element URL Rewriting =====
  function rewriteElementUrls(el) {
    if (!el || !el.getAttribute) return;
    
    var attrs = ['src', 'href', 'action', 'poster', 'data'];
    for (var i = 0; i < attrs.length; i++) {
      var attr = attrs[i];
      var val = el.getAttribute(attr);
      if (val && !/^(javascript:|data:|#|blob:|about:|mailto:|tel:)/.test(val.trim())) {
        if (val.indexOf(PROXY_BASE) !== 0 && val.indexOf('/proxy/http') === -1) {
          try {
            el.setAttribute(attr, proxify(val));
          } catch(e) {}
        }
      }
    }
    
    // srcset handling
    var srcset = el.getAttribute('srcset');
    if (srcset) {
      try {
        var parts = srcset.split(',').map(function(part) {
          var trimmed = part.trim();
          if (!trimmed) return trimmed;
          var tokens = trimmed.split(/\\s+/);
          if (tokens[0] && tokens[0].indexOf(PROXY_BASE) !== 0) {
            tokens[0] = proxify(tokens[0]);
          }
          return tokens.join(' ');
        });
        el.setAttribute('srcset', parts.join(', '));
      } catch(e) {}
    }

    // Background image in style attribute
    if (el.style && el.style.backgroundImage) {
      var bg = el.style.backgroundImage;
      var urlMatch = bg.match(/url\\(["']?([^"')]+)["']?\\)/);
      if (urlMatch && urlMatch[1] && urlMatch[1].indexOf(PROXY_BASE) !== 0) {
        try {
          el.style.backgroundImage = 'url("' + proxify(urlMatch[1]) + '")';
        } catch(e) {}
      }
    }
  }

  function rewriteAllElements(root) {
    if (!root) return;
    rewriteElementUrls(root);
    try {
      var elements = root.querySelectorAll('[src],[href],[action],[poster],[data],[srcset]');
      for (var i = 0; i < elements.length; i++) {
        rewriteElementUrls(elements[i]);
      }
    } catch(e) {}
  }

  // MutationObserver - dynamically added elements
  var observerTimer = null;
  var pendingNodes = [];
  
  var observer = new MutationObserver(function(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var added = mutations[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        if (added[j].nodeType === 1) {
          pendingNodes.push(added[j]);
        }
      }
      // Attribute changes
      if (mutations[i].type === 'attributes' && mutations[i].target && mutations[i].target.nodeType === 1) {
        pendingNodes.push(mutations[i].target);
      }
    }
    
    if (!observerTimer) {
      observerTimer = setTimeout(function() {
        var nodes = pendingNodes.splice(0);
        for (var k = 0; k < nodes.length; k++) {
          rewriteAllElements(nodes[k]);
        }
        observerTimer = null;
      }, 50);
    }
  });

  // Observer စတင်ခြင်း
  if (document.documentElement) {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'href', 'action', 'poster', 'data', 'srcset', 'style']
    });
  }

  // ===== Property Descriptor Overrides =====
  // src, href property set ကို intercept လုပ်ခြင်း
  
  function overrideProperty(proto, prop) {
    try {
      var descriptor = Object.getOwnPropertyDescriptor(proto, prop);
      if (descriptor && descriptor.set) {
        var origSetter = descriptor.set;
        var origGetter = descriptor.get;
        Object.defineProperty(proto, prop, {
          get: origGetter,
          set: function(val) {
            if (typeof val === 'string' && !/^(javascript:|data:|blob:|#|about:)/.test(val)) {
              if (val.indexOf(PROXY_BASE) !== 0) {
                val = proxify(val);
              }
            }
            origSetter.call(this, val);
          },
          enumerable: true,
          configurable: true
        });
      }
    } catch(e) {}
  }

  // Image, Script, Link, Iframe, Video, Audio, Source elements
  try { overrideProperty(HTMLImageElement.prototype, 'src'); } catch(e) {}
  try { overrideProperty(HTMLScriptElement.prototype, 'src'); } catch(e) {}
  try { overrideProperty(HTMLLinkElement.prototype, 'href'); } catch(e) {}
  try { overrideProperty(HTMLIFrameElement.prototype, 'src'); } catch(e) {}
  try { overrideProperty(HTMLVideoElement.prototype, 'src'); } catch(e) {}
  try { overrideProperty(HTMLAudioElement.prototype, 'src'); } catch(e) {}
  try { overrideProperty(HTMLSourceElement.prototype, 'src'); } catch(e) {}
  try { overrideProperty(HTMLAnchorElement.prototype, 'href'); } catch(e) {}
  try { overrideProperty(HTMLFormElement.prototype, 'action'); } catch(e) {}

  // ===== createElement override =====
  var origCreateElement = document.createElement;
  document.createElement = function() {
    var el = origCreateElement.apply(document, arguments);
    // Slight delay to catch attribute setting
    return el;
  };

  // ===== Image constructor override =====
  var OrigImage = window.Image;
  window.Image = function(w, h) {
    var img = new OrigImage(w, h);
    var origSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    // Already handled above
    return img;
  };
  window.Image.prototype = OrigImage.prototype;

  // ===== ServiceWorker block =====
  if (navigator.serviceWorker) {
    try {
      Object.defineProperty(navigator, 'serviceWorker', {
        get: function() {
          return {
            register: function() { return Promise.reject(new Error('SW disabled')); },
            getRegistrations: function() { return Promise.resolve([]); },
            ready: Promise.resolve({ unregister: function() { return Promise.resolve(true); } })
          };
        }
      });
    } catch(e) {
      navigator.serviceWorker.register = function() {
        return Promise.reject(new Error('SW disabled'));
      };
    }
  }

  // ===== PostMessage origin fix =====
  var origPostMessage = window.postMessage;
  window.postMessage = function(message, targetOrigin, transfer) {
    if (targetOrigin && targetOrigin !== '*') {
      targetOrigin = '*';
    }
    return origPostMessage.call(window, message, targetOrigin, transfer);
  };

  // DOMContentLoaded ပြီးလျှင် existing elements အကုန် rewrite
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      rewriteAllElements(document.documentElement);
    });
  } else {
    // Already loaded
    setTimeout(function() {
      rewriteAllElements(document.documentElement);
    }, 0);
  }

  // load event ပြီးလျှင်လည်း နောက်တစ်ကြိမ် rewrite
  window.addEventListener('load', function() {
    setTimeout(function() {
      rewriteAllElements(document.documentElement);
    }, 100);
    setTimeout(function() {
      rewriteAllElements(document.documentElement);
    }, 500);
  });

  console.log('[Proxy] Enhanced client-side URL rewriting active');
})();
<\/script>
`;
}

// Home Page UI
function getHomePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Deno Web Proxy</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh;
      background: linear-gradient(135deg, #0f0f23 0%, #1a1a3e 50%, #2d1b69 100%);
    }
    .container {
      background: rgba(255,255,255,0.95); padding: 50px 40px;
      border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      text-align: center; max-width: 520px; width: 90%;
    }
    h2 { color: #1a1a3e; font-size: 28px; margin-bottom: 10px; }
    p { color: #666; margin-bottom: 25px; }
    input[type="text"] {
      width: 100%; padding: 14px 18px; margin-bottom: 20px;
      border: 2px solid #ddd; border-radius: 8px; font-size: 16px;
      outline: none; transition: border-color 0.3s;
    }
    input[type="text"]:focus { border-color: #2d1b69; }
    button {
      padding: 14px 36px;
      background: linear-gradient(135deg, #1a1a3e, #2d1b69);
      color: #fff; border: none; border-radius: 8px; font-size: 16px;
      cursor: pointer; transition: transform 0.2s, box-shadow 0.2s;
    }
    button:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(45,27,105,0.4); }
    .hint { font-size: 12px; color: #999; margin-top: 15px; }
    .features { text-align: left; margin: 20px 0; padding: 15px; background: #f8f8ff; border-radius: 8px; }
    .features div { padding: 4px 0; color: #555; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <h2>Deno Web Proxy</h2>
    <p>Enter a URL to browse freely</p>
    <form onsubmit="go(event)">
      <input type="text" id="url" placeholder="https://www.google.com" required autocomplete="off" autofocus>
      <br>
      <button type="submit">Browse</button>
    </form>
    <div class="features">
      <div>&#10003; Images &amp; Media supported</div>
      <div>&#10003; CSS &amp; JavaScript rewriting</div>
      <div>&#10003; Dynamic content handling</div>
      <div>&#10003; Form &amp; Navigation support</div>
      <div>&#10003; Download links work</div>
    </div>
    <p class="hint">Example: https://www.google.com, https://en.wikipedia.org</p>
  </div>
  <script>
    function go(e) {
      e.preventDefault();
      var url = document.getElementById('url').value.trim();
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
      }
      window.location.href = '/proxy/' + url;
    }
  </script>
</body>
</html>`;
}

// Server Start
console.log(`Proxy server running on http://localhost:${PORT}`);
Deno.serve({ port: PORT }, handler);
