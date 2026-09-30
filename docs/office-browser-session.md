# Persistent office browser session

The office pairs once per browser profile using POST /api/web/session/pair. The response contains only authenticated:true and sets __Host-AgentOffice with Secure, HttpOnly, SameSite=Strict, Path=/ and a 30-day Max-Age matching the existing native device lifetime. There is no localStorage/sessionStorage token. Existing native Keychain sessions and legacy bearer /api/web/pair remain compatible.

GET /api/web/session restores the login; requests require same-origin Fetch Metadata and matching Origin on mutations. POST /api/web/session/logout revokes only the current device and expires the cookie. Native routes still require bearer auth and do not consume cookies. Unrelated cookies are ignored. Duplicate office cookies are rejected. Expiry/owner revocation clears office state so a new device cannot replay a pending request owned by the previous device.

The macOS office uses a persistent default WKWebsiteDataStore, so this same cookie can survive app restarts. Browser profiles do not share sessions automatically. Reauthentication remains necessary after 30 days, explicit logout/revocation, or clearing browser data. No indefinite session or automatic renewal is claimed.

Validation: 6 native/API tests (99 assertions), 17 office tests (630 assertions), TypeScript/Vite build, 4 browser scenarios including reload/profile restoration, actual HTTPS Set-Cookie acceptance and outgoing Cookie header, logout, interrupted sends, and role navigation. Browser transport is mocked; live deployment acceptance and physical WKWebView restart remain pending.
