import base64
import datetime as dt
import html
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import List
import cv2
import numpy as np

from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class TelegramNotifier: 
    def __init__(self):
        self._lock = threading.Lock()
        self._last_sent_at = {}
        self._face_cascade = self._load_face_cascade()
        self._last_delivery_status = {
            "ok": None,
            "method": None,
            "chat_id": None,
            "error": None,
            "response": None,
            "timestamp": None,
        }
        self._cleanup_counter = 0
        self._validate_and_log_config()

    def _load_face_cascade(self):
        cascade_path = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
        cascade = cv2.CascadeClassifier(cascade_path)
        if cascade.empty():
            logger.warning("[TELEGRAM] Haar cascade wajah tidak tersedia, blur dinonaktifkan")
            return None
        return cascade

    def _validate_and_log_config(self):
        token = self._get_bot_token()
        chat_ids = self._get_chat_ids()

        if not token:
            logger.warning("[TELEGRAM] TELEGRAM_BOT_TOKEN tidak ditemukan di .env")
        elif not self._validate_token_format(token):
            logger.error("[TELEGRAM] Format TELEGRAM_BOT_TOKEN tidak valid")
        else:
            logger.info(f"[TELEGRAM] Bot token valid ({len(token)} chars)")

        if not chat_ids:
            logger.warning("[TELEGRAM] TELEGRAM_CHAT_IDS tidak ditemukan di .env")
        else:
            logger.info(f"[TELEGRAM] {len(chat_ids)} chat ID(s) ditemukan")

    def _validate_token_format(self, token: str) -> bool:
        return ":" in token and len(token.split(":")) == 2

    def _cleanup_cooldowns(self):
        self._cleanup_counter += 1
        if self._cleanup_counter < 100:
            return

        now = dt.datetime.now()
        with self._lock:
            keys_to_remove = [
                key for key, value in self._last_sent_at.items()
                if (now - value).total_seconds() > 3600
            ]
            for key in keys_to_remove:
                del self._last_sent_at[key]
        self._cleanup_counter = 0

    def _get_bot_token(self) -> str:
        token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
        if token and not self._validate_token_format(token):
            logger.error("[TELEGRAM] Format token tidak valid")
            return ""
        return token

    def _get_chat_ids(self) -> List[str]:
        raw_chat_ids = os.getenv("TELEGRAM_CHAT_IDS", "").strip()
        if not raw_chat_ids:
            return []

        valid_ids = []
        for chat_id in [item.strip() for item in raw_chat_ids.split(",") if item.strip()]:
            if chat_id.lstrip("-").isdigit():
                valid_ids.append(chat_id)
            else:
                logger.warning(f"[TELEGRAM] Chat ID tidak valid: {chat_id}")
        return valid_ids

    def _build_url(self, method: str) -> str:
        return f"https://api.telegram.org/bot{self._get_bot_token()}/{method}"

    def _send_request(self, method: str, payload, headers, max_retries: int = 2) -> bool:
        chat_ids = self._get_chat_ids()
        if not self._get_bot_token() or not chat_ids:
            self._last_delivery_status = {
                "ok": False,
                "method": method,
                "chat_id": None,
                "error": "Telegram bot token atau chat id belum dikonfigurasi.",
                "response": None,
                "timestamp": dt.datetime.now().isoformat(),
            }
            return False

        success = True
        for chat_id in chat_ids:
            sent_successfully = False
            last_error = None

            for attempt in range(max_retries):
                try:
                    request = urllib.request.Request(
                        self._build_url(method),
                        data=payload(chat_id) if callable(payload) else payload,
                        headers=headers(chat_id) if callable(headers) else headers,
                        method="POST",
                    )
                    with urllib.request.urlopen(request, timeout=10) as response:
                        response_body = response.read().decode("utf-8")
                        result = json.loads(response_body)
                        if result.get("ok"):
                            self._last_delivery_status = {
                                "ok": True,
                                "method": method,
                                "chat_id": chat_id,
                                "error": None,
                                "response": result,
                                "timestamp": dt.datetime.now().isoformat(),
                            }
                            sent_successfully = True
                            break
                        last_error = result.get("description", "Unknown error")
                except urllib.error.HTTPError as error:
                    last_error = f"HTTP {error.code}"
                    try:
                        error_body = error.read().decode("utf-8")
                        error_data = json.loads(error_body)
                        last_error = error_data.get("description", last_error)
                    except Exception:
                        pass
                except (urllib.error.URLError, TimeoutError):
                    last_error = "Network error"
                except json.JSONDecodeError:
                    last_error = "Invalid JSON response"

                if attempt < max_retries - 1 and not sent_successfully:
                    time.sleep(2 ** attempt)

            if not sent_successfully:
                success = False
                self._last_delivery_status = {
                    "ok": False,
                    "method": method,
                    "chat_id": chat_id,
                    "error": last_error or "Unknown error",
                    "response": None,
                    "timestamp": dt.datetime.now().isoformat(),
                }

        self._cleanup_cooldowns()
        return success

    def is_configured(self) -> bool:
        return bool(self._get_bot_token() and self._get_chat_ids())

    def get_chat_ids(self) -> list[str]:
        return self._get_chat_ids()

    def get_config_status(self) -> dict:
        token = self._get_bot_token()
        chat_ids = self._get_chat_ids()
        return {
            "configured": bool(token and chat_ids),
            "has_token": bool(token),
            "chat_ids_count": len(chat_ids),
            "chat_ids": chat_ids,
            "token_preview": f"{token[:6]}...{token[-4:]}" if len(token) >= 10 else "",
            "last_delivery_status": self._last_delivery_status,
        }

    def send_message(self, message: str) -> bool:
        if not self.is_configured():
            return False

        def payload(chat_id: str) -> bytes:
            return urllib.parse.urlencode(
                {
                    "chat_id": chat_id,
                    "text": message,
                    "parse_mode": "HTML",
                }
            ).encode("utf-8")

        headers = {"Content-Type": "application/x-www-form-urlencoded"}
        return self._send_request("sendMessage", payload, headers)

    def send_photo(self, photo_bytes: bytes, caption: str) -> bool:
        if not self.is_configured() or not photo_bytes:
            return False

        boundary = "----K3VisionTelegramBoundary"

        def payload(chat_id: str) -> bytes:
            parts = [
                f"--{boundary}\r\n".encode("utf-8"),
                b'Content-Disposition: form-data; name="chat_id"\r\n\r\n',
                chat_id.encode("utf-8"),
                b"\r\n",
                f"--{boundary}\r\n".encode("utf-8"),
                b'Content-Disposition: form-data; name="caption"\r\n\r\n',
                caption.encode("utf-8"),
                b"\r\n",
                f"--{boundary}\r\n".encode("utf-8"),
                b'Content-Disposition: form-data; name="parse_mode"\r\n\r\n',
                b"HTML",
                b"\r\n",
                f"--{boundary}\r\n".encode("utf-8"),
                b'Content-Disposition: form-data; name="photo"; filename="alert.jpg"\r\n',
                b"Content-Type: image/jpeg\r\n\r\n",
                photo_bytes,
                b"\r\n",
                f"--{boundary}--\r\n".encode("utf-8"),
            ]
            return b"".join(parts)

        def headers(_: str) -> dict[str, str]:
            return {"Content-Type": f"multipart/form-data; boundary={boundary}"}

        return self._send_request("sendPhoto", payload, headers)

    def _blur_faces(self, photo_bytes: bytes) -> bytes:
        if not photo_bytes or self._face_cascade is None:
            return photo_bytes

        image_array = np.frombuffer(photo_bytes, dtype=np.uint8)
        image = cv2.imdecode(image_array, cv2.IMREAD_COLOR)
        if image is None:
            return photo_bytes

        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        faces = self._face_cascade.detectMultiScale(
            gray,
            scaleFactor=1.1,
            minNeighbors=5,
            minSize=(30, 30),
        )

        for (x, y, w, h) in faces:
            pad_w = int(w * 0.15)
            pad_h = int(h * 0.20)
            x1 = max(0, x - pad_w)
            y1 = max(0, y - pad_h)
            x2 = min(image.shape[1], x + w + pad_w)
            y2 = min(image.shape[0], y + h + pad_h)

            face_region = image[y1:y2, x1:x2]
            if face_region.size == 0:
                continue

            blurred = cv2.GaussianBlur(face_region, (51, 51), 30)
            image[y1:y2, x1:x2] = blurred

        success, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if not success:
            return photo_bytes
        return encoded.tobytes()

    def send_alert(
        self,
        caption: str,
        annotated_base64: str | None = None,
        blur_faces: bool = False,
    ) -> bool:
        if annotated_base64:
            try:
                photo_bytes = base64.b64decode(annotated_base64)
            except (ValueError, TypeError):
                photo_bytes = b""

            if blur_faces and photo_bytes:
                photo_bytes = self._blur_faces(photo_bytes)

            if photo_bytes and self.send_photo(photo_bytes, caption):
                return True

        return self.send_message(caption)

    def get_updates(self) -> list[dict]:
        token = self._get_bot_token()
        if not token:
            return []

        request = urllib.request.Request(self._build_url("getUpdates"), method="GET")
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                response_body = response.read().decode("utf-8")
                result = json.loads(response_body)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            return []

        if not result.get("ok"):
            return []
        return result.get("result", [])

    def extract_chat_ids_from_updates(self) -> list[dict]:
        updates = self.get_updates()
        discovered = {}

        for item in updates:
            message = item.get("message") or item.get("edited_message") or {}
            chat = message.get("chat") or {}
            chat_id = chat.get("id")
            if chat_id is None:
                continue
            discovered[str(chat_id)] = {
                "chat_id": str(chat_id),
                "type": chat.get("type", ""),
                "title": chat.get("title") or chat.get("username") or chat.get("first_name") or "Unknown",
            }

        return list(discovered.values())

    def send_message_with_cooldown(
        self,
        cooldown_key: str,
        message: str,
        cooldown_seconds: int,
        annotated_base64: str | None = None,
    ) -> bool:
        now = dt.datetime.now()

        with self._lock:
            last_sent_at = self._last_sent_at.get(cooldown_key)
            if last_sent_at and (now - last_sent_at).total_seconds() < cooldown_seconds:
                return False

            sent = self.send_alert(message, annotated_base64=annotated_base64)
            if sent:
                self._last_sent_at[cooldown_key] = now
            return sent

    @staticmethod
    def format_missing_ppe(ppe_status: dict) -> list[str]:
        missing = []
        if not ppe_status.get("helmet"):
            missing.append("Helm")
        if not ppe_status.get("vest"):
            missing.append("Rompi")
        if not ppe_status.get("boots"):
            missing.append("Sepatu")
        return missing

    @staticmethod
    def _format_bool_label(value: bool) -> str:
        return "Lengkap" if value else "Tidak"

    def build_attendance_caption(self, worker_name: str, ppe_status: dict, timestamp: str) -> str:
        safe_name = html.escape(worker_name)
        missing = self.format_missing_ppe(ppe_status)
        missing_text = ", ".join(missing) if missing else "-"
        return (
            "<b>ALERT ABSENSI K3VISION</b>\n"
            "<b>Status:</b> Absensi ditolak\n"
            f"<b>Pekerja:</b> {safe_name}\n"
            f"<b>APD Kurang:</b> {html.escape(missing_text)}\n"
            f"<b>Helm:</b> {self._format_bool_label(bool(ppe_status.get('helmet')))}\n"
            f"<b>Rompi:</b> {self._format_bool_label(bool(ppe_status.get('vest')))}\n"
            f"<b>Sepatu:</b> {self._format_bool_label(bool(ppe_status.get('boots')))}\n"
            f"<b>Waktu:</b> {html.escape(timestamp)}"
        )

    def build_monitoring_caption(self, ppe_status: dict, timestamp: str, source_label: str) -> str:
        missing = self.format_missing_ppe(ppe_status)
        missing_text = ", ".join(missing) if missing else "-"
        return (
            "<b>ALERT MONITORING K3VISION</b>\n"
            "<b>Status:</b> APD tidak lengkap terdeteksi\n"
            f"<b>Sumber:</b> {html.escape(source_label)}\n"
            f"<b>APD Kurang:</b> {html.escape(missing_text)}\n"
            f"<b>Helm:</b> {self._format_bool_label(bool(ppe_status.get('helmet')))}\n"
            f"<b>Rompi:</b> {self._format_bool_label(bool(ppe_status.get('vest')))}\n"
            f"<b>Sepatu:</b> {self._format_bool_label(bool(ppe_status.get('boots')))}\n"
            f"<b>Waktu:</b> {html.escape(timestamp)}"
        )

    def notify_attendance_rejected(self, worker_name: str, ppe_status: dict, timestamp: str) -> bool:
        missing = self.format_missing_ppe(ppe_status)
        if not missing:
            return False

        caption = self.build_attendance_caption(worker_name, ppe_status, timestamp)
        return self.send_alert(
            caption,
            annotated_base64=ppe_status.get("annotated_base64"),
            blur_faces=True,
        )

    def notify_monitoring_incomplete_ppe(
        self,
        ppe_status: dict,
        cooldown_seconds: int = 60,
        source_label: str = "Area Monitoring",
    ) -> bool:
        if not ppe_status.get("person_detected"):
            return False

        missing = self.format_missing_ppe(ppe_status)
        if not missing:
            return False

        timestamp = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        caption = self.build_monitoring_caption(ppe_status, timestamp, source_label)
        cooldown_key = f"monitoring:{source_label}:{'-'.join(missing)}"
        return self.send_message_with_cooldown(
            cooldown_key,
            caption,
            cooldown_seconds,
            annotated_base64=ppe_status.get("annotated_base64"),
        )


telegram_notifier = TelegramNotifier()
