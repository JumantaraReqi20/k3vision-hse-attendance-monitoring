from fastapi import APIRouter, UploadFile, File
from ppe_detector import ppe_det
from telegram_notifier import telegram_notifier

router = APIRouter()


@router.post("/monitor/frame")
def monitor_frame(file: UploadFile = File(...)):
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
                source_label="Live Monitoring",
                photo_bytes=image_bytes,
            )

    return {
        "person_detected": ppe_status["person_detected"],
        "ppe_status": ppe_status,
        "warning": warning,
        "telegram_alert_sent": telegram_sent,
        "boxes": ppe_status["boxes"],
        "annotated_frame": ppe_status["annotated_base64"]
    }
