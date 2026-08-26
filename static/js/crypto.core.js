const LuckyCrypto = {
    initialized: false,
    keyPair: null,
    keyHistory: [],
    publicKeyCache: new Map(),
    initPromise: null,

    async init() {
        if (this.initialized) return true;
        if (this.initPromise) return this.initPromise;

        this.initPromise = (async () => {
            if (!window.crypto?.subtle) {
                throw new Error("Web Crypto API is not available");
            }

            await this.loadOrCreateKeyPair();
            await this.uploadPublicKey();

            this.initialized = true;
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
        const stored = await this.loadKeyPairFromDB();

        // New format:
        // {
        //   current: CryptoKeyPair,
        //   history: CryptoKeyPair[]
        // }
        //
        // Backward compatibility: older builds stored the CryptoKeyPair
        // directly under the "identity" key.
        if (stored?.current?.publicKey && stored?.current?.privateKey) {
            this.keyPair = stored.current;
            this.keyHistory = Array.isArray(stored.history)
                ? stored.history.filter(pair => pair?.privateKey && pair?.publicKey)
                : [];

            console.log(
                "🔑 Encryption key loaded with",
                this.keyHistory.length,
                "archived key(s)"
            );
            return;
        }

        if (stored?.publicKey && stored?.privateKey) {
            this.keyPair = stored;
            this.keyHistory = [];
            await this.saveKeyPairToDB({
                current: this.keyPair,
                history: []
            });
            console.log("🔑 Existing encryption key migrated to key-history format");
            return;
        }

        this.keyPair = await this.generateKeyPair();
        this.keyHistory = [];
        await this.saveKeyPairToDB({
            current: this.keyPair,
            history: []
        });
        console.log("🔑 New encryption key pair generated");
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
            false,
            ["encrypt"]
        );
    },

    async getPublicKey(username) {
        const name = String(username || "").trim();
        if (!name) {
            throw new Error("Recipient username is required");
        }

        if (this.publicKeyCache.has(name)) {
            return this.publicKeyCache.get(name);
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

        if (!data.public_key) {
            throw new Error("No public key registered for " + name);
        }

        const publicKey = await this.importPublicKey(data.public_key);
        this.publicKeyCache.set(name, publicKey);
        return publicKey;
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
        await this.ensureReady();

        const plaintext = String(text ?? "");
        const recipient = String(recipientUsername || "").trim();
        const sender = String(senderUsername || "").trim();

        if (!plaintext) {
            return plaintext;
        }
        if (!recipient) {
            throw new Error("Recipient username is required");
        }
        if (!sender) {
            throw new Error("Sender username is required");
        }

        const recipientPublicKey = await this.getPublicKey(recipient);
        const senderPublicKey = this.keyPair.publicKey;
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

        const recipientWrappedKey = await window.crypto.subtle.encrypt(
            { name: "RSA-OAEP" },
            recipientPublicKey,
            rawAesKey
        );

        const senderWrappedKey = await window.crypto.subtle.encrypt(
            { name: "RSA-OAEP" },
            senderPublicKey,
            rawAesKey
        );

        const envelope = {
            v: 1,
            alg: "RSA-OAEP-3072-SHA256/AES-256-GCM",
            sender,
            recipient,
            iv: this.arrayBufferToBase64(iv.buffer),
            ciphertext: this.arrayBufferToBase64(ciphertext),
            keys: {
                [sender]: this.arrayBufferToBase64(senderWrappedKey),
                [recipient]: this.arrayBufferToBase64(recipientWrappedKey)
            }
        };

        return "LCE1:" + JSON.stringify(envelope);
    },

    isEncryptedMessage(value) {
        return typeof value === "string" && value.startsWith("LCE1:");
    },

    async decryptMessage(value, currentUsername) {
        await this.ensureReady();

        if (!this.isEncryptedMessage(value)) {
            return value;
        }

        const username = String(currentUsername || "").trim();
        if (!username) {
            throw new Error("Current username is required for decryption");
        }

        let envelope;
        try {
            envelope = JSON.parse(value.slice(5));
        } catch (error) {
            throw new Error("Invalid encrypted message format");
        }

        if (
            !envelope ||
            envelope.v !== 1 ||
            envelope.alg !== "RSA-OAEP-3072-SHA256/AES-256-GCM" ||
            !envelope.iv ||
            !envelope.ciphertext ||
            !envelope.keys ||
            !envelope.keys[username]
        ) {
            throw new Error("Encrypted message is incomplete or not addressed to this user");
        }

        const wrappedKey = this.base64ToArrayBuffer(envelope.keys[username]);

        // Try the active key first, then archived private keys. This makes
        // previously encrypted messages survive a normal key rotation.
        const candidatePairs = [this.keyPair, ...this.keyHistory];

        let lastError = null;

        for (let index = 0; index < candidatePairs.length; index += 1) {
            const pair = candidatePairs[index];

            if (!pair?.privateKey) {
                continue;
            }

            try {
                const rawAesKey = await window.crypto.subtle.decrypt(
                    { name: "RSA-OAEP" },
                    pair.privateKey,
                    wrappedKey
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
                        iv: new Uint8Array(this.base64ToArrayBuffer(envelope.iv)),
                        tagLength: 128
                    },
                    aesKey,
                    this.base64ToArrayBuffer(envelope.ciphertext)
                );

                // If an archived key succeeded, silently continue using that
                // key for this historical message. Do not rewrite ciphertext.
                if (index > 0) {
                    console.debug("🔑 Decrypted message with archived key");
                }

                return new TextDecoder().decode(plaintextBuffer);
            } catch (error) {
                lastError = error;
            }
        }

        throw lastError || new Error("No matching decryption key found");
    },


    clearCachedPublicKey(username) {
        const name = String(username || "").trim();
        if (name) this.publicKeyCache.delete(name);
    },

    async saveKeyPairToDB(keyStore) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open("LuckyChatCrypto", 1);

            request.onupgradeneeded = () => {
                const db = request.result;

                if (!db.objectStoreNames.contains("keys")) {
                    db.createObjectStore("keys");
                }
            };

            request.onsuccess = () => {
                const db = request.result;
                const transaction = db.transaction("keys", "readwrite");
                const store = transaction.objectStore("keys");

                store.put(keyStore, "identity");

                transaction.oncomplete = () => {
                    db.close();
                    resolve();
                };

                transaction.onerror = () => {
                    db.close();
                    reject(transaction.error);
                };
            };

            request.onerror = () => reject(request.error);
        });
    },

    async loadKeyPairFromDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open("LuckyChatCrypto", 1);

            request.onupgradeneeded = () => {
                const db = request.result;

                if (!db.objectStoreNames.contains("keys")) {
                    db.createObjectStore("keys");
                }
            };

            request.onsuccess = () => {
                const db = request.result;
                const transaction = db.transaction("keys", "readonly");
                const store = transaction.objectStore("keys");
                const getRequest = store.get("identity");

                getRequest.onsuccess = () => {
                    const result = getRequest.result || null;
                    db.close();
                    resolve(result);
                };

                getRequest.onerror = () => {
                    db.close();
                    reject(getRequest.error);
                };
            };

            request.onerror = () => reject(request.error);
        });
    }
};
