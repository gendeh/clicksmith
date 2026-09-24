import base64
import binascii
import math
import os
import time
from concurrent.futures import ThreadPoolExecutor

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


def _match_template_direct(template, search_area, threshold, find_all, max_matches, template_scale=1.0):
    template_gray = cv2.cvtColor(template, cv2.COLOR_BGR2GRAY)
    low_variance = float(np.std(template_gray)) < 6.0
    method = cv2.TM_SQDIFF_NORMED if low_variance else cv2.TM_CCOEFF_NORMED
    raw = cv2.matchTemplate(search_area, template, method)
    score = 1.0 - raw if method == cv2.TM_SQDIFF_NORMED else raw
    accept_at = max(float(threshold), 0.85) if low_variance else float(threshold)
    min_val, max_val, min_loc, max_loc = cv2.minMaxLoc(score)
    h, w = template.shape[:2]

    matches = []
    if find_all:
        work = score.copy()
        limit = max(1, min(MAX_MATCHES, int(max_matches)))
        for _ in range(limit):
            _, best_val, _, best_loc = cv2.minMaxLoc(work)
            if best_val < accept_at:
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

            pad = max(12, max(w, h) // 2 + 4)
            left = max(0, x - pad)
            top = max(0, y - pad)
            right = min(work.shape[1], x + pad + 1)
            bottom = min(work.shape[0], y + pad + 1)
            work[top:bottom, left:right] = -1.0
    elif max_val >= accept_at:
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
    return best_match, matches, float(max_val)


TEMPLATE_PYRAMID_MIN_PIXELS = 640 * 640


def _template_pyramid_factor(template, search_area):
    height, width = search_area.shape[:2]
    template_h, template_w = template.shape[:2]
    if height * width <= TEMPLATE_PYRAMID_MIN_PIXELS or template_h < 16 or template_w < 16:
        return 1
    if min(template_h, template_w) >= 32 and min(height, width) >= 64:
        return 4
    return 2


def match_template(template, search_area, threshold, find_all, max_matches, template_scale=1.0):
    height, width = search_area.shape[:2]
    template_h, template_w = template.shape[:2]
    factor = _template_pyramid_factor(template, search_area)
    if factor == 1:
        best_match, matches, peak = _match_template_direct(
            template, search_area, threshold, find_all, max_matches, template_scale
        )
        return best_match, matches, peak, True
    small_template = cv2.resize(
        template,
        (template_w // factor, template_h // factor),
        interpolation=cv2.INTER_AREA,
    )
    small_h, small_w = small_template.shape[:2]
    if small_h < 8 or small_w < 8:
        best_match, matches, peak = _match_template_direct(
            template, search_area, threshold, find_all, max_matches, template_scale
        )
        return best_match, matches, peak, True
    small_search = cv2.resize(
        search_area,
        (width // factor, height // factor),
        interpolation=cv2.INTER_AREA,
    )
    _coarse, coarse_matches, coarse_peak = _match_template_direct(
        small_template, small_search, threshold, find_all, max_matches, template_scale
    )
    if not coarse_matches:
        return None, [], coarse_peak, False
    refined = []
    refined_peak = 0.0
    margin = max(16, factor * 4)
    for coarse in coarse_matches:
        center_x = int(coarse["x"]) * factor
        center_y = int(coarse["y"]) * factor
        x0 = max(0, center_x - template_w // 2 - margin)
        y0 = max(0, center_y - template_h // 2 - margin)
        x1 = min(width, center_x + template_w - template_w // 2 + margin)
        y1 = min(height, center_y + template_h - template_h // 2 + margin)
        if x1 - x0 < template_w or y1 - y0 < template_h:
            continue
        crop = search_area[y0:y1, x0:x1]
        _local, local_matches, local_peak = _match_template_direct(
            template, crop, threshold, False, 1, template_scale
        )
        refined_peak = max(refined_peak, local_peak)
        pad = max(12, max(template_w, template_h) // 2 + 4)
        for item in local_matches:
            shifted = dict(item)
            shifted["x"] = int(item["x"]) + x0
            shifted["y"] = int(item["y"]) + y0
            bounds = dict(item.get("bounds") or {})
            if bounds:
                bounds["x"] = int(bounds.get("x", 0)) + x0
                bounds["y"] = int(bounds.get("y", 0)) + y0
                shifted["bounds"] = bounds
            if any(
                abs(shifted["x"] - prev["x"]) <= pad and abs(shifted["y"] - prev["y"]) <= pad
                for prev in refined
            ):
                continue
            refined.append(shifted)
            if not find_all:
                break
        if not find_all and refined:
            break
    if not refined:
        return None, [], refined_peak, True
    refined.sort(key=lambda item: float(item.get("score", item.get("confidence", 0.0))), reverse=True)
    limit = max(1, min(MAX_MATCHES, int(max_matches)))
    if find_all:
        refined = refined[:limit]
    else:
        refined = [refined[0]]
    return refined[0], refined, refined_peak, True


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

    common_steps = [0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.33, 1.5, 1.67, 1.75, 2.0]
    in_range_common = [round(v, 3) for v in common_steps if min_scale <= v <= max_scale]

    preferred = [round(scale_hint, 3), round(min_scale, 3), round(max_scale, 3)]
    if abs(scale_hint - 1.0) <= 0.08:
        preferred.extend([1.1, 0.9, 1.2, 0.67, 0.8, 1.25, 0.75, 1.33, 1.5, 1.67, 2.0])
    elif scale_hint < 1.0:
        preferred.insert(2, 0.67)
    elif scale_hint > 1.0:
        preferred.append(1.2)

    ordered = []
    seen = set()

    def _push(value, slack=0.0):
        rounded = round(value, 3)
        if rounded in seen:
            return
        if rounded < min_scale - slack or rounded > max_scale + slack:
            return
        seen.add(rounded)
        ordered.append(rounded)

    for value in preferred:
        _push(value, 0.05)

    for value in sorted(in_range_common, key=lambda scale: (abs(scale - scale_hint), abs(scale - 1.0))):
        _push(value)

    for value in sorted(set(grid_values), key=lambda scale: (abs(scale - scale_hint), abs(scale - 1.0))):
        _push(value)

    return ordered


DECISIVE_TEMPLATE_CONFIDENCE = 0.92
CLICKABLE_TEMPLATE_CONFIDENCE = 0.6
HOPELESS_TEMPLATE_CONFIDENCE = 0.30
FLAT_SCALE_SCORE_TIE = 0.02


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
    deadline=None,
):
    start = time.perf_counter()
    if deadline is None:
        deadline = start + max(0.0, float(max_budget_ms)) / 1000.0
    best_match = None
    collected = []
    max_matches = max(1, min(MAX_MATCHES, int(max_matches)))
    scale_cost_s = 0.0

    def score_of(item):
        return float(item.get("score", item.get("confidence", 0.0)))

    def scale_fits():
        now = time.perf_counter()
        if now >= deadline:
            return False
        if scale_cost_s > 0 and now + scale_cost_s >= deadline:
            return False
        return True

    scales = build_scale_candidates(min_scale, max_scale, scale_hint, step=0.08)
    template_gray = cv2.cvtColor(template, cv2.COLOR_BGR2GRAY)
    low_variance = float(np.std(template_gray)) < 6.0
    best_scale = None
    stopped_on_decisive = False

    def prefer_candidate(candidate, incumbent):
        if incumbent is None:
            return True
        candidate_score = score_of(candidate)
        incumbent_score = score_of(incumbent)
        if low_variance and abs(candidate_score - incumbent_score) <= FLAT_SCALE_SCORE_TIE:
            return float(candidate.get("scale") or 0.0) > float(incumbent.get("scale") or 0.0)
        return candidate_score > incumbent_score

    def match_at_scale(scale):
        nonlocal scale_cost_s
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
        height, width = scaled_template.shape[:2]
        if height < 4 or width < 4 or height > search_area.shape[0] or width > search_area.shape[1]:
            return None, [], 0.0, True
        scale_started = time.perf_counter()
        candidate_best, candidate_matches, peak, measured = match_template(
            scaled_template, search_area, threshold, find_all, max_matches, template_scale=scale
        )
        scale_cost_s = max(scale_cost_s, time.perf_counter() - scale_started)
        return candidate_best, candidate_matches, peak, measured

    if low_variance:
        ordered = sorted(set(scales))
        low = 0
        high = len(ordered) - 1
        while low <= high and scale_fits():
            mid = (low + high) // 2
            candidate_best, candidate_matches, _peak, _measured = match_at_scale(ordered[mid])
            if candidate_best:
                best_match = candidate_best
                best_scale = ordered[mid]
                collected = list(candidate_matches or [candidate_best])
                low = mid + 1
            else:
                high = mid - 1
        stopped_on_decisive = best_match is not None
    else:
        tried = 0
        best_peak = 0.0
        coarse_hint = 0.0
        for scale in scales:
            if not scale_fits():
                break
            tried += 1
            candidate_best, candidate_matches, peak, measured = match_at_scale(scale)
            if measured:
                best_peak = max(best_peak, peak)
            else:
                coarse_hint = max(coarse_hint, peak)
            if candidate_best and prefer_candidate(candidate_best, best_match):
                best_match = candidate_best
                best_scale = scale
            if candidate_matches:
                collected.extend(candidate_matches)
            if best_match and score_of(best_match) >= DECISIVE_TEMPLATE_CONFIDENCE:
                stopped_on_decisive = True
                break
            if tried >= 6 and best_match and score_of(best_match) >= CLICKABLE_TEMPLATE_CONFIDENCE:
                stopped_on_decisive = True
                break
            if tried >= 5 and best_peak < HOPELESS_TEMPLATE_CONFIDENCE and coarse_hint < HOPELESS_TEMPLATE_CONFIDENCE:
                break
            if (
                tried >= 8
                and best_peak < HOPELESS_TEMPLATE_CONFIDENCE
                and (best_match is None or score_of(best_match) < CLICKABLE_TEMPLATE_CONFIDENCE)
            ):
                break

    if not stopped_on_decisive and best_scale is not None and scale_fits():
        for delta in (-0.04, -0.02, 0.02, 0.04):
            scale = round(best_scale + delta, 3)
            if scale < min_scale or scale > max_scale:
                continue
            if not scale_fits():
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
            scale_started = time.perf_counter()
            candidate_best, candidate_matches, _peak, _measured = match_template(
                scaled_template, search_area, threshold, find_all, max_matches, template_scale=scale
            )
            scale_cost_s = max(scale_cost_s, time.perf_counter() - scale_started)
            if candidate_best and prefer_candidate(candidate_best, best_match):
                best_match = candidate_best
                best_scale = scale
            if candidate_matches:
                collected.extend(candidate_matches)

    if low_variance and best_match is not None:
        winning_scale = float(best_match.get("scale") or 0.0)
        collected = [
            item
            for item in collected
            if abs(float(item.get("scale") or 0.0) - winning_scale) <= 0.021
        ]

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


def match_feature_multiscale(template, search_area, min_scale, max_scale, scale_hint, deadline):
    best = None
    for scale in build_scale_candidates(min_scale, max_scale, scale_hint):
        if time.perf_counter() >= deadline:
            break
        if abs(scale - 1.0) < 1e-6:
            sized = template
        else:
            sized = cv2.resize(
                template,
                dsize=None,
                fx=scale,
                fy=scale,
                interpolation=cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LINEAR,
            )
        height, width = sized.shape[:2]
        if height < 12 or width < 12 or height > search_area.shape[0] or width > search_area.shape[1]:
            continue
        hit = match_feature(sized, search_area)
        if not hit or hit.get("homography_ok") is not True:
            continue
        reported = float(hit.get("scale") or 0.0)
        inliers = int(hit.get("inliers") or 0)
        if inliers < 8 or abs(reported - 1.0) > 0.12:
            continue
        chosen = dict(hit)
        chosen["scale"] = float(scale)
        align = abs(reported - 1.0)
        best_align = float(best.get("_align")) if best is not None else None
        if best is None or align < best_align - 0.02 or (
            abs(align - best_align) <= 0.02 and inliers > int(best.get("inliers") or 0)
        ):
            chosen["_align"] = align
            best = chosen
        if inliers >= 24 and align <= 0.02:
            break
    if best is not None:
        best.pop("_align", None)
    return best


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
    start_time = time.perf_counter()
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
        deadline = start_time + max_budget_ms / 1000.0

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
                deadline,
            )

        if method in ["feature", "hybrid"]:
            budget_left = (deadline - time.perf_counter()) * 1000
            feature_floor = 0 if method == "feature" else 50
            should_try_feature = budget_left > feature_floor and (
                method == "feature"
                or (
                    best_match is not None
                    and best_match["confidence"] < max(0.82, threshold + 0.12)
                )
            )
            if should_try_feature:
                if method == "feature":
                    feature_match = match_feature_multiscale(
                        template,
                        search_area,
                        min_scale,
                        max_scale,
                        scale_hint,
                        deadline,
                    )
                else:
                    feature_match = match_feature(template, search_area)
                if feature_match and not scale_within_request(
                    feature_match.get("scale"), min_scale, max_scale
                ):
                    feature_match = None
                if method != "feature" and feature_match and feature_match.get("homography_ok") is True:
                    try:
                        reported_scale = float(feature_match.get("scale"))
                    except (TypeError, ValueError):
                        reported_scale = None
                    if reported_scale is not None and abs(reported_scale - 1.0) > 0.12:
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

        processing_ms = int((time.perf_counter() - start_time) * 1000)

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


def items_from_tesseract(data_dict, ocr_scale, origin_x=0, origin_y=0):
    line_map = {}
    words = []
    for idx, raw_text in enumerate(data_dict.get("text", [])):
        item_text = (raw_text or "").strip()
        try:
            confidence = float(data_dict.get("conf", [0])[idx])
        except (TypeError, ValueError):
            confidence = 0.0
        if not item_text or confidence < 0:
            continue
        left = origin_x + int(round(int(data_dict.get("left", [0])[idx]) / ocr_scale))
        top = origin_y + int(round(int(data_dict.get("top", [0])[idx]) / ocr_scale))
        width = int(round(int(data_dict.get("width", [0])[idx]) / ocr_scale))
        height = int(round(int(data_dict.get("height", [0])[idx]) / ocr_scale))
        words.append(
            {
                "text": item_text,
                "confidence": confidence,
                "bounds": {
                    "x": left,
                    "y": top,
                    "width": int(max(1, width)),
                    "height": int(max(1, height)),
                },
            }
        )
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
    line_texts = []
    for line in line_map.values():
        line_text = " ".join(line["texts"]).strip()
        if not line_text:
            continue
        line_texts.append(line_text)
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
            return items, "\n".join(line_texts)
    for word in words:
        if len(items) >= MAX_OCR_ITEMS:
            break
        items.append(word)
    return items, "\n".join(line_texts)


def text_rectangles(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 40, 120)
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for contour in contours:
        x, y, width, height = cv2.boundingRect(contour)
        if width < 60 or height < 16 or width > 340 or height > 90:
            continue
        if any(abs(x - kept[0]) < 8 and abs(y - kept[1]) < 8 for kept in boxes):
            continue
        boxes.append((int(x), int(y), int(width), int(height)))
        if len(boxes) >= 24:
            break
    return boxes


def _boxes_overlap(left, right):
    return not (
        left[0] + left[2] < right[0]
        or right[0] + right[2] < left[0]
        or left[1] + left[3] < right[1]
        or right[1] + right[3] < left[1]
    )


def _box_contains(outer, inner):
    return (
        inner[0] >= outer[0]
        and inner[1] >= outer[1]
        and inner[0] + inner[2] <= outer[0] + outer[2]
        and inner[1] + inner[3] <= outer[1] + outer[3]
    )


def text_line_boxes(image, occupied):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    ink = np.where(gray < 200, 255, 0).astype(np.uint8)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 3))
    dilated = cv2.dilate(ink, kernel, iterations=1)
    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    lines = []
    for contour in contours:
        x, y, width, height = cv2.boundingRect(contour)
        if width < 24 or height < 6 or height > 22 or width > 180:
            continue
        box = (int(x), int(y), int(width), int(height))
        if any(_boxes_overlap(box, kept) for kept in occupied):
            continue
        lines.append(box)
    lines.sort(key=lambda box: (box[1], box[0]))
    return lines[:16]


def _ocr_image(image, origin_x, origin_y, timeout_s):
    if image.size == 0:
        return []
    height, width = image.shape[:2]
    ocr_scale = 2 if 96 <= max(height, width) <= 448 else 1
    scaled = image
    if ocr_scale != 1:
        scaled = cv2.resize(
            image,
            (width * ocr_scale, height * ocr_scale),
            interpolation=cv2.INTER_CUBIC,
        )
    try:
        data_dict = pytesseract.image_to_data(
            scaled,
            output_type=Output.DICT,
            timeout=timeout_s,
        )
    except Exception:
        return []
    items, _line_text = items_from_tesseract(data_dict, ocr_scale, origin_x, origin_y)
    return items


def _ink_crop(image):
    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    ink_y, ink_x = np.where(gray < 200)
    if ink_x.size == 0:
        return None
    pad = 8
    left = max(0, int(ink_x.min()) - pad)
    top = max(0, int(ink_y.min()) - pad)
    right = min(width, int(ink_x.max()) + 1 + pad)
    bottom = min(height, int(ink_y.max()) + 1 + pad)
    if max(right - left, bottom - top) < 96 and max(height, width) >= 96:
        need = 96
        if right - left < need:
            extra = need - (right - left)
            left = max(0, left - extra // 2)
            right = min(width, left + need)
            left = max(0, right - need)
        if bottom - top < need:
            extra = need - (bottom - top)
            top = max(0, top - extra // 2)
            bottom = min(height, top + need)
            top = max(0, bottom - need)
    if right - left >= width - 4 and bottom - top >= height - 4:
        return image, 0, 0
    return image[top:bottom, left:right], left, top


def _focus_items(image, focus_x, focus_y, timeout_s):
    height, width = image.shape[:2]
    if width < 96 or height < 96:
        return []
    try:
        focus_x = float(focus_x)
        focus_y = float(focus_y)
    except (TypeError, ValueError):
        return []
    if not math.isfinite(focus_x) or not math.isfinite(focus_y):
        return []
    size = min(448, width, height)
    half = size // 2
    left = max(0, min(int(round(focus_x)) - half, width - size))
    top = max(0, min(int(round(focus_y)) - half, height - size))
    tightened = _ink_crop(image[top : top + size, left : left + size])
    if tightened is None:
        return []
    ink, ink_left, ink_top = tightened
    return _ocr_image(ink, left + ink_left, top + ink_top, timeout_s)


def _line_mosaic_items(image, lines, timeout_s):
    pad = 4
    gap = 6
    width = max(box[2] for box in lines) + pad * 2
    height = pad + sum(box[3] + gap for box in lines)
    canvas = np.full((height, width, 3), 255, dtype=np.uint8)
    placements = []
    cursor = pad
    for x, y, box_width, box_height in lines:
        canvas[cursor : cursor + box_height, pad : pad + box_width] = image[
            y : y + box_height, x : x + box_width
        ]
        placements.append((cursor, x, y, box_height))
        cursor += box_height + gap
    mapped = []
    for item in _ocr_image(canvas, 0, 0, timeout_s):
        bounds = item["bounds"]
        center_y = bounds["y"] + bounds["height"] / 2.0
        host = None
        for strip_top, origin_x, origin_y, strip_height in placements:
            if strip_top - 2 <= center_y <= strip_top + strip_height + 2:
                host = (origin_x, origin_y, strip_top)
                break
        if host is None:
            continue
        origin_x, origin_y, strip_top = host
        mapped.append(
            {
                "text": item["text"],
                "confidence": item["confidence"],
                "bounds": {
                    "x": int(origin_x + bounds["x"] - pad),
                    "y": int(origin_y + bounds["y"] - strip_top),
                    "width": int(bounds["width"]),
                    "height": int(bounds["height"]),
                },
            }
        )
    return mapped


def _normalize_ocr_word(value):
    chars = []
    for char in str(value).lower():
        chars.append(char if char.isalnum() else " ")
    return " ".join("".join(chars).split())


def _edit_distance_at_most_one(left, right):
    if abs(len(left) - len(right)) > 1:
        return False
    if len(left) < len(right):
        left, right = right, left
    misses = 0
    shorter = 0
    for index, char in enumerate(left):
        if shorter < len(right) and char == right[shorter]:
            shorter += 1
            continue
        misses += 1
        if misses > 1:
            return False
        if len(left) == len(right):
            shorter += 1
    return True


def _query_found(items, query):
    raw = _normalize_ocr_word(query)
    tokens = [token for token in raw.split(" ") if len(token) >= 2]
    if not tokens:
        return False
    words = []
    for item in items:
        word = _normalize_ocr_word(item.get("text", ""))
        if not word or " " in word or len(word) < 2:
            continue
        words.append(word)
    for token in tokens:
        found = False
        for word in words:
            if word == token or (
                len(word) >= 6
                and len(token) >= 6
                and _edit_distance_at_most_one(word, token)
            ):
                found = True
                break
        if not found:
            return False
    return True


def _focus_region(image, focus_x, focus_y):
    height, width = image.shape[:2]
    if width < 96 or height < 96:
        return None
    try:
        focus_x = float(focus_x)
        focus_y = float(focus_y)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(focus_x) or not math.isfinite(focus_y):
        return None
    size = min(448, width, height)
    half = size // 2
    left = max(0, min(int(round(focus_x)) - half, width - size))
    top = max(0, min(int(round(focus_y)) - half, height - size))
    return (left, top, size, size)


def _slice_wide_box(box):
    slices = []
    x, y, width, height = box
    cursor = 0
    while cursor < width and len(slices) < 6:
        piece = min(400, width - cursor)
        if piece >= 24:
            slices.append((x + cursor, y, int(piece), height))
        cursor += 280
    return slices


def _wide_line_groups(image, occupied, focus_region):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    ink = np.where(gray < 200, 255, 0).astype(np.uint8)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 3))
    dilated = cv2.dilate(ink, kernel, iterations=1)
    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    outside = []
    clipped = []
    for contour in contours:
        x, y, width, height = cv2.boundingRect(contour)
        if width <= 180 or width > image.shape[1] or height < 6 or height > 28:
            continue
        box = (int(x), int(y), int(width), int(height))
        if any(_boxes_overlap(box, kept) for kept in occupied):
            continue
        if focus_region is not None and _boxes_overlap(box, focus_region):
            _fx, fy, _fw, fh = focus_region
            if box[1] >= fy and box[1] + box[3] <= fy + fh:
                continue
            clipped.extend(_slice_wide_box(box))
            continue
        outside.extend(_slice_wide_box(box))
    return outside, clipped


def recognize_rectangles(image, timeout_s, focus=None, query=None):
    boxes = text_rectangles(image)
    lines = text_line_boxes(image, boxes)
    focus_region = _focus_region(image, focus[0], focus[1]) if focus is not None else None
    outside, clipped = _wide_line_groups(image, boxes, focus_region)
    opened = []
    if clipped:
        chosen = (clipped[:3] + outside[:3]) if outside else clipped[:6]
        opened = _line_mosaic_items(image, chosen, timeout_s)
        if query and _query_found(opened, query):
            return opened[:MAX_OCR_ITEMS]
        outside = []
    elif outside:
        pieces = outside[:1]
        for box in boxes:
            if focus_region is not None and _box_contains(focus_region, box):
                continue
            pieces.append(box)
        chosen = []
        height = 4
        for box in pieces:
            step = box[3] + 6
            if height + step > 448:
                break
            chosen.append(box)
            height += step
        opened = _line_mosaic_items(image, chosen, timeout_s) if chosen else []
        if query and _query_found(opened, query):
            return opened[:MAX_OCR_ITEMS]
        if len(outside) > 1:
            more = _line_mosaic_items(image, outside[1:6], timeout_s)
            opened.extend(more)
            if query and _query_found(opened, query):
                return opened[:MAX_OCR_ITEMS]
        outside = []
    elif focus_region is not None and lines:
        outside_lines = [box for box in lines if not _box_contains(focus_region, box)]
        inside_buttons = [box for box in boxes if _boxes_overlap(box, focus_region)]
        if outside_lines and not inside_buttons:
            opened = _line_mosaic_items(image, outside_lines, timeout_s)
            if query and _query_found(opened, query):
                return opened[:MAX_OCR_ITEMS]
    focus_pool = ThreadPoolExecutor(max_workers=1) if focus is not None else None
    focus_future = (
        focus_pool.submit(_focus_items, image, focus[0], focus[1], timeout_s)
        if focus_pool is not None
        else None
    )
    wide_pool = ThreadPoolExecutor(max_workers=1) if outside else None
    wide_future = (
        wide_pool.submit(_line_mosaic_items, image, outside, timeout_s) if wide_pool is not None else None
    )
    try:
        items = list(opened)
        if focus_future is not None:
            items.extend(focus_future.result())
            if query and _query_found(items, query):
                return items[:MAX_OCR_ITEMS]
        jobs = len(boxes) + (1 if lines else 0)
        if jobs:
            with ThreadPoolExecutor(max_workers=min(8, jobs)) as pool:
                futures = [
                    pool.submit(_ocr_image, image[y : y + height, x : x + width], x, y, timeout_s)
                    for x, y, width, height in boxes
                ]
                if lines:
                    futures.append(pool.submit(_line_mosaic_items, image, lines, timeout_s))
                for future in futures:
                    items.extend(future.result())
                    if len(items) >= MAX_OCR_ITEMS:
                        break
        if wide_future is not None and len(items) < MAX_OCR_ITEMS:
            items.extend(wide_future.result())
        return items[:MAX_OCR_ITEMS]
    finally:
        if focus_pool is not None:
            focus_pool.shutdown(wait=False, cancel_futures=True)
        if wide_pool is not None:
            wide_pool.shutdown(wait=False, cancel_futures=True)


@app.route("/ocr", methods=["POST"])
def ocr():
    start_time = time.time()
    try:
        data = request.json or {}
        if "image" not in data:
            return jsonify({"error": "Missing image"}), 400

        image = base64_to_cv2(data["image"], max_pixels=MAX_OCR_PIXELS)
        if data.get("regions"):
            focus = None
            if "focusX" in data and "focusY" in data:
                focus = (data.get("focusX"), data.get("focusY"))
            query = data.get("query") if isinstance(data.get("query"), str) else None
            items = recognize_rectangles(
                image,
                requested_ocr_timeout_seconds(data),
                focus,
                query,
            )
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
        source_height, source_width = image.shape[:2]
        ocr_scale = 2 if 96 <= max(source_height, source_width) <= 448 else 1
        if ocr_scale != 1:
            image = cv2.resize(
                image,
                (source_width * ocr_scale, source_height * ocr_scale),
                interpolation=cv2.INTER_CUBIC,
            )
        data_dict = pytesseract.image_to_data(
            image,
            output_type=Output.DICT,
            timeout=requested_ocr_timeout_seconds(data),
        )
        items, text = items_from_tesseract(data_dict, ocr_scale)
        text = text[:MAX_OCR_TEXT_CHARS]

        processing_ms = int((time.time() - start_time) * 1000)
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


def warm_ocr():
    try:
        blank = np.zeros((32, 32, 3), dtype=np.uint8)
        pytesseract.image_to_data(blank, output_type=Output.DICT, timeout=3)
    except Exception:
        return


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5001"))
    warm_ocr()
    app.run(host="0.0.0.0", port=port)
