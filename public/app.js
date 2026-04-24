import {
  findLoginIdByEmail,
  loginWithId,
  logoutUser,
  onSignedInUserChanged,
  refreshCurrentUserProfile,
  requestPasswordResetEmail,
  signUpWithProfile,
} from "./src/auth.js";
import { buildDashboard, menuDefinitions } from "./src/dashboard.js";

const authView = document.querySelector("#auth-view");
const dashboardView = document.querySelector("#dashboard-view");
const signupForm = document.querySelector("#signup-form");
const loginForm = document.querySelector("#login-form");
const logoutButton = document.querySelector("#logout-button");
const menuTabs = document.querySelector("#menu-tabs");
const menuContent = document.querySelector("#menu-content");
const toast = document.querySelector("#toast");

const signupModal = document.querySelector("#signup-modal");
const openSignupModalButton = document.querySelector("#open-signup-modal");
const closeSignupModalButton = document.querySelector("#close-signup-modal");

const findIdModal = document.querySelector("#find-id-modal");
const openFindIdModalButton = document.querySelector("#open-find-id-modal");
const closeFindIdModalButton = document.querySelector("#close-find-id-modal");
const findIdForm = document.querySelector("#find-id-form");
const findIdResult = document.querySelector("#find-id-result");

const resetPasswordModal = document.querySelector("#reset-password-modal");
const openResetPasswordModalButton = document.querySelector("#open-reset-password-modal");
const closeResetPasswordModalButton = document.querySelector("#close-reset-password-modal");
const resetPasswordForm = document.querySelector("#reset-password-form");

let dashboardState = {
  profile: null,
  activeMenuId: menuDefinitions[0].id,
};
let lastTeamWarningKey = "";

bindModal(signupModal, openSignupModalButton, closeSignupModalButton, () => {
  signupForm.reset();
});
bindModal(findIdModal, openFindIdModalButton, closeFindIdModalButton, () => {
  findIdForm.reset();
  findIdResult.classList.add("hidden");
  findIdResult.textContent = "";
});
bindModal(resetPasswordModal, openResetPasswordModalButton, closeResetPasswordModalButton, () => {
  resetPasswordForm.reset();
});

signupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = signupForm.querySelector('button[type="submit"]');
  const payload = Object.fromEntries(new FormData(signupForm).entries());

  if (String(payload.password || "") !== String(payload.passwordConfirm || "")) {
    showToast("비밀번호와 비밀번호 확인이 일치하지 않습니다.", true);
    return;
  }

  try {
    if (submitButton) submitButton.disabled = true;
    showToast("처리중입니다.");
    await signUpWithProfile({
      loginId: payload.loginId,
      email: payload.email,
      nickname: payload.nickname,
      characterName: payload.characterName,
      friendCode: payload.friendCode,
      factionName: payload.factionName,
      password: payload.password,
    });
    signupForm.reset();
    closeModal(signupModal);
    showToast("회원가입과 로그인을 완료했습니다.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});

findIdForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(findIdForm).entries());

  try {
    showToast("처리중입니다.");
    const loginId = await findLoginIdByEmail(payload.email);
    findIdResult.textContent = `가입한 아이디는 ${loginId} 입니다.`;
    findIdResult.classList.remove("hidden");
  } catch (error) {
    findIdResult.textContent = error.message;
    findIdResult.classList.remove("hidden");
    showToast(error.message, true);
  }
});

resetPasswordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = resetPasswordForm.querySelector('button[type="submit"]');
  const payload = Object.fromEntries(new FormData(resetPasswordForm).entries());

  try {
    if (submitButton) submitButton.disabled = true;
    showToast("처리중입니다.");
    await requestPasswordResetEmail(payload.email);
    resetPasswordForm.reset();
    closeModal(resetPasswordModal);
    showToast("비밀번호 재설정 메일을 보냈습니다.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});

document.addEventListener(
  "wheel",
  (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.type !== "number") return;
    if (document.activeElement !== target) return;
    event.preventDefault();
  },
  { passive: false }
);

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (loginForm.dataset.pending === "1") return;
  const payload = Object.fromEntries(new FormData(loginForm).entries());
  const submitButton = loginForm.querySelector('button[type="submit"]');

  try {
    loginForm.dataset.pending = "1";
    if (submitButton) submitButton.disabled = true;
    showToast("처리중입니다.");
    await loginWithId(payload.loginId, payload.password);
    loginForm.reset();
    showToast("로그인되었습니다.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    delete loginForm.dataset.pending;
    if (submitButton) submitButton.disabled = false;
  }
});

logoutButton.addEventListener("click", async () => {
  await logoutUser();
  showToast("로그아웃되었습니다.");
});

menuTabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-menu-id]");
  if (!button || !dashboardState.profile) {
    return;
  }

  updateDashboard(dashboardState.profile, button.dataset.menuId);
});

onSignedInUserChanged((profile, meta = {}) => {
  const isLoggedIn = Boolean(profile);
  authView.classList.toggle("hidden", isLoggedIn);
  dashboardView.classList.toggle("hidden", !isLoggedIn);

  if (!isLoggedIn) {
    if (meta?.reason === "session-conflict") {
      showToast("다른 곳에서 로그인되어 이 화면은 로그아웃되었습니다.", true);
    }
    lastTeamWarningKey = "";
    dashboardState = {
      profile: null,
      activeMenuId: menuDefinitions[0].id,
    };
    menuTabs.innerHTML = "";
    menuContent.innerHTML = "";
    return;
  }

  maybeShowTeamEnrollmentWarning(profile);
  updateDashboard(profile, dashboardState.activeMenuId);
});

function updateDashboard(profile, activeMenuId) {
  dashboardState = {
    profile,
    activeMenuId,
  };

  buildDashboard({
    profile,
    activeMenuId,
    menuTabs,
    menuContent,
    onProfilePatched: async (patchedProfile = null) => {
      const nextProfile = patchedProfile || (await refreshCurrentUserProfile());
      updateDashboard(nextProfile, activeMenuId);
    },
    onToast: showToast,
  });
}

function bindModal(modal, openButton, closeButton, onClose = null) {
  openButton?.addEventListener("click", () => modal.classList.remove("hidden"));
  closeButton?.addEventListener("click", () => closeModal(modal, onClose));
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) {
      closeModal(modal, onClose);
    }
  });
}

function closeModal(modal, onClose = null) {
  modal.classList.add("hidden");
  if (typeof onClose === "function") {
    onClose();
  }
}

function showToast(message, isError = false, options = {}) {
  const persist = Boolean(options?.persist);
  toast.textContent = message;
  toast.classList.remove("hidden", "error");
  if (isError) {
    toast.classList.add("error");
  }

  window.clearTimeout(showToast.timerId);
  if (!persist) {
    showToast.timerId = window.setTimeout(() => {
      toast.classList.add("hidden");
    }, 3000);
  }
}

showToast.hideIfMessage = (expectedMessage) => {
  if (toast.textContent === expectedMessage) {
    window.clearTimeout(showToast.timerId);
    toast.classList.add("hidden");
  }
};

showToast.forceHide = () => {
  window.clearTimeout(showToast.timerId);
  toast.classList.add("hidden");
};

function maybeShowTeamEnrollmentWarning(profile) {
  const status = String(profile?.teamEnrollmentStatus || "").trim();
  if (status !== "invalid-friend-code") {
    return;
  }

  const rawMessage = String(profile?.teamEnrollmentMessage || "").trim();
  const warningKey = `${profile.uid}:${status}:${rawMessage}`;
  if (warningKey === lastTeamWarningKey) {
    return;
  }

  lastTeamWarningKey = warningKey;
  showToast(resolveTeamEnrollmentWarningMessage(rawMessage), true);
}

function resolveTeamEnrollmentWarningMessage(rawMessage) {
  if (!rawMessage || looksLikeBrokenKorean(rawMessage)) {
    return "친구코드가 비어 있거나 숫자가 아닙니다. 수정해주세요.";
  }

  return "친구코드를 확인해주세요. 잘못 등록되어 있을 수 있습니다.";
}

function looksLikeBrokenKorean(value) {
  const text = String(value || "").trim();
  return Boolean(text) && !/[가-힣]/.test(text);
}
