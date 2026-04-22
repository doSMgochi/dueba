import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-functions.js";
import { db, functions } from "./firebase.js";

const THREE_MODULE_URL = "https://esm.sh/three@0.165.0";
const CANNON_MODULE_URL = "https://esm.sh/cannon-es@0.20.0";
const THREE_ROUNDED_BOX_URL =
  "https://esm.sh/three@0.165.0/examples/jsm/geometries/RoundedBoxGeometry.js";
const yachtActionCallable = httpsCallable(functions, "yachtAction");

const YACHT_MAX_PLAYERS = 4;
const YACHT_DICE_COUNT = 5;
const YACHT_ROLL_ANIMATION_MS = 3400;
const YACHT_TURN_LIMIT_MS = 30000;
const YACHT_ROOM_LIST_LIMIT = 30;
const YACHT_PENDING_TIMEOUT_MS = 15000;

const ROOM_STATUS_WAITING = "waiting";
const ROOM_STATUS_PLAYING = "playing";
const ROOM_STATUS_FINISHED = "finished";

const PHASE_WAITING = "waiting";
const PHASE_AWAITING_ROLL = "awaiting-roll";
const PHASE_ROLLING = "rolling";
const PHASE_FINISHED = "finished";

const UPPER_IDS = ["aces", "deuces", "threes", "fours", "fives", "sixes"];
const LOWER_IDS = ["choice", "threeKind", "fourKind", "fullHouse", "smallStraight", "largeStraight", "yacht"];

const SCORE_ROWS = [
  { id: "aces", label: "\uc5d0\uc774\uc2a4" },
  { id: "deuces", label: "\ub4c0\uc2a4" },
  { id: "threes", label: "\ud2b8\ub9ac" },
  { id: "fours", label: "\ud3ec" },
  { id: "fives", label: "\ud30c\uc774\ube0c" },
  { id: "sixes", label: "\uc2dd\uc2a4" },
  { id: "upperSubtotal", label: "\uc0c1\ub2e8 \ud569\uacc4", summary: true },
  { id: "bonus", label: "\ubcf4\ub108\uc2a4 35", summary: true },
  { id: "choice", label: "\ucd08\uc774\uc2a4" },
  { id: "threeKind", label: "\uc4f0\ub9ac \uc624\ube0c \uc5b4 \uce74\uc778\ub4dc" },
  { id: "fourKind", label: "\ud3ec\uce74\ub4dc" },
  { id: "fullHouse", label: "\ud480\ud558\uc6b0\uc2a4" },
  { id: "smallStraight", label: "\uc2a4\ubab0 \uc2a4\ud2b8\ub808\uc774\ud2b8" },
  { id: "largeStraight", label: "\ub77c\uc9c0 \uc2a4\ud2b8\ub808\uc774\ud2b8" },
  { id: "yacht", label: "\uc694\ud2b8" },
  { id: "finalScore", label: "\ucd1d\uc810", summary: true },
];

const PLAYABLE_CATEGORY_IDS = SCORE_ROWS.filter((row) => !row.summary).map((row) => row.id);

let roomListUnsubscribe = null;
let activeRoomUnsubscribe = null;
let automationIntervalId = 0;
let automationWakeTimeoutId = 0;
let boardViewCleanup = null;
let boardEnginePromise = null;
let lifecycleResumeCleanup = null;
const boardPoseCache = new Map();
const boardVisualDiceCache = new Map();
let boardVisualSyncKey = "";
let boardVisualSyncPromise = null;
let boardViewSignature = "";
let boardMountRequestId = 0;

let yachtState = {
  profile: null,
  onProfilePatched: null,
  onToast: null,
  rooms: [],
  room: null,
  roomId: "",
};

export function cleanupYachtModule() {
  if (typeof roomListUnsubscribe === "function") roomListUnsubscribe();
  if (typeof activeRoomUnsubscribe === "function") activeRoomUnsubscribe();
  if (typeof boardViewCleanup === "function") boardViewCleanup();
  window.clearInterval(automationIntervalId);
  window.clearTimeout(automationWakeTimeoutId);
  if (typeof lifecycleResumeCleanup === "function") lifecycleResumeCleanup();
  roomListUnsubscribe = null;
  activeRoomUnsubscribe = null;
  automationIntervalId = 0;
  automationWakeTimeoutId = 0;
  boardViewCleanup = null;
  lifecycleResumeCleanup = null;
  boardPoseCache.clear();
  boardVisualDiceCache.clear();
  boardVisualSyncKey = "";
  boardVisualSyncPromise = null;
  boardViewSignature = "";
  boardMountRequestId = 0;
  yachtState = {
    profile: null,
    onProfilePatched: null,
    onToast: null,
    rooms: [],
    room: null,
    roomId: "",
  };
}

export function renderYachtMenu() {
  return `
    <div id="yacht-root" class="yacht-root">
      <article class="content-card full">
        <p class="muted">\uc694\ud2b8 \ud654\uba74\uc744 \ubd88\ub7ec\uc624\ub294 \uc911\uc785\ub2c8\ub2e4.</p>
      </article>
    </div>
  `;
}

export function initYachtMenu({ profile, onProfilePatched, onToast }) {
  cleanupYachtModule();
  yachtState.profile = profile;
  yachtState.onProfilePatched = onProfilePatched;
  yachtState.onToast = onToast;
  yachtState.roomId = String(profile?.activeYachtRoomId || "").trim();

  subscribeRoomList();
  if (yachtState.roomId) {
    subscribeActiveRoom(yachtState.roomId);
  } else {
    renderYachtRoot();
  }

  lifecycleResumeCleanup = bindLifecycleResumeHandlers();
  automationIntervalId = window.setInterval(() => {
    updateVisibleTimers();
    void maybeAdvanceByTimeout();
  }, 250);
  scheduleAutomationWake();
}

function subscribeRoomList() {
  const roomQuery = query(collection(db, "yacht-rooms"), orderBy("updatedAtMs", "desc"));
  roomListUnsubscribe = onSnapshot(roomQuery, (snapshot) => {
    yachtState.rooms = snapshot.docs
      .map((item) => ({ id: item.id, ...item.data() }))
      .filter((room) => [ROOM_STATUS_WAITING, ROOM_STATUS_PLAYING].includes(String(room.status || "")))
      .slice(0, YACHT_ROOM_LIST_LIMIT);
    renderYachtRoot();
    scheduleAutomationWake();
  });
}

function subscribeActiveRoom(roomId) {
  if (!roomId) {
    yachtState.room = null;
    renderYachtRoot();
    return;
  }

  activeRoomUnsubscribe = onSnapshot(doc(db, "yacht-rooms", roomId), async (snapshot) => {
    if (!snapshot.exists()) {
      yachtState.onToast?.forceHide?.();
      yachtState.room = null;
      yachtState.roomId = "";
      await clearActiveRoom();
      renderYachtRoot();
      scheduleAutomationWake();
      return;
    }

    yachtState.room = { id: snapshot.id, ...snapshot.data() };
    renderYachtRoot();
    updateVisibleTimers();
    void maybeAdvanceByTimeout();
    scheduleAutomationWake();
  });
}

function renderYachtRoot() {
  const root = document.querySelector("#yacht-root");
  if (!root) return;
  if (String(yachtState.room?.status || "") !== ROOM_STATUS_PLAYING && typeof boardViewCleanup === "function") {
    boardViewCleanup();
    boardViewCleanup = null;
    boardViewSignature = "";
  }

  if (!yachtState.room) {
    yachtState.onToast?.forceHide?.();
    root.innerHTML = renderLobbyView();
    bindLobbyEvents();
    return;
  }

  const status = String(yachtState.room.status || "");
  if (status === ROOM_STATUS_WAITING) {
    root.innerHTML = renderWaitingRoomView(yachtState.room);
    bindWaitingRoomEvents(yachtState.room);
    return;
  }

  if (status === ROOM_STATUS_PLAYING) {
    const currentPlayingView = root.querySelector("[data-yacht-playing-view]");
    if (!currentPlayingView || String(currentPlayingView.getAttribute("data-yacht-playing-view") || "") !== String(yachtState.room.id || "")) {
      root.innerHTML = renderPlayingRoomView(yachtState.room);
    } else {
      updatePlayingRoomView(yachtState.room);
    }
    bindPlayingRoomEvents(yachtState.room);
    updateVisibleTimers();
    void mountPhysicsBoard(yachtState.room);
    return;
  }

  root.innerHTML = renderFinishedRoomView(yachtState.room);
  bindFinishedRoomEventsV2(yachtState.room);
}

function renderLobbyView() {
  return `
    <div class="yacht-lobby-center">
      <article class="content-card yacht-card yacht-lobby-panel">
        <div class="yacht-lobby-head">
          <div>
            <p class="eyebrow">YACHT</p>
            <h3>\uc694\ud2b8 \ubc29 \ubaa9\ub85d</h3>
            <p class="muted">\ubc29\uc744 \ub9cc\ub4e4\uba74 \ubc14\ub85c \ub300\uae30\uc2e4\ub85c \uc774\ub3d9\ud569\ub2c8\ub2e4. \uac8c\uc784\uc774 \uc2dc\uc791\ub41c \ubc29\uc740 \uad00\uc804\ud560 \uc218 \uc788\uc2b5\ub2c8\ub2e4.</p>
          </div>
          <div class="action-row">
            <button type="button" id="yacht-create-button" class="primary-button compact-button">\ubc29 \ub9cc\ub4e4\uae30</button>
            <button type="button" id="yacht-refresh-button" class="ghost-button compact-button">\uc0c8\ub85c\uace0\uce68</button>
          </div>
        </div>

        <div class="stack-list">
          ${renderLobbyRoomCards()}
        </div>
      </article>
    </div>
  `;
}

function renderLobbyRoomCards() {
  if (!yachtState.rooms.length) {
    return '<p class="muted">\ud604\uc7ac \uc5f4\ub824 \uc788\ub294 \ubc29\uc774 \uc5c6\uc2b5\ub2c8\ub2e4.</p>';
  }

  return yachtState.rooms
    .map((room) => {
      const players = Array.isArray(room.players) ? room.players : [];
      const spectators = Array.isArray(room.spectators) ? room.spectators : [];
      const isWaiting = String(room.status || "") === ROOM_STATUS_WAITING;
      const isPlaying = String(room.status || "") === ROOM_STATUS_PLAYING;
      const isPlayerJoined = players.some((item) => item.uid === yachtState.profile?.uid);
      const isSpectatorJoined = spectators.some((item) => item.uid === yachtState.profile?.uid);
      const canJoin = isWaiting && players.length < YACHT_MAX_PLAYERS && !isPlayerJoined;
      const canSpectate = isPlaying && !isSpectatorJoined && !isPlayerJoined;

      return `
        <article class="info-card yacht-room-card">
          <div class="info-card-head">
            <strong>${escapeHtml(room.title || "\uc694\ud2b8 \ubc29")}</strong>
            <span class="pill-badge">${isWaiting ? "\ub300\uae30 \uc911" : "\uc9c4\ud589 \uc911"}</span>
          </div>
          <p class="muted">\ud50c\ub808\uc774\uc5b4 ${players.length}/${YACHT_MAX_PLAYERS}\uba85 \u00b7 \uad00\uc804\uc790 ${spectators.length}\uba85</p>
          <div class="yacht-room-roster">
            ${players.map((player) => `<span class="pill-badge">${escapeHtml(player.characterName || "-")}</span>`).join("")}
          </div>
          <div class="action-row">
            ${canJoin ? `<button type="button" class="primary-button compact-button" data-yacht-join="${room.id}">\uc785\uc7a5</button>` : ""}
            ${canSpectate ? `<button type="button" class="ghost-button compact-button" data-yacht-spectate="${room.id}">\uad00\uc804</button>` : ""}
          </div>
        </article>
      `;
    })
    .join("");
}

function renderWaitingRoomView(room) {
  const me = getRoomPlayer(room, yachtState.profile?.uid);
  const isOwner = String(room.ownerUid || "") === String(yachtState.profile?.uid || "");
  const canStart = canHostStartGame(room, yachtState.profile?.uid);

  return `
    <div class="yacht-single-shell">
      <article class="content-card yacht-room-stage">
        <div class="yacht-stage-head">
          <div>
            <p class="eyebrow">\ub300\uae30\uc2e4</p>
            <h3>${escapeHtml(room.title || "\uc694\ud2b8 \ubc29")}</h3>
          </div>
          <div class="action-row">
            ${me && !isOwner ? `<button type="button" class="ghost-button compact-button" data-yacht-ready>${me.isReady ? "\uc900\ube44 \ucde8\uc18c" : "\uc900\ube44 \uc644\ub8cc"}</button>` : ""}
            ${isOwner ? `<button type="button" class="primary-button compact-button" data-yacht-start ${canStart ? "" : "disabled"}>\uac8c\uc784 \uc2dc\uc791</button>` : ""}
            <button type="button" class="ghost-button compact-button" data-yacht-leave>${me ? "\ubc29 \ub098\uac00\uae30" : "\uad00\uc804 \uc885\ub8cc"}</button>
          </div>
        </div>

        <article class="content-card yacht-subcard">
          <h3>\ud50c\ub808\uc774\uc5b4</h3>
          <div class="yacht-participant-list">
            ${(Array.isArray(room.players) ? room.players : [])
              .map((player, index) => {
                const isPlayerOwner = String(player.uid || "") === String(room.ownerUid || "");
                return `
                  <article class="yacht-participant ${isPlayerOwner ? "is-owner" : ""}">
                    <strong>${index + 1}. ${escapeHtml(player.characterName || "-")}</strong>
                    <span>${escapeHtml(player.nickname || "-")}</span>
                    <small>${isPlayerOwner ? "\ubc29\uc7a5" : player.isReady ? "\uc900\ube44 \uc644\ub8cc" : "\uc900\ube44 \ub300\uae30"}</small>
                  </article>
                `;
              })
              .join("")}
          </div>
        </article>
      </article>
    </div>
  `;
}

function renderPlayingRoomView(room) {
  const currentPlayer = getCurrentTurnPlayer(room);
  const canToggleHold = canCurrentUserToggleHold(room, yachtState.profile?.uid);
  const me = getRoomPlayer(room, yachtState.profile?.uid);
  const timer = getTimerState(room);

  return `
    <div class="yacht-single-shell" data-yacht-playing-view="${escapeHtml(room.id)}">
      <article class="content-card yacht-room-stage yacht-room-stage-play">
        <div class="yacht-stage-head yacht-stage-head-tight">
          <div>
            <p class="eyebrow">\uac8c\uc784 \ubc29</p>
            <h3>${escapeHtml(room.title || "\uc694\ud2b8 \ubc29")}</h3>
          </div>
          <div class="action-row">
            <div class="yacht-turn-chip">${escapeHtml(currentPlayer?.characterName || "-")} \ucc28\ub840</div>
            <button type="button" class="ghost-button compact-button" data-yacht-leave>${me ? "\ubc29 \ub098\uac00\uae30" : "\uad00\uc804 \uc885\ub8cc"}</button>
          </div>
        </div>

        <div class="yacht-live-bar">
          <div class="yacht-live-meter">
            <div id="yacht-timer-fill" class="yacht-live-meter-fill" style="width:${timer.progress}%"></div>
          </div>
        </div>

        ${renderSpectatorRoster(room)}

        <div class="yacht-match-layout">
          <section class="content-card yacht-subcard yacht-board-card">
            <div class="yacht-section-head compact yacht-section-head-slim">
              <div>
                <h3>\uc8fc\uc0ac\uc704</h3>
              </div>
            </div>
            <div class="yacht-board-shell">
              ${buildCircularBoard(room)}
            </div>
            ${buildHeldDiceRackV2(room, canToggleHold)}
            <div class="action-row yacht-action-row">
              ${renderPlayingActionRow(room, yachtState.profile?.uid)}
            </div>
          </section>

          <section class="content-card yacht-subcard yacht-score-panel">
            <div class="yacht-section-head compact yacht-section-head-slim"><h3>\uC810\uC218\uD45C</h3></div>
            ${buildScoreMatrix(room)}
          </section>
        </div>
      </article>
    </div>
  `;
}

function renderSpectatorRoster(room) {
  return Array.isArray(room.spectators) && room.spectators.length
    ? `<div class="yacht-room-roster">${room.spectators
        .map((item) => `<span class="pill-badge">${escapeHtml(item.characterName || "-")} \uad00\uc804 \uc911</span>`)
        .join("")}</div>`
    : "";
}

function renderPlayingActionRow(room, uid) {
  const isMyTurn =
    String(room.status || "") === ROOM_STATUS_PLAYING &&
    String(room.actionPhase || "") === PHASE_AWAITING_ROLL &&
    String(getCurrentTurnPlayer(room)?.uid || "") === String(uid || "");
  if (!isMyTurn) return "";

  const rollCount = Number(room.rollCount || 0);
  const canRoll = canCurrentUserRoll(room, uid);
  return `
    <button type="button" class="primary-button" data-yacht-roll ${canRoll ? "" : "disabled"}>\uad74\ub9ac\uae30 ${rollCount}/3</button>
  `;
}

function updatePlayingRoomView(room) {
  const view = document.querySelector(`[data-yacht-playing-view="${CSS.escape(String(room.id || ""))}"]`);
  if (!view) return;

  const currentPlayer = getCurrentTurnPlayer(room);
  const canToggleHold = canCurrentUserToggleHold(room, yachtState.profile?.uid);

  const turnChip = view.querySelector(".yacht-turn-chip");
  if (turnChip) {
    turnChip.textContent = `${currentPlayer?.characterName || "-"} 차례`;
  }

  const matchLayout = view.querySelector(".yacht-match-layout");
  const nextRosterMarkup = renderSpectatorRoster(room);
  const existingRoster = view.querySelector(".yacht-room-roster");
  if (nextRosterMarkup) {
    if (existingRoster) {
      existingRoster.outerHTML = nextRosterMarkup;
    } else {
      matchLayout?.insertAdjacentHTML("beforebegin", nextRosterMarkup);
    }
  } else {
    existingRoster?.remove();
  }


  const heldRack = view.querySelector(".yacht-held-rack");
  if (heldRack) {
    heldRack.outerHTML = buildHeldDiceRackV2(room, canToggleHold);
  }

  const actionRow = view.querySelector(".yacht-action-row");
  if (actionRow) {
    actionRow.innerHTML = renderPlayingActionRow(room, yachtState.profile?.uid);
  }

  const scorePanel = view.querySelector(".yacht-score-panel");
  if (scorePanel) {
    scorePanel.innerHTML = `
      <div class="yacht-section-head compact yacht-section-head-slim"><h3>\uC810\uC218\uD45C</h3></div>
      ${buildScoreMatrix(room)}
    `;
  }
}

function renderFinishedRoomView(room) {
  const roomPlayer = getRoomPlayer(room, yachtState.profile?.uid);
  return `
    <div class="yacht-single-shell">
      <article class="content-card yacht-room-stage yacht-room-stage-finished">
        <div class="yacht-stage-head">
          <div>
            <p class="eyebrow">\uacb0\uacfc</p>
            <h3>${escapeHtml(room.title || "\uc694\ud2b8 \uacb0\uacfc")}</h3>
            <p class="muted">\uac8c\uc784\uc774 \uc885\ub8cc\ub418\uc5c8\uc2b5\ub2c8\ub2e4. \uc7ac\uc2dc\uc791\uc744 \ub204\ub974\uba74 \ub300\uae30\uc2e4\ub85c \ubcf5\uadc0\ud569\ub2c8\ub2e4.</p>
          </div>
          <div class="action-row">
            <button type="button" class="ghost-button compact-button" data-yacht-leave>\ub098\uac00\uae30</button>
          </div>
        </div>
        <div class="yacht-finished-summary">
          <p class="muted">\uac00\uc7a5 \uba3c\uc800 \uc7ac\uc2dc\uc791\uc744 \ub204\ub978 \ud50c\ub808\uc774\uc5b4\uac00 \uc0c8 \ub300\uae30\uc2e4\uc758 \ubc29\uc7a5\uc774 \ub429\ub2c8\ub2e4.</p>
          <div class="action-row">
            ${roomPlayer ? '<button type="button" class="primary-button" data-yacht-restart>\uc7ac\uc2dc\uc791</button>' : ""}
          </div>
        </div>
      </article>
      ${buildFinalRanking(room)}
    </div>
  `;
}

function bindLobbyEvents() {
  document.querySelector("#yacht-create-button")?.addEventListener("click", async () => {
    try {
      await withPendingToast(async () => {
        const roomId = await createRoom(createRandomRoomCode());
        await setActiveRoom(roomId, "player");
      });
      yachtState.onToast?.("\ubc29\uc744 \ub9cc\ub4e4\uc5c8\uc2b5\ub2c8\ub2e4.");
    } catch (error) {
      yachtState.onToast?.(error.message, true);
    }
  });

  document.querySelector("#yacht-refresh-button")?.addEventListener("click", () => {
    renderYachtRoot();
    yachtState.onToast?.("\ubc29 \ubaa9\ub85d\uc744 \uc0c8\ub85c\uace0\uce68\ud588\uc2b5\ub2c8\ub2e4.");
  });

  document.querySelectorAll("[data-yacht-join]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await withPendingToast(async () => {
          await joinRoom(button.dataset.yachtJoin);
          await setActiveRoom(button.dataset.yachtJoin, "player");
        });
        yachtState.onToast?.("\ubc29\uc5d0 \uc785\uc7a5\ud588\uc2b5\ub2c8\ub2e4.");
      } catch (error) {
        yachtState.onToast?.(error.message, true);
      }
    });
  });

  document.querySelectorAll("[data-yacht-spectate]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await withPendingToast(async () => {
          await joinAsSpectator(button.dataset.yachtSpectate);
          await setActiveRoom(button.dataset.yachtSpectate, "spectator");
        });
        yachtState.onToast?.("\uad00\uc804\uc744 \uc2dc\uc791\ud588\uc2b5\ub2c8\ub2e4.");
      } catch (error) {
        yachtState.onToast?.(error.message, true);
      }
    });
  });
}

function bindWaitingRoomEvents(room) {
  document.querySelector("[data-yacht-ready]")?.addEventListener("click", async () => {
    try {
      await withPendingToast(() => toggleReady(room.id));
      yachtState.onToast?.("\uc900\ube44 \uc0c1\ud0dc\ub97c \ubcc0\uacbd\ud588\uc2b5\ub2c8\ub2e4.");
    } catch (error) {
      yachtState.onToast?.(error.message, true);
    }
  });

  document.querySelector("[data-yacht-start]")?.addEventListener("click", async () => {
    try {
      await withPendingToast(() => startGame(room.id));
      yachtState.onToast?.("\uac8c\uc784\uc744 \uc2dc\uc791\ud588\uc2b5\ub2c8\ub2e4.");
    } catch (error) {
      yachtState.onToast?.(error.message, true);
    }
  });

  document.querySelector("[data-yacht-leave]")?.addEventListener("click", async () => {
    try {
      yachtState.onToast?.forceHide?.();
      await withPendingToast(async () => {
        await leaveRoom(room.id);
        await clearActiveRoom();
      });
      yachtState.onToast?.forceHide?.();
      yachtState.onToast?.("\ubc29\uc5d0\uc11c \ub098\uac14\uc2b5\ub2c8\ub2e4.");
    } catch (error) {
      yachtState.onToast?.(error.message, true);
    }
  });
}

function bindPlayingRoomEvents(room) {
  document.querySelector("[data-yacht-roll]")?.addEventListener("click", async () => {
    try {
      await withPendingToast(() => requestRoll(room.id));
      yachtState.onToast?.("\uc8fc\uc0ac\uc704\ub97c \uad74\ub838\uc2b5\ub2c8\ub2e4.");
    } catch (error) {
      yachtState.onToast?.(error.message, true);
    }
  });

  document.querySelectorAll("[data-yacht-score-category]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await withPendingToast(() => lockScore(room.id, button.dataset.yachtScoreCategory));
        yachtState.onToast?.("\uc810\uc218\ub97c \ub4f1\ub85d\ud588\uc2b5\ub2c8\ub2e4.");
      } catch (error) {
        yachtState.onToast?.(error.message, true);
      }
    });
  });

  document.querySelectorAll("[data-yacht-held-slot]").forEach((button) => {
    button.addEventListener("click", async () => {
      const index = Number(button.dataset.yachtHeldSlot);
      if (!Number.isInteger(index)) return;
      try {
        await withPendingToast(() => toggleHold(room.id, index, buildLocalVisualDiceStatePayload(yachtState.room || room)));
      } catch (error) {
        yachtState.onToast?.(error.message, true);
      }
    });
  });

  document.querySelector("[data-yacht-leave]")?.addEventListener("click", async () => {
    try {
      yachtState.onToast?.forceHide?.();
      await withPendingToast(async () => {
        await leaveRoom(room.id);
        await clearActiveRoom();
      });
      yachtState.onToast?.forceHide?.();
      yachtState.onToast?.("\ubc29\uc5d0\uc11c \ub098\uac14\uc2b5\ub2c8\ub2e4.");
    } catch (error) {
      yachtState.onToast?.(error.message, true);
    }
  });

}

function bindFinishedRoomEvents(room) {
  document.querySelectorAll("[data-yacht-restart]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await withPendingToast(() => restartFinishedRoom(room.id));
        yachtState.onToast?.("대기실로 복귀했습니다. 먼저 재시작한 플레이어가 방장이 됩니다.");
      } catch (error) {
        yachtState.onToast?.(error.message, true);
      }
    });
  });

  document.querySelectorAll("[data-yacht-leave]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await withPendingToast(async () => {
          await leaveRoom(room.id);
          await clearActiveRoom();
        });
        yachtState.onToast?.forceHide?.();
        yachtState.onToast?.("방에서 나갔습니다.");
      } catch (error) {
        yachtState.onToast?.(error.message, true);
      }
    });
  });
}

function bindFinishedRoomEventsV2(room) {
  document.querySelectorAll("[data-yacht-restart]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        const result = await withPendingToast(() => restartFinishedRoom(room.id));
        if (result?.redirectLobby) {
          yachtState.onToast?.("\uc774\ubbf8 \ub2e4\uc74c \uac8c\uc784\uc774 \uc2dc\uc791\ub418\uc5b4 \ub85c\ube44\ub85c \ubcf5\uadc0\ud588\uc2b5\ub2c8\ub2e4.");
          return;
        }
        yachtState.onToast?.("\uc7ac\uc2dc\uc791 \ub300\uae30\uc2e4\ub85c \uc774\ub3d9\ud588\uc2b5\ub2c8\ub2e4. \uba3c\uc800 \ub3cc\uc544\uc628 \ud50c\ub808\uc774\uc5b4\uac00 \ubc29\uc7a5\uc785\ub2c8\ub2e4.");
      } catch (error) {
        yachtState.onToast?.(error.message, true);
      }
    });
  });

  document.querySelectorAll("[data-yacht-leave]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        yachtState.onToast?.forceHide?.();
        await withPendingToast(async () => {
          await leaveRoom(room.id);
          await clearActiveRoom();
        });
        yachtState.onToast?.forceHide?.();
        yachtState.onToast?.("\ubc29\uc5d0\uc11c \ub098\uac14\uc2b5\ub2c8\ub2e4.");
      } catch (error) {
        yachtState.onToast?.(error.message, true);
      }
    });
  });
}

async function withPendingToast(task) {
  yachtState.onToast?.("\ucc98\ub9ac\uc911\uc785\ub2c8\ub2e4.", false, { persist: true });
  const safetyTimer = window.setTimeout(() => {
    yachtState.onToast?.forceHide?.();
  }, YACHT_PENDING_TIMEOUT_MS);

  try {
    return await task();
  } finally {
    window.clearTimeout(safetyTimer);
    yachtState.onToast?.forceHide?.();
  }
}

function updateVisibleTimers() {
  const room = yachtState.room;
  if (!room || String(room.status || "") !== ROOM_STATUS_PLAYING) return;

  const fillEl = document.querySelector("#yacht-timer-fill");
  if (!fillEl) return;

  const timer = getTimerState(room);
  fillEl.style.width = `${timer.progress}%`;
}

function bindLifecycleResumeHandlers() {
  const handleResume = () => {
    if (typeof boardViewCleanup === "function") {
      boardViewCleanup();
      boardViewCleanup = null;
    }
    boardViewSignature = "";
    if (yachtState.room?.id) {
      const roomKey = String(yachtState.room.id || "");
      boardPoseCache.delete(roomKey);
      boardVisualDiceCache.delete(roomKey);
    }
    updateVisibleTimers();
    scheduleAutomationWake();
    void maybeAdvanceByTimeout();

    if (yachtState.room && String(yachtState.room.status || "") === ROOM_STATUS_PLAYING) {
      const boardEl = document.querySelector("[data-yacht-physics-board]");
      if (boardEl) {
        void mountPhysicsBoard(yachtState.room);
      }
    }
  };

  const onVisibilityChange = () => {
    if (!document.hidden) {
      handleResume();
    }
  };

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("focus", handleResume);
  window.addEventListener("pageshow", handleResume);

  return () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("focus", handleResume);
    window.removeEventListener("pageshow", handleResume);
  };
}

function scheduleAutomationWake() {
  window.clearTimeout(automationWakeTimeoutId);
  automationWakeTimeoutId = 0;

  const room = yachtState.room;
  if (!room || String(room.status || "") !== ROOM_STATUS_PLAYING) return;

  const now = Date.now();
  const targets = [Number(room.rollResolveAtMs || 0), Number(room.actionDeadlineAtMs || 0)].filter(
    (value) => value > now
  );
  const nextDeadline = Math.min(...targets);
  if (!Number.isFinite(nextDeadline)) return;

  automationWakeTimeoutId = window.setTimeout(() => {
    updateVisibleTimers();
    void maybeAdvanceByTimeout();
    scheduleAutomationWake();
  }, Math.max(0, nextDeadline - now) + 40);
}

function createPlayer(profile) {
  return finalizePlayer({
    uid: profile.uid,
    characterName: profile.characterName,
    nickname: profile.nickname,
    isReady: false,
    scoreSheet: createEmptyScoreSheet(),
    upperSubtotal: 0,
    bonus: 0,
    finalScore: 0,
    rank: 0,
    rewardCurrency: 0,
  });
}

function createEmptyScoreSheet() {
  return PLAYABLE_CATEGORY_IDS.reduce((map, categoryId) => {
    map[categoryId] = { score: null, locked: false };
    return map;
  }, {});
}

function finalizePlayer(player) {
  const scoreSheet = player.scoreSheet || createEmptyScoreSheet();
  const upperSubtotal = UPPER_IDS.reduce((sum, key) => sum + Number(scoreSheet[key]?.score || 0), 0);
  const lowerSubtotal = LOWER_IDS.reduce((sum, key) => sum + Number(scoreSheet[key]?.score || 0), 0);
  const bonus = upperSubtotal >= 63 ? 35 : 0;

  return {
    ...player,
    scoreSheet,
    upperSubtotal,
    bonus,
    finalScore: upperSubtotal + lowerSubtotal + bonus,
  };
}

function calculateCategoryScore(categoryId, dice) {
  const sorted = [...dice].sort((left, right) => left - right);
  const counts = new Map();
  dice.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
  const total = dice.reduce((sum, value) => sum + value, 0);

  switch (categoryId) {
    case "aces":
      return sumByFace(dice, 1);
    case "deuces":
      return sumByFace(dice, 2);
    case "threes":
      return sumByFace(dice, 3);
    case "fours":
      return sumByFace(dice, 4);
    case "fives":
      return sumByFace(dice, 5);
    case "sixes":
      return sumByFace(dice, 6);
    case "choice":
      return total;
    case "threeKind":
      return Array.from(counts.values()).some((count) => count >= 3) ? total : 0;
    case "fourKind":
      return Array.from(counts.values()).some((count) => count >= 4) ? total : 0;
    case "fullHouse": {
      const values = Array.from(counts.values()).sort((left, right) => right - left);
      return values[0] === 3 && values[1] === 2 ? 25 : 0;
    }
    case "smallStraight":
      return hasStraight(sorted, 4) ? 25 : 0;
    case "largeStraight":
      return hasStraight(sorted, 5) ? 40 : 0;
    case "yacht":
      return Array.from(counts.values()).some((count) => count === 5) ? 50 : 0;
    default:
      return 0;
  }
}

function pickBestScoreCategory(scoreSheet, dice) {
  return PLAYABLE_CATEGORY_IDS
    .filter((categoryId) => !scoreSheet?.[categoryId]?.locked)
    .map((categoryId, index) => ({
      categoryId,
      score: calculateCategoryScore(categoryId, dice),
      index,
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.index - right.index;
    })[0]?.categoryId;
}

function canHostStartGame(room, uid) {
  if (String(room.ownerUid || "") !== String(uid || "")) return false;
  const players = Array.isArray(room.players) ? room.players : [];
  if (players.length < 2) return false;
  return players
    .filter((player) => String(player.uid || "") !== String(room.ownerUid || ""))
    .every((player) => Boolean(player.isReady));
}

function resolveStartError(room, uid) {
  if (String(room.ownerUid || "") !== String(uid || "")) {
    return "방장만 게임을 시작할 수 있습니다.";
  }

  const players = Array.isArray(room.players) ? room.players : [];
  if (players.length < 2) {
    return "최소 2명 이상 입장해야 게임을 시작할 수 있습니다.";
  }

  const waitingPlayers = players.filter(
    (player) => String(player.uid || "") !== String(room.ownerUid || "") && !player.isReady
  );
  if (waitingPlayers.length) {
    return "다른 플레이어가 모두 준비 완료되어야 합니다.";
  }

  return "게임을 시작할 수 없습니다.";
}

function canCurrentUserRoll(room, uid) {
  return (
    String(room.status || "") === ROOM_STATUS_PLAYING &&
    String(room.actionPhase || "") === PHASE_AWAITING_ROLL &&
    Number(room.rollCount || 0) < 3 &&
    String(getCurrentTurnPlayer(room)?.uid || "") === String(uid || "")
  );
}

function canCurrentUserToggleHold(room, uid) {
  return (
    String(room.status || "") === ROOM_STATUS_PLAYING &&
    String(room.actionPhase || "") === PHASE_AWAITING_ROLL &&
    Number(room.rollCount || 0) > 0 &&
    String(getCurrentTurnPlayer(room)?.uid || "") === String(uid || "")
  );
}

function canCurrentUserScore(room, uid) {
  return (
    String(room.status || "") === ROOM_STATUS_PLAYING &&
    String(room.actionPhase || "") !== PHASE_ROLLING &&
    Number(room.rollCount || 0) > 0 &&
    String(getCurrentTurnPlayer(room)?.uid || "") === String(uid || "")
  );
}

function resolvePlayingStatus(room) {
  const currentPlayer = getCurrentTurnPlayer(room);
  const phaseText = String(room.actionPhase || "") === PHASE_ROLLING ? "주사위 굴리는 중" : "행동 대기";
  return `${phaseText} · ${escapeHtml(currentPlayer?.characterName || "-")}`;
}

function getTimerState(room) {
  const now = Date.now();
  const isRolling = String(room.actionPhase || "") === PHASE_ROLLING;
  const deadline = Number(isRolling ? room.rollResolveAtMs || 0 : room.actionDeadlineAtMs || 0);
  const total = isRolling ? YACHT_ROLL_ANIMATION_MS : YACHT_TURN_LIMIT_MS;
  const remainMs = Math.max(0, deadline - now);
  const progress = total > 0 ? Math.max(0, Math.min(100, (remainMs / total) * 100)) : 0;
  return { progress };
}

function getCurrentTurnPlayer(room) {
  const players = Array.isArray(room?.players) ? room.players : [];
  return players[Number(room?.currentTurnSeat || 0)] || null;
}

function getRoomPlayer(room, uid) {
  return (Array.isArray(room?.players) ? room.players : []).find((player) => player.uid === uid) || null;
}

function getRoomSpectator(room, uid) {
  return (Array.isArray(room?.spectators) ? room.spectators : []).find((player) => player.uid === uid) || null;
}

function findNextSeat(players, currentSeat) {
  for (let offset = 1; offset <= players.length; offset += 1) {
    const nextSeat = (currentSeat + offset) % players.length;
    if (!isScoreSheetComplete(players[nextSeat]?.scoreSheet)) return nextSeat;
  }
  return currentSeat;
}

function isScoreSheetComplete(scoreSheet) {
  return PLAYABLE_CATEGORY_IDS.every((categoryId) => Boolean(scoreSheet?.[categoryId]?.locked));
}

function normalizeDice(dice) {
  const nextDice = Array.isArray(dice) ? [...dice] : [];
  while (nextDice.length < YACHT_DICE_COUNT) nextDice.push(1);
  return nextDice.slice(0, YACHT_DICE_COUNT).map((value) => Math.max(1, Math.min(6, Number(value || 1))));
}

function sumByFace(dice, face) {
  return dice.filter((value) => value === face).reduce((sum, value) => sum + value, 0);
}

function hasStraight(sortedDice, length) {
  const unique = Array.from(new Set(sortedDice));
  let streak = 1;
  for (let index = 1; index < unique.length; index += 1) {
    if (unique[index] === unique[index - 1] + 1) {
      streak += 1;
      if (streak >= length) return true;
    } else {
      streak = 1;
    }
  }
  return false;
}

function resolveCategoryLabel(categoryId) {
  return SCORE_ROWS.find((row) => row.id === categoryId)?.label || categoryId;
}

function resolveScoreCellText(player, rowId, dice = [], viewerUid = "") {
  if (rowId === "upperSubtotal") return String(Number(player.upperSubtotal || 0));
  if (rowId === "bonus") return Number(player.bonus || 0) > 0 ? "35" : "-";
  if (rowId === "finalScore") return String(Number(player.finalScore || 0));

  if (!player.scoreSheet?.[rowId]?.locked) {
    if (String(player.uid || "") === String(viewerUid || "") && PLAYABLE_CATEGORY_IDS.includes(rowId)) {
      return String(calculateCategoryScore(rowId, normalizeDice(dice)));
    }
    return "-";
  }
  return String(Number(player.scoreSheet[rowId]?.score || 0));
}

function getDisplayedDiceValues(room) {
  return normalizeDice(room?.dice);
}

function getSharedVisualDiceState(room) {
  if (!room?.visualDiceState || typeof room.visualDiceState !== "object") return null;
  if (Number(room.visualDiceState.diceSeed || 0) !== Number(room.diceSeed || 0)) return null;
  return room.visualDiceState;
}

function buildLocalVisualDiceStatePayload(room) {
  const liveRoom = yachtState.room && String(yachtState.room.id || "") === String(room?.id || "") ? yachtState.room : room;
  if (!liveRoom) return null;

  const roomKey = String(liveRoom.id || "");
  const diceSeed = Number(liveRoom.diceSeed || 0);
  const localVisualState = boardVisualDiceCache.get(roomKey);
  const sharedVisualState = getSharedVisualDiceState(liveRoom);
  const values = normalizeDice(liveRoom.dice);
  const poses = {
    ...((sharedVisualState?.poses && typeof sharedVisualState.poses === "object") ? sharedVisualState.poses : {}),
    ...((localVisualState?.poses && typeof localVisualState.poses === "object") ? localVisualState.poses : {}),
  };

  return {
    diceSeed,
    visualDiceState: {
      diceSeed,
      values,
      poses,
    },
  };
}

function renderDieFace(value) {
  return ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"][Math.max(1, Math.min(6, Number(value || 1))) - 1] || "⚀";
}

function buildSlotDieFace(value = 0, empty = false) {
  const safe = Math.max(1, Math.min(6, Number(value || 1)));
  const activePipsByValue = {
    1: ["c"],
    2: ["tl", "br"],
    3: ["tl", "c", "br"],
    4: ["tl", "tr", "bl", "br"],
    5: ["tl", "tr", "c", "bl", "br"],
    6: ["tl", "tr", "ml", "mr", "bl", "br"],
  };
  const pipOrder = ["tl", "tr", "ml", "c", "mr", "bl", "br"];
  const active = new Set(empty ? [] : activePipsByValue[safe] || activePipsByValue[1]);

  return `
    <span class="yacht-slot-die ${empty ? "is-empty" : `value-${safe}`}" aria-hidden="true">
      ${pipOrder
        .map(
          (pip) =>
            `<span class="yacht-slot-pip pos-${pip} ${active.has(pip) ? "is-on" : ""}"></span>`
        )
        .join("")}
    </span>
  `;
}

function renderDieCubeFaces(value) {
  const safe = Math.max(1, Math.min(6, Number(value || 1)));
  const front = safe;
  const back = 7 - front;
  const top = safe === 6 ? 2 : safe + 1;
  const bottom = 7 - top;
  const right = safe >= 4 ? safe - 2 : safe + 2;
  const left = 7 - right;
  return {
    front,
    back,
    top,
    bottom,
    right,
    left,
  };
}

function buildRolledDice(seedBase, rollCount) {
  return Array.from({ length: YACHT_DICE_COUNT }, (_, index) => {
    const valueSeed = pseudoRandom(seedBase * 97 + rollCount * 53 + index * 19);
    return Math.max(1, Math.min(6, Math.floor(valueSeed * 6) + 1));
  });
}

function buildBoardPositions(seedBase) {
  return Array.from({ length: YACHT_DICE_COUNT }, (_, index) => {
    const seed = seedBase * 31 + index * 17 + 7;
    const angle = (Math.PI * 2 * index) / YACHT_DICE_COUNT + pseudoRandom(seed + 1) * 0.42;
    const radius = 8 + pseudoRandom(seed + 2) * 4.2;
    return {
      x: 50 + Math.cos(angle) * radius,
      y: 50 + Math.sin(angle) * radius,
      rotate: -18 + pseudoRandom(seed + 3) * 36,
      throwX: -110 + pseudoRandom(seed + 4) * 220,
      throwY: -80 + pseudoRandom(seed + 5) * 160,
      bounce: 14 + pseudoRandom(seed + 6) * 20,
      spinX: 460 + pseudoRandom(seed + 7) * 520,
      spinY: 540 + pseudoRandom(seed + 8) * 620,
      spinZ: 340 + pseudoRandom(seed + 9) * 460,
    };
  });
}

function buildCircularBoard(room) {
  const isRolling = String(room.actionPhase || "") === PHASE_ROLLING;

  return `
    <div
      class="yacht-board ${isRolling ? "is-rolling" : ""}"
      data-yacht-physics-board
      data-yacht-seed="${escapeHtml(String(Number(room.diceSeed || Date.now())))}"
      data-yacht-rolling="${isRolling ? "1" : "0"}"
    >
      <div class="yacht-board-ring"></div>
      <div class="yacht-board-core"></div>
      <div class="yacht-board-canvas-shell"></div>
    </div>
  `;
}

function buildHeldDiceRack(room, canToggleHold) {
  const dice = normalizeDice(room.dice);
  const heldDice = Array.isArray(room.heldDice)
    ? room.heldDice.slice(0, YACHT_DICE_COUNT).map((value) => Boolean(value))
    : Array.from({ length: YACHT_DICE_COUNT }, () => false);

  return `
    <div class="yacht-held-rack" aria-label="고정된 주사위">
      ${Array.from({ length: YACHT_DICE_COUNT }, (_, index) => {
        const isHeld = heldDice[index];
        const content = isHeld
          ? `<span class="yacht-held-rack-face">${renderDieFace(dice[index])}</span><small>D${index + 1}</small>`
          : `<span class="yacht-held-rack-empty">+</span><small>빈 슬롯</small>`;
        return `
          <button
            type="button"
            class="yacht-held-rack-slot ${isHeld ? "is-held" : ""}"
            data-yacht-held-slot="${index}"
            ${canToggleHold && isHeld ? "" : "disabled"}
          >
            ${content}
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function buildHeldDiceRackV2(room, canToggleHold) {
  const dice = getDisplayedDiceValues(room);
  const heldDice = Array.isArray(room.heldDice)
    ? room.heldDice.slice(0, YACHT_DICE_COUNT).map((value) => Boolean(value))
    : Array.from({ length: YACHT_DICE_COUNT }, () => false);
  const heldEntries = heldDice
    .map((isHeld, index) => (isHeld ? { index, value: Number(dice[index] || 1) } : null))
    .filter(Boolean)
    .sort((left, right) => {
      if (left.value !== right.value) return left.value - right.value;
      return left.index - right.index;
    });

  return `
    <div class="yacht-held-rack" aria-label="고정된 주사위">
      ${Array.from({ length: YACHT_DICE_COUNT }, (_, slotIndex) => {
        const entry = heldEntries[slotIndex] || null;
        const content = entry
          ? `${buildSlotDieFace(entry.value)}<small>${entry.value} 고정</small>`
          : `${buildSlotDieFace(1, true)}<small>빈 슬롯</small>`;
        return `
          <button
            type="button"
            class="yacht-held-rack-slot ${entry ? "is-held" : ""}"
            ${entry ? `data-yacht-held-slot="${entry.index}"` : ""}
            ${canToggleHold && entry ? "" : "disabled"}
          >
            ${content}
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function buildScoreMatrix(room) {
  const players = Array.isArray(room.players) ? room.players : [];
  const viewerUid = String(yachtState.profile?.uid || "");
  const canScore = canCurrentUserScore(room, viewerUid);
  const currentPlayer = getCurrentTurnPlayer(room);
  const currentDice = getDisplayedDiceValues(room);

  return `
    <div class="yacht-score-matrix">
      <table class="data-table yacht-score-table">
        <thead>
          <tr>
            <th class="yacht-score-row-head">구분</th>
            ${players
              .map((player) => {
                const isCurrentTurnPlayer = String(player.uid || "") === String(currentPlayer?.uid || "");
                const isMe = String(player.uid || "") === viewerUid;
                return `
                  <th class="yacht-score-player-head ${isCurrentTurnPlayer ? "is-current-turn" : ""} ${isMe ? "is-self" : ""}">
                    <div class="yacht-score-player-name">${escapeHtml(player.characterName || "-")}</div>
                    ${isMe ? '<span class="yacht-score-player-tag">나</span>' : ""}
                  </th>
                `;
              })
              .join("")}
          </tr>
        </thead>
        <tbody>
          ${SCORE_ROWS.map((row) => {
            return `
              <tr class="${row.summary ? "is-summary-row" : ""}">
                <th class="yacht-score-row-head">${escapeHtml(row.label)}</th>
                ${players
                  .map((player) => {
                    const isCurrentTurnPlayer = String(player.uid || "") === String(currentPlayer?.uid || "");
                    const isCurrentUserTurn =
                      String(player.uid || "") === viewerUid &&
                      String(currentPlayer?.uid || "") === viewerUid &&
                      canScore &&
                      PLAYABLE_CATEGORY_IDS.includes(row.id) &&
                      !player.scoreSheet?.[row.id]?.locked;

                    if (isCurrentUserTurn) {
                      const score = calculateCategoryScore(row.id, currentDice);
                      return `
                        <td class="yacht-score-cell ${isCurrentTurnPlayer ? "is-current-turn" : ""}">
                          <button
                            type="button"
                            class="yacht-score-cell-button"
                            data-yacht-score-category="${row.id}"
                          >
                            <span>${score}</span>
                            <small>선택</small>
                          </button>
                        </td>
                      `;
                    }

                    return `<td class="yacht-score-cell ${isCurrentTurnPlayer ? "is-current-turn" : ""}"><span class="yacht-score-cell-preview ${row.summary ? "is-summary" : ""}">${escapeHtml(
                      resolveScoreCellText(player, row.id, currentDice, viewerUid)
                    )}</span></td>`;
                  })
                  .join("")}
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

async function mountPhysicsBoard(room) {
  const boardEl = document.querySelector("[data-yacht-physics-board]");
  if (!boardEl) return;
  const requestId = ++boardMountRequestId;

  const nextSignature = JSON.stringify({
    roomId: String(room.id || ""),
    diceSeed: Number(room.diceSeed || 0),
    dice: normalizeDice(room.dice),
    heldDice: Array.isArray(room.heldDice) ? room.heldDice.slice(0, YACHT_DICE_COUNT).map(Boolean) : [],
    visualDiceState: room.visualDiceState || null,
  });
  if (boardViewSignature === nextSignature && typeof boardViewCleanup === "function") {
    return;
  }

  try {
    const engine = await getBoardEngine();
    if (requestId !== boardMountRequestId) return;
    if (!document.body.contains(boardEl)) return;
    if (typeof boardViewCleanup === "function") {
      boardViewCleanup();
    }
    boardViewCleanup = engine.mount(boardEl, room);
    boardViewSignature = nextSignature;
  } catch (error) {
    console.error("Failed to mount yacht physics board", error);
    yachtState.onToast?.("주사위 물리 엔진을 불러오지 못했습니다.", true);
  }
}

async function getBoardEngine() {
  if (!boardEnginePromise) {
    boardEnginePromise = Promise.all([
      import(THREE_MODULE_URL),
      import(CANNON_MODULE_URL),
      import(THREE_ROUNDED_BOX_URL),
    ]).then(([THREE, CANNON, RoundedBox]) => createBoardEngine(THREE, CANNON, RoundedBox));
  }
  return boardEnginePromise;
}

function isIgnorableVisualSyncError(error) {
  const message = String(error?.message || "");
  return (
    message.includes("굴리는 중에는 결과를 동기화할 수 없습니다.") ||
    message.includes("이미 다음 굴림 상태로 변경되었습니다.")
  );
}

async function syncVisualDiceIfNeeded(room) {
  const liveRoom = yachtState.room && String(yachtState.room.id || "") === String(room?.id || "") ? yachtState.room : room;
  if (!liveRoom || String(liveRoom.status || "") !== ROOM_STATUS_PLAYING) return false;
  if (String(liveRoom.actionPhase || "") === PHASE_ROLLING) return false;
  if (
    !canCurrentUserScore(liveRoom, yachtState.profile?.uid) &&
    !canCurrentUserToggleHold(liveRoom, yachtState.profile?.uid)
  ) {
    return false;
  }

  const roomKey = String(liveRoom.id || "");
  const diceSeed = Number(liveRoom.diceSeed || 0);
  const localVisualState = boardVisualDiceCache.get(roomKey);
  const sharedVisualState = getSharedVisualDiceState(liveRoom);
  const actual = normalizeDice(liveRoom.dice);
  const mergedPoses = {
    ...((sharedVisualState?.poses && typeof sharedVisualState.poses === "object") ? sharedVisualState.poses : {}),
    ...((localVisualState?.poses && typeof localVisualState.poses === "object") ? localVisualState.poses : {}),
  };
  const hasLocalPoseState =
    localVisualState?.diceSeed === diceSeed && Object.keys(mergedPoses).length > 0;
  const sharedMatchesLocal =
    sharedVisualState &&
    JSON.stringify(normalizeDice(sharedVisualState.values || actual)) === JSON.stringify(actual) &&
    JSON.stringify(sharedVisualState.poses || {}) === JSON.stringify(mergedPoses);

  if (!hasLocalPoseState || sharedMatchesLocal) return false;

  const syncKey = `${roomKey}:${diceSeed}`;
  if (boardVisualSyncPromise && boardVisualSyncKey === syncKey) {
    return boardVisualSyncPromise;
  }

  boardVisualSyncKey = syncKey;
  boardVisualSyncPromise = (async () => {
    try {
      await callYachtAction("sync-visual-state", {
        roomId: liveRoom.id,
        dice: actual,
        diceSeed,
        visualDiceState: {
          diceSeed,
          values: actual,
          poses: mergedPoses,
        },
      });
      return true;
    } catch (error) {
      if (isIgnorableVisualSyncError(error)) {
        return false;
      }
      throw error;
    } finally {
      if (boardVisualSyncKey === syncKey) {
        boardVisualSyncKey = "";
        boardVisualSyncPromise = null;
      }
    }
  })();

  return boardVisualSyncPromise;
}

function createBoardEngine(THREE, CANNON, RoundedBox) {
  const faceTextureCache = new Map();
  let audioContext = null;
  const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));
  const lerp = (start, end, t) => start + (end - start) * clamp01(t);
  const easeOutCubic = (t) => 1 - Math.pow(1 - clamp01(t), 3);
  const easeInOutSine = (t) => 0.5 - Math.cos(clamp01(t) * Math.PI) * 0.5;

  function getAudioContext() {
    if (!audioContext) {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) return null;
      audioContext = new AudioContextCtor();
    }
    return audioContext;
  }

  function playSoftCollision(intensity = 0.1) {
    const context = getAudioContext();
    if (!context) return;
    if (context.state === "suspended") {
      context.resume().catch(() => {});
    }

    const now = context.currentTime;
    const gainNode = context.createGain();
    const bufferSize = Math.max(1, Math.floor(context.sampleRate * 0.035));
    const buffer = context.createBuffer(1, bufferSize, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < bufferSize; index += 1) {
      const envelope = 1 - index / bufferSize;
      data[index] = (Math.random() * 2 - 1) * envelope * 0.32;
    }

    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 920;
    gainNode.gain.setValueAtTime(Math.min(0.045, 0.012 + intensity * 0.012), now);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
    source.buffer = buffer;
    source.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(context.destination);
    source.start(now);
    source.stop(now + 0.08);
  }

  function createFaceTexture(faceValue) {
    if (faceTextureCache.has(faceValue)) {
      return faceTextureCache.get(faceValue).clone();
    }

    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const outerGradient = ctx.createLinearGradient(0, 0, size, size);
    outerGradient.addColorStop(0, "#5e6571");
    outerGradient.addColorStop(0.42, "#2c3139");
    outerGradient.addColorStop(1, "#14181d");
    ctx.fillStyle = outerGradient;
    ctx.fillRect(0, 0, size, size);

    const innerGradient = ctx.createLinearGradient(0, 0, 0, size);
    innerGradient.addColorStop(0, "#454b56");
    innerGradient.addColorStop(0.52, "#2b3038");
    innerGradient.addColorStop(1, "#181c22");
    ctx.fillStyle = innerGradient;
    ctx.fillRect(22, 22, size - 44, size - 44);

    const metallicEdge = ctx.createLinearGradient(0, 0, size, size);
    metallicEdge.addColorStop(0, "rgba(255, 135, 150, 0.92)");
    metallicEdge.addColorStop(0.3, "rgba(205, 28, 52, 0.9)");
    metallicEdge.addColorStop(0.7, "rgba(116, 8, 25, 0.96)");
    metallicEdge.addColorStop(1, "rgba(255, 162, 173, 0.9)");
    ctx.lineWidth = 11;
    ctx.strokeStyle = metallicEdge;
    ctx.strokeRect(17, 17, size - 34, size - 34);

    ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
    ctx.fillRect(30, 30, size - 60, size * 0.12);

    const pipColor = faceValue === 1 ? "#f5f7fb" : "#c61f36";
    const pipShadow = faceValue === 1 ? "rgba(198, 31, 54, 0.24)" : "rgba(255, 255, 255, 0.16)";
    const radiusByFace = {
      1: 23,
      2: 17,
      3: 17,
      4: 16,
      5: 16,
      6: 14,
    };
    const radius = radiusByFace[faceValue] || 16;
    const center = size / 2;
    const offset = 56;
    const far = 50;
    const map = {
      1: [[0, 0]],
      2: [[-offset, -offset], [offset, offset]],
      3: [[-offset, -offset], [0, 0], [offset, offset]],
      4: [[-offset, -offset], [offset, -offset], [-offset, offset], [offset, offset]],
      5: [[-offset, -offset], [offset, -offset], [0, 0], [-offset, offset], [offset, offset]],
      6: [[-far, -offset], [far, -offset], [-far, 0], [far, 0], [-far, offset], [far, offset]],
    };

    (map[faceValue] || map[1]).forEach(([x, y]) => {
      ctx.beginPath();
      ctx.fillStyle = pipShadow;
      ctx.arc(center + x + 2, center + y + 2, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = pipColor;
      ctx.arc(center + x, center + y, radius, 0, Math.PI * 2);
      ctx.fill();
    });

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    faceTextureCache.set(faceValue, texture);
    return texture.clone();
  }

  function buildMaterials(value) {
    const faces = renderDieCubeFaces(value);
    return [
      new THREE.MeshStandardMaterial({ map: createFaceTexture(faces.right), roughness: 0.42, metalness: 0.05 }),
      new THREE.MeshStandardMaterial({ map: createFaceTexture(faces.left), roughness: 0.42, metalness: 0.05 }),
      new THREE.MeshStandardMaterial({ map: createFaceTexture(value), roughness: 0.42, metalness: 0.05 }),
      new THREE.MeshStandardMaterial({ map: createFaceTexture(faces.bottom), roughness: 0.42, metalness: 0.05 }),
      new THREE.MeshStandardMaterial({ map: createFaceTexture(faces.front), roughness: 0.42, metalness: 0.05 }),
      new THREE.MeshStandardMaterial({ map: createFaceTexture(faces.back), roughness: 0.42, metalness: 0.05 }),
    ];
  }

  function getFinalQuaternion(value, seed = 0) {
    const quarterTurn = Math.floor(pseudoRandom(seed + Number(value || 1) * 17) * 4) * (Math.PI / 2);
    const quaternion = new THREE.Quaternion();
    quaternion.setFromEuler(new THREE.Euler(0, quarterTurn, 0));
    return quaternion;
  }

  function getRollingQuaternion(seed = 0) {
    const quaternion = new THREE.Quaternion();
    quaternion.setFromEuler(
      new THREE.Euler(
        pseudoRandom(seed + 3) * Math.PI * 2,
        pseudoRandom(seed + 5) * Math.PI * 2,
        pseudoRandom(seed + 7) * Math.PI * 2
      )
    );
    return quaternion;
  }

  function readTopFaceValue(baseValue, quaternion, objectPosition, cameraPosition) {
    const faces = renderDieCubeFaces(baseValue);
    const candidates = [
      { normal: new THREE.Vector3(1, 0, 0), center: new THREE.Vector3(0.27, 0, 0), value: faces.right },
      { normal: new THREE.Vector3(-1, 0, 0), center: new THREE.Vector3(-0.27, 0, 0), value: faces.left },
      {
        normal: new THREE.Vector3(0, 1, 0),
        center: new THREE.Vector3(0, 0.27, 0),
        value: Math.max(1, Math.min(6, Number(baseValue || 1))),
      },
      { normal: new THREE.Vector3(0, -1, 0), center: new THREE.Vector3(0, -0.27, 0), value: faces.bottom },
      { normal: new THREE.Vector3(0, 0, 1), center: new THREE.Vector3(0, 0, 0.27), value: faces.front },
      { normal: new THREE.Vector3(0, 0, -1), center: new THREE.Vector3(0, 0, -0.27), value: faces.back },
    ];
    const up = new THREE.Vector3(0, 1, 0);
    let best = candidates[0];
    let bestDot = -Infinity;
    candidates.forEach((candidate) => {
      const worldNormal = candidate.normal.clone().applyQuaternion(quaternion);
      const worldCenter = candidate.center.clone().applyQuaternion(quaternion).add(objectPosition);
      const cameraRay = cameraPosition.clone().sub(worldCenter).normalize();
      const facingScore = worldNormal.dot(cameraRay);
      const topBias = worldNormal.dot(up);
      const score = facingScore * 0.78 + topBias * 0.22;
      if (score > bestDot) {
        bestDot = score;
        best = candidate;
      }
    });
    return {
      value: Number(best.value || 1),
      alignment: bestDot,
    };
  }

  function clampPlanarPosition(x, z, limit) {
    const distance = Math.hypot(x, z);
    if (distance <= limit) return { x, z };
    const scale = limit / Math.max(distance, 0.0001);
    return {
      x: x * scale,
      z: z * scale,
    };
  }

  function resolveNonOverlappingPlanarPosition(x, z, occupiedEntries = [], limit = 2.08, minGap = 0.78) {
    let nextX = x;
    let nextZ = z;

    for (let iteration = 0; iteration < 16; iteration += 1) {
      let moved = false;
      occupiedEntries.forEach((entry, occupiedIndex) => {
        const dx = nextX - Number(entry?.x || 0);
        const dz = nextZ - Number(entry?.z || 0);
        const distance = Math.hypot(dx, dz);
        if (distance >= minGap) return;

        const angle = distance > 0.0001
          ? Math.atan2(dz, dx)
          : ((occupiedIndex + 1) * Math.PI * 0.73) % (Math.PI * 2);
        const push = minGap - distance + 0.02;
        nextX += Math.cos(angle) * push;
        nextZ += Math.sin(angle) * push;
        const clamped = clampPlanarPosition(nextX, nextZ, limit);
        nextX = clamped.x;
        nextZ = clamped.z;
        moved = true;
      });
      if (!moved) break;
    }

    return { x: nextX, z: nextZ };
  }

function mount(container, room) {
    const shell = container.querySelector(".yacht-board-canvas-shell");
    if (!shell) return () => {};

    const width = Math.max(320, shell.clientWidth || container.clientWidth || 520);
    const height = Math.max(320, shell.clientHeight || container.clientHeight || 520);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    shell.innerHTML = "";
    shell.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(24, width / height, 0.1, 100);
    camera.up.set(0, 0, -1);
    camera.position.set(0, 13.2, 0.01);
    camera.lookAt(0, 0.4, 0);

    const ambient = new THREE.AmbientLight(0xffffff, 1.45);
    scene.add(ambient);
    const key = new THREE.DirectionalLight(0xf4f7ff, 2.3);
    key.position.set(4, 14, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -10;
    key.shadow.camera.right = 10;
    key.shadow.camera.top = 10;
    key.shadow.camera.bottom = -10;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffb38a, 0.62);
    fill.position.set(-6, 5, -5);
    scene.add(fill);

    const world = new CANNON.World({
      gravity: new CANNON.Vec3(0, -28, 0),
    });
    world.allowSleep = true;
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.defaultContactMaterial.friction = 0.16;
    world.defaultContactMaterial.restitution = 0.58;

    const groundBody = new CANNON.Body({
      type: CANNON.Body.STATIC,
      shape: new CANNON.Plane(),
    });
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(groundBody);

    const dieHalfExtent = 0.27;
    const dieCenterLimit = 2.08;
    const playRadius = dieCenterLimit;
    const wallDistance = playRadius + dieHalfExtent + 0.04;
    const wallShape = new CANNON.Box(new CANNON.Vec3(playRadius + dieHalfExtent, 1.2, 0.18));
    const sideShape = new CANNON.Box(new CANNON.Vec3(0.18, 1.2, playRadius + dieHalfExtent));
    [
      { x: 0, y: 1.4, z: -wallDistance, shape: wallShape },
      { x: 0, y: 1.4, z: wallDistance, shape: wallShape },
      { x: -wallDistance, y: 1.4, z: 0, shape: sideShape },
      { x: wallDistance, y: 1.4, z: 0, shape: sideShape },
    ].forEach((wall) => {
      const body = new CANNON.Body({ type: CANNON.Body.STATIC, shape: wall.shape });
      body.position.set(wall.x, wall.y, wall.z);
      world.addBody(body);
    });

    const diceValues = normalizeDice(room.dice);
    const heldDice = Array.isArray(room.heldDice)
      ? room.heldDice.slice(0, YACHT_DICE_COUNT).map((value) => Boolean(value))
      : Array.from({ length: YACHT_DICE_COUNT }, () => false);
    const seedBase = Number(room.diceSeed || Date.now());
    const poseCacheKey = String(room.id || "");
    const isRolling = String(room.actionPhase || "") === PHASE_ROLLING;
    const sharedVisualState = getSharedVisualDiceState(room);
    const cachedPoseState = boardPoseCache.get(poseCacheKey) || {};
    const cacheAgeMs = Math.max(0, Date.now() - Number(cachedPoseState.updatedAtMs || 0));
    const localCachedPoses =
      Number(cachedPoseState.diceSeed || 0) === seedBase && cacheAgeMs < 12000
        ? cachedPoseState.poses || {}
        : {};
    const cachedPoses = {
      ...localCachedPoses,
      ...((sharedVisualState?.poses && typeof sharedVisualState.poses === "object") ? sharedVisualState.poses : {}),
    };
    const positions = buildBoardPositions(seedBase);
    const occupiedPlanarEntries = diceValues
      .map((_, index) => {
        const pose = cachedPoses[index];
        if (!pose?.position) return null;
        return {
          index,
          x: Number(pose.position.x || 0),
          z: Number(pose.position.z || 0),
          held: heldDice[index],
        };
      })
      .filter(Boolean);
    const diceSet = diceValues
      .map((value, index) => ({ value, index }))
      .filter((entry) => !heldDice[entry.index])
      .map(({ value, index }) => {
      const geometry = new RoundedBox.RoundedBoxGeometry(0.54, 0.54, 0.54, 4, 0.07);
      const mesh = new THREE.Mesh(geometry, buildMaterials(value));
      mesh.userData.dieIndex = index;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);

      const hitArea = new THREE.Mesh(
        new THREE.BoxGeometry(0.8, 0.8, 0.8),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 })
      );
      hitArea.userData.dieIndex = index;
      mesh.add(hitArea);

      const body = new CANNON.Body({
        mass: 0.72,
        shape: new CANNON.Box(new CANNON.Vec3(dieHalfExtent, dieHalfExtent, dieHalfExtent)),
        linearDamping: 0.055,
        angularDamping: 0.045,
      });

      let px = ((positions[index].x - 50) / 50) * 5;
      let pz = ((positions[index].y - 50) / 50) * 5;
      const targetDistance = Math.hypot(px, pz);
      if (targetDistance > dieCenterLimit) {
        const scale = dieCenterLimit / targetDistance;
        px *= scale;
        pz *= scale;
      }
      const occupiedByOthers = occupiedPlanarEntries.filter((entry) => entry.index !== index);
      const restingPlanar = resolveNonOverlappingPlanarPosition(px, pz, occupiedByOthers, dieCenterLimit);
      px = restingPlanar.x;
      pz = restingPlanar.z;
      const occupiedEntry = occupiedPlanarEntries.find((entry) => entry.index === index);
      if (occupiedEntry) {
        occupiedEntry.x = px;
        occupiedEntry.z = pz;
      } else {
        occupiedPlanarEntries.push({ index, x: px, z: pz, held: false });
      }
      const rollQ = getFinalQuaternion(value, seedBase + index * 41);

      if (isRolling && !heldDice[index]) {
        const rollingQ = getRollingQuaternion(seedBase + index * 53);
        rollingQ.slerp(rollQ, 0.22);
        const throwSide = index % 4;
        const sideDrift = (pseudoRandom(seedBase + index * 11) - 0.5) * 0.3;
        let startX = px;
        let startZ = pz;
        let velocityX = 0;
        let velocityZ = 0;

        if (throwSide === 0) {
          startX = -playRadius + 0.2;
          startZ = pz + sideDrift;
          velocityX = 7.2 + pseudoRandom(seedBase + index * 13) * 1.0;
          velocityZ = (0.5 - pseudoRandom(seedBase + index * 19)) * 1.4;
        } else if (throwSide === 1) {
          startX = playRadius - 0.2;
          startZ = pz + sideDrift;
          velocityX = -7.2 - pseudoRandom(seedBase + index * 13) * 1.0;
          velocityZ = (0.5 - pseudoRandom(seedBase + index * 19)) * 1.4;
        } else if (throwSide === 2) {
          startX = px + sideDrift;
          startZ = -playRadius + 0.2;
          velocityX = (0.5 - pseudoRandom(seedBase + index * 13)) * 1.4;
          velocityZ = 7.2 + pseudoRandom(seedBase + index * 19) * 1.0;
        } else {
          startX = px + sideDrift;
          startZ = playRadius - 0.2;
          velocityX = (0.5 - pseudoRandom(seedBase + index * 13)) * 1.4;
          velocityZ = -7.2 - pseudoRandom(seedBase + index * 19) * 1.0;
        }

        const startPlanar = resolveNonOverlappingPlanarPosition(
          startX,
          startZ,
          occupiedByOthers.filter((entry) => entry.held),
          playRadius - 0.08,
          0.72
        );
        startX = startPlanar.x;
        startZ = startPlanar.z;

        body.position.set(startX, 0.76 + pseudoRandom(seedBase + index * 37) * 0.12, startZ);
        body.quaternion.set(rollingQ.x, rollingQ.y, rollingQ.z, rollingQ.w);
        body.velocity.set(
          velocityX,
          -0.14 - pseudoRandom(seedBase + index * 17) * 0.12,
          velocityZ
        );
        body.angularVelocity.set(
          4.5 + pseudoRandom(seedBase + index * 23) * 2.0,
          3.8 + pseudoRandom(seedBase + index * 29) * 1.5,
          4.5 + pseudoRandom(seedBase + index * 31) * 2.0
        );
      } else if (cachedPoses[index]) {
        const pose = cachedPoses[index];
        body.position.set(
          Number(pose.position?.x || px),
          Number(pose.position?.y || 0.42),
          Number(pose.position?.z || pz)
        );
        body.quaternion.set(
          Number(pose.quaternion?.x || rollQ.x),
          Number(pose.quaternion?.y || rollQ.y),
          Number(pose.quaternion?.z || rollQ.z),
          Number(pose.quaternion?.w || rollQ.w)
        );
      } else {
        body.position.set(px, 0.42, pz);
        body.quaternion.set(rollQ.x, rollQ.y, rollQ.z, rollQ.w);
      }

      let lastHitAt = 0;
      body.addEventListener("collide", (event) => {
        const now = performance.now();
        if (now - lastHitAt < 80) return;
        lastHitAt = now;
        const speed = Math.abs(event.contact?.getImpactVelocityAlongNormal?.() || 0);
        if (speed < 1.2) return;
        playSoftCollision(Math.min(1, speed / 8));
      });

      world.addBody(body);
      return {
        mesh,
        body,
        hitArea,
        dieIndex: index,
        targetQuaternion: rollQ,
        restPosition: { x: px, z: pz },
        settlePlan: null,
        settlePhase: pseudoRandom(seedBase + index * 61) * Math.PI * 2,
      };
    });

    let rafId = 0;
    let stopped = false;
    let lastTime = performance.now();
    const rollStartedAtMs = performance.now();
    const settleStartMs = isRolling ? rollStartedAtMs + 560 : 0;
    const settleEndMs = isRolling ? rollStartedAtMs + YACHT_ROLL_ANIMATION_MS - 180 : 0;
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    function resize() {
      const nextWidth = Math.max(320, shell.clientWidth || container.clientWidth || 520);
      const nextHeight = Math.max(320, shell.clientHeight || container.clientHeight || 520);
      renderer.setSize(nextWidth, nextHeight);
      camera.aspect = nextWidth / nextHeight;
      camera.updateProjectionMatrix();
    }

    const onResize = () => resize();
    window.addEventListener("resize", onResize);

    const getLiveRoom = () => {
      const liveRoom = yachtState.room;
      if (!liveRoom) return room;
      if (String(liveRoom.id || "") !== String(room.id || "")) return room;
      return liveRoom;
    };

    const isCurrentlyRolling = () => {
      const liveRoom = getLiveRoom();
      return (
        String(liveRoom.id || "") === String(room.id || "") &&
        Number(liveRoom.diceSeed || 0) === seedBase &&
        String(liveRoom.actionPhase || "") === PHASE_ROLLING
      );
    };

    const onPointerDown = async (event) => {
      const liveRoom = getLiveRoom();
      if (!canCurrentUserToggleHold(liveRoom, yachtState.profile?.uid)) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const intersects = raycaster.intersectObjects(
        diceSet.flatMap((die) => [die.mesh, die.hitArea]),
        true
      );
      const hitObject = intersects[0]?.object;
      const hitIndex = hitObject?.userData?.dieIndex ?? hitObject?.parent?.userData?.dieIndex;
      if (!Number.isInteger(hitIndex)) return;
      try {
        await toggleHold(liveRoom.id, hitIndex, buildLocalVisualDiceStatePayload(getLiveRoom()));
      } catch (error) {
        yachtState.onToast?.(error.message, true);
      }
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);

    function animate(now) {
      if (stopped) return;
      const dt = Math.min(1 / 30, (now - lastTime) / 1000 || 1 / 60);
      lastTime = now;

      const rollingNow = isCurrentlyRolling();

      if (rollingNow && now < settleStartMs) {
        world.step(1 / 60, dt, 5);
      }

      if (rollingNow && now < settleStartMs) {
        for (let leftIndex = 0; leftIndex < diceSet.length; leftIndex += 1) {
          for (let rightIndex = leftIndex + 1; rightIndex < diceSet.length; rightIndex += 1) {
            const leftDie = diceSet[leftIndex];
            const rightDie = diceSet[rightIndex];
            const dx = rightDie.body.position.x - leftDie.body.position.x;
            const dz = rightDie.body.position.z - leftDie.body.position.z;
            const distance = Math.hypot(dx, dz) || 0.001;
          if (distance >= 0.78) continue;
          const push = (0.78 - distance) * 0.06;
            const nx = dx / distance;
            const nz = dz / distance;
            leftDie.body.position.x -= nx * push;
            leftDie.body.position.z -= nz * push;
            rightDie.body.position.x += nx * push;
            rightDie.body.position.z += nz * push;
          }
        }

        diceSet.forEach((die) => {
          const planarDistance = Math.hypot(die.body.position.x, die.body.position.z);
          if (planarDistance <= playRadius) return;
          const nx = die.body.position.x / planarDistance;
          const nz = die.body.position.z / planarDistance;
          die.body.position.x = nx * playRadius;
          die.body.position.z = nz * playRadius;
          const outwardVelocity = die.body.velocity.x * nx + die.body.velocity.z * nz;
          die.body.velocity.x -= outwardVelocity * nx * 2.1;
          die.body.velocity.z -= outwardVelocity * nz * 2.1;
          die.body.angularVelocity.scale(0.92, die.body.angularVelocity);
        });
      }

      if (rollingNow && now >= settleStartMs) {
        const progress = Math.min(1, (now - settleStartMs) / Math.max(1, settleEndMs - settleStartMs));
        diceSet.forEach((die) => {
          if (!die.settlePlan) {
            const initialVelocityX = Number(die.body.velocity.x || 0);
            const initialVelocityZ = Number(die.body.velocity.z || 0);
            const initialSpeed = Math.hypot(initialVelocityX, initialVelocityZ);
            const fallbackAngle = die.settlePhase;
            die.settlePlan = {
              startPosition: new THREE.Vector3(
                die.body.position.x,
                die.body.position.y,
                die.body.position.z
              ),
              targetPosition: new THREE.Vector3(
                die.body.position.x,
                0.42,
                die.body.position.z
              ),
              startQuaternion: new THREE.Quaternion(
                die.body.quaternion.x,
                die.body.quaternion.y,
                die.body.quaternion.z,
                die.body.quaternion.w
              ),
              wobbleTilt: 0.14 + pseudoRandom(seedBase + die.dieIndex * 67) * 0.08,
              wobbleLift: 0.05 + pseudoRandom(seedBase + die.dieIndex * 71) * 0.04,
              driftRadius: 0.05 + pseudoRandom(seedBase + die.dieIndex * 73) * 0.04,
              approachDirX: initialSpeed > 0.01 ? initialVelocityX / initialSpeed : Math.cos(fallbackAngle),
              approachDirZ: initialSpeed > 0.01 ? initialVelocityZ / initialSpeed : Math.sin(fallbackAngle),
              approachDistance: Math.min(0.24, 0.08 + initialSpeed * 0.03),
            };
          }

          const positionT = easeInOutSine(progress);
          const prepT = clamp01((progress - 0.28) / 0.72);
          const orientationT = easeOutCubic(prepT);
          const liftFade = 1 - positionT;
          const wobbleFade = Math.pow(1 - orientationT, 1.2);
          const driftWave = progress * Math.PI * 2.6 + die.settlePhase;
          const forwardCarry = (1 - orientationT) * (0.42 + (1 - positionT) * 0.58);

          die.body.velocity.set(0, 0, 0);
          die.body.angularVelocity.set(0, 0, 0);

          const baseX = lerp(die.settlePlan.startPosition.x, die.settlePlan.targetPosition.x, positionT);
          const baseZ = lerp(die.settlePlan.startPosition.z, die.settlePlan.targetPosition.z, positionT);
          const driftRadius = die.settlePlan.driftRadius * liftFade;
          die.body.position.x =
            baseX +
            die.settlePlan.approachDirX * die.settlePlan.approachDistance * forwardCarry +
            Math.cos(driftWave) * driftRadius;
          die.body.position.z =
            baseZ +
            die.settlePlan.approachDirZ * die.settlePlan.approachDistance * forwardCarry +
            Math.sin(driftWave) * driftRadius * 0.82;
          die.body.position.y =
            lerp(die.settlePlan.startPosition.y, die.settlePlan.targetPosition.y, easeOutCubic(progress)) +
            Math.sin(progress * Math.PI) * die.settlePlan.wobbleLift * liftFade;

          const currentQ = die.settlePlan.startQuaternion.clone();
          currentQ.slerp(die.targetQuaternion, orientationT);
          const wobbleEuler = new THREE.Euler(
            Math.sin(driftWave * 1.2) * die.settlePlan.wobbleTilt * wobbleFade,
            Math.cos(driftWave * 0.9) * die.settlePlan.wobbleTilt * 0.38 * wobbleFade,
            Math.cos(driftWave * 1.15) * die.settlePlan.wobbleTilt * 0.8 * wobbleFade,
            "XYZ"
          );
          currentQ.multiply(new THREE.Quaternion().setFromEuler(wobbleEuler));
          die.body.quaternion.set(currentQ.x, currentQ.y, currentQ.z, currentQ.w);

          if (progress >= 0.992) {
            die.body.velocity.set(0, 0, 0);
            die.body.angularVelocity.set(0, 0, 0);
            die.body.position.set(
              die.settlePlan.targetPosition.x,
              0.42,
              die.settlePlan.targetPosition.z
            );
            die.body.quaternion.set(
              die.targetQuaternion.x,
              die.targetQuaternion.y,
              die.targetQuaternion.z,
              die.targetQuaternion.w
            );
            die.body.sleep();
          }
        });
      }

      diceSet.forEach((die) => {
        die.mesh.position.copy(die.body.position);
        die.mesh.quaternion.copy(die.body.quaternion);
        die.mesh.material.forEach?.((material) => {
          material.emissive = new THREE.Color(0x000000);
          material.emissiveIntensity = 0;
        });
      });

      renderer.render(scene, camera);
      const displayedValues = normalizeDice(getLiveRoom().dice);
      const displayedPoses = {
        ...cachedPoses,
      };
      diceSet.forEach((die) => {
        displayedValues[die.dieIndex] = Number(
          normalizeDice(getLiveRoom().dice)[die.dieIndex] || room.dice?.[die.dieIndex] || 1
        );
        displayedPoses[die.dieIndex] = {
          position: {
            x: die.body.position.x,
            y: die.body.position.y,
            z: die.body.position.z,
          },
          quaternion: {
            x: die.body.quaternion.x,
            y: die.body.quaternion.y,
            z: die.body.quaternion.z,
            w: die.body.quaternion.w,
          },
        };
      });
      boardVisualDiceCache.set(poseCacheKey, {
        diceSeed: seedBase,
        values: displayedValues,
        poses: displayedPoses,
        updatedAtMs: Date.now(),
      });
      boardPoseCache.set(poseCacheKey, {
        diceSeed: seedBase,
        poses: displayedPoses,
        updatedAtMs: Date.now(),
      });
      rafId = window.requestAnimationFrame(animate);
    }

    resize();
    rafId = window.requestAnimationFrame(animate);

    return () => {
      const nextPoseCache = { ...cachedPoses };
      diceSet.forEach((die) => {
        nextPoseCache[die.dieIndex] = {
          position: {
            x: die.body.position.x,
            y: die.body.position.y,
            z: die.body.position.z,
          },
          quaternion: {
            x: die.body.quaternion.x,
            y: die.body.quaternion.y,
            z: die.body.quaternion.z,
            w: die.body.quaternion.w,
          },
        };
      });
      boardPoseCache.set(poseCacheKey, {
        diceSeed: seedBase,
        poses: nextPoseCache,
        updatedAtMs: Date.now(),
      });
      const currentVisualState = boardVisualDiceCache.get(poseCacheKey) || {};
      boardVisualDiceCache.set(poseCacheKey, {
        diceSeed: seedBase,
        values: normalizeDice(currentVisualState.values || room.dice),
        poses: nextPoseCache,
        updatedAtMs: Date.now(),
      });
      stopped = true;
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      diceSet.forEach((die) => {
        world.removeBody(die.body);
        die.mesh.geometry.dispose();
        die.hitArea.geometry.dispose();
        die.hitArea.material.dispose();
        (Array.isArray(die.mesh.material) ? die.mesh.material : [die.mesh.material]).forEach((material) => material.dispose());
        scene.remove(die.mesh);
      });
      renderer.dispose();
      shell.innerHTML = "";
    };
  }

  return { mount };
}

function buildFinalRanking(room) {
  const players = [...(Array.isArray(room.players) ? room.players : [])].sort((left, right) => {
    if (Number(right.finalScore || 0) !== Number(left.finalScore || 0)) {
      return Number(right.finalScore || 0) - Number(left.finalScore || 0);
    }
    return String(left.characterName || "").localeCompare(String(right.characterName || ""), "ko");
  });

  return `
    <div class="modal-backdrop yacht-result-modal">
      <div class="modal-panel yacht-result-panel">
        <div class="modal-head">
          <div>
            <p class="eyebrow">RESULT</p>
            <h2>최종 순위</h2>
          </div>
        </div>
        <div class="stack-list yacht-result-list">
      ${players
        .map((player, index) => {
          const isMe = String(player.uid || "") === String(yachtState.profile?.uid || "");
          return `
            <article class="info-card yacht-result-card ${isMe ? "is-self" : ""}">
              <div class="info-card-head">
                <strong>${index + 1}위 · ${escapeHtml(player.characterName || "-")}</strong>
                ${isMe ? '<span class="pill-badge yacht-result-me">나</span>' : ""}
              </div>
              <p class="muted">${escapeHtml(player.nickname || "-")}</p>
            </article>
          `;
        })
        .join("")}
        </div>
        <div class="notice-modal-actions yacht-result-actions">
          ${
            getRoomPlayer(room, yachtState.profile?.uid)
              ? '<button type="button" class="primary-button" data-yacht-restart>재시작</button>'
              : ""
          }
          <button type="button" class="ghost-button" data-yacht-leave>나가기</button>
        </div>
      </div>
    </div>
  `;
}

async function createRoomLegacy(title) {
  const profile = yachtState.profile;
  if (!profile?.uid) throw new Error("로그인 정보가 올바르지 않습니다.");

  const safeTitle = String(title || "").trim();
  if (!safeTitle) throw new Error("방 제목을 입력해 주세요.");

  const roomRef = doc(collection(db, "yacht-rooms"));
  const now = Date.now();
  const owner = createPlayer(profile);

  await setDoc(roomRef, {
    title: safeTitle,
    ownerUid: profile.uid,
    status: ROOM_STATUS_WAITING,
    actionPhase: PHASE_WAITING,
    players: [owner],
    spectators: [],
    dice: [1, 1, 1, 1, 1],
    heldDice: [false, false, false, false, false],
    diceSeed: now,
    rollCount: 0,
    currentTurnSeat: 0,
    actionDeadlineAtMs: 0,
    rollResolveAtMs: 0,
    rewardPlan: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdAtMs: now,
    updatedAtMs: now,
  });

  return roomRef.id;
}

function createRandomRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

async function joinRoomLegacy(roomId) {
  const profile = yachtState.profile;
  if (!profile?.uid) throw new Error("로그인 정보가 올바르지 않습니다.");

  const roomRef = doc(db, "yacht-rooms", roomId);
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists()) throw new Error("방을 찾을 수 없습니다.");

    const room = snapshot.data();
    if (String(room.status || "") !== ROOM_STATUS_WAITING) {
      throw new Error("게임이 이미 시작되어 플레이어로 입장할 수 없습니다.");
    }

    const players = Array.isArray(room.players) ? [...room.players] : [];
    if (players.some((player) => String(player.uid || "") === String(profile.uid || ""))) {
      return;
    }
    if (players.length >= YACHT_MAX_PLAYERS) {
      throw new Error("방 인원이 가득 찼습니다.");
    }

    const spectators = (Array.isArray(room.spectators) ? room.spectators : []).filter(
      (spectator) => String(spectator.uid || "") !== String(profile.uid || "")
    );
    players.push(createPlayer(profile));

    transaction.update(roomRef, {
      players,
      spectators,
      updatedAt: serverTimestamp(),
      updatedAtMs: Date.now(),
    });
  });
}

async function joinAsSpectatorLegacy(roomId) {
  const profile = yachtState.profile;
  if (!profile?.uid) throw new Error("로그인 정보가 올바르지 않습니다.");

  const roomRef = doc(db, "yacht-rooms", roomId);
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists()) throw new Error("방을 찾을 수 없습니다.");

    const room = snapshot.data();
    if (String(room.status || "") !== ROOM_STATUS_PLAYING) {
      throw new Error("진행 중인 방만 관전할 수 있습니다.");
    }

    const players = Array.isArray(room.players) ? room.players : [];
    if (players.some((player) => String(player.uid || "") === String(profile.uid || ""))) {
      return;
    }

    const spectators = Array.isArray(room.spectators) ? [...room.spectators] : [];
    if (!spectators.some((spectator) => String(spectator.uid || "") === String(profile.uid || ""))) {
      spectators.push({
        uid: profile.uid,
        characterName: profile.characterName,
        nickname: profile.nickname,
      });
    }

    transaction.update(roomRef, {
      spectators,
      updatedAt: serverTimestamp(),
      updatedAtMs: Date.now(),
    });
  });
}

async function toggleReadyLegacy(roomId) {
  const uid = String(yachtState.profile?.uid || "");
  if (!uid) throw new Error("로그인 정보가 올바르지 않습니다.");

  const roomRef = doc(db, "yacht-rooms", roomId);
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists()) throw new Error("방을 찾을 수 없습니다.");

    const room = snapshot.data();
    if (String(room.status || "") !== ROOM_STATUS_WAITING) {
      throw new Error("대기실에서만 준비 상태를 변경할 수 있습니다.");
    }
    if (String(room.ownerUid || "") === uid) {
      throw new Error("방장은 준비 완료를 누를 수 없습니다.");
    }

    const players = (Array.isArray(room.players) ? room.players : []).map((player) =>
      String(player.uid || "") === uid ? { ...player, isReady: !player.isReady } : player
    );

    transaction.update(roomRef, {
      players,
      updatedAt: serverTimestamp(),
      updatedAtMs: Date.now(),
    });
  });
}

async function startGameLegacy(roomId) {
  const uid = String(yachtState.profile?.uid || "");
  const roomRef = doc(db, "yacht-rooms", roomId);

  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists()) throw new Error("방을 찾을 수 없습니다.");

    const room = snapshot.data();
    if (String(room.status || "") !== ROOM_STATUS_WAITING) {
      throw new Error("이미 시작된 방입니다.");
    }
    if (!canHostStartGame(room, uid)) {
      throw new Error(resolveStartError(room, uid));
    }

    const players = (Array.isArray(room.players) ? room.players : []).map((player) =>
      finalizePlayer({
        ...player,
        isReady: false,
        scoreSheet: createEmptyScoreSheet(),
      })
    );

    transaction.update(roomRef, {
      players,
      status: ROOM_STATUS_PLAYING,
      actionPhase: PHASE_AWAITING_ROLL,
      currentTurnSeat: 0,
      rollCount: 0,
      dice: [1, 1, 1, 1, 1],
      heldDice: [false, false, false, false, false],
      diceSeed: Date.now(),
      actionDeadlineAtMs: Date.now() + YACHT_TURN_LIMIT_MS,
      rollResolveAtMs: 0,
      updatedAt: serverTimestamp(),
      updatedAtMs: Date.now(),
    });
  });
}

async function requestRollLegacy(roomId) {
  const uid = String(yachtState.profile?.uid || "");
  const roomRef = doc(db, "yacht-rooms", roomId);

  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists()) throw new Error("방을 찾을 수 없습니다.");

    const room = snapshot.data();
    if (!canCurrentUserRoll(room, uid)) {
      throw new Error("지금은 주사위를 굴릴 수 없습니다.");
    }

    const nextRollCount = Number(room.rollCount || 0) + 1;
    const seed = Date.now();
    const previousDice = normalizeDice(room.dice);
    const heldDice = Array.isArray(room.heldDice)
      ? room.heldDice.slice(0, YACHT_DICE_COUNT).map((value) => Boolean(value))
      : Array.from({ length: YACHT_DICE_COUNT }, () => false);
    const rolledDice = buildRolledDice(seed, nextRollCount);
    const dice = previousDice.map((value, index) => (heldDice[index] ? value : rolledDice[index]));

    transaction.update(roomRef, {
      dice,
      heldDice,
      diceSeed: seed,
      rollCount: nextRollCount,
      actionPhase: PHASE_ROLLING,
      rollResolveAtMs: Date.now() + YACHT_ROLL_ANIMATION_MS,
      updatedAt: serverTimestamp(),
      updatedAtMs: Date.now(),
    });
  });
}

async function lockScoreLegacy(roomId, categoryId) {
  const uid = String(yachtState.profile?.uid || "");
  const safeCategoryId = String(categoryId || "");
  if (!PLAYABLE_CATEGORY_IDS.includes(safeCategoryId)) {
    throw new Error("잘못된 점수 칸입니다.");
  }

  const roomRef = doc(db, "yacht-rooms", roomId);
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists()) throw new Error("방을 찾을 수 없습니다.");

    const room = snapshot.data();
    if (!canCurrentUserScore(room, uid)) {
      throw new Error("지금은 점수를 기록할 수 없습니다.");
    }

    const players = [...(Array.isArray(room.players) ? room.players : [])];
    const seat = Number(room.currentTurnSeat || 0);
    const player = players[seat];
    if (!player || String(player.uid || "") !== uid) {
      throw new Error("현재 턴 플레이어가 아닙니다.");
    }
    if (player.scoreSheet?.[safeCategoryId]?.locked) {
      throw new Error("이미 기록한 점수 칸입니다.");
    }

    const scoreSheet = {
      ...(player.scoreSheet || createEmptyScoreSheet()),
      [safeCategoryId]: {
        score: calculateCategoryScore(safeCategoryId, normalizeDice(room.dice)),
        locked: true,
      },
    };
    players[seat] = finalizePlayer({ ...player, scoreSheet });

    const everyoneFinished = players.every((item) => isScoreSheetComplete(item.scoreSheet));
    if (everyoneFinished) {
      const rankedPlayers = assignRanks(players);
      transaction.update(roomRef, {
        players: rankedPlayers,
        status: ROOM_STATUS_FINISHED,
        actionPhase: PHASE_FINISHED,
        rollCount: 0,
        heldDice: [false, false, false, false, false],
        actionDeadlineAtMs: 0,
        rollResolveAtMs: 0,
        updatedAt: serverTimestamp(),
        updatedAtMs: Date.now(),
      });
      return;
    }

    const nextSeat = findNextSeat(players, seat);
    transaction.update(roomRef, {
      players,
      currentTurnSeat: nextSeat,
      actionPhase: PHASE_AWAITING_ROLL,
      rollCount: 0,
      dice: [1, 1, 1, 1, 1],
      heldDice: [false, false, false, false, false],
      diceSeed: Date.now(),
      actionDeadlineAtMs: Date.now() + YACHT_TURN_LIMIT_MS,
      rollResolveAtMs: 0,
      updatedAt: serverTimestamp(),
      updatedAtMs: Date.now(),
    });
  });
}

async function leaveRoomLegacy(roomId) {
  const uid = String(yachtState.profile?.uid || "");
  if (!uid) return;

  const roomRef = doc(db, "yacht-rooms", roomId);
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists()) return;

    const room = snapshot.data();
    let players = (Array.isArray(room.players) ? room.players : []).filter(
      (player) => String(player.uid || "") !== uid
    );
    let spectators = (Array.isArray(room.spectators) ? room.spectators : []).filter(
      (spectator) => String(spectator.uid || "") !== uid
    );

    if (players.length + spectators.length <= 1) {
      transaction.delete(roomRef);
      return;
    }

    let nextOwnerUid = String(room.ownerUid || "");
    if (!players.some((player) => String(player.uid || "") === nextOwnerUid)) {
      nextOwnerUid = String(players[0]?.uid || "");
    }

    let nextTurnSeat = Number(room.currentTurnSeat || 0);
    if (players.length) {
      nextTurnSeat = Math.min(nextTurnSeat, players.length - 1);
      if (
        String(room.status || "") === ROOM_STATUS_PLAYING &&
        !players.some((player) => String(player.uid || "") === String(getCurrentTurnPlayer(room)?.uid || ""))
      ) {
        nextTurnSeat = findNextSeat(players, Math.max(0, nextTurnSeat - 1));
      }
    }

    if (String(room.status || "") === ROOM_STATUS_WAITING) {
      players = players.map((player) =>
        String(player.uid || "") === nextOwnerUid ? { ...player, isReady: false } : player
      );
    }

    transaction.update(roomRef, {
      ownerUid: nextOwnerUid,
      players,
      spectators,
      currentTurnSeat: players.length ? nextTurnSeat : 0,
      updatedAt: serverTimestamp(),
      updatedAtMs: Date.now(),
    });
  });
}

async function restartFinishedRoomLegacy(roomId) {
  const profile = yachtState.profile;
  const uid = String(profile?.uid || "");
  if (!uid) throw new Error("로그인 정보가 올바르지 않습니다.");

  const roomRef = doc(db, "yacht-rooms", roomId);
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists()) throw new Error("방을 찾을 수 없습니다.");

    const room = snapshot.data();
    if (String(room.status || "") === ROOM_STATUS_WAITING) {
      return;
    }
    if (String(room.status || "") !== ROOM_STATUS_FINISHED) {
      throw new Error("게임이 끝난 뒤에만 재시작할 수 있습니다.");
    }

    const players = Array.isArray(room.players) ? [...room.players] : [];
    const spectators = Array.isArray(room.spectators) ? [...room.spectators] : [];
    const requesterPlayer = players.find((player) => String(player.uid || "") === uid);
    const requesterSpectator = spectators.find((spectator) => String(spectator.uid || "") === uid);
    if (!requesterPlayer && !requesterSpectator) {
      throw new Error("방에 남아 있는 참가자만 재시작할 수 있습니다.");
    }

    const requesterSeed =
      requesterPlayer ||
      createPlayer({
        uid: profile.uid,
        characterName: profile.characterName,
        nickname: profile.nickname,
      });

    const reorderedPlayers = [requesterSeed, ...players.filter((player) => String(player.uid || "") !== uid)]
      .slice(0, YACHT_MAX_PLAYERS)
      .map((player) =>
        finalizePlayer({
          ...player,
          isReady: false,
          rank: 0,
          rewardCurrency: 0,
          scoreSheet: createEmptyScoreSheet(),
        })
      );

    transaction.update(roomRef, {
      ownerUid: uid,
      players: reorderedPlayers,
      spectators: spectators.filter((spectator) => String(spectator.uid || "") !== uid),
      status: ROOM_STATUS_WAITING,
      actionPhase: PHASE_WAITING,
      currentTurnSeat: 0,
      rollCount: 0,
      dice: [1, 1, 1, 1, 1],
      heldDice: [false, false, false, false, false],
      diceSeed: Date.now(),
      actionDeadlineAtMs: 0,
      rollResolveAtMs: 0,
      rewardPlan: null,
      updatedAt: serverTimestamp(),
      updatedAtMs: Date.now(),
    });
  });
}

async function maybeAdvanceByTimeout() {
  const room = yachtState.room;
  if (!room || String(room.status || "") !== ROOM_STATUS_PLAYING) return;

  const now = Date.now();
  if (String(room.actionPhase || "") === PHASE_ROLLING && Number(room.rollResolveAtMs || 0) <= now) {
    try {
      await callYachtAction("advance-room", { roomId: room.id });
    } catch {
      // noop
    }
    return;
  }

  if (String(room.actionPhase || "") === PHASE_AWAITING_ROLL && Number(room.actionDeadlineAtMs || 0) <= now) {
    try {
      await callYachtAction("advance-room", { roomId: room.id });
    } catch {
      // noop
    }
  }
}

async function resolveRollLegacy(roomId) {
  const roomRef = doc(db, "yacht-rooms", roomId);
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists()) return;

    const room = snapshot.data();
    if (String(room.status || "") !== ROOM_STATUS_PLAYING || String(room.actionPhase || "") !== PHASE_ROLLING) {
      return;
    }
    if (Number(room.rollResolveAtMs || 0) > Date.now()) {
      return;
    }

    const rollCount = Number(room.rollCount || 0);
    transaction.update(roomRef, {
      actionPhase: rollCount >= 3 ? PHASE_AWAITING_ROLL : PHASE_AWAITING_ROLL,
      actionDeadlineAtMs: Date.now() + YACHT_TURN_LIMIT_MS,
      rollResolveAtMs: 0,
      updatedAt: serverTimestamp(),
      updatedAtMs: Date.now(),
    });
  });
}

async function toggleHoldLegacy(roomId, dieIndex) {
  const uid = String(yachtState.profile?.uid || "");
  const safeIndex = Number(dieIndex);
  if (!Number.isInteger(safeIndex) || safeIndex < 0 || safeIndex >= YACHT_DICE_COUNT) {
    throw new Error("잘못된 주사위입니다.");
  }

  const roomRef = doc(db, "yacht-rooms", roomId);
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists()) throw new Error("방을 찾을 수 없습니다.");

    const room = snapshot.data();
    if (!canCurrentUserToggleHold(room, uid)) {
      throw new Error("지금은 주사위를 고정할 수 없습니다.");
    }

    const heldDice = Array.isArray(room.heldDice)
      ? room.heldDice.slice(0, YACHT_DICE_COUNT).map((value) => Boolean(value))
      : Array.from({ length: YACHT_DICE_COUNT }, () => false);
    heldDice[safeIndex] = !heldDice[safeIndex];

    transaction.update(roomRef, {
      heldDice,
      updatedAt: serverTimestamp(),
      updatedAtMs: Date.now(),
    });
  });
}

async function autoScoreBestCategoryLegacy(roomId) {
  const roomRef = doc(db, "yacht-rooms", roomId);
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists()) return;

    const room = snapshot.data();
    if (String(room.status || "") !== ROOM_STATUS_PLAYING) return;
    if (String(room.actionPhase || "") === PHASE_ROLLING) return;
    if (Number(room.rollCount || 0) <= 0) return;

    const seat = Number(room.currentTurnSeat || 0);
    const players = [...(Array.isArray(room.players) ? room.players : [])];
    const player = players[seat];
    if (!player) return;

    const bestCategoryId = pickBestScoreCategory(player.scoreSheet, normalizeDice(room.dice));
    if (!bestCategoryId) return;

    const scoreSheet = {
      ...(player.scoreSheet || createEmptyScoreSheet()),
      [bestCategoryId]: {
        score: calculateCategoryScore(bestCategoryId, normalizeDice(room.dice)),
        locked: true,
      },
    };
    players[seat] = finalizePlayer({ ...player, scoreSheet });

    const everyoneFinished = players.every((item) => isScoreSheetComplete(item.scoreSheet));
    if (everyoneFinished) {
      transaction.update(roomRef, {
        players: assignRanks(players),
        status: ROOM_STATUS_FINISHED,
        actionPhase: PHASE_FINISHED,
        rollCount: 0,
        heldDice: [false, false, false, false, false],
        actionDeadlineAtMs: 0,
        rollResolveAtMs: 0,
        updatedAt: serverTimestamp(),
        updatedAtMs: Date.now(),
      });
      return;
    }

    transaction.update(roomRef, {
      players,
      currentTurnSeat: findNextSeat(players, seat),
      actionPhase: PHASE_AWAITING_ROLL,
      rollCount: 0,
      dice: [1, 1, 1, 1, 1],
      heldDice: [false, false, false, false, false],
      diceSeed: Date.now(),
      actionDeadlineAtMs: Date.now() + YACHT_TURN_LIMIT_MS,
      rollResolveAtMs: 0,
      updatedAt: serverTimestamp(),
      updatedAtMs: Date.now(),
    });
  });
}

async function callYachtAction(action, payload = {}) {
  const response = await yachtActionCallable({
    action,
    ...payload,
  });
  return response?.data || {};
}

async function createRoom(title) {
  const result = await callYachtAction("create-room", { title });
  return String(result?.roomId || "").trim();
}

async function joinRoom(roomId) {
  await callYachtAction("join-room", { roomId });
}

async function joinAsSpectator(roomId) {
  await callYachtAction("join-spectator", { roomId });
}

async function toggleReady(roomId) {
  await callYachtAction("toggle-ready", { roomId });
}

async function startGame(roomId) {
  await callYachtAction("start-game", { roomId });
}

async function requestRoll(roomId) {
  await callYachtAction("request-roll", { roomId });
}

async function lockScore(roomId, categoryId) {
  await callYachtAction("lock-score", { roomId, categoryId });
}

async function leaveRoom(roomId) {
  await callYachtAction("leave-room", { roomId });
}

async function restartFinishedRoom(roomId) {
  const result = await callYachtAction("restart-room", { roomId });
  if (result?.redirectLobby) {
    await clearActiveRoom();
    return { redirectLobby: true };
  }
  if (result?.roomId) {
    await setActiveRoom(result.roomId, result.role || "player");
    return { roomId: result.roomId };
  }
  return result;
}

async function resolveRoll(roomId) {
  await callYachtAction("advance-room", { roomId });
}

async function toggleHold(roomId, dieIndex, extraPayload = null) {
  await callYachtAction("toggle-hold", {
    roomId,
    dieIndex,
    ...(extraPayload && typeof extraPayload === "object" ? extraPayload : {}),
  });
}

async function autoScoreBestCategory(roomId) {
  await callYachtAction("advance-room", { roomId });
}

function assignRanks(players) {
  const sorted = [...players].sort((left, right) => {
    if (Number(right.finalScore || 0) !== Number(left.finalScore || 0)) {
      return Number(right.finalScore || 0) - Number(left.finalScore || 0);
    }
    return String(left.characterName || "").localeCompare(String(right.characterName || ""), "ko");
  });

  sorted.forEach((player, index) => {
    player.rank = index + 1;
  });

  return players.map((player) => {
    const ranked = sorted.find((item) => String(item.uid || "") === String(player.uid || ""));
    return { ...player, rank: Number(ranked?.rank || 0) };
  });
}

async function setActiveRoom(roomId, role) {
  const profile = yachtState.profile;
  if (!profile?.docId) return;

  yachtState.roomId = String(roomId || "").trim();
  await updateDoc(doc(db, "users", profile.docId), {
    activeYachtRoomId: yachtState.roomId,
    activeYachtRole: String(role || "").trim(),
    activeYachtUpdatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  await yachtState.onProfilePatched?.({
    ...profile,
    activeYachtRoomId: yachtState.roomId,
    activeYachtRole: String(role || "").trim(),
  });

  if (typeof activeRoomUnsubscribe === "function") {
    activeRoomUnsubscribe();
  }
  subscribeActiveRoom(yachtState.roomId);
}

async function clearActiveRoom() {
  const profile = yachtState.profile;
  if (!profile?.docId) return;

  yachtState.onToast?.forceHide?.();
  yachtState.roomId = "";
  yachtState.room = null;
  if (typeof activeRoomUnsubscribe === "function") {
    activeRoomUnsubscribe();
    activeRoomUnsubscribe = null;
  }
  await updateDoc(doc(db, "users", profile.docId), {
    activeYachtRoomId: "",
    activeYachtRole: "",
    activeYachtUpdatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  await yachtState.onProfilePatched?.({
    ...profile,
    activeYachtRoomId: "",
    activeYachtRole: "",
  });
  renderYachtRoot();
}

function pseudoRandom(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
