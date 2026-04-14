const { onCall, HttpsError, onRequest } = require("firebase-functions/v2/https");
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
    description: "특수 룰의 작탁을 개설할 수 있는 권한 아이템",
    price: 1500,
    sortOrder: 1,
  },
  {
    id: "duel-ticket",
    name: "결투권",
    description: "지정 대상과 결투 매치를 생성하는 입장권",
    price: 900,
    sortOrder: 2,
  },
  {
    id: "wrapping-paper",
    name: "포장지",
    description: "소포 발송 시 사용하며, 포장된 소포는 거절할 수 없습니다.",
    price: 120,
    sortOrder: 3,
  },
];

const defaultTraits = [
  {
    id: "pinfu-win",
    name: "핑후로 화료",
    successPoints: 5,
    failPoints: 3,
    requiredPoints: 10,
    sortOrder: 1,
  },
  {
    id: "wait-36-win",
    name: "36통 대기로 화료",
    successPoints: 10,
    failPoints: 5,
    requiredPoints: 2,
    sortOrder: 2,
  },
  {
    id: "kokushi-win",
    name: "국사무쌍으로 화료",
    successPoints: 20,
    failPoints: 5,
    requiredPoints: 1,
    sortOrder: 3,
  },
  {
    id: "hidden-trait",
    name: "특성 비공개",
    successPoints: 0,
    failPoints: 0,
    requiredPoints: 10,
    sortOrder: 4,
  },
];

exports.ensureUserProfile = onCall(async (request) => {
  assertAuthenticated(request);

  const { loginId, nickname, characterName } = request.data || {};
  validateProfileInput({ loginId, nickname, characterName });
  await ensureGlobalGameData();

  const uid = request.auth.uid;
  const normalizedCharacterName = String(characterName).trim();
  const userRef = db.collection("users").doc(normalizedCharacterName);
  const duplicateLoginIdSnapshot = await db
    .collection("users")
    .where("loginId", "==", loginId)
    .limit(1)
    .get();

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
      nickname,
      characterName: normalizedCharacterName,
      role: "user",
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

exports.getDashboardData = onCall(async (request) => {
  assertAuthenticated(request);
  await ensureGlobalGameData();

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
    addItemName = "",
    addItemDescription = "",
    setRole = "",
  } = request.data || {};

  const normalizedCharacterName = String(targetCharacterName || "").trim();
  if (!normalizedCharacterName) {
    throw new HttpsError("invalid-argument", "Target character name is required.");
  }

  const targetSnapshot = await findUserSnapshotByCharacterName(normalizedCharacterName);
  if (!targetSnapshot) {
    throw new HttpsError("not-found", "Target user was not found.");
  }

  const data = targetSnapshot.data();
  const inventory = Array.isArray(data.inventory) ? [...data.inventory] : [];
  const numericCurrencyDelta = Number(currencyDelta || 0);
  const numericTraitPointDelta = Number(traitPointDelta || 0);
  const nextRole = String(setRole || "").trim();
  const nextCurrency = Math.max(0, Number(data.currency || 0) + numericCurrencyDelta);
  const nextTraitPoints = Math.max(
    0,
    Number(data.availableTraitPoints || 0) + numericTraitPointDelta
  );

  if (addItemName) {
    inventory.push({
      name: String(addItemName).trim(),
      description: String(addItemDescription || "").trim() || "운영진 지급 아이템",
      shortLabel: "운영진 지급",
      grantedAt: new Date().toISOString(),
    });
  }

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
  await createNotification({
    targetUid: data.uid,
    targetCharacterName: data.characterName,
    type: "admin-update",
    message: `${adminProfile.characterName}님이 운영진 조정을 적용했습니다.`,
    payload: {
      currencyDelta: numericCurrencyDelta,
      traitPointDelta: numericTraitPointDelta,
      addedItemName: addItemName || "",
      setRole: nextRole || "",
    },
  });

  return {
    ok: true,
    target: normalizedCharacterName,
  };
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

  return {
    ok: true,
    deletedCharacterName: characterName,
  };
});

exports.createAnnouncement = onCall(async (request) => {
  assertAuthenticated(request);
  const adminProfile = await assertAdmin(request.auth.uid);
  const title = String(request.data?.title || "").trim();
  const body = String(request.data?.body || "").trim();

  if (title.length < 2 || body.length < 2) {
    throw new HttpsError("invalid-argument", "Announcement title and body are required.");
  }

  const docRef = await db.collection("announcements").add({
    title,
    body,
    active: true,
    createdByUid: adminProfile.uid,
    createdByCharacterName: adminProfile.characterName,
    createdAt: FieldValue.serverTimestamp(),
  });

  return {
    ok: true,
    announcementId: docRef.id,
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
    throw new HttpsError("not-found", "Profile does not exist.");
  }

  const {
    targetCharacterName,
    itemName = "",
    itemDescription = "",
    currencyAmount = 0,
    useWrapping = false,
  } = request.data || {};

  const receiverCharacterName = String(targetCharacterName || "").trim();
  const giftItemName = String(itemName || "").trim();
  const giftItemDescription = String(itemDescription || "").trim();
  const numericCurrencyAmount = Math.max(0, Number(currencyAmount || 0));
  const wantsWrapping = Boolean(useWrapping);

  if (!receiverCharacterName) {
    throw new HttpsError("invalid-argument", "Receiver character name is required.");
  }

  if (!giftItemName && numericCurrencyAmount <= 0) {
    throw new HttpsError("invalid-argument", "You must include an item or currency.");
  }

  const receiverSnapshot = await findUserSnapshotByCharacterName(receiverCharacterName);
  if (!receiverSnapshot) {
    throw new HttpsError("not-found", "Receiver was not found.");
  }

  const senderData = senderSnapshot.data();
  const receiverData = receiverSnapshot.data();

  if (senderData.uid === receiverData.uid) {
    throw new HttpsError("invalid-argument", "You cannot send a parcel to yourself.");
  }

  const parcelRef = db.collection("parcels").doc();

  await db.runTransaction(async (transaction) => {
    const currentSenderSnapshot = await transaction.get(senderSnapshot.ref);
    if (!currentSenderSnapshot.exists) {
      throw new HttpsError("not-found", "Sender profile does not exist.");
    }

    const currentSenderData = currentSenderSnapshot.data();
    const inventory = Array.isArray(currentSenderData.inventory)
      ? [...currentSenderData.inventory]
      : [];
    const currentCurrency = Number(currentSenderData.currency || 0);

    if (numericCurrencyAmount > currentCurrency) {
      throw new HttpsError("failed-precondition", "Not enough currency.");
    }

    let giftedItem = null;
    if (giftItemName) {
      const itemIndex = inventory.findIndex((item) => item?.name === giftItemName);
      if (itemIndex === -1) {
        throw new HttpsError("failed-precondition", "The item is not in your inventory.");
      }

      giftedItem = inventory.splice(itemIndex, 1)[0];
      if (giftItemDescription && !giftedItem.description) {
        giftedItem.description = giftItemDescription;
      }
    }

    if (wantsWrapping) {
      const wrappingIndex = inventory.findIndex((item) => item?.name === "포장지");
      if (wrappingIndex === -1) {
        throw new HttpsError("failed-precondition", "포장지가 필요합니다.");
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
      item: giftedItem,
      currencyAmount: numericCurrencyAmount,
      wrapped: wantsWrapping,
      canReject: !wantsWrapping,
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
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
    },
  });

  return {
    ok: true,
    parcelId: parcelRef.id,
  };
});

exports.respondParcel = onCall(async (request) => {
  assertAuthenticated(request);
  const parcelId = String(request.data?.parcelId || "").trim();
  const action = String(request.data?.action || "").trim();

  if (!parcelId || !["accept", "reject"].includes(action)) {
    throw new HttpsError("invalid-argument", "A valid parcel action is required.");
  }

  const parcelRef = db.collection("parcels").doc(parcelId);
  const parcelSnapshot = await parcelRef.get();
  if (!parcelSnapshot.exists) {
    throw new HttpsError("not-found", "Parcel was not found.");
  }

  const parcel = parcelSnapshot.data();
  if (parcel.receiverUid !== request.auth.uid) {
    throw new HttpsError("permission-denied", "You cannot access this parcel.");
  }

  if (parcel.status !== "pending") {
    throw new HttpsError("failed-precondition", "Parcel is already closed.");
  }

  if (action === "reject" && parcel.wrapped) {
    throw new HttpsError("failed-precondition", "Wrapped parcels cannot be rejected.");
  }

  const senderSnapshot = await findUserSnapshotByUid(parcel.senderUid);
  const receiverSnapshot = await findUserSnapshotByUid(parcel.receiverUid);
  if (!senderSnapshot || !receiverSnapshot) {
    throw new HttpsError("not-found", "Sender or receiver profile was not found.");
  }

  await db.runTransaction(async (transaction) => {
    const [currentSenderSnapshot, currentReceiverSnapshot, currentParcelSnapshot] =
      await Promise.all([
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
    const receiverInventory = Array.isArray(receiverData.inventory)
      ? [...receiverData.inventory]
      : [];
    let senderCurrency = Number(senderData.currency || 0);
    let receiverCurrency = Number(receiverData.currency || 0);

    if (action === "accept") {
      if (currentParcel.item) {
        receiverInventory.push(currentParcel.item);
      }
      receiverCurrency += Number(currentParcel.currencyAmount || 0);
      transaction.update(receiverSnapshot.ref, {
        inventory: receiverInventory,
        currency: receiverCurrency,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      if (currentParcel.item) {
        senderInventory.push(currentParcel.item);
      }
      senderCurrency += Number(currentParcel.currencyAmount || 0);
      transaction.update(senderSnapshot.ref, {
        inventory: senderInventory,
        currency: senderCurrency,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    transaction.update(parcelRef, {
      status: action === "accept" ? "accepted" : "rejected",
      respondedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  await createNotification({
    targetUid: parcel.senderUid,
    targetCharacterName: parcel.senderCharacterName,
    type: action === "accept" ? "parcel-accepted" : "parcel-rejected",
    message:
      action === "accept"
        ? `${parcel.receiverCharacterName}님이 소포를 수령했습니다.`
        : `${parcel.receiverCharacterName}님이 소포를 거절했습니다.`,
    payload: {
      parcelId,
    },
  });

  return {
    ok: true,
    action,
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

  if (writes.length) {
    await Promise.all(writes);
  }
}

function validateProfileInput({ loginId, nickname, characterName }) {
  const idPattern = /^[a-z0-9_]{4,20}$/;

  if (!idPattern.test(String(loginId || ""))) {
    throw new HttpsError(
      "invalid-argument",
      "Login ID must use lowercase letters, numbers, or underscore."
    );
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

async function createNotification({
  targetUid,
  targetCharacterName,
  type,
  message,
  payload = {},
}) {
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

function serialize(data) {
  return JSON.parse(JSON.stringify(data));
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
