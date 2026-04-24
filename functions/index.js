const { onCall, HttpsError, onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
setGlobalOptions({ region: "asia-northeast3", maxInstances: 10 });

const db = getFirestore();
const adminAuth = getAuth();

const defaultTraits = [
  { id: "pinfu-win", name: "핑후로 화료", successPoints: 5, failPoints: 3, requiredPoints: 10, sortOrder: 1 },
  { id: "wait-36-win", name: "36통 대기로 화료", successPoints: 10, failPoints: 5, requiredPoints: 2, sortOrder: 2 },
  { id: "kokushi-win", name: "국사무쌍으로 화료", successPoints: 20, failPoints: 5, requiredPoints: 1, sortOrder: 3 },
  { id: "hidden-trait", name: "특성 비공개", successPoints: 0, failPoints: 0, requiredPoints: 10, sortOrder: 4 },
];
const allowedFactions = new Set(["매화", "난초", "국화", "대나무"]);
const YACHT_MAX_PLAYERS = 4;
const YACHT_DICE_COUNT = 5;
const YACHT_ROLL_ANIMATION_MS = 3400;
const YACHT_TURN_LIMIT_MS = 30000;
const YACHT_DIE_CENTER_LIMIT = 2.08;
const YACHT_STALE_FINISH_MS = 6 * 60 * 60 * 1000;
const YACHT_ROOM_STATUS_WAITING = "waiting";
const YACHT_ROOM_STATUS_PLAYING = "playing";
const YACHT_ROOM_STATUS_FINISHED = "finished";
const YACHT_PHASE_WAITING = "waiting";
const YACHT_PHASE_AWAITING_ROLL = "awaiting-roll";
const YACHT_PHASE_ROLLING = "rolling";
const YACHT_PHASE_FINISHED = "finished";
const YACHT_UPPER_IDS = ["aces", "deuces", "threes", "fours", "fives", "sixes"];
const YACHT_LOWER_IDS = ["choice", "threeKind", "fourKind", "fullHouse", "smallStraight", "largeStraight", "yacht"];
const YACHT_PLAYABLE_CATEGORY_IDS = [...YACHT_UPPER_IDS, ...YACHT_LOWER_IDS];
exports.ensureUserProfile = onCall(async (request) => {
  assertAuthenticated(request);
  const { loginId, nickname, characterName, friendCode = "", factionName = "" } = request.data || {};
  validateProfileInput({ loginId, nickname, characterName });
  await ensureGlobalGameData();

  const uid = request.auth.uid;
  const normalizedCharacterName = String(characterName).trim();
  const userRef = db.collection("users").doc(normalizedCharacterName);
  const duplicateLoginIdSnapshot = await db.collection("users").where("loginId", "==", loginId).limit(1).get();

  if (!duplicateLoginIdSnapshot.empty && duplicateLoginIdSnapshot.docs[0].data().uid !== uid) {
    throw new HttpsError("already-exists", "This login ID is already in use.");
  }

  const duplicateCharacterSnapshot = await userRef.get();
  if (duplicateCharacterSnapshot.exists && duplicateCharacterSnapshot.data().uid !== uid) {
    throw new HttpsError("already-exists", "This character name is already in use.");
  }

  await userRef.set(
    {
      uid,
      loginId,
      email: String(request.auth.token.email || "").trim().toLowerCase(),
      nickname,
      characterName: normalizedCharacterName,
      friendCode: String(friendCode || "").replace(/\D/g, ""),
      factionName: allowedFactions.has(String(factionName || "").trim()) ? String(factionName || "").trim() : "",
      teamEnrollmentStatus: "pending",
      teamEnrollmentMessage: "",
      role: "user",
      rankingPoints: 0,
      selectedTraitIds: [],
      availableTraitPoints: 12,
      dismissedAnnouncementIds: [],
      inventory: [],
      profileDecorations: [],
      publicInventoryHiddenUntil: "",
      factionDisguiseUntil: "",
      factionDisguiseName: "",
      currency: 300,
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { ok: true };
});

exports.validateSignupProfile = onCall(async (request) => {
  const { loginId, email, characterName, friendCode = "", factionName = "" } = request.data || {};
  const normalizedLoginId = String(loginId || "").trim().toLowerCase();
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedCharacterName = String(characterName || "").trim();
  const normalizedFriendCode = String(friendCode || "").replace(/\D/g, "");
  const normalizedFactionName = String(factionName || "").trim();

  if (!normalizedLoginId || !normalizedEmail || !normalizedCharacterName || !normalizedFriendCode) {
    throw new HttpsError("invalid-argument", "아이디, 이메일, 캐릭터 이름, 친구코드를 모두 입력해 주세요.");
  }

  if (!allowedFactions.has(normalizedFactionName)) {
    throw new HttpsError("invalid-argument", "파벌 이름을 올바르게 선택해 주세요.");
  }

  if (!/^\d+$/.test(normalizedFriendCode)) {
    throw new HttpsError("invalid-argument", "친구코드는 숫자만 입력해 주세요.");
  }

  const [loginIdSnapshot, characterSnapshot, emailSnapshot] = await Promise.all([
    db.collection("users").where("loginId", "==", normalizedLoginId).limit(1).get(),
    db.collection("users").doc(normalizedCharacterName).get(),
    db.collection("users").where("email", "==", normalizedEmail).limit(1).get(),
  ]);

  if (!loginIdSnapshot.empty) {
    throw new HttpsError("already-exists", "이미 사용 중인 아이디입니다.");
  }

  if (characterSnapshot.exists) {
    throw new HttpsError("already-exists", "이미 사용 중인 캐릭터 이름입니다.");
  }

  if (!emailSnapshot.empty) {
    throw new HttpsError("already-exists", "이미 사용 중인 이메일입니다.");
  }

  return { ok: true };
});

exports.resolveLoginEmail = onCall(async (request) => {
  const normalizedLoginId = String(request.data?.loginId || "").trim().toLowerCase();
  if (!normalizedLoginId) {
    throw new HttpsError("invalid-argument", "아이디를 입력해 주세요.");
  }

  const snapshot = await db.collection("users").where("loginId", "==", normalizedLoginId).limit(1).get();
  if (snapshot.empty) {
    throw new HttpsError("not-found", "가입된 계정을 찾지 못했습니다.");
  }

  const data = snapshot.docs[0].data();
  return {
    email: String(data.email || `${normalizedLoginId}@internal.app`).trim().toLowerCase(),
  };
});

exports.findLoginIdByEmail = onCall(async (request) => {
  const normalizedEmail = String(request.data?.email || "").trim().toLowerCase();
  if (!normalizedEmail) {
    throw new HttpsError("invalid-argument", "이메일을 입력해 주세요.");
  }

  const snapshot = await db.collection("users").where("email", "==", normalizedEmail).limit(1).get();
  if (snapshot.empty) {
    throw new HttpsError("not-found", "가입된 계정을 찾지 못했습니다.");
  }

  return { loginId: String(snapshot.docs[0].data().loginId || "") };
});

exports.claimActiveSession = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Login is required.");
  }

  const sessionId = String(request.data?.sessionId || "").trim();
  if (!sessionId || sessionId.length > 120) {
    throw new HttpsError("invalid-argument", "Invalid session id.");
  }

  const profileSnapshot = await findUserSnapshotByUid(request.auth.uid);
  if (!profileSnapshot) {
    throw new HttpsError("not-found", "User profile was not found.");
  }

  let activeRoom = null;
  try {
    activeRoom = await findActiveYachtRoomForUid(request.auth.uid);
  } catch (error) {
    console.warn("Failed to restore active yacht room while claiming session", error);
  }
  const sessionUpdate = {
    activeSessionId: sessionId,
    activeSessionUpdatedAt: FieldValue.serverTimestamp(),
  };
  if (activeRoom) {
    sessionUpdate.activeYachtRoomId = activeRoom.roomId;
    sessionUpdate.activeYachtRole = activeRoom.role;
    sessionUpdate.activeYachtUpdatedAt = FieldValue.serverTimestamp();
  }

  await profileSnapshot.ref.update({
    ...sessionUpdate,
  });

  return {
    profile: {
      docId: profileSnapshot.id,
      ...serialize(profileSnapshot.data()),
      activeSessionId: sessionId,
      ...(activeRoom
        ? {
            activeYachtRoomId: activeRoom.roomId,
            activeYachtRole: activeRoom.role,
          }
        : {}),
    },
  };
});

exports.getDashboardData = onCall(async (request) => {
  assertAuthenticated(request);
  await ensureGlobalGameData();
  await processExpiredParcelsForUid(request.auth.uid);

  const snapshot = await findUserSnapshotByUid(request.auth.uid);
  if (!snapshot) {
    throw new HttpsError("not-found", "Profile does not exist.");
  }

  return {
    profile: {
      docId: snapshot.id,
      ...serialize(snapshot.data()),
    },
  };
});

exports.getRankingBoard = onCall(async (request) => {
  assertAuthenticated(request);
  await ensureGlobalGameData();

  const [userSnapshot, traitSnapshot] = await Promise.all([
    db.collection("users").get(),
    db.collection("traits").get(),
  ]);
  const traitPointMap = new Map(
    traitSnapshot.docs.map((item) => [item.id, Number(item.data().requiredPoints || 0)])
  );

  const preferredUsers = Array.from(
    userSnapshot.docs.reduce((map, item) => {
      const data = item.data();
      const key = String(data.uid || item.id || "").trim();
      const current = map.get(key);
      const score = item.id === data.characterName ? 2 : item.id !== data.uid ? 1 : 0;
      if (!current || score > current.score) {
        map.set(key, { score, item, data });
      }
      return map;
    }, new Map()).values()
  );

  const rankings = preferredUsers
    .map(({ item, data }) => {
      const selectedTraitIds = Array.isArray(data.selectedTraitIds) ? data.selectedTraitIds : [];
      const usedTraitPoints = selectedTraitIds.reduce(
        (sum, traitId) => sum + Number(traitPointMap.get(traitId) || 0),
        0
      );

      return {
        characterName: data.characterName || item.id,
        nickname: data.nickname || "-",
        rankingPoints: Number(data.rankingPoints || 0),
        currency: Number(data.currency || 0),
        factionName: String(data.factionName || "").trim(),
        factionDisguiseName: String(data.factionDisguiseName || "").trim(),
        factionDisguiseUntil: String(data.factionDisguiseUntil || "").trim(),
        totalTraitPoints: Number(data.availableTraitPoints || 0) + usedTraitPoints,
      };
    })
    .sort((left, right) => right.rankingPoints - left.rankingPoints);

  return { rankings };
});

exports.selectTrait = onCall(async (request) => {
  assertAuthenticated(request);
  const { traitId } = request.data || {};
  if (!traitId) {
    throw new HttpsError("invalid-argument", "Trait id is required.");
  }

  await ensureGlobalGameData();
  const snapshot = await findUserSnapshotByUid(request.auth.uid);
  if (!snapshot) {
    throw new HttpsError("not-found", "Profile does not exist.");
  }

  const traitRef = db.collection("traits").doc(String(traitId));
  const userRef = snapshot.ref;

  const profile = await db.runTransaction(async (transaction) => {
    const [currentSnapshot, traitSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(traitRef),
    ]);

    if (!currentSnapshot.exists) {
      throw new HttpsError("not-found", "Profile does not exist.");
    }
    if (!traitSnapshot.exists) {
      throw new HttpsError("not-found", "Trait does not exist.");
    }

    const data = currentSnapshot.data();
    const trait = traitSnapshot.data();
    const selectedTraitIds = Array.isArray(data.selectedTraitIds) ? [...data.selectedTraitIds] : [];
    const requiredPoints = Number(trait.requiredPoints || 0);
    const currentPoints = Number(data.availableTraitPoints || 0);

    if (selectedTraitIds.includes(traitId)) {
      throw new HttpsError("failed-precondition", "Trait is already selected.");
    }
    if (currentPoints < requiredPoints) {
      throw new HttpsError("failed-precondition", "Not enough trait points.");
    }

    selectedTraitIds.push(String(traitId));
    const nextPoints = currentPoints - requiredPoints;

    transaction.update(userRef, {
      selectedTraitIds,
      availableTraitPoints: nextPoints,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      docId: currentSnapshot.id,
      ...serialize({
        ...data,
        selectedTraitIds,
        availableTraitPoints: nextPoints,
      }),
    };
  });

  return { profile };
});

exports.adminManageUser = onCall(async (request) => {
  assertAuthenticated(request);
  const adminProfile = await assertAdmin(request.auth.uid);
  const {
    targetCharacterName,
    currencyDelta = 0,
    traitPointDelta = 0,
    addItemIds = [],
    setRole = "",
    applyToAllUsers = false,
  } = request.data || {};

  await ensureGlobalGameData();

  const normalizedCharacterName = String(targetCharacterName || "").trim();
  if (!applyToAllUsers && !normalizedCharacterName) {
    throw new HttpsError("invalid-argument", "Target character name is required.");
  }

  const normalizedItemIds = Array.isArray(addItemIds)
    ? addItemIds.map((itemId) => String(itemId || "").trim()).filter(Boolean)
    : [];
  const itemDefinitions = await Promise.all(
    normalizedItemIds.map(async (itemId) => {
      const snapshot = await db.collection("item-db").doc(itemId).get();
      if (!snapshot.exists) {
        throw new HttpsError("not-found", `Item definition '${itemId}' was not found.`);
      }
      return { id: snapshot.id, ...snapshot.data() };
    })
  );

  const targetSnapshots = applyToAllUsers
    ? (await db.collection("users").get()).docs
    : [await findUserSnapshotByCharacterName(normalizedCharacterName)].filter(Boolean);

  if (!targetSnapshots.length) {
    throw new HttpsError("not-found", "Target user was not found.");
  }

  const numericCurrencyDelta = Number(currencyDelta || 0);
  const numericTraitPointDelta = Number(traitPointDelta || 0);
  const nextRole = String(setRole || "").trim();
  const grantedItemNames = itemDefinitions.map((item) => String(item.name || item.id));

  for (const targetSnapshot of targetSnapshots) {
    const data = targetSnapshot.data();
    const inventory = Array.isArray(data.inventory) ? [...data.inventory] : [];
    const nextCurrency = Math.max(0, Number(data.currency || 0) + numericCurrencyDelta);
    const nextTraitPoints = Math.max(0, Number(data.availableTraitPoints || 0) + numericTraitPointDelta);

    itemDefinitions.forEach((item) => {
      inventory.push(buildInventoryItemFromDefinition(item));
    });

    const updatePayload = {
      currency: nextCurrency,
      availableTraitPoints: nextTraitPoints,
      inventory,
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (nextRole) {
      updatePayload.role = nextRole;
    }

    await targetSnapshot.ref.update(updatePayload);
  }

  const operateLoggedAt = new Date();
  await db.collection("operate-logs").add({
    kind: "user-adjust",
    targetCharacterName: applyToAllUsers ? "전체 유저" : normalizedCharacterName,
    adminUid: adminProfile.uid,
    adminCharacterName: adminProfile.characterName,
    currencyDelta: numericCurrencyDelta,
    traitPointDelta: numericTraitPointDelta,
    addItemNames: grantedItemNames,
    setRole: nextRole || "",
    applyToAllUsers: Boolean(applyToAllUsers),
    affectedUserCount: targetSnapshots.length,
    createdAt: FieldValue.serverTimestamp(),
    createdAtText: operateLoggedAt.toLocaleString("ko-KR"),
  });

  return {
    ok: true,
    target: applyToAllUsers ? "all-users" : normalizedCharacterName,
    affectedUserCount: targetSnapshots.length,
  };
});

exports.createItemDefinition = onCall(async (request) => {
  assertAuthenticated(request);
  await assertAdmin(request.auth.uid);
  const {
    name = "",
    description = "",
    shortLabel = "",
    icon = "🎁",
    spriteKey = "",
    colorPreset = "",
    category = "기타 아이템",
    foodCurrencyReward = 0,
    price = 0,
    sellInShop = true,
  } = request.data || {};

  const normalizedName = normalizeSystemItemName(name);
  if (!normalizedName) {
    throw new HttpsError("invalid-argument", "Item name is required.");
  }

  const itemId = buildItemId(normalizedName);
  const normalizedPrice = Math.max(0, Number(price || 0));
  const shouldSellInShop = Boolean(sellInShop);
  const normalizedCategory = normalizeItemCategory(category);
  const normalizedFoodCurrencyReward =
    normalizedCategory === "음식" ? Math.max(0, Math.floor(Number(foodCurrencyReward || 0))) : 0;

  await db.collection("item-db").doc(itemId).set(
    {
      name: normalizedName,
      description: String(description || "").trim(),
      shortLabel: String(shortLabel || normalizedName).trim(),
      icon: String(icon || "🎁").trim(),
      spriteKey: String(spriteKey || "").trim(),
      colorPreset: String(colorPreset || "").trim(),
      category: normalizedCategory,
      foodCurrencyReward: normalizedFoodCurrencyReward,
      sellInShop: shouldSellInShop,
      sortOrder: Date.now(),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  if (shouldSellInShop) {
    await db.collection("shop").doc(itemId).set(
      {
        name: normalizedName,
        description: String(description || "").trim(),
        spriteKey: String(spriteKey || "").trim(),
        colorPreset: String(colorPreset || "").trim(),
        category: normalizedCategory,
        foodCurrencyReward: normalizedFoodCurrencyReward,
        price: normalizedPrice,
        sortOrder: Date.now(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } else {
    await db.collection("shop").doc(itemId).delete().catch(() => null);
  }

  return { ok: true, itemId };
});

exports.updateItemDefinition = onCall(async (request) => {
  assertAuthenticated(request);
  await assertAdmin(request.auth.uid);

  const {
    itemId = "",
    name = "",
    description = "",
    shortLabel = "",
    icon = "🎁",
    spriteKey = "",
    colorPreset = "",
    category = "기타 아이템",
    foodCurrencyReward = 0,
    price = 0,
    sellInShop = true,
  } = request.data || {};

  const normalizedItemId = String(itemId || "").trim();
  const normalizedName = normalizeSystemItemName(name);
  if (!normalizedItemId || !normalizedName) {
    throw new HttpsError("invalid-argument", "Item id and name are required.");
  }

  const itemRef = db.collection("item-db").doc(normalizedItemId);
  const itemSnapshot = await itemRef.get();
  if (!itemSnapshot.exists) {
    throw new HttpsError("not-found", "Item definition was not found.");
  }
  const previousItem = itemSnapshot.data() || {};
  const matchingNames = buildItemMatchNames(previousItem.name, normalizedName);

  const normalizedPrice = Math.max(0, Number(price || 0));
  const shouldSellInShop = Boolean(sellInShop);
  const normalizedCategory = normalizeItemCategory(category);
  const normalizedDescription = String(description || "").trim();
  const normalizedShortLabel = String(shortLabel || normalizedName).trim();
  const normalizedIcon = String(icon || "🎁").trim();
  const normalizedSpriteKey = String(spriteKey || "").trim();
  const normalizedColorPreset = String(colorPreset || "").trim();
  const normalizedFoodCurrencyReward =
    normalizedCategory === "음식" ? Math.max(0, Math.floor(Number(foodCurrencyReward || 0))) : 0;

  await itemRef.update({
    name: normalizedName,
    description: normalizedDescription,
    shortLabel: normalizedShortLabel,
    icon: normalizedIcon,
    spriteKey: normalizedSpriteKey,
    colorPreset: normalizedColorPreset,
    category: normalizedCategory,
    foodCurrencyReward: normalizedFoodCurrencyReward,
    sellInShop: shouldSellInShop,
    updatedAt: FieldValue.serverTimestamp(),
  });

  if (shouldSellInShop) {
    await db.collection("shop").doc(normalizedItemId).set(
      {
        name: normalizedName,
        description: normalizedDescription,
        shortLabel: normalizedShortLabel,
        icon: normalizedIcon,
        spriteKey: normalizedSpriteKey,
        colorPreset: normalizedColorPreset,
        category: normalizedCategory,
        foodCurrencyReward: normalizedFoodCurrencyReward,
        price: normalizedPrice,
        sellInShop: true,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } else {
    await db.collection("shop").doc(normalizedItemId).delete().catch(() => null);
  }

  const usersSnapshot = await db.collection("users").get();
  await Promise.all(
    usersSnapshot.docs.map(async (userDoc) => {
      const data = userDoc.data();
      const inventory = Array.isArray(data.inventory) ? [...data.inventory] : [];
      let touched = false;

      const nextInventory = inventory.map((inventoryItem) => {
        let nextInventoryItem = inventoryItem;
        if (itemMatchesDefinition(inventoryItem, normalizedItemId, matchingNames)) {
          touched = true;
          nextInventoryItem = {
            ...inventoryItem,
            name: normalizedName,
            itemId: normalizedItemId,
            description: normalizedDescription,
            shortLabel: normalizedShortLabel,
            icon: normalizedIcon,
            spriteKey: normalizedSpriteKey,
            colorPreset: normalizedColorPreset,
            category: normalizedCategory,
            foodCurrencyReward: normalizedFoodCurrencyReward,
          };
        }
        const nestedUpdatedItem = mapNestedStoredItem(nextInventoryItem, (storedItem) => {
          if (!itemMatchesDefinition(storedItem, normalizedItemId, matchingNames)) {
            return storedItem;
          }
          touched = true;
          return {
            ...storedItem,
            name: normalizedName,
            itemId: normalizedItemId,
            description: normalizedDescription,
            shortLabel: normalizedShortLabel,
            icon: normalizedIcon,
            spriteKey: normalizedSpriteKey,
            colorPreset: normalizedColorPreset,
            category: normalizedCategory,
            foodCurrencyReward: normalizedFoodCurrencyReward,
          };
        });
        return nestedUpdatedItem;
      });

      const currentDecorations = Array.isArray(data.profileDecorations) ? data.profileDecorations : [];
      const nextProfileDecorations = currentDecorations.map((decoration) => {
        if (!itemMatchesDefinition(decoration, normalizedItemId, matchingNames)) {
          return decoration;
        }
        touched = true;
        return {
          ...decoration,
          itemId: normalizedItemId,
          name: normalizedName,
          description: normalizedDescription,
          shortLabel: normalizedShortLabel,
          icon: normalizedIcon,
          spriteKey: normalizedSpriteKey,
          colorPreset: normalizedColorPreset,
          category: normalizedCategory,
          foodCurrencyReward: normalizedFoodCurrencyReward,
        };
      });

      if (!touched) {
        return null;
      }

      return userDoc.ref.update({
        inventory: nextInventory,
        profileDecorations: nextProfileDecorations,
        updatedAt: FieldValue.serverTimestamp(),
      });
    })
  );

  const parcelsSnapshot = await db.collection("parcels").get();
  await Promise.all(
    parcelsSnapshot.docs.map(async (parcelDoc) => {
      const parcelData = parcelDoc.data();
      let touched = false;
      const currentItems = Array.isArray(parcelData.items) ? parcelData.items : [];
      const nextItems = currentItems.map((parcelItem) => {
        let nextParcelItem = parcelItem;
        if (itemMatchesDefinition(parcelItem, normalizedItemId, matchingNames)) {
          touched = true;
          nextParcelItem = {
            ...parcelItem,
            itemId: normalizedItemId,
            name: normalizedName,
            description: normalizedDescription,
            shortLabel: normalizedShortLabel,
            icon: normalizedIcon,
            spriteKey: normalizedSpriteKey,
            colorPreset: normalizedColorPreset,
            category: normalizedCategory,
            foodCurrencyReward: normalizedFoodCurrencyReward,
          };
        }
        return mapNestedStoredItem(nextParcelItem, (storedItem) => {
          if (!itemMatchesDefinition(storedItem, normalizedItemId, matchingNames)) {
            return storedItem;
          }
          touched = true;
          return {
            ...storedItem,
            itemId: normalizedItemId,
            name: normalizedName,
            description: normalizedDescription,
            shortLabel: normalizedShortLabel,
            icon: normalizedIcon,
            spriteKey: normalizedSpriteKey,
            colorPreset: normalizedColorPreset,
            category: normalizedCategory,
            foodCurrencyReward: normalizedFoodCurrencyReward,
          };
        });
      });

      const currentPrimaryItem = parcelData.item;
      const nextPrimaryItem =
        currentPrimaryItem && itemMatchesDefinition(currentPrimaryItem, normalizedItemId, matchingNames)
          ? {
              ...currentPrimaryItem,
              itemId: normalizedItemId,
              name: normalizedName,
              description: normalizedDescription,
              shortLabel: normalizedShortLabel,
              icon: normalizedIcon,
              spriteKey: normalizedSpriteKey,
              colorPreset: normalizedColorPreset,
              category: normalizedCategory,
              foodCurrencyReward: normalizedFoodCurrencyReward,
            }
          : currentPrimaryItem;
      const nextPrimaryItemWithNested = mapNestedStoredItem(nextPrimaryItem, (storedItem) => {
        if (!itemMatchesDefinition(storedItem, normalizedItemId, matchingNames)) {
          return storedItem;
        }
        touched = true;
        return {
          ...storedItem,
          itemId: normalizedItemId,
          name: normalizedName,
          description: normalizedDescription,
          shortLabel: normalizedShortLabel,
          icon: normalizedIcon,
          spriteKey: normalizedSpriteKey,
          colorPreset: normalizedColorPreset,
          category: normalizedCategory,
          foodCurrencyReward: normalizedFoodCurrencyReward,
        };
      });

      if (nextPrimaryItemWithNested !== currentPrimaryItem) {
        touched = true;
      }

      if (!touched) {
        return null;
      }

      return parcelDoc.ref.update({
        item: nextPrimaryItemWithNested || null,
        items: nextItems,
        updatedAt: FieldValue.serverTimestamp(),
      });
    })
  );

  return { ok: true, itemId: normalizedItemId };
});

exports.deleteItemDefinition = onCall(async (request) => {
  assertAuthenticated(request);
  await assertAdmin(request.auth.uid);

  const normalizedItemId = String(request.data?.itemId || "").trim();
  if (!normalizedItemId) {
    throw new HttpsError("invalid-argument", "Item id is required.");
  }
  const itemSnapshot = await db.collection("item-db").doc(normalizedItemId).get();
  const matchingNames = buildItemMatchNames(itemSnapshot.data()?.name);

  await Promise.all([
    db.collection("item-db").doc(normalizedItemId).delete(),
    db.collection("shop").doc(normalizedItemId).delete(),
  ]);

  const usersSnapshot = await db.collection("users").get();
  await Promise.all(
    usersSnapshot.docs.map(async (userDoc) => {
      const data = userDoc.data();
      const currentInventory = Array.isArray(data.inventory) ? data.inventory : [];
      const nextInventory = currentInventory
        .filter((item) => !itemMatchesDefinition(item, normalizedItemId, matchingNames))
        .map((item) =>
          mapNestedStoredItem(item, (storedItem) =>
            itemMatchesDefinition(storedItem, normalizedItemId, matchingNames) ? null : storedItem
          )
        );
      const currentDecorations = Array.isArray(data.profileDecorations) ? data.profileDecorations : [];
      const nextDecorations = currentDecorations.filter((item) => !itemMatchesDefinition(item, normalizedItemId, matchingNames));

      if (nextInventory.length === currentInventory.length && nextDecorations.length === currentDecorations.length) {
        return null;
      }

      return userDoc.ref.update({
        inventory: nextInventory,
        profileDecorations: nextDecorations,
        updatedAt: FieldValue.serverTimestamp(),
      });
    })
  );

  const parcelsSnapshot = await db.collection("parcels").get();
  await Promise.all(
    parcelsSnapshot.docs.map(async (parcelDoc) => {
      const data = parcelDoc.data();
      const currentItems = Array.isArray(data.items) ? data.items : [];
      const nextItems = currentItems
        .filter((item) => !itemMatchesDefinition(item, normalizedItemId, matchingNames))
        .map((item) =>
          mapNestedStoredItem(item, (storedItem) =>
            itemMatchesDefinition(storedItem, normalizedItemId, matchingNames) ? null : storedItem
          )
        );
      const currentPrimaryItem = data.item;
      const nextPrimaryItem =
        currentPrimaryItem && itemMatchesDefinition(currentPrimaryItem, normalizedItemId, matchingNames) ? null : currentPrimaryItem;
      const nextPrimaryItemWithNested = mapNestedStoredItem(nextPrimaryItem, (storedItem) =>
        itemMatchesDefinition(storedItem, normalizedItemId, matchingNames) ? null : storedItem
      );

      if (nextItems.length === currentItems.length && nextPrimaryItemWithNested === currentPrimaryItem) {
        return null;
      }

      return parcelDoc.ref.update({
        item: nextPrimaryItemWithNested,
        items: nextItems,
        updatedAt: FieldValue.serverTimestamp(),
      });
    })
  );

  return { ok: true, itemId: normalizedItemId };
});

exports.purchaseShopItem = onCall(async (request) => {
  assertAuthenticated(request);
  await ensureGlobalGameData();

  const shopItemId = String(request.data?.shopItemId || "").trim();
  const quantity = Math.max(1, Math.min(99, Number(request.data?.quantity || 1)));
  if (!shopItemId) {
    throw new HttpsError("invalid-argument", "Shop item id is required.");
  }

  const userSnapshot = await findUserSnapshotByUid(request.auth.uid);
  if (!userSnapshot) {
    throw new HttpsError("not-found", "User profile was not found.");
  }

  const [shopSnapshot, itemDefinitionSnapshot] = await Promise.all([
    db.collection("shop").doc(shopItemId).get(),
    db.collection("item-db").doc(shopItemId).get(),
  ]);

  if (!shopSnapshot.exists) {
    throw new HttpsError("not-found", "Shop item was not found.");
  }

  const shopItem = shopSnapshot.data();
  const userData = userSnapshot.data();
  const currentCurrency = Number(userData.currency || 0);
  const price = Number(shopItem.price || 0);
  const totalPrice = price * quantity;
  if (currentCurrency < totalPrice) {
    throw new HttpsError("failed-precondition", `보유 환이 부족합니다. 현재 ${currentCurrency}환만 보유 중입니다.`);
  }

  const itemDefinition = itemDefinitionSnapshot.exists
    ? { id: itemDefinitionSnapshot.id, ...itemDefinitionSnapshot.data() }
    : {
        id: shopItemId,
        name: shopItem.name,
        description: shopItem.description,
        shortLabel: shopItem.name,
        icon: "🎁",
        spriteKey: String(shopItem.spriteKey || "").trim(),
        colorPreset: String(shopItem.colorPreset || "").trim(),
        category: "상점",
      };

  const inventory = Array.isArray(userData.inventory) ? [...userData.inventory] : [];
  Array.from({ length: quantity }).forEach(() => {
    inventory.push(buildInventoryItemFromDefinition(itemDefinition));
  });

  await userSnapshot.ref.update({
    currency: currentCurrency - totalPrice,
    inventory,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return { ok: true, shopItemId, quantity };
});
exports.adminDeleteUser = onCall(async (request) => {
  assertAuthenticated(request);
  await assertAdmin(request.auth.uid);

  const characterName = String(request.data?.characterName || "").trim();
  if (!characterName) {
    throw new HttpsError("invalid-argument", "Character name is required.");
  }

  const targetSnapshot = await findUserSnapshotByCharacterName(characterName);
  if (!targetSnapshot) {
    throw new HttpsError("not-found", "Target user was not found.");
  }

  const targetData = targetSnapshot.data();
  await targetSnapshot.ref.delete();

  if (targetData.uid) {
    try {
      await adminAuth.deleteUser(targetData.uid);
    } catch (_error) {
      // Keep Firestore deletion even if auth user was already removed.
    }
  }

  return { ok: true, deletedCharacterName: characterName };
});

exports.createAnnouncement = onCall(async (request) => {
  assertAuthenticated(request);
  const adminProfile = await assertAdmin(request.auth.uid);
  const title = String(request.data?.title || "").trim();
  const body = String(request.data?.body || "").trim();

  if (title.length < 2 || body.length < 2) {
    throw new HttpsError("invalid-argument", "Announcement title and body are required.");
  }

  const noticeCreatedAt = new Date();
  const noticeId = buildNoticeId(title, noticeCreatedAt);
  const noticePayload = {
    title,
    body,
    active: true,
    noticeId,
    createdByUid: adminProfile.uid,
    createdByCharacterName: adminProfile.characterName,
    createdAt: FieldValue.serverTimestamp(),
    createdAtText: noticeCreatedAt.toLocaleString("ko-KR"),
  };

  await Promise.all([
    db.collection("announcements").doc(noticeId).set(noticePayload, { merge: true }),
    db.collection("notice-logs").doc(noticeId).set(noticePayload, { merge: true }),
  ]);

  return { ok: true, announcementId: noticeId };
});

exports.listAdminLogs = onCall(async (request) => {
  assertAuthenticated(request);
  await assertAdmin(request.auth.uid);

  const kind = String(request.data?.kind || "").trim();
  const page = Math.max(0, Number(request.data?.page || 0));
  const pageSize = Math.min(20, Math.max(1, Number(request.data?.pageSize || 5)));
  const collectionName = kind === "notice" ? "notice-logs" : kind === "operate" ? "operate-logs" : "";

  if (!collectionName) {
    throw new HttpsError("invalid-argument", "Invalid log kind.");
  }

  const snapshot = await db
    .collection(collectionName)
    .orderBy("createdAt", "desc")
    .offset(page * pageSize)
    .limit(pageSize + 1)
    .get();

  const docs = snapshot.docs.slice(0, pageSize).map((item) => ({
    id: item.id,
    ...serialize(item.data()),
  }));

  return {
    items: docs,
    page,
    pageSize,
    hasNext: snapshot.docs.length > pageSize,
  };
});

exports.listBugReports = onCall(async (request) => {
  assertAuthenticated(request);
  await assertAdmin(request.auth.uid);

  const page = Math.max(0, Number(request.data?.page || 0));
  const pageSize = Math.min(20, Math.max(1, Number(request.data?.pageSize || 5)));
  const snapshot = await db
    .collection("report-logs")
    .orderBy("createdAt", "desc")
    .offset(page * pageSize)
    .limit(pageSize + 1)
    .get();

  const docs = snapshot.docs.slice(0, pageSize).map((item) => ({
    id: item.id,
    ...serialize(item.data()),
  }));

  return {
    items: docs,
    page,
    pageSize,
    hasNext: snapshot.docs.length > pageSize,
  };
});

exports.dismissAnnouncement = onCall(async (request) => {
  assertAuthenticated(request);
  const announcementId = String(request.data?.announcementId || "").trim();
  if (!announcementId) {
    throw new HttpsError("invalid-argument", "Announcement id is required.");
  }

  const snapshot = await findUserSnapshotByUid(request.auth.uid);
  if (!snapshot) {
    throw new HttpsError("not-found", "Profile does not exist.");
  }

  await snapshot.ref.update({
    dismissedAnnouncementIds: FieldValue.arrayUnion(announcementId),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const updated = await snapshot.ref.get();
  return {
    profile: {
      docId: updated.id,
      ...serialize(updated.data()),
    },
  };
});

exports.sendParcel = onCall(async (request) => {
  assertAuthenticated(request);
  const senderSnapshot = await findUserSnapshotByUid(request.auth.uid);
  if (!senderSnapshot) {
    throw new HttpsError("not-found", "보내는 사람 프로필을 찾지 못했습니다.");
  }

  const { targetCharacterName, itemKeys = [], currencyAmount = 0, chargeAmount = 0, useWrapping = false } = request.data || {};
  const receiverCharacterName = String(targetCharacterName || "").trim();
  const normalizedItemKeys = Array.isArray(itemKeys)
    ? itemKeys.map((itemKey) => String(itemKey || "").trim()).filter(Boolean)
    : [];
  const numericCurrencyAmount = normalizeNonNegativeCurrency(currencyAmount);
  const wantsWrapping = Boolean(useWrapping);
  const numericChargeAmount = wantsWrapping ? 0 : normalizeNonNegativeCurrency(chargeAmount);

  if (!receiverCharacterName) {
    throw new HttpsError("invalid-argument", "받는 사람 캐릭터명을 입력해 주세요.");
  }
  if (!normalizedItemKeys.length && numericCurrencyAmount <= 0) {
    throw new HttpsError("invalid-argument", "보낼 아이템이나 환을 하나 이상 입력해 주세요.");
  }

  const receiverSnapshot = await findUserSnapshotByCharacterName(receiverCharacterName);
  if (!receiverSnapshot) {
    throw new HttpsError("not-found", "받는 사람 캐릭터를 찾지 못했습니다.");
  }

  const senderData = senderSnapshot.data();
  const receiverData = receiverSnapshot.data();
  if (senderData.uid === receiverData.uid) {
    throw new HttpsError("invalid-argument", "자기 자신에게는 소포를 보낼 수 없습니다.");
  }

  const parcelRef = db.collection("parcels").doc();

  const giftedItemsForNotification = [];
  await db.runTransaction(async (transaction) => {
    const currentSenderSnapshot = await transaction.get(senderSnapshot.ref);
    if (!currentSenderSnapshot.exists) {
      throw new HttpsError("not-found", "보내는 사람 프로필이 존재하지 않습니다.");
    }

    const currentSenderData = currentSenderSnapshot.data();
    const inventory = Array.isArray(currentSenderData.inventory) ? [...currentSenderData.inventory] : [];
    const currentCurrency = Number(currentSenderData.currency || 0);

    if (numericCurrencyAmount > currentCurrency) {
      throw new HttpsError(
        "failed-precondition",
        `보유 환이 부족합니다. 현재 ${currentCurrency}환만 보유 중입니다.`
      );
    }

    const giftedItems = [];
    for (const normalizedItemKey of normalizedItemKeys) {
      const itemIndex = inventory.findIndex((item) => buildInventoryItemKey(item) === normalizedItemKey);
      if (itemIndex === -1) {
        throw new HttpsError("failed-precondition", "선택한 아이템이 인벤토리에 없어서 보낼 수 없습니다.");
      }
      giftedItems.push(normalizeSystemInventoryItem(inventory.splice(itemIndex, 1)[0]));
    }

    if (wantsWrapping) {
      const wrappingIndex = inventory.findIndex(isDeliveryBoxItem);
      if (wrappingIndex === -1) {
        throw new HttpsError("failed-precondition", "택배 상자를 사용하려면 인벤토리에 택배 상자가 있어야 합니다.");
      }
      inventory.splice(wrappingIndex, 1);
    }

    transaction.update(senderSnapshot.ref, {
      currency: currentCurrency - numericCurrencyAmount,
      inventory,
      updatedAt: FieldValue.serverTimestamp(),
    });

    transaction.set(parcelRef, {
      senderUid: currentSenderData.uid,
      senderCharacterName: currentSenderData.characterName,
      receiverUid: receiverData.uid,
      receiverCharacterName: receiverData.characterName,
      item: giftedItems[0] || null,
      items: giftedItems,
      currencyAmount: numericCurrencyAmount,
      chargeAmount: numericChargeAmount,
      wrapped: wantsWrapping,
      contentRevealed: false,
      canReject: true,
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
      autoAcceptAfterMs: Date.now() + 24 * 60 * 60 * 1000,
      updatedAt: FieldValue.serverTimestamp(),
    });
    giftedItemsForNotification.push(...giftedItems);
  });

  await createNotification({
    targetUid: receiverData.uid,
    targetCharacterName: receiverData.characterName,
    type: "parcel-received",
    message: `${senderData.characterName}님이 소포를 보냈습니다.`,
      payload: {
        parcelId: parcelRef.id,
        wrapped: wantsWrapping,
        preview: wantsWrapping
          ? "택배 상자로 포장된 소포가 도착했습니다."
          : buildParcelPreview({
              itemNames: giftedItemsForNotification.map((item) => item?.name).filter(Boolean),
              currencyAmount: numericCurrencyAmount,
              chargeAmount: numericChargeAmount,
            }),
      },
    });

  return { ok: true, parcelId: parcelRef.id };
});
exports.respondParcel = onCall(async (request) => {
  assertAuthenticated(request);
  const parcelId = String(request.data?.parcelId || "").trim();
  const action = String(request.data?.action || "").trim();

  if (!parcelId || !["accept", "reject", "reveal"].includes(action)) {
    throw new HttpsError("invalid-argument", "소포 처리 방식이 올바르지 않습니다.");
  }

  const parcelRef = db.collection("parcels").doc(parcelId);
  const parcelSnapshot = await parcelRef.get();
  if (!parcelSnapshot.exists) {
    throw new HttpsError("not-found", "대상 소포를 찾지 못했습니다.");
  }

  const parcel = parcelSnapshot.data();
  if (parcel.receiverUid !== request.auth.uid) {
    throw new HttpsError("permission-denied", "이 소포를 처리할 권한이 없습니다.");
  }
  if (parcel.status !== "pending") {
    throw new HttpsError("failed-precondition", "이미 처리된 소포여서 다시 선택할 수 없습니다.");
  }
  await resolveParcel({
    parcelId,
    action,
    actorUid: request.auth.uid,
    automatic: false,
  });

  return { ok: true, action };
});

exports.useInventoryItem = onCall(async (request) => {
  assertAuthenticated(request);

  const itemKey = String(request.data?.itemKey || "").trim();
  const extraData =
    request.data?.extraData && typeof request.data.extraData === "object"
      ? request.data.extraData
      : {};

  if (!itemKey) {
    throw new HttpsError("invalid-argument", "Item key is required.");
  }

  const userSnapshot = await findUserSnapshotByUid(request.auth.uid);
  if (!userSnapshot) {
    throw new HttpsError("not-found", "User profile was not found.");
  }

  const userData = userSnapshot.data();
  const inventory = Array.isArray(userData.inventory) ? [...userData.inventory] : [];
  const itemIndex = inventory.findIndex((item) => buildInventoryItemKey(item) === itemKey);
  if (itemIndex === -1) {
    throw new HttpsError("not-found", "Inventory item was not found.");
  }

  const usedItem = inventory[itemIndex];
  if (isHammerItem(usedItem) || isDeliveryBoxItem(usedItem) || isDisposalPermitItem(usedItem)) {
    throw new HttpsError("failed-precondition", "시스템 처리용 물품은 인벤토리에서 직접 사용할 수 없습니다.");
  }
  const itemDefinitionSnapshot = usedItem.itemId
    ? await db.collection("item-db").doc(String(usedItem.itemId)).get()
    : null;
  const itemDefinition = itemDefinitionSnapshot?.exists
    ? { id: itemDefinitionSnapshot.id, ...itemDefinitionSnapshot.data() }
    : null;
  const useConfig =
    itemDefinition?.useConfig && typeof itemDefinition.useConfig === "object"
      ? itemDefinition.useConfig
      : {};
  const normalizedCategory = normalizeItemCategory(itemDefinition?.category || usedItem?.category);

  if (Array.isArray(useConfig.requiredFields) && useConfig.requiredFields.length) {
    const missingField = useConfig.requiredFields.find((field) => !String(extraData?.[field] || "").trim());
    if (missingField) {
      throw new HttpsError("invalid-argument", `추가 입력값 '${missingField}' 이 필요합니다.`);
    }
  }

  const nextInventory = [...inventory];
  const receiptCode = `[${String(request.auth.uid || "UID").slice(0, 6).toUpperCase()}-${Math.random()
    .toString(36)
    .slice(2, 8)
    .toUpperCase()}]`;
  const nextProfileDecorations = Array.isArray(userData.profileDecorations) ? [...userData.profileDecorations] : [];
  let effectDescription = String(
    itemDefinition?.useEffectDescription ||
      itemDefinition?.description ||
      usedItem.description ||
      "아이템 효과 설명은 아직 등록되지 않았습니다."
  ).trim();
  let createdDecoration = null;
  let grantedCurrency = 0;
  let stolenItem = null;
  const normalizedItemName = normalizeSystemItemName(usedItem?.name || itemDefinition?.name || "");
  const shouldConsumeItem = normalizedItemName !== "금고";

  if (shouldConsumeItem) {
    nextInventory.splice(itemIndex, 1);
  }

  if (normalizedCategory === "프로필 꾸미기") {
    const spriteKey = String(usedItem?.spriteKey || itemDefinition?.spriteKey || "").trim();
    if (!spriteKey) {
      throw new HttpsError("failed-precondition", "프로필 꾸미기 아이템에는 도트 이미지가 필요합니다.");
    }
    createdDecoration = {
      id: `profile-decor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      itemId: String(usedItem?.itemId || itemDefinition?.id || "").trim(),
      name: String(usedItem?.name || itemDefinition?.name || "프로필 장식").trim(),
      spriteKey,
      colorPreset: String(usedItem?.colorPreset || itemDefinition?.colorPreset || "").trim(),
      x: 0.5,
      y: 0.5,
      createdAt: new Date().toISOString(),
    };
    nextProfileDecorations.push(createdDecoration);
    effectDescription = `${createdDecoration.name} 장식을 간단 프로필에 추가했습니다.`;
  }

  const profileUpdates = {};
  if (normalizedItemName === "낡은 차광포") {
    profileUpdates.publicInventoryHiddenUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    effectDescription = "24시간 동안 공개 프로필의 인벤토리를 비공개로 전환했습니다.";
  } else if (normalizedItemName === "차광포") {
    profileUpdates.publicInventoryHiddenUntil = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
    effectDescription = "72시간 동안 공개 프로필의 인벤토리를 비공개로 전환했습니다.";
  } else if (normalizedItemName === "위장 물약") {
    const disguiseFactionName = String(request.data?.extraData?.targetFactionName || "").trim();
    if (!allowedFactions.has(disguiseFactionName)) {
      throw new HttpsError("invalid-argument", "위장할 진영을 올바르게 선택해 주세요.");
    }
    if (disguiseFactionName === String(userData.factionName || "").trim()) {
      throw new HttpsError("failed-precondition", "현재 진영과 다른 진영으로만 위장할 수 있습니다.");
    }
    profileUpdates.factionDisguiseName = disguiseFactionName;
    profileUpdates.factionDisguiseUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    effectDescription = `24시간 동안 공개 프로필의 진영을 ${disguiseFactionName}(으)로 위장합니다.`;
  } else if (normalizedItemName === "식칼") {
    const targetCharacterName = String(extraData?.targetCharacterName || "").trim();
    if (!targetCharacterName) {
      throw new HttpsError("invalid-argument", "대상 캐릭터 이름을 입력해 주세요.");
    }
    if (targetCharacterName === String(userData.characterName || "").trim()) {
      throw new HttpsError("failed-precondition", "자기 자신에게는 사용할 수 없습니다.");
    }

    const targetSnapshot = await findUserSnapshotByCharacterName(targetCharacterName);
    if (!targetSnapshot) {
      throw new HttpsError("not-found", "대상 캐릭터를 찾지 못했습니다.");
    }
    const targetData = targetSnapshot.data() || {};
    const targetInventory = Array.isArray(targetData.inventory) ? [...targetData.inventory] : [];
    const stealableIndexes = targetInventory
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !isSafeItem(item));

    if (!stealableIndexes.length) {
      effectDescription = `${targetCharacterName}의 인벤토리를 뒤졌지만 훔쳐올 수 있는 아이템이 없었습니다.`;
    } else {
      const selectedEntry = stealableIndexes[Math.floor(Math.random() * stealableIndexes.length)];
      stolenItem = normalizeSystemInventoryItem(targetInventory.splice(selectedEntry.index, 1)[0]);
      nextInventory.push(stolenItem);

      await targetSnapshot.ref.update({
        inventory: targetInventory,
        updatedAt: FieldValue.serverTimestamp(),
      });
      effectDescription = `${targetCharacterName}의 인벤토리에서 ${String(stolenItem?.name || "아이템").trim()} 하나를 훔쳐왔습니다.`;
    }
  } else if (normalizedItemName === "금고") {
    const storedItem = normalizeStoredInventoryItem(usedItem?.storedItem);
    if (storedItem) {
      nextInventory[itemIndex] = {
        ...usedItem,
        storedItem: null,
      };
      delete nextInventory[itemIndex].storedItem;
      nextInventory.push(storedItem);
      effectDescription = `${storedItem.name}을(를) 금고에서 꺼내 인벤토리로 되돌렸습니다.`;
    } else {
      const storedItemKey = String(extraData?.storedItemKey || "").trim();
      if (!storedItemKey) {
        throw new HttpsError("invalid-argument", "금고에 넣을 아이템을 선택해 주세요.");
      }
      const candidateIndex = nextInventory.findIndex((item, index) =>
        index !== itemIndex && buildInventoryItemKey(item) === storedItemKey
      );
      if (candidateIndex === -1) {
        throw new HttpsError("not-found", "금고에 넣을 아이템을 찾지 못했습니다.");
      }
      const candidateItem = nextInventory[candidateIndex];
      if (isSafeItem(candidateItem)) {
        throw new HttpsError("failed-precondition", "금고는 다른 금고를 보관할 수 없습니다.");
      }
      nextInventory.splice(candidateIndex, 1);
      const safeIndex = candidateIndex < itemIndex ? itemIndex - 1 : itemIndex;
      nextInventory[safeIndex] = {
        ...usedItem,
        storedItem: normalizeStoredInventoryItem(candidateItem),
      };
      effectDescription = `${String(candidateItem?.name || "아이템").trim()}을(를) 금고에 보관했습니다.`;
    }
  }

  if (normalizedCategory === "음식") {
    grantedCurrency = Math.max(
      0,
      Math.floor(Number(itemDefinition?.foodCurrencyReward ?? usedItem?.foodCurrencyReward ?? 0))
    );
    if (grantedCurrency > 0) {
      profileUpdates.currency = Math.max(0, Number(userData.currency || 0)) + grantedCurrency;
      effectDescription = `${effectDescription} 환 ${grantedCurrency}을(를) 추가로 획득했습니다.`;
    }
  }

  await userSnapshot.ref.update({
    inventory: nextInventory,
    profileDecorations: nextProfileDecorations,
    ...profileUpdates,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return {
    ok: true,
    item: serialize(usedItem),
    receiptCode,
    effectDescription,
    useConfig: serialize(useConfig),
    profileDecorations: serialize(nextProfileDecorations),
    createdDecoration: serialize(createdDecoration),
    grantedCurrency,
    stolenItem: serialize(stolenItem),
    profileUpdates: serialize(profileUpdates),
  };
});

exports.returnProfileDecorationToInventory = onCall(async (request) => {
  assertAuthenticated(request);

  const decorationId = String(request.data?.decorationId || "").trim();
  if (!decorationId) {
    throw new HttpsError("invalid-argument", "장식 ID가 필요합니다.");
  }

  const userSnapshot = await findUserSnapshotByUid(request.auth.uid);
  if (!userSnapshot) {
    throw new HttpsError("not-found", "User profile was not found.");
  }

  const userData = userSnapshot.data();
  const profileDecorations = Array.isArray(userData.profileDecorations) ? [...userData.profileDecorations] : [];
  const decorationIndex = profileDecorations.findIndex((item) => String(item?.id || "").trim() === decorationId);
  if (decorationIndex === -1) {
    throw new HttpsError("not-found", "프로필 장식을 찾지 못했습니다.");
  }

  const decoration = profileDecorations.splice(decorationIndex, 1)[0];
  const inventory = Array.isArray(userData.inventory) ? [...userData.inventory] : [];
  const itemDefinitionSnapshot = decoration?.itemId
    ? await db.collection("item-db").doc(String(decoration.itemId)).get()
    : null;
  const itemDefinition = itemDefinitionSnapshot?.exists
    ? { id: itemDefinitionSnapshot.id, ...itemDefinitionSnapshot.data() }
    : null;

  inventory.push(
    buildInventoryItemFromDefinition(
      itemDefinition || {
        id: String(decoration?.itemId || "").trim(),
        name: String(decoration?.name || "프로필 장식").trim(),
        description: "",
        shortLabel: String(decoration?.name || "프로필 장식").trim(),
        icon: "🎁",
        spriteKey: String(decoration?.spriteKey || "").trim(),
        colorPreset: String(decoration?.colorPreset || "").trim(),
        category: "프로필 꾸미기",
      }
    )
  );

  await userSnapshot.ref.update({
    inventory,
    profileDecorations,
    updatedAt: FieldValue.serverTimestamp(),
  });

  const updatedSnapshot = await userSnapshot.ref.get();
  return {
    ok: true,
    profile: {
      docId: updatedSnapshot.id,
      ...serialize(updatedSnapshot.data()),
    },
  };
});

exports.markNotificationRead = onCall(async (request) => {
  assertAuthenticated(request);
  const notificationId = String(request.data?.notificationId || "").trim();
  if (!notificationId) {
    throw new HttpsError("invalid-argument", "Notification id is required.");
  }

  const notificationRef = db.collection("notifications").doc(notificationId);
  const notificationSnapshot = await notificationRef.get();
  if (!notificationSnapshot.exists) {
    throw new HttpsError("not-found", "Notification was not found.");
  }

  const notificationData = notificationSnapshot.data();
  if (notificationData.targetUid !== request.auth.uid) {
    throw new HttpsError("permission-denied", "You cannot modify this notification.");
  }

  await notificationRef.update({
    isRead: true,
    readAt: FieldValue.serverTimestamp(),
  });

  return { ok: true };
});

exports.yachtAction = onCall(async (request) => {
  assertAuthenticated(request);
  const action = String(request.data?.action || "").trim();
  const roomId = String(request.data?.roomId || "").trim();
  const uid = request.auth.uid;

  switch (action) {
    case "create-room": {
      const profileSnapshot = await findUserSnapshotByUid(uid);
      if (!profileSnapshot) {
        throw new HttpsError("not-found", "사용자 프로필을 찾지 못했습니다.");
      }

      const title = String(request.data?.title || "").trim();
      if (!title) {
        throw new HttpsError("invalid-argument", "방 제목을 입력해 주세요.");
      }

      const roomRef = db.collection("yacht-rooms").doc();
      const now = Date.now();
      await roomRef.set({
        title,
        ownerUid: uid,
        status: YACHT_ROOM_STATUS_WAITING,
        actionPhase: YACHT_PHASE_WAITING,
        players: [buildYachtPlayerFromProfile(profileSnapshot.data())],
        spectators: [],
        dice: [1, 1, 1, 1, 1],
        heldDice: [false, false, false, false, false],
        diceSeed: now,
        rollCount: 0,
        currentTurnSeat: 0,
        actionDeadlineAtMs: 0,
        rollResolveAtMs: 0,
        diceMotion: null,
        visualDiceState: null,
        rewardPlan: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        createdAtMs: now,
        updatedAtMs: now,
      });
      return { ok: true, roomId: roomRef.id };
    }
    case "join-room":
      return runYachtRoomMutation(roomId, async (transaction, snapshot) => {
        const profileSnapshot = await findUserSnapshotByUid(uid);
        if (!profileSnapshot) {
          throw new HttpsError("not-found", "사용자 프로필을 찾지 못했습니다.");
        }

        const room = snapshot.data();
        if (String(room.status || "") !== YACHT_ROOM_STATUS_WAITING) {
          throw new HttpsError("failed-precondition", "진행 중인 방에는 플레이어로 입장할 수 없습니다.");
        }

        const players = Array.isArray(room.players) ? [...room.players] : [];
        if (players.some((player) => String(player.uid || "") === uid)) {
          return { ok: true, roomId };
        }
        if (players.length >= YACHT_MAX_PLAYERS) {
          throw new HttpsError("failed-precondition", "방 인원이 가득 찼습니다.");
        }

        const spectators = (Array.isArray(room.spectators) ? room.spectators : []).filter(
          (spectator) => String(spectator.uid || "") !== uid
        );
        players.push(buildYachtPlayerFromProfile(profileSnapshot.data()));

        transaction.update(snapshot.ref, {
          players,
          spectators,
          updatedAt: FieldValue.serverTimestamp(),
          updatedAtMs: Date.now(),
        });
        return { ok: true, roomId };
      });
    case "join-spectator":
      return runYachtRoomMutation(roomId, async (transaction, snapshot) => {
        const profileSnapshot = await findUserSnapshotByUid(uid);
        if (!profileSnapshot) {
          throw new HttpsError("not-found", "사용자 프로필을 찾지 못했습니다.");
        }

        const room = snapshot.data();
        if (String(room.status || "") !== YACHT_ROOM_STATUS_PLAYING) {
          throw new HttpsError("failed-precondition", "진행 중인 방만 관전할 수 있습니다.");
        }

        const players = Array.isArray(room.players) ? room.players : [];
        if (players.some((player) => String(player.uid || "") === uid)) {
          return { ok: true, roomId };
        }

        const spectators = Array.isArray(room.spectators) ? [...room.spectators] : [];
        if (!spectators.some((spectator) => String(spectator.uid || "") === uid)) {
          const data = profileSnapshot.data();
          spectators.push({
            uid: data.uid,
            characterName: data.characterName,
            nickname: data.nickname,
          });
        }

        transaction.update(snapshot.ref, {
          spectators,
          updatedAt: FieldValue.serverTimestamp(),
          updatedAtMs: Date.now(),
        });
        return { ok: true, roomId };
      });
    case "toggle-ready":
      return runYachtRoomMutation(roomId, async (transaction, snapshot) => {
        const room = snapshot.data();
        if (String(room.status || "") !== YACHT_ROOM_STATUS_WAITING) {
          throw new HttpsError("failed-precondition", "대기실에서만 준비 상태를 바꿀 수 있습니다.");
        }
        if (String(room.ownerUid || "") === uid) {
          throw new HttpsError("failed-precondition", "방장은 준비 버튼을 누를 수 없습니다.");
        }

        const players = (Array.isArray(room.players) ? room.players : []).map((player) =>
          String(player.uid || "") === uid ? { ...player, isReady: !player.isReady } : player
        );

        transaction.update(snapshot.ref, {
          players,
          updatedAt: FieldValue.serverTimestamp(),
          updatedAtMs: Date.now(),
        });
        return { ok: true };
      });
    case "start-game":
      return runYachtRoomMutation(roomId, async (transaction, snapshot) => {
        const room = snapshot.data();
        if (String(room.status || "") !== YACHT_ROOM_STATUS_WAITING) {
          throw new HttpsError("failed-precondition", "이미 시작된 방입니다.");
        }
        if (!canYachtHostStartGame(room, uid)) {
          throw new HttpsError("failed-precondition", resolveYachtStartError(room, uid));
        }

        const startSeed = Date.now();
        const players = (Array.isArray(room.players) ? room.players : [])
          .map((player, index) => ({
            player,
            order: pseudoRandom(startSeed + index * 97 + hashYachtString(player.uid || player.characterName || "")),
          }))
          .sort((left, right) => left.order - right.order)
          .map(({ player }) =>
            finalizeYachtPlayer({
              ...player,
              isReady: false,
              rank: 0,
              rewardCurrency: 0,
              scoreSheet: createEmptyYachtScoreSheet(),
            })
          );

        const startedRoom = {
          title: String(room.title || "요트 방"),
          ownerUid: String(room.ownerUid || ""),
          players,
          spectators: Array.isArray(room.spectators) ? room.spectators : [],
          status: YACHT_ROOM_STATUS_PLAYING,
          actionPhase: YACHT_PHASE_AWAITING_ROLL,
          currentTurnSeat: 0,
          rollCount: 0,
          dice: [1, 1, 1, 1, 1],
          heldDice: [false, false, false, false, false],
          diceSeed: startSeed,
          actionDeadlineAtMs: startSeed + YACHT_TURN_LIMIT_MS,
          rollResolveAtMs: 0,
          diceMotion: null,
          visualDiceState: null,
          emoteEvents: Array.isArray(room.emoteEvents) ? room.emoteEvents : [],
          rewardPlan: room.rewardPlan || null,
          createdAtMs: Number(room.createdAtMs || startSeed),
          updatedAtMs: Date.now(),
        };

        transaction.update(snapshot.ref, {
          players: startedRoom.players,
          status: startedRoom.status,
          actionPhase: startedRoom.actionPhase,
          currentTurnSeat: startedRoom.currentTurnSeat,
          rollCount: startedRoom.rollCount,
          dice: startedRoom.dice,
          heldDice: startedRoom.heldDice,
          diceSeed: startedRoom.diceSeed,
          actionDeadlineAtMs: startedRoom.actionDeadlineAtMs,
          rollResolveAtMs: startedRoom.rollResolveAtMs,
          diceMotion: startedRoom.diceMotion,
          visualDiceState: startedRoom.visualDiceState,
          updatedAt: FieldValue.serverTimestamp(),
          updatedAtMs: startedRoom.updatedAtMs,
        });
        return { ok: true, room: startedRoom };
      });
    case "send-emote":
      return runYachtRoomMutation(roomId, async (transaction, snapshot) => {
        const room = snapshot.data();
        const allowedEmotes = new Set([
          "joy",
          "astonished",
          "cry",
          "thinking",
          "pleading",
          "scream",
          "cool",
          "woozy",
          "wink",
        ]);
        const emote = String(request.data?.emote || "").trim();
        if (!allowedEmotes.has(emote)) {
          throw new HttpsError("invalid-argument", "지원하지 않는 감정표현입니다.");
        }

        const members = [
          ...(Array.isArray(room.players) ? room.players : []),
          ...(Array.isArray(room.spectators) ? room.spectators : []),
        ];
        const member = members.find((item) => String(item.uid || "") === uid);
        if (!member) {
          throw new HttpsError("permission-denied", "방에 있는 사람만 감정표현을 보낼 수 있습니다.");
        }

        const now = Date.now();
        const previousEvents = Array.isArray(room.emoteEvents) ? room.emoteEvents : [];
        const emoteEvents = previousEvents
          .filter((event) => now - Number(event.createdAtMs || 0) < 15000)
          .slice(-11);
        emoteEvents.push({
          id: `${now}-${uid.slice(0, 8)}`,
          uid,
          characterName: String(member.characterName || "플레이어").slice(0, 24),
          emote,
          createdAtMs: now,
        });

        transaction.update(snapshot.ref, {
          emoteEvents,
          updatedAt: FieldValue.serverTimestamp(),
          updatedAtMs: now,
        });
        return { ok: true };
      });
    case "request-roll":
      return runYachtRoomMutation(roomId, async (transaction, snapshot) => {
        const room = snapshot.data();
        if (!canYachtUserRoll(room, uid)) {
          throw new HttpsError("failed-precondition", "지금은 주사위를 굴릴 수 없습니다.");
        }

        const nextRollCount = Number(room.rollCount || 0) + 1;
        const seed = Date.now();
        const previousDice = normalizeYachtDice(room.dice);
        const heldDice = normalizeYachtHeldDice(room.heldDice);
        const rolledDice = buildYachtRolledDice(seed, nextRollCount);
        const dice = previousDice.map((value, index) => (heldDice[index] ? value : rolledDice[index]));
        const diceMotion = buildYachtDiceMotion(seed, dice, heldDice);

        transaction.update(snapshot.ref, {
          dice,
          heldDice,
          diceSeed: seed,
          rollCount: nextRollCount,
          actionPhase: YACHT_PHASE_ROLLING,
          rollResolveAtMs: Date.now() + YACHT_ROLL_ANIMATION_MS,
          diceMotion,
          visualDiceState: null,
          updatedAt: FieldValue.serverTimestamp(),
          updatedAtMs: Date.now(),
        });
        return { ok: true };
      });
    case "toggle-hold":
      return runYachtRoomMutation(roomId, async (transaction, snapshot) => {
        const room = snapshot.data();
        if (!canYachtUserToggleHold(room, uid)) {
          throw new HttpsError("failed-precondition", "지금은 주사위를 고정할 수 없습니다.");
        }

        const dieIndex = Number(request.data?.dieIndex);
        if (!Number.isInteger(dieIndex) || dieIndex < 0 || dieIndex >= YACHT_DICE_COUNT) {
          throw new HttpsError("invalid-argument", "잘못된 주사위 번호입니다.");
        }
        const diceSeed = Number(request.data?.diceSeed || 0);
        if (diceSeed && Number(room.diceSeed || 0) !== diceSeed) {
          throw new HttpsError("failed-precondition", "이미 다음 굴림 상태로 변경되었습니다.");
        }

        const heldDice = normalizeYachtHeldDice(room.heldDice);
        heldDice[dieIndex] = !heldDice[dieIndex];
        const nextVisualDiceState = request.data?.visualDiceState
          ? normalizeYachtVisualDiceState(
              request.data?.visualDiceState,
              Number(room.diceSeed || 0),
              normalizeYachtDice(room.dice)
            )
          : room.visualDiceState || null;
        const updatePayload = {
          heldDice,
          visualDiceState: nextVisualDiceState,
          updatedAt: FieldValue.serverTimestamp(),
          updatedAtMs: Date.now(),
        };
        if (nextVisualDiceState?.values) {
          updatePayload.dice = normalizeYachtDice(nextVisualDiceState.values);
        }
        transaction.update(snapshot.ref, updatePayload);
        return { ok: true };
      });
    case "sync-dice":
    case "sync-visual-state":
      return runYachtRoomMutation(roomId, async (transaction, snapshot) => {
        const room = snapshot.data();
        const diceSeed = Number(request.data?.diceSeed || 0);
        if (String(room.status || "") !== YACHT_ROOM_STATUS_PLAYING) {
          throw new HttpsError("failed-precondition", "진행 중인 방만 동기화할 수 있습니다.");
        }
        if (String(getCurrentYachtTurnPlayer(room)?.uid || "") !== String(uid || "")) {
          throw new HttpsError("failed-precondition", "현재 차례 플레이어만 결과를 동기화할 수 있습니다.");
        }
        if (diceSeed && Number(room.diceSeed || 0) !== diceSeed) {
          throw new HttpsError("failed-precondition", "이미 다음 굴림 상태로 변경되었습니다.");
        }

        const dice = normalizeYachtDice(request.data?.dice);
        const visualDiceState = normalizeYachtVisualDiceState(
          request.data?.visualDiceState,
          Number(room.diceSeed || 0),
          dice
        );
        const updatePayload = {
          dice,
          visualDiceState,
          rollResolveAtMs: 0,
          updatedAt: FieldValue.serverTimestamp(),
          updatedAtMs: Date.now(),
        };
        if (String(room.actionPhase || "") === YACHT_PHASE_ROLLING) {
          updatePayload.actionPhase = YACHT_PHASE_AWAITING_ROLL;
          updatePayload.actionDeadlineAtMs = Date.now() + YACHT_TURN_LIMIT_MS;
          updatePayload.diceMotion = null;
        }
        transaction.update(snapshot.ref, updatePayload);
        return { ok: true };
      });
    case "reset-holds":
      return runYachtRoomMutation(roomId, async (transaction, snapshot) => {
        const room = snapshot.data();
        if (!canYachtUserToggleHold(room, uid)) {
          throw new HttpsError("failed-precondition", "지금은 주사위 고정을 해제할 수 없습니다.");
        }

        transaction.update(snapshot.ref, {
          heldDice: [false, false, false, false, false],
          updatedAt: FieldValue.serverTimestamp(),
          updatedAtMs: Date.now(),
        });
        return { ok: true };
      });
    case "lock-score":
      return runYachtRoomMutation(roomId, async (transaction, snapshot) => {
        const room = snapshot.data();
        const categoryId = String(request.data?.categoryId || "");
        if (!YACHT_PLAYABLE_CATEGORY_IDS.includes(categoryId)) {
          throw new HttpsError("invalid-argument", "잘못된 점수 칸입니다.");
        }
        if (!canYachtUserScore(room, uid)) {
          throw new HttpsError("failed-precondition", "지금은 점수를 확정할 수 없습니다.");
        }

        const players = [...(Array.isArray(room.players) ? room.players : [])];
        const seat = Number(room.currentTurnSeat || 0);
        const player = players[seat];
        if (!player || String(player.uid || "") !== uid) {
          throw new HttpsError("failed-precondition", "현재 차례 플레이어가 아닙니다.");
        }
        if (player.scoreSheet?.[categoryId]?.locked) {
          throw new HttpsError("failed-precondition", "이미 선택한 점수 칸입니다.");
        }

        const scoreSheet = {
          ...(player.scoreSheet || createEmptyYachtScoreSheet()),
          [categoryId]: {
            score: calculateYachtCategoryScore(categoryId, normalizeYachtDice(room.dice)),
            locked: true,
          },
        };
        players[seat] = finalizeYachtPlayer({ ...player, scoreSheet });

        applyYachtPostScoreUpdate(transaction, snapshot.ref, players, seat);
        return { ok: true };
      });
    case "leave-room":
      return runYachtRoomMutation(roomId, async (transaction, snapshot) => {
        applyYachtLeaveRoom(transaction, snapshot, uid);
        return { ok: true };
      });
    case "restart-room":
      return runYachtRoomMutation(roomId, async (transaction, snapshot) => {
        const room = snapshot.data();
        if (String(room.status || "") !== YACHT_ROOM_STATUS_FINISHED) {
          return { ok: true, redirectLobby: true };
        }

        const players = Array.isArray(room.players) ? [...room.players] : [];
        const spectators = Array.isArray(room.spectators) ? [...room.spectators] : [];
        const requesterPlayer = players.find((player) => String(player.uid || "") === uid);
        const requesterSpectator = spectators.find((spectator) => String(spectator.uid || "") === uid);
        if (!requesterPlayer && !requesterSpectator) {
          throw new HttpsError("failed-precondition", "방에 남아 있는 참가자만 재시작할 수 있습니다.");
        }

        const restartRoomId = String(room.restartRoomId || "").trim();
        if (restartRoomId) {
          const restartRef = db.collection("yacht-rooms").doc(restartRoomId);
          const restartSnapshot = await transaction.get(restartRef);
          if (!restartSnapshot.exists) {
            transaction.update(snapshot.ref, {
              restartRoomId: FieldValue.delete(),
              updatedAt: FieldValue.serverTimestamp(),
              updatedAtMs: Date.now(),
            });
            return { ok: true, redirectLobby: true };
          }

          const restartRoom = restartSnapshot.data();
          if (String(restartRoom.status || "") !== YACHT_ROOM_STATUS_WAITING) {
            return { ok: true, redirectLobby: true };
          }

          const restartPlayers = Array.isArray(restartRoom.players) ? [...restartRoom.players] : [];
          if (!restartPlayers.some((player) => String(player.uid || "") === uid)) {
            if (restartPlayers.length >= YACHT_MAX_PLAYERS) {
              throw new HttpsError("resource-exhausted", "재시작 대기실 인원이 가득 찼습니다.");
            }
            const profileSnapshot = await findUserSnapshotByUid(uid);
            if (!profileSnapshot) {
              throw new HttpsError("not-found", "사용자 프로필을 찾지 못했습니다.");
            }
            restartPlayers.push(buildYachtPlayerFromProfile(profileSnapshot.data()));
          }

          transaction.update(restartRef, {
            players: restartPlayers.map((player, index) =>
              finalizeYachtPlayer({
                ...player,
                isReady: index === 0 ? true : Boolean(player.isReady),
                rank: 0,
                rewardCurrency: 0,
                scoreSheet: createEmptyYachtScoreSheet(),
              })
            ),
            spectators: (Array.isArray(restartRoom.spectators) ? restartRoom.spectators : []).filter(
              (spectator) => String(spectator.uid || "") !== uid
            ),
            updatedAt: FieldValue.serverTimestamp(),
            updatedAtMs: Date.now(),
          });
          return { ok: true, roomId: restartRoomId, role: "player" };
        }

        let requesterSeed = requesterPlayer;
        if (!requesterSeed) {
          const profileSnapshot = await findUserSnapshotByUid(uid);
          if (!profileSnapshot) {
            throw new HttpsError("not-found", "사용자 프로필을 찾지 못했습니다.");
          }
          requesterSeed = buildYachtPlayerFromProfile(profileSnapshot.data());
        }

        const restartRef = db.collection("yacht-rooms").doc();
        transaction.set(restartRef, {
          title: room.title || "Yacht",
          mode: "multi",
          ownerUid: uid,
          players: [
            finalizeYachtPlayer({
              ...requesterSeed,
              isReady: true,
              rank: 0,
              rewardCurrency: 0,
              scoreSheet: createEmptyYachtScoreSheet(),
            }),
          ],
          spectators: [],
          status: YACHT_ROOM_STATUS_WAITING,
          actionPhase: YACHT_PHASE_WAITING,
          currentTurnSeat: 0,
          rollCount: 0,
          dice: [1, 1, 1, 1, 1],
          heldDice: [false, false, false, false, false],
          diceSeed: Date.now(),
          actionDeadlineAtMs: 0,
          rollResolveAtMs: 0,
          diceMotion: null,
          visualDiceState: null,
          rewardPlan: null,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          updatedAtMs: Date.now(),
        });
        transaction.update(snapshot.ref, {
          restartRoomId: restartRef.id,
          updatedAt: FieldValue.serverTimestamp(),
          updatedAtMs: Date.now(),
        });
        return { ok: true, roomId: restartRef.id, role: "player" };
      });
    case "advance-room":
      return runYachtRoomMutation(roomId, async (transaction, snapshot) => {
        const room = snapshot.data();
        if (String(room.status || "") !== YACHT_ROOM_STATUS_PLAYING) {
          return { ok: true };
        }

        const now = Date.now();
        if (String(room.actionPhase || "") === YACHT_PHASE_ROLLING && Number(room.rollResolveAtMs || 0) <= now) {
          transaction.update(snapshot.ref, {
            actionPhase: YACHT_PHASE_AWAITING_ROLL,
            actionDeadlineAtMs: Date.now() + YACHT_TURN_LIMIT_MS,
            rollResolveAtMs: 0,
            updatedAt: FieldValue.serverTimestamp(),
            updatedAtMs: Date.now(),
          });
          return { ok: true, advanced: "resolve-roll" };
        }

        if (
          String(room.actionPhase || "") === YACHT_PHASE_AWAITING_ROLL &&
          Number(room.actionDeadlineAtMs || 0) <= now
        ) {
          if (Number(room.rollCount || 0) < 3) {
            const nextRollCount = Math.min(3, Number(room.rollCount || 0) + 1);
            const seed = Date.now();
            const previousDice = normalizeYachtDice(room.dice);
            const heldDice = normalizeYachtHeldDice(room.heldDice);
            const rolledDice = buildYachtRolledDice(seed, nextRollCount);
            const dice = previousDice.map((value, index) => (heldDice[index] ? value : rolledDice[index]));
            const diceMotion = buildYachtDiceMotion(seed, dice, heldDice);
            transaction.update(snapshot.ref, {
              dice,
              heldDice,
              diceSeed: seed,
              rollCount: nextRollCount,
              actionPhase: YACHT_PHASE_ROLLING,
              actionDeadlineAtMs: 0,
              rollResolveAtMs: Date.now() + YACHT_ROLL_ANIMATION_MS,
              diceMotion,
              visualDiceState: null,
              updatedAt: FieldValue.serverTimestamp(),
              updatedAtMs: Date.now(),
            });
            return { ok: true, advanced: "auto-roll" };
          }

          const players = [...(Array.isArray(room.players) ? room.players : [])];
          const seat = Number(room.currentTurnSeat || 0);
          const player = players[seat];
          if (!player) {
            return { ok: true };
          }
          const bestCategoryId = pickBestYachtScoreCategory(player.scoreSheet, normalizeYachtDice(room.dice));
          if (!bestCategoryId) {
            return { ok: true };
          }

          const scoreSheet = {
            ...(player.scoreSheet || createEmptyYachtScoreSheet()),
            [bestCategoryId]: {
              score: calculateYachtCategoryScore(bestCategoryId, normalizeYachtDice(room.dice)),
              locked: true,
            },
          };
          players[seat] = finalizeYachtPlayer({ ...player, scoreSheet });
          applyYachtPostScoreUpdate(transaction, snapshot.ref, players, seat);
          return { ok: true, advanced: "auto-score" };
        }

        return { ok: true };
      });
    default:
      throw new HttpsError("invalid-argument", "알 수 없는 요트 액션입니다.");
  }
});

exports.spinRoulette = onRequest(async (_req, res) => {
  res.status(410).json({
    error: "Roulette reward grant is disabled. The frontend logs roulette results directly.",
  });
});

exports.autoAcceptExpiredParcels = onSchedule("every 15 minutes", async () => {
  await processAllExpiredParcels();
});

exports.advanceStaleYachtRooms = onSchedule("every 5 minutes", async () => {
  await processStaleYachtRooms();
});

function assertAuthenticated(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication is required.");
  }
}

async function assertAdmin(uid) {
  const snapshot = await findUserSnapshotByUid(uid);
  if (!snapshot) {
    throw new HttpsError("not-found", "Profile does not exist.");
  }

  const data = snapshot.data();
  if (!["admin", "gm", "moderator"].includes(String(data.role || ""))) {
    throw new HttpsError("permission-denied", "Admin role is required.");
  }

  return data;
}

async function ensureGlobalGameData() {
  const writes = [];

  for (const trait of defaultTraits) {
    const ref = db.collection("traits").doc(trait.id);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      writes.push(ref.set(trait));
    }
  }

  if (writes.length) {
    await Promise.all(writes);
  }
}

function validateProfileInput({ loginId, nickname, characterName }) {
  const idPattern = /^[a-z0-9_]{4,20}$/;

  if (!idPattern.test(String(loginId || ""))) {
    throw new HttpsError("invalid-argument", "Login ID must use lowercase letters, numbers, or underscore.");
  }
  if (String(nickname || "").trim().length < 2) {
    throw new HttpsError("invalid-argument", "Nickname must be at least 2 characters.");
  }
  if (String(characterName || "").trim().length < 2) {
    throw new HttpsError("invalid-argument", "Character name must be at least 2 characters.");
  }
  if (String(characterName || "").includes("/")) {
    throw new HttpsError("invalid-argument", "Character name cannot contain slash.");
  }
}

async function createNotification({ targetUid, targetCharacterName, type, message, payload = {} }) {
  await db.collection("notifications").add({
    targetUid,
    targetCharacterName,
    type,
    message,
    payload,
    isRead: false,
    createdAt: FieldValue.serverTimestamp(),
  });
}

async function processExpiredParcelsForUid(uid) {
  const snapshot = await db.collection("parcels").where("receiverUid", "==", uid).where("status", "==", "pending").get();
  const now = Date.now();

  for (const item of snapshot.docs) {
    const data = item.data();
    const expiresAt = Number(data.autoAcceptAfterMs || 0);
    if (expiresAt && expiresAt <= now) {
      try {
        await resolveParcel({
          parcelId: item.id,
          action: "accept",
          actorUid: uid,
          automatic: true,
        });
      } catch (_error) {
        // Ignore stale or already-processed parcels.
      }
    }
  }
}

async function processAllExpiredParcels() {
  const snapshot = await db.collection("parcels").where("status", "==", "pending").get();
  const now = Date.now();

  for (const item of snapshot.docs) {
    const data = item.data();
    const expiresAt = Number(data.autoAcceptAfterMs || 0);
    if (!expiresAt || expiresAt > now) {
      continue;
    }

    try {
      await resolveParcel({
        parcelId: item.id,
        action: "accept",
        actorUid: data.receiverUid,
        automatic: true,
      });
    } catch (_error) {
      // Ignore parcels that were processed in parallel or became invalid.
    }
  }
}

async function resolveParcel({ parcelId, action, actorUid, automatic }) {
  const parcelRef = db.collection("parcels").doc(parcelId);
  const parcelSnapshot = await parcelRef.get();
  if (!parcelSnapshot.exists) {
    throw new HttpsError("not-found", "Parcel was not found.");
  }

  const parcel = parcelSnapshot.data();
  if (parcel.receiverUid !== actorUid) {
    throw new HttpsError("permission-denied", "You cannot access this parcel.");
  }

  const senderSnapshot = await findUserSnapshotByUid(parcel.senderUid);
  const receiverSnapshot = await findUserSnapshotByUid(parcel.receiverUid);
  if (!senderSnapshot || !receiverSnapshot) {
    throw new HttpsError("not-found", "Sender or receiver profile was not found.");
  }

  await db.runTransaction(async (transaction) => {
    const [currentSenderSnapshot, currentReceiverSnapshot, currentParcelSnapshot] = await Promise.all([
      transaction.get(senderSnapshot.ref),
      transaction.get(receiverSnapshot.ref),
      transaction.get(parcelRef),
    ]);

    if (!currentParcelSnapshot.exists) {
      throw new HttpsError("not-found", "Parcel was not found.");
    }

    const currentParcel = currentParcelSnapshot.data();
    if (currentParcel.status !== "pending") {
      throw new HttpsError("failed-precondition", "Parcel is already closed.");
    }

    const senderData = currentSenderSnapshot.data();
    const receiverData = currentReceiverSnapshot.data();
    const senderInventory = Array.isArray(senderData.inventory) ? [...senderData.inventory] : [];
    const receiverInventory = Array.isArray(receiverData.inventory) ? [...receiverData.inventory] : [];
    let senderCurrency = Number(senderData.currency || 0);
    let receiverCurrency = Number(receiverData.currency || 0);
    const chargeAmount = normalizeNonNegativeCurrency(currentParcel.chargeAmount);

    if (action === "reveal") {
      if (!currentParcel.wrapped) {
        throw new HttpsError("failed-precondition", "일반 소포는 이미 내용물을 확인할 수 있습니다.");
      }
      if (currentParcel.contentRevealed) {
        return;
      }
      const hammerIndex = receiverInventory.findIndex(isHammerItem);
      if (hammerIndex === -1) {
        throw new HttpsError("failed-precondition", "택배 상자 내용을 확인하려면 망치가 필요합니다.");
      }
      receiverInventory.splice(hammerIndex, 1);
      transaction.update(receiverSnapshot.ref, {
        inventory: receiverInventory,
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.update(parcelRef, {
        contentRevealed: true,
        revealedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    if (action === "reject" && currentParcel.wrapped) {
      const rejectTicketIndex = receiverInventory.findIndex(isDisposalPermitItem);
      if (rejectTicketIndex === -1) {
        throw new HttpsError("failed-precondition", "택배 상자로 온 소포를 거절하려면 폐기 승인서가 필요합니다.");
      }
      receiverInventory.splice(rejectTicketIndex, 1);
    }

    if (action === "accept") {
      if (chargeAmount > 0) {
        if (receiverCurrency < chargeAmount) {
          throw new HttpsError(
            "failed-precondition",
            `청구 금액 ${chargeAmount}환을 지불하기 전까지 소포는 보류됩니다. 현재 ${receiverCurrency}환을 보유 중입니다.`
          );
        }
        receiverCurrency -= chargeAmount;
        senderCurrency += chargeAmount;
      }
      if (Array.isArray(currentParcel.items) && currentParcel.items.length) {
        receiverInventory.push(...currentParcel.items.map((item) => normalizeSystemInventoryItem(item)));
      } else if (currentParcel.item) {
        receiverInventory.push(normalizeSystemInventoryItem(currentParcel.item));
      }
      receiverCurrency += Number(currentParcel.currencyAmount || 0);
      transaction.update(receiverSnapshot.ref, {
        inventory: receiverInventory,
        currency: receiverCurrency,
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (chargeAmount > 0) {
        transaction.update(senderSnapshot.ref, {
          currency: senderCurrency,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    } else {
      if (Array.isArray(currentParcel.items) && currentParcel.items.length) {
        senderInventory.push(...currentParcel.items.map((item) => normalizeSystemInventoryItem(item)));
      } else if (currentParcel.item) {
        senderInventory.push(normalizeSystemInventoryItem(currentParcel.item));
      }
      senderCurrency += Number(currentParcel.currencyAmount || 0);
      transaction.update(senderSnapshot.ref, {
        inventory: senderInventory,
        currency: senderCurrency,
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.update(receiverSnapshot.ref, {
        inventory: receiverInventory,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    transaction.update(parcelRef, {
      status: action === "accept" ? "accepted" : "rejected",
      respondedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      resolvedAutomatically: Boolean(automatic),
    });
  });

  if (action === "reveal") {
    return;
  }

  await createNotification({
    targetUid: parcel.senderUid,
    targetCharacterName: parcel.senderCharacterName,
    type: action === "accept" ? "parcel-accepted" : "parcel-rejected",
    message:
      action === "accept"
        ? automatic
          ? `${parcel.receiverCharacterName}님의 소포가 1일 경과로 자동 수령되었습니다.${normalizeNonNegativeCurrency(parcel.chargeAmount) > 0 ? ` 청구 비용 ${normalizeNonNegativeCurrency(parcel.chargeAmount)}환을 받았습니다.` : ""}`
          : `${parcel.receiverCharacterName}님이 소포를 수령했습니다.${normalizeNonNegativeCurrency(parcel.chargeAmount) > 0 ? ` 청구 비용 ${normalizeNonNegativeCurrency(parcel.chargeAmount)}환을 받았습니다.` : ""}`
        : `${parcel.receiverCharacterName}님이 소포를 거절했습니다.`,
    payload: { parcelId, automatic: Boolean(automatic) },
  });

  if (action === "accept" && automatic) {
    await createNotification({
      targetUid: parcel.receiverUid,
      targetCharacterName: parcel.receiverCharacterName,
      type: "parcel-auto-accepted",
      message: `${parcel.senderCharacterName}님의 소포가 1일 경과로 자동 수령되었습니다.`,
      payload: { parcelId },
    });
  }
}

function buildParcelPreview({ itemName, itemNames = [], currencyAmount, chargeAmount }) {
  const parts = [];
  if (Array.isArray(itemNames) && itemNames.length) {
    parts.push(`아이템 ${itemNames.join(", ")}`);
  } else if (itemName) {
    parts.push(`아이템 ${String(itemName).trim()}`);
  }
  if (Number(currencyAmount || 0) > 0) {
    parts.push(`환 ${Number(currencyAmount || 0)}`);
  }
  if (Number(chargeAmount || 0) > 0) {
    parts.push(`청구 ${Number(chargeAmount || 0)}환`);
  }
  return parts.join(" / ") || "소포가 도착했습니다.";
}

function normalizeNonNegativeCurrency(value) {
  const numericValue = Number(value || 0);
  return Number.isFinite(numericValue) ? Math.max(0, numericValue) : 0;
}

async function runYachtRoomMutation(roomId, handler) {
  const normalizedRoomId = String(roomId || "").trim();
  if (!normalizedRoomId) {
    throw new HttpsError("invalid-argument", "방 ID가 필요합니다.");
  }

  return db.runTransaction(async (transaction) => {
    const roomRef = db.collection("yacht-rooms").doc(normalizedRoomId);
    const snapshot = await transaction.get(roomRef);
    if (!snapshot.exists) {
      throw new HttpsError("not-found", "방을 찾지 못했습니다.");
    }
    return handler(transaction, snapshot);
  });
}

function buildYachtPlayerFromProfile(profile) {
  return finalizeYachtPlayer({
    uid: profile.uid,
    characterName: profile.characterName,
    nickname: profile.nickname,
    isReady: false,
    scoreSheet: createEmptyYachtScoreSheet(),
    upperSubtotal: 0,
    bonus: 0,
    finalScore: 0,
    rank: 0,
    rewardCurrency: 0,
  });
}

function createEmptyYachtScoreSheet() {
  return YACHT_PLAYABLE_CATEGORY_IDS.reduce((map, categoryId) => {
    map[categoryId] = { score: null, locked: false };
    return map;
  }, {});
}

function finalizeYachtPlayer(player) {
  const scoreSheet = player.scoreSheet || createEmptyYachtScoreSheet();
  const upperSubtotal = YACHT_UPPER_IDS.reduce((sum, key) => sum + Number(scoreSheet[key]?.score || 0), 0);
  const lowerSubtotal = YACHT_LOWER_IDS.reduce((sum, key) => sum + Number(scoreSheet[key]?.score || 0), 0);
  const bonus = upperSubtotal >= 63 ? 35 : 0;

  return {
    ...player,
    scoreSheet,
    upperSubtotal,
    bonus,
    finalScore: upperSubtotal + lowerSubtotal + bonus,
  };
}

function calculateYachtCategoryScore(categoryId, dice) {
  const sorted = [...dice].sort((left, right) => left - right);
  const counts = new Map();
  dice.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
  const total = dice.reduce((sum, value) => sum + value, 0);

  switch (categoryId) {
    case "aces":
      return sumYachtByFace(dice, 1);
    case "deuces":
      return sumYachtByFace(dice, 2);
    case "threes":
      return sumYachtByFace(dice, 3);
    case "fours":
      return sumYachtByFace(dice, 4);
    case "fives":
      return sumYachtByFace(dice, 5);
    case "sixes":
      return sumYachtByFace(dice, 6);
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
      return hasYachtStraight(sorted, 4) ? 25 : 0;
    case "largeStraight":
      return hasYachtStraight(sorted, 5) ? 40 : 0;
    case "yacht":
      return Array.from(counts.values()).some((count) => count === 5) ? 50 : 0;
    default:
      return 0;
  }
}

function pickBestYachtScoreCategory(scoreSheet, dice) {
  return YACHT_PLAYABLE_CATEGORY_IDS
    .filter((categoryId) => !scoreSheet?.[categoryId]?.locked)
    .map((categoryId, index) => ({
      categoryId,
      score: calculateYachtCategoryScore(categoryId, dice),
      index,
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.index - right.index;
    })[0]?.categoryId;
}

function canYachtHostStartGame(room, uid) {
  if (String(room.ownerUid || "") !== String(uid || "")) return false;
  const players = Array.isArray(room.players) ? room.players : [];
  if (players.length < 1) return false;
  return players
    .filter((player) => String(player.uid || "") !== String(room.ownerUid || ""))
    .every((player) => Boolean(player.isReady));
}

function resolveYachtStartError(room, uid) {
  if (String(room.ownerUid || "") !== String(uid || "")) {
    return "방장만 게임을 시작할 수 있습니다.";
  }
  const players = Array.isArray(room.players) ? room.players : [];
  if (players.length < 1) {
    return "플레이어가 있어야 게임을 시작할 수 있습니다.";
  }
  const waitingPlayers = players.filter(
    (player) => String(player.uid || "") !== String(room.ownerUid || "") && !player.isReady
  );
  if (waitingPlayers.length) {
    return "다른 플레이어가 모두 준비 완료해야 합니다.";
  }
  return "게임을 시작할 수 없습니다.";
}

function canYachtUserRoll(room, uid) {
  return (
    String(room.status || "") === YACHT_ROOM_STATUS_PLAYING &&
    String(room.actionPhase || "") === YACHT_PHASE_AWAITING_ROLL &&
    Number(room.rollCount || 0) < 3 &&
    String(getCurrentYachtTurnPlayer(room)?.uid || "") === String(uid || "")
  );
}

function canYachtUserToggleHold(room, uid) {
  return (
    String(room.status || "") === YACHT_ROOM_STATUS_PLAYING &&
    String(room.actionPhase || "") === YACHT_PHASE_AWAITING_ROLL &&
    Number(room.rollCount || 0) > 0 &&
    String(getCurrentYachtTurnPlayer(room)?.uid || "") === String(uid || "")
  );
}

function canYachtUserScore(room, uid) {
  return (
    String(room.status || "") === YACHT_ROOM_STATUS_PLAYING &&
    String(room.actionPhase || "") !== YACHT_PHASE_ROLLING &&
    Number(room.rollCount || 0) > 0 &&
    String(getCurrentYachtTurnPlayer(room)?.uid || "") === String(uid || "")
  );
}

function getCurrentYachtTurnPlayer(room) {
  const players = Array.isArray(room?.players) ? room.players : [];
  return players[Number(room?.currentTurnSeat || 0)] || null;
}

function findNextYachtSeat(players, currentSeat) {
  for (let offset = 1; offset <= players.length; offset += 1) {
    const nextSeat = (currentSeat + offset) % players.length;
    if (!isYachtScoreSheetComplete(players[nextSeat]?.scoreSheet)) return nextSeat;
  }
  return currentSeat;
}

function isYachtScoreSheetComplete(scoreSheet) {
  return YACHT_PLAYABLE_CATEGORY_IDS.every((categoryId) => Boolean(scoreSheet?.[categoryId]?.locked));
}

function normalizeYachtDice(dice) {
  const nextDice = Array.isArray(dice) ? [...dice] : [];
  while (nextDice.length < YACHT_DICE_COUNT) nextDice.push(1);
  return nextDice.slice(0, YACHT_DICE_COUNT).map((value) => Math.max(1, Math.min(6, Number(value || 1))));
}

function normalizeYachtHeldDice(heldDice) {
  const nextHeldDice = Array.isArray(heldDice) ? [...heldDice] : [];
  while (nextHeldDice.length < YACHT_DICE_COUNT) nextHeldDice.push(false);
  return nextHeldDice.slice(0, YACHT_DICE_COUNT).map((value) => Boolean(value));
}

function normalizeYachtVisualDiceState(visualDiceState, fallbackDiceSeed = 0, fallbackDice = [1, 1, 1, 1, 1]) {
  if (!visualDiceState || typeof visualDiceState !== "object") {
    return null;
  }

  const diceSeed = Math.max(0, Number(visualDiceState.diceSeed || fallbackDiceSeed || 0));
  const values = normalizeYachtDice(Array.isArray(visualDiceState.values) ? visualDiceState.values : fallbackDice);
  const sourcePoses = visualDiceState.poses && typeof visualDiceState.poses === "object" ? visualDiceState.poses : {};
  const poses = {};

  for (let index = 0; index < YACHT_DICE_COUNT; index += 1) {
    const pose = sourcePoses[index];
    if (!pose || typeof pose !== "object") continue;

    const px = Number(pose.position?.x);
    const py = Number(pose.position?.y);
    const pz = Number(pose.position?.z);
    const qx = Number(pose.quaternion?.x);
    const qy = Number(pose.quaternion?.y);
    const qz = Number(pose.quaternion?.z);
    const qw = Number(pose.quaternion?.w);

    if (
      !Number.isFinite(px) ||
      !Number.isFinite(py) ||
      !Number.isFinite(pz) ||
      !Number.isFinite(qx) ||
      !Number.isFinite(qy) ||
      !Number.isFinite(qz) ||
      !Number.isFinite(qw)
    ) {
      continue;
    }

    poses[index] = {
      position: { x: px, y: py, z: pz },
      quaternion: { x: qx, y: qy, z: qz, w: qw },
    };
  }

  return {
    diceSeed,
    values,
    poses,
    updatedAtMs: Date.now(),
  };
}

function sumYachtByFace(dice, face) {
  return dice.filter((value) => value === face).reduce((sum, value) => sum + value, 0);
}

function hasYachtStraight(sortedDice, length) {
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

function buildYachtRolledDice(seedBase, rollCount) {
  return Array.from({ length: YACHT_DICE_COUNT }, (_, index) => {
    const valueSeed = pseudoRandom(seedBase * 97 + rollCount * 53 + index * 19);
    return Math.max(1, Math.min(6, Math.floor(valueSeed * 6) + 1));
  });
}

function buildYachtBoardPositions(seedBase) {
  return Array.from({ length: YACHT_DICE_COUNT }, (_, index) => {
    const seed = seedBase * 31 + index * 17 + 7;
    const angle = (Math.PI * 2 * index) / YACHT_DICE_COUNT + pseudoRandom(seed + 1) * 0.42;
    const radius = 8 + pseudoRandom(seed + 2) * 4.2;
    return {
      x: 50 + Math.cos(angle) * radius,
      y: 50 + Math.sin(angle) * radius,
    };
  });
}

function clampYachtPlanarPosition(x, z, limit = YACHT_DIE_CENTER_LIMIT) {
  const distance = Math.hypot(x, z);
  if (distance <= limit) return { x, z };
  const scale = limit / Math.max(distance, 0.0001);
  return {
    x: x * scale,
    z: z * scale,
  };
}

function resolveYachtNonOverlappingPlanarPosition(x, z, occupiedEntries = [], limit = YACHT_DIE_CENTER_LIMIT, minGap = 0.78) {
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
      const clamped = clampYachtPlanarPosition(nextX, nextZ, limit);
      nextX = clamped.x;
      nextZ = clamped.z;
      moved = true;
    });
    if (!moved) break;
  }

  return { x: nextX, z: nextZ };
}

function buildYachtDiceMotion(seedBase, dice, heldDice) {
  const positions = buildYachtBoardPositions(seedBase);
  const occupiedPlanarEntries = [];
  const playRadius = YACHT_DIE_CENTER_LIMIT;

  const diceEntries = normalizeYachtDice(dice).map((value, index) => {
    let px = ((positions[index].x - 50) / 50) * 5;
    let pz = ((positions[index].y - 50) / 50) * 5;
    const clamped = clampYachtPlanarPosition(px, pz, playRadius);
    px = clamped.x;
    pz = clamped.z;

    const occupiedByOthers = occupiedPlanarEntries.filter((entry) => entry.index !== index);
    const restingPlanar = resolveYachtNonOverlappingPlanarPosition(px, pz, occupiedByOthers, playRadius);
    px = restingPlanar.x;
    pz = restingPlanar.z;
    occupiedPlanarEntries.push({ index, x: px, z: pz, held: Boolean(heldDice[index]) });

    const throwSide = Math.floor(pseudoRandom(seedBase + index * 101) * 4);
    const sideDrift = (pseudoRandom(seedBase + index * 103) - 0.5) * 0.32;
    let startX = px;
    let startZ = pz;
    let velocityX = 0;
    let velocityZ = 0;

    if (throwSide === 0) {
      startX = -playRadius + 0.2;
      startZ = pz + sideDrift;
      velocityX = 6.9 + pseudoRandom(seedBase + index * 107) * 1.1;
      velocityZ = (0.5 - pseudoRandom(seedBase + index * 109)) * 1.35;
    } else if (throwSide === 1) {
      startX = playRadius - 0.2;
      startZ = pz + sideDrift;
      velocityX = -6.9 - pseudoRandom(seedBase + index * 107) * 1.1;
      velocityZ = (0.5 - pseudoRandom(seedBase + index * 109)) * 1.35;
    } else if (throwSide === 2) {
      startX = px + sideDrift;
      startZ = -playRadius + 0.2;
      velocityX = (0.5 - pseudoRandom(seedBase + index * 107)) * 1.35;
      velocityZ = 6.9 + pseudoRandom(seedBase + index * 109) * 1.1;
    } else {
      startX = px + sideDrift;
      startZ = playRadius - 0.2;
      velocityX = (0.5 - pseudoRandom(seedBase + index * 107)) * 1.35;
      velocityZ = -6.9 - pseudoRandom(seedBase + index * 109) * 1.1;
    }

    const startPlanar = resolveYachtNonOverlappingPlanarPosition(
      startX,
      startZ,
      occupiedPlanarEntries.filter((entry) => entry.held && entry.index !== index),
      playRadius - 0.08,
      0.72
    );

    return {
      index,
      value,
      held: Boolean(heldDice[index]),
      start: {
        x: startPlanar.x,
        y: 0.76 + pseudoRandom(seedBase + index * 113) * 0.12,
        z: startPlanar.z,
      },
      velocity: {
        x: velocityX,
        y: -0.14 - pseudoRandom(seedBase + index * 127) * 0.12,
        z: velocityZ,
      },
      angularVelocity: {
        x: 4.4 + pseudoRandom(seedBase + index * 131) * 2.0,
        y: 3.7 + pseudoRandom(seedBase + index * 137) * 1.5,
        z: 4.4 + pseudoRandom(seedBase + index * 139) * 2.0,
      },
      final: {
        x: px,
        y: 0.42,
        z: pz,
        yaw: Math.floor(pseudoRandom(seedBase + index * 149 + value * 17) * 4) * (Math.PI / 2),
      },
      rollingQuaternionSeed: seedBase + index * 151,
      settlePhase: pseudoRandom(seedBase + index * 157) * Math.PI * 2,
    };
  });

  return {
    diceSeed: seedBase,
    startedAtMs: Date.now(),
    durationMs: YACHT_ROLL_ANIMATION_MS,
    dice: diceEntries,
  };
}

function assignYachtRanks(players) {
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

function applyYachtPostScoreUpdate(transaction, roomRef, players, seat) {
  const everyoneFinished = players.every((item) => isYachtScoreSheetComplete(item.scoreSheet));
  if (everyoneFinished) {
    transaction.update(roomRef, {
      players: assignYachtRanks(players),
      status: YACHT_ROOM_STATUS_FINISHED,
      actionPhase: YACHT_PHASE_FINISHED,
      rollCount: 0,
      heldDice: [false, false, false, false, false],
      actionDeadlineAtMs: 0,
      rollResolveAtMs: 0,
      diceMotion: null,
      visualDiceState: null,
      updatedAt: FieldValue.serverTimestamp(),
      updatedAtMs: Date.now(),
    });
    return;
  }

  transaction.update(roomRef, {
    players,
    currentTurnSeat: findNextYachtSeat(players, seat),
    actionPhase: YACHT_PHASE_AWAITING_ROLL,
    rollCount: 0,
    dice: [1, 1, 1, 1, 1],
    heldDice: [false, false, false, false, false],
    diceSeed: Date.now(),
    actionDeadlineAtMs: Date.now() + YACHT_TURN_LIMIT_MS,
    rollResolveAtMs: 0,
    diceMotion: null,
    visualDiceState: null,
    updatedAt: FieldValue.serverTimestamp(),
    updatedAtMs: Date.now(),
  });
}

async function processStaleYachtRooms() {
  const snapshot = await db
    .collection("yacht-rooms")
    .where("status", "==", YACHT_ROOM_STATUS_PLAYING)
    .limit(50)
    .get();

  for (const docSnapshot of snapshot.docs) {
    await db.runTransaction(async (transaction) => {
      const freshSnapshot = await transaction.get(docSnapshot.ref);
      if (!freshSnapshot.exists) return;
      applyYachtScheduledAdvance(transaction, freshSnapshot.ref, freshSnapshot.data(), Date.now());
    });
  }
}

function applyYachtScheduledAdvance(transaction, roomRef, room, now) {
  if (String(room.status || "") !== YACHT_ROOM_STATUS_PLAYING) return;

  const lastUpdatedAtMs = Number(room.updatedAtMs || 0);
  const players = [...(Array.isArray(room.players) ? room.players : [])];
  if (!players.length) return;

  if (lastUpdatedAtMs && now - lastUpdatedAtMs >= YACHT_STALE_FINISH_MS) {
    transaction.update(roomRef, {
      players: assignYachtRanks(players.map((player) => finalizeYachtPlayer(player))),
      status: YACHT_ROOM_STATUS_FINISHED,
      actionPhase: YACHT_PHASE_FINISHED,
      rollCount: 0,
      heldDice: [false, false, false, false, false],
      actionDeadlineAtMs: 0,
      rollResolveAtMs: 0,
      diceMotion: null,
      visualDiceState: null,
      updatedAt: FieldValue.serverTimestamp(),
      updatedAtMs: now,
    });
    return;
  }

  if (String(room.actionPhase || "") === YACHT_PHASE_ROLLING && Number(room.rollResolveAtMs || 0) <= now) {
    transaction.update(roomRef, {
      actionPhase: YACHT_PHASE_AWAITING_ROLL,
      actionDeadlineAtMs: now + YACHT_TURN_LIMIT_MS,
      rollResolveAtMs: 0,
      updatedAt: FieldValue.serverTimestamp(),
      updatedAtMs: now,
    });
    return;
  }

  if (
    String(room.actionPhase || "") !== YACHT_PHASE_AWAITING_ROLL ||
    Number(room.actionDeadlineAtMs || 0) > now
  ) {
    return;
  }

  let dice = normalizeYachtDice(room.dice);
  const heldDice = normalizeYachtHeldDice(room.heldDice);
  let rollCount = Number(room.rollCount || 0);
  while (rollCount < 3) {
    rollCount += 1;
    const seed = now + rollCount;
    const rolledDice = buildYachtRolledDice(seed, rollCount);
    dice = dice.map((value, index) => (heldDice[index] ? value : rolledDice[index]));
  }

  const seat = Number(room.currentTurnSeat || 0);
  const player = players[seat];
  if (!player) return;
  const bestCategoryId = pickBestYachtScoreCategory(player.scoreSheet, dice);
  if (!bestCategoryId) return;

  const scoreSheet = {
    ...(player.scoreSheet || createEmptyYachtScoreSheet()),
    [bestCategoryId]: {
      score: calculateYachtCategoryScore(bestCategoryId, dice),
      locked: true,
    },
  };
  players[seat] = finalizeYachtPlayer({ ...player, scoreSheet });
  applyYachtPostScoreUpdate(transaction, roomRef, players, seat);
}

function applyYachtLeaveRoom(transaction, snapshot, uid) {
  const room = snapshot.data();
  let players = (Array.isArray(room.players) ? room.players : []).filter(
    (player) => String(player.uid || "") !== String(uid || "")
  );
  const spectators = (Array.isArray(room.spectators) ? room.spectators : []).filter(
    (spectator) => String(spectator.uid || "") !== String(uid || "")
  );

  if (players.length === 0) {
    transaction.delete(snapshot.ref);
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
      String(room.status || "") === YACHT_ROOM_STATUS_PLAYING &&
      !players.some(
        (player) => String(player.uid || "") === String(getCurrentYachtTurnPlayer(room)?.uid || "")
      )
    ) {
      nextTurnSeat = findNextYachtSeat(players, Math.max(0, nextTurnSeat - 1));
    }
  }

  if (String(room.status || "") === YACHT_ROOM_STATUS_WAITING) {
    players = players.map((player) =>
      String(player.uid || "") === nextOwnerUid ? { ...player, isReady: false } : player
    );
  }

  transaction.update(snapshot.ref, {
    ownerUid: nextOwnerUid,
    players,
    spectators,
    currentTurnSeat: players.length ? nextTurnSeat : 0,
    updatedAt: FieldValue.serverTimestamp(),
    updatedAtMs: Date.now(),
  });
}

function pseudoRandom(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function hashYachtString(value) {
  return String(value || "").split("").reduce((hash, char) => {
    return (hash * 31 + char.charCodeAt(0)) % 1000003;
  }, 17);
}

function buildNoticeId(title, date) {
  const pad = (value) => String(value).padStart(2, "0");
  const prefix = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate()), pad(date.getHours()), pad(date.getMinutes())].join("");
  const safeTitle = String(title || "notice")
    .trim()
    .replace(/[\\/#?[\]]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 40);
  return `${prefix}_${safeTitle}`;
}

function serialize(data) {
  return JSON.parse(JSON.stringify(data));
}

function normalizeItemCategory(category) {
  const normalizedCategory = String(category || "").trim() || "기타 아이템";
  const categoryMap = new Map([
    ["권한", "소모품"],
    ["광물", "화폐"],
    ["기타", "기타 아이템"],
    ["기타 아이템", "기타 아이템"],
    ["꽃&식물", "생물"],
    ["몬스터 잔해", "기타 아이템"],
    ["무기", "기타 아이템"],
    ["물약", "소모품"],
    ["배지", "치장 아이템"],
    ["상자", "소모품"],
    ["생물", "생물"],
    ["스킬", "기타 아이템"],
    ["클래스", "기타 아이템"],
    ["스킬,클래스", "기타 아이템"],
    ["시스템", "기타 아이템"],
    ["시즈널 이벤트", "기타 아이템"],
    ["소모품", "소모품"],
    ["악세서리", "치장 아이템"],
    ["음식", "음식"],
    ["의상", "치장 아이템"],
    ["치장 아이템", "치장 아이템"],
    ["프로필 꾸미기", "프로필 꾸미기"],
    ["화폐", "화폐"],
  ]);
  return categoryMap.get(normalizedCategory) || "기타 아이템";
}

function buildInventoryItemFromDefinition(item) {
  return normalizeSystemInventoryItem({
    itemId: item.id || "",
    name: String(item.name || item.id || "아이템").trim(),
    description: String(item.description || "").trim(),
    shortLabel: String(item.shortLabel || item.name || "지급 아이템").trim(),
    icon: String(item.icon || "🎁").trim(),
    spriteKey: String(item.spriteKey || "").trim(),
    colorPreset: String(item.colorPreset || "").trim(),
    category: normalizeItemCategory(item.category),
    foodCurrencyReward: Math.max(0, Math.floor(Number(item.foodCurrencyReward || 0))),
    grantedAt: new Date().toISOString(),
  });
}

function buildInventoryItemKey(item) {
  return [item?.itemId || item?.name || "item", item?.grantedAt || "", item?.name || ""].join("::");
}

function normalizeSystemItemName(name) {
  const normalized = String(name || "").trim();
  if (["포장지", "택배상자", "택배 상자"].includes(normalized)) return "택배 상자";
  if (["거절권", "폐기 승인서"].includes(normalized)) return "폐기 승인서";
  return normalized;
}

function isSafeItem(item) {
  return normalizeSystemItemName(item?.name) === "금고";
}

function normalizeStoredInventoryItem(item) {
  if (!item || typeof item !== "object") return null;
  return normalizeSystemInventoryItem({
    itemId: String(item.itemId || "").trim(),
    name: String(item.name || item.itemId || "아이템").trim(),
    description: String(item.description || "").trim(),
    shortLabel: String(item.shortLabel || item.name || "보관 아이템").trim(),
    icon: String(item.icon || "🎁").trim(),
    spriteKey: String(item.spriteKey || "").trim(),
    colorPreset: String(item.colorPreset || "").trim(),
    category: normalizeItemCategory(item.category),
    foodCurrencyReward: Math.max(0, Math.floor(Number(item.foodCurrencyReward || 0))),
    grantedAt: String(item.grantedAt || new Date().toISOString()).trim(),
  });
}

function mapNestedStoredItem(item, mapper) {
  if (!item || typeof item !== "object" || !item.storedItem || typeof mapper !== "function") {
    return item;
  }
  const nextStoredItem = mapper(item.storedItem);
  if (nextStoredItem === item.storedItem) {
    return item;
  }
  if (!nextStoredItem) {
    const nextItem = { ...item };
    delete nextItem.storedItem;
    return nextItem;
  }
  return {
    ...item,
    storedItem: nextStoredItem,
  };
}

function buildItemMatchNames(...names) {
  return new Set(names.map((name) => normalizeSystemItemName(name)).filter(Boolean));
}

function itemMatchesDefinition(item, itemId, names = new Set()) {
  const normalizedItemId = String(itemId || "").trim();
  const normalizedNames = names instanceof Set ? names : buildItemMatchNames(...[].concat(names || []));
  const candidateId = String(item?.itemId || "").trim();
  const candidateName = normalizeSystemItemName(item?.name);
  return Boolean(
    (normalizedItemId && candidateId === normalizedItemId) ||
      (candidateName && normalizedNames.has(candidateName))
  );
}

function normalizeSystemInventoryItem(item) {
  if (!item || typeof item !== "object") return item;
  const name = normalizeSystemItemName(item.name);
  const nextItem = { ...item, name };
  if (name === "택배 상자") {
    nextItem.shortLabel = "택배 상자";
    nextItem.description =
      nextItem.description && !String(nextItem.description).includes("내용물을 숨겨")
        ? nextItem.description
        : "소포의 내용물을 숨겨서 보낼 때 사용하는 시스템 물품입니다.";
  }
  if (name === "폐기 승인서") {
    nextItem.shortLabel = "폐기 승인서";
    nextItem.description =
      nextItem.description && !String(nextItem.description).includes("거절")
        ? nextItem.description
        : "택배 상자로 온 소포를 거절할 때 사용하는 시스템 물품입니다.";
  }
  return nextItem;
}

function isNamedSystemItem(item, names) {
  const itemName = normalizeSystemItemName(item?.name);
  const itemId = String(item?.itemId || "").replace(/\s+/g, "").toLowerCase();
  return names.has(itemName) || (names.has("택배 상자") && itemId.includes("택배")) || (names.has("폐기 승인서") && itemId.includes("거절"));
}

function isDeliveryBoxItem(item) {
  return isNamedSystemItem(item, new Set(["택배 상자"]));
}

function isDisposalPermitItem(item) {
  return isNamedSystemItem(item, new Set(["폐기 승인서"]));
}

function isHammerItem(item) {
  return normalizeSystemItemName(item?.name) === "망치" || String(item?.itemId || "").toLowerCase().includes("hammer");
}

function buildItemId(name) {
  return (
    String(name || "item")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-_가-힣]/g, "")
      .slice(0, 50) || `item-${Date.now()}`
  );
}

async function findUserSnapshotByUid(uid) {
  const legacySnapshot = await db.collection("users").doc(uid).get();
  const profileQuery = await db.collection("users").where("uid", "==", uid).limit(1).get();
  if (!profileQuery.empty) {
    const preferredSnapshot = profileQuery.docs[0];
    if (
      legacySnapshot.exists &&
      legacySnapshot.id !== preferredSnapshot.id &&
      String(legacySnapshot.data()?.uid || "").trim() === String(uid || "").trim()
    ) {
      await legacySnapshot.ref.delete().catch(() => null);
    }
    return preferredSnapshot;
  }

  if (legacySnapshot.exists) {
    return legacySnapshot;
  }

  return null;
}

async function findActiveYachtRoomForUid(uid) {
  const safeUid = String(uid || "");
  if (!safeUid) return null;

  const snapshot = await db
    .collection("yacht-rooms")
    .where("status", "in", [YACHT_ROOM_STATUS_WAITING, YACHT_ROOM_STATUS_PLAYING])
    .orderBy("updatedAtMs", "desc")
    .limit(100)
    .get();

  for (const roomDoc of snapshot.docs) {
    const room = roomDoc.data();
    const players = Array.isArray(room.players) ? room.players : [];
    if (players.some((player) => String(player.uid || "") === safeUid)) {
      return { roomId: roomDoc.id, role: "player" };
    }

    const spectators = Array.isArray(room.spectators) ? room.spectators : [];
    if (spectators.some((spectator) => String(spectator.uid || "") === safeUid)) {
      return { roomId: roomDoc.id, role: "spectator" };
    }
  }

  return null;
}

async function findUserSnapshotByCharacterName(characterName) {
  const snapshot = await db.collection("users").doc(characterName).get();
  if (!snapshot.exists) {
    return null;
  }

  return snapshot;
}



