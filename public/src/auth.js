import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-functions.js";
import { auth, db, functions } from "./firebase.js";

const ensureUserProfileCallable = httpsCallable(functions, "ensureUserProfile");
const getDashboardDataCallable = httpsCallable(functions, "getDashboardData");
const selectTraitCallable = httpsCallable(functions, "selectTrait");
const adminManageUserCallable = httpsCallable(functions, "adminManageUser");
const adminDeleteUserCallable = httpsCallable(functions, "adminDeleteUser");
const createAnnouncementCallable = httpsCallable(functions, "createAnnouncement");
const dismissAnnouncementCallable = httpsCallable(functions, "dismissAnnouncement");
const sendParcelCallable = httpsCallable(functions, "sendParcel");
const respondParcelCallable = httpsCallable(functions, "respondParcel");
const markNotificationReadCallable = httpsCallable(functions, "markNotificationRead");

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

  return new Error(errorMap[code] || error.message || "요청을 처리하는 중 오류가 발생했습니다.");
}

async function findUserProfileByUid(uid) {
  const legacySnapshot = await getDoc(doc(db, "users", uid));
  if (legacySnapshot.exists()) {
    return {
      id: legacySnapshot.id,
      data: legacySnapshot.data(),
    };
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

    try {
      await ensureUserProfileCallable(payload);
    } catch (_error) {
      await createProfileFallback(userCredential.user.uid, payload);
    }

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
  try {
    const result = await getDashboardDataCallable();
    return result.data.profile;
  } catch (error) {
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
    throw toFriendlyError(error);
  }
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

export async function createAnnouncement(payload) {
  try {
    const result = await createAnnouncementCallable(payload);
    return result.data;
  } catch (error) {
    throw toFriendlyError(error);
  }
}

export async function dismissAnnouncement(announcementId) {
  try {
    const result = await dismissAnnouncementCallable({ announcementId });
    return result.data.profile;
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

export async function markNotificationRead(notificationId) {
  try {
    const result = await markNotificationReadCallable({ notificationId });
    return result.data;
  } catch (error) {
    throw toFriendlyError(error);
  }
}
