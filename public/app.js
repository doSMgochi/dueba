import {
  loginWithId,
  logoutUser,
  onSignedInUserChanged,
  refreshCurrentUserProfile,
  signUpWithProfile,
} from "./src/auth.js";
import { buildDashboard, menuDefinitions } from "./src/dashboard.js";

const authView = document.querySelector("#auth-view");
const dashboardView = document.querySelector("#dashboard-view");
const signupForm = document.querySelector("#signup-form");
const loginForm = document.querySelector("#login-form");
const logoutButton = document.querySelector("#logout-button");
const refreshButton = document.querySelector("#refresh-dashboard");
const menuTabs = document.querySelector("#menu-tabs");
const menuContent = document.querySelector("#menu-content");
const toast = document.querySelector("#toast");
const signupModal = document.querySelector("#signup-modal");
const openSignupModalButton = document.querySelector("#open-signup-modal");
const closeSignupModalButton = document.querySelector("#close-signup-modal");

let dashboardState = {
  profile: null,
  activeMenuId: menuDefinitions[0].id,
};

openSignupModalButton.addEventListener("click", () => {
  signupModal.classList.remove("hidden");
});

closeSignupModalButton.addEventListener("click", closeSignupModal);
signupModal.addEventListener("click", (event) => {
  if (event.target === signupModal) {
    closeSignupModal();
  }
});

signupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(signupForm).entries());

  if (payload.password !== payload.passwordConfirm) {
    showToast("비밀번호와 비밀번호 확인이 일치하지 않습니다.", true);
    return;
  }

  try {
    await signUpWithProfile({
      loginId: payload.loginId,
      nickname: payload.nickname,
      characterName: payload.characterName,
      password: payload.password,
    });
    signupForm.reset();
    closeSignupModal();
    showToast("회원가입과 로그인까지 완료되었습니다.");
  } catch (error) {
    showToast(error.message, true);
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(loginForm).entries());

  try {
    await loginWithId(payload.loginId, payload.password);
    loginForm.reset();
    showToast("로그인되었습니다.");
  } catch (error) {
    showToast(error.message, true);
  }
});

logoutButton.addEventListener("click", async () => {
  await logoutUser();
  showToast("로그아웃되었습니다.");
});

refreshButton.addEventListener("click", async () => {
  if (!dashboardState.profile) {
    return;
  }

  try {
    const profile = await refreshCurrentUserProfile();
    updateDashboard(profile, dashboardState.activeMenuId);
    showToast("대시보드를 새로고침했습니다.");
  } catch (error) {
    showToast(error.message, true);
  }
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

function closeSignupModal() {
  signupModal.classList.add("hidden");
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
