import {
  EmailAuthProvider,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  reauthenticateWithCredential,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js";
import {
  arrayUnion,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-functions.js";
import { auth, db, functions } from "./firebase.js";

const selectTraitCallable = httpsCallable(functions, "selectTrait");
const getRankingBoardCallable = httpsCallable(functions, "getRankingBoard");
const adminManageUserCallable = httpsCallable(functions, "adminManageUser");
const adminDeleteUserCallable = httpsCallable(functions, "adminDeleteUser");
const createItemDefinitionCallable = httpsCallable(functions, "createItemDefinition");
const updateItemDefinitionCallable = httpsCallable(functions, "updateItemDefinition");
const deleteItemDefinitionCallable = httpsCallable(functions, "deleteItemDefinition");
const createAnnouncementCallable = httpsCallable(functions, "createAnnouncement");
const purchaseShopItemCallable = httpsCallable(functions, "purchaseShopItem");
const sendParcelCallable = httpsCallable(functions, "sendParcel");
const respondParcelCallable = httpsCallable(functions, "respondParcel");
const useInventoryItemCallable = httpsCallable(functions, "useInventoryItem");
const listAdminLogsCallable = httpsCallable(functions, "listAdminLogs");
const listBugReportsCallable = httpsCallable(functions, "listBugReports");

function normalizeLoginId(loginId) {
  return String(loginId || "").trim().toLowerCase();
}

function normalizeCharacterName(characterName) {
  return String(characterName || "").trim();
}

function toInternalEmail(loginId) {
  return `${normalizeLoginId(loginId)}@internal.app`;
}

function buildDefaultProfile({ uid, loginId, nickname, characterName }) {
  return {
    uid,
    loginId,
    nickname: String(nickname || "").trim(),
    characterName: normalizeCharacterName(characterName),
    role: "user",
    rankingPoints: 0,
    selectedTraitIds: [],
    availableTraitPoints: 12,
    dismissedAnnouncementIds: [],
    inventory: [],
    currency: 300,
    updatedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
  };
}

function buildBootstrapProfileFromUser(user) {
  const loginId = normalizeLoginId(user?.email?.split("@")[0] || user?.uid || "player");
  return buildDefaultProfile({
    uid: user.uid,
    loginId,
    nickname: loginId,
    characterName: loginId,
  });
}

function toFriendlyError(error) {
  const code = error?.code || "";
  const detailedFunctionCodes = new Set([
    "functions/invalid-argument",
    "functions/not-found",
    "functions/already-exists",
    "functions/failed-precondition",
    "functions/permission-denied",
  ]);
  const errorMap = {
    "auth/email-already-in-use": "이미 사용 중인 아이디입니다.",
    "auth/invalid-email": "아이디 형식이 올바르지 않습니다.",
    "auth/invalid-credential": "아이디 또는 비밀번호가 올바르지 않습니다.",
    "auth/missing-password": "비밀번호를 입력해 주세요.",
    "functions/not-found": "대상을 찾지 못했습니다.",
    "functions/invalid-argument": "입력값을 다시 확인해 주세요.",
    "functions/already-exists": "이미 존재하는 데이터입니다.",
    "functions/failed-precondition": "현재 상태에서는 처리할 수 없습니다.",
    "functions/permission-denied": "권한이 없습니다.",
    "permission-denied": "Firestore 권한 설정을 확인해 주세요.",
  };

  if (detailedFunctionCodes.has(code) && error?.message) {
    return new Error(error.message);
  }

  return new Error(errorMap[code] || error.message || "요청을 처리하는 중 오류가 발생했습니다.");
}

async function findUserProfileByUid(uid) {
  try {
    const legacySnapshot = await getDoc(doc(db, "users", uid));
    if (legacySnapshot.exists()) {
      return {
        id: legacySnapshot.id,
        data: legacySnapshot.data(),
      };
    }
  } catch (_error) {
    // Ignore permission failures for legacy doc ids and continue with uid query.
  }

  const profileQuery = query(collection(db, "users"), where("uid", "==", uid), limit(1));
  const profileSnapshot = await getDocs(profileQuery);

  if (!profileSnapshot.empty) {
    const matchedDoc = profileSnapshot.docs[0];
    return {
      id: matchedDoc.id,
      data: matchedDoc.data(),
    };
  }

  return null;
}

async function createProfileFallback(uid, payload) {
  const characterName = normalizeCharacterName(payload.characterName);
  await setDoc(
    doc(db, "users", characterName),
    buildDefaultProfile({
      uid,
      loginId: payload.loginId,
      nickname: payload.nickname,
      characterName,
    }),
    { merge: true }
  );
}

async function ensureBootstrapProfileForCurrentUser() {
  if (!auth.currentUser) {
    throw new Error("로그인된 유저가 없습니다.");
  }

  const existingProfile = await findUserProfileByUid(auth.currentUser.uid);
  if (existingProfile) {
    return {
      docId: existingProfile.id,
      ...existingProfile.data,
    };
  }

  const bootstrapProfile = buildBootstrapProfileFromUser(auth.currentUser);
  await setDoc(doc(db, "users", bootstrapProfile.characterName), bootstrapProfile, {
    merge: true,
  });

  return {
    docId: bootstrapProfile.characterName,
    ...bootstrapProfile,
  };
}

export async function signUpWithProfile({ loginId, nickname, characterName, password }) {
  const normalizedLoginId = normalizeLoginId(loginId);
  const normalizedCharacterName = normalizeCharacterName(characterName);
  const payload = {
    loginId: normalizedLoginId,
    nickname,
    characterName: normalizedCharacterName,
  };

  if (normalizedCharacterName.includes("/")) {
    throw new Error("캐릭터 이름에는 / 문자를 사용할 수 없습니다.");
  }

  try {
    const userCredential = await createUserWithEmailAndPassword(
      auth,
      toInternalEmail(normalizedLoginId),
      password
    );
    await createProfileFallback(userCredential.user.uid, payload);

    return userCredential.user;
  } catch (error) {
    throw toFriendlyError(error);
  }
}

export async function loginWithId(loginId, password) {
  try {
    const userCredential = await signInWithEmailAndPassword(
      auth,
      toInternalEmail(loginId),
      password
    );
    return userCredential.user;
  } catch (error) {
    throw toFriendlyError(error);
  }
}

export async function logoutUser() {
  await signOut(auth);
}

export async function refreshCurrentUserProfile() {
  if (auth.currentUser) {
    const fallbackProfile = await findUserProfileByUid(auth.currentUser.uid);
    if (fallbackProfile) {
      return {
        docId: fallbackProfile.id,
        ...fallbackProfile.data,
      };
    }

    return ensureBootstrapProfileForCurrentUser();
  }

  throw new Error("로그인된 유저가 없습니다.");
}

export function onSignedInUserChanged(callback) {
  return onAuthStateChanged(auth, async (user) => {
    if (!user) {
      callback(null);
      return;
    }

    try {
      const profile = await refreshCurrentUserProfile();
      callback(profile);
    } catch (error) {
      console.error(error);
      callback(null);
    }
  });
}

export async function selectTrait(traitId) {
  try {
    const result = await selectTraitCallable({ traitId });
    return result.data.profile;
  } catch (error) {
    throw toFriendlyError(error);
  }
}

export async function getRankingBoard() {
  try {
    const [userSnapshot, traitSnapshot] = await Promise.all([
      getDocs(collection(db, "users")),
      getDocs(collection(db, "traits")),
    ]);

    const traitPointMap = new Map(
      traitSnapshot.docs.map((item) => [item.id, Number(item.data().requiredPoints || 0)])
    );

    return userSnapshot.docs
      .map((item) => {
        const data = item.data();
        const selectedTraitIds = Array.isArray(data.selectedTraitIds) ? data.selectedTraitIds : [];
        const usedTraitPoints = selectedTraitIds.reduce(
          (sum, traitId) => sum + Number(traitPointMap.get(traitId) || 0),
          0
        );

        return {
          uid: data.uid || "",
          characterName: data.characterName || item.id,
          nickname: data.nickname || "-",
          rankingPoints: Number(data.rankingPoints || 0),
          currency: Number(data.currency || 0),
          totalTraitPoints: Number(data.availableTraitPoints || 0) + usedTraitPoints,
        };
      })
      .sort((left, right) => right.rankingPoints - left.rankingPoints);
  } catch (error) {
    try {
      const result = await getRankingBoardCallable();
      return result.data.rankings || [];
    } catch (fallbackError) {
      throw toFriendlyError(fallbackError);
    }
  }
}

export async function adminManageUser(payload) {
  try {
    const result = await adminManageUserCallable(payload);
    return result.data;
  } catch (error) {
    throw toFriendlyError(error);
  }
}

export async function adminDeleteUser(characterName) {
  try {
    const result = await adminDeleteUserCallable({ characterName });
    return result.data;
  } catch (error) {
    throw toFriendlyError(error);
  }
}

export async function createItemDefinition(payload) {
  try {
    const result = await createItemDefinitionCallable(payload);
    return result.data;
  } catch (error) {
    throw toFriendlyError(error);
  }
}

export async function updateItemDefinition(payload) {
  try {
    const result = await updateItemDefinitionCallable(payload);
    return result.data;
  } catch (error) {
    throw toFriendlyError(error);
  }
}

export async function deleteItemDefinition(itemId) {
  try {
    const result = await deleteItemDefinitionCallable({ itemId });
    return result.data;
  } catch (error) {
    throw toFriendlyError(error);
  }
}

export async function createAnnouncement(payload) {
  try {
    const result = await createAnnouncementCallable(payload);
    return result.data;
  } catch (error) {
    throw toFriendlyError(error);
  }
}

export async function listBugReports(payload) {
  try {
    const result = await listBugReportsCallable(payload);
    return result.data;
  } catch (error) {
    throw toFriendlyError(error);
  }
}

export async function purchaseShopItem(shopItemId, quantity = 1) {
  try {
    const result = await purchaseShopItemCallable({ shopItemId, quantity });
    return result.data;
  } catch (error) {
    throw toFriendlyError(error);
  }
}

export async function dismissAnnouncement(announcementId) {
  try {
    if (!auth.currentUser) {
      throw new Error("로그인된 유저가 없습니다.");
    }

    const profile = await findUserProfileByUid(auth.currentUser.uid);
    if (!profile) {
      throw new Error("유저 프로필을 찾지 못했습니다.");
    }

    await updateDoc(doc(db, "users", profile.id), {
      dismissedAnnouncementIds: arrayUnion(announcementId),
      updatedAt: serverTimestamp(),
    });

    return {
      docId: profile.id,
      ...profile.data,
      dismissedAnnouncementIds: [...new Set([...(profile.data.dismissedAnnouncementIds || []), announcementId])],
    };
  } catch (error) {
    throw toFriendlyError(error);
  }
}

export async function updateProfileSealImage(profileSealImage) {
  try {
    if (!auth.currentUser) {
      throw new Error("로그인한 유저가 없습니다.");
    }

    const profile = await findUserProfileByUid(auth.currentUser.uid);
    if (!profile) {
      throw new Error("유저 프로필을 찾지 못했습니다.");
    }

    await updateDoc(doc(db, "users", profile.id), {
      profileSealImage: String(profileSealImage || ""),
      updatedAt: serverTimestamp(),
    });

    return {
      docId: profile.id,
      ...profile.data,
      profileSealImage: String(profileSealImage || ""),
    };
  } catch (error) {
    throw toFriendlyError(error);
  }
}

export async function updateMemberProfile({ extraNicknames = [] }) {
  try {
    if (!auth.currentUser) {
      throw new Error("로그인한 유저가 없습니다.");
    }

    const profile = await findUserProfileByUid(auth.currentUser.uid);
    if (!profile) {
      throw new Error("유저 프로필을 찾지 못했습니다.");
    }

    const normalizedExtraNicknames = Array.isArray(extraNicknames)
      ? extraNicknames.map((item) => String(item || "").trim()).filter(Boolean)
      : [];

    await updateDoc(doc(db, "users", profile.id), {
      extraNicknames: normalizedExtraNicknames,
      updatedAt: serverTimestamp(),
    });

    return {
      docId: profile.id,
      ...profile.data,
      extraNicknames: normalizedExtraNicknames,
    };
  } catch (error) {
    throw toFriendlyError(error);
  }
}

export async function changeUserPassword(currentPassword, nextPassword) {
  try {
    if (!auth.currentUser || !auth.currentUser.email) {
      throw new Error("로그인한 유저가 없습니다.");
    }

    const currentPasswordText = String(currentPassword || "").trim();
    const nextPasswordText = String(nextPassword || "").trim();

    if (!currentPasswordText || !nextPasswordText) {
      throw new Error("현재 비밀번호와 새 비밀번호를 입력해 주세요.");
    }

    if (nextPasswordText.length < 8) {
      throw new Error("새 비밀번호는 8자 이상이어야 합니다.");
    }

    const credential = EmailAuthProvider.credential(auth.currentUser.email, currentPasswordText);
    await reauthenticateWithCredential(auth.currentUser, credential);
    await updatePassword(auth.currentUser, nextPasswordText);

    return { ok: true };
  } catch (error) {
    throw toFriendlyError(error);
  }
}

export async function sendParcel(payload) {
  try {
    const result = await sendParcelCallable(payload);
    return result.data;
  } catch (error) {
    throw toFriendlyError(error);
  }
}

export async function respondParcel(parcelId, action) {
  try {
    const result = await respondParcelCallable({ parcelId, action });
    return result.data;
  } catch (error) {
    throw toFriendlyError(error);
  }
}

export async function useInventoryItem(itemKey, extraData = {}) {
  try {
    const result = await useInventoryItemCallable({ itemKey, extraData });
    return result.data;
  } catch (error) {
    throw toFriendlyError(error);
  }
}

export async function markNotificationRead(notificationId) {
  try {
    await updateDoc(doc(db, "notifications", notificationId), {
      isRead: true,
      readAt: serverTimestamp(),
    });
    return { ok: true };
  } catch (error) {
    throw toFriendlyError(error);
  }
}

export async function listAdminLogs({ kind, page = 0, pageSize = 5 }) {
  try {
    const result = await listAdminLogsCallable({ kind, page, pageSize });
    return result.data;
  } catch (error) {
    throw toFriendlyError(error);
  }
}
