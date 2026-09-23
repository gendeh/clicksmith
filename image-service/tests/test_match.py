import base64
import io
import time

import cv2
import numpy as np
from PIL import Image

from app.main import MAX_MATCHES, MAX_OCR_PIXELS, create_app


def to_base64(arr):
    image = Image.fromarray(arr.astype("uint8"))
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def make_template(size=28):
    template = np.zeros((size, size, 3), dtype=np.uint8)
    cv2.rectangle(template, (2, 2), (size - 3, size - 3), (220, 220, 220), 1)
    cv2.line(template, (4, size - 6), (size - 6, 4), (255, 255, 255), 2)
    cv2.circle(template, (size // 2, size // 2), size // 5, (180, 180, 180), -1)
    return template


def make_feature_template(size=128):
    rng = np.random.default_rng(7)
    template = np.zeros((size, size, 3), dtype=np.uint8)
    block = 8
    for y in range(0, size, block):
        for x in range(0, size, block):
            val = 255 if rng.random() > 0.5 else 20
            template[y : y + block, x : x + block] = val
    cv2.rectangle(template, (8, 8), (size - 9, size - 9), (240, 240, 240), 2)
    cv2.line(template, (16, size - 20), (size - 20, 16), (255, 255, 255), 3)
    cv2.line(template, (16, 16), (size - 20, size - 20), (170, 170, 170), 2)
    cv2.circle(template, (size // 3, size // 3), size // 9, (220, 220, 220), -1)
    cv2.circle(template, (size * 2 // 3, size // 3), size // 11, (200, 200, 200), 3)
    cv2.circle(template, (size // 2, size * 2 // 3), size // 8, (180, 180, 180), -1)
    cv2.putText(
        template,
        "CS",
        (18, size - 24),
        cv2.FONT_HERSHEY_SIMPLEX,
        1.2,
        (255, 255, 255),
        3,
        cv2.LINE_AA,
    )
    return template


def embed_scaled_template(template, scale, canvas_size=240, origin=(90, 110)):
    search = np.zeros((canvas_size, canvas_size, 3), dtype=np.uint8)
    scaled = cv2.resize(
        template,
        dsize=None,
        fx=scale,
        fy=scale,
        interpolation=cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LINEAR,
    )
    h, w = scaled.shape[:2]
    x, y = origin
    search[y : y + h, x : x + w] = scaled
    return search


def expected_center(template, scale, origin=(90, 110)):
    height, width = template.shape[:2]
    return origin[0] + (width * scale) / 2.0, origin[1] + (height * scale) / 2.0


def assert_click_on_embedded_patch(match, template, scale, tolerance=8):
    center_x, center_y = expected_center(template, scale)
    assert abs(float(match["x"]) - center_x) <= tolerance
    assert abs(float(match["y"]) - center_y) <= tolerance


def post_match(client, template, search, threshold=0.55, min_scale=0.7, max_scale=1.4, scale_hint=1.0, method="template", find_all=False, max_matches=1, max_budget_ms=180):
    payload = {
        "template": to_base64(template),
        "searchArea": to_base64(search),
        "threshold": threshold,
        "method": method,
        "findAll": find_all,
        "maxMatches": max_matches,
        "minScale": min_scale,
        "maxScale": max_scale,
        "scaleHint": scale_hint,
        "maxBudgetMs": max_budget_ms,
    }
    return client.post("/match", json=payload)


def test_match_endpoint_baseline_scale_1_0():
    app = create_app()
    client = app.test_client()
    template = make_template(28)
    search = embed_scaled_template(template, 1.0)
    res = post_match(client, template, search, threshold=0.55)
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is True
    assert data["bestMatch"]["confidence"] >= 0.55
    assert "scale" in data["bestMatch"]
    assert abs(float(data["bestMatch"]["scale"]) - 1.0) <= 0.12
    assert_click_on_embedded_patch(data["bestMatch"], template, 1.0)


def test_match_endpoint_in_range_scale_0_8():
    app = create_app()
    client = app.test_client()
    template = make_template(28)
    search = embed_scaled_template(template, 0.8)
    res = post_match(client, template, search, threshold=0.5, scale_hint=0.9)
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is True
    assert data["bestMatch"]["confidence"] >= 0.5
    assert "scale" in data["bestMatch"]
    assert abs(float(data["bestMatch"]["scale"]) - 0.8) <= 0.2
    assert_click_on_embedded_patch(data["bestMatch"], template, 0.8)


def test_match_endpoint_zoom_edges_0_7_and_1_4():
    app = create_app()
    client = app.test_client()
    template = make_template(28)
    for scale in (0.7, 1.4):
        search = embed_scaled_template(template, scale)
        res = post_match(client, template, search, threshold=0.5, scale_hint=1.0)
        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True
        assert data["bestMatch"]["confidence"] >= 0.5
        assert abs(float(data["bestMatch"]["scale"]) - scale) <= 0.2
        assert_click_on_embedded_patch(data["bestMatch"], template, scale)


def test_zoom_edges_match_inside_window_stage_budget():
    app = create_app()
    client = app.test_client()
    template = make_feature_template(128)
    for scale in (0.7, 1.4):
        search = embed_scaled_template(template, scale, canvas_size=480, origin=(40, 36))
        res = client.post(
            "/match",
            json={
                "template": to_base64(template),
                "searchArea": to_base64(search),
                "threshold": 0.6,
                "method": "hybrid",
                "findAll": True,
                "maxMatches": 8,
                "minScale": 0.7,
                "maxScale": 1.4,
                "scaleHint": 1.0,
                "maxBudgetMs": 90,
            },
        )
        assert res.status_code == 200
        data = res.get_json()
        assert data["bestMatch"] is not None
        assert data["bestMatch"]["confidence"] >= 0.6
        assert abs(float(data["bestMatch"]["scale"]) - scale) <= 0.15
        center_x = 40 + (template.shape[1] * scale) / 2.0
        center_y = 36 + (template.shape[0] * scale) / 2.0
        assert abs(float(data["bestMatch"]["x"]) - center_x) <= 8
        assert abs(float(data["bestMatch"]["y"]) - center_y) <= 8


def test_decisive_match_stops_before_the_rest_of_the_scale_grid(monkeypatch):
    calls = {"n": 0}
    real = __import__("app.main", fromlist=["match_template"]).match_template

    def wrapped(*args, **kwargs):
        calls["n"] += 1
        return real(*args, **kwargs)

    monkeypatch.setattr("app.main.match_template", wrapped)
    app = create_app()
    client = app.test_client()
    template = make_feature_template(128)
    search = embed_scaled_template(template, 1.0, canvas_size=480, origin=(40, 36))
    res = post_match(
        client,
        template,
        search,
        threshold=0.6,
        method="template",
        min_scale=0.7,
        max_scale=1.4,
        scale_hint=1.0,
    )
    data = res.get_json()
    assert data["bestMatch"]["confidence"] >= 0.92
    assert abs(float(data["bestMatch"]["scale"]) - 1.0) <= 0.05
    assert calls["n"] == 1


def test_zoomed_patch_is_found_on_its_own_scale(monkeypatch):
    calls = {"n": 0}
    real = __import__("app.main", fromlist=["match_template"]).match_template

    def wrapped(*args, **kwargs):
        calls["n"] += 1
        return real(*args, **kwargs)

    monkeypatch.setattr("app.main.match_template", wrapped)
    app = create_app()
    client = app.test_client()
    template = make_feature_template(128)
    search = embed_scaled_template(template, 0.7, canvas_size=480, origin=(40, 36))
    res = post_match(
        client,
        template,
        search,
        threshold=0.6,
        method="template",
        min_scale=0.7,
        max_scale=1.4,
        scale_hint=1.0,
    )
    data = res.get_json()
    assert data["bestMatch"]["confidence"] >= 0.6
    assert abs(float(data["bestMatch"]["scale"]) - 0.7) <= 0.15
    assert calls["n"] <= 3


def test_match_endpoint_in_range_scale_1_3():
    app = create_app()
    client = app.test_client()
    template = make_template(28)
    search = embed_scaled_template(template, 1.3)
    res = post_match(client, template, search, threshold=0.5, scale_hint=1.2)
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is True
    assert data["bestMatch"]["confidence"] >= 0.5
    assert "scale" in data["bestMatch"]
    assert abs(float(data["bestMatch"]["scale"]) - 1.3) <= 0.2
    assert_click_on_embedded_patch(data["bestMatch"], template, 1.3)


def test_match_endpoint_out_of_range_scale_1_8():
    app = create_app()
    client = app.test_client()
    template = make_template(28)
    search = embed_scaled_template(template, 1.8)
    threshold = 0.72
    res = post_match(client, template, search, threshold=threshold, min_scale=0.7, max_scale=1.4, scale_hint=1.0)
    assert res.status_code == 200
    data = res.get_json()
    if data["success"] is True:
        assert data["bestMatch"]["confidence"] < threshold
    else:
        assert data["success"] is False


def test_feature_match_returns_estimated_scale_for_homography():
    app = create_app()
    client = app.test_client()
    template = make_feature_template(128)
    search = embed_scaled_template(template, 1.25, canvas_size=480, origin=(130, 170))
    res = post_match(
        client,
        template,
        search,
        threshold=0.35,
        min_scale=0.7,
        max_scale=1.5,
        scale_hint=1.2,
        method="feature",
    )
    assert res.status_code == 200
    data = res.get_json()
    assert data["bestMatch"] is not None
    assert data["bestMatch"]["method"] == "feature"
    assert "scale" in data["bestMatch"]
    assert float(data["bestMatch"]["scale"]) > 0.0


def test_feature_patch_at_140_percent_clicks_the_scaled_center():
    app = create_app()
    client = app.test_client()
    template = make_feature_template(128)
    origin = (40, 50)
    scale = 1.4
    search = embed_scaled_template(template, scale, canvas_size=640, origin=origin)
    res = post_match(
        client,
        template,
        search,
        threshold=0.6,
        min_scale=0.7,
        max_scale=1.4,
        scale_hint=1.0,
        method="feature",
    )
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is True
    match = data["bestMatch"]
    center_x, center_y = expected_center(template, scale, origin)
    assert abs(float(match["scale"]) - scale) <= 0.08
    assert abs(float(match["x"]) - center_x) <= 8
    assert abs(float(match["y"]) - center_y) <= 8


def test_feature_patch_at_70_percent_clicks_the_scaled_center():
    app = create_app()
    client = app.test_client()
    template = make_feature_template(128)
    origin = (40, 50)
    scale = 0.7
    search = embed_scaled_template(template, scale, canvas_size=480, origin=origin)
    res = post_match(
        client,
        template,
        search,
        threshold=0.6,
        min_scale=0.7,
        max_scale=1.4,
        scale_hint=1.0,
        method="feature",
    )
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is True
    match = data["bestMatch"]
    center_x, center_y = expected_center(template, scale, origin)
    assert abs(float(match["scale"]) - scale) <= 0.08
    assert abs(float(match["x"]) - center_x) <= 8
    assert abs(float(match["y"]) - center_y) <= 8


def test_feature_patch_at_110_percent_reports_that_scale():
    app = create_app()
    client = app.test_client()
    template = make_feature_template(128)
    origin = (30, 40)
    scale = 1.1
    search = embed_scaled_template(template, scale, canvas_size=520, origin=origin)
    res = post_match(
        client,
        template,
        search,
        threshold=0.6,
        min_scale=0.7,
        max_scale=1.4,
        scale_hint=1.0,
        method="feature",
    )
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is True
    match = data["bestMatch"]
    center_x, center_y = expected_center(template, scale, origin)
    assert abs(float(match["scale"]) - scale) <= 0.08
    assert abs(float(match["x"]) - center_x) <= 8
    assert abs(float(match["y"]) - center_y) <= 8


def test_absent_patch_stops_after_the_endpoint_scales(monkeypatch):
    from app.main import match_template

    calls = []
    real = match_template

    def wrapped(*args, **kwargs):
        calls.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr("app.main.match_template", wrapped)
    app = create_app()
    client = app.test_client()
    template = make_feature_template(96)
    search = np.full((640, 640, 3), 18, dtype=np.uint8)
    search[40:80, 50:90] = (200, 30, 30)
    res = post_match(
        client,
        template,
        search,
        threshold=0.25,
        min_scale=0.7,
        max_scale=1.4,
        scale_hint=1.0,
        method="template",
    )
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is False
    assert len(calls) <= 6


def test_template_at_125_percent_still_clicks_the_scaled_center():
    app = create_app()
    client = app.test_client()
    template = make_feature_template(96)
    origin = (40, 50)
    scale = 1.25
    search = embed_scaled_template(template, scale, canvas_size=640, origin=origin)
    res = post_match(
        client,
        template,
        search,
        threshold=0.25,
        min_scale=0.7,
        max_scale=1.4,
        scale_hint=1.0,
        method="template",
        max_budget_ms=260,
    )
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is True
    match = data["bestMatch"]
    center_x, center_y = expected_center(template, scale, origin)
    assert float(match["confidence"]) > 0.6
    assert abs(float(match["scale"]) - scale) <= 0.08
    assert abs(float(match["x"]) - center_x) <= 8
    assert abs(float(match["y"]) - center_y) <= 8


def redraw_text_button(scale):
    width = max(2, int(220 * scale))
    height = max(2, int(48 * scale))
    image = np.full((height, width, 3), (226, 226, 254), dtype=np.uint8)
    cv2.rectangle(image, (1, 1), (width - 2, height - 2), (17, 24, 39), 2)
    cv2.putText(
        image,
        "Target D: Coral",
        (8, max(12, int(32 * scale))),
        cv2.FONT_HERSHEY_SIMPLEX,
        max(0.3, 0.7 * scale),
        (20, 20, 20),
        max(1, int(2 * scale)),
        cv2.LINE_AA,
    )
    return image


def test_rerendered_button_at_70_percent_clicks_the_center():
    app = create_app()
    client = app.test_client()
    template = redraw_text_button(1.0)
    origin = (40, 50)
    button = redraw_text_button(0.7)
    search = np.full((640, 640, 3), 245, dtype=np.uint8)
    height, width = button.shape[:2]
    search[origin[1] : origin[1] + height, origin[0] : origin[0] + width] = button
    res = post_match(
        client,
        template,
        search,
        threshold=0.25,
        min_scale=0.7,
        max_scale=1.4,
        scale_hint=1.0,
        method="hybrid",
        max_budget_ms=260,
    )
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is True
    match = data["bestMatch"]
    center_x = origin[0] + width / 2.0
    center_y = origin[1] + height / 2.0
    assert float(match["confidence"]) > 0.6
    assert abs(float(match["scale"]) - 0.7) <= 0.08
    assert abs(float(match["x"]) - center_x) <= 8
    assert abs(float(match["y"]) - center_y) <= 8
    assert int(data["processingTimeMs"]) <= 260


def test_hybrid_at_120_percent_clicks_the_scaled_center():
    app = create_app()
    client = app.test_client()
    template = make_feature_template(96)
    origin = (40, 50)
    scale = 1.2
    search = embed_scaled_template(template, scale, canvas_size=640, origin=origin)
    res = post_match(
        client,
        template,
        search,
        threshold=0.25,
        min_scale=0.7,
        max_scale=1.4,
        scale_hint=1.0,
        method="hybrid",
        max_budget_ms=260,
    )
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is True
    match = data["bestMatch"]
    center_x, center_y = expected_center(template, scale, origin)
    assert float(match["confidence"]) >= 0.92
    assert abs(float(match["scale"]) - scale) <= 0.08
    assert abs(float(match["x"]) - center_x) <= 8
    assert abs(float(match["y"]) - center_y) <= 8
    assert match["method"] == "template"
    assert data["processingTimeMs"] <= 260


def test_template_at_110_and_90_percent_clicks_the_scaled_center():
    app = create_app()
    client = app.test_client()
    template = make_feature_template(96)
    for scale, origin in ((1.1, (40, 50)), (0.9, (40, 50))):
        search = embed_scaled_template(template, scale, canvas_size=640, origin=origin)
        res = post_match(
            client,
            template,
            search,
            threshold=0.25,
            min_scale=0.7,
            max_scale=1.4,
            scale_hint=1.0,
            method="template",
            max_budget_ms=220,
        )
        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True
        match = data["bestMatch"]
        center_x, center_y = expected_center(template, scale, origin)
        assert float(match["confidence"]) > 0.6
        assert abs(float(match["scale"]) - scale) <= 0.08
        assert abs(float(match["x"]) - center_x) <= 8
        assert abs(float(match["y"]) - center_y) <= 8
        assert int(data["processingTimeMs"]) <= 220


def test_patch_on_a_desktop_sized_image_clicks_the_far_center():
    app = create_app()
    client = app.test_client()
    template = make_feature_template(96)
    origin = (1400, 700)
    search = np.zeros((1080, 1920, 3), dtype=np.uint8)
    search[origin[1] : origin[1] + 96, origin[0] : origin[0] + 96] = template
    res = client.post(
        "/match",
        json={
            "template": to_base64(template),
            "searchArea": to_base64(search),
            "threshold": 0.25,
            "method": "hybrid",
            "findAll": True,
            "maxMatches": 6,
            "minScale": 0.7,
            "maxScale": 1.4,
            "scaleHint": 1.0,
            "maxBudgetMs": 180,
        },
    )
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is True
    match = data["bestMatch"]
    center_x, center_y = expected_center(template, 1.0, origin)
    assert float(match["confidence"]) > 0.6
    assert abs(float(match["x"]) - center_x) <= 8
    assert abs(float(match["y"]) - center_y) <= 8
    assert int(data["processingTimeMs"]) <= 180


def test_scaled_patch_on_a_desktop_sized_image_clicks_the_scaled_center():
    app = create_app()
    client = app.test_client()
    template = make_feature_template(96)
    for scale, origin in ((0.7, (900, 400)), (1.25, (1100, 500)), (1.4, (1100, 500))):
        scaled = cv2.resize(
            template,
            dsize=None,
            fx=scale,
            fy=scale,
            interpolation=cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LINEAR,
        )
        search = np.zeros((1080, 1920, 3), dtype=np.uint8)
        height, width = scaled.shape[:2]
        search[origin[1] : origin[1] + height, origin[0] : origin[0] + width] = scaled
        res = client.post(
            "/match",
            json={
                "template": to_base64(template),
                "searchArea": to_base64(search),
                "threshold": 0.25,
                "method": "hybrid",
                "findAll": True,
                "maxMatches": 6,
                "minScale": 0.7,
                "maxScale": 1.4,
                "scaleHint": 1.0,
                "maxBudgetMs": 160,
            },
        )
        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True
        match = data["bestMatch"]
        center_x, center_y = expected_center(template, scale, origin)
        assert float(match["confidence"]) > 0.6
        assert abs(float(match["scale"]) - scale) <= 0.08
        assert abs(float(match["x"]) - center_x) <= 8
        assert abs(float(match["y"]) - center_y) <= 8
        assert int(data["processingTimeMs"]) <= 160


def test_ocr_endpoint_returns_line_items():
    app = create_app()
    client = app.test_client()
    image = np.zeros((160, 420, 3), dtype=np.uint8)
    cv2.putText(image, "Submit", (40, 90), cv2.FONT_HERSHEY_SIMPLEX, 2.0, (255, 255, 255), 4, cv2.LINE_AA)
    res = client.post("/ocr", json={"image": to_base64(image)})
    assert res.status_code == 200
    data = res.get_json()
    assert "success" in data
    assert "items" in data
    assert isinstance(data["items"], list)


def test_match_endpoint_caps_find_all_work():
    app = create_app()
    client = app.test_client()
    template = np.zeros((8, 8, 3), dtype=np.uint8)
    search = np.zeros((80, 80, 3), dtype=np.uint8)
    res = client.post(
        "/match",
        json={
            "template": to_base64(template),
            "searchArea": to_base64(search),
            "threshold": -1,
            "findAll": True,
            "maxMatches": 2000,
            "maxBudgetMs": 20,
        },
    )
    assert res.status_code == 200
    data = res.get_json()
    assert len(data["matches"]) <= MAX_MATCHES


def test_feature_outside_scale_window_does_not_replace_template(monkeypatch):
    def outside_feature(_template, _search):
        return {
            "x": 18,
            "y": 238,
            "confidence": 0.9,
            "method": "feature",
            "score": 0.9,
            "scale": 4.34,
            "homography_ok": True,
            "inliers": 20,
            "bounds": {"x": 0, "y": 200, "width": 40, "height": 40},
        }

    monkeypatch.setattr("app.main.match_feature", outside_feature)
    app = create_app()
    client = app.test_client()
    template = make_template(28)
    search = embed_scaled_template(template, 1.0)
    res = post_match(client, template, search, threshold=0.55, method="hybrid", max_scale=1.4)
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is True
    assert data["bestMatch"]["method"] == "template"
    assert all(float(item.get("scale") or 0) <= 1.45 for item in data["matches"])
    assert_click_on_embedded_patch(data["bestMatch"], template, 1.0)


def test_match_endpoint_rejects_oversized_base64_payload():
    app = create_app()
    client = app.test_client()
    template = to_base64(make_template(8))
    oversized = "A" * (2_100_000)
    res = client.post("/match", json={"template": template, "searchArea": oversized})
    assert res.status_code in (400, 413)


def test_ocr_endpoint_rejects_images_over_pixel_budget():
    app = create_app()
    client = app.test_client()
    side = int(np.sqrt(MAX_OCR_PIXELS)) + 10
    image = np.zeros((side, side, 3), dtype=np.uint8)
    res = client.post("/ocr", json={"image": to_base64(image)})
    assert res.status_code == 400
    data = res.get_json()
    assert data["success"] is False


def test_ocr_uses_one_pass_inside_the_requested_budget(monkeypatch):
    calls = []

    def fake_data(_image, output_type=None, timeout=None):
        calls.append(("data", timeout))
        return {
            "text": ["Submit"],
            "conf": ["91"],
            "left": [40],
            "top": [30],
            "width": [80],
            "height": [20],
            "block_num": [1],
            "par_num": [1],
            "line_num": [1],
        }

    def fake_string(*_args, **_kwargs):
        calls.append("string")
        raise AssertionError("second ocr pass")

    monkeypatch.setattr("app.main.pytesseract.image_to_data", fake_data)
    monkeypatch.setattr("app.main.pytesseract.image_to_string", fake_string)
    app = create_app()
    client = app.test_client()
    image = np.zeros((40, 40, 3), dtype=np.uint8)
    res = client.post("/ocr", json={"image": to_base64(image), "timeoutMs": 80})
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is True
    assert data["items"][0]["text"] == "Submit"
    assert data["items"][0]["bounds"] == {"x": 40, "y": 30, "width": 80, "height": 20}
    assert "Submit" in data["text"]
    assert calls == [("data", 0.08)]


def test_hybrid_does_not_start_features_after_the_budget_is_spent(monkeypatch):
    template_match = {
        "x": 90,
        "y": 70,
        "confidence": 0.7,
        "method": "template",
        "score": 0.7,
        "scale": 1.0,
        "bounds": {"x": 74, "y": 54, "width": 32, "height": 32},
    }

    def spent_template(*_args, **_kwargs):
        time.sleep(0.03)
        return template_match, [template_match]

    def feature_should_not_run(*_args, **_kwargs):
        raise AssertionError("feature ran after the budget")

    monkeypatch.setattr("app.main.match_template_multiscale", spent_template)
    monkeypatch.setattr("app.main.match_feature", feature_should_not_run)
    app = create_app()
    client = app.test_client()
    image = np.zeros((32, 32, 3), dtype=np.uint8)
    res = client.post(
        "/match",
        json={
            "template": to_base64(image),
            "searchArea": to_base64(image),
            "threshold": 0.6,
            "method": "hybrid",
            "maxBudgetMs": 20,
        },
    )
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is True
    assert data["bestMatch"]["method"] == "template"
    assert data["bestMatch"]["x"] == 90
    assert data["bestMatch"]["y"] == 70


def test_large_template_miss_returns_inside_the_requested_budget():
    app = create_app()
    client = app.test_client()
    rng = np.random.default_rng(0)
    search = rng.integers(0, 255, (600, 800, 3), dtype=np.uint8)
    template = rng.integers(0, 255, (96, 96, 3), dtype=np.uint8)
    res = client.post(
        "/match",
        json={
            "template": to_base64(template),
            "searchArea": to_base64(search),
            "threshold": 0.25,
            "method": "hybrid",
            "findAll": True,
            "maxMatches": 8,
            "minScale": 0.7,
            "maxScale": 1.4,
            "scaleHint": 1.0,
            "maxBudgetMs": 180,
        },
    )
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is False
    assert data["bestMatch"] is None
    assert data["processingTimeMs"] <= 180


def test_flat_template_that_is_missing_is_not_a_click():
    app = create_app()
    client = app.test_client()
    search = np.full((180, 200, 3), (80, 0, 240), dtype=np.uint8)
    template = np.full((40, 40, 3), (255, 0, 255), dtype=np.uint8)
    res = post_match(
        client,
        template,
        search,
        threshold=0.6,
        min_scale=0.7,
        max_scale=1.4,
        scale_hint=1.0,
        method="hybrid",
    )
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is False
    assert data["bestMatch"] is None


def test_flat_template_clicks_the_matching_patch_not_the_brighter_decoy():
    app = create_app()
    client = app.test_client()
    search = np.full((220, 240, 3), 30, dtype=np.uint8)
    search[10:50, 10:50] = (210, 210, 210)
    search[90:130, 140:180] = (140, 140, 140)
    template = np.full((40, 40, 3), 140, dtype=np.uint8)
    res = post_match(
        client,
        template,
        search,
        threshold=0.6,
        min_scale=1.0,
        max_scale=1.0,
        scale_hint=1.0,
    )
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is True
    assert data["bestMatch"]["confidence"] > 0.6
    assert abs(float(data["bestMatch"]["x"]) - 160) <= 2
    assert abs(float(data["bestMatch"]["y"]) - 110) <= 2


def test_flat_patch_at_140_percent_clicks_the_scaled_center():
    app = create_app()
    client = app.test_client()
    template = np.full((80, 80, 3), (140, 140, 140), dtype=np.uint8)
    origin = (80, 90)
    scale = 1.4
    search = embed_scaled_template(template, scale, canvas_size=320, origin=origin)
    res = post_match(
        client,
        template,
        search,
        threshold=0.6,
        min_scale=0.7,
        max_scale=1.4,
        scale_hint=1.0,
        method="template",
        find_all=True,
        max_matches=4,
    )
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is True
    match = data["bestMatch"]
    center_x, center_y = expected_center(template, scale, origin)
    assert abs(float(match["scale"]) - scale) <= 0.08
    assert abs(float(match["x"]) - center_x) <= 8
    assert abs(float(match["y"]) - center_y) <= 8
    assert data["matches"]
    assert abs(float(data["matches"][0]["scale"]) - scale) <= 0.08


def test_nearby_copy_stays_a_candidate():
    app = create_app()
    client = app.test_client()
    template = make_template(40)
    height, width = template.shape[:2]
    search = np.zeros((180, 360, 3), dtype=np.uint8)
    search[30 : 30 + height, 20 : 20 + width] = template
    second = 20 + width + 8
    search[30 : 30 + height, second : second + width] = template
    res = post_match(
        client,
        template,
        search,
        threshold=0.6,
        min_scale=1.0,
        max_scale=1.0,
        scale_hint=1.0,
        find_all=True,
        max_matches=4,
    )
    assert res.status_code == 200
    data = res.get_json()
    centers = [(int(item["x"]), int(item["y"])) for item in data["matches"]]
    first = (20 + width // 2, 30 + height // 2)
    other = (second + width // 2, 30 + height // 2)
    assert any(abs(x - first[0]) <= 2 and abs(y - first[1]) <= 2 for x, y in centers)
    assert any(abs(x - other[0]) <= 2 and abs(y - other[1]) <= 2 for x, y in centers)


def test_one_button_is_one_match():
    app = create_app()
    client = app.test_client()
    template = make_template(40)
    search = embed_scaled_template(template, 1.0, canvas_size=200, origin=(40, 50))
    res = post_match(
        client,
        template,
        search,
        threshold=0.25,
        min_scale=1.0,
        max_scale=1.0,
        scale_hint=1.0,
        find_all=True,
        max_matches=4,
    )
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is True
    assert len(data["matches"]) == 1


def test_flat_patch_at_70_percent_clicks_the_scaled_center():
    app = create_app()
    client = app.test_client()
    template = np.full((80, 80, 3), (140, 140, 140), dtype=np.uint8)
    origin = (80, 90)
    scale = 0.7
    search = embed_scaled_template(template, scale, canvas_size=320, origin=origin)
    res = post_match(
        client,
        template,
        search,
        threshold=0.6,
        min_scale=0.7,
        max_scale=1.4,
        scale_hint=1.0,
        method="template",
    )
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is True
    match = data["bestMatch"]
    center_x, center_y = expected_center(template, scale, origin)
    assert abs(float(match["scale"]) - scale) <= 0.08
    assert abs(float(match["x"]) - center_x) <= 8
    assert abs(float(match["y"]) - center_y) <= 8
