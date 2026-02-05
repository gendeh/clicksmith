import base64
import os
import time

import cv2
import numpy as np
import pytesseract
from flask import Flask, jsonify, request

app = Flask(__name__)


def base64_to_cv2(b64_string):
    if ',' in b64_string:
        b64_string = b64_string.split(',')[1]
    img_data = base64.b64decode(b64_string)
    np_arr = np.frombuffer(img_data, np.uint8)
    return cv2.imdecode(np_arr, cv2.IMREAD_COLOR)


def match_template(template, search_area, threshold, find_all, max_matches):
    result = cv2.matchTemplate(search_area, template, cv2.TM_CCOEFF_NORMED)
    min_val, max_val, min_loc, max_loc = cv2.minMaxLoc(result)
    h, w = template.shape[:2]

    matches = []
    if find_all:
        y_coords, x_coords = np.where(result >= threshold)
        for (x, y) in zip(x_coords, y_coords):
            matches.append(
                {
                    "x": int(x + w / 2),
                    "y": int(y + h / 2),
                    "confidence": float(result[y, x]),
                    "bounds": {"x": int(x), "y": int(y), "width": int(w), "height": int(h)},
                }
            )
        matches = sorted(matches, key=lambda m: m["confidence"], reverse=True)[:max_matches]
    else:
        matches.append(
            {
                "x": int(max_loc[0] + w / 2),
                "y": int(max_loc[1] + h / 2),
                "confidence": float(max_val),
                "bounds": {"x": int(max_loc[0]), "y": int(max_loc[1]), "width": int(w), "height": int(h)},
            }
        )

    best_match = matches[0] if matches else None
    return best_match, matches


def match_feature(template, search_area):
    orb = cv2.ORB_create(400)
    kp1, des1 = orb.detectAndCompute(template, None)
    kp2, des2 = orb.detectAndCompute(search_area, None)
    if des1 is None or des2 is None:
        return None

    matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    matches = matcher.match(des1, des2)
    if not matches:
        return None

    matches = sorted(matches, key=lambda m: m.distance)
    top = matches[: min(15, len(matches))]
    pts = np.array([kp2[m.trainIdx].pt for m in top])
    center = pts.mean(axis=0)
    confidence = max(0.0, min(1.0, 1 - (top[0].distance / 100)))
    return {
        "x": int(center[0]),
        "y": int(center[1]),
        "confidence": float(confidence),
        "bounds": {"x": int(center[0]), "y": int(center[1]), "width": 1, "height": 1},
    }


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "image-service"})


@app.route("/match", methods=["POST"])
def match_image():
    start_time = time.time()
    try:
        data = request.json or {}
        template_b64 = data.get("template")
        search_area_b64 = data.get("searchArea")
        threshold = float(data.get("threshold", 0.6))
        method = data.get("method", "template")
        find_all = bool(data.get("findAll", False))
        max_matches = int(data.get("maxMatches", 1))

        if not template_b64 or not search_area_b64:
            return jsonify({"error": "Missing template or search area image"}), 400

        template = base64_to_cv2(template_b64)
        search_area = base64_to_cv2(search_area_b64)

        best_match = None
        matches = []

        if method in ["template", "hybrid"]:
            best_match, matches = match_template(template, search_area, threshold, find_all, max_matches)

        if method in ["feature", "hybrid"] and (not best_match or best_match["confidence"] < threshold):
            feature_match = match_feature(template, search_area)
            if feature_match:
                best_match = feature_match
                matches = [feature_match]

        processing_ms = int((time.time() - start_time) * 1000)

        return jsonify(
            {
                "success": best_match is not None and best_match["confidence"] >= threshold,
                "matches": matches,
                "bestMatch": best_match,
                "processingTimeMs": processing_ms,
            }
        )
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/ocr", methods=["POST"])
def ocr():
    try:
        data = request.json or {}
        if "image" not in data:
            return jsonify({"error": "Missing image"}), 400

        image = base64_to_cv2(data["image"])
        text = pytesseract.image_to_string(image)
        return jsonify({"text": text.strip(), "confidence": 80})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


def create_app():
    return app


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5001"))
    app.run(host="0.0.0.0", port=port)
