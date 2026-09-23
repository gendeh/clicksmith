import base64
import io

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


def post_match(client, template, search, threshold=0.55, min_scale=0.7, max_scale=1.4, scale_hint=1.0, method="template"):
    payload = {
        "template": to_base64(template),
        "searchArea": to_base64(search),
        "threshold": threshold,
        "method": method,
        "findAll": False,
        "maxMatches": 1,
        "minScale": min_scale,
        "maxScale": max_scale,
        "scaleHint": scale_hint,
        "maxBudgetMs": 180,
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
