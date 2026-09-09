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

        document.querySelectorAll("[id^='status-']").forEach(el => {
            el.innerHTML = "⚪ Offline";
        });

        list.forEach(user => {
            const name = typeof user === "string" ? user : (user?.username || user?.user || "");
            if (!name) return;
            const el = document.getElementById("status-" + name);
            if (el) el.innerHTML = "🟢 Online";
        });
    } catch (error) {
        console.debug("Online users refresh failed:", error);
    }
}

void updateOnlineUsers();

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
const STATUS_VIEWERS_KEY = "lucky_status_viewers_by_id_v1";
const STATUS_LIKERS_KEY = "lucky_status_likers_by_id_v1";
const STATUS_REPLIES_KEY = "lucky_status_replies_by_id_v1";
const CURRENT_DASHBOARD_USER = String("{{ username }}").trim();
const STATUS_LIKES_VERSION = 2;
const STATUS_VISIBILITY_OPTIONS = [
    {id:"contacts", label:"My contacts"},
    {id:"close", label:"Close friends"},
    {id:"except", label:"My contacts except…"}
];
let statusVisibilityIndex = 0;

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

    loadStatuses();
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


function showStatusToast(message, error){
    const host = document.getElementById("statusToastHost");
    if (!host || !message) return;
    const toast = document.createElement("div");
    toast.className = "status-toast" + (error ? " error" : "");
    toast.textContent = message;
    host.appendChild(toast);
    setTimeout(() => toast.remove(), 2400);
}

function getStatusPrivacy(){
    try{
        const value = JSON.parse(localStorage.getItem(STATUS_PRIVACY_KEY) || "{}");
        return {
            hideViewed: !!value.hideViewed,
            blockScreenshots: !!value.blockScreenshots,
            visibility: value.visibility || "contacts"
        };
    }catch(_error){
        return {hideViewed:false, blockScreenshots:false, visibility:"contacts"};
    }
}

function saveStatusPrivacy(next){
    localStorage.setItem(STATUS_PRIVACY_KEY, JSON.stringify(next));
}

function syncStatusPrivacySwitches(){
    const privacy = getStatusPrivacy();
    document.getElementById("statusHideViewedSwitch")?.classList.toggle("on", privacy.hideViewed);
    document.getElementById("statusBlockShotsSwitch")?.classList.toggle("on", privacy.blockScreenshots);
    const visIndex = STATUS_VISIBILITY_OPTIONS.findIndex(item => item.id === privacy.visibility);
    statusVisibilityIndex = visIndex >= 0 ? visIndex : 0;
    const label = document.getElementById("statusVisibilityLabel");
    if (label) label.textContent = STATUS_VISIBILITY_OPTIONS[statusVisibilityIndex].label;
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

function cycleStatusVisibility(){
    statusVisibilityIndex = (statusVisibilityIndex + 1) % STATUS_VISIBILITY_OPTIONS.length;
    const option = STATUS_VISIBILITY_OPTIONS[statusVisibilityIndex];
    const privacy = getStatusPrivacy();
    privacy.visibility = option.id;
    saveStatusPrivacy(privacy);
    const label = document.getElementById("statusVisibilityLabel");
    if (label) label.textContent = option.label;
    setStatusMessage("Status visibility: " + option.label + ".");
    syncStatusComposerPreview();
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

function rememberStatusLike(id, liked){
    if (id == null) return;
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
        const onclick = item.getAttribute("onclick") || "";
        const match = onclick.match(/openChat\('([^']+)'\)/);
        const username = match ? match[1] : name;
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
    const sender = String(CURRENT_DASHBOARD_USER || "{{ username }}" || "").trim();
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
    const friend = String(username);
    const mediaUrl = currentStatus.media_url || "";
    const caption = currentStatus.text || "";
    const fromName = statusOwnerName(currentStatus);
    const forwardText = caption
        ? `Forwarded status from ${fromName}: ${caption}`
        : `Forwarded status from ${fromName}`;

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
    const sent = await postChatMessage({
        username: friend,
        text: forwardText,
        mediaUrl,
        kind: "status-forward"
    });

    closeStatusSheets();
    closeStatusViewer();
    showStatusToast(sent ? "Status forwarded" : "Opening chat to forward");
    openChatWithDraft(friend, "forward=1&from_status=1");
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
            likers: [],
            repliesList: [],
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
                    likers,
                    repliesList,
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
        likers: [],
        repliesList: [],
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

    // The owner engagement panel is server-authoritative.
    // Never merge browser-local viewer/liker caches into this panel because
    // those caches can survive older tests, browser sessions, or old UI state.
    const viewers = Array.isArray(fetched.viewers)
        ? fetched.viewers.slice()
        : [];

    const likers = Array.isArray(fetched.likers)
        ? fetched.likers.slice()
        : [];

    const replies = Array.isArray(fetched.repliesList)
        ? fetched.repliesList.slice()
        : [];

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
            replied_at: viewer.replied_at
        });
    }

    if (stats) {
        stats.hidden = false;
        stats.innerHTML = `
            <div class="status-engage-chip">
                <b>${fetched.fromApi ? Number(fetched.views) : viewers.length}</b>
                <span>Views</span>
            </div>
            <div class="status-engage-chip">
                <b>${fetched.fromApi ? Number(fetched.likes) : likers.length}</b>
                <span>Likes</span>
            </div>
            <div class="status-engage-chip">
                <b>${fetched.fromApi ? Number(fetched.replies) : replies.length}</b>
                <span>Replies</span>
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
        Number(fetched.views) || viewers.length
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

    const visibility = STATUS_VISIBILITY_OPTIONS[statusVisibilityIndex] || STATUS_VISIBILITY_OPTIONS[0];
    const audience = document.getElementById("statusAudienceHint");
    if (audience) audience.textContent = visibility.label;

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

async function loadStatuses(){
    const row = document.getElementById("statusRow");
    if (!row) return;

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

        loadedStatuses = Array.isArray(data.statuses) ? data.statuses : [];
        statusViewerStatuses = buildStatusViewerList(loadedStatuses);
        renderStatuses();
    } catch (error) {
        console.debug("Status list unavailable; keeping current shelf:", error);
    }
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
                <span class="status-hint" ${myNewest ? `data-status-created="${escapeHtml(myNewest.created_at)}` : ""}>${myAge}</span>
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

    const heartButton = document.getElementById("statusHeartButton");
    if (heartButton) {
        heartButton.style.display = currentStatus.is_mine ? "none" : "flex";
        heartButton.classList.remove("liked","pop");

        // Never trust the browser's cached like state when opening a story.
        // The server is authoritative for whether THIS account currently
        // likes THIS status. Start visually unliked, then reconcile from the
        // engagement endpoint without re-playing the like animation.
        paintStatusHeart(heartButton, false);

        if (!heartButton.querySelector("svg")) {
            heartButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.8 8.6c0 5.2-8.8 11-8.8 11S3.2 13.8 3.2 8.6A4.6 4.6 0 0 1 12 6.7a4.6 4.6 0 0 1 8.8 1.9z"></path></svg>';
        }

        if (!currentStatus.is_mine) {
            const openedStatusId = getStatusReactionId(currentStatus);
            const openedStatus = currentStatus;

            void fetchStatusViewers(openedStatus).then(result => {
                // Do not let a late response for an older story overwrite the
                // currently visible story or a deliberate like/unlike tap.
                if (!currentStatus) return;
                if (getStatusReactionId(currentStatus) !== openedStatusId) return;
                if (!result?.fromApi) return;

                const ownKey = String(CURRENT_DASHBOARD_USER || "").trim().toLowerCase();
                const serverLiked = (Array.isArray(result.likers) ? result.likers : [])
                    .some(person =>
                        String(person?.username || person?.user || "")
                            .trim()
                            .toLowerCase() === ownKey
                    );

                // Reconcile the browser cache with server truth. In
                // particular, remove a stale cached "liked" flag when the
                // server says this account is not a liker.
                rememberStatusLike(openedStatusId, serverLiked);
                paintStatusHeart(heartButton, serverLiked);
            }).catch(() => {
                // Keep the safe unliked visual state when the server cannot
                // confirm a previous like. A deliberate new tap still works.
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

connectDashboardSocket();
startDashboardTimers();

void loadServerPinnedChats();
void refreshDashboard();

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
let dashboardRefreshInFlight = false;

async function refreshDashboard(){

    const generation = ++dashboardRefreshGeneration;

    // Multiple dashboard_update events plus the timer can overlap. A slower,
    // older refresh must never overwrite a newer dashboard state.
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

        // Never treat an invalid/temporary response as an instruction to
        // erase conversations already shown on the dashboard.
        if (!Array.isArray(payload)) {
            console.warn("DASHBOARD DATA: expected an array; keeping current chat list.");
            return;
        }

        const chats = payload.filter(chat => chat && typeof chat === "object");

        const settled = await Promise.allSettled(
            chats.map(decryptDashboardPreview)
        );

        // Ignore results from an older refresh once a newer request started.
        if (generation !== dashboardRefreshGeneration) {
            return;
        }

        // A failed decrypt must never leak ciphertext into the visible UI.
        settled.forEach((result, index) => {
            if (result.status === "rejected") {
                chats[index].last = "🔒 Encrypted message";
            }
        });

        console.log("DASHBOARD DATA:", chats);

        const chatList = document.querySelector(".chat-list");
        if (!chatList) return;

        const pinned = getPinnedChats();

        const orderedChats = [...chats].sort((a, b) => {
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

        // An empty result is not enough evidence that there are no chats.
        // Keep the existing server-rendered/current list visible.
        if (orderedChats.length === 0) {
            updateOnlineUsers();
            searchChats();
            return;
        }

        // Build the entire replacement off-DOM first. This prevents a single
        // malformed chat record from leaving the dashboard completely blank.
        let renderedChatList = "";

        orderedChats.forEach(chat => {
            try {
                const username = String(chat.username ?? "").trim();
                if (!username) return;

                const senderName =
                    chat.sender === "{{ username }}"
                    ? "You"
                    : (chat.display_name || username);

                let messageText = chat.last || "";

                if (!messageText && chat.media_type === "image") {
                    messageText = "📷 Photo";
                } else if (!messageText && chat.media_type === "audio") {
                    messageText = "🎙️ Voice message";
                }

                const trimmedText = String(messageText).substring(0, 30);
                const preview = messageText
                    ? `${escapeDashboardText(senderName)}: ${escapeDashboardText(trimmedText)}${String(messageText).length > 30 ? "..." : ""}`
                    : "No messages yet";

                const unread = Number(chat.unread) || 0;
                const badge = unread > 0
                    ? `<span class="badge">${unread}</span>`
                    : "";

                const safeUsername = username.replace(/'/g, "\\'");
                const profile = chat.profile || "/static/profile/default.png";
                const displayName = escapeDashboardText(chat.display_name || username);
                const escapedUsername = escapeDashboardText(username);
                const pinMark = isPinned(username)
                    ? ' <span class="chat-pin">📌</span>'
                    : "";
                const activeClass = unread > 0 ? " has-unread" : "";
                const pinnedClass = isPinned(username) ? " is-pinned" : "";

                renderedChatList += `
    <div class="chat-item${activeClass}${pinnedClass}"
         data-username="${escapedUsername}"
         onclick="openChat('${safeUsername}')"
         oncontextmenu="showChatMenu(event, '${safeUsername}')">

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
            } catch (chatRenderError) {
                console.warn("Skipping malformed dashboard chat record:", chatRenderError, chat);
            }
        });

        // Never replace a working list with an empty render.
        if (renderedChatList.trim()) {
            chatList.innerHTML = renderedChatList;
        }

        updateOnlineUsers();
        searchChats();

    } catch (error) {
        // Preserve whatever conversation list is already on screen when
        // the refresh endpoint/network temporarily fails.
        console.error("DASHBOARD REFRESH ERROR:", error);
    }
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

