from fastapi import APIRouter, Form, UploadFile, File, HTTPException
import datetime
import logging
from database import get_worker, record_attendance, check_already_accepted_today
from database import get_all_workers, get_all_attendance, get_attendance_report, get_attendance_count, get_ppe_compliance_stats
from database import get_daily_attendance_status as fetch_daily_attendance_status
from face_recognition import face_rec
from ppe_detector import ppe_det
from telegram_notifier import telegram_notifier

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/telegram/status")
def telegram_status():
    return telegram_notifier.get_config_status()


@router.post("/telegram/test")
def telegram_test():
    timestamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    sent = telegram_notifier.send_alert(
        (
            "<b>TEST ALERT K3VISION</b>\n"
            "<b>Status:</b> Integrasi Telegram aktif\n"
            "<b>Sumber:</b> Endpoint test\n"
            f"<b>Waktu:</b> {timestamp}"
        )
    )
    if not sent:
        raise HTTPException(
            status_code=400,
            detail="Gagal mengirim test Telegram. Periksa TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_IDS."
        )
    return {"status": "success", "message": "Test alert Telegram berhasil dikirim."}


@router.get("/telegram/discover-chat-ids")
def telegram_discover_chat_ids():
    chats = telegram_notifier.extract_chat_ids_from_updates()
    return {"chats": chats, "count": len(chats)}

@router.post("/register-face")
def register_face(
    file: UploadFile = File(...), 
    worker_name: str = Form(...),
    department: str = Form(...),
    position: str = Form(...),
    email: str = Form(...),
    phone: str = Form(...)
):
    if not worker_name:
        raise HTTPException(400, "worker_name is required")
        
    image_bytes = file.file.read()
    
    # Memanggil register yang sekarang mengembalikan (bool, message)
    success, message = face_rec.register(
        worker_name, 
        image_bytes, 
        department, 
        position, 
        email, 
        phone
    )
    
    if success:
        return {
            "status": "success", 
            "message": f"✅ {message}",
            "worker": {
                "name": worker_name,
                "department": department,
                "position": position,
                "email": email,
                "phone": phone,
            }
        }
    
    # Jika gagal (karena wajah ganda atau nama ganda), kirim pesan errornya
    raise HTTPException(status_code=400, detail=message)

@router.post("/identify-worker")
def identify_worker(file: UploadFile = File(...)):
    image_bytes = file.file.read()
    name = face_rec.identify(image_bytes)
    if name:
        return {"status": "success", "worker": name}
    raise HTTPException(status_code=404, detail="Face not recognized or not registered")

@router.post("/attendance/check")
def check_attendance(
    file: UploadFile = File(...),
    ppe_helmet: str = Form(default="0"),
    ppe_vest: str = Form(default="0"),
    ppe_boots: str = Form(default="0")
):
    image_bytes = file.file.read()
    logger.info("[Attendance] /attendance/check received %s bytes", len(image_bytes))
    
    # Client-side PPE detection results
    client_ppe_result = {
        "helmet": ppe_helmet == "1",
        "vest": ppe_vest == "1",
        "boots": ppe_boots == "1"
    }
    logger.info("[Attendance] Client-side PPE results: %s", client_ppe_result)
    
    # 1. Verify worker by face identification (server-side)
    logger.info("[Attendance] Starting face identification")
    worker_name = face_rec.identify(image_bytes)
    if not worker_name:
        logger.info("[Attendance] Face identification failed")
        raise HTTPException(status_code=401, detail="Worker not registered. Please register face first.")
        
    logger.info("[Attendance] Face identified as %s", worker_name)
    worker = get_worker(worker_name)
    if not worker:
        logger.error("[Attendance] Worker DB lookup failed for %s", worker_name)
        raise HTTPException(500, "Worker DB lookup failed")
    
    # 2. Prevent duplicate accepted attendance
    if check_already_accepted_today(worker["id"]):
        logger.info("[Attendance] Duplicate accepted attendance blocked for %s", worker_name)
        raise HTTPException(status_code=403, detail=f"{worker_name} sudah memiliki absensi diterima hari ini.")

    # 3. Use CLIENT-SIDE PPE results (NO server inference)
    ppe_status = {
        "person_detected": True,  # We assume client always detects if sending results
        "helmet": client_ppe_result["helmet"],
        "vest": client_ppe_result["vest"],
        "boots": client_ppe_result["boots"],
        "gloves": False,  # Not required
        "boxes": [],  # Client handles visualization
        "annotated_base64": None,  # Client handles annotation
        "error": None,
    }
    
    logger.info("[Attendance] Using client-side PPE results for %s", worker_name)

    # 4. Logic Acceptance/Rejection
    is_complete = ppe_status["helmet"] and ppe_status["vest"] and ppe_status["boots"]
    attendance_status = "accepted" if is_complete else "rejected"
    timestamp = datetime.datetime.now().isoformat()

    # 5. Save attendance record
    record_attendance(
        worker_id=worker["id"],
        timestamp=timestamp,
        status=attendance_status,
        ppe=ppe_status
    )

    # 6. Send Telegram notification if rejected
    telegram_sent = False
    if not is_complete:
        telegram_sent = telegram_notifier.notify_attendance_rejected(
            worker_name=worker_name,
            ppe_status=ppe_status,
            timestamp=timestamp,
            photo_bytes=image_bytes,
        )
    
    logger.info(
        "[Attendance] Attendance recorded: worker=%s status=%s helmet=%s vest=%s boots=%s",
        worker_name,
        attendance_status,
        ppe_status["helmet"],
        ppe_status["vest"],
        ppe_status["boots"],
    )

    return {
        "worker": {"name": worker_name, "id": worker["id"]},
        "attendance": attendance_status,
        "helmet": ppe_status["helmet"],
        "vest": ppe_status["vest"],
        "boots": ppe_status["boots"],
        "message": (
            f"✅ Absensi {worker_name} diterima - APD lengkap (🪖 Helm ✓ 🦺 Rompi ✓ 👢 Sepatu ✓)"
            if is_complete
            else (
                f"❌ Absensi {worker_name} ditolak - APD tidak lengkap. "
                f"Hilang: {'🪖' if not ppe_status['helmet'] else ''} "
                f"{'🦺' if not ppe_status['vest'] else ''} "
                f"{'👢' if not ppe_status['boots'] else ''}".strip()
            )
        ),
        "timestamp": timestamp,
        "telegram_notified": telegram_sent,
    }

@router.get("/workers")
def list_workers():
    workers = get_all_workers()
    return {"workers": workers}

@router.get("/attendance/history")
def get_attendance_history(status: str = None, limit: int = 20, offset: int = 0):
    """Get attendance history with optional status filter"""
    if status in ("all", ""):
        status = None
    records = get_all_attendance(limit=limit, offset=offset, status=status)
    return {"records": records}

@router.get("/dashboard/stats")
def dashboard_stats():
    """Ambil statistik untuk dashboard"""
    import datetime as dt
    today = dt.date.today().isoformat()
    
    total_workers = len(get_all_workers())
    
    # Attendance hari ini
    today_attendance = get_attendance_count(date=today)
    
    # Accepted & Rejected hari ini
    accepted_today = get_attendance_count(status="accepted", date=today)
    rejected_today = get_attendance_count(status="rejected", date=today)
    
    # Compliance rate (last 7 days)
    compliance_rate = 0
    if accepted_today + rejected_today > 0:
        compliance_rate = int((accepted_today / (accepted_today + rejected_today)) * 100)
    
    # PPE compliance stats
    ppe_stats = get_ppe_compliance_stats(days=7)
    
    return {
        "total_workers": total_workers,
        "attendance_today": today_attendance,
        "accepted_today": accepted_today,
        "rejected_today": rejected_today,
        "compliance_rate": compliance_rate,
        "ppe_compliance": ppe_stats
    }

@router.get("/reports/compliance")
def compliance_report(start_date: str = None, end_date: str = None):
    """Generate compliance report"""
    report_data = get_attendance_report(start_date, end_date)
    
    if not report_data:
        return {
            "report": [],
            "summary": {
                "total": 0,
                "accepted": 0,
                "rejected": 0,
                "compliance": 0
            }
        }
    
    return {"report": report_data}

@router.get("/attendance/daily-status")
def get_daily_attendance_status(date: str = None):
    """Get attendance status for all workers on a specific date"""
    import datetime as dt

    if not date:
        date = dt.date.today().isoformat()

    try:
        dt.date.fromisoformat(date)
    except ValueError:
        raise HTTPException(status_code=400, detail="date must use YYYY-MM-DD format")

    result = []
    for row in fetch_daily_attendance_status(date):
        if row.get("attendance_id") is not None:
            result.append({
                "worker_id": row["worker_id"],
                "name": row["name"],
                "department": row.get("department", ""),
                "position": row.get("position", ""),
                "attendance_status": row["status"],  # 'accepted' or 'rejected'
                "timestamp": row["timestamp"],
                "helmet": bool(row["helmet"]) if row.get("helmet") is not None else None,
                "vest": bool(row["vest"]) if row.get("vest") is not None else None,
                "boots": bool(row["boots"]) if row.get("boots") is not None else None,
            })
        else:
            result.append({
                "worker_id": row["worker_id"],
                "name": row["name"],
                "department": row.get("department", ""),
                "position": row.get("position", ""),
                "attendance_status": "absent",
                "timestamp": None,
                "helmet": None,
                "vest": None,
                "boots": None,
            })

    return {"date": date, "workers": result}

@router.get("/stats/overview")
def get_stats():
    # This calls the report function you already wrote in database.py
    return get_attendance_report()
