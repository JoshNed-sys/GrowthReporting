// middleware.js — Vercel Edge Middleware
// Gates the whole site behind HTTP Basic Auth.
// Set DASHBOARD_USER and DASHBOARD_PASS in Vercel env vars.

export const config = {
  // Protect everything except Vercel internals and static assets like favicon.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

export default function middleware(req) {
  const USER = process.env.DASHBOARD_USER;
  const PASS = process.env.DASHBOARD_PASS;

  // If creds aren't configured, fail closed (deny) so data is never exposed.
  if (!USER || !PASS) {
    return new Response('Auth not configured', { status: 503 });
  }

  const auth = req.headers.get('authorization') || '';
  if (auth.startsWith('Basic ')) {
    try {
      const decoded = atob(auth.slice(6)); // "user:pass"
      const idx = decoded.indexOf(':');
      const user = decoded.slice(0, idx);
      const pass = decoded.slice(idx + 1);
      if (user === USER && pass === PASS) {
        return; // authorized — continue to the requested resource
      }
    } catch (e) {
      // fall through to 401
    }
  }

  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Growth Reporting", charset="UTF-8"',
    },
  });
}
