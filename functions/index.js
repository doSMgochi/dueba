const { onCall, HttpsError, onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
setGlobalOptions({ region: "asia-northeast3", maxInstances: 10 });

const db = getFirestore();

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
    description: "아이템이나 선물을 감싸는 꾸미기 소모품",
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
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication is required.");
  }

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
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication is required.");
  }

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
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication is required.");
  }

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

    selectedTraitIds.push(traitId);
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

exports.spinRoulette = onRequest(async (_req, res) => {
  res.status(410).json({
    error: "Roulette reward grant is disabled. The frontend logs roulette results directly.",
  });
});

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
