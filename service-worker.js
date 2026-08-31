const CACHE_NAME = "lucky-chat-pwa-v3";
const OFFLINE_URL = "/offline.html";

const PRECACHE_URLS = [
    OFFLINE_URL,
    "/static/pwa/icon-192.png",
    "/static/pwa/icon-512.png"
];

const NETWORK_ONLY_PREFIXES = [
    "/api/",
    "/online",
    "/dashboard-data",
    "/dashboard_ws",
    "/statuses",
    "/status/",
    "/upload-status",
    "/pinned-chats",
    "/send-message",
    "/send_message",
    "/send/",
    "/view-status",
    "/view_status",
    "/seen-status",
    "/status-view",
    "/status-viewers",
    "/like-status",
    "/status-like",
    "/react-status",
    "/delete-status",
    "/chat/"
];

const NETWORK_ONLY_EXACT = new Set([
    "/send",
    "/login",
    "/logout",
    "/settings"
]);

function isSameOrigin(url) {
    return url.origin === self.location.origin;
}

function isNetworkOnlyPath(pathname) {
    if (NETWORK_ONLY_EXACT.has(pathname)) return true;
    if (pathname.includes("_ws")) return true;
    return NETWORK_ONLY_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

function isPrecacheableStatic(pathname) {
    if (pathname === "/manifest.json" || pathname === OFFLINE_URL) return true;
    if (!pathname.startsWith("/static/")) return false;
    if (pathname === "/static/js/crypto.core.js") return false;
    return true;
}

async function putInCache(request, response) {
    if (!response || !response.ok || response.status === 206) return;
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
}

async function networkFirst(request, fallbackUrl) {
    try {
        const response = await fetch(request, { cache: "no-store" });
        if (response && response.ok) {
            await putInCache(request, response);
        }
        return response;
    } catch (error) {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (fallbackUrl) {
            const offline = await caches.match(fallbackUrl);
            if (offline) return offline;
        }
        throw error;
    }
}

async function staleWhileRevalidate(request) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);

    const networkPromise = fetch(request).then(response => {
        if (response && response.ok) {
            cache.put(request, response.clone()).catch(() => {});
        }
        return response;
    }).catch(() => cached);

    return cached || networkPromise;
}

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS))
    );
    self.skipWaiting();
});

self.addEventListener("activate", event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(
            keys
                .filter(key => key !== CACHE_NAME)
                .map(key => caches.delete(key))
        );
        await self.clients.claim();
    })());
});

self.addEventListener("message", event => {
    const data = event.data;
    const type = data && typeof data === "object" ? data.type : data;
    if (type === "SKIP_WAITING") {
        self.skipWaiting();
    }
});

self.addEventListener("fetch", event => {
    const request = event.request;
    if (request.method !== "GET") return;

    const url = new URL(request.url);

    if (!isSameOrigin(url)) return;
    if (url.pathname === "/service-worker.js") return;
    if (isNetworkOnlyPath(url.pathname)) return;

    if (request.mode === "navigate") {
        event.respondWith(networkFirst(request, OFFLINE_URL));
        return;
    }

    if (url.pathname === "/static/js/crypto.core.js") {
        event.respondWith(networkFirst(request));
        return;
    }

    if (isPrecacheableStatic(url.pathname)) {
        event.respondWith(staleWhileRevalidate(request));
    }
});

self.addEventListener("push", event => {
    event.waitUntil((async () => {
        let data = {
            title: "Lucky Chat",
            body: "You received a new message.",
            icon: "/static/pwa/icon-192.png"
        };

        try {
            if (event.data) {
                const parsed = event.data.json();
                if (parsed && typeof parsed === "object") {
                    data = { ...data, ...parsed };
                }
            }
        } catch (_error) {
            try {
                const text = event.data && event.data.text();
                if (text) data.body = text;
            } catch (_textError) {}
        }

        await self.registration.showNotification(data.title || "Lucky Chat", {
            body: data.body || "You received a new message.",
            icon: data.icon || "/static/pwa/icon-192.png",
            badge: "/static/pwa/icon-192.png",
            vibrate: [200, 100, 200]
        });
    })());
});

self.addEventListener("notificationclick", event => {
    event.notification.close();

    event.waitUntil((async () => {
        const allClients = await clients.matchAll({
            type: "window",
            includeUncontrolled: true
        });
        const existing = allClients.find(client => client.url && "focus" in client);
        if (existing) {
            await existing.focus();
            return;
        }
        await clients.openWindow("/");
    })());
});
