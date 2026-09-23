import base64
import binascii
import math
import os
import time

import cv2
import numpy as np
import pytesseract
from pytesseract import Output
from flask import Flask, jsonify, request
from werkzeug.exceptions import RequestEntityTooLarge

app = Flask(__name__)
DEFAULT_MIN_SCALE = 0.70
DEFAULT_MAX_SCALE = 1.40
DEFAULT_SCALE_HINT = 1.0
DEFAULT_MAX_BUDGET_MS = 180
MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_IMAGE_BYTES = 1_500_000
MAX_IMAGE_PIXELS = 4_000_000
MAX_OCR_PIXELS = 2_000_000
MAX_MATCHES = 50
MAX_OCR_ITEMS = 200
MAX_OCR_TEXT_CHARS = 8_000
TESSERACT_TIMEOUT_SECONDS = 3

app.config["MAX_CONTENT_LENGTH"] = MAX_REQUEST_BYTES


def base64_to_cv2(b64_string, *, max_decoded_bytes=MAX_IMAGE_BYTES, max_pixels=MAX_IMAGE_PIXELS):
    if not isinstance(b64_string, str) or not b64_string:
        raise ValueError("Image must be a base64 string")
    if ',' in b64_string:
        b64_string = b64_string.split(',', 1)[1]
    if len(b64_string) > int((max_decoded_bytes * 4) / 3) + 8:
        raise ValueError("Image exceeds byte budget")
    try:
        img_data = base64.b64decode(b64_string, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("Invalid base64 image") from exc
    if len(img_data) > max_decoded_bytes:
        raise ValueError("Image exceeds byte budget")
    np_arr = np.frombuffer(img_data, np.uint8)
    image = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Invalid image")
    height, width = image.shape[:2]
    if height * width > max_pixels:
        raise ValueError("Image exceeds pixel budget")
    return image


def match_template(template, search_area, threshold, find_all, max_matches, template_scale=1.0):
    template_gray = cv2.cvtColor(template, cv2.COLOR_BGR2GRAY)
    # Constant/low-variance templates can produce misleading high scores with CCOEFF.
    # Switch to SQDIFF mode (inverted to score map) for those cases.
    low_variance = float(np.std(template_gray)) < 6.0
    method = cv2.TM_SQDIFF_NORMED if low_variance else cv2.TM_CCOEFF_NORMED
    raw = cv2.matchTemplate(search_area, template, method)
    score = 1.0 - raw if method == cv2.TM_SQDIFF_NORMED else raw
    min_val, max_val, min_loc, max_loc = cv2.minMaxLoc(score)
    h, w = template.shape[:2]

    matches = []
    if find_all:
        # Extract top-k local maxima instead of scanning every threshold hit.
        # This keeps full-screen SmartClick queries bounded and fast.
        work = score.copy()
        limit = max(1, min(MAX_MATCHES, int(max_matches)))
        for _ in range(limit):
            _, best_val, _, best_loc = cv2.minMaxLoc(work)
            if best_val < threshold:
                break
            x, y = best_loc
            matches.append(
                {
                    "x": int(x + w / 2),
                    "y": int(y + h / 2),
                    "confidence": float(best_val),
                    "method": "template",
                    "score": float(best_val),
                    "scale": float(template_scale),
                    "bounds": {"x": int(x), "y": int(y), "width": int(w), "height": int(h)},
                }
            )

            # Suppress the local neighborhood so subsequent picks are distinct.
            left = max(0, x - w // 2)
            top = max(0, y - h // 2)
            right = min(work.shape[1], x + w + w // 2)
            bottom = min(work.shape[0], y + h + h // 2)
            work[top:bottom, left:right] = -1.0
    else:
        matches.append(
            {
                "x": int(max_loc[0] + w / 2),
                "y": int(max_loc[1] + h / 2),
                "confidence": float(max_val),
                "method": "template",
                "score": float(max_val),
                "scale": float(template_scale),
                "bounds": {"x": int(max_loc[0]), "y": int(max_loc[1]), "width": int(w), "height": int(h)},
            }
        )

    best_match = matches[0] if matches else None
    return best_match, matches


def _clamp_float(value, low, high, default):
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(parsed):
        return default
    return max(low, min(high, parsed))


def _clamp_int(value, low, high, default):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, parsed))


def build_scale_candidates(min_scale, max_scale, scale_hint, step=0.08):
    grid_values = []
    current = min_scale
    while current <= max_scale + 1e-9:
        grid_values.append(round(current, 3))
        current += step

    # Common UI/browser zoom steps improve hit-rate without forcing a dense full sweep.
    common_steps = [0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.33, 1.5, 1.67, 1.75, 2.0]
    in_range_common = [round(v, 3) for v in common_steps if min_scale <= v <= max_scale]

    preferred = [round(scale_hint, 3), round(min_scale, 3), round(max_scale, 3)]
    # When hint is near 1.0, aggressively probe browser zoom pivots early.
    if abs(scale_hint - 1.0) <= 0.08:
        preferred.extend([0.8, 1.25, 0.75, 1.33, 0.67, 1.5, 1.67, 2.0])

    ordered = []
    seen = set()

    def _push(value):
        rounded = round(value, 3)
        if rounded in seen:
            return
        if rounded < min_scale or rounded > max_scale:
            return
        seen.add(rounded)
        ordered.append(rounded)

    for value in preferred:
        _push(value)

    for value in sorted(in_range_common, key=lambda scale: (abs(scale - scale_hint), abs(scale - 1.0))):
        _push(value)

    for value in sorted(set(grid_values), key=lambda scale: (abs(scale - scale_hint), abs(scale - 1.0))):
        _push(value)

    return ordered


DECISIVE_TEMPLATE_CONFIDENCE = 0.92


def match_template_multiscale(
    template,
    search_area,
    threshold,
    find_all,
    max_matches,
    min_scale,
    max_scale,
    scale_hint,
    max_budget_ms,
):
    start = time.perf_counter()
    best_match = None
    collected = []
    max_matches = max(1, min(MAX_MATCHES, int(max_matches)))

    def score_of(item):
        return float(item.get("score", item.get("confidence", 0.0)))

    scales = build_scale_candidates(min_scale, max_scale, scale_hint, step=0.08)
    best_scale = None
    stopped_on_decisive = False

    for scale in scales:
        if (time.perf_counter() - start) * 1000 >= max_budget_ms:
            break

        if abs(scale - 1.0) < 1e-6:
            scaled_template = template
        else:
            scaled_template = cv2.resize(
                template,
                dsize=None,
                fx=scale,
                fy=scale,
                interpolation=cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LINEAR,
            )

        h, w = scaled_template.shape[:2]
        if h < 4 or w < 4 or h > search_area.shape[0] or w > search_area.shape[1]:
            continue

        candidate_best, candidate_matches = match_template(
            scaled_template, search_area, threshold, find_all, max_matches, template_scale=scale
        )
        if candidate_best:
            if not best_match or score_of(candidate_best) > score_of(best_match):
                best_match = candidate_best
                best_scale = scale
        if candidate_matches:
            collected.extend(candidate_matches)
        if best_match and score_of(best_match) >= DECISIVE_TEMPLATE_CONFIDENCE:
            stopped_on_decisive = True
            break

    if (
        not stopped_on_decisive
        and best_scale is not None
        and (time.perf_counter() - start) * 1000 < max_budget_ms
    ):
        for delta in (-0.04, -0.02, 0.02, 0.04):
            scale = round(best_scale + delta, 3)
            if scale < min_scale or scale > max_scale:
                continue
            if (time.perf_counter() - start) * 1000 >= max_budget_ms:
                break
            scaled_template = cv2.resize(
                template,
                dsize=None,
                fx=scale,
                fy=scale,
                interpolation=cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LINEAR,
            )
            h, w = scaled_template.shape[:2]
            if h < 4 or w < 4 or h > search_area.shape[0] or w > search_area.shape[1]:
                continue
            candidate_best, candidate_matches = match_template(
                scaled_template, search_area, threshold, find_all, max_matches, template_scale=scale
            )
            if candidate_best and (not best_match or score_of(candidate_best) > score_of(best_match)):
                best_match = candidate_best
            if candidate_matches:
                collected.extend(candidate_matches)

    if collected:
        collected = sorted(collected, key=score_of, reverse=True)
        if find_all:
            collected = collected[:max_matches]
        else:
            collected = [collected[0]]

    if not best_match and collected:
        best_match = collected[0]

    return best_match, collected


def match_feature(template, search_area):
    template_gray = cv2.cvtColor(template, cv2.COLOR_BGR2GRAY)
    search_gray = cv2.cvtColor(search_area, cv2.COLOR_BGR2GRAY)
    orb = cv2.ORB_create(700)
    kp1, des1 = orb.detectAndCompute(template_gray, None)
    kp2, des2 = orb.detectAndCompute(search_gray, None)
    if des1 is None or des2 is None:
        return None

    matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
    knn_matches = matcher.knnMatch(des1, des2, k=2)
    good_matches = []
    for pair in knn_matches:
        if len(pair) < 2:
            continue
        m, n = pair
        if m.distance < 0.75 * n.distance:
            good_matches.append(m)

    if not good_matches:
        return None

    good_matches = sorted(good_matches, key=lambda m: m.distance)
    top = good_matches[: min(120, len(good_matches))]

    def estimate_keypoint_scale(matches_subset):
        ratios = []
        for match in matches_subset:
            src_size = float(kp1[match.queryIdx].size or 0.0)
            dst_size = float(kp2[match.trainIdx].size or 0.0)
            if src_size <= 0 or dst_size <= 0:
                continue
            ratio = dst_size / src_size
            if np.isfinite(ratio) and 0.25 <= ratio <= 3.0:
                ratios.append(ratio)
        if not ratios:
            return None
        return float(np.median(ratios))

    if len(top) >= 8:
        src_pts = np.float32([kp1[m.queryIdx].pt for m in top]).reshape(-1, 1, 2)
        dst_pts = np.float32([kp2[m.trainIdx].pt for m in top]).reshape(-1, 1, 2)
        homography, mask = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, 5.0)
        if homography is not None:
            h, w = template.shape[:2]
            corners = np.float32([[0, 0], [w, 0], [w, h], [0, h]]).reshape(-1, 1, 2)
            projected = cv2.perspectiveTransform(corners, homography)
            center = projected.mean(axis=0)[0]
            inliers = int(mask.sum()) if mask is not None else len(top)
            inlier_ratio = inliers / max(1, len(top))
            avg_distance = float(np.mean([m.distance for m in top[: min(40, len(top))]]))
            projected_width = max(1.0, float(np.max(projected[:, 0, 0]) - np.min(projected[:, 0, 0])))
            projected_height = max(1.0, float(np.max(projected[:, 0, 1]) - np.min(projected[:, 0, 1])))
            homography_scale = float(np.sqrt(max(1e-6, (projected_width / max(1.0, w)) * (projected_height / max(1.0, h)))))
            confidence = max(
                0.0,
                min(1.0, 0.35 + 0.45 * inlier_ratio + 0.20 * (1.0 - min(1.0, avg_distance / 64.0))),
            )
            return {
                "x": int(center[0]),
                "y": int(center[1]),
                "confidence": float(confidence),
                "method": "feature",
                "score": float(confidence),
                "scale": homography_scale,
                "homography_ok": True,
                "bounds": {
                    "x": int(np.min(projected[:, 0, 0])),
                    "y": int(np.min(projected[:, 0, 1])),
                    "width": int(np.max(projected[:, 0, 0]) - np.min(projected[:, 0, 0])),
                    "height": int(np.max(projected[:, 0, 1]) - np.min(projected[:, 0, 1])),
                },
                "inliers": inliers,
            }

    pts = np.array([kp2[m.trainIdx].pt for m in top[: min(20, len(top))]])
    center = pts.mean(axis=0)
    confidence = max(0.0, min(0.72, 0.25 + 0.55 * (1.0 - (top[0].distance / 100))))
    feature_scale = estimate_keypoint_scale(top[: min(40, len(top))])
    return {
        "x": int(center[0]),
        "y": int(center[1]),
        "confidence": float(confidence),
        "method": "feature",
        "score": float(confidence),
        "scale": feature_scale,
        "homography_ok": False,
        "bounds": {"x": int(center[0]), "y": int(center[1]), "width": 1, "height": 1},
    }


def scale_within_request(scale, min_scale, max_scale, slack=0.25):
    if scale is None:
        return True
    try:
        value = float(scale)
    except (TypeError, ValueError):
        return False
    if not np.isfinite(value):
        return False
    return (min_scale - slack) <= value <= (max_scale + slack)


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
        threshold = _clamp_float(data.get("threshold"), 0.0, 1.0, 0.6)
        method = data.get("method", "template")
        find_all = bool(data.get("findAll", False))
        max_matches = _clamp_int(data.get("maxMatches"), 1, MAX_MATCHES, 1)
        min_scale = _clamp_float(data.get("minScale"), 0.25, 3.0, DEFAULT_MIN_SCALE)
        max_scale = _clamp_float(data.get("maxScale"), min_scale, 3.0, DEFAULT_MAX_SCALE)
        scale_hint = _clamp_float(data.get("scaleHint"), min_scale, max_scale, DEFAULT_SCALE_HINT)
        max_budget_ms = int(_clamp_float(data.get("maxBudgetMs"), 20, 500, DEFAULT_MAX_BUDGET_MS))

        if not template_b64 or not search_area_b64:
            return jsonify({"error": "Missing template or search area image"}), 400
        if method not in {"template", "feature", "hybrid"}:
            return jsonify({"error": "Unsupported match method"}), 400

        template = base64_to_cv2(template_b64)
        search_area = base64_to_cv2(search_area_b64)

        best_match = None
        matches = []

        if method in ["template", "hybrid"]:
            best_match, matches = match_template_multiscale(
                template,
                search_area,
                threshold,
                find_all,
                max_matches,
                min_scale,
                max_scale,
                scale_hint,
                max_budget_ms,
            )

        if method in ["feature", "hybrid"]:
            budget_left = max_budget_ms - (time.time() - start_time) * 1000
            should_try_feature = budget_left > 0 and (
                method == "feature"
                or not best_match
                or best_match["confidence"] < max(0.82, threshold + 0.12)
            )
            if should_try_feature:
                feature_match = match_feature(template, search_area)
                if feature_match and not scale_within_request(
                    feature_match.get("scale"), min_scale, max_scale
                ):
                    feature_match = None
                if feature_match:
                    if not matches:
                        matches = [feature_match]
                    else:
                        matches.append(feature_match)

                    def _score(item):
                        return float(item.get("score", item.get("confidence", 0.0)))

                    if not best_match or _score(feature_match) >= _score(best_match):
                        best_match = feature_match

        if matches:
            matches = sorted(matches, key=lambda item: float(item.get("score", item.get("confidence", 0.0))), reverse=True)
            if find_all:
                matches = matches[:max_matches]

        processing_ms = int((time.time() - start_time) * 1000)

        return jsonify(
            {
                "success": best_match is not None and best_match["confidence"] >= threshold,
                "matches": matches,
                "bestMatch": best_match,
                "processingTimeMs": processing_ms,
            }
        )
    except RequestEntityTooLarge:
        return jsonify({"error": "Request exceeds byte budget"}), 413
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/ocr", methods=["POST"])
def ocr():
    start_time = time.time()
    try:
        data = request.json or {}
        if "image" not in data:
            return jsonify({"error": "Missing image"}), 400

        image = base64_to_cv2(data["image"], max_pixels=MAX_OCR_PIXELS)
        data_dict = pytesseract.image_to_data(
            image,
            output_type=Output.DICT,
            timeout=requested_ocr_timeout_seconds(data),
        )

        line_map = {}
        for idx, raw_text in enumerate(data_dict.get("text", [])):
            item_text = (raw_text or "").strip()
            try:
                confidence = float(data_dict.get("conf", [0])[idx])
            except (TypeError, ValueError):
                confidence = 0.0
            if not item_text:
                continue
            if confidence < 0:
                continue
            left = int(data_dict.get("left", [0])[idx])
            top = int(data_dict.get("top", [0])[idx])
            width = int(data_dict.get("width", [0])[idx])
            height = int(data_dict.get("height", [0])[idx])
            key = (
                int(data_dict.get("block_num", [0])[idx]),
                int(data_dict.get("par_num", [0])[idx]),
                int(data_dict.get("line_num", [0])[idx]),
            )
            line = line_map.setdefault(
                key,
                {
                    "texts": [],
                    "confidences": [],
                    "left": left,
                    "top": top,
                    "right": left + width,
                    "bottom": top + height,
                },
            )
            line["texts"].append(item_text)
            line["confidences"].append(confidence)
            line["left"] = min(line["left"], left)
            line["top"] = min(line["top"], top)
            line["right"] = max(line["right"], left + width)
            line["bottom"] = max(line["bottom"], top + height)

        items = []
        for line in line_map.values():
            line_text = " ".join(line["texts"]).strip()
            if not line_text:
                continue
            items.append(
                {
                    "text": line_text,
                    "confidence": float(sum(line["confidences"]) / max(1, len(line["confidences"]))),
                    "bounds": {
                        "x": int(line["left"]),
                        "y": int(line["top"]),
                        "width": int(max(1, line["right"] - line["left"])),
                        "height": int(max(1, line["bottom"] - line["top"])),
                    },
                }
            )
            if len(items) >= MAX_OCR_ITEMS:
                break

        processing_ms = int((time.time() - start_time) * 1000)
        text = "\n".join(item["text"] for item in items)[:MAX_OCR_TEXT_CHARS]
        return jsonify(
            {
                "success": True,
                "text": text,
                "items": items,
                "processingTimeMs": processing_ms,
            }
        )
    except RequestEntityTooLarge:
        return jsonify(
            {
                "success": False,
                "text": "",
                "items": [],
                "processingTimeMs": int((time.time() - start_time) * 1000),
                "error": "Request exceeds byte budget",
            }
        ), 413
    except ValueError as exc:
        return jsonify(
            {
                "success": False,
                "text": "",
                "items": [],
                "processingTimeMs": int((time.time() - start_time) * 1000),
                "error": str(exc),
            }
        ), 400
    except Exception as exc:
        return jsonify(
            {
                "success": False,
                "text": "",
                "items": [],
                "processingTimeMs": int((time.time() - start_time) * 1000),
                "error": str(exc),
            }
        )


def requested_ocr_timeout_seconds(payload):
    raw = payload.get("timeoutMs") if isinstance(payload, dict) else None
    if raw is None:
        return TESSERACT_TIMEOUT_SECONDS
    try:
        milliseconds = float(raw)
    except (TypeError, ValueError):
        return TESSERACT_TIMEOUT_SECONDS
    if not math.isfinite(milliseconds):
        return TESSERACT_TIMEOUT_SECONDS
    return max(0.01, min(float(TESSERACT_TIMEOUT_SECONDS), milliseconds / 1000.0))


def create_app():
    return app


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5001"))
    app.run(host="0.0.0.0", port=port)
