/* =========================================================
   LUCKY CHAT — DASHBOARD CORE
   Dashboard behavior moved out of dashboard.html.
   Existing application logic is preserved.
   ========================================================= */

let dashboardSocket = null;
let reconnectTimer = null;
let dashboardPageUnloading = false;
let dashboardSessionExpired = false;
let dashboardWsBackoffMs = 1000;
let onlineUsersTimer = null;
let dashboardPingTimer = null;
let dashboardRefreshTimer = null;
let statusShelfTimer = null;
const DASHBOARD_WS_MAX_BACKOFF_MS = 15000;
const DASHBOARD_ONLINE_POLL_MS = 15000;

function isDashboardAuthFailure(status){
    return status === 401 || status === 403;
}

function stopDashboardRealtime(){
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearInterval(onlineUsersTimer);
    clearInterval(dashboardPingTimer);
    clearInterval(dashboardRefreshTimer);
    clearInterval(statusShelfTimer);
    onlineUsersTimer = null;
    dashboardPingTimer = null;
    dashboardRefreshTimer = null;
    statusShelfTimer = null;
    if (dashboardSocket) {
        try { dashboardSocket.close(); } catch (_error) {}
    }
}

function handleDashboardAuthFailure(status){
    if (!isDashboardAuthFailure(status)) return false;
    if (dashboardSessionExpired) return true;
    dashboardSessionExpired = true;
    dashboardPageUnloading = true;
    stopDashboardRealtime();
    console.warn("Lucky Chat session expired (HTTP " + status + "). Background refresh stopped.");
    return true;
}

async function updateOnlineUsers(){
    if (dashboardSessionExpired || document.hidden) return;

    try {
        const res = await fetch("/online", {
            credentials: "same-origin",
            cache: "no-store"
        });

        if (handleDashboardAuthFailure(res.status)) return;
        if (!res.ok) return;

        const users = await res.json().catch(() => null);
        const list = Array.isArray(users)
            ? users
            : (Array.isArray(users?.users) ? users.users : null);
        if (!list) return;

        const onlineNames = new Set();
        list.forEach(user => {
            const name = typeof user === "string" ? user : (user?.username || user?.user || "");
            if (name) onlineNames.add(String(name));
        });

        document.querySelectorAll("[id^='status-']").forEach(el => {
            const name = el.id.slice("status-".length);
            const nextText = onlineNames.has(name) ? "🟢 Online" : "⚪ Offline";
            if (el.textContent !== nextText) el.textContent = nextText;
        });
    } catch (error) {
        console.debug("Online users refresh failed:", error);
    }
}

function openChat(friend){
    window.location.href="/chat/"+encodeURIComponent(friend);
}

function openSettings(){
    window.location.href="/settings";
}


let loadedStatuses = [];
let statusViewerStatuses = [];
let currentStatus = null;
let currentStatusIndex = -1;
let statusPreviewUrl = null;
let statusComposerSelectionId = 0;
let statusProgressTimer = null;
let statusAgeRefreshTimer = null;
let statusProgressStartedAt = 0;
let statusProgressElapsed = 0;
let statusPaused = false;
const STATUS_VIEW_DURATION = 6500;
let statusTouchStartX = 0;
let statusTouchStartY = 0;
const STATUS_PRIVACY_KEY = "lucky_status_privacy_v30";
const STATUS_SEEN_KEY = "lucky_status_seen_ids";
const STATUS_LIKES_KEY = "lucky_status_liked_ids";
const STATUS_REACTION_STATE_KEY = "lucky_status_reaction_state_v1";
const STATUS_EMOJI_REACTIONS_KEY = "lucky_status_emoji_reactions_v1";
const STATUS_EMOJI_REACTIONS = ["👍","😂","😮","😢","😡","🙏","🎉","🔥"];
const STATUS_VIEWERS_KEY = "lucky_status_viewers_by_id_v1";
const STATUS_LIKERS_KEY = "lucky_status_likers_by_id_v1";
const STATUS_REPLIES_KEY = "lucky_status_replies_by_id_v1";
const CURRENT_DASHBOARD_USER = String(
    document.querySelector('meta[name="lucky-chat-username"]')?.content || ""
).trim();
const STATUS_LIKES_VERSION = 2;
const STATUS_VISIBILITY_OPTIONS = [
    {id:"contacts", label:"My contacts"},
    {id:"close", label:"Close friends"},
    {id:"except", label:"My contacts except…"}
];
let statusVisibilityIndex = 0;
let statusAudienceDraft = [];
let statusAudienceMode = "contacts";

function resetStatusPreviewSizing(){
    const modal = document.getElementById("statusCreateModal");
    if (!modal) return;
    modal.style.removeProperty("--status-preview-frame-height");
    modal.style.removeProperty("--status-preview-backdrop");
}

function sizeStatusPreview(preview, attempt=0){
    const modal = document.getElementById("statusCreateModal");
    const wrap = document.getElementById("statusPreviewWrap");
    const frame = preview?.closest?.(".st15-preview-frame");
    if (!modal || !wrap || !frame || !preview || !preview.naturalWidth || !preview.naturalHeight) return;

    const measuredWidth = frame.clientWidth || wrap.clientWidth;
    if (!measuredWidth && attempt < 8) {
        requestAnimationFrame(() => sizeStatusPreview(preview, attempt + 1));
        return;
    }

    const ratio = preview.naturalWidth / preview.naturalHeight;
    const availableWidth = Math.max(220, measuredWidth || 320);
    const mobile = window.matchMedia("(max-width: 899px)").matches;
    const maxViewport = window.innerHeight || 720;
    const maxHeight = mobile ? Math.min(maxViewport * 0.62, 560) : Math.min(maxViewport * 0.68, 680);
    const minHeight = mobile ? 240 : 280;

    let frameHeight = availableWidth / ratio;
    frameHeight = Math.max(minHeight, Math.min(frameHeight, maxHeight));

    modal.style.setProperty("--status-preview-frame-height", `${Math.round(frameHeight)}px`);
    const src = preview.currentSrc || preview.src || "";
    if (src && !src.startsWith("data:")) {
        modal.style.setProperty("--status-preview-backdrop", `url("${src.replace(/"/g, '\\"')}")`);
    } else if (src) {
        modal.style.setProperty("--status-preview-backdrop", `url("${src}")`);
    }
}

window.addEventListener("resize", () => {
    const preview = document.getElementById("statusPreview");
    if (preview && preview.naturalWidth > 0) sizeStatusPreview(preview);
});

function createStatus(){
    const modal = document.getElementById("statusCreateModal");
    if (!modal) return;

    const fileInput = document.getElementById("statusFile");
    const textInput = document.getElementById("statusText");
    const message = document.getElementById("statusFormMessage");
    const previewWrap = document.getElementById("statusPreviewWrap");
    const preview = document.getElementById("statusPreview");
    const label = document.getElementById("statusFileLabel");

    if (fileInput) fileInput.value = "";
    if (textInput) textInput.value = "";
    updateStatusCaptionCount();
    resetStatusComposerTheme();
    if (message) message.textContent = "";
    previewWrap?.classList.remove("show","has-image");
    preview?.removeAttribute("src");
    const fallback = document.getElementById("st15PreviewFallback");
    if (fallback) fallback.style.display = "grid";
    const state = document.getElementById("st15PreviewState");
    if (state) state.textContent = "Waiting for photo";
    if (label) label.textContent = "Choose photo";

    statusPreviewUrl = null;
    resetStatusPreviewSizing();
    statusComposerSelectionId++;
    modal.classList.remove("has-selection");
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    document.getElementById("statusDraftStrip")?.classList.remove("show");
    syncStatusPrivacySwitches();
    syncStatusComposerPreview();
}

function closeStatusCreate(){
    const modal = document.getElementById("statusCreateModal");
    if (!modal) return;
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    document.getElementById("statusDraftStrip")?.classList.remove("show");
}

function stopStatusProgress(){
    if (statusProgressTimer) {
        clearInterval(statusProgressTimer);
        statusProgressTimer = null;
    }
}

function closeStatusViewer(){
    closeStatusMenu();
    closeStatusSheets();
    closeStatusReactionPicker(false);
    stopStatusProgress();

    // The age-refresh timer belongs to the viewer lifecycle. Stop it as
    // soon as the viewer closes so it cannot run forever in the background.
    if (statusAgeRefreshTimer) {
        clearInterval(statusAgeRefreshTimer);
        statusAgeRefreshTimer = null;
    }

    const modal = document.getElementById("statusViewerModal");
    if (modal) {
        modal.classList.remove("open");
        modal.setAttribute("aria-hidden", "true");
    }

    currentStatus = null;
    currentStatusIndex = -1;
    statusPaused = false;
    statusProgressElapsed = 0;
    document.getElementById("statusViewerCard")?.classList.remove("status-holding");

    const stage = document.getElementById("statusStage30");
    if (stage) stage.style.removeProperty("--status-stage-image");
}

function setStatusMessage(text, error=false){
    const el = document.getElementById("statusFormMessage");
    el.textContent = text || "";
    el.style.color = error ? "#fca5a5" : "#94a3b8";
}

document.addEventListener("DOMContentLoaded", () => {
    const fileInput = document.getElementById("statusFile");
    const viewerCard = document.getElementById("statusViewerCard");

    if (fileInput) {
        fileInput.addEventListener("change", async () => {
            const selectionId = ++statusComposerSelectionId;
            const file = fileInput.files && fileInput.files[0];

            const previewWrap = document.getElementById("statusPreviewWrap");
            const preview = document.getElementById("statusPreview");
            const label = document.getElementById("statusFileLabel");
            const draftStrip = document.getElementById("statusDraftStrip");
            const draftThumb = document.getElementById("statusDraftThumb");
            const fallback = document.getElementById("st15PreviewFallback");
            const state = document.getElementById("st15PreviewState");
            const createModal = document.getElementById("statusCreateModal");

            // Invalidate every older preview immediately.
            preview.onload = null;
            preview.onerror = null;
            preview.removeAttribute("src");
            previewWrap.classList.remove("show", "has-image");
            if (createModal) createModal.classList.remove("has-selection");
            if (draftStrip) draftStrip.classList.remove("show");
            syncStatusComposerPreview();

            if (draftThumb) {
                draftThumb.removeAttribute("src");
                draftThumb.alt = "Selected photo";
            }

            label.textContent = "Choose photo";
            if (state) state.textContent = "Waiting for photo";
            if (fallback) {
                fallback.style.removeProperty("display");
                const title = fallback.querySelector("b");
                if (title) title.textContent = "Your photo will appear here";
            }
            statusPreviewUrl = null;
            resetStatusPreviewSizing();

            if (!file) return;

            if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
                fileInput.value = "";
                setStatusMessage("Please choose a PNG, JPEG or WebP image.", true);
                return;
            }

            if (file.size > 25 * 1024 * 1024) {
                fileInput.value = "";
                setStatusMessage("That image is larger than 25 MB.", true);
                return;
            }

            const reader = new FileReader();

            reader.onerror = () => {
                if (selectionId !== statusComposerSelectionId) return;
                if (state) state.textContent = "Preview unavailable";
                setStatusMessage("Could not read that photo.", true);
            };

            reader.onload = () => {
                if (selectionId !== statusComposerSelectionId) return;

                const dataUrl = String(reader.result || "");
                if (!dataUrl.startsWith("data:image/")) {
                    if (state) state.textContent = "Preview unavailable";
                    setStatusMessage("The selected photo could not be previewed.", true);
                    return;
                }

                statusPreviewUrl = dataUrl;

                // The draft thumbnail and large preview receive the exact same
                // data URL, eliminating source drift between the two.
                if (draftThumb) {
                    draftThumb.src = dataUrl;
                    draftThumb.alt = file.name;
                }

                // Show the preview container immediately, before image decode.
                previewWrap.classList.add("show", "has-image");
                if (createModal) createModal.classList.add("has-selection");
                if (draftStrip) draftStrip.classList.add("show");
                syncStatusComposerPreview();

                label.textContent = file.name;
                if (state) state.textContent = "Preview ready";
                setStatusMessage("");

                preview.onload = () => {
                    if (selectionId !== statusComposerSelectionId) return;
                    previewWrap.classList.add("show", "has-image");
                    sizeStatusPreview(preview);
                    requestAnimationFrame(() => sizeStatusPreview(preview));
                    if (state) state.textContent = "Preview ready";
                };

                preview.onerror = () => {
                    if (selectionId !== statusComposerSelectionId) return;
                    previewWrap.classList.remove("has-image");
                    resetStatusPreviewSizing();
                    if (state) state.textContent = "Preview unavailable";
                    if (fallback) {
                        fallback.style.removeProperty("display");
                        const title = fallback.querySelector("b");
                        if (title) title.textContent = "Preview unavailable";
                    }
                    setStatusMessage("The selected photo could not be rendered.", true);
                };

                preview.src = dataUrl;

                // Cached/data URL images may already be complete immediately.
                if (preview.complete && preview.naturalWidth > 0) {
                    previewWrap.classList.add("show", "has-image");
                    sizeStatusPreview(preview);
                }
            };

            reader.readAsDataURL(file);
        });
    }

    const heartButton = document.getElementById("statusHeartButton");
    if (heartButton) {
        heartButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
            reactToStatus(event);
        }, true);
    }

    if (viewerCard) {
        viewerCard.addEventListener("touchstart", event => {
            const touch = event.changedTouches[0];
            statusTouchStartX = touch.clientX;
            statusTouchStartY = touch.clientY;
        }, {passive:true});

        viewerCard.addEventListener("touchend", event => {
            const touch = event.changedTouches[0];
            const dx = touch.clientX - statusTouchStartX;
            const dy = touch.clientY - statusTouchStartY;
            if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy)) {
                showAdjacentStatus(dx > 0 ? -1 : 1);
            } else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) {
                closeStatusViewer();
            } else if (dy < -90 && Math.abs(dy) > Math.abs(dx)) {
                if (currentStatus?.is_mine) openStatusViewersSheet();
                else replyToStatus();
            }
        }, {passive:true});

        viewerCard.addEventListener("click", event => {
            if (event.target.closest("button,.status-viewer-bottom,.status-viewer-head,.status-sheet,.status-action-menu")) return;
            const rect = viewerCard.getBoundingClientRect();
            const x = event.clientX - rect.left;
            if (x < rect.width * .34) showAdjacentStatus(-1);
            else if (x > rect.width * .66) showAdjacentStatus(1);
        });
    }

    // Reference-style hold to pause / release to resume.
    let holdTimer = null;
    let holdTriggered = false;
    let lastStatusTapAt = 0;

    const pauseStatus = () => {
        if (!statusPaused) {
            statusProgressElapsed += Math.max(0, performance.now() - statusProgressStartedAt);
        }
        statusPaused = true;
        viewerCard.classList.add("status-holding");
    };
    const resumeStatus = () => {
        if (statusPaused) statusProgressStartedAt = performance.now();
        statusPaused = false;
        viewerCard.classList.remove("status-holding");
    };

    viewerCard.addEventListener("pointerdown", event => {
        if (event.target.closest("button,.status-viewer-bottom,.status-viewer-head,.status-sheet,.status-action-menu")) return;
        holdTriggered = false;
        clearTimeout(holdTimer);
        holdTimer = setTimeout(() => {
            holdTriggered = true;
            pauseStatus();
            toggleStatusMenu();
        }, 380);
    });
    ["pointerup","pointercancel","pointerleave"].forEach(type => {
        viewerCard.addEventListener(type, () => {
            clearTimeout(holdTimer);
            if (holdTriggered) resumeStatus();
        });
    });
    viewerCard.addEventListener("dblclick", event => {
        if (event.target.closest("button,.status-viewer-bottom,.status-viewer-head,.status-sheet")) return;
        if (currentStatus && !currentStatus.is_mine) reactToStatus(true);
    });
    viewerCard.addEventListener("click", event => {
        if (event.target.closest("button,.status-viewer-bottom,.status-viewer-head,.status-sheet,.status-action-menu")) return;
        const now = Date.now();
        if (now - lastStatusTapAt < 300) return;
        lastStatusTapAt = now;
    });

    document.addEventListener("click", event => {
        const picker = document.getElementById("statusReactionPicker");
        const reactionButton = document.getElementById("statusReactionButton");
        if (
            picker &&
            !picker.hidden &&
            !picker.contains(event.target) &&
            !reactionButton?.contains(event.target)
        ) {
            closeStatusReactionPicker(true);
        }

        const menu = document.getElementById("statusActionMenu");
        const more = document.getElementById("statusMoreButton");
        if (!menu || menu.hidden) return;
        if (Date.now() - statusMenuOpenedAt < 280) return;
        if (!menu.contains(event.target) && !more?.contains(event.target)) {
            closeStatusMenu();
        }
    });

    document.addEventListener("keydown", event => {
        const createModal = document.getElementById("statusCreateModal");
        if (createModal?.classList.contains("open") && event.key === "Escape") {
            closeStatusCreate();
            return;
        }

        const visibilitySheet = document.getElementById("statusVisibilitySheet");
        if (visibilitySheet && !visibilitySheet.hidden && event.key === "Escape") {
            closeStatusVisibilitySheet();
            return;
        }

        const modal = document.getElementById("statusViewerModal");
        if (!modal?.classList.contains("open")) return;
        if (event.target.closest("input, textarea, select, [contenteditable='true']")) {
            if (event.key === "Escape") event.target.blur();
            return;
        }

        if (event.key === "Escape") {
            const anySheet = document.querySelector(".status-sheet.open");
            const menu = document.getElementById("statusActionMenu");
            if (anySheet) closeStatusSheets();
            else if (menu && !menu.hidden) closeStatusMenu();
            else closeStatusViewer();
            return;
        }
        if (event.key === "ArrowLeft") {
            showAdjacentStatus(-1);
            return;
        }
        if (event.key === "ArrowRight") {
            showAdjacentStatus(1);
            return;
        }
        if (event.code === "Space") {
            event.preventDefault();
            if (statusPaused) {
                statusPaused = false;
                document.getElementById("statusViewerCard")?.classList.remove("status-holding");
                statusProgressStartedAt = performance.now();
            } else {
                if (statusProgressStartedAt) {
                    statusProgressElapsed += Math.max(0, performance.now() - statusProgressStartedAt);
                }
                statusPaused = true;
                document.getElementById("statusViewerCard")?.classList.add("status-holding");
            }
        }
    });

    const replyBox = document.getElementById("statusReplyText");
    if (replyBox) {
        replyBox.addEventListener("keydown", event => {
            event.stopPropagation();
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendStatusPrivateReply();
            }
        });
        replyBox.addEventListener("pointerdown", event => event.stopPropagation());
        replyBox.addEventListener("click", event => event.stopPropagation());
        replyBox.addEventListener("focus", () => {
            document.getElementById("statusViewerCard")?.classList.add("reply-focused");
            if (!statusPaused) {
                statusProgressElapsed += Math.max(0, performance.now() - statusProgressStartedAt);
                statusPaused = true;
                document.getElementById("statusViewerCard")?.classList.add("status-holding");
            }
        });
        replyBox.addEventListener("blur", () => {
            const card = document.getElementById("statusViewerCard");
            card?.classList.remove("reply-focused");
            if (statusPaused && !card?.classList.contains("sheet-open") && !card?.classList.contains("menu-open")) {
                statusProgressStartedAt = performance.now();
                statusPaused = false;
                card?.classList.remove("status-holding");
            }
        });
    }

    const replyForm = document.getElementById("statusInlineReplyForm");
    if (replyForm) {
        replyForm.addEventListener("pointerdown", event => event.stopPropagation());
        replyForm.addEventListener("click", event => event.stopPropagation());
        replyForm.addEventListener("submit", event => {
            event.preventDefault();
            event.stopPropagation();
            sendStatusPrivateReply();
        });
    }
    document.getElementById("statusReplySendBtn")?.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        sendStatusPrivateReply();
    });

    requestAnimationFrame(() => {
        setTimeout(() => { void loadStatuses(); }, 0);
    });
    syncStatusPrivacySwitches();
    if (getStatusPrivacy().blockScreenshots) {
        document.body.classList.add("status-block-shots");
    }
});


function getMutedStatusUsers(){
    try{
        const value = JSON.parse(localStorage.getItem("lucky_status_muted_users") || "[]");
        return Array.isArray(value) ? value : [];
    }catch(_error){
        return [];
    }
}

function isStatusMuted(username){
    return !!username && getMutedStatusUsers().includes(String(username));
}

function updateStatusMuteButton(){
    const button = document.getElementById("statusMuteMenuBtn");
    if (!button) return;
    const label = button.querySelector("span:last-child");
    const username = currentStatus?.username || "";
    if (label) label.textContent = isStatusMuted(username)
        ? `Unmute updates from ${username || "this user"}`
        : `Mute updates${username ? " from " + username : ""}`;
}

let statusMenuOpenedAt = 0;

function closeStatusMenu(){
    const menu = document.getElementById("statusActionMenu");
    const card = document.getElementById("statusViewerCard");
    if (menu) {
        menu.hidden = true;
        menu.setAttribute("hidden", "");
    }
    card?.classList.remove("menu-open");
}

function toggleStatusMenu(event){
    event?.preventDefault?.();
    event?.stopPropagation?.();
    closeStatusSheets();
    const menu = document.getElementById("statusActionMenu");
    const card = document.getElementById("statusViewerCard");
    if (!menu) return;
    const willOpen = menu.hasAttribute("hidden") || menu.hidden;
    if (willOpen) {
        menu.hidden = false;
        menu.removeAttribute("hidden");
        statusMenuOpenedAt = Date.now();
        updateStatusMuteButton();
    } else {
        menu.hidden = true;
        menu.setAttribute("hidden", "");
    }
    card?.classList.toggle("menu-open", willOpen);
}

function toggleMuteCurrentStatus(){
    if (!currentStatus || currentStatus.is_mine || !currentStatus.username) return;
    const username = String(currentStatus.username);
    const muted = getMutedStatusUsers();
    const index = muted.indexOf(username);
    if (index >= 0) muted.splice(index,1);
    else muted.push(username);
    localStorage.setItem("lucky_status_muted_users", JSON.stringify(muted));
    updateStatusMuteButton();
    closeStatusMenu();
    renderStatuses();
    showStatusToast(index >= 0
        ? `Unmuted updates from ${username}`
        : `Muted updates from ${username}`);
}

function statusOwnerUsername(status){
    return String(status?.username || status?.user || status?.owner || "").trim();
}

function resolveStatusChatUsername(status){
    const direct = statusOwnerUsername(status);
    const pretty = String(status?.display_name || status?.name || "").trim();
    const contacts = collectDashboardContacts();
    const match = contacts.find(contact =>
        contact.username === direct ||
        contact.name === direct ||
        (pretty && (contact.username === pretty || contact.name === pretty))
    );
    return (match && match.username) || direct;
}

function getStatusReplyText(){
    const inline = document.getElementById("statusReplyText");
    const sheet = document.getElementById("statusReplySheetText");
    return String(inline?.value || sheet?.value || "").trim();
}

function replyToStatus(event){
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (!currentStatus || currentStatus.is_mine) return;
    const input = document.getElementById("statusReplyText");
    if (input) {
        input.focus();
        try { input.setSelectionRange(input.value.length, input.value.length); } catch (_error) {}
        return;
    }
    openStatusReplySheet();
}

function getStatusReactionId(status){
    if (!status) return "";
    if (status.id != null && String(status.id).trim() !== "") return String(status.id);
    const owner = status.username || status.user || "status";
    const stamp = status.created_at || status.time || "";
    return owner + ":" + stamp;
}

function reactToStatus(eventOrFromDoubleTap){
    // The heart must be a self-contained control. Never let the viewer's
    // navigation/gesture layer consume the same tap.
    const isEvent = eventOrFromDoubleTap && typeof eventOrFromDoubleTap === "object" && eventOrFromDoubleTap.stopPropagation;
    const fromDoubleTap = !isEvent && !!eventOrFromDoubleTap;
    const event = isEvent ? eventOrFromDoubleTap : null;

    if (event) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    }

    const status = currentStatus;
    const button = document.getElementById("statusHeartButton");
    if (!button) return false;
    if (!status || status.is_mine) return false;

    const id = getStatusReactionId(status);
    if (!id) return false;

    const wasLiked = button.classList.contains("liked");
    // Double-tap is always a like; a deliberate heart tap toggles.
    const nextLiked = fromDoubleTap ? true : !wasLiked;

    paintStatusHeart(button, nextLiked);
    rememberStatusLike(id, nextLiked);
    rememberLocalStatusLiker(status.id || id, {
        username: CURRENT_DASHBOARD_USER,
        display_name: CURRENT_DASHBOARD_USER,
        seen_at: Date.now()
    }, nextLiked);
    void recordStatusLike(status, nextLiked);

    try {
        document.dispatchEvent(new CustomEvent("lucky:status-reaction", {
            detail: { statusId: id, liked: nextLiked, status }
        }));
    } catch (_error) {}

    if (nextLiked) {
        button.classList.remove("pop");
        void button.offsetWidth;
        button.classList.add("pop");

        const burst = document.getElementById("statusLikeBurst");
        if (burst) {
            burst.classList.remove("show");
            void burst.offsetWidth;
            burst.classList.add("show");
        }
        showStatusToast("Liked");
    } else {
        button.classList.remove("pop");
        showStatusToast("Like removed");
    }

    return true;
}

function paintStatusHeart(button, liked){
    if (!button) return;
    button.classList.toggle("liked", !!liked);
    button.setAttribute("aria-pressed", liked ? "true" : "false");
    button.setAttribute("aria-label", liked ? "Unlike status" : "Like status");
    button.setAttribute("title", liked ? "Unlike status" : "Like status");
}

function getStatusEmojiReactionStorageKey(){
    const username = String(CURRENT_DASHBOARD_USER || "").trim() || "anonymous";
    return `${STATUS_EMOJI_REACTIONS_KEY}:v1:${username}`;
}

function getStatusEmojiReactionMap(){
    try {
        const raw = JSON.parse(localStorage.getItem(getStatusEmojiReactionStorageKey()) || "{}");
        return raw && typeof raw === "object" ? raw : {};
    } catch (_error) {
        return {};
    }
}

function getStoredStatusEmojiReaction(statusId){
    if (statusId == null) return "";
    const value = getStatusEmojiReactionMap()[String(statusId)];
    return STATUS_EMOJI_REACTIONS.includes(value) ? value : "";
}

function saveStoredStatusEmojiReaction(statusId, reaction){
    if (statusId == null) return;
    const map = getStatusEmojiReactionMap();
    const key = String(statusId);
    if (reaction) map[key] = reaction;
    else delete map[key];
    const entries = Object.entries(map);
    const trimmed = entries.length > 300 ? entries.slice(-300) : entries;
    try {
        localStorage.setItem(
            getStatusEmojiReactionStorageKey(),
            JSON.stringify(Object.fromEntries(trimmed))
        );
    } catch (_error) {}
}

function paintStatusEmojiReaction(reaction){
    const button = document.getElementById("statusReactionButton");
    const emoji = document.getElementById("statusReactionButtonEmoji");
    if (!button || !emoji) return;
    const value = STATUS_EMOJI_REACTIONS.includes(reaction) ? reaction : "";
    emoji.textContent = value || "😊";
    button.classList.toggle("selected", !!value);
    button.setAttribute("aria-label", value ? `Reacted ${value}` : "React to status");
    button.setAttribute("title", value ? `Current reaction ${value}` : "React to status");
    const picker = document.getElementById("statusReactionPicker");
    picker?.querySelectorAll("[data-status-reaction]").forEach(item => {
        item.classList.toggle("selected", item.getAttribute("data-status-reaction") === value);
        item.setAttribute("aria-pressed", item.getAttribute("data-status-reaction") === value ? "true" : "false");
    });
}

function closeStatusReactionPicker(resumeViewer=false){
    const picker = document.getElementById("statusReactionPicker");
    if (!picker) return;
    picker.hidden = true;
    picker.setAttribute("aria-hidden", "true");
    document.getElementById("statusViewerCard")?.classList.remove("status-reaction-open");

    if (
        resumeViewer &&
        statusPaused &&
        currentStatus &&
        !document.querySelector(".status-sheet.open") &&
        !(document.getElementById("statusActionMenu")?.hidden === false)
    ) {
        statusProgressStartedAt = performance.now();
        statusPaused = false;
        document.getElementById("statusViewerCard")?.classList.remove("status-holding");
    }
}

function openStatusReactionPicker(event){
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const status = currentStatus;
    const picker = document.getElementById("statusReactionPicker");
    if (!picker || !status || status.is_mine) return;
    const willOpen = picker.hidden !== false;
    if (willOpen) {
        closeStatusMenu();
        closeStatusSheets();
        picker.hidden = false;
        picker.removeAttribute("hidden");
        picker.setAttribute("aria-hidden", "false");
        document.getElementById("statusViewerCard")?.classList.add("status-reaction-open");
        paintStatusEmojiReaction(getStoredStatusEmojiReaction(status.id));
        if (!statusPaused && statusProgressStartedAt) {
            statusProgressElapsed += Math.max(0, performance.now() - statusProgressStartedAt);
            statusPaused = true;
            document.getElementById("statusViewerCard")?.classList.add("status-holding");
        }
    } else {
        closeStatusReactionPicker(true);
    }
}

let statusReactionSending = false;

async function recordStatusReaction(status, reaction){
    if (!status?.id || status.is_mine) return {success:false};
    try {
        const res = await fetch(
            "/statuses/" + encodeURIComponent(status.id) + "/reaction",
            {
                method: "POST",
                credentials: "same-origin",
                cache: "no-store",
                headers: {"Content-Type":"application/json"},
                body: JSON.stringify({reaction: reaction || ""})
            }
        );
        if (!res.ok) return {success:false};
        const data = await res.json();
        return data && data.success === true ? data : {success:false};
    } catch (error) {
        console.error("STATUS REACTION ERROR:", error);
        return {success:false};
    }
}

async function syncStatusEmojiReactionFromServer(status){
    if (!status?.id || status.is_mine) return;
    try {
        const id = encodeURIComponent(status.id);
        const res = await fetch(
            "/statuses/" + id + "/reaction",
            {credentials:"same-origin", cache:"no-store"}
        );
        if (!res.ok) return;
        const data = await res.json();
        if (!data?.success) return;
        if (!currentStatus || getStatusReactionId(currentStatus) !== getStatusReactionId(status)) return;
        const reaction = STATUS_EMOJI_REACTIONS.includes(data.reaction) ? data.reaction : "";
        saveStoredStatusEmojiReaction(status.id, reaction);
        paintStatusEmojiReaction(reaction);
    } catch (error) {
        console.debug("Status reaction state refresh failed:", error);
    }
}

async function selectStatusReaction(reaction, event){
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (statusReactionSending) return;
    if (!currentStatus || currentStatus.is_mine) return;
    const value = STATUS_EMOJI_REACTIONS.includes(reaction) ? reaction : "";
    if (!value) return;

    const status = currentStatus;
    const previous = getStoredStatusEmojiReaction(status.id);
    const next = previous === value ? "" : value;

    statusReactionSending = true;
    saveStoredStatusEmojiReaction(status.id, next);
    paintStatusEmojiReaction(next);
    closeStatusReactionPicker(true);

    const result = await recordStatusReaction(status, next);
    if (!result.success) {
        saveStoredStatusEmojiReaction(status.id, previous);
        paintStatusEmojiReaction(previous);
        showStatusToast("Could not save reaction", true);
    } else {
        const serverReaction = STATUS_EMOJI_REACTIONS.includes(result.reaction) ? result.reaction : "";
        saveStoredStatusEmojiReaction(status.id, serverReaction);
        paintStatusEmojiReaction(serverReaction);
        showStatusToast(serverReaction ? `Reacted ${serverReaction}` : "Reaction removed");
    }

    statusReactionSending = false;
}

function showStatusToast(message, error){
    const host = document.getElementById("statusToastHost");
    if (!host || !message) return;
    const toast = document.createElement("div");
    toast.className = "status-toast" + (error ? " error" : "");
    toast.textContent = message;
    host.appendChild(toast);
    setTimeout(() => toast.remove(), 2400);
}

function getStatusPrivacyStorageKey(){
    const username = String(CURRENT_DASHBOARD_USER || "").trim() || "anonymous";
    return `${STATUS_PRIVACY_KEY}:v1:${username}`;
}

function getStatusPrivacy(){
    try{
        const key = getStatusPrivacyStorageKey();
        const scopedRaw = localStorage.getItem(key);
        const value = JSON.parse(scopedRaw || "{}");
        const rawAudience = Array.isArray(value.audience_users) ? value.audience_users : [];
        const audience_users = [...new Set(rawAudience.map(item => String(item || "").trim()).filter(Boolean))];
        return {
            hideViewed: !!value.hideViewed,
            blockScreenshots: !!value.blockScreenshots,
            visibility: value.visibility || "contacts",
            audience_users
        };
    }catch(_error){
        return {hideViewed:false, blockScreenshots:false, visibility:"contacts", audience_users:[]};
    }
}

function saveStatusPrivacy(next){
    const normalized = {
        hideViewed: !!next.hideViewed,
        blockScreenshots: !!next.blockScreenshots,
        visibility: String(next.visibility || "contacts"),
        audience_users: Array.isArray(next.audience_users)
            ? [...new Set(next.audience_users.map(item => String(item || "").trim()).filter(Boolean))]
            : []
    };
    localStorage.setItem(getStatusPrivacyStorageKey(), JSON.stringify(normalized));
}

function getStatusVisibilitySummary(privacy){
    const mode = String(privacy?.visibility || "contacts");
    const count = Array.isArray(privacy?.audience_users) ? privacy.audience_users.length : 0;
    if (mode === "close") return count ? `Close friends (${count})` : "Close friends";
    if (mode === "except") return count ? `My contacts except (${count})` : "My contacts except…";
    return "My contacts";
}

function syncStatusPrivacySwitches(){
    const privacy = getStatusPrivacy();
    document.getElementById("statusHideViewedSwitch")?.classList.toggle("on", privacy.hideViewed);
    document.getElementById("statusBlockShotsSwitch")?.classList.toggle("on", privacy.blockScreenshots);
    const visIndex = STATUS_VISIBILITY_OPTIONS.findIndex(item => item.id === privacy.visibility);
    statusVisibilityIndex = visIndex >= 0 ? visIndex : 0;
    const label = document.getElementById("statusVisibilityLabel");
    if (label) label.textContent = getStatusVisibilitySummary(privacy);
    syncStatusComposerPreview();
}

function toggleStatusPrivacy(key){
    const privacy = getStatusPrivacy();
    privacy[key] = !privacy[key];
    saveStatusPrivacy(privacy);
    syncStatusPrivacySwitches();
    if (key === "hideViewed") {
        renderStatuses();
        showStatusToast(privacy.hideViewed ? "Viewed updates will hide from the shelf." : "Viewed updates stay on the shelf.");
    }
    if (key === "blockScreenshots") {
        document.body.classList.toggle("status-block-shots", privacy.blockScreenshots);
        showStatusToast(privacy.blockScreenshots ? "Screenshot protection is on for this device." : "Screenshot protection is off.");
    }
}

function renderStatusAudiencePicker(){
    const sheet = document.getElementById("statusVisibilitySheet");
    const list = document.getElementById("statusAudienceUsers");
    const hint = document.getElementById("statusAudiencePickerHint");
    if (!sheet || !list) return;

    const mode = statusAudienceMode;
    const showPeople = mode !== "contacts";
    list.hidden = !showPeople;
    if (hint) {
        hint.textContent = mode === "close"
            ? "Choose who can see this status."
            : mode === "except"
                ? "Choose people who should not see this status."
                : "Everyone in your Lucky Chat people list can see it.";
    }

    const contacts = collectDashboardContacts();
    if (!showPeople) {
        list.innerHTML = "";
        return;
    }

    if (!contacts.length) {
        list.innerHTML = '<div class="status-sheet-empty">No other users are available yet.</div>';
        return;
    }

    const selected = new Set(statusAudienceDraft.map(value => String(value).trim().toLowerCase()));
    list.innerHTML = contacts.map(contact => {
        const username = String(contact.username || "").trim();
        const checked = selected.has(username.toLowerCase());
        return `
            <button class="status-sheet-row status-audience-user ${checked ? "selected" : ""}" type="button" data-username="${escapeHtml(username)}">
                <img src="${escapeHtml(contact.avatar || "/static/profile/default.png")}" alt="" onerror="this.src='/static/profile/default.png'">
                <div class="status-audience-user-copy">
                    <strong>${escapeHtml(contact.name || username)}</strong>
                    <span>${escapeHtml(username)}</span>
                </div>
                <span class="status-audience-check" aria-hidden="true">${checked ? "✓" : ""}</span>
            </button>`;
    }).join("");

    list.querySelectorAll(".status-audience-user").forEach(button => {
        button.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            const username = String(button.dataset.username || "").trim();
            if (!username) return;
            const key = username.toLowerCase();
            const next = statusAudienceDraft.filter(item => String(item).trim().toLowerCase() !== key);
            if (next.length === statusAudienceDraft.length) next.push(username);
            statusAudienceDraft = next;
            renderStatusAudiencePicker();
        });
    });

    const modeButtons = sheet.querySelectorAll("[data-visibility-mode]");
    modeButtons.forEach(button => {
        button.classList.toggle("active", button.dataset.visibilityMode === mode);
        button.setAttribute("aria-pressed", button.dataset.visibilityMode === mode ? "true" : "false");
    });
}

function selectStatusVisibilityMode(mode){
    if (!STATUS_VISIBILITY_OPTIONS.some(item => item.id === mode)) return;
    statusAudienceMode = mode;
    if (mode === "contacts") statusAudienceDraft = [];
    renderStatusAudiencePicker();
}

function openStatusVisibilitySheet(){
    const sheet = document.getElementById("statusVisibilitySheet");
    if (!sheet) return;
    const privacy = getStatusPrivacy();
    statusAudienceMode = privacy.visibility || "contacts";
    statusAudienceDraft = Array.isArray(privacy.audience_users) ? [...privacy.audience_users] : [];
    renderStatusAudiencePicker();
    sheet.hidden = false;
    sheet.setAttribute("aria-hidden", "false");
}

function closeStatusVisibilitySheet(){
    const sheet = document.getElementById("statusVisibilitySheet");
    if (!sheet) return;
    sheet.hidden = true;
    sheet.setAttribute("aria-hidden", "true");
}

function saveStatusVisibilityChoice(){
    const mode = statusAudienceMode;
    if (mode === "close" && !statusAudienceDraft.length) {
        showStatusToast("Choose at least one close friend.", true);
        return;
    }

    const privacy = getStatusPrivacy();
    privacy.visibility = mode;
    privacy.audience_users = mode === "contacts" ? [] : [...statusAudienceDraft];
    saveStatusPrivacy(privacy);
    syncStatusPrivacySwitches();
    closeStatusVisibilitySheet();
    setStatusMessage("Status visibility: " + getStatusVisibilitySummary(privacy) + ".");
}

function cycleStatusVisibility(){
    // Kept under the existing onclick contract; the old cycling behavior only
    // changed localStorage and never enforced privacy. Now it opens the real
    // audience picker while preserving the existing button/ID.
    openStatusVisibilitySheet();
}

function getSeenStatusIds(){
    try{
        const value = JSON.parse(localStorage.getItem(STATUS_SEEN_KEY) || "[]");
        return Array.isArray(value) ? value.map(String) : [];
    }catch(_error){
        return [];
    }
}

function markStatusSeen(id){
    if (id == null) return;
    const seen = getSeenStatusIds();
    const key = String(id);
    if (!seen.includes(key)) {
        seen.push(key);
        localStorage.setItem(STATUS_SEEN_KEY, JSON.stringify(seen.slice(-200)));
    }
}

function getStatusLikeStorageKey(){
    // localStorage is shared by accounts in the same browser. Scope likes to
    // the signed-in username so one account never inherits another account's
    // heart state.
    const username = String("{{ username }}").trim() || "anonymous";
    return `${STATUS_LIKES_KEY}:v${STATUS_LIKES_VERSION}:${username}`;
}

function getLikedStatusIds(){
    try{
        const value = JSON.parse(localStorage.getItem(getStatusLikeStorageKey()) || "[]");
        return Array.isArray(value) ? value.map(String) : [];
    }catch(_error){
        return [];
    }
}

function getStatusReactionStateMap(){
    try {
        const raw = JSON.parse(localStorage.getItem(`${STATUS_REACTION_STATE_KEY}:v1:${String("{{ username }}").trim() || "anonymous"}`) || "{}");
        return raw && typeof raw === "object" ? raw : {};
    } catch (_error) {
        return {};
    }
}

function getStoredStatusReaction(id){
    if (id == null) return null;
    const key = String(id);
    const map = getStatusReactionStateMap();
    if (Object.prototype.hasOwnProperty.call(map, key) && typeof map[key] === "boolean") {
        return map[key];
    }
    // Migrate the older positive-only cache without changing its behavior.
    return getLikedStatusIds().includes(key) ? true : null;
}

function rememberStatusReaction(id, liked){
    if (id == null) return;
    const key = String(id);
    const map = getStatusReactionStateMap();
    map[key] = !!liked;
    const entries = Object.entries(map);
    if (entries.length > 300) {
        const trimmed = entries.slice(-300);
        localStorage.setItem(`${STATUS_REACTION_STATE_KEY}:v1:${String("{{ username }}").trim() || "anonymous"}`, JSON.stringify(Object.fromEntries(trimmed)));
    } else {
        localStorage.setItem(`${STATUS_REACTION_STATE_KEY}:v1:${String("{{ username }}").trim() || "anonymous"}`, JSON.stringify(map));
    }
}

function rememberStatusLike(id, liked){
    if (id == null) return;
    rememberStatusReaction(id, liked);
    const key = String(id);
    const likes = getLikedStatusIds().filter(item => item !== key);
    if (liked) likes.push(key);
    try {
        localStorage.setItem(getStatusLikeStorageKey(), JSON.stringify(likes.slice(-200)));
    } catch (_error) {}
}

function closeStatusSheets(){
    ["statusReplySheet","statusForwardSheet","statusViewersSheet"].forEach(id => {
        const sheet = document.getElementById(id);
        if (!sheet) return;
        sheet.classList.remove("open");
        sheet.setAttribute("aria-hidden","true");
    });
    document.getElementById("statusViewerCard")?.classList.remove("sheet-open");
    if (statusPaused) {
        statusProgressStartedAt = performance.now();
        statusPaused = false;
        document.getElementById("statusViewerCard")?.classList.remove("status-holding");
    }
}

function openStatusSheet(id){
    closeStatusMenu();
    closeStatusSheets();
    const sheet = document.getElementById(id);
    if (!sheet) return;
    sheet.classList.add("open");
    sheet.setAttribute("aria-hidden","false");
    document.getElementById("statusViewerCard")?.classList.add("sheet-open");
    if (!statusPaused) {
        statusProgressElapsed += Math.max(0, performance.now() - statusProgressStartedAt);
        statusPaused = true;
        document.getElementById("statusViewerCard")?.classList.add("status-holding");
    }
}

function collectDashboardContacts(){
    return [...document.querySelectorAll(".chat-list .chat-item")].map(item => {
        const name = item.querySelector("h4")?.textContent?.replace("📌","").trim();
        const preview = item.querySelector(".message-preview")?.textContent?.trim() || "";
        const avatar = item.querySelector("img.avatar")?.getAttribute("src") || "/static/profile/default.png";
        const dataUsername = item.getAttribute("data-username") || "";
        const onclick = item.getAttribute("onclick") || "";
        const match = onclick.match(/openChat\('([^']+)'\)/);
        const username = dataUsername || (match ? match[1] : name);
        return name && username ? {name, username, preview, avatar} : null;
    }).filter(Boolean);
}

function openStatusReplySheet(){
    if (!currentStatus || currentStatus.is_mine || !statusOwnerUsername(currentStatus)) return;
    const hint = document.getElementById("statusReplySheetHint");
    if (hint) hint.textContent = `Only ${statusOwnerName(currentStatus)} will see this reply`;
    const inline = document.getElementById("statusReplyText");
    const sheetInput = document.getElementById("statusReplySheetText");
    if (sheetInput && inline && !sheetInput.value) sheetInput.value = inline.value;
    openStatusSheet("statusReplySheet");
    setTimeout(() => (sheetInput || inline)?.focus(), 50);
}

function statusOwnerName(status){
    return String(status?.display_name || status?.username || "this person").trim() || "this person";
}

function stashOutgoingChatDraft(payload){
    try{
        sessionStorage.setItem("lucky_outgoing_chat_message", JSON.stringify(payload));
        localStorage.setItem("lucky_outgoing_chat_message", JSON.stringify(payload));
        if (payload.kind === "status-reply") {
            sessionStorage.setItem("lucky_status_reply_draft", JSON.stringify(payload));
        }
        if (payload.kind === "status-forward") {
            sessionStorage.setItem("lucky_status_forward_draft", JSON.stringify(payload));
        }
    }catch(_error){}
}

async function encryptOutgoingChatText(text, friend){
    const plain = String(text || "");
    const recipient = String(friend || "").trim();
    const sender = String(CURRENT_DASHBOARD_USER || "").trim();
    if (!plain || !recipient || !sender) return plain;

    try {
        if (await ensureDashboardCrypto() && typeof LuckyCrypto.encryptMessage === "function") {
            // crypto.core.js requires all three arguments: plaintext, recipient, sender.
            // The dashboard previously omitted the sender, which caused Status replies
            // to fail encryption and appear as "Could not send reply".
            const encrypted = await LuckyCrypto.encryptMessage(
                plain,
                recipient,
                sender
            );
            if (encrypted && String(encrypted).startsWith("LCE")) {
                return String(encrypted);
            }
        }
    } catch (error) {
        console.error("DASHBOARD MESSAGE ENCRYPTION ERROR:", error);
    }

    return plain;
}

function getDashboardCsrfToken(){
    const meta = document.querySelector('meta[name="csrf-token"], meta[name="csrf_token"]');
    if (meta?.content) return meta.content;
    const match = document.cookie.match(/(?:^|; )(?:csrf_token|csrftoken|csrf)=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : "";
}

function jsonLooksLikeSent(data){
    if (!data || typeof data !== "object") return false;
    if (data.success === false || data.ok === false || data.error) return false;
    if (data.success === true || data.ok === true || data.sent === true) return true;
    if (data.id || data.message_id || data.messageId) return true;
    return false;
}

async function postChatMessage({ username, text, mediaUrl, kind }){
    const friend = String(username || "").trim();
    if (!friend) return false;

    const messageText = String(text || "").trim();
    if (!messageText && !mediaUrl) return false;

    const encryptedText = await encryptOutgoingChatText(messageText, friend);
    const csrf = getDashboardCsrfToken();
    const payload = {
        receiver: friend,
        friend,
        to: friend,
        username: friend,
        text: encryptedText,
        message: encryptedText,
        content: encryptedText,
        media_url: mediaUrl || "",
        media: mediaUrl || "",
        media_type: mediaUrl ? "image" : "",
        type: "text",
        source: "status"
    };
    if (csrf) payload.csrf_token = csrf;

    const encodedFriend = encodeURIComponent(friend);
    const attempts = [
        { url: "/send-message", mode: "json" },
        { url: "/send_message", mode: "json" },
        { url: "/send-message", mode: "form" },
        { url: "/send_message", mode: "form" },
        { url: "/send", mode: "form" },
        { url: "/chat/" + encodedFriend + "/send", mode: "json" }
    ];

    for (const attempt of attempts) {
        try {
            const headers = { "Accept": "application/json" };
            if (csrf) headers["X-CSRFToken"] = csrf;
            let body;
            if (attempt.mode === "json") {
                headers["Content-Type"] = "application/json";
                body = JSON.stringify(payload);
            } else {
                body = new URLSearchParams();
                Object.entries(payload).forEach(([key, value]) => body.append(key, value == null ? "" : String(value)));
                headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
            }
            const res = await fetch(attempt.url, {
                method: "POST",
                credentials: "same-origin",
                headers,
                body
            });
            if (!res.ok) continue;
            const contentType = res.headers.get("content-type") || "";
            if (!contentType.includes("application/json")) continue;
            const data = await res.json().catch(() => ({}));
            if (jsonLooksLikeSent(data)) return true;
        } catch (_error) {}
    }
    return false;
}

function storePendingChatSend(friend, text){
    const payload = {
        to: friend,
        username: friend,
        friend,
        text,
        message: text,
        autosend: true,
        kind: "text",
        source: "status",
        createdAt: Date.now()
    };
    const raw = JSON.stringify(payload);
    [
        "lucky_outgoing_chat_message",
        "lucky_status_reply_draft",
        "lucky_autosend_chat",
        "pendingChatMessage",
        "autoSendMessage"
    ].forEach(key => {
        try { sessionStorage.setItem(key, raw); } catch (_error) {}
        try { localStorage.setItem(key, raw); } catch (_error) {}
    });
    return payload;
}

function sendViaLiveChatPage(friend, text){
    return new Promise(resolve => {
        const iframe = document.createElement("iframe");
        iframe.setAttribute("aria-hidden", "true");
        iframe.style.cssText = "position:fixed;left:-9999px;top:0;width:320px;height:560px;opacity:0;border:0;pointer-events:none;";
        let finished = false;
        const finish = ok => {
            if (finished) return;
            finished = true;
            setTimeout(() => iframe.remove(), 500);
            resolve(!!ok);
        };
        const watchdog = setTimeout(() => finish(false), 9000);

        iframe.onload = () => {
            setTimeout(() => {
                try {
                    const win = iframe.contentWindow;
                    const doc = iframe.contentDocument;
                    if (!win || !doc) return finish(false);

                    const skip = el => {
                        const hint = `${el.id} ${el.className} ${el.name || ""} ${el.placeholder || ""}`.toLowerCase();
                        return /search|password|file|email/.test(hint);
                    };
                    const boxes = [...doc.querySelectorAll("textarea, input[type='text'], input:not([type])")]
                        .filter(el => !el.disabled && !skip(el));
                    const input = boxes.find(el => /message|msg|chat|compose|reply|input/.test(`${el.id} ${el.className} ${el.placeholder || ""}`.toLowerCase()))
                        || boxes[boxes.length - 1];
                    if (input) {
                        input.focus();
                        const proto = Object.getPrototypeOf(input);
                        const desc = Object.getOwnPropertyDescriptor(proto, "value");
                        if (desc && desc.set) desc.set.call(input, text);
                        else input.value = text;
                        input.dispatchEvent(new Event("input", { bubbles: true }));
                        input.dispatchEvent(new Event("change", { bubbles: true }));
                    }

                    const names = ["sendMessage", "sendChatMessage", "sendMsg", "submitMessage", "sendChat"];
                    let invoked = false;
                    for (const name of names) {
                        if (typeof win[name] === "function") {
                            try {
                                const result = win[name].length ? win[name](text) : win[name]();
                                invoked = true;
                                if (result && typeof result.then === "function") {
                                    result.catch(() => {});
                                }
                                break;
                            } catch (_error) {}
                        }
                    }

                    if (!invoked) {
                        const btn = [...doc.querySelectorAll("button, input[type='submit']")].find(el => {
                            const hint = `${el.id} ${el.className} ${el.textContent || el.value || ""}`.toLowerCase();
                            return /send|➤|submit/.test(hint) && !/status|search/.test(hint);
                        });
                        if (btn) btn.click();
                        else if (input) {
                            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
                        }
                    }

                    clearTimeout(watchdog);
                    setTimeout(() => finish(true), 1400);
                } catch (_error) {
                    finish(false);
                }
            }, 1600);
        };
        iframe.onerror = () => finish(false);
        iframe.src = "/chat/" + encodeURIComponent(friend);
        document.body.appendChild(iframe);
    });
}

function openChatWithDraft(username, extraQuery){
    const friend = String(username || "").trim();
    if (!friend) return;
    const params = extraQuery ? "?" + extraQuery : "";
    window.location.href = "/chat/" + encodeURIComponent(friend) + params;
}

let statusReplySending = false;

async function sendStatusPrivateReply(){
    if (statusReplySending) return;
    if (!currentStatus || currentStatus.is_mine) return;

    const friend = resolveStatusChatUsername(currentStatus);
    if (!friend) {
        showStatusToast("Could not find this chat", true);
        return;
    }

    const inline = document.getElementById("statusReplyText");
    const sheetInput = document.getElementById("statusReplySheetText");
    const text = getStatusReplyText();

    if (!text) {
        showStatusToast("Write a reply first");
        (inline || sheetInput)?.focus();
        return;
    }

    const statusId = currentStatus.id;
    const outgoingText = text;

    statusReplySending = true;

    const sendBtns = [
        document.getElementById("statusReplySendBtn"),
        document.querySelector("#statusReplySheet .status-reply-send")
    ].filter(Boolean);

    sendBtns.forEach(btn => {
        btn.disabled = true;
        if (btn.id === "statusReplySendBtn") {
            const label = btn.querySelector("span");
            if (label) label.textContent = "…";
        } else {
            btn.textContent = "Sending…";
        }
    });

    let saved = false;
    try {
        saved = await recordStatusReplyServer(currentStatus, outgoingText);
    } catch (error) {
        console.error("Status reply send failed:", error);
    }

    statusReplySending = false;

    sendBtns.forEach(btn => {
        btn.disabled = false;
        if (btn.id === "statusReplySendBtn") {
            const label = btn.querySelector("span");
            if (label) label.textContent = "Send";
        } else {
            btn.textContent = "Send in chat";
        }
    });

    if (!saved) {
        showStatusToast("Could not send reply", true);
        return;
    }

    if (inline) inline.value = "";
    if (sheetInput) sheetInput.value = "";

    closeStatusSheets();
    closeStatusViewer();

    showStatusToast("Reply sent · opening chat");
    openChatWithDraft(
        friend,
        "from_status=" + encodeURIComponent(String(statusId || "")) +
        "&status_reply=1"
    );
}

function openStatusForwardSheet(){
    if (!currentStatus) return;
    const list = document.getElementById("statusForwardList");
    if (!list) return;
    const contacts = collectDashboardContacts();
    if (!contacts.length) {
        list.innerHTML = '<div class="status-sheet-empty">No chats to forward to yet.</div>';
    } else {
        list.innerHTML = contacts.map(contact => `
            <button class="status-sheet-row" type="button" onclick="forwardStatusTo('${escapeHtml(contact.username).replace(/'/g, "\\'")}')">
                <img src="${escapeHtml(contact.avatar)}" alt="" onerror="this.src='/static/profile/default.png'">
                <div>
                    <strong>${escapeHtml(contact.name)}</strong>
                    <span>${escapeHtml(contact.preview || contact.username)}</span>
                </div>
            </button>
        `).join("");
    }
    openStatusSheet("statusForwardSheet");
}

async function forwardStatusTo(username){
    if (!username || !currentStatus) return;

    const friend = String(username).trim();
    const mediaUrl = String(currentStatus.media_url || "").trim();
    const mediaType = mediaUrl ? "image" : "";
    const caption = currentStatus.text || "";
    const fromName = statusOwnerName(currentStatus);
    const forwardText = caption
        ? `Forwarded status from ${fromName}: ${caption}`
        : `Forwarded status from ${fromName}`;

    if (!friend || !forwardText) return;

    stashOutgoingChatDraft({
        to: friend,
        username: friend,
        media: mediaUrl,
        media_url: mediaUrl,
        text: forwardText,
        message: forwardText,
        from: fromName,
        kind: "status-forward",
        createdAt: Date.now()
    });

    showStatusToast("Forwarding…");

    let sent = false;
    let forwardSocket = null;
    let watchdog = null;

    try {
        const cryptoReady = await ensureDashboardCrypto();

        let encryptedText = forwardText;
        if (
            cryptoReady &&
            typeof LuckyCrypto !== "undefined" &&
            typeof LuckyCrypto.encryptMessage === "function"
        ) {
            const sender = String(CURRENT_DASHBOARD_USER || "").trim();
            if (sender) {
                encryptedText = await LuckyCrypto.encryptMessage(
                    forwardText,
                    friend,
                    sender
                );
            }
        }

        sent = await new Promise(resolve => {
            let settled = false;

            const finish = ok => {
                if (settled) return;
                settled = true;
                clearTimeout(watchdog);
                try { forwardSocket?.close(); } catch (_error) {}
                resolve(!!ok);
            };

            const protocol = location.protocol === "https:" ? "wss://" : "ws://";
            forwardSocket = new WebSocket(
                protocol +
                location.host +
                "/ws?friend=" + encodeURIComponent(friend) +
                "&page=chat"
            );

            watchdog = setTimeout(() => finish(false), 10000);

            forwardSocket.onopen = () => {
                try {
                    forwardSocket.send(JSON.stringify({
                        type: "forward_message",
                        text: encryptedText,
                        target: friend,
                        forwarded: true,
                        media_url: mediaUrl || null,
                        media_type: mediaType || null,
                        client_id:
                            "status-forward-" +
                            Date.now() +
                            "-" +
                            Math.random().toString(36).slice(2)
                    }));
                } catch (_error) {
                    finish(false);
                }
            };

            forwardSocket.onmessage = event => {
                try {
                    const data = JSON.parse(event.data);
                    if (
                        data?.type === "message" &&
                        data?.forwarded === true
                    ) {
                        finish(true);
                        return;
                    }
                    if (
                        data?.type === "forward_ack" &&
                        data?.forwarded === true
                    ) {
                        finish(true);
                    }
                } catch (_error) {}
            };

            forwardSocket.onerror = () => finish(false);
            forwardSocket.onclose = () => {
                if (!settled) finish(false);
            };
        });
    } catch (error) {
        console.error("STATUS FORWARD ERROR:", error);
        sent = false;
    }

    closeStatusSheets();
    closeStatusViewer();

    if (sent) {
        showStatusToast("Status forwarded");
    } else {
        showStatusToast("Could not forward status", true);
    }
}

function readLocalStatusViewMap(){
    try {
        const value = JSON.parse(localStorage.getItem(STATUS_VIEWERS_KEY) || "{}");
        return value && typeof value === "object" ? value : {};
    } catch (_error) {
        return {};
    }
}

function writeLocalStatusViewMap(map){
    try {
        localStorage.setItem(STATUS_VIEWERS_KEY, JSON.stringify(map));
    } catch (_error) {}
}

function rememberLocalStatusViewer(statusId, viewer){
    const id = String(statusId || "");
    const username = String(viewer?.username || viewer?.user || viewer?.name || "").trim();
    if (!id || !username) return;
    const map = readLocalStatusViewMap();
    const list = Array.isArray(map[id]) ? map[id] : [];
    const existing = list.find(item => String(item.username || "").toLowerCase() === username.toLowerCase());
    if (existing) {
        existing.seen_at = viewer.seen_at || existing.seen_at || Date.now();
        existing.display_name = viewer.display_name || existing.display_name;
        existing.profile_picture = viewer.profile_picture || existing.profile_picture;
    } else {
        list.push({
            username,
            display_name: viewer.display_name || username,
            profile_picture: viewer.profile_picture || "",
            seen_at: viewer.seen_at || Date.now()
        });
    }
    map[id] = list;
    writeLocalStatusViewMap(map);
}

function getLocalStatusViewers(statusId){
    const list = readLocalStatusViewMap()[String(statusId || "")] || [];
    return Array.isArray(list) ? list : [];
}

function readStatusMap(key){
    try {
        const value = JSON.parse(localStorage.getItem(key) || "{}");
        return value && typeof value === "object" ? value : {};
    } catch (_error) {
        return {};
    }
}

function writeStatusMap(key, map){
    try { localStorage.setItem(key, JSON.stringify(map)); } catch (_error) {}
}

function upsertStatusPerson(key, statusId, person, extra){
    const id = String(statusId || "");
    const username = String(person?.username || person?.user || person?.name || "").trim();
    if (!id || !username) return;
    const map = readStatusMap(key);
    const list = Array.isArray(map[id]) ? map[id] : [];
    const existing = list.find(item => String(item.username || "").toLowerCase() === username.toLowerCase());
    const incoming = { ...(extra || {}) };
    const created = getStatusCreatedAt(id);
    const next = {
        username,
        display_name: person.display_name || person.name || existing?.display_name || username,
        profile_picture: person.profile_picture || person.avatar || existing?.profile_picture || "",
        seen_at: pickStatusEventTime("latest", created, existing?.seen_at, person.seen_at, incoming.seen_at),
        liked_at: pickStatusEventTime("earliest", created, existing?.liked_at, person.liked_at, incoming.liked_at),
        replied_at: pickStatusEventTime("earliest", created, existing?.replied_at, person.replied_at, incoming.replied_at),
        ...incoming
    };
    next.seen_at = pickStatusEventTime("latest", created, existing?.seen_at, next.seen_at) || "";
    next.liked_at = pickStatusEventTime("earliest", created, existing?.liked_at, next.liked_at) || "";
    next.replied_at = pickStatusEventTime("earliest", created, existing?.replied_at, next.replied_at) || "";
    if (existing) Object.assign(existing, next);
    else list.push(next);
    map[id] = list;
    writeStatusMap(key, map);
}

function removeStatusPerson(key, statusId, username){
    const id = String(statusId || "");
    const who = String(username || "").trim().toLowerCase();
    if (!id || !who) return;
    const map = readStatusMap(key);
    map[id] = (Array.isArray(map[id]) ? map[id] : []).filter(item => String(item.username || "").toLowerCase() !== who);
    writeStatusMap(key, map);
}

function listStatusPeople(key, statusId){
    const list = readStatusMap(key)[String(statusId || "")] || [];
    return Array.isArray(list) ? list : [];
}

function rememberLocalStatusLiker(statusId, person, liked){
    if (liked === false) {
        removeStatusPerson(STATUS_LIKERS_KEY, statusId, person?.username || person?.user);
        return;
    }
    const username = person?.username || person?.user;
    const existing = listStatusPeople(STATUS_LIKERS_KEY, statusId).find(item =>
        String(item.username || "").toLowerCase() === String(username || "").trim().toLowerCase()
    );
    // Keep the first like time forever. Re-opening the status, or a
    // later "Just now" payload, must not move the original like forward.
    const incomingLikeTime = earliestStatusTime(
        existing?.liked_at,
        person?.liked_at,
        person?.like_at,
        person?.likedAt,
        person?.like_created_at
    );
    const isOwnLike = String(username || "").toLowerCase() === CURRENT_DASHBOARD_USER.toLowerCase();
    const likedAt = incomingLikeTime || existing?.liked_at || (isOwnLike ? Date.now() : "");
    upsertStatusPerson(STATUS_LIKERS_KEY, statusId, person, {
        liked: true,
        liked_at: likedAt
    });
    if (likedAt) rememberStatusPersonTimes(statusId, person, { liked_at: likedAt });
}

function rememberLocalStatusReply(statusId, person){
    upsertStatusPerson(STATUS_REPLIES_KEY, statusId, person, {
        text: person?.text || person?.message || "",
        replied_at: person?.replied_at || Date.now()
    });
}

function getLocalStatusLikers(statusId){
    return listStatusPeople(STATUS_LIKERS_KEY, statusId);
}

function getLocalStatusReplies(statusId){
    return listStatusPeople(STATUS_REPLIES_KEY, statusId);
}

function coerceViewerList(raw){
    if (!raw && raw !== 0) return [];
    if (typeof raw === "number") return [];
    if (typeof raw === "string") {
        const text = raw.trim();
        if (!text || /^\d+$/.test(text)) return [];
        if (text.startsWith("[") || text.startsWith("{")) {
            try { return coerceViewerList(JSON.parse(text)); } catch (_error) {}
        }
        return text.split(/[,|\n]/).map(part => part.trim()).filter(Boolean);
    }
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "object") {
        if (raw.username || raw.user || raw.viewer || raw.display_name) return [raw];
        const nested = raw.viewers || raw.seen_by || raw.seenBy || raw.watched_by ||
            raw.watchers || raw.seen || raw.views || raw.users || raw.list || raw.data;
        if (nested && nested !== raw) return coerceViewerList(nested);
    }
    return [];
}

function formatViewerSeenAt(value){
    if (!value && value !== 0) return "Viewed";
    const parsed = parseStatusTimestamp(value);
    if (Number.isFinite(parsed)) return formatStatusAge(parsed);
    const text = String(value).trim();
    if (!text) return "Viewed";
    return text;
}

const STATUS_PERSON_TIMES_KEY = "lucky_status_person_times_v2";

function readStatusPersonTimes(){
    return readStatusMap(STATUS_PERSON_TIMES_KEY);
}

function writeStatusPersonTimes(map){
    writeStatusMap(STATUS_PERSON_TIMES_KEY, map);
}

function getStatusCreatedAt(statusId){
    if (currentStatus && statusIdsEqual(currentStatus.id, statusId)) {
        return currentStatus.created_at || currentStatus.time || "";
    }
    const match = (typeof loadedStatuses !== "undefined" && Array.isArray(loadedStatuses))
        ? loadedStatuses.find(item => statusIdsEqual(item?.id, statusId))
        : null;
    return match?.created_at || match?.time || "";
}

function clampStatusEventTime(value, statusCreatedAt){
    const time = parseStatusTimestamp(value);
    if (!Number.isFinite(time) || time <= 0) return NaN;
    if (time > Date.now() + 120000) return NaN;
    const created = parseStatusTimestamp(statusCreatedAt);
    // A view/like/reply cannot happen before the status exists.
    if (Number.isFinite(created) && time < created - 60000) return NaN;
    return time;
}

function earliestStatusTime(...values){
    const created = getStatusCreatedAt(currentStatus?.id);
    let best = NaN;
    values.forEach(value => {
        const time = clampStatusEventTime(value, created);
        if (!Number.isFinite(time)) return;
        if (!Number.isFinite(best) || time < best) best = time;
    });
    return best;
}

function pickStatusEventTime(mode, statusCreatedAt, ...values){
    let best = NaN;
    values.forEach(value => {
        const time = clampStatusEventTime(value, statusCreatedAt);
        if (!Number.isFinite(time)) return;
        if (!Number.isFinite(best)) {
            best = time;
            return;
        }
        if (mode === "latest") {
            if (time > best) best = time;
        } else if (time < best) {
            best = time;
        }
    });
    return best;
}

function getStatusPersonTimes(statusId, username){
    const id = String(statusId || "");
    const key = String(username || "").trim().toLowerCase();
    if (!id || !key) return null;
    const group = readStatusPersonTimes()[id];
    if (!group || typeof group !== "object") return null;
    const entry = group[key];
    return entry && typeof entry === "object" ? entry : null;
}

function rememberStatusPersonTimes(statusId, person, extra){
    const id = String(statusId || "");
    const username = String(person?.username || person?.user || person?.name || "").trim();
    if (!id || !username) return;
    const created = getStatusCreatedAt(id);
    const map = readStatusPersonTimes();
    const group = map[id] && typeof map[id] === "object" ? map[id] : {};
    const key = username.toLowerCase();
    const prev = group[key] && typeof group[key] === "object" ? group[key] : {};
    const next = { ...prev };
    const latestFields = { seen_at: "latest", liked_at: "earliest", replied_at: "earliest" };
    Object.keys(latestFields).forEach(field => {
        const picked = pickStatusEventTime(
            latestFields[field],
            created,
            prev[field],
            person?.[field],
            extra?.[field]
        );
        if (Number.isFinite(picked)) next[field] = picked;
        else if (next[field] && !Number.isFinite(clampStatusEventTime(next[field], created))) {
            delete next[field];
        }
    });
    group[key] = next;
    map[id] = group;
    writeStatusPersonTimes(map);
    return next;
}

function resolvePersonEventTime(statusId, person, field, fallbacks, mode){
    const created = getStatusCreatedAt(statusId);
    const cached = getStatusPersonTimes(statusId, person?.username);
    const candidates = [
        cached?.[field],
        person?.[field],
        ...(Array.isArray(fallbacks) ? fallbacks : [fallbacks])
    ];
    const pickMode = mode || (field === "seen_at" ? "latest" : "earliest");
    const picked = pickStatusEventTime(pickMode, created, ...candidates);
    if (Number.isFinite(picked)) {
        rememberStatusPersonTimes(statusId, person, { [field]: picked });
        return picked;
    }
    return "";
}

function hydrateStatusViewer(entry){
    if (entry == null || entry === "") return null;
    if (typeof entry === "string" || typeof entry === "number") {
        entry = { username: String(entry) };
    }
    const username = String(entry.username || entry.user || entry.viewer || entry.id || entry.name || "").trim();
    if (!username) return null;
    const contacts = collectDashboardContacts();
    const match = contacts.find(contact =>
        contact.username.toLowerCase() === username.toLowerCase() ||
        String(contact.name || "").toLowerCase() === username.toLowerCase()
    );
    return {
        username: match?.username || username,
        display_name: entry.display_name || entry.name || match?.name || username,
        profile_picture: entry.profile_picture || entry.avatar || entry.photo || match?.avatar || "/static/profile/default.png",
        seen_at: entry.seen_at || entry.viewed_at || entry.seenAt || entry.last_viewed_at || "",
        liked_at: entry.liked_at || entry.like_at || entry.likedAt || entry.like_created_at || entry.liked_at_ts || "",
        replied_at: entry.replied_at || entry.reply_at || entry.repliedAt || entry.reply_created_at || "",
        reacted_at: entry.reacted_at || entry.reaction_at || entry.reactedAt || "",
        reaction: STATUS_EMOJI_REACTIONS.includes(String(entry.reaction || "").trim())
            ? String(entry.reaction || "").trim()
            : "",
        text: entry.text || entry.message || "",
        liked: !!(entry.liked || entry.reacted || entry.like)
    };
}

function mergeStatusViewers(...groups){
    const merged = [];
    groups.flat().map(hydrateStatusViewer).filter(Boolean).forEach(viewer => {
        const index = merged.findIndex(item => item.username.toLowerCase() === viewer.username.toLowerCase());
        if (index === -1) merged.push(viewer);
        else {
            const created = getStatusCreatedAt(currentStatus?.id);
            merged[index] = {
                ...merged[index],
                ...viewer,
                seen_at: pickStatusEventTime("latest", created, merged[index].seen_at, viewer.seen_at) || "",
                liked_at: pickStatusEventTime("earliest", created, merged[index].liked_at, viewer.liked_at) || "",
                replied_at: pickStatusEventTime("earliest", created, merged[index].replied_at, viewer.replied_at) || "",
                reacted_at: pickStatusEventTime("earliest", created, merged[index].reacted_at, viewer.reacted_at) || "",
                reaction: viewer.reaction || merged[index].reaction || "",
                liked: !!(merged[index].liked || viewer.liked)
            };
        }
    });
    return merged;
}

function extractStatusViewers(status){
    if (!status) return [];
    return mergeStatusViewers(
        coerceViewerList(status.viewers),
        coerceViewerList(status.seen_by),
        coerceViewerList(status.seenBy),
        coerceViewerList(status.watched_by),
        coerceViewerList(status.watchers),
        coerceViewerList(status.seen),
        Array.isArray(status.views) &&
            typeof status.views[0] !== "number"
            ? coerceViewerList(status.views)
            : [],
        coerceViewerList(status.engagement?.viewers)
    ).filter(viewer =>
        viewer.username.toLowerCase() !== CURRENT_DASHBOARD_USER.toLowerCase() ||
        !status.is_mine
    );
}

function readCountField(...values){
    for (const value of values) {
        if (value == null || value === "") continue;
        if (Array.isArray(value)) return value.length;
        if (typeof value === "object") {
            return coerceViewerList(value).length ||
                Number(value.count || value.total || 0) || 0;
        }
        const count = Number(value);
        if (Number.isFinite(count)) return count;
    }
    return 0;
}

function extractStatusEngagement(status, viewers){
    const viewerList = Array.isArray(viewers)
        ? viewers
        : extractStatusViewers(status);

    const likers = coerceViewerList(
        status?.likers ||
        status?.liked_by ||
        status?.likes_list ||
        status?.engagement?.likers
    );

    const replies = coerceViewerList(
        status?.replies_list ||
        status?.repliesList ||
        status?.engagement?.replies_list
    );

    const likes = readCountField(
        status?.likes_count,
        status?.like_count,
        status?.engagement?.likes
    );

    const replyCount = readCountField(
        status?.replies_count,
        status?.reply_count,
        status?.engagement?.replies
    );

    const views = readCountField(
        status?.views_count,
        status?.view_count,
        status?.seen_count,
        status?.watch_count,
        status?.engagement?.views,
        viewerList.length
    );

    return {
        views: Math.max(0, Number(views) || 0),
        likes: Math.max(0, Number(likes) || likers.length),
        replies: Math.max(0, Number(replyCount) || replies.length),
        likers,
        repliesList: replies
    };
}

function mergeServerStatusPeople(list){
    const seen = new Map();
    (Array.isArray(list) ? list : [])
        .map(hydrateStatusViewer)
        .filter(Boolean)
        .forEach(person => {
            const key = String(person.username || "").trim().toLowerCase();
            if (!key) return;
            const prev = seen.get(key) || {};
            const created = getStatusCreatedAt(currentStatus?.id);
            seen.set(key, {
                ...prev,
                ...person,
                seen_at: pickStatusEventTime("latest", created, prev.seen_at, person.seen_at) || "",
                liked_at: pickStatusEventTime("earliest", created, prev.liked_at, person.liked_at) || "",
                replied_at: pickStatusEventTime("earliest", created, prev.replied_at, person.replied_at) || "",
                liked: !!(prev.liked || person.liked)
            });
        });
    return [...seen.values()];
}

async function fetchStatusViewers(status){
    if (!status?.id) {
        return {
            viewers: [],
            views: 0,
            likes: 0,
            replies: 0,
            reactions: 0,
            reactionCounts: {},
            likers: [],
            repliesList: [],
            reactionsList: [],
            fromApi: false,
            raw: status
        };
    }

    try {
        const id = encodeURIComponent(status.id);
        const res = await fetch(
            "/statuses/" + id + "/engagement",
            {
                credentials: "same-origin",
                cache: "no-store"
            }
        );

        if (res.ok) {
            const data = await res.json();
            if (data?.success) {
                const viewers = mergeServerStatusPeople(data.viewers);
                const likers = mergeServerStatusPeople(data.likers);
                const repliesList = mergeServerStatusPeople(data.replies_list);
                const reactionsList = mergeServerStatusPeople(data.reactions_list);

                viewers.forEach(person => {
                    rememberStatusPersonTimes(status.id, person, {
                        seen_at: person.seen_at
                    });
                });
                likers.forEach(person => {
                    rememberLocalStatusLiker(status.id, person, true);
                    rememberStatusPersonTimes(status.id, person, {
                        liked_at: person.liked_at || person.like_at || person.likedAt
                    });
                });
                repliesList.forEach(person => {
                    rememberStatusPersonTimes(status.id, person, {
                        replied_at: person.replied_at
                    });
                });

                return {
                    viewers,
                    views: Number(data.views) || viewers.length,
                    likes: Number(data.likes) || likers.length,
                    replies: Number(data.replies) || repliesList.length,
                    reactions: Number(data.reactions) || reactionsList.length,
                    reactionCounts: (
                        data.reaction_counts && typeof data.reaction_counts === "object"
                            ? data.reaction_counts
                            : {}
                    ),
                    likers,
                    repliesList,
                    reactionsList,
                    fromApi: true,
                    raw: data
                };
            }
        }
    } catch (error) {
        console.error("STATUS ENGAGEMENT FETCH ERROR:", error);
    }

    return {
        viewers: [],
        views: 0,
        likes: 0,
        replies: 0,
        reactions: 0,
        reactionCounts: {},
        likers: [],
        repliesList: [],
        reactionsList: [],
        fromApi: false,
        raw: null
    };
}

async function recordStatusView(status){
    if (!status?.id || status.is_mine) return false;

    try {
        const res = await fetch(
            "/statuses/" + encodeURIComponent(status.id) + "/view",
            {
                method: "POST",
                credentials: "same-origin",
                cache: "no-store"
            }
        );
        if (!res.ok) return false;
        const data = await res.json();
        return data?.success === true;
    } catch (error) {
        console.error("STATUS VIEW ERROR:", error);
        return false;
    }
}

async function recordStatusLike(status, liked){
    if (!status?.id || status.is_mine) return false;

    try {
        const res = await fetch(
            "/statuses/" + encodeURIComponent(status.id) + "/like",
            {
                method: "POST",
                credentials: "same-origin",
                cache: "no-store",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ liked: !!liked })
            }
        );
        if (!res.ok) return false;
        const data = await res.json();
        return data?.success === true;
    } catch (error) {
        console.error("STATUS LIKE ERROR:", error);
        return false;
    }
}

async function recordStatusReplyServer(status, text){
    if (!status?.id || status.is_mine) return false;
    const friend = resolveStatusChatUsername(status);
    if (!friend) return false;

    try {
        const encryptedText = await encryptOutgoingChatText(text, friend);
        if (!String(encryptedText || "").startsWith("LCE")) {
            console.warn(
                "STATUS REPLY: encryption unavailable; not recording engagement"
            );
            return false;
        }

        const res = await fetch(
            "/statuses/" + encodeURIComponent(status.id) + "/reply",
            {
                method: "POST",
                credentials: "same-origin",
                cache: "no-store",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ encrypted_text: encryptedText })
            }
        );
        if (!res.ok) return false;
        const data = await res.json();
        return data?.success === true;
    } catch (error) {
        console.error("STATUS REPLY ENGAGEMENT ERROR:", error);
        return false;
    }
}

async function decryptStatusReplyText(reply){
    const encrypted = String(reply?.encrypted_text || "").trim();
    if (!encrypted) return "";

    if (
        !encrypted.startsWith("LCE1:") &&
        !encrypted.startsWith("LCE2:")
    ) {
        return encrypted;
    }

    try {
        if (
            await ensureDashboardCrypto() &&
            typeof LuckyCrypto.decryptMessage === "function"
        ) {
            return await LuckyCrypto.decryptMessage(
                encrypted,
                "{{ username }}"
            );
        }
    } catch (error) {
        console.error("STATUS REPLY DECRYPT ERROR:", error);
    }

    return "Private reply";
}

function openChatFromViewer(username){
    const friend = String(username || "").trim();
    if (!friend) return;
    closeStatusSheets();
    closeStatusViewer();
    openChat(friend);
}

async function openStatusViewersSheet(){
    if (!currentStatus) return;

    const list = document.getElementById("statusViewersList");
    const meta = document.getElementById("statusViewersMeta");
    const stats = document.getElementById("statusEngageStats");

    if (list) {
        list.innerHTML = '<div class="status-sheet-empty">Loading viewers…</div>';
    }
    if (stats) {
        stats.hidden = true;
        stats.innerHTML = "";
    }

    openStatusSheet("statusViewersSheet");

    if (!currentStatus.is_mine) {
        if (meta) {
            meta.textContent =
                "Viewer names are only visible on your own status";
        }
        if (stats) {
            stats.hidden = false;
            stats.innerHTML = `
                <div class="status-engage-chip"><b>—</b><span>Views</span></div>
                <div class="status-engage-chip"><b>—</b><span>Likes</span></div>
                <div class="status-engage-chip"><b>—</b><span>Replies</span></div>
                <div class="status-engage-chip"><b>—</b><span>Reactions</span></div>
            `;
        }
        if (list) {
            list.innerHTML =
                '<div class="status-sheet-empty">Viewer names are only visible on your own status.</div>';
        }
        return;
    }

    const fetched = await fetchStatusViewers(currentStatus);
    const statusId = currentStatus.id;

    // The owner of a status must never appear as a viewer, liker, or reply
    // participant in their own engagement panel. Some backend responses may
    // include the owner as an engagement record, so filter that account here
    // before building the visible list and counts.
    const ownerKey = String(CURRENT_DASHBOARD_USER || "").trim().toLowerCase();
    const isOwnerRecord = person =>
        String(person?.username || person?.user || "").trim().toLowerCase() === ownerKey;

    // The owner engagement panel is server-authoritative.
    // Never merge browser-local viewer/liker caches into this panel because
    // those caches can survive older tests, browser sessions, or old UI state.
    const serverViewers = Array.isArray(fetched.viewers)
        ? fetched.viewers.slice()
        : [];

    const serverLikers = Array.isArray(fetched.likers)
        ? fetched.likers.slice()
        : [];

    const serverReplies = Array.isArray(fetched.repliesList)
        ? fetched.repliesList.slice()
        : [];

    const ownerWasViewer = serverViewers.some(isOwnerRecord);
    const ownerWasLiker = serverLikers.some(isOwnerRecord);
    const ownerWasReplier = serverReplies.some(isOwnerRecord);

    const viewers = serverViewers.filter(person => !isOwnerRecord(person));
    const likers = serverLikers.filter(person => !isOwnerRecord(person));
    const replies = serverReplies.filter(person => !isOwnerRecord(person));

    const serverViewCount = Number(fetched.views) || serverViewers.length;
    const serverLikeCount = Number(fetched.likes) || serverLikers.length;
    const serverReplyCount = Number(fetched.replies) || serverReplies.length;

    const displayViewCount = Math.max(0, serverViewCount - (ownerWasViewer ? 1 : 0));
    const displayLikeCount = Math.max(0, serverLikeCount - (ownerWasLiker ? 1 : 0));
    const displayReplyCount = Math.max(0, serverReplyCount - (ownerWasReplier ? 1 : 0));

    const likedSet = new Set(
        likers
            .map(item =>
                String(item.username || "").trim().toLowerCase()
            )
            .filter(Boolean)
    );

    // Prefer an explicit like stamp, then a locally cached first-like time.
    // Never fall back to updated-now fields such as created_at/timestamp —
    // those make an old like look like "Just now" every time the sheet opens.
    const likeTimeMap = new Map(
        likers.map(liker => {
            const key = String(liker.username || "").trim().toLowerCase();
            const value = resolvePersonEventTime(statusId, liker, "liked_at", [
                liker.liked_at,
                liker.like_at,
                liker.likedAt,
                liker.like_created_at
            ]);
            return [key, value];
        }).filter(([key]) => !!key)
    );

    const replyMap = new Map(
        replies.map(reply => [
            String(reply.username || "").trim().toLowerCase(),
            reply
        ])
    );

    for (const viewer of viewers) {
        const key = String(viewer.username || "")
            .trim()
            .toLowerCase();

        const liker = likers.find(item =>
            String(item.username || "").trim().toLowerCase() === key
        );
        viewer.liked = !!viewer.liked || !!liker || likedSet.has(key);
        viewer.seen_at = resolvePersonEventTime(statusId, viewer, "seen_at", [
            viewer.seen_at
        ]) || viewer.seen_at;
        if (viewer.liked) {
            viewer.liked_at = likeTimeMap.get(key) ||
                resolvePersonEventTime(statusId, viewer, "liked_at", [
                    viewer.liked_at,
                    liker?.liked_at,
                    liker?.like_at,
                    liker?.likedAt,
                    liker?.like_created_at
                ]);
        }

        const reaction = Array.isArray(fetched.reactionsList)
            ? fetched.reactionsList.find(item =>
                String(item.username || "").trim().toLowerCase() === key
            )
            : null;
        if (reaction) {
            viewer.reaction = reaction.reaction || "";
            viewer.reacted_at = reaction.reacted_at || "";
        }

        const reply = replyMap.get(key);
        if (reply) {
            viewer.replied = true;
            viewer.replied_at = resolvePersonEventTime(statusId, viewer, "replied_at", [
                viewer.replied_at,
                reply.replied_at,
                reply.reply_at,
                reply.repliedAt
            ]) || viewer.replied_at || reply.replied_at || "";
            viewer.reply_text = await decryptStatusReplyText(reply);
        }

        rememberStatusPersonTimes(statusId, viewer, {
            seen_at: viewer.seen_at,
            liked_at: viewer.liked_at,
            replied_at: viewer.replied_at,
            reacted_at: viewer.reacted_at
        });
    }

    if (stats) {
        stats.hidden = false;
        stats.innerHTML = `
            <div class="status-engage-chip">
                <b>${fetched.fromApi ? displayViewCount : viewers.length}</b>
                <span>Views</span>
            </div>
            <div class="status-engage-chip">
                <b>${fetched.fromApi ? displayLikeCount : likers.length}</b>
                <span>Likes</span>
            </div>
            <div class="status-engage-chip">
                <b>${fetched.fromApi ? displayReplyCount : replies.length}</b>
                <span>Replies</span>
            </div>
            <div class="status-engage-chip status-reaction-summary-chip">
                <b>${fetched.fromApi ? Number(fetched.reactions || 0) : 0}</b>
                <span>Reactions</span>
            </div>
        `;
    }

    if (meta) {
        meta.textContent = viewers.length
            ? `Seen by ${viewers.length} · ${formatStatusAge(currentStatus.created_at)}`
            : "No views yet · only you can see this list";
    }

    paintViewersFab(
        viewers,
        fetched.fromApi ? displayViewCount : viewers.length
    );

    if (!list) return;

    const renderPersonRow = (person, subtitle, extra) => {
        const username = String(person.username || "").trim();
        const name = person.display_name || username || "Contact";
        const avatar =
            person.profile_picture ||
            "/static/profile/default.png";
        const safeUser = username.replace(/'/g, "\\'");
        return `
            <button class="status-sheet-row status-viewer-row" type="button"
                ${username ? `onclick="openChatFromViewer('${safeUser}')"` : ""}>
                <img src="${escapeHtml(avatar)}"
                     alt=""
                     onerror="this.src='/static/profile/default.png'">
                <div class="viewer-meta">
                    <strong>${escapeHtml(name)}</strong>
                    <span>${escapeHtml(subtitle)}</span>
                </div>
                ${extra || ""}
            </button>
        `;
    };

    let html = "";

    if (viewers.length) {
        html +=
            '<div class="status-viewers-section-title">Viewed by</div>';

        html += viewers.map(viewer => {
            const key = String(viewer.username || "")
                .trim()
                .toLowerCase();
            const viewedAt = resolvePersonEventTime(statusId, viewer, "seen_at", [
                viewer.seen_at,
                viewer.liked_at,
                viewer.replied_at
            ], "latest");
            const viewedLabel = viewedAt ? formatStatusAge(viewedAt) : "Viewed";
            const bits = [viewedLabel];

            if (viewer.liked) {
                const likedAt = likeTimeMap.get(key) ||
                    resolvePersonEventTime(statusId, viewer, "liked_at", [
                        viewer.liked_at
                    ], "earliest");
                const likedLabel = likedAt ? formatStatusAge(likedAt) : "";
                if (likedLabel && likedLabel !== viewedLabel) {
                    bits.push("liked " + likedLabel);
                } else {
                    bits.push("liked");
                }
            }

            if (viewer.reaction) {
                const reactedAt = resolvePersonEventTime(statusId, viewer, "reacted_at", [
                    viewer.reacted_at
                ], "earliest");
                bits.push(
                    reactedAt
                        ? `reacted ${viewer.reaction} ${formatStatusAge(reactedAt)}`
                        : `reacted ${viewer.reaction}`
                );
            }

            if (viewer.replied) {
                const replyText = String(
                    viewer.reply_text || ""
                ).trim();
                const repliedAt = resolvePersonEventTime(statusId, viewer, "replied_at", [
                    viewer.replied_at
                ], "earliest");
                const repliedLabel = repliedAt ? formatStatusAge(repliedAt) : "replied";
                bits.push(
                    replyText
                        ? `replied ${repliedLabel}: ${replyText.slice(0, 42)}`
                        : `replied ${repliedLabel}`
                );
            }

            return renderPersonRow(
                viewer,
                bits.join(" · "),
                viewer.liked
                    ? '<span class="viewer-like">♥</span>'
                    : ""
            );
        }).join("");
    } else {
        html +=
            '<div class="status-sheet-empty">No views yet. When someone opens this status, they will show up here.</div>';
    }

    // Exceptional records are still shown, but nobody already present in
    // "Viewed by" is duplicated under another section.
    const viewerNames = new Set(
        viewers.map(item =>
            String(item.username || "").trim().toLowerCase()
        )
    );

    const extraLikers = likers.filter(person =>
        !viewerNames.has(
            String(person.username || "").trim().toLowerCase()
        )
    );

    if (extraLikers.length) {
        html +=
            '<div class="status-viewers-section-title">Liked</div>';
        html += extraLikers.map(person => {
            const likedAt = resolvePersonEventTime(statusId, person, "liked_at", [
                person.liked_at,
                person.like_at
            ]);
            return renderPersonRow(
                person,
                likedAt ? ("Liked " + formatStatusAge(likedAt)) : "Liked this status",
                '<span class="viewer-like">♥</span>'
            );
        }).join("");
    }

    const viewerReactionNames = new Set(
        viewers
            .map(item => String(item.username || "").trim().toLowerCase())
            .filter(Boolean)
    );
    const extraReactions = Array.isArray(fetched.reactionsList)
        ? fetched.reactionsList.filter(person =>
            !viewerReactionNames.has(
                String(person.username || "").trim().toLowerCase()
            )
        )
        : [];

    if (extraReactions.length) {
        html +=
            '<div class="status-viewers-section-title">Reactions</div>';
        html += extraReactions.map(person => {
            const reactedAt = resolvePersonEventTime(statusId, person, "reacted_at", [
                person.reacted_at
            ]);
            const reaction = String(person.reaction || "").trim();
            return renderPersonRow(
                person,
                reactedAt
                    ? `Reacted ${reaction} · ${formatStatusAge(reactedAt)}`
                    : `Reacted ${reaction}`,
                `<span class="viewer-reaction">${escapeHtml(reaction)}</span>`
            );
        }).join("");
    }

    const extraReplies = replies.filter(person =>
        !viewerNames.has(
            String(person.username || "").trim().toLowerCase()
        )
    );

    if (extraReplies.length) {
        html +=
            '<div class="status-viewers-section-title">Replied privately</div>';

        for (const person of extraReplies) {
            const replyText =
                await decryptStatusReplyText(person);

            html += renderPersonRow(
                person,
                replyText
                    ? replyText.slice(0, 42)
                    : "Sent a private reply"
            );
        }
    }

    list.innerHTML = html;
}

function paintViewersFab(viewers, viewCount){
    const faces = document.getElementById("statusViewersFaces");
    const label = document.getElementById("statusViewersFabLabel");
    if (!faces || !label) return;
    const items = Array.isArray(viewers) ? viewers : [];
    const count = Number(viewCount);
    const shown = Number.isFinite(count) && count > items.length ? count : items.length;
    faces.innerHTML = items.slice(0, 3).map(viewer =>
        `<img src="${escapeHtml(viewer.profile_picture || viewer.avatar || viewer.photo || "/static/profile/default.png")}" alt="" onerror="this.src='/static/profile/default.png'">`
    ).join("");
    label.textContent = shown ? `Seen by ${shown}` : "No views yet";
}

function toggleStatusVolume(){
    const button = document.getElementById("statusVolumeBtn");
    if (!button) return;
    const muted = button.classList.toggle("is-muted");
    button.setAttribute("aria-label", muted ? "Unmute" : "Sound");
}

function selectStatusTheme(theme, button){
    const modal = document.getElementById("statusCreateModal");
    if (!modal) return;
    modal.dataset.statusTheme = theme;
    modal.classList.remove("status-theme-default","status-theme-ocean","status-theme-forest","status-theme-space","status-theme-sunset","status-theme-aurora");
    modal.classList.add(`status-theme-${theme}`);
    document.querySelectorAll("#statusCreateModal .status-theme").forEach(el => {
        el.classList.toggle("active", el === button);
    });
    syncStatusComposerPreview();
}

function updateStatusCaptionCount(){
    const input = document.getElementById("statusText");
    const counter = document.getElementById("statusCaptionCount");
    if (input && counter) counter.textContent = `${input.value.length} / 500`;
    syncStatusComposerPreview();
}

function resetStatusComposerTheme(){
    const modal = document.getElementById("statusCreateModal");
    if (!modal) return;
    modal.dataset.statusTheme = "default";
    modal.classList.remove("status-theme-ocean","status-theme-forest","status-theme-space","status-theme-sunset","status-theme-aurora");
    modal.classList.add("status-theme-default");
    const first = modal.querySelector(".status-theme-default");
    document.querySelectorAll("#statusCreateModal .status-theme").forEach(el => {
        el.classList.toggle("active", el === first);
    });
}

function syncStatusComposerPreview(){
    const modal = document.getElementById("statusCreateModal");
    if (!modal) return;

    const captionEl = document.getElementById("statusPreviewCaption");
    const textInput = document.getElementById("statusText");
    const caption = String(textInput?.value || "").trim();
    if (captionEl) {
        captionEl.textContent = caption;
        if (caption && modal.classList.contains("has-selection")) captionEl.removeAttribute("hidden");
        else captionEl.setAttribute("hidden", "");
    }

    const metaState = document.getElementById("statusPreviewMetaState");
    const theme = modal.dataset.statusTheme || "default";
    if (metaState) {
        metaState.textContent = modal.classList.contains("has-selection")
            ? (theme === "default" ? "Ready to post" : `Mood · ${theme}`)
            : "Waiting for photo";
    }

    const privacy = getStatusPrivacy();
    const visibility = STATUS_VISIBILITY_OPTIONS[statusVisibilityIndex] || STATUS_VISIBILITY_OPTIONS[0];
    const audience = document.getElementById("statusAudienceHint");
    if (audience) audience.textContent = getStatusVisibilitySummary(privacy) || visibility.label;

    const hasPhoto = modal.classList.contains("has-selection");
    const hasCustomize = hasPhoto && (!!caption || theme !== "default");
    const previewStep = document.getElementById("statusStepPreview");
    const customizeStep = document.getElementById("statusStepCustomize");
    const publishStep = document.getElementById("statusStepPublish");
    previewStep?.classList.toggle("is-active", !hasPhoto);
    customizeStep?.classList.toggle("is-active", hasPhoto && !hasCustomize);
    publishStep?.classList.toggle("is-active", hasPhoto && hasCustomize);
}

async function uploadStatus(){
    const fileInput = document.getElementById("statusFile");
    const textInput = document.getElementById("statusText");
    const button = document.getElementById("statusUploadBtn");
    const file = fileInput.files && fileInput.files[0];

    if (!file) {
        setStatusMessage("Choose a photo first.", true);
        return;
    }

    if (file.size > 25 * 1024 * 1024) {
        setStatusMessage("That image is larger than 25 MB.", true);
        return;
    }

    const formData = new FormData();
    const privacy = getStatusPrivacy();
    formData.append("file", file);
    formData.append("text", textInput.value.trim());
    formData.append("visibility", privacy.visibility || "contacts");
    formData.append("audience_users", JSON.stringify(Array.isArray(privacy.audience_users) ? privacy.audience_users : []));
    formData.append("theme", document.getElementById("statusCreateModal")?.dataset.statusTheme || "default");
    formData.append("duration_hours", "24");

    button.disabled = true;
    button.innerHTML = "<span>Posting…</span><span class=\"status-btn-arrow\">↗</span>";
    setStatusMessage("Uploading your story…");

    try {
        const res = await fetch("/upload-status", {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            body: formData
        });

        if (handleDashboardAuthFailure(res.status)) {
            throw new Error("Please sign in again to post a status.");
        }

        const data = await res.json();

        if (!res.ok || !data.success) {
            throw new Error(data.error || "Could not upload status");
        }

        closeStatusCreate();
        showStatusToast("Status posted · disappears in 24 hours");
        await loadStatuses();
        const fresh = loadedStatuses.find(item => statusIdsEqual(item?.id, data.status?.id));
        if (fresh) openStatusById(fresh.id);
    } catch (error) {
        console.error("Status upload error:", error);
        setStatusMessage(error.message || "Could not upload status.", true);
    } finally {
        button.disabled = false;
        button.innerHTML = "<span>Post status</span><span class=\"status-btn-arrow\">↗</span>";
    }
}

function getStatusSortTime(status){
    const value = status?.created_at;
    const parsed = parseStatusTimestamp(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function buildStatusViewerList(statuses){
    const source = Array.isArray(statuses) ? statuses.filter(Boolean) : [];

    // The viewer order is deliberately independent from the API's raw order:
    // 1) the signed-in user's statuses first, newest first
    // 2) everyone else's statuses, newest first
    // This keeps the dashboard card order and viewer order identical.
    return [...source].sort((a, b) => {
        const mineA = a?.is_mine ? 1 : 0;
        const mineB = b?.is_mine ? 1 : 0;
        if (mineA !== mineB) return mineB - mineA;

        const timeDiff = getStatusSortTime(b) - getStatusSortTime(a);
        if (timeDiff !== 0) return timeDiff;

        return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
    });
}

let statusLoadInFlight = null;
let statusLoadGeneration = 0;

async function loadStatuses(force = false){
    const row = document.getElementById("statusRow");
    if (!row) return;

    if (force) {
        // A privacy-changing event must not reuse a status request that may
        // have started before the block/unblock was committed on the server.
        // Advance the generation so any older response is discarded.
        statusLoadGeneration++;
    } else if (statusLoadInFlight) {
        return statusLoadInFlight;
    }

    const requestGeneration = statusLoadGeneration;

    const loadPromise = (async () => {
        try {
            const res = await fetch("/statuses", {
                credentials:"same-origin",
                cache:"no-store"
            });
            if (handleDashboardAuthFailure(res.status)) return;
            const data = await res.json();

            if (!res.ok || !data.success) {
                throw new Error(data.error || "Could not load statuses");
            }

            // Never let an older pre-change response overwrite the result of a
            // newer forced privacy refresh.
            if (requestGeneration !== statusLoadGeneration) return;

            loadedStatuses = Array.isArray(data.statuses) ? data.statuses : [];
            statusViewerStatuses = buildStatusViewerList(loadedStatuses);
            renderStatuses();
        } catch (error) {
            console.debug("Status list unavailable; keeping current shelf:", error);
        }
    })();

    statusLoadInFlight = loadPromise;
    loadPromise.then(
        () => { if (statusLoadInFlight === loadPromise) statusLoadInFlight = null; },
        () => { if (statusLoadInFlight === loadPromise) statusLoadInFlight = null; }
    );

    return loadPromise;
}

function invalidateStatusesForBlockedUser(username){
    const blockedKey = String(username || "").trim().toLowerCase();
    if (!blockedKey) return;

    const next = loadedStatuses.filter(status =>
        String(status?.username || "").trim().toLowerCase() !== blockedKey
    );

    if (next.length === loadedStatuses.length) return;

    loadedStatuses = next;
    statusViewerStatuses = buildStatusViewerList(loadedStatuses);
    renderStatuses();
}

function recoverMyStatusEmptyState(image){
    const card = image?.closest?.(".status-card.your-status");
    if (!card) return;

    card.classList.remove("my-status-active", "has-story");
    card.classList.add("story-card-empty");
    card.setAttribute("aria-label", "Add a status");
    card.setAttribute("onclick", "createStatus()");

    const top = card.querySelector(".story-card-top");
    if (top) {
        top.innerHTML = `
            <div class="story-avatar-wrap my-status-empty-avatar" aria-hidden="true">
                <span class="my-status-empty-icon" aria-hidden="true"></span>
                <span class="status-add" aria-hidden="true">+</span>
            </div>
        `;
    }

    const bottom = card.querySelector(".story-card-bottom");
    if (bottom) {
        bottom.innerHTML = `
            <span class="status-name">My Status</span>
            <span class="status-hint">Add status</span>
        `;
    }
}

function renderStatuses(){
    const row = document.getElementById("statusRow");
    if (!row) return;

    // Keep the visual shelf and viewer based on the same ordered data set.
    statusViewerStatuses = buildStatusViewerList(loadedStatuses);

    const seenIds = getSeenStatusIds();
    const hideViewed = getStatusPrivacy().hideViewed;
    // The Dashboard status API is photo-based. Ignore malformed own-status
    // records that do not contain actual story media; those records must not
    // turn the "My Status" tile into a broken image.
    const myStatuses = statusViewerStatuses.filter(s =>
        s.is_mine && String(s?.media_url || s?.media || "").trim()
    );
    const otherStatuses = statusViewerStatuses.filter(s => {
        if (s.is_mine) return false;
        if (isStatusMuted(s.username)) return false;
        if (hideViewed && seenIds.includes(String(s.id))) return false;
        return true;
    });
    const myNewest = myStatuses[0];

    const myAge = myNewest ? formatStatusAge(myNewest.created_at) : "Add status";
    const myAvatar = "{{ profile_picture or '/static/profile/default.png' }}";

    const statusOpenCall = myNewest
        ? `openStatusById(${escapeHtml(JSON.stringify(String(myNewest.id)))})`
        : "createStatus()";

    const myStatusVisual = myNewest
        ? `
                <div class="story-avatar-wrap">
                    <img class="status-avatar status-story-media"
                         src="${escapeHtml(myNewest.media_url || "")}"
                         alt=""
                         aria-label="My status"
                         onerror="recoverMyStatusEmptyState(this)">
                    <span class="story-profile-overlay">
                        <img src="${escapeHtml(myAvatar)}" alt="" aria-hidden="true"
                             onerror="this.src='/static/profile/default.png'">
                    </span>
                    <span class="status-add" role="button" tabindex="0" onclick="event.stopPropagation(); createStatus();" aria-label="Add a status">+</span>
                </div>
                <span class="story-badge">YOUR STORY</span>
        `
        : `
                <div class="story-avatar-wrap my-status-empty-avatar" aria-hidden="true">
                    <span class="my-status-empty-icon" aria-hidden="true"></span>
                    <span class="status-add" aria-hidden="true">+</span>
                </div>
        `;

    let html = `
        <button class="status-card story-card your-status ${myNewest ? "my-status-active has-story" : "story-card-empty"}"
                type="button"
                onclick='${statusOpenCall}'
                aria-label="${myNewest ? "Open My Status" : "Add a status"}">
            <div class="story-card-top">
                ${myStatusVisual}
            </div>
            <div class="story-card-bottom">
                <span class="status-name">My Status</span>
                <span class="status-hint" ${myNewest ? `data-status-created="${escapeHtml(myNewest.created_at)}"` : ""}>${myAge}</span>
            </div>
        </button>
    `;

    otherStatuses.forEach(status => {
        const rawId = String(status.id ?? "");
        const label = status.username || "Friend";
        const avatar = status.profile_picture || "/static/profile/default.png";
        const storyMedia = status.media_url || avatar;
        const age = formatStatusAge(status.created_at);
        const openCall = `openStatusById(${escapeHtml(JSON.stringify(rawId))})`;
        const seenClass = seenIds.includes(rawId) ? " is-seen" : " is-unseen";

        html += `
            <button class="status-card story-card has-story${seenClass}${status.is_online ? " has-live" : ""}"
                    type="button"
                    onclick='${openCall}'
                    aria-label="Open ${escapeHtml(label)} status">
                <div class="story-card-top">
                    <div class="story-avatar-wrap">
                        <img class="status-avatar status-story-media"
                             src="${escapeHtml(storyMedia)}"
                             data-fallback="${escapeHtml(avatar)}"
                             alt="${escapeHtml(label)}"
                             onerror="this.onerror=null;this.src=this.dataset.fallback">
                        <span class="story-profile-overlay">
                            <img src="${escapeHtml(avatar)}" alt="" aria-hidden="true"
                                 onerror="this.src='/static/profile/default.png'">
                        </span>
                    </div>
                    ${status.is_online ? '<span class="story-live-dot" aria-hidden="true"></span>' : ''}
                    <span class="status-live-chip">LIVE</span>
                </div>
                <div class="story-card-bottom">
                    <span class="status-name">${escapeHtml(label)}</span>
                    <span class="status-hint" data-status-created="${escapeHtml(status.created_at)}">${age}</span>
                </div>
            </button>
        `;
    });

    if (!otherStatuses.length && !myNewest) {
        html += `
            <button class="status-card story-card story-card-empty status-create-card"
                    type="button"
                    onclick="createStatus()"
                    aria-label="Create your first story">
                <div class="story-card-top">
                    <div class="story-avatar-wrap"><span class="story-create-plus">+</span></div>
                </div>
                <div class="story-card-bottom">
                    <span class="status-name">Create status</span>
                    <span class="status-hint">Share for 24h</span>
                </div>
            </button>
        `;
    }

    row.innerHTML = html;
}

function escapeHtml(value){
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function parseStatusTimestamp(value){
    if (value == null || value === "") return NaN;
    if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isFinite(ms) ? ms : NaN;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value) || value <= 0) return NaN;
        return value < 1e12 ? value * 1000 : value;
    }
    const text = String(value).trim();
    if (!text) return NaN;
    if (/^\d{10,13}$/.test(text)) {
        const num = Number(text);
        return text.length <= 10 ? num * 1000 : num;
    }
    // Frozen relative labels are not absolute times. Ignore them so a
    // cached first-seen stamp can age instead of staying "Just now".
    if (/^(just now|now|recently|viewed|liked|replied)$/i.test(text)) return NaN;

    const relative = text.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*ago$/i);
    if (relative) {
        const amount = Number(relative[1]);
        const unit = relative[2].toLowerCase();
        const ms = unit.startsWith("m") ? 60 * 1000
            : unit.startsWith("h") ? 60 * 60 * 1000
            : 24 * 60 * 60 * 1000;
        return Date.now() - (amount * ms);
    }

    const naive = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/);
    if (naive && !/(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
        const iso = naive[1] + "T" + naive[2];
        const utc = Date.parse(iso + "Z");
        const local = Date.parse(iso);
        // Prefer the reading that is not in the future (clock / TZ skew).
        if (Number.isFinite(utc) && utc > Date.now() + 120000 && Number.isFinite(local) && local <= Date.now() + 120000) {
            return local;
        }
        if (Number.isFinite(utc)) return utc;
        return local;
    }

    // Legacy status timestamps were stored as naive UTC.
    if (/^\d{4}-\d{2}-\d{2}T.*$/.test(text) && !/(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
        return Date.parse(text + "Z");
    }
    return Date.parse(text);
}

function formatStatusAge(value){
    const time = parseStatusTimestamp(value);
    if (!Number.isFinite(time)) return "Just now";

    const now = Date.now();
    const delta = Math.max(0, now - time);
    const seconds = Math.floor(delta / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    // Status 3.0 smart timing: Just now / Nm ago / Nh ago / Yesterday
    if (seconds < 60) return "Just now";
    if (minutes < 60) return minutes + "m ago";
    if (hours < 24) return hours + "h ago";

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfYesterday = new Date(startOfToday);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);
    if (time >= startOfYesterday.getTime()) return "Yesterday";

    const days = Math.floor(hours / 24);
    return days + "d ago";
}

function formatStatusRemaining(value){
    const time = parseStatusTimestamp(value);
    if (!Number.isFinite(time)) return "Disappears in 24h";

    const expiresAt = time + (24 * 60 * 60 * 1000);
    const remaining = Math.max(0, expiresAt - Date.now());
    const minutes = Math.ceil(remaining / 60000);
    const hours = Math.floor(minutes / 60);

    if (remaining <= 0) return "Expires soon";
    if (minutes < 60) return "Disappears in " + minutes + "m";
    if (hours < 24) return "Disappears in " + hours + "h";
    return "Disappears in 24h";
}

function getStatusThemeName(status){
    const raw = String(status?.theme || status?.mood || status?.style || "").toLowerCase();
    const allowed = ["default", "ocean", "forest", "space", "sunset", "aurora"];
    return allowed.includes(raw) ? raw : "default";
}

function applyStatusViewerTheme(status){
    const card = document.getElementById("statusViewerCard");
    const modal = document.getElementById("statusViewerModal");
    const theme = getStatusThemeName(status);
    const themes = ["default", "ocean", "forest", "space", "sunset", "aurora"];
    [card, modal].forEach(el => {
        if (!el) return;
        themes.forEach(name => el.classList.remove("status-theme-" + name));
        el.classList.add("status-theme-" + theme);
        el.dataset.statusTheme = theme;
    });
}

function refreshStatusAges(){
    document.querySelectorAll(".status-hint[data-status-created], #statusViewerTime[data-status-created]").forEach(el => {
        const value = el.getAttribute("data-status-created");
        el.textContent = formatStatusAge(value);
    });
    const expiry = document.getElementById("statusViewerExpiry");
    if (expiry && currentStatus?.created_at) {
        expiry.textContent = formatStatusRemaining(currentStatus.created_at);
    }
}


function buildStatusProgress(){
    const track = document.getElementById("statusProgressTrack");
    if (!track) return;

    track.innerHTML = statusViewerStatuses.map((_, index) =>
        `<span class="status-progress-segment ${index < currentStatusIndex ? "done" : ""}" data-index="${index}"><i></i></span>`
    ).join("");
}

function updateStatusProgress(){
    stopStatusProgress();
    statusProgressElapsed = 0;

    const segments = [...document.querySelectorAll(".status-progress-segment")];
    segments.forEach((segment, index) => {
        segment.classList.toggle("done", index < currentStatusIndex);
        const fill = segment.querySelector("i");
        if (fill) fill.style.width = index < currentStatusIndex ? "100%" : "0%";
    });

    const active = segments[currentStatusIndex]?.querySelector("i");
    if (!active) return;

    statusProgressStartedAt = performance.now();
    statusProgressTimer = setInterval(() => {
        if (statusPaused) return;

        const elapsed = statusProgressElapsed + (performance.now() - statusProgressStartedAt);
        const ratio = Math.min(1, elapsed / STATUS_VIEW_DURATION);
        active.style.width = `${ratio * 100}%`;

        if (ratio >= 1) {
            stopStatusProgress();
            if (currentStatusIndex < statusViewerStatuses.length - 1) {
                showAdjacentStatus(1);
            } else {
                closeStatusViewer();
            }
        }
    }, 40);
}

function updateStatusNav(){
    const prev = document.getElementById("statusPrevButton");
    const next = document.getElementById("statusNextButton");
    const counter = document.getElementById("statusViewerCounter");

    if (prev) prev.disabled = currentStatusIndex <= 0;
    if (next) next.disabled = currentStatusIndex < 0 || currentStatusIndex >= statusViewerStatuses.length - 1;

    if (counter) {
        counter.textContent =
            `${Math.max(1, currentStatusIndex + 1)} / ${Math.max(1, statusViewerStatuses.length)}`;
    }
}

function statusIdsEqual(a, b){
    if (a == null || b == null) return false;

    const left = String(a);
    const right = String(b);
    if (left === right) return true;

    const leftNumber = Number(a);
    const rightNumber = Number(b);
    return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber === rightNumber;
}

function openStatusAtIndex(index){
    const safeIndex = Number(index);
    if (!Number.isInteger(safeIndex) || safeIndex < 0 || safeIndex >= statusViewerStatuses.length) return;

    const status = statusViewerStatuses[safeIndex];
    if (!status) return;

    currentStatusIndex = safeIndex;
    currentStatus = status;
    openCurrentStatusViewer();
}

function openStatusById(id){
    const index = statusViewerStatuses.findIndex(item => statusIdsEqual(item?.id, id));
    if (index < 0) return;

    currentStatusIndex = index;
    currentStatus = statusViewerStatuses[index];
    openCurrentStatusViewer();
}

function openCurrentStatusViewer(){
    if (!currentStatus) return;

    closeStatusReactionPicker(false);
    statusPaused = false;
    document.getElementById("statusViewerCard")?.classList.remove("status-holding");

    document.getElementById("statusViewerName").textContent =
        currentStatus.is_mine ? "My Status" : (currentStatus.username || "Status");

    applyStatusViewerTheme(currentStatus);

    const statusTimeEl = document.getElementById("statusViewerTime");
    if (statusTimeEl) {
        statusTimeEl.textContent = formatStatusAge(currentStatus.created_at);
        statusTimeEl.setAttribute("data-status-created", currentStatus.created_at);
    }
    const expiryEl = document.getElementById("statusViewerExpiry");
    if (expiryEl) {
        expiryEl.textContent = formatStatusRemaining(currentStatus.created_at);
    }

    const stage = document.getElementById("statusStage30");
    const mediaUrl = currentStatus.media_url || "/static/profile/default.png";
    const viewerImage = document.getElementById("statusViewerImage");
    const mediaShell = viewerImage?.closest(".status-media-shell");

    if (!viewerImage) return;

    if (mediaShell) {
        mediaShell.classList.remove("is-portrait","is-landscape","is-square");
        mediaShell.style.removeProperty("--status-media-ratio");
        mediaShell.style.removeProperty("--status-media-w");
        mediaShell.style.removeProperty("--status-media-h");
    }

    // Clear the old source before assigning the new one so a fast status switch
    // cannot visually retain the previous photo during decoding.
    viewerImage.onload = null;
    viewerImage.onerror = null;
    viewerImage.removeAttribute("src");
    viewerImage.src = mediaUrl;

    viewerImage.onload = () => {
        if (!mediaShell || !viewerImage.naturalWidth || !viewerImage.naturalHeight) return;

        const ratio = viewerImage.naturalWidth / viewerImage.naturalHeight;
        mediaShell.classList.add(
            ratio < 0.82 ? "is-portrait" :
            ratio > 1.18 ? "is-landscape" : "is-square"
        );
        mediaShell.style.setProperty("--status-media-ratio", ratio.toFixed(4));

        requestAnimationFrame(() => {
            if (mediaShell && mediaShell.isConnected) {
                mediaShell.style.setProperty(
                    "--status-media-w",
                    Math.round(mediaShell.getBoundingClientRect().width) + "px"
                );
            }
        });
    };

    viewerImage.onerror = () => {
        viewerImage.src = "/static/profile/default.png";
    };

    if (stage) {
        stage.style.setProperty(
            "--status-stage-image",
            `url("${String(mediaUrl).replace(/"/g, '\\"')}")`
        );
    }

    document.getElementById("statusViewerText").textContent = currentStatus.text || "";

    const avatar = document.getElementById("statusViewerAvatar");
    if (avatar) {
        avatar.src = currentStatus.is_mine
            ? ("{{ profile_picture or '/static/profile/default.png' }}")
            : (currentStatus.profile_picture || "/static/profile/default.png");
    }

    const deleteButton = document.getElementById("statusDeleteBtn");
    if (deleteButton) deleteButton.style.display = currentStatus.is_mine ? "flex" : "none";

    const viewerCardEl = document.getElementById("statusViewerCard");
    if (viewerCardEl) {
        viewerCardEl.classList.toggle("status-own", !!currentStatus.is_mine);
        viewerCardEl.classList.remove("sheet-open");
    }
    closeStatusSheets();
    markStatusSeen(currentStatus.id);

    const swipeLabel = document.getElementById("statusSwipeUpLabel");
    if (swipeLabel) {
        swipeLabel.textContent = currentStatus.is_mine ? "Pull up for viewers" : "Swipe up to reply";
    }

    const reactionButton = document.getElementById("statusReactionButton");
    if (reactionButton) {
        reactionButton.style.display = currentStatus.is_mine ? "none" : "flex";
        if (currentStatus.is_mine) {
            closeStatusReactionPicker();
            paintStatusEmojiReaction("");
        } else {
            paintStatusEmojiReaction(getStoredStatusEmojiReaction(currentStatus.id));
        }
    }

    const heartButton = document.getElementById("statusHeartButton");
    if (heartButton) {
        heartButton.style.display = currentStatus.is_mine ? "none" : "flex";
        heartButton.classList.remove("liked","pop");

        // Persist the user's last deliberate reaction (both like AND unlike).
        // This prevents an engagement response with incomplete/stale liker data
        // from silently resetting the heart when the same status is reopened.
        const openedStatusId = getStatusReactionId(currentStatus);
        const storedReaction = getStoredStatusReaction(openedStatusId);
        paintStatusHeart(heartButton, storedReaction === true);

        if (!heartButton.querySelector("svg")) {
            heartButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.8 8.6c0 5.2-8.8 11-8.8 11S3.2 13.8 3.2 8.6A4.6 4.6 0 0 1 12 6.7a4.6 4.6 0 0 1 8.8 1.9z"></path></svg>';
        }

        if (!currentStatus.is_mine) {
            paintStatusEmojiReaction(getStoredStatusEmojiReaction(currentStatus.id));
            void syncStatusEmojiReactionFromServer(currentStatus);

            const openedStatus = currentStatus;

            void fetchStatusViewers(openedStatus).then(result => {
                // Do not let a late response for an older story overwrite the
                // currently visible story or a deliberate like/unlike tap.
                if (!currentStatus) return;
                if (getStatusReactionId(currentStatus) !== openedStatusId) return;
                if (!result?.fromApi) return;

                const ownKey = String(CURRENT_DASHBOARD_USER || "").trim().toLowerCase();
                const likers = Array.isArray(result.likers) ? result.likers : [];
                const serverIncludesOwnLike = likers.some(person =>
                    String(person?.username || person?.user || "")
                        .trim()
                        .toLowerCase() === ownKey
                );

                // Some server responses expose the current user's state
                // directly. When that explicit boolean exists, it is safe to
                // reconcile both directions. Otherwise, do NOT interpret
                // "my username is absent from likers" as an unlike: older
                // engagement endpoints may omit the current user from that
                // list even though the like is stored successfully.
                const raw = result.raw;
                const explicitCandidates = [
                    raw?.liked_by_me,
                    raw?.likedByMe,
                    raw?.is_liked,
                    raw?.isLiked,
                    raw?.user_liked,
                    raw?.userLiked,
                    raw?.my_like,
                    raw?.myLike,
                    raw?.viewer_liked,
                    raw?.viewerLiked,
                    raw?.current_user?.liked,
                    raw?.currentUser?.liked,
                    raw?.viewer?.liked,
                    raw?.you?.liked
                ];
                explicitCandidates.push(
                    raw?.liked,
                    raw?.like,
                    raw?.reacted,
                    raw?.reaction?.liked,
                    raw?.engagement?.liked_by_me,
                    raw?.engagement?.likedByMe,
                    raw?.engagement?.is_liked
                );
                const explicitLike = explicitCandidates.find(value => typeof value === "boolean");

                // A deliberate local reaction is authoritative for this browser
                // session. Only use the server result when no local state exists.
                const latestLocalReaction = getStoredStatusReaction(openedStatusId);
                if (latestLocalReaction !== null) {
                    paintStatusHeart(heartButton, latestLocalReaction);
                    return;
                }

                if (explicitLike !== undefined) {
                    rememberStatusReaction(openedStatusId, explicitLike);
                    rememberStatusLike(openedStatusId, explicitLike);
                    paintStatusHeart(heartButton, explicitLike);
                    return;
                }

                if (serverIncludesOwnLike) {
                    rememberStatusReaction(openedStatusId, true);
                    rememberStatusLike(openedStatusId, true);
                    paintStatusHeart(heartButton, true);
                } else {
                    // No server confirmation and no local decision: remain unliked.
                    paintStatusHeart(heartButton, false);
                }
            }).catch(() => {
                // Keep the locally persisted like state when the engagement
                // request cannot confirm the current user's state.
                const latestLocalReaction = getStoredStatusReaction(openedStatusId);
                paintStatusHeart(heartButton, latestLocalReaction === true);
            });
        }
    }

    const menuDeleteButton = document.getElementById("statusMenuDeleteBtn");
    if (menuDeleteButton) {
        menuDeleteButton.hidden = !currentStatus.is_mine;
        menuDeleteButton.style.display = "";
    }

    const replyRow = document.getElementById("statusReplyRow");
    const replyForm = document.getElementById("statusInlineReplyForm");
    const replyInput = document.getElementById("statusReplyText");
    if (replyRow) replyRow.style.display = currentStatus.is_mine ? "none" : "flex";
    if (replyForm) replyForm.style.display = currentStatus.is_mine ? "none" : "flex";
    if (replyInput) {
        replyInput.value = "";
        replyInput.placeholder = currentStatus.is_mine
            ? "Your status"
            : `Reply privately to ${statusOwnerName(currentStatus)}…`;
        replyInput.disabled = !!currentStatus.is_mine;
    }

    const replyMenuButton = document.getElementById("statusReplyMenuBtn");
    if (replyMenuButton) {
        replyMenuButton.hidden = !!currentStatus.is_mine;
        replyMenuButton.style.display = "";
    }

    const muteMenuButton = document.getElementById("statusMuteMenuBtn");
    if (muteMenuButton) {
        muteMenuButton.hidden = !!currentStatus.is_mine;
        muteMenuButton.style.display = "";
    }

    updateStatusMuteButton();
    paintViewersFab(extractStatusViewers(currentStatus), extractStatusEngagement(currentStatus, extractStatusViewers(currentStatus)).views);
    if (currentStatus.is_mine) {
        fetchStatusViewers(currentStatus).then(result => {
            if (!currentStatus?.is_mine) return;
            const viewers = result.viewers || [];
            const engagement = extractStatusEngagement(result.raw || currentStatus, viewers);
            paintViewersFab(viewers, engagement.views);
        }).catch(() => {});
    } else {
        recordStatusView(currentStatus);
    }
    buildStatusProgress();
    updateStatusNav();

    const modal = document.getElementById("statusViewerModal");
    if (!modal) return;

    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    updateStatusProgress();

    if (!statusAgeRefreshTimer) {
        statusAgeRefreshTimer = setInterval(() => {
            if (!document.hidden && currentStatus) refreshStatusAges();
        }, 4000);
    }
}

function showAdjacentStatus(direction){
    if (!statusViewerStatuses.length) return;

    const nextIndex = currentStatusIndex + direction;
    if (nextIndex < 0 || nextIndex >= statusViewerStatuses.length) return;

    openStatusById(statusViewerStatuses[nextIndex].id);
}

function openStatusPage(){
    if (!statusViewerStatuses.length) {
        createStatus();
        return;
    }

    openStatusAtIndex(0);
}

async function fetchStatusMediaBlob(status){
    const mediaUrl = status?.media_url;
    if (!mediaUrl) throw new Error("No photo to save");
    const absolute = new URL(mediaUrl, location.href).href;
    const response = await fetch(absolute, { credentials:"same-origin", cache:"no-store" });
    if (!response.ok) throw new Error("Could not download photo");
    const blob = await response.blob();
    if (!blob || !blob.size) throw new Error("Photo was empty");
    return { blob, absolute, type: blob.type || "image/jpeg" };
}

function triggerBlobDownload(blob, filename){
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "lucky-chat-status.jpg";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function downloadCurrentStatus(){
    if (!currentStatus?.media_url) {
        showStatusToast("This status has no photo to save", true);
        return;
    }
    try {
        const { blob } = await fetchStatusMediaBlob(currentStatus);
        triggerBlobDownload(blob, `lucky-chat-status-${currentStatus.id || "photo"}.jpg`);
        showStatusToast("Saved to gallery");
    } catch (error) {
        try {
            const link = new URL(currentStatus.media_url, location.href).href;
            const a = document.createElement("a");
            a.href = link;
            a.download = `lucky-chat-status-${currentStatus.id || "photo"}.jpg`;
            a.target = "_blank";
            a.rel = "noopener";
            document.body.appendChild(a);
            a.click();
            a.remove();
            showStatusToast("Opening photo so you can save it");
        } catch (_error) {
            window.open(currentStatus.media_url, "_blank", "noopener");
            showStatusToast("Opening photo so you can save it");
        }
    }
}

async function shareCurrentStatus(){
    if (!currentStatus) return;
    const title = currentStatus.is_mine
        ? "My Lucky Chat status"
        : `${statusOwnerName(currentStatus)} status`;
    const text = currentStatus.text || title;
    const pageUrl = new URL(currentStatus.media_url || location.href, location.href).href;

    try {
        const { blob, type } = await fetchStatusMediaBlob(currentStatus);
        const extension = (type.split("/")[1] || "jpg").replace("jpeg", "jpg");
        const file = new File([blob], `lucky-chat-status.${extension}`, { type });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ title, text, files: [file] });
            showStatusToast("Shared");
            return;
        }
    } catch (error) {
        if (error?.name === "AbortError") return;
    }

    try {
        if (navigator.share) {
            await navigator.share({ title, text, url: pageUrl });
            showStatusToast("Shared");
            return;
        }
    } catch (error) {
        if (error?.name === "AbortError") return;
    }

    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(pageUrl);
            showStatusToast("Status link copied");
            return;
        }
    } catch (_error) {}

    openStatusForwardSheet();
    showStatusToast("Use Forward to send this status");
}

let statusDeleteConfirmResolver = null;

function closeStatusDeleteConfirm(result = false){
    const overlay = document.getElementById("statusDeleteConfirmOverlay");
    if (!overlay) {
        const resolver = statusDeleteConfirmResolver;
        statusDeleteConfirmResolver = null;
        if (resolver) resolver(result);
        return;
    }

    overlay.hidden = true;
    overlay.setAttribute("aria-hidden", "true");

    const resolver = statusDeleteConfirmResolver;
    statusDeleteConfirmResolver = null;

    if (resolver) resolver(result);
}

function showStatusDeleteConfirm(){
    const overlay = document.getElementById("statusDeleteConfirmOverlay");
    const cancelButton = document.getElementById("statusDeleteConfirmCancel");
    const deleteButton = document.getElementById("statusDeleteConfirmDelete");

    if (!overlay || !cancelButton || !deleteButton) {
        return Promise.resolve(false);
    }

    overlay.hidden = false;
    overlay.setAttribute("aria-hidden", "false");

    return new Promise(resolve => {
        statusDeleteConfirmResolver = resolve;

        const onKeydown = event => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            finish(false);
        };

        const cleanup = () => {
            document.removeEventListener("keydown", onKeydown);
        };

        const finish = value => {
            if (statusDeleteConfirmResolver !== resolve) return;
            cleanup();
            cancelButton.onclick = null;
            deleteButton.onclick = null;
            overlay.onclick = null;
            closeStatusDeleteConfirm(value);
        };

        cancelButton.onclick = () => finish(false);
        deleteButton.onclick = () => finish(true);

        overlay.onclick = event => {
            if (event.target === overlay) finish(false);
        };

        document.addEventListener("keydown", onKeydown);

        requestAnimationFrame(() => {
            if (!overlay.hidden) cancelButton.focus();
        });
    });
}

async function deleteCurrentStatus(){
    closeStatusMenu();
    if (!currentStatus || !currentStatus.is_mine) return;

    const confirmed = await showStatusDeleteConfirm();
    if (!confirmed) return;

    const statusId = currentStatus.id;
    const button = document.getElementById("statusDeleteBtn");
    if (button) button.disabled = true;

    const attempts = [
        { url: "/statuses/" + encodeURIComponent(statusId), method: "DELETE" },
        { url: "/status/" + encodeURIComponent(statusId), method: "DELETE" },
        { url: "/delete-status/" + encodeURIComponent(statusId), method: "POST" },
        { url: "/delete-status", method: "POST", body: { id: statusId, status_id: statusId } },
        { url: "/statuses/" + encodeURIComponent(statusId) + "/delete", method: "POST" }
    ];

    let deleted = false;
    let lastError = "Could not delete status";

    try {
        for (const attempt of attempts) {
            try {
                const res = await fetch(attempt.url, {
                    method: attempt.method,
                    credentials: "same-origin",
                    headers: attempt.body ? { "Content-Type": "application/json" } : undefined,
                    body: attempt.body ? JSON.stringify(attempt.body) : undefined
                });
                if (!res.ok) continue;
                const contentType = res.headers.get("content-type") || "";
                if (contentType.includes("application/json")) {
                    const data = await res.json().catch(() => ({}));
                    if (data && data.success === false) {
                        lastError = data.error || lastError;
                        continue;
                    }
                }
                deleted = true;
                break;
            } catch (error) {
                lastError = error.message || lastError;
            }
        }

        if (!deleted) throw new Error(lastError);

        loadedStatuses = loadedStatuses.filter(item => !statusIdsEqual(item?.id, statusId));
        closeStatusViewer();
        showStatusToast("Status deleted");
        await loadStatuses();
    } catch (error) {
        showStatusToast(error.message || "Could not delete status.", true);
    } finally {
        if (button) button.disabled = false;
    }
}



function scheduleDashboardReconnect() {
    if (dashboardPageUnloading || dashboardSessionExpired) return;
    if (document.hidden || (typeof navigator !== "undefined" && navigator.onLine === false)) return;

    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
        connectDashboardSocket();
    }, dashboardWsBackoffMs);
    dashboardWsBackoffMs = Math.min(
        DASHBOARD_WS_MAX_BACKOFF_MS,
        Math.max(1000, Math.floor(dashboardWsBackoffMs * 1.8))
    );
}

function connectDashboardSocket() {

    if (dashboardPageUnloading || dashboardSessionExpired) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;

    if (
        dashboardSocket &&
        (
            dashboardSocket.readyState === WebSocket.OPEN ||
            dashboardSocket.readyState === WebSocket.CONNECTING
        )
    ) {
        return;
    }

    dashboardSocket = new WebSocket(
    (location.protocol === "https:" ? "wss://" : "ws://") +
    location.host +
    "/dashboard_ws"
);

    dashboardSocket.onopen = () => {
        dashboardWsBackoffMs = 1000;
        console.log("Dashboard WebSocket connected");
    };

    dashboardSocket.onmessage = (event) => {

        console.log("DASHBOARD EVENT:", event.data);

        try {
            const data = JSON.parse(event.data);

            if (data.type === "dashboard_update") {
                refreshDashboard();
            }

            if (data.type === "hidden_user_update") {
                const hiddenUsername = String(data.username || data.user || "").trim();
                if (hiddenUsername) {
                    const nextHidden = !!data.hidden;
                    const current = getHiddenUsers().filter(name => String(name).trim().toLowerCase() !== hiddenUsername.toLowerCase());
                    serverHiddenUsers = nextHidden ? [...current, hiddenUsername] : current;
                    saveHiddenUsers(serverHiddenUsers);
                    if (nextHidden) removeHiddenChatRow(hiddenUsername);
                    else void refreshDashboard();
                }
            }

            if (data.type === "block_status_update") {
                const blockedUsername = String(data.username || data.user || "").trim();
                if (blockedUsername) {
                    if (data.blocked_by_me) {
                        const current = getBlockedUsers().filter(
                            name => String(name).trim().toLowerCase() !== blockedUsername.toLowerCase()
                        );
                        serverBlockedUsers = data.blocked
                            ? [...current, blockedUsername]
                            : current;
                        saveBlockedUsers(serverBlockedUsers);
                    }

                    if (data.blocked) {
                        // Remove the now-private owner's statuses immediately so
                        // an already-rendered shelf cannot continue to expose a
                        // status while the authoritative refresh is in flight.
                        invalidateStatusesForBlockedUser(blockedUsername);

                        if (
                            currentStatus &&
                            !currentStatus.is_mine &&
                            String(currentStatus.username || "").trim().toLowerCase() === blockedUsername.toLowerCase()
                        ) {
                            closeStatusViewer();
                        }
                    }

                    // Force a fresh server-side audience evaluation. This also
                    // handles unblock events and defeats any in-flight response
                    // created before the privacy change.
                    void loadStatuses(true);
                }
            }

            if (data.type === "status_update" || data.type === "new_status" || data.type === "status") {
                loadStatuses();
                const who = data.username || data.user || data.status?.username;
                if (who && String(who) !== "{{ username }}") {
                    showStatusToast(who + " added a new status");
                }
            }

            if (
                data.type === "status_view" ||
                data.type === "status_seen" ||
                data.type === "status_viewed" ||
                data.type === "status_like" ||
                data.type === "status_unlike" ||
                data.type === "status_reaction" ||
                data.type === "status_reply"
            ) {
                const statusId =
                    data.status_id ||
                    data.id ||
                    data.status?.id;

                if (
                    currentStatus?.is_mine &&
                    statusId &&
                    statusIdsEqual(currentStatus.id, statusId)
                ) {
                    const actorName = data.username || data.user ||
                        data.viewer || data.liker || data.actor ||
                        data.status?.username;
                    // The owner panel re-fetches authoritative engagement below.
                    // Do not seed the local liker cache from a server event here.
                    if (actorName && (data.type === "status_view" || data.type === "status_seen" || data.type === "status_viewed")) {
                        rememberStatusPersonTimes(statusId, { username: actorName }, {
                            seen_at: data.seen_at || data.timestamp || Date.now()
                        });
                    } else if (actorName && data.type === "status_reaction" && data.reaction) {
                        rememberStatusPersonTimes(statusId, { username: actorName }, {
                            reacted_at: data.timestamp || Date.now()
                        });
                    }
                    fetchStatusViewers(currentStatus)
                        .then(result => {
                            if (!currentStatus?.is_mine) return;

                            const viewers =
                                Array.isArray(result.viewers)
                                    ? result.viewers
                                    : [];

                            paintViewersFab(
                                viewers,
                                Number(result.views) || viewers.length
                            );

                            const sheet =
                                document.getElementById(
                                    "statusViewersSheet"
                                );

                            if (sheet?.classList.contains("open")) {
                                openStatusViewersSheet();
                            }
                        })
                        .catch(() => {});
                }
            }

        } catch (error) {
            console.error("Dashboard message error:", error);
        }
    };

    dashboardSocket.onerror = (error) => {
        console.error("Dashboard WebSocket error:", error);
    };

    dashboardSocket.onclose = () => {
        if (dashboardPageUnloading || dashboardSessionExpired) return;
        console.log("Dashboard WebSocket closed. Reconnecting...");
        scheduleDashboardReconnect();
    };
}

function startDashboardTimers() {
    if (!onlineUsersTimer) {
        onlineUsersTimer = setInterval(updateOnlineUsers, DASHBOARD_ONLINE_POLL_MS);
    }
    if (!dashboardPingTimer) {
        dashboardPingTimer = setInterval(() => {
            if (document.hidden || dashboardSessionExpired) return;
            if (dashboardSocket && dashboardSocket.readyState === WebSocket.OPEN) {
                dashboardSocket.send("ping");
            }
        }, 15000);
    }
    if (!dashboardRefreshTimer) {
        dashboardRefreshTimer = setInterval(() => {
            if (document.hidden || dashboardSessionExpired) return;
            refreshDashboard();
        }, 10000);
    }
    if (!statusShelfTimer) {
        statusShelfTimer = setInterval(() => {
            if (document.hidden || dashboardSessionExpired) return;
            if (document.getElementById("statusRow")) renderStatuses();
            if (currentStatus) refreshStatusAges();
        }, 8000);
    }
}

function resumeDashboardNetwork() {
    if (dashboardSessionExpired || dashboardPageUnloading) return;
    connectDashboardSocket();
    void updateOnlineUsers();
    void refreshDashboard();
    void loadStatuses();
}

window.addEventListener("pagehide", (event) => {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    dashboardPageUnloading = !event.persisted;
    try { dashboardSocket?.close(); } catch (_error) {}
});

window.addEventListener("pageshow", (event) => {
    if (dashboardSessionExpired) return;
    dashboardPageUnloading = false;
    if (event.persisted) resumeDashboardNetwork();
});

document.addEventListener("visibilitychange", () => {
    if (document.hidden || dashboardSessionExpired) return;
    connectDashboardSocket();
    void updateOnlineUsers();
});

window.addEventListener("online", resumeDashboardNetwork);

// The dashboard is server-rendered, so let that UI paint first. Network work
// starts on the next animation frame instead of competing with initial layout.
requestAnimationFrame(() => {
    setTimeout(() => {
        if (dashboardPageUnloading || dashboardSessionExpired) return;
        connectDashboardSocket();
        startDashboardTimers();
        void loadServerPinnedChats();
        void loadServerHiddenUsers();
        void loadServerBlockedUsers();
        void refreshDashboard();
    }, 0);
});

function getChatTimestamp(value) {
    if (!value) return 0;

    const text = String(value).trim();

    // Full ISO/server timestamps. JavaScript treats timezone-less ISO values
    // as local time; explicit Z/offset values are converted from that offset.
    const full = Date.parse(text);
    if (!Number.isNaN(full)) return full;

    // HH:MM timestamps used by the dashboard.
    const match = text.match(/(\\d{1,2}):(\\d{2})/);
    if (match) {
        const now = new Date();
        const d = new Date(now);
        d.setHours(Number(match[1]), Number(match[2]), 0, 0);

        // If the time appears to be from yesterday, account for that.
        if (d.getTime() > now.getTime() + 5 * 60 * 1000) {
            d.setDate(d.getDate() - 1);
        }

        return d.getTime();
    }

    return 0;
}

function formatDashboardTime(value) {
    if (!value) return "";

    const raw = String(value).trim();

    // Old dashboard values such as "10:10 PM"
    if (/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(raw)) {
        return raw;
    }

    // New ISO/UTC timestamps
    const date = new Date(raw);

    if (!Number.isNaN(date.getTime())) {
        return date.toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
            hour12: true
        });
    }

    return raw;
}

const PINNED_CHATS_KEY = "lucky_chat_pinned_chats";
let serverPinnedChats = null;

const HIDDEN_USERS_KEY = "lucky_chat_hidden_users_v1";
let serverHiddenUsers = null;
let hiddenUserMutationPromises = new Map();

const BLOCKED_USERS_KEY = "lucky_chat_blocked_users_v1";
let serverBlockedUsers = null;
let blockedUserMutationPromises = new Map();

function getBlockedUsersStorageKey(){
    const username = String(CURRENT_DASHBOARD_USER || "").trim() || "anonymous";
    return `${BLOCKED_USERS_KEY}:${username}`;
}

function getHiddenUsersStorageKey(){
    const username = String(CURRENT_DASHBOARD_USER || "").trim() || "anonymous";
    return `${HIDDEN_USERS_KEY}:${username}`;
}

function getLocalPinnedChats(){
    try{
        const value = JSON.parse(localStorage.getItem(PINNED_CHATS_KEY) || "[]");
        return Array.isArray(value) ? value : [];
    }catch(e){ return []; }
}

function getPinnedChats(){
    return Array.isArray(serverPinnedChats)
        ? serverPinnedChats
        : getLocalPinnedChats();
}

function savePinnedChats(list){
    localStorage.setItem(PINNED_CHATS_KEY, JSON.stringify(list));
}

async function loadServerPinnedChats(){
    try{
        const res = await fetch("/pinned-chats", { credentials:"same-origin", cache:"no-store" });
        if (handleDashboardAuthFailure(res.status)) return;
        if(!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        if(data.success && Array.isArray(data.pinned)){
            serverPinnedChats = data.pinned;
            savePinnedChats(serverPinnedChats);
            return;
        }
    }catch(e){
        console.debug("Server pinned chats unavailable; using local cache:", e);
    }

    serverPinnedChats = getLocalPinnedChats();
}

function isPinned(username){
    return getPinnedChats().includes(username);
}

async function togglePinnedChat(username){
    const pinned = [...getPinnedChats()];
    const alreadyPinned = pinned.includes(username);
    const next = alreadyPinned
        ? pinned.filter(name => name !== username)
        : [username, ...pinned];

    // Update immediately so the UI feels instant.
    serverPinnedChats = next;
    savePinnedChats(next);
    refreshDashboard();

    try{
        const res = await fetch("/pinned-chats", {
            method:"POST",
            credentials:"same-origin",
            cache:"no-store",
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({friend:username, pinned:!alreadyPinned})
        });

        if (handleDashboardAuthFailure(res.status)) return;
        if(!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();

        if(data.success && Array.isArray(data.pinned)){
            serverPinnedChats = data.pinned;
            savePinnedChats(serverPinnedChats);
            refreshDashboard();
        }
    }catch(e){
        console.debug("Could not persist pinned chat on server:", e);
    }
}


function getLocalHiddenUsers(){
    try{
        const value = JSON.parse(localStorage.getItem(getHiddenUsersStorageKey()) || "[]");
        return Array.isArray(value)
            ? [...new Set(value.map(item => String(item || "").trim()).filter(Boolean))]
            : [];
    }catch(_error){
        return [];
    }
}

function saveHiddenUsers(list){
    const normalized = Array.isArray(list)
        ? [...new Set(list.map(item => String(item || "").trim()).filter(Boolean))]
        : [];
    localStorage.setItem(getHiddenUsersStorageKey(), JSON.stringify(normalized));
}

function getHiddenUsers(){
    return Array.isArray(serverHiddenUsers)
        ? serverHiddenUsers
        : getLocalHiddenUsers();
}

function isUserHidden(username){
    const target = String(username || "").trim().toLowerCase();
    if (!target) return false;
    return getHiddenUsers().some(name => String(name || "").trim().toLowerCase() === target);
}

function removeHiddenChatRow(username){
    const target = String(username || "").trim().toLowerCase();
    if (!target) return;
    document.querySelectorAll(".chat-list .chat-item[data-username]").forEach(item => {
        if (String(item.getAttribute("data-username") || "").trim().toLowerCase() === target) {
            item.remove();
        }
    });
}

async function loadServerHiddenUsers(){
    try{
        const res = await fetch("/hidden-users", { credentials:"same-origin", cache:"no-store" });
        if (handleDashboardAuthFailure(res.status)) return;
        if(!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        if(data.success && Array.isArray(data.hidden)){
            const previous = getHiddenUsers();
            serverHiddenUsers = data.hidden
                .map(item => String(item?.username || item || "").trim())
                .filter(Boolean);
            saveHiddenUsers(serverHiddenUsers);
            const before = JSON.stringify(previous.map(name => String(name).trim().toLowerCase()).sort());
            const after = JSON.stringify(serverHiddenUsers.map(name => String(name).trim().toLowerCase()).sort());
            if (before !== after) void refreshDashboard();
            return serverHiddenUsers;
        }
        throw new Error(data.error || "Hidden-user list unavailable");
    }catch(e){
        console.debug("Server hidden-user list unavailable; using local cache:", e);
    }

    serverHiddenUsers = getLocalHiddenUsers();
    return serverHiddenUsers;
}

function getLocalBlockedUsers(){
    try{
        const value = JSON.parse(localStorage.getItem(getBlockedUsersStorageKey()) || "[]");
        return Array.isArray(value)
            ? [...new Set(value.map(item => String(item || "").trim()).filter(Boolean))]
            : [];
    }catch(_error){
        return [];
    }
}

function saveBlockedUsers(list){
    const normalized = Array.isArray(list)
        ? [...new Set(list.map(item => String(item || "").trim()).filter(Boolean))]
        : [];
    localStorage.setItem(getBlockedUsersStorageKey(), JSON.stringify(normalized));
}

function getBlockedUsers(){
    return Array.isArray(serverBlockedUsers)
        ? serverBlockedUsers
        : getLocalBlockedUsers();
}

function isUserBlocked(username){
    const target = String(username || "").trim().toLowerCase();
    if (!target) return false;
    return getBlockedUsers().some(
        name => String(name || "").trim().toLowerCase() === target
    );
}

async function loadServerBlockedUsers(){
    try{
        const res = await fetch("/blocked-users", {
            credentials:"same-origin",
            cache:"no-store"
        });
        if (handleDashboardAuthFailure(res.status)) return;
        if(!res.ok) throw new Error("HTTP " + res.status);

        const data = await res.json();
        if(data.success && Array.isArray(data.blocked)){
            serverBlockedUsers = data.blocked
                .map(item => String(item?.username || item || "").trim())
                .filter(Boolean);
            saveBlockedUsers(serverBlockedUsers);
            return serverBlockedUsers;
        }
        throw new Error(data.error || "Blocked-user list unavailable");
    }catch(e){
        console.debug("Server blocked-user list unavailable; using local cache:", e);
    }

    serverBlockedUsers = getLocalBlockedUsers();
    return serverBlockedUsers;
}

function closeBlockedUsers(){
    const overlay = document.getElementById("blockedUsersOverlay");
    if (overlay) overlay.remove();
}

function renderBlockedUsersList(items){
    const list = document.getElementById("blockedUsersList");
    if (!list) return;

    const rows = Array.isArray(items) ? items : [];
    list.innerHTML = "";

    if (!rows.length) {
        const empty = document.createElement("div");
        empty.className = "blocked-users-empty";
        empty.innerHTML = "<b>No blocked users</b><small>Users you block will appear here.</small>";
        list.appendChild(empty);
        return;
    }

    rows.forEach(item => {
        const target = String(item?.username || "").trim();
        if (!target) return;

        const displayName = String(item?.display_name || target);
        const profile = String(item?.profile || "/static/profile/default.png");

        const row = document.createElement("div");
        row.className = "blocked-user-row";

        const image = document.createElement("img");
        image.className = "blocked-user-avatar";
        image.src = profile;
        image.alt = "";
        image.onerror = () => { image.src = "/static/profile/default.png"; };

        const info = document.createElement("div");
        info.className = "blocked-user-info";

        const name = document.createElement("b");
        name.textContent = displayName;

        const handle = document.createElement("small");
        handle.textContent = "@" + target;
        info.append(name, handle);

        const button = document.createElement("button");
        button.type = "button";
        button.className = "blocked-user-unblock";
        button.textContent = "Unblock";
        button.addEventListener("click", async () => {
            await toggleBlockedUser(target, false);
            if (!isUserBlocked(target)) await loadBlockedUsersForDialog();
        });

        row.append(image, info, button);
        list.appendChild(row);
    });
}

async function loadBlockedUsersForDialog(){
    const list = document.getElementById("blockedUsersList");
    if (list) {
        list.innerHTML = '<div class="blocked-users-loading">Loading blocked users…</div>';
    }

    try{
        const res = await fetch("/blocked-users", {
            credentials:"same-origin",
            cache:"no-store"
        });
        if (handleDashboardAuthFailure(res.status)) return;
        if(!res.ok) throw new Error("HTTP " + res.status);

        const data = await res.json();
        if(!data.success || !Array.isArray(data.blocked)){
            throw new Error(data.error || "Blocked-user list failed");
        }

        serverBlockedUsers = data.blocked
            .map(item => String(item?.username || "").trim())
            .filter(Boolean);
        saveBlockedUsers(serverBlockedUsers);
        renderBlockedUsersList(data.blocked);
        return;
    }catch(e){
        console.debug("Could not load blocked users dialog:", e);
    }

    const fallback = getBlockedUsers().map(username => ({
        username,
        display_name: username,
        profile: "/static/profile/default.png"
    }));
    renderBlockedUsersList(fallback);
}

let blockUserConfirmResolver = null;
let blockUserConfirmKey = "";
let blockUserConfirmEscapeHandler = null;
let blockUserConfirmDelegationInstalled = false;
let blockUserConfirmActionLock = false;

function installBlockUserConfirmDelegation(){
    if (blockUserConfirmDelegationInstalled) return;
    blockUserConfirmDelegationInstalled = true;

    const handleAction = event => {
        const overlay = document.getElementById("blockUserConfirmOverlay");
        if (!overlay || overlay.hasAttribute("hidden")) return;

        const target = event.target instanceof Element
            ? event.target.closest("#blockUserConfirmCancel, #blockUserConfirmPrimary")
            : null;
        if (!target || !overlay.contains(target)) return;

        // Handle touch/pointer actions at document capture level so another
        // ancestor handler cannot swallow the modal button interaction.
        if (event.type === "click" && blockUserConfirmActionLock) return;
        if (event.type !== "click") blockUserConfirmActionLock = true;

        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") {
            event.stopImmediatePropagation();
        }

        closeBlockUserConfirm(target.id === "blockUserConfirmPrimary");

        if (event.type !== "click") {
            setTimeout(() => { blockUserConfirmActionLock = false; }, 0);
        } else {
            blockUserConfirmActionLock = false;
        }
    };

    document.addEventListener("pointerup", handleAction, true);
    document.addEventListener("touchend", handleAction, true);
    document.addEventListener("click", handleAction, true);
}

function closeBlockUserConfirm(result = false){
    const overlay = document.getElementById("blockUserConfirmOverlay");

    if (blockUserConfirmEscapeHandler) {
        document.removeEventListener("keydown", blockUserConfirmEscapeHandler, true);
        blockUserConfirmEscapeHandler = null;
    }

    if (overlay) {
        overlay.classList.remove("open");
        overlay.setAttribute("aria-hidden", "true");
        overlay.setAttribute("hidden", "");
    }

    const resolver = blockUserConfirmResolver;
    blockUserConfirmResolver = null;
    blockUserConfirmKey = "";
    if (typeof resolver === "function") resolver(!!result);
}

function openBlockUserConfirm(username){
    const target = String(username || "").trim();
    if (!target) return Promise.resolve(false);

    const existing = document.getElementById("blockUserConfirmOverlay");
    if (!existing) return Promise.resolve(false);

    if (blockUserConfirmResolver) {
        if (blockUserConfirmKey === target.toLowerCase()) {
            return new Promise(resolve => {
                const previous = blockUserConfirmResolver;
                blockUserConfirmResolver = value => {
                    try { previous(value); } finally { resolve(!!value); }
                };
            });
        }
        closeBlockUserConfirm(false);
    }

    const meta = getHideUserDisplayMeta(target);
    const avatar = document.getElementById("blockUserConfirmAvatar");
    const name = document.getElementById("blockUserConfirmName");
    const handle = document.getElementById("blockUserConfirmHandle");
    const cancel = document.getElementById("blockUserConfirmCancel");
    const primary = document.getElementById("blockUserConfirmPrimary");

    // The Block User dialog is rendered as static HTML. Bind the controls here
    // instead of relying on inline HTML handlers, and assign through .onclick so
    // reopening the dialog never stacks duplicate listeners.
    if (cancel) {
        cancel.onclick = event => {
            event.preventDefault();
            event.stopPropagation();
            closeBlockUserConfirm(false);
        };
    }
    if (primary) {
        primary.onclick = event => {
            event.preventDefault();
            event.stopPropagation();
            closeBlockUserConfirm(true);
        };
    }
    if (existing) {
        existing.onclick = event => {
            if (event.target === existing) {
                closeBlockUserConfirm(false);
            }
        };
    }

    if (avatar) {
        avatar.src = meta.avatar || "/static/profile/default.png";
        avatar.alt = "";
        avatar.onerror = () => { avatar.src = "/static/profile/default.png"; };
    }
    if (name) name.textContent = meta.displayName || target;
    if (handle) handle.textContent = "@" + target;

    existing.setAttribute("aria-hidden", "false");
    existing.removeAttribute("hidden");
    existing.classList.add("open");
    blockUserConfirmKey = target.toLowerCase();

    blockUserConfirmEscapeHandler = event => {
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeBlockUserConfirm(false);
        }
    };
    document.addEventListener("keydown", blockUserConfirmEscapeHandler, true);

    const finishOpen = () => {
        try { cancel?.focus({preventScroll:true}); } catch (_error) {}
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(finishOpen);
    else setTimeout(finishOpen, 0);

    return new Promise(resolve => {
        blockUserConfirmResolver = resolve;
    });
}

async function toggleBlockedUser(username, blocked = null){
    const target = String(username || "").trim();
    if (!target) return false;
    if (target.toLowerCase() === String(CURRENT_DASHBOARD_USER || "").trim().toLowerCase()) return false;

    const alreadyBlocked = isUserBlocked(target);
    const nextBlocked = blocked === null ? !alreadyBlocked : !!blocked;

    if (blocked === null && !alreadyBlocked) {
        const confirmed = await openBlockUserConfirm(target);
        if (!confirmed) return false;
    }

    const mutationKey = target.toLowerCase();
    if (blockedUserMutationPromises.has(mutationKey)) {
        return blockedUserMutationPromises.get(mutationKey);
    }

    const previous = [...getBlockedUsers()];
    const next = nextBlocked
        ? [...new Set([...previous, target])]
        : previous.filter(
            name => String(name || "").trim().toLowerCase() !== mutationKey
        );

    serverBlockedUsers = next;
    saveBlockedUsers(next);
    closeChatMenu();

    const run = (async () => {
        try{
            const res = await fetch("/blocked-users", {
                method:"POST",
                credentials:"same-origin",
                cache:"no-store",
                headers:{"Content-Type":"application/json"},
                body:JSON.stringify({
                    username:target,
                    blocked:nextBlocked
                })
            });

            if (handleDashboardAuthFailure(res.status)) return false;
            if(!res.ok) throw new Error("HTTP " + res.status);

            const data = await res.json();
            if(!data.success || !Array.isArray(data.blocked)){
                throw new Error(data.error || "Blocked-user update failed");
            }

            serverBlockedUsers = data.blocked
                .map(item => String(item || "").trim())
                .filter(Boolean);
            saveBlockedUsers(serverBlockedUsers);
            await loadServerBlockedUsers();

            // Refresh Status visibility immediately after a local block/unblock
            // mutation. Do not depend on the dashboard WebSocket event arriving.
            await loadStatuses(true);

            showStatusToast(
                nextBlocked ? `Blocked ${target}` : `Unblocked ${target}`
            );
            return true;
        }catch(e){
            serverBlockedUsers = previous;
            saveBlockedUsers(previous);
            console.debug("Could not persist blocked user:", e);
            showStatusToast("Could not update blocked user", true);
            return false;
        }finally{
            blockedUserMutationPromises.delete(mutationKey);
        }
    })();

    blockedUserMutationPromises.set(mutationKey, run);
    return run;
}

function openBlockedUsers(){
    closeChatMenu();
    closeBlockedUsers();

    const overlay = document.createElement("div");
    overlay.id = "blockedUsersOverlay";
    overlay.className = "blocked-users-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "blockedUsersTitle");

    overlay.addEventListener("click", event => {
        if (event.target === overlay) closeBlockedUsers();
    });

    const panel = document.createElement("section");
    panel.className = "blocked-users-panel";

    const head = document.createElement("div");
    head.className = "blocked-users-head";
    head.innerHTML = '<div><span>CHAT PRIVACY</span><h3 id="blockedUsersTitle">Blocked users</h3><p>Blocked users cannot start new messages or voice calls with you.</p></div>';

    const close = document.createElement("button");
    close.type = "button";
    close.className = "blocked-users-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close blocked users");
    close.addEventListener("click", closeBlockedUsers);
    head.appendChild(close);

    const list = document.createElement("div");
    list.id = "blockedUsersList";
    list.className = "blocked-users-list";

    panel.append(head, list);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    void loadBlockedUsersForDialog();
}

let hideUserConfirmResolver = null;
let hideUserConfirmKey = "";
let hideUserConfirmEscapeHandler = null;

function getHideUserDisplayMeta(username){
    const target = String(username || "").trim();
    const item = [...document.querySelectorAll(".chat-list .chat-item[data-username]")]
        .find(node => String(node.getAttribute("data-username") || "").trim().toLowerCase() === target.toLowerCase());

    const displayName = String(
        item?.querySelector(".chat-name-row h4, .chat-top h4, h4")?.textContent
            ?.replace("📌", "")
            ?.trim()
            || target
    );

    const avatar = String(
        item?.querySelector("img.avatar")?.getAttribute("src")
            || "/static/profile/default.png"
    );

    return { displayName, avatar };
}

function closeHideUserConfirm(result = false){
    const overlay = document.getElementById("hideUserConfirmOverlay");
    if (hideUserConfirmEscapeHandler) {
        document.removeEventListener("keydown", hideUserConfirmEscapeHandler, true);
        hideUserConfirmEscapeHandler = null;
    }

    if (overlay) {
        overlay.classList.remove("open");
        overlay.setAttribute("aria-hidden", "true");
        setTimeout(() => overlay.remove(), 160);
    }

    const resolver = hideUserConfirmResolver;
    hideUserConfirmResolver = null;
    hideUserConfirmKey = "";
    if (typeof resolver === "function") resolver(!!result);
}

function openHideUserConfirm(username){
    const target = String(username || "").trim();
    if (!target) return Promise.resolve(false);

    const existing = document.getElementById("hideUserConfirmOverlay");
    if (existing && hideUserConfirmResolver) {
        if (hideUserConfirmKey === target.toLowerCase()) return new Promise(resolve => {
            const previous = hideUserConfirmResolver;
            hideUserConfirmResolver = value => {
                try { previous(value); } finally { resolve(!!value); }
            };
        });
        closeHideUserConfirm(false);
    }

    const meta = getHideUserDisplayMeta(target);

    const overlay = document.createElement("div");
    overlay.id = "hideUserConfirmOverlay";
    overlay.className = "hide-user-confirm-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-hidden", "true");
    overlay.setAttribute("aria-labelledby", "hideUserConfirmTitle");
    overlay.setAttribute("aria-describedby", "hideUserConfirmText");

    const panel = document.createElement("section");
    panel.className = "hide-user-confirm-panel";

    const head = document.createElement("div");
    head.className = "hide-user-confirm-head";

    const icon = document.createElement("div");
    icon.className = "hide-user-confirm-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "🙈";

    const copy = document.createElement("div");
    copy.className = "hide-user-confirm-copy";

    const kicker = document.createElement("span");
    kicker.className = "hide-user-confirm-kicker";
    kicker.textContent = "CHAT PRIVACY";

    const title = document.createElement("h3");
    title.id = "hideUserConfirmTitle";
    title.textContent = "Hide user?";

    copy.append(kicker, title);
    head.append(icon, copy);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "hide-user-confirm-close";
    close.setAttribute("aria-label", "Cancel hiding user");
    close.textContent = "×";
    close.addEventListener("click", () => closeHideUserConfirm(false));

    const identity = document.createElement("div");
    identity.className = "hide-user-confirm-identity";

    const avatar = document.createElement("img");
    avatar.className = "hide-user-confirm-avatar";
    avatar.src = meta.avatar;
    avatar.alt = "";
    avatar.onerror = () => { avatar.src = "/static/profile/default.png"; };

    const identityCopy = document.createElement("div");
    identityCopy.className = "hide-user-confirm-identity-copy";

    const name = document.createElement("strong");
    name.textContent = meta.displayName;

    const handle = document.createElement("span");
    handle.textContent = "@" + target;

    identityCopy.append(name, handle);
    identity.append(avatar, identityCopy);

    const text = document.createElement("p");
    text.id = "hideUserConfirmText";
    text.textContent = `Hide ${meta.displayName} from your Chats list?`;

    const note = document.createElement("div");
    note.className = "hide-user-confirm-note";
    note.innerHTML =
        '<span aria-hidden="true">↺</span>' +
        '<span>Your conversation and messages stay untouched. Restore this user anytime from <b>Hidden users</b>.</span>';

    const actions = document.createElement("div");
    actions.className = "hide-user-confirm-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "hide-user-confirm-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => closeHideUserConfirm(false));

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "hide-user-confirm-primary";
    confirm.textContent = "Hide user";
    confirm.addEventListener("click", () => closeHideUserConfirm(true));

    actions.append(cancel, confirm);
    panel.append(head, close, identity, text, note, actions);
    overlay.appendChild(panel);

    if (!document.getElementById("hide-user-confirm-style-v1")) {
        const style = document.createElement("style");
        style.id = "hide-user-confirm-style-v1";
        style.textContent = `
.hide-user-confirm-overlay{
    position:fixed;
    inset:0;
    z-index:11000;
    display:flex;
    align-items:center;
    justify-content:center;
    padding:16px;
    background:rgba(1,5,14,.78);
    backdrop-filter:blur(18px) saturate(1.08);
    -webkit-backdrop-filter:blur(18px) saturate(1.08);
    opacity:0;
    transition:opacity .16s ease;
}
.hide-user-confirm-overlay.open{opacity:1}
.hide-user-confirm-panel{
    position:relative;
    width:min(100%,430px);
    padding:21px;
    border:1px solid rgba(125,211,252,.18);
    border-radius:26px;
    background:
        radial-gradient(320px 170px at 5% 0%,rgba(56,189,248,.14),transparent 72%),
        radial-gradient(300px 180px at 100% 100%,rgba(129,140,248,.10),transparent 74%),
        linear-gradient(180deg,rgba(10,21,38,.99),rgba(5,11,22,.99));
    box-shadow:0 30px 90px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.045);
    transform:translateY(10px) scale(.985);
    transition:transform .18s ease;
}
.hide-user-confirm-overlay.open .hide-user-confirm-panel{transform:translateY(0) scale(1)}
.hide-user-confirm-head{
    display:flex;
    align-items:center;
    gap:12px;
    padding-right:38px;
}
.hide-user-confirm-icon{
    width:46px;
    height:46px;
    min-width:46px;
    display:grid;
    place-items:center;
    border:1px solid rgba(125,211,252,.18);
    border-radius:15px;
    background:linear-gradient(145deg,rgba(56,189,248,.16),rgba(59,130,246,.08));
    box-shadow:0 10px 24px rgba(14,165,233,.12);
    font-size:24px;
}
.hide-user-confirm-kicker{
    display:block;
    margin-bottom:4px;
    color:#79c9ff;
    font:800 8px/1 Poppins,sans-serif;
    letter-spacing:.19em;
}
.hide-user-confirm-copy h3{
    margin:0;
    color:#f7fbff;
    font:850 20px/1.05 Poppins,sans-serif;
    letter-spacing:-.035em;
}
.hide-user-confirm-close{
    position:absolute;
    top:17px;
    right:17px;
    width:36px;
    height:36px;
    border:1px solid rgba(148,163,184,.13);
    border-radius:12px;
    background:rgba(30,41,59,.64);
    color:#dbe7f4;
    font:400 23px/1 Poppins,sans-serif;
    cursor:pointer;
}
.hide-user-confirm-close:active{transform:scale(.93)}
.hide-user-confirm-identity{
    display:flex;
    align-items:center;
    gap:12px;
    margin-top:19px;
    padding:11px;
    border:1px solid rgba(148,163,184,.09);
    border-radius:17px;
    background:rgba(15,23,42,.58);
}
.hide-user-confirm-avatar{
    width:48px;
    height:48px;
    min-width:48px;
    object-fit:cover;
    border-radius:15px;
    border:1px solid rgba(125,211,252,.18);
    background:#142239;
}
.hide-user-confirm-identity-copy{min-width:0}
.hide-user-confirm-identity-copy strong{
    display:block;
    overflow:hidden;
    text-overflow:ellipsis;
    white-space:nowrap;
    color:#f4f9ff;
    font:750 14px/1.2 Poppins,sans-serif;
}
.hide-user-confirm-identity-copy span{
    display:block;
    margin-top:4px;
    color:#7087a0;
    font:550 10px/1 Poppins,sans-serif;
}
.hide-user-confirm-panel>p{
    margin:16px 2px 0;
    color:#b0bdcc;
    font:550 12px/1.6 Poppins,sans-serif;
}
.hide-user-confirm-note{
    display:flex;
    align-items:flex-start;
    gap:8px;
    margin-top:12px;
    padding:11px 12px;
    border:1px solid rgba(96,165,250,.10);
    border-radius:14px;
    background:rgba(59,130,246,.055);
    color:#8ea4bc;
    font:500 10px/1.55 Poppins,sans-serif;
}
.hide-user-confirm-note span:first-child{
    color:#6cc7ff;
    font-size:16px;
    line-height:1;
    margin-top:1px;
}
.hide-user-confirm-note b{color:#cfe8ff}
.hide-user-confirm-actions{
    display:grid;
    grid-template-columns:1fr 1.08fr;
    gap:10px;
    margin-top:18px;
}
.hide-user-confirm-actions button{
    min-height:48px;
    border-radius:15px;
    font:700 12px Poppins,sans-serif;
    cursor:pointer;
    transition:transform .15s ease,background .15s ease,border-color .15s ease,filter .15s ease;
}
.hide-user-confirm-actions button:active{transform:scale(.975)}
.hide-user-confirm-cancel{
    border:1px solid rgba(148,163,184,.15);
    background:rgba(30,41,59,.70);
    color:#d4deeb;
}
.hide-user-confirm-cancel:hover{background:rgba(51,65,85,.72)}
.hide-user-confirm-primary{
    border:1px solid rgba(125,211,252,.22);
    background:linear-gradient(145deg,#3388ee,#2563eb);
    color:#fff;
    box-shadow:0 12px 28px rgba(37,99,235,.20);
}
.hide-user-confirm-primary:hover{filter:brightness(1.07)}
@media(max-width:520px){
    .hide-user-confirm-overlay{padding:13px}
    .hide-user-confirm-panel{padding:18px;border-radius:23px}
    .hide-user-confirm-actions{grid-template-columns:1fr 1.08fr}
}
`;
        document.head.appendChild(style);
    }

    overlay.addEventListener("click", event => {
        if (event.target === overlay) closeHideUserConfirm(false);
    });

    document.body.appendChild(overlay);
    hideUserConfirmKey = target.toLowerCase();

    hideUserConfirmEscapeHandler = event => {
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeHideUserConfirm(false);
        }
    };
    document.addEventListener("keydown", hideUserConfirmEscapeHandler, true);

    requestAnimationFrame(() => {
        overlay.setAttribute("aria-hidden", "false");
        overlay.classList.add("open");
        cancel.focus({preventScroll:true});
    });

    return new Promise(resolve => {
        hideUserConfirmResolver = resolve;
    });
}

async function toggleHiddenUser(username, hidden = null){
    const target = String(username || "").trim();
    if (!target) return false;
    if (target.toLowerCase() === String(CURRENT_DASHBOARD_USER || "").trim().toLowerCase()) return false;

    const alreadyHidden = isUserHidden(target);
    const nextHidden = hidden === null ? !alreadyHidden : !!hidden;
    if (hidden === null && !alreadyHidden) {
        const confirmed = await openHideUserConfirm(target);
        if (!confirmed) return false;
    }
    const mutationKey = target.toLowerCase();
    if (hiddenUserMutationPromises.has(mutationKey)) return hiddenUserMutationPromises.get(mutationKey);

    const previous = [...getHiddenUsers()];
    const next = nextHidden
        ? [...new Set([...previous, target])]
        : previous.filter(name => String(name || "").trim().toLowerCase() !== mutationKey);

    serverHiddenUsers = next;
    saveHiddenUsers(next);
    closeChatMenu();

    if (nextHidden) removeHiddenChatRow(target);

    const run = (async () => {
        try{
            const res = await fetch("/hidden-users", {
                method:"POST",
                credentials:"same-origin",
                cache:"no-store",
                headers:{"Content-Type":"application/json"},
                body:JSON.stringify({username:target, hidden:nextHidden})
            });

            if (handleDashboardAuthFailure(res.status)) return false;
            if(!res.ok) throw new Error("HTTP " + res.status);
            const data = await res.json();
            if(!data.success || !Array.isArray(data.hidden)) throw new Error(data.error || "Hidden-user update failed");

            serverHiddenUsers = data.hidden.map(item => String(item || "").trim()).filter(Boolean);
            saveHiddenUsers(serverHiddenUsers);
            await refreshDashboard();
            showStatusToast(nextHidden ? `Hidden ${target} from Chats` : `Unhidden ${target}`);
            return true;
        }catch(e){
            serverHiddenUsers = previous;
            saveHiddenUsers(previous);
            console.debug("Could not persist hidden user:", e);
            await refreshDashboard();
            showStatusToast("Could not update hidden user", true);
            return false;
        }finally{
            hiddenUserMutationPromises.delete(mutationKey);
        }
    })();

    hiddenUserMutationPromises.set(mutationKey, run);
    return run;
}

function closeHiddenUsers(){
    const overlay = document.getElementById("hiddenUsersOverlay");
    if (overlay) overlay.remove();
}

function renderHiddenUsersList(items){
    const list = document.getElementById("hiddenUsersList");
    if (!list) return;
    const rows = Array.isArray(items) ? items : [];
    list.innerHTML = "";

    if (!rows.length) {
        const empty = document.createElement("div");
        empty.className = "hidden-users-empty";
        empty.innerHTML = "<b>No hidden users</b><small>Users you hide from Chats will appear here.</small>";
        list.appendChild(empty);
        return;
    }

    rows.forEach(item => {
        const username = String(item?.username || "").trim();
        if (!username) return;
        const displayName = String(item?.display_name || username);
        const profile = String(item?.profile || "/static/profile/default.png");

        const row = document.createElement("div");
        row.className = "hidden-user-row";

        const image = document.createElement("img");
        image.className = "hidden-user-avatar";
        image.src = profile;
        image.alt = "";
        image.onerror = () => { image.src = "/static/profile/default.png"; };

        const info = document.createElement("div");
        info.className = "hidden-user-info";
        const name = document.createElement("b");
        name.textContent = displayName;
        const handle = document.createElement("small");
        handle.textContent = "@" + username;
        info.append(name, handle);

        const button = document.createElement("button");
        button.type = "button";
        button.className = "hidden-user-unhide";
        button.textContent = "Unhide";
        button.addEventListener("click", async () => {
            await toggleHiddenUser(username, false);
            if (!isUserHidden(username)) await loadHiddenUsersForDialog();
        });

        row.append(image, info, button);
        list.appendChild(row);
    });
}

async function loadHiddenUsersForDialog(){
    const list = document.getElementById("hiddenUsersList");
    if (list) list.innerHTML = '<div class="hidden-users-loading">Loading hidden users…</div>';

    try{
        const res = await fetch("/hidden-users", { credentials:"same-origin", cache:"no-store" });
        if (handleDashboardAuthFailure(res.status)) return;
        if(!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        if(!data.success || !Array.isArray(data.hidden)) throw new Error(data.error || "Hidden-user list failed");
        serverHiddenUsers = data.hidden.map(item => String(item?.username || "").trim()).filter(Boolean);
        saveHiddenUsers(serverHiddenUsers);
        renderHiddenUsersList(data.hidden);
        return;
    }catch(e){
        console.debug("Could not load hidden users dialog:", e);
    }

    const fallback = getHiddenUsers().map(username => ({
        username,
        display_name: username,
        profile: "/static/profile/default.png"
    }));
    renderHiddenUsersList(fallback);
}

function openHiddenUsers(){
    closeChatMenu();
    closeHiddenUsers();

    const overlay = document.createElement("div");
    overlay.id = "hiddenUsersOverlay";
    overlay.className = "hidden-users-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "hiddenUsersTitle");
    overlay.addEventListener("click", event => {
        if (event.target === overlay) closeHiddenUsers();
    });

    const panel = document.createElement("section");
    panel.className = "hidden-users-panel";

    const head = document.createElement("div");
    head.className = "hidden-users-head";
    head.innerHTML = '<div><span>CHAT PRIVACY</span><h3 id="hiddenUsersTitle">Hidden users</h3><p>Hidden users stay out of your Chats list.</p></div>';

    const close = document.createElement("button");
    close.type = "button";
    close.className = "hidden-users-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close hidden users");
    close.addEventListener("click", closeHiddenUsers);
    head.appendChild(close);

    const list = document.createElement("div");
    list.id = "hiddenUsersList";
    list.className = "hidden-users-list";

    panel.append(head, list);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    void loadHiddenUsersForDialog();
}

function showChatMenu(event, username){
    event.preventDefault();
    event.stopPropagation();
    closeChatMenu();

    const menu=document.createElement("div");
    menu.className="chat-menu";
    menu.id="dashboardChatMenu";

    const button=document.createElement("button");
    button.textContent=isPinned(username) ? "📌 Unpin chat" : "📌 Pin chat";
    button.onclick=async ()=>{
        await togglePinnedChat(username);
        closeChatMenu();
    };
    menu.appendChild(button);

    const hideButton=document.createElement("button");
    hideButton.textContent=isUserHidden(username) ? "👁 Unhide user" : "🙈 Hide user";
    hideButton.onclick=async ()=>{
        await toggleHiddenUser(username);
        closeChatMenu();
    };
    menu.appendChild(hideButton);

    const blockButton=document.createElement("button");
    blockButton.textContent=isUserBlocked(username) ? "✅ Unblock user" : "🚫 Block user";
    blockButton.onclick=async ()=>{
        await toggleBlockedUser(username);
        closeChatMenu();
    };
    menu.appendChild(blockButton);

    document.body.appendChild(menu);

    const x=Math.min(event.clientX, window.innerWidth-menu.offsetWidth-8);
    const y=Math.min(event.clientY, window.innerHeight-menu.offsetHeight-8);
    menu.style.left=Math.max(8,x)+"px";
    menu.style.top=Math.max(8,y)+"px";
}

function closeChatMenu(){
    const menu=document.getElementById("dashboardChatMenu");
    if(menu) menu.remove();
}

document.addEventListener("click", closeChatMenu);

let dashboardCryptoReady = null;

async function ensureDashboardCrypto(){
    // crypto.core.js declares LuckyCrypto as a top-level lexical binding,
    // not as window.LuckyCrypto. Check the binding directly so the dashboard
    // can initialize and decrypt message previews.
    if (typeof LuckyCrypto === "undefined") return false;

    if (!dashboardCryptoReady) {
        dashboardCryptoReady = (async () => {
            try {
                // Explicitly initialize here so the dashboard does not depend
                // on the timing of another page's crypto initialization.
                await LuckyCrypto.init();
                await LuckyCrypto.ensureReady();
                return true;
            } catch (error) {
                console.error("Dashboard crypto initialization failed:", error);
                dashboardCryptoReady = null;
                return false;
            }
        })();
    }

    return dashboardCryptoReady;
}


const DASHBOARD_PREVIEW_PREFIX = "lucky_chat_dashboard_preview:";

function getCachedDashboardPreview(otherUser) {
    try {
        const raw = localStorage.getItem(
            DASHBOARD_PREVIEW_PREFIX +
            String("{{ username }}") + ":" +
            String(otherUser || "")
        );

        if (!raw) return null;

        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.id) return null;

        return parsed;
    } catch (error) {
        console.warn("Dashboard preview cache read failed:", error);
        return null;
    }
}

function saveCachedDashboardPreview(chat) {
    if (!chat || !chat.username) return;

    try {
        localStorage.setItem(
            DASHBOARD_PREVIEW_PREFIX +
            String("{{ username }}") + ":" +
            String(chat.username),
            JSON.stringify({
                id: Number(chat.id) || 0,
                sender: chat.sender || "",
                receiver: "{{ username }}",
                text: chat.last || "",
                timestamp: chat.time || "",
                media_url: chat.media_url || null,
                media_type: chat.media_type || null
            })
        );
    } catch (error) {
        console.warn("Dashboard preview cache write failed:", error);
    }
}

async function decryptDashboardPreview(chat){
    if (!chat) return chat;

    const cached = getCachedDashboardPreview(chat.username);

    // The local device may already know the decrypted plaintext. Prefer it
    // when it is at least as new as the server row, but NEVER trust an old
    // "Encrypted message" placeholder as if it were decrypted plaintext.
    const cachedText = String(cached?.text || "").trim();
    const cachedLooksEncrypted =
        cachedText.startsWith("LCE1:") ||
        cachedText.startsWith("LCE2:");
    const cachedIsUsable =
        !!cached &&
        !cachedLooksEncrypted &&
        cachedText !== "🔒 Encrypted message" &&
        cachedText !== "Encrypted message";

    if (cachedIsUsable && Number(cached.id) >= Number(chat.id || 0)) {
        chat.last = cached.text || "";
        chat.sender = cached.sender || chat.sender || "";
        chat.time = cached.timestamp || chat.time || "";
        chat.id = Math.max(Number(chat.id || 0), Number(cached.id || 0));
        chat.media_url = cached.media_url || chat.media_url || null;
        chat.media_type = cached.media_type || chat.media_type || null;
        return chat;
    }

    if (!chat.last) {
        return chat;
    }

    const raw = String(chat.last);

    if (!raw.startsWith("LCE1:") && !raw.startsWith("LCE2:")) {
        saveCachedDashboardPreview(chat);
        return chat;
    }

    if (await ensureDashboardCrypto()) {
        try {
            chat.last = await LuckyCrypto.decryptMessage(
                raw,
                "{{ username }}"
            );
            saveCachedDashboardPreview(chat);
            return chat;
        } catch (error) {
            console.error(
                "DASHBOARD MESSAGE DECRYPTION ERROR:",
                error,
                chat.id
            );
        }
    }

    // Never leak ciphertext into the dashboard preview. Also do not let an
    // old placeholder permanently poison the cache.
    if (cachedIsUsable) {
        chat.last = cached.text || "";
        chat.sender = cached.sender || chat.sender || "";
        chat.time = cached.timestamp || chat.time || "";
    } else {
        chat.last = "🔒 Encrypted message";
    }

    return chat;
}

function escapeDashboardText(value){
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&":"&amp;",
        "<":"&lt;",
        ">":"&gt;",
        '"':"&quot;",
        "'":"&#39;"
    })[char]);
}

let dashboardRefreshGeneration = 0;
let dashboardRefreshInFlight = null;
let dashboardRefreshPending = false;
let dashboardOnlinePrimed = false;

function isUsableCachedDashboardPreview(cached){
    const cachedText = String(cached?.text || "").trim();
    if (!cached || !cachedText) return false;
    return !cachedText.startsWith("LCE1:") &&
           !cachedText.startsWith("LCE2:") &&
           cachedText !== "🔒 Encrypted message" &&
           cachedText !== "Encrypted message";
}

function prepareFastDashboardChat(chat){
    const next = { ...(chat || {}) };
    if (!next.username) return next;

    const cached = getCachedDashboardPreview(next.username);
    if (isUsableCachedDashboardPreview(cached) && Number(cached.id) >= Number(next.id || 0)) {
        next.last = cached.text || "";
        next.sender = cached.sender || next.sender || "";
        next.time = cached.timestamp || next.time || "";
        next.id = Math.max(Number(next.id || 0), Number(cached.id || 0));
        next.media_url = cached.media_url || next.media_url || null;
        next.media_type = cached.media_type || next.media_type || null;
        return next;
    }

    const raw = String(next.last || "");
    if (raw.startsWith("LCE1:") || raw.startsWith("LCE2:")) {
        next.last = "🔒 Encrypted message";
    }
    return next;
}

function getDashboardPreviewText(chat){
    let messageText = chat?.last || "";

    if (!messageText && chat?.media_type === "image") {
        messageText = "📷 Photo";
    } else if (!messageText && chat?.media_type === "audio") {
        messageText = "🎙️ Voice message";
    }

    return String(messageText);
}

function sortDashboardChats(chats){
    const pinned = getPinnedChats();
    return [...chats].sort((a, b) => {
        const pinA = pinned.includes(a.username) ? 1 : 0;
        const pinB = pinned.includes(b.username) ? 1 : 0;
        if (pinA !== pinB) return pinB - pinA;

        const timeA = getChatTimestamp(a.time);
        const timeB = getChatTimestamp(b.time);
        if (timeA !== timeB) return timeB - timeA;

        const unreadA = Number(a.unread) || 0;
        const unreadB = Number(b.unread) || 0;
        return unreadB - unreadA;
    });
}

function buildDashboardChatHtml(chat){
    const username = String(chat.username ?? "").trim();
    if (!username) return "";

    const senderName =
        chat.sender === "{{ username }}"
        ? "You"
        : (chat.display_name || username);

    const messageText = getDashboardPreviewText(chat);
    const trimmedText = messageText.substring(0, 30);
    const preview = messageText
        ? `${escapeDashboardText(senderName)}: ${escapeDashboardText(trimmedText)}${messageText.length > 30 ? "..." : ""}`
        : "No messages yet";

    const unread = Number(chat.unread) || 0;
    const badge = unread > 0
        ? `<span class="badge">${unread}</span>`
        : "";

    const profile = chat.profile || "/static/profile/default.png";
    const displayName = escapeDashboardText(chat.display_name || username);
    const escapedUsername = escapeDashboardText(username);
    const pinMark = isPinned(username)
        ? ' <span class="chat-pin">📌</span>'
        : "";
    const activeClass = unread > 0 ? " has-unread" : "";
    const pinnedClass = isPinned(username) ? " is-pinned" : "";

    return `
    <div class="chat-item${activeClass}${pinnedClass}"
         data-username="${escapedUsername}"
         onclick="openChat(this.dataset.username)"
         oncontextmenu="showChatMenu(event, this.dataset.username)">

        <img
            class="avatar"
            src="${escapeDashboardText(profile)}"
            alt="${escapedUsername}"
            onerror="this.src='/static/profile/default.png'">

        <div class="chat-info">

        <div class="chat-top">
    <h4>${displayName}${pinMark}</h4>

    <div class="chat-right">
        ${chat.time
            ? `<small class="time">${formatDashboardTime(chat.time)}</small>`
            : ""
        }

        ${badge}
        <button class="chat-action-btn" type="button" aria-label="Chat options" title="Chat options" onclick="event.stopPropagation(); showChatMenu(event, this.closest('.chat-item').dataset.username)">⋮</button>
    </div>
</div>

        <small class="message-preview">
    ${preview}
</small>

<p class="status" id="status-${escapedUsername}">
    ⚪ Offline
</p>

        </div>

    </div>
`;
}

function renderDashboardChats(chats){
    const chatList = document.querySelector(".chat-list");
    if (!chatList) return false;

    const visibleChats = chats.filter(chat => chat && !isUserHidden(chat.username));
    const orderedChats = sortDashboardChats(visibleChats);
    if (!orderedChats.length) return false;

    let renderedChatList = "";
    for (const chat of orderedChats) {
        try {
            renderedChatList += buildDashboardChatHtml(chat);
        } catch (chatRenderError) {
            console.warn("Skipping malformed dashboard chat record:", chatRenderError, chat);
        }
    }

    if (!renderedChatList.trim()) return false;
    chatList.innerHTML = renderedChatList;
    searchChats();
    return true;
}

function patchDashboardDecryptedPreviews(chats){
    const chatList = document.querySelector(".chat-list");
    if (!chatList) return;

    const elements = new Map();
    chatList.querySelectorAll(".chat-item[data-username]").forEach(item => {
        elements.set(item.getAttribute("data-username") || "", item);
    });

    chats.forEach(chat => {
        const username = String(chat?.username || "");
        if (!username) return;
        const item = elements.get(username);
        if (!item) return;

        const previewEl = item.querySelector(".message-preview");
        if (!previewEl) return;

        const senderName =
            chat.sender === "{{ username }}"
            ? "You"
            : (chat.display_name || username);
        const messageText = getDashboardPreviewText(chat);
        const trimmedText = messageText.substring(0, 30);
        const preview = messageText
            ? `${escapeDashboardText(senderName)}: ${escapeDashboardText(trimmedText)}${messageText.length > 30 ? "..." : ""}`
            : "No messages yet";

        previewEl.innerHTML = preview;
    });

    searchChats();
}

async function decryptDashboardPreviewsInBackground(chats, generation){
    if (!Array.isArray(chats) || !chats.length) return;

    let nextIndex = 0;
    const workerCount = Math.min(4, chats.length);

    const worker = async () => {
        while (nextIndex < chats.length) {
            const index = nextIndex++;
            try {
                await decryptDashboardPreview(chats[index]);
            } catch (_error) {
                chats[index].last = "🔒 Encrypted message";
            }
            // Yield between decryptions so long chat lists do not monopolize
            // the main thread on mobile devices.
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    };

    await Promise.all(Array.from({ length: workerCount }, worker));

    if (generation !== dashboardRefreshGeneration) return;
    patchDashboardDecryptedPreviews(chats);
}

async function refreshDashboard(){
    if (dashboardSessionExpired || dashboardPageUnloading) return;
    if (dashboardRefreshInFlight) {
        // A WebSocket/timer event can arrive while the current request is still
        // in flight. Queue one trailing refresh instead of silently dropping it.
        dashboardRefreshPending = true;
        return dashboardRefreshInFlight;
    }

    const generation = ++dashboardRefreshGeneration;

    const run = (async () => {
        try {
            const res = await fetch("/dashboard-data", {
                cache: "no-store",
                credentials: "same-origin"
            });

            if (handleDashboardAuthFailure(res.status)) return;

            if (!res.ok) {
                throw new Error("Dashboard data request failed (HTTP " + res.status + ")");
            }

            const payload = await res.json();

            if (!Array.isArray(payload)) {
                console.warn("DASHBOARD DATA: expected an array; keeping current chat list.");
                return;
            }

            const chats = payload.filter(chat => chat && typeof chat === "object");
            const fastChats = chats.map(prepareFastDashboardChat);

            // The server-rendered dashboard is already visible on first load.
            // Refresh only after the first paint and replace it in one DOM write
            // as soon as fresh server data arrives.
            const rendered = renderDashboardChats(fastChats);

            if (!rendered) {
                // Keep the existing server-rendered/current list visible on an
                // empty or malformed response.
                searchChats();
            }

            // Online state is a separate endpoint. Do not chain it to every
            // dashboard refresh; prime it once, then let its own timer handle it.
            if (!dashboardOnlinePrimed) {
                dashboardOnlinePrimed = true;
                setTimeout(() => { void updateOnlineUsers(); }, 0);
            }

            // Decryption is never on the critical first-paint path.
            if (chats.length) {
                requestAnimationFrame(() => {
                    void decryptDashboardPreviewsInBackground(chats, generation);
                });
            }

        } catch (error) {
            console.error("DASHBOARD REFRESH ERROR:", error);
        }
    })();

    dashboardRefreshInFlight = run;
    const finishRefresh = () => {
        if (dashboardRefreshInFlight !== run) return;

        dashboardRefreshInFlight = null;

        // Never lose an update received during an active /dashboard-data
        // request. One coalesced trailing fetch is enough even when several
        // events arrive together.
        if (
            dashboardRefreshPending &&
            !dashboardSessionExpired &&
            !dashboardPageUnloading
        ) {
            dashboardRefreshPending = false;
            setTimeout(() => {
                void refreshDashboard();
            }, 0);
        }
    };

    run.then(finishRefresh, finishRefresh);
    return run;
}


function animateTopChat() {
    const first = document.querySelector(".chat-list .chat-item");
    if (!first) return;

    first.classList.remove("chat-just-moved");
    void first.offsetWidth;
    first.classList.add("chat-just-moved");
}

function getChatSearchText(chat){
    if (!chat) return "";

    const name = chat.querySelector(".chat-info h4, .chat-top h4, h4")?.textContent || "";
    const preview = chat.querySelector(".message-preview")?.textContent || "";
    const dataUser = chat.getAttribute("data-username") || "";
    const statusId = chat.querySelector(".status")?.id || "";
    const usernameFromStatus = statusId.startsWith("status-") ? statusId.slice("status-".length) : "";
    const onclick = chat.getAttribute("onclick") || "";
    const fromClick = (onclick.match(/openChat\('([^']+)'\)/) || [])[1] || "";

    return [name, preview, dataUser, usernameFromStatus, fromClick]
        .join(" ")
        .replace(/📌/g, " ")
        .toLowerCase();
}

function searchChats() {
    const input = document.getElementById("chatSearch");
    const list = document.querySelector(".chat-list");
    if (!input || !list) return;

    const filter = input.value.trim().toLowerCase();
    const items = list.querySelectorAll(".chat-item");
    let visible = 0;

    items.forEach(chat => {
        const matches = !filter || getChatSearchText(chat).includes(filter);
        chat.classList.toggle("is-search-hidden", !matches);
        chat.style.removeProperty("display");
        if (matches) visible++;
    });

    let empty = list.querySelector(".chat-list-empty");

    if (filter && visible === 0) {
        if (!empty) {
            empty = document.createElement("div");
            empty.className = "chat-list-empty";
            empty.textContent = "No chats found";
            list.appendChild(empty);
        }
    } else if (empty) {
        empty.remove();
    }
}

document.addEventListener("click", (event) => {
    if (event.target.id === "statusCreateModal") closeStatusCreate();
    if (event.target.id === "statusViewerModal") closeStatusViewer();
});



/* =========================================================
   Lucky Chat PWA service-worker registration
   ========================================================= */

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("/service-worker.js", { scope: "/" })
            .then(reg => {
                console.log("Lucky Chat PWA service worker ready:", reg.scope);
                if (typeof reg.update === "function") {
                    reg.update().catch(() => {});
                }
                reg.addEventListener("updatefound", () => {
                    const worker = reg.installing;
                    if (!worker) return;
                    worker.addEventListener("statechange", () => {
                        if (worker.state === "installed" && navigator.serviceWorker.controller) {
                            try { worker.postMessage({ type: "SKIP_WAITING" }); } catch (_error) {}
                        }
                    });
                });
                navigator.serviceWorker.addEventListener("controllerchange", () => {
                    if (window.__luckySwReloaded) return;
                    window.__luckySwReloaded = true;
                    location.reload();
                });
            })
            .catch(err => console.error("Lucky Chat PWA service worker failed:", err));
    });
}

