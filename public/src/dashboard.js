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
  deleteItemDefinition,
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
  changeUserPassword,
  updateMemberProfile,
  useInventoryItem,
  updateItemDefinition,
  updateProfileSealImage,
} from "./auth.js";

export const menuDefinitions = [
  { id: "ranking", label: "랭킹" },
  { id: "match", label: "대국 정보" },
  { id: "match-results", label: "대국 결과" },
  { id: "traits", label: "특성치" },
  { id: "inventory", label: "인벤토리" },
  { id: "shop", label: "자판기" },
  { id: "roulette", label: "룰렛" },
  { id: "admin", label: "운영진 메뉴", adminOnly: true },
  { id: "bug-report", label: "버그 리포트" },
  { id: "todo", label: "할 일" },
  { id: "item-db", label: "아이템 DB", adminOnly: true },
];

const adminRoles = ["admin", "gm", "moderator"];
const roulettePalette = [
  "#0d285a",
  "#153b7d",
  "#fa5f03",
  "#244f95",
  "#1f6f78",
  "#ff8a3d",
  "#3f88c5",
  "#1b998b",
  "#e36414",
  "#5c6bc0",
  "#2a9d8f",
  "#bc6c25",
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
let activeAdminItemSection = "create";

async function withPendingToast(onToast, task) {
  onToast("처리중입니다");
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

  document.querySelector("#welcome-title").textContent = `${profile.characterName}님 환영합니다`;
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
  const inventoryItems = buildGroupedInventoryItems(profile.inventory)
    .map(({ item, count }) => {
      const tooltip = escapeHtml(`${item.name || "이름 없는 아이템"} | ${item.description || "설명이 아직 등록되지 않았습니다."}`);
      const safeGroupKey = escapeHtml(buildInventoryGroupKey(item));
      const icon = escapeHtml(item.icon || "🎁");
      return `
        <li class="inventory-item inventory-tooltip draggable-item" data-tooltip="${tooltip}" draggable="true" data-inventory-group-key="${safeGroupKey}">
          <div class="dot-slot">${icon}${count > 1 ? `<span class="inventory-count-badge">${count}</span>` : ""}</div>
          <button type="button" class="ghost-button compact-button inventory-use-button" data-inventory-use-group-key="${safeGroupKey}">사용</button>
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
        <h3>랭킹</h3>
        <div class="table-wrap">
          <table class="log-table ranking-table">
            <thead>
              <tr>
                <th>순위</th>
                <th>캐릭터명</th>
                <th>작혼 닉네임</th>
                <th>랭킹전 포인트</th>
                <th>보유 재화</th>
                <th>총 특성치 포인트</th>
              </tr>
            </thead>
            <tbody id="ranking-table-body">
              <tr><td colspan="6" class="table-empty">랭킹을 불러오는 중입니다.</td></tr>
            </tbody>
          </table>
        </div>
      </article>
    `,
    shop: `
      <div id="shop-grid" class="content-grid three">
        <article class="content-card full">
          <p class="muted">자판기 정보를 불러오는 중입니다.</p>
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
            <button type="submit" class="primary-button">리포트 등록</button>
          </form>
        </article>
        <article class="content-card ${adminRoles.includes(profile.role) ? "" : "hidden"}">
          <div class="admin-log-head">
            <h3>접수된 리포트</h3>
            <div class="admin-log-pager">
              <button type="button" class="ghost-button compact-button" data-report-page="prev">이전</button>
              <span id="bug-report-page-label" class="muted">1 페이지</span>
              <button type="button" class="ghost-button compact-button" data-report-page="next">다음</button>
            </div>
          </div>
          <div class="table-wrap">
            <table class="log-table">
              <thead><tr><th>시각</th><th>작성자</th><th>제목</th><th>내용</th></tr></thead>
              <tbody id="bug-report-body"><tr><td colspan="4" class="table-empty">버그 리포트를 불러오는 중입니다.</td></tr></tbody>
            </table>
          </div>
        </article>
      </div>
    `,
    inventory: `
      <div class="content-grid two inventory-layout">
        <article class="content-card full">
          <h3>인벤토리</h3>
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
                <p class="muted">인벤토리 아이템을 여기로 드래그해서 여러 개 넣어주세요.</p>
                <div id="parcel-selected-item" class="parcel-selected-item muted">선택한 아이템이 없습니다.</div>
                <button id="parcel-clear-button" type="button" class="ghost-button compact-button">전체 선택 해제</button>
              </div>
            </div>
            <label><span>보낼 재화</span><input type="number" min="0" name="currencyAmount" placeholder="0" /></label>
            <label class="inline-check parcel-wrap-check">
              <input type="checkbox" name="useWrapping" />
              <span class="check-indicator" aria-hidden="true"></span>
              <span class="check-copy">
                <strong>포장지 사용</strong>
                <small>포장지를 사용하면 내용물을 숨길 수 있고 기본적으로 거절할 수 없습니다. 단, 상대가 거절권을 가지고 있다면 거절할 수 있습니다.</small>
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
            <h3>룰렛 항목</h3>
            <form id="roulette-item-form" class="roulette-inline-form">
              <input type="text" name="name" placeholder="항목 이름" required />
              <button type="submit" class="ghost-button compact-button">추가</button>
            </form>
          </div>
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
          <p>나중에 크롤링 데이터에서 대국중인 항목을 찾고, 그 안의 작혼 닉네임을 캐릭터와 연결해 현재 대국중인 특성치를 hover 정보로 보여주는 구조를 염두에 둔 화면입니다.</p>
          <div class="schema-box">
            <strong>추천 컬렉션 구조</strong>
            <p><code>live-matches</code>에 제목, 상태, 플레이어 목록, 작혼 닉네임, 캐릭터명, 특성치 요약을 저장하는 방식이 확장에 유리합니다.</p>
          </div>
        </article>
      </div>
    `,
    "match-results": `
      <article class="content-card full">
        <div class="result-mode-tabs">
          <div class="admin-section-tabs">
            <button type="button" class="tab-button ${activeResultMode === "ranked-4p-hanchan" ? "active" : ""}" data-result-mode="ranked-4p-hanchan">랭킹전 4인 반장전</button>
            <button type="button" class="tab-button ${activeResultMode === "ranked-3p-hanchan" ? "active" : ""}" data-result-mode="ranked-3p-hanchan">랭킹전 3인 반장전</button>
            <button type="button" class="tab-button ${activeResultMode === "normal-4p-hanchan" ? "active" : ""}" data-result-mode="normal-4p-hanchan">일반전 4인 반장전</button>
            <button type="button" class="tab-button ${activeResultMode === "normal-3p-hanchan" ? "active" : ""}" data-result-mode="normal-3p-hanchan">일반전 3인 반장전</button>
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
    traits: `
      <article class="content-card full">
        <div class="trait-header">
          <div>
            <h3>특성치</h3>
            <p>한 특성치는 한 번만 찍을 수 있습니다. 성공 보너스, 실패 패널티, 필요 포인트를 표로 빠르게 확인할 수 있습니다.</p>
          </div>
          <strong class="trait-point-badge">남은 포인트 ${Number(profile.availableTraitPoints || 0)}</strong>
        </div>
        <div class="table-wrap">
          <table class="log-table trait-table">
            <thead><tr><th>특성명</th><th>성공+</th><th>실패-</th><th>필요P</th><th>상태</th><th>구매</th></tr></thead>
            <tbody id="trait-table-body"><tr><td colspan="6" class="table-empty">특성치를 불러오는 중입니다.</td></tr></tbody>
          </table>
        </div>
      </article>
    `,
    admin: `
      <article class="content-card full">
        <div class="admin-shell">
          <div class="admin-section-tabs">
            <button type="button" class="tab-button ${activeAdminSection === "user-adjust" ? "active" : ""}" data-admin-section="user-adjust">유저 조정</button>
            <button type="button" class="tab-button ${activeAdminSection === "items" ? "active" : ""}" data-admin-section="items">아이템</button>
            <button type="button" class="tab-button ${activeAdminSection === "notice" ? "active" : ""}" data-admin-section="notice">공지 작성</button>
            <button type="button" class="tab-button ${activeAdminSection === "account" ? "active" : ""}" data-admin-section="account">계정 관리</button>
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
      shopGrid.innerHTML = '<article class="content-card full"><p class="muted">자판기에 등록된 아이템이 없습니다.</p></article>';
      return;
    }

    shopGrid.innerHTML = shopItems
      .map(
        (item) => {
          const itemMeta = itemDbMap.get(item.id) || {};
          return `
          <article class="content-card shop-item-card">
            <div class="dot-slot large">${escapeHtml(itemMeta.icon || "🎁")}</div>
            <div class="content-meta">
              <h3>${escapeHtml(item.name || "이름 없음")}</h3>
              <p>${escapeHtml(item.description || "설명 없음")}</p>
              <strong>${Number(item.price || 0)} G</strong>
            </div>
            <div class="shop-purchase-row">
              <label class="shop-quantity-field">
                <span>수량</span>
                <input type="number" min="1" max="99" value="1" data-shop-quantity="${escapeHtml(item.id)}" />
              </label>
              <button type="button" class="primary-button compact-button" data-shop-purchase="${escapeHtml(item.id)}">구매</button>
            </div>
          </article>
        `;
        }
      )
      .join("");

    shopGrid.querySelectorAll("[data-shop-purchase]").forEach((button) => {
      button.addEventListener("click", async () => {
        const quantityInput = shopGrid.querySelector(`[data-shop-quantity="${button.dataset.shopPurchase}"]`);
        const quantity = Math.max(1, Math.min(99, Number(quantityInput?.value || 1)));
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
  } catch (_error) {
    shopGrid.innerHTML = '<article class="content-card full"><p class="muted">자판기 정보를 불러오지 못했습니다.</p></article>';
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

    grid.innerHTML = itemDbItems
      .map(
        (item) => `
          <article class="content-card item-db-card">
            <div class="item-db-icon">${escapeHtml(item.icon || "🎁")}</div>
            <div class="content-meta">
              <h3>${escapeHtml(item.name || "이름 없음")}</h3>
              <p>${escapeHtml(item.description || "설명 없음")}</p>
              <span class="pill-badge">${escapeHtml(item.category || "기타")}</span>
            </div>
          </article>
        `
      )
      .join("");
  } catch (_error) {
    grid.innerHTML = '<article class="content-card full"><p class="muted">아이템 DB를 불러오지 못했습니다.</p></article>';
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
      body.innerHTML = '<tr><td colspan="4" class="table-empty">접수된 버그 리포트가 없습니다.</td></tr>';
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
    body.innerHTML = '<tr><td colspan="4" class="table-empty">버그 리포트를 불러오지 못했습니다.</td></tr>';
  }
}

async function hydrateAdminItemOptions() {
  const selects = Array.from(
    document.querySelectorAll("#admin-item-select, #admin-item-edit-select, #admin-item-delete-select")
  );
  if (!selects.length) return;

  try {
    const items = await fetchCollectionItems("item-db", "sortOrder");
    const optionsHtml = `
      <option value="">아이템을 선택하세요</option>
      ${items
        .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.icon || "🎁")} ${escapeHtml(item.name || item.id)}</option>`)
        .join("")}
    `;
    selects.forEach((select) => {
      select.innerHTML = optionsHtml;
    });
  } catch (_error) {
    selects.forEach((select) => {
      select.innerHTML = '<option value="">아이템을 불러오지 못했습니다</option>';
    });
  }
}

function renderAdminItemQueue() {
  const queue = document.querySelector("#admin-item-queue");
  const select = document.querySelector("#admin-item-select");
  if (!queue) return;

  if (!pendingAdminItemIds.length) {
    queue.innerHTML = '<span class="muted">선택한 아이템이 없습니다.</span>';
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
          ${escapeHtml(optionMap.get(itemId) || itemId)}${count > 1 ? ` x${count}` : ""} ×
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

async function showProfileQuickModal({ profile, viewerProfile, onProfilePatched, onToast }) {
  const modal = ensureProfileQuickModal();
  const content = modal.querySelector("#profile-quick-card");
  const fileInput = modal.querySelector("#profile-seal-input");
  const sealButton = modal.querySelector("#profile-seal-button");
  const closeButton = modal.querySelector("#profile-quick-close");
  const closeIcon = modal.querySelector("#profile-quick-close-icon");
  if (!content || !fileInput || !sealButton || !closeButton || !closeIcon) return;

  modal.classList.remove("hidden");
  content.innerHTML = '<div class="panel empty-state">간단 프로필을 불러오는 중입니다.</div>';

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
  const isOwnProfile = viewerProfile?.uid && viewerProfile.uid === profile.uid;
  const hasHiddenTrait = selectedTraitIds.includes("hidden-trait");
  const traitNames = selectedTraitIds.map((traitId) => traitMap.get(traitId) || traitId).filter(Boolean);
  const usedTraitPoints = traits
    .filter((item) => selectedTraitIds.includes(item.id))
    .reduce((sum, item) => sum + Number(item.requiredPoints || 0), 0);
  const totalTraitPoints = Number(profile.availableTraitPoints || 0) + usedTraitPoints;
  const nicknameList = [profile.nickname, ...(Array.isArray(profile.extraNicknames) ? profile.extraNicknames : [])]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const traitSummary = !isOwnProfile && hasHiddenTrait
    ? "비공개 된 특성입니다."
    : traitNames.length
      ? traitNames.join(", ")
      : "없음";

  content.innerHTML = `
    <div class="profile-lobby-card">
      <div class="profile-lobby-visual">
        <div class="profile-seal-panel">
          ${
            profile.profileSealImage
              ? `<img src="${escapeHtml(profile.profileSealImage)}" alt="프로필 인장" class="profile-seal-art" />`
              : `<div class="profile-seal-fallback">인장</div>`
          }
        </div>
      </div>
      <div class="profile-lobby-meta">
        <p class="eyebrow">PLAYER LOBBY</p>
        <h2>${escapeHtml(profile.characterName || "-")}</h2>
        <div class="profile-lobby-grid">
          <div><span>작혼 닉네임</span><strong>${escapeHtml(nicknameList.join(" / ") || "-")}</strong></div>
          <div><span>현재 랭킹 순위</span><strong>${rankEntry?.displayRank ? `${rankEntry.displayRank}위` : "-"}</strong></div>
          <div><span>랭킹전 포인트</span><strong>${Number(profile.rankingPoints || 0)}</strong></div>
          <div><span>총 대국 수</span><strong>${Number(profile.totalMatches || 0)}</strong></div>
          <div><span>보유 재화</span><strong>${Number(profile.currency || 0)} G</strong></div>
          <div><span>총 스탯 포인트</span><strong>${totalTraitPoints}</strong></div>
        </div>
        <div class="profile-lobby-traits">
          <span>보유 특성치 종류</span>
          <strong>${escapeHtml(traitSummary)}</strong>
        </div>
      </div>
      <div class="profile-lobby-stripes" aria-hidden="true">
        <span></span><span></span><span></span>
      </div>
    </div>
  `;

  sealButton.classList.toggle("hidden", !isOwnProfile);
  fileInput.classList.toggle("hidden", !isOwnProfile);
  sealButton.onclick = () => fileInput.click();
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
  const body = document.querySelector("#ranking-table-body");
  if (!body) return;

  try {
    const rankings = buildDisplayRankings(await getRankingBoard());

    if (!rankings.length) {
      body.innerHTML = '<tr><td colspan="6" class="table-empty">표시할 랭킹이 없습니다.</td></tr>';
      return;
    }

    body.innerHTML = rankings
      .map((item) => {
        return `
          <tr>
            <td>${item.displayRank}</td>
            <td><button type="button" class="text-button ranking-profile-button" data-ranking-character="${escapeHtml(item.characterName || "")}">${escapeHtml(item.characterName || "-")}</button></td>
            <td>${escapeHtml(item.nickname || "-")}</td>
            <td>${Number(item.rankingPoints || 0)}</td>
            <td>${Number(item.currency || 0)} G</td>
            <td>${Number(item.totalTraitPoints || 0)}</td>
          </tr>
        `;
      })
      .join("");

    body.querySelectorAll("[data-ranking-character]").forEach((button) => {
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
          body.insertAdjacentHTML(
            "afterbegin",
            '<tr><td colspan="6" class="table-empty">프로필을 불러오지 못했습니다.</td></tr>'
          );
        }
      });
    });
  } catch (_error) {
    body.innerHTML = '<tr><td colspan="6" class="table-empty">랭킹을 불러오지 못했습니다.</td></tr>';
  }
}

function attachParcelForm({ profile, onProfilePatched, onToast }) {
  const form = document.querySelector("#parcel-form");
  const dropZone = document.querySelector("#parcel-drop-zone");
  const selectedItem = document.querySelector("#parcel-selected-item");
  const clearButton = document.querySelector("#parcel-clear-button");
  const inventoryList = document.querySelector(".inventory-list");
  if (!form) return;

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
        const label = `${item.icon || "🎁"} ${item.name || "아이템"}`;
        const existing = map.get(label) || { count: 0, item };
        existing.count += 1;
        map.set(label, existing);
        return map;
      }, new Map())
    );
    selectedItem.innerHTML = countedItems
      .map(
        ([label, data]) => `
          <button type="button" class="parcel-selected-chip" data-parcel-remove-group="${escapeHtml(buildInventoryGroupKey(data.item))}">
            ${escapeHtml(label)}${data.count > 1 ? ` x${data.count}` : ""}
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
        const extraData = await requestInventoryItemExtraData(availableItem);
        const result = await withPendingToast(onToast, () =>
          useInventoryItem(buildInventoryItemKey(availableItem), extraData)
        );
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
        <span class="notification-bell-icon">🔔</span>
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
    const hasRejectTicket = Array.isArray(profile.inventory)
      ? profile.inventory.some((item) => item?.name === "거절권")
      : false;

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
        const itemPreview = item.wrapped
          ? "내용물을 확인할 수 없는 포장 소포입니다."
          : buildParcelDisplayText(item);
        const rejectControl = item.wrapped
          ? hasRejectTicket
            ? `<button type="button" class="ghost-button compact-button" data-parcel-action="reject" data-parcel-id="${item.id}">거절</button>`
            : '<span class="pill-badge">거절권 필요</span>'
          : `<button type="button" class="ghost-button compact-button" data-parcel-action="reject" data-parcel-id="${item.id}">거절</button>`;
        return {
          id: `parcel-${item.id}`,
          createdAt: getSortTime(item.createdAt),
          html: `
          <article class="info-card compact-info ${item.wrapped ? "is-unread" : ""}">
            <div class="info-card-head">
              <strong>${escapeHtml(item.senderCharacterName || "소포")}</strong>
              <span class="pill-badge">${item.wrapped ? "포장 소포" : "일반 소포"}</span>
            </div>
            <p>${escapeHtml(itemPreview)}</p>
            <div class="action-row">
              <button type="button" class="primary-button compact-button" data-parcel-action="accept" data-parcel-id="${item.id}">수락</button>
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
        try {
          await withPendingToast(onToast, () =>
            respondParcel(button.dataset.parcelId, button.dataset.parcelAction)
          );
          const latestProfile = await refreshCurrentUserProfile().catch(() => profile);
          await onProfilePatched(latestProfile);
          await hydrateNotificationBadge(latestProfile);
          await renderNotificationBellPanel({ profile: latestProfile, onProfilePatched, onToast });
          onToast("소포 상태를 처리했습니다.");
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
        const itemLabel = escapeHtml(buildParcelDisplayText(data));
        const currencyLabel = Number(data.currencyAmount || 0)
          ? `재화 ${Number(data.currencyAmount || 0)} G`
          : "재화 없음";
        return `
          <article class="info-card">
            <div class="info-card-head">
              <strong>${escapeHtml(data.senderCharacterName || "-")}</strong>
              <span class="pill-badge">${escapeHtml(data.status || "-")}</span>
            </div>
            <p>${itemLabel}${Number(data.currencyAmount || 0) ? ` / ${currencyLabel}` : ""}</p>
            <p>${data.wrapped ? "포장 소포" : "일반 소포"}</p>
            ${
              data.status === "pending"
                ? `
                  <div class="action-row">
                    <button type="button" class="primary-button compact-button" data-parcel-action="accept" data-parcel-id="${parcelDoc.id}">수령</button>
                    ${
                      data.wrapped
                        ? ""
                        : `<button type="button" class="ghost-button compact-button" data-parcel-action="reject" data-parcel-id="${parcelDoc.id}">거절</button>`
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
          onToast("소포 상태를 처리했습니다.");
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
          ? `재화 ${Number(data.currencyAmount || 0)} G`
          : "재화 없음";
        return `
          <article class="info-card">
            <div class="info-card-head">
              <strong>${escapeHtml(data.receiverCharacterName || "-")}</strong>
              <span class="pill-badge">${escapeHtml(data.status || "-")}</span>
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

async function hydrateTraitPanel({ profile, onProfilePatched, onToast }) {
  const traitTableBody = document.querySelector("#trait-table-body");
  if (!traitTableBody) return;

  try {
    const traitItems = await fetchCollectionItems("traits", "sortOrder");

    if (!traitItems.length) {
      traitTableBody.innerHTML = '<tr><td colspan="6" class="table-empty">traits 컬렉션에 특성치가 없습니다.</td></tr>';
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
        const statusLabel = isSelected ? "사용 중" : isLocked ? "포인트 부족" : "구매 가능";
        return `
          <tr>
            <td>${escapeHtml(trait.name || trait.id)}</td>
            <td>+${Number(trait.successPoints || 0)}</td>
            <td>-${Number(trait.failPoints || 0)}</td>
            <td>${requiredPoints}</td>
            <td>${statusLabel}</td>
            <td>
              <button type="button" class="ghost-button compact-button ${isSelected ? "is-owned" : ""}" data-trait-id="${trait.id}" ${isSelected || isLocked ? "disabled" : ""}>
                ${isSelected ? "구매 완료" : "구매"}
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
          onToast("특성치를 구매했습니다.");
        } catch (error) {
          onToast(error.message, true);
          button.disabled = false;
        }
      });
    });
  } catch (_error) {
    traitTableBody.innerHTML = '<tr><td colspan="6" class="table-empty">특성치를 불러오지 못했습니다.</td></tr>';
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
    const items = await fetchRouletteItems(profile.uid);

    if (!items.length) {
      onToast("먼저 룰렛 항목을 추가해 주세요.", true);
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
    labels.innerHTML = '<span class="wheel-placeholder">항목을 추가하면 원판이 만들어집니다.</span>';
    result.textContent = "항목을 추가하면 돌릴 수 있습니다.";
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
      const angle = index * sliceAngle + sliceAngle / 2;
      const translateY = Math.max(112, 150 - Math.min(items.length, 10) * 3);
      const width = Math.max(78, Math.min(126, 220 / Math.max(items.length, 2)));
      const fontSize = sliceAngle < 32 ? 11 : sliceAngle < 45 ? 12 : 13;
      return `<span style="width:${width}px;margin-left:${-width / 2}px;font-size:${fontSize}px;transform: rotate(${angle}deg) translateY(-${translateY}px) rotate(-${angle}deg);">${escapeHtml(item.name)}</span>`;
    })
    .join("");
}

function renderRouletteItemList(items, profile) {
  const itemList = document.querySelector("#roulette-item-list");
  if (!itemList) return;

  if (!items.length) {
    itemList.innerHTML = '<p class="muted">등록된 룰렛 항목이 없습니다.</p>';
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
  if (activeAdminSection === "items") {
    renderAdminItemSection();
  }
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
            <label class="admin-wide-field">
              <span>대상 옵션</span>
              <label class="inline-check parcel-wrap-check admin-toggle-check">
                <input type="checkbox" name="applyToAllUsers" />
                <span class="check-indicator" aria-hidden="true"></span>
                <span class="check-copy">
                  <strong>전체 유저 대상</strong>
                  <small>체크하면 모든 유저에게 같은 조정을 적용합니다.</small>
                </span>
              </label>
            </label>
            <label><span>대상 캐릭터명</span><input type="text" name="targetCharacterName" placeholder="캐릭터명" required /></label>
            <label><span>재화 증감</span><input type="number" name="currencyDelta" value="0" /></label>
            <label><span>특성치 포인트 증감</span><input type="number" name="traitPointDelta" value="0" /></label>
            <label>
              <span>지급 아이템 선택</span>
              <select name="addItemId" id="admin-item-select">
                <option value="">아이템을 선택하세요</option>
              </select>
            </label>
            <div class="admin-item-picker-row">
              <button type="button" class="ghost-button" id="admin-add-item-button">아이템 추가</button>
              <div id="admin-item-queue" class="admin-item-queue"></div>
            </div>
            <label>
              <span>권한 변경</span>
              <select name="setRole">
                <option value="">변경 안 함</option>
                <option value="user">user</option>
                <option value="moderator">moderator</option>
                <option value="gm">gm</option>
                <option value="admin">admin</option>
              </select>
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
    items: `
      <div class="admin-section-grid">
        <article class="content-card full">
          <div class="admin-section-tabs admin-subtabs">
            <button type="button" class="tab-button ${activeAdminItemSection === "create" ? "active" : ""}" data-admin-item-section="create">아이템 추가</button>
            <button type="button" class="tab-button ${activeAdminItemSection === "edit" ? "active" : ""}" data-admin-item-section="edit">아이템 수정</button>
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
  };

  body.innerHTML = sections[activeAdminSection] || sections["user-adjust"];
}

function renderAdminItemSection() {
  const body = document.querySelector("#admin-item-section-body");
  if (!body) return;

  const sections = {
    create: `
      <form id="admin-item-form" class="stack-form compact-form">
        <label><span>아이템 이름</span><input type="text" name="name" placeholder="예: 결투권" required /></label>
        <label><span>아이콘 이모지</span><input type="text" name="icon" placeholder="예: 🎁" value="🎁" /></label>
        <label><span>카테고리</span><input type="text" name="category" placeholder="예: 소모품" /></label>
        <label><span>짧은 설명</span><input type="text" name="shortLabel" placeholder="툴팁 요약" /></label>
        <label><span>상세 설명</span><textarea name="description" rows="4" placeholder="아이템 설명"></textarea></label>
        <label><span>자판기 가격</span><input type="number" min="0" name="price" value="0" /></label>
        <button type="submit" class="primary-button">아이템 등록</button>
      </form>
    `,
    edit: `
      <form id="admin-item-edit-form" class="stack-form compact-form">
        <label>
          <span>수정 대상 아이템</span>
          <select name="itemId" id="admin-item-edit-select">
            <option value="">아이템을 선택하세요</option>
          </select>
        </label>
        <label><span>아이템 이름</span><input type="text" name="name" placeholder="예: 결투권" required /></label>
        <label><span>아이콘 이모지</span><input type="text" name="icon" placeholder="예: 🎁" value="🎁" /></label>
        <label><span>카테고리</span><input type="text" name="category" placeholder="예: 소모품" /></label>
        <label><span>짧은 설명</span><input type="text" name="shortLabel" placeholder="툴팁 요약" /></label>
        <label><span>상세 설명</span><textarea name="description" rows="4" placeholder="아이템 설명"></textarea></label>
        <label><span>자판기 가격</span><input type="number" min="0" name="price" value="0" /></label>
        <button type="submit" class="primary-button">아이템 수정</button>
      </form>
    `,
    delete: `
      <form id="admin-item-delete-form" class="stack-form compact-form">
        <label>
          <span>삭제 대상 아이템</span>
          <select name="itemId" id="admin-item-delete-select">
            <option value="">아이템을 선택하세요</option>
          </select>
        </label>
        <button type="submit" class="ghost-button danger-button">아이템 삭제</button>
      </form>
    `,
  };

  body.innerHTML = sections[activeAdminItemSection] || sections.create;
}

function attachAdminEvents({ onProfilePatched, onToast }) {
  const manageForm = document.querySelector("#admin-manage-form");
  const itemForm = document.querySelector("#admin-item-form");
  const itemEditForm = document.querySelector("#admin-item-edit-form");
  const itemDeleteForm = document.querySelector("#admin-item-delete-form");
  const announcementForm = document.querySelector("#announcement-form");
  const deleteForm = document.querySelector("#admin-delete-form");

  document.querySelectorAll("[data-admin-item-section]").forEach((button) => {
    button.classList.toggle("active", button.dataset.adminItemSection === activeAdminItemSection);
    button.onclick = () => {
      activeAdminItemSection = button.dataset.adminItemSection;
      renderAdminItemSection();
      attachAdminEvents({ onProfilePatched, onToast });
    };
  });

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
        onToast("지급할 아이템을 먼저 선택해 주세요.", true);
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
        onToast("적용할 변경 사항이 없습니다.", true);
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
        onToast("유저 조정을 적용했습니다.");
      } catch (error) {
        onToast(error.message, true);
      }
    });
  }

  if (itemForm) {
    void hydrateAdminItemOptions();
    itemForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(itemForm).entries());

      try {
        await withPendingToast(onToast, () => createItemDefinition(payload));
        itemForm.reset();
        await hydrateAdminItemOptions();
        onToast("아이템 DB에 새 아이템을 추가했습니다.");
      } catch (error) {
        onToast(error.message, true);
      }
    });
  }

  if (itemEditForm) {
    const editSelect = itemEditForm.querySelector("#admin-item-edit-select");
    void hydrateAdminItemOptions();

    editSelect?.addEventListener("change", async () => {
      const itemId = String(editSelect.value || "").trim();
      if (!itemId) {
        itemEditForm.reset();
        return;
      }
      try {
        const items = await fetchCollectionItems("item-db", "sortOrder");
        const shopItems = await fetchCollectionItems("shop", "sortOrder");
        const item = items.find((entry) => entry.id === itemId);
        const shopItem = shopItems.find((entry) => entry.id === itemId);
        if (!item) return;
        itemEditForm.elements.name.value = item.name || "";
        itemEditForm.elements.icon.value = item.icon || "🎁";
        itemEditForm.elements.category.value = item.category || "";
        itemEditForm.elements.shortLabel.value = item.shortLabel || "";
        itemEditForm.elements.description.value = item.description || "";
        itemEditForm.elements.price.value = String(Number(shopItem?.price || 0));
      } catch (_error) {
        onToast("아이템 정보를 불러오지 못했습니다.", true);
      }
    });

    itemEditForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(itemEditForm).entries());
      try {
        await withPendingToast(onToast, () => updateItemDefinition(payload));
        await hydrateAdminItemOptions();
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
      if (!window.confirm("선택한 아이템을 삭제할까요?")) return;
      try {
        await withPendingToast(onToast, () => deleteItemDefinition(itemId));
        itemDeleteForm.reset();
        await hydrateAdminItemOptions();
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

      if (!window.confirm(`${payload.characterName} 계정을 삭제할까요?`)) return;

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

async function requestInventoryItemExtraData(item) {
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
  subtitle.textContent = "이 아이템은 사용 전에 추가 입력을 받을 수 있도록 확장되어 있습니다.";
  form.innerHTML = fields
    .map(
      (field) => `
        <label>
          <span>${escapeHtml(field.label || field.name || "입력값")}</span>
          <input
            type="${escapeHtml(field.type || "text")}"
            name="${escapeHtml(field.name || "")}"
            placeholder="${escapeHtml(field.placeholder || "")}"
            ${field.required === false ? "" : "required"}
          />
        </label>
      `
    )
    .join("");

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
    !currentPasswordInput ||
    !nextPasswordInput ||
    !nextPasswordConfirmInput ||
    !closeButton ||
    !closeIcon
  ) {
    return;
  }

  let pendingExtraNicknames = Array.isArray(profile.extraNicknames) ? [...profile.extraNicknames] : [];
  nicknameDisplay.value = String(profile.nickname || "");
  addWrap.classList.add("hidden");
  addInput.value = "";

  const renderExtraNicknames = () => {
    nicknameList.innerHTML = pendingExtraNicknames.length
      ? pendingExtraNicknames.map((item) => `<span class="pill-badge">${escapeHtml(item)}</span>`).join("")
      : '<span class="muted">아직 추가된 닉네임이 없습니다.</span>';
  };

  renderExtraNicknames();
  modal.classList.remove("hidden");

  const close = () => modal.classList.add("hidden");
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
        extraNicknames: pendingExtraNicknames,
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
          <input id="member-profile-primary-nickname" type="text" value="" readonly />
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
  return modal;
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
        <button id="inventory-use-prompt-cancel" type="button" class="ghost-button">취소</button>
        <button form="inventory-use-prompt-form" type="submit" class="primary-button">사용</button>
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
        <div class="item-use-ribbons" aria-hidden="true"><span></span><span></span><span></span></div>
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

async function confirmInventoryItemUse(item) {
  const modal = ensureInventoryUseConfirmModal();
  const title = modal.querySelector("#inventory-use-confirm-title");
  const body = modal.querySelector("#inventory-use-confirm-body");
  const confirmButton = modal.querySelector("#inventory-use-confirm-ok");
  const cancelButton = modal.querySelector("#inventory-use-confirm-cancel");
  const closeIcon = modal.querySelector("#inventory-use-confirm-close");
  if (!title || !body || !confirmButton || !cancelButton || !closeIcon) {
    return false;
  }

  title.textContent = item?.name || "아이템 사용";
  body.textContent = `'${item?.name || "아이템"}' 을(를) 사용하시겠습니까?`;
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
          <p class="eyebrow">ITEM CONFIRM</p>
          <h2 id="inventory-use-confirm-title">아이템 사용</h2>
        </div>
        <button id="inventory-use-confirm-close" type="button" class="icon-button">x</button>
      </div>
      <div class="notice-modal-body">
        <p id="inventory-use-confirm-body"></p>
      </div>
      <div class="notice-modal-actions">
        <button id="inventory-use-confirm-cancel" type="button" class="ghost-button">취소</button>
        <button id="inventory-use-confirm-ok" type="button" class="primary-button">사용</button>
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
            item.currencyDelta ? `재화 ${Number(item.currencyDelta) > 0 ? "+" : ""}${Number(item.currencyDelta)}` : "",
            item.traitPointDelta ? `포인트 ${Number(item.traitPointDelta) > 0 ? "+" : ""}${Number(item.traitPointDelta)}` : "",
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
      parts.push(`아이템 ${itemNames.join(", ")}`);
    }
  } else if (parcel.item?.name) {
    parts.push(`아이템 ${parcel.item.name}`);
  }
  if (Number(parcel.currencyAmount || 0) > 0) {
    parts.push(`재화 ${Number(parcel.currencyAmount || 0)} G`);
  }
  return parts.join(" / ") || "내용물 없음";
}

function buildGroupedInventoryItems(items) {
  return Array.from(
    (Array.isArray(items) ? items : []).reduce((map, item) => {
      const groupKey = buildInventoryGroupKey(item);
      const existing = map.get(groupKey);
      if (existing) {
        existing.count += 1;
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
  return [item?.itemId || item?.name || "item", item?.name || "", item?.description || ""].join("::");
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
  if (result) result.textContent = "항목을 추가하면 돌릴 수 있습니다.";
  if (form) form.reset();
}
