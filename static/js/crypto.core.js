const LUCKY_CRYPTO_DB_TIMEOUT_MS = 8000;

const LuckyCrypto = {
    initialized: false,
    keyPair: null,
    keyHistory: [],
    publicKeyCache: new Map(),
    publicKeyIdCache: new WeakMap(),
    initPromise: null,
    localKeyPromise: null,
    accountUsername: null,
    accountStorageKey: null,
    publicKeyUploadAllowed: null,
    deviceNeedsPairing: false,
    devicePairingRequestId: null,
    devicePairingPollTimer: null,
    devicePairingWatcherTimer: null,
    devicePairingPromptActive: false,

    getCookieValue(name) {
        try {
            const target = String(name || "");
            const encodedTarget = encodeURIComponent(target);

            for (const part of String(document.cookie || "").split(";")) {
                const trimmed = part.trim();
                if (!trimmed) continue;

                const separator = trimmed.indexOf("=");
                if (separator < 0) continue;

                const key = trimmed.slice(0, separator);
                const value = trimmed.slice(separator + 1);

                if (key === target || key === encodedTarget) {
                    try {
                        return decodeURIComponent(value);
                    } catch (_) {
                        return value;
                    }
                }
            }
        } catch (_) {
            // Restricted cookie access is handled by the explicit username path.
        }

        return "";
    },

    normalizeAccountUsername(username) {
        return String(username || "").trim();
    },

    getAccountStorageKey(username) {
        const name = this.normalizeAccountUsername(username);
        if (!name) {
            throw new Error("Logged-in username is unavailable for local encryption storage");
        }

        return "account:v1:" + encodeURIComponent(name);
    },

    async ensureAccountContext(username) {
        const explicit = this.normalizeAccountUsername(username);
        const cookieUsername = this.normalizeAccountUsername(
            this.getCookieValue("username")
        );

        if (explicit && cookieUsername && explicit !== cookieUsername) {
            throw new Error(
                "Encryption account mismatch; refusing to use another account's local keys"
            );
        }

        const resolved = explicit || cookieUsername || this.accountUsername;

        if (!resolved) {
            throw new Error(
                "Logged-in username is unavailable; cannot bind local encryption keys to this account"
            );
        }

        if (this.accountUsername && this.accountUsername !== resolved) {
            throw new Error(
                "Encryption account context changed; refusing to reuse another account's local keys"
            );
        }

        this.accountUsername = resolved;
        this.accountStorageKey = this.getAccountStorageKey(resolved);

        return resolved;
    },

    async getServerPublicKeyState(username) {
        const name = await this.ensureAccountContext(username);

        const response = await fetch(
            "/keys/" + encodeURIComponent(name),
            {
                method: "GET",
                credentials: "same-origin",
                cache: "no-store"
            }
        );

        if (!response.ok) {
            throw new Error(
                "Account public key request failed (HTTP " + response.status + ")"
            );
        }

        let data;
        try {
            data = await response.json();
        } catch (_) {
            throw new Error("Account public key response is invalid");
        }

        if (!data.success) {
            const error = String(data.error || "");

            if (/no public key registered/i.test(error)) {
                return {
                    publicKeys: [],
                    currentPublicKey: "",
                    hasServerKey: false
                };
            }

            throw new Error(error || "Could not fetch account public key");
        }

        const publicKeys = Array.isArray(data.public_keys)
            ? data.public_keys
                .map(value => String(value || "").trim())
                .filter(Boolean)
            : [String(data.public_key || "").trim()].filter(Boolean);

        return {
            publicKeys,
            currentPublicKey:
                publicKeys.length ? publicKeys[publicKeys.length - 1] : "",
            hasServerKey: publicKeys.length > 0
        };
    },

    async keyIdFromPublicKeyBase64(publicKeyBase64) {
        const publicKey = await this.importPublicKey(publicKeyBase64);
        return await this.publicKeyId(publicKey);
    },

    async findLocalKeyMatch(localPairs, serverPublicKeys) {
        const pairs = Array.isArray(localPairs)
            ? localPairs.filter(
                pair => pair?.privateKey && pair?.publicKey
            )
            : [];

        const serverKeys = Array.isArray(serverPublicKeys)
            ? serverPublicKeys
                .map(value => String(value || "").trim())
                .filter(Boolean)
            : [];

        if (!pairs.length || !serverKeys.length) return null;

        const serverIds = new Set();

        for (const encoded of serverKeys) {
            try {
                serverIds.add(await this.keyIdFromPublicKeyBase64(encoded));
            } catch (_) {
                // Ignore malformed historical public-key entries.
            }
        }

        for (let index = 0; index < pairs.length; index += 1) {
            try {
                const localId = await this.publicKeyId(pairs[index].publicKey);
                if (serverIds.has(localId)) {
                    return { localIndex: index, keyId: localId };
                }
            } catch (_) {
                // Try the next locally retained key.
            }
        }

        return null;
    },

    async synchronizePublicKeyIfSafe() {
        try {
            const username = await this.ensureAccountContext();
            const serverState = await this.getServerPublicKeyState(username);

            if (!serverState.hasServerKey) {
                await this.uploadPublicKey();
                console.log("🔐 Missing server public key restored from local account key");
                return true;
            }

            const currentLocalId = await this.publicKeyId(this.keyPair.publicKey);
            const serverCurrentId = await this.keyIdFromPublicKeyBase64(
                serverState.currentPublicKey
            );

            if (currentLocalId === serverCurrentId) {
                return true;
            }

            const match = await this.findLocalKeyMatch(
                [this.keyPair, ...this.keyHistory],
                serverState.publicKeys
            );

            if (match) {
                console.warn(
                    "🔐 Server has a different current key; local account keys were preserved " +
                    "and no automatic key rotation was performed."
                );
                return false;
            }

            console.warn(
                "🔐 Server encryption identity does not match any locally retained key; " +
                "automatic key replacement was refused."
            );
            return false;
        } catch (error) {
            // Never block chat/history decryption on a background key-sync request.
            console.warn("⚠️ Background public-key synchronization skipped:", error);
            return false;
        }
    },

    async init() {
        if (this.initialized) return true;
        if (this.initPromise) return this.initPromise;

        this.initPromise = (async () => {
            if (!window.crypto?.subtle) {
                throw new Error("Web Crypto API is not available");
            }

            // Load/create the local identity independently from the network.
            // This keeps stored-message decryption usable even if the public
            // key upload endpoint is slow.
            await this.ensureLocalKeyPair();

            if (this.publicKeyUploadAllowed === true) {
                await this.uploadPublicKey();
            } else if (this.publicKeyUploadAllowed === false) {
                // Existing account identities are already safely stored under the
                // logged-in account. Do not block initialization or overwrite a
                // different server current key; reconcile in the background.
                console.log(
                    "🔐 Account-scoped encryption identity loaded; background server-key " +
                    "synchronization will preserve the existing server identity."
                );
            } else {
                throw new Error("Encryption key upload policy was not initialized");
            }

            this.initialized = true;

            if (this.publicKeyUploadAllowed === false) {
                void this.synchronizePublicKeyIfSafe();
            }

            // A fresh browser profile cannot contain this account's existing
            // private keys. Start an authenticated, explicitly approved device
            // pairing in the background so old encrypted messages can become
            // readable without blocking normal chat startup.
            if (this.deviceNeedsPairing || this.hasSavedDevicePairingState()) {
                void this.startOrResumeDevicePairing();
            }

            // Existing sessions watch for a new browser requesting access. The
            // actual transfer is encrypted to the requesting device's public key.
            void this.watchForIncomingDevicePairings();

            console.log("✅ LuckyCrypto initialized");
            return true;
        })();

        try {
            return await this.initPromise;
        } catch (error) {
            this.initPromise = null;
            console.error("❌ LuckyCrypto initialization failed:", error);
            throw error;
        }
    },

    async ensureReady() {
        if (!this.initialized) {
            await this.init();
        }
        if (!this.keyPair?.privateKey || !this.keyPair?.publicKey) {
            throw new Error("Encryption key pair is not available");
        }
    },

    // Fast local-only readiness path used by history decryption. It never
    // uploads a public key, so decrypting existing messages is not blocked by
    // network latency or a temporarily unavailable key endpoint.
    async ensureLocalKeyPair() {
        if (this.keyPair?.privateKey && this.keyPair?.publicKey) {
            return true;
        }
        if (this.localKeyPromise) return this.localKeyPromise;

        this.localKeyPromise = (async () => {
            await this.loadOrCreateKeyPair();
            if (!this.keyPair?.privateKey || !this.keyPair?.publicKey) {
                throw new Error("Local encryption key pair is not available");
            }
            return true;
        })();

        try {
            return await this.localKeyPromise;
        } catch (error) {
            this.localKeyPromise = null;
            throw error;
        }
    },

    async ensureDecryptReady() {
        return this.ensureLocalKeyPair();
    },

    async generateKeyPair() {
        return await window.crypto.subtle.generateKey(
            {
                name: "RSA-OAEP",
                modulusLength: 3072,
                publicExponent: new Uint8Array([1, 0, 1]),
                hash: "SHA-256"
            },
            true,
            ["encrypt", "decrypt"]
        );
    },

    async loadOrCreateKeyPair() {
        const username = await this.ensureAccountContext();
        const accountStorageKey = this.accountStorageKey;

        const applyStored = stored => {
            if (stored?.current?.publicKey && stored?.current?.privateKey) {
                this.keyPair = stored.current;
                this.keyHistory = Array.isArray(stored.history)
                    ? stored.history.filter(
                        pair => pair?.privateKey && pair?.publicKey
                    )
                    : [];
                return true;
            }

            if (stored?.publicKey && stored?.privateKey) {
                this.keyPair = stored;
                this.keyHistory = [];
                return true;
            }

            return false;
        };

        // Account-scoped storage is always preferred.
        const accountStored = await this.loadKeyPairFromDB(accountStorageKey);

        if (applyStored(accountStored)) {
            // Account-scoped storage is already isolated by username. Loading it
            // must stay local-only so history decryption is never blocked by a
            // transient network/key-endpoint failure.
            this.publicKeyUploadAllowed = false;

            console.log(
                "🔑 Account-scoped encryption key loaded for",
                username,
                "with",
                this.keyHistory.length,
                "archived key(s)"
            );
            return;
        }

        // Legacy migration: use the old global identity only after proving that
        // one of its retained public keys belongs to this logged-in account.
        const legacyStored = await this.loadKeyPairFromDB("identity");

        if (applyStored(legacyStored)) {
            const serverState = await this.getServerPublicKeyState(username);
            const localPairs = [this.keyPair, ...this.keyHistory];

            if (serverState.hasServerKey) {
                const match = await this.findLocalKeyMatch(
                    localPairs,
                    serverState.publicKeys
                );

                if (!match) {
                    throw new Error(
                        "A different account's local encryption key was detected. " +
                        "The key was not reused, and no new key was generated. " +
                        "Use this account's recovery backup to restore its encryption identity."
                    );
                }

                // Migration is complete without changing the server identity.
                // Any safe reconciliation happens asynchronously after initialization.
                this.publicKeyUploadAllowed = false;
            } else {
                this.publicKeyUploadAllowed = true;
            }

            await this.saveKeyPairToDB({
                current: this.keyPair,
                history: this.keyHistory
            }, accountStorageKey);

            console.log(
                "🔑 Legacy encryption identity migrated into account-scoped storage for",
                username
            );
            return;
        }

        // A fresh browser profile (for example, Chrome Incognito) has a separate
        // IndexedDB and therefore cannot see this account's existing private key.
        // Do not reuse another account's local identity and do not require the old
        // private key just to establish a new device session. Generate a distinct
        // device key and publish it. The backend retains the previous public key in
        // its public-key history, so older-device identities remain addressable.
        const serverState = await this.getServerPublicKeyState(username);

        this.keyPair = await this.generateKeyPair();
        this.keyHistory = [];
        this.publicKeyUploadAllowed = true;
        this.deviceNeedsPairing = !!serverState.hasServerKey;

        if (this.deviceNeedsPairing) {
            this.saveDevicePairingState({
                needsPairing: true,
                requestId: null
            });
        }

        await this.saveKeyPairToDB({
            current: this.keyPair,
            history: []
        }, accountStorageKey);

        console.log(
            serverState.hasServerKey
                ? "🔑 New Lucky Chat device key generated; waiting for secure pairing approval"
                : "🔑 New account-scoped encryption key pair generated for",
            username
        );
    },

    async exportPublicKey() {
        if (!this.keyPair?.publicKey) {
            throw new Error("Public key is not available");
        }

        return await window.crypto.subtle.exportKey(
            "spki",
            this.keyPair.publicKey
        );
    },

    async exportPublicKeyBase64() {
        const publicKeyBuffer = await this.exportPublicKey();
        return this.arrayBufferToBase64(publicKeyBuffer);
    },

    async uploadPublicKey() {
        const publicKeyBase64 = await this.exportPublicKeyBase64();

        const response = await fetch("/keys/upload", {
            method: "POST",
            credentials: "same-origin",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                public_key: publicKeyBase64
            })
        });

        if (!response.ok) {
            throw new Error(
                "Public key upload failed (HTTP " + response.status + ")"
            );
        }

        const data = await response.json();

        if (!data.success) {
            throw new Error(data.error || "Public key upload failed");
        }

        console.log("🔐 Public key uploaded");
    },

    arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = "";
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(
                ...bytes.subarray(i, i + chunkSize)
            );
        }
        return btoa(binary);
    },

    base64ToArrayBuffer(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    },

    async importPublicKey(publicKeyBase64) {
        if (!publicKeyBase64) {
            throw new Error("Recipient public key is missing");
        }

        const keyData = this.base64ToArrayBuffer(publicKeyBase64);

        return await window.crypto.subtle.importKey(
            "spki",
            keyData,
            {
                name: "RSA-OAEP",
                hash: "SHA-256"
            },
            true,
            ["encrypt"]
        );
    },


    getDevicePairingStorageKey() {
        const username = String(this.accountUsername || "").trim();
        return username
            ? "lucky:crypto:device-pair:" + encodeURIComponent(username)
            : "";
    },

    readDevicePairingState() {
        const key = this.getDevicePairingStorageKey();
        if (!key) return null;
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === "object" ? parsed : null;
        } catch (_) {
            return null;
        }
    },

    saveDevicePairingState(state) {
        const key = this.getDevicePairingStorageKey();
        if (!key) return;
        try {
            localStorage.setItem(key, JSON.stringify(state || {}));
        } catch (_) {}
    },

    clearDevicePairingState() {
        const key = this.getDevicePairingStorageKey();
        if (!key) return;
        try {
            localStorage.removeItem(key);
        } catch (_) {}
    },

    hasSavedDevicePairingState() {
        const state = this.readDevicePairingState();
        return !!state?.needsPairing || !!state?.requestId;
    },

    async requestDevicePairing() {
        await this.ensureLocalKeyPair();
        const publicKeyBase64 = await this.exportPublicKeyBase64();

        let state = this.readDevicePairingState() || {};
        if (!state.requestId) {
            const random = window.crypto.getRandomValues(new Uint8Array(18));
            state.requestId = this.arrayBufferToBase64(random.buffer)
                .replace(/\+/g, "-")
                .replace(/\//g, "_")
                .replace(/=+$/g, "");
        }

        state.needsPairing = true;
        this.saveDevicePairingState(state);
        this.devicePairingRequestId = state.requestId;

        const response = await fetch("/crypto/device-pair/request", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                request_id: state.requestId,
                device_public_key: publicKeyBase64
            })
        });

        if (!response.ok) {
            throw new Error("Device-pair request failed (HTTP " + response.status + ")");
        }

        const result = await response.json();
        if (!result.success) {
            throw new Error(result.error || "Device-pair request failed");
        }

        return result;
    },

    async encryptDevicePairingTransfer(state, recipientPublicKeyBase64, senderUsername) {
        const sender = String(senderUsername || this.accountUsername || "").trim();
        const recipientEncoded = String(recipientPublicKeyBase64 || "").trim();
        if (!sender) throw new Error("Sender username is required");
        if (!recipientEncoded) throw new Error("New device public key is missing");

        await this.ensureAccountContext(sender);
        await this.ensureReady();

        const recipientPublicKey = await this.importPublicKey(recipientEncoded);
        const recipientKeyId = await this.publicKeyId(recipientPublicKey);
        const transferKey = await this.generateMessageKey();
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const plaintext = new TextEncoder().encode(JSON.stringify(state));

        const ciphertext = await window.crypto.subtle.encrypt(
            { name: "AES-GCM", iv, tagLength: 128 },
            transferKey,
            plaintext
        );
        const rawTransferKey = await window.crypto.subtle.exportKey("raw", transferKey);
        const wrappedKey = await window.crypto.subtle.encrypt(
            { name: "RSA-OAEP" },
            recipientPublicKey,
            rawTransferKey
        );

        return "LCMD1:" + JSON.stringify({
            v: 1,
            alg: "RSA-OAEP-3072-SHA256/AES-256-GCM",
            sender,
            recipientKeyId,
            iv: this.arrayBufferToBase64(iv.buffer),
            wrappedKey: this.arrayBufferToBase64(wrappedKey),
            ciphertext: this.arrayBufferToBase64(ciphertext)
        });
    },

    async decryptDevicePairingTransfer(value) {
        await this.ensureLocalKeyPair();
        const raw = String(value || "").trim();
        if (!raw.startsWith("LCMD1:")) throw new Error("Invalid Lucky Chat device transfer format");

        let envelope;
        try {
            envelope = JSON.parse(raw.slice("LCMD1:".length));
        } catch (_) {
            throw new Error("Device transfer is invalid");
        }

        if (
            envelope?.v !== 1 ||
            envelope?.alg !== "RSA-OAEP-3072-SHA256/AES-256-GCM" ||
            !envelope?.wrappedKey || !envelope?.iv || !envelope?.ciphertext
        ) {
            throw new Error("Device transfer is incomplete");
        }

        const localKeyId = await this.publicKeyId(this.keyPair.publicKey);
        if (envelope.recipientKeyId && localKeyId !== String(envelope.recipientKeyId).trim()) {
            throw new Error("Device transfer was encrypted for another device");
        }

        const rawTransferKey = await window.crypto.subtle.decrypt(
            { name: "RSA-OAEP" },
            this.keyPair.privateKey,
            this.base64ToArrayBuffer(envelope.wrappedKey)
        );
        const transferKey = await window.crypto.subtle.importKey(
            "raw", rawTransferKey, { name: "AES-GCM" }, false, ["decrypt"]
        );
        const plaintextBuffer = await window.crypto.subtle.decrypt(
            {
                name: "AES-GCM",
                iv: new Uint8Array(this.base64ToArrayBuffer(envelope.iv)),
                tagLength: 128
            },
            transferKey,
            this.base64ToArrayBuffer(envelope.ciphertext)
        );
        const state = JSON.parse(new TextDecoder().decode(plaintextBuffer));

        if (!state || state.v !== 1 || !state.current?.publicKey || !state.current?.privateKey) {
            throw new Error("Transferred encryption identity is invalid");
        }
        return state;
    },

    async importTransferredKeyPair(jwkPair) {
        if (!jwkPair?.publicKey || !jwkPair?.privateKey) {
            throw new Error("Transferred encryption key pair is incomplete");
        }

        const publicKey = await window.crypto.subtle.importKey(
            "jwk", jwkPair.publicKey,
            { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]
        );
        const privateKey = await window.crypto.subtle.importKey(
            "jwk", jwkPair.privateKey,
            { name: "RSA-OAEP", hash: "SHA-256" }, true, ["decrypt"]
        );
        return { publicKey, privateKey };
    },

    async mergeTransferredKeyState(state) {
        await this.ensureLocalKeyPair();
        const importedCurrent = await this.importTransferredKeyPair(state.current);
        const importedHistory = [];

        for (const pair of Array.isArray(state.history) ? state.history : []) {
            try {
                importedHistory.push(await this.importTransferredKeyPair(pair));
            } catch (_) {}
        }

        const localCurrentId = await this.publicKeyId(this.keyPair.publicKey);
        const mergedHistory = [];
        const seenIds = new Set([localCurrentId]);

        for (const pair of [importedCurrent, ...importedHistory, ...this.keyHistory]) {
            try {
                const id = await this.publicKeyId(pair.publicKey);
                if (!id || seenIds.has(id)) continue;
                seenIds.add(id);
                mergedHistory.push(pair);
            } catch (_) {}
        }

        this.keyHistory = mergedHistory.slice(0, 24);
        await this.saveKeyPairToDB({
            current: this.keyPair,
            history: this.keyHistory
        }, this.accountStorageKey);
        return true;
    },

    async approveIncomingDevicePairing(item) {
        const requestId = String(item?.request_id || "").trim();
        const devicePublicKey = String(item?.device_public_key || "").trim();
        if (!requestId || !devicePublicKey) return false;

        let fingerprint = "unknown";
        try {
            fingerprint = (await this.keyIdFromPublicKeyBase64(devicePublicKey)).slice(0, 12);
        } catch (_) {}

        const approved = window.confirm(
            "A new Lucky Chat browser wants access to this account's encrypted message history.\n\n" +
            "Device key: " + fingerprint + "\n\nApprove this device?"
        );

        if (!approved) {
            await fetch("/crypto/device-pair/deny", {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ request_id: requestId })
            }).catch(() => {});
            return false;
        }

        const state = await this.exportBackupState();
        const transfer = await this.encryptDevicePairingTransfer(
            state, devicePublicKey, this.accountUsername
        );

        const response = await fetch("/crypto/device-pair/approve", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ request_id: requestId, transfer })
        });

        if (!response.ok) {
            throw new Error("Device approval failed (HTTP " + response.status + ")");
        }
        const result = await response.json();
        if (!result.success) {
            throw new Error(result.error || "Device approval failed");
        }
        console.log("✅ Lucky Chat device approved:", requestId);
        return true;
    },

    async pollIncomingDevicePairings() {
        try {
            const response = await fetch(
                "/crypto/device-pair/pending?_=" + Date.now(),
                { credentials: "same-origin", cache: "no-store" }
            );
            if (!response.ok) return [];
            const result = await response.json();
            if (!result.success || !Array.isArray(result.requests)) return [];

            const currentPublicKeyId = this.keyPair?.publicKey
                ? await this.publicKeyId(this.keyPair.publicKey)
                : "";

            const candidates = [];
            for (const item of result.requests) {
                try {
                    const requestPublicKeyId = await this.keyIdFromPublicKeyBase64(item?.device_public_key);
                    if (currentPublicKeyId && requestPublicKeyId === currentPublicKeyId) continue;
                } catch (_) {}
                candidates.push(item);
            }
            return candidates;
        } catch (_) {
            return [];
        }
    },

    async watchForIncomingDevicePairings() {
        if (this.devicePairingWatcherTimer) return;

        const run = async () => {
            if (document.hidden || this.devicePairingPromptActive) return;
            const requests = await this.pollIncomingDevicePairings();
            for (const item of requests) {
                if (this.devicePairingPromptActive) break;
                this.devicePairingPromptActive = true;
                try {
                    await this.approveIncomingDevicePairing(item);
                } catch (error) {
                    console.error("❌ Incoming device pairing failed:", error);
                } finally {
                    this.devicePairingPromptActive = false;
                }
                break;
            }
        };

        await run();
        this.devicePairingWatcherTimer = window.setInterval(run, 4000);
    },

    async startOrResumeDevicePairing() {
        if (this.devicePairingPollTimer) return;

        try {
            const result = await this.requestDevicePairing();
            this.devicePairingRequestId = String(
                result.request_id || this.devicePairingRequestId || ""
            );
            const requestId = this.devicePairingRequestId;
            if (!requestId) throw new Error("Device-pair request id is missing");

            const poll = async () => {
                try {
                    const response = await fetch(
                        "/crypto/device-pair/status/" +
                        encodeURIComponent(requestId) +
                        "?_=" + Date.now(),
                        { credentials: "same-origin", cache: "no-store" }
                    );
                    if (!response.ok) return;
                    const result = await response.json();
                    if (!result.success) return;

                    if (result.status === "approved") {
                        const state = await this.decryptDevicePairingTransfer(result.transfer);
                        await this.mergeTransferredKeyState(state);
                        this.deviceNeedsPairing = false;
                        this.clearDevicePairingState();
                        if (this.devicePairingPollTimer) {
                            clearInterval(this.devicePairingPollTimer);
                            this.devicePairingPollTimer = null;
                        }
                        console.log("✅ Encryption identity synchronized from an approved Lucky Chat device");
                        try {
                            window.dispatchEvent(new CustomEvent("lucky-crypto-device-paired"));
                        } catch (_) {}
                    } else if (result.status === "expired") {
                        // Keep the need flag so the next page load can request a fresh approval.
                        this.deviceNeedsPairing = true;
                        this.saveDevicePairingState({ needsPairing: true, requestId: null });
                        if (this.devicePairingPollTimer) {
                            clearInterval(this.devicePairingPollTimer);
                            this.devicePairingPollTimer = null;
                        }
                        console.warn("⚠️ Lucky Chat device pairing request expired or was denied");
                    }
                } catch (error) {
                    console.warn("⚠️ Device pairing status check failed:", error);
                }
            };

            await poll();
            if (!this.devicePairingPollTimer) {
                this.devicePairingPollTimer = window.setInterval(poll, 3000);
            }
        } catch (error) {
            console.warn("⚠️ Lucky Chat device pairing unavailable:", error);
        }
    },


async getPublicKeys(username) {
    const name = String(username || "").trim();
    if (!name) {
        throw new Error("Recipient username is required");
    }

    const response = await fetch(
        "/keys/" + encodeURIComponent(name),
        {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store"
        }
    );

    if (!response.ok) {
        throw new Error(
            "Public key request failed (HTTP " + response.status + ")"
        );
    }

    const data = await response.json();
    if (!data.success) {
        throw new Error(data.error || "Could not fetch public key");
    }

    const encodedKeys = Array.isArray(data.public_keys)
        ? data.public_keys
        : [data.public_key];

    const imported = [];
    for (const publicKeyBase64 of encodedKeys) {
        const encoded = String(publicKeyBase64 || "").trim();
        if (!encoded) continue;

        let cached = this.publicKeyCache.get(encoded);
        if (!cached) {
            const publicKey = await this.importPublicKey(encoded);
            cached = {
                publicKey,
                publicKeyBase64: encoded,
                keyId: await this.publicKeyId(publicKey)
            };
            this.publicKeyCache.set(encoded, cached);
        }
        imported.push(cached);
    }

    if (!imported.length) {
        throw new Error("No public key registered for " + name);
    }

    return imported;
},

async getPublicKey(username) {
    const keys = await this.getPublicKeys(username);
    // The backend returns archived keys first and the current key last.
    // Preserve the single-key helper's historical/current-key semantics.
    return keys[keys.length - 1].publicKey;
},

async publicKeyId(publicKey) {
    if (publicKey && this.publicKeyIdCache.has(publicKey)) {
        return this.publicKeyIdCache.get(publicKey);
    }

    const spki = await window.crypto.subtle.exportKey(
        "spki",
        publicKey
    );

    const digest = await window.crypto.subtle.digest(
        "SHA-256",
        spki
    );

    const id = Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 24);

    if (publicKey) {
        this.publicKeyIdCache.set(publicKey, id);
    }

    return id;
},


    async generateMessageKey() {
        return await window.crypto.subtle.generateKey(
            {
                name: "AES-GCM",
                length: 256
            },
            true,
            ["encrypt", "decrypt"]
        );
    },


async encryptMessage(text, recipientUsername, senderUsername) {
    const plaintext = String(text ?? "");
    const recipient = String(recipientUsername || "").trim();
    const sender = String(senderUsername || "").trim();

    if (!plaintext) return plaintext;
    if (!sender) throw new Error("Sender username is required");

    await this.ensureAccountContext(sender);
    await this.ensureReady();

    if (!recipient) throw new Error("Recipient username is required");

    const recipientPublicKeys = await this.getPublicKeys(recipient);

    // Multi-device account support: every active/archived public identity of the
    // sender receives a wrapped copy of the message key. A fresh browser profile
    // may have a new current device key, while an older browser still retains its
    // previous private key. Keeping both sender identities in the envelope lets
    // the account's other sessions continue to read the messages it sent.
    const senderPublicKeys = await this.getPublicKeys(sender);

    const aesKey = await this.generateMessageKey();
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encodedText = new TextEncoder().encode(plaintext);

    const ciphertext = await window.crypto.subtle.encrypt(
        {
            name: "AES-GCM",
            iv,
            tagLength: 128
        },
        aesKey,
        encodedText
    );

    const rawAesKey = await window.crypto.subtle.exportKey(
        "raw",
        aesKey
    );

    const senderWrappedKeys = [];
    for (const senderKey of senderPublicKeys) {
        const wrapped = await window.crypto.subtle.encrypt(
            { name: "RSA-OAEP" },
            senderKey.publicKey,
            rawAesKey
        );

        senderWrappedKeys.push({
            id: senderKey.keyId,
            wrapped: this.arrayBufferToBase64(wrapped)
        });
    }

    const recipientWrappedKeys = [];
    for (const recipientKey of recipientPublicKeys) {
        const wrapped = await window.crypto.subtle.encrypt(
            { name: "RSA-OAEP" },
            recipientKey.publicKey,
            rawAesKey
        );

        recipientWrappedKeys.push({
            id: recipientKey.keyId,
            wrapped: this.arrayBufferToBase64(wrapped)
        });
    }

    const envelope = {
        v: 2,
        alg: "RSA-OAEP-3072-SHA256/AES-256-GCM",
        sender,
        recipient,
        iv: this.arrayBufferToBase64(iv.buffer),
        ciphertext: this.arrayBufferToBase64(ciphertext),
        keys: {
            [sender]: senderWrappedKeys,
            [recipient]: recipientWrappedKeys
        }
    };

    return "LCE2:" + JSON.stringify(envelope);
},



isEncryptedMessage(value) {
    return typeof value === "string" && (
        value.startsWith("LCE1:") ||
        value.startsWith("LCE2:")
    );
},

async decryptMessage(value, currentUsername) {
    // Plaintext does not need local crypto state. This is important for
    // compatibility with older messages/edit events and avoids failing a
    // plaintext render just because IndexedDB/Web Crypto is unavailable.
    if (!this.isEncryptedMessage(value)) return value;

    const username = String(currentUsername || "").trim();
    if (!username) {
        throw new Error("Current username is required for decryption");
    }

    await this.ensureAccountContext(username);
    await this.ensureDecryptReady();

    const prefix = value.startsWith("LCE2:") ? "LCE2:" : "LCE1:";
    let envelope;

    try {
        envelope = JSON.parse(value.slice(prefix.length));
    } catch (_) {
        throw new Error("Invalid encrypted message format");
    }

    if (!envelope || !envelope.iv || !envelope.ciphertext || !envelope.keys) {
        throw new Error("Encrypted message is incomplete");
    }

    let wrappedEntries = envelope.keys[username];

    // LCE1 compatibility: one base64-wrapped AES key.
    if (typeof wrappedEntries === "string") {
        wrappedEntries = [{
            id: null,
            wrapped: wrappedEntries
        }];
    }

    // Some dashboard contexts may render a username alias that does not
    // exactly match the username used as the encryption-envelope key.
    // The private key is still the real authorization boundary: trying all
    // wrapped entries cannot decrypt anything unless the local private key
    // actually matches one of them.
    if (!Array.isArray(wrappedEntries) || !wrappedEntries.length) {
        const allEntries = [];

        for (const value of Object.values(envelope.keys || {})) {
            if (typeof value === "string") {
                allEntries.push({
                    id: null,
                    wrapped: value
                });
            } else if (Array.isArray(value)) {
                for (const entry of value) {
                    if (entry?.wrapped) {
                        allEntries.push(entry);
                    }
                }
            }
        }

        wrappedEntries = allEntries;

        if (wrappedEntries.length) {
            console.warn(
                "🔐 Encryption envelope username did not match exactly; trying all locally testable wrapped keys."
            );
        }
    }

    if (!Array.isArray(wrappedEntries) || !wrappedEntries.length) {
        throw new Error("Encrypted message has no usable wrapped key entries");
    }

    const candidates = [this.keyPair, ...this.keyHistory]
        .filter(pair => pair?.privateKey);

    const candidateRecords = [];
    for (const pair of candidates) {
        try {
            candidateRecords.push({
                pair,
                id: await this.publicKeyId(pair.publicKey)
            });
        } catch (_) {
            candidateRecords.push({ pair, id: null });
        }
    }

    // Try exact key-id matches first, then any compatible wrapped key.
    const attempts = [];
    for (const record of candidateRecords) {
        const exact = wrappedEntries.filter(
            entry => entry?.id && record.id && entry.id === record.id
        );

        const fallback = wrappedEntries.filter(
            entry => !entry?.id || !record.id || exact.length === 0
        );

        for (const entry of [...exact, ...fallback]) {
            if (entry?.wrapped) {
                attempts.push({
                    pair: record.pair,
                    wrapped: entry.wrapped
                });
            }
        }
    }

    // De-duplicate only the same wrapped-key/candidate-pair combination.
    // De-duplicating by wrapped ciphertext alone can consume a historical-key
    // attempt after the current private key fails against the same wrapped key.
    const seen = new WeakMap();
    for (const attempt of attempts) {
        let pairSeen = seen.get(attempt.pair);
        if (!pairSeen) {
            pairSeen = new Set();
            seen.set(attempt.pair, pairSeen);
        }
        if (pairSeen.has(attempt.wrapped)) continue;
        pairSeen.add(attempt.wrapped);

        try {
            const rawAesKey = await window.crypto.subtle.decrypt(
                { name: "RSA-OAEP" },
                attempt.pair.privateKey,
                this.base64ToArrayBuffer(attempt.wrapped)
            );

            const aesKey = await window.crypto.subtle.importKey(
                "raw",
                rawAesKey,
                { name: "AES-GCM" },
                false,
                ["decrypt"]
            );

            const plaintextBuffer = await window.crypto.subtle.decrypt(
                {
                    name: "AES-GCM",
                    iv: new Uint8Array(
                        this.base64ToArrayBuffer(envelope.iv)
                    ),
                    tagLength: 128
                },
                aesKey,
                this.base64ToArrayBuffer(envelope.ciphertext)
            );

            return new TextDecoder().decode(plaintextBuffer);
        } catch (_) {
            // Try the next retained key.
        }
    }

    throw new Error("No matching decryption key found");
},


    /*
     * Encrypted message-recovery transfer.
     *
     * This does NOT transfer private keys. The source device decrypts messages
     * locally, creates a plaintext recovery payload, then encrypts that payload
     * to the target account's current public key using a fresh AES-GCM key whose
     * key is wrapped with RSA-OAEP. The transferred file therefore contains no
     * usable plaintext unless opened by the intended target account.
     */
    async encryptRecoveryTransfer(payload, recipientUsername, senderUsername) {
        const sender = String(
            senderUsername || this.accountUsername || ""
        ).trim();
        const recipient = String(recipientUsername || "").trim();

        await this.ensureAccountContext(sender);
        await this.ensureReady();

        if (!recipient) {
            throw new Error("Recovery transfer recipient is required");
        }

        const recipientPublicKeys = await this.getPublicKeys(recipient);
        const recipientKeyRecord =
            recipientPublicKeys[recipientPublicKeys.length - 1];

        if (!recipientKeyRecord?.publicKey) {
            throw new Error("Recipient encryption key is unavailable");
        }

        const recipientKeyId =
            recipientKeyRecord.keyId ||
            await this.publicKeyId(recipientKeyRecord.publicKey);

        const transferKey = await this.generateMessageKey();
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const plaintext = new TextEncoder().encode(
            JSON.stringify(payload)
        );

        const ciphertext = await window.crypto.subtle.encrypt(
            {
                name: "AES-GCM",
                iv,
                tagLength: 128
            },
            transferKey,
            plaintext
        );

        const rawTransferKey = await window.crypto.subtle.exportKey(
            "raw",
            transferKey
        );

        const wrappedKey = await window.crypto.subtle.encrypt(
            { name: "RSA-OAEP" },
            recipientKeyRecord.publicKey,
            rawTransferKey
        );

        return "LCRT1:" + JSON.stringify({
            v: 1,
            alg: "RSA-OAEP-3072-SHA256/AES-256-GCM",
            sender,
            recipient,
            recipientKeyId,
            iv: this.arrayBufferToBase64(iv.buffer),
            wrappedKey: this.arrayBufferToBase64(wrappedKey),
            ciphertext: this.arrayBufferToBase64(ciphertext)
        });
    },

    async decryptRecoveryTransfer(value, currentUsername) {
        const username = String(currentUsername || "").trim();
        await this.ensureAccountContext(username);
        await this.ensureDecryptReady();

        const raw = String(value || "").trim();
        if (!raw.startsWith("LCRT1:")) {
            throw new Error("Invalid Lucky Chat recovery transfer format");
        }

        let envelope;
        try {
            envelope = JSON.parse(raw.slice("LCRT1:".length));
        } catch (_) {
            throw new Error("Recovery transfer is invalid");
        }

        if (
            envelope?.v !== 1 ||
            envelope?.alg !== "RSA-OAEP-3072-SHA256/AES-256-GCM" ||
            !envelope.recipient ||
            !envelope.wrappedKey ||
            !envelope.iv ||
            !envelope.ciphertext
        ) {
            throw new Error("Unsupported or incomplete recovery transfer");
        }

        if (String(envelope.recipient).trim() !== username) {
            throw new Error(
                "This recovery transfer belongs to another Lucky Chat account"
            );
        }

        const candidates = [
            this.keyPair,
            ...(Array.isArray(this.keyHistory) ? this.keyHistory : [])
        ].filter(pair => pair?.privateKey && pair?.publicKey);

        let lastError = null;
        const orderedCandidates = [];

        for (const pair of candidates) {
            try {
                const id = await this.publicKeyId(pair.publicKey);
                if (
                    envelope.recipientKeyId &&
                    id === String(envelope.recipientKeyId).trim()
                ) {
                    orderedCandidates.unshift({ pair, id });
                } else {
                    orderedCandidates.push({ pair, id });
                }
            } catch (_) {
                orderedCandidates.push({ pair, id: null });
            }
        }

        for (const candidate of orderedCandidates) {
            try {
                const rawTransferKey = await window.crypto.subtle.decrypt(
                    { name: "RSA-OAEP" },
                    candidate.pair.privateKey,
                    this.base64ToArrayBuffer(envelope.wrappedKey)
                );

                const transferKey = await window.crypto.subtle.importKey(
                    "raw",
                    rawTransferKey,
                    { name: "AES-GCM" },
                    false,
                    ["decrypt"]
                );

                const plaintextBuffer = await window.crypto.subtle.decrypt(
                    {
                        name: "AES-GCM",
                        iv: new Uint8Array(
                            this.base64ToArrayBuffer(envelope.iv)
                        ),
                        tagLength: 128
                    },
                    transferKey,
                    this.base64ToArrayBuffer(envelope.ciphertext)
                );

                let payload;
                try {
                    payload = JSON.parse(
                        new TextDecoder().decode(plaintextBuffer)
                    );
                } catch (_) {
                    throw new Error("Recovered transfer payload is invalid");
                }

                if (
                    payload?.v !== 1 ||
                    payload?.type !== "lucky-message-recovery" ||
                    String(payload.targetUsername || "").trim() !== username
                ) {
                    throw new Error("Recovered transfer belongs to another account");
                }

                return {
                    payload,
                    sender: String(envelope.sender || "").trim(),
                    recipient: String(envelope.recipient || "").trim(),
                    recipientKeyId:
                        String(envelope.recipientKeyId || "").trim() || null
                };
            } catch (error) {
                lastError = error;
            }
        }

        throw new Error(
            lastError?.message ||
            "Recovery transfer cannot be decrypted with this account's local keys"
        );
    },


    clearCachedPublicKey(username) {
        const name = String(username || "").trim();
        if (name) this.publicKeyCache.delete(name);
    },


async loadExistingKeyPair() {
    await this.ensureAccountContext();

    const stored = await this.loadKeyPairFromDB(this.accountStorageKey);

    if (stored?.current?.publicKey && stored?.current?.privateKey) {
        this.keyPair = stored.current;
        this.keyHistory = Array.isArray(stored.history)
            ? stored.history.filter(
                pair => pair?.privateKey && pair?.publicKey
            )
            : [];
        return true;
    }

    if (stored?.publicKey && stored?.privateKey) {
        this.keyPair = stored;
        this.keyHistory = [];
        return true;
    }

    // Recovery backup creation can also perform the guarded legacy migration.
    const legacyStored = await this.loadKeyPairFromDB("identity");

    if (legacyStored?.current?.publicKey && legacyStored?.current?.privateKey) {
        const state = await this.getServerPublicKeyState(this.accountUsername);
        const legacyPairs = [
            legacyStored.current,
            ...(Array.isArray(legacyStored.history) ? legacyStored.history : [])
        ].filter(pair => pair?.publicKey && pair?.privateKey);

        if (state.hasServerKey) {
            const match = await this.findLocalKeyMatch(
                legacyPairs,
                state.publicKeys
            );
            if (!match) return false;
        }

        this.keyPair = legacyStored.current;
        this.keyHistory = Array.isArray(legacyStored.history)
            ? legacyStored.history.filter(
                pair => pair?.privateKey && pair?.publicKey
            )
            : [];

        await this.saveKeyPairToDB({
            current: this.keyPair,
            history: this.keyHistory
        }, this.accountStorageKey);

        return true;
    }

    if (legacyStored?.publicKey && legacyStored?.privateKey) {
        const state = await this.getServerPublicKeyState(this.accountUsername);

        if (state.hasServerKey) {
            const match = await this.findLocalKeyMatch(
                [legacyStored],
                state.publicKeys
            );
            if (!match) return false;
        }

        this.keyPair = legacyStored;
        this.keyHistory = [];

        await this.saveKeyPairToDB({
            current: this.keyPair,
            history: []
        }, this.accountStorageKey);

        return true;
    }

    return false;
},

async exportBackupState() {
    if (!this.keyPair?.privateKey || !this.keyPair?.publicKey) {
        throw new Error("No local encryption key is available");
    }

    const exportPair = async pair => ({
        publicKey: await window.crypto.subtle.exportKey(
            "jwk",
            pair.publicKey
        ),
        privateKey: await window.crypto.subtle.exportKey(
            "jwk",
            pair.privateKey
        )
    });

    return {
        v: 1,
        current: await exportPair(this.keyPair),
        history: await Promise.all(
            this.keyHistory.map(exportPair)
        )
    };
},

async deriveRecoveryKey(recoveryCode, salt) {
    const material = await window.crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(String(recoveryCode || "")),
        "PBKDF2",
        false,
        ["deriveKey"]
    );

    return await window.crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt,
            iterations: 310000,
            hash: "SHA-256"
        },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
},

generateRecoveryCode() {
    const bytes = window.crypto.getRandomValues(new Uint8Array(24));
    return this.arrayBufferToBase64(bytes.buffer)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
},

async createRecoveryBackup(recoveryCode) {
    const code = String(recoveryCode || "").trim();
    if (code.length < 12) {
        throw new Error("Recovery code must be at least 12 characters");
    }

    if (!(await this.loadExistingKeyPair())) {
        throw new Error("No local encryption key is available");
    }

    const plaintext = new TextEncoder().encode(
        JSON.stringify(await this.exportBackupState())
    );
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const key = await this.deriveRecoveryKey(code, salt);

    const ciphertext = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv, tagLength: 128 },
        key,
        plaintext
    );

    const backup = {
        v: 1,
        alg: "PBKDF2-SHA256-310000/AES-256-GCM",
        salt: this.arrayBufferToBase64(salt.buffer),
        iv: this.arrayBufferToBase64(iv.buffer),
        ciphertext: this.arrayBufferToBase64(ciphertext)
    };

    const response = await fetch("/crypto/backup", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backup: JSON.stringify(backup) })
    });

    if (!response.ok) {
        throw new Error("Crypto backup failed (HTTP " + response.status + ")");
    }

    const result = await response.json();
    if (!result.success) {
        throw new Error(result.error || "Crypto backup failed");
    }

    return backup;
},

async restoreRecoveryBackup(recoveryCode) {
    await this.ensureAccountContext();

    const code = String(recoveryCode || "").trim();
    if (code.length < 12) {
        throw new Error("Recovery code must be at least 12 characters");
    }

    const response = await fetch("/crypto/backup", {
        credentials: "same-origin",
        cache: "no-store"
    });

    if (!response.ok) {
        throw new Error(
            "Recovery backup request failed (HTTP " + response.status + ")"
        );
    }

    const result = await response.json();
    if (!result.success) {
        throw new Error(result.error || "Could not load recovery backup");
    }

    if (!result.backup) {
        throw new Error("No recovery backup exists");
    }

    let backup;
    try {
        backup = JSON.parse(result.backup);
    } catch (_) {
        throw new Error("Recovery backup is invalid");
    }

    if (
        backup.v !== 1 ||
        backup.alg !== "PBKDF2-SHA256-310000/AES-256-GCM"
    ) {
        throw new Error("Unsupported recovery backup format");
    }

    const key = await this.deriveRecoveryKey(
        code,
        new Uint8Array(this.base64ToArrayBuffer(backup.salt))
    );

    let plaintextBuffer;
    try {
        plaintextBuffer = await window.crypto.subtle.decrypt(
            {
                name: "AES-GCM",
                iv: new Uint8Array(
                    this.base64ToArrayBuffer(backup.iv)
                ),
                tagLength: 128
            },
            key,
            this.base64ToArrayBuffer(backup.ciphertext)
        );
    } catch (_) {
        throw new Error(
            "Recovery code is incorrect or the backup is invalid"
        );
    }

    let state;
    try {
        state = JSON.parse(
            new TextDecoder().decode(plaintextBuffer)
        );
    } catch (_) {
        throw new Error("Recovered key data is invalid");
    }

    const importPair = async record => ({
        publicKey: await window.crypto.subtle.importKey(
            "jwk",
            record.publicKey,
            {
                name: "RSA-OAEP",
                hash: "SHA-256"
            },
            true,
            ["encrypt"]
        ),
        privateKey: await window.crypto.subtle.importKey(
            "jwk",
            record.privateKey,
            {
                name: "RSA-OAEP",
                hash: "SHA-256"
            },
            true,
            ["decrypt"]
        )
    });

    this.keyPair = await importPair(state.current);
    this.keyHistory = Array.isArray(state.history)
        ? await Promise.all(state.history.map(importPair))
        : [];

    await this.saveKeyPairToDB({
        current: this.keyPair,
        history: this.keyHistory
    }, this.accountStorageKey);

    // Recovery is an explicit account-owner action, so it may intentionally
    // restore the recovered identity as the server's current public key while
    // the server retains its prior public key in history.
    this.publicKeyUploadAllowed = true;
    await this.uploadPublicKey(true);
    this.publicKeyCache.clear();
    this.initialized = true;

    return true;
},

    async saveKeyPairToDB(keyStore, storageKey = this.accountStorageKey) {
        const keyName = String(storageKey || "").trim();
        if (!keyName) {
            throw new Error("Account context is required for local encryption storage");
        }

        return new Promise((resolve, reject) => {
            const request = indexedDB.open("LuckyChatCrypto", 1);
            let db = null;
            let transaction = null;
            let settled = false;

            const finish = (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);

                try {
                    db?.close();
                } catch (_) {}

                if (error) reject(error);
                else resolve();
            };

            const timeoutId = setTimeout(() => {
                try {
                    transaction?.abort();
                } catch (_) {}
                finish(new Error(
                    "Local encryption storage timed out while saving keys"
                ));
            }, LUCKY_CRYPTO_DB_TIMEOUT_MS);

            request.onupgradeneeded = () => {
                db = request.result;

                if (!db.objectStoreNames.contains("keys")) {
                    db.createObjectStore("keys");
                }
            };

            request.onsuccess = () => {
                db = request.result;

                try {
                    transaction = db.transaction("keys", "readwrite");
                    const store = transaction.objectStore("keys");
                    store.put(keyStore, keyName);

                    transaction.oncomplete = () => finish();
                    transaction.onerror = () => finish(
                        transaction.error || new Error("Could not save encryption keys")
                    );
                    transaction.onabort = () => finish(
                        transaction.error || new Error("Encryption key save was aborted")
                    );
                } catch (error) {
                    finish(error);
                }
            };

            request.onerror = () => finish(
                request.error || new Error("Could not open local encryption storage")
            );
            request.onblocked = () => {
                // Keep the timeout as the final escape hatch. A blocked IndexedDB
                // request can otherwise leave crypto initialization pending forever.
                console.warn("⚠️ LuckyCrypto IndexedDB open is blocked");
            };
        });
    },

    async loadKeyPairFromDB(storageKey = this.accountStorageKey) {
        const keyName = String(storageKey || "").trim();
        if (!keyName) {
            throw new Error("Account context is required for local encryption storage");
        }

        return new Promise((resolve, reject) => {
            const request = indexedDB.open("LuckyChatCrypto", 1);
            let db = null;
            let settled = false;

            const finish = (result, error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);

                try {
                    db?.close();
                } catch (_) {}

                if (error) reject(error);
                else resolve(result);
            };

            const timeoutId = setTimeout(() => {
                finish(null, new Error(
                    "Local encryption storage timed out while loading keys"
                ));
            }, LUCKY_CRYPTO_DB_TIMEOUT_MS);

            request.onupgradeneeded = () => {
                db = request.result;

                if (!db.objectStoreNames.contains("keys")) {
                    db.createObjectStore("keys");
                }
            };

            request.onsuccess = () => {
                db = request.result;

                try {
                    const transaction = db.transaction("keys", "readonly");
                    const store = transaction.objectStore("keys");
                    const getRequest = store.get(keyName);

                    getRequest.onsuccess = () => {
                        finish(getRequest.result || null);
                    };

                    getRequest.onerror = () => {
                        finish(null,
                            getRequest.error ||
                            new Error("Could not read local encryption keys")
                        );
                    };

                    transaction.onabort = () => {
                        finish(null,
                            transaction.error ||
                            new Error("Encryption key read was aborted")
                        );
                    };
                } catch (error) {
                    finish(null, error);
                }
            };

            request.onerror = () => finish(
                null,
                request.error || new Error("Could not open local encryption storage")
            );
            request.onblocked = () => {
                // Keep the timeout as the final escape hatch. A blocked IndexedDB
                // request can otherwise leave crypto initialization pending forever.
                console.warn("⚠️ LuckyCrypto IndexedDB open is blocked");
            };
        });
    }
};

// Expose the crypto runtime to other classic scripts (chat.core.js).
window.LuckyCrypto = LuckyCrypto;
