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

const defaultShopItems = [
  {
    id: "special-table-ticket",
    name: "특수작탁개설권",
    description: "특수 룰의 작탁을 개설할 수 있는 권한 아이템.",
    price: 1500,
    sortOrder: 1,
  },
  {
    id: "duel-ticket",
    name: "결투권",
    description: "지정 대상과 결투 매치를 생성하는 입장권.",
    price: 900,
    sortOrder: 2,
  },
  {
    id: "wrapping-paper",
    name: "포장지",
    description: "소포 발송 때 사용할 수 있는 포장 아이템.",
    price: 120,
    sortOrder: 3,
  },
];

const defaultItemDatabase = [
  {
    id: "special-table-ticket",
    name: "특수작탁개설권",
    description: "특수 룰의 작탁을 개설할 수 있는 권한 아이템.",
    shortLabel: "작탁 개설",
    icon: "🎫",
    category: "권한",
    sortOrder: 1,
  },
  {
    id: "duel-ticket",
    name: "결투권",
    description: "지정 대상과 결투 매치를 생성하는 입장권.",
    shortLabel: "결투 개시",
    icon: "⚔️",
    category: "권한",
    sortOrder: 2,
  },
  {
    id: "wrapping-paper",
    name: "포장지",
    description: "소포 내용을 숨기는 포장 아이템.",
    shortLabel: "내용물 숨김",
    icon: "🎁",
    category: "소모품",
    sortOrder: 3,
  },
];

const defaultTraits = [
  { id: "pinfu-win", name: "핑후로 화료", successPoints: 5, failPoints: 3, requiredPoints: 10, sortOrder: 1 },
  { id: "wait-36-win", name: "36통 대기로 화료", successPoints: 10, failPoints: 5, requiredPoints: 2, sortOrder: 2 },
  { id: "kokushi-win", name: "국사무쌍으로 화료", successPoints: 20, failPoints: 5, requiredPoints: 1, sortOrder: 3 },
  { id: "hidden-trait", name: "특성 비공개", successPoints: 0, failPoints: 0, requiredPoints: 10, sortOrder: 4 },
];
exports.ensureUserProfile = onCall(async (request) => {
  assertAuthenticated(request);
  const { loginId, nickname, characterName } = request.data || {};
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
      role: "user",
      rankingPoints: 0,
      selectedTraitIds: [],
      availableTraitPoints: 12,
      dismissedAnnouncementIds: [],
      inventory: [],
      currency: 300,
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { ok: true };
});

exports.validateSignupProfile = onCall(async (request) => {
  const { loginId, email, characterName } = request.data || {};
  const normalizedLoginId = String(loginId || "").trim().toLowerCase();
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedCharacterName = String(characterName || "").trim();

  if (!normalizedLoginId || !normalizedEmail || !normalizedCharacterName) {
    throw new HttpsError("invalid-argument", "아이디, 이메일, 캐릭터 이름을 모두 입력해 주세요.");
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

  const rankings = userSnapshot.docs
    .map((item) => {
      const data = item.data();
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
    category = "기타",
    price = 0,
  } = request.data || {};

  const normalizedName = String(name || "").trim();
  if (!normalizedName) {
    throw new HttpsError("invalid-argument", "Item name is required.");
  }

  const itemId = buildItemId(normalizedName);
  const normalizedPrice = Math.max(0, Number(price || 0));

  await Promise.all([
    db.collection("item-db").doc(itemId).set(
      {
        name: normalizedName,
        description: String(description || "").trim(),
        shortLabel: String(shortLabel || normalizedName).trim(),
        icon: String(icon || "🎁").trim(),
        category: String(category || "기타").trim(),
        sortOrder: Date.now(),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    ),
    db.collection("shop").doc(itemId).set(
      {
        name: normalizedName,
        description: String(description || "").trim(),
        price: normalizedPrice,
        sortOrder: Date.now(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    ),
  ]);

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
    category = "기타",
    price = 0,
  } = request.data || {};

  const normalizedItemId = String(itemId || "").trim();
  const normalizedName = String(name || "").trim();
  if (!normalizedItemId || !normalizedName) {
    throw new HttpsError("invalid-argument", "Item id and name are required.");
  }

  const itemRef = db.collection("item-db").doc(normalizedItemId);
  const itemSnapshot = await itemRef.get();
  if (!itemSnapshot.exists) {
    throw new HttpsError("not-found", "Item definition was not found.");
  }

  const normalizedPrice = Math.max(0, Number(price || 0));
  await Promise.all([
    itemRef.update({
      name: normalizedName,
      description: String(description || "").trim(),
      shortLabel: String(shortLabel || normalizedName).trim(),
      icon: String(icon || "🎁").trim(),
      category: String(category || "기타").trim(),
      updatedAt: FieldValue.serverTimestamp(),
    }),
    db.collection("shop").doc(normalizedItemId).set(
      {
        name: normalizedName,
        description: String(description || "").trim(),
        price: normalizedPrice,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    ),
  ]);

  const usersSnapshot = await db.collection("users").get();
  await Promise.all(
    usersSnapshot.docs.map(async (userDoc) => {
      const data = userDoc.data();
      const inventory = Array.isArray(data.inventory) ? [...data.inventory] : [];
      let touched = false;

      const nextInventory = inventory.map((inventoryItem) => {
        if (String(inventoryItem?.itemId || "") !== normalizedItemId) {
          return inventoryItem;
        }

        touched = true;
        return {
          ...inventoryItem,
          name: normalizedName,
          description: String(description || "").trim(),
          shortLabel: String(shortLabel || normalizedName).trim(),
          icon: String(icon || "🎁").trim(),
          category: String(category || "기타").trim(),
        };
      });

      if (!touched) {
        return null;
      }

      return userDoc.ref.update({
        inventory: nextInventory,
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

  await Promise.all([
    db.collection("item-db").doc(normalizedItemId).delete(),
    db.collection("shop").doc(normalizedItemId).delete(),
  ]);

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

  const { targetCharacterName, itemKeys = [], currencyAmount = 0, useWrapping = false } = request.data || {};
  const receiverCharacterName = String(targetCharacterName || "").trim();
  const normalizedItemKeys = Array.isArray(itemKeys)
    ? itemKeys.map((itemKey) => String(itemKey || "").trim()).filter(Boolean)
    : [];
  const numericCurrencyAmount = Math.max(0, Number(currencyAmount || 0));
  const wantsWrapping = Boolean(useWrapping);

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
      giftedItems.push(inventory.splice(itemIndex, 1)[0]);
    }

    if (wantsWrapping) {
      const wrappingIndex = inventory.findIndex((item) => item?.name === "포장지");
      if (wrappingIndex === -1) {
        throw new HttpsError("failed-precondition", "포장지를 사용하려면 인벤토리에 포장지가 있어야 합니다.");
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
      wrapped: wantsWrapping,
      canReject: true,
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
      autoAcceptAfterMs: Date.now() + 24 * 60 * 60 * 1000,
      updatedAt: FieldValue.serverTimestamp(),
    });
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
          ? "포장된 소포가 도착했습니다."
          : buildParcelPreview({
              itemNames: giftedItems.map((item) => item?.name).filter(Boolean),
              currencyAmount: numericCurrencyAmount,
            }),
      },
    });

  return { ok: true, parcelId: parcelRef.id };
});
exports.respondParcel = onCall(async (request) => {
  assertAuthenticated(request);
  const parcelId = String(request.data?.parcelId || "").trim();
  const action = String(request.data?.action || "").trim();

  if (!parcelId || !["accept", "reject"].includes(action)) {
    throw new HttpsError("invalid-argument", "?뚰룷 泥섎━ 諛⑹떇???щ컮瑜댁? ?딆뒿?덈떎.");
  }

  const parcelRef = db.collection("parcels").doc(parcelId);
  const parcelSnapshot = await parcelRef.get();
  if (!parcelSnapshot.exists) {
    throw new HttpsError("not-found", "????뚰룷瑜?李얠? 紐삵뻽?듬땲??");
  }

  const parcel = parcelSnapshot.data();
  if (parcel.receiverUid !== request.auth.uid) {
    throw new HttpsError("permission-denied", "???뚰룷瑜?泥섎━??沅뚰븳???놁뒿?덈떎.");
  }
  if (parcel.status !== "pending") {
    throw new HttpsError("failed-precondition", "?대? 泥섎━???뚰룷?쇱꽌 ?ㅼ떆 ?좏깮?????놁뒿?덈떎.");
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

  if (Array.isArray(useConfig.requiredFields) && useConfig.requiredFields.length) {
    const missingField = useConfig.requiredFields.find((field) => !String(extraData?.[field] || "").trim());
    if (missingField) {
      throw new HttpsError("invalid-argument", `추가 입력값 '${missingField}' 이 필요합니다.`);
    }
  }

  inventory.splice(itemIndex, 1);
  await userSnapshot.ref.update({
    inventory,
    updatedAt: FieldValue.serverTimestamp(),
  });

  const receiptCode = `[${String(request.auth.uid || "UID").slice(0, 6).toUpperCase()}-${Math.random()
    .toString(36)
    .slice(2, 8)
    .toUpperCase()}]`;
  const effectDescription = String(
    itemDefinition?.useEffectDescription ||
      itemDefinition?.description ||
      usedItem.description ||
      "아이템 효과 설명은 아직 등록되지 않았습니다."
  ).trim();

  return {
    ok: true,
    item: serialize(usedItem),
    receiptCode,
    effectDescription,
    useConfig: serialize(useConfig),
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

exports.spinRoulette = onRequest(async (_req, res) => {
  res.status(410).json({
    error: "Roulette reward grant is disabled. The frontend logs roulette results directly.",
  });
});

exports.autoAcceptExpiredParcels = onSchedule("every 15 minutes", async () => {
  await processAllExpiredParcels();
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

  for (const item of defaultShopItems) {
    const ref = db.collection("shop").doc(item.id);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      writes.push(ref.set(item));
    }
  }

  for (const trait of defaultTraits) {
    const ref = db.collection("traits").doc(trait.id);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      writes.push(ref.set(trait));
    }
  }

  for (const item of defaultItemDatabase) {
    const ref = db.collection("item-db").doc(item.id);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      writes.push(ref.set(item));
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

    if (action === "reject" && currentParcel.wrapped) {
      const rejectTicketIndex = receiverInventory.findIndex((item) => item?.name === "거절권");
      if (rejectTicketIndex === -1) {
        throw new HttpsError("failed-precondition", "?ъ옣 ?뚰룷瑜?嫄곗젅?섎젮硫?嫄곗젅沅뚯씠 ?꾩슂?⑸땲??");
      }
      receiverInventory.splice(rejectTicketIndex, 1);
    }

    if (action === "accept") {
      if (Array.isArray(currentParcel.items) && currentParcel.items.length) {
        receiverInventory.push(...currentParcel.items);
      } else if (currentParcel.item) {
        receiverInventory.push(currentParcel.item);
      }
      receiverCurrency += Number(currentParcel.currencyAmount || 0);
      transaction.update(receiverSnapshot.ref, {
        inventory: receiverInventory,
        currency: receiverCurrency,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      if (Array.isArray(currentParcel.items) && currentParcel.items.length) {
        senderInventory.push(...currentParcel.items);
      } else if (currentParcel.item) {
        senderInventory.push(currentParcel.item);
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

  await createNotification({
    targetUid: parcel.senderUid,
    targetCharacterName: parcel.senderCharacterName,
    type: action === "accept" ? "parcel-accepted" : "parcel-rejected",
    message:
      action === "accept"
        ? automatic
          ? `${parcel.receiverCharacterName}님의 소포가 1일 경과로 자동 수락되었습니다.`
          : `${parcel.receiverCharacterName}님이 소포를 수락했습니다.`
        : `${parcel.receiverCharacterName}님이 소포를 거절했습니다.`,
    payload: { parcelId, automatic: Boolean(automatic) },
  });

  if (action === "accept" && automatic) {
    await createNotification({
      targetUid: parcel.receiverUid,
      targetCharacterName: parcel.receiverCharacterName,
      type: "parcel-auto-accepted",
      message: `${parcel.senderCharacterName}님의 소포가 1일 경과로 자동 수락되었습니다.`,
      payload: { parcelId },
    });
  }
}

function buildParcelPreview({ itemName, itemNames = [], currencyAmount }) {
  const parts = [];
  if (Array.isArray(itemNames) && itemNames.length) {
    parts.push(`아이템 ${itemNames.join(", ")}`);
  } else if (itemName) {
    parts.push(`?꾩씠??${String(itemName).trim()}`);
  }
  if (Number(currencyAmount || 0) > 0) {
    parts.push(`환 ${Number(currencyAmount || 0)}`);
  }
  return parts.join(" / ") || "?뚰룷媛 ?꾩갑?덉뒿?덈떎.";
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

function buildInventoryItemFromDefinition(item) {
  return {
    itemId: item.id || "",
    name: String(item.name || item.id || "아이템").trim(),
    description: String(item.description || "").trim(),
    shortLabel: String(item.shortLabel || item.name || "지급 아이템").trim(),
    icon: String(item.icon || "🎁").trim(),
    category: String(item.category || "기타").trim(),
    grantedAt: new Date().toISOString(),
  };
}

function buildInventoryItemKey(item) {
  return [item?.itemId || item?.name || "item", item?.grantedAt || "", item?.name || ""].join("::");
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
  if (legacySnapshot.exists) {
    return legacySnapshot;
  }

  const profileQuery = await db.collection("users").where("uid", "==", uid).limit(1).get();
  if (!profileQuery.empty) {
    return profileQuery.docs[0];
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



