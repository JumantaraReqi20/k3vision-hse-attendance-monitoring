import datetime as dt
import logging
import os
import threading
import time

import cv2
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from ppe_detector import ppe_det
from telegram_notifier import telegram_notifier

router = APIRouter()
logger = logging.getLogger(__name__)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except ValueError:
        return default


class LocalCameraMonitor:
    def __init__(self):
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._running = False
        self._state = {
            "running": False,
            "camera_count": 0,
            "last_update": None,
            "latest_alert": None,
            "recent_events": [],
            "cameras": [],
        }
        self.max_cameras = _env_int("LOCAL_MONITOR_MAX_CAMERAS", 6)
        self.interval_seconds = _env_float("LOCAL_MONITOR_INTERVAL_SECONDS", 4.0)
        self.alert_cooldown_seconds = _env_int("LOCAL_MONITOR_ALERT_COOLDOWN_SECONDS", 60)

    def _camera_backend(self):
        if os.name == "nt" and hasattr(cv2, "CAP_DSHOW"):
            return cv2.CAP_DSHOW
        return cv2.CAP_ANY

    def _scan_camera_indexes(self) -> list[dict]:
        cameras = []
        backend = self._camera_backend()

        for index in range(self.max_cameras):
            capture = cv2.VideoCapture(index, backend)
            try:
                if not capture.isOpened():
                    continue

                ok, frame = capture.read()
                if not ok or frame is None:
                    continue

                height, width = frame.shape[:2]
                cameras.append(
                    {
                        "index": index,
                        "label": f"Camera {index + 1}",
                        "resolution": f"{width}x{height}",
                    }
                )
            finally:
                capture.release()

        return cameras

    def _encode_frame(self, frame):
        success, buffer = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if not success:
            return None
        return buffer.tobytes()

    def _capture_and_infer(self, camera_info: dict) -> dict:
        index = camera_info["index"]
        backend = self._camera_backend()
        capture = cv2.VideoCapture(index, backend)
        timestamp = dt.datetime.now().isoformat()

        if not capture.isOpened():
            capture.release()
            return {
                "index": index,
                "label": camera_info["label"],
                "resolution": camera_info.get("resolution", ""),
                "connected": False,
                "timestamp": timestamp,
                "person_detected": False,
                "warning": "",
                "telegram_alert_sent": False,
                "ppe_status": {
                    "person_detected": False,
                    "helmet": False,
                    "vest": False,
                    "boots": False,
                    "boxes": [],
                    "annotated_base64": None,
                    "error": "Camera not available",
                },
                "boxes": [],
                "annotated_frame": None,
            }

        try:
            ok, frame = capture.read()
        finally:
            capture.release()

        if not ok or frame is None:
            return {
                "index": index,
                "label": camera_info["label"],
                "resolution": camera_info.get("resolution", ""),
                "connected": False,
                "timestamp": timestamp,
                "person_detected": False,
                "warning": "",
                "telegram_alert_sent": False,
                "ppe_status": {
                    "person_detected": False,
                    "helmet": False,
                    "vest": False,
                    "boots": False,
                    "boxes": [],
                    "annotated_base64": None,
                    "error": "Failed to read frame",
                },
                "boxes": [],
                "annotated_frame": None,
            }

        frame_bytes = self._encode_frame(frame)
        if not frame_bytes:
            return {
                "index": index,
                "label": camera_info["label"],
                "resolution": camera_info.get("resolution", ""),
                "connected": True,
                "timestamp": timestamp,
                "person_detected": False,
                "warning": "",
                "telegram_alert_sent": False,
                "ppe_status": {
                    "person_detected": False,
                    "helmet": False,
                    "vest": False,
                    "boots": False,
                    "boxes": [],
                    "annotated_base64": None,
                    "error": "Failed to encode frame",
                },
                "boxes": [],
                "annotated_frame": None,
            }

        ppe_status = ppe_det.predict(frame_bytes)
        warning = ""
        telegram_sent = False

        if ppe_status.get("person_detected"):
            missing = telegram_notifier.format_missing_ppe(ppe_status)
            if missing:
                warning = "PPE Tidak Lengkap: " + ", ".join(missing)
                telegram_sent = telegram_notifier.notify_monitoring_incomplete_ppe(
                    ppe_status=ppe_status,
                    cooldown_seconds=self.alert_cooldown_seconds,
                    source_label=camera_info["label"],
                    photo_bytes=frame_bytes,
                )

        return {
            "index": index,
            "label": camera_info["label"],
            "resolution": camera_info.get("resolution", ""),
            "connected": True,
            "timestamp": timestamp,
            "person_detected": bool(ppe_status.get("person_detected")),
            "warning": warning,
            "telegram_alert_sent": telegram_sent,
            "ppe_status": ppe_status,
            "boxes": ppe_status.get("boxes", []),
            "annotated_frame": ppe_status.get("annotated_base64"),
        }

    def _snapshot_from_results(self, results: list[dict]) -> dict:
        latest_alert = None
        recent_events = []

        for item in results:
            if item.get("warning"):
                event = {
                    "timestamp": item.get("timestamp"),
                    "camera_index": item.get("index"),
                    "camera_label": item.get("label"),
                    "warning": item.get("warning"),
                    "telegram_alert_sent": item.get("telegram_alert_sent", False),
                }
                recent_events.append(event)
                if latest_alert is None:
                    latest_alert = event

        if recent_events:
            with self._lock:
                previous = self._state.get("recent_events", [])
                merged = recent_events + previous
                self._state["recent_events"] = merged[:20]
                if latest_alert:
                    self._state["latest_alert"] = latest_alert

        return {
            "running": self._running,
            "camera_count": len(results),
            "last_update": dt.datetime.now().isoformat(),
            "latest_alert": latest_alert,
            "recent_events": recent_events,
            "cameras": results,
        }

    def _run_cycle(self):
        available_cameras = self._scan_camera_indexes()
        results = [self._capture_and_infer(camera) for camera in available_cameras]
        snapshot = self._snapshot_from_results(results)

        with self._lock:
            self._state.update(snapshot)

    def _loop(self):
        logger.info("[Monitor] Local multi-camera monitoring loop started")
        while not self._stop_event.is_set():
            try:
                self._run_cycle()
            except Exception as exc:
                logger.exception("[Monitor] Monitoring cycle failed: %s", exc)

            if self._stop_event.wait(self.interval_seconds):
                break

        logger.info("[Monitor] Local multi-camera monitoring loop stopped")

    def start(self) -> dict:
        with self._lock:
            if self._thread and self._thread.is_alive():
                self._running = True
                self._state["running"] = True
            else:
                self._stop_event.clear()
                self._running = True
                self._state["running"] = True
                self._thread = threading.Thread(target=self._loop, daemon=True)
                self._thread.start()

        return self.get_state()

    def stop(self) -> dict:
        self._stop_event.set()
        thread = self._thread
        if thread and thread.is_alive():
            thread.join(timeout=2)

        with self._lock:
            self._running = False
            self._state["running"] = False
        return self.get_state()

    def get_state(self) -> dict:
        with self._lock:
            cameras = [dict(camera) for camera in self._state.get("cameras", [])]
            recent_events = [dict(event) for event in self._state.get("recent_events", [])]
            latest_alert = self._state.get("latest_alert")
            latest_alert_copy = dict(latest_alert) if latest_alert else None
            return {
                "running": self._running,
                "camera_count": self._state.get("camera_count", len(cameras)),
                "last_update": self._state.get("last_update"),
                "latest_alert": latest_alert_copy,
                "recent_events": recent_events,
                "cameras": cameras,
                "interval_seconds": self.interval_seconds,
                "max_cameras": self.max_cameras,
            }

    def scan_devices(self) -> dict:
        cameras = self._scan_camera_indexes()
        return {
            "cameras": cameras,
            "camera_count": len(cameras),
            "max_cameras": self.max_cameras,
        }


local_camera_monitor = LocalCameraMonitor()


@router.get("/monitor/cameras")
def monitor_cameras():
    return local_camera_monitor.scan_devices()


@router.post("/monitor/start")
def monitor_start():
    return local_camera_monitor.start()


@router.post("/monitor/stop")
def monitor_stop():
    return local_camera_monitor.stop()


@router.get("/monitor/status")
def monitor_status():
    return local_camera_monitor.get_state()


@router.post("/monitor/frame")
def monitor_frame(
    file: UploadFile = File(...),
    source_label: str = Form(default="Live Monitoring"),
):
    image_bytes = file.file.read()
    ppe_status = ppe_det.predict(image_bytes)

    warning = ""
    telegram_sent = False

    if ppe_status["person_detected"]:
        missing = telegram_notifier.format_missing_ppe(ppe_status)
        if missing:
            warning = "PPE Tidak Lengkap: " + ", ".join(missing)
            telegram_sent = telegram_notifier.notify_monitoring_incomplete_ppe(
                ppe_status=ppe_status,
                cooldown_seconds=60,
                source_label=source_label,
                photo_bytes=image_bytes,
            )

    return {
        "person_detected": ppe_status["person_detected"],
        "ppe_status": ppe_status,
        "warning": warning,
        "telegram_alert_sent": telegram_sent,
        "boxes": ppe_status["boxes"],
        "annotated_frame": ppe_status["annotated_base64"],
    }
