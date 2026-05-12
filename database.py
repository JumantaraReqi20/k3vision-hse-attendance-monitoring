import sqlite3
import os
from cryptography.fernet import Fernet

DB_PATH = "k3vision.db"
KEY_FILE = "k3vision_enc.key"

def get_encryption_key() -> Fernet:
    if not os.path.exists(KEY_FILE):
        key = Fernet.generate_key()
        with open(KEY_FILE, "wb") as f:
            f.write(key)
    else:
        with open(KEY_FILE, "rb") as f:
            key = f.read()
    return Fernet(key)

fernet = get_encryption_key()

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn

def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS workers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            face_encrypted TEXT NOT NULL,
            department TEXT DEFAULT '',
            position TEXT DEFAULT '',
            email TEXT DEFAULT '',
            phone TEXT DEFAULT '',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            worker_id INTEGER NOT NULL,
            timestamp TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('accepted', 'rejected')),
            helmet BOOLEAN DEFAULT 0,
            vest BOOLEAN DEFAULT 0,
            boots BOOLEAN DEFAULT 0,
            FOREIGN KEY(worker_id) REFERENCES workers(id)
        );
    """)
    conn.commit()
    conn.close()

def save_worker(name: str, face_bytes: bytes, department: str = "", position: str = "", email: str = "", phone: str = "") -> bool:
    conn = get_db()
    try:
        encrypted_face = fernet.encrypt(face_bytes).decode('utf-8')
        conn.execute(
            "INSERT INTO workers (name, face_encrypted, department, position, email, phone) VALUES (?, ?, ?, ?, ?, ?)",
            (name, encrypted_face, department, position, email, phone)
        )
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        return False
    finally:
        conn.close()

# database.py

def get_all_workers() -> list[dict]:
    conn = get_db()
    rows = conn.execute("SELECT id, name, face_encrypted, department, position, email, phone, created_at FROM workers").fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_worker(name: str) -> dict | None:
    conn = get_db()
    row = conn.execute("SELECT id, name FROM workers WHERE name = ?", (name,)).fetchone()
    conn.close()
    return dict(row) if row else None

def record_attendance(worker_id: int, timestamp: str, status: str, ppe: dict):
    conn = get_db()
    conn.execute(
        "INSERT INTO attendance (worker_id, timestamp, status, helmet, vest, boots) VALUES (?, ?, ?, ?, ?, ?)",
        (worker_id, timestamp, status, ppe.get("helmet", False), ppe.get("vest", False), ppe.get("boots", False))
    )
    conn.commit()
    conn.close()

def get_all_attendance(limit: int = 100, offset: int = 0, worker_id: int = None, status: str = None, date: str = None) -> list[dict]:
    """Ambil data kehadiran dengan filter optional"""
    if status in ("all", ""):
        status = None

    conn = get_db()
    query = """
        SELECT
            a.id,
            a.worker_id,
            w.name,
            a.timestamp,
            a.status,
            a.helmet,
            a.vest,
            a.boots
        FROM attendance a
        JOIN workers w ON a.worker_id = w.id
        WHERE 1=1
    """
    params = []
    
    if worker_id:
        query += " AND a.worker_id = ?"
        params.append(worker_id)
    if status:
        query += " AND a.status = ?"
        params.append(status)
    if date:
        query += " AND DATE(a.timestamp) = ?"
        params.append(date)
    
    query += " ORDER BY a.timestamp DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])
    
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_daily_attendance_status(date: str) -> list[dict]:
    """Ambil status harian semua pekerja berdasarkan absensi terbaru pada tanggal tersebut."""
    conn = get_db()
    rows = conn.execute(
        """
        WITH ranked_attendance AS (
            SELECT
                a.*,
                ROW_NUMBER() OVER (
                    PARTITION BY a.worker_id
                    ORDER BY datetime(a.timestamp) DESC, a.id DESC
                ) AS row_num
            FROM attendance a
            WHERE DATE(a.timestamp) = ?
        )
        SELECT
            w.id AS worker_id,
            w.name,
            w.department,
            w.position,
            ra.id AS attendance_id,
            ra.timestamp,
            ra.status,
            ra.helmet,
            ra.vest,
            ra.boots
        FROM workers w
        LEFT JOIN ranked_attendance ra
            ON ra.worker_id = w.id
            AND ra.row_num = 1
        ORDER BY w.name COLLATE NOCASE
        """,
        (date,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_attendance_count(worker_id: int = None, status: str = None, date: str = None) -> int:
    """Hitung total attendance record"""
    if status in ("all", ""):
        status = None

    conn = get_db()
    query = "SELECT COUNT(*) as count FROM attendance WHERE 1=1"
    params = []
    
    if worker_id:
        query += " AND worker_id = ?"
        params.append(worker_id)
    if status:
        query += " AND status = ?"
        params.append(status)
    if date:
        query += " AND DATE(timestamp) = ?"
        params.append(date)
    
    result = conn.execute(query, params).fetchone()
    conn.close()
    return result['count'] if result else 0

def get_worker_by_id(worker_id: int) -> dict | None:
    """Ambil data pekerja berdasarkan ID"""
    conn = get_db()
    row = conn.execute("SELECT id, name FROM workers WHERE id = ?", (worker_id,)).fetchone()
    conn.close()
    return dict(row) if row else None

def get_attendance_report(start_date: str = None, end_date: str = None) -> dict:
    """Generate laporan kehadiran & APD compliance"""
    conn = get_db()
    
    # Filter berdasarkan tanggal
    date_filter = ""
    params = []
    if start_date and end_date:
        date_filter = "AND DATE(a.timestamp) BETWEEN ? AND ?"
        params = [start_date, end_date]
    
    # Get per-worker summary
    query = f"""
        SELECT 
            w.name,
            COUNT(CASE WHEN a.status = 'accepted' THEN 1 END) as accepted,
            COUNT(CASE WHEN a.status = 'rejected' THEN 1 END) as rejected,
            COUNT(*) as total,
            COUNT(CASE WHEN a.helmet = 1 THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0) as helmet_pct,
            COUNT(CASE WHEN a.vest = 1 THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0) as vest_pct,
            COUNT(CASE WHEN a.boots = 1 THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0) as boots_pct
        FROM attendance a
        JOIN workers w ON a.worker_id = w.id
        WHERE 1=1 {date_filter}
        GROUP BY w.id, w.name
        ORDER BY w.name
    """
    
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]

def check_already_accepted_today(worker_id: int) -> bool:
    """Check if a worker already has an accepted attendance record today."""
    import datetime as dt
    today = dt.date.today().isoformat()
    
    conn = get_db()
    result = conn.execute(
        """
        SELECT COUNT(*) as count
        FROM attendance
        WHERE worker_id = ?
          AND DATE(timestamp) = ?
          AND status = 'accepted'
        """,
        (worker_id, today)
    ).fetchone()
    conn.close()
    
    return result['count'] > 0 if result else False

def check_already_attended_today(worker_id: int) -> bool:
    """Backward-compatible alias for accepted attendance checks."""
    return check_already_accepted_today(worker_id)

def get_ppe_compliance_stats(days: int = 7) -> dict:
    """Get average PPE compliance for last N days"""
    conn = get_db()
    query = """
        SELECT 
            COUNT(CASE WHEN helmet = 1 THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0) as helmet,
            COUNT(CASE WHEN vest = 1 THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0) as vest,
            COUNT(CASE WHEN boots = 1 THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0) as boots
        FROM attendance
        WHERE datetime(timestamp) >= datetime('now', '-' || ? || ' days')
    """
    result = conn.execute(query, (days,)).fetchone()
    conn.close()
    
    return {
        "helmet": int(result['helmet'] or 0) if result else 0,
        "vest": int(result['vest'] or 0) if result else 0,
        "boots": int(result['boots'] or 0) if result else 0
    }
    
    # Total attendance
    total_accepted = conn.execute(
        f"SELECT COUNT(*) as count FROM attendance a WHERE a.status = 'accepted' {date_filter}",
        params
    ).fetchone()
    total_rejected = conn.execute(
        f"SELECT COUNT(*) as count FROM attendance a WHERE a.status = 'rejected' {date_filter}",
        params
    ).fetchone()
    
    # APD compliance
    helmet_count = conn.execute(
        f"SELECT COUNT(*) as count FROM attendance a WHERE a.helmet = 1 {date_filter}",
        params
    ).fetchone()
    vest_count = conn.execute(
        f"SELECT COUNT(*) as count FROM attendance a WHERE a.vest = 1 {date_filter}",
        params
    ).fetchone()
    boots_count = conn.execute(
        f"SELECT COUNT(*) as count FROM attendance a WHERE a.boots = 1 {date_filter}",
        params
    ).fetchone()
    
    # Per-worker stats
    worker_stats = conn.execute(
        f"""SELECT w.id, w.name, 
                  COUNT(CASE WHEN a.status = 'accepted' THEN 1 END) as accepted_count,
                  COUNT(CASE WHEN a.status = 'rejected' THEN 1 END) as rejected_count,
                  SUM(CASE WHEN a.helmet = 1 THEN 1 ELSE 0 END) as helmet_count,
                  SUM(CASE WHEN a.vest = 1 THEN 1 ELSE 0 END) as vest_count,
                  SUM(CASE WHEN a.boots = 1 THEN 1 ELSE 0 END) as boots_count
           FROM workers w
           LEFT JOIN attendance a ON w.id = a.worker_id {date_filter}
           GROUP BY w.id, w.name
           ORDER BY w.name""",
        params
    ).fetchall()
    
    conn.close()
    
    return {
        "summary": {
            "total_accepted": total_accepted['count'],
            "total_rejected": total_rejected['count'],
            "helmet_compliance": helmet_count['count'],
            "vest_compliance": vest_count['count'],
            "boots_compliance": boots_count['count']
        },
        "per_worker": [dict(row) for row in worker_stats]
    }
