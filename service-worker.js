const CACHE_NAME = "lucky-chat-pwa-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache =>
            cache.addAll([
                OFFLINE_URL,
                "/static/pwa/icon-192.png",
                "/static/pwa/icon-512.png"
            ])
        )
    );

    self.skipWaiting();
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys
                    .filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            )
        )
    );

    self.clients.claim();
});

self.addEventListener("fetch", event => {
    const request = event.request;

    if (request.method !== "GET") return;

    const url = new URL(request.url);

    // Don't cache private/API/WebSocket traffic.
    if (
        url.origin !== self.location.origin ||
        url.pathname.startsWith("/api/") ||
        url.pathname.startsWith("/online") ||
        url.pathname.startsWith("/dashboard-data") ||
        url.pathname.startsWith("/statuses") ||
        url.pathname.startsWith("/upload-status") ||
        url.pathname.startsWith("/pinned-chats") ||
        url.pathname.includes("_ws")
    ) {
        return;
    }

    // Keep private pages network-first.
    if (request.mode === "navigate") {
        event.respondWith(
            fetch(request).catch(() => caches.match(OFFLINE_URL))
        );
        return;
    }

    // Cache static/PWA resources.
    if (
        url.pathname.startsWith("/static/") ||
        url.pathname === "/manifest.json" ||
        url.pathname === "/offline.html"
    ) {
        event.respondWith(
            caches.match(request).then(cached => {
                if (cached) return cached;

                return fetch(request).then(response => {
                    if (response && response.ok) {
                        const copy = response.clone();

                        caches.open(CACHE_NAME).then(cache => {
                            cache.put(request, copy);
                        });
                    }

                    return response;
                });
            })
        );
    }
});

self.addEventListener("push", event => {
    const data = event.data
        ? event.data.json()
        : {
            title: "Lucky Chat",
            body: "You received a new message.",
            icon: "/static/pwa/icon-192.png"
        };

    event.waitUntil(
        self.registration.showNotification(data.title, {
            body: data.body,
            icon: data.icon,
            badge: "/static/pwa/icon-192.png",
            vibrate: [200, 100, 200]
        })
    );
});

self.addEventListener("notificationclick", event => {
    event.notification.close();

    event.waitUntil(
        clients.openWindow("/")
    );
});
