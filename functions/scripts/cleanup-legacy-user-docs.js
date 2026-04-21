const path = require("path");
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

function parseArgs(argv) {
  const parsed = {
    apply: false,
    serviceAccount: "",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--apply") {
      parsed.apply = true;
      continue;
    }
    if (current === "--service-account") {
      parsed.serviceAccount = String(argv[index + 1] || "").trim();
      index += 1;
    }
  }

  return parsed;
}

function loadServiceAccount(serviceAccountPath) {
  const resolvedPath = path.resolve(process.cwd(), serviceAccountPath);
  // eslint-disable-next-line import/no-dynamic-require, global-require
  return require(resolvedPath);
}

function scoreUserDoc(docId, data) {
  const normalizedUid = String(data?.uid || "").trim();
  const normalizedCharacterName = String(data?.characterName || "").trim();
  let score = 0;

  if (docId && normalizedCharacterName && docId === normalizedCharacterName) {
    score += 100;
  }
  if (docId && normalizedUid && docId !== normalizedUid) {
    score += 10;
  }
  if (Array.isArray(data?.inventory)) {
    score += Math.min(data.inventory.length, 20);
  }
  score += Number(data?.currency || 0) > 0 ? 1 : 0;

  return score;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.serviceAccount) {
    throw new Error("--service-account 경로를 입력해 주세요.");
  }

  if (!getApps().length) {
    initializeApp({
      credential: cert(loadServiceAccount(args.serviceAccount)),
    });
  }

  const db = getFirestore();
  const usersSnapshot = await db.collection("users").get();
  const usersByUid = new Map();

  usersSnapshot.docs.forEach((docSnapshot) => {
    const data = docSnapshot.data();
    const uid = String(data?.uid || "").trim();
    if (!uid) return;
    const list = usersByUid.get(uid) || [];
    list.push({
      id: docSnapshot.id,
      ref: docSnapshot.ref,
      data,
      score: scoreUserDoc(docSnapshot.id, data),
    });
    usersByUid.set(uid, list);
  });

  const cleanupPlans = [];

  usersByUid.forEach((entries, uid) => {
    if (entries.length < 2) return;

    const sortedEntries = [...entries].sort((left, right) => right.score - left.score);
    const keep = sortedEntries[0];
    const remove = sortedEntries.slice(1).filter((entry) => entry.id === uid || entry.score < keep.score);

    if (!remove.length) return;

    cleanupPlans.push({
      uid,
      keep,
      remove,
    });
  });

  if (!cleanupPlans.length) {
    console.log("정리할 중복 users 문서가 없습니다.");
    return;
  }

  console.log(`중복 uid ${cleanupPlans.length}건을 찾았습니다.`);
  cleanupPlans.forEach((plan) => {
    console.log(`- uid: ${plan.uid}`);
    console.log(`  유지: ${plan.keep.id}`);
    console.log(`  삭제 예정: ${plan.remove.map((entry) => entry.id).join(", ")}`);
  });

  if (!args.apply) {
    console.log("드라이런 모드입니다. 실제 삭제하려면 --apply 를 추가해 주세요.");
    return;
  }

  for (const plan of cleanupPlans) {
    for (const entry of plan.remove) {
      await entry.ref.delete();
      console.log(`삭제 완료: users/${entry.id}`);
    }
  }

  console.log("레거시 users 문서 정리가 끝났습니다.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
