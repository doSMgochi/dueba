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
import {
  getDownloadURL,
  ref as storageRef,
  uploadString,
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-storage.js";
import { db, storage } from "./firebase.js";
import {
  buildItemImageStyleAttribute,
  buildItemSpriteFallbackAttributes,
  buildItemSpritePicker,
  getItemColorPresetFilter,
  getItemSprite,
  ITEM_COLOR_PRESETS,
  getItemSpriteCategory,
  getItemSpriteUrl,
  itemSpriteCategories,
  normalizeSpriteCategory,
  preloadImageUrl,
  preloadItemSprite,
  registerCustomItemSprite,
  renderItemVisual,
} from "./item-sprites.js";
import { cleanupYachtModule, initYachtMenu, renderYachtMenu } from "./yacht.js";
import {
  adminDeleteUser,
  adminManageUser,
  getUserInventoryForAdmin,
  uploadItemDotImage,
  createItemDefinition,
  createAnnouncement,
  deleteItemDefinition,
  dismissAnnouncement,
  ensureMahjongProfileItems,
  getRankingBoard,
  getRankingTerritoryAdminSettings,
  listAdminLogs,
  listBugReports,
  markNotificationRead,
  purchaseShopItem,
  refreshCurrentUserProfile,
  respondParcel,
  returnProfileDecorationToInventory,
  sendParcel,
  changeUserPassword,
  clearProfileTitle,
  updateMemberProfile,
  updateProfileDecorations,
  useInventoryItem,
  updateItemDefinition,
  updateRankingTerritoryAdminSettings,
  updateProfileSealImage,
  saveRankingSnapshot,
  clearPastRankingSnapshots,
} from "./auth.js";

const SYSTEM_INVENTORY_ITEM_NAMES = new Set(["망치", "택배 상자", "택배상자", "포장지", "반송장", "폐기 승인서", "거절권"]);
const PROFILE_FACTION_OPTIONS = ["매화", "난초", "국화", "대나무"];
const EMPTY_FACTION_SELECTOR_VALUE = "__empty__";

export const menuDefinitions = [
  { id: "ranking", label: "랭킹" },
  { id: "territory", label: "지도" },
  // 대국 정보 메뉴는 현재 미사용 상태라 임시 비활성화합니다.
  // { id: "match", label: "대국 정보" },
  { id: "match-results", label: "대국 결과" },
  { id: "yacht", label: "요트" },
  // 특성치 시스템은 전체 개편 전까지 임시 비활성화합니다.
  // { id: "traits", label: "특성치" },
  { id: "inventory", label: "인벤토리" },
  { id: "shop", label: "상점" },
  { id: "roulette", label: "룰렛" },
  { id: "admin", label: "운영진 메뉴", adminOnly: true },
  { id: "bug-report", label: "버그 리포트" },
  { id: "todo", label: "할 일" },
  { id: "item-db", label: "아이템 DB", adminOnly: true },
];

const adminRoles = ["admin", "gm", "moderator"];
const roulettePalette = [
  "#57121a",
  "#6c1820",
  "#7f1d27",
  "#93222d",
  "#a32733",
  "#b22d39",
  "#432427",
  "#553034",
  "#6b3a3e",
  "#7b1f2b",
  "#8d2431",
  "#a9323f",
];

const sampleLiveMatches = [
  {
    title: "현재 진행중인 대국 예시",
    source: "크롤링 연동 예정",
    players: [
      { mahjongNickname: "쪼름", characterName: "유즈", traits: ["핑후로 화료", "36통 대기로 화료"] },
      { mahjongNickname: "도스모찌", characterName: "아오이", traits: ["국사무쌍으로 화료", "특성 비공개"] },
    ],
  },
  {
    title: "관전 대기방 예시",
    source: "크롤링 연동 예정",
    players: [{ mahjongNickname: "sample-player", characterName: "A-37", traits: ["핑후로 화료"] }],
  },
];

let activeAdminSection = "user-adjust";
let latestAdminTerritorySettings = null;

function preloadQuickProfileImages(profile) {
  if (!profile) {
    return Promise.resolve([]);
  }

  const preloadTasks = [];
  const sealImageUrl = String(profile.profileSealImage || "").trim();
  if (sealImageUrl) {
    preloadTasks.push(preloadImageUrl(sealImageUrl));
  }

  const profileDecorations = normalizeProfileDecorations(profile.profileDecorations);
  for (const decoration of profileDecorations) {
    if (decoration?.spriteKey) {
      preloadTasks.push(preloadItemSprite(decoration.spriteKey));
    }
  }

  const inventoryKinds = buildGroupedInventoryItems(profile.inventory || []);
  for (const { item } of inventoryKinds) {
    if (item?.spriteKey) {
      preloadTasks.push(preloadItemSprite(item.spriteKey));
    }
  }

  return Promise.allSettled(preloadTasks);
}
let currentNoticeModalId = null;
let adminLogPages = { operate: 0, notice: 0 };
let activeResultMode = "ranked-4p-hanchan";
let matchResultsPage = 0;
let notificationPanelPage = 0;
let todoPage = 0;
let shopPage = 0;
let pendingAdminItemIds = [];
let selectedParcelItemKeys = [];
let bugReportPage = 0;
let itemDbPage = 0;
let adminItemCatalogCache = [];
let adminItemCatalogPromise = null;
let rouletteDropItemMode = false;
let ensureMahjongProfileItemsPromise = null;
let hasEnsuredMahjongProfileItems = false;
const quickProfileCacheTtl = 60 * 1000;
const itemDbPageSize = 24;
const territoryCacheTtl = 2 * 60 * 1000;
const territorySnapshotStorageKey = "dueba.territory-snapshot.v1";
let rankingBoardCache = { data: null, date: "", fetchedAt: 0, promise: null, promiseDate: "" };
let activeRankingDate = "";
let activeAdminItemSection = "create";
let profileDecorationEditMode = false;
let mobileInfoExpanded = false;
const randomBoxAdminItems = [
  { name: "랜덤박스:소모품", typeLabel: "소모품" },
  { name: "랜덤박스:의상", typeLabel: "의상" },
  { name: "랜덤박스:프로필 꾸미기", typeLabel: "프로필 꾸미기" },
];

function hydrateCustomSpritesFromItems(items = []) {
  items.forEach((item) => {
    const spriteKey = String(item?.spriteKey || "").trim();
    if (!spriteKey.startsWith("custom:")) return;
    const customUrl = spriteKey.slice("custom:".length).trim();
    if (!customUrl) return;
    registerCustomItemSprite({
      url: customUrl,
      label: item?.name || item?.shortLabel || customUrl,
      category: item?.category || "커스텀",
    });
  });
}

function hydrateCustomSpritesFromProfile(profile) {
  if (!profile || typeof profile !== "object") return;

  const registerFromItem = (item, fallbackCategory) => {
    const spriteKey = String(item?.spriteKey || "").trim();
    if (!spriteKey.startsWith("custom:")) return;
    const customUrl = spriteKey.slice("custom:".length).trim();
    if (!customUrl) return;
    registerCustomItemSprite({
      url: customUrl,
      label: item?.name || item?.shortLabel || customUrl,
      category: item?.category || fallbackCategory || "커스텀",
    });
  };

  normalizeProfileDecorations(profile.profileDecorations).forEach((item) => registerFromItem(item, "프로필 꾸미기"));
  (Array.isArray(profile.inventory) ? profile.inventory : []).forEach((item) =>
    registerFromItem(normalizeSystemInventoryItemForDisplay(item), item?.category || "기타 아이템")
  );
}

async function ensureAdminMahjongProfileItems(onToast) {
  if (hasEnsuredMahjongProfileItems) return null;
  if (ensureMahjongProfileItemsPromise) return ensureMahjongProfileItemsPromise;
  ensureMahjongProfileItemsPromise = (async () => {
    try {
      const result = await ensureMahjongProfileItems();
      hasEnsuredMahjongProfileItems = true;
      const createdCount = Math.max(0, Number(result?.createdCount || 0));
      const updatedCount = Math.max(0, Number(result?.updatedCount || 0));
      if (createdCount > 0 || updatedCount > 0) {
        await loadAdminItemCatalog(true);
        await hydrateAdminItemOptions();
        refreshAdminItemSelectors({ root: document });
        if (document.querySelector("#item-db-grid")) {
          await hydrateItemDatabasePanel();
        }
        const fragments = [];
        if (createdCount > 0) {
          fragments.push(`${createdCount}개 추가`);
        }
        if (updatedCount > 0) {
          fragments.push(`${updatedCount}개 보정`);
        }
        onToast?.(`마작패 아이템 ${fragments.join(", ")} 완료`);
      }
      return result;
    } catch (error) {
      console.error("Failed to ensure mahjong profile items", error);
      return null;
    } finally {
      ensureMahjongProfileItemsPromise = null;
    }
  })();
  return ensureMahjongProfileItemsPromise;
}

async function withPendingToast(onToast, task) {
  onToast("처리중입니다.", false, { persist: true });
  try {
    return await task();
  } finally {
    window.setTimeout(() => {
      onToast.hideIfMessage?.("처리중입니다.");
    }, 0);
  }
}

async function getCachedRankingBoard(forceRefresh = false, date = activeRankingDate) {
  const now = Date.now();
  const requestedDate = String(date || "").trim();
  if (
    !forceRefresh &&
    rankingBoardCache.data &&
    rankingBoardCache.date === requestedDate &&
    now - rankingBoardCache.fetchedAt < quickProfileCacheTtl
  ) {
    return rankingBoardCache.data;
  }

  if (rankingBoardCache.promise && rankingBoardCache.promiseDate === requestedDate) {
    return rankingBoardCache.promise;
  }

  rankingBoardCache.promise = getRankingBoard(requestedDate)
    .then((data) => {
      rankingBoardCache = {
        data: data && typeof data === "object" ? data : {},
        date: requestedDate,
        fetchedAt: Date.now(),
        promise: null,
        promiseDate: "",
      };
      syncCachedTerritoryFromBoard(rankingBoardCache.data);
      return rankingBoardCache.data;
    })
    .catch((error) => {
      rankingBoardCache.promise = null;
      rankingBoardCache.promiseDate = "";
      throw error;
    });
  rankingBoardCache.promiseDate = requestedDate;

  return rankingBoardCache.promise;
}

async function getCurrentRankingBoardSnapshot(forceRefresh = false) {
  return getCachedRankingBoard(forceRefresh, "");
}

function invalidateQuickProfileCaches() {
  rankingBoardCache = { data: null, date: "", fetchedAt: 0, promise: null, promiseDate: "" };
}

function readCachedTerritorySnapshot() {
  try {
    const raw = window.localStorage.getItem(territorySnapshotStorageKey);
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object") return null;
    const territory = parsed.territory;
    if (!territory || !Array.isArray(territory.cells) || !territory.cells.length) {
      return null;
    }
    return {
      territory,
      version: String(parsed.version || territory.version || "").trim(),
      checkedAt: Number(parsed.checkedAt || 0),
    };
  } catch {
    return null;
  }
}

function writeCachedTerritorySnapshot(territory) {
  if (!territory || !Array.isArray(territory.cells) || !territory.cells.length) return;
  try {
    window.localStorage.setItem(
      territorySnapshotStorageKey,
      JSON.stringify({
        territory,
        version: String(territory.version || "").trim(),
        checkedAt: Date.now(),
      })
    );
  } catch {
    // Ignore storage failures and fall back to in-memory caching.
  }
}

function syncCachedTerritoryFromBoard(board) {
  const territory = board?.territory;
  if (!territory || !Array.isArray(territory.cells) || !territory.cells.length) return;
  writeCachedTerritorySnapshot(territory);
}

export function buildDashboard({
  profile,
  activeMenuId,
  menuTabs,
  menuContent,
  onProfilePatched,
  onToast,
}) {
  cleanupYachtModule();
  initializeFloatingTooltip();
  const visibleMenus = menuDefinitions.filter((menu) => !menu.adminOnly || adminRoles.includes(profile.role));
  if (!adminRoles.includes(profile.role)) {
    rouletteDropItemMode = false;
  }
  const preferredMenuId = profile?.activeYachtRoomId ? "yacht" : activeMenuId;
  const safeActiveMenuId = visibleMenus.some((menu) => menu.id === preferredMenuId)
    ? preferredMenuId
    : visibleMenus[0].id;

  document.querySelector("#welcome-title").textContent = `${profile.characterName}님 환영합니다`;
  document.querySelector("#profile-summary").textContent = `${profile.nickname} | ID ${profile.loginId}`;
  document.querySelector("#role-badge").textContent = profile.role;
  document.querySelector("#currency-value").textContent = `${Number(profile.currency || 0)} 환`;
  document.querySelector("#faction-value").textContent = String(profile.factionName || "미설정");
  document.querySelector("#stat-points").textContent = String(profile.rankingPoints || 0);

  const mobileInfoToggle = document.querySelector("#mobile-info-toggle");
  const statsStrip = document.querySelector("#dashboard-stats-strip");
  if (mobileInfoToggle && statsStrip) {
    const syncMobileInfoPanel = () => {
      statsStrip.classList.toggle("is-open", mobileInfoExpanded);
      mobileInfoToggle.textContent = mobileInfoExpanded ? "정보 닫기" : "정보 보기";
      mobileInfoToggle.setAttribute("aria-expanded", mobileInfoExpanded ? "true" : "false");
    };

    mobileInfoToggle.onclick = () => {
      mobileInfoExpanded = !mobileInfoExpanded;
      syncMobileInfoPanel();
    };

    syncMobileInfoPanel();
  }
  if (statsStrip) {
    ensureDashboardFactionBar(statsStrip);
    void hydrateDashboardFactionBar();
  }

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
  if (adminRoles.includes(profile.role)) {
    void loadAdminItemCatalog();
  }

  menuContent.innerHTML = renderMenuContent(safeActiveMenuId, profile);

  if (safeActiveMenuId === "ranking") void hydrateRankingPanel();
  if (safeActiveMenuId === "territory") void hydrateTerritoryPanel();
  if (safeActiveMenuId === "shop") void hydrateShopPanel({ onProfilePatched, onToast });
  if (safeActiveMenuId === "item-db") void hydrateItemDatabasePanel();
  if (safeActiveMenuId === "inventory") attachParcelForm({ profile, onProfilePatched, onToast });
  if (safeActiveMenuId === "bug-report") void hydrateBugReportPanel(profile, onToast);
  if (safeActiveMenuId === "todo") {
    attachTodoEvents({ profile, onToast });
    todoPage = 0;
    void hydrateTodoPanel(profile.uid);
  }
  if (safeActiveMenuId === "yacht") initYachtMenu({ profile, onProfilePatched, onToast });
  if (safeActiveMenuId === "roulette") {
    attachRouletteEvents({ profile, onToast });
    void hydrateRoulettePanel(profile);
  }
  if (safeActiveMenuId === "match-results") void hydrateMatchResultsPanel();
  // if (safeActiveMenuId === "traits") void hydrateTraitPanel({ profile, onProfilePatched, onToast });
  if (safeActiveMenuId === "admin") hydrateAdminPanel({ onProfilePatched, onToast });

  void syncAnnouncementModal({ profile, onProfilePatched, onToast });
}

function initializeFloatingTooltip() {
  if (document.body.dataset.tooltipBound === "true") return;
  document.body.dataset.tooltipBound = "true";

  const tooltip = document.createElement("div");
  tooltip.id = "floating-tooltip";
  tooltip.className = "floating-tooltip hidden";
  document.body.appendChild(tooltip);

  let activeTarget = null;

  const hideTooltip = () => {
    activeTarget = null;
    tooltip.classList.add("hidden");
  };

  const updateTooltip = (event) => {
    if (!activeTarget) return;
    const text = String(activeTarget.getAttribute("data-tooltip") || "").trim();
    if (!text) {
      hideTooltip();
      return;
    }

    tooltip.textContent = text;
    tooltip.classList.remove("hidden");

    const margin = 12;
    const offset = 18;
    const rect = tooltip.getBoundingClientRect();
    let left = event.clientX + offset;
    let top = event.clientY - rect.height - offset;

    if (left + rect.width > window.innerWidth - margin) {
      left = window.innerWidth - rect.width - margin;
    }
    if (left < margin) {
      left = margin;
    }
    if (top < margin) {
      top = event.clientY + offset;
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = window.innerHeight - rect.height - margin;
    }

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };

  document.addEventListener("mouseover", (event) => {
    const target = event.target.closest("[data-tooltip]");
    if (!target) {
      hideTooltip();
      return;
    }
    activeTarget = target;
    updateTooltip(event);
  });

  document.addEventListener("mousemove", (event) => {
    if (!activeTarget) return;
    updateTooltip(event);
  });

  document.addEventListener("mouseout", (event) => {
    if (!activeTarget) return;
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Element && activeTarget.contains(nextTarget)) {
      return;
    }
    if (event.target instanceof Element && event.target.closest("[data-tooltip]") === activeTarget) {
      hideTooltip();
    }
  });

  window.addEventListener("scroll", hideTooltip, true);
  window.addEventListener("resize", hideTooltip);
}

function renderMenuContent(menuId, profile) {
  const isThreePlayerResultMode = activeResultMode.includes("3p");
  const isAdminProfile = adminRoles.includes(profile.role);
  const inventoryItems = buildGroupedInventoryItems(profile.inventory)
    .map(({ item, count }) => {
      const displayItem = normalizeSystemInventoryItemForDisplay(item);
      const canUseItem = !isSystemInventoryItem(displayItem);
      const tooltip = escapeHtml(buildInventoryTooltipText(displayItem));
      const safeGroupKey = escapeHtml(buildInventoryGroupKey(item));
      return `
        <li class="inventory-item inventory-tooltip draggable-item" data-tooltip="${tooltip}" draggable="true" data-inventory-group-key="${safeGroupKey}">
          ${renderInventoryItemVisual(displayItem, { overlayHtml: count > 1 ? `<span class="inventory-count-badge">${count}</span>` : "" })}
          ${canUseItem ? `<button type="button" class="ghost-button compact-button inventory-use-button" data-inventory-use-group-key="${safeGroupKey}">사용</button>` : ""}
        </li>
      `;
    })
    .join("");
  const activeEffectSummary = renderActiveProfileEffects(profile);

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
        <h3>랭킹</h3>
        <div class="ranking-shell">
          <div class="ranking-toolbar">
            <div class="ranking-date-nav">
              <button type="button" class="secondary-button" data-ranking-date-nav="prev">이전 날짜</button>
              <strong id="ranking-date-label">랭킹을 불러오는 중입니다.</strong>
              <button type="button" class="secondary-button" data-ranking-date-nav="next">다음 날짜</button>
            </div>
            <p id="ranking-phase-label" class="muted">현재 진행 상태를 불러오는 중입니다.</p>
          </div>
          <div class="ranking-mode-grid">
            <article class="ranking-mode-panel">
              <div class="ranking-mode-head">
                <p class="eyebrow">4인 마작</p>
              </div>
              <div class="table-wrap">
                <table class="log-table ranking-table">
                  <thead>
                    <tr>
                      <th>순위</th>
                      <th>캐릭터명</th>
                      <th>작혼 닉네임</th>
                      <th>보유 환</th>
                      <th>점수</th>
                      <th>파벌</th>
                    </tr>
                  </thead>
                  <tbody id="ranking-table-body-4p">
                    <tr><td colspan="6" class="table-empty">랭킹을 불러오는 중입니다.</td></tr>
                  </tbody>
                </table>
              </div>
            </article>
            <article class="ranking-mode-panel">
              <div class="ranking-mode-head">
                <p class="eyebrow">3인 마작</p>
              </div>
              <div class="table-wrap">
                <table class="log-table ranking-table">
                  <thead>
                    <tr>
                      <th>순위</th>
                      <th>캐릭터명</th>
                      <th>작혼 닉네임</th>
                      <th>보유 환</th>
                      <th>점수</th>
                      <th>파벌</th>
                    </tr>
                  </thead>
                  <tbody id="ranking-table-body-3p">
                    <tr><td colspan="6" class="table-empty">랭킹을 불러오는 중입니다.</td></tr>
                  </tbody>
                </table>
              </div>
            </article>
          </div>
        </div>
      </article>
    `,
    territory: `
      <article class="content-card full">
        <h3>지도</h3>
        <div class="ranking-shell">
          <section class="territory-panel">
            <div id="territory-page-map" class="ranking-territory-map">
              <p class="muted">지도를 불러오는 중입니다.</p>
            </div>
          </section>
        </div>
      </article>
    `,
    shop: `
      <div id="shop-grid" class="shop-list-shell">
        <article class="content-card full">
          <p class="muted">상점 정보를 불러오는 중입니다.</p>
        </article>
      </div>
    `,
    "item-db": `
      <div id="item-db-grid" class="content-grid three">
        <article class="content-card full">
          <p class="muted">아이템 DB를 불러오는 중입니다.</p>
        </article>
      </div>
    `,
    "bug-report": `
      <div class="content-grid two">
        <article class="content-card">
          <h3>버그 리포트 작성</h3>
          <form id="bug-report-form" class="stack-form compact-form">
            <label><span>제목</span><input type="text" name="title" placeholder="간단한 제목" required /></label>
            <label><span>내용</span><textarea name="body" rows="6" placeholder="재현 방법이나 증상을 적어주세요." required></textarea></label>
            <label>
              <span>스크린샷 첨부</span>
              <input type="file" name="screenshots" accept="image/*" multiple />
              <small class="muted">최대 5장까지 첨부할 수 있습니다.</small>
            </label>
            <div id="bug-report-preview" class="bug-report-preview-list">
              <p class="muted">첨부된 스크린샷이 없습니다.</p>
            </div>
            <button type="submit" class="primary-button">리포트 등록</button>
          </form>
        </article>
        <article class="content-card bug-report-admin-card ${adminRoles.includes(profile.role) ? "" : "hidden"}">
          <div class="admin-log-head">
            <h3>접수된 리포트</h3>
            <div class="admin-log-pager">
              <button type="button" class="ghost-button compact-button" data-report-page="prev">이전</button>
              <span id="bug-report-page-label" class="muted">1 페이지</span>
              <button type="button" class="ghost-button compact-button" data-report-page="next">다음</button>
            </div>
          </div>
          <div class="table-wrap">
            <table class="log-table bug-report-table">
              <colgroup>
                <col class="bug-report-col-title" />
                <col class="bug-report-col-writer" />
                <col class="bug-report-col-date" />
              </colgroup>
              <thead><tr><th>제목</th><th>작성자</th><th>날짜</th></tr></thead>
              <tbody id="bug-report-body"><tr><td colspan="3" class="table-empty">버그 리포트를 불러오는 중입니다.</td></tr></tbody>
            </table>
          </div>
        </article>
      </div>
    `,
    inventory: `
      <div class="content-grid two inventory-layout">
        <article class="content-card full">
          <h3>인벤토리</h3>
          ${activeEffectSummary}
          <ul class="inventory-list">
            ${inventoryItems || '<li class="empty-state">보유 중인 아이템이 없습니다.</li>'}
          </ul>
        </article>
        <article class="content-card">
          <h3>소포 보내기</h3>
          <form id="parcel-form" class="stack-form compact-form">
            <label><span>대상 캐릭터명</span><input type="text" name="targetCharacterName" placeholder="받는 캐릭터명" required /></label>
            <div class="parcel-drop-shell">
              <div id="parcel-drop-zone" class="parcel-drop-zone">
                <strong>보낼 아이템</strong>
                <p class="muted">인벤토리 아이템을 여기로 드래그해서 넣어주세요.</p>
                <div id="parcel-selected-item" class="parcel-selected-item muted">선택한 아이템이 없습니다.</div>
                <button id="parcel-clear-button" type="button" class="ghost-button compact-button">전체 선택 해제</button>
              </div>
            </div>
            <label><span>보낼 환</span><input type="number" min="0" name="currencyAmount" placeholder="0" /></label>
            <label class="inline-check parcel-charge-check">
              <input type="checkbox" name="useCharge" />
              <span class="check-indicator" aria-hidden="true"></span>
              <span class="check-copy">
                <strong>대금 청구</strong>
                <small>상대가 수령할 때 청구 금액을 지불해야 합니다.</small>
              </span>
            </label>
            <label data-parcel-charge-field><span>청구 금액</span><input type="number" min="0" name="chargeAmount" placeholder="0" disabled /></label>
            <label class="inline-check parcel-wrap-check">
              <input type="checkbox" name="useWrapping" />
              <span class="check-indicator" aria-hidden="true"></span>
              <span class="check-copy">
                <strong>택배 상자 사용</strong>
                <small>택배 상자를 사용하면 내용물을 숨기고, 거절할 수 없습니다. 상대는 망치로 확인할 수 있습니다.</small>
              </span>
            </label>
            <button type="submit" class="primary-button">소포 보내기</button>
          </form>
        </article>
      </div>
    `,
    todo: `
      <div class="content-grid two todo-layout">
        <article class="content-card">
          <h3>할 일 추가</h3>
          <form id="todo-form" class="stack-form compact-form todo-form">
            <label>
              <span>메모</span>
              <textarea name="todoText" rows="4" maxlength="200" placeholder="간단한 메모를 적어두세요" required></textarea>
            </label>
            <button type="submit" class="primary-button">추가</button>
          </form>
        </article>
        <article class="content-card">
          <h3>할 일 목록</h3>
          <div id="todo-list" class="stack-list">
            <p class="muted">할 일 목록을 불러오는 중입니다.</p>
          </div>
          <div id="todo-pager" class="notification-pager hidden"></div>
        </article>
      </div>
    `,
    roulette: `
      <div class="roulette-layout">
        <article class="content-card roulette-side-card">
          <div class="roulette-side-head">
            <h3>${rouletteDropItemMode && isAdminProfile ? "드랍 아이템 룰렛" : "룰렛 항목"}</h3>
            <form id="roulette-item-form" class="roulette-inline-form">
              <input type="text" name="name" placeholder="항목 이름" required />
              <button type="submit" class="ghost-button compact-button">추가</button>
            </form>
          </div>
          ${
            isAdminProfile
              ? `<label class="inline-check parcel-wrap-check roulette-mode-switch">
                  <input type="checkbox" id="roulette-drop-mode" ${rouletteDropItemMode ? "checked" : ""} />
                  <span class="check-indicator" aria-hidden="true"></span>
                  <span class="check-copy"><strong>드랍 아이템 룰렛</strong><small>아이템 DB 전체를 대상으로 돌립니다.</small></span>
                </label>`
              : ""
          }
          <div id="roulette-item-list" class="roulette-item-list compact-list"><p class="muted">등록된 항목이 없습니다.</p></div>
        </article>
        <article class="content-card roulette-card wide">
          <div class="roulette-stage">
            <div class="roulette-pointer"></div>
            <div id="roulette-wheel" class="roulette-wheel empty-wheel">
              <div id="roulette-wheel-labels" class="roulette-labels">
                <span class="wheel-placeholder">항목을 추가하면 원판이 만들어집니다.</span>
              </div>
            </div>
          </div>
          <button id="roulette-button" type="button" class="primary-button roulette-spin-button">룰렛 돌리기</button>
          <p id="roulette-result" class="muted roulette-result-text">항목을 추가하면 돌릴 수 있습니다.</p>
        </article>
      </div>
      <article class="content-card roulette-log-card">
        <h3>최근 룰렛 결과</h3>
        <div class="table-wrap roulette-log-wrap">
          <table class="log-table">
            <thead><tr><th>시각</th><th>캐릭터명</th><th>결과</th></tr></thead>
            <tbody id="roulette-log-body"><tr><td colspan="3" class="table-empty">아직 로그가 없습니다.</td></tr></tbody>
          </table>
        </div>
      </article>
    `,
    match: `
      <div class="content-grid two">
        ${liveMatchCards}
        <article class="content-card">
          <h3>확장 메모</h3>
          <p>나중에 크롤링 데이터에서 대국중인 항목을 찾고, 그 안의 작혼 닉네임을 캐릭터와 연결해 현재 대국중인 캐릭터 정보를 hover로 보여주는 구조를 염두에 둔 화면입니다.</p>
          <div class="schema-box">
            <strong>추천 컬렉션 구조</strong>
            <p><code>live-matches</code>에 제목, 상태, 플레이어 목록, 작혼 닉네임, 캐릭터명, 대국 메모를 저장하는 방식이 확장에 유리합니다.</p>
          </div>
        </article>
      </div>
    `,
    "match-results": `
      <article class="content-card full">
        <div class="result-mode-tabs">
          <div class="admin-section-tabs">
            <button type="button" class="tab-button ${activeResultMode === "ranked-4p-hanchan" ? "active" : ""}" data-result-mode="ranked-4p-hanchan">4인 반장전</button>
            <button type="button" class="tab-button ${activeResultMode === "ranked-3p-hanchan" ? "active" : ""}" data-result-mode="ranked-3p-hanchan">3인 반장전</button>
          </div>
        </div>
        <div class="table-wrap">
          <table class="log-table">
            <thead>
              <tr>
                <th rowspan="2">Timestamp</th>
                <th colspan="2">1위</th>
                <th colspan="2">2위</th>
                <th colspan="2">3위</th>
                ${isThreePlayerResultMode ? "" : '<th colspan="2">4위</th>'}
              </tr>
              <tr>
                <th>닉네임</th>
                <th>점수</th>
                <th>닉네임</th>
                <th>점수</th>
                <th>닉네임</th>
                <th>점수</th>
                ${isThreePlayerResultMode ? "" : "<th>닉네임</th><th>점수</th>"}
              </tr>
            </thead>
            <tbody id="match-results-body">
              <tr><td colspan="${isThreePlayerResultMode ? 7 : 9}" class="table-empty">대국 결과를 불러오는 중입니다.</td></tr>
            </tbody>
          </table>
        </div>
        <div class="admin-log-pager">
          <button type="button" class="ghost-button compact-button" data-match-page="prev">이전</button>
          <span id="match-results-page-label" class="muted">1 페이지</span>
          <button type="button" class="ghost-button compact-button" data-match-page="next">다음</button>
        </div>
      </article>
    `,
    yacht: renderYachtMenu(profile),
    // traits: `
    //   <article class="content-card full">
    //     <div class="trait-header">
    //       <div>
    //         <h3>특성치</h3>
    //         <p>특성치 시스템 개편 중입니다.</p>
    //       </div>
    //     </div>
    //   </article>
    // `,
    admin: `
      <article class="content-card full">
        <div class="admin-shell">
          <div class="admin-section-tabs">
            <button type="button" class="tab-button ${activeAdminSection === "user-adjust" ? "active" : ""}" data-admin-section="user-adjust">유저 조정</button>
            <button type="button" class="tab-button ${activeAdminSection === "territory-rules" ? "active" : ""}" data-admin-section="territory-rules">영토/정산</button>
            <button type="button" class="tab-button ${activeAdminSection === "items" ? "active" : ""}" data-admin-section="items">아이템</button>
            <button type="button" class="tab-button ${activeAdminSection === "notice" ? "active" : ""}" data-admin-section="notice">공지 작성</button>
            <button type="button" class="tab-button ${activeAdminSection === "account" ? "active" : ""}" data-admin-section="account">계정 관리</button>
            <button type="button" class="tab-button ${activeAdminSection === "ranking-manage" ? "active" : ""}" data-admin-section="ranking-manage">랭킹 관리</button>
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
      shopGrid.innerHTML = '<article class="content-card full"><p class="muted">상점에 등록된 아이템이 없습니다.</p></article>';
      return;
    }

    const pageSize = 10;
    const pageCount = Math.max(1, Math.ceil(shopItems.length / pageSize));
    shopPage = Math.min(shopPage, pageCount - 1);
    const pagedItems = shopItems.slice(shopPage * pageSize, shopPage * pageSize + pageSize);

    shopGrid.innerHTML = `
      <article class="content-card full">
        <div class="shop-list-head">
          <h3>상점</h3>
          <div class="admin-log-pager">
            <button type="button" class="ghost-button compact-button" data-shop-page="prev" ${shopPage === 0 ? "disabled" : ""}>이전</button>
            <span class="muted">${shopPage + 1} / ${pageCount}</span>
            <button type="button" class="ghost-button compact-button" data-shop-page="next" ${shopPage >= pageCount - 1 ? "disabled" : ""}>다음</button>
          </div>
        </div>
        <div class="table-wrap">
          <table class="log-table shop-list-table">
            <thead>
              <tr>
                <th>물품</th>
                <th>이름</th>
                <th>가격</th>
                <th>수량</th>
                <th>구매</th>
              </tr>
            </thead>
            <tbody>
              ${pagedItems
                .map((item) => {
                  const itemMeta = itemDbMap.get(item.id) || {};
                  const mergedItem = normalizeSystemInventoryItemForDisplay({ ...itemMeta, ...item });
                  const tooltip = escapeHtml(mergedItem.description || "설명 없음");
                  return `
                    <tr class="shop-row" data-tooltip="${tooltip}">
                      <td>${renderItemVisual(mergedItem)}</td>
                      <td class="shop-item-name-cell">${escapeHtml(mergedItem.name || "이름 없음")}</td>
                      <td>${Number(item.price || 0)} 환</td>
                      <td>
                        <input type="number" min="1" max="99" value="1" class="shop-quantity-inline" data-shop-quantity="${escapeHtml(item.id)}" />
                      </td>
                      <td>
                        <button type="button" class="primary-button compact-button" data-shop-purchase="${escapeHtml(item.id)}">구매</button>
                      </td>
                    </tr>
                  `;
                })
                .join("")}
            </tbody>
          </table>
        </div>
      </article>
    `;

    shopGrid.querySelectorAll("[data-shop-purchase]").forEach((button) => {
      button.addEventListener("click", async () => {
        const quantityInput = shopGrid.querySelector(`[data-shop-quantity="${button.dataset.shopPurchase}"]`);
        const quantity = Math.max(1, Math.min(99, Number(quantityInput?.value || 1)));
        const shopItem = pagedItems.find((item) => item.id === button.dataset.shopPurchase);
        const shouldPurchase = await openActionConfirmModal({
          titleText: "상점 구매",
          bodyText: `${shopItem?.name || "아이템"} ${quantity}개를 구매하시겠습니까?`,
          confirmText: "구매",
          cancelText: "취소",
          eyebrowText: "구매 확인",
        });
        if (!shouldPurchase) return;
        try {
          button.disabled = true;
          if (quantityInput) quantityInput.disabled = true;
          await withPendingToast(onToast, () => purchaseShopItem(button.dataset.shopPurchase, quantity));
          await onProfilePatched();
          onToast(`아이템을 ${quantity}개 구매했습니다.`);
        } catch (error) {
          onToast(error.message, true);
        } finally {
          button.disabled = false;
          if (quantityInput) quantityInput.disabled = false;
        }
      });
    });

    shopGrid.querySelectorAll("[data-shop-page]").forEach((button) => {
      button.addEventListener("click", async () => {
        const direction = button.dataset.shopPage;
        if (direction === "prev" && shopPage > 0) {
          shopPage -= 1;
        }
        if (direction === "next" && shopPage < pageCount - 1) {
          shopPage += 1;
        }
        await hydrateShopPanel({ onProfilePatched, onToast });
      });
    });
  } catch (_error) {
    shopGrid.innerHTML = '<article class="content-card full"><p class="muted">상점 정보를 불러오지 못했습니다.</p></article>';
  }
}

async function hydrateItemDatabasePanel() {
  const grid = document.querySelector("#item-db-grid");
  if (!grid) return;

  try {
    const itemDbItems = await fetchCollectionItems("item-db", "sortOrder");

    if (!itemDbItems.length) {
      grid.innerHTML = '<article class="content-card full"><p class="muted">아이템 DB에 등록된 아이템이 없습니다.</p></article>';
      return;
    }

    const pageCount = Math.max(1, Math.ceil(itemDbItems.length / itemDbPageSize));
    itemDbPage = Math.min(itemDbPage, pageCount - 1);
    const pagedItems = itemDbItems.slice(itemDbPage * itemDbPageSize, itemDbPage * itemDbPageSize + itemDbPageSize);

    grid.innerHTML = pagedItems
      .map(
        (item) => {
          const displayItem = normalizeSystemInventoryItemForDisplay(item);
          return `
          <article class="content-card item-db-card">
            <div class="item-db-icon">${renderItemVisual(displayItem)}</div>
            <div class="content-meta">
              <h3>${escapeHtml(displayItem.name || "이름 없음")}</h3>
              <p>${escapeHtml(displayItem.description || "설명 없음")}</p>
              <span class="pill-badge">${escapeHtml(normalizeSpriteCategory(displayItem.category || "기타 아이템"))}</span>
            </div>
          </article>
        `;
        }
      )
      .join("");
    grid.insertAdjacentHTML(
      "beforeend",
      `
        <article class="content-card full item-db-pager-card">
          <div class="admin-log-pager">
            <button type="button" class="ghost-button compact-button" data-item-db-page="prev" ${itemDbPage === 0 ? "disabled" : ""}>이전</button>
            <span class="muted">${itemDbPage + 1} / ${pageCount}</span>
            <button type="button" class="ghost-button compact-button" data-item-db-page="next" ${itemDbPage >= pageCount - 1 ? "disabled" : ""}>다음</button>
          </div>
        </article>
      `
    );
    grid.querySelectorAll("[data-item-db-page]").forEach((button) => {
      button.addEventListener("click", async () => {
        const direction = button.dataset.itemDbPage;
        if (direction === "prev" && itemDbPage > 0) itemDbPage -= 1;
        if (direction === "next" && itemDbPage < pageCount - 1) itemDbPage += 1;
        await hydrateItemDatabasePanel();
      });
    });
  } catch (_error) {
    grid.innerHTML = '<article class="content-card full"><p class="muted">아이템 DB를 불러오지 못했습니다.</p></article>';
  }
}

async function hydrateBugReportPanel(profile, onToast) {
  const form = document.querySelector("#bug-report-form");
  if (form && !form.dataset.bound) {
    form.dataset.bound = "true";
    const screenshotInput = form.querySelector('input[name="screenshots"]');
    const preview = document.querySelector("#bug-report-preview");
    let selectedScreenshotFiles = [];

    const renderScreenshotPreview = () => {
      if (!preview) return;
      if (!selectedScreenshotFiles.length) {
        preview.innerHTML = '<p class="muted">첨부된 스크린샷이 없습니다.</p>';
        return;
      }

      preview.innerHTML = selectedScreenshotFiles
        .map((file, index) => {
          const objectUrl = URL.createObjectURL(file);
          return `
            <article class="bug-report-preview-card">
              <img src="${objectUrl}" alt="스크린샷 미리보기" class="bug-report-preview-image" data-bug-report-object-url="${objectUrl}" />
              <button type="button" class="bug-report-preview-remove" data-bug-report-remove="${index}">x</button>
              <strong>${escapeHtml(file.name || `첨부 ${index + 1}`)}</strong>
            </article>
          `;
        })
        .join("");

      preview.querySelectorAll("[data-bug-report-remove]").forEach((button) => {
        button.onclick = () => {
          const index = Number(button.dataset.bugReportRemove);
          if (Number.isNaN(index)) return;
          selectedScreenshotFiles.splice(index, 1);
          renderScreenshotPreview();
        };
      });
    };

    screenshotInput?.addEventListener("change", () => {
      const nextFiles = Array.from(screenshotInput.files || []).filter((file) => file.type.startsWith("image/"));
      const combinedFiles = [...selectedScreenshotFiles, ...nextFiles];
      if (combinedFiles.length > 5) {
        onToast?.("스크린샷은 최대 5장까지 첨부할 수 있습니다.", true);
      }
      selectedScreenshotFiles = combinedFiles.slice(0, 5);
      if (screenshotInput) {
        screenshotInput.value = "";
      }
      renderScreenshotPreview();
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      const payload = Object.fromEntries(formData.entries());
      const title = String(payload.title || "").trim();
      const body = String(payload.body || "").trim();

      if (!title || !body) {
        return;
      }

      const screenshotUrls = [];
      const reportId = buildReportLogId(new Date());
      for (const [index, screenshotFile] of selectedScreenshotFiles.entries()) {
        const screenshotDataUrl = await compressImageFile(screenshotFile, 960);
        const screenshotRef = storageRef(storage, `bug-reports/${profile.uid}/${reportId}_${index + 1}.jpg`);
        await uploadString(screenshotRef, screenshotDataUrl, "data_url");
        screenshotUrls.push(await getDownloadURL(screenshotRef));
      }

      await setDoc(doc(db, "report-logs", reportId), {
        uid: profile.uid,
        characterName: profile.characterName,
        title,
        body,
        screenshotUrls,
        createdAt: serverTimestamp(),
        createdAtText: new Date().toLocaleString("ko-KR"),
      });
      form.reset();
      selectedScreenshotFiles = [];
      renderScreenshotPreview();
      onToast?.("버그 리포트를 등록했습니다.");
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

    label.textContent = `${result.page + 1} 페이지`;
    if (!result.items.length) {
      body.innerHTML = '<tr><td colspan="3" class="table-empty">접수된 버그 리포트가 없습니다.</td></tr>';
    } else {
      body.innerHTML = result.items
        .map((item) => {
          const createdLabel = formatMaybeTimestamp(item.createdAt) || item.createdAtText || "-";
          const detailRowId = `bug-report-detail-${escapeHtml(item.id || item.reportId || createdLabel)}`;
          const screenshotList = Array.isArray(item.screenshotUrls) && item.screenshotUrls.length
            ? item.screenshotUrls
            : item.screenshotUrl
              ? [item.screenshotUrl]
              : [];
          const screenshotHtml = screenshotList.length
            ? `
              <div class="bug-report-screenshot-grid">
                ${screenshotList
                  .map(
                    (url) =>
                      `<img src="${escapeHtml(url)}" alt="버그 리포트 첨부 이미지" class="bug-report-screenshot" />`
                  )
                  .join("")}
              </div>
            `
            : '<p class="muted">첨부된 스크린샷이 없습니다.</p>';
          return `
            <tr>
              <td>
                <button type="button" class="text-button bug-report-toggle" data-bug-report-toggle="${detailRowId}">
                  ${escapeHtml(item.title || "-")}
                </button>
              </td>
              <td>${escapeHtml(item.characterName || "-")}</td>
              <td>${escapeHtml(createdLabel)}</td>
            </tr>
            <tr id="${detailRowId}" class="bug-report-detail-row hidden">
              <td colspan="3">
                <div class="bug-report-detail">
                  <p>${escapeHtml(item.body || "-")}</p>
                  ${screenshotHtml}
                </div>
              </td>
            </tr>
          `;
        })
        .join("");

      body.querySelectorAll("[data-bug-report-toggle]").forEach((button) => {
        button.onclick = () => {
          const targetId = button.dataset.bugReportToggle;
          const detailRow = body.querySelector(`#${CSS.escape(targetId)}`);
          if (!detailRow) return;
          detailRow.classList.toggle("hidden");
        };
      });
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
    body.innerHTML = '<tr><td colspan="3" class="table-empty">버그 리포트를 불러오지 못했습니다.</td></tr>';
  }
}

async function hydrateAdminItemOptions() {
  const selectors = Array.from(document.querySelectorAll("[data-admin-item-selector]"));
  if (!selectors.length) return;

  selectors.forEach((selector) => {
    const trigger = selector.querySelector("[data-item-selector-trigger]");
    const label = selector.querySelector("[data-item-selector-label]");
    const menu = selector.querySelector("[data-item-selector-menu]");
    if (trigger) trigger.disabled = true;
    if (label && !adminItemCatalogCache.length) {
      label.textContent = "아이템을 불러오는 중입니다.";
    }
    if (menu && !adminItemCatalogCache.length) {
      menu.innerHTML = '<div class="item-selector-empty">아이템을 불러오는 중입니다.</div>';
    }
  });

  try {
    const items = await loadAdminItemCatalog();
    adminItemCatalogCache = items;
    refreshAdminItemSelectors({ selectors });
  } catch (_error) {
    adminItemCatalogCache = [];
    selectors.forEach((selector) => {
      const trigger = selector.querySelector("[data-item-selector-trigger]");
      const label = selector.querySelector("[data-item-selector-label]");
      const menu = selector.querySelector("[data-item-selector-menu]");
      if (trigger) trigger.disabled = false;
      if (label) label.textContent = "아이템을 불러오지 못했습니다.";
      if (menu) menu.innerHTML = '<div class="item-selector-empty">아이템을 불러오지 못했습니다.</div>';
    });
  }
}

async function loadAdminItemCatalog(forceRefresh = false) {
  if (!forceRefresh && adminItemCatalogCache.length) {
    return adminItemCatalogCache;
  }

  if (!forceRefresh && adminItemCatalogPromise) {
    return adminItemCatalogPromise;
  }

  adminItemCatalogPromise = fetchCollectionItems("item-db", "sortOrder")
    .then((items) => {
      hydrateCustomSpritesFromItems(items);
      adminItemCatalogCache = items;
      adminItemCatalogPromise = null;
      return items;
    })
    .catch((error) => {
      adminItemCatalogPromise = null;
      throw error;
    });

  return adminItemCatalogPromise;
}

function refreshAdminItemSelectors({ root = document, selectors = null, preferredValues = new Map() } = {}) {
  const targetSelectors = selectors || Array.from(root.querySelectorAll("[data-admin-item-selector]"));
  targetSelectors.forEach((selector) => {
    const trigger = selector.querySelector("[data-item-selector-trigger]");
    if (trigger) trigger.disabled = false;
    const hiddenInput = selector.querySelector("[data-item-selector-input]");
    const preferredValue = preferredValues.get(selector.id);
    const currentValue = String(preferredValue ?? hiddenInput?.value ?? "").trim();
    const nextValue = adminItemCatalogCache.some((item) => item.id === currentValue) ? currentValue : "";
    syncAdminItemSelector(selector, nextValue);
  });
}

function renderAdminItemQueue() {
  const queue = document.querySelector("#admin-item-queue");
  if (!queue) return;

  if (!pendingAdminItemIds.length) {
    queue.innerHTML = '<span class="muted">선택한 아이템이 없습니다.</span>';
    return;
  }

  const itemMap = new Map(adminItemCatalogCache.map((item) => [item.id, item]));

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
          ${escapeHtml(itemMap.get(itemId)?.name || itemId)}${count > 1 ? ` x${count}` : ""} ×
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

async function fetchUserInventoryByCharacterName(characterName) {
  const normalizedName = String(characterName || "").trim();
  if (!normalizedName) return null;
  return getUserInventoryForAdmin(normalizedName);
}

function renderAdminTargetInventoryList(profile, onToast, onProfilePatched) {
  const list = document.querySelector("#admin-target-inventory-list");
  if (!list) return;
  if (!profile) {
    list.classList.add("muted");
    list.textContent = "대상 캐릭터명을 입력한 뒤 조회해 주세요.";
    return;
  }
  const items = Array.isArray(profile.inventory) ? profile.inventory : [];
  if (!items.length) {
    list.classList.add("muted");
    list.textContent = "보유 아이템이 없습니다.";
    return;
  }
  list.classList.remove("muted");
  list.innerHTML = items
    .map((item) => {
      const displayItem = normalizeSystemInventoryItemForDisplay(item);
      return `
        <div class="admin-target-inventory-card inventory-tooltip" data-tooltip="${escapeHtml(buildInventoryTooltipText(displayItem))}">
          ${renderInventoryItemVisual(displayItem)}
          <button type="button" class="ghost-button compact-button danger-button" data-admin-remove-inventory-key="${escapeHtml(buildInventoryItemKey(item))}">제거</button>
        </div>
      `;
    })
    .join("");
  list.querySelectorAll("[data-admin-remove-inventory-key]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const itemKey = button.dataset.adminRemoveInventoryKey || "";
      if (!itemKey) return;
      try {
        button.disabled = true;
        await withPendingToast(onToast, () =>
          adminManageUser({
            targetCharacterName: profile.characterName,
            removeInventoryKeys: [itemKey],
          })
        );
        const updatedProfile = await fetchUserInventoryByCharacterName(profile.characterName);
        renderAdminTargetInventoryList(updatedProfile, onToast, onProfilePatched);
        await renderAdminLogTable("operate");
        onToast("대상 인벤토리에서 아이템을 제거했습니다.");
      } catch (error) {
        onToast(error.message || "아이템 제거에 실패했습니다.", true);
      } finally {
        button.disabled = false;
      }
    });
  });
}

function renderProfileQuickButton({ profile, onProfilePatched, onToast }) {
  const headerActions = document.querySelector(".header-actions");
  if (!headerActions) return;

  let editButton = document.querySelector("#profile-edit-button");
  if (!editButton) {
    editButton = document.createElement("button");
    editButton.id = "profile-edit-button";
    editButton.type = "button";
    editButton.className = "ghost-button";
    editButton.textContent = "회원정보 수정";
    headerActions.prepend(editButton);
  }

  let button = document.querySelector("#profile-quick-button");
  if (!button) {
    button = document.createElement("button");
    button.id = "profile-quick-button";
    button.type = "button";
    button.className = "ghost-button";
    button.textContent = "간단 프로필 보기";
    headerActions.prepend(button);
  }

  button.onclick = async () => {
    await showProfileQuickModal({ profile, viewerProfile: profile, onProfilePatched, onToast });
  };

  editButton.onclick = async () => {
    await openMemberProfileEditModal({ profile, onProfilePatched, onToast });
  };
}

async function showProfileQuickModal({ profile, viewerProfile, onProfilePatched, onToast, preserveContent = false, suppressCardEnter = false }) {
  const modal = ensureProfileQuickModal();
  const content = modal.querySelector("#profile-quick-card");
  const fileInput = modal.querySelector("#profile-seal-input");
  const sealButton = modal.querySelector("#profile-seal-button");
  const closeButton = modal.querySelector("#profile-quick-close");
  const closeIcon = modal.querySelector("#profile-quick-close-icon");
  if (!content || !fileInput || !sealButton || !closeButton || !closeIcon) return;

  modal.classList.remove("hidden");
  if (!preserveContent || !content.innerHTML.trim()) {
    content.innerHTML = '<div class="panel empty-state">간단 프로필을 불러오는 중입니다.</div>';
  }

  hydrateCustomSpritesFromProfile(profile);
  const [rankingBoard] = await Promise.all([
    getCachedRankingBoard().catch(() => ({})),
    preloadQuickProfileImages(profile).catch(() => []),
  ]);
  const normalizedRankings = buildDisplayRankings(rankingBoard?.combinedRankings || []);
  const rankEntry = normalizedRankings.find(
    (item) =>
      item.uid === profile.uid ||
      item.characterName === profile.characterName ||
      item.nickname === profile.nickname
  );
  const isOwnProfile = viewerProfile?.uid && viewerProfile.uid === profile.uid;
  if (!isOwnProfile) profileDecorationEditMode = false;
  const canEditProfileDecorations = Boolean(isOwnProfile && profileDecorationEditMode);
  const factionName = getDisplayedProfileFactionName(profile, isOwnProfile);
  const factionThemeClass = getFactionThemeClass(factionName);
  const profileDecorations = normalizeProfileDecorations(profile.profileDecorations);
  const modalProfileState = {
    profile: {
      ...profile,
      profileDecorations,
    },
    viewerProfile: isOwnProfile
      ? {
          ...(viewerProfile || {}),
          ...profile,
          profileDecorations,
        }
      : viewerProfile || null,
  };
  const inventoryHiddenForViewer = !isOwnProfile && isPublicInventoryHidden(profile);
  const nicknameList = [profile.nickname, ...(Array.isArray(profile.extraNicknames) ? profile.extraNicknames : [])]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const inventoryKinds = buildGroupedInventoryItems(profile.inventory || []);
  const inventorySummary = inventoryHiddenForViewer
    ? '<span class="profile-item-empty">차광포로 비공개 처리되어 있습니다.</span>'
    : inventoryKinds.length
    ? inventoryKinds
        .map(({ item, count }) => {
          const tooltip = escapeHtml(buildInventoryTooltipText(item));
          return `
            <div class="profile-item-chip inventory-tooltip" data-tooltip="${tooltip}">
              ${renderProfileItemVisual(item, { eager: true })}
              ${count > 1 ? `<span class="profile-item-count">x${count}</span>` : ""}
            </div>
          `;
        })
        .join("")
    : '<span class="profile-item-empty">없음</span>';

  content.innerHTML = `
    <div class="profile-card-stage">
      <div class="profile-card-scale-box">
        <div class="profile-card-scale-shell">
          <div class="profile-lobby-card ${suppressCardEnter ? "" : "profile-lobby-card-enter"} ${factionThemeClass}">
        <div class="profile-card-frame profile-card-frame-outer" aria-hidden="true"></div>
        <div class="profile-card-frame profile-card-frame-inner" aria-hidden="true"></div>
        <div class="profile-decoration-layer" data-profile-decoration-layer data-profile-decoration-editable="${canEditProfileDecorations ? "true" : "false"}">
          ${profileDecorations.map((item) => renderProfileDecorationVisual(item, canEditProfileDecorations, { eager: true })).join("")}
        </div>
        <div class="profile-lobby-visual">
          <div class="profile-seal-panel">
            ${
              profile.profileSealImage
                ? `<img src="${escapeHtml(profile.profileSealImage)}" alt="프로필 인장" class="profile-seal-art" loading="eager" fetchpriority="high" decoding="async" />`
                : `<div class="profile-seal-fallback">인장</div>`
            }
          </div>
        </div>
        <div class="profile-lobby-meta">
          <p class="eyebrow">PLAYER LOBBY</p>
          <h2${buildCharacterNameStyleAttribute(profile)}>${buildDisplayedCharacterNameMarkup(profile)}</h2>
          <div class="profile-lobby-grid">
            <div><span>작혼 닉네임</span><strong>${escapeHtml(nicknameList.join(" / ") || "-")}</strong></div>
            <div><span>파벌</span><strong>${escapeHtml(factionName || "미설정")}</strong></div>
            <div><span>현재 랭킹 순위</span><strong>${rankEntry?.displayRank ? `${rankEntry.displayRank}위` : "-"}</strong></div>
            <div><span>랭킹전 포인트</span><strong>${Number(profile.rankingPoints || 0)}</strong></div>
            <div><span>총 대국 수</span><strong>${Number(profile.totalMatches || 0)}</strong></div>
            <div><span>보유 환</span><strong>${Number(profile.currency || 0)} 환</strong></div>
          </div>
          <div class="profile-lobby-traits">
            <span>${isOwnProfile ? "보유 아이템 요약" : inventoryHiddenForViewer ? "공개 인벤토리 비공개 중" : "공개 인벤토리 요약"}</span>
            <div class="profile-item-summary">${inventorySummary}</div>
          </div>
        </div>
          </div>
        </div>
      </div>
    </div>
  `;
  ensureProfileQuickCardScaler(modal);
  applyProfileQuickCardScale(modal);
  profile.profileDecorations = profileDecorations;
  modal.__profileQuickState = modalProfileState;
  bindProfileDecorationEditor({ modal, profile, onProfilePatched, onToast });

  sealButton.classList.toggle("hidden", !isOwnProfile);
  fileInput.classList.add("hidden");
  sealButton.onclick = () => fileInput.click();
  const profileActions = modal.querySelector(".profile-quick-actions");
  profileActions?.querySelector("[data-profile-decoration-edit-toggle]")?.remove();
  profileActions?.querySelector("[data-profile-title-clear]")?.remove();
  if (profileActions && isOwnProfile && !profileActions.querySelector("[data-profile-decoration-edit-toggle]")) {
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = profileDecorationEditMode ? "primary-button" : "ghost-button";
    editButton.dataset.profileDecorationEditToggle = "true";
    editButton.textContent = profileDecorationEditMode ? "꾸미기 편집 종료" : "프로필 꾸미기 편집";
    editButton.addEventListener("click", async () => {
      const nextEditMode = !profileDecorationEditMode;
      profileDecorationEditMode = nextEditMode;
      const latestState = modal.__profileQuickState || {};
      let nextProfile =
        latestState.profile || {
          ...profile,
          profileDecorations: normalizeProfileDecorations(profile.profileDecorations),
        };
      let nextViewerProfile = latestState.viewerProfile || viewerProfile;
      if (!nextEditMode && isOwnProfile) {
        try {
          const refreshedProfile = await refreshCurrentUserProfile();
          if (refreshedProfile) {
            nextProfile = {
              ...refreshedProfile,
              profileDecorations: normalizeProfileDecorations(refreshedProfile.profileDecorations),
            };
            nextViewerProfile = nextProfile;
          }
        } catch {
          // Keep the modal state fallback if the profile refresh fails.
        }
      }
      await showProfileQuickModal({
        profile: nextProfile,
        viewerProfile: nextViewerProfile,
        onProfilePatched,
        onToast,
        preserveContent: true,
        suppressCardEnter: true,
      });
    });
    profileActions.insertBefore(editButton, closeButton);
  }
  if (profileActions && isOwnProfile && String(profile.profileTitle || "").trim()) {
    const clearTitleButton = document.createElement("button");
    clearTitleButton.type = "button";
    clearTitleButton.className = "ghost-button";
    clearTitleButton.dataset.profileTitleClear = "true";
    clearTitleButton.textContent = "칭호 해제";
    clearTitleButton.addEventListener("click", async () => {
      try {
        await withPendingToast(onToast, () => clearProfileTitle());
        invalidateQuickProfileCaches();
        const refreshedProfile = await refreshCurrentUserProfile();
        await onProfilePatched(refreshedProfile);
        await showProfileQuickModal({
          profile: refreshedProfile,
          viewerProfile: refreshedProfile,
          onProfilePatched,
          onToast,
          preserveContent: true,
          suppressCardEnter: true,
        });
        onToast("칭호를 해제하고 아이템으로 돌려보냈습니다.");
      } catch (error) {
        onToast(error.message || "칭호를 해제하지 못했습니다.", true);
      }
    });
    profileActions.insertBefore(clearTitleButton, closeButton);
  }
  fileInput.onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const optimizedDataUrl = await openProfileSealCropModal(file);
      const updatedProfile = await updateProfileSealImage(optimizedDataUrl);
      invalidateQuickProfileCaches();
      await onProfilePatched(updatedProfile);
      onToast("프로필 인장을 저장했습니다.");
      await showProfileQuickModal({ profile: updatedProfile, viewerProfile: updatedProfile, onProfilePatched, onToast });
    } catch (error) {
      if (error.message !== "이미지 선택이 취소되었습니다.") {
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

function applyProfileQuickCardScale(modal) {
  const panel = modal?.querySelector(".profile-quick-modal-panel");
  const content = modal?.querySelector("#profile-quick-card");
  const stage = modal?.querySelector(".profile-card-stage");
  const scaleBox = modal?.querySelector(".profile-card-scale-box");
  const scaleShell = modal?.querySelector(".profile-card-scale-shell");
  const card = modal?.querySelector(".profile-lobby-card");
  const header = modal?.querySelector(".modal-head");
  const actions = modal?.querySelector(".profile-quick-actions");
  if (
    !(panel instanceof HTMLElement) ||
    !(content instanceof HTMLElement) ||
    !(stage instanceof HTMLElement) ||
    !(scaleBox instanceof HTMLElement) ||
    !(scaleShell instanceof HTMLElement) ||
    !(card instanceof HTMLElement) ||
    !(header instanceof HTMLElement) ||
    !(actions instanceof HTMLElement)
  ) return;

  content.style.removeProperty("height");
  scaleShell.style.transform = "scale(1)";
  scaleBox.style.removeProperty("width");
  scaleBox.style.removeProperty("height");

  const naturalWidth = Math.max(1, card.offsetWidth || card.scrollWidth || 836);
  const naturalHeight = Math.max(1, card.offsetHeight || card.scrollHeight || 332);
  const availableWidth = Math.max(1, content.clientWidth);
  const panelStyles = window.getComputedStyle(panel);
  const actionsStyles = window.getComputedStyle(actions);
  const backdropStyles = modal instanceof HTMLElement ? window.getComputedStyle(modal) : null;
  const panelPaddingBlock =
    (parseFloat(panelStyles.paddingTop) || 0) +
    (parseFloat(panelStyles.paddingBottom) || 0);
  const actionsMarginTop = parseFloat(actionsStyles.marginTop) || 0;
  const backdropPaddingBlock = backdropStyles
    ? (parseFloat(backdropStyles.paddingTop) || 0) + (parseFloat(backdropStyles.paddingBottom) || 0)
    : 0;
  const viewportHeight = Math.max(
    1,
    window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight || 0
  );
  const availableHeight = Math.max(
    1,
    viewportHeight -
      backdropPaddingBlock -
      panelPaddingBlock -
      header.offsetHeight -
      actions.offsetHeight -
      actionsMarginTop
  );
  const nextScale = Math.min(1, availableWidth / naturalWidth, availableHeight / naturalHeight);
  const scaledWidth = Math.max(1, Math.floor(naturalWidth * nextScale));
  const scaledHeight = Math.max(1, Math.floor(naturalHeight * nextScale));

  content.style.height = `${scaledHeight}px`;
  scaleBox.style.width = `${scaledWidth}px`;
  scaleBox.style.height = `${scaledHeight}px`;
  scaleShell.style.width = `${naturalWidth}px`;
  scaleShell.style.height = `${naturalHeight}px`;
  scaleShell.style.transform = `translateZ(0) scale(${nextScale})`;
}

function ensureProfileQuickCardScaler(modal) {
  if (modal?.__profileQuickScaleObserver) return;
  const content = modal?.querySelector("#profile-quick-card");
  if (!(content instanceof HTMLElement)) return;
  const observer = new ResizeObserver(() => applyProfileQuickCardScale(modal));
  observer.observe(content);
  modal.__profileQuickScaleObserver = observer;
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
          <h2>간단 프로필</h2>
        </div>
        <button id="profile-quick-close-icon" type="button" class="icon-button">x</button>
      </div>
      <div id="profile-quick-card"></div>
      <div class="profile-quick-actions">
        <input id="profile-seal-input" type="file" accept="image/*" class="hidden" />
        <button id="profile-seal-button" type="button" class="ghost-button">프로필 인장 수정</button>
        <button id="profile-quick-close" type="button" class="primary-button">닫기</button>
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
    throw new Error("자르기 도구를 준비하지 못했습니다.");
  }

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("이미지 자르기를 시작하지 못했습니다.");
  }

  let zoom = 1;
  let offsetX = 0;
  let offsetY = 0;
  const canvasSize = 260;
  canvas.width = canvasSize;
  canvas.height = canvasSize;

  const redraw = () => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#1c1c1f";
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
      reject(new Error("이미지 선택이 취소되었습니다."));
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
          <h2>인장 이미지 자르기</h2>
        </div>
        <button id="profile-seal-crop-close-icon" type="button" class="icon-button">x</button>
      </div>
      <div class="profile-seal-crop-layout">
        <canvas id="profile-seal-crop-canvas" class="profile-seal-crop-canvas"></canvas>
        <div class="stack-form compact-form">
          <label><span>확대</span><input id="profile-seal-crop-zoom" type="range" min="100" max="220" value="100" /></label>
          <label><span>가로 이동</span><input id="profile-seal-crop-offset-x" type="range" min="-100" max="100" value="0" /></label>
          <label><span>세로 이동</span><input id="profile-seal-crop-offset-y" type="range" min="-100" max="100" value="0" /></label>
        </div>
      </div>
      <div class="profile-quick-actions">
        <button id="profile-seal-crop-cancel" type="button" class="ghost-button">취소</button>
        <button id="profile-seal-crop-confirm" type="button" class="primary-button">적용</button>
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
      onToast("메모 내용을 입력해 주세요.", true);
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
      onToast("할 일을 추가했습니다.");
    } catch (error) {
      onToast(error.message || "할 일을 추가하지 못했습니다.", true);
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
      list.innerHTML = '<p class="muted">등록된 할 일이 없습니다.</p>';
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
                  ? `<button type="button" class="ghost-button compact-button todo-delete-button" data-todo-delete="${item.id}">삭제</button>`
                  : ""
              }
            </div>
            <p class="muted">${escapeHtml(item.characterName || "익명")}</p>
          </article>
        `
      )
      .join("");

    pager.innerHTML = `
      <button type="button" class="ghost-button compact-button" data-todo-page="prev" ${todoPage === 0 ? "disabled" : ""}>이전</button>
      <span class="muted">${todoPage + 1} / ${pageCount}</span>
      <button type="button" class="ghost-button compact-button" data-todo-page="next" ${todoPage >= pageCount - 1 ? "disabled" : ""}>다음</button>
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
            '<p class="muted">할 일을 삭제하지 못했습니다.</p>'
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
    list.innerHTML = '<p class="muted">할 일 목록을 불러오지 못했습니다.</p>';
    pager.innerHTML = "";
    pager.classList.add("hidden");
  }
}

async function hydrateRankingPanel() {
  const body4p = document.querySelector("#ranking-table-body-4p");
  const body3p = document.querySelector("#ranking-table-body-3p");
  const dateLabel = document.querySelector("#ranking-date-label");
  const phaseLabel = document.querySelector("#ranking-phase-label");
  if (!body4p || !body3p || !dateLabel || !phaseLabel) return;

  const bindRankingProfileButtons = (root) => {
    root.querySelectorAll("[data-ranking-character]").forEach((button) => {
      button.addEventListener("click", async () => {
        const characterName = button.dataset.rankingCharacter || "";
        if (!characterName) return;
        try {
          const targetProfile = await findProfileByCharacterName(characterName);
          if (!targetProfile) {
            throw new Error("유저 프로필을 찾지 못했습니다.");
          }
          const currentProfile = await refreshCurrentUserProfile();
          await showProfileQuickModal({
            profile: targetProfile,
            viewerProfile: currentProfile,
            onProfilePatched: async (nextProfile = null) => {
              if (nextProfile) {
                await refreshCurrentUserProfile();
              }
            },
            onToast: () => {},
          });
        } catch (_error) {
          root.insertAdjacentHTML(
            "afterbegin",
            '<tr><td colspan="5" class="table-empty">프로필을 불러오지 못했습니다.</td></tr>'
          );
        }
      });
    });
  };

  try {
    let board = await getCachedRankingBoard(false, activeRankingDate);
    const candidateDates = Array.isArray(board?.availableDates) ? board.availableDates : [];
    const selectedDateBeforeRedirect = String(board?.selectedDate || "").trim();
    const currentRegularPeriodKey = String(board?.currentRegularPeriodKey || "").trim();
    const latestDate = String(candidateDates[0] || "").trim();
    const isSameDayRegularPageSelected =
      String(board?.currentPhase || board?.phase || "regular").trim() === "war" &&
      selectedDateBeforeRedirect &&
      currentRegularPeriodKey &&
      selectedDateBeforeRedirect === currentRegularPeriodKey &&
      latestDate &&
      latestDate !== selectedDateBeforeRedirect;
    if (isSameDayRegularPageSelected) {
      activeRankingDate = latestDate;
      board = await getCachedRankingBoard(false, activeRankingDate);
    }
    const selectedDate = String(board?.selectedDate || "").trim();
    const selectedDateLabel = String(board?.selectedDateLabel || "").trim();
    const availableDates = Array.isArray(board?.availableDates) ? board.availableDates : [];
    const scoreUnit = String(board?.scoreUnit || "points").trim();
    const mode4p = buildDisplayRankings(board?.modes?.["ranked-4p-hanchan"]?.rankings || []);
    const mode3p = buildDisplayRankings(board?.modes?.["ranked-3p-hanchan"]?.rankings || []);
    activeRankingDate = selectedDate;
    dateLabel.textContent = selectedDateLabel || formatRankingDateLabel(selectedDate);
    const currentPhase = String(board?.currentPhase || board?.phase || "regular").trim();
    phaseLabel.textContent = currentPhase === "war"
      ? "현재는 쟁탈전 진행 중입니다."
      : "현재는 정규전 진행 중입니다.";

    renderRankingModeTable(body4p, mode4p, scoreUnit);
    renderRankingModeTable(body3p, mode3p, scoreUnit);
    bindRankingProfileButtons(body4p);
    bindRankingProfileButtons(body3p);

    const currentIndex = availableDates.findIndex((item) => item === selectedDate);
    const prevDate = currentIndex >= 0 ? availableDates[currentIndex + 1] || "" : "";
    const nextDate = currentIndex > 0 ? availableDates[currentIndex - 1] || "" : "";
    const prevButton = document.querySelector('[data-ranking-date-nav="prev"]');
    const nextButton = document.querySelector('[data-ranking-date-nav="next"]');
    if (prevButton) {
      prevButton.disabled = !prevDate;
      prevButton.onclick = async () => {
        if (!prevDate) return;
        activeRankingDate = prevDate;
        await hydrateRankingPanel();
      };
    }
    if (nextButton) {
      nextButton.disabled = !nextDate;
      nextButton.onclick = async () => {
        if (!nextDate) return;
        activeRankingDate = nextDate;
        await hydrateRankingPanel();
      };
    }

  } catch (_error) {
    body4p.innerHTML = '<tr><td colspan="5" class="table-empty">랭킹을 불러오지 못했습니다.</td></tr>';
    body3p.innerHTML = '<tr><td colspan="5" class="table-empty">랭킹을 불러오지 못했습니다.</td></tr>';
    dateLabel.textContent = "랭킹을 불러오지 못했습니다.";
    phaseLabel.textContent = "현재 진행 상태를 불러오지 못했습니다.";
  }
}

async function hydrateTerritoryPanel() {
  const map = document.querySelector("#territory-page-map");
  if (!map) return;

  let renderedVersion = "";
  const inMemoryTerritory = rankingBoardCache.data?.territory;
  if (inMemoryTerritory?.cells?.length) {
    renderedVersion = String(inMemoryTerritory.version || "").trim();
    map.innerHTML = buildTerritoryMapMarkup(inMemoryTerritory);
  } else {
    const cachedSnapshot = readCachedTerritorySnapshot();
    if (cachedSnapshot?.territory?.cells?.length) {
      renderedVersion = cachedSnapshot.version;
      map.innerHTML = buildTerritoryMapMarkup(cachedSnapshot.territory);
    }
  }

  try {
    const board = await getCachedRankingBoard(false, activeRankingDate);
    const nextTerritory = board?.territory;
    const nextVersion = String(nextTerritory?.version || "").trim();
    if (!nextTerritory?.cells?.length) {
      if (!renderedVersion) {
        map.innerHTML = buildTerritoryMapMarkup(null);
      }
      return;
    }
    if (nextVersion !== renderedVersion || !renderedVersion) {
      map.innerHTML = buildTerritoryMapMarkup(nextTerritory);
    }
  } catch (_error) {
    if (!renderedVersion) {
      map.innerHTML = buildTerritoryMapMarkup(null);
    }
  }
}

function attachParcelForm({ profile, onProfilePatched, onToast }) {
  const form = document.querySelector("#parcel-form");
  const dropZone = document.querySelector("#parcel-drop-zone");
  const selectedItem = document.querySelector("#parcel-selected-item");
  const clearButton = document.querySelector("#parcel-clear-button");
  const inventoryList = document.querySelector(".inventory-list");
  if (!form) return;
  const chargeToggle = form.querySelector('input[name="useCharge"]');
  const chargeInput = form.querySelector('input[name="chargeAmount"]');
  const chargeField = form.querySelector("[data-parcel-charge-field]");
  const wrapToggle = form.querySelector('input[name="useWrapping"]');

  const inventoryItems = Array.isArray(profile.inventory) ? profile.inventory : [];
  const inventoryByKey = new Map(inventoryItems.map((item) => [buildInventoryItemKey(item), item]));

  const getAvailableItemKeyByGroup = (groupKey) => {
    const matchingKeys = inventoryItems
      .filter((item) => buildInventoryGroupKey(item) === groupKey)
      .map((item) => buildInventoryItemKey(item));

    const selectedCounts = selectedParcelItemKeys.reduce((map, key) => {
      map.set(key, (map.get(key) || 0) + 1);
      return map;
    }, new Map());

    for (const key of matchingKeys) {
      const remaining = (selectedCounts.get(key) || 0) > 0;
      if (!remaining) {
        return key;
      }
      selectedCounts.set(key, selectedCounts.get(key) - 1);
    }

    return "";
  };

  const getAvailableItemByGroup = (groupKey) => {
    const itemKey = getAvailableItemKeyByGroup(groupKey);
    return itemKey ? inventoryByKey.get(itemKey) : null;
  };

  const renderInventoryAvailability = () => {
    if (!inventoryList) return;
    const selectedByGroup = selectedParcelItemKeys.reduce((map, itemKey) => {
      const item = inventoryByKey.get(itemKey);
      const groupKey = buildInventoryGroupKey(item);
      map.set(groupKey, (map.get(groupKey) || 0) + 1);
      return map;
    }, new Map());

    inventoryList.querySelectorAll("[data-inventory-group-key]").forEach((itemNode) => {
      const groupKey = itemNode.dataset.inventoryGroupKey || "";
      const grouped = buildGroupedInventoryItems(inventoryItems).find(
        (entry) => buildInventoryGroupKey(entry.item) === groupKey
      );
      const totalCount = grouped?.count || 0;
      const selectedCount = selectedByGroup.get(groupKey) || 0;
      const remainingCount = Math.max(0, totalCount - selectedCount);
      itemNode.classList.toggle("hidden", remainingCount <= 0);
      const badge = itemNode.querySelector(".inventory-count-badge");
      if (badge) {
        badge.textContent = String(remainingCount);
        badge.classList.toggle("hidden", remainingCount <= 1);
      }
    });
  };

  const renderSelectedParcelItem = () => {
    if (!selectedItem || !dropZone) return;
    const selectedItems = selectedParcelItemKeys
      .map((itemKey) => inventoryByKey.get(itemKey))
      .filter(Boolean);
    if (!selectedItems.length) {
      selectedItem.textContent = "선택한 아이템이 없습니다.";
      selectedItem.classList.add("muted");
      renderInventoryAvailability();
      return;
    }
    const countedItems = Array.from(
      selectedItems.reduce((map, item) => {
        const displayItem = normalizeSystemInventoryItemForDisplay(item);
        const label = displayItem.name || "아이템";
        const existing = map.get(label) || { count: 0, item: displayItem };
        existing.count += 1;
        map.set(label, existing);
        return map;
      }, new Map())
    );
    selectedItem.innerHTML = countedItems
      .map(
        ([label, data]) => `
          <button type="button" class="parcel-selected-chip" data-parcel-remove-group="${escapeHtml(buildInventoryGroupKey(data.item))}">
            <span class="parcel-selected-chip-visual">${renderInventoryItemVisual(data.item)}</span>
            <strong>${escapeHtml(label)}</strong>${data.count > 1 ? ` x${data.count}` : ""}
            <span aria-hidden="true">×</span>
          </button>
        `
      )
      .join("");
    selectedItem.classList.remove("muted");
    selectedItem.querySelectorAll("[data-parcel-remove-group]").forEach((button) => {
      button.addEventListener("click", () => {
        const removeGroup = button.dataset.parcelRemoveGroup || "";
        const removeIndex = selectedParcelItemKeys.findIndex((itemKey) => {
          const item = inventoryByKey.get(itemKey);
          return buildInventoryGroupKey(item) === removeGroup;
        });
        if (removeIndex !== -1) {
          selectedParcelItemKeys.splice(removeIndex, 1);
          renderSelectedParcelItem();
        }
      });
    });
    renderInventoryAvailability();
  };

  const appendSelectedParcelItem = (itemKey) => {
    if (!itemKey) return;
    selectedParcelItemKeys.push(itemKey);
    renderSelectedParcelItem();
  };

  const appendSelectedParcelItemByGroup = (groupKey) => {
    const itemKey = getAvailableItemKeyByGroup(groupKey);
    if (!itemKey) return;
    appendSelectedParcelItem(itemKey);
  };

  document.querySelectorAll("[data-inventory-group-key]").forEach((item) => {
    item.addEventListener("dragstart", (event) => {
      const groupKey = item.dataset.inventoryGroupKey || "";
      const iconNode = item.querySelector(".dot-slot");
      event.dataTransfer?.setData("text/plain", groupKey);
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
      appendSelectedParcelItemByGroup(item.dataset.inventoryGroupKey || "");
    });
  });

  document.querySelectorAll("[data-inventory-use-group-key]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const groupKey = button.dataset.inventoryUseGroupKey || "";
      const availableItem = getAvailableItemByGroup(groupKey);
      if (!availableItem) {
        onToast("사용할 수 있는 아이템이 없습니다.", true);
        return;
      }

      const shouldUse = await confirmInventoryItemUse(availableItem);
      if (!shouldUse) {
        return;
      }

      try {
        const extraData = await requestInventoryItemExtraData(availableItem, profile);
        const result = await withPendingToast(onToast, () =>
          useInventoryItem(buildInventoryItemKey(availableItem), extraData)
        );
        invalidateQuickProfileCaches();
        await onProfilePatched();
        showItemUseResultModal(result);
      } catch (error) {
        if (error?.message !== "아이템 사용이 취소되었습니다.") {
          onToast(error.message, true);
        }
      }
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
    appendSelectedParcelItemByGroup(event.dataTransfer?.getData("text/plain") || "");
  });

  clearButton?.addEventListener("click", () => {
    selectedParcelItemKeys = [];
    renderSelectedParcelItem();
  });

  const syncParcelChargeControls = () => {
    const isWrapped = Boolean(wrapToggle?.checked);
    const useCharge = Boolean(chargeToggle?.checked) && !isWrapped;
    if (isWrapped && chargeToggle) chargeToggle.checked = false;
    if (chargeToggle) chargeToggle.disabled = isWrapped;
    if (chargeInput) {
      chargeInput.disabled = !useCharge;
      if (!useCharge) chargeInput.value = "";
    }
    chargeField?.classList.toggle("is-disabled", !useCharge);
  };

  chargeToggle?.addEventListener("change", syncParcelChargeControls);
  wrapToggle?.addEventListener("change", syncParcelChargeControls);
  syncParcelChargeControls();

  renderSelectedParcelItem();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(form).entries());

    try {
      await withPendingToast(onToast, () =>
        sendParcel({
          targetCharacterName: payload.targetCharacterName,
          itemKeys: selectedParcelItemKeys,
          currencyAmount: normalizeNonNegativeAmount(payload.currencyAmount),
          chargeAmount: payload.useCharge === "on" && payload.useWrapping !== "on" ? normalizeNonNegativeAmount(payload.chargeAmount) : 0,
          useWrapping: payload.useWrapping === "on",
        })
      );
      form.reset();
      selectedParcelItemKeys = [];
      syncParcelChargeControls();
      renderSelectedParcelItem();
      await onProfilePatched();
      onToast(`${profile.characterName}의 소포를 보냈습니다.`);
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
      list.innerHTML = '<p class="muted">확인할 공지가 없습니다.</p>';
      return;
    }

    list.innerHTML = visibleAnnouncements
      .map(
        (announcement) => `
          <article class="info-card">
            <div class="info-card-head">
              <strong>${escapeHtml(announcement.title || "공지")}</strong>
              <button type="button" class="ghost-button compact-button" data-dismiss-announcement="${announcement.id}">닫기</button>
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
          onToast("공지를 닫았습니다.");
        } catch (error) {
          onToast(error.message, true);
        }
      });
    });
  } catch (_error) {
    list.innerHTML = '<p class="muted">공지를 불러오지 못했습니다.</p>';
  }
}

async function renderNotifications({ profile, onToast }) {
  const list = document.querySelector("#notification-list");
  if (!list) return;

  try {
    const notifications = await fetchNotifications(profile.uid, 10);

    if (!notifications.length) {
      list.innerHTML = '<p class="muted">새 알림이 없습니다.</p>';
      return;
    }

    list.innerHTML = notifications
      .map(
        (item) => `
          <article class="info-card ${item.isRead ? "is-read" : "is-unread"}">
            <div class="info-card-head">
              <strong>${escapeHtml(item.message || "알림")}</strong>
              ${
                item.isRead
                  ? '<span class="pill-badge">읽음</span>'
                  : `<button type="button" class="ghost-button compact-button" data-read-notification="${item.id}">읽음 처리</button>`
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
          onToast("알림을 읽음 처리했습니다.");
        } catch (error) {
          onToast(error.message, true);
        }
      });
    });
  } catch (_error) {
    list.innerHTML = '<p class="muted">알림을 불러오지 못했습니다.</p>';
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
      <button id="header-notification-button" type="button" class="notification-bell-button" aria-label="알림 열기">
        <span class="notification-bell-icon" aria-hidden="true">
          <svg viewBox="0 0 32 32">
            <path d="M9 14.2c0-4.2 2.8-7.2 7-7.2s7 3 7 7.2v4.2l2.4 4.1H6.6L9 18.4z"></path>
            <path d="M13.2 23.4c.5 2 1.4 3 2.8 3s2.3-1 2.8-3"></path>
            <path d="M16 4.5v2.2"></path>
          </svg>
        </span>
        <span id="header-notification-badge" class="notification-bell-badge hidden">0</span>
      </button>
      <div id="header-notification-panel" class="notification-panel hidden">
        <div id="header-notification-list" class="stack-list">
          <p class="muted">알림을 불러오는 중입니다.</p>
        </div>
      </div>
    `;
    headerActions.prepend(wrap);
  }

  const button = document.querySelector("#header-notification-button");
  const panel = document.querySelector("#header-notification-panel");
  if (!button || !panel) return;

  const syncPanelPosition = () => {
    if (panel.classList.contains("hidden")) return;
    adjustNotificationPanelPosition(button, panel);
  };

  button.onclick = async () => {
    const shouldOpen = panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !shouldOpen);

    if (shouldOpen) {
      adjustNotificationPanelPosition(button, panel);
      const latestProfile = await refreshCurrentUserProfile().catch(() => profile);
      await markVisibleNotificationsRead(latestProfile);
      await hydrateNotificationBadge(latestProfile);
      notificationPanelPage = 0;
      await renderNotificationBellPanel({ profile: latestProfile, onProfilePatched, onToast });
      adjustNotificationPanelPosition(button, panel);
    }
  };

  if (!wrap.dataset.outsideBound) {
    wrap.dataset.outsideBound = "1";
    document.addEventListener("pointerdown", (event) => {
      const currentPanel = document.querySelector("#header-notification-panel");
      const currentWrap = document.querySelector("#header-notification-wrap");
      if (!currentPanel || !currentWrap || currentPanel.classList.contains("hidden")) return;
      if (event.target instanceof Node && currentWrap.contains(event.target)) return;
      currentPanel.classList.add("hidden");
    });
  }

  window.removeEventListener("resize", syncPanelPosition);
  window.addEventListener("resize", syncPanelPosition);
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
    const hasRejectTicket = hasInventoryItem(profile, (item) => item.name === "반송장");
    const hasHammer = hasInventoryItem(profile, (item) => item.name === "망치");

    const announcementCards = announcements
      .filter((item) => !dismissedIds.has(item.id))
      .map((item) => ({
        id: `announcement-${item.id}`,
        createdAt: getSortTime(item.createdAt),
        html: `
          <article class="info-card compact-info">
            <div class="info-card-head">
              <strong>${escapeHtml(item.title || "공지")}</strong>
              <button type="button" class="ghost-button compact-button" data-dismiss-announcement="${item.id}">닫기</button>
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
              <strong>${escapeHtml(item.message || "알림")}</strong>
            </div>
          </article>
        `,
    }));

    const parcelCards = parcels.map((item) => {
        const itemPreview = item.wrapped && !item.contentRevealed
          ? "택배 상자로 포장되어 내용물을 확인할 수 없습니다."
          : buildParcelDisplayText(item);
        const rejectControl = item.wrapped
          ? hasRejectTicket
            ? `<button type="button" class="ghost-button compact-button" data-parcel-action="reject" data-parcel-id="${item.id}">거절</button>`
            : `<button type="button" class="ghost-button compact-button" data-parcel-action="reject" data-parcel-id="${item.id}" disabled title="반송장이 필요합니다.">거절</button>`
          : `<button type="button" class="ghost-button compact-button" data-parcel-action="reject" data-parcel-id="${item.id}">거절</button>`;
        const revealControl =
          item.wrapped && !item.contentRevealed
            ? `<button type="button" class="ghost-button compact-button" data-parcel-action="reveal" data-parcel-id="${item.id}" ${hasHammer ? "" : "disabled"} title="${hasHammer ? "망치를 소모해 내용물을 확인합니다." : "망치가 필요합니다."}">망치 사용</button>`
            : "";
        const chargeBadge = Number(item.chargeAmount || 0) > 0 ? `<span class="pill-badge">청구 ${Number(item.chargeAmount || 0)}환</span>` : "";
        return {
          id: `parcel-${item.id}`,
          createdAt: getSortTime(item.createdAt),
          parcel: item,
          html: `
          <article class="info-card compact-info ${item.wrapped ? "is-unread" : ""}">
            <div class="info-card-head">
              <strong>${escapeHtml(item.senderCharacterName || "소포")}</strong>
              <span class="pill-badge">${item.wrapped ? "택배 상자" : "일반 소포"}</span>
              ${chargeBadge}
            </div>
            <p>${escapeHtml(itemPreview)}</p>
            <div class="action-row">
              <button type="button" class="primary-button compact-button" data-parcel-action="accept" data-parcel-id="${item.id}">수령</button>
              ${revealControl}
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
            <button type="button" class="ghost-button compact-button" data-notification-page="prev" ${notificationPanelPage === 0 ? "disabled" : ""}>이전</button>
            <span class="muted">${notificationPanelPage + 1} / ${pageCount}</span>
            <button type="button" class="ghost-button compact-button" data-notification-page="next" ${notificationPanelPage >= pageCount - 1 ? "disabled" : ""}>다음</button>
          </div>
        `
      : '<p class="muted">새 알림이 없습니다.</p>';

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
        if (button.disabled) return;
        const action = button.dataset.parcelAction || "";
        const parcelId = button.dataset.parcelId || "";
        const parcel = parcels.find((item) => item.id === parcelId) || null;
        const shouldProceed = await confirmParcelAction(action, parcel);
        if (!shouldProceed) return;
        try {
          await withPendingToast(onToast, () =>
            respondParcel(parcelId, action)
          );
          const latestProfile = await refreshCurrentUserProfile().catch(() => profile);
          await onProfilePatched(latestProfile);
          await hydrateNotificationBadge(latestProfile);
          await renderNotificationBellPanel({ profile: latestProfile, onProfilePatched, onToast });
          onToast(formatParcelActionToast(action));
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
    list.innerHTML = '<p class="muted">알림을 불러오지 못했습니다.</p>';
  }
}

function adjustNotificationPanelPosition(button, panel) {
  const margin = 16;
  const buttonRect = button.getBoundingClientRect();
  const panelWidth = Math.min(360, Math.max(280, window.innerWidth - margin * 2));

  panel.style.position = "fixed";
  panel.style.width = `${panelWidth}px`;
  panel.style.maxWidth = `calc(100vw - ${margin * 2}px)`;
  panel.style.top = `${Math.min(window.innerHeight - margin - 120, buttonRect.bottom + 10)}px`;

  let left = buttonRect.right - panelWidth;
  if (window.innerWidth <= 900) {
    left = Math.min(buttonRect.left, window.innerWidth - margin - panelWidth);
  }
  left = Math.max(margin, Math.min(left, window.innerWidth - margin - panelWidth));
  panel.style.left = `${left}px`;
  panel.style.right = "auto";
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
      list.innerHTML = '<p class="muted">받은 소포가 없습니다.</p>';
      return;
    }

    list.innerHTML = snapshot.docs
      .map((parcelDoc) => {
        const data = parcelDoc.data();
        const hasRejectTicket = hasInventoryItem(profile, (item) => item.name === "반송장");
        const hasHammer = hasInventoryItem(profile, (item) => item.name === "망치");
        const itemLabel = escapeHtml(data.wrapped && !data.contentRevealed ? "택배 상자로 포장되어 내용물을 확인할 수 없습니다." : buildParcelDisplayText(data));
        const revealControl =
          data.wrapped && !data.contentRevealed
            ? `<button type="button" class="ghost-button compact-button" data-parcel-action="reveal" data-parcel-id="${parcelDoc.id}" ${hasHammer ? "" : "disabled"}>망치 사용</button>`
            : "";
        const rejectControl = data.wrapped
          ? `<button type="button" class="ghost-button compact-button" data-parcel-action="reject" data-parcel-id="${parcelDoc.id}" ${hasRejectTicket ? "" : "disabled"}>거절</button>`
          : `<button type="button" class="ghost-button compact-button" data-parcel-action="reject" data-parcel-id="${parcelDoc.id}">거절</button>`;
        const chargeBadge = Number(data.chargeAmount || 0) > 0 ? `<span class="pill-badge">청구 ${Number(data.chargeAmount || 0)}환</span>` : "";
        return `
          <article class="info-card">
            <div class="info-card-head">
              <strong>${escapeHtml(data.senderCharacterName || "-")}</strong>
              <span class="pill-badge">${escapeHtml(data.status || "-")}</span>
              ${chargeBadge}
            </div>
            <p>${itemLabel}</p>
            <p>${data.wrapped ? "택배 상자" : "일반 소포"}</p>
            ${
              data.status === "pending"
                ? `
                  <div class="action-row">
                    <button type="button" class="primary-button compact-button" data-parcel-action="accept" data-parcel-id="${parcelDoc.id}">수령</button>
                    ${revealControl}
                    ${rejectControl}
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
        if (button.disabled) return;
        const action = button.dataset.parcelAction || "";
        const parcelId = button.dataset.parcelId || "";
        const parcelCard = snapshot.docs.find((entry) => entry.id === parcelId);
        const parcel = parcelCard ? { id: parcelCard.id, ...parcelCard.data() } : null;
        const shouldProceed = await confirmParcelAction(action, parcel);
        if (!shouldProceed) return;
        try {
          await withPendingToast(onToast, () =>
            respondParcel(parcelId, action)
          );
          await onProfilePatched();
          onToast(formatParcelActionToast(action));
        } catch (error) {
          onToast(error.message, true);
        }
      });
    });
  } catch (_error) {
    list.innerHTML = '<p class="muted">받은 소포를 불러오지 못했습니다.</p>';
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
      list.innerHTML = '<p class="muted">보낸 소포가 없습니다.</p>';
      return;
    }

    list.innerHTML = snapshot.docs
      .map((parcelDoc) => {
        const data = parcelDoc.data();
        const itemLabel = escapeHtml(buildParcelDisplayText(data));
        const currencyLabel = Number(data.currencyAmount || 0)
          ? `환 ${Number(data.currencyAmount || 0)}`
          : "환 없음";
        return `
          <article class="info-card">
            <div class="info-card-head">
              <strong>${escapeHtml(data.receiverCharacterName || "-")}</strong>
              <span class="pill-badge">${escapeHtml(formatParcelStatus(data.status))}</span>
            </div>
            <p>${itemLabel}${Number(data.currencyAmount || 0) ? ` / ${currencyLabel}` : ""}</p>
            <p>${data.wrapped ? "포장 소포" : "일반 소포"}</p>
          </article>
        `;
      })
      .join("");
  } catch (_error) {
    list.innerHTML = '<p class="muted">보낸 소포를 불러오지 못했습니다.</p>';
  }
}

// async function hydrateTraitPanel({ profile, onProfilePatched, onToast }) {
//   특성치 시스템 개편 전까지 임시 비활성화
// }

function attachRouletteEvents({ profile, onToast }) {
  const form = document.querySelector("#roulette-item-form");
  const button = document.querySelector("#roulette-button");
  const result = document.querySelector("#roulette-result");
  const wheel = document.querySelector("#roulette-wheel");
  const dropModeInput = document.querySelector("#roulette-drop-mode");
  if (!form || !button || !result || !wheel) return;
  const isDropModeAvailable = adminRoles.includes(profile.role);

  if (dropModeInput && !dropModeInput.dataset.rouletteBound) {
    dropModeInput.dataset.rouletteBound = "1";
    dropModeInput.addEventListener("change", async () => {
      rouletteDropItemMode = Boolean(dropModeInput.checked);
      await hydrateRoulettePanel(profile);
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (rouletteDropItemMode && isDropModeAvailable) return;
    const payload = Object.fromEntries(new FormData(form).entries());
    const name = String(payload.name || "").trim();

    if (!name) {
      onToast("항목 이름을 입력해 주세요.", true);
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
      onToast("룰렛 항목을 추가했습니다.");
    } catch (_error) {
      onToast("룰렛 항목 추가에 실패했습니다.", true);
    }
  });

  button.addEventListener("click", async () => {
    const isDropMode = rouletteDropItemMode && isDropModeAvailable;
    const items = isDropMode ? await fetchDropRouletteItems() : await fetchRouletteItems(profile.uid);

    if (!items.length) {
      onToast(isDropMode ? "아이템 DB에 등록된 아이템이 없습니다." : "먼저 룰렛 항목을 추가해 주세요.", true);
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
    result.textContent = "룰렛을 돌리는 중입니다.";

    window.setTimeout(async () => {
      if (isDropMode) {
        renderDropRouletteResult(result, reward, onToast);
      } else {
        result.textContent = reward.name;
      }
      try {
        const attemptedAt = new Date();
        const logId = buildRouletteLogId(attemptedAt, profile.characterName);
        await setDoc(doc(db, "roulette-logs", logId), {
          uid: profile.uid,
          characterName: profile.characterName,
          loginId: profile.loginId,
          rewardName: reward.name,
          rewardDescription: "",
          rewardType: isDropMode ? "drop-item" : "roulette",
          rewardItemId: isDropMode ? reward.id : "",
          createdAt: serverTimestamp(),
          createdAtText: attemptedAt.toLocaleString("ko-KR"),
          attemptedAtId: logId,
        });
        await renderRecentRouletteLogs();
        onToast("룰렛 로그를 저장했습니다.");
      } catch (_error) {
        onToast("룰렛 로그 저장에 실패했습니다.", true);
      } finally {
        button.disabled = false;
      }
    }, 3400);
  });
}

async function hydrateRoulettePanel(profile) {
  const isDropMode = rouletteDropItemMode && adminRoles.includes(profile.role);
  const items = isDropMode ? await fetchDropRouletteItems() : await fetchRouletteItems(profile.uid);
  resetRoulettePanel();
  const title = document.querySelector(".roulette-side-head h3");
  if (title) title.textContent = isDropMode ? "드랍 아이템 룰렛" : "룰렛 항목";
  renderRouletteItemList(items, profile, { dropMode: isDropMode });
  renderRouletteWheel(items);
  await renderRecentRouletteLogs();
}

async function fetchDropRouletteItems() {
  return (await fetchCollectionItems("item-db", "sortOrder")).map((item) => ({
    ...normalizeSystemInventoryItemForDisplay(item),
    id: item.id,
  }));
}

function renderDropRouletteResult(result, reward, onToast) {
  const displayItem = normalizeSystemInventoryItemForDisplay(reward);
  result.innerHTML = `
    <span class="roulette-drop-result-name">${escapeHtml(displayItem.name || "아이템")}</span>
  `;
  openDropRouletteTransferModal(reward, onToast);
}

function openDropRouletteTransferModal(reward, onToast) {
  const displayItem = normalizeSystemInventoryItemForDisplay(reward);
  const modal = ensureDropRouletteTransferModal();
  const title = modal.querySelector("#drop-roulette-transfer-title");
  const form = modal.querySelector("#drop-roulette-transfer-form");
  const cancelButton = modal.querySelector("#drop-roulette-transfer-cancel");
  const closeButton = modal.querySelector("#drop-roulette-transfer-close");
  if (!title || !form || !cancelButton || !closeButton) return;
  title.textContent = `${displayItem.name || "아이템"} 전송`;
  form.reset();
  modal.classList.remove("hidden");
  const close = () => modal.classList.add("hidden");
  cancelButton.onclick = close;
  closeButton.onclick = close;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const targetCharacterName = String(new FormData(form).get("targetCharacterName") || "").trim();
    if (!targetCharacterName) {
      onToast("전송 대상 캐릭터명을 입력해 주세요.", true);
      return;
    }
    const submitButton = modal.querySelector('button[form="drop-roulette-transfer-form"]');
    if (submitButton) submitButton.disabled = true;
    try {
      await withPendingToast(onToast, () =>
        adminManageUser({
          targetCharacterName,
          addItemIds: [String(reward.id || "").trim()],
        })
      );
      onToast(`${targetCharacterName}님에게 ${displayItem.name || "아이템"}을(를) 전송했습니다.`);
      close();
    } catch (_error) {
      onToast("드랍 아이템 전송에 실패했습니다.", true);
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  };
}

function ensureDropRouletteTransferModal() {
  let modal = document.querySelector("#drop-roulette-transfer-modal");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "drop-roulette-transfer-modal";
  modal.className = "modal-backdrop hidden";
  modal.innerHTML = `
    <div class="modal-panel inventory-use-prompt-panel">
      <div class="modal-head">
        <div>
          <p class="eyebrow">DROP ITEM</p>
          <h2 id="drop-roulette-transfer-title">아이템 전송</h2>
          <p class="muted">룰렛 결과 아이템을 받을 캐릭터명을 입력해 주세요.</p>
        </div>
        <button id="drop-roulette-transfer-close" type="button" class="icon-button">x</button>
      </div>
      <form id="drop-roulette-transfer-form" class="stack-form compact-form">
        <label><span>전송 대상</span><input type="text" name="targetCharacterName" placeholder="캐릭터명" required /></label>
      </form>
      <div class="notice-modal-actions">
        <button form="drop-roulette-transfer-form" type="submit" class="primary-button">전송</button>
        <button id="drop-roulette-transfer-cancel" type="button" class="ghost-button">취소</button>
      </div>
    </div>
  `;
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.classList.add("hidden");
  });
  document.body.append(modal);
  return modal;
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
    labels.innerHTML = `<span class="wheel-placeholder">${rouletteDropItemMode ? "아이템 DB를 불러오면 원판이 만들어집니다." : "항목을 추가하면 원판이 만들어집니다."}</span>`;
    result.textContent = rouletteDropItemMode ? "아이템 DB를 불러오면 돌릴 수 있습니다." : "항목을 추가하면 돌릴 수 있습니다.";
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

  if (items.length > 72) {
    labels.innerHTML = `<span class="wheel-placeholder">아이템 ${items.length}개</span>`;
    return;
  }

  labels.innerHTML = items
    .map((item, index) => {
      const angle = index * sliceAngle + sliceAngle / 2;
      const translateY = Math.max(112, 150 - Math.min(items.length, 10) * 3);
      const width = Math.max(78, Math.min(126, 220 / Math.max(items.length, 2)));
      const fontSize = sliceAngle < 32 ? 11 : sliceAngle < 45 ? 12 : 13;
      return `<span style="width:${width}px;margin-left:${-width / 2}px;font-size:${fontSize}px;transform: rotate(${angle}deg) translateY(-${translateY}px) rotate(-${angle}deg);">${escapeHtml(item.name)}</span>`;
    })
    .join("");
}

function renderRouletteItemList(items, profile, { dropMode = false } = {}) {
  const itemList = document.querySelector("#roulette-item-list");
  const form = document.querySelector("#roulette-item-form");
  if (!itemList) return;
  if (form) form.classList.toggle("hidden", dropMode);

  if (!items.length) {
    itemList.innerHTML = `<p class="muted">${dropMode ? "아이템 DB에 등록된 아이템이 없습니다." : "등록된 룰렛 항목이 없습니다."}</p>`;
    return;
  }

  if (dropMode) {
    itemList.innerHTML = `
      <p class="muted">아이템 DB ${items.length}개가 드랍 후보입니다.</p>
      ${items
        .slice(0, 80)
        .map(
          (item) => `
            <div class="roulette-item-row">
              <strong>${escapeHtml(item.name || item.id || "아이템")}</strong>
            </div>
          `
        )
        .join("")}
      ${items.length > 80 ? `<p class="muted">외 ${items.length - 80}개</p>` : ""}
    `;
    return;
  }

  itemList.innerHTML = items
    .map(
      (item) => `
        <div class="roulette-item-row">
          <strong>${escapeHtml(item.name)}</strong>
          <button type="button" class="ghost-button compact-button" data-roulette-remove="${item.id}">삭제</button>
        </div>
      `
    )
    .join("");

  itemList.querySelectorAll("[data-roulette-remove]").forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest(".roulette-item-row");
      const rewardName = row?.querySelector("strong")?.textContent?.trim() || "룰렛 항목";
      const shouldDelete = await openActionConfirmModal({
        titleText: "룰렛 항목 삭제",
        bodyText: `${rewardName} 항목을 삭제하시겠습니까?`,
        confirmText: "삭제",
        cancelText: "취소",
        eyebrowText: "삭제 확인",
      });
      if (!shouldDelete) return;
      try {
        await withPendingToast(
          (message, isError = false) => {
            const result = document.querySelector("#roulette-result");
            if (result) {
              result.textContent = isError ? message : "처리중입니다";
            }
          },
          () => deleteDoc(doc(db, "roulette-items", button.dataset.rouletteRemove))
        );
        await hydrateRoulettePanel(profile);
      } catch (_error) {
        const result = document.querySelector("#roulette-result");
        if (result) result.textContent = "룰렛 항목 삭제에 실패했습니다.";
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
      logBody.innerHTML = '<tr><td colspan="3" class="table-empty">아직 로그가 없습니다.</td></tr>';
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
    logBody.innerHTML = '<tr><td colspan="3" class="table-empty">로그를 불러오지 못했습니다.</td></tr>';
  }
}

function hydrateAdminPanel({ onProfilePatched, onToast }) {
  const body = document.querySelector("#admin-section-body");
  if (!body) return;

  if (activeAdminSection === "random-box") {
    activeAdminSection = "items";
    activeAdminItemSection = "random-box";
  }

  renderAdminSection(body);
  if (activeAdminSection === "items") {
    renderAdminItemSection();
    if (activeAdminItemSection === "random-box") {
      void renderAdminRandomBoxSection({ onProfilePatched, onToast });
    }
  }
  if (activeAdminSection === "territory-rules") {
    void renderAdminTerritorySettings({ onProfilePatched, onToast });
  }
  if (activeAdminSection === "ranking-manage") {
    attachAdminRankingManageEvents({ onToast });
  }

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
          <h3>유저 조정</h3>
          <form id="admin-manage-form" class="stack-form compact-form admin-manage-grid">
            <div class="admin-wide-field">
              <label class="inline-check parcel-wrap-check admin-toggle-check">
                <input type="checkbox" name="applyToAllUsers" />
                <span class="check-indicator" aria-hidden="true"></span>
                <span class="check-copy">
                  <strong>전체 유저 대상</strong>
                  <small>체크하면 모든 유저에게 같은 조정을 적용합니다.</small>
                </span>
              </label>
            </div>
            <label><span>대상 캐릭터명</span><input type="text" name="targetCharacterName" placeholder="캐릭터명" required /></label>
            <label><span>환 증감</span><input type="number" name="currencyDelta" value="0" /></label>
            <!-- 특성치 시스템은 개편 전까지 운영진 조정에서 제외 -->
            <label>
              <span>지급 아이템 선택</span>
              ${buildAdminItemSelector({ inputName: "addItemId", selectorId: "admin-item-select", placeholder: "아이템을 선택하세요" })}
            </label>
            <div class="admin-item-picker-row">
              <button type="button" class="ghost-button" id="admin-add-item-button">아이템 추가</button>
              <div id="admin-item-queue" class="admin-item-queue"></div>
            </div>
            <div class="admin-target-inventory-box">
              <div class="admin-target-inventory-head">
                <span>대상 인벤토리</span>
                <button type="button" class="ghost-button compact-button" id="admin-load-target-inventory">인벤토리 조회</button>
              </div>
              <div id="admin-target-inventory-list" class="admin-target-inventory-list muted">대상 캐릭터명을 입력한 뒤 조회해 주세요.</div>
            </div>
            <label>
              <span>권한 변경</span>
              ${buildAdminOptionSelector({
                inputName: "setRole",
                selectorId: "admin-user-role-select",
                selectedValue: "",
                placeholder: "변경 안 함",
                options: [
                  { value: "", label: "변경 안 함", description: "현재 권한 유지" },
                  { value: "user", label: "user", description: "일반 회원" },
                  { value: "admin", label: "admin", description: "최고 권한" },
                ],
              })}
            </label>
            <button type="submit" class="primary-button">적용</button>
          </form>
        </article>
        <article class="content-card">
          <div class="admin-log-head">
            <h3>유저 조정 로그</h3>
            <div class="admin-log-pager">
              <button type="button" class="ghost-button compact-button" data-log-page="operate-prev">이전</button>
              <span id="operate-log-page-label" class="muted">1 페이지</span>
              <button type="button" class="ghost-button compact-button" data-log-page="operate-next">다음</button>
            </div>
          </div>
          <div class="table-wrap">
            <table class="log-table">
              <thead>
                <tr><th>시각</th><th>운영진</th><th>대상</th><th>내용</th></tr>
              </thead>
              <tbody id="operate-log-body">
                <tr><td colspan="4" class="table-empty">로그를 불러오는 중입니다.</td></tr>
              </tbody>
            </table>
          </div>
        </article>
      </div>
    `,
    "territory-rules": `
      <div class="admin-section-grid">
        <article class="content-card full">
          <div id="admin-territory-settings-body" class="stack-form compact-form">
            <p class="muted">영토 운영 설정을 불러오는 중입니다.</p>
          </div>
        </article>
      </div>
    `,
    items: `
      <div class="admin-section-grid">
        <article class="content-card full">
          <div class="admin-section-tabs admin-subtabs">
            <button type="button" class="tab-button ${activeAdminItemSection === "create" ? "active" : ""}" data-admin-item-section="create">아이템 추가</button>
            <button type="button" class="tab-button ${activeAdminItemSection === "edit" ? "active" : ""}" data-admin-item-section="edit">아이템 수정</button>
            <button type="button" class="tab-button ${activeAdminItemSection === "random-box" ? "active" : ""}" data-admin-item-section="random-box">랜덤박스</button>
            <button type="button" class="tab-button ${activeAdminItemSection === "delete" ? "active" : ""}" data-admin-item-section="delete">아이템 삭제</button>
          </div>
          <div id="admin-item-section-body"></div>
        </article>
      </div>
    `,
    notice: `
      <div class="admin-section-grid">
        <article class="content-card">
          <h3>공지 작성</h3>
          <form id="announcement-form" class="stack-form compact-form">
            <label><span>공지 제목</span><input type="text" name="title" placeholder="공지 제목" required /></label>
            <label><span>공지 내용</span><textarea name="body" rows="6" placeholder="닫기를 누르면 유저별로 1회만 사라지는 공지" required></textarea></label>
            <button type="submit" class="primary-button">공지 등록</button>
          </form>
        </article>
        <article class="content-card">
          <div class="admin-log-head">
            <h3>공지 로그</h3>
            <div class="admin-log-pager">
              <button type="button" class="ghost-button compact-button" data-log-page="notice-prev">이전</button>
              <span id="notice-log-page-label" class="muted">1 페이지</span>
              <button type="button" class="ghost-button compact-button" data-log-page="notice-next">다음</button>
            </div>
          </div>
          <div class="table-wrap">
            <table class="log-table">
              <thead>
                <tr><th>시각</th><th>제목</th><th>작성자</th></tr>
              </thead>
              <tbody id="notice-log-body">
                <tr><td colspan="3" class="table-empty">로그를 불러오는 중입니다.</td></tr>
              </tbody>
            </table>
          </div>
        </article>
      </div>
    `,
    account: `
      <div class="admin-section-grid">
        <article class="content-card">
          <h3>계정 삭제</h3>
          <form id="admin-delete-form" class="stack-form compact-form">
            <label><span>삭제 대상 캐릭터명</span><input type="text" name="characterName" placeholder="캐릭터명" required /></label>
            <button type="submit" class="ghost-button danger-button">계정 삭제</button>
          </form>
        </article>
      </div>
    `,
    "ranking-manage": `
      <div class="admin-section-grid">
        <article class="content-card">
          <h3>날짜별 랭킹 박제</h3>
          <p class="muted">해당 날짜 23:59 기준 랭킹을 영구 저장합니다. 이후 그 날짜를 조회하면 박제된 데이터를 표시합니다.</p>
          <form id="ranking-snapshot-form" class="stack-form compact-form">
            <label><span>박제할 날짜</span><input type="date" name="dateKey" required /></label>
            <button type="submit" class="primary-button">랭킹 박제</button>
          </form>
        </article>
        <article class="content-card">
          <h3>박제 데이터 초기화</h3>
          <p class="muted">오늘 이전 날짜의 랭킹 박제 데이터를 전부 삭제합니다.</p>
          <button type="button" id="clear-past-matches-button" class="ghost-button danger-button">박제 데이터 삭제</button>
        </article>
      </div>
    `,
  };

  body.innerHTML = sections[activeAdminSection] || sections["user-adjust"];
}

function buildRandomBoxConfigMarkup(prefix) {
  return `
    <div class="random-box-config" data-random-box-config>
      <input type="hidden" name="randomBoxRewardItemIds" value="[]" data-random-box-reward-input />
      <div class="stack-form compact-form random-box-config-body">
        <div class="auto-category-badge-row">
          <span>랜덤박스 보상</span>
          <div class="auto-category-actions">
            <strong data-random-box-type-label>랜덤박스 아님</strong>
          </div>
        </div>
        <p class="muted random-box-config-hint" data-random-box-hint>아이템 이름이 랜덤박스 3종 중 하나일 때만 실제로 사용됩니다.</p>
        <label>
          <span>보상 아이템 선택</span>
          ${buildAdminItemSelector({ inputName: `${prefix}RandomBoxRewardCandidate`, selectorId: `${prefix}-random-box-reward-select`, placeholder: "보상 아이템을 선택하세요" })}
        </label>
        <div class="random-box-config-actions">
          <button type="button" class="ghost-button compact-button" data-random-box-add-button>보상 추가</button>
        </div>
        <div class="random-box-reward-list muted" data-random-box-reward-list>등록된 보상이 없습니다.</div>
      </div>
    </div>
  `;
}

function buildRandomBoxAdminCardMarkup({ name, typeLabel }, index) {
  return `
    <div class="stack-form compact-form content-card random-box-admin-card" data-random-box-admin-form data-random-box-name="${escapeHtml(name)}">
      <input type="hidden" name="itemId" value="" data-random-box-item-id />
      <input type="hidden" name="randomBoxRewardItemIds" value="[]" data-random-box-reward-input />
      <div class="random-box-admin-head">
        <div>
          <strong>${escapeHtml(name)}</strong>
          <p class="muted">${escapeHtml(typeLabel)} 랜덤박스에서 나올 보상을 정합니다.</p>
        </div>
      </div>
      <label>
        <span>보상 아이템 선택</span>
        <div data-random-box-add-selector>
          ${buildAdminItemSelector({ inputName: `adminRandomBoxRewardCandidate${index}`, selectorId: `admin-random-box-reward-select-${index}`, placeholder: "보상 아이템을 선택하세요" })}
        </div>
      </label>
      <div class="random-box-config-actions">
        <button type="button" class="ghost-button compact-button" data-random-box-add-button>보상 추가</button>
      </div>
      <label>
        <span>현재 등록된 보상</span>
        <div data-random-box-remove-selector>
          ${buildAdminItemSelector({ inputName: `adminRandomBoxRewardRemove${index}`, selectorId: `admin-random-box-reward-remove-${index}`, placeholder: "등록된 보상 중에서 선택하세요" })}
        </div>
      </label>
      <div class="random-box-config-actions">
        <button type="button" class="ghost-button compact-button danger-button" data-random-box-remove-button>선택 보상 제거</button>
      </div>
      <div class="random-box-reward-list muted" data-random-box-reward-list>등록된 보상이 없습니다.</div>
    </div>
  `;
}

function renderAdminItemSection() {
  const body = document.querySelector("#admin-item-section-body");
  if (!body) return;

  const sections = {
    create: `
      <form id="admin-item-form" class="stack-form compact-form">
        <label><span>아이템 이름</span><input type="text" name="name" placeholder="예: 결투권" required /></label>
        <label>
          <span>도트 선택</span>
          ${buildItemSpritePicker({ pickerId: "admin-item-create-picker" })}
        </label>
        <label class="custom-dot-upload">
          <span>도트 이미지 추가</span>
          <input type="file" accept="image/png,image/gif,image/webp,image/jpeg" data-custom-sprite-upload />
          <strong data-custom-dot-label>파일 선택</strong>
          <small class="muted">PNG/GIF/WEBP/JPEG, 512KB 이하</small>
        </label>
        <div class="item-color-preset-row">
          <span>도트 색상</span>
          <input type="hidden" name="colorPreset" value="" />
          <div class="item-color-preset-list" data-color-preset-list>${buildItemColorPresetButtons()}</div>
        </div>
        <input type="hidden" name="category" value="기타" />
        <div class="auto-category-badge-row">
          <span>자동 카테고리</span>
          <div class="auto-category-actions">
            <strong data-sprite-category-display>기타</strong>
            <button type="button" class="ghost-button compact-button" data-category-edit-toggle>카테고리 수정</button>
          </div>
        </div>
        <label class="hidden" data-category-edit-row>
          <span>카테고리 수정</span>
          ${buildAdminOptionSelector({
            inputName: "categoryOverride",
            selectorId: "admin-item-create-category-override",
            selectedValue: "기타 아이템",
            placeholder: "카테고리를 선택하세요",
            options: buildCategoryOverrideOptions(),
          })}
        </label>
        <label><span>설명</span><textarea name="description" rows="4" placeholder="아이템 설명"></textarea></label>
        <label class="hidden" data-food-reward-row>
          <span>음용 시 추가 환</span>
          <input type="number" min="0" step="1" name="foodCurrencyReward" value="0" />
        </label>
        <label class="item-shop-toggle">
          <input type="checkbox" name="sellInShop" />
          <span class="item-shop-toggle-box" aria-hidden="true"></span>
          <span>상점에 등록</span>
        </label>
        <label data-shop-price-row><span>상점 가격</span><input type="number" min="0" name="price" value="0" /></label>
        <button type="submit" class="primary-button">아이템 등록</button>
      </form>
    `,
    edit: `
      <form id="admin-item-edit-form" class="stack-form compact-form">
        <label>
          <span>수정 대상 아이템</span>
          ${buildAdminItemSelector({ inputName: "itemId", selectorId: "admin-item-edit-select", placeholder: "아이템을 선택하세요" })}
        </label>
        <label><span>아이템 이름</span><input type="text" name="name" placeholder="예: 결투권" required /></label>
        <label>
          <span>도트 선택</span>
          ${buildItemSpritePicker({ pickerId: "admin-item-edit-picker" })}
        </label>
        <label class="custom-dot-upload">
          <span>도트 이미지 추가</span>
          <input type="file" accept="image/png,image/gif,image/webp,image/jpeg" data-custom-sprite-upload />
          <strong data-custom-dot-label>파일 선택</strong>
          <small class="muted">PNG/GIF/WEBP/JPEG, 512KB 이하</small>
        </label>
        <div class="item-color-preset-row">
          <span>도트 색상</span>
          <input type="hidden" name="colorPreset" value="" />
          <div class="item-color-preset-list" data-color-preset-list>${buildItemColorPresetButtons()}</div>
        </div>
        <input type="hidden" name="category" value="기타" />
        <div class="auto-category-badge-row">
          <span>자동 카테고리</span>
          <div class="auto-category-actions">
            <strong data-sprite-category-display>기타</strong>
            <button type="button" class="ghost-button compact-button" data-category-edit-toggle>카테고리 수정</button>
          </div>
        </div>
        <label class="hidden" data-category-edit-row>
          <span>카테고리 수정</span>
          ${buildAdminOptionSelector({
            inputName: "categoryOverride",
            selectorId: "admin-item-edit-category-override",
            selectedValue: "기타 아이템",
            placeholder: "카테고리를 선택하세요",
            options: buildCategoryOverrideOptions(),
          })}
        </label>
        <label><span>설명</span><textarea name="description" rows="4" placeholder="아이템 설명"></textarea></label>
        <label class="hidden" data-food-reward-row>
          <span>음용 시 추가 환</span>
          <input type="number" min="0" step="1" name="foodCurrencyReward" value="0" />
        </label>
        <label class="item-shop-toggle">
          <input type="checkbox" name="sellInShop" />
          <span class="item-shop-toggle-box" aria-hidden="true"></span>
          <span>상점에 등록</span>
        </label>
        <label data-shop-price-row><span>상점 가격</span><input type="number" min="0" name="price" value="0" /></label>
        <button type="submit" class="primary-button">아이템 수정</button>
      </form>
    `,
    "random-box": `
      <div class="stack-form compact-form">
        <p class="muted">랜덤박스 3종이 열렸을 때 나올 아이템을 여기서 바로 추가하거나 제거합니다.</p>
        <div id="admin-random-box-section-body" class="admin-random-box-grid"></div>
      </div>
    `,
    delete: `
      <form id="admin-item-delete-form" class="stack-form compact-form">
        <label>
          <span>삭제 대상 아이템</span>
          ${buildAdminItemSelector({ inputName: "itemId", selectorId: "admin-item-delete-select", placeholder: "아이템을 선택하세요" })}
        </label>
        <button type="submit" class="ghost-button danger-button">아이템 삭제</button>
      </form>
    `,
  };

  body.innerHTML = sections[activeAdminItemSection] || sections.create;
}

async function renderAdminRandomBoxSection({ onProfilePatched, onToast }) {
  const body = document.querySelector("#admin-random-box-section-body");
  if (!body) return;

  body.innerHTML = randomBoxAdminItems
    .map((entry, index) => buildRandomBoxAdminCardMarkup(entry, index))
    .join("");

  initializeAdminItemSelectors(body);
  await hydrateAdminItemOptions();

  const [items, shopItems] = await Promise.all([
    fetchCollectionItems("item-db", "sortOrder"),
    fetchCollectionItems("shop", "sortOrder").catch(() => []),
  ]);
  const itemMap = new Map(items.map((item) => [String(item.name || "").trim(), item]));
  const shopMap = new Map(shopItems.map((item) => [String(item.id || "").trim(), item]));

  const persistRandomBoxRewards = async (item, rewardIds) => {
    const shopItem = shopMap.get(String(item.id || "").trim());
    const payload = {
      itemId: item.id,
      name: item.name || "",
      description: item.description || "",
      shortLabel: item.shortLabel || item.name || "",
      icon: item.icon || "🎁",
      spriteKey: item.spriteKey || "",
      colorPreset: item.colorPreset || "",
      category: item.category || "기타 아이템",
      foodCurrencyReward: Number(item.foodCurrencyReward || 0),
      sellInShop: Boolean(shopItem || item.sellInShop),
      price: Number(shopItem?.price || item.price || 0),
      randomBoxRewardItemIds: normalizeRandomBoxRewardIds(rewardIds),
    };
    await withPendingToast(onToast, () => updateItemDefinition(payload));
    await loadAdminItemCatalog(true);
  };

  const refreshRandomBoxControls = (form) => {
    const rewardInput = form.querySelector("[data-random-box-reward-input]");
    const removeSelector = form.querySelector("#" + CSS.escape(String(form.dataset.randomBoxRemoveSelectorId || "")));
    if (!(rewardInput instanceof HTMLInputElement) || !(removeSelector instanceof HTMLElement)) return;
    const rewardIds = normalizeRandomBoxRewardIds(rewardInput.value);
    removeSelector.dataset.allowedItemIds = JSON.stringify(rewardIds);
    syncAdminItemSelector(removeSelector, "");
  };

  body.querySelectorAll("[data-random-box-admin-form]").forEach((form) => {
    const boxName = String(form.dataset.randomBoxName || "").trim();
    const item = itemMap.get(boxName);
    const itemIdInput = form.querySelector("[data-random-box-item-id]");
    const rewardInput = form.querySelector("[data-random-box-reward-input]");
    const selector = form.querySelector("[data-random-box-add-selector] [data-admin-item-selector]");
    const removeSelector = form.querySelector("[data-random-box-remove-selector] [data-admin-item-selector]");
    const addButton = form.querySelector("[data-random-box-add-button]");
    const removeButton = form.querySelector("[data-random-box-remove-button]");
    if (removeSelector instanceof HTMLElement && removeSelector.id) {
      form.dataset.randomBoxRemoveSelectorId = removeSelector.id;
    }

    if (itemIdInput instanceof HTMLInputElement) {
      itemIdInput.value = String(item?.id || "").trim();
    }
    if (rewardInput instanceof HTMLInputElement) {
      rewardInput.value = JSON.stringify(normalizeRandomBoxRewardIds(item?.useConfig?.randomBoxRewardItemIds || []));
    }
    renderRandomBoxRewardList(form);
    refreshRandomBoxControls(form);

    addButton?.addEventListener("click", () => {
      if (!(rewardInput instanceof HTMLInputElement) || !(selector instanceof HTMLElement)) return;
      const candidateId = String(selector.dataset.selectedItemId || selector.querySelector("[data-item-selector-input]")?.value || "").trim();
      if (!candidateId) return;
      const nextIds = normalizeRandomBoxRewardIds(rewardInput.value);
      if (!nextIds.includes(candidateId)) {
        nextIds.push(candidateId);
      } else {
        handleAdminItemSelection(selector, "");
        return;
      }
      rewardInput.value = JSON.stringify(nextIds);
      (async () => {
        if (!item) {
          onToast("랜덤박스 아이템 정의를 찾지 못했습니다.", true);
          return;
        }
        try {
          await persistRandomBoxRewards(item, nextIds);
          renderRandomBoxRewardList(form);
          refreshRandomBoxControls(form);
          handleAdminItemSelection(selector, "");
          onToast(`${boxName} 보상을 추가했습니다.`);
        } catch (error) {
          onToast(error.message, true);
        }
      })();
    });

    removeButton?.addEventListener("click", () => {
      if (!(rewardInput instanceof HTMLInputElement) || !(removeSelector instanceof HTMLElement)) return;
      const targetId = String(removeSelector.dataset.selectedItemId || removeSelector.querySelector("[data-item-selector-input]")?.value || "").trim();
      if (!targetId) {
        onToast("제거할 보상을 먼저 선택해 주세요.", true);
        return;
      }
      const nextIds = normalizeRandomBoxRewardIds(rewardInput.value).filter((itemId) => itemId !== targetId);
      rewardInput.value = JSON.stringify(nextIds);
      (async () => {
        if (!item) {
          onToast("랜덤박스 아이템 정의를 찾지 못했습니다.", true);
          return;
        }
        try {
          await persistRandomBoxRewards(item, nextIds);
          renderRandomBoxRewardList(form);
          refreshRandomBoxControls(form);
          onToast(`${boxName} 보상을 제거했습니다.`);
        } catch (error) {
          onToast(error.message, true);
        }
      })();
    });
  });
}

function getAdminTerritoryFactionOptions(selectedValue = "") {
  return PROFILE_FACTION_OPTIONS
    .map((faction) => `<option value="${escapeHtml(faction)}"${selectedValue === faction ? " selected" : ""}>${escapeHtml(faction)}</option>`)
    .join("");
}

function buildAdminTerritoryStatusPills(board) {
  const phase = String(board?.currentPhase || board?.phase || "regular").trim();
  const sourceTotals = phase === "war"
    ? board?.territory?.shareTotals || {}
    : board?.currentFactionScores?.rawTotals || {};
  const unit = phase === "war" ? "percent" : "points";
  const pills = PROFILE_FACTION_OPTIONS
    .map((faction) => `<span class="live-pill">${escapeHtml(faction)} ${escapeHtml(formatRankingScoreValue(sourceTotals?.[faction] || 0, unit))}</span>`)
    .join("");
  const hold = board?.territory?.regularClaimHold;
  if (phase === "regular" && hold?.availableCells === 1 && Array.isArray(hold.factions) && hold.factions.length > 1) {
    return `${pills}<span class="live-pill">마지막 1칸 보류 ${escapeHtml(hold.factions.join(", "))} ${escapeHtml(formatRankingScoreValue(hold.points || 0, "points"))}</span>`;
  }
  return pills;
}

function buildAdminTerritoryLiveBar(board) {
  const phase = String(board?.currentPhase || board?.phase || "regular").trim();
  if (phase === "war") {
    return buildFactionScoreBarMarkup({
      rawTotals: board?.territory?.shareTotals || {},
      barTotals: board?.territory?.shareTotals || {},
      displayUnit: "percent",
      barUnit: "percent",
    });
  }
  return buildFactionScoreBarMarkup(board?.currentFactionScores || board?.factionScores || null);
}

function buildAdminRegularCellSelectionMarkup(board) {
  const cells = Array.isArray(board?.territory?.cells) ? [...board.territory.cells] : [];
  const sortedCells = cells
    .map((cell) => ({
      id: String(cell.id || "").trim(),
      number: Number(String(cell.id || "").replace(/^cell-/, "")),
      ownerFaction: String(cell.ownerFaction || "").trim(),
    }))
    .filter((cell) => Number.isFinite(cell.number) && cell.number >= 1 && cell.number <= 100)
    .sort((left, right) => left.number - right.number);
  return `
    <div class="admin-territory-cell-picker-head">
      <div class="admin-territory-form-head">
        <strong>땅 선택</strong>
      </div>
      <button type="button" class="ghost-button compact-button" data-admin-cell-selection-clear>선택 해제</button>
    </div>
    <input type="hidden" name="cellNumbers" value="" />
    <div class="admin-territory-cell-picker-grid" data-admin-cell-picker>
      ${sortedCells.map((cell) => `
        <button
          type="button"
          class="admin-territory-cell-button ${escapeHtml(getTerritoryFactionClass(cell.ownerFaction))}"
          data-admin-cell-number="${cell.number}"
          data-tooltip="${escapeHtml(`${cell.number}번 ${cell.ownerFaction || "빈 땅"}`)}"
          aria-label="${escapeHtml(`${cell.number}번 ${cell.ownerFaction || "빈 땅"}`)}"
        >
          <span class="admin-territory-cell-number${cell.number >= 100 ? " is-three-digit" : ""}">${cell.number}</span>
        </button>
      `).join("")}
    </div>
    <p class="muted admin-territory-cell-selection-summary" data-admin-cell-selection-summary>선택된 칸이 없습니다.</p>
  `;
}

function buildAdminTerritorySettingsMarkup({ config, board }) {
  const phase = String(board?.currentPhase || board?.phase || "regular").trim();
  const selectedDate = String(board?.selectedDate || "").trim();
  const selectedDateLabel = String(board?.selectedDateLabel || selectedDate || "-").trim();
  const currentRegularPeriodKey = String(board?.currentRegularPeriodKey || selectedDate || "").trim();
  const settings = config?.settings || {};
  const regular4p = settings?.regularPayouts?.["ranked-4p-hanchan"] || [30, 10, -10, -30];
  const regular3p = settings?.regularPayouts?.["ranked-3p-hanchan"] || [15, 0, -15];
  const war4p = settings?.warPayouts?.["ranked-4p-hanchan"] || { entryPercent: 0.2, prizePercents: [0.45, 0.25, 0.1, 0] };
  const war3p = settings?.warPayouts?.["ranked-3p-hanchan"] || { entryPercent: 0.1, prizePercents: [0.2, 0.1, 0] };
  const factionSummary = buildAdminTerritoryStatusPills(board);

  return `
    <div class="admin-territory-grid">
      <article class="content-card admin-territory-status-card">
        <div class="admin-territory-status-head">
          <div>
            <p class="eyebrow">TERRITORY STATUS</p>
            <h3>현재 상태</h3>
          </div>
          <span class="admin-territory-status-phase ${phase === "war" ? "is-war" : "is-regular"}">${phase === "war" ? "쟁탈전" : "정규전"}</span>
        </div>
        <p class="muted">현재 랭킹 페이지: ${escapeHtml(selectedDateLabel || "-")}</p>
        <div class="admin-territory-live-bar">${buildAdminTerritoryLiveBar(board)}</div>
        <div class="live-match-summary">${factionSummary}</div>
        <form id="admin-territory-reset-form" class="admin-territory-reset-form" autocomplete="off">
          <button type="submit" class="danger-button">지도 초기화 및 정규전 복귀</button>
        </form>
      </article>
      <article class="content-card ${phase === "regular" ? "" : "hidden"}">
        <h3>정규전 조정</h3>
        <div class="admin-territory-actions">
        <form id="admin-regular-points-form" class="stack-form compact-form admin-territory-inline-form" autocomplete="off">
          <div class="admin-territory-form-head">
            <strong>진영 점수 조정</strong>
            <p>현재 진행 중인 정규전 페이지에 즉시 반영됩니다.</p>
          </div>
          <input type="hidden" name="periodKey" value="${escapeHtml(currentRegularPeriodKey)}" />
          <label><span>대상 진영</span>${buildAdminFactionSelector({ inputName: "factionName", selectorId: "admin-regular-faction-select", selectedValue: "매화" })}</label>
          <label><span>추가 점수</span><input type="number" name="delta" value="0" step="1" /></label>
          <label><span>메모</span><input type="text" name="note" placeholder="선택 사항" /></label>
          <button type="submit" class="primary-button">점수 적용</button>
        </form>
        <form id="admin-regular-cell-form" class="stack-form compact-form admin-territory-inline-form" autocomplete="off">
          ${buildAdminRegularCellSelectionMarkup(board)}
          <label><span>변경 대상 진영</span>${buildAdminFactionSelector({ inputName: "targetFaction", selectorId: "admin-regular-target-faction-select", selectedValue: EMPTY_FACTION_SELECTOR_VALUE, includeEmptyOption: true, emptyOptionLabel: "빈 땅" })}</label>
          <button type="submit" class="ghost-button">선택한 땅 소유권 변경</button>
        </form>
        </div>
      </article>
      <article class="content-card admin-territory-war-card ${phase === "war" ? "" : "hidden"}">
        <h3>쟁탈전 조정</h3>
        <div class="admin-territory-actions">
          <form id="admin-war-transfer-form" class="stack-form compact-form admin-territory-inline-form admin-territory-war-transfer-form" autocomplete="off">
            <div class="admin-territory-form-head">
              <strong>진영 간 양도</strong>
              <p>한 진영의 비율을 다른 진영으로 넘깁니다.</p>
            </div>
            <div class="admin-territory-war-transfer-grid">
              <label><span>양도 진영</span>${buildAdminFactionSelector({ inputName: "sourceFaction", selectorId: "admin-war-source-faction-select", selectedValue: "매화" })}</label>
              <label><span>대상 진영</span>${buildAdminFactionSelector({ inputName: "targetFaction", selectorId: "admin-war-target-faction-select", selectedValue: "난초" })}</label>
              <label><span>양도 비율</span><input type="number" name="delta" value="0" step="0.01" /></label>
              <label><span>메모</span><input type="text" name="note" placeholder="선택 사항" /></label>
            </div>
            <button type="submit" class="ghost-button">비율 양도</button>
          </form>
        </div>
      </article>
      <article class="content-card full">
        <h3>정산 규칙</h3>
        <form id="admin-territory-rules-form" class="stack-form compact-form admin-territory-rules-form" autocomplete="off">
          <div class="admin-territory-rule-block">
            <strong>정규전 땅 규칙</strong>
            <label><span>점령 기준 점수</span><input type="number" name="regularCaptureThreshold" value="${Number(settings?.regularCaptureThreshold || 100)}" min="1" step="1" /></label>
            <label><span>평일 점령 배수</span><input type="number" name="weekdayCaptureMultiplier" value="${Number(settings?.weekdayCaptureMultiplier || 1)}" min="1" step="1" /></label>
            <label><span>주말 점령 배수</span><input type="number" name="weekendCaptureMultiplier" value="${Number(settings?.weekendCaptureMultiplier || 2)}" min="1" step="1" /></label>
          </div>
          <div class="admin-territory-rule-block">
            <strong>정규전 4인 반장전</strong>
            <label><span>1위</span><input type="number" name="regular4p1" value="${Number(regular4p[0] || 0)}" step="0.01" /></label>
            <label><span>2위</span><input type="number" name="regular4p2" value="${Number(regular4p[1] || 0)}" step="0.01" /></label>
            <label><span>3위</span><input type="number" name="regular4p3" value="${Number(regular4p[2] || 0)}" step="0.01" /></label>
            <label><span>4위</span><input type="number" name="regular4p4" value="${Number(regular4p[3] || 0)}" step="0.01" /></label>
          </div>
          <div class="admin-territory-rule-block">
            <strong>정규전 3인 반장전</strong>
            <label><span>1위</span><input type="number" name="regular3p1" value="${Number(regular3p[0] || 0)}" step="0.01" /></label>
            <label><span>2위</span><input type="number" name="regular3p2" value="${Number(regular3p[1] || 0)}" step="0.01" /></label>
            <label><span>3위</span><input type="number" name="regular3p3" value="${Number(regular3p[2] || 0)}" step="0.01" /></label>
          </div>
          <div class="admin-territory-rule-block">
            <strong>쟁탈전 4인 반장전</strong>
            <label><span>참가비</span><input type="number" name="war4pEntry" value="${Number(war4p.entryPercent || 0)}" step="0.01" /></label>
            <label><span>1위</span><input type="number" name="war4p1" value="${Number(war4p.prizePercents?.[0] || 0)}" step="0.01" /></label>
            <label><span>2위</span><input type="number" name="war4p2" value="${Number(war4p.prizePercents?.[1] || 0)}" step="0.01" /></label>
            <label><span>3위</span><input type="number" name="war4p3" value="${Number(war4p.prizePercents?.[2] || 0)}" step="0.01" /></label>
            <label><span>4위</span><input type="number" name="war4p4" value="${Number(war4p.prizePercents?.[3] || 0)}" step="0.01" /></label>
          </div>
          <div class="admin-territory-rule-block">
            <strong>쟁탈전 3인 반장전</strong>
            <label><span>참가비</span><input type="number" name="war3pEntry" value="${Number(war3p.entryPercent || 0)}" step="0.01" /></label>
            <label><span>1위</span><input type="number" name="war3p1" value="${Number(war3p.prizePercents?.[0] || 0)}" step="0.01" /></label>
            <label><span>2위</span><input type="number" name="war3p2" value="${Number(war3p.prizePercents?.[1] || 0)}" step="0.01" /></label>
            <label><span>3위</span><input type="number" name="war3p3" value="${Number(war3p.prizePercents?.[2] || 0)}" step="0.01" /></label>
          </div>
          <button type="submit" class="primary-button">정산 규칙 저장</button>
        </form>
      </article>
    </div>
  `;
}

async function renderAdminTerritorySettings({ onProfilePatched, onToast }) {
  const body = document.querySelector("#admin-territory-settings-body");
  if (!body) return;
  try {
    const [settingsResult, board] = await Promise.all([
      getRankingTerritoryAdminSettings(),
      getCachedRankingBoard(true, ""),
    ]);
    latestAdminTerritorySettings = settingsResult?.config || null;
    body.innerHTML = buildAdminTerritorySettingsMarkup({
      config: latestAdminTerritorySettings,
      board,
    });
    initializeAdminFactionSelectors(body);
    initializeAdminRegularCellPicker(body);
    attachAdminTerritoryEvents({ onProfilePatched, onToast });
  } catch (error) {
    body.innerHTML = `<p class="muted">${escapeHtml(error.message || "영토 설정을 불러오지 못했습니다.")}</p>`;
    onToast(error.message || "영토 설정을 불러오지 못했습니다.", true);
  }
}

function initializeAdminRegularCellPicker(root = document) {
  const form = root.querySelector("#admin-regular-cell-form");
  if (!(form instanceof HTMLElement) || form.dataset.cellPickerBound === "true") return;
  form.dataset.cellPickerBound = "true";
  const hiddenInput = form.querySelector('input[name="cellNumbers"]');
  const summary = form.querySelector("[data-admin-cell-selection-summary]");
  const clearButton = form.querySelector("[data-admin-cell-selection-clear]");
  const cellButtons = Array.from(form.querySelectorAll("[data-admin-cell-number]"));
  if (!(hiddenInput instanceof HTMLInputElement) || !(summary instanceof HTMLElement) || !cellButtons.length) {
    return;
  }

  const selectedCells = new Set();
  let isDragging = false;
  let dragSelectMode = true;

  const syncSelection = () => {
    const numbers = [...selectedCells].sort((left, right) => left - right);
    hiddenInput.value = numbers.join(",");
    summary.textContent = numbers.length
      ? `${numbers.length}칸 선택됨: ${numbers.join(", ")}`
      : "선택된 칸이 없습니다.";
    cellButtons.forEach((button) => {
      const cellNumber = Number(button.dataset.adminCellNumber || 0);
      button.classList.toggle("is-selected", selectedCells.has(cellNumber));
    });
  };

  const applySelection = (button) => {
    const cellNumber = Number(button.dataset.adminCellNumber || 0);
    if (!cellNumber) return;
    if (dragSelectMode) {
      selectedCells.add(cellNumber);
    } else {
      selectedCells.delete(cellNumber);
    }
    syncSelection();
  };

  cellButtons.forEach((button) => {
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const cellNumber = Number(button.dataset.adminCellNumber || 0);
      if (!cellNumber) return;
      isDragging = true;
      form.dataset.dragging = "true";
      dragSelectMode = !selectedCells.has(cellNumber);
      applySelection(button);
    });
    button.addEventListener("mouseenter", () => {
      isDragging = form.dataset.dragging === "true";
      if (!isDragging) return;
      applySelection(button);
    });
  });

  if (!document.body.dataset.adminCellPickerMouseupBound) {
    document.body.dataset.adminCellPickerMouseupBound = "true";
    document.addEventListener("mouseup", () => {
      document.querySelectorAll("#admin-regular-cell-form").forEach((activeForm) => {
        activeForm.dataset.dragging = "false";
      });
    });
  }

  clearButton?.addEventListener("click", () => {
    selectedCells.clear();
    syncSelection();
  });

  syncSelection();
}

function attachAdminRankingManageEvents({ onToast }) {
  const snapshotForm = document.querySelector("#ranking-snapshot-form");
  const clearButton = document.querySelector("#clear-past-matches-button");

  if (snapshotForm) {
    snapshotForm.onsubmit = async (e) => {
      e.preventDefault();
      const dateKey = String(snapshotForm.querySelector('[name="dateKey"]')?.value || "").trim();
      if (!dateKey) return;
      const submitButton = snapshotForm.querySelector("button[type=submit]");
      submitButton.disabled = true;
      try {
        await saveRankingSnapshot(dateKey);
        onToast(`${dateKey} 랭킹 박제 완료`);
      } catch (err) {
        onToast(`박제 실패: ${err.message}`, true);
      } finally {
        submitButton.disabled = false;
      }
    };
  }

  if (clearButton) {
    clearButton.onclick = async () => {
      if (!confirm("오늘 이전 랭킹 박제 데이터를 전부 삭제합니다. 계속하시겠습니까?")) return;
      clearButton.disabled = true;
      try {
        const result = await clearPastRankingSnapshots();
        onToast(`삭제 완료 (${result.deletedCount}건)`);
      } catch (err) {
        onToast(`삭제 실패: ${err.message}`, true);
      } finally {
        clearButton.disabled = false;
      }
    };
  }
}

function attachAdminTerritoryEvents({ onProfilePatched, onToast }) {
  if (activeAdminSection !== "territory-rules") return;

  const regularPointsForm = document.querySelector("#admin-regular-points-form");
  const regularCellForm = document.querySelector("#admin-regular-cell-form");
  const warTransferForm = document.querySelector("#admin-war-transfer-form");
  const rulesForm = document.querySelector("#admin-territory-rules-form");
  const resetForm = document.querySelector("#admin-territory-reset-form");

  if (regularPointsForm && regularPointsForm.dataset.bound !== "true") {
    regularPointsForm.dataset.bound = "true";
    regularPointsForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(regularPointsForm).entries());
      try {
        await withPendingToast(onToast, () => updateRankingTerritoryAdminSettings("grant-regular-points", {
          periodKey: String(payload.periodKey || "").trim(),
          factionName: String(payload.factionName || "").trim(),
          delta: Number(payload.delta || 0),
          note: String(payload.note || "").trim(),
        }));
        invalidateQuickProfileCaches();
        await renderAdminTerritorySettings({ onProfilePatched, onToast });
        await hydrateTerritoryPanel();
        await hydrateRankingPanel();
        await hydrateDashboardFactionBar();
        onToast("정규전 진영 점수를 조정했습니다.");
      } catch (error) {
        onToast(error.message, true);
      }
    });
  }

  if (regularCellForm && regularCellForm.dataset.bound !== "true") {
    regularCellForm.dataset.bound = "true";
    regularCellForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(regularCellForm).entries());
      if (!String(payload.cellNumbers || "").trim()) {
        onToast("먼저 땅 번호를 하나 이상 선택해 주세요.", true);
        return;
      }
      try {
        await withPendingToast(onToast, () => updateRankingTerritoryAdminSettings("transfer-regular-cells", {
          cellNumbers: String(payload.cellNumbers || "").trim(),
          targetFaction: String(payload.targetFaction || "").trim() === EMPTY_FACTION_SELECTOR_VALUE
            ? ""
            : String(payload.targetFaction || "").trim(),
        }));
        invalidateQuickProfileCaches();
        await renderAdminTerritorySettings({ onProfilePatched, onToast });
        await hydrateTerritoryPanel();
        await hydrateDashboardFactionBar();
        onToast("정규전 땅 소유권을 변경했습니다.");
      } catch (error) {
        onToast(error.message, true);
      }
    });
  }

  if (warTransferForm && warTransferForm.dataset.bound !== "true") {
    warTransferForm.dataset.bound = "true";
    warTransferForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(warTransferForm).entries());
      const sourceSelector = warTransferForm.querySelector("#admin-war-source-faction-select");
      const targetSelector = warTransferForm.querySelector("#admin-war-target-faction-select");
      const sourceFaction = String(
        payload.sourceFaction
        || sourceSelector?.dataset.selectedFactionName
        || sourceSelector?.querySelector("[data-option-selector-input]")?.value
        || ""
      ).trim();
      const targetFaction = String(
        payload.targetFaction
        || targetSelector?.dataset.selectedFactionName
        || targetSelector?.querySelector("[data-option-selector-input]")?.value
        || ""
      ).trim();
      const delta = Number(payload.delta || 0);
      try {
        const requestPayload = {
          sourceFaction,
          targetFaction,
          delta,
          note: String(payload.note || "").trim(),
          force: true,
        };
        await withPendingToast(onToast, () => updateRankingTerritoryAdminSettings("transfer-war-share", requestPayload));
        invalidateQuickProfileCaches();
        await renderAdminTerritorySettings({ onProfilePatched, onToast });
        await hydrateTerritoryPanel();
        await hydrateDashboardFactionBar();
        onToast("쟁탈전 진영 비율을 양도했습니다.");
      } catch (error) {
        onToast(error.message, true);
      }
    });
  }

  if (rulesForm && rulesForm.dataset.bound !== "true") {
    rulesForm.dataset.bound = "true";
    rulesForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(rulesForm).entries());
      try {
        await withPendingToast(onToast, () => updateRankingTerritoryAdminSettings("update-rules", {
          regularCaptureThreshold: Number(payload.regularCaptureThreshold || 100),
          weekdayCaptureMultiplier: Number(payload.weekdayCaptureMultiplier || 1),
          weekendCaptureMultiplier: Number(payload.weekendCaptureMultiplier || 2),
          regularPayouts: {
            "ranked-4p-hanchan": [payload.regular4p1, payload.regular4p2, payload.regular4p3, payload.regular4p4].map(Number),
            "ranked-3p-hanchan": [payload.regular3p1, payload.regular3p2, payload.regular3p3].map(Number),
          },
          warPayouts: {
            "ranked-4p-hanchan": {
              entryPercent: Number(payload.war4pEntry || 0),
              prizePercents: [payload.war4p1, payload.war4p2, payload.war4p3, payload.war4p4].map(Number),
            },
            "ranked-3p-hanchan": {
              entryPercent: Number(payload.war3pEntry || 0),
              prizePercents: [payload.war3p1, payload.war3p2, payload.war3p3].map(Number),
            },
          },
        }));
        invalidateQuickProfileCaches();
        await renderAdminTerritorySettings({ onProfilePatched, onToast });
        await hydrateRankingPanel();
        await hydrateTerritoryPanel();
        await hydrateDashboardFactionBar();
        onToast("영토 정산 규칙을 저장했습니다.");
      } catch (error) {
        onToast(error.message, true);
      }
    });
  }

  if (resetForm && resetForm.dataset.bound !== "true") {
    resetForm.dataset.bound = "true";
    resetForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const confirmed = await openActionConfirmModal({
        eyebrowText: "영토 초기화",
        titleText: "지도 초기화 및 정규전 복귀",
        bodyText: "영토 상태, 수동 땅 배정, 정규전 추가 점수를 전부 초기화하고 정규전으로 되돌립니다.",
        confirmText: "초기화",
        cancelText: "취소",
      });
      if (!confirmed) return;
      try {
        await withPendingToast(onToast, () => updateRankingTerritoryAdminSettings("reset-territory-progress", {}));
        invalidateQuickProfileCaches();
        activeRankingDate = "";
        await renderAdminTerritorySettings({ onProfilePatched, onToast });
        await hydrateRankingPanel();
        await hydrateTerritoryPanel();
        await hydrateDashboardFactionBar();
        onToast("지도와 영토 진행 상태를 초기화했습니다.");
      } catch (error) {
        onToast(error.message, true);
      }
    });
  }
}

function attachAdminEvents({ onProfilePatched, onToast }) {
  const manageForm = document.querySelector("#admin-manage-form");
  const itemForm = document.querySelector("#admin-item-form");
  const itemEditForm = document.querySelector("#admin-item-edit-form");
  const itemDeleteForm = document.querySelector("#admin-item-delete-form");
  const announcementForm = document.querySelector("#announcement-form");
  const deleteForm = document.querySelector("#admin-delete-form");

  initializeItemSpritePickers();
  initializeAdminItemSelectors();
  initializeAdminFactionSelectors();
  void ensureAdminMahjongProfileItems(onToast);

  document.querySelectorAll("[data-admin-item-section]").forEach((button) => {
    button.classList.toggle("active", button.dataset.adminItemSection === activeAdminItemSection);
    button.onclick = () => {
      activeAdminItemSection = button.dataset.adminItemSection;
      renderAdminItemSection();
      if (activeAdminItemSection === "random-box") {
        void renderAdminRandomBoxSection({ onProfilePatched, onToast });
      }
      attachAdminEvents({ onProfilePatched, onToast });
    };
  });

  if (activeAdminItemSection === "random-box") {
    void renderAdminRandomBoxSection({ onProfilePatched, onToast });
  }

  attachAdminTerritoryEvents({ onProfilePatched, onToast });

  if (manageForm) {
    const targetInput = manageForm.querySelector('input[name="targetCharacterName"]');
    const applyAllCheckbox = manageForm.querySelector('input[name="applyToAllUsers"]');
    const itemSelect = manageForm.querySelector("#admin-item-select");
    const addItemButton = manageForm.querySelector("#admin-add-item-button");
    const loadTargetInventoryButton = manageForm.querySelector("#admin-load-target-inventory");

    // 지급 아이템 대기열은 유저 조정 화면을 새로 열 때마다 초기화합니다.
    // 이전 작업에서 담아둔 항목이 다음 조정에 섞여 들어가는 것을 방지합니다.
    pendingAdminItemIds = [];
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
      const selectedId = String(itemSelect?.querySelector("[data-item-selector-input]")?.value || "").trim();
      if (!selectedId) {
        onToast("지급할 아이템을 먼저 선택해 주세요.", true);
        return;
      }
      pendingAdminItemIds.push(selectedId);
      renderAdminItemQueue();
      syncAdminItemSelector(itemSelect, selectedId);
    });

    loadTargetInventoryButton?.addEventListener("click", async () => {
      const targetCharacterName = String(targetInput?.value || "").trim();
      if (!targetCharacterName) {
        onToast("대상 캐릭터명을 먼저 입력해 주세요.", true);
        return;
      }
      try {
        loadTargetInventoryButton.disabled = true;
        const targetProfile = await fetchUserInventoryByCharacterName(targetCharacterName);
        if (!targetProfile) {
          renderAdminTargetInventoryList(null, onToast, onProfilePatched);
          onToast("대상 유저를 찾지 못했습니다.", true);
          return;
        }
        renderAdminTargetInventoryList(targetProfile, onToast, onProfilePatched);
      } catch (error) {
        onToast(error.message || "대상 인벤토리를 불러오지 못했습니다.", true);
      } finally {
        loadTargetInventoryButton.disabled = false;
      }
    });

    manageForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(manageForm).entries());
      const hasCurrencyDelta = Number(payload.currencyDelta || 0) !== 0;
      const hasRoleChange = String(payload.setRole || "").trim().length > 0;
      const hasItems = pendingAdminItemIds.length > 0;

      if (!hasCurrencyDelta && !hasRoleChange && !hasItems) {
        onToast("적용할 변경 사항이 없습니다.", true);
        return;
      }
      if (payload.applyToAllUsers === "on") {
        const shouldContinue = await openActionConfirmModal({
          titleText: "WARNING!!",
          bodyText: "전체 유저 대상이 체크되어있습니다. 계속 진행하시겠습니까?",
          confirmText: "계속 진행",
          cancelText: "취소",
          eyebrowText: "운영진 확인",
        });
        if (!shouldContinue) return;
      }

      try {
        await withPendingToast(onToast, () =>
          adminManageUser({
            targetCharacterName: payload.targetCharacterName,
            currencyDelta: Number(payload.currencyDelta || 0),
            addItemIds: pendingAdminItemIds,
            setRole: payload.setRole,
            applyToAllUsers: payload.applyToAllUsers === "on",
          })
        );
        manageForm.reset();
        pendingAdminItemIds = [];
        renderAdminItemQueue();
        syncAdminItemSelector(itemSelect, "");
        await onProfilePatched();
        await renderAdminLogTable("operate");
        onToast("유저 조정을 적용했습니다.");
      } catch (error) {
        onToast(error.message, true);
      }
    });
  }

  if (itemForm) {
    void hydrateAdminItemOptions();
    bindAdminItemMetaForm(itemForm);
    itemForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(itemForm).entries());
      payload.sellInShop = itemForm.elements.sellInShop.checked;
      if (String(itemForm.elements.category.value || "").trim() !== "음식") {
        payload.foodCurrencyReward = 0;
      }

      try {
        await withPendingToast(onToast, () => createItemDefinition(payload));
        itemForm.reset();
        syncItemSpritePicker(itemForm.querySelector("[data-sprite-picker]"), "");
        bindAdminItemMetaForm(itemForm, true);
        await loadAdminItemCatalog(true);
        await hydrateAdminItemOptions();
        refreshAdminItemSelectors({ root: document });
        await onProfilePatched();
        onToast("아이템 DB에 새 아이템을 추가했습니다.");
      } catch (error) {
        onToast(error.message, true);
      }
    });
  }

  if (itemEditForm) {
    const editSelect = itemEditForm.querySelector("#admin-item-edit-select");
    void hydrateAdminItemOptions();
    bindAdminItemMetaForm(itemEditForm);

    editSelect?.addEventListener("itemchange", async (event) => {
      const itemId = String(event.detail?.itemId || editSelect.querySelector("[data-item-selector-input]")?.value || "").trim();
      if (!itemId) {
        itemEditForm.reset();
        syncAdminItemSelector(editSelect, "");
        syncItemSpritePicker(itemEditForm.querySelector("[data-sprite-picker]"), "");
        bindAdminItemMetaForm(itemEditForm, true);
        return;
      }
      try {
        const items = await fetchCollectionItems("item-db", "sortOrder");
        const shopItems = await fetchCollectionItems("shop", "sortOrder");
        const item = items.find((entry) => entry.id === itemId);
        const shopItem = shopItems.find((entry) => entry.id === itemId);
        if (!item) return;
        itemEditForm.elements.name.value = item.name || "";
        syncItemSpritePicker(itemEditForm.querySelector("[data-sprite-picker]"), item.spriteKey || "");
        itemEditForm.elements.category.value = item.category || getItemSpriteCategory(item.spriteKey || "");
        itemEditForm.elements.description.value = item.description || "";
        itemEditForm.elements.colorPreset.value = String(item.colorPreset || "");
        itemEditForm.elements.foodCurrencyReward.value = String(Math.max(0, Number(item.foodCurrencyReward || 0)));
        const randomBoxRewardInput = itemEditForm.querySelector("[data-random-box-reward-input]");
        if (randomBoxRewardInput instanceof HTMLInputElement) {
          randomBoxRewardInput.value = JSON.stringify(
            normalizeRandomBoxRewardIds(item?.useConfig?.randomBoxRewardItemIds || [])
          );
        }
        itemEditForm.elements.price.value = String(Number(shopItem?.price || 0));
        itemEditForm.elements.sellInShop.checked = Boolean(shopItem);
        bindAdminItemMetaForm(itemEditForm, true);
      } catch (_error) {
        onToast("아이템 정보를 불러오지 못했습니다.", true);
      }
    });

    itemEditForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(itemEditForm).entries());
      payload.sellInShop = itemEditForm.elements.sellInShop.checked;
      if (String(itemEditForm.elements.category.value || "").trim() !== "음식") {
        payload.foodCurrencyReward = 0;
      }
      try {
        await withPendingToast(onToast, () => updateItemDefinition(payload));
        await loadAdminItemCatalog(true);
        await hydrateAdminItemOptions();
        refreshAdminItemSelectors({
          root: document,
          preferredValues: new Map([[editSelect?.id || "", String(payload.itemId || "").trim()]]),
        });
        await onProfilePatched();
        onToast("아이템 정보를 수정했습니다.");
      } catch (error) {
        onToast(error.message, true);
      }
    });
  }

  if (itemDeleteForm) {
    void hydrateAdminItemOptions();
    itemDeleteForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(itemDeleteForm).entries());
      const itemId = String(payload.itemId || "").trim();
      if (!itemId) {
        onToast("삭제할 아이템을 선택해 주세요.", true);
        return;
      }
      const shouldDelete = await openActionConfirmModal({
        titleText: "아이템 삭제",
        bodyText: "선택한 아이템을 삭제하시겠습니까?",
        confirmText: "삭제",
        cancelText: "취소",
        eyebrowText: "삭제 확인",
      });
      if (!shouldDelete) return;
      try {
        await withPendingToast(onToast, () => deleteItemDefinition(itemId));
        itemDeleteForm.reset();
        await loadAdminItemCatalog(true);
        await hydrateAdminItemOptions();
        refreshAdminItemSelectors({ root: document });
        await onProfilePatched();
        onToast("아이템을 삭제했습니다.");
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
        onToast("공지를 등록했습니다.");
      } catch (error) {
        onToast(error.message, true);
      }
    });
  }

  if (deleteForm) {
    deleteForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(deleteForm).entries());

      const shouldDelete = await openActionConfirmModal({
        titleText: "계정 삭제",
        bodyText: `${payload.characterName} 계정을 삭제하시겠습니까?`,
        confirmText: "삭제",
        cancelText: "취소",
        eyebrowText: "삭제 확인",
      });
      if (!shouldDelete) return;

      try {
        await withPendingToast(onToast, () => adminDeleteUser(payload.characterName));
        deleteForm.reset();
        onToast("계정을 삭제했습니다.");
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
          <h2 id="announcement-modal-title">공지</h2>
        </div>
        <button id="announcement-modal-close-icon" type="button" class="icon-button">x</button>
      </div>
      <div class="notice-modal-body">
        <p id="announcement-modal-body"></p>
      </div>
      <div class="notice-modal-actions">
        <button id="announcement-modal-close" type="button" class="primary-button">닫기</button>
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

  title.textContent = announcement.title || "공지";
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

async function requestInventoryItemExtraData(item, profile = null) {
  let config = item?.useConfig && typeof item.useConfig === "object" ? item.useConfig : {};
  if ((!config || !Array.isArray(config.fields)) && item?.itemId) {
    try {
      const itemDefinitions = await fetchCollectionItems("item-db", "sortOrder");
      const itemDefinition = itemDefinitions.find((entry) => entry.id === item.itemId);
      if (itemDefinition?.useConfig && typeof itemDefinition.useConfig === "object") {
        config = itemDefinition.useConfig;
      }
    } catch (_error) {
      // Ignore lookup failures and treat as a direct-use item.
    }
  }
  if (!Array.isArray(config.fields) || !config.fields.length) {
    config = getSpecialInventoryUseConfig(item, profile) || config;
  }
  const fields = Array.isArray(config.fields) ? config.fields : [];
  if (!fields.length) {
    return {};
  }

  const modal = ensureInventoryUsePromptModal();
  const title = modal.querySelector("#inventory-use-prompt-title");
  const subtitle = modal.querySelector("#inventory-use-prompt-subtitle");
  const form = modal.querySelector("#inventory-use-prompt-form");
  const cancelButton = modal.querySelector("#inventory-use-prompt-cancel");
  const closeIcon = modal.querySelector("#inventory-use-prompt-close");
  if (!title || !subtitle || !form || !cancelButton || !closeIcon) {
    return {};
  }

  title.textContent = `${item.name || "아이템"} 사용 준비`;
  subtitle.textContent = config?.subtitle || "이 아이템은 사용 전에 추가 입력을 받을 수 있도록 확장되어 있습니다.";
  form.innerHTML = fields
    .map(
      (field) => `
        <label>
          <span>${escapeHtml(field.label || field.name || "입력값")}</span>
          ${
            field.type === "select"
              ? buildAdminOptionSelector({
                  inputName: field.name || "",
                  selectorId: `inventory-prompt-select-${field.name || "field"}`,
                  selectedValue: "",
                  placeholder: "선택해 주세요",
                  options: [
                    { value: "", label: "선택해 주세요", description: field.required === false ? "선택 안 함" : "필수 입력" },
                    ...(Array.isArray(field.options) ? field.options : []).map((option) => ({
                      value: option.value || option.label || "",
                      label: option.label || option.value || "",
                      description: field.label || field.name || "선택 항목",
                    })),
                  ],
                })
              : `<input
                  type="${escapeHtml(field.type || "text")}"
                  name="${escapeHtml(field.name || "")}"
                  placeholder="${escapeHtml(field.placeholder || "")}"
                  ${field.required === false ? "" : "required"}
                />`
          }
        </label>
      `
    )
    .join("");
  initializeAdminOptionSelectors(form);

  modal.classList.remove("hidden");

  return await new Promise((resolve, reject) => {
    const close = () => modal.classList.add("hidden");
    const cleanup = () => {
      form.onsubmit = null;
      cancelButton.onclick = null;
      closeIcon.onclick = null;
    };

    form.onsubmit = (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form).entries());
      cleanup();
      close();
      resolve(values);
    };

    const cancel = () => {
      cleanup();
      close();
      reject(new Error("아이템 사용이 취소되었습니다."));
    };

    cancelButton.onclick = cancel;
    closeIcon.onclick = cancel;
  });
}

function getSpecialInventoryUseConfig(item, profile = null) {
  const itemName = normalizeSystemItemName(item?.name || "");
  if (itemName !== "위조된 이름표") {
    if (itemName === "식칼") {
      return {
        subtitle: "대상 캐릭터명을 입력하면 상대 인벤토리에서 랜덤 아이템 1개를 훔칩니다.",
        fields: [
          {
            type: "text",
            name: "targetCharacterName",
            label: "대상 캐릭터 이름",
            placeholder: "캐릭터 이름 입력",
            required: true,
          },
        ],
      };
    }
    if (itemName === "금고" && !item?.storedItem) {
      const inventoryItems = Array.isArray(profile?.inventory) ? profile.inventory : [];
      const currentItemKey = buildInventoryItemKey(item);
      const candidates = inventoryItems
        .filter((candidate) => buildInventoryItemKey(candidate) !== currentItemKey)
        .filter((candidate) => normalizeSystemItemName(candidate?.name || "") !== "금고");
      if (!candidates.length) {
        throw new Error("금고에 넣을 수 있는 인벤토리 아이템이 없습니다.");
      }
      return {
        subtitle: "금고에 보관할 아이템을 선택해 주세요.",
        fields: [
          {
            type: "select",
            name: "storedItemKey",
            label: "보관할 아이템",
            required: true,
            options: candidates.map((candidate) => {
              const displayItem = normalizeSystemInventoryItemForDisplay(candidate);
              return {
                value: buildInventoryItemKey(candidate),
                label: displayItem.name || "아이템",
              };
            }),
          },
        ],
      };
    }
    return null;
  }

  return {
    fields: [
      {
        type: "select",
        name: "targetFactionName",
        label: "위조할 진영",
        required: true,
        options: PROFILE_FACTION_OPTIONS.map((value) => ({ value, label: value })),
      },
    ],
  };
}

async function findProfileByCharacterName(characterName) {
  const normalizedCharacterName = String(characterName || "").trim();
  if (!normalizedCharacterName) return null;

  const snapshot = await getDocs(
    query(collection(db, "users"), where("characterName", "==", normalizedCharacterName), limit(1))
  );

  if (snapshot.empty) {
    return null;
  }

  return {
    docId: snapshot.docs[0].id,
    ...snapshot.docs[0].data(),
  };
}

async function openMemberProfileEditModal({ profile, onProfilePatched, onToast }) {
  const modal = ensureMemberProfileEditModal();
  const form = modal.querySelector("#member-profile-edit-form");
  const nicknameDisplay = modal.querySelector("#member-profile-primary-nickname");
  const nicknameList = modal.querySelector("#member-profile-extra-list");
  const addButton = modal.querySelector("#member-profile-add-nickname");
  const addWrap = modal.querySelector("#member-profile-add-wrap");
  const addInput = modal.querySelector('input[name="newExtraNickname"]');
  const addConfirm = modal.querySelector("#member-profile-add-confirm");
  const friendCodeInput = modal.querySelector('input[name="friendCode"]');
  const factionSelector = modal.querySelector("#member-profile-faction-select");
  const factionInput = modal.querySelector('input[name="factionName"]');
  const currentPasswordInput = modal.querySelector('input[name="currentPassword"]');
  const nextPasswordInput = modal.querySelector('input[name="nextPassword"]');
  const nextPasswordConfirmInput = modal.querySelector('input[name="nextPasswordConfirm"]');
  const closeButton = modal.querySelector("#member-profile-edit-close");
  const closeIcon = modal.querySelector("#member-profile-edit-close-icon");
  if (
    !form ||
    !nicknameDisplay ||
    !nicknameList ||
    !addButton ||
    !addWrap ||
    !addInput ||
    !addConfirm ||
    !friendCodeInput ||
    !factionSelector ||
    !factionInput ||
    !currentPasswordInput ||
    !nextPasswordInput ||
    !nextPasswordConfirmInput ||
    !closeButton ||
    !closeIcon
  ) {
    return;
  }

  let pendingExtraNicknames = Array.isArray(profile.extraNicknames) ? [...profile.extraNicknames] : [];
  form.reset();
  nicknameDisplay.value = String(profile.nickname || "");
  friendCodeInput.value = String(profile.friendCode || "");
  syncAdminFactionSelector(factionSelector, String(profile.factionName || ""));
  addWrap.classList.add("hidden");
  addInput.value = "";
  currentPasswordInput.value = "";
  nextPasswordInput.value = "";
  nextPasswordConfirmInput.value = "";

  const renderExtraNicknames = () => {
    nicknameList.innerHTML = pendingExtraNicknames.length
      ? pendingExtraNicknames
          .map(
            (item, index) => `
              <button type="button" class="pill-badge member-profile-chip" data-extra-remove="${index}">
                <span>${escapeHtml(item)}</span>
                <strong>x</strong>
              </button>
            `
          )
          .join("")
      : '<span class="muted">아직 추가된 닉네임이 없습니다.</span>';

    nicknameList.querySelectorAll("[data-extra-remove]").forEach((button) => {
      button.onclick = () => {
        const index = Number(button.dataset.extraRemove);
        if (Number.isNaN(index)) return;
        pendingExtraNicknames.splice(index, 1);
        renderExtraNicknames();
      };
    });
  };

  renderExtraNicknames();
  modal.classList.remove("hidden");

  const close = () => {
    form.reset();
    addWrap.classList.add("hidden");
    addInput.value = "";
    modal.classList.add("hidden");
  };
  closeButton.onclick = close;
  closeIcon.onclick = close;

  addButton.onclick = () => {
    addWrap.classList.toggle("hidden");
    if (!addWrap.classList.contains("hidden")) {
      addInput.focus();
    }
  };

  addConfirm.onclick = () => {
    const nextNickname = String(addInput.value || "").trim();
    if (!nextNickname) {
      onToast("추가할 작혼 닉네임을 입력해 주세요.", true);
      return;
    }
    if (pendingExtraNicknames.includes(nextNickname)) {
      onToast("이미 추가된 작혼 닉네임입니다.", true);
      return;
    }
    pendingExtraNicknames.push(nextNickname);
    addInput.value = "";
    addWrap.classList.add("hidden");
    renderExtraNicknames();
  };

  form.onsubmit = async (event) => {
    event.preventDefault();
    try {
      const payload = Object.fromEntries(new FormData(form).entries());

      if (payload.currentPassword || payload.nextPassword || payload.nextPasswordConfirm) {
        if (String(payload.nextPassword || "") !== String(payload.nextPasswordConfirm || "")) {
          throw new Error("새 비밀번호와 비밀번호 확인이 일치하지 않습니다.");
        }
        await changeUserPassword(payload.currentPassword, payload.nextPassword);
      }

      const updatedProfile = await updateMemberProfile({
        nickname: payload.nickname,
        extraNicknames: pendingExtraNicknames,
        friendCode: payload.friendCode,
        factionName: payload.factionName,
      });
      close();
      await onProfilePatched(updatedProfile);
      invalidateQuickProfileCaches();
      onToast("회원정보를 수정했습니다.");
    } catch (error) {
      onToast(error.message, true);
    }
  };
}

function ensureMemberProfileEditModal() {
  let modal = document.querySelector("#member-profile-edit-modal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "member-profile-edit-modal";
  modal.className = "modal-backdrop hidden";
  modal.innerHTML = `
    <div class="modal-panel inventory-use-prompt-panel">
      <div class="modal-head">
        <div>
          <p class="eyebrow">PROFILE EDIT</p>
          <h2>회원정보 수정</h2>
        </div>
        <button id="member-profile-edit-close-icon" type="button" class="icon-button">x</button>
      </div>
      <form id="member-profile-edit-form" class="stack-form compact-form">
        <label>
          <span>대표 작혼 닉네임</span>
          <input id="member-profile-primary-nickname" type="text" name="nickname" value="" />
        </label>
        <label>
          <span>추가 작혼 닉네임</span>
          <div id="member-profile-extra-list" class="member-profile-chip-list"></div>
        </label>
        <div class="member-profile-add-row">
          <button id="member-profile-add-nickname" type="button" class="ghost-button">추가</button>
        </div>
        <div id="member-profile-add-wrap" class="member-profile-add-wrap hidden">
          <label>
            <span>추가할 작혼 닉네임</span>
            <input type="text" name="newExtraNickname" placeholder="작혼 닉네임 입력" />
          </label>
          <button id="member-profile-add-confirm" type="button" class="primary-button">닉네임 추가</button>
        </div>
        <label>
          <span>작혼 친구 코드</span>
          <input type="text" name="friendCode" inputmode="numeric" pattern="[0-9]*" placeholder="숫자만 입력" />
        </label>
        <label>
          <span>파벌 이름</span>
          ${buildAdminFactionSelector({
            inputName: "factionName",
            selectorId: "member-profile-faction-select",
            selectedValue: "",
            placeholder: "파벌을 선택하세요",
          })}
        </label>
        <label>
          <span>현재 비밀번호</span>
          <input type="password" name="currentPassword" placeholder="현재 비밀번호" />
        </label>
        <label>
          <span>새 비밀번호</span>
          <input type="password" name="nextPassword" placeholder="새 비밀번호" />
        </label>
        <label>
          <span>새 비밀번호 확인</span>
          <input type="password" name="nextPasswordConfirm" placeholder="새 비밀번호 확인" />
        </label>
      </form>
      <div class="notice-modal-actions">
        <button id="member-profile-edit-close" type="button" class="ghost-button">취소</button>
        <button form="member-profile-edit-form" type="submit" class="primary-button">저장</button>
      </div>
    </div>
  `;

  document.body.append(modal);
  initializeAdminFactionSelectors(modal);
  return modal;
}

function normalizeProfileDecorations(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const id = String(item.id || "").trim();
      const spriteKey = String(item.spriteKey || "").trim();
      if (!id || !spriteKey || !getItemSprite(spriteKey)) return null;
      const rawX = Number(item.x);
      const rawY = Number(item.y);
      const rawScale = Number(item.scale);
      return {
        id,
        itemId: String(item.itemId || "").trim(),
        name: String(item.name || "").trim(),
        spriteKey,
        colorPreset: String(item.colorPreset || "").trim(),
        x: Number.isFinite(rawX) ? Math.min(1, Math.max(0, rawX)) : 0.5,
        y: Number.isFinite(rawY) ? Math.min(1, Math.max(0, rawY)) : 0.5,
        scale: Number.isFinite(rawScale) ? Math.min(2.5, Math.max(0.5, rawScale)) : 1,
        flipX: Boolean(item.flipX),
        createdAt: String(item.createdAt || "").trim(),
      };
    })
    .filter(Boolean);
}

function renderProfileDecorationVisual(item, isOwnProfile, { eager = false } = {}) {
  const sprite = getItemSprite(item?.spriteKey);
  if (!sprite) return "";
  const safeLeft = Math.round(Math.min(1, Math.max(0, Number(item.x) || 0.5)) * 1000) / 10;
  const safeTop = Math.round(Math.min(1, Math.max(0, Number(item.y) || 0.5)) * 1000) / 10;
  const safeScale = Math.round(Math.min(2.5, Math.max(0.5, Number(item.scale) || 1)) * 100) / 100;
  const label = escapeHtml(item?.name || sprite.label || "프로필 장식");
  const imageStyle = buildProfileDecorationImageStyle(item);
  return `
    <div
      class="profile-decoration-item${isOwnProfile ? " is-editable" : ""}"
      data-profile-decoration-id="${escapeHtml(item.id)}"
      data-profile-decoration-name="${label}"
      style="left:${safeLeft}%;top:${safeTop}%;--profile-decoration-scale:${safeScale};"
      ${isOwnProfile ? "" : 'aria-hidden="true"'}
    >
      ${
        isOwnProfile
          ? `<button type="button" class="profile-decoration-remove" data-profile-decoration-remove="${escapeHtml(item.id)}" aria-label="${label} 장식을 인벤토리로 되돌리기">x</button>`
          : ""
      }
      ${
        isOwnProfile
          ? `<div class="profile-decoration-controls" aria-label="${label} 장식 조정">
              <button type="button" data-profile-decoration-scale="-0.1" aria-label="작게">-</button>
              <button type="button" data-profile-decoration-flip aria-label="좌우 반전">↔</button>
              <button type="button" data-profile-decoration-scale="0.1" aria-label="크게">+</button>
            </div>`
          : ""
      }
      <img src="${escapeHtml(getItemSpriteUrl(sprite))}" alt="${label}" class="profile-decoration-image"${eager ? ' loading="eager" fetchpriority="high" decoding="async"' : ' loading="lazy"'}${buildItemSpriteFallbackAttributes(sprite)} style="${escapeHtml(imageStyle)}" />
    </div>
  `;
}

function bindProfileDecorationEditor({ modal, profile, onProfilePatched, onToast }) {
  const layer = modal.querySelector("[data-profile-decoration-layer]");
  if (!(layer instanceof HTMLElement) || layer.dataset.profileDecorationEditable !== "true") {
    return;
  }

  const nodes = Array.from(layer.querySelectorAll("[data-profile-decoration-id]"));
  if (!nodes.length) return;

  let activeState = null;
  let decorationPersistChain = Promise.resolve();
  const syncProfileQuickModalState = (mergedProfile) => {
    profile.profileDecorations = mergedProfile.profileDecorations;
    const currentModalState = modal.__profileQuickState || {};
    modal.__profileQuickState = {
      profile: mergedProfile,
      viewerProfile:
        currentModalState.viewerProfile?.uid === mergedProfile.uid
          ? {
              ...currentModalState.viewerProfile,
              ...mergedProfile,
              profileDecorations: mergedProfile.profileDecorations,
            }
          : currentModalState.viewerProfile || null,
    };
  };
  const persistDecorations = async (nextDecorations, options = {}) => {
    const { syncOuterProfile = false } = options;
    const updatedProfile = await updateProfileDecorations(nextDecorations);
    const mergedProfile = {
      ...profile,
      ...updatedProfile,
      profileDecorations: normalizeProfileDecorations(updatedProfile.profileDecorations || nextDecorations),
    };
    syncProfileQuickModalState(mergedProfile);
    if (syncOuterProfile) {
      await onProfilePatched?.(mergedProfile);
    }
    return mergedProfile;
  };
  const queueDecorationPersist = async (nextDecorations, revertDecorations, errorMessage) => {
    profile.profileDecorations = normalizeProfileDecorations(nextDecorations);
    const runPersist = decorationPersistChain.then(async () => {
      try {
        await persistDecorations(nextDecorations);
      } catch (error) {
        profile.profileDecorations = normalizeProfileDecorations(revertDecorations);
        throw new Error(error.message || errorMessage);
      }
    });
    decorationPersistChain = runPersist.catch(() => null);
    return runPersist;
  };

  const applyPosition = (node, x, y) => {
    node.style.left = `${Math.round(x * 1000) / 10}%`;
    node.style.top = `${Math.round(y * 1000) / 10}%`;
  };

  const computePosition = (event, node) => {
    const layerRect = layer.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const halfWidth = Math.max(nodeRect.width / 2, 18);
    const halfHeight = Math.max(nodeRect.height / 2, 18);
    const clampedLeft = Math.min(layerRect.width - halfWidth, Math.max(halfWidth, event.clientX - layerRect.left));
    const clampedTop = Math.min(layerRect.height - halfHeight, Math.max(halfHeight, event.clientY - layerRect.top));
    return {
      x: layerRect.width > 0 ? clampedLeft / layerRect.width : 0.5,
      y: layerRect.height > 0 ? clampedTop / layerRect.height : 0.5,
    };
  };

  const commitActiveDecoration = async () => {
    if (!activeState) return;
    const { decorationId, startX, startY, x, y, node } = activeState;
    const moved = Math.abs(x - startX) > 0.001 || Math.abs(y - startY) > 0.001;
    node.classList.remove("is-dragging");
    if (!moved) {
      activeState = null;
      return;
    }

    const nextDecorations = normalizeProfileDecorations(profile.profileDecorations).map((item) =>
      item.id === decorationId ? { ...item, x, y } : item
    );

    try {
      await persistDecorations(nextDecorations);
    } catch (error) {
      applyPosition(node, startX, startY);
      profile.profileDecorations = normalizeProfileDecorations(profile.profileDecorations).map((item) =>
        item.id === decorationId ? { ...item, x: startX, y: startY } : item
      );
      onToast?.(error.message || "프로필 장식 위치를 저장하지 못했습니다.", true);
    } finally {
      activeState = null;
    }
  };

  const handlePointerMove = (event) => {
    if (!activeState) return;
    event.preventDefault();
    const { x, y } = computePosition(event, activeState.node);
    activeState.x = x;
    activeState.y = y;
    applyPosition(activeState.node, x, y);
  };

  const handlePointerUp = async () => {
    if (!activeState) return;
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerUp);
    await commitActiveDecoration();
  };

  layer.querySelectorAll("[data-profile-decoration-remove]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const decorationId = button.dataset.profileDecorationRemove || "";
      if (!decorationId) return;
      try {
        const result = await returnProfileDecorationToInventory(decorationId);
        const updatedProfile = result?.profile || null;
        if (updatedProfile) {
          const mergedProfile = {
            ...profile,
            ...updatedProfile,
            profileDecorations: normalizeProfileDecorations(updatedProfile.profileDecorations),
          };
          syncProfileQuickModalState(mergedProfile);
          button.closest("[data-profile-decoration-id]")?.remove();
          await onProfilePatched?.(mergedProfile);
        }
        onToast?.("프로필 장식을 인벤토리로 되돌렸습니다.");
      } catch (error) {
        onToast?.(error.message || "프로필 장식을 되돌리지 못했습니다.", true);
      }
    });
  });

  layer.querySelectorAll("[data-profile-decoration-scale]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const node = button.closest("[data-profile-decoration-id]");
      const decorationId = node?.dataset.profileDecorationId || "";
      const delta = Number(button.dataset.profileDecorationScale || 0);
      if (!decorationId || !Number.isFinite(delta)) return;
      const previousDecorations = normalizeProfileDecorations(profile.profileDecorations);
      const nextDecorations = normalizeProfileDecorations(profile.profileDecorations).map((item) =>
        item.id === decorationId ? { ...item, scale: Math.min(2.5, Math.max(0.5, Number(item.scale || 1) + delta)) } : item
      );
      try {
        const nextItem = nextDecorations.find((item) => item.id === decorationId);
        if (node instanceof HTMLElement && nextItem) {
          const image = node.querySelector(".profile-decoration-image");
          if (image instanceof HTMLElement) {
            image.style.transform = buildProfileDecorationTransform(nextItem);
          }
        }
        await queueDecorationPersist(nextDecorations, previousDecorations, "프로필 장식 크기를 저장하지 못했습니다.");
      } catch (error) {
        const currentItem = previousDecorations.find((item) => item.id === decorationId);
        if (node instanceof HTMLElement && currentItem) {
          const image = node.querySelector(".profile-decoration-image");
          if (image instanceof HTMLElement) {
            image.style.transform = buildProfileDecorationTransform(currentItem);
          }
        }
        onToast?.(error.message || "프로필 장식 크기를 저장하지 못했습니다.", true);
      }
    });
  });

  layer.querySelectorAll("[data-profile-decoration-flip]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const node = button.closest("[data-profile-decoration-id]");
      const decorationId = node?.dataset.profileDecorationId || "";
      if (!decorationId) return;
      const previousDecorations = normalizeProfileDecorations(profile.profileDecorations);
      const nextDecorations = normalizeProfileDecorations(profile.profileDecorations).map((item) =>
        item.id === decorationId ? { ...item, flipX: !item.flipX } : item
      );
      try {
        const nextItem = nextDecorations.find((item) => item.id === decorationId);
        if (node instanceof HTMLElement && nextItem) {
          const image = node.querySelector(".profile-decoration-image");
          if (image instanceof HTMLElement) {
            image.style.transform = buildProfileDecorationTransform(nextItem);
          }
        }
        await queueDecorationPersist(nextDecorations, previousDecorations, "프로필 장식 반전을 저장하지 못했습니다.");
      } catch (error) {
        const currentItem = previousDecorations.find((item) => item.id === decorationId);
        if (node instanceof HTMLElement && currentItem) {
          const image = node.querySelector(".profile-decoration-image");
          if (image instanceof HTMLElement) {
            image.style.transform = buildProfileDecorationTransform(currentItem);
          }
        }
        onToast?.(error.message || "프로필 장식 반전을 저장하지 못했습니다.", true);
      }
    });
  });

  nodes.forEach((node) => {
    if (!(node instanceof HTMLElement)) return;
    node.addEventListener("pointerdown", (event) => {
      if (activeState) return;
      if (event.target instanceof Element && event.target.closest("[data-profile-decoration-remove], .profile-decoration-controls")) {
        return;
      }
      const decorationId = node.dataset.profileDecorationId || "";
      if (!decorationId) return;
      const currentDecoration = normalizeProfileDecorations(profile.profileDecorations).find((item) => item.id === decorationId);
      if (!currentDecoration) return;
      event.preventDefault();
      node.classList.add("is-dragging");
      node.setPointerCapture?.(event.pointerId);
      activeState = {
        decorationId,
        node,
        startX: currentDecoration.x,
        startY: currentDecoration.y,
        x: currentDecoration.x,
        y: currentDecoration.y,
      };
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    });
  });
}

function ensureInventoryUsePromptModal() {
  let modal = document.querySelector("#inventory-use-prompt-modal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "inventory-use-prompt-modal";
  modal.className = "modal-backdrop hidden";
  modal.innerHTML = `
    <div class="modal-panel inventory-use-prompt-panel">
      <div class="modal-head">
        <div>
          <p class="eyebrow">ITEM INPUT</p>
          <h2 id="inventory-use-prompt-title">아이템 사용 준비</h2>
          <p id="inventory-use-prompt-subtitle" class="muted">추가 입력이 필요합니다.</p>
        </div>
        <button id="inventory-use-prompt-close" type="button" class="icon-button">x</button>
      </div>
      <form id="inventory-use-prompt-form" class="stack-form compact-form"></form>
      <div class="notice-modal-actions">
        <button form="inventory-use-prompt-form" type="submit" class="primary-button">사용</button>
        <button id="inventory-use-prompt-cancel" type="button" class="ghost-button">취소</button>
      </div>
    </div>
  `;

  document.body.append(modal);
  return modal;
}

function showItemUseResultModal(result) {
  const modal = ensureItemUseResultModal();
  const code = modal.querySelector("#item-use-receipt");
  const title = modal.querySelector("#item-use-title");
  const body = modal.querySelector("#item-use-body");
  const closeButton = modal.querySelector("#item-use-close");
  const closeIcon = modal.querySelector("#item-use-close-icon");
  if (!code || !title || !body || !closeButton || !closeIcon) return;

  const itemName = result?.item?.name || "아이템";
  code.textContent = `${result?.receiptCode || "[UID-XXXXXX]"} - '${itemName}' 을 사용했습니다.`;
  title.textContent = itemName;
  body.textContent = result?.effectDescription || "아이템 효과 설명은 아직 등록되지 않았습니다.";
  modal.classList.remove("hidden");

  const close = () => modal.classList.add("hidden");
  closeButton.onclick = close;
  closeIcon.onclick = close;
}

function ensureItemUseResultModal() {
  let modal = document.querySelector("#item-use-result-modal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "item-use-result-modal";
  modal.className = "modal-backdrop hidden";
  modal.innerHTML = `
    <div class="modal-panel item-use-result-panel">
      <div class="item-use-card">
        <div class="modal-head item-use-head">
          <div>
            <p class="eyebrow">ITEM RESULT</p>
            <h2 id="item-use-title">아이템 사용 완료</h2>
          </div>
          <button id="item-use-close-icon" type="button" class="icon-button">x</button>
        </div>
        <div class="item-use-body">
          <p id="item-use-receipt" class="item-use-receipt"></p>
          <p id="item-use-body" class="item-use-effect"></p>
        </div>
        <div class="notice-modal-actions">
          <button id="item-use-close" type="button" class="primary-button">확인</button>
        </div>
      </div>
    </div>
  `;

  document.body.append(modal);
  return modal;
}

async function openActionConfirmModal({
  titleText = "확인",
  bodyText = "",
  confirmText = "확인",
  cancelText = "취소",
  eyebrowText = "작업 확인",
} = {}) {
  const modal = ensureInventoryUseConfirmModal();
  const eyebrow = modal.querySelector("#inventory-use-confirm-eyebrow");
  const title = modal.querySelector("#inventory-use-confirm-title");
  const body = modal.querySelector("#inventory-use-confirm-body");
  const confirmButton = modal.querySelector("#inventory-use-confirm-ok");
  const cancelButton = modal.querySelector("#inventory-use-confirm-cancel");
  const closeIcon = modal.querySelector("#inventory-use-confirm-close");
  if (!eyebrow || !title || !body || !confirmButton || !cancelButton || !closeIcon) {
    return false;
  }

  eyebrow.textContent = eyebrowText;
  title.textContent = titleText;
  body.textContent = bodyText;
  confirmButton.textContent = confirmText;
  cancelButton.textContent = cancelText;
  modal.classList.remove("hidden");

  return await new Promise((resolve) => {
    const close = () => modal.classList.add("hidden");
    const cleanup = () => {
      confirmButton.onclick = null;
      cancelButton.onclick = null;
      closeIcon.onclick = null;
    };

    confirmButton.onclick = () => {
      cleanup();
      close();
      resolve(true);
    };
    const cancel = () => {
      cleanup();
      close();
      resolve(false);
    };
    cancelButton.onclick = cancel;
    closeIcon.onclick = cancel;
  });
}

async function confirmParcelAction(action, parcel = null) {
  const normalizedAction = String(action || "").trim();
  const senderName = parcel?.senderCharacterName || "소포";
  if (normalizedAction === "accept") {
    return openActionConfirmModal({
      titleText: "소포 수령",
      bodyText: `${senderName} 님의 소포를 수령하시겠습니까?`,
      confirmText: "수령",
      cancelText: "취소",
      eyebrowText: "소포 확인",
    });
  }
  if (normalizedAction === "reject") {
    return openActionConfirmModal({
      titleText: "소포 거절",
      bodyText: `${senderName} 님의 소포를 거절하시겠습니까?`,
      confirmText: "거절",
      cancelText: "취소",
      eyebrowText: "소포 확인",
    });
  }
  if (normalizedAction === "reveal") {
    return openActionConfirmModal({
      titleText: "망치 사용",
      bodyText: `${senderName} 님의 택배 상자 내용을 확인하기 위해 망치 1개를 사용하시겠습니까?`,
      confirmText: "망치 사용",
      cancelText: "취소",
      eyebrowText: "소포 확인",
    });
  }
  return openActionConfirmModal({
    titleText: "소포 처리",
    bodyText: "소포 상태를 변경하시겠습니까?",
    confirmText: "확인",
    cancelText: "취소",
    eyebrowText: "소포 확인",
  });
}

async function confirmInventoryItemUse(item) {
  return openActionConfirmModal({
    titleText: item?.name || "아이템 사용",
    bodyText: `'${item?.name || "아이템"}' 을(를) 사용하시겠습니까?`,
    confirmText: "사용",
    cancelText: "취소",
    eyebrowText: "아이템 확인",
  });
}

function ensureInventoryUseConfirmModal() {
  let modal = document.querySelector("#inventory-use-confirm-modal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "inventory-use-confirm-modal";
  modal.className = "modal-backdrop hidden";
  modal.innerHTML = `
    <div class="modal-panel inventory-use-confirm-panel">
      <div class="modal-head">
        <div>
          <p class="eyebrow" id="inventory-use-confirm-eyebrow">아이템 확인</p>
          <h2 id="inventory-use-confirm-title">아이템 사용</h2>
        </div>
        <button id="inventory-use-confirm-close" type="button" class="icon-button">x</button>
      </div>
      <div class="notice-modal-body">
        <p id="inventory-use-confirm-body"></p>
      </div>
      <div class="notice-modal-actions">
        <button id="inventory-use-confirm-ok" type="button" class="primary-button">사용</button>
        <button id="inventory-use-confirm-cancel" type="button" class="ghost-button">취소</button>
      </div>
    </div>
  `;

  document.body.append(modal);
  return modal;
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

    label.textContent = `${result.page + 1} 페이지`;

    if (!result.items.length) {
      if (adminLogPages[kind] > 0) {
        adminLogPages[kind] -= 1;
        await renderAdminLogTable(kind);
        return;
      }
      body.innerHTML =
        kind === "operate"
          ? '<tr><td colspan="4" class="table-empty">로그가 없습니다.</td></tr>'
          : '<tr><td colspan="3" class="table-empty">로그가 없습니다.</td></tr>';
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
            item.currencyDelta ? `환 ${Number(item.currencyDelta) > 0 ? "+" : ""}${Number(item.currencyDelta)}` : "",
            itemSummary
              ? `아이템 ${escapeHtml(itemSummary)}`
              : item.addItemName
                ? `아이템 ${escapeHtml(item.addItemName)}`
                : "",
            item.setRole ? `권한 ${escapeHtml(item.setRole)}` : "",
            item.applyToAllUsers ? "전체 유저 대상" : "",
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
        ? '<tr><td colspan="4" class="table-empty">로그를 불러오지 못했습니다.</td></tr>'
        : '<tr><td colspan="3" class="table-empty">로그를 불러오지 못했습니다.</td></tr>';
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
      pageLabel.textContent = `${matchResultsPage + 1} 페이지`;
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
      body.innerHTML = `<tr><td colspan="${emptyColspan}" class="table-empty">대국 결과가 없습니다.</td></tr>`;
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
    body.innerHTML = `<tr><td colspan="${emptyColspan}" class="table-empty">대국 결과를 불러오지 못했습니다.</td></tr>`;
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

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("파일을 읽지 못했습니다."));
    reader.readAsDataURL(file);
  });
}

function buildProfileDecorationTransform(item) {
  const safeScale = Math.round(Math.min(2.5, Math.max(0.5, Number(item?.scale) || 1)) * 100) / 100;
  const safeFlip = item?.flipX ? -1 : 1;
  return `scaleX(${safeFlip}) scale(${safeScale})`;
}

function buildProfileDecorationImageStyle(item) {
  const filter = getItemColorPresetFilter(item?.colorPreset);
  const transform = buildProfileDecorationTransform(item);
  return [filter ? `filter:${filter}` : "", `transform:${transform}`, "transform-origin:center"]
    .filter(Boolean)
    .join(";");
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
    const itemNames = parcel.items.map((item) => normalizeSystemInventoryItemForDisplay(item)?.name).filter(Boolean);
    if (itemNames.length) {
      parts.push(`아이템 ${itemNames.join(", ")}`);
    }
  } else if (parcel.item?.name) {
    parts.push(`아이템 ${normalizeSystemInventoryItemForDisplay(parcel.item).name}`);
  }
  if (Number(parcel.currencyAmount || 0) > 0) {
    parts.push(`환 ${Number(parcel.currencyAmount || 0)}`);
  }
  if (Number(parcel.chargeAmount || 0) > 0) {
    parts.push(`청구 ${Number(parcel.chargeAmount || 0)}환`);
  }
  return parts.join(" / ") || "내용물 없음";
}

function formatParcelStatus(status) {
  const normalized = String(status || "").trim();
  if (normalized === "pending") return "대기 중";
  if (normalized === "accepted") return "수령 완료";
  if (normalized === "rejected") return "거절 완료";
  return normalized || "-";
}

function formatParcelActionToast(action) {
  const normalized = String(action || "").trim();
  if (normalized === "accept") return "소포를 수령했습니다.";
  if (normalized === "reveal") return "택배 상자 내용을 확인했습니다.";
  if (normalized === "reject") return "소포를 거절했습니다.";
  return "소포 상태를 처리했습니다.";
}

function buildGroupedInventoryItems(items) {
  return Array.from(
    (Array.isArray(items) ? items : []).reduce((map, item) => {
      const groupKey = buildInventoryGroupKey(item);
      const existing = map.get(groupKey);
      if (existing) {
        existing.count += 1;
        const currentItem = normalizeSystemInventoryItemForDisplay(existing.item);
        const nextItem = normalizeSystemInventoryItemForDisplay(item);
        const shouldPromote =
          (!currentItem?.spriteKey && nextItem?.spriteKey) ||
          (!currentItem?.colorPreset && nextItem?.colorPreset) ||
          (!currentItem?.icon && nextItem?.icon) ||
          (!currentItem?.shortLabel && nextItem?.shortLabel);
        if (shouldPromote) {
          existing.item = item;
          existing.itemKey = buildInventoryItemKey(item);
        }
        return map;
      }
      map.set(groupKey, { item, itemKey: buildInventoryItemKey(item), count: 1 });
      return map;
    }, new Map()).values()
  );
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

function buildInventoryGroupKey(item) {
  const displayItem = normalizeSystemInventoryItemForDisplay(item);
  const storedItem = displayItem?.storedItem && typeof displayItem.storedItem === "object" ? displayItem.storedItem : null;
  return [
    displayItem?.itemId || displayItem?.name || "item",
    displayItem?.name || "",
    displayItem?.description || "",
    displayItem?.spriteKey || "",
    displayItem?.colorPreset || "",
    storedItem?.itemId || storedItem?.name || "",
    storedItem?.grantedAt || "",
    storedItem?.colorPreset || "",
  ].join("::");
}

function normalizeSystemItemName(name) {
  const normalized = String(name || "").trim();
  if (["포장지", "택배상자", "택배 상자"].includes(normalized)) return "택배 상자";
  if (["거절권", "폐기 승인서", "반송장"].includes(normalized)) return "반송장";
  if (["위장 물약", "위조된 이름표"].includes(normalized)) return "위조된 이름표";
  return normalized;
}

function normalizeNonNegativeAmount(value) {
  const numericValue = Number(value || 0);
  return Number.isFinite(numericValue) ? Math.max(0, numericValue) : 0;
}

function normalizeSystemInventoryItemForDisplay(item) {
  if (!item || typeof item !== "object") return item;
  const name = normalizeSystemItemName(item.name);
  const nextItem = { ...item, name };
  if (name !== item.name) {
    nextItem.shortLabel = nextItem.shortLabel || name;
  }
  if (name === "금고") {
    const storedItem = item?.storedItem && typeof item.storedItem === "object"
      ? normalizeSystemInventoryItemForDisplay(item.storedItem)
      : null;
    if (storedItem) {
      nextItem.storedItem = storedItem;
      nextItem.description = `${storedItem.name || "아이템"}이(가) 들어 있는 금고입니다. 사용하면 다시 꺼낼 수 있습니다.`;
    } else {
      delete nextItem.storedItem;
      nextItem.description = "아이템 1개를 안전하게 보관할 수 있는 금고입니다. 사용하면 보관하거나 꺼낼 수 있습니다.";
    }
  }
  return nextItem;
}

function buildInventoryTooltipText(item) {
  const displayItem = normalizeSystemInventoryItemForDisplay(item);
  const baseName = displayItem?.name || "이름 없는 아이템";
  const baseDescription = displayItem?.description || "설명이 아직 등록되지 않았습니다.";
  if (normalizeSystemItemName(displayItem?.name) === "금고") {
    const storedItem = displayItem?.storedItem;
    if (storedItem) {
      return `${baseName} | 보관 중: ${storedItem.name || "아이템"} | ${baseDescription}`;
    }
  }
  return `${baseName} | ${baseDescription}`;
}

function buildItemColorPresetButtons(selectedPreset = "") {
  const selectedId = String(selectedPreset || "").trim();
  return ITEM_COLOR_PRESETS.filter((preset) => !preset.hidden).map((preset) => {
    const isActive = preset.id === selectedId;
    const swatchStyle = preset.filter ? ` style="filter:${escapeHtml(preset.filter)}"` : "";
    return `
      <button
        type="button"
        class="item-color-preset-button${isActive ? " active" : ""}"
        data-color-preset-button
        data-color-preset="${escapeHtml(preset.id)}"
        aria-pressed="${isActive ? "true" : "false"}"
        title="${escapeHtml(preset.label)}"
      >
        <span class="item-color-preset-swatch"${swatchStyle} aria-hidden="true"></span>
        <span class="item-color-preset-label">${escapeHtml(preset.label)}</span>
      </button>
    `;
  }).join("");
}

function renderActiveProfileEffects(profile) {
  const effects = [];
  if (isFutureIsoTimestamp(profile?.publicInventoryHiddenUntil)) {
    effects.push({
      label: "차광포",
      until: profile.publicInventoryHiddenUntil,
      detail: "공개 프로필 인벤토리 비공개",
    });
  }
  if (isFutureIsoTimestamp(profile?.factionDisguiseUntil)) {
    effects.push({
      label: "위조된 이름표",
      until: profile.factionDisguiseUntil,
      detail: `${profile.factionDisguiseName || "다른 진영"}으로 위장 중`,
    });
  }
  if (!effects.length) return "";
  return `
    <div class="active-effect-list">
      ${effects
        .map(
          (effect) => `
            <div class="active-effect-chip">
              <strong>${escapeHtml(effect.label)}</strong>
              <span>${escapeHtml(effect.detail)}</span>
              <small>종료: ${escapeHtml(formatEffectUntil(effect.until))}</small>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function formatEffectUntil(value) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return "알 수 없음";
  const remainingMs = Math.max(0, timestamp - Date.now());
  const hours = Math.floor(remainingMs / (60 * 60 * 1000));
  const minutes = Math.ceil((remainingMs % (60 * 60 * 1000)) / (60 * 1000));
  const remainingText = hours > 0 ? `약 ${hours}시간 ${minutes}분 남음` : `약 ${minutes}분 남음`;
  return `${new Date(timestamp).toLocaleString("ko-KR")} (${remainingText})`;
}

function isFutureIsoTimestamp(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function buildCharacterNameColorPalette() {
  const seeded = [
    ["crimson", "#ef6677"],
    ["pink", "#ff9bc2"],
    ["rose-gold", "#f3bf8d"],
    ["orange", "#ffb067"],
    ["yellow", "#f3d86b"],
    ["blue-neon", "#76b7ff"],
    ["sky", "#9ee4ff"],
    ["teal", "#7de3d5"],
    ["emerald", "#78dd8c"],
    ["violet", "#b487ff"],
    ["lavender", "#d7c2ff"],
    ["faded", "#c5c0bb"],
    ["black", "#2f2f35"],
    ["white", "#f4f1ea"],
  ];
  const palette = new Map(seeded);
  for (let index = 1; index <= 128; index += 1) {
    const hue = Math.round(((index - 1) * 360) / 128);
    const saturation = 56 + (index % 4) * 8;
    const lightness = 42 + (index % 5) * 6;
    palette.set(`dye-${String(index).padStart(3, "0")}`, `hsl(${hue}deg ${saturation}% ${lightness}%)`);
  }
  return palette;
}

const characterNameColorPalette = buildCharacterNameColorPalette();

function getCharacterNameColorValue(presetId) {
  return characterNameColorPalette.get(String(presetId || "").trim()) || "";
}

function buildCharacterNameStyleAttribute(profileLike) {
  const colorValue = getCharacterNameColorValue(profileLike?.characterNameColorPreset);
  return colorValue ? ` style="color:${escapeHtml(colorValue)}"` : "";
}

function buildDisplayedCharacterName(profileLike) {
  const title = String(profileLike?.profileTitle || "").trim();
  const baseName = String(profileLike?.characterName || "-").trim() || "-";
  return title ? `【${title}】${baseName}` : baseName;
}

function buildDisplayedCharacterNameMarkup(profileLike) {
  const title = String(profileLike?.profileTitle || "").trim();
  const baseName = String(profileLike?.characterName || "-").trim() || "-";
  if (!title) {
    return `<span class="character-name-core">${escapeHtml(baseName)}</span>`;
  }
  return `<span class="character-title-inline"><span class="character-title-bracket">【</span>${escapeHtml(title)}<span class="character-title-bracket">】</span></span><span class="character-name-core">${escapeHtml(baseName)}</span>`;
}

function isPublicInventoryHidden(profile) {
  return isFutureIsoTimestamp(profile?.publicInventoryHiddenUntil);
}

function getDisplayedProfileFactionName(profile, isOwnProfile) {
  if (!isOwnProfile && isFutureIsoTimestamp(profile?.factionDisguiseUntil)) {
    const disguisedFaction = String(profile?.factionDisguiseName || "").trim();
    if (disguisedFaction) {
      return disguisedFaction;
    }
  }
  return String(profile?.factionName || "").trim();
}

function getDisplayedRankingFactionName(profileLike) {
  if (isFutureIsoTimestamp(profileLike?.factionDisguiseUntil)) {
    const disguisedFaction = String(profileLike?.factionDisguiseName || "").trim();
    if (disguisedFaction) {
      return disguisedFaction;
    }
  }
  return String(profileLike?.factionName || "").trim();
}

function isSystemInventoryItem(item) {
  return SYSTEM_INVENTORY_ITEM_NAMES.has(String(item?.name || "").trim());
}

function hasInventoryItem(profile, predicate) {
  return Array.isArray(profile?.inventory) && profile.inventory.some((item) => predicate(normalizeSystemInventoryItemForDisplay(item)));
}

function renderInventoryItemVisual(item, options = {}) {
  return renderItemVisual(normalizeSystemInventoryItemForDisplay(item), options);
}

function renderProfileItemVisual(item, { eager = false } = {}) {
  const sprite = getItemSprite(item?.spriteKey);
  if (sprite) {
    return `<img src="${escapeHtml(getItemSpriteUrl(sprite))}" alt="${escapeHtml(item?.name || sprite.label)}" class="profile-item-icon profile-item-icon-image"${eager ? ' loading="eager" fetchpriority="high" decoding="async"' : ' loading="lazy"'}${buildItemSpriteFallbackAttributes(sprite)}${buildItemImageStyleAttribute(item)} />`;
  }
  return `<span class="profile-item-icon">${escapeHtml(item?.icon || sprite?.fallbackIcon || "🎁")}</span>`;
}

function buildAdminItemSelector({ inputName, selectorId, placeholder = "아이템을 선택하세요" }) {
  return `
    <div class="item-selector" data-admin-item-selector id="${escapeHtml(selectorId)}" data-placeholder="${escapeHtml(placeholder)}">
      <input type="hidden" name="${escapeHtml(inputName)}" value="" data-item-selector-input />
      <button type="button" class="item-selector-trigger" data-item-selector-trigger aria-expanded="false">
        <span class="item-selector-value" data-item-selector-value>
          <span class="item-selector-label muted" data-item-selector-label>${escapeHtml(placeholder)}</span>
        </span>
        <span class="item-selector-arrow" aria-hidden="true">▾</span>
      </button>
      <div class="item-selector-menu hidden" data-item-selector-menu role="listbox"></div>
    </div>
  `;
}

function buildAdminFactionSelector({
  inputName,
  selectorId,
  selectedValue = "",
  placeholder = "진영을 선택하세요",
  includeEmptyOption = false,
  emptyOptionLabel = "빈 땅",
}) {
  const selectorOptions = [
    ...PROFILE_FACTION_OPTIONS.map((factionName) => ({
      value: factionName,
      label: factionName,
      description: "진영",
    })),
    ...(includeEmptyOption
      ? [{ value: EMPTY_FACTION_SELECTOR_VALUE, label: emptyOptionLabel, description: "점령 해제" }]
      : []),
  ];
  return buildAdminOptionSelector({
    inputName,
    selectorId,
    selectedValue,
    placeholder,
    options: selectorOptions,
    variant: "faction",
    rootAttributes: `data-admin-faction-selector`,
  });
}

function buildAdminOptionSelector({
  inputName,
  selectorId,
  selectedValue = "",
  placeholder = "선택하세요",
  options = [],
  variant = "",
  rootAttributes = "",
}) {
  const normalizedValue = String(selectedValue || "").trim();
  const optionList = Array.isArray(options)
    ? options.map((option) => ({
        value: String(option?.value ?? "").trim(),
        label: String(option?.label ?? option?.value ?? "").trim(),
        description: String(option?.description ?? "").trim(),
      }))
    : [];
  const selectedOption = optionList.find((option) => option.value === normalizedValue) || null;
  const variantClass = variant ? ` ${escapeHtml(`${variant}-selector`)}` : "";
  const variantAttr = variant ? ` data-option-selector-variant="${escapeHtml(variant)}"` : "";
  return `
    <div class="item-selector option-selector${variantClass}" data-admin-option-selector ${rootAttributes} id="${escapeHtml(selectorId)}" data-placeholder="${escapeHtml(placeholder)}" data-option-selector-input-name="${escapeHtml(inputName)}"${variantAttr}>
      <input type="hidden" name="${escapeHtml(inputName)}" value="${escapeHtml(normalizedValue)}" data-option-selector-input />
      <button type="button" class="item-selector-trigger" data-option-selector-trigger aria-expanded="false">
        <span class="item-selector-value" data-option-selector-value>
          ${selectedOption
            ? `<span class="item-selector-selected-copy"><strong>${escapeHtml(selectedOption.label)}</strong>${selectedOption.description ? `<small>${escapeHtml(selectedOption.description)}</small>` : ""}</span>`
            : `<span class="item-selector-label muted" data-option-selector-label>${escapeHtml(placeholder)}</span>`}
        </span>
        <span class="item-selector-arrow" aria-hidden="true">▾</span>
      </button>
      <div class="item-selector-menu hidden" data-option-selector-menu role="listbox">
        ${optionList.map((option) => `
          <button
            type="button"
            class="item-selector-option ${option.value === normalizedValue ? "active" : ""}"
            data-option-selector-option="${escapeHtml(option.value)}"
            data-option-selector-label="${escapeHtml(option.label)}"
            data-option-selector-description="${escapeHtml(option.description)}"
            role="option"
            aria-selected="${option.value === normalizedValue ? "true" : "false"}"
          >
            <span class="item-selector-option-copy">
              <strong>${escapeHtml(option.label)}</strong>
              ${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}
            </span>
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

function buildAdminItemSelectorOption(item, isSelected) {
  const displayItem = normalizeSystemInventoryItemForDisplay(item);
  return `
    <button
      type="button"
      class="item-selector-option ${isSelected ? "active" : ""}"
      data-item-selector-option="${escapeHtml(item.id)}"
      role="option"
      aria-selected="${isSelected ? "true" : "false"}"
    >
      <span class="item-selector-option-visual">${renderItemVisual(displayItem)}</span>
      <span class="item-selector-option-copy">
        <strong>${escapeHtml(displayItem.name || item.id)}</strong>
        <small>${escapeHtml(normalizeSpriteCategory(displayItem.category || "기타 아이템"))}</small>
      </span>
    </button>
  `;
}

function getAdminItemSelectorSearchValue(selector) {
  return String(selector?.dataset?.searchText || "").trim().toLowerCase();
}

function syncAdminOptionSelector(selector, selectedValue, { closeMenu = true } = {}) {
  if (!(selector instanceof HTMLElement)) return;
  const hiddenInput = selector.querySelector("[data-option-selector-input]");
  const valueBox = selector.querySelector("[data-option-selector-value]");
  const menu = selector.querySelector("[data-option-selector-menu]");
  const trigger = selector.querySelector("[data-option-selector-trigger]");
  if (!(hiddenInput instanceof HTMLInputElement) || !(valueBox instanceof HTMLElement) || !(menu instanceof HTMLElement) || !(trigger instanceof HTMLElement)) {
    return;
  }

  const placeholder = selector.dataset.placeholder || "선택하세요";
  const normalizedValue = String(selectedValue || "").trim();
  const selectedOption = Array.from(menu.querySelectorAll("[data-option-selector-option]"))
    .find((option) => String(option.dataset.optionSelectorOption || "").trim() === normalizedValue);

  hiddenInput.value = selectedOption ? normalizedValue : "";
  selector.dataset.selectedOptionValue = hiddenInput.value;
  if (selectedOption) {
    const label = String(selectedOption.dataset.optionSelectorLabel || hiddenInput.value).trim();
    const description = String(selectedOption.dataset.optionSelectorDescription || "").trim();
    valueBox.innerHTML = `<span class="item-selector-selected-copy"><strong>${escapeHtml(label)}</strong>${description ? `<small>${escapeHtml(description)}</small>` : ""}</span>`;
  } else {
    valueBox.innerHTML = `<span class="item-selector-label muted" data-option-selector-label>${escapeHtml(placeholder)}</span>`;
  }

  menu.querySelectorAll("[data-option-selector-option]").forEach((option) => {
    const isSelected = String(option.dataset.optionSelectorOption || "").trim() === hiddenInput.value;
    option.classList.toggle("active", isSelected);
    option.setAttribute("aria-selected", isSelected ? "true" : "false");
  });

  if (closeMenu) {
    menu.classList.add("hidden");
    trigger.classList.remove("is-open");
    trigger.setAttribute("aria-expanded", "false");
    setAdminItemSelectorLayerState(selector, false);
  } else {
    menu.classList.remove("hidden");
    trigger.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");
    setAdminItemSelectorLayerState(selector, true);
  }
}

function setAdminOptionSelectorOptions(selector, options, selectedValue = "") {
  if (!(selector instanceof HTMLElement)) return;
  const menu = selector.querySelector("[data-option-selector-menu]");
  if (!(menu instanceof HTMLElement)) return;
  const optionList = Array.isArray(options)
    ? options.map((option) => ({
        value: String(option?.value ?? "").trim(),
        label: String(option?.label ?? option?.value ?? "").trim(),
        description: String(option?.description ?? "").trim(),
      }))
    : [];
  const normalizedValue = String(selectedValue || "").trim();
  menu.innerHTML = optionList.map((option) => `
    <button
      type="button"
      class="item-selector-option ${option.value === normalizedValue ? "active" : ""}"
      data-option-selector-option="${escapeHtml(option.value)}"
      data-option-selector-label="${escapeHtml(option.label)}"
      data-option-selector-description="${escapeHtml(option.description)}"
      role="option"
      aria-selected="${option.value === normalizedValue ? "true" : "false"}"
    >
      <span class="item-selector-option-copy">
        <strong>${escapeHtml(option.label)}</strong>
        ${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}
      </span>
    </button>
  `).join("");
  syncAdminOptionSelector(selector, normalizedValue);
}

function syncAdminFactionSelector(selector, factionName, { closeMenu = true } = {}) {
  const requestedValue = String(factionName || "").trim();
  const normalizedValue = PROFILE_FACTION_OPTIONS.find((item) => item === requestedValue)
    || (requestedValue === EMPTY_FACTION_SELECTOR_VALUE ? EMPTY_FACTION_SELECTOR_VALUE : "");
  syncAdminOptionSelector(selector, normalizedValue, { closeMenu });
  selector.dataset.selectedFactionName = normalizedValue;
}

function initializeAdminOptionSelectors(root = document) {
  root.querySelectorAll("[data-admin-option-selector]").forEach((selector) => {
    if (selector.dataset.optionBound === "true") return;
    selector.dataset.optionBound = "true";

    const trigger = selector.querySelector("[data-option-selector-trigger]");
    const menu = selector.querySelector("[data-option-selector-menu]");
    const hiddenInput = selector.querySelector("[data-option-selector-input]");
    syncAdminOptionSelector(selector, hiddenInput?.value || "");

    menu?.addEventListener("click", (event) => {
      const option = event.target.closest("[data-option-selector-option]");
      if (!option || !menu.contains(option)) return;
      event.preventDefault();
      event.stopPropagation();
      syncAdminOptionSelector(selector, option.dataset.optionSelectorOption || "");
      if (hiddenInput instanceof HTMLInputElement) {
        hiddenInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    trigger?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const isOpen = !menu?.classList.contains("hidden");
      document.querySelectorAll("[data-admin-option-selector]").forEach((otherSelector) => {
        if (otherSelector === selector) return;
        syncAdminOptionSelector(otherSelector, otherSelector.querySelector("[data-option-selector-input]")?.value || "");
      });
      if (isOpen) {
        syncAdminOptionSelector(selector, hiddenInput?.value || "");
      } else {
        syncAdminOptionSelector(selector, hiddenInput?.value || "", { closeMenu: false });
      }
    });
  });

  if (!document.body.dataset.optionSelectorOutsideBound) {
    document.body.dataset.optionSelectorOutsideBound = "true";
    document.addEventListener("click", (event) => {
      if (event.target.closest("[data-admin-option-selector]")) return;
      document.querySelectorAll("[data-admin-option-selector]").forEach((selector) => {
        syncAdminOptionSelector(selector, selector.querySelector("[data-option-selector-input]")?.value || "");
      });
    });
  }
}

function initializeAdminFactionSelectors(root = document) {
  initializeAdminOptionSelectors(root);
  root.querySelectorAll("[data-admin-faction-selector]").forEach((selector) => {
    const hiddenInput = selector.querySelector("[data-option-selector-input]");
    syncAdminFactionSelector(selector, hiddenInput?.value || "");
  });
}

function getFilteredAdminItemSelectorItems(sourceItems, searchText) {
  const normalizedSearch = String(searchText || "").trim().toLowerCase();
  if (!normalizedSearch) return sourceItems;
  return sourceItems.filter((item) => {
    const displayItem = normalizeSystemInventoryItemForDisplay(item);
    const searchable = [
      displayItem?.name,
      displayItem?.shortLabel,
      displayItem?.category,
      item?.id,
    ]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean)
      .join(" ");
    return searchable.includes(normalizedSearch);
  });
}

function buildAdminItemSelectorOptionsMarkup(selector, sourceItems, selectedItemId) {
  const searchText = getAdminItemSelectorSearchValue(selector);
  const filteredItems = getFilteredAdminItemSelectorItems(sourceItems, searchText);
  return filteredItems.length
    ? filteredItems.map((item) => buildAdminItemSelectorOption(item, item.id === selectedItemId)).join("")
    : '<div class="item-selector-empty">조건에 맞는 아이템이 없습니다.</div>';
}

function buildAdminItemSelectorMenuMarkup(selector, sourceItems, selectedItemId) {
  const shouldShowSearch = sourceItems.length > 12;
  const searchMarkup = shouldShowSearch
    ? `
      <label class="item-selector-search">
        <input type="search" value="${escapeHtml(selector.dataset.searchText || "")}" placeholder="아이템 검색" data-item-selector-search />
      </label>
    `
    : "";
  return `
    ${searchMarkup}
    <div class="item-selector-options-scroll">
      ${buildAdminItemSelectorOptionsMarkup(selector, sourceItems, selectedItemId)}
    </div>
  `;
}

function setAdminItemSelectorLayerState(selector, isOpen) {
  if (!(selector instanceof HTMLElement)) return;
  selector.classList.toggle("is-open-layer", Boolean(isOpen));
  const hostCard = selector.closest(".content-card");
  if (hostCard instanceof HTMLElement) {
    hostCard.classList.toggle("item-selector-host-open", Boolean(isOpen));
  }
}

function closeAllAdminItemSelectors() {
  document.querySelectorAll("[data-admin-item-selector]").forEach((selector) => {
    const menu = selector.querySelector("[data-item-selector-menu]");
    const trigger = selector.querySelector("[data-item-selector-trigger]");
    if (menu) menu.classList.add("hidden");
    if (trigger) {
      trigger.classList.remove("is-open");
      trigger.setAttribute("aria-expanded", "false");
    }
    setAdminItemSelectorLayerState(selector, false);
  });
}

function handleAdminItemSelection(selector, nextItemId) {
  if (!selector) return;
  syncAdminItemSelector(selector, nextItemId);
  selector.dispatchEvent(new CustomEvent("itemchange", { bubbles: true, detail: { itemId: String(nextItemId || "").trim() } }));
}

function bindAdminItemSelectorMenu(selector) {
  if (!selector || selector.dataset.menuBound === "true") return;
  selector.dataset.menuBound = "true";
  const menu = selector.querySelector("[data-item-selector-menu]");
  if (!menu) return;

  menu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-item-selector-option]");
    if (!option || !menu.contains(option)) return;
    event.preventDefault();
    event.stopPropagation();
    handleAdminItemSelection(selector, option.dataset.itemSelectorOption || "");
  });

  menu.addEventListener("input", (event) => {
    const searchInput = event.target.closest("[data-item-selector-search]");
    if (!searchInput) return;
    selector.dataset.searchText = String(searchInput.value || "");
    const optionsScroll = menu.querySelector(".item-selector-options-scroll");
    if (optionsScroll) {
      const selectedItemId =
        selector.dataset.selectedItemId || selector.querySelector("[data-item-selector-input]")?.value || "";
      optionsScroll.innerHTML = buildAdminItemSelectorOptionsMarkup(
        selector,
        getAdminItemSelectorSourceItems(selector),
        String(selectedItemId || "").trim()
      );
    }
  });
}

function getAdminItemSelectorSourceItems(selector) {
  const allowedItemIds = normalizeRandomBoxRewardIds(selector?.dataset?.allowedItemIds || []);
  if (!allowedItemIds.length) {
    return adminItemCatalogCache;
  }
  return allowedItemIds
    .map((itemId) => adminItemCatalogCache.find((item) => item.id === itemId))
    .filter(Boolean);
}

function syncAdminItemSelector(selector, itemId, { closeMenu = true } = {}) {
  if (!selector) return;

  const hiddenInput = selector.querySelector("[data-item-selector-input]");
  const valueBox = selector.querySelector("[data-item-selector-value]");
  const menu = selector.querySelector("[data-item-selector-menu]");
  const trigger = selector.querySelector("[data-item-selector-trigger]");
  if (!hiddenInput || !valueBox || !menu || !trigger) return;

  const placeholder = selector.dataset.placeholder || "아이템을 선택하세요";
  const normalizedItemId = String(itemId || "").trim();
  const sourceItems = getAdminItemSelectorSourceItems(selector);
  const selectedItem = sourceItems.find((item) => item.id === normalizedItemId) || null;
  const selectedDisplayItem = selectedItem ? normalizeSystemInventoryItemForDisplay(selectedItem) : null;
  hiddenInput.value = selectedItem ? normalizedItemId : "";
  selector.dataset.selectedItemId = selectedItem ? normalizedItemId : "";

  valueBox.innerHTML = selectedItem
    ? `
      <span class="item-selector-selected-visual">${renderItemVisual(selectedDisplayItem)}</span>
      <span class="item-selector-selected-copy">
        <strong>${escapeHtml(selectedDisplayItem.name || selectedItem.id)}</strong>
        <small>${escapeHtml(normalizeSpriteCategory(selectedDisplayItem.category || "기타 아이템"))}</small>
      </span>
    `
    : `<span class="item-selector-label muted" data-item-selector-label>${escapeHtml(placeholder)}</span>`;

  menu.innerHTML = sourceItems.length
    ? buildAdminItemSelectorMenuMarkup(selector, sourceItems, normalizedItemId)
    : '<div class="item-selector-empty">표시할 아이템이 없습니다.</div>';

  bindAdminItemSelectorMenu(selector);
  if (closeMenu) {
    menu.classList.add("hidden");
    trigger.classList.remove("is-open");
    trigger.setAttribute("aria-expanded", "false");
    setAdminItemSelectorLayerState(selector, false);
  } else {
    menu.classList.remove("hidden");
    trigger.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");
    setAdminItemSelectorLayerState(selector, true);
  }
}

function initializeAdminItemSelectors(root = document) {
  root.querySelectorAll("[data-admin-item-selector]").forEach((selector) => {
    if (selector.dataset.bound === "true") return;
    selector.dataset.bound = "true";

    const trigger = selector.querySelector("[data-item-selector-trigger]");
    const menu = selector.querySelector("[data-item-selector-menu]");

    bindAdminItemSelectorMenu(selector);

    trigger?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const isOpen = !menu?.classList.contains("hidden");
      closeAllAdminItemSelectors();
      if (!isOpen && menu) {
        menu.classList.remove("hidden");
        trigger.classList.add("is-open");
        trigger.setAttribute("aria-expanded", "true");
        setAdminItemSelectorLayerState(selector, true);
      }
    });
  });

  if (!document.body.dataset.itemSelectorOutsideBound) {
    document.body.dataset.itemSelectorOutsideBound = "true";
    document.addEventListener("click", (event) => {
      if (event.target.closest("[data-admin-item-selector]")) return;
      closeAllAdminItemSelectors();
    });
  }
}

function buildCategoryOverrideOptions(selectedValue = "") {
  const normalizedSelected = normalizeSpriteCategory(selectedValue || "기타 아이템");
  return itemSpriteCategories
    .map((category) => ({
      value: category,
      label: category,
      description: category === normalizedSelected ? "현재 카테고리" : "카테고리 선택",
    }));
}

function getRandomBoxTypeByItemName(itemName) {
  const normalized = normalizeSystemItemName(itemName).replace(/\s+/g, "");
  if (normalized === "랜덤박스:소모품") return "소모품";
  if (normalized === "랜덤박스:의상") return "의상";
  if (normalized === "랜덤박스:프로필꾸미기") return "프로필 꾸미기";
  return "";
}

function normalizeRandomBoxRewardIds(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
  }
  const raw = String(value || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? [...new Set(parsed.map((item) => String(item || "").trim()).filter(Boolean))]
      : [];
  } catch {
    return [...new Set(raw.split(",").map((item) => String(item || "").trim()).filter(Boolean))];
  }
}

function renderRandomBoxRewardList(form) {
  const hiddenInput = form?.querySelector("[data-random-box-reward-input]");
  const list = form?.querySelector("[data-random-box-reward-list]");
  if (!(hiddenInput instanceof HTMLInputElement) || !(list instanceof HTMLElement)) return;
  const rewardIds = normalizeRandomBoxRewardIds(hiddenInput.value);
  if (form?.matches?.("[data-random-box-admin-form]")) {
    const items = rewardIds
      .map((itemId) => adminItemCatalogCache.find((item) => item.id === itemId) || adminItemCatalog.find((item) => item.id === itemId))
      .filter(Boolean);
    if (!items.length) {
      list.classList.remove("hidden");
      list.classList.add("muted");
      list.innerHTML = "등록된 보상이 없습니다.";
      return;
    }

    list.classList.add("hidden");
    list.classList.remove("muted");
    list.innerHTML = "";
    return;
  }

  const items = rewardIds
    .map((itemId) => adminItemCatalog.find((item) => item.id === itemId))
    .filter(Boolean);

  if (!items.length) {
    list.classList.add("muted");
    list.innerHTML = "등록된 보상이 없습니다.";
    return;
  }

  list.classList.remove("muted");
  list.innerHTML = items
    .map(
      (item) => `
        <div class="random-box-reward-chip">
          <span class="random-box-reward-visual">${renderInventoryItemVisual(item)}</span>
          <span class="random-box-reward-copy">${escapeHtml(item.name || item.id)}</span>
          <button type="button" class="ghost-button compact-button danger-button" data-random-box-remove-id="${escapeHtml(item.id)}">제거</button>
        </div>
      `
    )
    .join("");

  list.querySelectorAll("[data-random-box-remove-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextIds = rewardIds.filter((itemId) => itemId !== String(button.dataset.randomBoxRemoveId || "").trim());
      hiddenInput.value = JSON.stringify(nextIds);
      renderRandomBoxRewardList(form);
    });
  });
}

function bindAdminItemMetaForm(form, forceRefresh = false) {
  if (!form) return;
  if (form.dataset.metaBound === "true" && !forceRefresh) return;

  const picker = form.querySelector("[data-sprite-picker]");
  const hiddenSpriteInput = picker?.querySelector("[data-sprite-hidden]");
  const categoryInput = form.elements.category;
  const categoryDisplay = form.querySelector("[data-sprite-category-display]");
  const categoryEditToggle = form.querySelector("[data-category-edit-toggle]");
  const categoryEditRow = form.querySelector("[data-category-edit-row]");
  const categoryOverrideInput = form.elements.categoryOverride;
  const categoryOverrideSelector = form.querySelector('[data-admin-option-selector][data-option-selector-input-name="categoryOverride"]');
  const foodRewardRow = form.querySelector("[data-food-reward-row]");
  const foodRewardInput = form.elements.foodCurrencyReward;
  const colorPresetInput = form.elements.colorPreset;
  const colorPresetButtons = Array.from(form.querySelectorAll("[data-color-preset-button]"));
  const sellInShopCheckbox = form.elements.sellInShop;
  const priceRow = form.querySelector("[data-shop-price-row]");
  const priceInput = form.elements.price;
  const customSpriteUpload = form.querySelector("[data-custom-sprite-upload]");
  const itemNameInput = form.elements.name;
  const randomBoxConfig = form.querySelector("[data-random-box-config]");
  const randomBoxTypeLabel = form.querySelector("[data-random-box-type-label]");
  const randomBoxRewardInput = form.querySelector("[data-random-box-reward-input]");
  const randomBoxSelector = form.querySelector("[data-admin-item-selector][id*='random-box-reward-select']");
  const randomBoxAddButton = form.querySelector("[data-random-box-add-button]");
  const randomBoxHint = form.querySelector("[data-random-box-hint]");

  const syncRandomBoxConfig = () => {
    const randomBoxType = getRandomBoxTypeByItemName(itemNameInput?.value || "");
    randomBoxConfig?.classList.toggle("is-disabled", !randomBoxType);
    if (randomBoxTypeLabel) {
      randomBoxTypeLabel.textContent = randomBoxType ? `${randomBoxType} 보상 목록` : "랜덤박스 3종 전용";
    }
    if (randomBoxHint) {
      randomBoxHint.textContent = randomBoxType
        ? `${randomBoxType} 랜덤박스에서 나올 수 있는 아이템을 골라주세요.`
        : "아이템 이름을 랜덤박스:소모품 / 랜덤박스:의상 / 랜덤박스:프로필 꾸미기 중 하나로 입력하면 활성화됩니다.";
    }
    if (randomBoxSelector instanceof HTMLElement) {
      randomBoxSelector.classList.toggle("is-disabled", !randomBoxType);
      randomBoxSelector.querySelectorAll("button, input").forEach((element) => {
        element.disabled = !randomBoxType;
      });
    }
    if (randomBoxAddButton instanceof HTMLButtonElement) {
      randomBoxAddButton.disabled = !randomBoxType;
    }
    if (!randomBoxType && randomBoxRewardInput instanceof HTMLInputElement && !forceRefresh) {
      randomBoxRewardInput.value = "[]";
    }
    renderRandomBoxRewardList(form);
  };

  const syncCategory = () => {
    const autoCategory = getItemSpriteCategory(hiddenSpriteInput?.value || "");
    const manualCategory = String(categoryOverrideInput?.value || "").trim();
    const category = form.dataset.categoryMode === "manual" && manualCategory
      ? normalizeSpriteCategory(manualCategory)
      : autoCategory;
    if (categoryInput) {
      categoryInput.value = category;
    }
    if (categoryDisplay) {
      categoryDisplay.textContent = category;
    }
    if (categoryOverrideSelector && form.dataset.categoryMode !== "manual") {
      setAdminOptionSelectorOptions(categoryOverrideSelector, buildCategoryOverrideOptions(autoCategory), autoCategory);
    }
  };

  const syncShopRow = () => {
    const enabled = Boolean(sellInShopCheckbox?.checked);
    priceRow?.classList.toggle("is-disabled", !enabled);
    if (priceInput) {
      priceInput.disabled = !enabled;
      if (!enabled && !forceRefresh) {
        priceInput.value = "0";
      }
    }
  };

  const syncFoodRewardRow = () => {
    const isFood = String(categoryInput?.value || "").trim() === "음식";
    foodRewardRow?.classList.toggle("hidden", !isFood);
    if (foodRewardInput) {
      foodRewardInput.disabled = !isFood;
      if (!isFood) {
        foodRewardInput.value = "0";
      }
    }
  };

  const syncColorPresetPreview = () => {
    const presetId = String(colorPresetInput?.value || "").trim();
    const filter = getItemColorPresetFilter(presetId);
    colorPresetButtons.forEach((button) => {
      const isActive = String(button.dataset.colorPreset || "") === presetId;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });

    const selectedPreviewImage = picker?.querySelector(".sprite-picker-selected-image");
    if (!selectedPreviewImage) return;
    if (filter) {
      selectedPreviewImage.style.filter = filter;
      return;
    }
    selectedPreviewImage.style.removeProperty("filter");
  };

  initializeAdminOptionSelectors(form);
  syncCategory();
  syncShopRow();
  syncFoodRewardRow();
  syncColorPresetPreview();
  syncRandomBoxConfig();

  if (form.dataset.metaBound !== "true") {
    itemNameInput?.addEventListener("input", syncRandomBoxConfig);
    picker?.addEventListener("spritechange", () => {
      syncCategory();
      syncFoodRewardRow();
      syncColorPresetPreview();
    });
    categoryEditToggle?.addEventListener("click", () => {
      const isManual = form.dataset.categoryMode === "manual";
      form.dataset.categoryMode = isManual ? "auto" : "manual";
      categoryEditRow?.classList.toggle("hidden", isManual);
      if (!isManual && categoryOverrideSelector) {
        setAdminOptionSelectorOptions(
          categoryOverrideSelector,
          buildCategoryOverrideOptions(categoryInput?.value || "기타"),
          categoryInput?.value || "기타"
        );
      }
      if (categoryEditToggle) {
        categoryEditToggle.textContent = isManual ? "카테고리 수정" : "자동 카테고리 사용";
      }
      syncCategory();
      syncFoodRewardRow();
    });
    categoryOverrideInput?.addEventListener("change", () => {
      syncCategory();
      syncFoodRewardRow();
    });
    colorPresetButtons.forEach((button) => {
      button.addEventListener("click", () => {
        if (colorPresetInput) {
          colorPresetInput.value = String(button.dataset.colorPreset || "");
        }
        syncColorPresetPreview();
      });
    });
    sellInShopCheckbox?.addEventListener("change", syncShopRow);
    randomBoxAddButton?.addEventListener("click", () => {
      if (!(randomBoxRewardInput instanceof HTMLInputElement) || !(randomBoxSelector instanceof HTMLElement)) return;
      const candidateId = String(randomBoxSelector.querySelector("[data-item-selector-input]")?.value || "").trim();
      if (!candidateId) return;
      const currentIds = normalizeRandomBoxRewardIds(randomBoxRewardInput.value);
      if (!currentIds.includes(candidateId)) {
        currentIds.push(candidateId);
      }
      randomBoxRewardInput.value = JSON.stringify(currentIds);
      renderRandomBoxRewardList(form);
      syncAdminItemSelector(randomBoxSelector, candidateId);
    });
    customSpriteUpload?.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (!file || !hiddenSpriteInput) return;
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const label = form.querySelector("[data-custom-dot-label]");
        if (label) label.textContent = "업로드 중...";
        const downloadUrl = await uploadItemDotImage({ dataUrl, fileName: file.name });
        const customSprite = registerCustomItemSprite({ url: downloadUrl, label: file.name });
        hiddenSpriteInput.value = customSprite?.key || `custom:${downloadUrl}`;
        syncItemSpritePicker(picker, hiddenSpriteInput.value);
        syncCategory();
        syncFoodRewardRow();
        syncColorPresetPreview();
        if (label) label.textContent = "업로드 완료";
      } catch (error) {
        window.alert(error.message || "도트 이미지 업로드에 실패했습니다.");
        const label = form.querySelector("[data-custom-dot-label]");
        if (label) label.textContent = "파일 선택";
      } finally {
        event.target.value = "";
      }
    });
    form.dataset.metaBound = "true";
  }

  if (forceRefresh) {
    form.dataset.categoryMode = "auto";
    categoryEditRow?.classList.add("hidden");
    if (categoryEditToggle) {
      categoryEditToggle.textContent = "카테고리 수정";
    }
    syncCategory();
    syncShopRow();
    syncFoodRewardRow();
    syncColorPresetPreview();
    syncRandomBoxConfig();
  }
}

function initializeItemSpritePickers(root = document) {
  root.querySelectorAll("[data-sprite-picker]").forEach((picker) => {
    if (picker.dataset.bound === "true") return;
    picker.dataset.bound = "true";

    const hiddenInput = picker.querySelector("[data-sprite-hidden]");
    const searchInput = picker.querySelector("[data-sprite-search-input]");
    const selection = picker.querySelector("[data-sprite-selection]");
    const emptyState = picker.querySelector("[data-sprite-empty]");

    const getOptionButtons = () => Array.from(picker.querySelectorAll("[data-sprite-key]"));
    const getFilterButtons = () => Array.from(picker.querySelectorAll("[data-sprite-filter-category]"));

    const emitSpriteChange = () => {
      picker.dispatchEvent(new CustomEvent("spritechange", { bubbles: true }));
    };

    const renderSelection = () => {
      const sprite = getItemSprite(hiddenInput?.value);
      if (!selection) return;

      if (!sprite) {
        selection.innerHTML = '<span class="sprite-picker-selection-empty">선택된 도트가 없습니다.</span>';
        return;
      }

      selection.innerHTML = `
        <div class="sprite-picker-selected-card">
          <span class="sprite-picker-selected-thumb">
            <img src="${escapeHtml(getItemSpriteUrl(sprite))}" alt="${escapeHtml(sprite.label)}" class="sprite-picker-selected-image" loading="lazy"${buildItemSpriteFallbackAttributes(sprite)} />
          </span>
          <span class="sprite-picker-selected-copy">
            <strong>${escapeHtml(sprite.label)}</strong>
            <small>${escapeHtml(normalizeSpriteCategory(sprite.category || "기타"))}</small>
          </span>
          <button type="button" class="sprite-picker-clear" data-sprite-clear>선택 해제</button>
        </div>
      `;
    };

    const renderVisibleOptions = () => {
      const optionButtons = getOptionButtons();
      const filterButtons = getFilterButtons();
      const currentCategory =
        filterButtons.find((button) => button.classList.contains("active"))?.dataset.spriteFilterCategory || "";
      const searchText = String(searchInput?.value || "").trim().toLowerCase();
      let visibleCount = 0;

      optionButtons.forEach((button) => {
        const matchesCategory = !currentCategory || button.dataset.spriteCategory === currentCategory;
        const matchesSearch = !searchText || String(button.dataset.spriteSearch || "").includes(searchText);
        const isVisible = matchesCategory && matchesSearch;
        button.classList.toggle("hidden", !isVisible);
        if (isVisible) {
          visibleCount += 1;
        }
      });

      emptyState?.classList.toggle("hidden", visibleCount > 0);
    };

    const syncActiveOption = () => {
      const selectedKey = String(hiddenInput?.value || "");
      const optionButtons = getOptionButtons();
      optionButtons.forEach((button) => {
        const isActive = button.dataset.spriteKey === selectedKey;
        button.classList.toggle("active", isActive);
        button.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
      renderSelection();
    };

    searchInput?.addEventListener("input", () => {
      renderVisibleOptions();
    });

    const handlePickerAction = (event) => {
      const clearButton = event.target.closest("[data-sprite-clear]");
      if (clearButton) {
        event.preventDefault();
        if (hiddenInput) {
          hiddenInput.value = "";
        }
        syncActiveOption();
        emitSpriteChange();
        return;
      }

      const filterButton = event.target.closest("[data-sprite-filter-category]");
      if (filterButton) {
        event.preventDefault();
        getFilterButtons().forEach((entry) => entry.classList.toggle("active", entry === filterButton));
        renderVisibleOptions();
        return;
      }

      const optionButton = event.target.closest("[data-sprite-key]");
      if (optionButton) {
        event.preventDefault();
        if (hiddenInput) {
          hiddenInput.value = optionButton.dataset.spriteKey || "";
        }
        syncActiveOption();
        emitSpriteChange();
      }
    };

    picker.addEventListener("click", handlePickerAction);

    syncActiveOption();
    renderVisibleOptions();
  });
}

function syncItemSpritePicker(picker, spriteKey) {
  if (!picker) return;
  const hiddenInput = picker.querySelector("[data-sprite-hidden]");
  if (!hiddenInput) return;
  hiddenInput.value = String(spriteKey || "").trim();

  const searchInput = picker.querySelector("[data-sprite-search-input]");
  const selection = picker.querySelector("[data-sprite-selection]");
  const emptyState = picker.querySelector("[data-sprite-empty]");
  const optionButtons = Array.from(picker.querySelectorAll("[data-sprite-key]"));
  const filterButtons = Array.from(picker.querySelectorAll("[data-sprite-filter-category]"));
  const selectedSprite = getItemSprite(hiddenInput.value);

  if (searchInput) {
    searchInput.value = "";
  }

  filterButtons.forEach((button, index) => {
    button.classList.toggle("active", index === 0);
  });

  optionButtons.forEach((button) => {
    const isActive = button.dataset.spriteKey === hiddenInput.value;
    button.classList.toggle("active", isActive);
    button.classList.remove("hidden");
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });

  emptyState?.classList.add("hidden");

  if (selection) {
    selection.innerHTML = selectedSprite
      ? `
        <div class="sprite-picker-selected-card">
          <span class="sprite-picker-selected-thumb">
            <img src="${escapeHtml(getItemSpriteUrl(selectedSprite))}" alt="${escapeHtml(selectedSprite.label)}" class="sprite-picker-selected-image" loading="lazy"${buildItemSpriteFallbackAttributes(selectedSprite)} />
          </span>
          <span class="sprite-picker-selected-copy">
            <strong>${escapeHtml(selectedSprite.label)}</strong>
            <small>${escapeHtml(normalizeSpriteCategory(selectedSprite.category || "기타"))}</small>
          </span>
          <button type="button" class="sprite-picker-clear" data-sprite-clear>선택 해제</button>
        </div>
      `
      : '<span class="sprite-picker-selection-empty">선택된 도트가 없습니다.</span>';
  }

  picker.dispatchEvent(new CustomEvent("spritechange", { bubbles: true }));
}

function buildDisplayRankings(rankings) {
  const sorted = [...(Array.isArray(rankings) ? rankings : [])];
  const hasServerRanks = sorted.every((item) => Number.isFinite(Number(item?.displayRank)));
  if (!hasServerRanks) {
    sorted.sort((left, right) => {
      const pointDiff = Number(right.rankingPoints || 0) - Number(left.rankingPoints || 0);
      if (pointDiff !== 0) {
        return pointDiff;
      }
      return String(left.characterName || "").localeCompare(String(right.characterName || ""), "ko");
    });
  }

  let lastDisplayRank = 0;
  return sorted.map((item, index) => {
    if (hasServerRanks) {
      return {
        ...item,
        displayRank: Number(item.displayRank || index + 1),
      };
    }
    const previousPoints = index > 0 ? Number(sorted[index - 1].rankingPoints || 0) : null;
    const currentPoints = Number(item.rankingPoints || 0);
    const displayRank = index > 0 && previousPoints === currentPoints ? lastDisplayRank : index + 1;
    lastDisplayRank = displayRank;
    return { ...item, displayRank };
  });
}

function formatRankingScoreValue(value, scoreUnit = "points") {
  const numericValue = Number(value || 0);
  if (scoreUnit === "percent") {
    if (Math.abs(numericValue) < 0.005) {
      return "0%";
    }
    const rounded = Math.round(numericValue * 100) / 100;
    const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, "");
    return `${text}%`;
  }
  return String(Math.round(numericValue));
}

function roundRankingTerritoryValue(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function renderRankingModeTable(body, rankings, scoreUnit = "points") {
  if (!(body instanceof HTMLElement)) return;
  if (!rankings.length) {
    body.innerHTML = '<tr><td colspan="6" class="table-empty">표시할 랭킹이 없습니다.</td></tr>';
    return;
  }

  body.innerHTML = rankings
    .map(
      (item) => `
        <tr>
          <td>${item.displayRank}</td>
          <td><button type="button" class="text-button ranking-profile-button" data-ranking-character="${escapeHtml(item.characterName || "")}"${buildCharacterNameStyleAttribute(item)}>${buildDisplayedCharacterNameMarkup(item)}</button></td>
          <td>${escapeHtml(item.nickname || "-")}</td>
          <td>${Number(item.currency || 0)} 환</td>
          <td>${escapeHtml(formatRankingScoreValue(item.rankingPoints, scoreUnit))}</td>
          <td>${escapeHtml(getDisplayedRankingFactionName(item) || "-")}</td>
        </tr>
      `
    )
    .join("");
}

function formatRankingDateLabel(dateKey) {
  const matched = String(dateKey || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) {
    return "날짜 정보 없음";
  }
  return `${matched[1]}-${matched[2]}-${matched[3]}`;
}

function buildFactionScoreBarMarkup(factionScores) {
  const rawTotals = factionScores?.barTotals || factionScores?.rawTotals || {};
  const scoreUnit = String(factionScores?.barUnit || factionScores?.displayUnit || "points").trim();
  const factions = [
    { name: "매화", className: "faction-maehwa" },
    { name: "난초", className: "faction-nancho" },
    { name: "국화", className: "faction-gukhwa" },
    { name: "대나무", className: "faction-daenamu" },
  ];
  const numericValues = factions.map((faction) => Number(rawTotals[faction.name] || 0));
  const hasNegativeValue = numericValues.some((value) => value < 0);
  const minimumValue = hasNegativeValue ? Math.min(...numericValues) : 0;
  const layoutTotals = factions.reduce((result, faction) => {
    const value = Number(rawTotals[faction.name] || 0);
    result[faction.name] = hasNegativeValue ? Math.max(0, value - minimumValue) : Math.max(0, value);
    return result;
  }, {});
  const positiveTotal = factions.reduce((sum, faction) => sum + Number(layoutTotals[faction.name] || 0), 0);
  const useEqualLayout = positiveTotal <= 0;
  const useMinimumVisibility = !useEqualLayout && scoreUnit !== "percent";
  const minimumSegmentRatio = useMinimumVisibility ? 1.2 : 0;
  const distributableRatio = Math.max(0, 100 - (minimumSegmentRatio * factions.length));

  const segments = factions
    .map((faction) => {
      const value = Number(rawTotals[faction.name] || 0);
      const layoutValue = Number(layoutTotals[faction.name] || 0);
      const positiveRatio = positiveTotal > 0 ? (layoutValue / positiveTotal) * distributableRatio : 0;
      const ratio = useEqualLayout ? 25 : minimumSegmentRatio + positiveRatio;
      const displayValue = formatRankingScoreValue(value, scoreUnit);
      return `
        <div class="faction-score-segment ${faction.className}" style="width:${ratio.toFixed(2)}%" data-tooltip="${escapeHtml(`${faction.name} ${displayValue}`)}" aria-label="${escapeHtml(`${faction.name} ${displayValue}`)}">
          <span class="faction-score-value">${escapeHtml(displayValue)}</span>
        </div>
      `;
    })
    .join("");

  return `
    <div class="faction-score-bar${useEqualLayout ? " is-empty" : ""}">
      ${segments}
    </div>
  `;
}

function buildFactionSummaryMarkup(factionScores, territory) {
  const rawTotals = factionScores?.rawTotals || {};
  const displayUnit = String(factionScores?.displayUnit || "points").trim();
  const remainingTotals = factionScores?.remainingTotals || territory?.remainingTotals || {};
  const captureCounts = factionScores?.captureCounts || territory?.captureCounts || {};
  const captureThreshold = Math.max(1, Number(territory?.regularCaptureThreshold || 100));
  const hold = territory?.regularClaimHold;
  const heldFactions = new Set(Array.isArray(hold?.factions) ? hold.factions : []);
  const factions = [
    { name: "매화", className: "faction-maehwa" },
    { name: "난초", className: "faction-nancho" },
    { name: "국화", className: "faction-gukhwa" },
    { name: "대나무", className: "faction-daenamu" },
  ];

  return `
    <div class="ranking-faction-stack">
      ${buildFactionScoreBarMarkup(factionScores)}
      <div class="ranking-faction-cards">
        ${factions
          .map((faction) => {
            const rawTotal = Number(rawTotals[faction.name] || 0);
            const remaining = Number(remainingTotals[faction.name] || 0);
            const captures = Number(captureCounts[faction.name] || 0);
            const gauge = rawTotal > 0
              ? Math.max(0, Math.min(100, (Math.max(0, remaining) / captureThreshold) * 100))
              : 0;
            const pointsToNextCapture = Math.max(0, roundRankingTerritoryValue(captureThreshold - remaining));
            const isClaimHeld = territory?.phase === "regular"
              && hold?.availableCells === 1
              && heldFactions.has(faction.name)
              && remaining >= captureThreshold;
            return `
              <article class="ranking-faction-card ${faction.className}">
                <div>
                  <strong>${escapeHtml(faction.name)}</strong>
                  <span>합산 ${escapeHtml(formatRankingScoreValue(rawTotal, displayUnit))}</span>
                </div>
                <div class="ranking-faction-progress">
                  <div class="ranking-faction-progress-bar">
                    <span style="width:${gauge}%"></span>
                  </div>
                  <small>${escapeHtml(
                    isClaimHeld
                      ? `점령 ${captures}칸 / 마지막 1칸 동점 보류`
                      : `점령 ${captures}칸 / 다음 점령까지 ${formatRankingScoreValue(pointsToNextCapture, "points")}`
                  )}</small>
                </div>
              </article>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function ensureDashboardFactionBar(statsStrip) {
  if (!(statsStrip instanceof HTMLElement)) return;
  let card = statsStrip.querySelector("[data-dashboard-faction-bar]");
  if (!card) {
    card = document.createElement("div");
    card.className = "stats-faction-bar-card";
    card.setAttribute("data-dashboard-faction-bar", "true");
    card.innerHTML = '<div class="faction-score-bar is-empty"><div class="faction-score-segment faction-maehwa" style="width:25%" data-tooltip="매화 0" aria-label="매화 0"><span class="faction-score-value">0</span></div><div class="faction-score-segment faction-nancho" style="width:25%" data-tooltip="난초 0" aria-label="난초 0"><span class="faction-score-value">0</span></div><div class="faction-score-segment faction-gukhwa" style="width:25%" data-tooltip="국화 0" aria-label="국화 0"><span class="faction-score-value">0</span></div><div class="faction-score-segment faction-daenamu" style="width:25%" data-tooltip="대나무 0" aria-label="대나무 0"><span class="faction-score-value">0</span></div></div>';
    statsStrip.insertAdjacentElement("afterbegin", card);
  }
}

async function hydrateDashboardFactionBar() {
  const card = document.querySelector("[data-dashboard-faction-bar]");
  if (!(card instanceof HTMLElement)) return;
  try {
    const board = await getCurrentRankingBoardSnapshot(false);
    card.innerHTML = buildFactionScoreBarMarkup(board?.currentFactionScores || board?.factionScores);
  } catch {
    card.innerHTML = buildFactionScoreBarMarkup(null);
  }
}

function buildTerritoryMapMarkup(territory) {
  const cells = Array.isArray(territory?.cells) && territory.cells.length ? territory.cells : buildFallbackTerritoryCells();
  const hold = territory?.regularClaimHold;
  const captureCounts = PROFILE_FACTION_OPTIONS.reduce((result, factionName) => {
    result[factionName] = 0;
    return result;
  }, {});
  let contestedCount = 0;
  cells.forEach((cell) => {
    const ownerFaction = String(cell?.ownerFaction || "").trim();
    if (ownerFaction && Object.prototype.hasOwnProperty.call(captureCounts, ownerFaction)) {
      captureCounts[ownerFaction] += 1;
      return;
    }
    if (ownerFaction === "__contested__") contestedCount += 1;
  });
  const sideGroups = [
    [
      { name: "매화", className: "faction-maehwa" },
      { name: "난초", className: "faction-nancho" },
    ],
    [
      { name: "국화", className: "faction-gukhwa" },
      { name: "대나무", className: "faction-daenamu" },
    ],
  ];

  const size = 22;
  const layoutCells = cells.map((cell) => {
    const q = Number(cell.q || 0);
    const r = Number(cell.r || 0);
    return {
      ...cell,
      x: size * Math.sqrt(3) * (q + r / 2),
      y: size * 1.5 * r,
    };
  });

  const minX = Math.min(...layoutCells.map((cell) => cell.x));
  const maxX = Math.max(...layoutCells.map((cell) => cell.x));
  const minY = Math.min(...layoutCells.map((cell) => cell.y));
  const maxY = Math.max(...layoutCells.map((cell) => cell.y));
  const padding = 40;
  const width = Math.max(320, maxX - minX + padding * 2);
  const height = Math.max(320, maxY - minY + padding * 2);
  const hexPoints = buildHexPoints(size);

  return `
    ${territory?.phase === "regular" && hold?.availableCells === 1 && Array.isArray(hold.factions) && hold.factions.length > 1
      ? `<p class="muted">마지막 1칸 지급 보류: ${escapeHtml(hold.factions.join(", "))} 동점 ${escapeHtml(formatRankingScoreValue(hold.points || 0, "points"))}</p>`
      : ""}
    ${territory?.phase === "war" && contestedCount > 0
      ? `<div class="territory-contested-summary"><span class="territory-contested-badge">투쟁중 지역: ${contestedCount}</span></div>`
      : ""}
    <div class="territory-map-shell">
      <aside class="territory-side territory-side-left">
        ${sideGroups[0]
          .map(
            (faction) => `
              <article class="territory-side-card ${faction.className}">
                <strong>${escapeHtml(faction.name)}</strong>
                <span>${Number(captureCounts[faction.name] || 0)}칸</span>
              </article>
            `
          )
          .join("")}
      </aside>
      <div class="territory-map-center">
        <svg viewBox="0 0 ${width} ${height}" class="territory-svg" role="img" aria-label="파벌 영토 지도">
          <defs>
            <linearGradient id="territory-gradient-neutral" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="rgba(188, 194, 202, 0.36)" />
              <stop offset="58%" stop-color="rgba(216, 222, 230, 0.42)" />
              <stop offset="100%" stop-color="rgba(255, 255, 255, 0.74)" />
            </linearGradient>
            <linearGradient id="territory-gradient-maehwa" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="rgba(112, 22, 38, 0.95)" />
              <stop offset="54%" stop-color="rgba(148, 34, 53, 0.9)" />
              <stop offset="100%" stop-color="rgba(255, 212, 220, 0.88)" />
            </linearGradient>
            <linearGradient id="territory-gradient-nancho" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="rgba(8, 10, 14, 0.98)" />
              <stop offset="54%" stop-color="rgba(20, 24, 30, 0.98)" />
              <stop offset="100%" stop-color="rgba(232, 238, 246, 0.8)" />
            </linearGradient>
            <linearGradient id="territory-gradient-gukhwa" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="rgba(156, 160, 170, 0.94)" />
              <stop offset="54%" stop-color="rgba(218, 220, 226, 0.94)" />
              <stop offset="100%" stop-color="rgba(255, 255, 255, 0.96)" />
            </linearGradient>
            <linearGradient id="territory-gradient-daenamu" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="rgba(26, 92, 47, 0.95)" />
              <stop offset="54%" stop-color="rgba(42, 126, 68, 0.9)" />
              <stop offset="100%" stop-color="rgba(214, 255, 224, 0.82)" />
            </linearGradient>
            <linearGradient id="territory-gradient-contested" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="rgba(132, 44, 8, 0.94)" />
              <stop offset="54%" stop-color="rgba(208, 82, 24, 0.9)" />
              <stop offset="100%" stop-color="rgba(255, 234, 196, 0.84)" />
            </linearGradient>
          </defs>
          ${layoutCells
            .map((cell) => {
              const ownerClass = getTerritoryFactionClass(cell.ownerFaction);
              const cx = cell.x - minX + padding;
              const cy = cell.y - minY + padding;
              const cellNumber = String(cell.id || "").replace(/^cell-/, "");
              const ownerLabel = String(cell.ownerFaction || "").trim() === "__contested__"
                ? "투쟁중"
                : String(cell.ownerFaction || "").trim() || "빈 땅";
              return `
                <g class="territory-cell ${ownerClass}" transform="translate(${cx.toFixed(2)} ${cy.toFixed(2)})" data-tooltip="${escapeHtml(`${cellNumber}번 땅 · ${ownerLabel}`)}" aria-label="${escapeHtml(`${cellNumber}번 땅 · ${ownerLabel}`)}">
                  <ellipse class="territory-cell-shadow" cx="4.2" cy="5.2" rx="8.4" ry="4.6" />
                  <polygon class="territory-cell-glow" points="${hexPoints}" />
                  <polygon class="territory-cell-body" points="${hexPoints}" />
                  <ellipse class="territory-cell-sheen" cx="-4.8" cy="-6.2" rx="7.4" ry="4.2" />
                  <ellipse class="territory-cell-bottom-gloss" cx="0" cy="6.4" rx="8.3" ry="4.6" />
                  <ellipse class="territory-cell-spark" cx="-1.8" cy="-2.6" rx="3.2" ry="1.8" />
                  ${String(cell.ownerFaction || "").trim() === "__contested__"
                    ? '<text class="territory-cell-contested-icon" text-anchor="middle" dominant-baseline="central">⚔️</text>'
                    : ""}
                </g>
              `;
            })
            .join("")}
        </svg>
      </div>
      <aside class="territory-side territory-side-right">
        ${sideGroups[1]
          .map(
            (faction) => `
              <article class="territory-side-card ${faction.className}">
                <strong>${escapeHtml(faction.name)}</strong>
                <span>${Number(captureCounts[faction.name] || 0)}칸</span>
              </article>
            `
          )
          .join("")}
      </aside>
    </div>
  `;
}

function buildFallbackTerritoryCells() {
  const cells = [];
  const frontier = [{ q: 0, r: 0 }];
  const visited = new Set(["0,0"]);
  let cursor = 0;
  while (cursor < frontier.length && cells.length < 100) {
    const current = frontier[cursor];
    cursor += 1;
    cells.push({ id: `fallback-${cells.length + 1}`, q: current.q, r: current.r, ownerFaction: "" });
    [
      { q: current.q + 1, r: current.r },
      { q: current.q - 1, r: current.r },
      { q: current.q, r: current.r + 1 },
      { q: current.q, r: current.r - 1 },
      { q: current.q + 1, r: current.r - 1 },
      { q: current.q - 1, r: current.r + 1 },
    ].forEach((neighbor, index) => {
      if (cells.length + frontier.length >= 100 && index > 1) return;
      const key = `${neighbor.q},${neighbor.r}`;
      if (visited.has(key)) return;
      visited.add(key);
      if ((neighbor.q * 31 + neighbor.r * 17 + index) % 5 !== 0 || frontier.length < 16) {
        frontier.push(neighbor);
      }
    });
  }
  return cells;
}

function buildHexPoints(size) {
  const points = [];
  for (let index = 0; index < 6; index += 1) {
    const angle = Math.PI / 180 * (60 * index - 30);
    points.push(`${(size * Math.cos(angle)).toFixed(2)},${(size * Math.sin(angle)).toFixed(2)}`);
  }
  return points.join(" ");
}

function getTerritoryFactionClass(factionName) {
  if (factionName === "매화") return "faction-maehwa";
  if (factionName === "난초") return "faction-nancho";
  if (factionName === "국화") return "faction-gukhwa";
  if (factionName === "대나무") return "faction-daenamu";
  if (factionName === "__contested__") return "is-contested";
  return "is-neutral";
}

function getFactionThemeClass(factionName) {
  const normalizedFactionName = String(factionName || "").trim();
  if (normalizedFactionName === "매화") return "faction-theme-maehwa";
  if (normalizedFactionName === "난초") return "faction-theme-nancho";
  if (normalizedFactionName === "국화") return "faction-theme-gukhwa";
  if (normalizedFactionName === "대나무") return "faction-theme-daenamu";
  return "faction-theme-neutral";
}

async function loadImageFromFile(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("이미지를 읽지 못했습니다."));
    reader.readAsDataURL(file);
  });

  return await new Promise((resolve, reject) => {
    const target = new Image();
    target.onload = () => resolve(target);
    target.onerror = () => reject(new Error("이미지를 불러오지 못했습니다."));
    target.src = dataUrl;
  });
}

async function compressImageFile(file, maxSize = 960) {
  const image = await loadImageFromFile(file);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("이미지를 처리하지 못했습니다.");
  }

  const longestSide = Math.max(image.width, image.height, 1);
  const ratio = Math.min(1, maxSize / longestSide);
  canvas.width = Math.max(1, Math.round(image.width * ratio));
  canvas.height = Math.max(1, Math.round(image.height * ratio));
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82);
}

function buildReportLogId(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

async function compressCanvas(sourceCanvas, maxSize = 240) {
  const ratio = Math.min(1, maxSize / Math.max(sourceCanvas.width, sourceCanvas.height));
  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = Math.max(1, Math.round(sourceCanvas.width * ratio));
  outputCanvas.height = Math.max(1, Math.round(sourceCanvas.height * ratio));
  const context = outputCanvas.getContext("2d");
  if (!context) {
    throw new Error("이미지 처리를 시작하지 못했습니다.");
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
  if (result) result.textContent = rouletteDropItemMode ? "아이템 DB를 불러오면 돌릴 수 있습니다." : "항목을 추가하면 돌릴 수 있습니다.";
  if (form && !rouletteDropItemMode) form.reset();
}
