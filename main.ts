// Deno Web Proxy - Full Fix for SPA/React/Next.js Sites
// ပုံတွေပေါ်အောင်၊ Link/Button တွေနှိပ်ရအောင်၊ API calls proxy ဖြတ်အောင် ပြင်ဆင်ထားသည်
const PORT = 8000;
const PROXY_PATH_PREFIX = "/proxy/";

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const proxyOrigin = url.origin;

  // OPTIONS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
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
  let targetUrlStr = extractTargetUrl(req, url);

  if (!targetUrlStr) {
    return new Response("URL not found", { status: 400 });
  }

  // http/https prefix
  if (!/^https?:\/\//i.test(targetUrlStr)) {
    targetUrlStr = "https://" + targetUrlStr;
  }

  // Double-proxy strip
  const proxyBase = `${proxyOrigin}${PROXY_PATH_PREFIX}`;
  targetUrlStr = stripDoubleProxy(targetUrlStr, proxyBase);

  try {
    const targetUrl = new URL(targetUrlStr);

    // Request Headers
    const headers = buildRequestHeaders(req, targetUrl);

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

    // Response Headers
    const responseHeaders = buildResponseHeaders(response);

    // Redirect
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("Location");
      if (location) {
        const absoluteLocation = new URL(location, targetUrlStr).href;
        responseHeaders.set(
          "Location",
          `${proxyBase}${absoluteLocation}`
        );
      }
      return new Response(null, {
        status: response.status,
        headers: responseHeaders,
      });
    }

    // HTML - rewrite URLs + inject client script
    if (respContentType.includes("text/html")) {
      let htmlText = await response.text();
      htmlText = rewriteHtml(htmlText, targetUrlStr, proxyBase, targetUrl);
      responseHeaders.delete("Content-Length");
      responseHeaders.delete("Content-Encoding");
      responseHeaders.set("Content-Type", "text/html; charset=utf-8");
      return new Response(htmlText, {
        status: response.status,
        headers: responseHeaders,
      });
    }
    // CSS
    else if (respContentType.includes("text/css")) {
      let cssText = await response.text();
      cssText = rewriteCss(cssText, targetUrlStr, proxyBase);
      responseHeaders.delete("Content-Length");
      responseHeaders.delete("Content-Encoding");
      return new Response(cssText, {
        status: response.status,
        headers: responseHeaders,
      });
    }
    // JSON - API responses: rewrite any URLs inside
    else if (respContentType.includes("application/json")) {
      let jsonText = await response.text();
      // JSON ထဲက absolute URLs ကို proxy URL အဖြစ်ပြောင်းရန် (ပုံ URLs etc.)
      // ဒါက optional - ပုံ URLs JSON ထဲပါလာရင် rewrite လုပ်ပေးမယ်
      // သို့သော် JSON structure ကို ဖျက်ဆီးမှာ စိုးရိမ်ရသောကြောင့် မလုပ်ဘဲ ထားမယ်
      responseHeaders.delete("Content-Length");
      responseHeaders.delete("Content-Encoding");
      return new Response(jsonText, {
        status: response.status,
        headers: responseHeaders,
      });
    }
    // JavaScript
    else if (
      respContentType.includes("javascript") ||
      respContentType.includes("application/x-javascript")
    ) {
      let jsText = await response.text();
      responseHeaders.delete("Content-Length");
      responseHeaders.delete("Content-Encoding");
      return new Response(jsText, {
        status: response.status,
        headers: responseHeaders,
      });
    }
    // Binary/Stream (images, video, fonts, etc.)
    else {
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      });
    }
  } catch (error) {
    console.error("Proxy Error:", error);
    return new Response(errorPage((error as Error).message, targetUrlStr), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

// ========== Helper Functions ==========

function extractTargetUrl(req: Request, url: URL): string {
  if (url.pathname.startsWith(PROXY_PATH_PREFIX)) {
    // /proxy/ ပြီးနောက်အားလုံးကို target URL အဖြစ်ယူမည်
    // req.url ကို သုံးမည် (query string ပါအောင်)
    const idx = req.url.indexOf(PROXY_PATH_PREFIX);
    return req.url.substring(idx + PROXY_PATH_PREFIX.length);
  } else if (url.searchParams.has("url")) {
    return url.searchParams.get("url")!;
  }
  return "";
}

function stripDoubleProxy(targetUrl: string, proxyBase: string): string {
  let result = targetUrl;
  // Multiple proxy prefix ပါနေလျှင် strip
  let limit = 10;
  while (result.includes(proxyBase) && limit-- > 0) {
    result = result.replace(proxyBase, "");
  }
  // URL decoded version လည်း စစ်မည်
  try {
    let decoded = decodeURIComponent(result);
    let dlimit = 10;
    while (decoded.includes(proxyBase) && dlimit-- > 0) {
      decoded = decoded.replace(proxyBase, "");
    }
    if (decoded !== result) result = decoded;
  } catch (_) { /* ignore */ }
  return result;
}

function buildRequestHeaders(req: Request, targetUrl: URL): Headers {
  const headers = new Headers();
  headers.set("Host", targetUrl.host);
  headers.set(
    "User-Agent",
    req.headers.get("User-Agent") ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
  );
  headers.set("Accept", req.headers.get("Accept") || "*/*");
  headers.set(
    "Accept-Language",
    req.headers.get("Accept-Language") || "en-US,en;q=0.9"
  );
  headers.set("Accept-Encoding", "identity");
  headers.set("Referer", targetUrl.origin + "/");
  headers.set("Origin", targetUrl.origin);

  const cookie = req.headers.get("Cookie");
  if (cookie) headers.set("Cookie", cookie);

  const contentType = req.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);

  const range = req.headers.get("Range");
  if (range) headers.set("Range", range);

  const ifNoneMatch = req.headers.get("If-None-Match");
  if (ifNoneMatch) headers.set("If-None-Match", ifNoneMatch);

  const ifModifiedSince = req.headers.get("If-Modified-Since");
  if (ifModifiedSince) headers.set("If-Modified-Since", ifModifiedSince);

  return headers;
}

function corsHeaders(): Headers {
  const h = new Headers();
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
  h.set("Access-Control-Allow-Headers", "*");
  h.set("Access-Control-Expose-Headers", "*");
  h.set("Access-Control-Max-Age", "86400");
  return h;
}

function buildResponseHeaders(response: Response): Headers {
  const responseHeaders = new Headers();

  // Essential headers copy
  const copyList = [
    "Content-Type", "Content-Disposition", "Cache-Control", "ETag",
    "Last-Modified", "Content-Range", "Accept-Ranges", "Content-Length",
    "Vary", "Expires", "Pragma",
  ];
  for (const h of copyList) {
    const val = response.headers.get(h);
    if (val) responseHeaders.set(h, val);
  }

  // Set-Cookie forward
  try {
    const setCookies = response.headers.getSetCookie?.() || [];
    for (const sc of setCookies) {
      responseHeaders.append("Set-Cookie", sc);
    }
  } catch (_) {
    const sc = response.headers.get("Set-Cookie");
    if (sc) responseHeaders.set("Set-Cookie", sc);
  }

  // CORS
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
  responseHeaders.set("Access-Control-Allow-Headers", "*");
  responseHeaders.set("Access-Control-Expose-Headers", "*");

  // Security headers strip (proxy ဖြတ်ဖို့ အတွက်)
  responseHeaders.delete("X-Frame-Options");
  responseHeaders.delete("Content-Security-Policy");
  responseHeaders.delete("X-Content-Type-Options");
  responseHeaders.delete("Strict-Transport-Security");

  return responseHeaders;
}

// ========== URL Rewriting ==========

function shouldProxy(link: string): boolean {
  if (!link || typeof link !== "string") return false;
  const t = link.trim();
  return !/^(javascript:|data:|blob:|#|about:|mailto:|tel:)/.test(t);
}

function makeAbsoluteUrl(link: string, baseUrl: string): string | null {
  try {
    return new URL(link, baseUrl).href;
  } catch {
    return null;
  }
}

function isAlreadyProxied(link: string, proxyBase: string): boolean {
  return link.includes(proxyBase) || link.includes("/proxy/http");
}

// HTML Rewrite
function rewriteHtml(
  html: string,
  baseUrl: string,
  proxyBase: string,
  targetUrl: URL
): string {
  const baseOrigin = targetUrl.origin;

  // <base> tag ဖယ်ရှား
  html = html.replace(/<base\s[^>]*>/gi, "");

  // integrity, nonce, crossorigin attributes ဖယ်ရှား
  html = html.replace(/\s+integrity\s*=\s*["'][^"']*["']/gi, "");
  html = html.replace(/\s+nonce\s*=\s*["'][^"']*["']/gi, "");
  html = html.replace(/\s+crossorigin(?:\s*=\s*["'][^"']*["'])?/gi, "");

  // CSP meta tags ဖယ်ရှား
  html = html.replace(
    /<meta\s+http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi,
    ""
  );

  // href, src, action, poster, data attributes rewrite
  html = html.replace(
    /((?:href|src|action|poster|data)\s*=\s*)(["'])([^"']*?)\2/gi,
    (_m, prefix, quote, link) => {
      if (!shouldProxy(link) || isAlreadyProxied(link, proxyBase)) {
        return `${prefix}${quote}${link}${quote}`;
      }
      const abs = makeAbsoluteUrl(link, baseUrl);
      if (abs) return `${prefix}${quote}${proxyBase}${abs}${quote}`;
      return `${prefix}${quote}${link}${quote}`;
    }
  );

  // srcset rewrite
  html = html.replace(
    /(srcset\s*=\s*)(["'])([^"']*?)\2/gi,
    (_m, prefix, quote, val) => {
      const parts = val.split(",").map((part: string) => {
        const trimmed = part.trim();
        if (!trimmed) return trimmed;
        const spaceIdx = trimmed.search(/\s/);
        let urlPart = spaceIdx === -1 ? trimmed : trimmed.substring(0, spaceIdx);
        const descriptor = spaceIdx === -1 ? "" : trimmed.substring(spaceIdx);
        if (!shouldProxy(urlPart) || isAlreadyProxied(urlPart, proxyBase)) {
          return trimmed;
        }
        const abs = makeAbsoluteUrl(urlPart, baseUrl);
        return abs ? `${proxyBase}${abs}${descriptor}` : trimmed;
      });
      return `${prefix}${quote}${parts.join(", ")}${quote}`;
    }
  );

  // Inline style url() rewrite
  html = html.replace(
    /(style\s*=\s*)(["'])([^"']*?)\2/gi,
    (_m, prefix, quote, val) => {
      const rewritten = rewriteCssUrls(val, baseUrl, proxyBase);
      return `${prefix}${quote}${rewritten}${quote}`;
    }
  );

  // <style> tags rewrite
  html = html.replace(
    /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_m, open, css, close) => open + rewriteCss(css, baseUrl, proxyBase) + close
  );

  // meta refresh
  html = html.replace(
    /(<meta\s+http-equiv\s*=\s*["']refresh["'][^>]*content\s*=\s*["']\d+;\s*url=)([^"']+)(["'][^>]*>)/gi,
    (_m, before, link, after) => {
      const abs = makeAbsoluteUrl(link, baseUrl);
      return abs ? `${before}${proxyBase}${abs}${after}` : `${before}${link}${after}`;
    }
  );

  // Inject client-side script - *** အရေးကြီးဆုံး ***
  const script = getInjectedScript(proxyBase, baseOrigin, baseUrl);

  // <head> ရှာပြီး inject - script ကို အရင်ဆုံးထည့်ဖို့ အရေးကြီး
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch) {
    const idx = html.indexOf(headMatch[0]) + headMatch[0].length;
    html = html.slice(0, idx) + script + html.slice(idx);
  } else {
    const htmlMatch = html.match(/<html[^>]*>/i);
    if (htmlMatch) {
      const idx = html.indexOf(htmlMatch[0]) + htmlMatch[0].length;
      html = html.slice(0, idx) + "<head>" + script + "</head>" + html.slice(idx);
    } else {
      html = script + html;
    }
  }

  return html;
}

// CSS Rewrite
function rewriteCss(css: string, baseUrl: string, proxyBase: string): string {
  css = rewriteCssUrls(css, baseUrl, proxyBase);
  css = css.replace(/@import\s+["']([^"']+)["']/gi, (_m, link) => {
    if (!shouldProxy(link) || isAlreadyProxied(link, proxyBase)) return _m;
    const abs = makeAbsoluteUrl(link, baseUrl);
    return abs ? `@import "${proxyBase}${abs}"` : _m;
  });
  css = css.replace(/@import\s+url\(\s*["']?([^"')]+)["']?\s*\)/gi, (_m, link) => {
    if (!shouldProxy(link) || isAlreadyProxied(link, proxyBase)) return _m;
    const abs = makeAbsoluteUrl(link, baseUrl);
    return abs ? `@import url("${proxyBase}${abs}")` : _m;
  });
  return css;
}

function rewriteCssUrls(css: string, baseUrl: string, proxyBase: string): string {
  return css.replace(/url\(\s*["']?([^"')]+?)["']?\s*\)/gi, (_m, link) => {
    if (!shouldProxy(link) || isAlreadyProxied(link, proxyBase)) return `url("${link}")`;
    const abs = makeAbsoluteUrl(link, baseUrl);
    return abs ? `url("${proxyBase}${abs}")` : `url("${link}")`;
  });
}

// ========== Client-Side Script Injection ==========
// *** ဒီ script က SPA sites အတွက် အရေးအကြီးဆုံး ***
function getInjectedScript(proxyBase: string, baseOrigin: string, currentPageUrl: string): string {
  // JSON.stringify သုံးပြီး values ကို safe escape လုပ်မည်
  // </script> issue ကို \x3c/script> ဖြင့် ရှောင်မည်
  return `<script>
(function(){
'use strict';
var PROXY_BASE=${JSON.stringify(proxyBase)};
var TARGET_ORIGIN=${JSON.stringify(baseOrigin)};
var CURRENT_PAGE=${JSON.stringify(currentPageUrl)};

function proxify(u){
  if(!u||typeof u!=='string')return u;
  u=u.trim();
  if(/^(javascript:|data:|blob:|#|about:|mailto:|tel:)/i.test(u))return u;
  if(u.indexOf(PROXY_BASE)===0)return u;
  if(u.indexOf('/proxy/http')!==-1)return u;
  try{
    var a=new URL(u,CURRENT_PAGE).href;
    return PROXY_BASE+a;
  }catch(e){return u;}
}

// === *** fetch override - framework JS load မလုပ်ခင် override *** ===
var OF=window.fetch;
window.fetch=function(input,init){
  if(typeof input==='string'){
    input=proxify(input);
  }else if(input&&typeof input==='object'){
    try{
      var ur=input.url||input.href||'';
      if(ur){input=new Request(proxify(ur),input);}
    }catch(e){}
  }
  return OF.call(window,input,init);
};

// === XMLHttpRequest override ===
var OX=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(){
  if(arguments.length>=2&&typeof arguments[1]==='string'){
    arguments[1]=proxify(arguments[1]);
  }
  return OX.apply(this,arguments);
};

// === window.open override ===
var OW=window.open;
window.open=function(u,n,f){return OW.call(window,u?proxify(u):u,n,f);};

// === History API ===
var OP=history.pushState,OR=history.replaceState;
history.pushState=function(s,t,u){if(u&&typeof u==='string')u=proxify(u);return OP.call(history,s,t,u);};
history.replaceState=function(s,t,u){if(u&&typeof u==='string')u=proxify(u);return OR.call(history,s,t,u);};

// === EventSource override (SSE) ===
if(window.EventSource){
  var OES=window.EventSource;
  window.EventSource=function(u,c){return new OES(proxify(u),c);};
  window.EventSource.prototype=OES.prototype;
}

// === WebSocket - origin header fix (limited) ===

// === Property overrides for dynamic element creation ===
function overrideProp(proto,prop){
  try{
    var d=Object.getOwnPropertyDescriptor(proto,prop);
    if(!d||!d.set)return;
    var oSet=d.set,oGet=d.get;
    Object.defineProperty(proto,prop,{
      get:oGet,
      set:function(v){
        if(typeof v==='string'&&v&&!/^(javascript:|data:|blob:|#|about:)/i.test(v)){
          if(v.indexOf(PROXY_BASE)!==0&&v.indexOf('/proxy/http')===-1){
            v=proxify(v);
          }
        }
        oSet.call(this,v);
      },
      enumerable:true,configurable:true
    });
  }catch(e){}
}

// Image, Script, Link, Iframe, Video, Audio, Source, Anchor, Form
var overrides=[
  [HTMLImageElement,'src'],[HTMLScriptElement,'src'],[HTMLLinkElement,'href'],
  [HTMLIFrameElement,'src'],[HTMLVideoElement,'src'],[HTMLVideoElement,'poster'],
  [HTMLAudioElement,'src'],[HTMLSourceElement,'src'],[HTMLSourceElement,'srcset'],
  [HTMLAnchorElement,'href'],[HTMLFormElement,'action']
];
for(var i=0;i<overrides.length;i++){
  try{overrideProp(overrides[i][0].prototype,overrides[i][1]);}catch(e){}
}

// === Element.setAttribute override ===
var origSetAttr=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(name,value){
  var n=name.toLowerCase();
  if((n==='src'||n==='href'||n==='action'||n==='poster'||n==='data')
    &&typeof value==='string'&&value
    &&!/^(javascript:|data:|blob:|#|about:|mailto:|tel:)/i.test(value)
    &&value.indexOf(PROXY_BASE)!==0
    &&value.indexOf('/proxy/http')===-1){
    value=proxify(value);
  }
  if(n==='srcset'&&typeof value==='string'&&value){
    try{
      value=value.split(',').map(function(p){
        var t=p.trim().split(/\\s+/);
        if(t[0]&&t[0].indexOf(PROXY_BASE)!==0&&t[0].indexOf('/proxy/http')===-1){
          t[0]=proxify(t[0]);
        }
        return t.join(' ');
      }).join(', ');
    }catch(e){}
  }
  return origSetAttr.call(this,name,value);
};

// === document.write/writeln override ===
// SPA frameworks တစ်ခါတစ်ရံ document.write သုံးတတ်
// (ဒီမှာ skip - ပြဿနာရှာရင် ထပ်ထည့်)

// === createElement intercept - না ===
// setAttribute override လုပ်ထားပြီးဖြစ်သည့်အတွက် createElement ကို override မလိုပါ

// === Form submit ===
document.addEventListener('submit',function(e){
  var f=e.target;
  if(f&&f.tagName==='FORM'){
    var a=f.getAttribute('action')||'';
    if(!a||a.indexOf(PROXY_BASE)!==0){
      f.setAttribute('action',proxify(a||CURRENT_PAGE));
    }
  }
},true);

// === Click handler ===
document.addEventListener('click',function(e){
  var el=e.target;
  var max=15;
  while(el&&el.tagName!=='A'&&max-->0)el=el.parentElement;
  if(el&&el.tagName==='A'){
    var hr=el.getAttribute('href');
    if(hr&&!/^(javascript:|#|data:|blob:|mailto:|tel:)/i.test(hr.trim())){
      if(hr.indexOf(PROXY_BASE)!==0&&hr.indexOf('/proxy/http')===-1){
        e.preventDefault();
        e.stopPropagation();
        window.location.href=proxify(hr);
        return false;
      }
    }
  }
},true);

// === MutationObserver ===
function rewriteEl(el){
  if(!el||!el.getAttribute)return;
  var attrs=['src','href','action','poster','data'];
  for(var i=0;i<attrs.length;i++){
    var v=el.getAttribute(attrs[i]);
    if(v&&!/^(javascript:|data:|blob:|#|about:|mailto:|tel:)/i.test(v.trim())
      &&v.indexOf(PROXY_BASE)!==0&&v.indexOf('/proxy/http')===-1){
      try{origSetAttr.call(el,attrs[i],proxify(v));}catch(e){}
    }
  }
  var ss=el.getAttribute('srcset');
  if(ss){
    try{
      var parts=ss.split(',').map(function(p){
        var t=p.trim().split(/\\s+/);
        if(t[0]&&t[0].indexOf(PROXY_BASE)!==0&&t[0].indexOf('/proxy/http')===-1){
          t[0]=proxify(t[0]);
        }
        return t.join(' ');
      });
      origSetAttr.call(el,'srcset',parts.join(', '));
    }catch(e){}
  }
}

function rewriteTree(root){
  if(!root)return;
  rewriteEl(root);
  try{
    var els=root.querySelectorAll('[src],[href],[action],[poster],[data],[srcset]');
    for(var i=0;i<els.length;i++)rewriteEl(els[i]);
  }catch(e){}
}

var pending=[],timer=null;
var mo=new MutationObserver(function(muts){
  for(var i=0;i<muts.length;i++){
    var m=muts[i];
    if(m.addedNodes){
      for(var j=0;j<m.addedNodes.length;j++){
        if(m.addedNodes[j].nodeType===1)pending.push(m.addedNodes[j]);
      }
    }
    if(m.type==='attributes'&&m.target&&m.target.nodeType===1){
      pending.push(m.target);
    }
  }
  if(!timer){
    timer=requestAnimationFrame(function(){
      var nodes=pending.splice(0);
      for(var k=0;k<nodes.length;k++)rewriteTree(nodes[k]);
      timer=null;
    });
  }
});

if(document.documentElement){
  mo.observe(document.documentElement,{
    childList:true,subtree:true,
    attributes:true,
    attributeFilter:['src','href','action','poster','data','srcset','style']
  });
}

// === ServiceWorker block ===
try{
  Object.defineProperty(navigator,'serviceWorker',{
    get:function(){return{
      register:function(){return Promise.reject(new Error('SW disabled'));},
      getRegistrations:function(){return Promise.resolve([]);},
      ready:Promise.resolve({unregister:function(){return Promise.resolve(true);}})
    };},configurable:true
  });
}catch(e){}

// === postMessage fix ===
var OPM=window.postMessage;
window.postMessage=function(msg,origin,transfer){
  if(origin&&origin!=='*')origin='*';
  return OPM.call(window,msg,origin,transfer);
};

// === document.domain fix ===
try{
  Object.defineProperty(document,'domain',{
    get:function(){return TARGET_ORIGIN.replace(/^https?:\\/\\//,'').replace(/:\\d+$/,'');},
    set:function(){},
    configurable:true
  });
}catch(e){}

// === location overrides (limited - cannot fully override location) ===
// location.assign / location.replace
try{
  var oAssign=location.assign.bind(location);
  var oReplace=location.replace.bind(location);
  location.assign=function(u){oAssign(proxify(u));};
  location.replace=function(u){oReplace(proxify(u));};
}catch(e){}

// === DOMContentLoaded / load event rewrite ===
function fullRewrite(){rewriteTree(document.documentElement);}
if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',fullRewrite);
}else{
  setTimeout(fullRewrite,0);
}
window.addEventListener('load',function(){
  setTimeout(fullRewrite,100);
  setTimeout(fullRewrite,500);
  setTimeout(fullRewrite,1500);
  setTimeout(fullRewrite,3000);
});

console.log('[Proxy] SPA-compatible rewriting active');
})();
<\/script>`;
}

// ========== Home Page ==========
function getHomePage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Deno Web Proxy</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:linear-gradient(135deg,#0f0f23,#1a1a3e 50%,#2d1b69)}
.c{background:rgba(255,255,255,.95);padding:50px 40px;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.3);text-align:center;max-width:520px;width:90%}
h2{color:#1a1a3e;font-size:28px;margin-bottom:10px}
p{color:#666;margin-bottom:25px}
input[type=text]{width:100%;padding:14px 18px;margin-bottom:20px;border:2px solid #ddd;border-radius:8px;font-size:16px;outline:none;transition:border-color .3s}
input[type=text]:focus{border-color:#2d1b69}
button{padding:14px 36px;background:linear-gradient(135deg,#1a1a3e,#2d1b69);color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;transition:transform .2s,box-shadow .2s}
button:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(45,27,105,.4)}
.h{font-size:12px;color:#999;margin-top:15px}
.f{text-align:left;margin:20px 0;padding:15px;background:#f8f8ff;border-radius:8px}
.f div{padding:4px 0;color:#555;font-size:14px}
</style>
</head>
<body>
<div class="c">
<h2>Deno Web Proxy</h2>
<p>Enter a URL to browse freely</p>
<form onsubmit="go(event)">
<input type="text" id="u" placeholder="https://www.google.com" required autocomplete="off" autofocus>
<br><button type="submit">Browse</button>
</form>
<div class="f">
<div>&#10003; SPA / React / Next.js sites supported</div>
<div>&#10003; Images &amp; Media loading</div>
<div>&#10003; Dynamic content &amp; API calls</div>
<div>&#10003; Links &amp; Navigation working</div>
<div>&#10003; Download links supported</div>
</div>
<p class="h">Example: https://www.homietv.com, https://www.google.com</p>
</div>
<script>
function go(e){
  e.preventDefault();
  var u=document.getElementById('u').value.trim();
  if(!/^https?:\\/\\//i.test(u))u='https://'+u;
  window.location.href='/proxy/'+u;
}
</script>
</body>
</html>`;
}

function errorPage(msg: string, url: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proxy Error</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:#1a1a2e;color:#fff}a{color:#4fc3f7}pre{text-align:left;background:#2a2a4e;padding:15px;border-radius:8px;overflow-x:auto;margin:20px auto;max-width:600px}</style></head>
<body><h2>Proxy Error</h2><pre>${msg}</pre><p>URL: ${url}</p><a href="/">Back to Home</a></body></html>`;
}

// ========== Start Server ==========
console.log(`Proxy running on http://localhost:${PORT}`);
Deno.serve({ port: PORT }, handler);
