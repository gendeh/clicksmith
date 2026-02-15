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


def test_match_endpoint_multipart():
    app = create_app()
    client = app.test_client()

    search = np.zeros((200, 200, 3), dtype=np.uint8)
    search[80:100, 90:110] = 255

    template = np.zeros((20, 20, 3), dtype=np.uint8)
    template[:, :] = 255

    search_image = Image.fromarray(search.astype("uint8"))
    template_image = Image.fromarray(template.astype("uint8"))

    search_buf = io.BytesIO()
    template_buf = io.BytesIO()
    search_image.save(search_buf, format="PNG")
    template_image.save(template_buf, format="PNG")
    search_buf.seek(0)
    template_buf.seek(0)

    payload = {
        "template_file": (template_buf, "template.png"),
        "search_area_file": (search_buf, "search.png"),
        "threshold": "0.6",
        "method": "template",
        "findAll": "false",
        "maxMatches": "1",
    }

    res = client.post("/match", data=payload, content_type="multipart/form-data")
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is True
    assert data["bestMatch"]["confidence"] >= 0.6
