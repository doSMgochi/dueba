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
  createAnnouncement,
  dismissAnnouncement,
  markNotificationRead,
  respondParcel,
  selectTrait,
  sendParcel,
} from "./auth.js";

export const menuDefinitions = [
  { id: "shop", label: "상점" },
  { id: "inventory", label: "인벤토리" },
  { id: "notifications", label: "알림" },
  { id: "roulette", label: "룰렛", adminOnly: true },
  { id: "match", label: "대국 정보" },
  { id: "traits", label: "특성치" },
  { id: "admin", label: "운영진 메뉴", adminOnly: true },
];

const adminRoles = ["admin", "gm", "moderator"];
const roulettePalette = ["#0d285a", "#163a7a", "#fa5f03", "#0d285a", "#224d97", "#fa5f03"];

const sampleLiveMatches = [
  {
    title: "4인 작탁 랭크전",
    source: "크롤링 연동 예정",
    players: [
      { mahjongNickname: "유저A", characterName: "유즈", traits: ["핑후로 화료", "36통 대기로 화료"] },
      { mahjongNickname: "유저B", characterName: "이치히메", traits: ["특성 비공개"] },
    ],
  },
  {
    title: "친선 대국 로비",
    source: "크롤링 연동 예정",
    players: [{ mahjongNickname: "유저C", characterName: "A-37", traits: ["국사무쌍으로 화료"] }],
  },
];

export function buildDashboard({
  profile,
  activeMenuId,
  menuTabs,
  menuContent,
  onProfilePatched,
  onToast,
}) {
  const visibleMenus = menuDefinitions.filter((menu) => {
    if (!menu.adminOnly) {
      return true;
    }
    return adminRoles.includes(profile.role);
  });

  const safeActiveMenuId = visibleMenus.some((menu) => menu.id === activeMenuId)
    ? activeMenuId
    : visibleMenus[0].id;

  document.querySelector("#welcome-title").textContent = `${profile.characterName}님 환영합니다`;
  document.querySelector("#profile-summary").textContent =
    `${profile.nickname} | ID ${profile.loginId}`;
  document.querySelector("#role-badge").textContent = profile.role;
  document.querySelector("#currency-value").textContent = `${profile.currency ?? 0} G`;
  document.querySelector("#inventory-count").textContent = String(profile.inventory?.length ?? 0);
  document.querySelector("#stat-points").textContent = String(profile.availableTraitPoints ?? 0);

  menuTabs.innerHTML = visibleMenus
    .map(
      (menu) => `
        <button type="button" class="tab-button ${menu.id === safeActiveMenuId ? "active" : ""}" data-menu-id="${menu.id}">
          <span>${menu.label}</span>
          ${menu.id === "notifications" ? '<span id="notification-count-badge" class="menu-count-badge hidden">0</span>' : ""}
        </button>
      `
    )
    .join("");

  hydrateNotificationBadge(profile);

  menuContent.innerHTML = renderMenuContent(safeActiveMenuId, profile);

  if (safeActiveMenuId === "shop") hydrateShopPanel();
  if (safeActiveMenuId === "inventory") attachParcelForm({ profile, onProfilePatched, onToast });
  if (safeActiveMenuId === "notifications") hydrateNotificationPanel({ profile, onProfilePatched, onToast });
  if (safeActiveMenuId === "traits") hydrateTraitPanel({ profile, onProfilePatched, onToast });
  if (safeActiveMenuId === "roulette") {
    attachRouletteEvents({ profile, onToast });
    hydrateRoulettePanel();
  }
  if (safeActiveMenuId === "admin") attachAdminEvents({ onProfilePatched, onToast });
}

function renderMenuContent(menuId, profile) {
  const inventoryItems = (profile.inventory || [])
    .map(
      (item) => `
        <li class="inventory-item inventory-tooltip" data-tooltip="${escapeHtml(item.description || "아이템 설명이 아직 없습니다.")}">
          <div class="dot-slot"></div>
          <div>
            <strong>${item.name}</strong>
            <p>${item.shortLabel || "도트 리소스 연결 예정"}</p>
          </div>
        </li>
      `
    )
    .join("");

  const liveMatchCards = sampleLiveMatches
    .map(
      (match) => `
        <article class="content-card live-match-card">
          <h3>${match.title}</h3>
          <p>${match.source}</p>
          <div class="live-match-summary">
            ${match.players.map((player) => `<span class="live-pill">${player.mahjongNickname}</span>`).join("")}
          </div>
          <div class="live-hover-panel">
            ${match.players
              .map(
                (player) => `
                  <div class="live-player-line">
                    <strong>${player.mahjongNickname}</strong>
                    <span>${player.characterName}</span>
                    <p>${player.traits.join(", ")}</p>
                  </div>
                `
              )
              .join("")}
          </div>
        </article>
      `
    )
    .join("");

  const viewMap = {
    shop: `
      <div id="shop-grid" class="content-grid three">
        <article class="content-card full">
          <p class="muted">shop 컬렉션에서 상점 아이템을 불러오는 중입니다.</p>
        </article>
      </div>
    `,
    inventory: `
      <div class="content-grid two inventory-layout">
        <article class="content-card full">
          <h3>인벤토리</h3>
          <ul class="inventory-list">
            ${inventoryItems || '<li class="empty-state">아직 보유한 아이템이 없습니다.</li>'}
          </ul>
        </article>
        <article class="content-card">
          <h3>소포 보내기</h3>
          <form id="parcel-form" class="stack-form compact-form">
            <label><span>대상 캐릭터명</span><input type="text" name="targetCharacterName" placeholder="받는 캐릭터 이름" required /></label>
            <label><span>보낼 아이템명</span><input type="text" name="itemName" placeholder="없으면 비워두기" /></label>
            <label><span>아이템 설명</span><input type="text" name="itemDescription" placeholder="선택 입력" /></label>
            <label><span>보낼 재화</span><input type="number" min="0" name="currencyAmount" placeholder="0" /></label>
            <label class="inline-check"><input type="checkbox" name="useWrapping" /><span>포장지 사용</span></label>
            <button type="submit" class="primary-button">소포 보내기</button>
          </form>
          <p class="muted">포장지를 사용하면 상대방이 거절할 수 없습니다.</p>
        </article>
      </div>
    `,
    notifications: `
      <div class="content-grid two">
        <article class="content-card"><h3>공지</h3><div id="announcement-list" class="stack-list"><p class="muted">공지를 불러오는 중입니다.</p></div></article>
        <article class="content-card"><h3>알림</h3><div id="notification-list" class="stack-list"><p class="muted">알림을 불러오는 중입니다.</p></div></article>
      </div>
      <div class="content-grid two">
        <article class="content-card"><h3>받은 소포</h3><div id="incoming-parcels" class="stack-list"><p class="muted">소포를 불러오는 중입니다.</p></div></article>
        <article class="content-card"><h3>보낸 소포</h3><div id="outgoing-parcels" class="stack-list"><p class="muted">보낸 소포를 불러오는 중입니다.</p></div></article>
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
          <div class="roulette-item-list compact-list" id="roulette-item-list">
            <p class="muted">등록된 룰렛 항목이 없습니다.</p>
          </div>
        </article>
        <article class="content-card roulette-card wide">
          <div class="roulette-stage">
            <div class="roulette-pointer"></div>
            <div id="roulette-wheel" class="roulette-wheel empty-wheel">
              <div id="roulette-wheel-labels" class="roulette-labels">
                <span class="wheel-placeholder">항목을 추가하면 원판이 생성됩니다.</span>
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
            <thead><tr><th>시각</th><th>캐릭터</th><th>결과</th></tr></thead>
            <tbody id="roulette-log-body"><tr><td colspan="3" class="table-empty">아직 로그가 없습니다.</td></tr></tbody>
          </table>
        </div>
      </article>
    `,
    match: `
      <div class="content-grid two">
        ${liveMatchCards}
        <article class="content-card">
          <h3>확장 구조 메모</h3>
          <p>나중에 크롤링 데이터에서 현재 대국 중인 요소를 찾고, 작혼 닉네임을 캐릭터와 연결한 뒤 해당 캐릭터의 특성치를 hover 정보로 보여줄 수 있게 확장하는 자리입니다.</p>
          <div class="schema-box">
            <strong>추천 컬렉션</strong>
            <p><code>live-matches</code>에 방 제목, 상태, 플레이어 목록, 캐릭터명, 특성치 요약을 저장하는 형태를 권장합니다.</p>
          </div>
        </article>
      </div>
    `,
    traits: `
      <article class="content-card full">
        <div class="trait-header">
          <div>
            <h3>특성치</h3>
            <p>각 특성은 한 번만 선택할 수 있고, 성공 보너스와 실패 패널티, 필요 포인트를 짧게 확인할 수 있습니다.</p>
          </div>
          <strong class="trait-point-badge">남은 포인트 ${profile.availableTraitPoints ?? 0}</strong>
        </div>
        <div class="table-wrap">
          <table class="log-table trait-table">
            <thead>
              <tr><th>특성명</th><th>성공+</th><th>실패-</th><th>필요P</th><th>상태</th><th>선택</th></tr>
            </thead>
            <tbody id="trait-table-body">
              <tr><td colspan="6" class="table-empty">traits 컬렉션에서 특성치를 불러오는 중입니다.</td></tr>
            </tbody>
          </table>
        </div>
      </article>
    `,
    admin: `
      <div class="content-grid two">
        <article class="content-card">
          <h3>유저 조정</h3>
          <form id="admin-manage-form" class="stack-form compact-form">
            <label><span>대상 캐릭터명</span><input type="text" name="targetCharacterName" placeholder="캐릭터 이름" required /></label>
            <label><span>재화 증감</span><input type="number" name="currencyDelta" value="0" /></label>
            <label><span>특성치 포인트 증감</span><input type="number" name="traitPointDelta" value="0" /></label>
            <label><span>지급 아이템명</span><input type="text" name="addItemName" placeholder="없으면 비워두기" /></label>
            <label><span>아이템 설명</span><input type="text" name="addItemDescription" placeholder="선택 입력" /></label>
            <label>
              <span>역할 변경</span>
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
          <h3>운영 도구</h3>
          <form id="announcement-form" class="stack-form compact-form admin-subform">
            <label><span>공지 제목</span><input type="text" name="title" placeholder="공지 제목" required /></label>
            <label><span>공지 내용</span><textarea name="body" rows="5" placeholder="한 번 보고 닫히는 공지" required></textarea></label>
            <button type="submit" class="ghost-button">공지 작성</button>
          </form>
          <form id="admin-delete-form" class="stack-form compact-form admin-subform">
            <label><span>삭제 대상 캐릭터명</span><input type="text" name="characterName" placeholder="캐릭터 이름" required /></label>
            <button type="submit" class="ghost-button danger-button">계정 삭제</button>
          </form>
        </article>
      </div>
    `,
  };

  return viewMap[menuId] || "";
}

async function hydrateShopPanel() {
  const shopGrid = document.querySelector("#shop-grid");
  if (!shopGrid) return;

  try {
    const shopItems = await fetchCollectionItems("shop", "sortOrder");
    if (!shopItems.length) {
      shopGrid.innerHTML = `<article class="content-card full"><p class="muted">shop 컬렉션에 아이템이 없습니다.</p></article>`;
      return;
    }

    shopGrid.innerHTML = shopItems
      .map(
        (item) => `
          <article class="content-card">
            <div class="dot-slot large"></div>
            <div class="content-meta">
              <h3>${item.name}</h3>
              <p>${item.description}</p>
              <strong>${item.price} G</strong>
            </div>
            <button type="button" class="ghost-button" disabled>구매 예정</button>
          </article>
        `
      )
      .join("");
  } catch (_error) {
    shopGrid.innerHTML = `<article class="content-card full"><p class="muted">shop 컬렉션을 불러오지 못했습니다.</p></article>`;
  }
}

function attachParcelForm({ profile, onProfilePatched, onToast }) {
  const form = document.querySelector("#parcel-form");
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(form).entries());

    try {
      await sendParcel({
        targetCharacterName: payload.targetCharacterName,
        itemName: payload.itemName,
        itemDescription: payload.itemDescription,
        currencyAmount: Number(payload.currencyAmount || 0),
        useWrapping: payload.useWrapping === "on",
      });
      form.reset();
      await onProfilePatched();
      onToast(`${profile.characterName}님의 소포를 보냈습니다.`);
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
    const announcementQuery = query(
      collection(db, "announcements"),
      where("active", "==", true),
      orderBy("createdAt", "desc"),
      limit(5)
    );
    const snapshot = await getDocs(announcementQuery);
    const dismissedIds = new Set(profile.dismissedAnnouncementIds || []);
    const visibleAnnouncements = snapshot.docs.filter((item) => !dismissedIds.has(item.id));

    if (!visibleAnnouncements.length) {
      list.innerHTML = `<p class="muted">확인할 공지가 없습니다.</p>`;
      return;
    }

    list.innerHTML = visibleAnnouncements
      .map((announcement) => {
        const data = announcement.data();
        return `
          <article class="info-card">
            <div class="info-card-head">
              <strong>${escapeHtml(data.title || "공지")}</strong>
              <button type="button" class="ghost-button compact-button" data-dismiss-announcement="${announcement.id}">닫기</button>
            </div>
            <p>${escapeHtml(data.body || "")}</p>
          </article>
        `;
      })
      .join("");

    document.querySelectorAll("[data-dismiss-announcement]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          const updatedProfile = await dismissAnnouncement(button.dataset.dismissAnnouncement);
          await onProfilePatched(updatedProfile);
          await renderAnnouncements({ profile: updatedProfile, onProfilePatched, onToast });
          onToast("공지를 닫았습니다.");
        } catch (error) {
          onToast(error.message, true);
        }
      });
    });
  } catch (_error) {
    list.innerHTML = `<p class="muted">공지를 불러오지 못했습니다.</p>`;
  }
}

async function renderNotifications({ profile, onToast }) {
  const list = document.querySelector("#notification-list");
  if (!list) return;

  try {
    const notificationQuery = query(
      collection(db, "notifications"),
      where("targetUid", "==", profile.uid),
      orderBy("createdAt", "desc"),
      limit(12)
    );
    const snapshot = await getDocs(notificationQuery);

    if (snapshot.empty) {
      list.innerHTML = `<p class="muted">알림이 없습니다.</p>`;
      return;
    }

    list.innerHTML = snapshot.docs
      .map((notificationDoc) => {
        const data = notificationDoc.data();
        return `
          <article class="info-card ${data.isRead ? "is-read" : "is-unread"}">
            <div class="info-card-head">
              <strong>${escapeHtml(data.message || "알림")}</strong>
              ${
                data.isRead
                  ? '<span class="pill-badge">읽음</span>'
                  : `<button type="button" class="ghost-button compact-button" data-read-notification="${notificationDoc.id}">읽음 처리</button>`
              }
            </div>
          </article>
        `;
      })
      .join("");

    document.querySelectorAll("[data-read-notification]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await markNotificationRead(button.dataset.readNotification);
          await hydrateNotificationBadge(profile);
          await renderNotifications({ profile, onToast });
        } catch (error) {
          onToast(error.message, true);
        }
      });
    });
  } catch (_error) {
    list.innerHTML = `<p class="muted">알림을 불러오지 못했습니다.</p>`;
  }
}

async function hydrateNotificationBadge(profile) {
  const badge = document.querySelector("#notification-count-badge");
  if (!badge) return;

  try {
    const notificationQuery = query(
      collection(db, "notifications"),
      where("targetUid", "==", profile.uid),
      orderBy("createdAt", "desc"),
      limit(20)
    );
    const snapshot = await getDocs(notificationQuery);
    const unreadCount = snapshot.docs.filter((item) => !item.data().isRead).length;

    badge.textContent = String(unreadCount);
    badge.classList.toggle("hidden", unreadCount === 0);
  } catch (_error) {
    badge.classList.add("hidden");
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
      list.innerHTML = `<p class="muted">받은 소포가 없습니다.</p>`;
      return;
    }

    list.innerHTML = snapshot.docs
      .map((parcelDoc) => {
        const data = parcelDoc.data();
        const itemLabel = data.item?.name ? `아이템: ${data.item.name}` : "아이템 없음";
        const currencyLabel = Number(data.currencyAmount || 0)
          ? `재화: ${Number(data.currencyAmount || 0)} G`
          : "재화 없음";
        return `
          <article class="info-card">
            <div class="info-card-head">
              <strong>${escapeHtml(data.senderCharacterName || "-")}</strong>
              <span class="pill-badge">${escapeHtml(data.status || "-")}</span>
            </div>
            <p>${itemLabel} / ${currencyLabel}</p>
            <p>${data.wrapped ? "포장됨" : "일반 소포"}</p>
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

    document.querySelectorAll("[data-parcel-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await respondParcel(button.dataset.parcelId, button.dataset.parcelAction);
          await onProfilePatched();
          await renderIncomingParcels({ profile, onProfilePatched, onToast });
          await renderOutgoingParcels({ profile });
          onToast("소포 상태를 처리했습니다.");
        } catch (error) {
          onToast(error.message, true);
        }
      });
    });
  } catch (_error) {
    list.innerHTML = `<p class="muted">받은 소포를 불러오지 못했습니다.</p>`;
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
      list.innerHTML = `<p class="muted">보낸 소포가 없습니다.</p>`;
      return;
    }

    list.innerHTML = snapshot.docs
      .map((parcelDoc) => {
        const data = parcelDoc.data();
        const itemLabel = data.item?.name ? `아이템: ${data.item.name}` : "아이템 없음";
        const currencyLabel = Number(data.currencyAmount || 0)
          ? `재화: ${Number(data.currencyAmount || 0)} G`
          : "재화 없음";
        return `
          <article class="info-card">
            <div class="info-card-head">
              <strong>${escapeHtml(data.receiverCharacterName || "-")}</strong>
              <span class="pill-badge">${escapeHtml(data.status || "-")}</span>
            </div>
            <p>${itemLabel} / ${currencyLabel}</p>
            <p>${data.wrapped ? "포장됨" : "일반 소포"}</p>
          </article>
        `;
      })
      .join("");
  } catch (_error) {
    list.innerHTML = `<p class="muted">보낸 소포를 불러오지 못했습니다.</p>`;
  }
}

async function hydrateTraitPanel({ profile, onProfilePatched, onToast }) {
  const traitTableBody = document.querySelector("#trait-table-body");
  if (!traitTableBody) return;

  try {
    const traitItems = await fetchCollectionItems("traits", "sortOrder");
    if (!traitItems.length) {
      traitTableBody.innerHTML = `<tr><td colspan="6" class="table-empty">traits 컬렉션에 특성치가 없습니다.</td></tr>`;
      return;
    }

    const selectedTraitIds = new Set(profile.selectedTraitIds || []);
    const currentPoints = Number(profile.availableTraitPoints || 0);

    traitTableBody.innerHTML = traitItems
      .map((trait) => {
        const isSelected = selectedTraitIds.has(trait.id);
        const requiredPoints = Number(trait.requiredPoints || 0);
        const isLocked = !isSelected && currentPoints < requiredPoints;
        return `
          <tr>
            <td>${trait.name}</td>
            <td>+${Number(trait.successPoints || 0)}</td>
            <td>-${Number(trait.failPoints || 0)}</td>
            <td>${requiredPoints}</td>
            <td>${isSelected ? "선택됨" : isLocked ? "포인트 부족" : "선택 가능"}</td>
            <td><button type="button" class="ghost-button compact-button" data-trait-id="${trait.id}" ${isSelected || isLocked ? "disabled" : ""}>${isSelected ? "완료" : "선택"}</button></td>
          </tr>
        `;
      })
      .join("");

    attachTraitEvents({ onProfilePatched, onToast });
  } catch (_error) {
    traitTableBody.innerHTML = `<tr><td colspan="6" class="table-empty">traits 컬렉션을 불러오지 못했습니다.</td></tr>`;
  }
}

function attachTraitEvents({ onProfilePatched, onToast }) {
  document.querySelectorAll("[data-trait-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const updatedProfile = await selectTrait(button.dataset.traitId);
        await onProfilePatched(updatedProfile);
        onToast("특성치를 선택했습니다.");
      } catch (error) {
        onToast(error.message, true);
        button.disabled = false;
      }
    });
  });
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
    try {
      await addDoc(collection(db, "roulette-items"), {
        name: String(payload.name || "").trim(),
        createdAt: serverTimestamp(),
      });
      form.reset();
      await hydrateRoulettePanel();
      onToast("룰렛 항목을 추가했습니다.");
    } catch (_error) {
      onToast("룰렛 항목 추가에 실패했습니다.", true);
    }
  });

  button.addEventListener("click", async () => {
    const items = await fetchRouletteItems();
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
    result.textContent = "룰렛을 돌리는 중...";

    window.setTimeout(async () => {
      result.textContent = `${reward.name}`;
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

async function hydrateRoulettePanel() {
  const items = await fetchRouletteItems();
  resetRoulettePanel();
  renderRouletteItemList(items);
  renderRouletteWheel(items);
  await renderRecentRouletteLogs();
}

async function fetchRouletteItems() {
  const itemQuery = query(collection(db, "roulette-items"), orderBy("createdAt", "asc"));
  const snapshot = await getDocs(itemQuery);
  return snapshot.docs.map((docItem) => ({ id: docItem.id, ...docItem.data() }));
}

function renderRouletteWheel(items) {
  const wheel = document.querySelector("#roulette-wheel");
  const labels = document.querySelector("#roulette-wheel-labels");
  const result = document.querySelector("#roulette-result");
  if (!wheel || !labels || !result) return;

  if (!items.length) {
    wheel.classList.add("empty-wheel");
    wheel.style.background = "";
    labels.innerHTML = `<span class="wheel-placeholder">항목을 추가하면 원판이 생성됩니다.</span>`;
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
      const angle = index * sliceAngle;
      return `<span style="transform: rotate(${angle}deg) translateY(-158px) rotate(-${angle}deg);">${item.name}</span>`;
    })
    .join("");
}

function renderRouletteItemList(items) {
  const itemList = document.querySelector("#roulette-item-list");
  if (!itemList) return;

  if (!items.length) {
    itemList.innerHTML = `<p class="muted">등록된 룰렛 항목이 없습니다.</p>`;
    return;
  }

  itemList.innerHTML = items
    .map(
      (item) => `
        <div class="roulette-item-row">
          <strong>${item.name}</strong>
          <button type="button" class="ghost-button compact-button" data-roulette-remove="${item.id}">삭제</button>
        </div>
      `
    )
    .join("");

  document.querySelectorAll("[data-roulette-remove]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await deleteDoc(doc(db, "roulette-items", button.dataset.rouletteRemove));
        await hydrateRoulettePanel();
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
      logBody.innerHTML = `<tr><td colspan="3" class="table-empty">아직 로그가 없습니다.</td></tr>`;
      return;
    }

    logBody.innerHTML = logSnapshot.docs
      .map((logDoc) => {
        const data = logDoc.data();
        const createdAt = data.createdAt?.toDate?.().toLocaleString("ko-KR") || data.createdAtText || "-";
        return `<tr><td>${createdAt}</td><td>${data.characterName || "-"}</td><td>${data.rewardName || "-"}</td></tr>`;
      })
      .join("");
  } catch (_error) {
    logBody.innerHTML = `<tr><td colspan="3" class="table-empty">로그를 불러오지 못했습니다.</td></tr>`;
  }
}

function attachAdminEvents({ onProfilePatched, onToast }) {
  const manageForm = document.querySelector("#admin-manage-form");
  const deleteForm = document.querySelector("#admin-delete-form");
  const announcementForm = document.querySelector("#announcement-form");

  if (manageForm) {
    manageForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(manageForm).entries());
      try {
        await adminManageUser({
          targetCharacterName: payload.targetCharacterName,
          currencyDelta: Number(payload.currencyDelta || 0),
          traitPointDelta: Number(payload.traitPointDelta || 0),
          addItemName: payload.addItemName,
          addItemDescription: payload.addItemDescription,
          setRole: payload.setRole,
        });
        manageForm.reset();
        await onProfilePatched();
        onToast("유저 조정을 적용했습니다.");
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
        await createAnnouncement(payload);
        announcementForm.reset();
        onToast("공지를 작성했습니다.");
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
        await adminDeleteUser(payload.characterName);
        deleteForm.reset();
        onToast("계정을 삭제했습니다.");
      } catch (error) {
        onToast(error.message, true);
      }
    });
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
