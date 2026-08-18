const LuckyCrypto = {
    initialized: false,
    keyPair: null,

    async init() {
        if (!window.crypto?.subtle) {
            throw new Error("Web Crypto API is not available");
        }

        await this.loadOrCreateKeyPair();

        this.initialized = true;
        console.log("✅ LuckyCrypto initialized");
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

        if (stored?.publicKey && stored?.privateKey) {
            this.keyPair = stored;
            console.log("🔑 Existing encryption key loaded");
            return;
        }

        this.keyPair = await this.generateKeyPair();

        await this.saveKeyPairToDB(this.keyPair);

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

    async saveKeyPairToDB(keyPair) {
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

                store.put(keyPair, "identity");

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
