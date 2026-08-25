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
const videoBtn = document.getElementById("videoBtn");
const videoInput = document.getElementById("videoInput");
const videoPreview = document.getElementById("videoPreview");
const videoPreviewName = document.getElementById("videoPreviewName");
const removeVideoBtn = document.getElementById("removeVideoBtn");

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
let socketHeartbeatTimer = null;
let socketReconnectAttempt = 0;
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

const voiceAnalysisCache = new Map();
const voiceAnalysisPromises = new Map();

function clampAudioDuration(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.min(120, value);
}

function normalizeWaveform(values, bars = 28) {
    if (!Array.isArray(values) || !values.length) return [];

    const cleaned = values
        .map(value => Number(value))
        .filter(value => Number.isFinite(value) && value >= 0);

    if (!cleaned.length) return [];

    const max = Math.max(...cleaned, 1);
    const output = cleaned.slice(0, bars).map(value =>
        Math.max(0.08, Math.min(1, value / max))
    );

    while (output.length < bars) {
        output.push(output[output.length - 1] || 0.08);
    }

    return output;
}

function parseStoredWaveform(value) {
    if (Array.isArray(value)) {
        return normalizeWaveform(value);
    }

    if (typeof value !== "string" || !value.trim()) {
        return [];
    }

    try {
        return normalizeWaveform(JSON.parse(value));
    } catch (_) {
        return [];
    }
}

async function analyzeAudioBlob(blob) {
    if (!blob || !blob.size) {
        throw new Error("Empty audio data");
    }

    const AudioContextClass =
        window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) {
        throw new Error("Web Audio API is not available");
    }

    const context = new AudioContextClass();

    try {
        const buffer = await blob.arrayBuffer();
        const audioBuffer = await context.decodeAudioData(buffer.slice(0));
        const duration = clampAudioDuration(audioBuffer.duration);
        const bars = 28;
        const length = audioBuffer.length;

        if (!duration || !length) {
            throw new Error("Audio duration could not be determined");
        }

        const channels = audioBuffer.numberOfChannels;
        const blockSize = Math.max(1, Math.floor(length / bars));
        const waveform = [];

        for (let bar = 0; bar < bars; bar++) {
            const start = bar * blockSize;
            const end = bar === bars - 1
                ? length
                : Math.min(length, start + blockSize);

            let sum = 0;
            let peak = 0;
            let count = 0;

            for (let index = start; index < end; index += 1) {
                let sample = 0;

                for (let channel = 0; channel < channels; channel += 1) {
                    sample += Math.abs(audioBuffer.getChannelData(channel)[index] || 0);
                }

                sample /= channels || 1;
                sum += sample * sample;
                peak = Math.max(peak, sample);
                count += 1;
            }

            const rms = count ? Math.sqrt(sum / count) : 0;
            waveform.push(Math.max(rms, peak * 0.65));
        }

        const max = Math.max(...waveform, 0.0001);
        return {
            duration,
            waveform: waveform.map(value => value / max)
        };
    } finally {
        try {
            await context.close();
        } catch (_) {}
    }
}

async function analyzeAudioUrl(url) {
    if (!url) throw new Error("Missing audio URL");

    if (voiceAnalysisCache.has(url)) {
        return voiceAnalysisCache.get(url);
    }

    if (voiceAnalysisPromises.has(url)) {
        return voiceAnalysisPromises.get(url);
    }

    const promise = (async () => {
        const response = await fetch(url, {
            credentials: "same-origin",
            cache: "force-cache"
        });

        if (!response.ok) {
            throw new Error("Audio metadata request failed");
        }

        const blob = await response.blob();
        const result = await analyzeAudioBlob(blob);
        voiceAnalysisCache.set(url, result);
        return result;
    })();

    voiceAnalysisPromises.set(url, promise);

    try {
        return await promise;
    } finally {
        voiceAnalysisPromises.delete(url);
    }
}

let voiceHydrationObserver = null;

function scheduleVoiceHydration(row, msg) {
    if (!row || !msg || !msg.media_url) return;

    if (voiceHydrationObserver) {
        row.__voiceHydrationMessage = msg;
        voiceHydrationObserver.observe(row);
        return;
    }

    void hydrateVoiceMessage(row, msg);
}

if ("IntersectionObserver" in window && messages) {
    voiceHydrationObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;

            const row = entry.target;
            const msg = row.__voiceHydrationMessage;
            observer.unobserve(row);
            delete row.__voiceHydrationMessage;

            if (msg) {
                void hydrateVoiceMessage(row, msg);
            }
        });
    }, {
        root: messages,
        rootMargin: "400px 0px",
        threshold: 0.01
    });
}

function renderVoiceWaveform(row, waveform) {
    const wave = row?.querySelector(".voice-wave");
    if (!wave) return;

    const values = normalizeWaveform(waveform);
    if (!values.length) return;

    wave.innerHTML = values.map((value, index) => {
        const height = Math.round(6 + value * 20);
        return `<span data-wave-index="${index}" style="height:${height}px"></span>`;
    }).join("");

    updateVoiceWaveProgress(row, 0);
}

async function hydrateVoiceMessage(row, msg) {
    const voiceAudio = row?.querySelector("audio[data-voice-audio='1']");
    if (!voiceAudio || !msg?.media_url) return;

    const durationLabel = row.querySelector(".voice-duration");
    const storedDuration = clampAudioDuration(msg.media_duration);
    const storedWaveform = parseStoredWaveform(msg.media_waveform);

    if (storedWaveform.length) {
        renderVoiceWaveform(row, storedWaveform);
    }

    if (storedDuration && durationLabel) {
        durationLabel.textContent = formatAudioTime(storedDuration);
    }

    try {
        const analysis = await analyzeAudioUrl(msg.media_url);

        if (durationLabel && analysis.duration) {
            durationLabel.textContent = formatAudioTime(analysis.duration);
        }

        if (!storedWaveform.length) {
            renderVoiceWaveform(row, analysis.waveform);
        }
    } catch (error) {
        // Keep the stored duration/waveform or browser metadata fallback.
        console.debug("VOICE VISUAL ANALYSIS FALLBACK:", error);
    }
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

            const timerDuration = clampAudioDuration(
                (Date.now() - recordingStartedAt) / 1000
            );

            hideRecordingBar();

            const actualType =
                mediaRecorder?.mimeType ||
                recordingMimeType ||
                "audio/webm";

            const blob = new Blob(recordingChunks, { type: actualType });

            recordingChunks = [];

            let duration = timerDuration;
            let waveform = [];

            try {
                const analysis = await analyzeAudioBlob(blob);
                duration = analysis.duration || timerDuration;
                waveform = analysis.waveform || [];
            } catch (analysisError) {
                console.warn("VOICE AUDIO ANALYSIS FALLBACK:", analysisError);
            }

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
                    duration: Math.round(duration),
                    waveform
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

function updateVoiceWaveProgress(row, currentTime = 0) {
    if (!row) return;

    const wave = row.querySelector(".voice-wave");
    if (!wave) return;

    const audio = row.querySelector("audio[data-voice-audio='1']");
    const bars = Array.from(wave.querySelectorAll("span[data-wave-index]"));
    if (!bars.length) return;

    const duration = Number(audio?.duration || 0);
    const ratio = duration > 0
        ? Math.max(0, Math.min(1, Number(currentTime || 0) / duration))
        : 0;

    const playedCount = Math.floor(ratio * bars.length);

    bars.forEach((bar, index) => {
        bar.classList.toggle("played", index < playedCount);
    });

    wave.style.setProperty("--voice-progress", `${ratio * 100}%`);
}

function resetVoicePlayback(row) {
    if (!row) return;

    const button = row.querySelector(".voice-play-btn");
    const audio = row.querySelector("audio[data-voice-audio='1']");
    const durationLabel = row.querySelector(".voice-duration");

    if (audio) {
        audio.currentTime = 0;
    }

    if (button) {
        button.textContent = "▶";
        button.classList.remove("is-playing");
    }

    if (durationLabel && audio?.duration && Number.isFinite(audio.duration)) {
        durationLabel.textContent = formatAudioTime(audio.duration);
    }

    updateVoiceWaveProgress(row, 0);
}

function bindVoicePlayback(row) {
    const audio = row?.querySelector("audio[data-voice-audio='1']");
    const button = row?.querySelector(".voice-play-btn");

    if (!audio || !button || audio.dataset.voiceBound === "1") return;

    audio.dataset.voiceBound = "1";

    audio.addEventListener("loadedmetadata", () => {
        const durationLabel = row.querySelector(".voice-duration");

        if (durationLabel && Number.isFinite(audio.duration) && audio.duration > 0) {
            durationLabel.textContent = formatAudioTime(audio.duration);
        }

        updateVoiceWaveProgress(row, audio.currentTime);
    });

    audio.addEventListener("timeupdate", () => {
        const durationLabel = row.querySelector(".voice-duration");

        if (durationLabel && Number.isFinite(audio.duration) && audio.duration > 0) {
            durationLabel.textContent = formatAudioTime(
                Math.max(0, audio.duration - audio.currentTime)
            );
        }

        updateVoiceWaveProgress(row, audio.currentTime);
    });

    audio.addEventListener("play", () => {
        button.textContent = "⏸";
        button.classList.add("is-playing");
    });

    audio.addEventListener("pause", () => {
        if (!audio.ended) {
            button.textContent = "▶";
            button.classList.remove("is-playing");
        }
    });

    audio.addEventListener("ended", () => {
        resetVoicePlayback(row);
    });

    updateVoiceWaveProgress(row, audio.currentTime);
}

function toggleVoiceMessage(button) {
    const bubble = button?.closest(".voice-message");
    const audio = bubble?.querySelector("audio[data-voice-audio='1']");

    if (!audio) return;

    bindVoicePlayback(bubble);

    document.querySelectorAll("audio[data-voice-audio='1']").forEach(other => {
        if (other !== audio && !other.paused) {
            other.pause();
            resetVoicePlayback(other.closest(".voice-message"));
        }
    });

    if (audio.paused) {
        audio.play().catch(error => {
            console.error("VOICE PLAY ERROR:", error);
        });
    } else {
        audio.pause();
    }
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
        : latest.media_type === "video" && latest.media_url
        ? "🎬 Video"
        : latest.media_type === "audio" && latest.media_url
        ? "🎙️ Voice message"
        : latest.media_type === "call"
        ? "📞 Voice call"
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

async function loadMessages() {

    const res = await fetch("/messages/" + friend);

    if (!res.ok) {
        throw new Error("Failed to load messages (HTTP " + res.status + ")");
    }

    const data = await res.json();

    // Initial history loading can take noticeable time because messages are
    // decrypted one-by-one. Preserve any outgoing bubbles created while that
    // work is in progress so they are not wiped out by messages.innerHTML = "".
    const pendingOptimistic = pendingOutgoingMessages
        .map(item => item.message)
        .filter(Boolean);

    messages.innerHTML = "";
    messageMap = {};

    const savedReactions = loadSavedReactions();

    for (const msg of data) {
        if (deletedMessages[msg.id]) {
            continue;
        }

        if (savedReactions[msg.id]) {
            msg.reaction = savedReactions[msg.id];
        }

        if (msg.media_type !== "call") {
            try {
                msg.text = await LuckyCrypto.decryptMessage(msg.text, username);
            } catch (error) {
                console.error("MESSAGE DECRYPTION ERROR:", error, msg.id);
                msg.text = "🔒 Unable to decrypt this message";
            }
        }

        messageMap[msg.id] = msg;
    }

    pinnedMessages = pinnedMessages.filter(id => messageMap[id]);
    savePinnedMessages();

    data.forEach(msg => {
        if (deletedMessages[msg.id]) {
            return;
        }
        addMessage(msg);
    });

    // Restore any optimistic outgoing messages that were created while the
    // history request/decryption was still running.
    pendingOptimistic.forEach(msg => {
        if (msg && !document.querySelector(`[data-msg="${msg.id}"]`)) {
            addMessage(msg);
        }
    });

    // Queue delivery/read acknowledgements until the WebSocket is connected.
    data.forEach(msg => {
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


function stopSocketHeartbeat(){
    clearInterval(socketHeartbeatTimer);
    socketHeartbeatTimer=null;
}

function startSocketHeartbeat(ws){
    stopSocketHeartbeat();

    socketHeartbeatTimer=setInterval(()=>{
        if(ws !== socket || ws.readyState !== WebSocket.OPEN){
            stopSocketHeartbeat();
            return;
        }

        try{
            ws.send(JSON.stringify({
                type:"ws_heartbeat",
                ts:Date.now()
            }));
        }catch(error){
            console.debug("WEBSOCKET HEARTBEAT SEND FAILED:",error);
        }
    },20000);
}

function scheduleSocketReconnect(){
    clearTimeout(reconnectTimer);

    const delay=Math.min(
        30000,
        Math.max(1000,1000 * Math.pow(1.7, socketReconnectAttempt))
    );

    socketReconnectAttempt=Math.min(socketReconnectAttempt + 1, 8);

    reconnectTimer=setTimeout(()=>{
        reconnectTimer=null;
        if(!socket || socket.readyState===WebSocket.CLOSED){
            socket=null;
            connectSocket();
        }
    },delay);
}

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

    const ws = socket;

    ws.onopen = () => {
    // Ignore a late open event from a socket that is no longer current.
    if(ws !== socket) return;

    console.log("Chat WebSocket connected");
    socketReconnectAttempt=0;
    startSocketHeartbeat(ws);

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
                        duration: item.message.media_duration || 0,
                        waveform: item.message.media_waveform || null
                    } : null,
                    item.message.media_type === "video" ? {
                        url: item.message.media_url,
                        media_type: item.message.media_type
                    } : null
                );
            }, 0);
        }
    });

    clearTimeout(reconnectTimer);
    reconnectTimer = null;
};

    ws.onmessage = async (event) => {
        if(ws !== socket) return;

        // Do not log every WebSocket receipt/read event.
        // The chat can receive hundreds of acknowledgements and excessive
        // console logging on mobile can delay visible UI updates.
        try {
            const incoming=JSON.parse(event.data);

            if(incoming?.type==="ws_heartbeat_ack"){
                return;
            }

            await handleSocketMessage(event);
        } catch (error) {
            console.error("Socket message handling error:", error);
        }
    };

    ws.onerror = (error) => {
        if(ws !== socket) return;

        console.error("Chat WebSocket error:", error);

        document.getElementById("online-users").innerHTML =
            "🔴 Connection error";
    };

    ws.onclose = () => {
        if(ws !== socket) return;

        console.log("Chat WebSocket closed");
        stopSocketHeartbeat();

        document.getElementById("online-users").innerHTML =
            "🔴 Disconnected";

        socket = null;
        scheduleSocketReconnect();
    };

}

window.addEventListener("beforeunload",()=>{
    stopSocketHeartbeat();
    clearTimeout(reconnectTimer);
});

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

    if (data.type === "call_offer" && window.LuckyVoiceCall?.handleOffer) { window.LuckyVoiceCall.handleOffer(data); return; }
    if (data.type === "call_answer" && window.LuckyVoiceCall?.handleAnswer) { window.LuckyVoiceCall.handleAnswer(data); return; }
    if (data.type === "call_ice" && window.LuckyVoiceCall?.handleIce) { window.LuckyVoiceCall.handleIce(data); return; }
    if (data.type === "call_reject" && window.LuckyVoiceCall?.handleReject) { window.LuckyVoiceCall.handleReject(data); return; }
    if (data.type === "call_busy" && window.LuckyVoiceCall?.handleBusy) { window.LuckyVoiceCall.handleBusy(data); return; }
    if (data.type === "call_end" && window.LuckyVoiceCall?.handleEnd) { window.LuckyVoiceCall.handleEnd(data); return; }
    if (data.type === "call_unavailable" && window.LuckyVoiceCall?.handleUnavailable) { window.LuckyVoiceCall.handleUnavailable(data); return; }

    if (data.type === "call_history_update" && data.call) {
        addMessage(data.call);
        return;
    }

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
    // Crypto must never prevent the chat history from loading.
    try {
        await LuckyCrypto.init();
        console.log("✅ LuckyCrypto ready");
    } catch (error) {
        console.warn("⚠️ LuckyCrypto unavailable:", error);
    }

    // Open the live socket before loading/decrypting history so the first
    // outgoing message is never stranded waiting for a later connection.
    connectSocket();

    try {
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

    // Video attach button
    if (videoBtn && videoInput) {
        videoBtn.addEventListener("click", () => {
            videoInput.click();
        });
    }

    if (videoInput) {
        videoInput.addEventListener("change", async () => {
            await uploadChatVideo();
        });
    }

    removeVideoBtn?.addEventListener("click", clearVideoPreview);

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

window.LUCKY_CHAT_CORE_VERSION = "media-video-v2-upload-progress+voice-call-fix-v6-audio-diagnostics";
console.log("JavaScript loaded | Lucky Chat core reply-quote-fix-v1");

function createOptimisticMessage(text, image, audio, video) {
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
        media_url: image?.url || audio?.url || video?.url || null,
        media_type: image?.media_type || audio?.media_type || video?.media_type || null,
        media_duration: audio?.duration || 0,
        media_waveform: audio?.waveform?.length ? JSON.stringify(audio.waveform) : null,
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
    const video = window.selectedChatVideo;

    // Don't send anything if there is neither text nor image/audio/video.
    if (text === "" && !image && !audio && !video) {
        return;
    }

    // Render the outgoing bubble first. Network/crypto work is deliberately
    // deferred to a later task so Android Chrome can paint this bubble before
    // anything else occupies the main thread.
    const optimisticMessage = createOptimisticMessage(text, image, audio, video);
    queueOptimisticMessage(optimisticMessage);

    // Clear the composer immediately so the UI is responsive.
    input.value = "";
    window.selectedChatImage = null;
    window.selectedChatAudio = null;
    window.selectedChatVideo = null;

    const imagePreview = document.getElementById("imagePreview");
    const previewImage = document.getElementById("previewImage");
    const replyPreviewEl = document.getElementById("replyPreview");

    if (imagePreview) imagePreview.style.display = "none";
    if (previewImage) previewImage.src = "";
    clearAudioPreview();
    clearVideoPreview();

    replyToId = null;
    if (replyPreviewEl) replyPreviewEl.style.display = "none";

    const sendLater = () => {
        void sendOptimisticMessage(optimisticMessage, image, audio, video);
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

async function sendOptimisticMessage(optimisticMessage, image, audio, video) {
    try {
        const pending = pendingOutgoingMessages.find(
            item => item.tempId === optimisticMessage.id
        );

        if (!socket || socket.readyState !== WebSocket.OPEN) {
            connectSocket();
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
            payload.media_waveform = audio.waveform?.length
                ? JSON.stringify(audio.waveform)
                : null;
        }

        if (video) {
            payload.media_url = video.url;
            payload.media_type = video.media_type;
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


function parseCallHistoryData(msg){
    if(!msg || msg.media_type!=="call") return null;

    try{
        const value=typeof msg.text==="string"
            ? JSON.parse(msg.text||"{}")
            : msg.text;

        if(value && value.type==="voice_call"){
            return value;
        }
    }catch(_){}

    return {
        type:"voice_call",
        status:"ended",
        duration:Number(msg.media_duration||0)
    };
}

function formatCallHistoryDuration(seconds){
    const total=Math.max(0,Math.floor(Number(seconds)||0));
    const minutes=Math.floor(total/60);
    const secs=String(total%60).padStart(2,"0");
    return `${String(minutes).padStart(2,"0")}:${secs}`;
}

function callHistoryLabel(msg,call){
    const outgoing=msg.sender===username;
    const duration=Number(call.duration||msg.media_duration||0);

    if(call.status==="missed"){
        return outgoing ? "Cancelled voice call" : "Missed voice call";
    }
    if(call.status==="rejected"){
        return outgoing ? "Voice call declined" : "Declined voice call";
    }
    if(call.status==="busy"){
        return "Voice call busy";
    }
    if(call.status==="unavailable"){
        return "Voice call unavailable";
    }
    if(call.status==="ringing"){
        return outgoing ? "Calling…" : "Incoming voice call";
    }
    if(call.status==="active"){
        return "Voice call connected";
    }
    if(call.status==="ended"){
        return duration>0
            ? `Voice call • ${formatCallHistoryDuration(duration)}`
            : "Voice call ended";
    }

    return "Voice call";
}

function renderCallHistoryMessage(msg){
    const call=parseCallHistoryData(msg);
    if(!call || !messages) return;

    const existing=document.querySelector(`[data-msg="${msg.id}"]`);
    const outgoing=msg.sender===username;
    const status=String(call.status||"ended");
    const label=callHistoryLabel(msg,call);

    if(existing){
        const labelNode=existing.querySelector(".call-history-label");
        const statusNode=existing.querySelector(".call-history-status");
        const iconNode=existing.querySelector(".call-history-icon");

        if(labelNode) labelNode.textContent=label;
        if(statusNode) statusNode.textContent=status.toUpperCase();
        if(iconNode){
            iconNode.textContent =
                status==="missed" ? "📵" :
                status==="rejected" ? "🚫" :
                status==="busy" ? "📞" :
                status==="unavailable" ? "⚠️" :
                "📞";
        }

        existing.dataset.callStatus=status;
        return;
    }

    const row=document.createElement("div");
    row.className="message-row call-history-row";

    row.innerHTML=`
        <div class="message ${outgoing ? "message-own" : "message-other"} call-history-message"
             data-msg="${msg.id}"
             data-call-status="${escapeHTML(status)}">
            <div class="call-history-card">
                <div class="call-history-icon" aria-hidden="true">${
                    status==="missed" ? "📵" :
                    status==="rejected" ? "🚫" :
                    status==="unavailable" ? "⚠️" :
                    "📞"
                }</div>
                <div class="call-history-copy">
                    <div class="call-history-label">${escapeHTML(label)}</div>
                    <div class="call-history-meta">
                        <span class="call-history-status">${escapeHTML(status.toUpperCase())}</span>
                        <span class="msg-time">${formatMessageTimestamp(msg.timestamp)}</span>
                    </div>
                </div>
            </div>
        </div>
    `;

    messages.appendChild(row);
}


function addMessage(msg){

    if (deletedMessages[msg.id]) {
        return;
    }

    if (msg.media_type === "call") {
        messageMap[msg.id] = msg;
        renderCallHistoryMessage(msg);
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
            replied.sender === username ? "You" : (replied.sender || "Lucky Chat");

        let replyType = "text";
        let repliedContent = "";

        if (replied.media_type === "image" && replied.media_url) {
            replyType = "image";
            repliedContent = `
                <div class="reply-quote-media">
                    <img
                        class="reply-quote-thumb"
                        src="${escapeHTML(replied.media_url)}"
                        alt="Photo"
                        loading="lazy"
                    >
                    <span class="reply-quote-media-label">Photo</span>
                </div>
            `;
        } else if (replied.media_type === "audio" && replied.media_url) {
            replyType = "audio";
            const replyDuration = Number(replied.media_duration || 0);
            repliedContent = `
                <div class="reply-quote-media">
                    <span class="reply-quote-icon" aria-hidden="true">🎙️</span>
                    <span class="reply-quote-media-label">Voice message</span>
                    ${replyDuration > 0
                        ? `<span class="reply-quote-duration">${formatAudioTime(replyDuration)}</span>`
                        : ""}
                </div>
            `;
        } else {
            repliedContent = `
                <div class="reply-quote-text">
                    ${escapeHTML(replied.text || "Message")}
                </div>
            `;
        }

        replyHtml = `
            <div
                class="reply-quote reply-quote-${replyType}"
                onclick="jumpToRepliedMessage(${Number(replied.id) || 0})"
                title="Jump to original message"
            >
                <div class="reply-quote-accent" aria-hidden="true"></div>
                <div class="reply-quote-content">
                    <div class="reply-quote-sender">${escapeHTML(replyName)}</div>
                    ${repliedContent}
                </div>
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
                    data-photo-url="${escapeHTML(msg.media_url)}"
                    role="button"
                    tabindex="0"
                    aria-label="Open photo"
                >
            `;
        } else if (msg.media_url && msg.media_type === "video") {
            mediaHtml = `
                <div class="video-message">
                    <video
                        class="chat-video"
                        src="${escapeHTML(msg.media_url)}"
                        controls
                        playsinline
                        preload="metadata"
                        aria-label="Video message"
                        data-video-url="${escapeHTML(msg.media_url)}"
                        role="button"
                        tabindex="0"
                    ></video>
                </div>
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
                        ${parseStoredWaveform(msg.media_waveform)
                            .map((value, index) =>
                                `<span data-wave-index="${index}" style="height:${Math.round(6 + value * 20)}px"></span>`
                            )
                            .join("")}
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

    const voiceAudio = row.querySelector("audio[data-voice-audio='1']");
    if (voiceAudio) {
        bindVoicePlayback(row);

        const durationLabel = row.querySelector(".voice-duration");

        const updateVoiceDuration = () => {
            if (
                durationLabel &&
                Number.isFinite(voiceAudio.duration) &&
                voiceAudio.duration > 0 &&
                voiceAudio.paused
            ) {
                durationLabel.textContent =
                    formatAudioTime(voiceAudio.duration);
            }
        };

        voiceAudio.addEventListener("loadedmetadata", updateVoiceDuration);
        if (voiceAudio.readyState >= 1) {
            updateVoiceDuration();
        }

        scheduleVoiceHydration(row, msg);
    }

    renderPinnedBadge(msg.id);
    renderPinnedBar();
    messages.scrollTop = messages.scrollHeight;
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


function ensureVideoUploadStatusUI() {
    if (!videoPreview) return null;

    let status = document.getElementById("videoUploadStatus");
    if (status) return status;

    status = document.createElement("div");
    status.id = "videoUploadStatus";
    status.style.display = "none";
    status.style.marginTop = "7px";
    status.style.padding = "7px 9px";
    status.style.borderRadius = "10px";
    status.style.background = "rgba(15,23,42,.72)";
    status.style.border = "1px solid rgba(96,165,250,.20)";
    status.style.color = "#cbd5e1";
    status.style.fontSize = "12px";
    status.style.lineHeight = "1.25";
    status.style.boxSizing = "border-box";

    const title = document.createElement("div");
    title.id = "videoUploadStatusText";
    title.textContent = "Preparing video…";

    const track = document.createElement("div");
    track.style.height = "5px";
    track.style.marginTop = "6px";
    track.style.borderRadius = "999px";
    track.style.overflow = "hidden";
    track.style.background = "rgba(148,163,184,.18)";

    const bar = document.createElement("div");
    bar.id = "videoUploadProgress";
    bar.style.width = "0%";
    bar.style.height = "100%";
    bar.style.borderRadius = "999px";
    bar.style.background = "linear-gradient(90deg,#60a5fa,#2563eb)";
    bar.style.transition = "width .12s linear";

    track.appendChild(bar);
    status.appendChild(title);
    status.appendChild(track);

    videoPreview.appendChild(status);
    return status;
}

function updateVideoUploadStatus(text, percent = null, visible = true) {
    const status = ensureVideoUploadStatusUI();
    if (!status) return;

    status.style.display = visible ? "block" : "none";

    const label = document.getElementById("videoUploadStatusText");
    const bar = document.getElementById("videoUploadProgress");

    if (label) label.textContent = text;

    if (bar && percent != null && Number.isFinite(Number(percent))) {
        const safe = Math.max(0, Math.min(100, Number(percent)));
        bar.style.width = safe + "%";
    }
}

function formatUploadSize(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024 * 1024) {
        return `${Math.max(1, Math.round(value / 1024))} KB`;
    }
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function uploadVideoWithProgress(file) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();

        xhr.open("POST", "/upload-chat-video", true);
        xhr.withCredentials = true;

        xhr.upload.addEventListener("progress", event => {
            if (!event.lengthComputable) {
                updateVideoUploadStatus("Uploading video…", null, true);
                return;
            }

            const percent = (event.loaded / event.total) * 100;
            updateVideoUploadStatus(
                `Uploading ${Math.round(percent)}% • ${formatUploadSize(event.loaded)} / ${formatUploadSize(event.total)}`,
                percent,
                true
            );
        });

        xhr.addEventListener("load", () => {
            let result = null;

            try {
                result = JSON.parse(xhr.responseText || "{}");
            } catch (_) {
                reject(new Error("Invalid server response"));
                return;
            }

            if (xhr.status < 200 || xhr.status >= 300 || !result.success) {
                reject(new Error(result.error || `Video upload failed (HTTP ${xhr.status})`));
                return;
            }

            resolve(result);
        });

        xhr.addEventListener("error", () => {
            reject(new Error("Network error while uploading video"));
        });

        xhr.addEventListener("abort", () => {
            reject(new Error("Video upload cancelled"));
        });

        xhr.addEventListener("timeout", () => {
            reject(new Error("Video upload timed out"));
        });

        // No artificial timeout: large uploads depend on the connection speed.
        const formData = new FormData();
        formData.append("file", file);
        xhr.send(formData);
    });
}

async function uploadChatVideo() {
    const file = videoInput?.files?.[0];
    if (!file) return;

    const allowed = new Set(["video/mp4", "video/webm", "video/ogg"]);
    const maxSize = 30 * 1024 * 1024;

    if (!allowed.has(file.type)) {
        alert("Only MP4, WebM, and OGG videos are allowed");
        if (videoInput) videoInput.value = "";
        return;
    }

    if (file.size > maxSize) {
        alert("Video is too large. Maximum size is 30 MB");
        if (videoInput) videoInput.value = "";
        return;
    }

    if (videoPreview) videoPreview.style.display = "flex";
    if (videoPreviewName) videoPreviewName.textContent = file.name || "Video";

    // Clear an older uploaded video while the new one uploads.
    window.selectedChatVideo = null;
    updateVideoUploadStatus("Uploading video… 0%", 0, true);

    try {
        const startedAt = performance.now();
        const result = await uploadVideoWithProgress(file);
        const elapsed = Math.max(0, (performance.now() - startedAt) / 1000);

        window.selectedChatVideo = result;

        updateVideoUploadStatus(
            `Ready to send • ${formatUploadSize(file.size)} • ${elapsed.toFixed(1)}s`,
            100,
            true
        );

        console.log(
            "VIDEO UPLOADED:",
            result,
            "size:",
            file.size,
            "seconds:",
            elapsed
        );
    } catch (error) {
        console.error("VIDEO UPLOAD ERROR:", error);
        window.selectedChatVideo = null;
        updateVideoUploadStatus(
            `Upload failed • ${error.message || "Unknown error"}`,
            0,
            true
        );
        alert(error.message || "Could not upload video");
    } finally {
        if (videoInput) videoInput.value = "";
    }
}

function clearVideoPreview() {
    window.selectedChatVideo = null;
    const uploadStatus = document.getElementById("videoUploadStatus");
    if (uploadStatus) uploadStatus.remove();
    if (videoPreview) videoPreview.style.display = "none";
    if (videoPreviewName) videoPreviewName.textContent = "Video";
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
    window.selectedChatVideo = null;

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

    // Legacy messages contain only a time such as "09:45 AM".
    // Keep them unchanged because they have no date/timezone information.
    if (/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(raw)) {
        return raw;
    }

    // New messages contain a complete UTC timestamp.
    let iso = raw;

    if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(iso)) {
        iso += "Z";
    }

    const date = new Date(iso);

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
    const clearBtn = document.getElementById("chatSearchClear");
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
        if (msg.media_type === "video" && msg.media_url) {
            const text = (msg.text || "").trim();
            return text ? "🎬 " + text : "🎬 Video";
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

    function formatSearchTimestamp(value) {
        if (!value) return "";
        const date = new Date(value);

        if (!Number.isNaN(date.getTime())) {
            return date.toLocaleString([], {
                hour: "numeric",
                minute: "2-digit"
            });
        }

        return String(value);
    }

    function getSearchMediaMeta(msg) {
        if (msg.media_type === "image" && msg.media_url) {
            return { icon: "🖼️", label: "Photo", className: "photo" };
        }
        if (msg.media_type === "video" && msg.media_url) {
            return { icon: "🎬", label: "Video", className: "video" };
        }
        if (msg.media_type === "audio" && msg.media_url) {
            return { icon: "🎙️", label: "Voice", className: "audio" };
        }
        return { icon: "💬", label: "Message", className: "text" };
    }

    function highlightSearchText(text, query) {
        const source = String(text ?? "");
        const needle = String(query ?? "").trim();

        if (!needle) return escapeSearchHtml(source);

        const pattern = new RegExp(
            needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            "ig"
        );

        let output = "";
        let lastIndex = 0;
        let match;

        while ((match = pattern.exec(source)) !== null) {
            output += escapeSearchHtml(source.slice(lastIndex, match.index));
            output += `<mark class="chat-search-highlight">${escapeSearchHtml(match[0])}</mark>`;
            lastIndex = match.index + match[0].length;

            if (!pattern.global) break;
        }

        output += escapeSearchHtml(source.slice(lastIndex));
        return output;
    }

    function renderResults(query) {
        const q = query.trim().toLowerCase();
        const all = getMessageList();

        if (!q) {
            matches = [];
            activeIndex = -1;
            countEl.textContent = "0 / 0";
            if (clearBtn) clearBtn.hidden = true;
            resultsEl.innerHTML =
                '<div class="chat-search-empty">' +
                    '<div class="chat-search-empty-icon" aria-hidden="true">🔍</div>' +
                    '<strong>Search this conversation</strong>' +
                    '<span>Messages, photos, videos and voice messages will appear here.</span>' +
                '</div>';
            return;
        }

        matches = all.filter(msg =>
            messagePreview(msg).toLowerCase().includes(q)
        );

        activeIndex = matches.length ? 0 : -1;
        countEl.textContent = matches.length ? `1 / ${matches.length}` : "0 / 0";
        if (clearBtn) clearBtn.hidden = !q;

        if (!matches.length) {
            resultsEl.innerHTML =
                '<div class="chat-search-empty">' +
                    '<div class="chat-search-empty-icon is-empty" aria-hidden="true">⌕</div>' +
                    '<strong>No messages found</strong>' +
                    '<span>Try another word, phrase, or media name.</span>' +
                '</div>';
            return;
        }

        resultsEl.innerHTML = matches.map((msg, index) => {
            const name = msg.sender === username ? "You" : (msg.sender || "Lucky Chat");
            const preview = messagePreview(msg);
            const media = getSearchMediaMeta(msg);
            const timestamp = formatSearchTimestamp(msg.timestamp);
            const isActive = index === activeIndex;

            return `
                <button class="chat-search-result${isActive ? " is-current" : ""}"
                        type="button"
                        data-search-id="${Number(msg.id)}"
                        data-search-index="${index}"
                        aria-label="Open matching message">
                    <span class="chat-search-result-icon ${media.className}" aria-hidden="true">${media.icon}</span>

                    <span class="chat-search-result-main">
                        <span class="chat-search-result-top">
                            <span class="chat-search-result-name">${escapeSearchHtml(name)}</span>
                            <span class="chat-search-result-type">${escapeSearchHtml(media.label)}</span>
                        </span>

                        <span class="chat-search-result-text">${highlightSearchText(preview, q)}</span>

                        <span class="chat-search-result-bottom">
                            <span class="chat-search-result-time">${escapeSearchHtml(timestamp)}</span>
                            ${isActive ? '<span class="chat-search-current">Current match</span>' : ""}
                        </span>
                    </span>

                    <span class="chat-search-result-chevron" aria-hidden="true">›</span>
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

        if (countEl) {
            countEl.textContent = `${activeIndex + 1} / ${matches.length}`;
        }

        resultsEl.querySelectorAll(".chat-search-result").forEach((item, index) => {
            const active = index === activeIndex;
            item.classList.toggle("is-current", active);

            const badge = item.querySelector(".chat-search-current");

            if (active && !badge) {
                const bottom = item.querySelector(".chat-search-result-bottom");
                if (bottom) {
                    bottom.insertAdjacentHTML(
                        "beforeend",
                        '<span class="chat-search-current">Current match</span>'
                    );
                }
            } else if (!active && badge) {
                badge.remove();
            }
        });

        const result = resultsEl.querySelector(
            `[data-search-id="${target.id}"]`
        );

        if (result) {
            result.scrollIntoView({
                behavior: "smooth",
                block: "center"
            });

            result.animate(
                [
                    { transform: "scale(1)" },
                    { transform: "scale(1.015)" },
                    { transform: "scale(1)" }
                ],
                {
                    duration: 220,
                    easing: "ease-out"
                }
            );
        }
    }

    function openSearch() {
        overlay.style.display = "flex";
        overlay.classList.remove("is-closing");
        requestAnimationFrame(() => overlay.classList.add("is-open"));
        overlay.setAttribute("aria-hidden", "false");
        inputEl.value = "";
        renderResults("");
        setTimeout(() => inputEl.focus(), 90);
    }

    function closeSearch() {
        overlay.classList.remove("is-open");
        overlay.classList.add("is-closing");
        overlay.setAttribute("aria-hidden", "true");

        setTimeout(() => {
            overlay.style.display = "none";
            overlay.classList.remove("is-closing");
        }, 220);

        inputEl.value = "";
        matches = [];
        activeIndex = -1;
        if (countEl) countEl.textContent = "0 / 0";
        if (clearBtn) clearBtn.hidden = true;
    }

    openBtn.addEventListener("click", openSearch);
    closeBtn.addEventListener("click", closeSearch);
    inputEl.addEventListener("input", () => renderResults(inputEl.value));

    clearBtn?.addEventListener("click", () => {
        inputEl.value = "";
        renderResults("");
        inputEl.focus();
    });

    prevBtn.addEventListener("click", () => moveMatch(-1));
    nextBtn.addEventListener("click", () => moveMatch(1));

    document.addEventListener("keydown", event => {
        if (!overlay.classList.contains("is-open")) return;

        if (event.key === "Escape") {
            closeSearch();
            return;
        }

        if (event.key === "ArrowUp") {
            event.preventDefault();
            moveMatch(-1);
        } else if (event.key === "ArrowDown") {
            event.preventDefault();
            moveMatch(1);
        }
    });

    inputEl.addEventListener("keydown", event => {
        if (event.key === "Escape") {
            closeSearch();
        } else if (event.key === "Enter" && matches.length) {
            moveMatch(1);
        }
    });
})();



/* =========================================================
   LUCKY CHAT — FULL-SCREEN PHOTO VIEWER V2
   Robust delegated touch/pointer handling for dynamically
   rendered chat images.
   ========================================================= */

const photoViewer = document.getElementById("photoViewer");
const photoViewerStage = document.getElementById("photoViewerStage");
const photoViewerImage = document.getElementById("photoViewerImage");
const photoViewerClose = document.getElementById("photoViewerClose");
const photoViewerSpinner = document.getElementById("photoViewerSpinner");

const photoViewerState = {
    open: false,
    scale: 1,
    maxScale: 4,
    x: 0,
    y: 0,
    startX: 0,
    startY: 0,
    startPanX: 0,
    startPanY: 0,
    startScale: 1,
    pinchStartDistance: 0,
    pointers: new Map(),
    lastTap: 0,
    swipeY: 0
};

function photoViewerDistance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
}

function photoViewerClampScale(value) {
    return Math.max(1, Math.min(photoViewerState.maxScale, value));
}

function photoViewerSetTransform(animate = false) {
    if (!photoViewerImage) return;
    photoViewerImage.classList.toggle("photo-viewer-animating", animate);
    photoViewerImage.style.transform =
        `translate3d(${photoViewerState.x}px, ${photoViewerState.y}px, 0) scale(${photoViewerState.scale})`;
}

function photoViewerReset(animate = false) {
    photoViewerState.scale = 1;
    photoViewerState.x = 0;
    photoViewerState.y = 0;
    photoViewerState.swipeY = 0;
    photoViewerSetTransform(animate);
}

function photoViewerSetLoading(show) {
    photoViewerSpinner?.classList.toggle("is-visible", !!show);
    photoViewerImage?.classList.toggle("is-loading", !!show);
}

function openPhotoViewer(image) {
    if (!photoViewer || !photoViewerImage || !image) return;

    const url = image.dataset.photoUrl || image.currentSrc || image.src;
    if (!url) return;

    photoViewerState.open = true;
    photoViewerState.pointers.clear();
    photoViewerReset(false);

    photoViewerImage.alt = image.alt || "Photo";
    photoViewerImage.src = url;
    photoViewerSetLoading(true);

    photoViewer.classList.remove("is-closing");
    photoViewer.classList.add("is-open");
    photoViewer.setAttribute("aria-hidden", "false");
    document.body.classList.add("photo-viewer-open");

    photoViewerImage.onload = () => {
        photoViewerSetLoading(false);
        photoViewerImage.style.transform = "translate3d(0,0,0) scale(.96)";
        requestAnimationFrame(() => {
            photoViewerImage.classList.add("photo-viewer-animating");
            photoViewerImage.style.transform = "translate3d(0,0,0) scale(1)";
        });
    };

    photoViewerImage.onerror = () => {
        photoViewerSetLoading(false);
        console.error("PHOTO VIEWER: image failed to load");
    };
}

function closePhotoViewer() {
    if (!photoViewer || !photoViewerState.open) return;

    photoViewerState.open = false;
    photoViewer.classList.remove("is-swipe-dismissing");
    photoViewer.classList.add("is-closing");
    photoViewer.setAttribute("aria-hidden", "true");

    window.setTimeout(() => {
        photoViewer.classList.remove("is-open", "is-closing");
        document.body.classList.remove("photo-viewer-open");
        photoViewerImage?.removeAttribute("src");
        photoViewerSetLoading(false);
        photoViewerReset(false);
        returnToMediaGalleryAfterViewer();
    }, 230);
}

function photoViewerDoubleTap(clientX, clientY) {
    if (!photoViewerStage) return;

    if (photoViewerState.scale > 1.05) {
        photoViewerReset(true);
        return;
    }

    const rect = photoViewerStage.getBoundingClientRect();
    const localX = clientX - rect.left - rect.width / 2;
    const localY = clientY - rect.top - rect.height / 2;

    photoViewerState.scale = 2.2;
    photoViewerState.x = -localX * 0.95;
    photoViewerState.y = -localY * 0.95;
    photoViewerSetTransform(true);
}

function photoViewerPointerDown(event) {
    if (!photoViewerState.open) return;

    photoViewerState.pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY
    });

    const points = Array.from(photoViewerState.pointers.values());

    if (points.length === 1) {
        const now = performance.now();
        if (now - photoViewerState.lastTap < 300) {
            photoViewerDoubleTap(event.clientX, event.clientY);
            photoViewerState.lastTap = 0;
            event.preventDefault();
            return;
        }

        photoViewerState.lastTap = now;
        photoViewerState.startX = event.clientX;
        photoViewerState.startY = event.clientY;
        photoViewerState.startPanX = photoViewerState.x;
        photoViewerState.startPanY = photoViewerState.y;
        event.preventDefault();
    } else if (points.length === 2) {
        photoViewerState.pinchStartDistance =
            photoViewerDistance(points[0], points[1]);
        photoViewerState.startScale = photoViewerState.scale;
        event.preventDefault();
    }
}

function photoViewerPointerMove(event) {
    if (!photoViewerState.open) return;

    const pointer = photoViewerState.pointers.get(event.pointerId);
    if (!pointer) return;

    pointer.x = event.clientX;
    pointer.y = event.clientY;

    const points = Array.from(photoViewerState.pointers.values());

    if (points.length >= 2 && photoViewerState.pinchStartDistance > 0) {
        const distance = photoViewerDistance(points[0], points[1]);
        photoViewerState.scale = photoViewerClampScale(
            photoViewerState.startScale *
            (distance / photoViewerState.pinchStartDistance)
        );
        photoViewerSetTransform(false);
        event.preventDefault();
        return;
    }

    if (points.length !== 1) return;

    const dx = event.clientX - photoViewerState.startX;
    const dy = event.clientY - photoViewerState.startY;

    if (photoViewerState.scale > 1.05) {
        photoViewerState.x = photoViewerState.startPanX + dx;
        photoViewerState.y = photoViewerState.startPanY + dy;
        photoViewerSetTransform(false);
        event.preventDefault();
        return;
    }

    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) {
        photoViewerState.swipeY = dy;
        photoViewerImage.style.transform =
            `translate3d(0,${dy}px,0) scale(${Math.max(.82, 1 - Math.abs(dy) / 900)})`;
        photoViewer.classList.add("is-swipe-dismissing");
        event.preventDefault();
    }
}

function photoViewerPointerEnd(event) {
    photoViewerState.pointers.delete(event.pointerId);

    if (photoViewerState.pointers.size < 2) {
        photoViewerState.pinchStartDistance = 0;
    }

    if (photoViewerState.pointers.size === 0) {
        const swipe = photoViewerState.swipeY;

        if (photoViewerState.scale <= 1.05 && Math.abs(swipe) > 120) {
            closePhotoViewer();
        } else {
            photoViewer.classList.remove("is-swipe-dismissing");
            photoViewerSetTransform(true);
        }

        photoViewerState.swipeY = 0;
    }

    event.preventDefault();
}

function photoViewerPointerCancel(event) {
    photoViewerState.pointers.delete(event.pointerId);
    photoViewerState.pinchStartDistance = 0;
    photoViewerState.swipeY = 0;
    photoViewer.classList.remove("is-swipe-dismissing");
    photoViewerSetTransform(true);
}

/* Capture on the document so dynamic message bubbles work reliably. */
document.addEventListener("pointerup", event => {
    const image = event.target?.closest?.(".chat-image");
    if (!image || photoViewerState.open) return;

    openPhotoViewer(image);
}, true);

document.addEventListener("click", event => {
    const image = event.target?.closest?.(".chat-image");
    if (!image || photoViewerState.open) return;

    openPhotoViewer(image);
}, true);

if (photoViewerStage) {
    photoViewerStage.addEventListener("pointerdown", photoViewerPointerDown, { passive:false });
    photoViewerStage.addEventListener("pointermove", photoViewerPointerMove, { passive:false });
    photoViewerStage.addEventListener("pointerup", photoViewerPointerEnd, { passive:false });
    photoViewerStage.addEventListener("pointercancel", photoViewerPointerCancel, { passive:false });
}

photoViewerClose?.addEventListener("click", event => {
    event.stopPropagation();
    closePhotoViewer();
});

photoViewer?.querySelector(".photo-viewer-backdrop")?.addEventListener("click", closePhotoViewer);

photoViewerStage?.addEventListener("click", event => {
    if (
        event.target === photoViewerStage &&
        photoViewerState.scale <= 1.05
    ) {
        closePhotoViewer();
    }
});

document.addEventListener("keydown", event => {
    if (!photoViewerState.open) return;

    if (event.key === "Escape") {
        event.preventDefault();
        closePhotoViewer();
    }
});

/* =========================================================
   LUCKY CHAT — FULL-SCREEN VIDEO VIEWER V2
   ========================================================= */

const videoViewer = document.getElementById("videoViewer");
const videoViewerStage = document.getElementById("videoViewerStage");
const videoViewerVideo = document.getElementById("videoViewerVideo");
const videoViewerCloseButton = document.getElementById("videoViewerClose");
const videoViewerSpinner = document.getElementById("videoViewerSpinner");
const videoViewerControls = document.getElementById("videoViewerControls");
const videoViewerPlay = document.getElementById("videoViewerPlay");
const videoViewerSeek = document.getElementById("videoViewerSeek");
const videoViewerCurrentTime = document.getElementById("videoViewerCurrentTime");
const videoViewerDuration = document.getElementById("videoViewerDuration");
const videoViewerMute = document.getElementById("videoViewerMute");
const videoViewerFullscreen = document.getElementById("videoViewerFullscreen");

const videoViewerState = {
    open:false,
    sourceElement:null,
    pointers:new Map(),
    startX:0,
    startY:0,
    swipeY:0,
    lastTap:0,
    controlsTimer:null
};

function videoViewerFormatTime(seconds){
    const value=Math.max(0,Math.floor(Number(seconds)||0));
    return `${Math.floor(value/60)}:${String(value%60).padStart(2,"0")}`;
}

function videoViewerSetLoading(show){
    videoViewerSpinner?.classList.toggle("is-visible",!!show);
    videoViewerVideo?.classList.toggle("is-loading",!!show);
}

function videoViewerUpdatePlayButton(){
    if(!videoViewerPlay||!videoViewerVideo) return;
    videoViewerPlay.textContent=videoViewerVideo.paused?"▶":"⏸";
}

function videoViewerUpdateTime(){
    if(!videoViewerVideo) return;
    const duration=Number(videoViewerVideo.duration);
    const current=Number(videoViewerVideo.currentTime||0);
    if(videoViewerCurrentTime) videoViewerCurrentTime.textContent=videoViewerFormatTime(current);
    if(videoViewerDuration){
        videoViewerDuration.textContent=
            Number.isFinite(duration)&&duration>0?videoViewerFormatTime(duration):"0:00";
    }
    if(videoViewerSeek){
        const ratio=Number.isFinite(duration)&&duration>0?Math.max(0,Math.min(1,current/duration)):0;
        videoViewerSeek.value=String(Math.round(ratio*1000));
    }
}

function videoViewerShowControls(){
    if(!videoViewerControls) return;
    videoViewerControls.classList.add("is-visible");
    clearTimeout(videoViewerState.controlsTimer);
    videoViewerState.controlsTimer=setTimeout(()=>{
        if(videoViewerVideo&&!videoViewerVideo.paused) videoViewerControls.classList.remove("is-visible");
    },2200);
}

function videoViewerTogglePlay(){
    if(!videoViewerVideo) return;
    if(videoViewerVideo.paused) videoViewerVideo.play().catch(()=>{});
    else videoViewerVideo.pause();
    videoViewerShowControls();
}

function videoViewerToggleMute(){
    if(!videoViewerVideo) return;
    videoViewerVideo.muted=!videoViewerVideo.muted;
    if(videoViewerMute) videoViewerMute.textContent=videoViewerVideo.muted?"🔇":"🔊";
    videoViewerShowControls();
}

function videoViewerSeekFromRange(){
    if(!videoViewerVideo||!videoViewerSeek) return;
    const duration=Number(videoViewerVideo.duration);
    if(!Number.isFinite(duration)||duration<=0) return;
    videoViewerVideo.currentTime=(Number(videoViewerSeek.value)/1000)*duration;
    videoViewerShowControls();
}

async function videoViewerToggleFullscreen(){
    try{
        if(document.fullscreenElement) await document.exitFullscreen();
        else if(videoViewerStage?.requestFullscreen) await videoViewerStage.requestFullscreen();
        else if(videoViewerVideo?.webkitEnterFullscreen) videoViewerVideo.webkitEnterFullscreen();
    }catch(_){}
    videoViewerShowControls();
}

function videoViewerOpen(source){
    if(!videoViewer||!videoViewerVideo||!source) return;
    const url=source.dataset.videoUrl||source.currentSrc||source.getAttribute("src")||source.src;
    if(!url) return;

    videoViewerState.open=true;
    videoViewerState.sourceElement=source;
    videoViewerState.pointers.clear();
    videoViewerState.swipeY=0;
    videoViewerState.lastTap=0;

    videoViewerStage.style.transform="translate3d(0,0,0) scale(1)";
    videoViewer.classList.remove("is-closing","is-swipe-dismissing");
    videoViewer.classList.add("is-open");
    videoViewer.setAttribute("aria-hidden","false");
    document.body.classList.add("video-viewer-open");

    videoViewerSetLoading(true);
    videoViewerVideo.pause();
    videoViewerVideo.currentTime=0;
    videoViewerVideo.src=url;
    videoViewerVideo.load();
    videoViewerUpdateTime();
    videoViewerUpdatePlayButton();
    videoViewerShowControls();

    videoViewerVideo.onloadedmetadata=()=>{
        videoViewerSetLoading(false);
        videoViewerUpdateTime();
    };
    videoViewerVideo.oncanplay=()=>videoViewerSetLoading(false);
    videoViewerVideo.onerror=()=>{
        videoViewerSetLoading(false);
        console.error("VIDEO VIEWER: video failed to load");
    };
    videoViewerVideo.play().catch(()=>videoViewerUpdatePlayButton());
}

function videoViewerClose(){
    if(!videoViewer||!videoViewerState.open) return;
    videoViewerState.open=false;
    clearTimeout(videoViewerState.controlsTimer);
    videoViewer.classList.remove("is-swipe-dismissing");
    videoViewer.classList.add("is-closing");
    videoViewer.setAttribute("aria-hidden","true");

    if(document.fullscreenElement) document.exitFullscreen().catch(()=>{});
    if(videoViewerVideo) videoViewerVideo.pause();

    setTimeout(()=>{
        videoViewer.classList.remove("is-open","is-closing");
        document.body.classList.remove("video-viewer-open");
        if(videoViewerVideo){
            videoViewerVideo.removeAttribute("src");
            videoViewerVideo.load();
        }
        videoViewerState.sourceElement=null;
        videoViewerSetLoading(false);
        videoViewerUpdateTime();
        videoViewerUpdatePlayButton();
        returnToMediaGalleryAfterViewer();
    },230);
}

function videoViewerDoubleTap(clientX){
    if(!videoViewerVideo) return;
    const direction=clientX<(window.innerWidth/2)?-1:1;
    const duration=Number(videoViewerVideo.duration||0);
    const next=videoViewerVideo.currentTime+direction*10;
    videoViewerVideo.currentTime=Math.max(0,Math.min(duration>0?duration:next,next));
    videoViewerShowControls();
}

function videoViewerPointerDown(event){
    if(!videoViewerState.open) return;
    videoViewerState.pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(videoViewerState.pointers.size===1){
        const now=performance.now();
        if(now-videoViewerState.lastTap<300){
            videoViewerDoubleTap(event.clientX);
            videoViewerState.lastTap=0;
            event.preventDefault();
            return;
        }
        videoViewerState.lastTap=now;
        videoViewerState.startX=event.clientX;
        videoViewerState.startY=event.clientY;
        videoViewerState.swipeY=0;
    }
    videoViewerShowControls();
}

function videoViewerPointerMove(event){
    if(!videoViewerState.open) return;
    const pointer=videoViewerState.pointers.get(event.pointerId);
    if(!pointer||videoViewerState.pointers.size!==1) return;
    pointer.x=event.clientX; pointer.y=event.clientY;
    const dx=event.clientX-videoViewerState.startX;
    const dy=event.clientY-videoViewerState.startY;
    if(Math.abs(dy)>Math.abs(dx)&&Math.abs(dy)>8){
        videoViewerState.swipeY=dy;
        videoViewerStage.style.transform=
            `translate3d(0,${dy}px,0) scale(${Math.max(.84,1-Math.abs(dy)/1000)})`;
        videoViewer.classList.add("is-swipe-dismissing");
        event.preventDefault();
    }
}

function videoViewerPointerEnd(event){
    videoViewerState.pointers.delete(event.pointerId);
    if(videoViewerState.pointers.size===0){
        const swipe=videoViewerState.swipeY;
        if(Math.abs(swipe)>120) videoViewerClose();
        else{
            videoViewer.classList.remove("is-swipe-dismissing");
            videoViewerStage.classList.add("is-animating");
            videoViewerStage.style.transform="translate3d(0,0,0) scale(1)";
            setTimeout(()=>videoViewerStage.classList.remove("is-animating"),220);
        }
        videoViewerState.swipeY=0;
    }
    event.preventDefault();
}

function videoViewerPointerCancel(event){
    videoViewerState.pointers.delete(event.pointerId);
    videoViewerState.swipeY=0;
    videoViewer.classList.remove("is-swipe-dismissing");
    videoViewerStage.classList.add("is-animating");
    videoViewerStage.style.transform="translate3d(0,0,0) scale(1)";
    setTimeout(()=>videoViewerStage.classList.remove("is-animating"),220);
}

/* Capture-phase delegation coexists with message long-press/pointer logic. */
document.addEventListener("pointerup",event=>{
    const video=event.target?.closest?.(".chat-video");
    if(!video||videoViewerState.open) return;

    const rect=video.getBoundingClientRect();
    const y=event.clientY-rect.top;

    /* Keep taps on native control areas inside the embedded player. */
    if(y>rect.height*.82||y<rect.height*.12) return;

    videoViewerOpen(video);
},true);

document.addEventListener("click",event=>{
    const video=event.target?.closest?.(".chat-video");
    if(!video||videoViewerState.open||event.target!==video) return;
    videoViewerOpen(video);
},true);

videoViewerStage?.addEventListener("pointerdown",videoViewerPointerDown,{passive:false});
videoViewerStage?.addEventListener("pointermove",videoViewerPointerMove,{passive:false});
videoViewerStage?.addEventListener("pointerup",videoViewerPointerEnd,{passive:false});
videoViewerStage?.addEventListener("pointercancel",videoViewerPointerCancel,{passive:false});

videoViewerPlay?.addEventListener("click",e=>{e.stopPropagation();videoViewerTogglePlay();});
videoViewerMute?.addEventListener("click",e=>{e.stopPropagation();videoViewerToggleMute();});
videoViewerFullscreen?.addEventListener("click",e=>{e.stopPropagation();void videoViewerToggleFullscreen();});
videoViewerSeek?.addEventListener("input",e=>{e.stopPropagation();videoViewerSeekFromRange();});
videoViewerCloseButton?.addEventListener("click",e=>{e.stopPropagation();videoViewerClose();});
videoViewer?.querySelector("[data-video-viewer-close='1']")?.addEventListener("click",videoViewerClose);

videoViewerVideo?.addEventListener("timeupdate",videoViewerUpdateTime);
videoViewerVideo?.addEventListener("loadedmetadata",videoViewerUpdateTime);
videoViewerVideo?.addEventListener("play",()=>{videoViewerUpdatePlayButton();videoViewerShowControls();});
videoViewerVideo?.addEventListener("pause",()=>{videoViewerUpdatePlayButton();videoViewerShowControls();});
videoViewerVideo?.addEventListener("ended",()=>{videoViewerUpdatePlayButton();videoViewerShowControls();});

document.addEventListener("keydown",event=>{
    if(!videoViewerState.open) return;
    if(event.key==="Escape"){event.preventDefault();videoViewerClose();return;}
    if(event.key===" "){event.preventDefault();videoViewerTogglePlay();return;}
    if(event.key==="ArrowLeft"){event.preventDefault();if(videoViewerVideo)videoViewerVideo.currentTime=Math.max(0,videoViewerVideo.currentTime-5);return;}
    if(event.key==="ArrowRight"){event.preventDefault();if(videoViewerVideo)videoViewerVideo.currentTime=Math.min(Number(videoViewerVideo.duration||0),videoViewerVideo.currentTime+5);}
});





function returnToMediaGalleryAfterViewer() {
    if (!window.__mediaGalleryViewerReturn) return;

    window.__mediaGalleryViewerReturn = false;

    if (chatMediaGallery && chatMediaGallery.classList.contains("is-open")) {
        // The gallery was intentionally kept underneath the viewer.
        // Leave its current tab/scroll position intact.
        chatMediaGallery.setAttribute("aria-hidden", "false");
        document.body.classList.add("chat-media-gallery-open");
    }
}


/* =========================================================
   LUCKY CHAT — VOICE CALL CLIENT V1
   WebRTC media + existing WebSocket signaling.
   ========================================================= */
const voiceCallBtn=document.getElementById("voiceCallBtn");
const voiceCallOverlay=document.getElementById("voiceCallOverlay");
const voiceCallCloseBtn=document.getElementById("voiceCallCloseBtn");
const voiceCallMainBtn=document.getElementById("voiceCallMainBtn");
const voiceCallMuteBtn=document.getElementById("voiceCallMuteBtn");
const voiceCallSpeakerBtn=document.getElementById("voiceCallSpeakerBtn");
const voiceCallStatus=document.getElementById("voiceCallStatus");
const voiceCallStatePill=document.getElementById("voiceCallStatePill");
const voiceCallTimer=document.getElementById("voiceCallTimer");
const voiceCallRemoteAudio=document.getElementById("voiceCallRemoteAudio");
const VOICE_CALL_ICE_SERVERS=[{urls:"stun:stun.l.google.com:19302"}];
let voiceCallPeer=null,voiceCallLocalStream=null,voiceCallRemoteStream=null,voiceCallId=null,voiceCallState="idle",voiceCallPendingOffer=null,voiceCallPendingCandidates=[],voiceCallTimerId=null,voiceCallStartedAt=0,voiceCallMuted=false,voiceCallStarting=false,voiceCallSpeakerLow=false;
let voiceCallRemoteTrackId=null;
let voiceCallQualityTimerId=null;
let voiceCallQualityLabel=null;
let voiceCallReconnectTimerId=null;
let voiceCallReconnectAttempts=0;
let voiceCallReconnectInProgress=false;
let voiceCallInboundDiagTimerId=null;

let voiceCallToneContext=null;
let voiceCallToneTimer=null;
let voiceCallToneKind="";

function voiceCallStopTone(){
    clearInterval(voiceCallToneTimer);
    voiceCallToneTimer=null;
    voiceCallToneKind="";
    try{voiceCallToneContext?.close()}catch(_){}
    voiceCallToneContext=null;
}

function voiceCallEnsureToneContext(){
    if(voiceCallToneContext) return voiceCallToneContext;
    const AudioContextClass=window.AudioContext||window.webkitAudioContext;
    if(!AudioContextClass) return null;

    try{
        voiceCallToneContext=new AudioContextClass();
        if(voiceCallToneContext.state==="suspended"){
            void voiceCallToneContext.resume().catch(()=>{});
        }
        return voiceCallToneContext;
    }catch(_){
        return null;
    }
}

function voiceCallToneBurst(f1,f2,durationMs){
    const ctx=voiceCallEnsureToneContext();
    if(!ctx) return;

    const now=ctx.currentTime;
    const gain=ctx.createGain();
    const osc1=ctx.createOscillator();
    const osc2=ctx.createOscillator();

    osc1.type="sine";
    osc2.type="sine";
    osc1.frequency.value=f1;
    osc2.frequency.value=f2;

    gain.gain.setValueAtTime(0.0001,now);
    gain.gain.exponentialRampToValueAtTime(0.045,now+0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001,now+durationMs/1000);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now+durationMs/1000+0.03);
    osc2.stop(now+durationMs/1000+0.03);
}

function voiceCallStartTone(kind){
    if(voiceCallToneKind===kind) return;

    voiceCallStopTone();
    voiceCallToneKind=kind;

    // Incoming: short repeating double-ring.
    // Outgoing: softer, slower ringback so it doesn't sound like an incoming call.
    const pattern=kind==="incoming"
        ? {on:520,off:700,f1:660,f2:880}
        : {on:720,off:1250,f1:440,f2:660};

    const play=()=>{
        if(voiceCallToneKind!==kind) return;
        voiceCallToneBurst(pattern.f1,pattern.f2,pattern.on);
    };

    play();
    voiceCallToneTimer=setInterval(play,pattern.on+pattern.off);
}


function voiceCallEnsureQualityLabel(){
    if(voiceCallQualityLabel && document.body.contains(voiceCallQualityLabel)){
        voiceCallQualityLabel.style.display="block";
        return voiceCallQualityLabel;
    }

    const anchor = voiceCallTimer || voiceCallStatus;
    if(!anchor || !anchor.parentElement) return null;

    voiceCallQualityLabel=document.createElement("div");
    voiceCallQualityLabel.className="voice-call-quality";
    voiceCallQualityLabel.textContent="● Checking";
    voiceCallQualityLabel.setAttribute("aria-live","polite");

    // Explicit inline layout prevents an existing stylesheet rule from
    // accidentally hiding the dynamically-created quality indicator.
    voiceCallQualityLabel.style.display="block";
    voiceCallQualityLabel.style.width="100%";
    voiceCallQualityLabel.style.marginTop="7px";
    voiceCallQualityLabel.style.minHeight="17px";
    voiceCallQualityLabel.style.textAlign="center";
    voiceCallQualityLabel.style.fontSize="11px";
    voiceCallQualityLabel.style.fontWeight="800";
    voiceCallQualityLabel.style.letterSpacing=".04em";
    voiceCallQualityLabel.style.lineHeight="17px";
    voiceCallQualityLabel.style.opacity="0.98";
    voiceCallQualityLabel.style.color="#93c5fd";
    voiceCallQualityLabel.style.pointerEvents="none";
    voiceCallQualityLabel.style.position="relative";
    voiceCallQualityLabel.style.zIndex="5";

    anchor.insertAdjacentElement("afterend",voiceCallQualityLabel);
    return voiceCallQualityLabel;
}

function voiceCallSetQuality(level){
    const label=voiceCallEnsureQualityLabel();
    if(!label) return;

    const names={
        excellent:"● Excellent",
        good:"● Good",
        poor:"● Poor",
        reconnecting:"↻ Reconnecting",
        unknown:"● Checking"
    };
    label.textContent=names[level]||names.unknown;
    label.dataset.quality=level;

    const colors={
        excellent:"#86efac",
        good:"#93c5fd",
        poor:"#fca5a5",
        reconnecting:"#fde68a",
        unknown:"#cbd5e1"
    };
    label.style.color=colors[level]||colors.unknown;
}

function voiceCallStopQualityMonitor(){
    clearInterval(voiceCallQualityTimerId);
    voiceCallQualityTimerId=null;
    voiceCallQualityLabel?.remove();
    voiceCallQualityLabel=null;
}

function voiceCallStartInboundDiagnostics(){
    clearInterval(voiceCallInboundDiagTimerId);
    voiceCallInboundDiagTimerId=setInterval(()=>{
        if(voiceCallState==="active"){
            void voiceCallLogInboundAudioDiagnostics("periodic");
        }else{
            clearInterval(voiceCallInboundDiagTimerId);
            voiceCallInboundDiagTimerId=null;
        }
    },5000);
}

function voiceCallStopInboundDiagnostics(){
    clearInterval(voiceCallInboundDiagTimerId);
    voiceCallInboundDiagTimerId=null;
}

function voiceCallStartQualityMonitor(){
    voiceCallStopQualityMonitor();
    voiceCallSetQuality("unknown");

    voiceCallQualityTimerId=setInterval(async()=>{
        const peer=voiceCallPeer;
        if(!peer || voiceCallState!=="active") return;

        try{
            const stats=await peer.getStats();
            let inbound=null;
            let candidatePair=null;

            stats.forEach(report=>{
                if(report.type==="inbound-rtp" && report.kind==="audio"){
                    inbound=report;
                }
                if(report.type==="candidate-pair" &&
                   (report.state==="succeeded" || report.nominated)){
                    candidatePair=report;
                }
            });

            let score=0;
            const jitter=Number(inbound?.jitter||0);
            const packetsLost=Number(inbound?.packetsLost||0);
            const packetsReceived=Number(inbound?.packetsReceived||0);
            const rtt=Number(
                candidatePair?.currentRoundTripTime ??
                candidatePair?.roundTripTime ??
                0
            )*1000;

            if(jitter>0.035 || rtt>220 || (packetsReceived>80 && packetsLost/(packetsReceived+packetsLost)>0.06)){
                score=2;
            }else if(jitter>0.018 || rtt>120 || (packetsReceived>40 && packetsLost/(packetsReceived+packetsLost)>0.025)){
                score=1;
            }

            voiceCallSetQuality(score===0?"excellent":score===1?"good":"poor");
        }catch(error){
            console.debug("VOICE QUALITY CHECK ERROR:",error);
        }
    },2500);
}

function voiceCallStopReconnect(){
    clearTimeout(voiceCallReconnectTimerId);
    voiceCallReconnectTimerId=null;
    voiceCallReconnectAttempts=0;
    voiceCallReconnectInProgress=false;
}

async function voiceCallRestartIce(){
    if(!voiceCallPeer || !voiceCallId || !voiceCallLocalStream || voiceCallState==="idle") return false;
    if(voiceCallReconnectInProgress) return false;
    if(voiceCallReconnectAttempts>=3) return false;

    voiceCallReconnectInProgress=true;
    voiceCallReconnectAttempts+=1;
    voiceCallSetQuality("reconnecting");
    voiceCallSetStatus("Reconnecting…","Reconnecting");

    try{
        const offer=await voiceCallPeer.createOffer({iceRestart:true});
        await voiceCallPeer.setLocalDescription(offer);

        if(!sendSocket({
            type:"call_offer",
            call_id:voiceCallId,
            target:friend,
            sdp:voiceCallPeer.localDescription,
            ice_restart:true
        })){
            throw new Error("Call signaling connection unavailable");
        }

        return true;
    }catch(error){
        console.warn("VOICE ICE RESTART FAILED:",error);
        return false;
    }finally{
        voiceCallReconnectInProgress=false;
    }
}

function voiceCallScheduleReconnect(){
    if(voiceCallState==="idle" || !voiceCallPeer) return;
    clearTimeout(voiceCallReconnectTimerId);

    voiceCallReconnectTimerId=setTimeout(async()=>{
        voiceCallReconnectTimerId=null;
        const ok=await voiceCallRestartIce();
        if(!ok && voiceCallReconnectAttempts>=3){
            voiceCallSetStatus("Connection lost","Ended");
            setTimeout(()=>voiceCallEnd(false),700);
        }else if(ok){
            voiceCallReconnectTimerId=setTimeout(()=>{
                if(voiceCallState==="active"){
                    voiceCallSetQuality("unknown");
                }
            },3500);
        }
    },1200);
}

function voiceCallSetStatus(s,p){
    if(voiceCallStatus) voiceCallStatus.textContent=s;
    if(voiceCallStatePill) voiceCallStatePill.textContent=p||"Voice call";
}
function voiceCallSetDetail(s){
    if(voiceCallStatus) voiceCallStatus.textContent=s;
}
function voiceCallFormatTimer(v){const t=Math.max(0,Math.floor(Number(v)||0)),m=Math.floor(t/60),s=String(t%60).padStart(2,"0");return `${String(m).padStart(2,"0")}:${s}`}
function voiceCallStartTimer(){voiceCallStopTimer();voiceCallStartedAt=Date.now();if(voiceCallTimer)voiceCallTimer.textContent="00:00";voiceCallTimerId=setInterval(()=>{if(voiceCallTimer&&voiceCallStartedAt)voiceCallTimer.textContent=voiceCallFormatTimer((Date.now()-voiceCallStartedAt)/1000)},500)}
function voiceCallStopTimer(){clearInterval(voiceCallTimerId);voiceCallTimerId=null;voiceCallStartedAt=0;if(voiceCallTimer)voiceCallTimer.textContent="00:00"}
function voiceCallOpen(mode){if(!voiceCallOverlay)return;voiceCallOverlay.classList.remove("is-closing","is-ringing");voiceCallOverlay.classList.add("is-open");if(mode==="incoming")voiceCallOverlay.classList.add("is-ringing");voiceCallOverlay.setAttribute("aria-hidden","false")}
function voiceCallCloseVisual(){voiceCallStopTone();if(!voiceCallOverlay)return;voiceCallOverlay.classList.remove("is-open","is-ringing");voiceCallOverlay.classList.add("is-closing");voiceCallOverlay.setAttribute("aria-hidden","true");setTimeout(()=>voiceCallOverlay?.classList.remove("is-closing"),220)}
function voiceCallResetControls(){
    voiceCallMuteBtn?.setAttribute("disabled","disabled");
    voiceCallSpeakerBtn?.setAttribute("disabled","disabled");
    voiceCallMuteBtn?.classList.remove("is-muted");
    voiceCallSpeakerBtn?.classList.remove("is-low");
    voiceCallMuted=false;
    voiceCallSpeakerLow=false;
    if(voiceCallMuteBtn)voiceCallMuteBtn.textContent="🎙️";
    if(voiceCallSpeakerBtn){
        voiceCallSpeakerBtn.textContent="🔊";
        voiceCallSpeakerBtn.setAttribute("aria-label","Reduce speaker volume");
    }
    if(voiceCallRemoteAudio){
        voiceCallRemoteAudio.volume=0.58;
        voiceCallRemoteAudio.muted=false;
    }
    if(voiceCallMainBtn){
        voiceCallMainBtn.classList.remove("is-end","is-accept","is-incoming");
        voiceCallMainBtn.textContent="📞";
        voiceCallMainBtn.disabled=false;
    }
}
function voiceCallConfigureOutgoing(){voiceCallState="outgoing";voiceCallOpen("outgoing");voiceCallSetStatus("Calling…","Calling");voiceCallResetControls();voiceCallStartTone("outgoing");if(voiceCallMainBtn){voiceCallMainBtn.classList.add("is-end");voiceCallMainBtn.textContent="📵"}}
function voiceCallConfigureIncoming(){voiceCallState="incoming";voiceCallOpen("incoming");voiceCallSetStatus("Incoming voice call","Incoming call");voiceCallResetControls();voiceCallStartTone("incoming");if(voiceCallMainBtn){voiceCallMainBtn.classList.add("is-accept","is-incoming");voiceCallMainBtn.textContent="📞"}}
function voiceCallConfigureActive(){
    voiceCallStopTone();
    voiceCallStopReconnect();
    voiceCallState="active";
    voiceCallOpen("active");

    const activeMicTrack=voiceCallLocalStream?.getAudioTracks?.()[0];
    if(activeMicTrack?.applyConstraints){
        void activeMicTrack.applyConstraints({
            echoCancellation:"remote-only",
            noiseSuppression:true,
            autoGainControl:false,
            channelCount:1
        }).catch(()=>{
            // Older browsers may only accept a boolean AEC value.
            return activeMicTrack.applyConstraints({
                echoCancellation:true,
                noiseSuppression:true,
                autoGainControl:false,
                channelCount:1
            }).catch(()=>{});
        });

        void activeMicTrack.applyConstraints({
            echoCancellationType:"system"
        }).catch(()=>{});
    }
voiceCallSetStatus("Voice call connected","Connected");voiceCallResetControls();if(voiceCallMainBtn){voiceCallMainBtn.classList.add("is-end");voiceCallMainBtn.textContent="📵"}if(voiceCallMuteBtn)voiceCallMuteBtn.disabled=false;if(voiceCallSpeakerBtn)voiceCallSpeakerBtn.disabled=false;voiceCallStartTimer();voiceCallStartQualityMonitor();voiceCallStartInboundDiagnostics();voiceCallSetQuality("unknown")}
function voiceCallNewId(){return window.crypto?.randomUUID?window.crypto.randomUUID():`${Date.now()}-${Math.random().toString(36).slice(2)}`}
async function voiceCallAttachLocalTracks(){
    if(!voiceCallPeer || !voiceCallLocalStream) return;

    for(const track of voiceCallLocalStream.getTracks()){
        // A sender may already own this exact track when a start/accept path
        // is re-entered. Never call addTrack for a track that is already sent.
        let senders = voiceCallPeer.getSenders();
        if(senders.some(sender => sender.track === track || (sender.track && sender.track.id === track.id))){
            continue;
        }

        // There should be only one audio sender. Reuse it instead of creating
        // another sender for the same media kind. Await the replacement so a
        // second call path cannot race this operation.
        let existingKindSender = senders.find(sender => sender.kind === track.kind);
        if(existingKindSender){
            if(typeof existingKindSender.replaceTrack === "function"){
                await existingKindSender.replaceTrack(track);
                continue;
            }

            console.warn("VOICE sender already exists; skipping duplicate addTrack.");
            continue;
        }

        try{
            voiceCallPeer.addTrack(track, voiceCallLocalStream);
        }catch(error){
            // Re-check after the exception because another call path may have
            // created the sender between getSenders() and addTrack().
            senders = voiceCallPeer.getSenders();
            const racedExactSender = senders.find(sender =>
                sender.track === track || (sender.track && sender.track.id === track.id)
            );
            const racedKindSender = senders.find(sender => sender.kind === track.kind);

            if(racedExactSender){
                continue;
            }
            if(racedKindSender && typeof racedKindSender.replaceTrack === "function"){
                await racedKindSender.replaceTrack(track);
                continue;
            }
            throw error;
        }
    }
}

function voiceCallEnsurePeer(){
    if(voiceCallPeer) return voiceCallPeer;

    voiceCallPeer = new RTCPeerConnection({
        iceServers: VOICE_CALL_ICE_SERVERS
    });

    voiceCallPeer.onicecandidate = event => {
        if(event.candidate && voiceCallId){
            sendSocket({
                type:"call_ice",
                call_id:voiceCallId,
                target:friend,
                candidate:event.candidate
            });
        }
    };

    voiceCallPeer.ontrack = event => {
        // This is an audio-only call. Ignore anything that is not an audio track.
        if(!event.track || event.track.kind !== "audio"){
            return;
        }

        const incomingTrackId = event.track.id;

        // The browser can deliver ontrack again during ICE restart /
        // renegotiation. Never start a second playback pipeline for the same
        // track, and do not restart the audio element when the track changes.
        if(voiceCallRemoteTrackId === incomingTrackId){
            if(voiceCallState !== "active"){
                voiceCallConfigureActive();
            }
            return;
        }

        const hadRemoteTrack = Boolean(voiceCallRemoteTrackId);
        const previousStream = voiceCallRemoteStream;

        voiceCallRemoteTrackId = incomingTrackId;

        if(!voiceCallRemoteStream){
            voiceCallRemoteStream = new MediaStream();
        }

        // Keep exactly one remote audio track in the playback stream.
        // Replace the old track in the existing MediaStream instead of
        // replacing audio.srcObject. Reassigning srcObject + calling play()
        // during renegotiation can replay a small buffered portion of speech
        // on some mobile Chromium/WebRTC combinations.
        for(const track of voiceCallRemoteStream.getAudioTracks()){
            if(track.id !== incomingTrackId){
                try{voiceCallRemoteStream.removeTrack(track)}catch(_){}
                try{track.stop()}catch(_){}
            }
        }

        if(!voiceCallRemoteStream.getAudioTracks().some(track => track.id === incomingTrackId)){
            voiceCallRemoteStream.addTrack(event.track);
        }

        if(voiceCallRemoteAudio){
            const currentVolume = voiceCallSpeakerLow ? 0.35 : 0.58;

            voiceCallRemoteAudio.volume = currentVolume;
            voiceCallRemoteAudio.muted = false;

            if(voiceCallRemoteAudio.srcObject !== voiceCallRemoteStream){
                voiceCallRemoteAudio.srcObject = voiceCallRemoteStream;
            }

            // Only start playback for the first remote track. For an
            // ICE-restart/replacement track, keep the existing playback
            // pipeline running so buffered audio is not replayed.
            if(!hadRemoteTrack || voiceCallRemoteAudio.paused){
                void voiceCallRemoteAudio.play().catch(() => {});
            }
        }

        event.track.onended = () => {
            if(voiceCallRemoteTrackId !== incomingTrackId){
                return;
            }

            // During a call, keep the playback object alive so a subsequent
            // renegotiation can replace the track without recreating audio.
            if(voiceCallState === "active"){
                return;
            }

            voiceCallRemoteTrackId = null;
        };

        if(previousStream && previousStream !== voiceCallRemoteStream){
            try{previousStream.getAudioTracks().forEach(track => track.stop())}catch(_){}
        }

        if(voiceCallState !== "active"){
            voiceCallConfigureActive();
        }

        void voiceCallLogInboundAudioDiagnostics("remote-track");
    };

    voiceCallPeer.onconnectionstatechange = () => {
        const state = voiceCallPeer?.connectionState;

        if(state === "connected"){
            voiceCallConfigureActive();
            void voiceCallLogInboundAudioDiagnostics("connection-connected");
            return;
        }

        if(state === "disconnected"){
            if(voiceCallState !== "idle"){
                voiceCallScheduleReconnect();
            }
            return;
        }

        if(state === "failed"){
            if(voiceCallState !== "idle"){
                voiceCallScheduleReconnect();
            }
            return;
        }

        if(state === "closed"){
            if(voiceCallState !== "idle"){
                voiceCallSetStatus("Call ended","Ended");
                setTimeout(() => voiceCallEnd(false), 350);
            }
        }
    };

    // Do not attach tracks here. The local stream is acquired immediately
    // before this helper is called, and attaching here plus again in
    // voiceCallGetLocalStream() can race and create a duplicate sender.
    return voiceCallPeer;
}


async function voiceCallLogInboundAudioDiagnostics(reason="unknown"){
    try{
        const peer=voiceCallPeer;
        if(!peer) return;

        const receivers=peer.getReceivers
            ? peer.getReceivers().filter(receiver =>
                receiver?.track?.kind === "audio"
            )
            : [];

        const audioTracks=receivers
            .map(receiver => receiver.track)
            .filter(Boolean);

        const uniqueTrackIds=[...new Set(audioTracks.map(track => track.id))];

        const report={
            reason,
            state:peer.connectionState,
            iceConnectionState:peer.iceConnectionState,
            receiverCount:receivers.length,
            audioReceiverCount:audioTracks.length,
            uniqueAudioTrackCount:uniqueTrackIds.length,
            audioTrackIds:uniqueTrackIds,
            remoteStreamTrackIds:voiceCallRemoteStream
                ? voiceCallRemoteStream.getAudioTracks().map(track => track.id)
                : [],
            remoteAudioElementHasStream:Boolean(
                voiceCallRemoteAudio?.srcObject
            )
        };

        if(peer.getStats){
            const stats=await peer.getStats();
            const inboundAudio=[];

            stats.forEach(stat=>{
                if(
                    stat.type==="inbound-rtp" &&
                    stat.kind==="audio"
                ){
                    inboundAudio.push({
                        ssrc:stat.ssrc,
                        packetsReceived:stat.packetsReceived,
                        packetsLost:stat.packetsLost,
                        jitter:stat.jitter,
                        bytesReceived:stat.bytesReceived,
                        trackIdentifier:stat.trackIdentifier || null,
                        streamIdentifiers:stat.streamIds || []
                    });
                }
            });

            report.inboundAudioStats=inboundAudio;
        }

        console.log("VOICE INBOUND AUDIO DIAGNOSTICS:",report);
    }catch(error){
        console.debug(
            "VOICE INBOUND AUDIO DIAGNOSTICS ERROR:",
            error
        );
    }
}

async function voiceCallLogAudioSettings(track){
    try{
        if(!track?.getSettings) return;
        const settings=track.getSettings();
        console.log("VOICE MIC SETTINGS:", {
            echoCancellation:settings.echoCancellation,
            noiseSuppression:settings.noiseSuppression,
            autoGainControl:settings.autoGainControl,
            channelCount:settings.channelCount,
            sampleRate:settings.sampleRate,
            latency:settings.latency
        });
    }catch(error){
        console.debug("VOICE MIC SETTINGS ERROR:",error);
    }
}

async function voiceCallGetLocalStream(){
    if(!voiceCallLocalStream){
        voiceCallLocalStream = await navigator.mediaDevices.getUserMedia({
            audio:{
                // Voice-call profile:
                // - remote-only AEC targets audio coming from the other peer.
                // - noise suppression removes steady phone/environment noise.
                // - AGC is disabled so noisy devices do not keep boosting
                //   the microphone and making the returned echo louder.
                echoCancellation:"remote-only",
                noiseSuppression:true,
                autoGainControl:false,
                channelCount:1
            },
            video:false
        });

        // Some Android browsers still negotiate weaker processing than the
        // getUserMedia request suggests. Apply the same constraints directly
        // to the live microphone track when the platform supports it.
        const micTrack=voiceCallLocalStream.getAudioTracks()[0];
        if(micTrack?.applyConstraints){
            try{
                const supported =
                    navigator.mediaDevices?.getSupportedConstraints?.() || {};

                const callAudioConstraints = {
                    noiseSuppression:true,
                    autoGainControl:false,
                    channelCount:1
                };

                // Use the remote-only AEC mode when the browser advertises
                // echo cancellation support; otherwise fall back to true.
                // The standard permits both boolean and string values for
                // echoCancellation on browsers that support specific modes.
                callAudioConstraints.echoCancellation =
                    supported.echoCancellation ? "remote-only" : true;

                await micTrack.applyConstraints(callAudioConstraints);
            }catch(error){
                console.debug("VOICE MIC CONSTRAINT FALLBACK:",error);
            }

            // Prefer the system acoustic echo canceller on devices that support it.
            try{
                await micTrack.applyConstraints({
                    echoCancellationType:"system"
                });
            }catch(_){}
        }
    }

    const diagnosticTrack=voiceCallLocalStream.getAudioTracks?.()[0];
    if(diagnosticTrack){
        void voiceCallLogAudioSettings(diagnosticTrack);
    }

    voiceCallEnsurePeer();
    await voiceCallAttachLocalTracks();
    return voiceCallLocalStream;
}
async function voiceCallStart(){
    if(voiceCallState!=="idle" || voiceCallStarting) return;
    if(!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection){
        alert("Voice calling is not supported by this browser.");
        return;
    }

    voiceCallStarting=true;

    try{
        // Create the call ID before the initial ping so the server can
        // persist the same call record from the first call event.
        voiceCallId=voiceCallNewId();

        if(!sendSocket({
            type:"call_ping",
            call_id:voiceCallId,
            target:friend
        })){
            connectSocket();
            voiceCallId=null;
            alert("Connecting to the chat server. Try the call again in a moment.");
            return;
        }

        voiceCallPendingCandidates=[];
        await voiceCallGetLocalStream();

        voiceCallConfigureOutgoing();

        const offer=await voiceCallPeer.createOffer();
        await voiceCallPeer.setLocalDescription(offer);

        sendSocket({
            type:"call_offer",
            call_id:voiceCallId,
            target:friend,
            sdp:voiceCallPeer.localDescription
        });
    }catch(e){
        console.error("VOICE CALL START ERROR:",e);
        voiceCallSetStatus(
            e?.message || "Could not start voice call.",
            "Call failed"
        );
        setTimeout(() => voiceCallEnd(true), 900);
    }finally{
        voiceCallStarting=false;
    }
}
async function voiceCallAccept(){
    if(voiceCallState!=="incoming" || !voiceCallPendingOffer || voiceCallStarting) return;
    voiceCallStarting=true;
    try{
        await voiceCallGetLocalStream();
        const p=voiceCallEnsurePeer();
        await p.setRemoteDescription(new RTCSessionDescription(voiceCallPendingOffer));
        for(const c of voiceCallPendingCandidates.splice(0)){
            try{await p.addIceCandidate(c)}catch(_){}
        }
        const answer=await p.createAnswer();
        await p.setLocalDescription(answer);
        sendSocket({type:"call_answer",call_id:voiceCallId,target:friend,sdp:p.localDescription});
        voiceCallSetStatus("Connecting…","Connecting");
        if(voiceCallMainBtn)voiceCallMainBtn.disabled=true;
    }catch(e){
        console.error("VOICE CALL ACCEPT ERROR:",e);
        voiceCallEnd(true);
    }finally{
        voiceCallStarting=false;
    }
}
async function voiceCallHandleOffer(data){
    if(!data.call_id||!data.sdp||data.sender===username)return;

    // A matching call_offer during an active call is an ICE-restart
    // renegotiation, not a second incoming call.
    if(data.call_id===voiceCallId && voiceCallPeer && voiceCallState!=="idle"){
        try{
            await voiceCallPeer.setRemoteDescription(new RTCSessionDescription(data.sdp));
            for(const c of voiceCallPendingCandidates.splice(0)){
                try{await voiceCallPeer.addIceCandidate(c)}catch(_){}
            }

            const answer=await voiceCallPeer.createAnswer();
            await voiceCallPeer.setLocalDescription(answer);

            sendSocket({
                type:"call_answer",
                call_id:voiceCallId,
                target:data.sender,
                sdp:voiceCallPeer.localDescription,
                ice_restart:true
            });

            voiceCallSetStatus("Voice call connected","Connected");
            voiceCallReconnectAttempts=0;
            voiceCallSetQuality("unknown");
        }catch(error){
            console.warn("VOICE ICE RESTART ANSWER ERROR:",error);
        }
        return;
    }

    if(voiceCallState!=="idle"){
        sendSocket({type:"call_busy",call_id:data.call_id,target:data.sender});
        return;
    }

    voiceCallId=data.call_id;
    voiceCallPendingOffer=data.sdp;
    voiceCallPendingCandidates=[];
    voiceCallConfigureIncoming();
}
async function voiceCallHandleAnswer(data){if(data.call_id!==voiceCallId||!voiceCallPeer||!data.sdp)return;try{await voiceCallPeer.setRemoteDescription(new RTCSessionDescription(data.sdp));for(const c of voiceCallPendingCandidates.splice(0)){try{await voiceCallPeer.addIceCandidate(c)}catch(_){} }voiceCallReconnectAttempts=0;if(voiceCallState==="outgoing")voiceCallSetStatus("Connecting…","Connecting");else if(voiceCallState==="active")voiceCallSetStatus("Voice call connected","Connected");}catch(e){console.error("VOICE ANSWER ERROR:",e);if(voiceCallState!=="idle")voiceCallScheduleReconnect()}}
async function voiceCallHandleIce(data){if(!data.candidate||data.call_id!==voiceCallId)return;if(!voiceCallPeer||!voiceCallPeer.remoteDescription){voiceCallPendingCandidates.push(data.candidate);return}try{await voiceCallPeer.addIceCandidate(data.candidate)}catch(_){}}
function voiceCallToggleMute(){if(!voiceCallLocalStream)return;voiceCallMuted=!voiceCallMuted;voiceCallLocalStream.getAudioTracks().forEach(t=>t.enabled=!voiceCallMuted);if(voiceCallMuteBtn){voiceCallMuteBtn.classList.toggle("is-muted",voiceCallMuted);voiceCallMuteBtn.textContent=voiceCallMuted?"🔇":"🎙️"}voiceCallSetDetail(voiceCallMuted?"Microphone muted":"Voice call connected")}
function voiceCallToggleSpeaker(){
    if(!voiceCallRemoteAudio) return;

    voiceCallSpeakerLow=!voiceCallSpeakerLow;
    voiceCallRemoteAudio.volume=voiceCallSpeakerLow ? 0.35 : 0.58;

    if(voiceCallSpeakerBtn){
        voiceCallSpeakerBtn.classList.toggle("is-low",voiceCallSpeakerLow);
        voiceCallSpeakerBtn.textContent=voiceCallSpeakerLow ? "🔉" : "🔊";
        voiceCallSpeakerBtn.setAttribute(
            "aria-label",
            voiceCallSpeakerLow ? "Restore speaker volume" : "Reduce speaker volume"
        );
    }

    voiceCallSetDetail(
        voiceCallSpeakerLow ? "Lower speaker volume" : "Voice call connected"
    );
}

function voiceCallEnd(sendSignal=true){voiceCallStopTone();voiceCallStopReconnect();voiceCallStopQualityMonitor();voiceCallStopInboundDiagnostics();const id=voiceCallId;if(sendSignal&&id&&voiceCallState!=="idle")sendSocket({type:"call_end",call_id:id,target:friend});voiceCallStarting=false;voiceCallLocalStream?.getTracks().forEach(t=>t.stop());try{voiceCallPeer?.close()}catch(_){}voiceCallPeer=null;voiceCallLocalStream=null;voiceCallRemoteStream=null;voiceCallRemoteTrackId=null;voiceCallPendingOffer=null;voiceCallPendingCandidates=[];voiceCallId=null;voiceCallState="idle";voiceCallMuted=false;voiceCallStopTimer();voiceCallResetControls();if(voiceCallRemoteAudio){
    try{voiceCallRemoteAudio.pause()}catch(_){}
    voiceCallRemoteAudio.srcObject=null;
    voiceCallRemoteAudio.volume=1;
voiceCallSpeakerLow=false;
}voiceCallCloseVisual()}
function voiceCallReject(){if(voiceCallId)sendSocket({type:"call_reject",call_id:voiceCallId,target:friend});voiceCallEnd(false)}
function voiceCallRemoteEnd(data){if(data.call_id!==voiceCallId)return;voiceCallSetStatus("Call ended","Ended");setTimeout(()=>voiceCallEnd(false),300)}
function voiceCallRemoteReject(data){if(data.call_id!==voiceCallId)return;voiceCallStopTone();voiceCallSetStatus("Call declined","Declined");setTimeout(()=>voiceCallEnd(false),500)}
function voiceCallRemoteBusy(data){if(data.call_id!==voiceCallId)return;voiceCallStopTone();voiceCallSetStatus("User is busy","Busy");setTimeout(()=>voiceCallEnd(false),500)}
function voiceCallRemoteUnavailable(data){if(data.call_id&&data.call_id!==voiceCallId)return;voiceCallStopTone();console.warn("VOICE CALL TARGET UNAVAILABLE:",data);voiceCallSetStatus("User is not connected to chat","Unavailable");setTimeout(()=>voiceCallEnd(false),800)}
voiceCallBtn?.addEventListener("click",()=>voiceCallState==="idle"?void voiceCallStart():voiceCallEnd(true));voiceCallMainBtn?.addEventListener("click",()=>{if(voiceCallState==="incoming")void voiceCallAccept();else if(voiceCallState==="outgoing"||voiceCallState==="active")voiceCallEnd(true);else void voiceCallStart()});voiceCallMuteBtn?.addEventListener("click",voiceCallToggleMute);voiceCallSpeakerBtn?.addEventListener("click",voiceCallToggleSpeaker);voiceCallCloseBtn?.addEventListener("click",()=>voiceCallState==="incoming"?voiceCallReject():voiceCallState!=="idle"?voiceCallEnd(true):voiceCallCloseVisual());window.LuckyVoiceCall={handleOffer:voiceCallHandleOffer,handleAnswer:voiceCallHandleAnswer,handleIce:voiceCallHandleIce,handleReject:voiceCallRemoteReject,handleBusy:voiceCallRemoteBusy,handleEnd:voiceCallRemoteEnd,handleUnavailable:voiceCallRemoteUnavailable};

/* =========================================================
   LUCKY CHAT — MEDIA GALLERY V1
   ========================================================= */
const chatMediaGallery=document.getElementById("chatMediaGallery");
const chatMediaGalleryGrid=document.getElementById("chatMediaGalleryGrid");
const chatMediaGalleryEmpty=document.getElementById("chatMediaGalleryEmpty");
const chatMediaGalleryCount=document.getElementById("chatMediaGalleryCount");
const chatMediaGalleryBtn=document.getElementById("chatMediaGalleryBtn");
const chatMediaGalleryCloseBtn=document.getElementById("chatMediaGalleryClose");
const chatMediaGalleryTabs=[...document.querySelectorAll("[data-media-gallery-tab]")];
let chatMediaGalleryFilter="all";

function chatMediaGalleryItems(){
  if(typeof messageMap==="undefined") return [];
  return Object.values(messageMap).filter(m=>m&&m.id!=null&&!deletedMessages[m.id]&&m.media_url&&["image","video","audio"].includes(m.media_type)).sort((a,b)=>Number(b.id)-Number(a.id));
}
function chatMediaGallerySafe(v){return typeof escapeHTML==="function"?escapeHTML(v||""):String(v||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]));}
function chatMediaGalleryDate(ts){const d=new Date(ts||0);return Number.isNaN(d.getTime())?"":d.toLocaleDateString([], {day:"2-digit",month:"short"});}
function chatMediaGalleryItem(m){
  const id=Number(m.id), sender=m.sender===username?"You":(m.sender||"Lucky Chat"), date=chatMediaGalleryDate(m.timestamp);
  if(m.media_type==="image") return `<button type="button" class="chat-media-gallery-item" data-gallery-id="${id}" data-gallery-kind="image"><img src="${chatMediaGallerySafe(m.media_url)}" alt="Photo" loading="lazy"><span class="chat-media-gallery-overlay"><b>${chatMediaGallerySafe(sender)}</b><small>${chatMediaGallerySafe(date)}</small></span></button>`;
  if(m.media_type==="video") return `<button type="button" class="chat-media-gallery-item" data-gallery-id="${id}" data-gallery-kind="video"><video src="${chatMediaGallerySafe(m.media_url)}" muted playsinline preload="metadata"></video><span class="chat-media-gallery-play">▶</span><span class="chat-media-gallery-overlay"><b>${chatMediaGallerySafe(sender)}</b><small>${chatMediaGallerySafe(date)}</small></span></button>`;
  const duration=Number(m.media_duration||0), label=(m.text||"").trim()||"Voice message";
  let waveform=[];
  try{
    waveform=typeof parseStoredWaveform==="function"?parseStoredWaveform(m.media_waveform):[];
  }catch(_){}
  if(!Array.isArray(waveform)||!waveform.length){
    waveform=[.18,.34,.62,.32,.75,.48,.24,.58,.82,.42,.68,.36,.76,.28,.54,.22];
  }
  const bars=waveform.slice(0,20).map(v=>Math.max(.12,Math.min(1,Number(v)||.12)));
  return `<div class="chat-media-gallery-item chat-media-gallery-audio" data-gallery-id="${id}" data-gallery-kind="audio">
    <div class="chat-media-gallery-audio-icon">🎙️</div>
    <div class="chat-media-gallery-audio-main">
      <div class="chat-media-gallery-audio-row">
        <button type="button" class="chat-media-gallery-audio-play" data-gallery-audio-play aria-label="Play voice message">▶</button>
        <div class="chat-media-gallery-audio-body">
          <div class="chat-media-gallery-audio-top">
            <b>${chatMediaGallerySafe(sender)}</b>
            <small>${duration>0?chatMediaGallerySafe(formatAudioTime(duration)):"Voice message"}</small>
          </div>
          <div class="chat-media-gallery-wave" aria-hidden="true">${bars.map((v,i)=>`<span data-wave-index="${i}" style="height:${Math.round(6+v*18)}px"></span>`).join("")}</div>
          <div class="chat-media-gallery-audio-caption">${chatMediaGallerySafe(label)}</div>
        </div>
      </div>
    </div>
    <audio class="chat-media-gallery-audio-player" data-gallery-audio="1" src="${chatMediaGallerySafe(m.media_url)}" preload="metadata"></audio>
  </div>`;
}
function chatMediaGalleryBindAudio(){
  if(!chatMediaGalleryGrid) return;
  chatMediaGalleryGrid.querySelectorAll("[data-gallery-audio-play]").forEach(button=>{
    if(button.dataset.bound==="1") return;
    button.dataset.bound="1";
    button.addEventListener("click",e=>{
      e.preventDefault();
      e.stopPropagation();
      const card=button.closest(".chat-media-gallery-audio");
      const audio=card?.querySelector("audio[data-gallery-audio='1']");
      if(!audio) return;

      chatMediaGalleryGrid.querySelectorAll("audio[data-gallery-audio='1']").forEach(other=>{
        if(other!==audio&&!other.paused){
          other.pause();
          const otherBtn=other.closest(".chat-media-gallery-audio")?.querySelector("[data-gallery-audio-play]");
          if(otherBtn) otherBtn.textContent="▶";
        }
      });

      if(audio.paused){
        audio.play().catch(()=>{});
        button.textContent="⏸";
      }else{
        audio.pause();
        button.textContent="▶";
      }
    });
  });

  chatMediaGalleryGrid.querySelectorAll("audio[data-gallery-audio='1']").forEach(audio=>{
    if(audio.dataset.bound==="1") return;
    audio.dataset.bound="1";
    audio.addEventListener("ended",()=>{
      const btn=audio.closest(".chat-media-gallery-audio")?.querySelector("[data-gallery-audio-play]");
      if(btn) btn.textContent="▶";
    });
    audio.addEventListener("pause",()=>{
      if(!audio.ended){
        const btn=audio.closest(".chat-media-gallery-audio")?.querySelector("[data-gallery-audio-play]");
        if(btn) btn.textContent="▶";
      }
    });
  });
}

function chatMediaGalleryRender(){
  if(!chatMediaGalleryGrid) return;

  const all=chatMediaGalleryItems();
  const counts={
    all:all.length,
    image:all.filter(m=>m.media_type==="image").length,
    video:all.filter(m=>m.media_type==="video").length,
    audio:all.filter(m=>m.media_type==="audio").length
  };

  const items=chatMediaGalleryFilter==="all"
    ? all
    : all.filter(m=>m.media_type===chatMediaGalleryFilter);

  if(chatMediaGalleryCount){
    chatMediaGalleryCount.textContent=`${items.length} ${items.length===1?"item":"items"} shared`;
  }

  chatMediaGalleryTabs.forEach(t=>{
    const key=t.dataset.mediaGalleryTab||"all";
    const active=key===chatMediaGalleryFilter;
    t.classList.toggle("is-active",active);
    t.setAttribute("aria-selected",active?"true":"false");
    const badge=t.querySelector("[data-gallery-tab-count]");
    if(badge) badge.textContent=String(counts[key]||0);
  });

  const mediaItems=items.filter(m=>m.media_type==="image"||m.media_type==="video");
  const voiceItems=items.filter(m=>m.media_type==="audio");

  if(chatMediaGalleryFilter==="all" && mediaItems.length){
    const featured=mediaItems[0];
    const restMedia=mediaItems.slice(1);
    const featuredMarkup=chatMediaGalleryItem(featured);
    const mediaMarkup=restMedia.map(chatMediaGalleryItem).join("");
    const voiceMarkup=voiceItems.map(chatMediaGalleryItem).join("");

    chatMediaGalleryGrid.innerHTML=
      `<div class="chat-media-gallery-section-label chat-media-gallery-section-label-featured"><span>Latest media</span><em>${mediaItems.length}</em></div>`+
      `<div class="chat-media-gallery-featured" data-gallery-featured="1">${featuredMarkup}<span class="chat-media-gallery-featured-badge">Latest</span></div>`+
      (restMedia.length
        ? `<div class="chat-media-gallery-section-label"><span>More media</span><em>${restMedia.length}</em></div>`+
          `<div class="chat-media-gallery-media-grid">${mediaMarkup}</div>`
        : "")+
      (voiceItems.length
        ? `<div class="chat-media-gallery-section-label chat-media-gallery-section-label-voice"><span>Voice messages</span><em>${voiceItems.length}</em></div>`+
          `<div class="chat-media-gallery-voice-list">${voiceMarkup}</div>`
        : "");
  }else if(chatMediaGalleryFilter==="audio"){
    chatMediaGalleryGrid.innerHTML=
      `<div class="chat-media-gallery-section-label"><span>Voice messages</span><em>${voiceItems.length}</em></div>`+
      `<div class="chat-media-gallery-voice-list">${items.map(chatMediaGalleryItem).join("")}</div>`;
  }else{
    const kindLabel=chatMediaGalleryFilter==="image"?"Photos":"Videos";
    const kindIcon=chatMediaGalleryFilter==="image"?"🖼️":"🎬";
    chatMediaGalleryGrid.innerHTML=
      `<div class="chat-media-gallery-section-label"><span>${kindIcon} ${kindLabel}</span><em>${items.length}</em></div>`+
      `<div class="chat-media-gallery-media-grid">${items.map(chatMediaGalleryItem).join("")}</div>`;
  }

  chatMediaGalleryGrid.scrollTop=0;
  chatMediaGalleryEmpty.style.display=items.length?"none":"flex";
  chatMediaGalleryBindAudio();
}
function chatMediaGalleryOpen(){if(!chatMediaGallery)return;chatMediaGalleryFilter="all";chatMediaGalleryRender();chatMediaGallery.classList.remove("is-closing");chatMediaGallery.classList.add("is-open");chatMediaGallery.setAttribute("aria-hidden","false");document.body.classList.add("chat-media-gallery-open");}
function chatMediaGalleryClose(){if(!chatMediaGallery)return;chatMediaGallery.classList.add("is-closing");chatMediaGallery.setAttribute("aria-hidden","true");setTimeout(()=>{chatMediaGallery.classList.remove("is-open","is-closing");document.body.classList.remove("chat-media-gallery-open");},220);}
chatMediaGalleryBtn?.addEventListener("click",chatMediaGalleryOpen);
chatMediaGalleryCloseBtn?.addEventListener("click",chatMediaGalleryClose);
chatMediaGallery?.querySelector("[data-media-gallery-close='1']")?.addEventListener("click",chatMediaGalleryClose);
chatMediaGalleryTabs.forEach(t=>t.addEventListener("click",()=>{chatMediaGalleryFilter=t.dataset.mediaGalleryTab||"all";chatMediaGalleryRender();}));
chatMediaGalleryGrid?.addEventListener("click",e=>{const item=e.target.closest?.("[data-gallery-id]");if(!item)return;const m=messageMap[Number(item.dataset.galleryId)];if(!m)return;if(m.media_type==="image"&&typeof openPhotoViewer==="function"){window.__mediaGalleryViewerReturn=true;setTimeout(()=>{const i=new Image();i.src=m.media_url;i.dataset.photoUrl=m.media_url;openPhotoViewer(i);},40);}else if(m.media_type==="video"&&typeof videoViewerOpen==="function"){window.__mediaGalleryViewerReturn=true;setTimeout(()=>{const v=document.createElement("video");v.src=m.media_url;v.dataset.videoUrl=m.media_url;videoViewerOpen(v);},40);}});
document.addEventListener("keydown",e=>{if((photoViewerState?.open||videoViewerState?.open))return;if(chatMediaGallery?.classList.contains("is-open")&&e.key==="Escape")chatMediaGalleryClose();});
