// Deno ၏ Built-in Server ကို အသုံးပြုခြင်း
const PORT = 8000;
const PROXY_PATH_PREFIX = "/proxy/";

// Proxy အလုပ်လုပ်မည့် Main Function
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Home Page (URL ထည့်ရန် Form ပြမည်)
  if (url.pathname === "/" && !url.searchParams.has("url")) {
    return new Response(getHomePage(), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // User က Form ကနေ URL ထည့်လိုက်လျှင် သို့မဟုတ် /proxy/ လမ်းကြောင်းသို့ ဝင်လာလျှင်
  let targetUrlStr = "";
  if (url.searchParams.has("url")) {
    targetUrlStr = url.searchParams.get("url")!;
  } else if (url.pathname.startsWith(PROXY_PATH_PREFIX)) {
    targetUrlStr = req.url.substring(req.url.indexOf(PROXY_PATH_PREFIX) + PROXY_PATH_PREFIX.length);
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
    
    // Header များ ပြင်ဆင်ခြင်း (User-Agent ကို ပုံမှန် Browser အတိုင်းဖြစ်စေရန်)
    const headers = new Headers(req.headers);
    headers.set("Host", targetUrl.host);
    headers.delete("Origin");
    headers.delete("Referer");
    headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    // ပစ်မှတ် Website သို့ လှမ်း၍ Fetch လုပ်ခြင်း
    const proxyReq = new Request(targetUrlStr, {
      method: req.method,
      headers: headers,
      body: req.body,
      redirect: "manual", // Redirect များကို ကိုယ်တိုင် Handle လုပ်ရန်
    });

    const response = await fetch(proxyReq);
    const contentType = response.headers.get("Content-Type") || "";

    // Proxy မှ ပြန်ပို့မည့် Header များ ပြင်ဆင်ခြင်း
    const responseHeaders = new Headers(response.headers);
    // လုံခြုံရေးတားမြစ်ချက်များကို ဖျက်ပစ်မည် (ဥပမာ - ကြည့်ခွင့်ပိတ်ထားခြင်းများ)
    responseHeaders.delete("Content-Security-Policy");
    responseHeaders.delete("X-Frame-Options");
    responseHeaders.delete("Access-Control-Allow-Origin");
    responseHeaders.set("Access-Control-Allow-Origin", "*");

    // Redirect လုပ်ခိုင်းပါက Proxy လမ်းကြောင်းဖြင့်သာ Redirect လုပ်စေမည်
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = responseHeaders.get("Location");
      if (location) {
        const absoluteLocation = new URL(location, targetUrlStr).href;
        responseHeaders.set("Location", `${url.origin}${PROXY_PATH_PREFIX}${absoluteLocation}`);
      }
      return new Response(null, {
        status: response.status,
        headers: responseHeaders,
      });
    }

    // HTML ဖိုင်ဖြစ်ပါက အတွင်းရှိ Link များကို Rewrite လုပ်မည်
    if (contentType.includes("text/html")) {
      let htmlText = await response.text();
      const proxyBaseUrl = `${url.origin}${PROXY_PATH_PREFIX}`;
      
      htmlText = rewriteLinks(htmlText, targetUrlStr, proxyBaseUrl);
      
      return new Response(htmlText, {
        status: response.status,
        headers: responseHeaders,
      });
    } else {
      // ရုပ်ရှင် ဗီဒီယိုများ (Streaming), ပုံများ, Download ဖိုင်များဖြစ်ပါက
      // Stream အတိုင်း တိုက်ရိုက် ပြန်လွှတ်ပေးမည် (Deno ၏ အားသာချက်)
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      });
    }
  } catch (error) {
    return new Response(`Error: ${(error as Error).message}`, { status: 500 });
  }
}

// HTML အတွင်းရှိ Link များကို ပြင်ဆင်ပေးသော Function
function rewriteLinks(html: string, baseUrl: string, proxyBaseUrl: string): string {
  // href, src, action အစရှိသော attribute များကို ရှာမည်
  const linkRegex = /(href|src|action)=["']([^"']+)["']/gi;
  
  return html.replace(linkRegex, (match, attr, link) => {
    // javascript: data: # တို့ဖြင့် စသော Link များကို မပြင်ပါ
    if (link.startsWith("javascript:") || link.startsWith("data:") || link.startsWith("#")) {
      return match;
    }

    try {
      // Relative link (/images/logo.png) ကို Absolute link အဖြစ် ပြောင်းခြင်း
      const absoluteUrl = new URL(link, baseUrl).href;
      // Proxy URL ဖြင့် အစားထိုးခြင်း
      const proxifiedUrl = proxyBaseUrl + absoluteUrl;
      return `${attr}="${proxifiedUrl}"`;
    } catch {
      // URL Parse လုပ်၍မရပါက မူလအတိုင်းထားမည်
      return match;
    }
  });
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
      body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background-color: #f0f2f5; margin: 0; }
      .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; }
      input[type="text"] { width: 80%; padding: 12px; margin-bottom: 20px; border: 1px solid #ccc; border-radius: 5px; font-size: 16px; }
      button { padding: 12px 24px; background: #000; color: #fff; border: none; border-radius: 5px; font-size: 16px; cursor: pointer; }
      button:hover { background: #333; }
    </style>
  </head>
  <body>
    <div class="container">
      <h2>Deno Web Proxy</h2>
      <p>Enter a URL to browse without VPN</p>
      <form action="/proxy/" method="GET" onsubmit="event.preventDefault(); window.location.href='/proxy/' + document.getElementById('url').value;">
        <input type="text" id="url" name="url" placeholder="https://google.com" required>
        <br>
        <button type="submit">Browse</button>
      </form>
    </div>
  </body>
  </html>
  `;
}

// Server စတင် Run ခြင်း
Deno.serve({ port: PORT }, handler);
