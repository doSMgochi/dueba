import json
import logging
import os
import re
import sys
import time
import imaplib
from email import message_from_bytes
from email.header import decode_header, make_header
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, List, Optional

import firebase_admin
import undetected_chromedriver as uc
from bs4 import BeautifulSoup
from firebase_admin import credentials, firestore
from selenium.common.exceptions import TimeoutException, SessionNotCreatedException
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.environ.get("DUEBA_CRAWLER_CONFIG") or os.path.join(BASE_DIR, "config.local.json")
LOG_DIR = os.path.join(BASE_DIR, "logs")
USER_DATA_DIR = os.path.join(BASE_DIR, "user_data_crawler")
DEBUG_DIR = os.path.join(BASE_DIR, "debug")

FACTIONS = ("매화", "난초", "국화", "대나무")

TEAM_ADD_BUTTON_XPATHS = [
    ".//button[contains(., '팀원 추가')]",
    ".//span[contains(., '팀원 추가')]/ancestor::button[1]",
    ".//button[contains(., '添加队员')]",
    ".//span[contains(., '添加队员')]/ancestor::button[1]",
]
TEAM_SEARCH_INPUT_SELECTORS = [
    "input[placeholder*='친구']",
    "input[placeholder*='ID']",
    "input",
]
TEAM_SEARCH_BUTTON_XPATHS = [
    ".//button[contains(., '검색')]",
    ".//span[contains(., '검색')]/ancestor::button[1]",
    ".//button[contains(., '搜索')]",
    ".//span[contains(., '搜索')]/ancestor::button[1]",
    ".//button[contains(., '查找')]",
    ".//span[contains(., '查找')]/ancestor::button[1]",
    ".//button[contains(translate(normalize-space(.), ' ', ''), '搜索')]",
    ".//button[contains(translate(normalize-space(.), ' ', ''), '查找')]",
    ".//button[contains(@data-track-key, 'button.search')]",
]
TEAM_RESULT_ROW_SELECTORS = [
    ".ant-list-item",
    "tbody tr",
    ".search-result-item",
]
TEAM_RESULT_ADD_BUTTON_XPATHS = [
    ".//button[contains(., '추가')]",
    ".//span[contains(., '추가')]/ancestor::button[1]",
    ".//button[contains(., '添加')]",
    ".//span[contains(., '添加')]/ancestor::button[1]",
    ".//button[contains(translate(normalize-space(.), ' ', ''), '添加')]",
    ".//button[contains(@data-track-key, 'button.add')]",
]
TEAM_EXISTING_MEMBER_PATTERNS = [
    "{friend_code}",
    "{nickname}",
    "{character_name}",
]
RECORD_ROW_SELECTORS = [
    "div.ant-table-content tbody.ant-table-tbody tr[data-row-key]",
    "tbody.ant-table-tbody tr",
]


@dataclass
class ContestConfig:
    key: str
    name: str
    record_url: str
    team_manager_url: str
    player_count: int


def ensure_dirs() -> None:
    os.makedirs(LOG_DIR, exist_ok=True)
    os.makedirs(USER_DATA_DIR, exist_ok=True)
    os.makedirs(DEBUG_DIR, exist_ok=True)


def configure_logging() -> None:
    ensure_dirs()
    log_path = os.path.join(LOG_DIR, "crawler.log")
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[
            logging.FileHandler(log_path, encoding="utf-8"),
            logging.StreamHandler(sys.stdout),
        ],
    )


def load_config() -> Dict[str, Any]:
    if not os.path.exists(CONFIG_PATH):
      raise FileNotFoundError(
          f"설정 파일이 없습니다: {CONFIG_PATH}. config.example.json을 복사해서 config.local.json을 만들어 주세요."
      )

    with open(CONFIG_PATH, "r", encoding="utf-8") as file:
        return json.load(file)


def resolve_path(path: str) -> str:
    return path if os.path.isabs(path) else os.path.normpath(os.path.join(BASE_DIR, path))


def init_firestore(config: Dict[str, Any]):
    service_account_path = resolve_path(config["firestore_service_account_path"])
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(service_account_path))
    return firestore.client()


def build_contests(config: Dict[str, Any]) -> List[ContestConfig]:
    contests: List[ContestConfig] = []
    for item in config.get("contests", []):
        contests.append(
            ContestConfig(
                key=str(item["key"]),
                name=str(item["name"]),
                record_url=str(item["record_url"]),
                team_manager_url=str(item["team_manager_url"]),
                player_count=int(item["player_count"]),
            )
        )
    return contests


def build_driver_options(headless: bool):
    options = uc.ChromeOptions()
    chrome_binary = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
    if os.path.exists(chrome_binary):
        options.binary_location = chrome_binary
    options.add_argument("--disable-gpu")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_argument("--remote-debugging-port=0")
    options.add_argument(f"--user-data-dir={USER_DATA_DIR}")
    if headless:
        options.add_argument("--headless=new")
    return options


def create_driver(headless: bool):
    try:
        return uc.Chrome(options=build_driver_options(headless), use_subprocess=True)
    except SessionNotCreatedException:
        if headless:
            logging.warning("undetected_chromedriver headless 세션 생성에 실패해 일반 Chrome WebDriver로 재시도합니다.")
            return webdriver.Chrome(options=build_driver_options(True))
        logging.warning("일반 브라우저 세션 생성에 실패해 headless 모드로 재시도합니다.")
        try:
            return uc.Chrome(options=build_driver_options(True), use_subprocess=True)
        except SessionNotCreatedException:
            logging.warning("undetected_chromedriver 재시도에도 실패해 일반 Chrome WebDriver로 전환합니다.")
            return webdriver.Chrome(options=build_driver_options(True))


class DuebaCrawler:
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.db = init_firestore(config)
        self.contests = build_contests(config)
        self.driver = create_driver(bool(config.get("headless", False)))
        self.wait = WebDriverWait(self.driver, 20)
        self.saved_account_login_attempted_at = 0.0
        self.agreement_handled_at = 0.0
        self.saved_account_login_started = False
        self.agreement_submission_started_at = 0.0

    def close(self) -> None:
        try:
            self.driver.quit()
        except Exception:
            pass

    def run_once(self) -> None:
        self.ensure_logged_in()
        users = self.load_users()
        for contest in self.contests:
            self.sync_team_members(contest, users)
            self.sync_match_results(contest)

    def ensure_logged_in(self) -> None:
        self.saved_account_login_attempted_at = 0.0
        self.agreement_handled_at = 0.0
        self.saved_account_login_started = False
        self.agreement_submission_started_at = 0.0
        landing_url = self.contests[0].record_url
        self.driver.get(landing_url)
        time.sleep(5)

        if self.is_record_table_visible():
            logging.info("이미 로그인된 세션을 사용합니다.")
            return

        self.wait_for_login_surface()

        if self.is_saved_account_login_visible():
            if self.click_saved_account_login():
                self.saved_account_login_started = True
                self.saved_account_login_attempted_at = time.time()
                self.wait_for_post_login_ready()
                try:
                    self.wait.until(lambda driver: self.is_logged_in_surface_visible())
                    logging.info("YOSTAR 저장 계정 로그인 완료")
                    return
                except TimeoutException:
                    self.dump_debug_artifacts("saved_account_post_login_timeout")
                    raise

        login_button = self.find_first_xpath([
            "//button[contains(., 'LOGIN')]",
            "//button[contains(., 'Login')]",
            "//button[contains(., '로그인')]",
            "//a[contains(., 'LOGIN')]",
            "//a[contains(., 'Login')]",
            "//a[contains(., '로그인')]",
            "//span[contains(., 'LOGIN')]/ancestor::button[1]",
            "//span[contains(., 'Login')]/ancestor::button[1]",
            "//span[contains(., '로그인')]/ancestor::button[1]",
            "//span[contains(., 'LOGIN')]/ancestor::a[1]",
            "//span[contains(., 'Login')]/ancestor::a[1]",
            "//span[contains(., '로그인')]/ancestor::a[1]",
        ])
        if login_button is None:
            logging.info("로그인 버튼을 찾지 못했지만 페이지 로딩을 다시 시도합니다.")
            self.dump_debug_artifacts("login_button_missing")
            self.driver.get(landing_url)
            time.sleep(5)
            return

        self.driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", login_button)
        self.driver.execute_script("arguments[0].click();", login_button)
        time.sleep(4)
        self.perform_yostar_login()

        # 濡쒓렇??吏곹썑 ?쎄?/?덈궡/由щ떎?대젆?멸? ?좎떆 ?????덉뼱???ъ쑀瑜??〓땲??
        self.wait_for_post_login_ready()

        try:
            self.wait.until(lambda driver: self.is_logged_in_surface_visible())
        except TimeoutException:
            self.dump_debug_artifacts("post_login_table_timeout")
            raise
        logging.info("YOSTAR 로그인 완료")

    def wait_for_login_surface(self) -> None:
        deadline = time.time() + 15
        while time.time() < deadline:
            if self.is_record_table_visible():
                return

            login_panel = self.find_first_xpath([
                "//*[contains(., 'LOG IN WITH AN IN-GAME ACCOUNT')]",
                "//*[contains(., 'Account:')]",
                "//*[contains(., '계정:')]",
                "//button[contains(., 'Login')]",
                "//button[contains(., '로그인')]",
            ])
            if login_panel is not None:
                time.sleep(5)
                return

            time.sleep(1)

    def wait_for_post_login_ready(self) -> None:
        deadline = time.time() + 40
        while time.time() < deadline:
            if self.is_logged_in_surface_visible():
                return

            if "contest_dashboard" in self.driver.current_url:
                time.sleep(8)
                return

            if self.handle_age_agreement_modal():
                self.agreement_handled_at = time.time()
                self.agreement_submission_started_at = time.time()
                time.sleep(4)
                continue

            if self.has_active_agreement_modal():
                time.sleep(3)
                continue

            if self.agreement_handled_at and (time.time() - self.agreement_handled_at) < 10:
                time.sleep(2)
                continue

            if self.agreement_submission_started_at and (time.time() - self.agreement_submission_started_at) < 20:
                time.sleep(2)
                continue

            dismiss_button = self.find_first_xpath([
                "//button[contains(., '?숈쓽')]",
                "//button[contains(., '?뺤씤')]",
                "//button[contains(., 'Agree')]",
                "//button[contains(., 'OK')]",
                "//span[contains(., '?숈쓽')]/ancestor::button[1]",
                "//span[contains(., '?뺤씤')]/ancestor::button[1]",
                "//span[contains(., 'Agree')]/ancestor::button[1]",
                "//span[contains(., 'OK')]/ancestor::button[1]",
            ])
            if dismiss_button is not None:
                try:
                    self.driver.execute_script("arguments[0].click();", dismiss_button)
                    time.sleep(4)
                    continue
                except Exception:
                    pass

            time.sleep(2)

    def handle_age_agreement_modal(self) -> bool:
        agreement_modal = self.find_first_css([
            "#web-sdk-root .agreement",
            "#web-sdk-root .agreement-main",
            "#web-sdk-root .agreement-main-option",
        ])
        if agreement_modal is None:
            return False

        # 약관 레이어가 완전히 렌더될 때까지 조금 더 기다립니다.
        time.sleep(1.5)

        # 로딩 레이어가 살아 있으면 클릭이 막히므로 잠깐 대기합니다.
        overlay_deadline = time.time() + 8
        while time.time() < overlay_deadline:
            try:
                overlay_visible = self.driver.execute_script(
                    """
                    const overlay = document.querySelector("#websdk-container-loading");
                    if (!overlay) return false;
                    const style = window.getComputedStyle(overlay);
                    return style.display !== "none" && style.visibility !== "hidden" && overlay.offsetParent !== null;
                    """
                )
            except Exception:
                overlay_visible = False

            if not overlay_visible:
                break
            time.sleep(0.5)

        try:
            agreement_ready = self.driver.execute_script(
                """
                const root = document.querySelector("#web-sdk-root");
                if (!root) return false;
                const text = root.innerText || "";
                return text.includes("약관 확인")
                    || text.includes("이용 약관")
                    || text.includes("개인정보수집 및 이용 동의")
                    || text.includes("나는 만 18 세 이상입니다")
                    || text.includes("나는 만 18세 이상입니다");
                """
            )
        except Exception:
            agreement_ready = False

        if not agreement_ready:
            time.sleep(2)

        try:
            checkbox_targets = self.driver.execute_script(
                """
                return Array.from(
                    document.querySelectorAll(
                        "#web-sdk-root .agreement .agreement-main-option, #web-sdk-root .agreement-main-option"
                    )
                );
                """
            )
        except Exception:
            checkbox_targets = []

        if not checkbox_targets:
            checkbox_targets = self.find_all_xpath([
                "//*[contains(@class, 'agreement-main-option')]",
                "//*[contains(., '이용 약관')]",
                "//*[contains(., '개인정보수집 및 이용 동의')]",
                "//*[contains(., '나는 만 18 세 이상입니다')]",
                "//*[contains(., '나는 만 18세 이상입니다')]",
            ])

        checked_count = 0
        for index, target in enumerate(checkbox_targets):
            try:
                self.driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", target)
                time.sleep(0.5)
                try:
                    ActionChains(self.driver).move_to_element(target).pause(0.35).click().perform()
                except Exception:
                    self.driver.execute_script(
                        """
                        const option = arguments[0];
                        const clickTargets = [
                            option,
                            option.querySelector(".agreement-main-option-content"),
                            option.querySelector(".cp-checkbox-wrapper"),
                            option.querySelector(".cp-checkbox"),
                            option.querySelector("span"),
                        ].filter(Boolean);
                        for (const target of clickTargets) {
                            const fire = (type) => {
                                target.dispatchEvent(new MouseEvent(type, {
                                    view: window,
                                    bubbles: true,
                                    cancelable: true,
                                }));
                            };
                            fire('pointerdown');
                            fire('mousedown');
                            fire('mouseup');
                            fire('click');
                        }
                        """,
                        target,
                    )
                time.sleep(0.9)

                button_enabled = False
                try:
                    button_enabled = self.driver.execute_script(
                        """
                        const button = document.querySelector("#web-sdk-root .agreement .actions .cp-button.cp-button_confirm, #web-sdk-root .agreement .cp-button.cp-button_confirm, #web-sdk-root .cp-pop .actions .cp-button.cp-button_confirm");
                        if (!button) return false;
                        const disabledAttr = button.hasAttribute('disabled');
                        const ariaDisabled = button.getAttribute('aria-disabled') === 'true';
                        const cls = button.className || '';
                        const style = window.getComputedStyle(button);
                        const visuallyDisabled =
                            cls.includes('disabled') ||
                            style.pointerEvents === 'none' ||
                            style.opacity === '0.5';
                        return !(disabledAttr || ariaDisabled || visuallyDisabled);
                        """
                    )
                except Exception:
                    button_enabled = False

                checked_count = index + 1
                if button_enabled:
                    break
            except Exception:
                continue

        agree_button = self.find_first_css([
            "#web-sdk-root .agreement .actions .cp-button.cp-button_confirm",
            "#web-sdk-root .agreement .cp-button.cp-button_confirm",
            "#web-sdk-root .cp-pop .actions .cp-button.cp-button_confirm",
        ])
        if agree_button is None:
            agree_button = self.find_first_xpath([
                "//button[contains(., '동의')]",
                "//button[contains(., '확인')]",
                "//span[contains(., '동의')]/ancestor::button[1]",
                "//span[contains(., '확인')]/ancestor::button[1]",
            ])

        if agree_button is not None:
            try:
                for _ in range(8):
                    disabled_attr = self.driver.execute_script(
                        """
                        const button = arguments[0];
                        const disabledAttr = button.hasAttribute('disabled');
                        const ariaDisabled = button.getAttribute('aria-disabled') === 'true';
                        const cls = button.className || '';
                        const style = window.getComputedStyle(button);
                        const visuallyDisabled =
                            cls.includes('disabled') ||
                            style.pointerEvents === 'none' ||
                            style.opacity === '0.5';
                        return disabledAttr || ariaDisabled || visuallyDisabled;
                        """,
                        agree_button,
                    )
                    if not disabled_attr:
                        break

                    if checkbox_targets and checked_count >= min(len(checkbox_targets), 3):
                        self.driver.execute_script(
                            """
                            const button = arguments[0];
                            button.removeAttribute('disabled');
                            button.setAttribute('aria-disabled', 'false');
                            button.classList.remove('disabled');
                            button.style.pointerEvents = 'auto';
                            button.style.opacity = '1';
                            """,
                            agree_button,
                        )
                    time.sleep(1.2)

                disabled_attr = self.driver.execute_script(
                    """
                    const button = arguments[0];
                    const disabledAttr = button.hasAttribute('disabled');
                    const ariaDisabled = button.getAttribute('aria-disabled') === 'true';
                    const cls = button.className || '';
                    const style = window.getComputedStyle(button);
                    const visuallyDisabled =
                        cls.includes('disabled') ||
                        style.pointerEvents === 'none' ||
                        style.opacity === '0.5';
                    return disabledAttr || ariaDisabled || visuallyDisabled;
                    """,
                    agree_button,
                )
                if disabled_attr:
                    return False

                self.driver.execute_script(
                    """
                    const button = arguments[0];
                    button.scrollIntoView({block: 'center'});
                    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                    button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                    button.click();
                    """,
                    agree_button,
                )
                time.sleep(4)
                return True
            except Exception:
                return False

        return False

    def has_active_agreement_modal(self) -> bool:
        return self.find_first_css([
            "#web-sdk-root .agreement",
            "#web-sdk-root .agreement-main",
            "#web-sdk-root .agreement-main-option",
        ]) is not None

    def is_saved_account_login_visible(self) -> bool:
        return self.find_first_xpath([
            "//button[contains(., 'Logout')]",
            "//button[contains(., '로그아웃')]",
        ]) is not None

    def click_saved_account_login(self) -> bool:
        saved_login_button = self.find_first_xpath([
            "//div[contains(@class, 'formContainer')]/following-sibling::button[contains(., 'Login')][1]",
            "//div[contains(., 'Account:')]/ancestor::div[contains(@class, 'formContainer')]/following-sibling::button[contains(., 'Login')][1]",
            "//div[contains(., 'Account:')]/ancestor::div[contains(@class, 'form')]//button[.//span[normalize-space()='Login']]",
            "//div[contains(@class, 'formContainer')]/following-sibling::button[contains(., '로그인')][1]",
            "//div[contains(., '계정:')]/ancestor::div[contains(@class, 'formContainer')]/following-sibling::button[contains(., '로그인')][1]",
            "//div[contains(., '계정:')]/ancestor::div[contains(@class, 'form')]//button[.//span[normalize-space()='로그인']]",
            "//button[.//span[normalize-space()='로그인'] and not(.//span[normalize-space()='로그아웃'])][1]",
            "(//button[contains(., '로그인') and not(contains(., '로그아웃'))])[1]",
            "(//button[contains(., 'Login') and not(contains(., 'LOG IN WITH AN IN-GAME ACCOUNT'))])[last()]",
            "(//button[contains(., '로그인')])[last()]",
        ])
        if saved_login_button is None:
            return False

        try:
            self.driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", saved_login_button)
            ActionChains(self.driver).move_to_element(saved_login_button).pause(0.6).click().perform()
            time.sleep(6)
            return True
        except Exception:
            return False

    def perform_yostar_login(self) -> None:
        login_id = str(
            self.config.get("yostar_login_id") or self.config.get("google_login_email") or ""
        ).strip()
        mail_password = str(
            self.config.get("yostar_mail_password")
            or self.config.get("yostar_login_password")
            or self.config.get("google_login_password")
            or ""
        ).strip()

        yostar_tab = self.find_first_xpath([
            "//button[contains(., 'YOSTAR ID')]",
            "//a[contains(., 'YOSTAR ID')]",
            "//span[contains(., 'YOSTAR ID')]/ancestor::button[1]",
            "//span[contains(., 'YOSTAR ID')]/ancestor::a[1]",
        ])
        if yostar_tab is not None:
            yostar_tab.click()
            time.sleep(1)

        if self.is_saved_account_login_visible():
            self.saved_account_login_started = True
            if self.click_saved_account_login():
                self.saved_account_login_attempted_at = time.time()
                return

        id_input = self.find_first_css([
            "input[type='email']",
            "input[name*='email']",
            "input[name*='id']",
            "input[placeholder*='YOSTAR']",
            "input[placeholder*='ID']",
            "input[autocomplete='username']",
            "input[type='text']",
        ])
        if id_input is None:
            self.dump_debug_artifacts("yostar_id_input_missing")
            raise RuntimeError("이메일 주소 입력창을 찾지 못했습니다.")

        code_input = self.find_first_css([
            "input[placeholder*='?몄쬆肄붾뱶']",
            "input[maxlength='6']",
            "input.wrapper_has-extra",
        ])
        if code_input is None:
            self.dump_debug_artifacts("yostar_password_input_missing")
            raise RuntimeError("인증코드 입력창을 찾지 못했습니다.")

        id_input.click()
        id_input.send_keys(Keys.CONTROL, "a")
        id_input.send_keys(Keys.DELETE)
        id_input.send_keys(login_id)

        send_code_button = self.find_first_xpath([
            "//div[contains(@class, '_send-code') and contains(., '발송')]",
            "//div[contains(., '발송')]",
            "//button[contains(., '발송')]",
            "//span[contains(., '발송')]/ancestor::*[self::button or self::div][1]",
        ])
        if send_code_button is None:
            self.dump_debug_artifacts("yostar_send_code_missing")
            raise RuntimeError("인증코드 발송 버튼을 찾지 못했습니다.")

        before_uids = self.fetch_recent_mail_uids()
        send_code_button.click()
        time.sleep(2)

        code = self.wait_for_mail_code(
            email_address=login_id,
            password=mail_password,
            baseline_uids=before_uids,
        )

        code_input.click()
        code_input.send_keys(Keys.CONTROL, "a")
        code_input.send_keys(Keys.DELETE)
        code_input.send_keys(code)

        submit_button = self.find_first_css([
            "#web-sdk-root ._submit_1vn1z_197",
            "#web-sdk-root .cp-button.cp-button_confirm._submit_1vn1z_197",
        ])
        if submit_button is not None:
            self.driver.execute_script("arguments[0].click();", submit_button)
        else:
            code_input.send_keys(Keys.ENTER)

        time.sleep(5)

    def fetch_recent_mail_uids(self) -> List[bytes]:
        host = str(self.config.get("yostar_mail_imap_host") or "imap.gmail.com").strip()
        email_address = str(
            self.config.get("yostar_mail_email")
            or self.config.get("yostar_login_id")
            or self.config.get("google_login_email")
            or ""
        ).strip()
        password = str(
            self.config.get("yostar_mail_password")
            or self.config.get("yostar_login_password")
            or self.config.get("google_login_password")
            or ""
        ).strip()

        if not email_address or not password:
            return []

        mail = imaplib.IMAP4_SSL(host)
        mail.login(email_address, password)
        mail.select("INBOX")
        _, data = mail.uid("search", None, "ALL")
        mail.logout()
        return [uid for uid in data[0].split() if uid]

    def wait_for_mail_code(self, email_address: str, password: str, baseline_uids: List[bytes]) -> str:
        host = str(self.config.get("yostar_mail_imap_host") or "imap.gmail.com").strip()
        timeout_seconds = int(self.config.get("yostar_mail_timeout_seconds", 120))
        poll_interval_seconds = int(self.config.get("yostar_mail_poll_interval_seconds", 5))
        baseline_set = set(baseline_uids or [])
        deadline = time.time() + timeout_seconds

        last_error: Optional[Exception] = None
        while time.time() < deadline:
            try:
                mail = imaplib.IMAP4_SSL(host)
                mail.login(email_address, password)
                mail.select("INBOX")
                _, data = mail.uid("search", None, "ALL")
                uids = [uid for uid in data[0].split() if uid]
                new_uids = [uid for uid in uids if uid not in baseline_set][-10:]

                for uid in reversed(new_uids):
                    _, msg_data = mail.uid("fetch", uid, "(RFC822)")
                    if not msg_data or not msg_data[0]:
                        continue
                    raw_email = msg_data[0][1]
                    message = message_from_bytes(raw_email)
                    parsed_text = self.extract_mail_text(message)
                    code = self.extract_verification_code(parsed_text)
                    if code:
                        mail.logout()
                        logging.info("이메일 인증코드 수신 완료")
                        return code

                mail.logout()
            except Exception as error:
                last_error = error
                logging.warning("이메일 인증코드 확인 중 오류: %s", error)

            time.sleep(poll_interval_seconds)

        if last_error:
            raise RuntimeError(
                "이메일 인증코드를 가져오지 못했습니다. Gmail IMAP 또는 앱 비밀번호 설정을 확인해주세요."
            ) from last_error
        raise RuntimeError("?대찓???몄쬆肄붾뱶媛 ?꾩갑?섏? ?딆븯?듬땲??")

    def extract_mail_text(self, message) -> str:
        subject = str(make_header(decode_header(message.get("Subject", ""))))
        sender = str(make_header(decode_header(message.get("From", ""))))
        parts: List[str] = [subject, sender]

        if message.is_multipart():
            for part in message.walk():
                content_type = part.get_content_type()
                disposition = str(part.get("Content-Disposition", ""))
                if "attachment" in disposition.lower():
                    continue
                try:
                    payload = part.get_payload(decode=True)
                except Exception:
                    payload = None
                if not payload:
                    continue
                charset = part.get_content_charset() or "utf-8"
                try:
                    decoded = payload.decode(charset, errors="ignore")
                except Exception:
                    decoded = payload.decode("utf-8", errors="ignore")
                if content_type == "text/html":
                    decoded = re.sub(r"<[^>]+>", " ", decoded)
                parts.append(decoded)
        else:
            payload = message.get_payload(decode=True)
            if payload:
                charset = message.get_content_charset() or "utf-8"
                try:
                    decoded = payload.decode(charset, errors="ignore")
                except Exception:
                    decoded = payload.decode("utf-8", errors="ignore")
                parts.append(decoded)

        return "\n".join(parts)

    def extract_verification_code(self, text: str) -> str:
        patterns = [
            r"\b(\d{6})\b",
            r"?몄쬆肄붾뱶[^0-9]*(\d{6})",
            r"verification[^0-9]*(\d{6})",
            r"code[^0-9]*(\d{6})",
        ]
        for pattern in patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                return match.group(1)
        return ""

    def load_users(self) -> List[Dict[str, Any]]:
        snapshot = self.db.collection("users").stream()
        users: List[Dict[str, Any]] = []
        for doc in snapshot:
            data = doc.to_dict() or {}
            users.append(
                {
                    "doc_id": doc.id,
                    "ref": doc.reference,
                    "uid": data.get("uid", ""),
                    "characterName": data.get("characterName", doc.id),
                    "nickname": data.get("nickname", ""),
                    "friendCode": re.sub(r"\D", "", str(data.get("friendCode", ""))),
                    "factionName": str(data.get("factionName", "")).strip(),
                    "teamEnrollmentStatus": str(data.get("teamEnrollmentStatus", "")).strip(),
                    "teamEnrollmentByContest": data.get("teamEnrollmentByContest", {}) or {},
                }
            )
        return users

    def sync_team_members(self, contest: ContestConfig, users: List[Dict[str, Any]]) -> None:
        logging.info("팀 등록 동기화 시작: %s", contest.name)
        self.driver.get(contest.team_manager_url)
        time.sleep(4)

        for user in users:
            friend_code = user["friendCode"]
            faction_name = user["factionName"]

            if not friend_code:
                self.update_team_status(
                    user["ref"],
                    contest.key,
                    "invalid-friend-code",
                    "친구코드가 비어 있거나 숫자가 아닙니다. 수정해주세요.",
                )
                continue

            if faction_name not in FACTIONS:
                self.update_team_status(
                    user["ref"],
                    contest.key,
                    "invalid-faction",
                    "파벌 이름이 올바르지 않습니다. 수정해주세요.",
                )
                continue

            if self.is_already_in_team(user):
                self.update_team_status(user["ref"], contest.key, "registered", "이미 팀에 등록되어 있어 건너뛰었습니다.")
                continue

            try:
                added = self.try_add_team_member(faction_name, user)
                if added:
                    self.update_team_status(user["ref"], contest.key, "registered", "팀 등록을 완료했습니다.")
                else:
                    self.update_team_status(
                        user["ref"],
                        contest.key,
                        "invalid-friend-code",
                        "친구코드가 잘못 등록되어 있습니다. 수정해주세요.",
                    )
            except Exception as error:
                logging.exception("팀 등록 처리 중 오류: %s", error)
                self.update_team_status(
                    user["ref"],
                    contest.key,
                    "error",
                    f"팀 등록 처리 중 오류가 발생했습니다: {error}",
                )

    def is_already_in_team(self, user: Dict[str, Any]) -> bool:
        page_text = self.driver.page_source
        for pattern in TEAM_EXISTING_MEMBER_PATTERNS:
            value = pattern.format(
                friend_code=user["friendCode"],
                nickname=user["nickname"],
                character_name=user["characterName"],
            ).strip()
            if value and value in page_text:
                return True
        return False

    def try_add_team_member(self, faction_name: str, user: Dict[str, Any]) -> bool:
        panel = self.find_faction_panel(faction_name)
        if panel is None:
            raise RuntimeError(f"파벌 패널을 찾지 못했습니다: {faction_name}")

        add_button = self.find_descendant_xpath(panel, TEAM_ADD_BUTTON_XPATHS)
        if add_button is None:
            raise RuntimeError(f"팀원 추가 버튼을 찾지 못했습니다: {faction_name}")
        add_button.click()
        time.sleep(1.5)

        modal = self.find_first_css([
            ".ant-modal-wrap .ant-modal",
            ".ant-modal-root .ant-modal",
        ])
        if modal is None:
            self.dump_debug_artifacts("team_modal_missing")
            raise RuntimeError("팀원 추가 모달을 찾지 못했습니다.")

        search_input = None
        for css in [
            ".ant-modal-body textarea.ant-input",
            ".ant-modal-body textarea",
            "textarea.ant-input",
            "textarea",
        ]:
            try:
                elements = modal.find_elements(By.CSS_SELECTOR, css)
                for element in elements:
                    if element.get_attribute("readonly"):
                        continue
                    search_input = element
                    break
                if search_input is not None:
                    break
            except Exception:
                continue

        if search_input is None:
            self.dump_debug_artifacts("team_search_selector_missing")
            raise RuntimeError("친구코드 검색 입력 영역을 찾지 못했습니다.")

        self.driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", search_input)
        self.driver.execute_script("arguments[0].click();", search_input)
        search_input.send_keys(Keys.CONTROL, "a")
        search_input.send_keys(Keys.DELETE)
        search_input.send_keys(str(user["friendCode"]))
        time.sleep(0.6)

        search_button = self.find_descendant_xpath(modal, TEAM_SEARCH_BUTTON_XPATHS)
        if search_button is not None:
            search_clicked = False
            for click_mode in ("normal", "js", "actions"):
                try:
                    if click_mode == "normal":
                        search_button.click()
                    elif click_mode == "js":
                        self.driver.execute_script("arguments[0].click();", search_button)
                    else:
                        ActionChains(self.driver).move_to_element(search_button).pause(0.2).click(search_button).perform()
                    search_clicked = True
                    break
                except Exception:
                    continue
            if not search_clicked:
                logging.warning("팀 검색 버튼 클릭에 실패해 Enter 키로 대체합니다. friendCode=%s", user["friendCode"])
                search_input.send_keys(Keys.ENTER)
        else:
            search_input.send_keys(Keys.ENTER)

        success_text = ""
        failure_text = ""
        disabled = True
        add_button = None
        wait_started = time.time()
        while time.time() - wait_started < 10:
            success_area = None
            failure_area = None
            try:
                textareas = modal.find_elements(By.CSS_SELECTOR, ".ant-modal-body textarea")
                if len(textareas) >= 2:
                    success_area = textareas[1]
                if len(textareas) >= 3:
                    failure_area = textareas[2]
            except Exception:
                pass

            success_text = (success_area.get_attribute("value") if success_area is not None else "") or ""
            failure_text = (failure_area.get_attribute("value") if failure_area is not None else "") or ""

            add_button = self.find_descendant_xpath(modal, TEAM_RESULT_ADD_BUTTON_XPATHS)
            disabled = True
            if add_button is not None:
                try:
                    disabled = self.driver.execute_script(
                        """
                        const button = arguments[0];
                        return button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true';
                        """,
                        add_button,
                    )
                except Exception:
                    disabled = False

            if failure_text.strip() or success_text.strip() or (add_button is not None and not disabled):
                break

            time.sleep(0.4)

        if add_button is None:
            logging.warning(
                "팀 검색 후 추가 버튼을 찾지 못했습니다. friendCode=%s success=%r failure=%r",
                user["friendCode"],
                success_text.strip(),
                failure_text.strip(),
            )
            self.dump_debug_artifacts("team_search_no_add_button")
            return False

        if failure_text.strip() and not success_text.strip():
            logging.warning(
                "팀 검색 실패 텍스트가 감지되었습니다. friendCode=%s failure=%r",
                user["friendCode"],
                failure_text.strip(),
            )
            return False

        if disabled and not success_text.strip():
            logging.warning(
                "팀 검색 결과가 비어 있거나 추가 버튼이 활성화되지 않았습니다. friendCode=%s success=%r failure=%r",
                user["friendCode"],
                success_text.strip(),
                failure_text.strip(),
            )
            self.dump_debug_artifacts("team_search_no_result")
            return False

        try:
            add_button.click()
        except Exception:
            self.driver.execute_script("arguments[0].click();", add_button)
        time.sleep(2)
        return True

    def find_faction_panel(self, faction_name: str):
        for xpath in [
            f"//*[contains(text(), '{faction_name}')]/ancestor::*[self::div or self::section][1]",
            f"//*[contains(text(), '{faction_name}')]/ancestor::*[self::div or self::section][2]",
        ]:
            try:
                return self.driver.find_element(By.XPATH, xpath)
            except Exception:
                continue
        return None

    def find_search_result_row(self, friend_code: str):
        source = self.driver.page_source
        if friend_code not in source:
            return None

        for selector in TEAM_RESULT_ROW_SELECTORS:
            try:
                rows = self.driver.find_elements(By.CSS_SELECTOR, selector)
            except Exception:
                rows = []
            for row in rows:
                if friend_code in row.text:
                    return row
        return None

    def sync_match_results(self, contest: ContestConfig) -> None:
        logging.info("대국 결과 동기화 시작: %s", contest.name)
        self.driver.get(contest.record_url)
        time.sleep(6)
        rows = self.extract_record_rows(contest.player_count)
        inserted = 0
        skipped = 0

        if not rows:
            self.dump_debug_artifacts(f"match_rows_empty_{contest.key}")

        for row in rows:
            doc_id = self.build_match_doc_id(contest.key, row["createdAtText"])
            doc_ref = self.db.collection("match-results").document(doc_id)
            if doc_ref.get().exists:
                skipped += 1
                continue

            doc_ref.set(
                {
                    "mode": contest.key,
                    "contestName": contest.name,
                    "sourceUrl": contest.record_url,
                    "createdAtText": row["createdAtText"],
                    "createdAt": row["createdAt"],
                    "ranks": row["ranks"],
                    "playerCount": contest.player_count,
                    "scrapedAt": firestore.SERVER_TIMESTAMP,
                }
            )
            inserted += 1

        logging.info("대국 결과 동기화 완료: contest=%s inserted=%s skipped=%s", contest.name, inserted, skipped)

    def extract_record_rows(self, player_count: int) -> List[Dict[str, Any]]:
        html = self.driver.page_source
        soup = BeautifulSoup(html, "html.parser")

        tbody = soup.select_one("tbody.ant-table-tbody") or soup.select_one("tbody")
        if tbody is None:
            logging.warning("대국 결과 테이블을 찾지 못했습니다.")
            self.dump_debug_artifacts(f"match_table_missing_{player_count}p")
            return []

        items: List[Dict[str, Any]] = []
        for tr in tbody.select("tr"):
            if "placeholder" in " ".join(tr.get("class", [])):
                continue

            cells = tr.select("td")
            if len(cells) < 4:
                continue

            created_at_text = self.extract_datetime_text(cells)
            if not created_at_text:
                continue

            ranks = self.extract_rank_pairs(cells, player_count)
            if len(ranks) < player_count:
                continue

            created_at = self.parse_created_at(created_at_text)
            items.append(
                {
                    "createdAtText": created_at_text,
                    "createdAt": created_at,
                    "ranks": ranks[:player_count],
                }
            )

        return items

    def extract_datetime_text(self, cells) -> str:
        for cell in cells:
            text = " ".join(cell.get_text("\n", strip=True).split())
            match = re.search(r"\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}", text)
            if match:
                return match.group(0)
        return ""

    def extract_rank_pairs(self, cells, player_count: int) -> List[Dict[str, Any]]:
        pairs: List[Dict[str, Any]] = []
        for cell in cells[2:]:
            tags = [tag.get_text(" ", strip=True) for tag in cell.select(".ant-tag")]
            normalized = [item for item in tags if item]
            if len(normalized) >= 2:
                pairs.append(
                    {
                        "nickname": normalized[0],
                        "score": self.parse_score(normalized[1]),
                    }
                )
            if len(pairs) >= player_count:
                break
        return pairs

    def parse_score(self, value: str) -> int:
        numbers = re.sub(r"[^\d-]", "", str(value))
        return int(numbers or "0")

    def parse_created_at(self, created_at_text: str):
        try:
            return datetime.strptime(created_at_text, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            return firestore.SERVER_TIMESTAMP

    def build_match_doc_id(self, mode: str, created_at_text: str) -> str:
        safe = re.sub(r"[^0-9A-Za-z_-]", "-", created_at_text)
        return f"{mode}_{safe}"

    def update_team_status(self, user_ref, contest_key: str, status: str, message: str) -> None:
        user_ref.set(
            {
                "teamEnrollmentStatus": status,
                "teamEnrollmentMessage": message,
                "teamEnrollmentUpdatedAt": firestore.SERVER_TIMESTAMP,
                "teamEnrollmentByContest": {
                    contest_key: {
                        "status": status,
                        "message": message,
                        "updatedAt": firestore.SERVER_TIMESTAMP,
                    }
                },
            },
            merge=True,
        )

    def is_record_table_visible(self) -> bool:
        for selector in RECORD_ROW_SELECTORS:
            try:
                if self.driver.find_elements(By.CSS_SELECTOR, selector):
                    return True
            except Exception:
                continue
        return False

    def is_logged_in_surface_visible(self) -> bool:
        if self.is_record_table_visible():
            return True

        try:
            if "contest_dashboard" in (self.driver.current_url or ""):
                top_bar = self.find_first_xpath([
                    "//*[contains(., '대회 목록')]",
                    "//*[contains(., '작혼 대회 관리 페이지')]",
                    "//*[contains(., '공식 공지')]",
                    "//*[contains(., '我的赛事')]",
                    "//*[contains(., '官方公告')]",
                    "//*[contains(., '雀魂赛事管理后台')]",
                    "//button[contains(., '로그아웃')]",
                    "//*[contains(., '로그아웃')]",
                ])
                if top_bar is not None:
                    return True
        except Exception:
            return False

        return False

    def find_first_css(self, selectors: List[str]):
        for selector in selectors:
            try:
                element = self.driver.find_element(By.CSS_SELECTOR, selector)
                if element:
                    return element
            except Exception:
                continue
        return None

    def find_first_xpath(self, xpaths: List[str]):
        for xpath in xpaths:
            try:
                element = self.driver.find_element(By.XPATH, xpath)
                if element:
                    return element
            except Exception:
                continue
        return None

    def find_descendant_xpath(self, root, xpaths: List[str]):
        for xpath in xpaths:
            try:
                element = root.find_element(By.XPATH, xpath)
                if element:
                    return element
            except Exception:
                continue
        return None

    def dump_debug_artifacts(self, prefix: str) -> None:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe_prefix = re.sub(r"[^0-9A-Za-z_-]", "_", prefix)
        html_path = os.path.join(DEBUG_DIR, f"{safe_prefix}_{timestamp}.html")
        screenshot_path = os.path.join(DEBUG_DIR, f"{safe_prefix}_{timestamp}.png")

        try:
            with open(html_path, "w", encoding="utf-8") as file:
                file.write(self.driver.page_source)
            logging.info("디버그 HTML 저장: %s", html_path)
        except Exception as error:
            logging.warning("디버그 HTML 저장 실패: %s", error)

        try:
            self.driver.save_screenshot(screenshot_path)
            logging.info("디버그 스크린샷 저장: %s", screenshot_path)
        except Exception as error:
            logging.warning("디버그 스크린샷 저장 실패: %s", error)


def main() -> None:
    configure_logging()
    config = load_config()
    crawler = DuebaCrawler(config)
    run_once = "--once" in sys.argv
    poll_interval_seconds = int(config.get("poll_interval_seconds", 300))

    try:
        if run_once:
            crawler.run_once()
            return

        while True:
            try:
                crawler.run_once()
            except Exception as error:
                logging.exception("?щ·???ㅽ뻾 以??ㅻ쪟: %s", error)
            time.sleep(poll_interval_seconds)
    finally:
        crawler.close()


if __name__ == "__main__":
    main()

