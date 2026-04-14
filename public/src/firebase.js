import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-functions.js";
import { firebaseConfig, firebaseFunctionsRegion } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, firebaseFunctionsRegion);

export { app, auth, db, functions };
