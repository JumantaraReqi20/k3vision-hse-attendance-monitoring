# main.py
import logging
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from dotenv import load_dotenv
from attendance import router as attendance_router
from monitoring import router as monitoring_router
from database import init_db
from face_recognition import face_rec

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Load environment variables from .env file
load_dotenv(verbose=True)
logger.info("✅ Environment variables loaded from .env")

app = FastAPI(title="K3Vision MVP", version="1.0.0")

# Serve UI statis
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.on_event("startup")
def startup_event():
    logger.info("🚀 Starting K3Vision MVP...")
    try:
        init_db()
        logger.info("✅ Database initialized")
    except Exception as e:
        logger.error(f"❌ Database initialization failed: {e}")
    
    try:
        face_rec._load_and_train()
        logger.info("✅ Face recognition model trained")
    except Exception as e:
        logger.error(f"❌ Face recognition training failed: {e}")
    
    logger.info("✅ K3Vision MVP Ready. UI: http://127.0.0.1:8000/")


@app.get("/")
def root():
    return FileResponse("static/index.html")

@app.get("/api/system/status")
def system_status():
    """Return system status including Telegram configuration"""
    from telegram_notifier import telegram_notifier
    return {
        "status": "running",
        "telegram": telegram_notifier.get_config_status(),
        "ui_url": "http://127.0.0.1:8000/"
    }

@app.post("/api/system/telegram-test")
def test_telegram():
    """Test Telegram connection by sending a test message"""
    from telegram_notifier import telegram_notifier
    
    if not telegram_notifier.is_configured():
        return {
            "success": False,
            "error": "Telegram not configured",
            "config_status": telegram_notifier.get_config_status()
        }
    
    test_message = "🧪 <b>K3Vision Test Message</b>\n\n✅ Telegram connection working!"
    success = telegram_notifier.send_message(test_message)
    
    return {
        "success": success,
        "delivery_status": telegram_notifier._last_delivery_status
    }

app.include_router(attendance_router, tags=["Auth & Attendance"])
app.include_router(monitoring_router, tags=["Monitoring"])
app.include_router(attendance_router, prefix="/api", tags=["Auth & Attendance"])
app.include_router(monitoring_router, prefix="/api", tags=["Monitoring"])
