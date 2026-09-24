import base64
import io

import numpy as np
from PIL import Image

from app.main import create_app


def to_base64(arr):
    image = Image.fromarray(arr.astype("uint8"))
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def test_match_endpoint():
    app = create_app()
    client = app.test_client()

    search = np.zeros((200, 200, 3), dtype=np.uint8)
    search[80:100, 90:110] = 255

    template = np.zeros((20, 20, 3), dtype=np.uint8)
    template[:, :] = 255

    payload = {
        "template": to_base64(template),
        "searchArea": to_base64(search),
        "threshold": 0.6,
        "method": "template",
        "findAll": False,
        "maxMatches": 1,
    }

    res = client.post("/match", json=payload)
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is True
    assert data["bestMatch"]["confidence"] >= 0.6


def test_match_scales_template_to_current_window():
    app = create_app()
    client = app.test_client()

    template = np.zeros((8, 8, 3), dtype=np.uint8)
    template[:4, :] = 255

    search = np.zeros((80, 80, 3), dtype=np.uint8)
    search[40:48, 30:46] = 255

    payload = {
        "template": to_base64(template),
        "searchArea": to_base64(search),
        "threshold": 0.6,
        "method": "template",
        "findAll": False,
        "maxMatches": 1,
        "scaleX": 2,
        "scaleY": 2,
    }

    res = client.post("/match", json=payload)
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is True
    assert abs(data["bestMatch"]["x"] - 38) <= 2
    assert abs(data["bestMatch"]["y"] - 48) <= 2
