import logging
import threading

import cv2
import numpy as np
from deepface import DeepFace

from database import fernet, get_all_workers

cv2.setNumThreads(1)
logger = logging.getLogger(__name__)


class FaceRecognizer:
    def __init__(self):
        self.model_name = "Facenet"
        self.detector_backend = "opencv"
        self.distance_threshold = 0.40
        self.max_image_dim = 960
        self.is_trained = False
        self.embeddings = []
        self._deepface_lock = threading.Lock()
        logger.info("[FaceRec] DeepFace initialized dengan model Facenet")

    def _decode_image(self, image_bytes: bytes):
        nparr = np.frombuffer(image_bytes, np.uint8)
        return cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    def _resize_for_inference(self, img):
        if img is None:
            return None

        height, width = img.shape[:2]
        max_dim = max(height, width)
        if max_dim <= self.max_image_dim:
            return img

        scale = self.max_image_dim / max_dim
        resized = cv2.resize(
            img,
            (int(width * scale), int(height * scale)),
            interpolation=cv2.INTER_AREA,
        )
        logger.info(
            "[FaceRec] Resized frame from %sx%s to %sx%s before inference",
            width,
            height,
            resized.shape[1],
            resized.shape[0],
        )
        return resized

    def _extract_largest_face(self, img):
        try:
            with self._deepface_lock:
                faces = DeepFace.extract_faces(
                    img_path=img,
                    detector_backend=self.detector_backend,
                    enforce_detection=True,
                    align=True,
                )
        except Exception as exc:
            logger.warning("[FaceRec] Face extraction failed: %s", exc)
            return None

        if not faces:
            return None

        face_obj = max(
            faces,
            key=lambda f: f.get("facial_area", {}).get("w", 0)
            * f.get("facial_area", {}).get("h", 0),
        )
        face_img = face_obj["face"]

        if face_img.dtype != np.uint8:
            if face_img.max() <= 1:
                face_img = face_img * 255
            face_img = np.clip(face_img, 0, 255).astype(np.uint8)

        return cv2.cvtColor(face_img, cv2.COLOR_RGB2BGR)

    def _get_embedding(self, img, enforce_detection: bool = True):
        with self._deepface_lock:
            reps = DeepFace.represent(
                img_path=img,
                model_name=self.model_name,
                detector_backend=self.detector_backend,
                enforce_detection=enforce_detection,
                align=True,
            )
        if not reps:
            return None
        return np.array(reps[0]["embedding"], dtype=np.float32)

    def _cosine_distance(self, emb1, emb2) -> float:
        denominator = np.linalg.norm(emb1) * np.linalg.norm(emb2)
        if denominator == 0:
            return 1.0
        return 1 - float(np.dot(emb1, emb2) / denominator)

    def _load_and_train(self):
        workers = get_all_workers()
        if not workers:
            logger.info("[FaceRec] No workers in DB to load.")
            return

        embeddings = []
        for worker in workers:
            try:
                dec_bytes = fernet.decrypt(worker["face_encrypted"].encode("utf-8"))
                img = self._decode_image(dec_bytes)
                if img is None:
                    continue

                img = self._resize_for_inference(img)
                embedding = self._get_embedding(img, enforce_detection=False)
                if embedding is not None:
                    embeddings.append({
                        "name": worker["name"],
                        "embedding": embedding,
                    })
            except Exception as exc:
                logger.warning("[FaceRec] Error loading face for %s: %s", worker["name"], exc)

        self.embeddings = embeddings
        self.is_trained = len(embeddings) > 0

        if self.is_trained:
            logger.info("[FaceRec] Loaded %s encrypted face embeddings.", len(embeddings))
        else:
            logger.info("[FaceRec] No valid face embeddings loaded.")

    def register(
        self,
        name: str,
        image_bytes: bytes,
        department: str = "",
        position: str = "",
        email: str = "",
        phone: str = "",
    ):
        existing_name = self.identify(image_bytes)
        if existing_name:
            return False, f"Wajah ini sudah terdaftar atas nama '{existing_name}'"

        img = self._decode_image(image_bytes)
        if img is None:
            return False, "Gambar rusak atau tidak valid"

        img = self._resize_for_inference(img)
        face_crop = self._extract_largest_face(img)
        if face_crop is None:
            return False, "Wajah tidak terdeteksi. Pastikan posisi wajah jelas dan terang"

        success, buf = cv2.imencode(".jpg", face_crop)
        if not success:
            return False, "Gagal memproses wajah"

        from database import save_worker

        if save_worker(name, buf.tobytes(), department, position, email, phone):
            self._load_and_train()
            return True, f"Berhasil mendaftarkan {name}"

        return False, "Nama sudah digunakan oleh user lain"

    def identify(self, image_bytes: bytes) -> str | None:
        if not self.is_trained:
            self._load_and_train()

        if not self.is_trained:
            logger.info("[FaceRec] Identify dibatalkan: Belum ada wajah terdaftar.")
            return None

        img = self._decode_image(image_bytes)
        if img is None:
            logger.warning("[FaceRec] Identify gagal: gambar tidak valid")
            return None

        img = self._resize_for_inference(img)
        try:
            query_embedding = self._get_embedding(img, enforce_detection=True)
        except Exception as exc:
            logger.warning("[FaceRec] Embedding extraction failed during identify: %s", exc)
            return None

        if query_embedding is None:
            logger.warning("[FaceRec] Embedding kosong saat identify")
            return None

        best_name = None
        best_distance = 1.0
        for item in self.embeddings:
            distance = self._cosine_distance(query_embedding, item["embedding"])
            if distance < best_distance:
                best_distance = distance
                best_name = item["name"]

        if best_distance <= self.distance_threshold:
            logger.info("[FaceRec] Match %s distance=%.4f", best_name, best_distance)
            return best_name

        logger.info("[FaceRec] No match. Best distance=%.4f", best_distance)
        return None


face_rec = FaceRecognizer()
