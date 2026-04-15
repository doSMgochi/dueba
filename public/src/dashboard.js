import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";
import { db } from "./firebase.js";
import {
  adminDeleteUser,
  adminManageUser,
  createItemDefinition,
  createAnnouncement,
  dismissAnnouncement,
  getRankingBoard,
  listAdminLogs,
  listBugReports,
  markNotificationRead,
  purchaseShopItem,
  refreshCurrentUserProfile,
  respondParcel,
  selectTrait,
  sendParcel,
  updateProfileSealImage,
} from "./auth.js";

export const menuDefinitions = [
  { id: "ranking", label: "??‚¹" },
  { id: "match", label: "?€êµ??•ë³´" },
  { id: "match-results", label: "?€êµ?ê²°ê³¼" },
  { id: "traits", label: "?¹ì„±ì¹? },
  { id: "inventory", label: "?¸ë²¤? ë¦¬" },
  { id: "shop", label: "?ì " },
  { id: "roulette", label: "ë£°ë ›" },
  { id: "admin", label: "?´ì˜ì§?ë©”ë‰´", adminOnly: true },
  { id: "bug-report", label: "ë²„ê·¸ ë¦¬í¬?? },
  { id: "todo", label: "???? },
  { id: "item-db", label: "?„ì´??DB", adminOnly: true },
];

const adminRoles = ["admin", "gm", "moderator"];
const roulettePalette = ["#0d285a", "#153b7d", "#fa5f03", "#244f95", "#0d285a", "#fa5f03"];

const sampleLiveMatches = [
  {
    title: "?„ì¬ ì§„í–‰ì¤‘ì¸ ?€êµ??ˆì‹œ",
    source: "?¬ë¡¤ë§??°ë™ ?ˆì •",
    players: [
      { mahjongNickname: "ìª¼ë¦„", characterName: "? ì¦ˆ", traits: ["?‘í›„ë¡??”ë£Œ", "36???€ê¸°ë¡œ ?”ë£Œ"] },
      { mahjongNickname: "?„ìŠ¤ëª¨ì°Œ", characterName: "?„ì˜¤??, traits: ["êµ?‚¬ë¬´ìŒ?¼ë¡œ ?”ë£Œ", "?¹ì„± ë¹„ê³µê°?] },
    ],
  },
  {
    title: "ê´€???€ê¸°ë°© ?ˆì‹œ",
    source: "?¬ë¡¤ë§??°ë™ ?ˆì •",
    players: [{ mahjongNickname: "sample-player", characterName: "A-37", traits: ["?‘í›„ë¡??”ë£Œ"] }],
  },
];

let activeAdminSection = "user-adjust";
let currentNoticeModalId = null;
let adminLogPages = { operate: 0, notice: 0 };
let activeResultMode = "ranked-4p-hanchan";
let matchResultsPage = 0;
let notificationPanelPage = 0;
let todoPage = 0;
let pendingAdminItemIds = [];
let selectedParcelItemKeys = [];
let bugReportPage = 0;
const quickProfileCacheTtl = 60 * 1000;
let rankingBoardCache = { data: null, fetchedAt: 0, promise: null };
let traitItemsCache = { data: null, fetchedAt: 0, promise: null };

async function withPendingToast(onToast, task) {
  onToast("ì²˜ë¦¬ì¤‘ì…?ˆë‹¤");
  return task();
}

async function getCachedRankingBoard(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && rankingBoardCache.data && now - rankingBoardCache.fetchedAt < quickProfileCacheTtl) {
    return rankingBoardCache.data;
  }

  if (rankingBoardCache.promise) {
    return rankingBoardCache.promise;
  }

  rankingBoardCache.promise = getRankingBoard()
    .then((data) => {
      rankingBoardCache = {
        data: Array.isArray(data) ? data : [],
        fetchedAt: Date.now(),
        promise: null,
      };
      return rankingBoardCache.data;
    })
    .catch((error) => {
      rankingBoardCache.promise = null;
      throw error;
    });

  return rankingBoardCache.promise;
}

async function getCachedTraits(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && traitItemsCache.data && now - traitItemsCache.fetchedAt < quickProfileCacheTtl) {
    return traitItemsCache.data;
  }

  if (traitItemsCache.promise) {
    return traitItemsCache.promise;
  }

  traitItemsCache.promise = fetchCollectionItems("traits", "sortOrder")
    .then((data) => {
      traitItemsCache = {
        data: Array.isArray(data) ? data : [],
        fetchedAt: Date.now(),
        promise: null,
      };
      return traitItemsCache.data;
    })
    .catch((error) => {
      traitItemsCache.promise = null;
      throw error;
    });

  return traitItemsCache.promise;
}

function invalidateQuickProfileCaches() {
  rankingBoardCache = { data: null, fetchedAt: 0, promise: null };
  traitItemsCache = { data: null, fetchedAt: 0, promise: null };
}

export function buildDashboard({
  profile,
  activeMenuId,
  menuTabs,
  menuContent,
  onProfilePatched,
  onToast,
}) {
  const visibleMenus = menuDefinitions.filter((menu) => !menu.adminOnly || adminRoles.includes(profile.role));
  const safeActiveMenuId = visibleMenus.some((menu) => menu.id === activeMenuId)
    ? activeMenuId
    : visibleMenus[0].id;

  document.querySelector("#welcome-title").textContent = `${profile.characterName}???˜ì˜?©ë‹ˆ??;
  document.querySelector("#profile-summary").textContent = `${profile.nickname} | ID ${profile.loginId}`;
  document.querySelector("#role-badge").textContent = profile.role;
  document.querySelector("#currency-value").textContent = `${Number(profile.currency || 0)} G`;
  document.querySelector("#inventory-count").textContent = String(profile.inventory?.length || 0);
  document.querySelector("#stat-points").textContent = String(profile.availableTraitPoints || 0);

  menuTabs.innerHTML = visibleMenus
    .map((menu) => {
      return `
        <button type="button" class="tab-button ${menu.id === safeActiveMenuId ? "active" : ""}" data-menu-id="${menu.id}">
          <span>${menu.label}</span>
        </button>
      `;
    })
    .join("");

  renderNotificationBell({ profile, onProfilePatched, onToast });
  renderProfileQuickButton({ profile, onProfilePatched, onToast });
  void hydrateNotificationBadge(profile);

  menuContent.innerHTML = renderMenuContent(safeActiveMenuId, profile);

  if (safeActiveMenuId === "ranking") void hydrateRankingPanel();
  if (safeActiveMenuId === "shop") void hydrateShopPanel({ onProfilePatched, onToast });
  if (safeActiveMenuId === "item-db") void hydrateItemDatabasePanel();
  if (safeActiveMenuId === "inventory") attachParcelForm({ profile, onProfilePatched, onToast });
  if (safeActiveMenuId === "bug-report") void hydrateBugReportPanel(profile, onToast);
  if (safeActiveMenuId === "todo") {
    attachTodoEvents({ profile, onToast });
    todoPage = 0;
    void hydrateTodoPanel(profile.uid);
  }
  if (safeActiveMenuId === "roulette") {
    attachRouletteEvents({ profile, onToast });
    void hydrateRoulettePanel(profile);
  }
  if (safeActiveMenuId === "match-results") void hydrateMatchResultsPanel();
  if (safeActiveMenuId === "traits") void hydrateTraitPanel({ profile, onProfilePatched, onToast });
  if (safeActiveMenuId === "admin") hydrateAdminPanel({ onProfilePatched, onToast });

  void syncAnnouncementModal({ profile, onProfilePatched, onToast });
}

function renderMenuContent(menuId, profile) {
  const isThreePlayerResultMode = activeResultMode.includes("3p");
  const inventoryItems = (profile.inventory || [])
    .map((item) => {
      const tooltip = escapeHtml(`${item.name || "?´ë¦„ ?†ëŠ” ?„ì´??} | ${item.description || "?¤ëª…???„ì§ ?±ë¡?˜ì? ?Šì•˜?µë‹ˆ??"}`);
      const itemKey = escapeHtml(buildInventoryItemKey(item));
      const icon = escapeHtml(item.icon || "?");
      return `
        <li class="inventory-item inventory-tooltip draggable-item" data-tooltip="${tooltip}" draggable="true" data-inventory-item-key="${itemKey}">
          <div class="dot-slot">${icon}</div>
        </li>
      `;
    })
    .join("");

  const liveMatchCards = sampleLiveMatches
    .map((match) => {
      const playerBadges = match.players
        .map((player) => `<span class="live-pill">${escapeHtml(player.mahjongNickname)}</span>`)
        .join("");
      const playerLines = match.players
        .map(
          (player) => `
            <div class="live-player-line">
              <strong>${escapeHtml(player.mahjongNickname)}</strong>
              <span>${escapeHtml(player.characterName)}</span>
              <p>${escapeHtml(player.traits.join(", "))}</p>
            </div>
          `
        )
        .join("");
      return `
        <article class="content-card live-match-card">
          <h3>${escapeHtml(match.title)}</h3>
          <p>${escapeHtml(match.source)}</p>
          <div class="live-match-summary">${playerBadges}</div>
          <div class="live-hover-panel">${playerLines}</div>
        </article>
      `;
    })
    .join("");

  const views = {
    ranking: `
      <article class="content-card full">
        <h3>??‚¹</h3>
        <div class="table-wrap">
          <table class="log-table ranking-table">
            <thead>
              <tr>
                <th>?œìœ„</th>
                <th>ìºë¦­?°ëª…</th>
                <th>?‘í˜¼ ?‰ë„¤??/th>
                <th>??‚¹???¬ì¸??/th>
                <th>ë³´ìœ  ?¬í™”</th>
                <th>ì´??¹ì„±ì¹??¬ì¸??/th>
              </tr>
            </thead>
            <tbody id="ranking-table-body">
              <tr><td colspan="6" class="table-empty">??‚¹??ë¶ˆëŸ¬?¤ëŠ” ì¤‘ì…?ˆë‹¤.</td></tr>
            </tbody>
          </table>
        </div>
      </article>
    `,
    shop: `
      <div id="shop-grid" class="content-grid three">
        <article class="content-card full">
          <p class="muted">?ì  ?•ë³´ë¥?ë¶ˆëŸ¬?¤ëŠ” ì¤‘ì…?ˆë‹¤.</p>
        </article>
      </div>
    `,
    "item-db": `
      <div id="item-db-grid" class="content-grid three">
        <article class="content-card full">
          <p class="muted">?„ì´??DBë¥?ë¶ˆëŸ¬?¤ëŠ” ì¤‘ì…?ˆë‹¤.</p>
        </article>
      </div>
    `,
    "bug-report": `
      <div class="content-grid two">
        <article class="content-card">
          <h3>ë²„ê·¸ ë¦¬í¬???‘ì„±</h3>
          <form id="bug-report-form" class="stack-form compact-form">
            <label><span>?œëª©</span><input type="text" name="title" placeholder="ê°„ë‹¨???œëª©" required /></label>
            <label><span>?´ìš©</span><textarea name="body" rows="6" placeholder="?¬í˜„ ë°©ë²•?´ë‚˜ ì¦ìƒ???ì–´ì£¼ì„¸??" required></textarea></label>
            <button type="submit" class="primary-button">ë¦¬í¬???±ë¡</button>
          </form>
        </article>
        <article class="content-card ${adminRoles.includes(profile.role) ? "" : "hidden"}">
          <div class="admin-log-head">
            <h3>?‘ìˆ˜??ë¦¬í¬??/h3>
            <div class="admin-log-pager">
              <button type="button" class="ghost-button compact-button" data-report-page="prev">?´ì „</button>
              <span id="bug-report-page-label" class="muted">1 ?˜ì´ì§€</span>
              <button type="button" class="ghost-button compact-button" data-report-page="next">?¤ìŒ</button>
            </div>
          </div>
          <div class="table-wrap">
            <table class="log-table">
              <thead><tr><th>?œê°</th><th>?‘ì„±??/th><th>?œëª©</th><th>?´ìš©</th></tr></thead>
              <tbody id="bug-report-body"><tr><td colspan="4" class="table-empty">ë²„ê·¸ ë¦¬í¬?¸ë? ë¶ˆëŸ¬?¤ëŠ” ì¤‘ì…?ˆë‹¤.</td></tr></tbody>
            </table>
          </div>
        </article>
      </div>
    `,
    inventory: `
      <div class="content-grid two inventory-layout">
        <article class="content-card full">
          <h3>?¸ë²¤? ë¦¬</h3>
          <ul class="inventory-list">
            ${inventoryItems || '<li class="empty-state">ë³´ìœ  ì¤‘ì¸ ?„ì´?œì´ ?†ìŠµ?ˆë‹¤.</li>'}
          </ul>
        </article>
        <article class="content-card">
          <h3>?Œí¬ ë³´ë‚´ê¸?/h3>
          <form id="parcel-form" class="stack-form compact-form">
            <label><span>?€??ìºë¦­?°ëª…</span><input type="text" name="targetCharacterName" placeholder="ë°›ëŠ” ìºë¦­?°ëª…" required /></label>
            <div class="parcel-drop-shell">
              <div id="parcel-drop-zone" class="parcel-drop-zone">
                <strong>ë³´ë‚¼ ?„ì´??/strong>
                <p class="muted">?¸ë²¤? ë¦¬ ?„ì´?œì„ ?¬ê¸°ë¡??œë˜ê·¸í•´???¬ëŸ¬ ê°??£ì–´ì£¼ì„¸??</p>
                <div id="parcel-selected-item" class="parcel-selected-item muted">? íƒ???„ì´?œì´ ?†ìŠµ?ˆë‹¤.</div>
                <button id="parcel-clear-button" type="button" class="ghost-button compact-button">? íƒ ?´ì œ</button>
              </div>
            </div>
            <label><span>ë³´ë‚¼ ?¬í™”</span><input type="number" min="0" name="currencyAmount" placeholder="0" /></label>
            <label class="inline-check parcel-wrap-check">
              <input type="checkbox" name="useWrapping" />
              <span class="check-indicator" aria-hidden="true"></span>
              <span class="check-copy">
                <strong>?¬ì¥ì§€ ?¬ìš©</strong>
                <small>?¬ì¥ì§€ë¥??¬ìš©?˜ë©´ ?´ìš©ë¬¼ì„ ?¨ê¸¸ ???ˆê³  ê¸°ë³¸?ìœ¼ë¡?ê±°ì ˆ?????†ìŠµ?ˆë‹¤. ?? ?ë?ê°€ ê±°ì ˆê¶Œì„ ê°€ì§€ê³??ˆë‹¤ë©?ê±°ì ˆ?????ˆìŠµ?ˆë‹¤.</small>
              </span>
            </label>
            <button type="submit" class="primary-button">?Œí¬ ë³´ë‚´ê¸?/button>
          </form>
        </article>
      </div>
    `,
    todo: `
      <div class="content-grid two todo-layout">
        <article class="content-card">
          <h3>????ì¶”ê?</h3>
          <form id="todo-form" class="stack-form compact-form todo-form">
            <label>
              <span>ë©”ëª¨</span>
              <textarea name="todoText" rows="4" maxlength="200" placeholder="ê°„ë‹¨??ë©”ëª¨ë¥??ì–´?ì„¸?? required></textarea>
            </label>
            <button type="submit" class="primary-button">ì¶”ê?</button>
          </form>
        </article>
        <article class="content-card">
          <h3>????ëª©ë¡</h3>
          <div id="todo-list" class="stack-list">
            <p class="muted">????ëª©ë¡??ë¶ˆëŸ¬?¤ëŠ” ì¤‘ì…?ˆë‹¤.</p>
          </div>
          <div id="todo-pager" class="notification-pager hidden"></div>
        </article>
      </div>
    `,
    roulette: `
      <div class="roulette-layout">
        <article class="content-card roulette-side-card">
          <div class="roulette-side-head">
            <h3>ë£°ë › ??ª©</h3>
            <form id="roulette-item-form" class="roulette-inline-form">
              <input type="text" name="name" placeholder="??ª© ?´ë¦„" required />
              <button type="submit" class="ghost-button compact-button">ì¶”ê?</button>
            </form>
          </div>
          <div id="roulette-item-list" class="roulette-item-list compact-list"><p class="muted">?±ë¡????ª©???†ìŠµ?ˆë‹¤.</p></div>
        </article>
        <article class="content-card roulette-card wide">
          <div class="roulette-stage">
            <div class="roulette-pointer"></div>
            <div id="roulette-wheel" class="roulette-wheel empty-wheel">
              <div id="roulette-wheel-labels" class="roulette-labels">
                <span class="wheel-placeholder">??ª©??ì¶”ê??˜ë©´ ?íŒ??ë§Œë“¤?´ì§‘?ˆë‹¤.</span>
              </div>
            </div>
          </div>
          <button id="roulette-button" type="button" class="primary-button roulette-spin-button">ë£°ë › ?Œë¦¬ê¸?/button>
          <p id="roulette-result" class="muted roulette-result-text">??ª©??ì¶”ê??˜ë©´ ?Œë¦´ ???ˆìŠµ?ˆë‹¤.</p>
        </article>
      </div>
      <article class="content-card roulette-log-card">
        <h3>ìµœê·¼ ë£°ë › ê²°ê³¼</h3>
        <div class="table-wrap roulette-log-wrap">
          <table class="log-table">
            <thead><tr><th>?œê°</th><th>ìºë¦­?°ëª…</th><th>ê²°ê³¼</th></tr></thead>
            <tbody id="roulette-log-body"><tr><td colspan="3" class="table-empty">?„ì§ ë¡œê·¸ê°€ ?†ìŠµ?ˆë‹¤.</td></tr></tbody>
          </table>
        </div>
      </article>
    `,
    match: `
      <div class="content-grid two">
        ${liveMatchCards}
        <article class="content-card">
          <h3>?•ì¥ ë©”ëª¨</h3>
          <p>?˜ì¤‘???¬ë¡¤ë§??°ì´?°ì—???€êµ?¤‘????ª©??ì°¾ê³ , ê·??ˆì˜ ?‘í˜¼ ?‰ë„¤?„ì„ ìºë¦­?°ì? ?°ê²°???„ì¬ ?€êµ?¤‘???¹ì„±ì¹˜ë? hover ?•ë³´ë¡?ë³´ì—¬ì£¼ëŠ” êµ¬ì¡°ë¥??¼ë‘?????”ë©´?…ë‹ˆ??</p>
          <div class="schema-box">
            <strong>ì¶”ì²œ ì»¬ë ‰??êµ¬ì¡°</strong>
            <p><code>live-matches</code>???œëª©, ?íƒœ, ?Œë ˆ?´ì–´ ëª©ë¡, ?‘í˜¼ ?‰ë„¤?? ìºë¦­?°ëª…, ?¹ì„±ì¹??”ì•½???€?¥í•˜??ë°©ì‹???•ì¥??? ë¦¬?©ë‹ˆ??</p>
          </div>
        </article>
      </div>
    `,
    "match-results": `
      <article class="content-card full">
        <div class="result-mode-tabs">
          <div class="admin-section-tabs">
            <button type="button" class="tab-button ${activeResultMode === "ranked-4p-hanchan" ? "active" : ""}" data-result-mode="ranked-4p-hanchan">??‚¹??4??ë°˜ì¥??/button>
            <button type="button" class="tab-button ${activeResultMode === "ranked-3p-hanchan" ? "active" : ""}" data-result-mode="ranked-3p-hanchan">??‚¹??3??ë°˜ì¥??/button>
            <button type="button" class="tab-button ${activeResultMode === "normal-4p-hanchan" ? "active" : ""}" data-result-mode="normal-4p-hanchan">?¼ë°˜??4??ë°˜ì¥??/button>
            <button type="button" class="tab-button ${activeResultMode === "normal-3p-hanchan" ? "active" : ""}" data-result-mode="normal-3p-hanchan">?¼ë°˜??3??ë°˜ì¥??/button>
          </div>
        </div>
        <div class="table-wrap">
          <table class="log-table">
            <thead>
              <tr>
                <th rowspan="2">Timestamp</th>
                <th colspan="2">1??/th>
                <th colspan="2">2??/th>
                <th colspan="2">3??/th>
                ${isThreePlayerResultMode ? "" : '<th colspan="2">4??/th>'}
              </tr>
              <tr>
                <th>?‰ë„¤??/th>
                <th>?ìˆ˜</th>
                <th>?‰ë„¤??/th>
                <th>?ìˆ˜</th>
                <th>?‰ë„¤??/th>
                <th>?ìˆ˜</th>
                ${isThreePlayerResultMode ? "" : "<th>?‰ë„¤??/th><th>?ìˆ˜</th>"}
              </tr>
            </thead>
            <tbody id="match-results-body">
              <tr><td colspan="${isThreePlayerResultMode ? 7 : 9}" class="table-empty">?€êµ?ê²°ê³¼ë¥?ë¶ˆëŸ¬?¤ëŠ” ì¤‘ì…?ˆë‹¤.</td></tr>
            </tbody>
          </table>
        </div>
        <div class="admin-log-pager">
          <button type="button" class="ghost-button compact-button" data-match-page="prev">?´ì „</button>
          <span id="match-results-page-label" class="muted">1 ?˜ì´ì§€</span>
          <button type="button" class="ghost-button compact-button" data-match-page="next">?¤ìŒ</button>
        </div>
      </article>
    `,
    traits: `
      <article class="content-card full">
        <div class="trait-header">
          <div>
            <h3>?¹ì„±ì¹?/h3>
            <p>???¹ì„±ì¹˜ëŠ” ??ë²ˆë§Œ ì°ì„ ???ˆìŠµ?ˆë‹¤. ?±ê³µ ë³´ë„ˆ?? ?¤íŒ¨ ?¨ë„?? ?„ìš” ?¬ì¸?¸ë? ?œë¡œ ë¹ ë¥´ê²??•ì¸?????ˆìŠµ?ˆë‹¤.</p>
          </div>
          <strong class="trait-point-badge">?¨ì? ?¬ì¸??${Number(profile.availableTraitPoints || 0)}</strong>
        </div>
        <div class="table-wrap">
          <table class="log-table trait-table">
            <thead><tr><th>?¹ì„±ëª?/th><th>?±ê³µ+</th><th>?¤íŒ¨-</th><th>?„ìš”P</th><th>?íƒœ</th><th>êµ¬ë§¤</th></tr></thead>
            <tbody id="trait-table-body"><tr><td colspan="6" class="table-empty">?¹ì„±ì¹˜ë? ë¶ˆëŸ¬?¤ëŠ” ì¤‘ì…?ˆë‹¤.</td></tr></tbody>
          </table>
        </div>
      </article>
    `,
    admin: `
      <article class="content-card full">
        <div class="admin-shell">
          <div class="admin-section-tabs">
            <button type="button" class="tab-button ${activeAdminSection === "user-adjust" ? "active" : ""}" data-admin-section="user-adjust">? ì? ì¡°ì •</button>
            <button type="button" class="tab-button ${activeAdminSection === "item-db" ? "active" : ""}" data-admin-section="item-db">?„ì´??ì¶”ê?</button>
            <button type="button" class="tab-button ${activeAdminSection === "notice" ? "active" : ""}" data-admin-section="notice">ê³µì? ?‘ì„±</button>
            <button type="button" class="tab-button ${activeAdminSection === "account" ? "active" : ""}" data-admin-section="account">ê³„ì • ê´€ë¦?/button>
          </div>
          <div id="admin-section-body"></div>
        </div>
      </article>
    `,
  };

  return views[menuId] || "";
}

async function hydrateShopPanel({ onProfilePatched, onToast }) {
  const shopGrid = document.querySelector("#shop-grid");
  if (!shopGrid) return;

  try {
    const [shopItems, itemDbItems] = await Promise.all([
      fetchCollectionItems("shop", "sortOrder"),
      fetchCollectionItems("item-db", "sortOrder"),
    ]);
    const itemDbMap = new Map(itemDbItems.map((item) => [item.id, item]));

    if (!shopItems.length) {
      shopGrid.innerHTML = '<article class="content-card full"><p class="muted">?ì  ì»¬ë ‰?˜ì— ?„ì´?œì´ ?†ìŠµ?ˆë‹¤.</p></article>';
      return;
    }

    shopGrid.innerHTML = shopItems
      .map(
        (item) => {
          const itemMeta = itemDbMap.get(item.id) || {};
          return `
          <article class="content-card shop-item-card">
            <div class="dot-slot large">${escapeHtml(itemMeta.icon || "?")}</div>
            <div class="content-meta">
              <h3>${escapeHtml(item.name || "?´ë¦„ ?†ìŒ")}</h3>
              <p>${escapeHtml(item.description || "?¤ëª… ?†ìŒ")}</p>
              <strong>${Number(item.price || 0)} G</strong>
            </div>
            <button type="button" class="primary-button compact-button" data-shop-purchase="${escapeHtml(item.id)}">êµ¬ë§¤</button>
          </article>
        `;
        }
      )
      .join("");

    shopGrid.querySelectorAll("[data-shop-purchase]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await withPendingToast(onToast, () => purchaseShopItem(button.dataset.shopPurchase));
          await onProfilePatched();
          onToast("?„ì´?œì„ êµ¬ë§¤?ˆìŠµ?ˆë‹¤.");
        } catch (error) {
          onToast(error.message, true);
        }
      });
    });
  } catch (_error) {
    shopGrid.innerHTML = '<article class="content-card full"><p class="muted">?ì  ?•ë³´ë¥?ë¶ˆëŸ¬?¤ì? ëª»í–ˆ?µë‹ˆ??</p></article>';
  }
}

async function hydrateItemDatabasePanel() {
  const grid = document.querySelector("#item-db-grid");
  if (!grid) return;

  try {
    const itemDbItems = await fetchCollectionItems("item-db", "sortOrder");

    if (!itemDbItems.length) {
      grid.innerHTML = '<article class="content-card full"><p class="muted">?„ì´??DB???±ë¡???„ì´?œì´ ?†ìŠµ?ˆë‹¤.</p></article>';
      return;
    }

    grid.innerHTML = itemDbItems
      .map(
        (item) => `
          <article class="content-card item-db-card">
            <div class="item-db-icon">${escapeHtml(item.icon || "?")}</div>
            <div class="content-meta">
              <h3>${escapeHtml(item.name || "?´ë¦„ ?†ìŒ")}</h3>
              <p>${escapeHtml(item.description || "?¤ëª… ?†ìŒ")}</p>
              <span class="pill-badge">${escapeHtml(item.category || "ê¸°í?")}</span>
            </div>
          </article>
        `
      )
      .join("");
  } catch (_error) {
    grid.innerHTML = '<article class="content-card full"><p class="muted">?„ì´??DBë¥?ë¶ˆëŸ¬?¤ì? ëª»í–ˆ?µë‹ˆ??</p></article>';
  }
}

async function hydrateBugReportPanel(profile, onToast) {
  const form = document.querySelector("#bug-report-form");
  if (form && !form.dataset.bound) {
    form.dataset.bound = "true";
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(form).entries());
      const title = String(payload.title || "").trim();
      const body = String(payload.body || "").trim();

      if (!title || !body) {
        return;
      }

      const reportId = buildReportLogId(new Date());
      await setDoc(doc(db, "report-logs", reportId), {
        uid: profile.uid,
        characterName: profile.characterName,
        title,
        body,
        createdAt: serverTimestamp(),
        createdAtText: new Date().toLocaleString("ko-KR"),
      });
      form.reset();
      onToast?.("ë²„ê·¸ ë¦¬í¬?¸ë? ?±ë¡?ˆìŠµ?ˆë‹¤.");
    });
  }

  if (adminRoles.includes(profile.role)) {
    await renderBugReports();
  }
}

async function renderBugReports() {
  const body = document.querySelector("#bug-report-body");
  const label = document.querySelector("#bug-report-page-label");
  if (!body || !label) return;

  try {
    const result = await listBugReports({
      page: bugReportPage,
      pageSize: 5,
    });

    label.textContent = `${result.page + 1} ?˜ì´ì§€`;
    if (!result.items.length) {
      body.innerHTML = '<tr><td colspan="4" class="table-empty">?‘ìˆ˜??ë²„ê·¸ ë¦¬í¬?¸ê? ?†ìŠµ?ˆë‹¤.</td></tr>';
    } else {
      body.innerHTML = result.items
        .map((item) => {
          const createdLabel = formatMaybeTimestamp(item.createdAt) || item.createdAtText || "-";
          return `<tr><td>${escapeHtml(createdLabel)}</td><td>${escapeHtml(item.characterName || "-")}</td><td>${escapeHtml(item.title || "-")}</td><td>${escapeHtml(item.body || "-")}</td></tr>`;
        })
        .join("");
    }

    const prevButton = document.querySelector('[data-report-page="prev"]');
    const nextButton = document.querySelector('[data-report-page="next"]');
    if (prevButton) {
      prevButton.disabled = bugReportPage === 0;
      prevButton.onclick = async () => {
        if (bugReportPage === 0) return;
        bugReportPage -= 1;
        await renderBugReports();
      };
    }
    if (nextButton) {
      nextButton.disabled = !result.hasNext;
      nextButton.onclick = async () => {
        if (!result.hasNext) return;
        bugReportPage += 1;
        await renderBugReports();
      };
    }
  } catch (_error) {
    body.innerHTML = '<tr><td colspan="4" class="table-empty">ë²„ê·¸ ë¦¬í¬?¸ë? ë¶ˆëŸ¬?¤ì? ëª»í–ˆ?µë‹ˆ??</td></tr>';
  }
}

async function hydrateAdminItemOptions() {
  const select = document.querySelector("#admin-item-select");
  if (!select) return;

  try {
    const items = await fetchCollectionItems("item-db", "sortOrder");
    select.innerHTML = `
      <option value="">?„ì´?œì„ ? íƒ?˜ì„¸??/option>
      ${items
        .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.icon || "?")} ${escapeHtml(item.name || item.id)}</option>`)
        .join("")}
    `;
  } catch (_error) {
    select.innerHTML = '<option value="">?„ì´?œì„ ë¶ˆëŸ¬?¤ì? ëª»í–ˆ?µë‹ˆ??/option>';
  }
}

function renderAdminItemQueue() {
  const queue = document.querySelector("#admin-item-queue");
  const select = document.querySelector("#admin-item-select");
  if (!queue) return;

  if (!pendingAdminItemIds.length) {
    queue.innerHTML = '<span class="muted">? íƒ???„ì´?œì´ ?†ìŠµ?ˆë‹¤.</span>';
    return;
  }

  const optionMap = new Map(
    Array.from(select?.options || [])
      .filter((option) => option.value)
      .map((option) => [option.value, option.textContent || option.value])
  );

  const countedItems = Array.from(
    pendingAdminItemIds.reduce((map, itemId) => {
      map.set(itemId, (map.get(itemId) || 0) + 1);
      return map;
    }, new Map())
  );

  queue.innerHTML = countedItems
    .map(
      ([itemId, count]) => `
        <button type="button" class="ghost-button compact-button admin-item-chip" data-remove-admin-item="${escapeHtml(itemId)}">
          ${escapeHtml(optionMap.get(itemId) || itemId)}${count > 1 ? ` x${count}` : ""} Ã—
        </button>
      `
    )
    .join("");

  queue.querySelectorAll("[data-remove-admin-item]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = pendingAdminItemIds.findIndex((itemId) => itemId === button.dataset.removeAdminItem);
      if (index !== -1) {
        pendingAdminItemIds.splice(index, 1);
      }
      renderAdminItemQueue();
    });
  });
}

function renderProfileQuickButton({ profile, onProfilePatched, onToast }) {
  const headerActions = document.querySelector(".header-actions");
  if (!headerActions) return;

  let button = document.querySelector("#profile-quick-button");
  if (!button) {
    button = document.createElement("button");
    button.id = "profile-quick-button";
    button.type = "button";
    button.className = "ghost-button";
    button.textContent = "ê°„ë‹¨ ?„ë¡œ??ë³´ê¸°";
    headerActions.prepend(button);
  }

  button.onclick = async () => {
    await showProfileQuickModal({ profile, onProfilePatched, onToast });
  };
}

async function showProfileQuickModal({ profile, onProfilePatched, onToast }) {
  const modal = ensureProfileQuickModal();
  const content = modal.querySelector("#profile-quick-card");
  const fileInput = modal.querySelector("#profile-seal-input");
  const sealButton = modal.querySelector("#profile-seal-button");
  const closeButton = modal.querySelector("#profile-quick-close");
  const closeIcon = modal.querySelector("#profile-quick-close-icon");
  if (!content || !fileInput || !sealButton || !closeButton || !closeIcon) return;

  modal.classList.remove("hidden");
  content.innerHTML = '<div class="panel empty-state">°£´Ü ÇÁ·ÎÇÊÀ» ºÒ·¯¿À´Â ÁßÀÔ´Ï´Ù.</div>';

  const [rankings, traits] = await Promise.all([
    getCachedRankingBoard().catch(() => []),
    getCachedTraits().catch(() => []),
  ]);
  const normalizedRankings = buildDisplayRankings(rankings);
  const rankEntry = normalizedRankings.find(
    (item) =>
      item.uid === profile.uid ||
      item.characterName === profile.characterName ||
      item.nickname === profile.nickname
  );
  const selectedTraitIds = Array.isArray(profile.selectedTraitIds) ? profile.selectedTraitIds : [];
  const traitMap = new Map(traits.map((item) => [item.id, item.name || item.id]));
  const traitNames = selectedTraitIds.map((traitId) => traitMap.get(traitId) || traitId).filter(Boolean);
  const usedTraitPoints = traits
    .filter((item) => selectedTraitIds.includes(item.id))
    .reduce((sum, item) => sum + Number(item.requiredPoints || 0), 0);
  const totalTraitPoints = Number(profile.availableTraitPoints || 0) + usedTraitPoints;

  content.innerHTML = `
    <div class="profile-lobby-card">
      <div class="profile-lobby-visual">
        <div class="profile-seal-panel">
          ${
            profile.profileSealImage
              ? `<img src="${escapeHtml(profile.profileSealImage)}" alt="?„ë¡œ???¸ì¥" class="profile-seal-art" />`
              : `<div class="profile-seal-fallback">?¸ì¥</div>`
          }
        </div>
      </div>
      <div class="profile-lobby-meta">
        <p class="eyebrow">PLAYER LOBBY</p>
        <h2>${escapeHtml(profile.characterName || "-")}</h2>
        <div class="profile-lobby-grid">
          <div><span>?‘í˜¼ ?‰ë„¤??/span><strong>${escapeHtml(profile.nickname || "-")}</strong></div>
          <div><span>?„ì¬ ??‚¹ ?œìœ„</span><strong>${rankEntry?.displayRank ? `${rankEntry.displayRank}?? : "-"}</strong></div>
          <div><span>??‚¹???¬ì¸??/span><strong>${Number(profile.rankingPoints || 0)}</strong></div>
          <div><span>ì´??€êµ???/span><strong>${Number(profile.totalMatches || 0)}</strong></div>
          <div><span>ë³´ìœ  ?¬í™”</span><strong>${Number(profile.currency || 0)} G</strong></div>
          <div><span>ì´??¤íƒ¯ ?¬ì¸??/span><strong>${totalTraitPoints}</strong></div>
        </div>
        <div class="profile-lobby-traits">
          <span>ë³´ìœ  ?¹ì„±ì¹?ì¢…ë¥˜</span>
          <strong>${escapeHtml(traitNames.length ? traitNames.join(", ") : "?†ìŒ")}</strong>
        </div>
      </div>
      <div class="profile-lobby-stripes" aria-hidden="true">
        <span></span><span></span><span></span>
      </div>
    </div>
  `;

  sealButton.onclick = () => fileInput.click();
  fileInput.onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const optimizedDataUrl = await openProfileSealCropModal(file);
      const updatedProfile = await updateProfileSealImage(optimizedDataUrl);
      invalidateQuickProfileCaches();
      await onProfilePatched(updatedProfile);
      onToast("?„ë¡œ???¸ì¥???€?¥í–ˆ?µë‹ˆ??");
      await showProfileQuickModal({ profile: updatedProfile, onProfilePatched, onToast });
    } catch (error) {
      if (error.message !== "?´ë?ì§€ ? íƒ??ì·¨ì†Œ?˜ì—ˆ?µë‹ˆ??") {
        onToast(error.message, true);
      }
    } finally {
      fileInput.value = "";
    }
  };

  const close = () => modal.classList.add("hidden");
  closeButton.onclick = close;
  closeIcon.onclick = close;
}

function ensureProfileQuickModal() {
  let modal = document.querySelector("#profile-quick-modal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "profile-quick-modal";
  modal.className = "modal-backdrop hidden";
  modal.innerHTML = `
    <div class="modal-panel profile-quick-modal-panel">
      <div class="modal-head">
        <div>
          <p class="eyebrow">PLAYER LOBBY</p>
          <h2>ê°„ë‹¨ ?„ë¡œ??/h2>
        </div>
        <button id="profile-quick-close-icon" type="button" class="icon-button">x</button>
      </div>
      <div id="profile-quick-card"></div>
      <div class="profile-quick-actions">
        <input id="profile-seal-input" type="file" accept="image/*" class="hidden" />
        <button id="profile-seal-button" type="button" class="ghost-button">?„ë¡œ???¸ì¥ ?˜ì •</button>
        <button id="profile-quick-close" type="button" class="primary-button">?«ê¸°</button>
      </div>
    </div>
  `;

  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      modal.classList.add("hidden");
    }
  });

  document.body.append(modal);
  return modal;
}

async function openProfileSealCropModal(file) {
  const image = await loadImageFromFile(file);
  const modal = ensureProfileSealCropModal();
  const canvas = modal.querySelector("#profile-seal-crop-canvas");
  const zoomInput = modal.querySelector("#profile-seal-crop-zoom");
  const offsetXInput = modal.querySelector("#profile-seal-crop-offset-x");
  const offsetYInput = modal.querySelector("#profile-seal-crop-offset-y");
  const confirmButton = modal.querySelector("#profile-seal-crop-confirm");
  const cancelButton = modal.querySelector("#profile-seal-crop-cancel");
  const closeIcon = modal.querySelector("#profile-seal-crop-close-icon");
  if (!canvas || !zoomInput || !offsetXInput || !offsetYInput || !confirmButton || !cancelButton || !closeIcon) {
    throw new Error("?ë¥´ê¸??„êµ¬ë¥?ì¤€ë¹„í•˜ì§€ ëª»í–ˆ?µë‹ˆ??");
  }

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("?´ë?ì§€ ?ë¥´ê¸°ë? ?œì‘?˜ì? ëª»í–ˆ?µë‹ˆ??");
  }

  let zoom = 1;
  let offsetX = 0;
  let offsetY = 0;
  const canvasSize = 260;
  canvas.width = canvasSize;
  canvas.height = canvasSize;

  const redraw = () => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#0d285a";
    context.fillRect(0, 0, canvas.width, canvas.height);

    const cropBase = Math.min(image.width, image.height);
    const cropSize = cropBase / zoom;
    const availableX = Math.max(0, image.width - cropSize);
    const availableY = Math.max(0, image.height - cropSize);
    const sourceX = availableX * ((Number(offsetX) + 100) / 200);
    const sourceY = availableY * ((Number(offsetY) + 100) / 200);
    context.drawImage(image, sourceX, sourceY, cropSize, cropSize, 0, 0, canvas.width, canvas.height);
  };

  zoomInput.value = "100";
  offsetXInput.value = "0";
  offsetYInput.value = "0";
  redraw();
  modal.classList.remove("hidden");

  return await new Promise((resolve, reject) => {
    const close = () => modal.classList.add("hidden");
    const cleanup = () => {
      zoomInput.oninput = null;
      offsetXInput.oninput = null;
      offsetYInput.oninput = null;
      confirmButton.onclick = null;
      cancelButton.onclick = null;
      closeIcon.onclick = null;
    };

    zoomInput.oninput = () => {
      zoom = Math.max(1, Number(zoomInput.value || 100) / 100);
      redraw();
    };
    offsetXInput.oninput = () => {
      offsetX = Number(offsetXInput.value || 0);
      redraw();
    };
    offsetYInput.oninput = () => {
      offsetY = Number(offsetYInput.value || 0);
      redraw();
    };

    confirmButton.onclick = async () => {
      try {
        const dataUrl = await compressCanvas(canvas, 240);
        cleanup();
        close();
        resolve(dataUrl);
      } catch (error) {
        cleanup();
        close();
        reject(error);
      }
    };

    const cancel = () => {
      cleanup();
      close();
      reject(new Error("?´ë?ì§€ ? íƒ??ì·¨ì†Œ?˜ì—ˆ?µë‹ˆ??"));
    };

    cancelButton.onclick = cancel;
    closeIcon.onclick = cancel;
  });
}

function ensureProfileSealCropModal() {
  let modal = document.querySelector("#profile-seal-crop-modal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "profile-seal-crop-modal";
  modal.className = "modal-backdrop hidden";
  modal.innerHTML = `
    <div class="modal-panel profile-seal-crop-panel">
      <div class="modal-head">
        <div>
          <p class="eyebrow">SEAL CROP</p>
          <h2>?¸ì¥ ?´ë?ì§€ ?ë¥´ê¸?/h2>
        </div>
        <button id="profile-seal-crop-close-icon" type="button" class="icon-button">x</button>
      </div>
      <div class="profile-seal-crop-layout">
        <canvas id="profile-seal-crop-canvas" class="profile-seal-crop-canvas"></canvas>
        <div class="stack-form compact-form">
          <label><span>?•ë?</span><input id="profile-seal-crop-zoom" type="range" min="100" max="220" value="100" /></label>
          <label><span>ê°€ë¡??´ë™</span><input id="profile-seal-crop-offset-x" type="range" min="-100" max="100" value="0" /></label>
          <label><span>?¸ë¡œ ?´ë™</span><input id="profile-seal-crop-offset-y" type="range" min="-100" max="100" value="0" /></label>
        </div>
      </div>
      <div class="profile-quick-actions">
        <button id="profile-seal-crop-cancel" type="button" class="ghost-button">ì·¨ì†Œ</button>
        <button id="profile-seal-crop-confirm" type="button" class="primary-button">?ìš©</button>
      </div>
    </div>
  `;
  document.body.append(modal);
  return modal;
}

function attachTodoEvents({ profile, onToast }) {
  const form = document.querySelector("#todo-form");
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(form).entries());
    const todoText = String(payload.todoText || "").trim();

    if (!todoText) {
      onToast("ë©”ëª¨ ?´ìš©???…ë ¥??ì£¼ì„¸??", true);
      return;
    }

    try {
      await withPendingToast(onToast, () =>
        addDoc(collection(db, "todos"), {
          uid: profile.uid,
          characterName: profile.characterName,
          text: todoText,
          createdAt: serverTimestamp(),
        })
      );
      form.reset();
      await hydrateTodoPanel(profile.uid);
      onToast("???¼ì„ ì¶”ê??ˆìŠµ?ˆë‹¤.");
    } catch (error) {
      onToast(error.message || "???¼ì„ ì¶”ê??˜ì? ëª»í–ˆ?µë‹ˆ??", true);
    }
  });
}

async function hydrateTodoPanel(uid) {
  const list = document.querySelector("#todo-list");
  const pager = document.querySelector("#todo-pager");
  if (!list || !pager) return;

  try {
    const todoQuery = query(collection(db, "todos"), limit(50));
    const snapshot = await getDocs(todoQuery);
    const items = snapshot.docs
      .map((item) => ({ id: item.id, ...item.data() }))
      .sort((left, right) => getSortTime(right.createdAt) - getSortTime(left.createdAt));
    const pageSize = 5;
    const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
    todoPage = Math.min(todoPage, pageCount - 1);

    if (!items.length) {
      list.innerHTML = '<p class="muted">?±ë¡?????¼ì´ ?†ìŠµ?ˆë‹¤.</p>';
      pager.innerHTML = "";
      pager.classList.add("hidden");
      return;
    }

    const pageItems = items.slice(todoPage * pageSize, todoPage * pageSize + pageSize);

    list.innerHTML = pageItems
      .map(
        (item) => `
          <article class="info-card">
            <div class="info-card-head">
              <strong>${escapeHtml(item.text || "")}</strong>
              ${
                item.uid === uid
                  ? `<button type="button" class="ghost-button compact-button todo-delete-button" data-todo-delete="${item.id}">?? œ</button>`
                  : ""
              }
            </div>
            <p class="muted">${escapeHtml(item.characterName || "?µëª…")}</p>
          </article>
        `
      )
      .join("");

    pager.innerHTML = `
      <button type="button" class="ghost-button compact-button" data-todo-page="prev" ${todoPage === 0 ? "disabled" : ""}>?´ì „</button>
      <span class="muted">${todoPage + 1} / ${pageCount}</span>
      <button type="button" class="ghost-button compact-button" data-todo-page="next" ${todoPage >= pageCount - 1 ? "disabled" : ""}>?¤ìŒ</button>
    `;
    pager.classList.toggle("hidden", pageCount <= 1);

    list.querySelectorAll("[data-todo-delete]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await deleteDoc(doc(db, "todos", button.dataset.todoDelete));
          await hydrateTodoPanel(uid);
        } catch (_error) {
          list.insertAdjacentHTML(
            "afterbegin",
            '<p class="muted">???¼ì„ ?? œ?˜ì? ëª»í–ˆ?µë‹ˆ??</p>'
          );
        }
      });
    });

    pager.querySelectorAll("[data-todo-page]").forEach((button) => {
      button.addEventListener("click", async () => {
        if (button.dataset.todoPage === "prev" && todoPage > 0) {
          todoPage -= 1;
        }
        if (button.dataset.todoPage === "next" && todoPage < pageCount - 1) {
          todoPage += 1;
        }
        await hydrateTodoPanel(uid);
      });
    });
  } catch (_error) {
    list.innerHTML = '<p class="muted">????ëª©ë¡??ë¶ˆëŸ¬?¤ì? ëª»í–ˆ?µë‹ˆ??</p>';
    pager.innerHTML = "";
    pager.classList.add("hidden");
  }
}

async function hydrateRankingPanel() {
  const body = document.querySelector("#ranking-table-body");
  if (!body) return;

  try {
    const rankings = buildDisplayRankings(await getRankingBoard());

    if (!rankings.length) {
      body.innerHTML = '<tr><td colspan="6" class="table-empty">?œì‹œ????‚¹???†ìŠµ?ˆë‹¤.</td></tr>';
      return;
    }

    body.innerHTML = rankings
      .map((item) => {
        return `
          <tr>
            <td>${item.displayRank}</td>
            <td>${escapeHtml(item.characterName || "-")}</td>
            <td>${escapeHtml(item.nickname || "-")}</td>
            <td>${Number(item.rankingPoints || 0)}</td>
            <td>${Number(item.currency || 0)} G</td>
            <td>${Number(item.totalTraitPoints || 0)}</td>
          </tr>
        `;
      })
      .join("");
  } catch (_error) {
    body.innerHTML = '<tr><td colspan="6" class="table-empty">??‚¹??ë¶ˆëŸ¬?¤ì? ëª»í–ˆ?µë‹ˆ??</td></tr>';
  }
}

function attachParcelForm({ profile, onProfilePatched, onToast }) {
  const form = document.querySelector("#parcel-form");
  const dropZone = document.querySelector("#parcel-drop-zone");
  const selectedItem = document.querySelector("#parcel-selected-item");
  const clearButton = document.querySelector("#parcel-clear-button");
  if (!form) return;

  const inventoryItems = Array.isArray(profile.inventory) ? profile.inventory : [];

  const renderSelectedParcelItem = () => {
    if (!selectedItem || !dropZone) return;
    const selectedItems = selectedParcelItemKeys
      .map((itemKey) => inventoryItems.find((item) => buildInventoryItemKey(item) === itemKey))
      .filter(Boolean);
    if (!selectedItems.length) {
      selectedItem.textContent = "? íƒ???„ì´?œì´ ?†ìŠµ?ˆë‹¤.";
      selectedItem.classList.add("muted");
      return;
    }
    const countedItems = Array.from(
      selectedItems.reduce((map, item) => {
        const label = `${item.icon || "?"} ${item.name || "?„ì´??}`;
        map.set(label, (map.get(label) || 0) + 1);
        return map;
      }, new Map())
    );
    selectedItem.innerHTML = countedItems
      .map(([label, count]) => `<span class="parcel-selected-chip">${escapeHtml(label)}${count > 1 ? ` x${count}` : ""}</span>`)
      .join("");
    selectedItem.classList.remove("muted");
  };

  const appendSelectedParcelItem = (itemKey) => {
    if (!itemKey) return;
    if (selectedParcelItemKeys.includes(itemKey)) return;
    selectedParcelItemKeys.push(itemKey);
    renderSelectedParcelItem();
  };

  document.querySelectorAll("[data-inventory-item-key]").forEach((item) => {
    item.addEventListener("dragstart", (event) => {
      const itemKey = item.dataset.inventoryItemKey || "";
      const iconNode = item.querySelector(".dot-slot");
      event.dataTransfer?.setData("text/plain", itemKey);
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "copy";
      }
      item.classList.add("is-dragging");
      if (iconNode instanceof HTMLElement && event.dataTransfer) {
        const ghost = iconNode.cloneNode(true);
        ghost.classList.add("inventory-drag-ghost");
        document.body.appendChild(ghost);
        event.dataTransfer.setDragImage(
          ghost,
          Math.round(ghost.offsetWidth / 2),
          Math.round(ghost.offsetHeight / 2)
        );
        window.setTimeout(() => ghost.remove(), 0);
      }
    });
    item.addEventListener("dragend", () => {
      item.classList.remove("is-dragging");
    });
    item.addEventListener("click", () => {
      appendSelectedParcelItem(item.dataset.inventoryItemKey || "");
    });
  });

  dropZone?.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("is-drag-over");
  });
  dropZone?.addEventListener("dragleave", () => {
    dropZone.classList.remove("is-drag-over");
  });
  dropZone?.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-drag-over");
    appendSelectedParcelItem(event.dataTransfer?.getData("text/plain") || "");
  });

  clearButton?.addEventListener("click", () => {
    selectedParcelItemKeys = [];
    renderSelectedParcelItem();
  });

  renderSelectedParcelItem();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(form).entries());

    try {
      await withPendingToast(onToast, () =>
        sendParcel({
          targetCharacterName: payload.targetCharacterName,
          itemKeys: selectedParcelItemKeys,
          currencyAmount: Number(payload.currencyAmount || 0),
          useWrapping: payload.useWrapping === "on",
        })
      );
      form.reset();
      selectedParcelItemKeys = [];
      renderSelectedParcelItem();
      await onProfilePatched();
      onToast(`${profile.characterName}???Œí¬ë¥?ë³´ëƒˆ?µë‹ˆ??`);
    } catch (error) {
      onToast(error.message, true);
    }
  });
}

async function hydrateNotificationPanel({ profile, onProfilePatched, onToast }) {
  await Promise.all([
    renderAnnouncements({ profile, onProfilePatched, onToast }),
    renderNotifications({ profile, onToast }),
    renderIncomingParcels({ profile, onProfilePatched, onToast }),
    renderOutgoingParcels({ profile }),
  ]);
}

async function renderAnnouncements({ profile, onProfilePatched, onToast }) {
  const list = document.querySelector("#announcement-list");
  if (!list) return;

  try {
    const announcements = await fetchActiveAnnouncements();
    const dismissedIds = new Set(profile.dismissedAnnouncementIds || []);
    const visibleAnnouncements = announcements.filter((item) => !dismissedIds.has(item.id));

    if (!visibleAnnouncements.length) {
      list.innerHTML = '<p class="muted">?•ì¸??ê³µì?ê°€ ?†ìŠµ?ˆë‹¤.</p>';
      return;
    }

    list.innerHTML = visibleAnnouncements
      .map(
        (announcement) => `
          <article class="info-card">
            <div class="info-card-head">
              <strong>${escapeHtml(announcement.title || "ê³µì?")}</strong>
              <button type="button" class="ghost-button compact-button" data-dismiss-announcement="${announcement.id}">?«ê¸°</button>
            </div>
            <p>${escapeHtml(announcement.body || "")}</p>
          </article>
        `
      )
      .join("");

    list.querySelectorAll("[data-dismiss-announcement]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          const updatedProfile = await withPendingToast(onToast, () =>
            dismissAnnouncement(button.dataset.dismissAnnouncement)
          );
          await onProfilePatched(updatedProfile);
          await renderAnnouncements({ profile: updatedProfile, onProfilePatched, onToast });
          await hydrateNotificationBadge(updatedProfile);
          onToast("ê³µì?ë¥??«ì•˜?µë‹ˆ??");
        } catch (error) {
          onToast(error.message, true);
        }
      });
    });
  } catch (_error) {
    list.innerHTML = '<p class="muted">ê³µì?ë¥?ë¶ˆëŸ¬?¤ì? ëª»í–ˆ?µë‹ˆ??</p>';
  }
}

async function renderNotifications({ profile, onToast }) {
  const list = document.querySelector("#notification-list");
  if (!list) return;

  try {
    const notifications = await fetchNotifications(profile.uid, 10);

    if (!notifications.length) {
      list.innerHTML = '<p class="muted">???Œë¦¼???†ìŠµ?ˆë‹¤.</p>';
      return;
    }

    list.innerHTML = notifications
      .map(
        (item) => `
          <article class="info-card ${item.isRead ? "is-read" : "is-unread"}">
            <div class="info-card-head">
              <strong>${escapeHtml(item.message || "?Œë¦¼")}</strong>
              ${
                item.isRead
                  ? '<span class="pill-badge">?½ìŒ</span>'
                  : `<button type="button" class="ghost-button compact-button" data-read-notification="${item.id}">?½ìŒ ì²˜ë¦¬</button>`
              }
            </div>
          </article>
        `
      )
      .join("");

    list.querySelectorAll("[data-read-notification]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await withPendingToast(onToast, () =>
            markNotificationRead(button.dataset.readNotification)
          );
          await renderNotifications({ profile, onToast });
          await hydrateNotificationBadge(profile);
          onToast("?Œë¦¼???½ìŒ ì²˜ë¦¬?ˆìŠµ?ˆë‹¤.");
        } catch (error) {
          onToast(error.message, true);
        }
      });
    });
  } catch (_error) {
    list.innerHTML = '<p class="muted">?Œë¦¼??ë¶ˆëŸ¬?¤ì? ëª»í–ˆ?µë‹ˆ??</p>';
  }
}

async function hydrateNotificationBadge(profile) {
  const menuBadge = document.querySelector("#notification-count-badge");
  const bellBadge = document.querySelector("#header-notification-badge");

  try {
    const [announcements, notifications, parcels] = await Promise.all([
      fetchActiveAnnouncements(),
      fetchNotifications(profile.uid, 20),
      fetchPendingParcels(profile.uid, 20),
    ]);
    const dismissedIds = new Set(profile.dismissedAnnouncementIds || []);
    const unseenAnnouncements = announcements.filter((item) => !dismissedIds.has(item.id)).length;
    const unreadNotifications = notifications.filter((item) => !item.isRead).length;
    const total = unseenAnnouncements + unreadNotifications + parcels.length;

    [menuBadge, bellBadge].forEach((badge) => {
      if (!badge) return;
      badge.textContent = String(total);
      badge.classList.toggle("hidden", total === 0);
    });
  } catch (_error) {
    [menuBadge, bellBadge].forEach((badge) => {
      if (badge) badge.classList.add("hidden");
    });
  }
}

function renderNotificationBell({ profile, onProfilePatched, onToast }) {
  const headerActions = document.querySelector(".header-actions");
  if (!headerActions) return;

  let wrap = document.querySelector("#header-notification-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "header-notification-wrap";
    wrap.className = "notification-bell-wrap";
    wrap.innerHTML = `
      <button id="header-notification-button" type="button" class="notification-bell-button" aria-label="?Œë¦¼ ?´ê¸°">
        <span class="notification-bell-icon">?””</span>
        <span id="header-notification-badge" class="notification-bell-badge hidden">0</span>
      </button>
      <div id="header-notification-panel" class="notification-panel hidden">
        <div id="header-notification-list" class="stack-list">
          <p class="muted">?Œë¦¼??ë¶ˆëŸ¬?¤ëŠ” ì¤‘ì…?ˆë‹¤.</p>
        </div>
      </div>
    `;
    headerActions.prepend(wrap);
  }

  const button = document.querySelector("#header-notification-button");
  const panel = document.querySelector("#header-notification-panel");
  if (!button || !panel) return;

  button.onclick = async () => {
    const shouldOpen = panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !shouldOpen);

    if (shouldOpen) {
      const latestProfile = await refreshCurrentUserProfile().catch(() => profile);
      await markVisibleNotificationsRead(latestProfile);
      await hydrateNotificationBadge(latestProfile);
      notificationPanelPage = 0;
      await renderNotificationBellPanel({ profile: latestProfile, onProfilePatched, onToast });
    }
  };
}

async function renderNotificationBellPanel({ profile, onProfilePatched, onToast }) {
  const list = document.querySelector("#header-notification-list");
  if (!list) return;

  try {
    const [announcements, notifications, parcels] = await Promise.all([
      fetchActiveAnnouncements(20),
      fetchNotifications(profile.uid, 20),
      fetchPendingParcels(profile.uid, 20),
    ]);
    const dismissedIds = new Set(profile.dismissedAnnouncementIds || []);
    const hasRejectTicket = Array.isArray(profile.inventory)
      ? profile.inventory.some((item) => item?.name === "ê±°ì ˆê¶?)
      : false;

    const announcementCards = announcements
      .filter((item) => !dismissedIds.has(item.id))
      .map((item) => ({
        id: `announcement-${item.id}`,
        createdAt: getSortTime(item.createdAt),
        html: `
          <article class="info-card compact-info">
            <div class="info-card-head">
              <strong>${escapeHtml(item.title || "ê³µì?")}</strong>
              <button type="button" class="ghost-button compact-button" data-dismiss-announcement="${item.id}">?«ê¸°</button>
            </div>
            <p>${escapeHtml(item.body || "")}</p>
          </article>
        `,
      }));

    const notificationCards = notifications.map((item) => ({
      id: `notification-${item.id}`,
      createdAt: getSortTime(item.createdAt),
      html: `
          <article class="info-card compact-info ${item.isRead ? "is-read" : "is-unread"}">
            <div class="info-card-head">
              <strong>${escapeHtml(item.message || "?Œë¦¼")}</strong>
            </div>
          </article>
        `,
    }));

    const parcelCards = parcels.map((item) => {
        const itemPreview = item.wrapped
          ? "?´ìš©ë¬¼ì„ ?•ì¸?????†ëŠ” ?¬ì¥ ?Œí¬?…ë‹ˆ??"
          : buildParcelDisplayText(item);
        const rejectControl = item.wrapped
          ? hasRejectTicket
            ? `<button type="button" class="ghost-button compact-button" data-parcel-action="reject" data-parcel-id="${item.id}">ê±°ì ˆ</button>`
            : '<span class="pill-badge">ê±°ì ˆê¶??„ìš”</span>'
          : `<button type="button" class="ghost-button compact-button" data-parcel-action="reject" data-parcel-id="${item.id}">ê±°ì ˆ</button>`;
        return {
          id: `parcel-${item.id}`,
          createdAt: getSortTime(item.createdAt),
          html: `
          <article class="info-card compact-info ${item.wrapped ? "is-unread" : ""}">
            <div class="info-card-head">
              <strong>${escapeHtml(item.senderCharacterName || "?Œí¬")}</strong>
              <span class="pill-badge">${item.wrapped ? "?¬ì¥ ?Œí¬" : "?¼ë°˜ ?Œí¬"}</span>
            </div>
            <p>${escapeHtml(itemPreview)}</p>
            <div class="action-row">
              <button type="button" class="primary-button compact-button" data-parcel-action="accept" data-parcel-id="${item.id}">?˜ë½</button>
              ${rejectControl}
            </div>
          </article>
          `,
        };
      });

    const allCards = [...announcementCards, ...parcelCards, ...notificationCards].sort(
      (left, right) => right.createdAt - left.createdAt
    );
    const pageSize = 5;
    const pageCount = Math.max(1, Math.ceil(allCards.length / pageSize));
    notificationPanelPage = Math.min(notificationPanelPage, pageCount - 1);
    const pageItems = allCards.slice(
      notificationPanelPage * pageSize,
      notificationPanelPage * pageSize + pageSize
    );

    list.innerHTML = allCards.length
      ? `
          <div class="notification-page-list">
            ${pageItems.map((item) => item.html).join("")}
          </div>
          <div class="notification-pager ${pageCount > 1 ? "" : "hidden"}">
            <button type="button" class="ghost-button compact-button" data-notification-page="prev" ${notificationPanelPage === 0 ? "disabled" : ""}>?´ì „</button>
            <span class="muted">${notificationPanelPage + 1} / ${pageCount}</span>
            <button type="button" class="ghost-button compact-button" data-notification-page="next" ${notificationPanelPage >= pageCount - 1 ? "disabled" : ""}>?¤ìŒ</button>
          </div>
        `
      : '<p class="muted">???Œë¦¼???†ìŠµ?ˆë‹¤.</p>';

    list.querySelectorAll("[data-dismiss-announcement]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          const updatedProfile = await withPendingToast(onToast, () =>
            dismissAnnouncement(button.dataset.dismissAnnouncement)
          );
          await onProfilePatched(updatedProfile);
          await hydrateNotificationBadge(updatedProfile);
          await renderNotificationBellPanel({ profile: updatedProfile, onProfilePatched, onToast });
        } catch (error) {
          onToast(error.message, true);
        }
      });
    });

    list.querySelectorAll("[data-parcel-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await withPendingToast(onToast, () =>
            respondParcel(button.dataset.parcelId, button.dataset.parcelAction)
          );
          const latestProfile = await refreshCurrentUserProfile().catch(() => profile);
          await onProfilePatched(latestProfile);
          await hydrateNotificationBadge(latestProfile);
          await renderNotificationBellPanel({ profile: latestProfile, onProfilePatched, onToast });
          onToast("?Œí¬ ?íƒœë¥?ì²˜ë¦¬?ˆìŠµ?ˆë‹¤.");
        } catch (error) {
          onToast(error.message, true);
        }
      });
    });

    list.querySelectorAll("[data-notification-page]").forEach((button) => {
      button.addEventListener("click", async () => {
        const direction = button.dataset.notificationPage;
        if (direction === "prev" && notificationPanelPage > 0) {
          notificationPanelPage -= 1;
        }
        if (direction === "next" && notificationPanelPage < pageCount - 1) {
          notificationPanelPage += 1;
        }
        await renderNotificationBellPanel({ profile, onProfilePatched, onToast });
      });
    });
  } catch (_error) {
    list.innerHTML = '<p class="muted">?Œë¦¼??ë¶ˆëŸ¬?¤ì? ëª»í–ˆ?µë‹ˆ??</p>';
  }
}

async function renderIncomingParcels({ profile, onProfilePatched, onToast }) {
  const list = document.querySelector("#incoming-parcels");
  if (!list) return;

  try {
    const parcelQuery = query(
      collection(db, "parcels"),
      where("receiverUid", "==", profile.uid),
      orderBy("createdAt", "desc"),
      limit(8)
    );
    const snapshot = await getDocs(parcelQuery);

    if (snapshot.empty) {
      list.innerHTML = '<p class="muted">ë°›ì? ?Œí¬ê°€ ?†ìŠµ?ˆë‹¤.</p>';
      return;
    }

    list.innerHTML = snapshot.docs
      .map((parcelDoc) => {
        const data = parcelDoc.data();
        const itemLabel = escapeHtml(buildParcelDisplayText(data));
        const currencyLabel = Number(data.currencyAmount || 0)
          ? `?¬í™” ${Number(data.currencyAmount || 0)} G`
          : "?¬í™” ?†ìŒ";
        return `
          <article class="info-card">
            <div class="info-card-head">
              <strong>${escapeHtml(data.senderCharacterName || "-")}</strong>
              <span class="pill-badge">${escapeHtml(data.status || "-")}</span>
            </div>
            <p>${itemLabel}${Number(data.currencyAmount || 0) ? ` / ${currencyLabel}` : ""}</p>
            <p>${data.wrapped ? "?¬ì¥ ?Œí¬" : "?¼ë°˜ ?Œí¬"}</p>
            ${
              data.status === "pending"
                ? `
                  <div class="action-row">
                    <button type="button" class="primary-button compact-button" data-parcel-action="accept" data-parcel-id="${parcelDoc.id}">?˜ë ¹</button>
                    ${
                      data.wrapped
                        ? ""
                        : `<button type="button" class="ghost-button compact-button" data-parcel-action="reject" data-parcel-id="${parcelDoc.id}">ê±°ì ˆ</button>`
                    }
                  </div>
                `
                : ""
            }
          </article>
        `;
      })
      .join("");

    list.querySelectorAll("[data-parcel-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await withPendingToast(onToast, () =>
            respondParcel(button.dataset.parcelId, button.dataset.parcelAction)
          );
          await onProfilePatched();
          onToast("?Œí¬ ?íƒœë¥?ì²˜ë¦¬?ˆìŠµ?ˆë‹¤.");
        } catch (error) {
          onToast(error.message, true);
        }
      });
    });
  } catch (_error) {
    list.innerHTML = '<p class="muted">ë°›ì? ?Œí¬ë¥?ë¶ˆëŸ¬?¤ì? ëª»í–ˆ?µë‹ˆ??</p>';
  }
}

async function renderOutgoingParcels({ profile }) {
  const list = document.querySelector("#outgoing-parcels");
  if (!list) return;

  try {
    const parcelQuery = query(
      collection(db, "parcels"),
      where("senderUid", "==", profile.uid),
      orderBy("createdAt", "desc"),
      limit(8)
    );
    const snapshot = await getDocs(parcelQuery);

    if (snapshot.empty) {
      list.innerHTML = '<p class="muted">ë³´ë‚¸ ?Œí¬ê°€ ?†ìŠµ?ˆë‹¤.</p>';
      return;
    }

    list.innerHTML = snapshot.docs
      .map((parcelDoc) => {
        const data = parcelDoc.data();
        const itemLabel = escapeHtml(buildParcelDisplayText(data));
        const currencyLabel = Number(data.currencyAmount || 0)
          ? `?¬í™” ${Number(data.currencyAmount || 0)} G`
          : "?¬í™” ?†ìŒ";
        return `
          <article class="info-card">
            <div class="info-card-head">
              <strong>${escapeHtml(data.receiverCharacterName || "-")}</strong>
              <span class="pill-badge">${escapeHtml(data.status || "-")}</span>
            </div>
            <p>${itemLabel}${Number(data.currencyAmount || 0) ? ` / ${currencyLabel}` : ""}</p>
            <p>${data.wrapped ? "?¬ì¥ ?Œí¬" : "?¼ë°˜ ?Œí¬"}</p>
          </article>
        `;
      })
      .join("");
  } catch (_error) {
    list.innerHTML = '<p class="muted">ë³´ë‚¸ ?Œí¬ë¥?ë¶ˆëŸ¬?¤ì? ëª»í–ˆ?µë‹ˆ??</p>';
  }
}

async function hydrateTraitPanel({ profile, onProfilePatched, onToast }) {
  const traitTableBody = document.querySelector("#trait-table-body");
  if (!traitTableBody) return;

  try {
    const traitItems = await fetchCollectionItems("traits", "sortOrder");

    if (!traitItems.length) {
      traitTableBody.innerHTML = '<tr><td colspan="6" class="table-empty">traits ì»¬ë ‰?˜ì— ?¹ì„±ì¹˜ê? ?†ìŠµ?ˆë‹¤.</td></tr>';
      return;
    }

    const selectedTraitIds = new Set(profile.selectedTraitIds || []);
    const currentPoints = Number(profile.availableTraitPoints || 0);
    const sortedTraitItems = [...traitItems].sort((left, right) => {
      const leftOwned = selectedTraitIds.has(left.id) ? 0 : 1;
      const rightOwned = selectedTraitIds.has(right.id) ? 0 : 1;
      if (leftOwned !== rightOwned) {
        return leftOwned - rightOwned;
      }
      return Number(left.sortOrder || 0) - Number(right.sortOrder || 0);
    });

    traitTableBody.innerHTML = sortedTraitItems
      .map((trait) => {
        const isSelected = selectedTraitIds.has(trait.id);
        const requiredPoints = Number(trait.requiredPoints || 0);
        const isLocked = !isSelected && currentPoints < requiredPoints;
        const statusLabel = isSelected ? "?¬ìš© ì¤? : isLocked ? "?¬ì¸??ë¶€ì¡? : "êµ¬ë§¤ ê°€??;
        return `
          <tr>
            <td>${escapeHtml(trait.name || trait.id)}</td>
            <td>+${Number(trait.successPoints || 0)}</td>
            <td>-${Number(trait.failPoints || 0)}</td>
            <td>${requiredPoints}</td>
            <td>${statusLabel}</td>
            <td>
              <button type="button" class="ghost-button compact-button ${isSelected ? "is-owned" : ""}" data-trait-id="${trait.id}" ${isSelected || isLocked ? "disabled" : ""}>
                ${isSelected ? "êµ¬ë§¤ ?„ë£Œ" : "êµ¬ë§¤"}
              </button>
            </td>
          </tr>
        `;
      })
      .join("");

    traitTableBody.querySelectorAll("[data-trait-id]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const updatedProfile = await withPendingToast(onToast, () =>
            selectTrait(button.dataset.traitId)
          );
          await onProfilePatched(updatedProfile);
          onToast("?¹ì„±ì¹˜ë? êµ¬ë§¤?ˆìŠµ?ˆë‹¤.");
        } catch (error) {
          onToast(error.message, true);
          button.disabled = false;
        }
      });
    });
  } catch (_error) {
    traitTableBody.innerHTML = '<tr><td colspan="6" class="table-empty">?¹ì„±ì¹˜ë? ë¶ˆëŸ¬?¤ì? ëª»í–ˆ?µë‹ˆ??</td></tr>';
  }
}

function attachRouletteEvents({ profile, onToast }) {
  const form = document.querySelector("#roulette-item-form");
  const button = document.querySelector("#roulette-button");
  const result = document.querySelector("#roulette-result");
  const wheel = document.querySelector("#roulette-wheel");
  if (!form || !button || !result || !wheel) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(form).entries());
    const name = String(payload.name || "").trim();

    if (!name) {
      onToast("??ª© ?´ë¦„???…ë ¥??ì£¼ì„¸??", true);
      return;
    }

    try {
      await withPendingToast(onToast, () =>
        addDoc(collection(db, "roulette-items"), {
          uid: profile.uid,
          characterName: profile.characterName,
          name,
          createdAt: serverTimestamp(),
        })
      );
      form.reset();
      await hydrateRoulettePanel(profile);
      onToast("ë£°ë › ??ª©??ì¶”ê??ˆìŠµ?ˆë‹¤.");
    } catch (_error) {
      onToast("ë£°ë › ??ª© ì¶”ê????¤íŒ¨?ˆìŠµ?ˆë‹¤.", true);
    }
  });

  button.addEventListener("click", async () => {
    const items = await fetchRouletteItems(profile.uid);

    if (!items.length) {
      onToast("ë¨¼ì? ë£°ë › ??ª©??ì¶”ê???ì£¼ì„¸??", true);
      return;
    }

    button.disabled = true;
    const rewardIndex = Math.floor(Math.random() * items.length);
    const reward = items[rewardIndex];
    const sliceAngle = 360 / items.length;
    const landingAngle = 360 - rewardIndex * sliceAngle - sliceAngle / 2;
    const totalRotation = 2160 + landingAngle;

    wheel.style.setProperty("--spin-rotation", `${totalRotation}deg`);
    wheel.classList.remove("spinning");
    void wheel.offsetWidth;
    wheel.classList.add("spinning");
    result.textContent = "ë£°ë ›???Œë¦¬??ì¤‘ì…?ˆë‹¤.";

    window.setTimeout(async () => {
      result.textContent = reward.name;
      try {
        const attemptedAt = new Date();
        const logId = buildRouletteLogId(attemptedAt, profile.characterName);
        await setDoc(doc(db, "roulette-logs", logId), {
          uid: profile.uid,
          characterName: profile.characterName,
          loginId: profile.loginId,
          rewardName: reward.name,
          rewardDescription: "",
          createdAt: serverTimestamp(),
          createdAtText: attemptedAt.toLocaleString("ko-KR"),
          attemptedAtId: logId,
        });
        await renderRecentRouletteLogs();
        onToast("ë£°ë › ë¡œê·¸ë¥??€?¥í–ˆ?µë‹ˆ??");
      } catch (_error) {
        onToast("ë£°ë › ë¡œê·¸ ?€?¥ì— ?¤íŒ¨?ˆìŠµ?ˆë‹¤.", true);
      } finally {
        button.disabled = false;
      }
    }, 3400);
  });
}

async function hydrateRoulettePanel(profile) {
  const items = await fetchRouletteItems(profile.uid);
  resetRoulettePanel();
  renderRouletteItemList(items, profile);
  renderRouletteWheel(items);
  await renderRecentRouletteLogs();
}

async function fetchRouletteItems(uid) {
  const itemQuery = query(collection(db, "roulette-items"), where("uid", "==", uid), limit(100));
  const snapshot = await getDocs(itemQuery);
  return snapshot.docs
    .map((itemDoc) => ({ id: itemDoc.id, ...itemDoc.data() }))
    .sort((left, right) => getSortTime(left.createdAt) - getSortTime(right.createdAt));
}

function renderRouletteWheel(items) {
  const wheel = document.querySelector("#roulette-wheel");
  const labels = document.querySelector("#roulette-wheel-labels");
  const result = document.querySelector("#roulette-result");
  if (!wheel || !labels || !result) return;

  if (!items.length) {
    wheel.classList.add("empty-wheel");
    wheel.style.background = "";
    labels.innerHTML = '<span class="wheel-placeholder">??ª©??ì¶”ê??˜ë©´ ?íŒ??ë§Œë“¤?´ì§‘?ˆë‹¤.</span>';
    result.textContent = "??ª©??ì¶”ê??˜ë©´ ?Œë¦´ ???ˆìŠµ?ˆë‹¤.";
    return;
  }

  const sliceAngle = 360 / items.length;
  const segments = items
    .map((_, index) => {
      const start = index * sliceAngle;
      const end = (index + 1) * sliceAngle;
      return `${roulettePalette[index % roulettePalette.length]} ${start}deg ${end}deg`;
    })
    .join(", ");

  wheel.classList.remove("empty-wheel");
  wheel.style.background = `
    radial-gradient(circle at center, rgba(255, 255, 255, 0.98) 0 18%, transparent 18%),
    conic-gradient(${segments})
  `;

  labels.innerHTML = items
    .map((item, index) => {
      const angle = index * sliceAngle;
      return `<span style="transform: rotate(${angle}deg) translateY(-158px) rotate(-${angle}deg);">${escapeHtml(item.name)}</span>`;
    })
    .join("");
}

function renderRouletteItemList(items, profile) {
  const itemList = document.querySelector("#roulette-item-list");
  if (!itemList) return;

  if (!items.length) {
    itemList.innerHTML = '<p class="muted">?±ë¡??ë£°ë › ??ª©???†ìŠµ?ˆë‹¤.</p>';
    return;
  }

  itemList.innerHTML = items
    .map(
      (item) => `
        <div class="roulette-item-row">
          <strong>${escapeHtml(item.name)}</strong>
          <button type="button" class="ghost-button compact-button" data-roulette-remove="${item.id}">?? œ</button>
        </div>
      `
    )
    .join("");

  itemList.querySelectorAll("[data-roulette-remove]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await withPendingToast(
          (message, isError = false) => {
            const result = document.querySelector("#roulette-result");
            if (result) {
              result.textContent = isError ? message : "ì²˜ë¦¬ì¤‘ì…?ˆë‹¤";
            }
          },
          () => deleteDoc(doc(db, "roulette-items", button.dataset.rouletteRemove))
        );
        await hydrateRoulettePanel(profile);
      } catch (_error) {
        const result = document.querySelector("#roulette-result");
        if (result) result.textContent = "ë£°ë › ??ª© ?? œ???¤íŒ¨?ˆìŠµ?ˆë‹¤.";
      }
    });
  });
}

async function renderRecentRouletteLogs() {
  const logBody = document.querySelector("#roulette-log-body");
  if (!logBody) return;

  try {
    const logQuery = query(collection(db, "roulette-logs"), orderBy("createdAt", "desc"), limit(5));
    const logSnapshot = await getDocs(logQuery);

    if (logSnapshot.empty) {
      logBody.innerHTML = '<tr><td colspan="3" class="table-empty">?„ì§ ë¡œê·¸ê°€ ?†ìŠµ?ˆë‹¤.</td></tr>';
      return;
    }

    logBody.innerHTML = logSnapshot.docs
      .map((logDoc) => {
        const data = logDoc.data();
        const createdAt = data.createdAt?.toDate?.().toLocaleString("ko-KR") || data.createdAtText || "-";
        return `<tr><td>${escapeHtml(createdAt)}</td><td>${escapeHtml(data.characterName || "-")}</td><td>${escapeHtml(data.rewardName || "-")}</td></tr>`;
      })
      .join("");
  } catch (_error) {
    logBody.innerHTML = '<tr><td colspan="3" class="table-empty">ë¡œê·¸ë¥?ë¶ˆëŸ¬?¤ì? ëª»í–ˆ?µë‹ˆ??</td></tr>';
  }
}

function hydrateAdminPanel({ onProfilePatched, onToast }) {
  const body = document.querySelector("#admin-section-body");
  if (!body) return;

  renderAdminSection(body);

  document.querySelectorAll("[data-admin-section]").forEach((button) => {
    button.classList.toggle("active", button.dataset.adminSection === activeAdminSection);
    button.onclick = () => {
      activeAdminSection = button.dataset.adminSection;
      document.querySelectorAll("[data-admin-section]").forEach((item) => {
        item.classList.toggle("active", item.dataset.adminSection === activeAdminSection);
      });
      hydrateAdminPanel({ onProfilePatched, onToast });
    };
  });

  attachAdminEvents({ onProfilePatched, onToast });
  if (activeAdminSection === "user-adjust") {
    void renderAdminLogTable("operate");
  }
  if (activeAdminSection === "notice") {
    void renderAdminLogTable("notice");
  }
}

function renderAdminSection(body) {
  const sections = {
    "user-adjust": `
      <div class="admin-section-grid">
        <article class="content-card">
          <h3>? ì? ì¡°ì •</h3>
          <form id="admin-manage-form" class="stack-form compact-form admin-manage-grid">
            <label class="admin-wide-field">
              <span>?€???µì…˜</span>
              <label class="inline-check parcel-wrap-check admin-toggle-check">
                <input type="checkbox" name="applyToAllUsers" />
                <span class="check-indicator" aria-hidden="true"></span>
                <span class="check-copy">
                  <strong>?„ì²´ ? ì? ?€??/strong>
                  <small>ì²´í¬?˜ë©´ ëª¨ë“  ? ì??ê²Œ ê°™ì? ì¡°ì •???ìš©?©ë‹ˆ??</small>
                </span>
              </label>
            </label>
            <label><span>?€??ìºë¦­?°ëª…</span><input type="text" name="targetCharacterName" placeholder="ìºë¦­?°ëª…" required /></label>
            <label><span>?¬í™” ì¦ê°</span><input type="number" name="currencyDelta" value="0" /></label>
            <label><span>?¹ì„±ì¹??¬ì¸??ì¦ê°</span><input type="number" name="traitPointDelta" value="0" /></label>
            <label>
              <span>ì§€ê¸??„ì´??? íƒ</span>
              <select name="addItemId" id="admin-item-select">
                <option value="">?„ì´?œì„ ? íƒ?˜ì„¸??/option>
              </select>
            </label>
            <div class="admin-item-picker-row">
              <button type="button" class="ghost-button" id="admin-add-item-button">?„ì´??ì¶”ê?</button>
              <div id="admin-item-queue" class="admin-item-queue"></div>
            </div>
            <label>
              <span>ê¶Œí•œ ë³€ê²?/span>
              <select name="setRole">
                <option value="">ë³€ê²?????/option>
                <option value="user">user</option>
                <option value="moderator">moderator</option>
                <option value="gm">gm</option>
                <option value="admin">admin</option>
              </select>
            </label>
            <button type="submit" class="primary-button">?ìš©</button>
          </form>
        </article>
        <article class="content-card">
          <div class="admin-log-head">
            <h3>? ì? ì¡°ì • ë¡œê·¸</h3>
            <div class="admin-log-pager">
              <button type="button" class="ghost-button compact-button" data-log-page="operate-prev">?´ì „</button>
              <span id="operate-log-page-label" class="muted">1 ?˜ì´ì§€</span>
              <button type="button" class="ghost-button compact-button" data-log-page="operate-next">?¤ìŒ</button>
            </div>
          </div>
          <div class="table-wrap">
            <table class="log-table">
              <thead>
                <tr><th>?œê°</th><th>?´ì˜ì§?/th><th>?€??/th><th>?´ìš©</th></tr>
              </thead>
              <tbody id="operate-log-body">
                <tr><td colspan="4" class="table-empty">ë¡œê·¸ë¥?ë¶ˆëŸ¬?¤ëŠ” ì¤‘ì…?ˆë‹¤.</td></tr>
              </tbody>
            </table>
          </div>
        </article>
      </div>
    `,
    "item-db": `
      <div class="admin-section-grid">
        <article class="content-card">
          <h3>?„ì´???±ë¡</h3>
          <form id="admin-item-form" class="stack-form compact-form">
            <label><span>?„ì´???´ë¦„</span><input type="text" name="name" placeholder="?? ê²°íˆ¬ê¶? required /></label>
            <label><span>?„ì´ì½??´ëª¨ì§€</span><input type="text" name="icon" placeholder="?? ?" value="?" /></label>
            <label><span>ì¹´í…Œê³ ë¦¬</span><input type="text" name="category" placeholder="?? ?Œëª¨?? /></label>
            <label><span>ì§§ì? ?¤ëª…</span><input type="text" name="shortLabel" placeholder="?´íŒ ?”ì•½" /></label>
            <label><span>?ì„¸ ?¤ëª…</span><textarea name="description" rows="4" placeholder="?„ì´???¤ëª…"></textarea></label>
            <button type="submit" class="primary-button">?„ì´???±ë¡</button>
          </form>
        </article>
        <article class="content-card">
          <h3>?±ë¡ ë¯¸ë¦¬ë³´ê¸°</h3>
          <p class="muted">ì§€ê¸ˆì? ?´ëª¨ì§€ ?„ì´ì½˜ì„ ?¬ìš©?˜ê³ , ?˜ì¤‘???„íŠ¸ ?´ë?ì§€ë¥??°ê²°?????ˆê²Œ ?„ë“œë¥?ë¶„ë¦¬???ì—ˆ?µë‹ˆ??</p>
        </article>
      </div>
    `,
    notice: `
      <div class="admin-section-grid">
        <article class="content-card">
          <h3>ê³µì? ?‘ì„±</h3>
          <form id="announcement-form" class="stack-form compact-form">
            <label><span>ê³µì? ?œëª©</span><input type="text" name="title" placeholder="ê³µì? ?œëª©" required /></label>
            <label><span>ê³µì? ?´ìš©</span><textarea name="body" rows="6" placeholder="?«ê¸°ë¥??„ë¥´ë©?? ì?ë³„ë¡œ 1?Œë§Œ ?¬ë¼ì§€??ê³µì?" required></textarea></label>
            <button type="submit" class="primary-button">ê³µì? ?±ë¡</button>
          </form>
        </article>
        <article class="content-card">
          <div class="admin-log-head">
            <h3>ê³µì? ë¡œê·¸</h3>
            <div class="admin-log-pager">
              <button type="button" class="ghost-button compact-button" data-log-page="notice-prev">?´ì „</button>
              <span id="notice-log-page-label" class="muted">1 ?˜ì´ì§€</span>
              <button type="button" class="ghost-button compact-button" data-log-page="notice-next">?¤ìŒ</button>
            </div>
          </div>
          <div class="table-wrap">
            <table class="log-table">
              <thead>
                <tr><th>?œê°</th><th>?œëª©</th><th>?‘ì„±??/th></tr>
              </thead>
              <tbody id="notice-log-body">
                <tr><td colspan="3" class="table-empty">ë¡œê·¸ë¥?ë¶ˆëŸ¬?¤ëŠ” ì¤‘ì…?ˆë‹¤.</td></tr>
              </tbody>
            </table>
          </div>
        </article>
      </div>
    `,
    account: `
      <div class="admin-section-grid">
        <article class="content-card">
          <h3>ê³„ì • ?? œ</h3>
          <form id="admin-delete-form" class="stack-form compact-form">
            <label><span>?? œ ?€??ìºë¦­?°ëª…</span><input type="text" name="characterName" placeholder="ìºë¦­?°ëª…" required /></label>
            <button type="submit" class="ghost-button danger-button">ê³„ì • ?? œ</button>
          </form>
        </article>
      </div>
    `,
  };

  body.innerHTML = sections[activeAdminSection] || sections["user-adjust"];
}

function attachAdminEvents({ onProfilePatched, onToast }) {
  const manageForm = document.querySelector("#admin-manage-form");
  const itemForm = document.querySelector("#admin-item-form");
  const announcementForm = document.querySelector("#announcement-form");
  const deleteForm = document.querySelector("#admin-delete-form");

  if (manageForm) {
    const targetInput = manageForm.querySelector('input[name="targetCharacterName"]');
    const applyAllCheckbox = manageForm.querySelector('input[name="applyToAllUsers"]');
    const itemSelect = manageForm.querySelector("#admin-item-select");
    const addItemButton = manageForm.querySelector("#admin-add-item-button");

    void hydrateAdminItemOptions();
    renderAdminItemQueue();

    applyAllCheckbox?.addEventListener("change", () => {
      if (!targetInput) return;
      targetInput.disabled = applyAllCheckbox.checked;
      targetInput.required = !applyAllCheckbox.checked;
      if (applyAllCheckbox.checked) {
        targetInput.value = "";
      }
    });

    addItemButton?.addEventListener("click", () => {
      const selectedId = String(itemSelect?.value || "").trim();
      if (!selectedId) {
        onToast("ì§€ê¸‰í•  ?„ì´?œì„ ë¨¼ì? ? íƒ??ì£¼ì„¸??", true);
        return;
      }
      pendingAdminItemIds.push(selectedId);
      renderAdminItemQueue();
      if (itemSelect) {
        itemSelect.value = "";
      }
    });

    manageForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(manageForm).entries());
      const hasCurrencyDelta = Number(payload.currencyDelta || 0) !== 0;
      const hasTraitDelta = Number(payload.traitPointDelta || 0) !== 0;
      const hasRoleChange = String(payload.setRole || "").trim().length > 0;
      const hasItems = pendingAdminItemIds.length > 0;

      if (!hasCurrencyDelta && !hasTraitDelta && !hasRoleChange && !hasItems) {
        onToast("?ìš©??ë³€ê²??¬í•­???†ìŠµ?ˆë‹¤.", true);
        return;
      }

      try {
        await withPendingToast(onToast, () =>
          adminManageUser({
            targetCharacterName: payload.targetCharacterName,
            currencyDelta: Number(payload.currencyDelta || 0),
            traitPointDelta: Number(payload.traitPointDelta || 0),
            addItemIds: pendingAdminItemIds,
            setRole: payload.setRole,
            applyToAllUsers: payload.applyToAllUsers === "on",
          })
        );
        manageForm.reset();
        pendingAdminItemIds = [];
        renderAdminItemQueue();
        await onProfilePatched();
        await renderAdminLogTable("operate");
        onToast("? ì? ì¡°ì •???ìš©?ˆìŠµ?ˆë‹¤.");
      } catch (error) {
        onToast(error.message, true);
      }
    });
  }

  if (itemForm) {
    itemForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(itemForm).entries());

      try {
        await withPendingToast(onToast, () => createItemDefinition(payload));
        itemForm.reset();
        await hydrateAdminItemOptions();
        onToast("?„ì´??DB?????„ì´?œì„ ì¶”ê??ˆìŠµ?ˆë‹¤.");
      } catch (error) {
        onToast(error.message, true);
      }
    });
  }

  if (announcementForm) {
    announcementForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(announcementForm).entries());

      try {
        await withPendingToast(onToast, () => createAnnouncement(payload));
        announcementForm.reset();
        adminLogPages.notice = 0;
        await renderAdminLogTable("notice");
        onToast("ê³µì?ë¥??±ë¡?ˆìŠµ?ˆë‹¤.");
      } catch (error) {
        onToast(error.message, true);
      }
    });
  }

  if (deleteForm) {
    deleteForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(deleteForm).entries());

      if (!window.confirm(`${payload.characterName} ê³„ì •???? œ? ê¹Œ??`)) return;

      try {
        await withPendingToast(onToast, () => adminDeleteUser(payload.characterName));
        deleteForm.reset();
        onToast("ê³„ì •???? œ?ˆìŠµ?ˆë‹¤.");
      } catch (error) {
        onToast(error.message, true);
      }
    });
  }

  document.querySelectorAll("[data-log-page]").forEach((button) => {
    button.addEventListener("click", async () => {
      const [kind, direction] = button.dataset.logPage.split("-");
      const currentPage = adminLogPages[kind];
      const nextPage = direction === "next" ? currentPage + 1 : Math.max(0, currentPage - 1);
      if (nextPage === currentPage && direction === "prev") return;
      adminLogPages[kind] = nextPage;
      await renderAdminLogTable(kind);
    });
  });
}

async function syncAnnouncementModal({ profile, onProfilePatched, onToast }) {
  const modal = ensureAnnouncementModal();
  const dismissedIds = new Set(profile.dismissedAnnouncementIds || []);

  try {
    const announcements = await fetchActiveAnnouncements();
    const nextAnnouncement = announcements.find((item) => !dismissedIds.has(item.id));

    if (!nextAnnouncement) {
      currentNoticeModalId = null;
      hideAnnouncementModal();
      return;
    }

    if (currentNoticeModalId === nextAnnouncement.id && !modal.classList.contains("hidden")) {
      return;
    }

    currentNoticeModalId = nextAnnouncement.id;
    showAnnouncementModal(nextAnnouncement, { onProfilePatched, onToast });
  } catch (_error) {
    hideAnnouncementModal();
  }
}

function ensureAnnouncementModal() {
  let modal = document.querySelector("#announcement-modal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "announcement-modal";
  modal.className = "modal-backdrop hidden";
  modal.innerHTML = `
    <div class="modal-panel notice-modal-panel">
      <div class="modal-head">
        <div>
          <p class="eyebrow">NOTICE</p>
          <h2 id="announcement-modal-title">ê³µì?</h2>
        </div>
        <button id="announcement-modal-close-icon" type="button" class="icon-button">x</button>
      </div>
      <div class="notice-modal-body">
        <p id="announcement-modal-body"></p>
      </div>
      <div class="notice-modal-actions">
        <button id="announcement-modal-close" type="button" class="primary-button">?«ê¸°</button>
      </div>
    </div>
  `;
  document.body.append(modal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      const closeButton = document.querySelector("#announcement-modal-close");
      if (closeButton) closeButton.click();
    }
  });
  return modal;
}

function showAnnouncementModal(announcement, { onProfilePatched, onToast }) {
  const modal = ensureAnnouncementModal();
  const title = document.querySelector("#announcement-modal-title");
  const body = document.querySelector("#announcement-modal-body");
  const closeButton = document.querySelector("#announcement-modal-close");
  const closeIcon = document.querySelector("#announcement-modal-close-icon");
  if (!title || !body || !closeButton || !closeIcon) return;

  title.textContent = announcement.title || "ê³µì?";
  body.textContent = announcement.body || "";
  modal.classList.remove("hidden");

  const closeHandler = async () => {
    try {
      const updatedProfile = await dismissAnnouncement(announcement.id);
      hideAnnouncementModal();
      await onProfilePatched(updatedProfile);
      await hydrateNotificationBadge(updatedProfile);
    } catch (error) {
      hideAnnouncementModal();
      onToast(error.message, true);
    }
  };

  closeButton.onclick = closeHandler;
  closeIcon.onclick = closeHandler;
}

function hideAnnouncementModal() {
  const modal = document.querySelector("#announcement-modal");
  if (modal) modal.classList.add("hidden");
}

async function fetchActiveAnnouncements(fetchLimit = 5) {
  const announcementQuery = query(
    collection(db, "announcements"),
    where("active", "==", true),
    limit(fetchLimit)
  );
  const snapshot = await getDocs(announcementQuery);
  return snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .sort((left, right) => getSortTime(right.createdAt) - getSortTime(left.createdAt))
    .slice(0, fetchLimit);
}

async function fetchNotifications(uid, fetchLimit = 10) {
  const notificationQuery = query(
    collection(db, "notifications"),
    where("targetUid", "==", uid),
    limit(fetchLimit)
  );
  const snapshot = await getDocs(notificationQuery);
  return snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .sort((left, right) => getSortTime(right.createdAt) - getSortTime(left.createdAt))
    .slice(0, fetchLimit);
}

async function markVisibleNotificationsRead(profile) {
  const notifications = await fetchNotifications(profile.uid, 20);
  const unreadItems = notifications.filter((item) => !item.isRead);

  if (!unreadItems.length) {
    return;
  }

  await Promise.all(
    unreadItems.map((item) =>
      markNotificationRead(item.id).catch(() => null)
    )
  );
}

async function fetchPendingParcels(uid, fetchLimit = 8) {
  const parcelQuery = query(
    collection(db, "parcels"),
    where("receiverUid", "==", uid),
    limit(fetchLimit * 4)
  );
  const snapshot = await getDocs(parcelQuery);
  return snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .filter((item) => item.status === "pending")
    .sort((left, right) => getSortTime(right.createdAt) - getSortTime(left.createdAt))
    .slice(0, fetchLimit);
}

async function renderAdminLogTable(kind) {
  const bodyId = kind === "operate" ? "#operate-log-body" : "#notice-log-body";
  const labelId = kind === "operate" ? "#operate-log-page-label" : "#notice-log-page-label";
  const body = document.querySelector(bodyId);
  const label = document.querySelector(labelId);
  if (!body || !label) return;

  try {
    const result = await listAdminLogs({
      kind,
      page: adminLogPages[kind],
      pageSize: 5,
    });

    label.textContent = `${result.page + 1} ?˜ì´ì§€`;

    if (!result.items.length) {
      if (adminLogPages[kind] > 0) {
        adminLogPages[kind] -= 1;
        await renderAdminLogTable(kind);
        return;
      }
      body.innerHTML =
        kind === "operate"
          ? '<tr><td colspan="4" class="table-empty">ë¡œê·¸ê°€ ?†ìŠµ?ˆë‹¤.</td></tr>'
          : '<tr><td colspan="3" class="table-empty">ë¡œê·¸ê°€ ?†ìŠµ?ˆë‹¤.</td></tr>';
      return;
    }

    body.innerHTML = result.items
      .map((item) => {
        const createdLabel = formatMaybeTimestamp(item.createdAt) || "-";
        if (kind === "operate") {
          const itemSummary = Array.isArray(item.addItemNames)
            ? Array.from(
                item.addItemNames.reduce((map, name) => {
                  const label = String(name || "").trim();
                  if (!label) return map;
                  map.set(label, (map.get(label) || 0) + 1);
                  return map;
                }, new Map())
              )
                .map(([name, count]) => `${name}${count > 1 ? ` x${count}` : ""}`)
                .join(", ")
            : "";
          const details = [
            item.currencyDelta ? `?¬í™” ${Number(item.currencyDelta) > 0 ? "+" : ""}${Number(item.currencyDelta)}` : "",
            item.traitPointDelta ? `?¬ì¸??${Number(item.traitPointDelta) > 0 ? "+" : ""}${Number(item.traitPointDelta)}` : "",
            itemSummary
              ? `?„ì´??${escapeHtml(itemSummary)}`
              : item.addItemName
                ? `?„ì´??${escapeHtml(item.addItemName)}`
                : "",
            item.setRole ? `ê¶Œí•œ ${escapeHtml(item.setRole)}` : "",
            item.applyToAllUsers ? "?„ì²´ ? ì? ?€?? : "",
          ]
            .filter(Boolean)
            .join(" / ");
          return `<tr><td>${escapeHtml(createdLabel)}</td><td>${escapeHtml(item.adminCharacterName || "-")}</td><td>${escapeHtml(item.targetCharacterName || "-")}</td><td>${details || "-"}</td></tr>`;
        }
        return `<tr><td>${escapeHtml(createdLabel)}</td><td>${escapeHtml(item.title || item.noticeId || "-")}</td><td>${escapeHtml(item.createdByCharacterName || "-")}</td></tr>`;
      })
      .join("");

    const nextButton = document.querySelector(`[data-log-page="${kind}-next"]`);
    const prevButton = document.querySelector(`[data-log-page="${kind}-prev"]`);
    if (prevButton) {
      prevButton.disabled = result.page === 0;
    }
    if (nextButton) {
      nextButton.disabled = !result.hasNext;
    }
  } catch (_error) {
    body.innerHTML =
      kind === "operate"
        ? '<tr><td colspan="4" class="table-empty">ë¡œê·¸ë¥?ë¶ˆëŸ¬?¤ì? ëª»í–ˆ?µë‹ˆ??</td></tr>'
        : '<tr><td colspan="3" class="table-empty">ë¡œê·¸ë¥?ë¶ˆëŸ¬?¤ì? ëª»í–ˆ?µë‹ˆ??</td></tr>';
  }
}

async function hydrateMatchResultsPanel() {
  const body = document.querySelector("#match-results-body");
  if (!body) return;
  const isThreePlayerResultMode = activeResultMode.includes("3p");
  const emptyColspan = isThreePlayerResultMode ? 7 : 9;
  const pageLabel = document.querySelector("#match-results-page-label");

  document.querySelectorAll("[data-result-mode]").forEach((button) => {
    button.onclick = async () => {
      activeResultMode = button.dataset.resultMode;
      matchResultsPage = 0;
      const menuContent = document.querySelector("#menu-content");
      if (menuContent) {
        const activeTab = document.querySelector(".tab-button.active[data-menu-id]");
        activeTab?.click();
      }
    };
  });

  document.querySelectorAll("[data-match-page]").forEach((button) => {
    button.onclick = async () => {
      if (button.dataset.matchPage === "prev") {
        matchResultsPage = Math.max(0, matchResultsPage - 1);
      } else {
        matchResultsPage += 1;
      }
      await hydrateMatchResultsPanel();
    };
  });

  try {
    const resultQuery = query(
      collection(db, "match-results"),
      where("mode", "==", activeResultMode),
      limit(100)
    );
    const snapshot = await getDocs(resultQuery);
    const allItems = [...snapshot.docs].sort((left, right) => {
      const leftTime = getSortTime(left.data().createdAt);
      const rightTime = getSortTime(right.data().createdAt);
      return rightTime - leftTime;
    });
    const pageSize = 10;
    const startIndex = matchResultsPage * pageSize;
    const pageItems = allItems.slice(startIndex, startIndex + pageSize);
    const hasNext = startIndex + pageSize < allItems.length;
    const prevButton = document.querySelector('[data-match-page="prev"]');
    const nextButton = document.querySelector('[data-match-page="next"]');

    if (pageLabel) {
      pageLabel.textContent = `${matchResultsPage + 1} ?˜ì´ì§€`;
    }
    if (prevButton) {
      prevButton.disabled = matchResultsPage === 0;
    }
    if (nextButton) {
      nextButton.disabled = !hasNext;
    }

    if (!pageItems.length) {
      if (matchResultsPage > 0) {
        matchResultsPage -= 1;
        await hydrateMatchResultsPanel();
        return;
      }
      body.innerHTML = `<tr><td colspan="${emptyColspan}" class="table-empty">?€êµ?ê²°ê³¼ê°€ ?†ìŠµ?ˆë‹¤.</td></tr>`;
      return;
    }

    body.innerHTML = pageItems
      .map((item) => {
        const data = item.data();
        const ranks = Array.isArray(data.ranks) ? data.ranks : [];
        const createdAt = data.createdAt?.toDate?.().toLocaleString("ko-KR") || data.createdAtText || "-";
        const rank1 = ranks[0] || {};
        const rank2 = ranks[1] || {};
        const rank3 = ranks[2] || {};
        const rank4 = ranks[3] || {};
        return `
          <tr>
            <td>${escapeHtml(createdAt)}</td>
            <td class="result-first-place">${escapeHtml(rank1.nickname || "-")}</td>
            <td class="result-first-place">${escapeHtml(String(rank1.score ?? "-"))}</td>
            <td>${escapeHtml(rank2.nickname || "-")}</td>
            <td>${escapeHtml(String(rank2.score ?? "-"))}</td>
            <td>${escapeHtml(rank3.nickname || "-")}</td>
            <td>${escapeHtml(String(rank3.score ?? "-"))}</td>
            ${
              isThreePlayerResultMode
                ? ""
                : `<td>${escapeHtml(rank4.nickname || "-")}</td><td>${escapeHtml(String(rank4.score ?? "-"))}</td>`
            }
          </tr>
        `;
      })
      .join("");
  } catch (_error) {
    body.innerHTML = `<tr><td colspan="${emptyColspan}" class="table-empty">?€êµ?ê²°ê³¼ë¥?ë¶ˆëŸ¬?¤ì? ëª»í–ˆ?µë‹ˆ??</td></tr>`;
  }
}

async function fetchCollectionItems(collectionName, orderField) {
  const itemQuery = query(collection(db, collectionName), orderBy(orderField, "asc"));
  const snapshot = await getDocs(itemQuery);
  return snapshot.docs.map((itemDoc) => ({ id: itemDoc.id, ...itemDoc.data() }));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatMaybeTimestamp(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value.toDate === "function") {
    return value.toDate().toLocaleString("ko-KR");
  }
  if (typeof value === "object") {
    const seconds = Number(value.seconds ?? value._seconds ?? NaN);
    const nanoseconds = Number(value.nanoseconds ?? value._nanoseconds ?? 0);
    if (!Number.isNaN(seconds)) {
      return new Date(seconds * 1000 + Math.floor(nanoseconds / 1000000)).toLocaleString("ko-KR");
    }
  }
  return "";
}

function getSortTime(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") {
    return value.toMillis();
  }
  if (typeof value.toDate === "function") {
    return value.toDate().getTime();
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function buildParcelDisplayText(parcel) {
  const parts = [];
  if (Array.isArray(parcel.items) && parcel.items.length) {
    const itemNames = parcel.items.map((item) => item?.name).filter(Boolean);
    if (itemNames.length) {
      parts.push(`?„ì´??${itemNames.join(", ")}`);
    }
  } else if (parcel.item?.name) {
    parts.push(`?„ì´??${parcel.item.name}`);
  }
  if (Number(parcel.currencyAmount || 0) > 0) {
    parts.push(`?¬í™” ${Number(parcel.currencyAmount || 0)} G`);
  }
  return parts.join(" / ") || "?´ìš©ë¬??†ìŒ";
}

function buildRouletteLogId(date, characterName) {
  const pad = (value) => String(value).padStart(2, "0");
  const timestamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    "-",
    String(date.getMilliseconds()).padStart(3, "0"),
  ].join("");
  const safeCharacterName = String(characterName || "player")
    .trim()
    .replace(/[\\/#?[\]]/g, "_")
    .replace(/\s+/g, "_");
  return `${timestamp}-${safeCharacterName}`;
}

function buildInventoryItemKey(item) {
  return [item?.itemId || item?.name || "item", item?.grantedAt || "", item?.name || ""].join("::");
}

function buildDisplayRankings(rankings) {
  const sorted = [...(Array.isArray(rankings) ? rankings : [])].sort((left, right) => {
    const pointDiff = Number(right.rankingPoints || 0) - Number(left.rankingPoints || 0);
    if (pointDiff !== 0) {
      return pointDiff;
    }
    return String(left.characterName || "").localeCompare(String(right.characterName || ""), "ko");
  });

  let lastDisplayRank = 0;
  return sorted.map((item, index) => {
    const previousPoints = index > 0 ? Number(sorted[index - 1].rankingPoints || 0) : null;
    const currentPoints = Number(item.rankingPoints || 0);
    const displayRank = index > 0 && previousPoints === currentPoints ? lastDisplayRank : index + 1;
    lastDisplayRank = displayRank;
    return { ...item, displayRank };
  });
}

async function loadImageFromFile(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("?´ë?ì§€ë¥??½ì? ëª»í–ˆ?µë‹ˆ??"));
    reader.readAsDataURL(file);
  });

  return await new Promise((resolve, reject) => {
    const target = new Image();
    target.onload = () => resolve(target);
    target.onerror = () => reject(new Error("?´ë?ì§€ë¥?ë¶ˆëŸ¬?¤ì? ëª»í–ˆ?µë‹ˆ??"));
    target.src = dataUrl;
  });
}

async function compressCanvas(sourceCanvas, maxSize = 240) {
  const ratio = Math.min(1, maxSize / Math.max(sourceCanvas.width, sourceCanvas.height));
  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = Math.max(1, Math.round(sourceCanvas.width * ratio));
  outputCanvas.height = Math.max(1, Math.round(sourceCanvas.height * ratio));
  const context = outputCanvas.getContext("2d");
  if (!context) {
    throw new Error("?´ë?ì§€ ì²˜ë¦¬ë¥??œì‘?˜ì? ëª»í–ˆ?µë‹ˆ??");
  }
  context.drawImage(sourceCanvas, 0, 0, outputCanvas.width, outputCanvas.height);
  return outputCanvas.toDataURL("image/jpeg", 0.82);
}

function resetRoulettePanel() {
  const wheel = document.querySelector("#roulette-wheel");
  const result = document.querySelector("#roulette-result");
  const form = document.querySelector("#roulette-item-form");
  if (wheel) {
    wheel.classList.remove("spinning");
    wheel.style.removeProperty("--spin-rotation");
  }
  if (result) result.textContent = "??ª©??ì¶”ê??˜ë©´ ?Œë¦´ ???ˆìŠµ?ˆë‹¤.";
  if (form) form.reset();
}


