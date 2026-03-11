// Deno ၏ Built-in Server ကို အသုံးပြုခြင်း
const PORT = 8000;
const PROXY_PATH_PREFIX = "/proxy/";

// Proxy အလုပ်လုပ်မည့် Main Function
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const proxyOrigin = url.origin;

  // Home Page (URL ထည့်ရန် Form ပြမည်)
  if (url.pathname === "/" && !url.searchParams.has("url")) {
    return new Response(getHomePage(), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // User က Form ကနေ URL ထည့်လိုက်လျှင် သို့မဟုတ် /proxy/ လမ်းကြောင်းသို့ ဝင်လာလျှင်
  let targetUrlStr = "";
  if (url.pathname.startsWith(PROXY_PATH_PREFIX)) {
    // /proxy/ နောက်က URL ကို ယူမည်
    targetUrlStr = decodeURIComponent(
      req.url.substring(req.url.indexOf(PROXY_PATH_PREFIX) + PROXY_PATH_PREFIX.length)
    );
  } else if (url.searchParams.has("url")) {
    targetUrlStr = url.searchParams.get("url")!;
  }

  if (!targetUrlStr) {
    return new Response("URL မတွေ့ပါ", { status: 400 });
  }

  // http/https မပါပါက ထည့်ပေးမည်
  if (!targetUrlStr.startsWith("http://") && !targetUrlStr.startsWith("https://")) {
    targetUrlStr = "https://" + targetUrlStr;
  }

  try {
    const targetUrl = new URL(targetUrlStr);

    // Header များ ပြင်ဆင်ခြင်း
    const headers = new Headers();
    headers.set("Host", targetUrl.host);
    headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    headers.set("Accept", req.headers.get("Accept") || "*/*");
    headers.set("Accept-Language", req.headers.get("Accept-Language") || "en-US,en;q=0.9");
    headers.set("Accept-Encoding", "identity"); // Encoding ကို identity အဖြစ်ထားမည် (decompress ပြဿနာမရှိစေရန်)
    headers.set("Referer", targetUrl.origin + "/");
    headers.set("Origin", targetUrl.origin);

    // Cookie များ forward လုပ်ခြင်း
    const cookie = req.headers.get("Cookie");
    if (cookie) {
      headers.set("Cookie", cookie);
    }

    // Content-Type (POST request များအတွက်)
    const contentType = req.headers.get("Content-Type");
    if (contentType) {
      headers.set("Content-Type", contentType);
    }

    // ပစ်မှတ် Website သို့ Fetch လုပ်ခြင်း
    const fetchOptions: RequestInit = {
      method: req.method,
      headers: headers,
      redirect: "manual",
    };

    // GET/HEAD မဟုတ်ပါက body ထည့်မည်
    if (req.method !== "GET" && req.method !== "HEAD") {
      fetchOptions.body = req.body;
    }

    const response = await fetch(targetUrlStr, fetchOptions);
    const respContentType = response.headers.get("Content-Type") || "";

    // Response Header များ ပြင်ဆင်ခြင်း
    const responseHeaders = new Headers();

    // လိုအပ်သော headers များကိုသာ copy လုပ်မည်
    const copyHeaders = [
      "Content-Type",
      "Content-Disposition",
      "Cache-Control",
      "ETag",
      "Last-Modified",
      "Set-Cookie",
    ];
    for (const h of copyHeaders) {
      const val = response.headers.get(h);
      if (val) {
        responseHeaders.set(h, val);
      }
    }

    // CORS ဖွင့်ပေးမည်
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    responseHeaders.set("Access-Control-Allow-Headers", "*");

    // Redirect handling
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("Location");
      if (location) {
        const absoluteLocation = new URL(location, targetUrlStr).href;
        responseHeaders.set(
          "Location",
          `${proxyOrigin}${PROXY_PATH_PREFIX}${encodeTargetUrl(absoluteLocation)}`
        );
      }
      return new Response(null, {
        status: response.status,
        headers: responseHeaders,
      });
    }

    // OPTIONS preflight request
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: responseHeaders });
    }

    const proxyBaseUrl = `${proxyOrigin}${PROXY_PATH_PREFIX}`;

    // HTML ဖိုင်ဖြစ်ပါက Link များ Rewrite လုပ်မည်
    if (respContentType.includes("text/html")) {
      let htmlText = await response.text();
      htmlText = rewriteHtml(htmlText, targetUrlStr, proxyBaseUrl, targetUrl);
      responseHeaders.delete("Content-Length"); // Rewrite ပြီးတာကြောင့် length ပြောင်းသွားနိုင်
      responseHeaders.set("Content-Type", "text/html; charset=utf-8");

      return new Response(htmlText, {
        status: response.status,
        headers: responseHeaders,
      });
    }
    // CSS ဖိုင်ဖြစ်ပါက url() references များ Rewrite လုပ်မည်
    else if (respContentType.includes("text/css")) {
      let cssText = await response.text();
      cssText = rewriteCss(cssText, targetUrlStr, proxyBaseUrl);
      responseHeaders.delete("Content-Length");

      return new Response(cssText, {
        status: response.status,
        headers: responseHeaders,
      });
    }
    // JavaScript ဖိုင်ဖြစ်ပါက (optional rewrite)
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
    // အခြား Binary/Stream ဖိုင်များ (ပုံ, ဗီဒီယို, PDF, etc.)
    else {
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      });
    }
  } catch (error) {
    console.error("Proxy Error:", error);
    return new Response(
      `<html><body style="font-family:sans-serif;text-align:center;padding:50px;">
        <h2>Proxy Error</h2>
        <p>${(error as Error).message}</p>
        <a href="/">Back to Home</a>
      </body></html>`,
      {
        status: 500,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }
}

// Target URL ကို encode လုပ်ခြင်း (slash များကို ထိန်းသိမ်းထားမည်)
function encodeTargetUrl(urlStr: string): string {
  return urlStr;
}

// Absolute URL ဖန်တီးခြင်း
function makeAbsoluteUrl(link: string, baseUrl: string): string | null {
  try {
    return new URL(link, baseUrl).href;
  } catch {
    return null;
  }
}

// HTML အတွင်းရှိ Link များကို ပြင်ဆင်ပေးသော Function
function rewriteHtml(
  html: string,
  baseUrl: string,
  proxyBaseUrl: string,
  targetUrl: URL
): string {
  const baseOrigin = targetUrl.origin;

  // 1. <base> tag ကို ဖယ်ရှားပြီး ကိုယ်ပိုင် base ထည့်မည်
  html = html.replace(/<base\s[^>]*>/gi, "");

  // 2. href, src, action, poster, data, srcset attributes များကို rewrite လုပ်မည်
  // -- href, src, action, poster, data --
  const attrRegex = /(href|src|action|poster|data)\s*=\s*["']([^"']+)["']/gi;
  html = html.replace(attrRegex, (_match, attr, link) => {
    // Skip: javascript:, data:, #, about:blank, blob:
    if (
      link.startsWith("javascript:") ||
      link.startsWith("data:") ||
      link.startsWith("#") ||
      link.startsWith("about:") ||
      link.startsWith("blob:") ||
      link.startsWith("mailto:")
    ) {
      return `${attr}="${link}"`;
    }

    const absoluteUrl = makeAbsoluteUrl(link, baseUrl);
    if (absoluteUrl) {
      return `${attr}="${proxyBaseUrl}${absoluteUrl}"`;
    }
    return `${attr}="${link}"`;
  });

  // 3. srcset attribute rewrite (responsive images)
  const srcsetRegex = /srcset\s*=\s*["']([^"']+)["']/gi;
  html = html.replace(srcsetRegex, (_match, srcsetVal) => {
    const parts = srcsetVal.split(",").map((part: string) => {
      const trimmed = part.trim();
      const spaceIdx = trimmed.search(/\s/);
      if (spaceIdx === -1) {
        const abs = makeAbsoluteUrl(trimmed, baseUrl);
        return abs ? `${proxyBaseUrl}${abs}` : trimmed;
      }
      const urlPart = trimmed.substring(0, spaceIdx);
      const descriptor = trimmed.substring(spaceIdx);
      const abs = makeAbsoluteUrl(urlPart, baseUrl);
      return abs ? `${proxyBaseUrl}${abs}${descriptor}` : trimmed;
    });
    return `srcset="${parts.join(", ")}"`;
  });

  // 4. Inline style ထဲက url() references rewrite လုပ်မည်
  const styleAttrRegex = /style\s*=\s*["']([^"']+)["']/gi;
  html = html.replace(styleAttrRegex, (_match, styleVal) => {
    const rewritten = rewriteCssUrls(styleVal, baseUrl, proxyBaseUrl);
    return `style="${rewritten}"`;
  });

  // 5. <style> tags ထဲက CSS ကို rewrite လုပ်မည်
  const styleTagRegex = /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi;
  html = html.replace(styleTagRegex, (_match, openTag, cssContent, closeTag) => {
    return openTag + rewriteCss(cssContent, baseUrl, proxyBaseUrl) + closeTag;
  });

  // 6. meta refresh redirect handling
  html = html.replace(
    /(<meta\s+http-equiv\s*=\s*["']refresh["'][^>]*content\s*=\s*["']\d+;\s*url=)([^"']+)(["'][^>]*>)/gi,
    (_match, before, link, after) => {
      const abs = makeAbsoluteUrl(link, baseUrl);
      return abs ? `${before}${proxyBaseUrl}${abs}${after}` : `${before}${link}${after}`;
    }
  );

  // 7. Integrity attributes ဖယ်ရှားမည် (subresource integrity check fail မဖြစ်စေရန်)
  html = html.replace(/\s+integrity\s*=\s*["'][^"']*["']/gi, "");

  // 8. CSP meta tags ဖယ်ရှားမည်
  html = html.replace(
    /<meta\s+http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi,
    ""
  );

  // 9. JavaScript Injection - Dynamic URL rewriting, form handling, XHR/fetch interception
  const injectedScript = getInjectedScript(proxyBaseUrl, baseOrigin, baseUrl);

  // <head> tag ပြီးနောက်တွင် script inject လုပ်မည်
  const headIdx = html.search(/<head[^>]*>/i);
  if (headIdx !== -1) {
    const headEndIdx = html.indexOf(">", headIdx) + 1;
    html = html.slice(0, headEndIdx) + injectedScript + html.slice(headEndIdx);
  } else {
    // <head> မရှိပါက <html> ပြီးနောက်ထည့်မည်
    const htmlIdx = html.search(/<html[^>]*>/i);
    if (htmlIdx !== -1) {
      const htmlEndIdx = html.indexOf(">", htmlIdx) + 1;
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

// CSS ဖိုင်ထဲက url() references များကို rewrite လုပ်မည်
function rewriteCss(css: string, baseUrl: string, proxyBaseUrl: string): string {
  // url() references
  css = rewriteCssUrls(css, baseUrl, proxyBaseUrl);

  // @import url("...") and @import "..."
  css = css.replace(
    /@import\s+["']([^"']+)["']/gi,
    (_match, link) => {
      const abs = makeAbsoluteUrl(link, baseUrl);
      return abs ? `@import "${proxyBaseUrl}${abs}"` : `@import "${link}"`;
    }
  );

  return css;
}

// CSS url() ကို rewrite လုပ်မည်
function rewriteCssUrls(css: string, baseUrl: string, proxyBaseUrl: string): string {
  return css.replace(
    /url\(\s*["']?([^"')]+)["']?\s*\)/gi,
    (_match, link) => {
      if (
        link.startsWith("data:") ||
        link.startsWith("blob:") ||
        link.startsWith("#")
      ) {
        return `url("${link}")`;
      }
      const abs = makeAbsoluteUrl(link, baseUrl);
      return abs ? `url("${proxyBaseUrl}${abs}")` : `url("${link}")`;
    }
  );
}

// Client-side JavaScript Injection - Dynamic content handling
function getInjectedScript(
  proxyBaseUrl: string,
  baseOrigin: string,
  currentPageUrl: string
): string {
  return `
<script>
(function() {
  const PROXY_BASE = "${proxyBaseUrl}";
  const TARGET_ORIGIN = "${baseOrigin}";
  const CURRENT_PAGE = "${currentPageUrl}";

  // URL ကို proxy URL အဖြစ်ပြောင်းခြင်း
  function proxify(url) {
    if (!url || typeof url !== 'string') return url;
    url = url.trim();
    if (url.startsWith('javascript:') || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('#') || url.startsWith('about:') || url.startsWith('mailto:')) return url;
    // Already proxied
    if (url.startsWith(PROXY_BASE)) return url;
    try {
      var absolute = new URL(url, CURRENT_PAGE).href;
      return PROXY_BASE + absolute;
    } catch(e) {
      return url;
    }
  }

  // window.location override (navigation interception)
  // location.href = "..." ကို intercept လုပ်ရန်
  try {
    var origAssign = window.location.assign;
    var origReplace = window.location.replace;

    window.location.assign = function(url) {
      origAssign.call(window.location, proxify(url));
    };
    window.location.replace = function(url) {
      origReplace.call(window.location, proxify(url));
    };
  } catch(e) {}

  // window.open override
  var origOpen = window.open;
  window.open = function(url, name, features) {
    return origOpen.call(window, proxify(url), name, features);
  };

  // fetch override
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') {
      input = proxify(input);
    } else if (input instanceof Request) {
      input = new Request(proxify(input.url), input);
    }
    return origFetch.call(window, input, init);
  };

  // XMLHttpRequest override
  var origXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    arguments[1] = proxify(url);
    return origXhrOpen.apply(this, arguments);
  };

  // Form submit interception
  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (form && form.tagName === 'FORM') {
      var action = form.getAttribute('action') || '';
      if (!action.startsWith(PROXY_BASE)) {
        form.setAttribute('action', proxify(action || CURRENT_PAGE));
      }
    }
  }, true);

  // Click interception - <a> tags
  document.addEventListener('click', function(e) {
    var el = e.target;
    while (el && el.tagName !== 'A') {
      el = el.parentElement;
    }
    if (el && el.tagName === 'A') {
      var href = el.getAttribute('href');
      if (href && !href.startsWith('javascript:') && !href.startsWith('#') && !href.startsWith(PROXY_BASE)) {
        e.preventDefault();
        window.location.href = proxify(href);
      }
    }
  }, true);

  // History API override
  var origPushState = history.pushState;
  var origReplaceState = history.replaceState;
  history.pushState = function(state, title, url) {
    if (url) url = proxify(url);
    return origPushState.call(history, state, title, url);
  };
  history.replaceState = function(state, title, url) {
    if (url) url = proxify(url);
    return origReplaceState.call(history, state, title, url);
  };

  // MutationObserver - dynamically added elements များကို rewrite လုပ်မည်
  var observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
      mutation.addedNodes.forEach(function(node) {
        if (node.nodeType === 1) { // Element node
          rewriteElementUrls(node);
          // Child elements များကိုလည်း စစ်မည်
          var children = node.querySelectorAll ? node.querySelectorAll('[src],[href],[action],[poster],[srcset]') : [];
          children.forEach(rewriteElementUrls);
        }
      });
    });
  });
  observer.observe(document.documentElement || document, { childList: true, subtree: true });

  function rewriteElementUrls(el) {
    if (!el || !el.getAttribute) return;
    ['src', 'href', 'action', 'poster'].forEach(function(attr) {
      var val = el.getAttribute(attr);
      if (val && !val.startsWith('javascript:') && !val.startsWith('data:') && !val.startsWith('#') && !val.startsWith('blob:') && !val.startsWith(PROXY_BASE)) {
        el.setAttribute(attr, proxify(val));
      }
    });
    // srcset
    var srcset = el.getAttribute('srcset');
    if (srcset) {
      var parts = srcset.split(',').map(function(part) {
        var trimmed = part.trim().split(/\\s+/);
        if (trimmed[0] && !trimmed[0].startsWith(PROXY_BASE)) {
          trimmed[0] = proxify(trimmed[0]);
        }
        return trimmed.join(' ');
      });
      el.setAttribute('srcset', parts.join(', '));
    }
  }

  // ServiceWorker registration ကို block လုပ်မည် (error မဖြစ်စေရန်)
  if (navigator.serviceWorker) {
    navigator.serviceWorker.register = function() {
      return Promise.reject(new Error('Service workers are disabled via proxy'));
    };
  }

  console.log('[Proxy] Client-side URL rewriting active');
})();
</script>
`;
}

// Home Page UI
function getHomePage() {
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Deno Fast Web Proxy</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: linear-gradient(135deg, #0f0f23 0%, #1a1a3e 50%, #2d1b69 100%); margin: 0; }
      .container { background: rgba(255,255,255,0.95); padding: 50px 40px; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); text-align: center; max-width: 520px; width: 90%; }
      h2 { margin-top: 0; color: #1a1a3e; font-size: 28px; }
      p { color: #666; margin-bottom: 25px; }
      input[type="text"] { width: 100%; padding: 14px 18px; margin-bottom: 20px; border: 2px solid #ddd; border-radius: 8px; font-size: 16px; outline: none; transition: border-color 0.3s; }
      input[type="text"]:focus { border-color: #2d1b69; }
      button { padding: 14px 36px; background: linear-gradient(135deg, #1a1a3e, #2d1b69); color: #fff; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; transition: transform 0.2s, box-shadow 0.2s; }
      button:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(45,27,105,0.4); }
      .hint { font-size: 12px; color: #999; margin-top: 15px; }
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
  </html>
  `;
}

// Server စတင် Run ခြင်း
console.log(`Proxy server running on http://localhost:${PORT}`);
Deno.serve({ port: PORT }, handler);
