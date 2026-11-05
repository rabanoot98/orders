// Online PWA: keep the same live Supabase connection as the website.
// No Cache Storage and no offline order queue. Local files always use the network.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin
      || !url.href.startsWith(self.registration.scope)) return;

  event.respondWith(fetch(request, { cache: 'no-store' }).catch(error => {
    if (request.mode !== 'navigate') throw error;
    return new Response(`<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#1c1c2e"><title>אין חיבור לאינטרנט — רבנות 98</title>
<style>body{margin:0;padding:32px;font-family:Arial,sans-serif;background:#f0ede8;color:#1c1c2e;display:grid;place-items:center;min-height:80vh;box-sizing:border-box;text-align:center}main{max-width:360px}h1{font-size:1.5rem}p{line-height:1.8}a{display:inline-block;margin-top:12px;padding:14px 24px;background:#1c1c2e;color:#fff;border-radius:12px;text-decoration:none}</style>
</head><body><main><h1>אין חיבור לאינטרנט</h1>
<p>מערכת ההזמנות צריכה חיבור לאינטרנט כדי להציג מלאי והזמנות עדכניים. בדקו את החיבור ונסו שוב.</p>
<a href="./">ניסיון נוסף</a></main></body></html>`, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }));
});
