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
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { selectTrait } from "./auth.js";

export const menuDefinitions = [
  { id: "shop", label: "상점" },
  { id: "inventory", label: "인벤토리" },
  { id: "roulette", label: "룰렛", adminOnly: true },
  { id: "match", label: "대국 정보" },
  { id: "traits", label: "특성치" },
  { id: "admin", label: "운영진 메뉴", adminOnly: true },
];

const adminRoles = ["admin", "gm", "moderator"];
const roulettePalette = ["#f4a261", "#2a9d8f", "#e9c46a", "#e76f51", "#90be6d", "#577590"];

const sampleLiveMatches = [
  {
    title: "4인 작탁 랭크전",
    source: "크롤링 연동 예정",
    players: [
      {
        mahjongNickname: "유저A",
        characterName: "유즈",
        traits: ["핑후로 화료", "36통 대기로 화료"],
      },
      {
        mahjongNickname: "유저B",
        characterName: "이치히메",
        traits: ["특성 비공개"],
      },
    ],
  },
  {
    title: "친선 대국 로비",
    source: "크롤링 연동 예정",
    players: [
      {
        mahjongNickname: "유저C",
        characterName: "A-37",
        traits: ["국사무쌍으로 화료"],
      },
    ],
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
  document.querySelector("#inventory-count").textContent = String(
    profile.inventory?.length ?? 0
  );
  document.querySelector("#stat-points").textContent = String(
    profile.availableTraitPoints ?? 0
  );

  menuTabs.innerHTML = visibleMenus
    .map(
      (menu) => `
        <button
          type="button"
          class="tab-button ${menu.id === safeActiveMenuId ? "active" : ""}"
          data-menu-id="${menu.id}"
        >
          ${menu.label}
        </button>
      `
    )
    .join("");

  menuContent.innerHTML = renderMenuContent(safeActiveMenuId, profile);

  if (safeActiveMenuId === "shop") {
    hydrateShopPanel();
  }

  if (safeActiveMenuId === "traits") {
    hydrateTraitPanel({ profile, onProfilePatched, onToast });
  }

  if (safeActiveMenuId === "roulette") {
    attachRouletteEvents({ profile, onToast });
    hydrateRoulettePanel();
  }
}

function renderMenuContent(menuId, profile) {
  const inventoryItems = (profile.inventory || [])
    .map(
      (item) => `
        <li class="inventory-item inventory-tooltip" data-tooltip="${escapeHtml(
          item.description || "아이템 설명이 아직 없습니다."
        )}">
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
            ${match.players
              .map((player) => `<span class="live-pill">${player.mahjongNickname}</span>`)
              .join("")}
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
      <article class="content-card full">
        <h3>인벤토리</h3>
        <p>도트 이미지가 들어오면 마우스를 올렸을 때 툴팁으로 설명을 보여주도록 확장 가능한 구조입니다.</p>
        <ul class="inventory-list">
          ${inventoryItems || '<li class="empty-state">아직 보유한 아이템이 없습니다.</li>'}
        </ul>
      </article>
    `,
    roulette: `
      <div class="roulette-layout">
        <article class="content-card roulette-card">
          <h3>룰렛</h3>
          <p>운영진만 볼 수 있고, 항목을 직접 추가하거나 삭제할 수 있습니다.</p>
          <form id="roulette-item-form" class="stack-form compact-form">
            <label>
              <span>항목 이름</span>
              <input type="text" name="name" placeholder="예: 포장지" required />
            </label>
            <label>
              <span>설명</span>
              <input type="text" name="description" placeholder="간단한 설명" required />
            </label>
            <button type="submit" class="ghost-button">룰렛 항목 추가</button>
          </form>
          <div class="roulette-item-list" id="roulette-item-list">
            <p class="muted">등록된 룰렛 항목이 없습니다.</p>
          </div>
          <div class="roulette-stage">
            <div class="roulette-pointer"></div>
            <div id="roulette-wheel" class="roulette-wheel empty-wheel">
              <div id="roulette-wheel-labels" class="roulette-labels">
                <span class="wheel-placeholder">항목을 추가하면 원판이 생성됩니다.</span>
              </div>
            </div>
          </div>
          <button id="roulette-button" type="button" class="primary-button">룰렛 돌리기</button>
          <p id="roulette-result" class="muted">항목을 추가하면 돌릴 수 있습니다.</p>
        </article>
        <article class="content-card full">
          <h3>최근 룰렛 결과</h3>
          <p>모든 유저 기준 최신 5개의 결과를 보여줍니다.</p>
          <div class="table-wrap">
            <table class="log-table">
              <thead>
                <tr>
                  <th>시각</th>
                  <th>캐릭터</th>
                  <th>결과</th>
                  <th>설명</th>
                </tr>
              </thead>
              <tbody id="roulette-log-body">
                <tr>
                  <td colspan="4" class="table-empty">아직 로그가 없습니다.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>
      </div>
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
              <tr>
                <th>특성명</th>
                <th>성공+</th>
                <th>실패-</th>
                <th>필요P</th>
                <th>상태</th>
                <th>선택</th>
              </tr>
            </thead>
            <tbody id="trait-table-body">
              <tr>
                <td colspan="6" class="table-empty">traits 컬렉션에서 특성치를 불러오는 중입니다.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>
    `,
    admin: `
      <div class="content-grid two">
        <article class="content-card">
          <h3>운영진 메뉴</h3>
          <p>공지 작성, 권한 변경, 이벤트 관리 같은 운영 기능을 확장할 수 있는 자리입니다.</p>
        </article>
        <article class="content-card">
          <h3>권한 기준</h3>
          <p>users 문서의 <code>role</code> 값이 <code>admin</code>, <code>gm</code>, <code>moderator</code> 중 하나면 운영진 메뉴와 룰렛 메뉴가 노출됩니다.</p>
        </article>
      </div>
    `,
  };

  return viewMap[menuId] || "";
}

async function hydrateShopPanel() {
  const shopGrid = document.querySelector("#shop-grid");
  if (!shopGrid) {
    return;
  }

  try {
    const shopItems = await fetchCollectionItems("shop", "sortOrder");
    if (!shopItems.length) {
      shopGrid.innerHTML = `
        <article class="content-card full">
          <p class="muted">shop 컬렉션에 아이템이 없습니다.</p>
        </article>
      `;
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
    shopGrid.innerHTML = `
      <article class="content-card full">
        <p class="muted">shop 컬렉션을 불러오지 못했습니다.</p>
      </article>
    `;
  }
}

async function hydrateTraitPanel({ profile, onProfilePatched, onToast }) {
  const traitTableBody = document.querySelector("#trait-table-body");
  if (!traitTableBody) {
    return;
  }

  try {
    const traitItems = await fetchCollectionItems("traits", "sortOrder");
    if (!traitItems.length) {
      traitTableBody.innerHTML = `
        <tr>
          <td colspan="6" class="table-empty">traits 컬렉션에 특성치가 없습니다.</td>
        </tr>
      `;
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
            <td>
              <button
                type="button"
                class="ghost-button compact-button"
                data-trait-id="${trait.id}"
                ${isSelected || isLocked ? "disabled" : ""}
              >
                ${isSelected ? "완료" : "선택"}
              </button>
            </td>
          </tr>
        `;
      })
      .join("");

    attachTraitEvents({ profile, onProfilePatched, onToast });
  } catch (_error) {
    traitTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="table-empty">traits 컬렉션을 불러오지 못했습니다.</td>
      </tr>
    `;
  }
}

function attachTraitEvents({ profile, onProfilePatched, onToast }) {
  document.querySelectorAll("[data-trait-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;

      try {
        const updatedProfile = await selectTrait(button.dataset.traitId);
        await onProfilePatched(updatedProfile);
        await hydrateTraitPanel({
          profile: updatedProfile,
          onProfilePatched,
          onToast,
        });
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

  if (!form || !button || !result || !wheel) {
    return;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(form).entries());

    try {
      await addDoc(collection(db, "roulette-items"), {
        name: String(payload.name || "").trim(),
        description: String(payload.description || "").trim(),
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
      result.textContent = `${reward.name} 결과! ${reward.description}`;

      try {
        const attemptedAt = new Date();
        const logId = buildRouletteLogId(attemptedAt, profile.characterName);

        await setDoc(doc(db, "roulette-logs", logId), {
          uid: profile.uid,
          characterName: profile.characterName,
          loginId: profile.loginId,
          rewardName: reward.name,
          rewardDescription: reward.description,
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

  return snapshot.docs.map((docItem) => ({
    id: docItem.id,
    ...docItem.data(),
  }));
}

function renderRouletteWheel(items) {
  const wheel = document.querySelector("#roulette-wheel");
  const labels = document.querySelector("#roulette-wheel-labels");
  const result = document.querySelector("#roulette-result");

  if (!wheel || !labels || !result) {
    return;
  }

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
    radial-gradient(circle at center, rgba(255, 249, 240, 0.96) 0 18%, transparent 18%),
    conic-gradient(${segments})
  `;

  labels.innerHTML = items
    .map((item, index) => {
      const angle = index * sliceAngle;
      return `
        <span style="transform: rotate(${angle}deg) translateY(-118px) rotate(-${angle}deg);">
          ${item.name}
        </span>
      `;
    })
    .join("");
}

function renderRouletteItemList(items) {
  const itemList = document.querySelector("#roulette-item-list");
  if (!itemList) {
    return;
  }

  if (!items.length) {
    itemList.innerHTML = `<p class="muted">등록된 룰렛 항목이 없습니다.</p>`;
    return;
  }

  itemList.innerHTML = items
    .map(
      (item) => `
        <div class="roulette-item-row">
          <div>
            <strong>${item.name}</strong>
            <p>${item.description}</p>
          </div>
          <button
            type="button"
            class="ghost-button compact-button"
            data-roulette-remove="${item.id}"
          >
            삭제
          </button>
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
        if (result) {
          result.textContent = "룰렛 항목 삭제에 실패했습니다.";
        }
      }
    });
  });
}

async function renderRecentRouletteLogs() {
  const logBody = document.querySelector("#roulette-log-body");
  if (!logBody) {
    return;
  }

  try {
    const logQuery = query(
      collection(db, "roulette-logs"),
      orderBy("createdAt", "desc"),
      limit(5)
    );
    const logSnapshot = await getDocs(logQuery);

    if (logSnapshot.empty) {
      logBody.innerHTML = `
        <tr>
          <td colspan="4" class="table-empty">아직 로그가 없습니다.</td>
        </tr>
      `;
      return;
    }

    logBody.innerHTML = logSnapshot.docs
      .map((logDoc) => {
        const data = logDoc.data();
        const createdAt =
          data.createdAt?.toDate?.().toLocaleString("ko-KR") || data.createdAtText || "-";

        return `
          <tr>
            <td>${createdAt}</td>
            <td>${data.characterName || "-"}</td>
            <td>${data.rewardName || "-"}</td>
            <td>${data.rewardDescription || "-"}</td>
          </tr>
        `;
      })
      .join("");
  } catch (_error) {
    logBody.innerHTML = `
      <tr>
        <td colspan="4" class="table-empty">로그를 불러오지 못했습니다.</td>
      </tr>
    `;
  }
}

async function fetchCollectionItems(collectionName, orderField) {
  const itemQuery = query(collection(db, collectionName), orderBy(orderField, "asc"));
  const snapshot = await getDocs(itemQuery);
  return snapshot.docs.map((itemDoc) => ({
    id: itemDoc.id,
    ...itemDoc.data(),
  }));
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

  if (result) {
    result.textContent = "항목을 추가하면 돌릴 수 있습니다.";
  }

  if (form) {
    form.reset();
  }
}
