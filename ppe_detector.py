import base64
import os

import cv2
import numpy as np
from ultralytics import YOLO


class PPEDetector:
    def __init__(self):
        self.required_ppe = ("helmet", "vest", "boots")
        self.class_thresholds = {
            "human": 0.55,
            "helmet": 0.55,
            "vest": 0.75,
            "boots": 0.55,
            "gloves": 0.60,
        }
        self.min_area_ratio = {
            "human": 0.04,
            "helmet": 0.0015,
            "vest": 0.012,
            "boots": 0.0015,
            "gloves": 0.001,
        }
        self.colors = {
            "human": (0, 255, 204),
            "helmet": (68, 68, 255),
            "vest": (255, 170, 68),
            "boots": (68, 204, 255),
            "gloves": (170, 68, 255),
        }
        self.model = None
        self.class_names = {}
        self.load_model()

    def load_model(self):
        model_path = "model/best.pt"
        if os.path.exists(model_path):
            print(f"[PPE] Loading local model: {model_path}")
            self.model = YOLO(model_path)
            self.class_names = {
                int(idx): str(name).lower()
                for idx, name in self.model.names.items()
            }
            print(f"[PPE] Model loaded successfully. Classes: {self.class_names}")
        else:
            print(f"[PPE] Model not found: {model_path}. Running in placeholder mode.")

    def _empty_result(self):
        return {
            "person_detected": False,
            "helmet": False,
            "vest": False,
            "boots": False,
            "boxes": [],
            "annotated_base64": None,
        }

    def _box_area(self, box):
        return max(0, box["x2"] - box["x1"]) * max(0, box["y2"] - box["y1"])

    def _expand_box(self, box, ratio, width, height):
        pad_x = (box["x2"] - box["x1"]) * ratio
        pad_y = (box["y2"] - box["y1"]) * ratio
        return {
            "x1": max(0, box["x1"] - pad_x),
            "y1": max(0, box["y1"] - pad_y),
            "x2": min(width, box["x2"] + pad_x),
            "y2": min(height, box["y2"] + pad_y),
        }

    def _center_inside(self, child, parent):
        cx = (child["x1"] + child["x2"]) / 2
        cy = (child["y1"] + child["y2"]) / 2
        return parent["x1"] <= cx <= parent["x2"] and parent["y1"] <= cy <= parent["y2"]

    def _intersects_person(self, ppe_box, human_boxes, width, height):
        for human_box in human_boxes:
            expanded = self._expand_box(human_box, 0.08, width, height)
            if self._center_inside(ppe_box, expanded):
                return True
        return False

    def _draw_boxes(self, img, boxes):
        annotated = img.copy()
        for box in boxes:
            label = box["label"]
            color = self.colors.get(label, (255, 255, 255))
            x1, y1, x2, y2 = (int(box[key]) for key in ("x1", "y1", "x2", "y2"))
            text = f"{label} {box['conf']:.2f}"

            cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 2)
            text_size, _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 2)
            text_w, text_h = text_size
            label_y = max(0, y1 - text_h - 8)
            cv2.rectangle(
                annotated,
                (x1, label_y),
                (x1 + text_w + 8, label_y + text_h + 8),
                color,
                -1,
            )
            cv2.putText(
                annotated,
                text,
                (x1 + 4, label_y + text_h + 4),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.55,
                (15, 23, 42),
                2,
                cv2.LINE_AA,
            )
        return annotated

    def predict(self, image_bytes: bytes) -> dict:
        nparr = np.frombuffer(image_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None or self.model is None:
            return self._empty_result()

        height, width = img.shape[:2]
        image_area = width * height
        min_conf = min(self.class_thresholds.values())
        results = self.model(img, verbose=False, conf=min_conf)

        raw_boxes = []
        for result in results:
            for box in result.boxes:
                cls_id = int(box.cls[0])
                label = self.class_names.get(cls_id, str(cls_id)).lower()
                conf = float(box.conf[0])

                if conf < self.class_thresholds.get(label, 0.60):
                    continue

                x1, y1, x2, y2 = map(float, box.xyxy[0].tolist())
                item = {
                    "label": label,
                    "conf": conf,
                    "x1": x1,
                    "y1": y1,
                    "x2": x2,
                    "y2": y2,
                }

                area_ratio = self._box_area(item) / image_area
                if area_ratio < self.min_area_ratio.get(label, 0):
                    continue

                raw_boxes.append(item)

        human_boxes = [box for box in raw_boxes if box["label"] == "human"]
        ppe_boxes = [
            box for box in raw_boxes
            if box["label"] in self.required_ppe
            and self._intersects_person(box, human_boxes, width, height)
        ]
        final_boxes = human_boxes + ppe_boxes
        detected = {box["label"] for box in ppe_boxes}

        annotated_img = self._draw_boxes(img, final_boxes)
        _, buffer = cv2.imencode(".jpg", annotated_img, [cv2.IMWRITE_JPEG_QUALITY, 80])

        status = {
            "person_detected": len(human_boxes) > 0,
            "helmet": "helmet" in detected,
            "vest": "vest" in detected,
            "boots": "boots" in detected,
            "boxes": final_boxes,
            "annotated_base64": base64.b64encode(buffer).decode("utf-8"),
        }

        print(
            "[PPE] "
            f"human={status['person_detected']} "
            f"helmet={status['helmet']} "
            f"vest={status['vest']} "
            f"boots={status['boots']} "
            f"boxes={[(b['label'], round(b['conf'], 2)) for b in final_boxes]}"
        )
        return status


ppe_det = PPEDetector()
