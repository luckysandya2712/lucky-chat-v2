function getCookie(name){
    const value="; "+document.cookie;
    const parts=value.split("; "+name+"=");
    if(parts.length===2){
        return parts.pop().split(";").shift();
    }
    return "";
}

const username=getCookie("username");
const friend = document.body.dataset.chatFriend;

const messages=document.querySelector(".messages");

const input = document.getElementById("messageInput");
const button = document.getElementById("sendBtn");

const imageBtn = document.getElementById("imageBtn");
const imageInput = document.getElementById("imageInput");

const voiceBtn = document.getElementById("voiceBtn");
const audioPreview = document.getElementById("audioPreview");
const audioPreviewTime = document.getElementById("audioPreviewTime");
const removeAudioBtn = document.getElementById("removeAudioBtn");

let mediaRecorder = null;
let recordingChunks = [];
let recordingStartedAt = 0;
let recordingTimer = null;
let recordingMimeType = "";

let socket = null;
let reconnectTimer = null;
let pendingReadIds = new Set();
let pendingDeliveredIds = new Set();

// Messages rendered locally before the server echoes them back.
// The queue lets us reconcile the server's real message id/timestamp
// without showing the same outgoing message twice.
let pendingOutgoingMessages = [];

function formatAudioTime(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds || 0));
    const minutes = Math.floor(seconds / 60);
    const rest = String(seconds % 60).padStart(2, "0");
    return `${minutes}:${rest}`;
}

function setAudioPreview(seconds) {
    if (audioPreviewTime) {
        audioPreviewTime.textContent = formatAudioTime(seconds);
    }
}

function showAudioPreview(seconds) {
    setAudioPreview(seconds);
    if (audioPreview) audioPreview.style.display = "flex";
}

function clearAudioPreview() {
    window.selectedChatAudio = null;
    if (audioPreview) audioPreview.style.display = "none";
    setAudioPreview(0);
}

function stopRecordingTimer() {
    clearInterval(recordingTimer);
    recordingTimer = null;
}

function updateRecordingTime() {
    const elapsed = (Date.now() - recordingStartedAt) / 1000;
    const time = document.getElementById("recordingTime");
    if (time) time.textContent = formatAudioTime(elapsed);
}

function showRecordingBar() {
    let bar = document.getElementById("voiceRecordingBar");

    if (!bar) {
        bar = document.createElement("div");
        bar.id = "voiceRecordingBar";
        bar.className = "voice-recording-bar";
        bar.innerHTML = `
            <span class="voice-recording-dot" aria-hidden="true"></span>
            <span class="voice-recording-text">Recording <span id="recordingTime">0:00</span></span>
            <button type="button" class="voice-cancel-btn" id="cancelRecordingBtn" aria-label="Cancel recording">✕</button>
        `;
        document.body.appendChild(bar);

        document.getElementById("cancelRecordingBtn")
            .addEventListener("click", cancelVoiceRecording);
    }

    bar.style.display = "flex";
    recordingStartedAt = Date.now();
    updateRecordingTime();
    stopRecordingTimer();
    recordingTimer = setInterval(updateRecordingTime, 250);
}

function hideRecordingBar() {
    const bar = document.getElementById("voiceRecordingBar");
    if (bar) bar.style.display = "none";
    stopRecordingTimer();
}

function chooseRecordingMimeType() {
    const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/mp4"
    ];

    return candidates.find(type =>
        window.MediaRecorder &&
        MediaRecorder.isTypeSupported(type)
    ) || "";
}

async function startVoiceRecording() {
    if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
        alert("Voice recording is not supported by this browser.");
        return;
    }

    if (mediaRecorder && mediaRecorder.state === "recording") return;

    clearAudioPreview();

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: true
        });

        recordingChunks = [];
        recordingMimeType = chooseRecordingMimeType();

        mediaRecorder = recordingMimeType
            ? new MediaRecorder(stream, { mimeType: recordingMimeType })
            : new MediaRecorder(stream);

        mediaRecorder.addEventListener("dataavailable", event => {
            if (event.data && event.data.size > 0) {
                recordingChunks.push(event.data);
            }
        });

        mediaRecorder.addEventListener("stop", async () => {
            stream.getTracks().forEach(track => track.stop());

            const duration = Math.min(
                120,
                Math.max(0, Math.round((Date.now() - recordingStartedAt) / 1000))
            );

            hideRecordingBar();

            const actualType =
                mediaRecorder?.mimeType ||
                recordingMimeType ||
                "audio/webm";

            const blob = new Blob(recordingChunks, { type: actualType });

            recordingChunks = [];

            if (!blob.size) {
                alert("No audio was recorded.");
                if (voiceBtn) voiceBtn.classList.remove("recording");
                return;
            }

            try {
                const extension =
                    actualType.includes("ogg") ? "ogg" :
                    actualType.includes("mp4") ? "m4a" :
                    actualType.includes("mpeg") ? "mp3" : "webm";

                // Send the audio as the raw request body. This is more reliable
                // than multipart/form-data through HTTPS tunnels on mobile.
                const response = await fetch("/upload-chat-audio?filename=voice_" + Date.now() + "." + extension, {
                    method: "POST",
                    credentials: "same-origin",
                    headers: {
                        "Content-Type": actualType.split(";", 1)[0]
                    },
                    body: blob
                });

                if (!response.ok) {
                    let serverError = "Voice upload failed (HTTP " + response.status + ")";
                    try {
                        const errorData = await response.json();
                        serverError = errorData.error || serverError;
                    } catch (_) {}
                    throw new Error(serverError);
                }

                const result = await response.json();

                if (!response.ok || !result.success) {
                    throw new Error(result.error || "Voice upload failed");
                }

                window.selectedChatAudio = {
                    url: result.url,
                    media_type: result.media_type,
                    duration
                };

                showAudioPreview(duration);

            } catch (error) {
                console.error("VOICE UPLOAD ERROR:", error);
                alert(error.message || "Could not upload voice message");
                clearAudioPreview();
            }

            if (voiceBtn) {
                voiceBtn.classList.remove("recording");
                voiceBtn.textContent = "🎙️";
            }
        });

        mediaRecorder.addEventListener("error", event => {
            console.error("VOICE RECORDING ERROR:", event.error);
            stream.getTracks().forEach(track => track.stop());
            hideRecordingBar();
            if (voiceBtn) {
                voiceBtn.classList.remove("recording");
                voiceBtn.textContent = "🎙️";
            }
        });

        mediaRecorder.start(250);
        showRecordingBar();

        voiceBtn.classList.add("recording");
        voiceBtn.textContent = "⏹️";

        // Safety limit: 2 minutes.
        setTimeout(() => {
            if (mediaRecorder && mediaRecorder.state === "recording") {
                stopVoiceRecording();
            }
        }, 120000);

    } catch (error) {
        console.error("MICROPHONE ERROR:", error);
        alert("Microphone access was not granted.");
    }
}

function stopVoiceRecording() {
    if (!mediaRecorder || mediaRecorder.state !== "recording") return;

    mediaRecorder.stop();
}

function cancelVoiceRecording() {
    if (!mediaRecorder || mediaRecorder.state !== "recording") {
        hideRecordingBar();
        if (voiceBtn) {
            voiceBtn.classList.remove("recording");
            voiceBtn.textContent = "🎙️";
        }
        recordingChunks = [];
        return;
    }

    const recorder = mediaRecorder;
    const stream = recorder.stream;

    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder.onerror = null;

    try {
        recorder.stop();
    } catch (_) {}

    stream.getTracks().forEach(track => track.stop());

    mediaRecorder = null;
    recordingChunks = [];
    hideRecordingBar();

    if (voiceBtn) {
        voiceBtn.classList.remove("recording");
        voiceBtn.textContent = "🎙️";
    }
}

function toggleVoiceMessage(button) {
    const bubble = button?.closest(".voice-message");
    const audio = bubble?.querySelector("audio[data-voice-audio='1']");

    if (!audio) return;

    document.querySelectorAll("audio[data-voice-audio='1']").forEach(other => {
        if (other !== audio && !other.paused) {
            other.pause();
            other.currentTime = 0;

            const otherButton =
                other.closest(".voice-message")?.querySelector(".voice-play-btn");

            if (otherButton) otherButton.textContent = "▶";
        }
    });

    if (audio.paused) {
        audio.play().then(() => {
            button.textContent = "⏸";
        }).catch(error => {
            console.error("VOICE PLAY ERROR:", error);
        });
    } else {
        audio.pause();
        button.textContent = "▶";
    }

    audio.onended = () => {
        button.textContent = "▶";
        audio.currentTime = 0;
    };
}

voiceBtn?.addEventListener("click", () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
        stopVoiceRecording();
    } else {
        startVoiceRecording();
    }
});

removeAudioBtn?.addEventListener("click", clearAudioPreview);

async function updateFriendStatus() {
    try {
        const response = await fetch(
            "/user-status/" + encodeURIComponent(friend)
        );

        if (!response.ok) {
            throw new Error("Status request failed");
        }

        const data = await response.json();

        if (data.online) {
            document.getElementById("online-users").innerHTML = "🟢 Online";
            return;
        }

        if (!data.last_seen) {
            document.getElementById("online-users").innerHTML = "⚫ Offline";
            return;
        }

        // The backend stores naive timestamps in the database. Treat a
        // timezone-less value as UTC so the browser converts it to the
        // device's local timezone (IST on your phone).
        let rawLastSeen = String(data.last_seen || "").trim();
        if (rawLastSeen && !/[zZ]|[+-]\d{2}:\d{2}$/.test(rawLastSeen)) {
            rawLastSeen += "Z";
        }

        const date = new Date(rawLastSeen);
        const now = new Date();

        const sameDay =
            date.toDateString() === now.toDateString();

        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);

        const isYesterday =
            date.toDateString() === yesterday.toDateString();

        const time = date.toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
            hour12: true
        });

        if (sameDay) {

            document.getElementById("online-users").innerHTML =
                "⚫ Last seen today at " + time;

        } else if (isYesterday) {

            document.getElementById("online-users").innerHTML =
                "⚫ Last seen yesterday at " + time;

        } else {

            document.getElementById("online-users").innerHTML =
                "⚫ Last seen " +
                date.toLocaleDateString([], {
                    day: "2-digit",
                    month: "short"
                }) +
                " at " +
                time;
        }

    } catch (error) {

        console.error(
            "Status check failed:",
            error
        );

        document.getElementById("online-users").innerHTML = "⚫ Offline";
    }
}

// updateFriendStatus() is called after DOM is ready (see bottom init)

let selectedMessageId = null;
let pressTimer = null;
let longPressTriggered = false;

let replyToId = null;
let replyPreview = null;
let messageMap = {};

function pinnedStorageKey(){
    return "lucky_chat_pinned_" + username + "_" + friend;
}

function loadPinnedMessages(){
    try{
        const raw = localStorage.getItem(pinnedStorageKey());
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.map(Number) : [];
    }catch(e){
        return [];
    }
}

function savePinnedMessages(){
    try{
        localStorage.setItem(
            pinnedStorageKey(),
            JSON.stringify(pinnedMessages)
        );
    }catch(e){
        console.debug("Could not save pinned messages:", e);
    }
}

function isMessagePinned(id){
    return pinnedMessages.includes(Number(id));
}

function getPinnedMessages(){
    return pinnedMessages
        .map(id => messageMap[id])
        .filter(Boolean);
}

function renderPinnedBadge(id){
    const bubble = document.querySelector(`[data-msg="${id}"]`);
    if(!bubble) return;

    const old = bubble.querySelector(".pinned-badge");
    if(old) old.remove();

    if(isMessagePinned(id)){
        const meta = bubble.querySelector(".msg-meta");
        if(meta){
            const badge = document.createElement("div");
            badge.className = "pinned-badge";
            badge.textContent = "📌 Pinned";
            meta.insertAdjacentElement("afterend", badge);
        }
        bubble.classList.add("pinned-message");
    }else{
        bubble.classList.remove("pinned-message");
    }
}

function renderPinnedBar(){
    const bar = document.getElementById("pinnedBar");
    const text = document.getElementById("pinnedBarText");
    const count = document.getElementById("pinnedBarCount");

    if(!bar || !text || !count) return;

    const pinned = getPinnedMessages();

    if(!pinned.length || pinnedBarHidden){
        bar.style.display = "none";
        return;
    }

    const latest = pinned[pinned.length - 1];
    const sender = latest.sender === username ? "You" : latest.sender;
    const preview = latest.media_type === "image" && latest.media_url
        ? "📷 Photo"
        : (latest.text || "Message");

    text.textContent = sender + ": " + preview;
    count.textContent = pinned.length > 1 ? `${pinned.length} pinned` : "";
    bar.style.display = "flex";
}

function hidePinnedBar(){
    pinnedBarHidden = true;
    const bar = document.getElementById("pinnedBar");
    if(bar) bar.style.display = "none";
}

function jumpToLatestPinned(){
    const pinned = getPinnedMessages();
    if(!pinned.length) return;

    const latest = pinned[pinned.length - 1];
    const bubble = document.querySelector(`[data-msg="${latest.id}"]`);

    if(!bubble){
        renderPinnedBar();
        return;
    }

    bubble.scrollIntoView({
        behavior:"smooth",
        block:"center"
    });

    bubble.classList.remove("search-hit");
    bubble.classList.remove("reply-highlight");
    void bubble.offsetWidth;
    bubble.classList.add("reply-highlight");

    setTimeout(()=>{
        bubble.classList.remove("reply-highlight");
    },1200);
}

function togglePinSelectedMessage(){
    if(selectedMessageId == null) return;

    const id = Number(selectedMessageId);
    const msg = messageMap[id];

    if(!msg){
        hideMessageMenu();
        return;
    }

    const index = pinnedMessages.indexOf(id);

    if(index >= 0){
        pinnedMessages.splice(index,1);
    }else{
        pinnedMessages.push(id);
    }

    savePinnedMessages();
    renderPinnedBadge(id);

    pinnedBarHidden = false;
    renderPinnedBar();
    hideMessageMenu();
}

let pinnedMessages = loadPinnedMessages();
let pinnedBarHidden = false;

function getReactionStorageKey() {
    return "reactions_" + username + "_" + friend;
}

function getDeletedMessagesStorageKey() {
    return "deleted_messages_" + username + "_" + friend;
}

function loadDeletedMessages() {
    try {
        return JSON.parse(
            localStorage.getItem(
                getDeletedMessagesStorageKey()
            ) || "{}"
        );
    } catch (error) {
        return {};
    }
}

function saveDeletedMessages() {
    localStorage.setItem(
        getDeletedMessagesStorageKey(),
        JSON.stringify(deletedMessages)
    );
}

let deletedMessages = loadDeletedMessages();

function loadSavedReactions() {
    try {
        return JSON.parse(
            localStorage.getItem(getReactionStorageKey()) || "{}"
        );
    } catch (error) {
        return {};
    }
}

function saveReactions() {
    const reactions = {};

    Object.keys(messageMap).forEach(id => {
        if (messageMap[id].reaction) {
            reactions[id] = messageMap[id].reaction;
        }
    });

    localStorage.setItem(
        getReactionStorageKey(),
        JSON.stringify(reactions)
    );
}


const DASHBOARD_PREVIEW_PREFIX = "lucky_chat_dashboard_preview:";

function getDashboardPreviewKey(otherUser) {
    return DASHBOARD_PREVIEW_PREFIX +
        String(username || "") + ":" +
        String(otherUser || "");
}

function saveDashboardPreview(msg) {
    if (!msg || !friend) return;

    const preview = {
        id: Number(msg.id) || 0,
        sender: msg.sender || username,
        receiver: msg.receiver || friend,
        text: msg.text || "",
        timestamp: msg.timestamp || new Date().toISOString(),
        media_url: msg.media_url || null,
        media_type: msg.media_type || null
    };

    try {
        localStorage.setItem(
            getDashboardPreviewKey(friend),
            JSON.stringify(preview)
        );
    } catch (error) {
        console.warn("Dashboard preview cache write failed:", error);
    }
}

async function loadMessages() {

    const res = await fetch("/messages/" + friend, {
        cache: "no-store",
        credentials: "same-origin"
    });

    if (!res.ok) {
        throw new Error("Failed to load messages (HTTP " + res.status + ")");
    }

    const data = await res.json();
    const savedReactions = loadSavedReactions();

    // IMPORTANT: Do not clear the chat while history is being decrypted.
    // A user can send a message while the initial history is loading; the
    // optimistic bubble must stay visible immediately instead of disappearing
    // until a later message causes another render.
    const existingLiveMessages = new Map();

    messages.querySelectorAll(".message-row").forEach(row => {
        const bubble = row.querySelector("[data-msg]");
        if (!bubble) return;

        const id = String(bubble.getAttribute("data-msg"));
        const numericId = Number(id);
        const msg = messageMap[numericId];

        if (msg) {
            existingLiveMessages.set(id, msg);
        }
    });

    // Remove the static welcome bubble only. Keep every live/optimistic message.
    messages.querySelectorAll(".message:not(.message-own):not(.message-other)").forEach(el => {
        if (el.textContent.trim() === "Welcome to Lucky Chat 🚀") {
            el.closest(".message-row")?.remove();
            el.remove();
        }
    });

    // Decrypt history in small batches with browser paint opportunities in
    // between. Large chats can contain hundreds of RSA/AES envelopes; starting
    // all decryptions in one Promise.all can starve Android Chrome long enough
    // to make a newly-sent message appear only after a later interaction.
    const HISTORY_BATCH_SIZE = 12;
    const decrypted = [];

    const yieldToBrowser = () => new Promise(resolve => {
        if (window.requestAnimationFrame) {
            requestAnimationFrame(() => resolve());
        } else {
            setTimeout(resolve, 0);
        }
    });

    for (let start = 0; start < data.length; start += HISTORY_BATCH_SIZE) {
        const batch = data.slice(start, start + HISTORY_BATCH_SIZE);

        const batchResults = await Promise.all(
            batch.map(async rawMsg => {
                const msg = { ...rawMsg };

                if (deletedMessages[msg.id]) {
                    return null;
                }

                if (savedReactions[msg.id]) {
                    msg.reaction = savedReactions[msg.id];
                }

                try {
                    msg.text = await LuckyCrypto.decryptMessage(msg.text, username);
                } catch (error) {
                    console.error("MESSAGE DECRYPTION ERROR:", error, msg.id);
                    msg.text = "🔒 Unable to decrypt this message";
                }

                return msg;
            })
        );

        decrypted.push(...batchResults);
        await yieldToBrowser();
    }

    const history = decrypted.filter(Boolean);

    // IMPORTANT: loadMessages() can overlap with a live WebSocket message.
    // During the many async decrypt/yield steps above, socket.onmessage may
    // have already inserted newer messages into messageMap. The old
    // implementation replaced messageMap with the HTTP history and therefore
    // could erase a newly-sent/received message until another event caused a
    // later refresh.
    //
    // Snapshot ALL live state that exists at the end of the history request,
    // not just what happened to be in the DOM when loadMessages() started.
    const liveMessagesAfterHistoryLoad = Object.values(messageMap);

    const merged = new Map();

    // Server history is the durable source of truth.
    history.forEach(msg => {
        merged.set(String(msg.id), msg);
    });

    // Live/optimistic state wins for matching IDs because it can contain a
    // newer delivery/read state or a message that was created after the HTTP
    // history response was taken.
    liveMessagesAfterHistoryLoad.forEach(msg => {
        if (!msg || deletedMessages[msg.id]) return;
        merged.set(String(msg.id), msg);
    });

    // Also retain the live DOM snapshot as a final fallback. This covers the
    // tiny window where a bubble exists but messageMap was not populated yet.
    existingLiveMessages.forEach(msg => {
        if (!msg || deletedMessages[msg.id]) return;
        merged.set(String(msg.id), msg);
    });

    const combinedMessages = Array.from(merged.values())
        .filter(msg => !deletedMessages[msg.id])
        .sort((a, b) => {
            const ai = Number(a.id);
            const bi = Number(b.id);

            if (Number.isFinite(ai) && Number.isFinite(bi)) {
                return ai - bi;
            }

            return String(a.timestamp || "").localeCompare(
                String(b.timestamp || "")
            );
        });

    // Rebuild the canonical in-memory map from the merged set.
    messageMap = {};
    combinedMessages.forEach(msg => {
        messageMap[msg.id] = msg;
    });

    pinnedMessages = pinnedMessages.filter(id => messageMap[id]);
    savePinnedMessages();

    // Re-render once, not once per message. This avoids hundreds of layout/
    // scroll operations on large conversations.
    messages.innerHTML = "";
    window.__suppressChatAutoScroll = true;

    combinedMessages.forEach(msg => {
        addMessage(msg);
    });

    window.__suppressChatAutoScroll = false;
    messages.scrollTop = messages.scrollHeight;

    // Update the dashboard preview exactly once from the newest merged
    // conversation message. This prevents an older history item from
    // overwriting a newer live message while history is being decrypted.
    const latestMessage = combinedMessages[combinedMessages.length - 1];
    if (latestMessage) {
        saveDashboardPreview(latestMessage);
    }

    // Queue delivery/read acknowledgements until the WebSocket is connected.
    history.forEach(msg => {
        if (msg.sender !== username && !deletedMessages[msg.id]) {
            pendingDeliveredIds.add(Number(msg.id));
            pendingReadIds.add(Number(msg.id));
        }
    });

    flushPendingReceiptAcknowledgements();
}

function flushPendingReceiptAcknowledgements() {

    if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
    }

    pendingDeliveredIds.forEach(id => {
        sendSocket({
            type: "delivered",
            id
        });
    });

    pendingReadIds.forEach(id => {
        sendSocket({
            type: "read",
            id
        });
    });

    pendingDeliveredIds.clear();
    pendingReadIds.clear();
}

function queueMessageReceipt(id) {
    if (id == null) return;

    const numericId = Number(id);
    pendingDeliveredIds.add(numericId);
    if (friend) {
        pendingReadIds.add(numericId);
    }

    flushPendingReceiptAcknowledgements();
}

function startReply(id) {

    const msg = messageMap[id];

    if (!msg) return;

    replyToId = id;

    const sender =
        msg.sender === username ? "You" : msg.sender;

    document.getElementById("replySender").innerText = sender;

    const replyText =
        document.getElementById("replyText");

    if (msg.media_type === "image" && msg.media_url) {

        replyText.innerHTML = `
            <span class="reply-preview-media">
                <img
                    class="reply-preview-thumb"
                    src="${escapeHTML(msg.media_url)}"
                    alt="Photo"
                >
                <span class="reply-preview-media-label">
                    Photo
                </span>
            </span>
        `;

    } else if (msg.media_type === "audio" && msg.media_url) {

        replyText.innerHTML = `
            <span class="reply-preview-media">
                <span class="reply-media-icon">🎙️</span>
                <span class="reply-preview-media-label">
                    Voice message
                </span>
            </span>
        `;

    } else {

        replyText.textContent =
            msg.text || "Message";
    }

    document.getElementById("replyPreview").style.display = "flex";

    input.focus();
}

function jumpToRepliedMessage(id){

    const original = document.querySelector(
        `[data-msg="${id}"]`
    );

    if (!original) {
        console.log("Original replied message not found:", id);
        return;
    }

    original.scrollIntoView({
        behavior: "smooth",
        block: "center"
    });

    original.classList.remove("reply-highlight");

    // Force the animation to restart
    void original.offsetWidth;

    original.classList.add("reply-highlight");

    setTimeout(() => {
        original.classList.remove("reply-highlight");
    }, 1200);
}

function copyMessage(){
    const bubble = document.querySelector(
        `[data-msg="${selectedMessageId}"]`
    );

    if(bubble){
        navigator.clipboard.writeText(
            bubble.innerText.replace("✔","").replace("✔✔","").trim()
        );
    }

    hideMessageMenu();
}

function replyMessage(){

    if (selectedMessageId == null) return;

    startReply(selectedMessageId);

    hideMessageMenu();
}

let editingMessageId = null;

function editMessage(){

    if (selectedMessageId == null) return;

    const msg = messageMap[selectedMessageId];

    if (!msg) {
        hideMessageMenu();
        return;
    }

    if (msg.sender !== username) {
        hideMessageMenu();
        return;
    }

    editingMessageId = selectedMessageId;

    const modal = document.getElementById("editModalOverlay");
    const editInput = document.getElementById("editMessageInput");

    if (!modal || !editInput) {
        console.error("Edit modal elements not found");
        hideMessageMenu();
        return;
    }

    editInput.value = msg.text || "";

    hideMessageMenu();

    modal.style.display = "flex";

    setTimeout(() => {
        editInput.focus();

        editInput.setSelectionRange(
            editInput.value.length,
            editInput.value.length
        );
    }, 50);
}


function closeEditModal(){

    const modal = document.getElementById("editModalOverlay");
    const editInput = document.getElementById("editMessageInput");

    if (modal) {
        modal.style.display = "none";
    }

    if (editInput) {
        editInput.value = "";
    }

    editingMessageId = null;
}


async function saveEditedMessage(){

    if (editingMessageId == null) {
        closeEditModal();
        return;
    }

    const msg = messageMap[editingMessageId];

    if (!msg) {
        closeEditModal();
        return;
    }

    const editInput = document.getElementById("editMessageInput");

    if (!editInput) {
        closeEditModal();
        return;
    }

    const text = editInput.value.trim();

    // Don't send an empty or unchanged message
    if (text === "" || text === msg.text) {
        closeEditModal();
        return;
    }

    if (!socket || socket.readyState !== WebSocket.OPEN) {
        console.error("Socket is not connected!");
        closeEditModal();
        return;
    }

    let encryptedText;
    try {
        await LuckyCrypto.ensureReady();
        encryptedText = await LuckyCrypto.encryptMessage(
            text,
            friend,
            username
        );
    } catch (error) {
        console.error("EDIT ENCRYPTION ERROR:", error);
        closeEditModal();
        return;
    }

    const sent = sendSocket({
        type: "edit_message",
        id: editingMessageId,
        text: encryptedText
    });

    if (sent) {

        // Update this device immediately.
        msg.text = text;
        msg.edited = 1;

        const bubble = document.querySelector(
            `[data-msg="${editingMessageId}"]`
        );

        if (bubble) {

            const textElement = bubble.querySelector(".msg-text");
            const timeElement = bubble.querySelector(".msg-time");

            if (textElement) {
                textElement.textContent = text;
            }

            if (timeElement &&
                !timeElement.parentElement.querySelector(".edited-label")) {

                const editedLabel = document.createElement("span");
                editedLabel.className = "edited-label";
                editedLabel.textContent = "(edited)";
                timeElement.insertAdjacentElement("afterend", editedLabel);
            }
        }

        closeEditModal();
    }
}


// Close the modal when tapping outside the box
document.getElementById("editModalOverlay")
    ?.addEventListener("click", function(e) {

        if (e.target === this) {
            closeEditModal();
        }

    });

function connectSocket() {

document.getElementById("online-users").innerHTML =
    "🔄 Connecting...";

console.log("CONNECT SOCKET STARTED");
console.log("WebSocket URL:",
    (location.protocol === "https:" ? "wss://" : "ws://") +
    location.host +
    "/ws?friend=" + encodeURIComponent(friend) +
    "&page=chat"
);

    if (socket && socket.readyState === WebSocket.OPEN) {
    return;
}

    if (socket && socket.readyState === WebSocket.CONNECTING) {
        console.log("Socket is still connecting...");
        return;
}

    console.log("Connecting chat WebSocket...");

    socket = new WebSocket(
        (location.protocol === "https:" ? "wss://" : "ws://") +
        location.host +
        "/ws?friend=" + encodeURIComponent(friend) +
        "&page=chat"
    );

    socket.onopen = () => {
    console.log("Chat WebSocket connected");

    updateFriendStatus();
    flushPendingReceiptAcknowledgements();

    // Messages created while the socket was still connecting must be sent
    // immediately after the connection opens. Start each send in a separate
    // task so crypto work cannot block the browser from painting the already
    // rendered optimistic bubble.
    const queued = pendingOutgoingMessages.slice();
    queued.forEach(item => {
        if (!item.attempted && item.message) {
            setTimeout(() => {
                void sendOptimisticMessage(
                    item.message,
                    item.message.media_type === "image" ? {
                        url: item.message.media_url,
                        media_type: item.message.media_type
                    } : null,
                    item.message.media_type === "audio" ? {
                        url: item.message.media_url,
                        media_type: item.message.media_type,
                        duration: item.message.media_duration || 0
                    } : null
                );
            }, 0);
        }
    });

    clearTimeout(reconnectTimer);
    reconnectTimer = null;
};

    socket.onmessage = async (event) => {
        // Do not log every WebSocket receipt/read event.
        // The chat can receive hundreds of acknowledgements and excessive
        // console logging on mobile can delay visible UI updates.
        try {
            await handleSocketMessage(event);
        } catch (error) {
            console.error("Socket message handling error:", error);
        }
    };

    socket.onerror = (error) => {
    console.error("Chat WebSocket error:", error);

    document.getElementById("online-users").innerHTML =
        "🔴 Connection error";
};

    socket.onclose = () => {
        console.log("Chat WebSocket closed");

        document.getElementById("online-users").innerHTML =
            "🔴 Disconnected";

        clearTimeout(reconnectTimer);

        reconnectTimer = setTimeout(() => {
            console.log("Reconnecting chat WebSocket...");
            socket = null;
            connectSocket();
        }, 2000);
    };

}

function sendSocket(data) {

    if (socket && socket.readyState === WebSocket.OPEN) {

        socket.send(JSON.stringify(data));

        return true;
    }

    console.log(
        "⚠️ Socket not connected:",
        data
    );

    return false;
}

async function handleSocketMessage(event) {

    const data = JSON.parse(event.data);

    if (data.type === "message") {
        // Outgoing messages are already rendered locally. Never make the
        // sender's own message wait for another encryption/decryption cycle.
        // The old flow decrypted the echoed ciphertext before reconciling it,
        // which could visibly delay the just-sent message on mobile.
        if (data.sender === username) {
            // Newer backend: reconcile immediately using client_id.
            if (reconcileOutgoingMessage(data)) {
                return;
            }

            // Older backend: it may not echo client_id. Decrypt the echoed
            // ciphertext and then retry reconciliation using plaintext.
            try {
                data.text = await LuckyCrypto.decryptMessage(data.text, username);
            } catch (error) {
                console.error("LIVE MESSAGE DECRYPTION ERROR:", error, data.id);
                data.text = "🔒 Unable to decrypt this message";
            }

            if (reconcileOutgoingMessage(data)) {
                return;
            }

            // Not one of our locally pending messages: render it normally.
            addMessage(data);
            return;
        }

        try {
            data.text = await LuckyCrypto.decryptMessage(data.text, username);
        } catch (error) {
            console.error("LIVE MESSAGE DECRYPTION ERROR:", error, data.id);
            data.text = "🔒 Unable to decrypt this message";
        }

        addMessage(data);
        saveDashboardPreview(data);
        queueMessageReceipt(data.id);
        return;
    }

    if (data.type === "read") {

    console.log("READ EVENT RECEIVED:", data.id);

    const message = document.querySelector(
        `[data-msg="${data.id}"]`
    );

    console.log("MESSAGE FOUND:", message);

    const tick = document.querySelector(
        `[data-msg="${data.id}"] .ticks`
    );

    console.log("TICK FOUND:", tick);

    if (tick) {
        tick.innerHTML = "✔✔";
        tick.classList.add("read");
    }

    return;
}

    if (data.type === "online") {
        updateFriendStatus();
        return;
    }

    if (data.type === "typing") {

        document.getElementById("online-users").innerHTML =
            "⌨️ " + data.sender + " is typing...";

        clearTimeout(window.typingTimer);

        window.typingTimer = setTimeout(() => {

            updateFriendStatus();

        }, 2500);

        return;
    }


    if (data.type === "stop_typing") {

        updateFriendStatus();

        return;
    }


    if (data.type === "delivered") {

        const tick = document.querySelector(
            `[data-msg="${data.id}"] .ticks`
        );

        if (tick) {
            tick.innerHTML = "✓✓";
        }

        return;
    }

    if (data.type === "reaction") {

        const msg = messageMap[data.id];

        if (msg) {
            msg.reaction = data.reaction || "";
        }

        const bubble = document.querySelector(
            `[data-msg="${data.id}"]`
        );

        if (bubble) {

            let reactionBox =
                bubble.querySelector(".reaction");

            if (!data.reaction) {

                if (reactionBox) {
                    reactionBox.remove();
                }

            } else {

                if (!reactionBox) {
                    reactionBox =
                        document.createElement("div");

                    reactionBox.className = "reaction";
                    bubble.appendChild(reactionBox);
                }

                reactionBox.innerText = data.reaction;
            }
        }

        // Keep the local browser copy in sync too.
        saveReactions();

        return;
    }


    if (data.type === "edit_message") {

        try {
            data.text = await LuckyCrypto.decryptMessage(data.text, username);
        } catch (error) {
            console.error("LIVE EDIT DECRYPTION ERROR:", error, data.id);
            data.text = "🔒 Unable to decrypt this message";
        }

        const bubble = document.querySelector(
            `[data-msg="${data.id}"]`
        );

        if (bubble) {

            const textElement =
                bubble.querySelector(".msg-text");

            if (textElement) {
                textElement.textContent = data.text;
            }

            const timeElement = bubble.querySelector(".msg-time");

            if (timeElement &&
                !timeElement.parentElement.querySelector(".edited-label")) {

                const editedLabel = document.createElement("span");
                editedLabel.className = "edited-label";
                editedLabel.textContent = "(edited)";
                timeElement.insertAdjacentElement("afterend", editedLabel);
            }
        }

        if (messageMap[data.id]) {

            messageMap[data.id].text = data.text;
            messageMap[data.id].edited = 1;
        }

        return;
    }


    if (data.type === "delete_everyone") {

        const bubble = document.querySelector(
            `[data-msg="${data.id}"]`
        );

        if (bubble) {

            const textElement =
                bubble.querySelector(".msg-text");

            if (textElement) {

                textElement.innerHTML =
                    "🚫 <i>This message was deleted</i>";
            }
        }

        return;
    }

        if (data.type === "profile_picture_update") {

        if (data.username === friend) {

            const newPicture =
                data.profile || "/static/profile/default.png";

            document
                .querySelectorAll(".header-avatar, .msg-avatar")
                .forEach(img => {
                    img.src = newPicture;
                });
        }

        return;
    }

} // closes handleSocketMessage()

async function initChatCore() {
    // Open the live socket FIRST. Crypto/history work must never block the
    // browser from accepting and painting a new outgoing message.
    connectSocket();

    const cryptoReadyPromise = LuckyCrypto.init()
        .then(() => {
            console.log("✅ LuckyCrypto ready");
            return true;
        })
        .catch(error => {
            console.warn("⚠️ LuckyCrypto unavailable:", error);
            return false;
        });

    // History decryption needs crypto, but the socket is already live so a
    // user can send immediately even on a large conversation.
    try {
        await cryptoReadyPromise;
        await loadMessages();
    } catch (error) {
        console.error("Initial message load failed:", error);
    }

    updateFriendStatus();
    bindImageAndSendControls();
    setupPushNotifications();
}

function bindImageAndSendControls() {
    // Image attach button
    if (imageBtn && imageInput) {
        imageBtn.addEventListener("click", () => {
            imageInput.click();
        });
    }

    // Image file selected → upload via core helper
    if (imageInput) {
        imageInput.addEventListener("change", async () => {
            if (typeof uploadChatImage === "function") {
                await uploadChatImage();
                return;
            }
        });
    }

    // Remove selected image / audio preview
    const removeImageBtn = document.getElementById("removeImageBtn");
    if (removeImageBtn) {
        removeImageBtn.addEventListener("click", () => {
            if (typeof removeSelectedImage === "function") {
                removeSelectedImage();
                return;
            }
            window.selectedChatImage = null;
            window.selectedChatAudio = null;
            const preview = document.getElementById("imagePreview");
            const previewImage = document.getElementById("previewImage");
            if (preview) preview.style.display = "none";
            if (typeof clearAudioPreview === "function") clearAudioPreview();
            if (previewImage) previewImage.src = "";
            if (imageInput) imageInput.value = "";
        });
    }

    // Send button
    if (button) {
        button.onclick = function () {
            sendMessage();
        };
    }
}

function setupPushNotifications() {
    async function requestNotify() {
        if ("Notification" in window && Notification.permission === "default") {
            try {
                await Notification.requestPermission();
            } catch (e) {}
        }
    }

    window.addEventListener("load", requestNotify);

    window.luckyNotify = function (sender, message) {
        if (!("Notification" in window)) return;
        if (document.visibilityState === "visible") return;
        if (Notification.permission !== "granted") return;
        const body = message || "New message";
        const n = new Notification(sender || "Lucky Chat", {
            body,
            icon: "favicon.png"
        });
        n.onclick = () => {
            window.focus();
            n.close();
        };
    };
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initChatCore);
} else {
    initChatCore();
}

let typingTimeout = null;
let lastTypingSent = 0;

input.addEventListener("input", () => {

    const now = Date.now();

    if (now - lastTypingSent > 800) {
        sendSocket({
            type: "typing"
        });

        lastTypingSent = now;
    }

    clearTimeout(typingTimeout);

    typingTimeout = setTimeout(() => {
        sendSocket({
            type: "stop_typing"
        });
    }, 1200);

});

input.addEventListener("keypress",function(e){

    if(e.key==="Enter"){
        sendMessage();
    }

});

window.LUCKY_CHAT_CORE_VERSION = "immediate-send-v6";
console.log("JavaScript loaded | Lucky Chat core v6");

function createOptimisticMessage(text, image, audio) {
    const tempId = -Date.now() - Math.floor(Math.random() * 1000);
    const clientId =
        (window.crypto && typeof window.crypto.randomUUID === "function")
            ? window.crypto.randomUUID()
            : String(Date.now()) + "-" + Math.random().toString(36).slice(2);

    return {
        id: tempId,
        client_id: clientId,
        sender: username,
        text: text || "",
        timestamp: new Date().toISOString(),
        reply_to: replyToId,
        media_url: image?.url || audio?.url || null,
        media_type: image?.media_type || audio?.media_type || null,
        media_duration: audio?.duration || 0,
        delivered: 0,
        read: 0,
        _optimistic: true
    };
}

function queueOptimisticMessage(msg) {
    pendingOutgoingMessages.push({
        tempId: msg.id,
        clientId: msg.client_id || null,
        text: msg.text || "",
        media_url: msg.media_url || null,
        media_type: msg.media_type || null,
        message: msg,
        attempted: false
    });

    addMessage(msg);

    // Do not keep stale reconciliation entries forever.
    setTimeout(() => {
        const index = pendingOutgoingMessages.findIndex(
            item => item.tempId === msg.id
        );
        if (index !== -1) {
            pendingOutgoingMessages.splice(index, 1);
        }
    }, 30000);
}

function removeOptimisticMessage(tempId) {
    const bubble = document.querySelector(`[data-msg="${tempId}"]`);
    if (bubble) {
        const row = bubble.closest(".message-row");
        if (row) row.remove();
        else bubble.remove();
    }
    delete messageMap[tempId];
    pendingOutgoingMessages = pendingOutgoingMessages.filter(
        item => item.tempId !== tempId
    );
}

function reconcileOutgoingMessage(msg) {
    if (msg.sender !== username || !pendingOutgoingMessages.length) {
        return false;
    }

    let index = -1;

    // Prefer a stable client ID when the backend echoes it.
    if (msg.client_id) {
        index = pendingOutgoingMessages.findIndex(
            item => item.clientId === msg.client_id
        );
    }

    // Backward-compatible fallback for servers that do not echo client_id.
    if (index === -1) {
        const incomingText = msg.text || "";
        const incomingMediaUrl = msg.media_url || null;
        const incomingMediaType = msg.media_type || null;

        index = pendingOutgoingMessages.findIndex(item =>
            item.text === incomingText &&
            item.media_url === incomingMediaUrl &&
            item.media_type === incomingMediaType
        );
    }

    if (index === -1) {
        return false;
    }

    const pending = pendingOutgoingMessages[index];
    pendingOutgoingMessages.splice(index, 1);

    const bubble = document.querySelector(
        `[data-msg="${pending.tempId}"]`
    );

    // Keep the already-visible DOM node. Only swap its temporary ID/time/status.
    // Removing and re-adding the bubble caused the visible-message lag/flicker.
    if (bubble) {
        bubble.dataset.msg = String(msg.id);

        const row = bubble.closest(".message-row");
        if (row) {
            const message = row.querySelector(".message");
            if (message) message.dataset.msg = String(msg.id);
        }

        const timeElement = bubble.querySelector(".msg-time");
        if (timeElement && msg.timestamp != null) {
            timeElement.textContent = formatMessageTimestamp(msg.timestamp);
        }

        const ticks = bubble.querySelector(".ticks");
        if (ticks) {
            if (msg.read) {
                ticks.innerHTML = "✔✔";
                ticks.classList.add("read");
            } else if (msg.delivered) {
                ticks.innerHTML = "✓✓";
                ticks.classList.remove("read");
            }
        }
    }

    const optimistic = messageMap[pending.tempId];
    if (optimistic) {
        delete messageMap[pending.tempId];
        optimistic.id = msg.id;
        optimistic.timestamp = msg.timestamp || optimistic.timestamp;
        optimistic.delivered = msg.delivered || 0;
        optimistic.read = msg.read || 0;
        optimistic._optimistic = false;
        messageMap[msg.id] = optimistic;
        saveDashboardPreview(optimistic);

        // If a history refresh/reconnect removed the optimistic bubble before
        // the server echo arrived, put the reconciled message back immediately.
        if (!bubble) {
            addMessage(optimistic);
        }
    }

    return true;
}

async function sendMessage() {

    const text = input.value.trim();
    const image = window.selectedChatImage;
    const audio = window.selectedChatAudio;

    // Don't send anything if there is neither text nor image/audio.
    if (text === "" && !image && !audio) {
        return;
    }

    // Render the outgoing bubble first. Network/crypto work is deliberately
    // deferred to a later task so Android Chrome can paint this bubble before
    // anything else occupies the main thread.
    const optimisticMessage = createOptimisticMessage(text, image, audio);
    queueOptimisticMessage(optimisticMessage);
    saveDashboardPreview(optimisticMessage);

    // Clear the composer immediately so the UI is responsive.
    input.value = "";
    window.selectedChatImage = null;
    window.selectedChatAudio = null;

    const imagePreview = document.getElementById("imagePreview");
    const previewImage = document.getElementById("previewImage");
    const replyPreviewEl = document.getElementById("replyPreview");

    if (imagePreview) imagePreview.style.display = "none";
    if (previewImage) previewImage.src = "";
    clearAudioPreview();

    replyToId = null;
    if (replyPreviewEl) replyPreviewEl.style.display = "none";

    const sendLater = () => {
        void sendOptimisticMessage(optimisticMessage, image, audio);
    };

    // The optimistic message is already in the DOM. Give the browser a
    // guaranteed paint opportunity before RSA/AES work starts. Two frames
    // makes this reliable on slower Android devices instead of relying on a
    // single rAF + timer race.
    if (window.requestAnimationFrame) {
        requestAnimationFrame(() => {
            requestAnimationFrame(sendLater);
        });
    } else {
        setTimeout(sendLater, 0);
    }
}

async function sendOptimisticMessage(optimisticMessage, image, audio) {
    try {
        const pending = pendingOutgoingMessages.find(
            item => item.tempId === optimisticMessage.id
        );

        if (!socket || socket.readyState !== WebSocket.OPEN) {
            connectSocket();

            // Keep the optimistic bubble visible and retry once the socket is
            // actually connected.
            const waitForSocket = () => {
                const livePending = pendingOutgoingMessages.find(
                    item => item.tempId === optimisticMessage.id
                );

                if (!livePending || livePending.attempted) return;

                if (socket && socket.readyState === WebSocket.OPEN) {
                    void sendOptimisticMessage(optimisticMessage, image, audio);
                    return;
                }

                setTimeout(waitForSocket, socket &&
                    socket.readyState === WebSocket.CONNECTING ? 50 : 100);
            };

            setTimeout(waitForSocket, 50);
            return;
        }

        if (pending?.attempted) {
            return;
        }

        await LuckyCrypto.ensureReady();

        let encryptedText = optimisticMessage.text;
        if (optimisticMessage.text) {
            encryptedText = await LuckyCrypto.encryptMessage(
                optimisticMessage.text,
                friend,
                username
            );
        }

        const payload = {
            type: "message",
            text: encryptedText,
            reply_to: optimisticMessage.reply_to,
            client_id: optimisticMessage.client_id
        };

        if (image) {
            payload.media_url = image.url;
            payload.media_type = image.media_type;
        }

        if (audio) {
            payload.media_url = audio.url;
            payload.media_type = audio.media_type;
            payload.media_duration = audio.duration || 0;
        }

        if (!sendSocket(payload)) {
            connectSocket();
            return;
        }

        if (pending) {
            pending.attempted = true;
        }
    } catch (error) {
        console.error("MESSAGE SEND ERROR:", error);
        removeOptimisticMessage(optimisticMessage.id);
        alert(error.message || "Could not send message");
    }
}

function addMessage(msg){

    if (deletedMessages[msg.id]) {
        return;
    }

    // Idempotent rendering: a server echo/reconnect must never append a
    // second DOM copy of a message that is already visible.
    const existingBubble = document.querySelector(`[data-msg="${msg.id}"]`);
    if (existingBubble) {
        messageMap[msg.id] = msg;

        const existingText = existingBubble.querySelector(".msg-text");
        const existingTime = existingBubble.querySelector(".msg-time");

        if (existingText && msg.text != null) {
            existingText.textContent = msg.text;
        }

        if (existingTime && msg.timestamp != null) {
            existingTime.textContent = formatMessageTimestamp(msg.timestamp);
        }

        return;
    }

    messageMap[msg.id] = msg;

    const row = document.createElement("div");
    row.className = "message-row";

    let replyHtml = "";

    if (msg.reply_to && messageMap[msg.reply_to]) {

    const replied = messageMap[msg.reply_to];

    const replyName =
        replied.sender === username ? "You" : replied.sender;

    let repliedContent = "";

    if (replied.media_type === "image" && replied.media_url) {

        repliedContent = `
            <div class="reply-media">
                <img
                    class="reply-media-thumb"
                    src="${escapeHTML(replied.media_url)}"
                    alt="Photo"
                    loading="lazy"
                >
                <span class="reply-media-text">Photo</span>
            </div>
        `;

    } else if (replied.media_type === "audio" && replied.media_url) {

        repliedContent = `
            <div class="reply-media">
                <span class="reply-media-icon">🎙️</span>
                <span class="reply-media-text">Voice message</span>
            </div>
        `;

    } else {

        repliedContent = `
            <div class="reply-text">
                ${escapeHTML(replied.text || "Message")}
            </div>
        `;
    }

    replyHtml = `
    <div class="reply-box"
         onclick="jumpToRepliedMessage(${replied.id})"
         title="Jump to original message">

        <div class="reply-sender">
            ${escapeHTML(replyName)}
        </div>

        ${repliedContent}

    </div>
`;

}

        let ticks = `<span class="ticks">✓</span>`;

        if (msg.read) {
            ticks = `<span class="ticks read">✓✓</span>`;
        } else if (msg.delivered) {
            ticks = `<span class="ticks">✓✓</span>`;
        }

        if(msg.read){
            ticks = `<span class="ticks read">✔✔</span>`;
        }

        let reactionHtml = "";

        if (msg.reaction) {
            reactionHtml = `
                <div class="reaction">${escapeHTML(msg.reaction)}</div>
            `;
}

        let mediaHtml = "";

        if (msg.media_url && msg.media_type === "image") {
            mediaHtml = `
                <img
                    src="${escapeHTML(msg.media_url)}"
                    class="chat-image"
                    alt="Image"
                    loading="lazy"
                >
            `;
        } else if (msg.media_url && msg.media_type === "audio") {
            const duration = Number(msg.media_duration || 0);

            mediaHtml = `
                <div class="voice-message">
                    <button
                        type="button"
                        class="voice-play-btn"
                        onclick="toggleVoiceMessage(this)"
                        aria-label="Play voice message"
                    >▶</button>

                    <div class="voice-wave" aria-hidden="true">
                        <span></span><span></span><span></span><span></span>
                        <span></span><span></span><span></span><span></span>
                        <span></span><span></span><span></span><span></span>
                    </div>

                    <span class="voice-duration">
                        ${formatAudioTime(duration)}
                    </span>

                    <audio
                        preload="metadata"
                        src="${escapeHTML(msg.media_url)}"
                        data-voice-audio="1"
                    ></audio>
                </div>
            `;
}


        if (msg.sender === username) {

        row.innerHTML = `
            <div class="message message-own"
                 data-msg="${msg.id}"
                 onpointerdown="startPress(event, ${msg.id})"
                 onpointerup="cancelPress()"
                 onpointercancel="cancelPress()"
                 onpointermove="cancelPress()"
                 oncontextmenu="return false;">

                 ${replyHtml}

                 ${mediaHtml}

                 <div class="msg-text">
                 ${escapeHTML(msg.text)}
                 </div>

                <div class="msg-meta">
                    <span class="msg-time">${formatMessageTimestamp(msg.timestamp)}</span>
                    ${renderEditedLabel(msg)}
                    ${ticks}
                </div>

                ${reactionHtml}

            </div>
        `;

    }else{

        row.innerHTML = `
            <img class="msg-avatar"
                 src="{{ friend_user.profile_picture }}"
                 onerror="this.src='/static/profile/default.png'">

            <div class="message message-other"
                 data-msg="${msg.id}"
                 onpointerdown="startPress(event, ${msg.id})"
                 onpointerup="cancelPress()"
                 onpointercancel="cancelPress()"
                 onpointermove="cancelPress()"
                 oncontextmenu="return false;">

                ${replyHtml}

                ${mediaHtml}

                <div class="msg-text">
                ${escapeHTML(msg.text)}
                </div>

                <div class="msg-meta">
                    <span class="msg-time">${formatMessageTimestamp(msg.timestamp)}</span>
                    ${renderEditedLabel(msg)}
                </div>

                ${reactionHtml}

            </div>
        `;
    }

    messages.appendChild(row);

    // Audio duration is read from the actual file, so it also works
    // after a page refresh when the server does not persist duration.
    const voiceAudio = row.querySelector("audio[data-voice-audio='1']");
    if (voiceAudio) {
        const durationLabel = row.querySelector(".voice-duration");

        const updateVoiceDuration = () => {
            if (
                durationLabel &&
                Number.isFinite(voiceAudio.duration) &&
                voiceAudio.duration > 0
            ) {
                durationLabel.textContent =
                    formatAudioTime(voiceAudio.duration);
            }
        };

        voiceAudio.addEventListener("loadedmetadata", updateVoiceDuration);
        if (voiceAudio.readyState >= 1) {
            updateVoiceDuration();
        }
    }

    renderPinnedBadge(msg.id);
    renderPinnedBar();

    if (!window.__suppressChatAutoScroll) {
        messages.scrollTop = messages.scrollHeight;
    }
}


function startPress(e, id) {
    if (e.isPrimary === false) return;

    longPressTriggered = false;
    clearTimeout(pressTimer);

    pressTimer = setTimeout(() => {
        longPressTriggered = true;

        if (e.cancelable) e.preventDefault();

        showMessageMenu(e, id);
    }, 500);
}

function cancelPress() {
    clearTimeout(pressTimer);
}

function showMessageMenu(e, id) {
    if (e.cancelable) e.preventDefault();

    selectedMessageId = id;

    const menu = document.getElementById("messageMenu");
    if (!menu) return;

    const msg = messageMap[id];
    if (!msg) return;

    const deleteEveryoneItem =
        menu.querySelector(".delete-everyone-action");

    const pinItem = menu.querySelector(".pin-message-action");
    if (pinItem) {
        pinItem.textContent =
            isMessagePinned(id) ? "📌 Unpin" : "📌 Pin";
    }

    if (deleteEveryoneItem) {
        deleteEveryoneItem.style.display =
            msg.sender === username ? "block" : "none";
    }

    const menuWidth = 220;
    const menuHeight = 350;

    let left = e.clientX || 0;
    let top = e.clientY || 0;

    if (left + menuWidth > window.innerWidth) {
        left = window.innerWidth - menuWidth - 10;
    }

    if (top + menuHeight > window.innerHeight) {
        top = window.innerHeight - menuHeight - 10;
    }

    left = Math.max(10, left);
    top = Math.max(10, top);

    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.style.display = "block";
}

/*
 * Android Chrome can generate a synthetic click after a long press.
 * Do not use the old document click-to-close handler here.
 */
document.addEventListener("pointerdown", function (e) {
    const menu = document.getElementById("messageMenu");

    if (
        menu &&
        menu.style.display === "block" &&
        !menu.contains(e.target)
    ) {
        hideMessageMenu();
    }
});

function hideMessageMenu() {
    const menu = document.getElementById("messageMenu");

    if (menu) {
        menu.style.display = "none";
    }

    selectedMessageId = null;
    clearTimeout(pressTimer);
    longPressTriggered = false;
}

let pendingDeleteId = null;
let pendingDeleteType = null;

function openDeleteConfirmation(type){

    if(selectedMessageId == null) return;

    const msg = messageMap[selectedMessageId];

    if(!msg){
        hideMessageMenu();
        return;
    }

    // Only the sender may delete for everyone.
    if(type === "everyone" && msg.sender !== username){
        hideMessageMenu();
        return;
    }

    pendingDeleteId = selectedMessageId;
    pendingDeleteType = type;

    const title = document.getElementById("deleteModalTitle");
    const message = document.getElementById("deleteModalMessage");

    if(type === "everyone"){
        title.textContent = "Delete for everyone?";
        message.textContent =
            "This message will be removed from the chat for you and the other person.";
    } else {
        title.textContent = "Delete for me?";
        message.textContent =
            "This message will be removed from your chat only. The other person will still see it.";
    }

    hideMessageMenu();

    const modal = document.getElementById("deleteModalOverlay");
    if(modal){
        modal.style.display = "flex";
    }
}

function closeDeleteModal(){

    const modal = document.getElementById("deleteModalOverlay");

    if(modal){
        modal.style.display = "none";
    }

    pendingDeleteId = null;
    pendingDeleteType = null;
}

function confirmDelete(){

    const id = pendingDeleteId;
    const type = pendingDeleteType;

    if(id == null || !type){
        closeDeleteModal();
        return;
    }

    if(type === "me"){
        const pinIndex = pinnedMessages.indexOf(Number(id));
        if(pinIndex >= 0){
            pinnedMessages.splice(pinIndex,1);
            savePinnedMessages();
            renderPinnedBar();
        }
    }

    closeDeleteModal();

    if(type === "everyone"){

        sendSocket({
            type: "delete_everyone",
            id: id
        });

        return;
    }

    deletedMessages[id] = true;
    saveDeletedMessages();

    const bubble = document.querySelector(
        `[data-msg="${id}"]`
    );

    if(bubble){

        const row = bubble.closest(".message-row");

        if(row){
            row.remove();
        }
    }

    delete messageMap[id];
}

async function forwardMessage(){

    if(selectedMessageId == null) return;

    const msg = messageMap[selectedMessageId];

    if(!msg){
        hideMessageMenu();
        return;
    }

    window.forwardMessageData = {
        id: msg.id,
        text: msg.text
    };

    hideMessageMenu();

    const modal = document.getElementById("forwardModal");
    const usersBox = document.getElementById("forwardUsers");

    modal.style.display = "flex";
    usersBox.innerHTML = "Loading users...";

    try{

        const response = await fetch("/users");
        const users = await response.json();

        usersBox.innerHTML = "";

        users.forEach(user => {

            if(user.username === username) return;

            const item = document.createElement("div");
            item.className = "forward-user";

            item.innerHTML = `
 
                <img
                   src="${user.profile_picture || '/static/profile/default.png'}"
                       onerror="this.src='/static/profile/default.png'"
                       >

                <div class="forward-user-name">
                    ${user.display_name || user.username}
                </div>
            `;

            item.onclick = () => {
                sendForward(user.username);
            };

            usersBox.appendChild(item);
        });

        if(usersBox.innerHTML === ""){
            usersBox.innerHTML =
                '<div style="padding:20px;color:#94a3b8;text-align:center;">No users found</div>';
        }

    }catch(error){

        console.error("Failed to load users:", error);

        usersBox.innerHTML =
            '<div style="padding:20px;color:#fca5a5;text-align:center;">Failed to load users</div>';
    }
}

async function sendForward(target){

    if(!window.forwardMessageData) return;

    const text = window.forwardMessageData.text;

    if(!text) return;

    let encryptedText;
    try {
        await LuckyCrypto.ensureReady();
        encryptedText = await LuckyCrypto.encryptMessage(
            text,
            target,
            username
        );
    } catch (error) {
        console.error("FORWARD ENCRYPTION ERROR:", error);
        alert(error.message || "Could not encrypt forwarded message");
        return;
    }

    if(!sendSocket({
        type:"forward_message",
        text:encryptedText,
        target:target
    })){
        alert("Connection lost. Please try again.");
        return;
    }

    closeForwardModal();
    window.forwardMessageData = null;
}

function closeForwardModal(){

    const modal =
        document.getElementById("forwardModal");

    if(modal){
        modal.style.display = "none";
    }

    window.forwardMessageData = null;
}

async function uploadChatImage() {
    const file = imageInput?.files?.[0];

    if (!file) return;

    const preview = document.getElementById("imagePreview");
    const previewImage = document.getElementById("previewImage");

    // Show preview immediately
    if (previewImage) {
        previewImage.src = URL.createObjectURL(file);
    }
    if (preview) {
        preview.style.display = "block";
    }

    try {
        const formData = new FormData();
        formData.append("file", file);

        const response = await fetch("/upload-chat-image", {
            method: "POST",
            body: formData
        });

        const result = await response.json();

        if (!response.ok || !result.success) {
            console.error("IMAGE UPLOAD FAILED:", result);
            alert(result.error || "Image upload failed");

            if (preview) preview.style.display = "none";
            if (previewImage) previewImage.src = "";
            return;
        }

        console.log("IMAGE UPLOADED:", result);

        window.selectedChatImage = result;

    } catch (error) {
        console.error("IMAGE UPLOAD ERROR:", error);

        alert("Could not upload image");

        if (preview) preview.style.display = "none";
        if (previewImage) previewImage.src = "";
    }

    if (imageInput) {
        imageInput.value = "";
    }
}

function removeSelectedImage() {
    window.selectedChatImage = null;
    window.selectedChatAudio = null;

    const preview = document.getElementById("imagePreview");
    const previewImage = document.getElementById("previewImage");

    if (preview) {
        preview.style.display = "none";
    }

    if (typeof clearAudioPreview === "function") {
        clearAudioPreview();
    }

    if (previewImage) {
        previewImage.src = "";
    }

    if (imageInput) {
        imageInput.value = "";
    }
}

function formatMessageTimestamp(ts) {
    const raw = String(ts ?? "").trim();

    if (!raw) return "";

    // Legacy values that already contain a formatted clock time.
    if (/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(raw)) {
        return raw;
    }

    // ISO timestamps with an explicit timezone (Z or +/-HH:MM) are UTC/offset
    // values and should be converted to the device's local time.
    // Timezone-less ISO values are legacy local timestamps and must NOT be
    // force-suffixed with Z, otherwise they shift by +5:30 on IST devices.
    const hasExplicitTimezone =
        /[zZ]|[+-]\d{2}:\d{2}$/.test(raw);

    const date = new Date(raw);

    if (!Number.isNaN(date.getTime())) {
        return date.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            hour12: true
        });
    }

    return raw;
}

function escapeHTML(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function renderEditedLabel(msg){
    return msg && msg.edited
        ? `<span class="edited-label">(edited)</span>`
        : "";
}


let reactionMessageId = null;

function cancelReply(){

    replyToId = null;

    document.getElementById("replyPreview").style.display = "none";

}

function reactToMessage() {
    if (selectedMessageId == null) return;

    // Save the selected message before hiding the menu
    reactionMessageId = selectedMessageId;

    const picker = document.getElementById("reactionPicker");
    picker.style.display = "flex";

    hideMessageMenu();
}

function chooseReaction(emoji) {

    if (reactionMessageId == null) return;

    const msg = messageMap[reactionMessageId];

    if (!msg) return;

    const reaction =
        msg.reaction === emoji ? "" : emoji;

    // Update this device immediately.
    msg.reaction = reaction;
    saveReactions();

    const bubble = document.querySelector(
        `[data-msg="${reactionMessageId}"]`
    );

    if (bubble) {

        let reactionBox =
            bubble.querySelector(".reaction");

        if (reaction === "") {

            if (reactionBox) {
                reactionBox.remove();
            }

        } else {

            if (!reactionBox) {

                reactionBox =
                    document.createElement("div");

                reactionBox.className = "reaction";
                bubble.appendChild(reactionBox);
            }

            reactionBox.innerText = reaction;
        }
    }

    // Tell the server so the other person sees the reaction live.
    sendSocket({
        type: "reaction",
        id: reactionMessageId,
        reaction: reaction
    });

    document.getElementById(
        "reactionPicker"
    ).style.display = "none";

    reactionMessageId = null;
}


/* =========================================================
   LUCKY CHAT — TYPING INDICATOR CLIENT
   ========================================================= */
(function () {
    const input = document.getElementById("messageInput");
    const indicator = document.getElementById("typingIndicator");
    const typingName = document.getElementById("typingName");

    if (!input || !indicator) return;

    let typingTimer = null;
    let isTyping = false;

    function sendTyping(type) {
        try {
            if (typeof socket !== "undefined" && socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type }));
            }
        } catch (e) {
            console.debug("Typing indicator send skipped:", e);
        }
    }

    function stopTyping() {
        if (!isTyping) return;
        isTyping = false;
        sendTyping("stop_typing");
    }

    input.addEventListener("input", function () {
        const hasText = input.value.trim().length > 0;

        if (!hasText) {
            clearTimeout(typingTimer);
            stopTyping();
            return;
        }

        if (!isTyping) {
            isTyping = true;
            sendTyping("typing");
        }

        clearTimeout(typingTimer);
        typingTimer = setTimeout(stopTyping, 1400);
    });

    input.addEventListener("blur", function () {
        clearTimeout(typingTimer);
        stopTyping();
    });

    window.luckyShowTyping = function (sender) {
        if (typingName) {
            typingName.textContent = (sender || "Someone") + " is typing";
        }
        indicator.style.display = "flex";
    };

    window.luckyHideTyping = function () {
        indicator.style.display = "none";
    };
})();


/* =========================================================
   LUCKY CHAT — MESSAGE SEARCH CLIENT
   ========================================================= */
(function () {
    const openBtn = document.getElementById("chatSearchBtn");
    const overlay = document.getElementById("chatSearchOverlay");
    const closeBtn = document.getElementById("chatSearchClose");
    const inputEl = document.getElementById("chatSearchInput");
    const countEl = document.getElementById("chatSearchCount");
    const resultsEl = document.getElementById("chatSearchResults");
    const prevBtn = document.getElementById("chatSearchPrev");
    const nextBtn = document.getElementById("chatSearchNext");

    if (!openBtn || !overlay || !inputEl || !resultsEl) return;

    let matches = [];
    let activeIndex = -1;

    function getMessageList() {
        if (typeof messageMap === "undefined") return [];

        return Object.values(messageMap)
            .filter(msg => msg && msg.id != null && !deletedMessages[msg.id])
            .sort((a, b) => Number(a.id) - Number(b.id));
    }

    function messagePreview(msg) {
        if (msg.media_type === "image" && msg.media_url) {
            const text = (msg.text || "").trim();
            return text ? "🖼️ " + text : "🖼️ Photo";
        }
        if (msg.media_type === "audio" && msg.media_url) {
            const text = (msg.text || "").trim();
            return text ? "🎙️ " + text : "🎙️ Voice message";
        }
        return (msg.text || "").trim() || "Message";
    }

    function escapeSearchHtml(value) {
        if (typeof escapeHTML === "function") return escapeHTML(value);
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function renderResults(query) {
        const q = query.trim().toLowerCase();
        const all = getMessageList();

        if (!q) {
            matches = [];
            activeIndex = -1;
            countEl.textContent = "0";
            resultsEl.innerHTML =
                '<div class="chat-search-empty">Search this conversation</div>';
            return;
        }

        matches = all.filter(msg =>
            messagePreview(msg).toLowerCase().includes(q)
        );

        activeIndex = matches.length ? matches.length - 1 : -1;
        countEl.textContent = matches.length ? `${matches.length} found` : "0";

        if (!matches.length) {
            resultsEl.innerHTML =
                '<div class="chat-search-empty">No messages found</div>';
            return;
        }

        resultsEl.innerHTML = matches.map((msg, index) => {
            const name = msg.sender === username ? "You" : msg.sender;
            return `
                <button class="chat-search-result"
                        type="button"
                        data-search-id="${Number(msg.id)}"
                        data-search-index="${index}">
                    <div class="chat-search-result-name">${escapeSearchHtml(name)}</div>
                    <div class="chat-search-result-text">${escapeSearchHtml(messagePreview(msg))}</div>
                    <div class="chat-search-result-time">${escapeSearchHtml(msg.timestamp || "")}</div>
                </button>
            `;
        }).join("");

        resultsEl.querySelectorAll(".chat-search-result").forEach(btn => {
            btn.addEventListener("click", () => {
                jumpToSearchMessage(Number(btn.dataset.searchId));
            });
        });
    }

    function jumpToSearchMessage(id) {
        closeSearch();

        setTimeout(() => {
            const bubble = document.querySelector(`[data-msg="${id}"]`);
            if (!bubble) return;

            bubble.scrollIntoView({
                behavior: "smooth",
                block: "center"
            });

            bubble.classList.remove("search-hit");
            void bubble.offsetWidth;
            bubble.classList.add("search-hit");

            setTimeout(() => bubble.classList.remove("search-hit"), 1600);
        }, 80);
    }

    function moveMatch(direction) {
        if (!matches.length) return;

        activeIndex += direction;

        if (activeIndex < 0) activeIndex = matches.length - 1;
        if (activeIndex >= matches.length) activeIndex = 0;

        const target = matches[activeIndex];
        const result = resultsEl.querySelector(
            `[data-search-id="${target.id}"]`
        );

        if (result) {
            result.scrollIntoView({
                behavior: "smooth",
                block: "nearest"
            });
        }

        jumpToSearchMessage(target.id);
    }

    function openSearch() {
        overlay.style.display = "flex";
        overlay.setAttribute("aria-hidden", "false");
        inputEl.value = "";
        renderResults("");
        setTimeout(() => inputEl.focus(), 60);
    }

    function closeSearch() {
        overlay.style.display = "none";
        overlay.setAttribute("aria-hidden", "true");
        inputEl.value = "";
        matches = [];
        activeIndex = -1;
    }

    openBtn.addEventListener("click", openSearch);
    closeBtn.addEventListener("click", closeSearch);
    inputEl.addEventListener("input", () => renderResults(inputEl.value));
    prevBtn.addEventListener("click", () => moveMatch(-1));
    nextBtn.addEventListener("click", () => moveMatch(1));

    inputEl.addEventListener("keydown", event => {
        if (event.key === "Escape") {
            closeSearch();
        } else if (event.key === "Enter" && matches.length) {
            moveMatch(1);
        }
    });
})();
