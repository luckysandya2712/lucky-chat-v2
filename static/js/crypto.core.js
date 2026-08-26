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
            true,
            ["encrypt"]
        );
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
    return keys[0].publicKey;
},

async publicKeyId(publicKey) {
    const spki = await window.crypto.subtle.exportKey(
        "spki",
        publicKey
    );

    const digest = await window.crypto.subtle.digest(
        "SHA-256",
        spki
    );

    return Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 24);
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

    if (!plaintext) return plaintext;
    if (!recipient) throw new Error("Recipient username is required");
    if (!sender) throw new Error("Sender username is required");

    const recipientPublicKeys = await this.getPublicKeys(recipient);
    const senderPublicKey = this.keyPair.publicKey;
    const senderKeyId = await this.publicKeyId(senderPublicKey);

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

    const senderWrappedKey = await window.crypto.subtle.encrypt(
        { name: "RSA-OAEP" },
        senderPublicKey,
        rawAesKey
    );

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
            [sender]: [{
                id: senderKeyId,
                wrapped: this.arrayBufferToBase64(senderWrappedKey)
            }],
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
    await this.ensureReady();

    if (!this.isEncryptedMessage(value)) return value;

    const username = String(currentUsername || "").trim();
    if (!username) {
        throw new Error("Current username is required for decryption");
    }

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

    const seen = new Set();
    for (const attempt of attempts) {
        if (seen.has(attempt.wrapped)) continue;
        seen.add(attempt.wrapped);

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


    clearCachedPublicKey(username) {
        const name = String(username || "").trim();
        if (name) this.publicKeyCache.delete(name);
    },


async loadExistingKeyPair() {
    const stored = await this.loadKeyPairFromDB();

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
    });

    // Restore this key as current while the server keeps earlier public
    // keys in history.
    await this.uploadPublicKey();
    this.publicKeyCache.clear();
    this.initialized = true;

    return true;
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
