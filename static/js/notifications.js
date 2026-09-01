(() => {
    "use strict";

    const SETTING_KEY = "lucky_setting_notifications";
    let registrationPromise = null;
    let syncPromise = null;

    function notificationsEnabled() {
        return localStorage.getItem(SETTING_KEY) !== "0";
    }

    function urlBase64ToUint8Array(value) {
        const padding = "=".repeat((4 - (value.length % 4)) % 4);
        const base64 = (value + padding)
            .replace(/-/g, "+")
            .replace(/_/g, "/");

        const raw = atob(base64);
        const bytes = new Uint8Array(raw.length);

        for (let i = 0; i < raw.length; i += 1) {
            bytes[i] = raw.charCodeAt(i);
        }

        return bytes;
    }

    async function getRegistration() {
        if (!("serviceWorker" in navigator)) return null;

        if (!registrationPromise) {
            registrationPromise = navigator.serviceWorker
                .getRegistration("/")
                .then(existing => {
                    if (existing) return existing;

                    return navigator.serviceWorker.register(
                        "/service-worker.js",
                        {scope: "/"}
                    );
                })
                .then(async registration => {
                    await navigator.serviceWorker.ready;
                    return registration;
                })
                .catch(error => {
                    registrationPromise = null;
                    throw error;
                });
        }

        return registrationPromise;
    }

    async function getPushConfig() {
        const response = await fetch("/push/config", {
            credentials: "same-origin",
            cache: "no-store"
        });

        if (!response.ok) {
            throw new Error("Push configuration request failed.");
        }

        const data = await response.json();

        if (!data?.success) {
            throw new Error(data?.error || "Push notifications are unavailable.");
        }

        return data;
    }

    async function saveSubscription(subscription) {
        const response = await fetch("/subscribe", {
            method: "POST",
            credentials: "same-origin",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                subscription: subscription.toJSON()
            })
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok || data.success !== true) {
            throw new Error(
                data.error || "Could not save push subscription."
            );
        }
    }

    async function sync({requestPermission = false} = {}) {
        const fail = message => {
            console.error("[Lucky Push Diagnostic]", message);
            try {
                window.alert("Lucky Chat push diagnostic:\n\n" + message);
            } catch (_) {}
            return false;
        };

        if (syncPromise) return syncPromise;

        if (!notificationsEnabled()) {
            return fail("Notifications setting is OFF.");
        }

        if (!("Notification" in window)) {
            return fail("Notification API is not available in this browser.");
        }

        if (!("PushManager" in window)) {
            return fail("PushManager is not available in this browser.");
        }

        if (!("serviceWorker" in navigator)) {
            return fail("Service Worker API is not available in this browser.");
        }

        syncPromise = (async () => {
            try {
                const config = await getPushConfig();

                if (!config.enabled) {
                    return fail("/push/config says enabled=false.");
                }

                if (!config.public_key) {
                    return fail("/push/config returned no VAPID public key.");
                }

                let permission = Notification.permission;

                // Never surprise the user with a permission prompt on page load.
                if (permission === "default" && requestPermission) {
                    permission = await Notification.requestPermission();
                }

                if (permission !== "granted") {
                    return fail(
                        "Notification.permission is " + JSON.stringify(permission) + "."
                    );
                }

                const registration = await getRegistration();
                if (!registration) {
                    return fail("Service worker registration is unavailable.");
                }

                let subscription =
                    await registration.pushManager.getSubscription();

                if (subscription) {
                    console.info("[Lucky Push Diagnostic] Existing subscription found.");
                } else {
                    console.info("[Lucky Push Diagnostic] No subscription; creating one.");
                    subscription = await registration.pushManager.subscribe({
                        userVisibleOnly: true,
                        applicationServerKey:
                            urlBase64ToUint8Array(config.public_key)
                    });
                    console.info("[Lucky Push Diagnostic] PushSubscription created.");
                }

                await saveSubscription(subscription);
                console.info("[Lucky Push Diagnostic] POST /subscribe succeeded.");
                return true;

            } catch (error) {
                const message = error && error.message
                    ? error.message
                    : String(error || "Unknown error");

                console.error(
                    "Lucky Chat push notification setup unavailable:",
                    error
                );

                try {
                    window.alert(
                        "Lucky Chat push diagnostic failed:\n\n" +
                        message
                    );
                } catch (_) {}

                return false;
            } finally {
                syncPromise = null;
            }
        })();

        return syncPromise;
    }

    async function unsubscribe() {
        try {
            const registration = await getRegistration();
            const subscription =
                await registration?.pushManager?.getSubscription();

            if (!subscription) return true;

            await fetch("/subscribe", {
                method: "DELETE",
                credentials: "same-origin",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(subscription.toJSON())
            }).catch(() => {});

            await subscription.unsubscribe().catch(() => {});
            return true;

        } catch (error) {
            console.debug(
                "Lucky Chat push unsubscribe unavailable:",
                error
            );
            return false;
        }
    }

    async function showLocalNotification(sender, body, target) {
        if (!notificationsEnabled()) return;
        if (!("Notification" in window)) return;
        if (Notification.permission !== "granted") return;
        if (document.visibilityState === "visible") return;

        try {
            const registration = await getRegistration();

            if (registration?.showNotification) {
                await registration.showNotification(
                    sender || "Lucky Chat",
                    {
                        body: body || "New message",
                        icon: "/static/pwa/icon-192.png",
                        badge: "/static/pwa/icon-192.png",
                        tag: `lucky-local-${sender || "chat"}`,
                        data: {
                            url: target || "/"
                        }
                    }
                );
                return;
            }
        } catch (error) {
            console.debug(
                "Service-worker local notification failed:",
                error
            );
        }

        // Final browser fallback for browsers whose SW notification API
        // is unavailable.
        try {
            const notification = new Notification(
                sender || "Lucky Chat",
                {
                    body: body || "New message",
                    icon: "/static/pwa/icon-192.png"
                }
            );

            notification.onclick = () => {
                window.focus();
                notification.close();
            };
        } catch (_) {}
    }

    window.LuckyNotifications = {
        sync,
        unsubscribe,
        getRegistration,
        diagnosticVersion: "v3"
    };

    // Keep the existing chat-core call site working without exposing
    // encrypted content to the push service. This notification is generated
    // entirely on the user's device.
    window.luckyNotify = showLocalNotification;

    // If permission was already granted, restore the subscription quietly.
    window.addEventListener("load", () => {
        void sync({requestPermission: false});
    });

    window.addEventListener("lucky-setting-changed", event => {
        if (event?.detail?.key !== "notifications") return;

        if (event.detail.value === true) {
            void sync({requestPermission: true});
        } else if (event.detail.value === false) {
            void unsubscribe();
        }
    });
})();
