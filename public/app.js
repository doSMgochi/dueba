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
  const payload = Object.fromEntries(new FormData(signupForm).entries());

  if (String(payload.password || "") !== String(payload.passwordConfirm || "")) {
    showToast("비밀번호와 비밀번호 확인이 일치하지 않습니다.", true);
    return;
  }

  try {
    showToast("처리중입니다");
    await signUpWithProfile({
      loginId: payload.loginId,
      email: payload.email,
      nickname: payload.nickname,
      characterName: payload.characterName,
      password: payload.password,
    });
    signupForm.reset();
    closeModal(signupModal);
    showToast("회원가입과 로그인을 완료했습니다.");
  } catch (error) {
    showToast(error.message, true);
  }
});

findIdForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(findIdForm).entries());

  try {
    showToast("처리중입니다");
    const loginId = await findLoginIdByEmail(payload.email);
    findIdResult.textContent = `가입된 아이디는 ${loginId} 입니다.`;
    findIdResult.classList.remove("hidden");
  } catch (error) {
    findIdResult.textContent = error.message;
    findIdResult.classList.remove("hidden");
    showToast(error.message, true);
  }
});

resetPasswordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(resetPasswordForm).entries());

  try {
    showToast("처리중입니다");
    await requestPasswordResetEmail(payload.email);
    resetPasswordForm.reset();
    closeModal(resetPasswordModal);
    showToast("비밀번호 재설정 메일을 보냈습니다.");
  } catch (error) {
    showToast(error.message, true);
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
  const payload = Object.fromEntries(new FormData(loginForm).entries());

  try {
    showToast("처리중입니다");
    await loginWithId(payload.loginId, payload.password);
    loginForm.reset();
    showToast("로그인되었습니다.");
  } catch (error) {
    showToast(error.message, true);
  }
});

logoutButton.addEventListener("click", async () => {
  await logoutUser();
  showToast("로그아웃했습니다.");
});

menuTabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-menu-id]");
  if (!button || !dashboardState.profile) {
    return;
  }

  updateDashboard(dashboardState.profile, button.dataset.menuId);
});

onSignedInUserChanged((profile) => {
  const isLoggedIn = Boolean(profile);
  authView.classList.toggle("hidden", isLoggedIn);
  dashboardView.classList.toggle("hidden", !isLoggedIn);

  if (!isLoggedIn) {
    dashboardState = {
      profile: null,
      activeMenuId: menuDefinitions[0].id,
    };
    menuTabs.innerHTML = "";
    menuContent.innerHTML = "";
    return;
  }

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

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.remove("hidden", "error");
  if (isError) {
    toast.classList.add("error");
  }

  window.clearTimeout(showToast.timerId);
  showToast.timerId = window.setTimeout(() => {
    toast.classList.add("hidden");
  }, 3000);
}
